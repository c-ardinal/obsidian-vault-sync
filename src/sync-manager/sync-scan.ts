import type { SyncContext } from "./context";
import {
    listFilesRecursive,
    isManagedSeparately,
    shouldNotBeOnRemote,
    shouldIgnore,
} from "./file-utils";
import { computeLocalHash } from "./sync-helpers";

/**
 * Scan .obsidian directory for changes
 * Vault events don't fire for .obsidian files, so we need to scan manually
 */
export async function scanObsidianChanges(ctx: SyncContext): Promise<void> {
    try {
        const obsidianFiles = await listFilesRecursive(ctx, ".obsidian");

        for (const filePath of obsidianFiles) {
            if (shouldIgnore(ctx, filePath)) continue;
            if (ctx.syncingPaths.has(filePath)) continue;

            const stat = await ctx.vault.stat(filePath);
            if (!stat) continue;

            const indexEntry = ctx.localIndex[filePath];

            // New file (not in local index)
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

            // Check if modified (mtime changed)
            if (stat.mtime > indexEntry.mtime) {
                // Mtime changed: verify content hash to confirm actual modification
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
                        // No previous hash, but mtime changed. Assume dirty to be safe and update hash.
                        ctx.dirtyPaths.set(filePath, Date.now());
                        await ctx.log(
                            `[Obsidian Scan] Modified (no prev hash in localIndex): ${filePath}`,
                            "debug",
                        );
                    } else {
                        // Hash matches, just update mtime in indices to avoid future re-hashing
                        ctx.localIndex[filePath].mtime = stat.mtime;
                        if (ctx.index[filePath]) {
                            ctx.index[filePath].mtime = stat.mtime;
                        }
                        // await ctx.log(`[Obsidian Scan] Skipped (hash match): ${filePath}`);
                    }
                } catch {
                    // Read failed, assume dirty
                    ctx.dirtyPaths.set(filePath, Date.now());
                }
            }
        }

        // Check for deleted or now-ignored .obsidian files
        const currentObsidianFiles = new Set(obsidianFiles);
        for (const path of Object.keys(ctx.localIndex)) {
            if (!path.startsWith(".obsidian/")) continue;
            if (path === ctx.pluginDataPath) continue;
            if (isManagedSeparately(path)) continue;

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
                    // Cleanup local-only entries without marking as dirty for remote deletion
                    delete ctx.localIndex[path];
                    ctx.dirtyPaths.delete(path);
                }
            }
        }
    } catch (e) {
        await ctx.log(`[Obsidian Scan] Error: ${e}`, "error");
    }
}

/**
 * Scan all vault files for changes (missing events while app was closed)
 * This is O(N) but fast because it uses Obsidian's cached file metadata
 */
export async function scanVaultChanges(ctx: SyncContext): Promise<void> {
    try {
        await ctx.log("[Vault Scan] Starting full vault scan...", "debug");
        const start = Date.now();

        const files = ctx.vault.getFiles();
        const currentPaths = new Set<string>();

        // 1. Check for New and Modified files
        for (const file of files) {
            if (shouldIgnore(ctx, file.path)) continue;

            // Track existence for deletion check
            currentPaths.add(file.path);

            // .obsidian files are handled by scanObsidianChanges, so we skip them here
            // (getFiles() usually doesn't return them anyway, but safety first)
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
                // New file (not in local index)
                ctx.dirtyPaths.set(file.path, Date.now());
                await ctx.log(`[Vault Scan] New: ${file.path}`, "debug");
            } else if (file.stat.mtime > indexEntry.mtime) {
                // Mtime changed: verify content hash
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
                        // Hash matches, update indices mtime
                        ctx.localIndex[file.path].mtime = file.stat.mtime;
                        if (ctx.index[file.path]) {
                            ctx.index[file.path].mtime = file.stat.mtime;
                        }
                    }
                } catch (e) {
                    // Read failed
                    await ctx.log(`[Vault Scan] Hash check failed for ${file.path}: ${e}`, "warn");
                }
            }
        }

        // 2. Check for Deleted or now-Ignored files (in localIndex but not in vault/now ignored)
        for (const path of Object.keys(ctx.localIndex)) {
            // Skip .obsidian files (handled by scanObsidianChanges)
            if (path.startsWith(".obsidian/")) continue;
            if (path === ctx.pluginDataPath) continue;
            if (isManagedSeparately(path)) continue;

            const isIgnored = shouldNotBeOnRemote(ctx, path);
            const isMissing = !currentPaths.has(path);

            if (isMissing || isIgnored) {
                if (ctx.index[path]) {
                    ctx.dirtyPaths.set(path, Date.now());
                    await ctx.log(
                        `[Vault Scan] Marked for remote deletion (${isMissing ? "missing" : "ignored"}): ${path}`,
                        "debug",
                    );
                } else {
                    // Cleanup local-only entries without marking as dirty for remote deletion
                    delete ctx.localIndex[path];
                    ctx.dirtyPaths.delete(path);
                }
            }
        }

        await ctx.log(`[Vault Scan] Completed in ${Date.now() - start}ms`, "debug");
    } catch (e) {
        await ctx.log(`[Vault Scan] Error: ${e}`, "error");
    }
}
