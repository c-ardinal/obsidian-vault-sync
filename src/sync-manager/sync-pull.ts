import type { SyncContext } from "./context";
import type { LocalFileIndex } from "./types";
import {
    PLUGIN_DIR,
    INTERNAL_LOCAL_ONLY,
    runParallel,
    isManagedSeparately,
    isAlwaysForbiddenOnRemote,
    shouldIgnore,
} from "./file-utils";
import { loadCommunication, saveIndex, saveLocalIndex, clearPendingPushStates } from "./state";
import { pullFileSafely } from "./merge";
import { TransferPriority } from "./transfer-types";
import { formatSize } from "../utils/format";
import { basename } from "../utils/path";
import { INTEGRITY_MIN_INDEX_SIZE_BYTES, INTEGRITY_MIN_LOCAL_FILE_COUNT } from "./constants";
import {
    downloadRemoteIndex,
    getThresholdBytes,
    generateTransferId,
    markPendingTransfer,
} from "./sync-helpers";


/** Check for active merge locks from other devices */
async function checkMergeLocks(ctx: SyncContext): Promise<void> {
    const commData = await loadCommunication(ctx);
    const now = Date.now();
    let localIndexChanged = false;
    for (const [path, lock] of Object.entries(commData.mergeLocks)) {
        if (lock.holder !== ctx.deviceId && lock.expiresAt > now) {
            await ctx.log(
                `[Smart Pull] Active merge lock detected: ${path} by ${lock.holder} (expires in ${Math.round((lock.expiresAt - now) / 1000)}s)`,
                "warn",
            );
            await ctx.notify("noticeWaitOtherDeviceMerge", basename(path));
            if (ctx.localIndex[path] && !ctx.localIndex[path].pendingConflict) {
                ctx.localIndex[path].pendingConflict = true;
                localIndexChanged = true;
            }
        }
    }
    if (localIndexChanged) {
        await saveLocalIndex(ctx);
    }
}

/** Wipe forbidden system directories from remote (e.g., on startup cleanup) */
async function cleanupForbiddenDirectories(ctx: SyncContext): Promise<void> {
    for (const dirName of INTERNAL_LOCAL_ONLY) {
        if (dirName.endsWith("/")) {
            const fullDirPath = PLUGIN_DIR + dirName.slice(0, -1);
            try {
                const meta = await ctx.adapter.getFileMetadata(fullDirPath);
                if (meta?.id) {
                    await ctx.adapter.deleteFile(meta.id);
                    await ctx.log(
                        `[Smart Pull] [System Cleanup] Forced wipe of internal directory: ${fullDirPath}`,
                        "debug",
                    );
                }
            } catch (e) {
            }
        }
    }
}

/** Build download/delete queues by comparing local vs remote index */
async function detectPullChanges(
    ctx: SyncContext,
    remoteIndex: LocalFileIndex,
): Promise<{
    toDownload: Array<{
        path: string;
        fileId: string;
        hash?: string;
        plainHash?: string;
        ancestorHash?: string;
    }>;
    toDeleteLocal: string[];
    toDeleteRemote: Array<{ path: string; fileId: string }>;
}> {
    const toDownload: Array<{
        path: string;
        fileId: string;
        hash?: string;
        plainHash?: string;
        ancestorHash?: string;
    }> = [];
    const toDeleteLocal: string[] = [];
    const toDeleteRemote: Array<{ path: string; fileId: string }> = [];

    // Pre-calculate ID map for rename detection
    const localIdToPath = new Map<string, string>();
    for (const [p, entry] of Object.entries(ctx.index)) {
        if (entry.fileId) localIdToPath.set(entry.fileId, p);
    }

    for (const [path, remoteEntry] of Object.entries(remoteIndex)) {
        if (path === ctx.pluginDataPath) continue;
        if (isManagedSeparately(path)) continue;

        // Only clean up system-level forbidden files during pull.
        // Settings-dependent cleanup is deferred to push phase to avoid
        // deleting files that another device legitimately synced with different settings.
        if (isAlwaysForbiddenOnRemote(path)) {
            toDeleteRemote.push({ path, fileId: remoteEntry.fileId });
            continue;
        }

        const localBaseEntry = ctx.localIndex[path];

        if (!localBaseEntry) {
            // Remote rename detection: check if this fileId exists locally under a different name
            const prevPathForId = localIdToPath.get(remoteEntry.fileId);
            if (prevPathForId && prevPathForId !== path) {
                // Detected remote rename (A -> B) during initial full scan
                const oldPath = prevPathForId;
                const newPath = path;

                // Case A: Local is clean, just rename it
                if (!ctx.dirtyPaths.has(oldPath)) {
                    try {
                        const sourceExists = await ctx.vault.exists(oldPath);
                        const targetExists = await ctx.vault.exists(newPath);

                        if (sourceExists && !targetExists) {
                            await ctx.log(
                                `[Smart Pull] Remote Rename detected (Full Scan): ${oldPath} -> ${newPath}`,
                                "info",
                            );
                            await ctx.vault.rename(oldPath, newPath);

                            if (ctx.index[oldPath]) {
                                ctx.index[newPath] = { ...ctx.index[oldPath] };
                                delete ctx.index[oldPath];
                            }
                            if (ctx.localIndex[oldPath]) {
                                ctx.localIndex[newPath] = { ...ctx.localIndex[oldPath] };
                                delete ctx.localIndex[oldPath];
                            }

                            // Update ID map so subsequent iterations see the correct path
                            localIdToPath.set(remoteEntry.fileId, newPath);

                            await ctx.notify(
                                "noticeFileMoved",
                                `${basename(oldPath)} → ${basename(newPath)}`,
                            );

                            // Check if content also changed. If hash matches, we're done with this file.
                            if (ctx.index[newPath]?.hash === remoteEntry.hash) {
                                await ctx.log(
                                    `[Smart Pull] Content matches after rename, skipping download: ${newPath}`,
                                    "debug",
                                );
                                continue;
                            }
                        }
                    } catch (e) {
                        await ctx.log(
                            `[Smart Pull] Failed to rename ${oldPath} -> ${newPath}: ${e}`,
                            "warn",
                        );
                    }
                } else {
                    // Local is dirty (Move/Edit conflict).
                    // We let it fall through. Since !localBaseEntry[newPath], it will be queued for toDownload[newPath].
                    // pullFileSafely will then handle the conflict correctly (Smart Merge).
                    await ctx.log(
                        `[Smart Pull] Pending local changes on ${oldPath}. Skipping auto-rename for remote move ${newPath}.`,
                        "warn",
                    );
                }
            }

            // Check if this fileId exists locally under a different name (Rename in progress locally)
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
                    "debug",
                );
                continue;
            }

            toDownload.push({
                path,
                fileId: remoteEntry.fileId,
                hash: remoteEntry.hash,
                plainHash: remoteEntry.plainHash,
                ancestorHash: remoteEntry.ancestorHash,
            });
        } else if (
            remoteEntry.hash &&
            localBaseEntry.hash &&
            remoteEntry.hash.toLowerCase() !== localBaseEntry.hash.toLowerCase()
        ) {
            toDownload.push({
                path,
                fileId: remoteEntry.fileId,
                hash: remoteEntry.hash,
                plainHash: remoteEntry.plainHash,
                ancestorHash: remoteEntry.ancestorHash,
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
                    "warn",
                );
                toDownload.push({ path, fileId: "" }); // Dummy fileId for deletion conflict
            } else {
                toDeleteLocal.push(path);
            }
        }
    }

    return { toDownload, toDeleteLocal, toDeleteRemote };
}

/** Route large files to background queue, return inline items */
function partitionPullsBySize(
    ctx: SyncContext,
    items: Array<{
        path: string;
        fileId: string;
        hash?: string;
        plainHash?: string;
        ancestorHash?: string;
    }>,
    remoteIndex: LocalFileIndex,
): { inlineDownloads: typeof items; deferredPullCount: number } {
    const pullThresholdBytes = getThresholdBytes(ctx);
    const inlineDownloads: typeof items = [];
    let deferredPullCount = 0;

    if (pullThresholdBytes > 0) {
        for (const item of items) {
            const remoteSize = remoteIndex[item.path]?.size ?? 0;
            const hasLocalConflict = ctx.dirtyPaths.has(item.path);
            const isDeletionConflict = !item.fileId; // Dummy entry for deletion conflict

            if (!hasLocalConflict && !isDeletionConflict && remoteSize > pullThresholdBytes) {
                // Defer to background queue
                ctx.backgroundTransferQueue.enqueue({
                    id: generateTransferId("pull"),
                    direction: "pull",
                    path: item.path,
                    fileId: item.fileId,
                    size: remoteSize,
                    priority: TransferPriority.NORMAL,
                    status: "pending",
                    retryCount: 0,
                    createdAt: Date.now(),
                    remoteHash: item.hash,
                });
                markPendingTransfer(ctx, item.path, "pull", item.hash || "");
                deferredPullCount++;
            } else {
                inlineDownloads.push(item);
            }
        }
    } else {
        inlineDownloads.push(...items);
    }

    return { inlineDownloads, deferredPullCount };
}

/** Execute inline downloads in parallel */
function buildInlineDownloadTasks(
    ctx: SyncContext,
    items: Array<{
        path: string;
        fileId: string;
        hash?: string;
        plainHash?: string;
        ancestorHash?: string;
    }>,
    counter: { completed: number },
    total: number,
): (() => Promise<void>)[] {
    const tasks: (() => Promise<void>)[] = [];
    for (const item of items) {
        tasks.push(async () => {
            const pullStartTime = Date.now();
            const estimatedSize = ctx.localIndex[item.path]?.size ?? 0;
            ctx.backgroundTransferQueue.markInlineStart(item.path, "pull", estimatedSize);
            try {
                const success = await pullFileSafely(ctx, item, "Smart Pull");
                if (success) {
                    counter.completed++;
                    await ctx.log(`[Smart Pull] [${counter.completed}/${total}] Synced: ${item.path}`, "info");
                    // Record inline transfer for history tracking
                    const pulledSize = ctx.localIndex[item.path]?.size ?? 0;
                    ctx.backgroundTransferQueue.recordInlineTransfer({
                        id: `inline-pull-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                        direction: "pull",
                        path: item.path,
                        size: pulledSize,
                        status: "completed",
                        startedAt: pullStartTime,
                        completedAt: Date.now(),
                        transferMode: "inline",
                    });
                }
            } finally {
                ctx.backgroundTransferQueue.markInlineEnd(item.path);
            }
        });
    }
    return tasks;
}

/** Build tasks to delete local files that were removed on remote */
function buildLocalDeletionTasks(
    ctx: SyncContext,
    toDeleteLocal: string[],
    counter: { completed: number },
    total: number,
): (() => Promise<void>)[] {
    const tasks: (() => Promise<void>)[] = [];
    for (const path of toDeleteLocal) {
        // Track this path to prevent re-upload if local deletion fails
        ctx.recentlyDeletedFromRemote.add(path);
        tasks.push(async () => {
            try {
                const file = ctx.vault.getAbstractFileByPath(path);
                if (file) {
                    await ctx.vault.trashFile(file, true);
                }
                delete ctx.index[path];
                delete ctx.localIndex[path];

                counter.completed++;
                await ctx.log(`[Smart Pull] [${counter.completed}/${total}] Deleted locally: ${path}`, "info");
                await ctx.notify("noticeFileTrashed", basename(path));
            } catch (e) {
                await ctx.log(`[Smart Pull] Delete failed: ${path} - ${e}`, "error");
            }
        });
    }
    return tasks;
}

/** Build tasks to delete forbidden files/folders from remote */
function buildForbiddenRemoteCleanupTasks(
    ctx: SyncContext,
    toDeleteRemote: Array<{ path: string; fileId: string }>,
): (() => Promise<void>)[] {
    const tasks: (() => Promise<void>)[] = [];

    // Optimization: group by folders
    const foldersToWipe = new Set<string>();
    const separateFiles: Array<{ path: string; fileId: string }> = [];

    for (const item of toDeleteRemote) {
        const parts = item.path.split("/");
        let highestIgnoredParent: string | null = null;
        for (let i = 1; i < parts.length; i++) {
            const parentPath = parts.slice(0, i).join("/");
            if (isAlwaysForbiddenOnRemote(parentPath + "/")) {
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
                    await ctx.log(`[Smart Pull] [Cleanup] Wiped forbidden folder: ${folder}`, "info");
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
                    "warn",
                );
            }
        });
    }

    for (const file of separateFiles) {
        tasks.push(async () => {
            try {
                await ctx.adapter.deleteFile(file.fileId);
                await ctx.log(`[Smart Pull] [Cleanup] Deleted forbidden file: ${file.path}`, "info");
                delete ctx.index[file.path];
                delete ctx.localIndex[file.path];
            } catch (e) {
                await ctx.log(
                    `[Smart Pull] [Cleanup] File delete failed: ${file.path} - ${e}`,
                    "warn",
                );
            }
        });
    }

    return tasks;
}


/**
 * Smart Pull - O(1) check for remote changes using sync-index.json hash
 */
export async function smartPull(ctx: SyncContext): Promise<boolean> {
    await ctx.log("[Smart Pull] Checking for remote changes...", "debug");

    // Check for active merge locks from other devices FIRST
    await checkMergeLocks(ctx);

    // Forced cleanup: wipe forbidden system directories
    if (ctx.forceCleanupNextSync) {
        await cleanupForbiddenDirectories(ctx);
    }

    if (ctx.adapter.supportsChangesAPI) {
        // Don't use Changes API when index is empty — a stale startPageToken
        // would skip files that haven't changed since the token was issued,
        // preventing a full pull on a fresh device.
        const hasIndex = Object.keys(ctx.index).length > 0;
        if (ctx.startPageToken && hasIndex) {
            return await pullViaChangesAPI(ctx);
        } else {
            try {
                ctx.startPageToken = await ctx.adapter.getStartPageToken();
                await saveIndex(ctx);
            } catch (e) {
                await ctx.log(`[Smart Pull] Failed to init Changes API: ${e}`, "warn");
            }
            // Fall through to standard hash check for this run
        }
    }

    // Get remote index metadata (O(1) operation)
    const remoteIndexMeta = await ctx.adapter.getFileMetadata(ctx.pluginDataPath);

    if (!remoteIndexMeta) {
        await ctx.log("[Smart Pull] No remote index found. Skipping pull.", "debug");
        return false;
    }

    // Compare hashes - use stored hash (from last push) instead of calculating
    // because local file includes self-reference which differs from uploaded content
    const localIndexHash = ctx.index[ctx.pluginDataPath]?.hash?.toLowerCase() || "";
    const remoteIndexHash = remoteIndexMeta.hash?.toLowerCase() || "";

    if (localIndexHash && remoteIndexHash && localIndexHash === remoteIndexHash) {
        await ctx.log("[Smart Pull] Index hash matches. No remote changes detected.", "debug");
        clearPendingPushStates(ctx);
        await saveIndex(ctx);
        return false;
    }

    // Hashes differ - download remote index and compare
    await ctx.log(
        `[Smart Pull] Index hash differs (local: ${localIndexHash}, remote: ${remoteIndexHash}). Fetching remote index...`,
        "info",
    );

    const remoteIndex = await downloadRemoteIndex(ctx, remoteIndexMeta.id);

    // === CORRUPTION CHECK ===
    const remoteKeys = Object.keys(remoteIndex);
    const localKeys = Object.keys(ctx.index);

    if (remoteKeys.length === 0) {
        if (remoteIndexMeta.size > INTEGRITY_MIN_INDEX_SIZE_BYTES) {
            throw new Error(
                `Remote index corruption detected: File size is ${remoteIndexMeta.size} bytes but parsed 0 files.`,
            );
        }
        if (localKeys.length > INTEGRITY_MIN_LOCAL_FILE_COUNT) {
            throw new Error(
                `Safety Halt: Remote index is empty but local has ${localKeys.length} files. This looks like data corruption. Aborting to prevent data loss.`,
            );
        }
    }

    const { toDownload, toDeleteLocal, toDeleteRemote } = await detectPullChanges(ctx, remoteIndex);

    await ctx.log(
        `[Smart Pull] Changes: ${toDownload.length} to download, ${toDeleteLocal.length} to delete`,
        "info",
    );

    if (toDownload.length === 0 && toDeleteLocal.length === 0) {
        await ctx.log("[Smart Pull] No file changes detected.", "debug");
        clearPendingPushStates(ctx);
        ctx.index[ctx.pluginDataPath] = {
            fileId: remoteIndexMeta.id,
            mtime: remoteIndexMeta.mtime,
            size: remoteIndexMeta.size,
            hash: remoteIndexMeta.hash,
        };
        await saveIndex(ctx);
        return false;
    }

    // === SIZE-BASED ROUTING: Partition pull items into inline and background ===
    const { inlineDownloads, deferredPullCount } = partitionPullsBySize(ctx, toDownload, remoteIndex);

    const counter = { completed: 0 };
    const total = inlineDownloads.length + toDeleteLocal.length;
    const tasks: (() => Promise<void>)[] = [
        ...buildInlineDownloadTasks(ctx, inlineDownloads, counter, total),
        ...buildLocalDeletionTasks(ctx, toDeleteLocal, counter, total),
        ...buildForbiddenRemoteCleanupTasks(ctx, toDeleteRemote),
    ];

    if (tasks.length > 0) {
        ctx.startActivity();
        try {
            await runParallel(tasks, ctx.settings.concurrency);
        } finally {
            // Keep spinning until executeSmartSync finishes
        }
    }

    ctx.index[ctx.pluginDataPath] = {
        fileId: remoteIndexMeta.id,
        mtime: remoteIndexMeta.mtime,
        size: remoteIndexMeta.size,
        hash: remoteIndexMeta.hash,
    };
    await saveIndex(ctx);

    if (deferredPullCount > 0) {
        await ctx.log(
            `[Smart Pull] ${deferredPullCount} large file(s) queued for background transfer.`,
            "info",
        );
    }

    if (total > 0 || deferredPullCount > 0) {
        await ctx.notify("noticePullCompleted", (total + deferredPullCount).toString());
        return true;
    }
    return false;
}

/**
 * Pull via Changes API (for adapters that support it)
 * @param drainAll If true, process all available pages of changes (useful after initial push)
 */
export async function pullViaChangesAPI(
    ctx: SyncContext,
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
            await ctx.log("[Smart Pull] No changes from Changes API", "debug");
            if (changes.newStartPageToken) {
                ctx.startPageToken = changes.newStartPageToken;
                await saveIndex(ctx);
            }
            break; // No more changes
        }

        await ctx.log(
            `[Smart Pull] Changes API page processed (${changes.changes.length} items)`,
            "debug",
        );
        hasTotalChanges = true;

        // In confirmation mode, if we haven't confirmed anything yet, notify user about the wait
        if (drainAll && confirmedCountTotal === 0) {
            await ctx.notify("noticeWaitingForRemoteRegistration", `(Page ${pageCount++})...`);
        }

        // Load communication data for mergeLock checks
        const commData = await loadCommunication(ctx);

        // Load Remote Index for ancestorHash lookups (Safety Guard)
        let remoteIndex: LocalFileIndex = {};
        try {
            const remoteIndexMeta = await ctx.adapter.getFileMetadata(ctx.pluginDataPath);
            if (remoteIndexMeta?.id) {
                remoteIndex = await downloadRemoteIndex(ctx, remoteIndexMeta.id);
            }
        } catch (e) {
            await ctx.log(
                `[Smart Pull] [Changes API] Failed to download remote index: ${e}`,
                "warn",
            );
        }

        const { tasks, completed: pageCompleted, confirmedCount } = await processChangePage(
            ctx,
            changes.changes,
            remoteIndex,
            commData,
        );

        if (tasks.length > 0) {
            ctx.startActivity();
            try {
                await runParallel(tasks, ctx.settings.concurrency);
                totalCompleted += pageCompleted.count;
            } finally {
                // endActivity is handled by executeSmartSync
            }
        }

        confirmedCountTotal += confirmedCount;

        if (changes.nextPageToken) {
            currentPageToken = changes.nextPageToken;
            ctx.startPageToken = currentPageToken;
            await saveIndex(ctx);
        } else if (changes.newStartPageToken) {
            ctx.startPageToken = changes.newStartPageToken;
            await saveIndex(ctx);
            break;
        } else {
            break;
        }

        if (!drainAll) break; // Only process one page unless drainAll is true
    } while (currentPageToken);

    if (hasTotalChanges) {
        if (totalCompleted > 0) {
            await ctx.notify("noticePullCompleted", totalCompleted.toString());
        }
        return true;
    }
    return false;
}

/** Process one page of Changes API results */
async function processChangePage(
    ctx: SyncContext,
    changes: Array<{
        fileId: string;
        removed?: boolean;
        file?: { kind: string; id: string; path: string; hash?: string; size: number; [key: string]: any };
    }>,
    remoteIndex: LocalFileIndex,
    commData: { mergeLocks: Record<string, { holder: string; expiresAt: number }> },
): Promise<{
    tasks: (() => Promise<void>)[];
    completed: { count: number };
    confirmedCount: number;
}> {
    const tasks: (() => Promise<void>)[] = [];
    const completed = { count: 0 };
    let confirmedCount = 0;

    // Pre-calculate ID map for rename detection (Ghost File Check)
    const localIdToPath = new Map<string, string>();
    for (const [p, entry] of Object.entries(ctx.index)) {
        if (entry.fileId) localIdToPath.set(entry.fileId, p);
    }

    for (const change of changes) {
        if (change.removed) {
            const pathToDelete = Object.entries(ctx.index).find(
                ([, entry]) => entry.fileId === change.fileId,
            )?.[0];

            if (pathToDelete && pathToDelete !== ctx.pluginDataPath) {
                // Track this path to prevent re-upload if local deletion fails
                ctx.recentlyDeletedFromRemote.add(pathToDelete);
                tasks.push(async () => {
                    try {
                        const file = ctx.vault.getAbstractFileByPath(pathToDelete);
                        if (file) {
                            await ctx.vault.trashFile(file, true);
                        }
                        delete ctx.index[pathToDelete];
                        delete ctx.localIndex[pathToDelete];
                        ctx.logger.markActionTaken();
                        completed.count++;
                        await ctx.log(`[Smart Pull] Deleted: ${pathToDelete}`, "info");
                        await ctx.notify("noticeFileTrashed", basename(pathToDelete));
                    } catch (e) {
                        await ctx.log(
                            `[Smart Pull] Delete failed: ${pathToDelete} - ${e}`,
                            "error",
                        );
                    }
                });
            }
        } else if (change.file && change.file.kind === "file") {
            const cloudFile: any = change.file;
            if (cloudFile.path === ctx.pluginDataPath) continue;
            if (isManagedSeparately(cloudFile.path)) continue;

            // Populate ancestorHash and plainHash from remote index.
            const remoteEntry = remoteIndex[cloudFile.path];
            if (remoteEntry) {
                cloudFile.ancestorHash = remoteEntry.ancestorHash;
                if (remoteEntry.plainHash) {
                    cloudFile.plainHash = remoteEntry.plainHash;
                }
            }

            // Only clean up system-level forbidden files during pull (Changes API).
            if (isAlwaysForbiddenOnRemote(cloudFile.path)) {
                tasks.push(async () => {
                    try {
                        await ctx.adapter.deleteFile(cloudFile.id);
                        ctx.logger.markActionTaken();
                        await ctx.log(
                            `[Smart Pull] [Cleanup] Deleted forbidden file (via Changes API): ${cloudFile.path}`,
                            "debug",
                        );
                        delete ctx.index[cloudFile.path];
                        delete ctx.localIndex[cloudFile.path];
                    } catch (e) {
                        await ctx.log(
                            `[Smart Pull] [Cleanup] Failed to delete forbidden file: ${cloudFile.path} - ${e}`,
                            "error",
                        );
                    }
                });
                continue;
            }

            // Check if another device is merging this file
            const mergeLock = commData.mergeLocks[cloudFile.path];
            const now = Date.now();
            if (mergeLock && mergeLock.holder !== ctx.deviceId && mergeLock.expiresAt > now) {
                await ctx.log(
                    `[Smart Pull] Waiting: ${cloudFile.path} is being merged by ${mergeLock.holder} (expires in ${Math.round((mergeLock.expiresAt - now) / 1000)}s)`,
                    "warn",
                );
                await ctx.notify("noticeWaitOtherDeviceMerge", basename(cloudFile.path));
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

                    // Guard: If local has pending changes on this file (user moved it),
                    // skip the remote rename — it's likely a stale echo of our own push.
                    const localIndexEntry = ctx.index[oldPath];
                    if (localIndexEntry?.pendingMove || ctx.dirtyPaths.has(oldPath)) {
                        await ctx.log(
                            `[Changes API] Remote Rename skipped: ${oldPath} -> ${newPath} (local has pending move/changes)`,
                            "debug",
                        );
                        continue;
                    }

                    const targetExists = await ctx.vault.exists(newPath);

                    if (!targetExists) {
                        try {
                            const sourceExists = await ctx.vault.exists(oldPath);
                            if (sourceExists) {
                                await ctx.log(
                                    `[Changes API] Remote Rename detected: ${oldPath} -> ${newPath}. Renaming locally.`,
                                    "info",
                                );

                                await ctx.vault.rename(oldPath, newPath);
                                ctx.logger.markActionTaken();

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

                                if (ctx.dirtyPaths.has(oldPath)) {
                                    ctx.dirtyPaths.delete(oldPath);
                                    ctx.dirtyPaths.set(newPath, Date.now());
                                }

                                localIdToPath.set(cloudFile.id, newPath);

                                await ctx.notify(
                                    "noticeFileRenamed",
                                    `${basename(oldPath)} -> ${basename(newPath)}`,
                                );
                            } else {
                                await ctx.log(
                                    `[Changes API] Remote Rename: Source ${oldPath} missing locally. Skipping rename.`,
                                    "warn",
                                );
                                if (ctx.index[oldPath]) delete ctx.index[oldPath];
                                if (ctx.localIndex[oldPath]) delete ctx.localIndex[oldPath];
                            }
                        } catch (e) {
                            await ctx.log(
                                `[Changes API] Failed to rename ${oldPath} -> ${newPath}: ${e}`,
                                "warn",
                            );
                        }
                    } else {
                        await ctx.log(
                            `[Changes API] Remote Rename: Target ${newPath} exists. Skipping rename to avoid overwrite.`,
                            "warn",
                        );
                    }
                }
            }

            // Guard: If remote hash matches our ancestorHash, it's likely a stale echo
            if (localEntry?.ancestorHash && cloudFile.hash === localEntry.ancestorHash) {
                await ctx.log(
                    `[Changes API] Stale echo detected for ${cloudFile.path} (matches ancestorHash), skipping.`,
                    "debug",
                );
                continue;
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
                        "debug",
                    );

                    // Notify individual confirmation
                    confirmedCount++;
                    await ctx.notify("noticeSyncConfirmed", basename(cloudFile.path));
                }

                // Strategy B: 他デバイスのマージ結果を適用済み（ハッシュ一致）であることを通知
                if (ctx.localIndex[cloudFile.path]?.pendingConflict) {
                    delete ctx.localIndex[cloudFile.path].pendingConflict;
                    await saveLocalIndex(ctx);
                    await ctx.notify(
                        "noticeRemoteMergeSynced",
                        basename(cloudFile.path),
                    );
                }

                await ctx.log(`[Smart Pull] Skipping (hash match): ${cloudFile.path}`, "debug");
                continue;
            }

            const changesThreshold = getThresholdBytes(ctx);
            const hasLocalConflict = ctx.dirtyPaths.has(cloudFile.path);

            if (
                changesThreshold > 0 &&
                !hasLocalConflict &&
                cloudFile.size > changesThreshold
            ) {
                ctx.backgroundTransferQueue.enqueue({
                    id: generateTransferId("pull"),
                    direction: "pull",
                    path: cloudFile.path,
                    fileId: cloudFile.id,
                    size: cloudFile.size,
                    priority: TransferPriority.NORMAL,
                    status: "pending",
                    retryCount: 0,
                    createdAt: Date.now(),
                    remoteHash: cloudFile.hash,
                });
                markPendingTransfer(ctx, cloudFile.path, "pull", cloudFile.hash || "");
                await ctx.log(
                    `[Changes API] Deferred to background (${formatSize(cloudFile.size)}): ${cloudFile.path}`,
                    "info",
                );
            } else {
                tasks.push(async () => {
                    const pullStartTime = Date.now();
                    ctx.backgroundTransferQueue.markInlineStart(cloudFile.path, "pull", cloudFile.size);
                    try {
                        const success = await pullFileSafely(ctx, cloudFile, "Changes API");
                        if (success) {
                            completed.count++;
                            await ctx.log(`[Changes API] Synced: ${cloudFile.path}`, "info");
                            // Record inline transfer for history tracking
                            const pulledSize = ctx.localIndex[cloudFile.path]?.size ?? 0;
                            ctx.backgroundTransferQueue.recordInlineTransfer({
                                id: `inline-pull-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                                direction: "pull",
                                path: cloudFile.path,
                                size: pulledSize,
                                status: "completed",
                                startedAt: pullStartTime,
                                completedAt: Date.now(),
                                transferMode: "inline",
                            });
                        }
                    } finally {
                        ctx.backgroundTransferQueue.markInlineEnd(cloudFile.path);
                    }
                });
            }
        }
    }

    return { tasks, completed, confirmedCount };
}
