import { md5 } from "../utils/md5";
import type { CloudFile } from "../types/adapter";
import type { SyncContext } from "./context";
import type { LocalFileIndex, SyncState } from "./types";
import {
    PLUGIN_DIR,
    INTERNAL_LOCAL_ONLY,
    listFilesRecursive,
    getLocalFiles,
    runParallel,
    compress,
    tryDecompress,
    isManagedSeparately,
    shouldNotBeOnRemote,
    shouldIgnore,
} from "./file-utils";
import {
    loadCommunication,
    saveIndex,
    saveLocalIndex,
    clearPendingPushStates,
} from "./state";
import { pullFileSafely } from "./merge";

// ==========================================================================
// Scanning
// ==========================================================================

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

            const stat = await ctx.app.vault.adapter.stat(filePath);
            if (!stat) continue;

            const indexEntry = ctx.localIndex[filePath];

            // New file (not in local index)
            if (!indexEntry) {
                // Skip if this file was recently deleted from remote
                // (prevents re-upload when local deletion failed)
                if (ctx.recentlyDeletedFromRemote.has(filePath)) {
                    await ctx.log(
                        `[Obsidian Scan] Skipped (recently deleted from remote): ${filePath}`,
                    );
                    continue;
                }
                ctx.dirtyPaths.add(filePath);
                await ctx.log(`[Obsidian Scan] New: ${filePath}`);
                continue;
            }

            // Check if modified (mtime changed)
            if (stat.mtime > indexEntry.mtime) {
                // Mtime changed: verify content hash to confirm actual modification
                try {
                    const content = await ctx.app.vault.adapter.readBinary(filePath);
                    const localHash = md5(content);
                    if (indexEntry.hash && localHash !== indexEntry.hash.toLowerCase()) {
                        ctx.dirtyPaths.add(filePath);
                        await ctx.log(
                            `[Obsidian Scan] Modified (hash mismatch vs localIndex): ${filePath}`,
                        );
                    } else if (!indexEntry.hash) {
                        // No previous hash, but mtime changed. Assume dirty to be safe and update hash.
                        ctx.dirtyPaths.add(filePath);
                        await ctx.log(
                            `[Obsidian Scan] Modified (no prev hash in localIndex): ${filePath}`,
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
                    ctx.dirtyPaths.add(filePath);
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
                    ctx.dirtyPaths.add(path);
                    await ctx.log(
                        `[Obsidian Scan] Marked for remote deletion (${isMissing ? "missing" : "ignored"}): ${path}`,
                    );
                } else {
                    // Cleanup local-only entries without marking as dirty for remote deletion
                    delete ctx.localIndex[path];
                    ctx.dirtyPaths.delete(path);
                }
            }
        }
    } catch (e) {
        await ctx.log(`[Obsidian Scan] Error: ${e}`);
    }
}

/**
 * Scan all vault files for changes (missing events while app was closed)
 * This is O(N) but fast because it uses Obsidian's cached file metadata
 */
export async function scanVaultChanges(ctx: SyncContext): Promise<void> {
    try {
        await ctx.log("[Vault Scan] Starting full vault scan...");
        const start = Date.now();

        const files = ctx.app.vault.getFiles();
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
                    );
                    continue;
                }
                // New file (not in local index)
                ctx.dirtyPaths.add(file.path);
                await ctx.log(`[Vault Scan] New: ${file.path}`);
            } else if (file.stat.mtime > indexEntry.mtime) {
                // Mtime changed: verify content hash
                try {
                    const content = await ctx.app.vault.adapter.readBinary(file.path);
                    const localHash = md5(content);

                    if (indexEntry.hash && localHash !== indexEntry.hash.toLowerCase()) {
                        ctx.dirtyPaths.add(file.path);
                        await ctx.log(
                            `[Vault Scan] Modified (hash mismatch vs localIndex): ${file.path}`,
                        );
                    } else if (!indexEntry.hash) {
                        ctx.dirtyPaths.add(file.path);
                        await ctx.log(
                            `[Vault Scan] Modified (no prev hash in localIndex): ${file.path}`,
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
                    await ctx.log(`[Vault Scan] Hash check failed for ${file.path}: ${e}`);
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
                    ctx.dirtyPaths.add(path);
                    await ctx.log(
                        `[Vault Scan] Marked for remote deletion (${isMissing ? "missing" : "ignored"}): ${path}`,
                    );
                } else {
                    // Cleanup local-only entries without marking as dirty for remote deletion
                    delete ctx.localIndex[path];
                    ctx.dirtyPaths.delete(path);
                }
            }
        }

        await ctx.log(`[Vault Scan] Completed in ${Date.now() - start}ms`);
    } catch (e) {
        await ctx.log(`[Vault Scan] Error: ${e}`);
    }
}

// ==========================================================================
// Smart Sync Entry Points
// ==========================================================================

/**
 * Request Smart Sync - high priority, interrupts full scan
 * This is the main entry point for user-triggered syncs
 * @param isSilent If true, suppress initial notifications (errors still shown)
 * @param scanVault If true, perform a full vault scan for changes (O(N)) - useful for startup
 */
export async function requestSmartSync(
    ctx: SyncContext,
    isSilent: boolean = true,
    scanVault: boolean = false,
): Promise<void> {
    // If already smart syncing, mark that we need another pass after and wait.
    if (ctx.syncState === "SMART_SYNCING") {
        ctx.syncRequestedWhileSyncing = true;
        if (!ctx.nextSyncParams) {
            ctx.nextSyncParams = { isSilent, scanVault };
        } else {
            // Merge requirements: if any request is NOT silent, the next pass should not be silent.
            // If any request wants a full scan, the next pass should scan.
            ctx.nextSyncParams.isSilent = ctx.nextSyncParams.isSilent && isSilent;
            ctx.nextSyncParams.scanVault = ctx.nextSyncParams.scanVault || scanVault;
        }

        if (ctx.currentSyncPromise) {
            await ctx.currentSyncPromise;
        }
        return;
    }

    // Interrupt running full scan
    if (ctx.syncState === "FULL_SCANNING") {
        await ctx.log("[Smart Sync] Interrupting full scan...");
        ctx.isInterrupted = true;
        // Wait for full scan to pause
        if (ctx.currentSyncPromise) {
            await ctx.currentSyncPromise;
        }

        // RACE CONDITION FIX:
        // After waiting, another request might have woken up first and started syncing.
        // Re-check state to ensure we don't run parallel syncs.
        if ((ctx.syncState as SyncState) === "SMART_SYNCING") {
            if (ctx.currentSyncPromise) {
                await ctx.currentSyncPromise;
            }
            return;
        }
    }

    let currentIsSilent = isSilent;
    let currentScanVault = scanVault;

    // Execute smart sync with re-queueing support
    do {
        ctx.syncRequestedWhileSyncing = false;
        ctx.syncState = "SMART_SYNCING";
        ctx.currentSyncPromise = executeSmartSync(ctx, currentIsSilent, currentScanVault);

        try {
            await ctx.currentSyncPromise;
        } finally {
            ctx.syncState = "IDLE";
            ctx.currentSyncPromise = null;
        }

        // If another request came in, prepare parameters for the next pass
        if (ctx.syncRequestedWhileSyncing && ctx.nextSyncParams) {
            currentIsSilent = ctx.nextSyncParams.isSilent;
            currentScanVault = ctx.nextSyncParams.scanVault;
            ctx.nextSyncParams = null;
        }
    } while (ctx.syncRequestedWhileSyncing);
}

/**
 * Execute Smart Sync logic
 * - Pull: Check remote changes via sync-index.json hash comparison (or Changes API)
 * - Push: Upload dirty files
 */
export async function executeSmartSync(
    ctx: SyncContext,
    isSilent: boolean,
    scanVault: boolean,
): Promise<void> {
    if (!isSilent) {
        ctx.startActivity();
    }
    try {
        await ctx.log("=== SMART SYNC START ===");
        await ctx.notify(ctx.t("noticeSyncing"), false, isSilent);

        // Clean up recentlyDeletedFromRemote: remove entries for files that no longer exist locally
        // (they were successfully deleted, so we don't need to track them anymore)
        for (const path of [...ctx.recentlyDeletedFromRemote]) {
            const exists = await ctx.app.vault.adapter.exists(path);
            if (!exists) {
                ctx.recentlyDeletedFromRemote.delete(path);
            }
        }

        // Pre-warm adapter (ensure root folders exist) to avoid delay in push phase
        if (ctx.adapter.initialize) {
            await ctx.adapter.initialize();
        }

        // === PULL PHASE ===
        // Call via ctx so vi.spyOn on SyncManager instance methods works in tests
        const pulled = await ctx.smartPull(isSilent);

        // === PUSH PHASE ===
        if (scanVault) {
            await ctx.notify(ctx.t("noticeScanningLocalFiles"), false, isSilent);
        }
        const pushed = await ctx.smartPush(isSilent, scanVault);

        // === CONFIRMATION PHASE (Initial Sync Only) ===
        // For initial sync (scanVault=true, isSilent=false) with Changes API support,
        // we immediately check for our own pushes to confirm identity and update ancestor hashes.
        // Skipped during startup sync (isSilent=true) since confirmation is only needed on first sync.
        if (pushed && scanVault && !isSilent && ctx.adapter.supportsChangesAPI) {
            await ctx.log(
                "[Smart Sync] Initial sync push detected. Running immediate identity check...",
            );
            await ctx.notify(ctx.t("noticeInitialSyncConfirmation"), false, isSilent);

            await ctx.pullViaChangesAPI(isSilent, true);

            // Re-confirm completion after identity check
            await ctx.notify(
                ctx.t("noticePushCompleted").replace("{0}", "1"),
                false,
                isSilent,
            );
        }

        if (!pulled && !pushed) {
            await ctx.notify(ctx.t("noticeVaultUpToDate"), false, isSilent);
        }

        await ctx.log("=== SMART SYNC COMPLETED ===");
    } catch (e) {
        await ctx.log(`Smart Sync failed: ${e}`);
        throw e;
    } finally {
        ctx.endActivity();
    }
}

// ==========================================================================
// Pull
// ==========================================================================

/**
 * Smart Pull - O(1) check for remote changes using sync-index.json hash
 */
export async function smartPull(ctx: SyncContext, isSilent: boolean): Promise<boolean> {
    await ctx.log("[Smart Pull] Checking for remote changes...");

    // Check for active merge locks from other devices FIRST
    // This prevents race conditions where Changes API hasn't caught up yet
    const commData = await loadCommunication(ctx);
    const now = Date.now();
    for (const [path, lock] of Object.entries(commData.mergeLocks)) {
        if (lock.holder !== ctx.deviceId && lock.expiresAt > now) {
            await ctx.log(
                `[Smart Pull] Active merge lock detected: ${path} by ${lock.holder} (expires in ${Math.round((lock.expiresAt - now) / 1000)}s)`,
            );
        }
    }

    // --- FORCED CLEANUP: Wipe forbidden system directories ---
    // We only do this if a full cleanup is requested (e.g., startup).
    if (ctx.forceCleanupNextSync) {
        for (const dirName of INTERNAL_LOCAL_ONLY) {
            if (dirName.endsWith("/")) {
                const fullDirPath = PLUGIN_DIR + dirName.slice(0, -1);
                try {
                    const meta = await ctx.adapter.getFileMetadata(fullDirPath);
                    if (meta?.id) {
                        await ctx.adapter.deleteFile(meta.id);
                        await ctx.log(
                            `[Smart Pull] [System Cleanup] Forced wipe of internal directory: ${fullDirPath}`,
                        );
                    }
                } catch (e) {
                    // Ignore (already clean or not found)
                }
            }
        }
    }

    // Check if adapter supports Changes API for faster detection
    if (ctx.adapter.supportsChangesAPI) {
        if (ctx.startPageToken) {
            await ctx.log("[Smart Pull] Using Changes API (fast path)");
            return await pullViaChangesAPI(ctx, isSilent);
        } else {
            await ctx.log(
                "[Smart Pull] Initializing Changes API token (will be used next time)",
            );
            try {
                ctx.startPageToken = await ctx.adapter.getStartPageToken();
                await saveIndex(ctx);
            } catch (e) {
                await ctx.log(`[Smart Pull] Failed to init Changes API: ${e}`);
            }
            // Fall through to standard hash check for this run
        }
    }

    // Core path: sync-index.json hash comparison
    await ctx.log("[Smart Pull] Using sync-index.json hash comparison (core path)");

    // Get remote index metadata (O(1) operation)
    const remoteIndexMeta = await ctx.adapter.getFileMetadata(ctx.pluginDataPath);

    if (!remoteIndexMeta) {
        await ctx.log("[Smart Pull] No remote index found. Skipping pull.");
        return false;
    }

    // Compare hashes - use stored hash (from last push) instead of calculating
    // because local file includes self-reference which differs from uploaded content
    const localIndexHash = ctx.index[ctx.pluginDataPath]?.hash?.toLowerCase() || "";
    const remoteIndexHash = remoteIndexMeta.hash?.toLowerCase() || "";

    if (localIndexHash && remoteIndexHash && localIndexHash === remoteIndexHash) {
        await ctx.log("[Smart Pull] Index hash matches. No remote changes detected.");
        // Sync confirmed - clear pending push/merge states
        clearPendingPushStates(ctx);
        await saveIndex(ctx);
        return false;
    }

    // Hashes differ - download remote index and compare
    await ctx.log(
        `[Smart Pull] Index hash differs (local: ${localIndexHash}, remote: ${remoteIndexHash}). Fetching remote index...`,
    );

    const remoteIndexContent = await ctx.adapter.downloadFile(remoteIndexMeta.id);
    const decompressed = await tryDecompress(remoteIndexContent);
    const remoteIndexData = JSON.parse(new TextDecoder().decode(decompressed));
    const remoteIndex: LocalFileIndex = remoteIndexData.index || {};

    // === CORRUPTION CHECK ===
    // If index is empty but file is large (>200 bytes), assume corruption.
    // Also if index is empty but we have > 20 local files, be very suspicious
    const remoteKeys = Object.keys(remoteIndex);
    const localKeys = Object.keys(ctx.index);

    if (remoteKeys.length === 0) {
        if (remoteIndexMeta.size > 200) {
            throw new Error(
                `Remote index corruption detected: File size is ${remoteIndexMeta.size} bytes but parsed 0 files.`,
            );
        }
        if (localKeys.length > 20) {
            // Prevent accidental wipe of large local vault if remote index appears empty
            throw new Error(
                `Safety Halt: Remote index is empty but local has ${localKeys.length} files. This looks like data corruption. Aborting to prevent data loss.`,
            );
        }
    }

    // Compare indexes to find changes
    const toDownload: Array<{
        path: string;
        fileId: string;
        hash?: string;
        mergeLock?: { holder: string; expiresAt: number };
    }> = [];
    const toDeleteLocal: string[] = [];

    // Find files to download or cleanup
    const toDeleteRemote: Array<{ path: string; fileId: string }> = [];

    // Pre-calculate ID map for rename detection
    const localIdToPath = new Map<string, string>();
    for (const [p, entry] of Object.entries(ctx.index)) {
        if (entry.fileId) localIdToPath.set(entry.fileId, p);
    }

    for (const [path, remoteEntry] of Object.entries(remoteIndex)) {
        if (path === ctx.pluginDataPath) continue;
        if (isManagedSeparately(path)) continue;

        // NEW: リモートにあってはいけないファイルを見つけたら、即座に削除キューへ
        if (shouldNotBeOnRemote(ctx, path)) {
            toDeleteRemote.push({ path, fileId: remoteEntry.fileId });
            continue;
        }

        const localBaseEntry = ctx.localIndex[path];

        if (!localBaseEntry) {
            // Check if this fileId exists locally under a different name (Rename in progress)
            // If we renamed A -> B locally, remote still sees A.
            // We should NOT download A if we are about to push B (which patches A -> B).
            const renamedLocalPath = localIdToPath.get(remoteEntry.fileId);
            if (
                renamedLocalPath &&
                renamedLocalPath !== path &&
                ctx.dirtyPaths.has(renamedLocalPath)
            ) {
                await ctx.log(
                    `[Smart Pull] Skipped ghost file ${path} (renamed locally to ${renamedLocalPath})`,
                );
                continue;
            }

            // New file on remote (we don't even have a base for it)
            toDownload.push({
                path,
                fileId: remoteEntry.fileId,
                hash: remoteEntry.hash,
                mergeLock: remoteEntry.mergeLock,
            });
        } else if (
            remoteEntry.hash &&
            localBaseEntry.hash &&
            remoteEntry.hash.toLowerCase() !== localBaseEntry.hash.toLowerCase()
        ) {
            // Modified on remote (remote differs from our local base)
            toDownload.push({
                path,
                fileId: remoteEntry.fileId,
                hash: remoteEntry.hash,
                mergeLock: remoteEntry.mergeLock,
            });
        }
    }

    // Find files to delete locally (removed on remote)
    for (const path of Object.keys(ctx.localIndex)) {
        if (path === ctx.pluginDataPath) continue;
        if (shouldIgnore(ctx, path)) continue;

        if (!remoteIndex[path]) {
            const localBase = ctx.localIndex[path];
            const isModified =
                ctx.dirtyPaths.has(path) ||
                localBase?.lastAction === "push" ||
                localBase?.lastAction === "merge";

            if (isModified) {
                await ctx.log(
                    `[Smart Pull] Conflict: ${path} removed from remote but modified locally. Queuing for merge check.`,
                );
                toDownload.push({ path, fileId: "" } as any); // Dummy fileId for deletion conflict
            } else {
                toDeleteLocal.push(path);
            }
        }
    }

    await ctx.log(
        `[Smart Pull] Changes: ${toDownload.length} to download, ${toDeleteLocal.length} to delete`,
    );

    if (toDownload.length === 0 && toDeleteLocal.length === 0) {
        await ctx.log("[Smart Pull] No file changes detected.");
        // Sync confirmed - clear pending push/merge states
        clearPendingPushStates(ctx);
        // Update index metadata
        ctx.index[ctx.pluginDataPath] = {
            fileId: remoteIndexMeta.id,
            mtime: remoteIndexMeta.mtime,
            size: remoteIndexMeta.size,
            hash: remoteIndexMeta.hash,
        };
        await saveIndex(ctx);
        return false;
    }

    // Download changed files
    const tasks: (() => Promise<void>)[] = [];
    let completed = 0;
    const total = toDownload.length + toDeleteLocal.length;

    for (const item of toDownload) {
        tasks.push(async () => {
            const success = await pullFileSafely(ctx, item, isSilent, "Smart Pull");
            if (success) {
                completed++;
                await ctx.log(`[Smart Pull] [${completed}/${total}] Synced: ${item.path}`);
            }
        });
    }

    // Delete local files that were removed on remote
    for (const path of toDeleteLocal) {
        // Track this path to prevent re-upload if local deletion fails
        ctx.recentlyDeletedFromRemote.add(path);
        tasks.push(async () => {
            try {
                const file = ctx.app.vault.getAbstractFileByPath(path);
                if (file) {
                    await ctx.app.vault.trash(file, true);
                }
                delete ctx.index[path];
                delete ctx.localIndex[path];

                completed++;
                await ctx.log(`[Smart Pull] [${completed}/${total}] Deleted locally: ${path}`);
                await ctx.notify(
                    `${ctx.t("noticeFileTrashed")}: ${path.split("/").pop()}`,
                    true,
                    isSilent,
                );
            } catch (e) {
                await ctx.log(`[Smart Pull] Delete failed: ${path} - ${e}`);
            }
        });
    }

    // Execute deletions for forbidden files found on remote
    if (toDeleteRemote.length > 0) {
        // Optimization: group by folders
        const foldersToWipe = new Set<string>();
        const separateFiles: Array<{ path: string; fileId: string }> = [];

        for (const item of toDeleteRemote) {
            const parts = item.path.split("/");
            let highestIgnoredParent: string | null = null;
            for (let i = 1; i < parts.length; i++) {
                const parentPath = parts.slice(0, i).join("/");
                if (shouldNotBeOnRemote(ctx, parentPath + "/")) {
                    highestIgnoredParent = parentPath;
                    break;
                }
            }
            if (highestIgnoredParent) {
                foldersToWipe.add(highestIgnoredParent);
            } else {
                separateFiles.push(item);
            }
        }

        for (const folder of foldersToWipe) {
            tasks.push(async () => {
                try {
                    const meta = await ctx.adapter.getFileMetadata(folder);
                    if (meta?.id) {
                        await ctx.adapter.deleteFile(meta.id);
                        await ctx.log(
                            `[Smart Pull] [Cleanup] Wiped forbidden folder: ${folder}`,
                        );
                        // Cleanup index entries
                        const prefix = folder + "/";
                        for (const path of Object.keys(ctx.index)) {
                            if (path.startsWith(prefix)) {
                                delete ctx.index[path];
                                delete ctx.localIndex[path];
                            }
                        }
                    }
                } catch (e) {
                    await ctx.log(
                        `[Smart Pull] [Cleanup] Folder wipe failed: ${folder} - ${e}`,
                    );
                }
            });
        }

        for (const file of separateFiles) {
            tasks.push(async () => {
                try {
                    await ctx.adapter.deleteFile(file.fileId);
                    await ctx.log(
                        `[Smart Pull] [Cleanup] Deleted forbidden file: ${file.path}`,
                    );
                    delete ctx.index[file.path];
                    delete ctx.localIndex[file.path];
                } catch (e) {
                    await ctx.log(
                        `[Smart Pull] [Cleanup] File delete failed: ${file.path} - ${e}`,
                    );
                }
            });
        }
    }

    if (tasks.length > 0) {
        ctx.startActivity();
        try {
            await runParallel(tasks, ctx.settings.concurrency);
        } finally {
            // Keep spinning until executeSmartSync finishes
        }
    }

    // Update index with remote index metadata
    ctx.index[ctx.pluginDataPath] = {
        fileId: remoteIndexMeta.id,
        mtime: remoteIndexMeta.mtime,
        size: remoteIndexMeta.size,
        hash: remoteIndexMeta.hash,
    };
    await saveIndex(ctx);

    if (total > 0) {
        await ctx.notify(
            ctx.t("noticePullCompleted").replace("{0}", total.toString()),
            false,
            false,
        );
        return true;
    }
    return false;
}

/**
 * Pull via Changes API (for adapters that support it)
 * @param isSilent Suppress notifications
 * @param drainAll If true, process all available pages of changes (useful after initial push)
 */
export async function pullViaChangesAPI(
    ctx: SyncContext,
    isSilent: boolean,
    drainAll: boolean = false,
): Promise<boolean> {
    if (!ctx.startPageToken) {
        ctx.startPageToken = await ctx.adapter.getStartPageToken();
        await saveIndex(ctx);
    }

    let hasTotalChanges = false;
    let currentPageToken = ctx.startPageToken;
    let confirmedCountTotal = 0;
    let pageCount = 1;
    let totalCompleted = 0;

    do {
        const changes = await ctx.adapter.getChanges(currentPageToken);

        if (changes.changes.length === 0) {
            await ctx.log("[Smart Pull] No changes from Changes API");
            if (changes.newStartPageToken) {
                ctx.startPageToken = changes.newStartPageToken;
                await saveIndex(ctx);
            }
            break; // No more changes
        }

        await ctx.log(
            `[Smart Pull] Changes API page processed (${changes.changes.length} items)`,
        );
        hasTotalChanges = true;

        // In confirmation mode, if we haven't confirmed anything yet, notify user about the wait
        if (drainAll && confirmedCountTotal === 0) {
            await ctx.notify(
                `${ctx.t("noticeWaitingForRemoteRegistration")} (Page ${pageCount++})...`,
                false,
                isSilent,
            );
        }

        // Load communication data for mergeLock checks
        const commData = await loadCommunication(ctx);

        const tasks: (() => Promise<void>)[] = [];
        let completed = 0;

        // Pre-calculate ID map for rename detection (Ghost File Check)
        const localIdToPath = new Map<string, string>();
        for (const [p, entry] of Object.entries(ctx.index)) {
            if (entry.fileId) localIdToPath.set(entry.fileId, p);
        }

        for (const change of changes.changes) {
            if (change.removed) {
                // File was deleted on remote
                const pathToDelete = Object.entries(ctx.index).find(
                    ([, entry]) => entry.fileId === change.fileId,
                )?.[0];

                if (pathToDelete && pathToDelete !== ctx.pluginDataPath) {
                    // Track this path to prevent re-upload if local deletion fails
                    ctx.recentlyDeletedFromRemote.add(pathToDelete);
                    tasks.push(async () => {
                        try {
                            const file = ctx.app.vault.getAbstractFileByPath(pathToDelete);
                            if (file) {
                                await ctx.app.vault.trash(file, true);
                            }
                            delete ctx.index[pathToDelete];
                            delete ctx.localIndex[pathToDelete]; // Added for consistency
                            completed++;
                            await ctx.log(`[Smart Pull] Deleted: ${pathToDelete}`);
                            await ctx.notify(
                                `${ctx.t("noticeFileTrashed")}: ${pathToDelete.split("/").pop()}`,
                                true,
                                isSilent,
                            );
                        } catch (e) {
                            await ctx.log(
                                `[Smart Pull] Delete failed: ${pathToDelete} - ${e}`,
                            );
                        }
                    });
                }
            } else if (change.file && change.file.kind === "file") {
                // File was added or modified
                const cloudFile = change.file;
                if (cloudFile.path === ctx.pluginDataPath) continue;
                if (isManagedSeparately(cloudFile.path)) continue;

                // NEW: もしリモート禁止対象ファイルが上がってきたら、即座に削除
                if (shouldNotBeOnRemote(ctx, cloudFile.path)) {
                    tasks.push(async () => {
                        try {
                            await ctx.adapter.deleteFile(cloudFile.id);
                            await ctx.log(
                                `[Smart Pull] [Cleanup] Deleted forbidden file (via Changes API): ${cloudFile.path}`,
                            );
                            delete ctx.index[cloudFile.path];
                            delete ctx.localIndex[cloudFile.path];
                        } catch (e) {
                            await ctx.log(
                                `[Smart Pull] [Cleanup] Failed to delete forbidden file: ${cloudFile.path} - ${e}`,
                            );
                        }
                    });
                    continue;
                }

                // Check if another device is merging this file
                const mergeLock = commData.mergeLocks[cloudFile.path];
                const now = Date.now();
                if (
                    mergeLock &&
                    mergeLock.holder !== ctx.deviceId &&
                    mergeLock.expiresAt > now
                ) {
                    await ctx.log(
                        `[Smart Pull] Waiting: ${cloudFile.path} is being merged by ${mergeLock.holder} (expires in ${Math.round((mergeLock.expiresAt - now) / 1000)}s)`,
                    );
                    await ctx.notify(
                        `${ctx.t("noticeWaitOtherDeviceMerge")}: ${cloudFile.path.split("/").pop()}`,
                        true,
                        isSilent,
                    );
                    // Mark as pending conflict so next sync shows "merge result applied"
                    if (ctx.localIndex[cloudFile.path]) {
                        ctx.localIndex[cloudFile.path].pendingConflict = true;
                        await saveLocalIndex(ctx);
                    }
                    continue; // Skip this file, wait for merge to complete
                }

                // Skip if local index hash matches (already synced by this client)
                const localEntry = ctx.index[cloudFile.path];
                if (localIdToPath.has(cloudFile.id)) {
                    const prevPathForId = localIdToPath.get(cloudFile.id);
                    if (prevPathForId && prevPathForId !== cloudFile.path) {
                        const oldPath = prevPathForId;
                        const newPath = cloudFile.path;

                        // Detected Remote Rename (A -> B)
                        // We should rename locally to preserve history/content.

                        // Check if target already exists locally
                        const targetExists = await ctx.app.vault.adapter.exists(newPath);

                        if (!targetExists) {
                            try {
                                // Check if source exists (it might have been deleted locally?)
                                const sourceExists =
                                    await ctx.app.vault.adapter.exists(oldPath);
                                if (sourceExists) {
                                    await ctx.log(
                                        `[Changes API] Remote Rename detected: ${oldPath} -> ${newPath}. Renaming locally.`,
                                    );

                                    // Execute Rename
                                    await ctx.app.vault.adapter.rename(oldPath, newPath);

                                    // Migrate Index Entries
                                    if (ctx.index[oldPath]) {
                                        ctx.index[newPath] = { ...ctx.index[oldPath] };
                                        delete ctx.index[oldPath];
                                    }
                                    if (ctx.localIndex[oldPath]) {
                                        ctx.localIndex[newPath] = {
                                            ...ctx.localIndex[oldPath],
                                        };
                                        delete ctx.localIndex[oldPath];
                                    }

                                    // Migrate Dirty State
                                    if (ctx.dirtyPaths.has(oldPath)) {
                                        ctx.dirtyPaths.delete(oldPath);
                                        ctx.dirtyPaths.add(newPath);
                                    }

                                    // Update ID Map so we don't process this again or inconsistently
                                    localIdToPath.set(cloudFile.id, newPath);

                                    await ctx.notify(
                                        `${ctx.t("noticeFileRenamed") || "Renamed"}: ${oldPath.split("/").pop()} -> ${newPath.split("/").pop()}`,
                                        true,
                                        isSilent,
                                    );
                                } else {
                                    // Source doesn't exist locally? Just removed from index/map then.
                                    // pullFileSafely will treat as new download.
                                    await ctx.log(
                                        `[Changes API] Remote Rename: Source ${oldPath} missing locally. Skipping rename.`,
                                    );
                                    if (ctx.index[oldPath]) delete ctx.index[oldPath];
                                    if (ctx.localIndex[oldPath])
                                        delete ctx.localIndex[oldPath];
                                }
                            } catch (e) {
                                await ctx.log(
                                    `[Changes API] Failed to rename ${oldPath} -> ${newPath}: ${e}`,
                                );
                                // Fallback: Do nothing, let pullFileSafely download new file. Old file remains as ghost.
                            }
                        } else {
                            await ctx.log(
                                `[Changes API] Remote Rename: Target ${newPath} exists. Skipping rename to avoid overwrite.`,
                            );
                            // Collision: A->B, but B exists.
                            // We can't rename. Old A remains.
                            // pullFileSafely will update B.
                            // We should probably disassociate A from this ID in our index to avoid confusion?
                            // If we leave A with ID 123, and B has ID 123...
                            // Next time we assume 123 is A again?
                            // localIdToPath will be rebuilt next run.
                            // If we don't delete A from index, it stays.
                            // Safe to leave it? Yes.
                        }
                    }
                }

                if (
                    localEntry?.hash &&
                    cloudFile.hash &&
                    localEntry.hash.toLowerCase() === cloudFile.hash.toLowerCase()
                ) {
                    if (
                        ctx.localIndex[cloudFile.path]?.lastAction === "push" ||
                        ctx.localIndex[cloudFile.path]?.lastAction === "merge"
                    ) {
                        ctx.localIndex[cloudFile.path].lastAction = "pull";
                        ctx.localIndex[cloudFile.path].ancestorHash = cloudFile.hash;
                        ctx.index[cloudFile.path].ancestorHash = cloudFile.hash;
                        await ctx.log(
                            `[Smart Pull] Sync confirmed for ${cloudFile.path}. ancestorHash updated to ${cloudFile.hash?.substring(0, 8)}`,
                        );

                        // Notify individual confirmation if detailed notifications are on
                        confirmedCountTotal++;
                        await ctx.notify(
                            `${ctx.t("noticeSyncConfirmed")}: ${cloudFile.path.split("/").pop()}`,
                            true,
                            isSilent,
                        );
                    }
                    await ctx.log(`[Smart Pull] Skipping (hash match): ${cloudFile.path}`);
                    continue;
                }

                tasks.push(async () => {
                    const success = await pullFileSafely(
                        ctx,
                        cloudFile,
                        isSilent,
                        "Changes API",
                    );
                    if (success) {
                        completed++;
                        await ctx.log(`[Changes API] Synced: ${cloudFile.path}`);
                    }
                });
            }
        }

        if (tasks.length > 0) {
            ctx.startActivity();
            try {
                await runParallel(tasks, ctx.settings.concurrency);
                totalCompleted += completed;
            } finally {
                // endActivity is handled by executeSmartSync
            }
        }

        // Advance to next page if supported, or settle on new start token
        if (changes.nextPageToken) {
            currentPageToken = changes.nextPageToken;
            ctx.startPageToken = currentPageToken;
            await saveIndex(ctx);
        } else if (changes.newStartPageToken) {
            ctx.startPageToken = changes.newStartPageToken;
            await saveIndex(ctx);
            break; // Reach the end
        } else {
            break; // No tokens, stop
        }

        if (!drainAll) break; // Only process one page unless drainAll is true
    } while (currentPageToken);

    if (hasTotalChanges) {
        // Notification for pulled files
        if (totalCompleted > 0) {
            await ctx.notify(
                ctx.t("noticePullCompleted").replace("{0}", totalCompleted.toString()),
                false, // isDetailed = false for summary
                isSilent, // Use isSilent from caller
            );
        }
        return true;
    }
    return false;
}

// ==========================================================================
// Push
// ==========================================================================

/**
 * Smart Push - upload only dirty files
 * O(1) when no dirty files, O(dirty count + .obsidian scan) otherwise
 * If scanVault is true, performs O(N) full vault scan before pushing
 */
export async function smartPush(
    ctx: SyncContext,
    isSilent: boolean,
    scanVault: boolean,
): Promise<boolean> {
    // Optional complete vault scan (for startup)
    if (scanVault) {
        await scanVaultChanges(ctx);
    }

    // Scan .obsidian files for changes (vault events don't fire for these)
    await scanObsidianChanges(ctx);

    // Pre-scan shared index for forbidden files
    // We only do this if full cleanup is requested to avoid O(N) overhead on every sync.
    if (ctx.forceCleanupNextSync) {
        for (const path of Object.keys(ctx.index)) {
            if (path === ctx.pluginDataPath) continue;
            if (isManagedSeparately(path)) continue;
            if (shouldNotBeOnRemote(ctx, path)) {
                ctx.dirtyPaths.add(path);
            }
        }
    }

    // === INFER DELETED FOLDERS ===
    // Startup Scan/Full Scan only detects missing files, not missing folders.
    // We must walk up the tree of missing files to find their missing folders.
    if (ctx.dirtyPaths.size > 0) {
        const checkedFolders = new Set<string>();
        const missingFiles: string[] = [];

        // Identify missing files that were previously synced
        for (const path of ctx.dirtyPaths) {
            if (ctx.index[path]) {
                // Quick check using adapter (async)
                // We can batch this or just do it sequentially (robustness > speed here)
                const exists = await ctx.app.vault.adapter.exists(path);
                if (!exists) {
                    missingFiles.push(path);
                }
            }
        }

        for (const path of missingFiles) {
            let folder = path.substring(0, path.lastIndexOf("/"));
            while (folder) {
                if (checkedFolders.has(folder)) break; // Optimization
                if (shouldIgnore(ctx, folder)) break;
                if (ctx.deletedFolders.has(folder)) {
                    checkedFolders.add(folder);
                    break;
                }

                const exists = await ctx.app.vault.adapter.exists(folder);
                // Do not mark as checked immediately, wait for existence check result logic

                if (!exists) {
                    // Folder is missing locally, mark for remote deletion
                    ctx.deletedFolders.add(folder);
                    await ctx.log(`[Smart Push] Inferred deleted folder: ${folder}`);
                    // Continue walking up to check parent
                    folder = folder.substring(0, folder.lastIndexOf("/"));
                } else {
                    // Folder exists, stop walking up
                    break;
                }
            }
        }
    }

    // === FOLDER DELETION PHASE ===
    let folderDeletedCount = 0;
    if (ctx.deletedFolders.size > 0) {
        ctx.startActivity(); // Spin if folder deletion needed
        await ctx.log(
            `[Smart Push] Processing ${ctx.deletedFolders.size} deleted folder(s)...`,
        );

        // Sort by depth (deepest first) to handle nested deletions cleanly
        const folders = Array.from(ctx.deletedFolders).sort((a, b) => b.length - a.length);

        for (const folderPath of folders) {
            try {
                // Try to find folder ID by path on remote
                const meta = await ctx.adapter.getFileMetadata(folderPath);
                if (meta && meta.id) {
                    if (meta.kind === "folder") {
                        await ctx.adapter.deleteFile(meta.id);
                        folderDeletedCount++;
                        await ctx.log(`[Smart Push] Deleted remote folder: ${folderPath}`);
                        await ctx.notify(
                            `${ctx.t("noticeFileTrashed")}: ${folderPath.split("/").pop()}`,
                            true,
                            isSilent,
                        );
                    }
                } else {
                    await ctx.log(
                        `[Smart Push] Folder not found on remote (already deleted?): ${folderPath}`,
                    );
                }

                // Clean up Index & DirtyPaths for all descendants
                // Since we deleted the parent, all children are gone on remote.
                const prefix = folderPath + "/";

                // 1. Remove from dirtyPaths to prevent redundant file deletion attempts
                // (Iterate copy to safely delete while iterating)
                for (const dirtyPath of Array.from(ctx.dirtyPaths)) {
                    if (dirtyPath.startsWith(prefix)) {
                        ctx.dirtyPaths.delete(dirtyPath);
                    }
                }

                // 2. Remove from Index
                const allPaths = Object.keys(ctx.index);
                for (const path of allPaths) {
                    if (path.startsWith(prefix)) {
                        delete ctx.index[path];
                        delete ctx.localIndex[path];
                    }
                }

                // Mark as handled
                ctx.deletedFolders.delete(folderPath);
            } catch (e) {
                await ctx.log(`[Smart Push] Failed to delete folder ${folderPath}: ${e}`);
            }
        }
    }

    if (ctx.dirtyPaths.size === 0 && folderDeletedCount === 0) {
        await ctx.log("[Smart Push] No dirty files to push. Skipping.");
        return false;
    }

    await ctx.log(`[Smart Push] Pushing ${ctx.dirtyPaths.size} dirty files...`);

    // Load communication data to check for active merge locks
    const commData = await loadCommunication(ctx);
    const now = Date.now();

    const uploadQueue: Array<{
        path: string;
        mtime: number;
        size: number;
        content: ArrayBuffer;
    }> = [];
    const deleteQueue: string[] = [];

    const dirtyPathTasks: (() => Promise<void>)[] = [];
    const dirtyPathsSnapshot = Array.from(ctx.dirtyPaths);

    for (const path of dirtyPathsSnapshot) {
        dirtyPathTasks.push(async () => {
            // Priority 0: Check if another device is currently merging this file
            const mergeLock = commData.mergeLocks[path];
            if (mergeLock && mergeLock.holder !== ctx.deviceId && mergeLock.expiresAt > now) {
                await ctx.log(
                    `[Smart Push] Skipping: ${path} is being merged by ${mergeLock.holder} (expires in ${Math.round((mergeLock.expiresAt - now) / 1000)}s)`,
                );
                // Don't remove from dirtyPaths - we'll retry next sync cycle
                return;
            }

            // Priority 1: 完全に外部(専用ロジック)で管理するファイル。汎用ループでは一切触らない。
            if (isManagedSeparately(path)) {
                return;
            }

            // Priority 2: リモートに存在してはいけないファイル。
            // 以前同期されていた（インデックスにある）ならリモートから掃除する。
            if (shouldNotBeOnRemote(ctx, path)) {
                if (ctx.localIndex[path]) {
                    deleteQueue.push(path);
                }
                return;
            }

            const exists = await ctx.app.vault.adapter.exists(path);
            if (exists) {
                const stat = await ctx.app.vault.adapter.stat(path);
                if (stat) {
                    // NEW: Handle folders
                    if (stat.type === "folder") {
                        try {
                            // Create folder on remote
                            await ctx.adapter.ensureFoldersExist([path]);
                            await ctx.log(`[Smart Push] Synced folder: ${path}`);
                            // Remove from dirty paths as it's handled
                            ctx.dirtyPaths.delete(path);
                            // Note: We don't index folders, so nothing to update in index
                            return;
                        } catch (e) {
                            await ctx.log(`[Smart Push] Failed to sync folder ${path}: ${e}`);
                            return;
                        }
                    }

                    // ... file handling continues ...
                    // OPTIONAL: Double check hash one last time before upload queue?
                    // But scan already did it. If markDirty came from event, we might want to check here.
                    // For now, let's calculate hash to store in queue so we don't have to read file twice if possible,
                    // OR just queue it and let uploadFile handle it.
                    // The user wants to avoid PUSH if hash is same.
                    // Since dirtyPaths can come from `markDirty` (events) which didn't check hash,
                    // we MUST check hash here to filter out "false alarms" from events.
                    try {
                        const content = await ctx.app.vault.adapter.readBinary(path);
                        // Get mtime AFTER reading content to ensure consistency
                        const statAfterRead = await ctx.app.vault.adapter.stat(path);
                        const mtimeAfterRead = statAfterRead?.mtime ?? stat.mtime;

                        const currentHash = md5(content);
                        const localIndexEntry = ctx.localIndex[path];

                        // Adoption/Shortcut Check:
                        // If index has a hash and it matches current, just update mtime and skip.
                        // If it's a NEW file (!indexEntry), check remote to see if we can adopt it without uploading.
                        let alreadyOnRemoteFile: CloudFile | null =
                            null;
                        if (!localIndexEntry) {
                            try {
                                alreadyOnRemoteFile = await ctx.adapter.getFileMetadata(path);
                            } catch (e) {
                                // Ignore metadata lookup errors
                            }
                        }

                        if (
                            localIndexEntry?.hash &&
                            localIndexEntry.hash.toLowerCase() === currentHash &&
                            localIndexEntry.lastAction !== "merge" && // Ensure pending merges are pushed
                            !localIndexEntry.forcePush // Force push if requested (e.g. rename)
                        ) {
                            // Local content matches our local base. No need to push.
                            // However, let's update mtimes to avoid re-calculating hash.
                            ctx.localIndex[path].mtime = mtimeAfterRead;
                            if (ctx.index[path]) {
                                ctx.index[path].mtime = mtimeAfterRead;
                            }
                            ctx.dirtyPaths.delete(path); // Remove from dirty since content matches
                            await ctx.log(`[Smart Push] Skipped (hash match): ${path}`);
                            return;
                        } else if (
                            !localIndexEntry &&
                            alreadyOnRemoteFile?.hash &&
                            alreadyOnRemoteFile.hash.toLowerCase() === currentHash
                        ) {
                            // NEW file found on remote with SAME hash -> Adopt it!
                            // Treat as "pull" since we're accepting remote state
                            const entry = {
                                fileId: alreadyOnRemoteFile.id,
                                mtime: mtimeAfterRead,
                                size: content.byteLength,
                                hash: alreadyOnRemoteFile.hash,
                                lastAction: "pull" as const,
                                ancestorHash: alreadyOnRemoteFile.hash, // Set ancestor for future merges
                            };
                            ctx.index[path] = entry;
                            ctx.localIndex[path] = { ...entry };
                            ctx.dirtyPaths.delete(path);
                            await ctx.log(
                                `[Smart Push] Adopted existing remote file: ${path}`,
                            );
                            return;
                        }

                        // Hash differs or new file -> Queue for upload with buffered content
                        uploadQueue.push({
                            path,
                            mtime: mtimeAfterRead,
                            size: content.byteLength,
                            content,
                        });
                    } catch (e) {
                        await ctx.log(
                            `[Smart Push] Failed to read ${path} for hash check: ${e}`,
                        );
                    }
                }
            } else {
                // File was deleted locally
                if (ctx.localIndex[path]) {
                    deleteQueue.push(path);
                }
            }
        });
    }
    if (dirtyPathTasks.length > 0) {
        await runParallel(dirtyPathTasks, 20);
    }

    const totalOps = uploadQueue.length + deleteQueue.length;
    if (totalOps === 0 && folderDeletedCount === 0) {
        await ctx.log("[Smart Push] No changes after filtering.");
        return false;
    }

    ctx.startActivity(); // Spin for upload/delete work

    // ctx.onActivityStart();
    try {
        // Ensure folders exist on remote
        // OPTIMIZATION: Removed listFiles() call here. We just pass the folders we need.
        // The adapter's ensureFoldersExist is smart enough to check existence efficiently (O(depth) vs O(total_files))
        const foldersToCreate = new Set<string>();
        for (const file of uploadQueue) {
            const parts = file.path.split("/");
            for (let i = 1; i < parts.length; i++) {
                foldersToCreate.add(parts.slice(0, i).join("/"));
            }
        }

        if (foldersToCreate.size > 0) {
            const sortedFolders = Array.from(foldersToCreate).sort(
                (a, b) => a.length - b.length,
            );
            await ctx.adapter.ensureFoldersExist(sortedFolders);
        }

        // Execute uploads and deletions
        const tasks: (() => Promise<void>)[] = [];
        let completed = 0;

        for (const file of uploadQueue) {
            tasks.push(async () => {
                try {
                    // Check if file was modified after queue creation (user still typing)
                    const currentStat = await ctx.app.vault.adapter.stat(file.path);
                    if (currentStat && currentStat.mtime !== file.mtime) {
                        // File was modified after queue creation - re-mark as dirty and skip
                        ctx.dirtyPaths.add(file.path);
                        await ctx.log(
                            `[Smart Push] Skipped (modified during sync): ${file.path}`,
                        );
                        return;
                    }

                    // === CONFLICT CHECK (Optimistic Locking) ===
                    // Before uploading, check if remote has changed since our last sync.
                    // If remote hash != index hash, someone else pushed. We MUST NOT overwrite.
                    let remoteMeta: CloudFile | null = null;
                    try {
                        const params = {
                            fileId: ctx.index[file.path]?.fileId,
                            path: file.path,
                        };
                        // Use fileId if available for faster lookup, otherwise path
                        if (params.fileId) {
                            try {
                                // CRITICAL FIX: Use ID-based lookup if available!
                                // Google Drive Search API (q=name=...) is Eventually Consistent and may return stale hash.
                                // Direct GET by ID is Strongly Consistent (mostly).
                                remoteMeta = await ctx.adapter.getFileMetadataById(
                                    params.fileId,
                                    file.path,
                                );
                            } catch {
                                /* ignore not found */
                            }
                        } else {
                            try {
                                remoteMeta = await ctx.adapter.getFileMetadata(file.path);
                            } catch {
                                /* ignore not found */
                            }
                        }

                        if (remoteMeta) {
                            const lastKnownHash = ctx.localIndex[file.path]?.hash;
                            const remoteHash = remoteMeta.hash;

                            // If we have a previous record and remote hash differs -> CONFLICT
                            // If we are new (no index) but remote exists -> CONFLICT (or adoption)
                            // Standard conflict condition: Remote exists AND (We don't know it OR It changed since we knew it)
                            if (
                                remoteHash &&
                                (!lastKnownHash ||
                                    lastKnownHash.toLowerCase() !== remoteHash.toLowerCase())
                            ) {
                                // EXCEPTION: If we just merged locally, we are ahead of remote.
                                // The hash mismatch is expected (Local=Merged, Remote=Old).
                                // We should treat this as a valid update, not a conflict.
                                if (ctx.localIndex[file.path]?.lastAction === "merge") {
                                    await ctx.log(
                                        `[Smart Push] Allowing push of merged file (hash mismatch expected): ${file.path}`,
                                    );
                                } else {
                                    await ctx.log(
                                        `[Smart Push] CONFLICT DETECTED: Remote changed for ${file.path}`,
                                    );
                                    await ctx.log(
                                        `[Smart Push] Local Base: ${lastKnownHash?.substring(0, 8)}, Remote: ${remoteHash.substring(0, 8)}`,
                                    );

                                    await ctx.log(
                                        `[Smart Push] [Deadlock Breaking] Attempting immediate pull/merge for ${file.path}...`,
                                    );
                                    await pullFileSafely(
                                        ctx,
                                        remoteMeta,
                                        isSilent,
                                        "Push Conflict",
                                    );
                                    // Critical: return here to skip uploading the OLD content in this closure.
                                    // The file remains in dirtyPaths (or is re-added by pullFileSafely),
                                    // so it will be picked up in the next sync cycle.
                                    return;
                                }
                            }
                        }
                    } catch (e) {
                        // If check fails (network?), allow upload? Or fail safe?
                        // Safe: Fail validation, don't upload.
                        await ctx.log(`[Smart Push] Pre-upload validation failed: ${e}`);
                        // We don't return here? If we can't verify, maybe safe to fail this file sync.
                        // If just "Not Found", code above handles it (remoteMeta is null).
                        // If network error, we probably shouldn't upload.
                    }

                    // Use buffered content from queue creation (no re-read)
                    // CRITICAL FIX: Always prefer the ID from index if available (Migration/Renaming scenario)
                    // remoteMeta might be null if lookup failed or if we skipped lookup, but we might still have a valid ID in index.
                    const targetFileId = remoteMeta?.id || ctx.index[file.path]?.fileId;

                    const uploaded = await ctx.adapter.uploadFile(
                        file.path,
                        file.content,
                        file.mtime,
                        targetFileId,
                    );

                    // SUCCESS: Update indices with REMOTE metadata
                    // IMPORTANT: Do NOT update ancestorHash here!
                    // ancestorHash should only be updated when we CONFIRM that both Local and Remote
                    // have the same content (i.e., during Pull when hash matches).
                    // If we update ancestorHash here and another device pushes immediately after,
                    // ancestorHash would equal localBase.hash, causing the 3-way merge to incorrectly
                    // treat Local as "unchanged" and lose our pushed content.
                    const previousAncestorHash = ctx.localIndex[file.path]?.ancestorHash;
                    const entry = {
                        fileId: uploaded.id,
                        mtime: file.mtime,
                        size: uploaded.size,
                        hash: uploaded.hash,
                        lastAction: "push" as const,
                        ancestorHash: previousAncestorHash || uploaded.hash, // Preserve original ancestor, fallback for new files
                    };
                    ctx.index[file.path] = entry;
                    ctx.localIndex[file.path] = { ...entry };

                    // Success: Remove from dirtyPaths
                    ctx.dirtyPaths.delete(file.path);

                    completed++;
                    await ctx.log(
                        `[Smart Push] [${completed}/${totalOps}] Pushed: ${file.path}`,
                    );
                    await ctx.notify(
                        `${ctx.t("noticeFilePushed")}: ${file.path.split("/").pop()}`,
                        true,
                        isSilent,
                    );
                } catch (e) {
                    await ctx.log(`[Smart Push] Upload failed: ${file.path} - ${e}`);
                }
            });
        }

        // --- Deletion Logic Optimization: Folder Deletions ---
        const foldersToWipe = new Set<string>(); // Unique parent paths to delete
        const filesToWipeSimpler: string[] = []; // Files that don't belong to any wiped folder

        for (const path of deleteQueue) {
            const parts = path.split("/");
            let highestIgnoredParent: string | null = null;

            // Find the highest level parent directory that is now ignored
            for (let i = 1; i < parts.length; i++) {
                const parentPath = parts.slice(0, i).join("/");
                if (shouldNotBeOnRemote(ctx, parentPath + "/")) {
                    highestIgnoredParent = parentPath;
                    break;
                }
            }

            if (highestIgnoredParent) {
                foldersToWipe.add(highestIgnoredParent);
            } else {
                filesToWipeSimpler.push(path);
            }
        }

        // Execute folder deletions first
        for (const folderPath of foldersToWipe) {
            tasks.push(async () => {
                try {
                    // Find folder ID by looking up metadata by path
                    const meta = await ctx.adapter.getFileMetadata(folderPath);
                    if (meta && meta.id) {
                        await ctx.adapter.deleteFile(meta.id);
                        await ctx.log(
                            `[Smart Push] [Folder Wipe] Deleted ignored folder: ${folderPath}`,
                        );

                        // Cleanup ALL index entries that were under this folder
                        const prefix = folderPath + "/";
                        const allPaths = new Set([
                            ...Object.keys(ctx.index),
                            ...Object.keys(ctx.localIndex),
                        ]);
                        for (const path of allPaths) {
                            if (path.startsWith(prefix)) {
                                delete ctx.index[path];
                                delete ctx.localIndex[path];
                                ctx.dirtyPaths.delete(path);
                            }
                        }
                        completed++; // Count folder deletion as one operation
                    }
                } catch (e) {
                    await ctx.log(
                        `[Smart Push] [Folder Wipe] Failed to wipe folder ${folderPath}: ${e}`,
                    );
                }
            });
        }

        // Execute individual file deletions (for those not in wiped folders)
        for (const path of filesToWipeSimpler) {
            tasks.push(async () => {
                try {
                    const entry = ctx.index[path];
                    if (entry) {
                        await ctx.adapter.deleteFile(entry.fileId);
                        delete ctx.index[path];
                        delete ctx.localIndex[path];
                        ctx.dirtyPaths.delete(path);

                        completed++;
                        await ctx.log(
                            `[Smart Push] [${completed}/${totalOps}] Deleted remote: ${path}`,
                        );
                        await ctx.notify(
                            `${ctx.t("noticeFileTrashed")}: ${path.split("/").pop()}`,
                            true,
                            isSilent,
                        );
                    } else {
                        // Zombie entry: in localIndex but not in shared index.
                        // Already "deleted" on remote by others or previous run.
                        delete ctx.localIndex[path];
                        ctx.dirtyPaths.delete(path);
                        await ctx.log(
                            `[Smart Push] Cleaned up zombie entry (local only): ${path}`,
                        );
                    }
                } catch (e) {
                    await ctx.log(`[Smart Push] Delete failed: ${path} - ${e}`);
                }
            });
        }

        await runParallel(tasks, ctx.settings.concurrency);

        // Do NOT clear all dirty paths here.
        // Items are removed from dirtyPaths individually upon success in the tasks above.
        // This ensures that failed items remain dirty and will be retried.

        // Reset cleanup flag after a successful cleanup run
        if (ctx.forceCleanupNextSync) {
            ctx.forceCleanupNextSync = false;
            await ctx.log("[Smart Push] Full cleanup scan completed and flag reset.");
        }

        // Upload updated index
        await saveIndex(ctx);
        try {
            const indexContent = await ctx.app.vault.adapter.readBinary(ctx.pluginDataPath);
            const compressedIndex = await compress(indexContent);
            const uploadedIndex = await ctx.adapter.uploadFile(
                ctx.pluginDataPath,
                compressedIndex,
                Date.now(),
            );
            ctx.index[ctx.pluginDataPath] = {
                fileId: uploadedIndex.id,
                mtime: Date.now(),
                size: uploadedIndex.size,
                hash: uploadedIndex.hash,
            };

            // Upload raw index backup (best effort, uncompressed)
            const rawPath = ctx.pluginDataPath.replace(".json", "_raw.json");
            try {
                if (await ctx.app.vault.adapter.exists(rawPath)) {
                    const rawContent = await ctx.app.vault.adapter.readBinary(rawPath);
                    await ctx.adapter.uploadFile(rawPath, rawContent, Date.now());
                    await ctx.log(`[Smart Push] Raw index backup uploaded.`);
                }
            } catch (rawErr) {
                await ctx.log(`[Smart Push] Failed to upload raw index: ${rawErr}`);
            }

            await saveIndex(ctx);
            await ctx.log(`[Smart Push] Index uploaded. Hash: ${uploadedIndex.hash}`);
        } catch (e) {
            await ctx.log(`[Smart Push] Failed to upload index: ${e}`);
        }

        if (completed > 0) {
            await ctx.notify(
                ctx.t("noticePushCompleted").replace("{0}", completed.toString()),
                false,
                isSilent,
            );
        }
        return true;
    } finally {
        // ctx.onActivityEnd();
    }
}

// ==========================================================================
// Background Full Scan
// ==========================================================================

/**
 * Request Background Full Scan - low priority, can be interrupted
 * @param resume If true, try to resume from previous progress
 */
export async function requestBackgroundScan(
    ctx: SyncContext,
    resume: boolean = false,
): Promise<void> {
    // Don't start if already syncing
    if (ctx.syncState !== "IDLE") {
        await ctx.log("[Full Scan] Skipped - sync already in progress");
        return;
    }

    // Check if we should resume or start fresh
    if (!resume || !ctx.fullScanProgress || isProgressStale(ctx)) {
        ctx.fullScanProgress = null;
    }

    ctx.syncState = "FULL_SCANNING";
    ctx.isInterrupted = false;
    ctx.currentSyncPromise = executeFullScan(ctx);

    try {
        await ctx.currentSyncPromise;
    } finally {
        if (ctx.syncState === "FULL_SCANNING") {
            ctx.syncState = "IDLE";
        }
        ctx.currentSyncPromise = null;
    }
}

/**
 * Check if stored progress is too old
 */
export function isProgressStale(ctx: SyncContext): boolean {
    if (!ctx.fullScanProgress) return true;
    return Date.now() - ctx.fullScanProgress.startedAt > ctx.FULL_SCAN_MAX_AGE_MS;
}

/**
 * Execute Full Scan with interrupt support
 */
export async function executeFullScan(ctx: SyncContext): Promise<void> {
    try {
        await ctx.log("=== BACKGROUND FULL SCAN START ===");

        // Initialize or resume progress
        if (!ctx.fullScanProgress) {
            await ctx.log("[Full Scan] Fetching file lists...");
            const localFiles = await getLocalFiles(ctx);
            const remoteFiles = await ctx.adapter.listFiles();

            // Check for interrupt after heavy listing operation
            if (ctx.isInterrupted) {
                ctx.syncState = "PAUSED"; // Or IDLE handled by finally/caller logic?
                // Actually requestSmartSync handles the state transition after this promise resolves.
                // But we should stop here.
                return;
            }

            ctx.fullScanProgress = {
                currentIndex: 0,
                totalFiles: remoteFiles.length,
                localFiles: localFiles.map((f) => ({
                    path: f.path,
                    mtime: f.mtime,
                    size: f.size,
                })),
                remoteFiles: remoteFiles.map((f) => ({
                    id: f.id,
                    path: f.path,
                    mtime: f.mtime,
                    size: f.size,
                    hash: f.hash,
                })),
                startedAt: Date.now(),
            };
        } else {
            await ctx.log(
                `[Full Scan] Resuming from index ${ctx.fullScanProgress.currentIndex}/${ctx.fullScanProgress.totalFiles}`,
            );
        }

        const { localFiles, remoteFiles } = ctx.fullScanProgress;
        const localPathsMap = new Map(localFiles.map((f) => [f.path, f]));
        const CHUNK_SIZE = 10; // Process in chunks to allow interruption

        // Process remote files in chunks
        while (ctx.fullScanProgress.currentIndex < remoteFiles.length) {
            // Check for interrupt
            if (ctx.isInterrupted) {
                await ctx.log(
                    `[Full Scan] Interrupted at index ${ctx.fullScanProgress.currentIndex}`,
                );
                ctx.syncState = "PAUSED";
                return;
            }

            const chunk = remoteFiles.slice(
                ctx.fullScanProgress.currentIndex,
                ctx.fullScanProgress.currentIndex + CHUNK_SIZE,
            );

            for (const remoteFile of chunk) {
                if (remoteFile.path === ctx.pluginDataPath) continue;
                if (shouldIgnore(ctx, remoteFile.path)) continue;

                const localFile = localPathsMap.get(remoteFile.path);
                const indexEntry = ctx.index[remoteFile.path];

                // Check for discrepancies
                if (!localFile && indexEntry) {
                    // File exists in index but not locally - might have been deleted
                    await ctx.log(
                        `[Full Scan] Discrepancy: ${remoteFile.path} in index but not local`,
                    );
                } else if (localFile && !indexEntry && remoteFile.hash) {
                    // File exists locally but not in index - check if it matches remote
                    try {
                        const content = await ctx.app.vault.adapter.readBinary(
                            remoteFile.path,
                        );
                        const localHash = md5(content);
                        if (localHash === remoteFile.hash.toLowerCase()) {
                            // Adopt into index - treat as "pull" since we're accepting remote state
                            ctx.index[remoteFile.path] = {
                                fileId: remoteFile.id,
                                mtime: localFile.mtime,
                                size: localFile.size,
                                hash: remoteFile.hash,
                                lastAction: "pull",
                                ancestorHash: remoteFile.hash, // Set ancestor for future merges
                            };
                            await ctx.log(`[Full Scan] Adopted: ${remoteFile.path}`);
                        }
                    } catch {
                        // Ignore hash calculation errors
                    }
                }
            }

            ctx.fullScanProgress.currentIndex += chunk.length;

            // Yield to allow interrupt check
            await new Promise((resolve) => setTimeout(resolve, 0));
        }

        // Scan completed
        await ctx.log("=== BACKGROUND FULL SCAN COMPLETED ===");
        ctx.fullScanProgress = null;
        await saveIndex(ctx);
    } catch (e) {
        await ctx.log(`[Full Scan] Error: ${e}`);
        ctx.fullScanProgress = null;
    }
}
