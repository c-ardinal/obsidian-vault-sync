import { md5 } from "../utils/md5";
import { normalizePath } from "../utils/path";
import type { SyncContext } from "./context";
import type { CommunicationData } from "./types";
import { isManagedSeparately, shouldNotBeOnRemote, shouldIgnore } from "./file-utils";

// === Communication.json Management ===

export async function loadCommunication(ctx: SyncContext): Promise<CommunicationData> {
    try {
        const meta = await ctx.adapter.getFileMetadata(ctx.communicationPath);
        if (!meta) {
            return { mergeLocks: {}, lastUpdated: 0 };
        }
        const content = await ctx.adapter.downloadFile(meta.id);
        const text = new TextDecoder().decode(content);
        const data = JSON.parse(text) as CommunicationData;
        const now = Date.now();
        for (const [path, lock] of Object.entries(data.mergeLocks)) {
            if (lock.expiresAt < now) {
                delete data.mergeLocks[path];
            }
        }
        return data;
    } catch (e) {
        await ctx.log(`[Communication] Failed to load: ${e}`, "error");
        return { mergeLocks: {}, lastUpdated: 0 };
    }
}

export async function saveCommunication(ctx: SyncContext, data: CommunicationData): Promise<void> {
    try {
        data.lastUpdated = Date.now();
        const content = new TextEncoder().encode(JSON.stringify(data, null, 2));
        await ctx.adapter.uploadFile(
            ctx.communicationPath,
            content.buffer as ArrayBuffer,
            Date.now(),
        );
    } catch (e) {
        await ctx.log(`[Communication] Failed to save: ${e}`, "error");
        throw e;
    }
}

export async function acquireMergeLock(
    ctx: SyncContext,
    path: string,
): Promise<{ acquired: boolean; holder?: string; expiresIn?: number }> {
    const comm = await loadCommunication(ctx);
    const existing = comm.mergeLocks[path];
    const now = Date.now();

    if (existing && existing.expiresAt > now && existing.holder !== ctx.deviceId) {
        return {
            acquired: false,
            holder: existing.holder,
            expiresIn: Math.floor((existing.expiresAt - now) / 1000),
        };
    }

    comm.mergeLocks[path] = {
        holder: ctx.deviceId,
        expiresAt: now + 60000,
    };
    await saveCommunication(ctx, comm);

    const verify = await loadCommunication(ctx);
    const verifyLock = verify.mergeLocks[path];
    if (verifyLock && verifyLock.holder === ctx.deviceId) {
        return { acquired: true };
    } else {
        return {
            acquired: false,
            holder: verifyLock?.holder,
            expiresIn: verifyLock ? Math.floor((verifyLock.expiresAt - now) / 1000) : 0,
        };
    }
}

export async function releaseMergeLock(
    ctx: SyncContext,
    path: string,
    logPrefix?: string,
): Promise<void> {
    try {
        const comm = await loadCommunication(ctx);
        const existing = comm.mergeLocks[path];
        if (existing && existing.holder === ctx.deviceId) {
            delete comm.mergeLocks[path];
            await saveCommunication(ctx, comm);
            await ctx.log(
                `[${logPrefix || "Communication"}] Merge lock released for ${path}.`,
                "debug",
            );
        }
    } catch (e) {
        await ctx.log(
            `[${logPrefix || "Communication"}] Failed to release lock for ${path}: ${e}`,
            "error",
        );
    }
}

export async function checkMergeLock(
    ctx: SyncContext,
    path: string,
): Promise<{ locked: boolean; holder?: string; expiresIn?: number }> {
    const comm = await loadCommunication(ctx);
    const existing = comm.mergeLocks[path];
    const now = Date.now();

    if (existing && existing.expiresAt > now && existing.holder !== ctx.deviceId) {
        return {
            locked: true,
            holder: existing.holder,
            expiresIn: Math.floor((existing.expiresAt - now) / 1000),
        };
    }
    return { locked: false };
}

// === Index Management ===

export async function loadIndex(
    ctx: SyncContext,
    tryDecompress: (data: ArrayBuffer) => Promise<ArrayBuffer>,
): Promise<void> {
    try {
        const data = await ctx.app.vault.adapter.readBinary(ctx.pluginDataPath);
        const decompressed = await tryDecompress(data);
        const text = new TextDecoder().decode(decompressed);
        const parsed = JSON.parse(text);
        ctx.index = parsed.index || {};
        ctx.startPageToken = parsed.startPageToken || null;

        if (data.byteLength !== decompressed.byteLength) {
            await ctx.log("[Index] Detected compressed local index. Normalizing to plain text...");
            await saveIndex(ctx);
        }

        await ctx.revisionCache.init();
        await loadLocalIndex(ctx);
    } catch (e) {
        const rawPath = ctx.pluginDataPath.replace(".json", "_raw.json");
        try {
            await ctx.log(
                `[Index] Main load failed (${e}). Attempting fallback to raw index: ${rawPath}`,
                "warn",
            );
            if (await ctx.app.vault.adapter.exists(rawPath)) {
                const data = await ctx.app.vault.adapter.read(rawPath);
                const parsed = JSON.parse(data);
                ctx.index = parsed.index || {};
                ctx.startPageToken = parsed.startPageToken || null;
                await ctx.log("[Index] Successfully recovered from raw index.");
                await saveIndex(ctx);
                return;
            }
        } catch (rawErr) {
            await ctx.log(`[Index] Raw fallback also failed: ${rawErr}`, "error");
        }

        await ctx.log(`[Index] Fatal load failure. Starting fresh.`, "error");
        ctx.indexLoadFailed = true;
        ctx.index = {};
        ctx.localIndex = {};
        ctx.startPageToken = null;
    }
}

export async function loadLocalIndex(ctx: SyncContext): Promise<void> {
    try {
        if (await ctx.app.vault.adapter.exists(ctx.localIndexPath)) {
            const data = await ctx.app.vault.adapter.read(ctx.localIndexPath);
            const parsed = JSON.parse(data);
            ctx.localIndex = parsed.index || {};
            ctx.deviceId = parsed.deviceId || "";

            if (!ctx.deviceId) {
                const randomArray = new Uint8Array(4);
                if (typeof crypto !== "undefined") crypto.getRandomValues(randomArray);
                const suffix = Array.from(randomArray)
                    .map((b) => b.toString(16).padStart(2, "0"))
                    .join("");
                ctx.deviceId = md5(
                    new TextEncoder().encode(Date.now().toString() + suffix).buffer,
                ).substring(0, 8);

                // Set folder BEFORE logging
                ctx.logFolder = `${ctx.pluginDir}/logs/${ctx.deviceId}`;
                await ctx.log(`[Local Index] Generated new device ID: ${ctx.deviceId}`, "system");
                await saveLocalIndex(ctx);
            } else {
                const isAlreadyLogged = ctx.logFolder === `${ctx.pluginDir}/logs/${ctx.deviceId}`;
                // Set folder BEFORE logging
                ctx.logFolder = `${ctx.pluginDir}/logs/${ctx.deviceId}`;
                if (!isAlreadyLogged) {
                    await ctx.log(
                        `[Local Index] Loaded successfully. Device ID: ${ctx.deviceId}`,
                        "system",
                    );
                }
            }
        } else {
            ctx.localIndex = { ...ctx.index };
            const randomArray = new Uint8Array(4);
            if (typeof crypto !== "undefined") crypto.getRandomValues(randomArray);
            const suffix = Array.from(randomArray)
                .map((b) => b.toString(16).padStart(2, "0"))
                .join("");
            ctx.deviceId = md5(
                new TextEncoder().encode(Date.now().toString() + suffix).buffer,
            ).substring(0, 8);

            const isAlreadyLogged = ctx.logFolder === `${ctx.pluginDir}/logs/${ctx.deviceId}`;

            // Set folder BEFORE logging
            ctx.logFolder = `${ctx.pluginDir}/logs/${ctx.deviceId}`;
            if (!isAlreadyLogged) {
                await ctx.log(
                    `[Local Index] Not found. Initialized from shared index (Migration). Device ID: ${ctx.deviceId}`,
                    "system",
                );
            }
            await saveLocalIndex(ctx);
        }
    } catch (e) {
        const isAlreadyLogged =
            ctx.deviceId && ctx.logFolder === `${ctx.pluginDir}/logs/${ctx.deviceId}`;

        // Fallback device ID
        ctx.deviceId =
            ctx.deviceId ||
            md5(
                new TextEncoder().encode(Date.now().toString() + Math.random().toString()).buffer,
            ).substring(0, 8);
        ctx.logFolder = `${ctx.pluginDir}/logs/${ctx.deviceId}`;

        if (!isAlreadyLogged) {
            await ctx.log(`[Local Index] Load failed: ${e}`, "error");
        }
        ctx.localIndex = {};
    }
}

export async function saveIndex(ctx: SyncContext): Promise<void> {
    const data = JSON.stringify({
        index: ctx.index,
        startPageToken: ctx.startPageToken,
    });

    await ctx.app.vault.adapter.write(ctx.pluginDataPath, data);

    const rawPath = ctx.pluginDataPath.replace(".json", "_raw.json");
    try {
        await ctx.app.vault.adapter.write(rawPath, data);
    } catch (e) {
        console.error("VaultSync: Failed to save raw index backup", e);
    }

    await saveLocalIndex(ctx);
}

export async function saveLocalIndex(ctx: SyncContext): Promise<void> {
    try {
        const data = JSON.stringify({
            index: ctx.localIndex,
            deviceId: ctx.deviceId,
        });
        await ctx.app.vault.adapter.write(ctx.localIndexPath, data);
    } catch (e) {
        console.error("VaultSync: Failed to save local index", e);
    }
}

export async function resetIndex(ctx: SyncContext): Promise<void> {
    ctx.index = {};
    ctx.localIndex = {};
    ctx.startPageToken = null;
    await saveIndex(ctx);
}

export function clearPendingPushStates(ctx: SyncContext): void {
    for (const path of Object.keys(ctx.localIndex)) {
        const entry = ctx.localIndex[path];
        if (entry.lastAction === "push" || entry.lastAction === "merge") {
            entry.lastAction = "pull";
        }
    }
}

// === Dirty Path Tracking ===

export function markDirty(ctx: SyncContext, path: string): void {
    path = normalizePath(path);
    if (shouldIgnore(ctx, path)) return;
    if (ctx.syncingPaths.has(path)) return;
    ctx.dirtyPaths.add(path);
}

export function markDeleted(ctx: SyncContext, path: string): void {
    if (shouldIgnore(ctx, path)) return;
    if (ctx.index[path]) {
        ctx.dirtyPaths.add(path);
        ctx.log(`[Dirty] Marked for deletion: ${path}`, "debug");
    }
}

export function markFolderDeleted(ctx: SyncContext, folderPath: string): void {
    if (shouldIgnore(ctx, folderPath)) return;
    ctx.deletedFolders.add(folderPath);
    ctx.log(`[Dirty] Marked for deletion (folder root): ${folderPath}`, "debug");

    const prefix = folderPath + "/";
    for (const path of Object.keys(ctx.index)) {
        if (path.startsWith(prefix) && !shouldIgnore(ctx, path)) {
            ctx.dirtyPaths.add(path);
            ctx.log(`[Dirty] Marked for deletion (child): ${path}`, "debug");
        }
    }
}

export function markRenamed(ctx: SyncContext, oldPath: string, newPath: string): void {
    if (shouldIgnore(ctx, newPath)) return;

    const oldDir = oldPath.substring(0, oldPath.lastIndexOf("/"));
    const newDir = newPath.substring(0, newPath.lastIndexOf("/"));
    const isMove = oldDir !== newDir;

    // 未同期ファイルのリネーム/移動（oldPath がインデックスになく dirtyPaths にある）
    if (ctx.dirtyPaths.has(oldPath) && !ctx.index[oldPath]) {
        ctx.dirtyPaths.delete(oldPath);
        ctx.dirtyPaths.add(newPath);
        ctx.log(`[Dirty] Removed (renamed before sync): ${oldPath}`, "debug");
        ctx.log(`[Dirty] Marked (renamed before sync): ${newPath}`, "debug");
        return;
    }

    // 既存インデックスエントリを移行（リネームでも移動でも共通）
    ctx.dirtyPaths.delete(oldPath);

    if (ctx.index[oldPath]) {
        ctx.index[newPath] = {
            ...ctx.index[oldPath],
            forcePush: true,
            pendingMove: { oldPath },
        };
        delete ctx.index[oldPath];
    }

    if (ctx.localIndex[oldPath]) {
        ctx.localIndex[newPath] = {
            ...ctx.localIndex[oldPath],
            forcePush: true,
            pendingMove: { oldPath },
        };
        delete ctx.localIndex[oldPath];
    }

    ctx.dirtyPaths.add(newPath);
    ctx.log(
        `[Dirty] Marked (${isMove ? "moved" : "renamed"}): ${newPath} (Migrated ID from ${oldPath})`,
        "debug",
    );
}

export function markFolderRenamed(
    ctx: SyncContext,
    oldFolderPath: string,
    newFolderPath: string,
): void {
    const oldPrefix = oldFolderPath + "/";
    const newPrefix = newFolderPath + "/";

    // Track folder-level move for optimization in smartPush
    ctx.pendingFolderMoves.set(newFolderPath, oldFolderPath);
    ctx.dirtyPaths.add(newFolderPath); // Ensure the folder itself is processed

    // If the old folder was marked for deletion (via previous event),
    // we remove it since it's now a move.
    ctx.deletedFolders.delete(oldFolderPath);

    for (const oldPath of Object.keys(ctx.index)) {
        if (oldPath.startsWith(oldPrefix)) {
            if (shouldIgnore(ctx, oldPath)) continue;

            const newPath = newPrefix + oldPath.slice(oldPrefix.length);
            if (shouldIgnore(ctx, newPath)) continue;

            // インデックスを移行（削除+再追加ではなく Move として追跡）
            ctx.index[newPath] = {
                ...ctx.index[oldPath],
                forcePush: true,
                pendingMove: { oldPath },
            };
            delete ctx.index[oldPath];

            if (ctx.localIndex[oldPath]) {
                ctx.localIndex[newPath] = {
                    ...ctx.localIndex[oldPath],
                    forcePush: true,
                    pendingMove: { oldPath },
                };
                delete ctx.localIndex[oldPath];
            }

            // dirtyPaths を更新
            ctx.dirtyPaths.delete(oldPath);
            ctx.dirtyPaths.add(newPath);
            ctx.log(
                `[Dirty] Marked (folder move child): ${oldPath} -> ${newPath} (Migrated ID)`,
                "debug",
            );
        }
    }
}

// === State Queries ===

export function getSyncState(ctx: SyncContext) {
    return ctx.syncState;
}

export function hasDirtyFiles(ctx: SyncContext): boolean {
    return ctx.dirtyPaths.size > 0;
}

export function isFreshStart(ctx: SyncContext): boolean {
    return ctx.indexLoadFailed || Object.keys(ctx.index).length === 0;
}
