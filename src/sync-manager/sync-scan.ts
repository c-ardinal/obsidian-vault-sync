import type { SyncContext } from "./context";
import {
    listFilesRecursive,
    isManagedSeparately,
    shouldNotBeOnRemote,
    shouldIgnore,
    isDeviceExcluded,
} from "./file-utils";
import { computeLocalHash } from "./sync-helpers";
import { markRenamed } from "./state";
import { entryIdentityHash, localIdentityHash } from "./content-identity";
import type { FileUtilsCtx } from "./file-utils";
import type { StateCtx } from "./state";
import type { SyncHelpersCtx } from "./sync-helpers";

/** What this module reads from the sync context */
export type ScanCtx = Pick<
    SyncContext,
    | "dirtyPaths"
    | "e2eeEnabled"
    | "index"
    | "localIndex"
    | "log"
    | "pluginDataPath"
    | "recentlyDeletedFromRemote"
    | "syncingPaths"
    | "vault"
> & FileUtilsCtx & StateCtx & SyncHelpersCtx;

/**
 * Scan .obsidian directory for changes
 * Vault events don't fire for .obsidian files, so we need to scan manually
 */
export async function scanObsidianChanges(ctx: ScanCtx): Promise<void> {
    try {
        const obsidianFiles = await listFilesRecursive(ctx, ".obsidian");

        for (const filePath of obsidianFiles) {
            if (shouldIgnore(ctx, filePath)) continue;
            if (ctx.syncingPaths.has(filePath)) continue;

            const stat = await ctx.vault.stat(filePath);
            if (!stat) continue;

            const indexEntry = ctx.localIndex[filePath];

            if (!indexEntry) {
                // Skip if this file was recently deleted from remote
                // (prevents re-upload when local deletion failed)
                if (ctx.recentlyDeletedFromRemote.has(filePath)) {
                    await ctx.log(
                        `[Obsidian Scan] Skipped (recently deleted from remote): ${filePath}`,
                        "debug",
                    );
                    continue;
                }
                ctx.dirtyPaths.set(filePath, Date.now());
                await ctx.log(`[Obsidian Scan] New: ${filePath}`, "debug");
                continue;
            }

            if (stat.mtime > indexEntry.mtime) {
                try {
                    const content = await ctx.vault.readBinary(filePath);
                    const { localHash, compareHash } = await computeLocalHash(ctx, content, indexEntry);
                    if (compareHash && localHash !== compareHash.toLowerCase()) {
                        ctx.dirtyPaths.set(filePath, Date.now());
                        await ctx.log(
                            `[Obsidian Scan] Modified (hash mismatch vs localIndex): ${filePath}`,
                            "debug",
                        );
                    } else if (!indexEntry.hash) {
                        ctx.dirtyPaths.set(filePath, Date.now());
                        await ctx.log(
                            `[Obsidian Scan] Modified (no prev hash in localIndex): ${filePath}`,
                            "debug",
                        );
                    } else {
                        ctx.localIndex[filePath].mtime = stat.mtime;
                        if (ctx.index[filePath]) {
                            ctx.index[filePath].mtime = stat.mtime;
                        }
                    }
                } catch {
                    ctx.dirtyPaths.set(filePath, Date.now());
                }
            }
        }

        const currentObsidianFiles = new Set(obsidianFiles);
        for (const path of Object.keys(ctx.localIndex)) {
            if (!path.startsWith(".obsidian/")) continue;
            if (path === ctx.pluginDataPath) continue;
            if (isManagedSeparately(path)) continue;
            if (isDeviceExcluded(ctx, path)) continue;

            const isIgnored = shouldNotBeOnRemote(ctx, path);
            const isMissing = !currentObsidianFiles.has(path);

            if (isMissing || isIgnored) {
                if (ctx.index[path]) {
                    ctx.dirtyPaths.set(path, Date.now());
                    await ctx.log(
                        `[Obsidian Scan] Marked for remote deletion (${isMissing ? "missing" : "ignored"}): ${path}`,
                        "debug",
                    );
                } else {
                    delete ctx.localIndex[path];
                    ctx.dirtyPaths.delete(path);
                }
            }
        }
    } catch (e) {
        await ctx.log(`[Obsidian Scan] Error: ${String(e)}`, "error");
    }
}

/**
 * Scan all vault files for changes (missing events while app was closed)
 * This is O(N) but fast because it uses Obsidian's cached file metadata
 */
export async function scanVaultChanges(ctx: ScanCtx): Promise<void> {
    try {
        await ctx.log("[Vault Scan] Starting full vault scan...", "debug");
        const start = Date.now();

        const files = ctx.vault.getFiles();
        const currentPaths = new Set<string>();
        const newPaths: string[] = [];
        const missingPaths: string[] = [];

        for (const file of files) {
            if (shouldIgnore(ctx, file.path)) continue;

            currentPaths.add(file.path);

            if (file.path.startsWith(".obsidian/")) continue;

            const indexEntry = ctx.localIndex[file.path];

            if (!indexEntry) {
                // Skip if this file was recently deleted from remote
                // (prevents re-upload when local deletion failed)
                if (ctx.recentlyDeletedFromRemote.has(file.path)) {
                    await ctx.log(
                        `[Vault Scan] Skipped (recently deleted from remote): ${file.path}`,
                        "debug",
                    );
                    continue;
                }
                ctx.dirtyPaths.set(file.path, Date.now());
                newPaths.push(file.path);
                await ctx.log(`[Vault Scan] New: ${file.path}`, "debug");
            } else if (file.stat.mtime > indexEntry.mtime) {
                try {
                    const content = await ctx.vault.readBinary(file.path);
                    const { localHash, compareHash } = await computeLocalHash(ctx, content, indexEntry);
                    if (compareHash && localHash !== compareHash.toLowerCase()) {
                        ctx.dirtyPaths.set(file.path, Date.now());
                        await ctx.log(
                            `[Vault Scan] Modified (hash mismatch vs localIndex): ${file.path}`,
                            "debug",
                        );
                    } else if (!compareHash) {
                        ctx.dirtyPaths.set(file.path, Date.now());
                        await ctx.log(
                            `[Vault Scan] Modified (no prev hash in localIndex): ${file.path}`,
                            "debug",
                        );
                    } else {
                        ctx.localIndex[file.path].mtime = file.stat.mtime;
                        if (ctx.index[file.path]) {
                            ctx.index[file.path].mtime = file.stat.mtime;
                        }
                    }
                } catch (e) {
                    await ctx.log(`[Vault Scan] Hash check failed for ${file.path}: ${String(e)}`, "warn");
                }
            }
        }

        for (const path of Object.keys(ctx.localIndex)) {
            if (path.startsWith(".obsidian/")) continue;
            if (path === ctx.pluginDataPath) continue;
            if (isManagedSeparately(path)) continue;
            if (isDeviceExcluded(ctx, path)) continue;

            const isIgnored = shouldNotBeOnRemote(ctx, path);
            const isMissing = !currentPaths.has(path);

            if (isMissing || isIgnored) {
                if (ctx.index[path]) {
                    if (isMissing && !isIgnored) missingPaths.push(path);
                    ctx.dirtyPaths.set(path, Date.now());
                    await ctx.log(
                        `[Vault Scan] Marked for remote deletion (${isMissing ? "missing" : "ignored"}): ${path}`,
                        "debug",
                    );
                } else {
                    delete ctx.localIndex[path];
                    ctx.dirtyPaths.delete(path);
                }
            }
        }

        // A rename or move recorded in the index but not pushed yet (pendingMove /
        // forcePush). Its dirty mark only lived in memory, so after the app was killed
        // nothing pushed it: the other devices kept the old name forever.
        for (const [path, entry] of Object.entries(ctx.index)) {
            if (!(entry.pendingMove || entry.forcePush)) continue;
            if (path === ctx.pluginDataPath || ctx.dirtyPaths.has(path)) continue;
            if (!currentPaths.has(path)) continue;
            ctx.dirtyPaths.set(path, Date.now());
            await ctx.log(`[Vault Scan] Unpushed ${entry.pendingMove ? "move" : "change"}: ${path}`, "debug");
        }
        // A merge result written locally but not pushed yet: the local file already
        // matches the local index, so the scan saw nothing to do and the other device's
        // half of the merge never reached the cloud.
        for (const [path, entry] of Object.entries(ctx.localIndex)) {
            if (entry.lastAction !== "merge") continue;
            if (path === ctx.pluginDataPath || ctx.dirtyPaths.has(path)) continue;
            if (!currentPaths.has(path)) continue;
            ctx.dirtyPaths.set(path, Date.now());
            await ctx.log(`[Vault Scan] Unpushed merge: ${path}`, "debug");
        }

        await pairRenames(ctx, missingPaths, newPaths);

        await ctx.log(`[Vault Scan] Completed in ${Date.now() - start}ms`, "debug");
    } catch (e) {
        await ctx.log(`[Vault Scan] Error: ${String(e)}`, "error");
    }
}

/**
 * A synced file gone from its path plus a new file with exactly its content: a
 * rename whose vault event has not arrived (yet). Uploading the new path as a new
 * file and deleting the old one left two cloud files for one note when the event
 * came after all, and edits other devices made under the old name stayed there.
 * Treat it as the rename it is.
 */
async function pairRenames(ctx: ScanCtx, missing: string[], added: string[]): Promise<void> {
    if (missing.length === 0 || added.length === 0) return;
    const byHash = new Map<string, string>();
    for (const path of added) {
        try {
            const content = await ctx.vault.readBinary(path);
            const localHash = await localIdentityHash(ctx, content);
            if (!byHash.has(localHash)) byHash.set(localHash, path);
        } catch {
            // unreadable: leave it as a new file
        }
    }
    for (const oldPath of missing) {
        const entry = ctx.localIndex[oldPath];
        const known = entryIdentityHash(ctx, entry)?.toLowerCase();
        const newPath = known ? byHash.get(known) : undefined;
        if (!newPath || ctx.localIndex[newPath]) continue;
        byHash.delete(known!);
        markRenamed(ctx, oldPath, newPath);
        await ctx.log(`[Vault Scan] ${oldPath} -> ${newPath} is a rename (same content).`, "debug");
    }
}
