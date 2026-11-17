import { md5 } from "../utils/md5";
import { toHex } from "../utils/format";
import { normalizePath, dirname } from "../utils/path";
import type { SyncContext } from "./context";
import type { CommunicationData } from "./types";
import { isManagedSeparately, shouldNotBeOnRemote, shouldIgnore } from "./file-utils";
import {
    LOCK_MAX_ATTEMPTS,
    LOCK_TTL_MS,
    LOCK_JITTER_MIN_MS,
    LOCK_JITTER_RANGE_MS,
} from "./constants";

function generateDeviceId(): string {
    const randomArray = new Uint8Array(4);
    if (typeof crypto !== "undefined") crypto.getRandomValues(randomArray);
    const suffix = toHex(randomArray);
    return md5(new TextEncoder().encode(Date.now().toString() + suffix).buffer).substring(0, 8);
}

// === Per-sync-cycle state (performance) ===
//
// communication.json (merge locks) used to be fetched from the cloud for every
// single pulled file (checkMergeLock) and read-modify-written 2-3 times per
// merge. With parallel pulls that is the dominant API cost, and parallel merges
// on ONE device even raced each other on the read-modify-write (a lost lock,
// then a jittered retry). Within a sync cycle we now
//   - serve read-only lock checks from a short-lived cache,
//   - serialize this device's lock updates and coalesce the ones that are
//     queued at the same time into a single load/save/verify round, and
//   - defer local-index writes (one JSON dump of the whole index per pulled
//     file) to periodic checkpoints and the end of the cycle.
// Outside a cycle (unit tests calling helpers directly) behaviour is unchanged.

/** Max age of the cached communication.json used for read-only lock checks */
export const COMM_CACHE_MAX_AGE_MS = 10_000;
/** While deferring, still write the local index after this many skipped saves (crash safety) */
export const LOCAL_INDEX_CHECKPOINT_EVERY = 50;

interface LockOpResult {
    acquired: boolean;
    holder?: string;
    expiresIn?: number;
    /** Our write was overwritten by another device (worth retrying) */
    contended?: boolean;
}

interface LockOp {
    kind: "acquire" | "release";
    path: string;
    logPrefix?: string;
    resolve: (r: LockOpResult) => void;
    reject: (e: unknown) => void;
}

interface CycleState {
    active: boolean;
    comm: { data: CommunicationData; at: number } | null;
    lockChain: Promise<void>;
    pendingLockOps: LockOp[];
    deferDepth: number;
    localIndexDirty: boolean;
    skippedLocalIndexSaves: number;
}

const cycleStates = new WeakMap<object, CycleState>();

function cycleState(ctx: SyncContext): CycleState {
    let s = cycleStates.get(ctx);
    if (!s) {
        s = {
            active: false,
            comm: null,
            lockChain: Promise.resolve(),
            pendingLockOps: [],
            deferDepth: 0,
            localIndexDirty: false,
            skippedLocalIndexSaves: 0,
        };
        cycleStates.set(ctx, s);
    }
    return s;
}

/** Start of a sync cycle: enable caching, defer local-index writes. */
export function beginSyncCycle(ctx: SyncContext): void {
    const s = cycleState(ctx);
    s.active = true;
    s.comm = null;
    s.deferDepth++;
}

/** End of a sync cycle: drop caches and flush deferred local-index writes. */
export async function endSyncCycle(ctx: SyncContext): Promise<void> {
    const s = cycleState(ctx);
    s.active = false;
    s.comm = null;
    s.deferDepth = Math.max(0, s.deferDepth - 1);
    if (s.deferDepth === 0 && s.localIndexDirty) {
        await saveLocalIndex(ctx);
    }
}

function cloneComm(data: CommunicationData): CommunicationData {
    return { ...data, mergeLocks: { ...data.mergeLocks } };
}

function dropExpiredLocks(data: CommunicationData): CommunicationData {
    const now = Date.now();
    for (const [path, lock] of Object.entries(data.mergeLocks)) {
        if (lock.expiresAt < now) {
            delete data.mergeLocks[path];
        }
    }
    return data;
}

// === Communication.json Management ===

/**
 * Load communication.json. Inside a sync cycle a copy cached for up to
 * COMM_CACHE_MAX_AGE_MS is returned unless `fresh` is set; lock updates
 * always read fresh data.
 */
export async function loadCommunication(
    ctx: SyncContext,
    opts: { fresh?: boolean } = {},
): Promise<CommunicationData> {
    const s = cycleState(ctx);
    if (!opts.fresh && s.active && s.comm && Date.now() - s.comm.at < COMM_CACHE_MAX_AGE_MS) {
        return dropExpiredLocks(cloneComm(s.comm.data));
    }
    try {
        const meta = await ctx.adapter.getFileMetadata(ctx.communicationPath);
        let data: CommunicationData;
        if (!meta) {
            data = { mergeLocks: {}, lastUpdated: 0 };
        } else {
            const content = await ctx.adapter.downloadFile(meta.id);
            const text = new TextDecoder().decode(content);
            data = JSON.parse(text) as CommunicationData;
            data.mergeLocks ??= {};
        }
        dropExpiredLocks(data);
        if (s.active) s.comm = { data: cloneComm(data), at: Date.now() };
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
        const s = cycleState(ctx);
        if (s.active) s.comm = { data: cloneComm(data), at: Date.now() };
    } catch (e) {
        const s = cycleState(ctx);
        s.comm = null;
        await ctx.log(`[Communication] Failed to save: ${e}`, "error");
        throw e;
    }
}

/**
 * Queue a lock update. Updates queued while another round is in flight are
 * applied together in ONE load -> save -> verify round, so N parallel merges
 * cost ~5 API calls instead of ~5N, and this device never overwrites its own
 * concurrent lock writes.
 */
function enqueueLockOp(
    ctx: SyncContext,
    kind: LockOp["kind"],
    path: string,
    logPrefix?: string,
): Promise<LockOpResult> {
    const s = cycleState(ctx);
    return new Promise<LockOpResult>((resolve, reject) => {
        s.pendingLockOps.push({ kind, path, logPrefix, resolve, reject });
        s.lockChain = s.lockChain.then(() => flushLockOps(ctx));
    });
}

async function flushLockOps(ctx: SyncContext): Promise<void> {
    const s = cycleState(ctx);
    const ops = s.pendingLockOps.splice(0);
    if (ops.length === 0) return;
    try {
        const comm = await loadCommunication(ctx, { fresh: true });
        const now = Date.now();
        const results = new Map<LockOp, LockOpResult>();
        let changed = false;
        const released: LockOp[] = [];

        for (const op of ops) {
            const existing = comm.mergeLocks[op.path];
            if (op.kind === "acquire") {
                if (existing && existing.expiresAt > now && existing.holder !== ctx.deviceId) {
                    results.set(op, {
                        acquired: false,
                        holder: existing.holder,
                        expiresIn: Math.floor((existing.expiresAt - now) / 1000),
                    });
                } else {
                    comm.mergeLocks[op.path] = {
                        holder: ctx.deviceId,
                        expiresAt: now + LOCK_TTL_MS,
                    };
                    changed = true;
                }
            } else {
                if (existing && existing.holder === ctx.deviceId) {
                    delete comm.mergeLocks[op.path];
                    changed = true;
                    released.push(op);
                }
                results.set(op, { acquired: false });
            }
        }

        if (changed) {
            await saveCommunication(ctx, comm);
            for (const op of released) {
                await ctx.log(
                    `[${op.logPrefix || "Communication"}] Merge lock released for ${op.path}.`,
                    "debug",
                );
            }
            const toVerify = ops.filter((op) => op.kind === "acquire" && !results.has(op));
            if (toVerify.length > 0) {
                const verify = await loadCommunication(ctx, { fresh: true });
                for (const op of toVerify) {
                    const lock = verify.mergeLocks[op.path];
                    if (lock && lock.holder === ctx.deviceId) {
                        results.set(op, { acquired: true });
                    } else {
                        results.set(op, {
                            acquired: false,
                            contended: true,
                            holder: lock?.holder,
                            expiresIn: lock ? Math.floor((lock.expiresAt - now) / 1000) : 0,
                        });
                    }
                }
            }
        }
        for (const op of ops) op.resolve(results.get(op) ?? { acquired: false });
    } catch (e) {
        for (const op of ops) op.reject(e);
    }
}

export async function acquireMergeLock(
    ctx: SyncContext,
    path: string,
): Promise<{ acquired: boolean; holder?: string; expiresIn?: number }> {
    for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt++) {
        const r = await enqueueLockOp(ctx, "acquire", path);
        if (r.acquired) return { acquired: true };
        if (!r.contended) {
            return { acquired: false, holder: r.holder, expiresIn: r.expiresIn };
        }

        // Verification failed — another device wrote concurrently. Retry with jitter.
        if (attempt < LOCK_MAX_ATTEMPTS - 1) {
            const jitter = LOCK_JITTER_MIN_MS + Math.random() * LOCK_JITTER_RANGE_MS;
            await ctx.log(
                `[Communication] Lock contention for ${path} (attempt ${attempt + 1}/${LOCK_MAX_ATTEMPTS}). Retrying in ${Math.round(jitter)}ms...`,
                "warn",
            );
            await new Promise((r) => setTimeout(r, jitter));
        } else {
            return { acquired: false, holder: r.holder, expiresIn: r.expiresIn };
        }
    }

    return { acquired: false };
}

export async function releaseMergeLock(
    ctx: SyncContext,
    path: string,
    logPrefix?: string,
): Promise<void> {
    try {
        await enqueueLockOp(ctx, "release", path, logPrefix);
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
        const data = await ctx.vault.readBinary(ctx.pluginDataPath);
        const decompressed = await tryDecompress(data);
        const text = new TextDecoder().decode(decompressed);
        const parsed = JSON.parse(text);
        ctx.index = parsed.index || {};
        ctx.startPageToken = parsed.startPageToken || null;

        if (data.byteLength !== decompressed.byteLength) {
            await ctx.log(
                "[Index] Detected compressed local index. Normalizing to plain text...",
                "info",
            );
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
            if (await ctx.vault.exists(rawPath)) {
                const data = await ctx.vault.read(rawPath);
                const parsed = JSON.parse(data);
                ctx.index = parsed.index || {};
                ctx.startPageToken = parsed.startPageToken || null;
                await ctx.log("[Index] Successfully recovered from raw index.", "info");
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
        if (await ctx.vault.exists(ctx.localIndexPath)) {
            const data = await ctx.vault.read(ctx.localIndexPath);
            const parsed = JSON.parse(data);
            ctx.localIndex = parsed.index || {};
            ctx.deviceId = parsed.deviceId || "";

            if (!ctx.deviceId) {
                ctx.deviceId = generateDeviceId();

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
            // Always start with empty localIndex on a new device.
            // Copying ctx.index would make the plugin think all remote files
            // exist locally, preventing full pull on a fresh device.
            ctx.localIndex = {};
            ctx.deviceId = generateDeviceId();

            const isAlreadyLogged = ctx.logFolder === `${ctx.pluginDir}/logs/${ctx.deviceId}`;

            // Set folder BEFORE logging
            ctx.logFolder = `${ctx.pluginDir}/logs/${ctx.deviceId}`;
            if (!isAlreadyLogged) {
                await ctx.log(
                    `[Local Index] Not found. Initialized fresh. Device ID: ${ctx.deviceId}`,
                    "system",
                );
            }
            await saveLocalIndex(ctx);
        }
    } catch (e) {
        const isAlreadyLogged =
            ctx.deviceId && ctx.logFolder === `${ctx.pluginDir}/logs/${ctx.deviceId}`;

        // Fallback device ID
        ctx.deviceId = ctx.deviceId || generateDeviceId();
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

    // Ensure parent directory exists (may not on fresh install)
    const dir = ctx.pluginDataPath.replace(/\/[^/]+$/, "");
    if (!(await ctx.vault.exists(dir))) {
        await ctx.vault.mkdir(dir);
    }

    await ctx.vault.write(ctx.pluginDataPath, data);

    const rawPath = ctx.pluginDataPath.replace(".json", "_raw.json");
    try {
        await ctx.vault.write(rawPath, data);
    } catch (e) {
        console.error("Vault-Sync: Failed to save raw index backup", e);
    }

    await saveLocalIndex(ctx);
}

export async function saveLocalIndex(ctx: SyncContext): Promise<void> {
    const s = cycleState(ctx);
    if (s.deferDepth > 0) {
        s.localIndexDirty = true;
        if (++s.skippedLocalIndexSaves < LOCAL_INDEX_CHECKPOINT_EVERY) return;
    }
    s.localIndexDirty = false;
    s.skippedLocalIndexSaves = 0;
    try {
        const data = JSON.stringify({
            index: ctx.localIndex,
            deviceId: ctx.deviceId,
        });
        await ctx.vault.write(ctx.localIndexPath, data);
    } catch (e) {
        console.error("Vault-Sync: Failed to save local index", e);
    }
}

export async function resetIndex(ctx: SyncContext): Promise<void> {
    ctx.index = {};
    ctx.localIndex = {};
    ctx.startPageToken = null;
    ctx.adapter.clearDownloadCache?.();
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
    ctx.dirtyPaths.set(path, Date.now());
}

export function markDeleted(ctx: SyncContext, path: string): void {
    if (shouldIgnore(ctx, path)) return;
    if (ctx.index[path]) {
        ctx.dirtyPaths.set(path, Date.now());
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
            ctx.dirtyPaths.set(path, Date.now());
            ctx.log(`[Dirty] Marked for deletion (child): ${path}`, "debug");
        }
    }
}

export function markRenamed(ctx: SyncContext, oldPath: string, newPath: string): void {
    if (shouldIgnore(ctx, newPath)) return;

    const oldDir = dirname(oldPath);
    const newDir = dirname(newPath);
    const isMove = oldDir !== newDir;

    // 未同期ファイルのリネーム/移動（oldPath がインデックスになく dirtyPaths にある）
    if (ctx.dirtyPaths.has(oldPath) && !ctx.index[oldPath]) {
        ctx.dirtyPaths.delete(oldPath);
        ctx.dirtyPaths.set(newPath, Date.now());
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

    ctx.dirtyPaths.set(newPath, Date.now());
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
    ctx.dirtyPaths.set(newFolderPath, Date.now()); // Ensure the folder itself is processed

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
            ctx.dirtyPaths.set(newPath, Date.now());
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
