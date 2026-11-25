import { capabilitiesOf, type CloudChanges, type CloudFile } from "../types/adapter";
import { isQuietCycle, takePeekedChanges } from "./change-peek";
import { removeRemote } from "./remote-deletion";
import { PlanDecision, reviewPlan } from "./sync-plan";
import type { CommunicationData } from "./types";
import type { SyncContext } from "./context";
import type { LocalFileIndex } from "./types";
import {
    PLUGIN_DIR,
    INTERNAL_LOCAL_ONLY,
    runParallel,
    isManagedSeparately,
    isAlwaysForbiddenOnRemote,
    shouldIgnore,
    isDeviceExcluded,
    exceedsDeviceSizeLimit,
    matchesDeviceScope,
    noteVacatedFolder,
    removeVacatedFolders,
} from "./file-utils";
import {
    loadCommunication,
    saveIndex,
    saveLocalIndex,
    clearPendingPushStates,
    checkMergeLock,
    releaseOrphanedOwnLocks,
    findForeignLock,
    renameLocal,
    alignFolderSpelling,
    hasDeleteIntent,
    clearDeleteIntent,
    markDeleted,
} from "./state";
import { noteKeptCopy, pullFileSafely, takePullLockSkip } from "./merge";
import { TransferPriority } from "./transfer-types";
import { formatSize } from "../utils/format";
import { basename, dirname } from "../utils/path";
import { announceIncoming, findPathCollision, freeCollisionPath, moveIndexEntry, pathKey } from "./path-collision";
import { INTEGRITY_MIN_INDEX_SIZE_BYTES, INTEGRITY_MIN_LOCAL_FILE_COUNT } from "./constants";
import {
    computeLocalHash,
    downloadRemoteIndex,
    downloadRemoteIndexData,
    getThresholdBytes,
    generateTransferId,
    markPendingTransfer,
    oweUnseenPull,
    relistForOthersAdd,
    pendingPullsOf,
    moveAttemptedUploads,
    peekAttemptedUpload,
    deletionMarkOf,
} from "./sync-helpers";
import { CtxFlag, CtxState } from "./context-state";
import { noteSkippedOutOfScope, takeScopeChange, takeScopeUnsettled, takeSkippedOutOfScope } from "./sync-scope";


/** Check for active merge locks from other devices */
async function checkMergeLocks(ctx: SyncContext): Promise<void> {
    const commData = await loadCommunication(ctx);
    await releaseOrphanedOwnLocks(ctx, commData);
    const now = Date.now();
    let localIndexChanged = false;
    for (const [path, lock] of Object.entries(commData.mergeLocks)) {
        if (lock.holder !== ctx.deviceId && lock.expiresAt > now) {
            if (isDeviceExcluded(ctx, path)) continue; // not synced here: nothing to wait for
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
                    await removeRemote(
                        ctx,
                        { id: meta.id, path: fullDirPath, kind: "folder" },
                        "system-cleanup",
                    );
                    await ctx.log(
                        `[Smart Pull] [System Cleanup] Forced wipe of internal directory: ${fullDirPath}`,
                        "debug",
                    );
                }
            } catch {
                // ignore: best-effort cleanup
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

    remoteIndex = await resolveDuplicateIds(ctx, remoteIndex);

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
        // Left out on this device: never downloaded here
        if (isDeviceExcluded(ctx, path)) {
            noteSkippedOutOfScope(ctx, path, remoteEntry);
            continue;
        }
        if (exceedsDeviceSizeLimit(ctx, remoteEntry.size)) continue;

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
                            await renameLocal(ctx, oldPath, newPath);
                            await followFolderSpelling(ctx, oldPath, newPath);
                            noteVacatedFolder(ctx, oldPath);
                            moveAttemptedUploads(ctx, oldPath, newPath);

                            if (ctx.index[oldPath]) {
                                ctx.index[newPath] = { ...ctx.index[oldPath] };
                                delete ctx.index[oldPath];
                            }
                            if (ctx.localIndex[oldPath]) {
                                ctx.localIndex[newPath] = { ...ctx.localIndex[oldPath] };
                                delete ctx.localIndex[oldPath];
                            }

                            await markIfEditedSinceSync(ctx, newPath);
                            await saveLocalIndex(ctx);
                            await saveIndex(ctx);

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
                            `[Smart Pull] Failed to rename ${oldPath} -> ${newPath}: ${String(e)}`,
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
    counter: { completed: number; failed?: number },
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
                } else if (!ctx.localIndex[item.path]) {
                    // Never pulled (e.g. another device's merge lock): nothing will retry it.
                    counter.failed = (counter.failed ?? 0) + 1;
                }
            } finally {
                ctx.backgroundTransferQueue.markInlineEnd(item.path);
            }
        });
    }
    return tasks;
}

/**
 * Apply a deletion made on another device. If the local file changed since our
 * last sync (an edit made here, or a brand-new note created at the same path),
 * the edit wins: the file is kept and uploaded again as a new file instead of
 * being trashed. A deletion the plan guard held is treated the same way.
 * Returns true if the local file was deleted.
 */
async function applyRemoteDeletion(ctx: SyncContext, path: string, decision: PlanDecision): Promise<boolean> {
    if (hasDeleteIntent(ctx, path)) {
        // Deleted here as well. On Windows/macOS a file still found at this name is
        // another note under another spelling (renamed onto the name since): keeping
        // it under this name uploaded that note as this one, trashing it lost it.
        // Gone on both sides: nothing is left to push for this name.
        delete ctx.index[path];
        delete ctx.localIndex[path];
        ctx.dirtyPaths.delete(path);
        clearDeleteIntent(ctx, path);
        return true;
    }
    const file = ctx.vault.getAbstractFileByPath(path);
    const base = ctx.localIndex[path] ?? ctx.index[path];
    if (file && !decision.allows("delete-local", path)) {
        delete ctx.index[path];
        delete ctx.localIndex[path];
        ctx.recentlyDeletedFromRemote.delete(path);
        ctx.dirtyPaths.set(path, Date.now());
        await ctx.log(
            `[Smart Pull] ${path} was deleted on another device; the deletion was held back. Keeping it and uploading it again.`,
            "warn",
        );
        return false;
    }
    if (file && base && (await ctx.vault.exists(path))) {
        const content = await ctx.vault.readBinary(path);
        const { localHash, compareHash } = await computeLocalHash(ctx, content, base);
        if (!compareHash || localHash !== compareHash.toLowerCase()) {
            noteKeptCopy(ctx, path, base.fileId, base.hash);
            delete ctx.index[path];
            delete ctx.localIndex[path];
            ctx.recentlyDeletedFromRemote.delete(path);
            ctx.dirtyPaths.set(path, Date.now());
            await ctx.log(
                `[Smart Pull] ${path} was deleted on another device but has local changes. Keeping it and uploading it again.`,
                "warn",
            );
            return false;
        }
    }
    if (file) {
        await ctx.vault.trashFile(file, true);
        noteVacatedFolder(ctx, path);
    }
    delete ctx.index[path];
    delete ctx.localIndex[path];
    return true;
}

/**
 * How long a deletion of our own upload waits for the deleting device's mark when
 * the shared index does not change meanwhile (a build without marks, or a device
 * that was closed before uploading its index).
 */
const DELETION_MARK_WAIT_MS = 10 * 60 * 1000;
/** fileId -> hash of the shared index when we started waiting for its deletion mark */
const deletionWaitIndex = new CtxState<Map<string, string>>(
    "deletionWaitIndex",
    "Deletions of our uploads waiting for the deleter's mark: index hash at the start",
);

/**
 * Another device deleted a cloud file whose current version is our upload. It
 * checked the version right before deleting, but the cloud has no "delete only if
 * unchanged": our upload may have landed between that check and the delete, and
 * then deleting the local copy too lost the edit everywhere. The deleting device
 * leaves the version it checked as a mark in the shared index:
 * - the version our upload replaced: it never saw our edit, keep ours and upload it
 *   as a new file (an edit wins over a deletion, as everywhere else);
 * - any other version (ours, or a later one built on it): delete here as well;
 * - no mark yet: its index upload may still be on its way, wait for it.
 */
async function weighRemoteDeletion(
    ctx: SyncContext,
    path: string,
    fileId: string,
    indexHash?: string,
): Promise<"delete" | "kept" | "wait"> {
    const entry = ctx.index[path];
    if (!entry?.hash || !isOurUploadCurrent(ctx, path)) return "delete";
    // Kept only when the deleting device checked the very version our upload
    // replaced. Any other version (ours, or a later edit made on top of ours)
    // means it saw our edit. A new note of ours replaced nothing.
    const replaced = [entry.lastAction === "push" ? entry.ancestorHash : undefined, ctx.localIndex[path]?.ownPushBase]
        .filter((h): h is string => !!h && h.toLowerCase() !== entry.hash!.toLowerCase())
        .map((h) => h.toLowerCase());
    if (replaced.length === 0) return "delete";
    const mark = deletionMarkOf(ctx, fileId);
    const waits = deletionWaitIndex.get(ctx) ?? new Map<string, string>();
    if (mark) {
        waits.delete(fileId);
        delete entry.remoteDeletionSeenAt;
        if (!mark.hash || !replaced.includes(mark.hash)) return "delete";
        delete ctx.index[path];
        delete ctx.localIndex[path];
        ctx.dirtyPaths.set(path, Date.now());
        await ctx.log(
            `[Smart Pull] ${path} was deleted on another device before our latest upload of it reached there. Keeping our version and uploading it again.`,
            "warn",
        );
        return "kept";
    }
    const now = Date.now();
    if (entry.remoteDeletionSeenAt === undefined) {
        entry.remoteDeletionSeenAt = now;
        waits.set(fileId, indexHash ?? (await currentIndexHash(ctx)));
        deletionWaitIndex.set(ctx, waits);
        await ctx.log(
            `[Smart Pull] ${path} was deleted on another device. Checking whether that device saw our latest upload first.`,
            "info",
        );
        return "wait";
    }
    const startedWith = waits.get(fileId);
    if (startedWith === undefined && indexHash !== undefined) {
        // Restarted since we began waiting: watch the index from here on
        waits.set(fileId, indexHash);
        deletionWaitIndex.set(ctx, waits);
    }
    const indexMoved = startedWith !== undefined && indexHash !== undefined && indexHash !== startedWith;
    if (!indexMoved && now - entry.remoteDeletionSeenAt < DELETION_MARK_WAIT_MS) return "wait";
    // The shared index changed without a mark (or we waited long enough): the
    // deleting device leaves none. Delete as before.
    waits.delete(fileId);
    delete entry.remoteDeletionSeenAt;
    return "delete";
}

/** The version we last know of in the cloud is our own upload (confirmed or not). */
function isOurUploadCurrent(ctx: SyncContext, path: string): boolean {
    return ctx.index[path]?.lastAction === "push" || !!ctx.localIndex[path]?.ownPushBase;
}

async function currentIndexHash(ctx: SyncContext): Promise<string> {
    const meta = await ctx.adapter.getFileMetadata(ctx.pluginDataPath).catch(() => null);
    return meta ? (meta.hash ?? `${meta.id}:${meta.mtime}`) : "";
}

/** Deletions of our uploads still waiting for their mark: decide them now if possible. */
async function settleWaitingDeletions(ctx: SyncContext): Promise<boolean> {
    const waiting = Object.entries(ctx.index).filter(([, e]) => e.remoteDeletionSeenAt !== undefined);
    if (waiting.length === 0) return false;
    let indexHash = "";
    try {
        const meta = await ctx.adapter.getFileMetadata(ctx.pluginDataPath);
        if (meta?.id) {
            indexHash = meta.hash ?? `${meta.id}:${meta.mtime}`;
            if (waiting.some(([, e]) => !deletionMarkOf(ctx, e.fileId))) await downloadRemoteIndex(ctx, meta.id);
        }
    } catch {
        return false; // try again next sync
    }
    let changed = false;
    for (const [path, entry] of waiting) {
        if (ctx.index[path] !== entry) continue;
        // Back in the cloud (restored from its trash): nothing was deleted
        if (await ctx.adapter.fileExistsById(entry.fileId).catch(() => false)) {
            delete entry.remoteDeletionSeenAt;
            deletionWaitIndex.get(ctx)?.delete(entry.fileId);
            continue;
        }
        const verdict = await weighRemoteDeletion(ctx, path, entry.fileId, indexHash);
        if (verdict === "wait") continue;
        changed = true;
        if (verdict === "kept") continue;
        try {
            if (await applyRemoteDeletion(ctx, path, PlanDecision.approveAll())) {
                ctx.logger.markActionTaken();
                await ctx.log(`[Smart Pull] Deleted: ${path}`, "info");
                await ctx.notify("noticeFileTrashed", basename(path));
            }
        } catch (e) {
            await ctx.log(`[Smart Pull] Delete failed: ${path} - ${String(e)}`, "error");
        }
    }
    return changed;
}

/**
 * A change listing the version our unconfirmed upload was built on is usually a late
 * echo of that older version (listed before our upload landed). But another device
 * may really have uploaded that older content again (a "keep this device's version"
 * conflict setting reverting our edit): skipping it then left our edit here while
 * every other device had the older content, until the note was edited again. Ask
 * the cloud which version is current.
 */
async function revertedToAncestor(
    ctx: SyncContext,
    entry: LocalFileIndex[string],
    cloudFile: ChangedFile,
): Promise<boolean> {
    if (entry.lastAction !== "push" || !entry.hash || !cloudFile.hash) return false;
    if (entry.hash.toLowerCase() === cloudFile.hash.toLowerCase()) return false;
    const current = await ctx.adapter.getFileMetadataById(cloudFile.id, cloudFile.path).catch(() => null);
    if (!current?.hash || current.hash.toLowerCase() !== cloudFile.hash.toLowerCase()) return false;
    await ctx.log(
        `[Changes API] ${cloudFile.path} was set back to its previous version on another device after our upload.`,
        "info",
    );
    return true;
}

/** Build tasks to delete local files that were removed on remote */
function buildLocalDeletionTasks(
    ctx: SyncContext,
    toDeleteLocal: string[],
    counter: { completed: number },
    total: number,
    decision: PlanDecision,
): (() => Promise<void>)[] {
    const tasks: (() => Promise<void>)[] = [];
    for (const path of toDeleteLocal) {
        // Track this path to prevent re-upload if local deletion fails
        ctx.recentlyDeletedFromRemote.add(path);
        tasks.push(async () => {
            try {
                if (!(await applyRemoteDeletion(ctx, path, decision))) return;

                counter.completed++;
                await ctx.log(`[Smart Pull] [${counter.completed}/${total}] Deleted locally: ${path}`, "info");
                await ctx.notify("noticeFileTrashed", basename(path));
            } catch (e) {
                await ctx.log(`[Smart Pull] Delete failed: ${path} - ${String(e)}`, "error");
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
                    await removeRemote(
                        ctx,
                        { id: meta.id, path: folder, kind: "folder" },
                        "excluded-cleanup",
                    );
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
                    `[Smart Pull] [Cleanup] Folder wipe failed: ${folder} - ${String(e)}`,
                    "warn",
                );
            }
        });
    }

    for (const file of separateFiles) {
        tasks.push(async () => {
            try {
                await removeRemote(
                    ctx,
                    { id: file.fileId, path: file.path, kind: "file" },
                    "excluded-cleanup",
                );
                await ctx.log(`[Smart Pull] [Cleanup] Deleted forbidden file: ${file.path}`, "info");
                delete ctx.index[file.path];
                delete ctx.localIndex[file.path];
            } catch (e) {
                await ctx.log(
                    `[Smart Pull] [Cleanup] File delete failed: ${file.path} - ${String(e)}`,
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
    try {
        return await pullChanges(ctx);
    } finally {
        await removeVacatedFolders(ctx);
    }
}

async function pullChanges(ctx: SyncContext): Promise<boolean> {
    await ctx.log("[Smart Pull] Checking for remote changes...", "debug");

    // Nothing new in the change feed and nothing waiting here: the merge locks
    // and the rest of the pull only matter when something changed.
    if (await isQuietCycle(ctx)) {
        const page = takePeekedChanges(ctx, ctx.startPageToken!)!;
        await ctx.log("[Smart Pull] No changes from Changes API (quiet cycle)", "debug");
        if (page.newStartPageToken && page.newStartPageToken !== ctx.startPageToken) {
            ctx.startPageToken = page.newStartPageToken;
            await saveIndex(ctx);
        }
        return false;
    }

    // Check for active merge locks from other devices FIRST
    await checkMergeLocks(ctx);

    // Forced cleanup: wipe forbidden system directories
    if (ctx.forceCleanupNextSync) {
        await cleanupForbiddenDirectories(ctx);
    }

    let tokenJustInitialized = false;
    if (capabilitiesOf(ctx.adapter).changeFeed) {
        // Don't use Changes API when index is empty — a stale startPageToken
        // would skip files that haven't changed since the token was issued,
        // preventing a full pull on a fresh device.
        const hasIndex = Object.keys(ctx.index).length > 0;
        if (ctx.startPageToken && hasIndex) {
            const changesResult = await pullViaChangesAPI(
                ctx,
                false,
                takePeekedChanges(ctx, ctx.startPageToken),
            );

            // Re-check files with pendingConflict whose merge lock has expired.
            // Changes API may have consumed the change while the lock was active,
            // so the change won't appear again. Force re-pull for these files.
            const pendingPaths = Object.entries(ctx.localIndex)
                .filter(([, entry]) => entry.pendingConflict)
                .map(([path]) => path);

            if (pendingPaths.length > 0) {
                // Filter to only paths whose locks have expired
                const unlockedPaths: string[] = [];
                for (const path of pendingPaths) {
                    const lock = await checkMergeLock(ctx, path);
                    if (!lock.locked) {
                        unlockedPaths.push(path);
                    }
                }

                if (unlockedPaths.length > 0) {
                    // The remote index only supplies ancestorHash/plainHash. The file's own
                    // metadata is the truth for its content: the index can lag behind (the
                    // merging device uploads the file before its index), and re-checking
                    // against a stale index hash made this device declare "already in sync"
                    // and drop the merged result for good (the change was already consumed).
                    let remoteIndex: LocalFileIndex = {};
                    try {
                        const remoteIndexMeta = await ctx.adapter.getFileMetadata(ctx.pluginDataPath);
                        if (remoteIndexMeta?.id) {
                            remoteIndex = await downloadRemoteIndex(ctx, remoteIndexMeta.id);
                        }
                    } catch (e) {
                        await ctx.log(`[Smart Pull] Failed to load remote index for pending conflicts: ${String(e)}`, "warn");
                    }
                    let pendingPulled = false;
                    for (const path of unlockedPaths) {
                        // Renamed (or resolved) locally since the list was made: the entry
                        // moved on. Pulling the old path recreated the note there as a copy.
                        if (!ctx.localIndex[path]?.pendingConflict) continue;
                        if (isDeviceExcluded(ctx, path)) {
                            // Left out here since: never pulled here, so nothing to re-check
                            delete ctx.localIndex[path].pendingConflict;
                            await saveLocalIndex(ctx);
                            continue;
                        }
                        const fileId =
                            ctx.localIndex[path]?.fileId || ctx.index[path]?.fileId || remoteIndex[path]?.fileId;
                        let meta: Awaited<ReturnType<typeof ctx.adapter.getFileMetadata>> = null;
                        try {
                            meta = fileId
                                ? await ctx.adapter.getFileMetadataById(fileId, path)
                                : await ctx.adapter.getFileMetadata(path);
                        } catch (e) {
                            // Transient error: keep pendingConflict and re-check next sync
                            await ctx.log(`[Smart Pull] Pending conflict re-check failed for ${path}: ${String(e)}`, "warn");
                            continue;
                        }
                        if (!meta || meta.kind === "folder" || meta.path !== path) {
                            // Deleted or renamed remotely: those arrive as changes of their own.
                            if (ctx.localIndex[path]?.pendingConflict) {
                                delete ctx.localIndex[path].pendingConflict;
                                await saveLocalIndex(ctx);
                            }
                            continue;
                        }
                        const remoteEntry = remoteIndex[path];
                        const indexIsCurrent =
                            !!remoteEntry?.hash &&
                            !!meta.hash &&
                            remoteEntry.hash.toLowerCase() === meta.hash.toLowerCase();
                        await ctx.log(
                            `[Smart Pull] Re-checking pendingConflict file (lock expired): ${path}`,
                            "info",
                        );
                        await pullFileSafely(
                            ctx,
                            {
                                path,
                                fileId: meta.id,
                                hash: meta.hash,
                                mtime: meta.mtime,
                                size: meta.size,
                                plainHash: indexIsCurrent ? remoteEntry.plainHash : undefined,
                                ancestorHash: indexIsCurrent ? remoteEntry.ancestorHash : undefined,
                            },
                            "Pending Conflict",
                        );
                        pendingPulled = true;
                    }
                    if (pendingPulled) return true;
                }
            }

            return changesResult;
        } else {
            tokenJustInitialized = true;
            try {
                ctx.startPageToken = await ctx.adapter.getStartPageToken!();
                await saveIndex(ctx);
            } catch (e) {
                await ctx.log(`[Smart Pull] Failed to init Changes API: ${String(e)}`, "warn");
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

    const { index: remoteIndex, startPageToken: remoteToken } = await downloadRemoteIndexData(
        ctx,
        remoteIndexMeta.id,
    );
    if (tokenJustInitialized && remoteToken && capabilitiesOf(ctx.adapter).changeFeed) {
        // The remote index can be older than the token we just took: another device may
        // have renamed or edited a file after uploading it. Pulling from the index and
        // then reading changes only from NOW lost those changes for good (the note stayed
        // under its old name on this device). Read changes from where the index's writer
        // stood instead; changes we already have are skipped as in sync.
        ctx.startPageToken = remoteToken;
    }

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
    ctx.progress?.plan(
        "pull",
        inlineDownloads.map((i) => ({ path: i.path, size: remoteIndex[i.path]?.size ?? 0 })),
    );

    const decision = await reviewPlan(ctx, {
        step: "pull",
        changes: toDeleteLocal.map((path) => ({ action: "delete-local", path, kind: "file" })),
    });

    const counter: { completed: number; failed?: number } = { completed: 0 };
    const total = inlineDownloads.length + toDeleteLocal.length;
    const tasks: (() => Promise<void>)[] = [
        ...buildInlineDownloadTasks(ctx, inlineDownloads, counter, total),
        ...buildLocalDeletionTasks(ctx, toDeleteLocal, counter, total, decision),
        ...buildForbiddenRemoteCleanupTasks(ctx, toDeleteRemote),
    ];

    if (tasks.length > 0) {
        ctx.startActivity();
        const release = announceIncoming(ctx, inlineDownloads.map((d) => d.path));
        try {
            await runParallel(tasks, ctx.settings.concurrency);
        } finally {
            release();
            // Keep spinning until executeSmartSync finishes
        }
    }

    if (counter.failed) {
        reconcilePending.add(ctx);
        // Some new files were not pulled (another device was merging them, or an
        // error). Recording this index as seen meant no later sync looked at it again,
        // and those files never arrived here. Leave it unseen: the next sync reconciles.
        await ctx.log(
            `[Smart Pull] ${counter.failed} new file(s) could not be pulled yet; will retry from the remote index.`,
            "info",
        );
    } else if (deferredPullCount > 0) {
        // Large files go to the background queue and have no index entry until they
        // arrive. Recording this index as seen made our next index upload skip the
        // merge with it, and the upload then dropped those files from the shared
        // index: devices joining later never received them. Leave it unseen.
        await ctx.log(
            `[Smart Pull] Remote index not marked as seen until ${deferredPullCount} background download(s) finish.`,
            "debug",
        );
    } else {
        ctx.index[ctx.pluginDataPath] = {
            fileId: remoteIndexMeta.id,
            mtime: remoteIndexMeta.mtime,
            size: remoteIndexMeta.size,
            hash: remoteIndexMeta.hash,
        };
    }
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

/** Upper bound on Changes API pages processed in one sync (pageSize is 1000 on Drive) */
export const CHANGES_MAX_PAGES_PER_SYNC = 50;
/** A change whose pull keeps failing is retried on at most this many later syncs */
export const CHANGES_MAX_PULL_RETRIES = 3;

type ChangedFile = {
    id: string;
    path: string;
    hash?: string;
    size: number;
    mtime?: number;
    ancestorHash?: string;
    plainHash?: string;
};

// Changes whose pull failed (network error etc.) or went to the background queue,
// keyed by fileId: see pendingPullsOf (persisted with the local index). The page
// token still advances (re-reading pages would replay unrelated changes), so
// without this list a failed pull was silently lost until the file changed
// again. Entries are dropped when a newer change for the same file arrives.

/**
 * Pull via Changes API (for adapters that support it).
 *
 * Processes every available page (up to CHANGES_MAX_PAGES_PER_SYNC) instead of
 * one page per sync, so a burst of remote changes converges in one sync.
 * communication.json and the remote index are fetched once per call (the
 * remote index is re-downloaded only when its hash changed), not per page.
 * Pulls that fail are retried on the next syncs (see failedChangePulls).
 * @param drainAll Post-push confirmation mode (shows the "waiting for remote" notice)
 */
export async function pullViaChangesAPI(
    ctx: SyncContext,
    drainAll: boolean = false,
    /** The first page, already read from ctx.startPageToken (see change-peek.ts) */
    firstPage?: CloudChanges,
): Promise<boolean> {
    if (!ctx.startPageToken) {
        ctx.startPageToken = await ctx.adapter.getStartPageToken!();
        await saveIndex(ctx);
    }

    let hasTotalChanges = false;
    let currentPageToken = ctx.startPageToken;
    let confirmedCountTotal = 0;
    let pageCount = 1;
    let totalCompleted = 0;

    let commData: Awaited<ReturnType<typeof loadCommunication>> | null = null;
    let remoteIndex: LocalFileIndex = {};
    let remoteIndexHash: string | null = null;
    // Failed pulls from earlier syncs. Updated as pages are processed, so a
    // newer change for the same file supersedes the retry even if this call
    // throws half-way.
    const pending = pendingPullsOf(ctx);
    // Pulls the background queue still holds are not retried inline
    const queuedInBackground = new Set(
        (ctx.backgroundTransferQueue.getPendingTransfers?.() ?? [])
            .filter((t) => t.direction === "pull")
            .map((t) => t.path),
    );
    const retryCandidates = new Map(
        [...pending].filter(([, p]) => !(p.background && queuedInBackground.has(p.file.path))),
    );
    let newFailureCount = 0;
    const seenFileIds = new Set<string>();
    let remoteIndexChanged = false;

    const loadRemoteIndex = async () => {
        // One metadata call; the body is re-downloaded only when it changed.
        try {
            const remoteIndexMeta = await ctx.adapter.getFileMetadata(ctx.pluginDataPath);
            if (remoteIndexMeta?.id) {
                const hash = remoteIndexMeta.hash ?? `${remoteIndexMeta.id}:${remoteIndexMeta.mtime}`;
                if (hash !== remoteIndexHash) {
                    remoteIndex = await downloadRemoteIndex(ctx, remoteIndexMeta.id);
                    remoteIndexHash = hash;
                }
            }
        } catch (e) {
            await ctx.log(
                `[Smart Pull] [Changes API] Failed to download remote index: ${String(e)}`,
                "warn",
            );
        }
    };

    for (let page = 0; page < CHANGES_MAX_PAGES_PER_SYNC && currentPageToken; page++) {
        const changes =
            page === 0 && firstPage && currentPageToken === ctx.startPageToken
                ? firstPage
                : await ctx.adapter.getChanges!(currentPageToken);

        if (changes.changes.length === 0 && changes.nextPageToken) {
            // Drive may return an empty page that is not the last one (e.g. every change
            // on it was superseded or filtered). Stopping here skipped all later pages,
            // so another device's edits were never pulled.
            currentPageToken = changes.nextPageToken;
            ctx.startPageToken = currentPageToken;
            continue;
        }
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

        // communication.json / remote index are only needed for file changes
        const hasFileChanges = changes.changes.some(
            (c) => !c.removed && c.file?.kind === "file" && c.file.path !== ctx.pluginDataPath,
        );
        // Deletion marks for removed files whose current version is our upload
        const removesOurUpload = changes.changes.some(
            (c) =>
                c.removed &&
                Object.entries(ctx.index).some(([p, e]) => e.fileId === c.fileId && isOurUploadCurrent(ctx, p)),
        );
        if (removesOurUpload) await loadRemoteIndex();
        if (hasFileChanges) {
            // Load communication data for mergeLock checks (once per call)
            commData ??= await loadCommunication(ctx);
            // Remote index for ancestorHash lookups (Safety Guard)
            await loadRemoteIndex();
        }
        for (const c of changes.changes) {
            pending.delete(c.fileId);
            retryCandidates.delete(c.fileId);
            seenFileIds.add(c.fileId);
            if (c.file?.path === ctx.pluginDataPath) remoteIndexChanged = true;
        }

        const {
            tasks,
            completed: pageCompleted,
            confirmedCount,
            failed,
        } = await processChangePage(
            ctx,
            changes.changes,
            remoteIndex,
            commData ?? { mergeLocks: {} },
        );

        if (tasks.length > 0) {
            ctx.startActivity();
            const release = announceIncoming(
                ctx,
                changes.changes.flatMap((c) => (c.file?.path && !c.removed ? [c.file.path] : [])),
            );
            try {
                await runParallel(tasks, ctx.settings.concurrency);
            } finally {
                release();
            }
            totalCompleted += pageCompleted.count;
        }

        confirmedCountTotal += confirmedCount;
        for (const f of failed) pending.set(f.id, { file: f, attempts: 0 });
        newFailureCount += failed.length;

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
    }

    // Another device published a new index: pick up files it lists that this
    // device has never seen (e.g. uploaded just before this device took its
    // first page token, so no change for them will ever arrive).
    if (remoteIndexChanged || reconcilePending.has(ctx)) {
        reconcilePending.delete(ctx);
        await loadRemoteIndex();
        const recovered =
            (await pullFilesMissingFromIndex(ctx, remoteIndex, seenFileIds, pending)) +
            (await refreshReincluded(ctx, seenFileIds));
        if (recovered > 0) {
            totalCompleted += recovered;
            hasTotalChanges = true;
        }
    }

    await retrySkippedRenames(ctx);
    if (await settleWaitingDeletions(ctx)) hasTotalChanges = true;

    // Retry pulls that failed in earlier syncs and were not superseded by a newer change
    const retries = [...retryCandidates.values()];
    if (retries.length > 0) {
        hasTotalChanges = true;
        commData ??= await loadCommunication(ctx);
        await loadRemoteIndex();
        const retryTasks = retries.map((r) => async () => {
            let ok = false;
            try {
                const meta = await ctx.adapter.getFileMetadataById(r.file.id, r.file.path);
                const localPathForId = Object.entries(ctx.index).find(
                    ([, e]) => e.fileId === r.file.id,
                )?.[0];
                if (!meta) {
                    ok = true; // gone remotely: its removal arrives as a change of its own
                } else if (
                    basename(meta.path) !== basename(r.file.path) ||
                    (localPathForId && localPathForId !== r.file.path)
                ) {
                    ok = true; // renamed since: the stored path is stale, the rename is its own change
                } else if (exceedsDeviceSizeLimit(ctx, meta.size)) {
                    ok = true; // over this device's size limit: left out here
                } else {
                    // Index annotations only when the index describes THIS version (as for
                    // fresh changes): a lagging index's plainHash belongs to an older version,
                    // and matching it against our content declared "in sync" a file that
                    // another device had changed.
                    const indexed = remoteIndex[r.file.path];
                    const remoteEntry =
                        indexed?.hash && meta.hash && indexed.hash.toLowerCase() === meta.hash.toLowerCase()
                            ? indexed
                            : undefined;
                    const item = {
                        ...r.file,
                        hash: meta.hash,
                        size: meta.size,
                        mtime: meta.mtime,
                        ancestorHash: remoteEntry?.ancestorHash,
                        plainHash: remoteEntry?.plainHash,
                    };
                    const localHash = ctx.localIndex[r.file.path]?.hash;
                    if (localHash && meta.hash && localHash.toLowerCase() === meta.hash.toLowerCase()) {
                        ok = true;
                    } else {
                        await ctx.log(`[Changes API] Retrying failed pull: ${r.file.path}`, "info");
                        ok = await pullFileSafely(ctx, item, "Changes API Retry");
                        if (ok) totalCompleted++;
                        else if (ctx.localIndex[r.file.path]?.pendingConflict) ok = true;
                    }
                }
            } catch {
                ok = false;
            }
            if (pending.get(r.file.id) !== r) return; // superseded meanwhile
            // Another device is merging it: waiting is not a failed attempt (giving up
            // left the device without the note once the merge was done)
            const waitedForLock = !ok && takePullLockSkip(ctx, r.file.path);
            if (ok) {
                pending.delete(r.file.id);
            } else if (waitedForLock) {
                pending.set(r.file.id, { file: r.file, attempts: r.attempts });
            } else if (r.attempts + 1 < CHANGES_MAX_PULL_RETRIES) {
                pending.set(r.file.id, { file: r.file, attempts: r.attempts + 1 });
            } else {
                pending.delete(r.file.id);
                await ctx.log(
                    `[Changes API] Giving up retrying ${r.file.path} after ${CHANGES_MAX_PULL_RETRIES} attempts.`,
                    "warn",
                );
            }
        });
        ctx.startActivity();
        await runParallel(retryTasks, ctx.settings.concurrency);
    }
    if (newFailureCount > 0) {
        await ctx.log(
            `[Smart Pull] ${newFailureCount} change(s) failed to apply; will retry on the next sync.`,
            "warn",
        );
    }

    if (hasTotalChanges) {
        if (totalCompleted > 0) {
            await ctx.notify("noticePullCompleted", totalCompleted.toString());
        }
        return true;
    }
    return false;
}

/**
 * Devices with files listed in the remote index that they could not pull yet (another
 * device was merging them, or an error). The next Changes API sync reconciles against
 * the remote index even if it did not change: no change for those files may ever come,
 * and our own index upload marks the remote index as seen.
 */
const reconcilePending = new CtxFlag("reconcilePending", "The next sync must reconcile against the remote index");

/**
 * Patterns were taken off this device's exclusion list: the files they left out
 * sync again. Those missing here are forgotten (index entries dropped), so the
 * next sync pulls them as files never seen; those still here sync as usual.
 * Returns how many were forgotten.
 */
export async function forgetReincludedFiles(ctx: SyncContext, previousPatterns: string): Promise<number> {
    return forgetReincluded(ctx, (path) => matchesDeviceScope(previousPatterns, path), "[Device scope]");
}

/**
 * Files left out under the previous settings and synced again now (`wasLeftOut`):
 * those missing here are forgotten (index entries dropped), so the next sync
 * pulls them as files never seen; those still here sync as usual.
 */
async function forgetReincluded(
    ctx: SyncContext,
    wasLeftOut: (path: string) => boolean,
    label: string,
): Promise<number> {
    const paths = new Set([...Object.keys(ctx.index), ...Object.keys(ctx.localIndex)]);
    let forgotten = 0;
    for (const path of paths) {
        if (path === ctx.pluginDataPath) continue;
        if (!wasLeftOut(path) || isDeviceExcluded(ctx, path)) continue;
        if (await ctx.vault.exists(path)) {
            // Kept here while left out: the cloud copy may have changed meanwhile
            // (those changes were skipped). Compared with the cloud at the next pull.
            if (ctx.index[path]?.fileId) reincludedOf(ctx).add(path);
            continue;
        }
        delete ctx.index[path];
        delete ctx.localIndex[path];
        ctx.dirtyPaths.delete(path);
        forgotten++;
    }
    // Also needed when nothing was forgotten: files never indexed here (left out
    // since the first sync) are found only by comparing with the remote index.
    reconcilePending.add(ctx);
    if (forgotten > 0) {
        await saveIndex(ctx);
        await ctx.log(`${label} ${forgotten} file(s) no longer left out will be downloaded`, "info");
    }
    await saveLocalIndex(ctx, true);
    return forgotten;
}

/**
 * The sync settings that decide what this device leaves out changed since the
 * last sync (here, or on another device: the settings file is synced). Files
 * synced again are fetched; files now left out simply stay as they are.
 */
export async function reconcileScopeChange(ctx: SyncContext): Promise<boolean> {
    // Changes skipped under settings changed after the last reconcile (and maybe
    // changed back since): compared with the cloud again when synced now.
    for (const [path, entry] of takeSkippedOutOfScope(ctx)) {
        if (path === ctx.pluginDataPath) continue;
        if (isDeviceExcluded(ctx, path)) {
            noteSkippedOutOfScope(ctx, path, entry, true); // still left out: kept for later
            continue;
        }
        reconcilePending.add(ctx);
        if (ctx.index[path]?.fileId) reincludedOf(ctx).add(path);
        // Not known here: the shared index may not list it either (an index upload
        // made while it was left out here replaced the one listing it), so the
        // file is pulled by id.
        else if (!ctx.localIndex[path]) oweUnseenPull(ctx, path, entry);
    }
    const changedMeanwhile = takeScopeUnsettled(ctx);
    const change = takeScopeChange(ctx, ctx.settings);
    if (!change) {
        if (!changedMeanwhile) return false;
        // Changed during the last sync and back since: files left out meanwhile were
        // skipped by its scan and push. A vault scan and a comparison with the remote
        // index find them.
        await ctx.log("[Sync scope] Exclusion or content settings were changed and changed back", "info");
        reconcilePending.add(ctx);
        return true;
    }
    const before: Pick<SyncContext, "settings"> = { settings: { ...ctx.settings, ...change.previous } };
    await ctx.log("[Sync scope] Exclusion or content settings changed since the last sync", "info");
    // A move not pushed yet whose new name is now left out: the cloud still has the
    // file under its old name, which this device would never pull again (its id is
    // known here under the new name). Forget the new name: the copy here stays, the
    // cloud file comes back under its own name.
    const movedOut: Array<[string, LocalFileIndex[string]]> = [];
    for (const path of Object.keys(ctx.index)) {
        if (path === ctx.pluginDataPath || isDeviceExcluded(before, path) || !isDeviceExcluded(ctx, path)) continue;
        if (!ctx.index[path]?.pendingMove && !ctx.localIndex[path]?.pendingMove) continue;
        await ctx.log(`[Sync scope] ${path} was moved but is now left out: its cloud file stays where it is`, "info");
        // The shared index may not list it yet (it was uploaded just before the move):
        // list it under its cloud name, or devices syncing from the index never get it
        const moved = ctx.index[path] ?? ctx.localIndex[path];
        if (moved?.pendingMove && moved.fileId) {
            const { pendingMove, forcePush: _f, ...rest } = moved;
            relistForOthersAdd(ctx, pendingMove.oldPath, { ...rest, lastAction: "push" });
            // Its old name is synced here: as when moved straight into a folder left out,
            // the file left the sync. Deleted in the cloud, the copy here stays.
            if (!isDeviceExcluded(ctx, pendingMove.oldPath)) movedOut.push([pendingMove.oldPath, { ...rest }]);
        }
        delete ctx.index[path];
        delete ctx.localIndex[path];
        ctx.dirtyPaths.delete(path);
    }
    await forgetReincluded(ctx, (path) => isDeviceExcluded(before, path), "[Sync scope]");
    for (const [path, entry] of movedOut) {
        if (ctx.index[path] || (await ctx.vault.exists(path))) continue; // the name holds another file now
        ctx.index[path] = { ...entry };
        ctx.localIndex[path] = { ...entry };
        markDeleted(ctx, path);
    }
    // The reconciled settings are saved with the local index: save the index changes
    // made for them too. Closed before that, the app restarted with the new settings
    // recorded as reconciled but the old entries (a move into a folder now left out
    // still pending), and the note stayed missing here for good.
    await saveIndex(ctx);
    await saveLocalIndex(ctx, true);
    return true;
}

/**
 * Pull files listed in the remote index that this device has no record of
 * at all (no index entry, fileId unknown, not dirty, not just deleted).
 * Existence is re-checked by id first so a stale index entry of a file that
 * was deleted meanwhile is never resurrected.
 */
const reincluded = new CtxState<Set<string>>(
    "reincludedFiles",
    "Files kept here while left out and synced again: compare with the cloud at the next pull",
);
function reincludedOf(ctx: SyncContext): Set<string> {
    let s = reincluded.get(ctx);
    if (!s) reincluded.set(ctx, (s = new Set<string>()));
    return s;
}

/**
 * Files synced again after being left out here, whose copy stayed on this
 * device: changes made elsewhere meanwhile were skipped, so the cloud version
 * is compared now and pulled (merged with any edit made here) when it differs.
 * A file deleted or moved in the cloud meanwhile is forgotten: the copy here
 * then counts as a new file and is uploaded, so nothing is lost.
 */
async function refreshReincluded(ctx: SyncContext, seenFileIds: Set<string>): Promise<number> {
    const paths = [...reincludedOf(ctx)];
    if (paths.length === 0) return 0;
    let count = 0;
    const tasks = paths.map((path) => async () => {
        const entry = ctx.index[path];
        if (!entry?.fileId) {
            reincludedOf(ctx).delete(path);
            return;
        }
        // Left out again before this pull (settings changed meanwhile): compared once
        // it is synced again, so the changes skipped while it was left out still come
        if (isDeviceExcluded(ctx, path)) return;
        if (seenFileIds.has(entry.fileId)) {
            reincludedOf(ctx).delete(path); // this pull already brought its latest change
            return;
        }
        try {
            // Renamed here and not pushed yet: the cloud still has it under the old name
            const cloudPath = (entry.pendingMove ?? ctx.localIndex[path]?.pendingMove)?.oldPath ?? path;
            const meta = await ctx.adapter.getFileMetadataById(entry.fileId, cloudPath);
            reincludedOf(ctx).delete(path);
            if (!meta || meta.kind === "folder" || meta.path !== cloudPath) {
                await ctx.log(`[Sync scope] ${path} was deleted or moved in the cloud while left out here: keeping this copy as a new file`, "info");
                delete ctx.index[path];
                delete ctx.localIndex[path];
                ctx.dirtyPaths.set(path, Date.now());
                return;
            }
            if (meta.hash && entry.hash && meta.hash.toLowerCase() === entry.hash.toLowerCase()) return;
            await ctx.log(`[Sync scope] ${path} changed in the cloud while left out here: pulling it`, "info");
            if (
                await pullFileSafely(
                    ctx,
                    { path, fileId: entry.fileId, hash: meta.hash, size: meta.size, mtime: meta.mtime },
                    "Scope Reconcile",
                )
            )
                count++;
        } catch (e) {
            reincludedOf(ctx).add(path);
            reconcilePending.add(ctx);
            await ctx.log(`[Sync scope] Could not compare ${path} with the cloud: ${String(e)}`, "warn");
        }
    });
    await runParallel(tasks, ctx.settings.concurrency);
    return count;
}

async function pullFilesMissingFromIndex(
    ctx: SyncContext,
    remoteIndex: LocalFileIndex,
    seenFileIds: Set<string>,
    pendingRetries: Map<string, unknown>,
): Promise<number> {
    const knownIds = new Set<string>();
    for (const e of Object.values(ctx.index)) if (e.fileId) knownIds.add(e.fileId);
    for (const e of Object.values(ctx.localIndex)) if (e.fileId) knownIds.add(e.fileId);

    const missing: Array<[string, LocalFileIndex[string]]> = [];
    for (const [path, entry] of Object.entries(remoteIndex)) {
        if (!entry?.fileId || path === ctx.pluginDataPath) continue;
        if (isManagedSeparately(path) || isAlwaysForbiddenOnRemote(path) || shouldIgnore(ctx, path)) continue;
        if (ctx.index[path] || ctx.localIndex[path]) continue;
        if (knownIds.has(entry.fileId) || seenFileIds.has(entry.fileId)) continue;
        if (pendingRetries.has(entry.fileId)) continue;
        if (ctx.dirtyPaths.has(path) || ctx.recentlyDeletedFromRemote.has(path)) continue;
        if (exceedsDeviceSizeLimit(ctx, entry.size)) continue;
        missing.push([path, entry]);
    }
    if (missing.length === 0) return 0;

    let count = 0;
    const tasks = missing.map(([path, entry]) => async () => {
        try {
            const meta = await ctx.adapter.getFileMetadataById(entry.fileId, path);
            if (!meta || meta.kind === "folder" || basename(meta.path) !== basename(path)) return;
            await ctx.log(`[Changes API] Pulling file listed in remote index but never seen: ${path}`, "info");
            const ok = await pullFileSafely(
                ctx,
                {
                    path,
                    fileId: entry.fileId,
                    hash: meta.hash,
                    size: meta.size,
                    mtime: meta.mtime,
                    ancestorHash: entry.ancestorHash,
                    plainHash: entry.plainHash,
                },
                "Index Reconcile",
            );
            if (ok) count++;
            else if (!ctx.localIndex[path]) reconcilePending.add(ctx);
        } catch (e) {
            reconcilePending.add(ctx);
            await ctx.log(`[Changes API] Index reconcile failed for ${path}: ${String(e)}`, "warn");
        }
    });
    ctx.startActivity();
    await runParallel(tasks, ctx.settings.concurrency);
    return count;
}

/**
 * The notes inside folders that this page reports renamed or moved. On Drive a
 * folder rename is one change: the notes keep their parent folder and are not
 * listed, so they stayed here under the old folder name. A folder holding no note
 * known under its new name is listed once (a new folder usually holds none known
 * either, its notes come with their own changes); each note found there under
 * another name here is taken as a change of its own (a rename).
 */
const foldersListedAt = new CtxState<Map<string, string>>(
    "foldersListedAt",
    "Changed folders (by id) and the path each was listed at for notes that moved with it",
);

async function notesMovedWithFolders(
    ctx: SyncContext,
    changes: ReadonlyArray<{ fileId: string; removed?: boolean; file?: ChangedFile & { kind: string } }>,
    localIdToPath: ReadonlyMap<string, string>,
): Promise<Array<{ fileId: string; file: ChangedFile & { kind: string } }>> {
    const listed = new Set(changes.map((c) => c.fileId));
    // Nothing known here can have moved with a folder
    if (localIdToPath.size === 0) return [];
    const out: Array<{ fileId: string; file: ChangedFile & { kind: string } }> = [];
    for (const change of changes) {
        const folder = change.file;
        if (change.removed || folder?.kind !== "folder" || !folder.path) continue;
        if (shouldIgnore(ctx, folder.path)) continue;
        // Listed at this path before (since the app started): its notes are in place
        let seen = foldersListedAt.get(ctx);
        if (!seen) foldersListedAt.set(ctx, (seen = new Map<string, string>()));
        if (seen.get(folder.id) === folder.path) continue;
        const prefix = folder.path + "/";
        // A failure fails the page: it is fetched again next sync. The folder's change
        // is the only notice of the move, so going on would lose it for good. A note
        // of the folder already known under the new name (its own change came first)
        // does not mean the others moved too: the folder is listed all the same.
        const inside: CloudFile[] = await ctx.adapter.listFiles(folder.id);
        const before = out.length;
        for (const f of inside) {
            if (f.kind === "folder" || listed.has(f.id)) continue;
            const was = localIdToPath.get(f.id);
            const path = prefix + f.path;
            if (!was || was === path) continue;
            listed.add(f.id);
            out.push({ fileId: f.id, file: { ...f, path, kind: "file" } });
        }
        // Remembered only when nothing had to move: when this page fails later (a
        // listing of another folder, a rename) it is fetched again, and a folder
        // remembered with its moves still to be made would then be passed over.
        if (out.length === before) seen.set(folder.id, folder.path);
    }
    if (out.length > 0) {
        await ctx.log(`[Changes API] ${out.length} note(s) moved with their folder`, "debug");
    }
    return out;
}

/** Process one page of Changes API results */
async function processChangePage(
    ctx: SyncContext,
    changes: Array<{
        fileId: string;
        removed?: boolean;
        /** Not deleted: moved to where this device does not sync */
        movedOut?: boolean;
        file?: ChangedFile & { kind: string };
    }>,
    remoteIndex: LocalFileIndex,
    commData: Pick<CommunicationData, "mergeLocks">,
): Promise<{
    tasks: (() => Promise<void>)[];
    completed: { count: number };
    confirmedCount: number;
    failed: ChangedFile[];
}> {
    const tasks: (() => Promise<void>)[] = [];
    const completed = { count: 0 };
    const failed: ChangedFile[] = [];
    let confirmedCount = 0;

    // Pre-calculate ID map for rename detection (Ghost File Check)
    const localIdToPath = new Map<string, string>();
    for (const [p, entry] of Object.entries(ctx.index)) {
        if (entry.fileId) localIdToPath.set(entry.fileId, p);
    }
    changes = [...changes, ...(await notesMovedWithFolders(ctx, changes, localIdToPath))];

    // Files this batch moves to a different name. A rename onto a name that one of
    // them still holds here is not a collision: that file is about to leave the name.
    // Treating it as one renamed the incoming file to "X (2)", in the cloud too, and
    // every device did the same with the next batch: an endless chain of "(2)" names.
    const movingAway = new Set<string>();
    for (const change of changes) {
        const f = change.file;
        const prev = f?.id ? localIdToPath.get(f.id) : undefined;
        if (f && prev && pathKey(prev) !== pathKey(f.path)) movingAway.add(f.id);
    }
    const deferred = new Set<(typeof changes)[number]>();
    const queue = [...changes];
    // Local deletions of this page, reviewed after the page is planned and
    // before any task runs (tasks start only after this function returns)
    const localDeletions: string[] = [];
    let decision = PlanDecision.approveAll();

    for (const change of queue) {
        if (change.removed) {
            const pathToDelete = Object.entries(ctx.index).find(
                ([, entry]) => entry.fileId === change.fileId,
            )?.[0];

            if (pathToDelete && pathToDelete !== ctx.pluginDataPath && isDeviceExcluded(ctx, pathToDelete)) {
                // Left out on this device: forget it, a copy kept here stays untouched
                delete ctx.index[pathToDelete];
                delete ctx.localIndex[pathToDelete];
                continue;
            }
            if (pathToDelete && pathToDelete !== ctx.pluginDataPath) {
                if (!change.movedOut && (await weighRemoteDeletion(ctx, pathToDelete, change.fileId)) !== "delete") continue;
                // Track this path to prevent re-upload if local deletion fails
                ctx.recentlyDeletedFromRemote.add(pathToDelete);
                localDeletions.push(pathToDelete);
                tasks.push(async () => {
                    try {
                        // Another file of this page took the name meanwhile (the deleted
                        // one had already left it here): that file is not what was deleted.
                        const holder = ctx.index[pathToDelete]?.fileId;
                        if (holder && holder !== change.fileId) {
                            await ctx.log(`[Smart Pull] ${pathToDelete} now holds another file. Not deleting it.`, "debug");
                            return;
                        }
                        if (!(await applyRemoteDeletion(ctx, pathToDelete, decision))) return;
                        ctx.logger.markActionTaken();
                        completed.count++;
                        await ctx.log(`[Smart Pull] Deleted: ${pathToDelete}`, "info");
                        await ctx.notify("noticeFileTrashed", basename(pathToDelete));
                    } catch (e) {
                        await ctx.log(
                            `[Smart Pull] Delete failed: ${pathToDelete} - ${String(e)}`,
                            "error",
                        );
                    }
                });
            }
        } else if (change.file && change.file.kind === "file") {
            const cloudFile: ChangedFile = change.file;
            if (cloudFile.path === ctx.pluginDataPath) continue;
            if (isManagedSeparately(cloudFile.path)) continue;
            // Over this device's size limit: not fetched; a copy already here stays as it is.
            // A full scan after the limit changes fetches it.
            if (exceedsDeviceSizeLimit(ctx, cloudFile.size)) {
                await ctx.log(`[Changes API] Left out (over this device's size limit): ${cloudFile.path}`, "debug");
                continue;
            }
            if (isDeviceExcluded(ctx, cloudFile.path)) {
                noteSkippedOutOfScope(ctx, cloudFile.path, {
                    fileId: cloudFile.id,
                    hash: cloudFile.hash,
                    size: cloudFile.size,
                    mtime: cloudFile.mtime,
                } as LocalFileIndex[string]);
                // Moved elsewhere to where this device does not sync: for this device
                // the file it synced is gone, as when deleted there.
                const known = Object.entries(ctx.index).find(([, e]) => e.fileId === cloudFile.id)?.[0];
                // Our own move of it not pushed yet (renamed here while uploading from
                // the old place): the cloud name is the old one, not another device's move.
                const ownMovePending = !!known && ctx.index[known]?.pendingMove?.oldPath === cloudFile.path;
                if (known && known !== ctx.pluginDataPath && !isDeviceExcluded(ctx, known) && !ownMovePending) {
                    await ctx.log(`[Smart Pull] ${known} was moved to ${cloudFile.path}, which this device does not sync`, "info");
                    queue.push({ ...change, removed: true, movedOut: true, file: undefined, fileId: cloudFile.id });
                }
                continue;
            }

            // Populate ancestorHash and plainHash from remote index.
            // Only when the index describes THIS version: the index is uploaded after the
            // file, so it can lag behind, and a stale ancestorHash made the Safety Guard
            // accept a version that does not contain our push.
            const remoteEntry = remoteIndex[cloudFile.path];
            if (
                remoteEntry &&
                (!remoteEntry.hash ||
                    !cloudFile.hash ||
                    remoteEntry.hash.toLowerCase() === cloudFile.hash.toLowerCase())
            ) {
                cloudFile.ancestorHash = remoteEntry.ancestorHash;
                if (remoteEntry.plainHash) {
                    cloudFile.plainHash = remoteEntry.plainHash;
                }
            }

            // Only clean up system-level forbidden files during pull (Changes API).
            if (isAlwaysForbiddenOnRemote(cloudFile.path)) {
                tasks.push(async () => {
                    try {
                        await removeRemote(
                            ctx,
                            { id: cloudFile.id, path: cloudFile.path, kind: "file" },
                            "system-cleanup",
                        );
                        ctx.logger.markActionTaken();
                        await ctx.log(
                            `[Smart Pull] [Cleanup] Deleted forbidden file (via Changes API): ${cloudFile.path}`,
                            "debug",
                        );
                        delete ctx.index[cloudFile.path];
                        delete ctx.localIndex[cloudFile.path];
                    } catch (e) {
                        await ctx.log(
                            `[Smart Pull] [Cleanup] Failed to delete forbidden file: ${cloudFile.path} - ${String(e)}`,
                            "error",
                        );
                    }
                });
                continue;
            }

            // A new file whose name (or its other spelling) a file of this batch is about
            // to leave here: apply that rename first. Pulled before it, the new file was
            // written over that note on a case/Unicode-insensitive disk.
            if (!localIdToPath.has(cloudFile.id) && !deferred.has(change)) {
                const holder = findPathCollision(ctx, cloudFile.path, cloudFile.id);
                const holderId = holder ? ctx.index[holder]?.fileId : undefined;
                if (holderId && movingAway.has(holderId)) {
                    deferred.add(change);
                    queue.push(change);
                    continue;
                }
            }

            // Remote rename of a file we know under another path
            if (localIdToPath.has(cloudFile.id)) {
                const prevPathForId = localIdToPath.get(cloudFile.id);
                if (prevPathForId && prevPathForId !== cloudFile.path) {
                    const oldPath = prevPathForId;
                    const newPath = cloudFile.path;

                    const holder = findPathCollision(ctx, newPath, cloudFile.id);
                    const holderId = holder ? ctx.index[holder]?.fileId : undefined;
                    if (holderId && movingAway.has(holderId) && !deferred.has(change)) {
                        deferred.add(change);
                        queue.push(change);
                        continue;
                    }

                    // Another note of ours was listed under the new name and is gone here,
                    // its deletion (or rename) not yet reported or pushed. Taking the name
                    // now let that late delete event land on this renamed note and delete
                    // it everywhere. Follow the rename once that note has left the name.
                    const occupant = ctx.index[newPath];
                    if (
                        occupant?.fileId &&
                        occupant.fileId !== cloudFile.id &&
                        !(await ctx.vault.exists(newPath))
                    ) {
                        await ctx.log(
                            `[Changes API] Remote Rename ${oldPath} -> ${newPath} waits: another note here left that name and is not synced yet.`,
                            "info",
                        );
                        skippedRenamesOf(ctx).set(cloudFile.id, newPath);
                        continue;
                    }

                    // Guard: if the user moved this file locally too (pendingMove), skip the
                    // remote rename — our own move is pushed next. A merely DIRTY file (content
                    // edits, or the echo event of our own pull write) must still follow the
                    // rename: skipping it dropped the rename for good (the change is consumed),
                    // leaving the old path behind forever and losing edits made under it. The
                    // dirty flag moves with the file, and the content is reconciled below.
                    const localIndexEntry = ctx.index[oldPath];
                    if (
                        localIndexEntry?.pendingMove &&
                        // Only a deletion the vault reported: a file merely missing may have
                        // been renamed again a moment ago (its event not here yet), and the
                        // cloud name may be just our own move not pushed yet.
                        hasDeleteIntent(ctx, oldPath) &&
                        !(await ctx.vault.exists(oldPath))
                    ) {
                        // We renamed it and then deleted it, while another device renamed it
                        // (and maybe edited it). Skipping kept a stale entry that a different
                        // note later took over under this name, and the file never arrived
                        // here again. The other device's newer version wins over our delete,
                        // as for any edit/delete conflict: forget our entry and pull it.
                        delete ctx.index[oldPath];
                        delete ctx.localIndex[oldPath];
                        ctx.dirtyPaths.delete(oldPath);
                        localIdToPath.delete(cloudFile.id);
                        await ctx.log(
                            `[Changes API] ${oldPath} was renamed to ${newPath} on another device after we deleted it here. Keeping their version.`,
                            "info",
                        );
                    } else if (localIndexEntry?.pendingMove) {
                        // Still confirm our own upload (same as the "Sync confirmed" path
                        // below). Otherwise ancestorHash stays at an older version, and the
                        // next merge uses a stale base and reports a conflict that isn't one.
                        const lastAction = ctx.localIndex[oldPath]?.lastAction;
                        if (
                            (lastAction === "push" || lastAction === "merge") &&
                            localIndexEntry.hash &&
                            cloudFile.hash &&
                            localIndexEntry.hash.toLowerCase() === cloudFile.hash.toLowerCase()
                        ) {
                            const confirmed = cloudFile.hash.toLowerCase();
                            localIndexEntry.ancestorHash = confirmed;
                            if (ctx.localIndex[oldPath]) {
                                const pushedFrom = ctx.localIndex[oldPath].ancestorHash;
                                if (pushedFrom && pushedFrom.toLowerCase() !== confirmed) {
                                    ctx.localIndex[oldPath].ownPushBase = pushedFrom;
                                }
                                ctx.localIndex[oldPath].ancestorHash = confirmed;
                                ctx.localIndex[oldPath].lastAction = "pull";
                            }
                            await ctx.log(
                                `[Smart Pull] Sync confirmed for ${oldPath} (pending move). ancestorHash updated to ${confirmed.substring(0, 8)}`,
                                "debug",
                            );
                        }
                        await ctx.log(
                            `[Changes API] Remote Rename skipped: ${oldPath} -> ${newPath} (local has pending move/changes)`,
                            "debug",
                        );
                        continue;
                    }

                    // A rename that only changes letter case / Unicode form: on Windows and
                    // macOS the "target" exists because it is this very file. Skipping
                    // it kept the old spelling here for good while the cloud had the new one.
                    // A name that differs only in letter case or Unicode form is the same
                    // file on a case/normalization-insensitive disk, but a separate file
                    // on Linux: there both exact names are listed (or only the new one,
                    // when the old name is gone).
                    const listed = (p: string) => ctx.vault.getFiles().some((f) => f.path === p);
                    const sameFileOnDisk =
                        oldPath !== newPath &&
                        pathKey(oldPath) === pathKey(newPath) &&
                        (await ctx.vault.exists(oldPath)) &&
                        !(listed(oldPath) && listed(newPath));
                    const targetExists = !sameFileOnDisk && (await ctx.vault.exists(newPath));

                    if (!targetExists) {
                        try {
                            const sourceExists = await ctx.vault.exists(oldPath);
                            if (sourceExists) {
                                await ctx.log(
                                    `[Changes API] Remote Rename detected: ${oldPath} -> ${newPath}. Renaming locally.`,
                                    "info",
                                );

                                await renameLocal(ctx, oldPath, newPath);
                                await followFolderSpelling(ctx, oldPath, newPath);
                                noteVacatedFolder(ctx, oldPath);
                                moveAttemptedUploads(ctx, oldPath, newPath);
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
                                    // A background pull queued under the old name for another
                                    // file (a same-name file that arrived meanwhile) marked this
                                    // entry: the mark is not for the note renamed away. Kept on
                                    // it, the note stayed "in transfer" for good.
                                    const moved = ctx.localIndex[newPath];
                                    const queuedForOther = (ctx.backgroundTransferQueue.getPendingTransfers?.() ?? []).some(
                                        (t) => t.direction === "pull" && t.path === oldPath && !!t.fileId && t.fileId !== cloudFile.id,
                                    );
                                    if (moved.pendingTransfer?.direction === "pull" && queuedForOther) delete moved.pendingTransfer;
                                }

                                if (ctx.dirtyPaths.has(oldPath)) {
                                    ctx.dirtyPaths.delete(oldPath);
                                    ctx.dirtyPaths.set(newPath, Date.now());
                                } else {
                                    await markIfEditedSinceSync(ctx, newPath);
                                }
                                // Journal it now: killed before the next save, the restarted
                                // app still listed the old name, found the note gone and the
                                // renamed file unknown, and kept it as an extra copy.
                                await saveLocalIndex(ctx);
                                await saveIndex(ctx);

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
                                `[Changes API] Failed to rename ${oldPath} -> ${newPath}: ${String(e)}`,
                                "warn",
                            );
                        }
                    } else if (
                        !ctx.index[newPath] &&
                        !ctx.localIndex[newPath] &&
                        !(await ctx.vault.exists(oldPath)) &&
                        (await holdsSyncedContent(ctx, newPath, oldPath))
                    ) {
                        // The rename is already done here, only its index update was lost
                        // (the app was killed after renaming, before the index was saved,
                        // and this change is replayed). Skipping it treated the file as an
                        // unknown local one: its edits ended up in a conflict copy.
                        moveIndexEntry(ctx, oldPath, newPath);
                        localIdToPath.set(cloudFile.id, newPath);
                        await ctx.log(
                            `[Changes API] Remote Rename ${oldPath} -> ${newPath} was already applied locally. Index updated.`,
                            "info",
                        );
                    } else if (
                        pathKey(oldPath) !== pathKey(newPath) &&
                        (await ctx.vault.exists(oldPath)) &&
                        findPathCollision(ctx, newPath, cloudFile.id)
                    ) {
                        // Another synced file already has this name here (on Windows/macOS
                        // "Note.md" and "note.md" are one file). Skipping the rename left
                        // the old index entry behind, so a later note created under the
                        // old name was taken for an edit of this one and overwritten.
                        // Give this file a free name, in the cloud too.
                        const alt = await freeCollisionPath(ctx, newPath);
                        try {
                            await ctx.adapter.moveFile(cloudFile.id, basename(alt), dirname(alt) || null);
                            await renameLocal(ctx, oldPath, alt);
                            ctx.logger.markActionTaken();
                            moveIndexEntry(ctx, oldPath, alt);
                            localIdToPath.set(cloudFile.id, alt);
                            cloudFile.path = alt;
                            await ctx.log(
                                `[Changes API] Remote Rename: ${newPath} has the same name as another note on Windows/macOS. Renamed ${oldPath} to ${alt}.`,
                                "warn",
                            );
                        } catch (e) {
                            await ctx.log(`[Changes API] Failed to rename ${oldPath} -> ${alt}: ${String(e)}`, "warn");
                        }
                    } else if (
                        !ctx.index[newPath] &&
                        !ctx.localIndex[newPath] &&
                        (await ctx.vault.exists(oldPath))
                    ) {
                        // The new name is a separate note made here and never synced (on
                        // Linux, also a new spelling of the same name). Skipping the rename
                        // left the old name behind for good, and this note's push waited on
                        // that cloud file forever. Move the local note to a free name and
                        // follow the rename.
                        const alt = await freeCollisionPath(ctx, newPath);
                        try {
                            await renameLocal(ctx, newPath, alt);
                            ctx.dirtyPaths.delete(newPath);
                            ctx.dirtyPaths.set(alt, Date.now());
                            await renameLocal(ctx, oldPath, newPath);
                            ctx.logger.markActionTaken();
                            moveIndexEntry(ctx, oldPath, newPath);
                            if (ctx.dirtyPaths.has(oldPath)) {
                                ctx.dirtyPaths.delete(oldPath);
                                ctx.dirtyPaths.set(newPath, Date.now());
                            } else {
                                await markIfEditedSinceSync(ctx, newPath);
                            }
                            localIdToPath.set(cloudFile.id, newPath);
                            await ctx.log(
                                `[Changes API] Remote Rename: ${newPath} was a separate local note. Moved it to ${alt} and renamed ${oldPath}.`,
                                "warn",
                            );
                        } catch (e) {
                            await ctx.log(`[Changes API] Failed to rename ${oldPath} -> ${newPath}: ${String(e)}`, "warn");
                        }
                    } else {
                        await ctx.log(
                            `[Changes API] Remote Rename: Target ${newPath} exists. Skipping rename to avoid overwrite.`,
                            "warn",
                        );
                        // The note in the way may leave that name later (its own rename can
                        // come in a later change): follow this rename then, or this device
                        // keeps the old name for good.
                        skippedRenamesOf(ctx).set(cloudFile.id, newPath);
                    }
                }
            }

            // Skip if local index hash matches (already synced by this client).
            // Read after the rename above so a renamed entry is found under its new path.
            const heldByMove = ctx.index[cloudFile.path];
            if (
                heldByMove?.pendingMove &&
                heldByMove.fileId &&
                heldByMove.fileId !== cloudFile.id &&
                (await ctx.vault.exists(cloudFile.path))
            ) {
                // We moved another note to this name here (not pushed yet) while a
                // different note took the name in the cloud. Treating that note as an
                // edit of ours turned ours into a conflict copy and lost its move.
                // Give our note a free name; the push then moves it there.
                const alt = await freeCollisionPath(ctx, cloudFile.path);
                try {
                    await renameLocal(ctx, cloudFile.path, alt);
                    moveIndexEntry(ctx, cloudFile.path, alt);
                    ctx.dirtyPaths.set(alt, ctx.dirtyPaths.get(alt) ?? Date.now());
                    localIdToPath.set(heldByMove.fileId, alt);
                    await ctx.log(
                        `[Changes API] ${cloudFile.path} is now another note in the cloud. Moved the note renamed here to ${alt}.`,
                        "warn",
                    );
                } catch (e) {
                    await ctx.log(`[Changes API] Could not move ${cloudFile.path} to ${alt}: ${String(e)}`, "warn");
                }
            }
            const localEntry = ctx.index[cloudFile.path];

            // Our entry for this name belongs to another cloud file (that one was moved
            // away and a new file with the same content took the name). Without taking
            // over the new file's id, the entry was later dropped as a stale copy of the
            // moved file and the note at this name was deleted here.
            if (
                localEntry?.fileId &&
                localEntry.fileId !== cloudFile.id &&
                cloudFile.hash &&
                [localEntry.ancestorHash, localEntry.hash].some(
                    (h) => !!h && h.toLowerCase() === cloudFile.hash!.toLowerCase(),
                )
            ) {
                const previousId = localEntry.fileId;
                localEntry.fileId = cloudFile.id;
                if (ctx.localIndex[cloudFile.path]) ctx.localIndex[cloudFile.path].fileId = cloudFile.id;
                if (localIdToPath.get(previousId) === cloudFile.path) localIdToPath.delete(previousId);
                localIdToPath.set(cloudFile.id, cloudFile.path);
                await ctx.log(
                    `[Changes API] ${cloudFile.path} is now a different cloud file with the same content. Index updated.`,
                    "debug",
                );
            }

            // Guard: If remote hash matches our ancestorHash, it's likely a stale echo
            if (
                localEntry?.ancestorHash &&
                cloudFile.hash === localEntry.ancestorHash &&
                !(await revertedToAncestor(ctx, localEntry, cloudFile))
            ) {
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
                    const pushedFrom = ctx.localIndex[cloudFile.path].ancestorHash;
                    if (pushedFrom && pushedFrom.toLowerCase() !== cloudFile.hash.toLowerCase()) {
                        ctx.localIndex[cloudFile.path].ownPushBase = pushedFrom;
                    }
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

            // Check if another device is merging this file. Checked only now: applying a
            // remote rename and confirming our own upload are metadata-only and must not
            // be skipped while the content is locked - the change is consumed, so a skipped
            // rename was lost for good, and a skipped confirmation left a stale merge base
            // (our own edit then looked like a conflicting change in the next merge).
            const now = Date.now();
            const mergeLock = findForeignLock(ctx, commData, cloudFile.path, cloudFile.id, now);
            if (mergeLock) {
                await ctx.log(
                    `[Smart Pull] Waiting: ${cloudFile.path} is being merged by ${mergeLock.holder} (expires in ${Math.round((mergeLock.expiresAt - now) / 1000)}s)`,
                    "warn",
                );
                await ctx.notify("noticeWaitOtherDeviceMerge", basename(cloudFile.path));
                // Mark as pending conflict so next sync shows "merge result applied"
                const known = ctx.localIndex[cloudFile.path];
                if (known && (!known.fileId || known.fileId === cloudFile.id)) {
                    known.pendingConflict = true;
                    await saveLocalIndex(ctx);
                } else {
                    // A file we don't have yet (or a new cloud file under a name whose
                    // old file is being deleted: that entry, and its re-check, goes with
                    // the deletion): the change is consumed. Retry it on the next syncs.
                    failed.push(cloudFile);
                }
                continue; // Skip this file, wait for merge to complete
            }

            const changesThreshold = getThresholdBytes(ctx);
            const hasLocalConflict = ctx.dirtyPaths.has(cloudFile.path);

            // Possibly our own upload whose response was lost (a new file renamed or
            // deleted here since): decided inline, where it is recognised and not pulled
            // back as a second copy.
            const maybeOurLostUpload = !ctx.index[cloudFile.path] && !!peekAttemptedUpload(ctx, cloudFile.path);
            if (
                changesThreshold > 0 &&
                !hasLocalConflict &&
                !maybeOurLostUpload &&
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
                pendingPullsOf(ctx).set(cloudFile.id, { file: cloudFile, attempts: 0, background: true });
                await ctx.log(
                    `[Changes API] Deferred to background (${formatSize(cloudFile.size)}): ${cloudFile.path}`,
                    "info",
                );
            } else {
                ctx.progress?.plan("pull", [{ path: cloudFile.path, size: cloudFile.size }]);
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
                        } else if (!ctx.localIndex[cloudFile.path]?.pendingConflict) {
                            // Not a merge-lock wait (those are re-checked via pendingConflict)
                            failed.push(cloudFile);
                        }
                    } finally {
                        ctx.backgroundTransferQueue.markInlineEnd(cloudFile.path);
                    }
                });
            }
        }
    }

    decision = await reviewPlan(ctx, {
        step: "pull",
        changes: localDeletions.map((path) => ({ action: "delete-local", path, kind: "file" })),
    });

    return { tasks, completed, confirmedCount, failed };
}

/**
 * The file at `path` is the synced file known as `knownAs`: it has exactly that name, or
 * the content we last synced. On Windows/macOS a different, new note with the same name in other
 * letter case ("Todo.md" for "todo.md") also "exists": taking it for the renamed file
 * uploaded that note over the renamed one.
 */
async function holdsSyncedContent(ctx: SyncContext, path: string, knownAs: string): Promise<boolean> {
    const entry = ctx.localIndex[knownAs] ?? ctx.index[knownAs];
    if (!entry) return false;
    try {
        if (!(await ctx.vault.exists(path))) return false;
        // Under exactly this name (not just the same name in other letter case): ours,
        // possibly edited since the rename.
        if (ctx.vault.getFiles().some((f) => f.path === path)) return true;
        const content = await ctx.vault.readBinary(path);
        const { localHash, compareHash } = await computeLocalHash(ctx, content, entry);
        return !!compareHash && localHash === compareHash.toLowerCase();
    } catch {
        return false;
    }
}

/**
 * After following another device's rename: an edit the user saved just before (its
 * vault event not delivered yet, or reported for the old name) is in the renamed
 * file but marked nowhere. Unmarked, it was never pushed and the device kept a
 * version the cloud never got. Compare with what the index says we synced.
 */
async function markIfEditedSinceSync(ctx: SyncContext, path: string): Promise<void> {
    const entry = ctx.localIndex[path];
    if (!entry || ctx.dirtyPaths.has(path)) return;
    try {
        const content = await ctx.vault.readBinary(path);
        const { localHash, compareHash } = await computeLocalHash(ctx, content, entry);
        if (compareHash && localHash !== compareHash.toLowerCase()) {
            ctx.dirtyPaths.set(path, Date.now());
            await ctx.log(`[Smart Pull] ${path} was edited here before the rename arrived; it will be pushed.`, "info");
        }
    } catch {
        // unreadable now: the next scan decides
    }
}

/** Folder spelling follows a remote rename that changed only the folder's letter case */
async function followFolderSpelling(ctx: SyncContext, oldPath: string, newPath: string): Promise<void> {
    const from = dirname(oldPath);
    const to = dirname(newPath);
    if (from !== to && pathKey(from) === pathKey(to)) await alignFolderSpelling(ctx, newPath);
}

/**
 * One cloud file listed under two names: the index was written by a device that had
 * not seen a rename yet. Pulling both put the file at both names, then dropped one
 * as a stale copy, and a different note that now holds the old name was never
 * pulled. Ask the cloud where the file really is; at the other name, list whatever
 * file the cloud has there instead (or nothing).
 */
async function resolveDuplicateIds(ctx: SyncContext, remoteIndex: LocalFileIndex): Promise<LocalFileIndex> {
    const byId = new Map<string, string[]>();
    for (const [p, e] of Object.entries(remoteIndex)) {
        if (!e.fileId || p === ctx.pluginDataPath) continue;
        byId.set(e.fileId, [...(byId.get(e.fileId) ?? []), p]);
    }
    const dupes = [...byId].filter(([, paths]) => paths.length > 1);
    if (dupes.length === 0) return remoteIndex;
    const out: LocalFileIndex = { ...remoteIndex };
    for (const [id, paths] of dupes) {
        let actual: string | undefined;
        try {
            actual = (await ctx.adapter.getFileMetadataById(id, paths[0]))?.path;
        } catch {
            continue; // unknown: leave the entries as they are
        }
        for (const p of paths) {
            if (p === actual) continue;
            delete out[p];
            const there = await ctx.adapter.getFileMetadata(p).catch(() => null);
            if (there?.id && there.id !== id && !byId.has(there.id)) {
                out[p] = { fileId: there.id, mtime: there.mtime ?? 0, size: there.size ?? 0, hash: there.hash };
            }
            await ctx.log(`[Smart Pull] The remote index lists ${id} under ${p} too, but it is at ${actual ?? "(gone)"}. Using the cloud's file at ${p}.`, "info");
        }
    }
    return out;
}

const skippedRenames = new CtxState<Map<string, string>>(
    "skippedRemoteRenames",
    "Remote renames not followed because the new name was taken here: file id to new path",
);

function skippedRenamesOf(ctx: SyncContext): Map<string, string> {
    let m = skippedRenames.get(ctx);
    if (!m) skippedRenames.set(ctx, (m = new Map<string, string>()));
    return m;
}

/** Follow remote renames skipped earlier once their new name is free here */
async function retrySkippedRenames(ctx: SyncContext): Promise<void> {
    const m = skippedRenames.get(ctx);
    if (!m || m.size === 0) return;
    for (const [id, target] of [...m]) {
        const oldPath = Object.entries(ctx.index).find(([, e]) => e.fileId === id)?.[0];
        if (!oldPath || oldPath === target || ctx.index[oldPath].pendingMove) {
            m.delete(id);
            continue;
        }
        if (ctx.dirtyPaths.has(oldPath) || (await ctx.vault.exists(target)) || !(await ctx.vault.exists(oldPath))) continue;
        // Another note of ours still holds the name until its deletion or rename is pushed
        const occupant = ctx.index[target];
        if (occupant?.fileId && occupant.fileId !== id) continue;
        const meta = await ctx.adapter.getFileMetadataById(id, target).catch(() => undefined);
        if (meta === undefined) continue; // unknown now: try again later
        m.delete(id);
        if (!meta || meta.path !== target) continue; // moved on since: that is a change of its own
        try {
            await renameLocal(ctx, oldPath, target);
            moveIndexEntry(ctx, oldPath, target);
            moveAttemptedUploads(ctx, oldPath, target);
            await ctx.log(`[Changes API] Remote Rename (deferred): ${oldPath} -> ${target}. The name is free now.`, "info");
            // The note may have been edited along with the rename: pull that version too
            const known = ctx.localIndex[target]?.hash;
            if (meta.hash && known?.toLowerCase() !== meta.hash.toLowerCase()) {
                pendingPullsOf(ctx).set(id, { file: { id: meta.id, path: target, hash: meta.hash, size: meta.size, mtime: meta.mtime }, attempts: 0 });
            }
        } catch (e) {
            await ctx.log(`[Changes API] Failed to rename ${oldPath} -> ${target}: ${String(e)}`, "warn");
        }
    }
}
