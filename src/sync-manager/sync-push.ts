import { removeRemote } from "./remote-deletion";
import { noteUploadedForRetention } from "./revision-retention";
import { recordActivity } from "./device-registry";
import { reviewPlan, type PlanDecision, type PlannedChange } from "./sync-plan";
import { cloudHashMatches, contentFingerprint } from "./content-fingerprint";
import type { CloudFile } from "../types/adapter";
import type { SyncContext } from "./context";
import type { LocalFileIndex } from "./types";
import {
    runParallel,
    compress,
    isManagedSeparately,
    shouldNotBeOnRemote,
    shouldIgnore,
    holdsDeviceExcluded,
    isDeviceExcluded,
    hashContent,
} from "./file-utils";
import { loadCommunication, saveIndex, saveLocalIndex, releaseLockAfterPush, findForeignLock, renameLocal, confirmMissingForDeletion, clearDeleteIntent, noteDeleteIntent, takeUnsyncedRename, peekUnsyncedRename } from "./state";
import { pullFileSafely } from "./merge";
import { isMergeableText, recoverOverwrittenVersion } from "./overwrite-recovery";
import { findPathCollision, freeCollisionPath, moveIndexEntry, pathKey } from "./path-collision";
import { TransferPriority } from "./transfer-types";
import { formatSize } from "../utils/format";
import { basename, dirname } from "../utils/path";
import { recheckEventsDuringSync, scanObsidianChanges, scanVaultChanges } from "./sync-scan";
import {
    computeLocalHash,
    getThresholdBytes,
    generateTransferId,
    markPendingTransfer,
    buildRemoteIndexPayload,
    checkIndexOverwrite,
    clearIndexUploadOwed,
    markIndexUploadOwed,
    owesIndexUpload,
    takeHandBack,
    recordAttemptedUpload,
    forgetAttemptedUpload,
    isAttemptedUpload,
    moveAttemptedUploads,
    forgetAttemptedVersion,
    attemptedUploadsSnapshot,
} from "./sync-helpers";
import { storesTransformedContent } from "./content-identity";


/** Walk directory tree of missing files to infer deleted folders */
async function inferDeletedFolders(ctx: SyncContext): Promise<void> {
    if (ctx.dirtyPaths.size === 0) return;

    const checkedFolders = new Set<string>();
    const missingFiles: string[] = [];

    for (const path of ctx.dirtyPaths.keys()) {
        if (ctx.index[path]) {
            const exists = await ctx.vault.exists(path);
            if (!exists) {
                missingFiles.push(path);
            }
        }
    }

    for (const path of missingFiles) {
        let folder = dirname(path);
        while (folder) {
            if (checkedFolders.has(folder)) break;
            if (shouldIgnore(ctx, folder)) break;
            if (holdsDeviceExcluded(ctx, folder, Object.keys(ctx.index))) break;
            if (ctx.deletedFolders.has(folder)) {
                checkedFolders.add(folder);
                break;
            }

            const exists = await ctx.vault.exists(folder);

            if (!exists) {
                ctx.deletedFolders.add(folder);
                await ctx.log(`[Smart Push] Inferred deleted folder: ${folder}`, "debug");
                folder = dirname(folder);
            } else {
                break;
            }
        }
    }
}

interface PlannedFolderDeletion {
    path: string;
    /** Synced files inside the folder (removed with it) */
    contains: string[];
}

/** Folders deleted on this device, deepest first, with the synced files inside each */
function planFolderDeletions(ctx: SyncContext): PlannedFolderDeletion[] {
    const folders = Array.from(ctx.deletedFolders).sort((a, b) => b.length - a.length);
    const indexed = Object.keys(ctx.index);
    return folders.map((path) => ({
        path,
        contains: indexed.filter((p) => p.startsWith(path + "/")),
    }));
}

/** Delete folders from remote (deepest first). Folders the guard held are left for a later sync. */
async function executeFolderDeletions(
    ctx: SyncContext,
    planned: PlannedFolderDeletion[],
    decision: PlanDecision,
): Promise<{ folderDeletedCount: number }> {
    let folderDeletedCount = 0;

    // Only what was planned and reviewed (a folder deleted while this push ran waits for the next one)
    const folders = planned
        .map((f) => f.path)
        .filter((p) => ctx.deletedFolders.has(p) && decision.allows("delete-remote", p));
    if (folders.length === 0) return { folderDeletedCount };

    ctx.startActivity();
    await ctx.log(
        `[Smart Push] Processing ${folders.length} deleted folder(s)...`,
        "debug",
    );

    // planned is sorted by depth (deepest first) to handle nested deletions cleanly
    for (const folderPath of folders) {
        try {
            const meta = await ctx.adapter.getFileMetadata(folderPath);
            if (meta && meta.id) {
                if (meta.kind === "folder") {
                    await removeRemote(
                        ctx,
                        { id: meta.id, path: folderPath, kind: "folder" },
                        "user-folder",
                    );
                    recordActivity(ctx, "delete", folderPath);
                    ctx.logger.markActionTaken();
                    folderDeletedCount++;
                    await ctx.log(`[Smart Push] Deleted remote folder: ${folderPath}`, "info");
                    await ctx.notify("noticeFileTrashed", basename(folderPath));
                }
            } else {
                await ctx.log(
                    `[Smart Push] Folder not found on remote (already deleted?): ${folderPath}`,
                    "warn",
                );
                // Its files may still be in the cloud (found by id, not by folder path):
                // forgetting them here left them there for good while this device no
                // longer had them. Leave them to be deleted one by one (as for a folder
                // whose removal failed); the folder is settled once none is left.
                const children = Object.keys(ctx.index).filter(
                    (p) => p.startsWith(folderPath + "/") && ctx.index[p].fileId,
                );
                let stillInCloud = false;
                for (const p of children) {
                    if (await ctx.adapter.getFileMetadataById(ctx.index[p].fileId)) {
                        stillInCloud = true;
                        break;
                    }
                }
                if (stillInCloud) continue;
            }

            const prefix = folderPath + "/";
            for (const dirtyPath of Array.from(ctx.dirtyPaths.keys())) {
                if (dirtyPath.startsWith(prefix)) {
                    ctx.dirtyPaths.delete(dirtyPath);
                }
            }
            const allPaths = Object.keys(ctx.index);
            for (const path of allPaths) {
                if (path.startsWith(prefix)) {
                    delete ctx.index[path];
                    delete ctx.localIndex[path];
                }
            }
            ctx.deletedFolders.delete(folderPath);
        } catch (e) {
            await ctx.log(`[Smart Push] Failed to delete folder ${folderPath}: ${String(e)}`, "error");
        }
    }

    return { folderDeletedCount };
}

/**
 * The user may rename (or delete) a NEW file while its first upload is in flight.
 * The rename event finds no index entry for the old path yet, so it is treated as
 * a brand-new file, and the finished upload would then register the old path too:
 * both names end up on every device. If the uploaded path vanished locally, adopt
 * the upload under its new name as a pending move (or mark it for remote deletion).
 * Returns true when the upload was re-homed this way.
 */
export async function reconcileVanishedAfterUpload(
    ctx: SyncContext,
    path: string,
    content: ArrayBuffer,
    entry: LocalFileIndex[string],
): Promise<boolean> {
    if (await ctx.vault.exists(path)) {
        // On Windows/macOS a letter-case-only rename ("Todo.md" -> "todo.md") leaves the
        // old spelling "existing": without this the upload stayed under the old name
        // while the note was renamed here.
        const to = peekUnsyncedRename(ctx, path);
        if (!(ctx.caseInsensitiveFs && to && to !== path && pathKey(to) === pathKey(path))) return false;
    }
    // An already-synced file renamed during the upload: the rename handler moved its
    // index entry (same fileId) to the new path, with a pendingMove from `path`. Record
    // that the remote now holds what we uploaded; registering `path` for deletion here
    // made the next push move the file AND delete it by the same fileId (data loss).
    for (const [p, e] of Object.entries(ctx.index)) {
        if (p === path || !entry.fileId || e.fileId !== entry.fileId) continue;
        const updated = { ...e, hash: entry.hash, plainHash: entry.plainHash, size: entry.size };
        ctx.index[p] = updated;
        if (ctx.localIndex[p]) {
            ctx.localIndex[p] = {
                ...ctx.localIndex[p],
                hash: entry.hash,
                plainHash: entry.plainHash,
                size: entry.size,
                lastAction: "push",
            };
        }
        ctx.dirtyPaths.delete(path);
        // The rename moved our upload record with the entry: the upload is settled now,
        // and a stale record later made this version look like an unconfirmed upload
        // (a wrong merge base, so a false conflict)
        forgetAttemptedVersion(ctx, p, contentFingerprint(content));
        await ctx.log(`[Smart Push] ${path} was renamed to ${p} during upload.`, "info");
        return true;
    }
    // Renamed again (or deleted) before that event arrived: the recorded name is gone
    // too. Deleting the upload now and creating the note anew under its final name made
    // two copies once another device edited the upload meanwhile. Keep it as our
    // attempted upload: the next push (or a pull of it) moves it to the final name.
    const pendingTo = peekUnsyncedRename(ctx, path);
    if (pendingTo && !ctx.index[pendingTo] && !(await ctx.vault.exists(pendingTo))) {
        recordAttemptedUpload(ctx, path, contentFingerprint(content));
        ctx.dirtyPaths.delete(path);
        await ctx.log(
            `[Smart Push] ${path} was renamed again during upload. Settling the upload next sync.`,
            "info",
        );
        return true;
    }
    // Renamed (and maybe edited since): the rename handler recorded where it went.
    const renamedTo = takeUnsyncedRename(ctx, path);
    if (renamedTo && !ctx.index[renamedTo] && (await ctx.vault.exists(renamedTo))) {
        const moved = { ...entry, forcePush: true, pendingMove: { oldPath: path } };
        ctx.index[renamedTo] = moved;
        ctx.localIndex[renamedTo] = { ...moved };
        ctx.dirtyPaths.delete(path);
        ctx.dirtyPaths.set(renamedTo, Date.now());
        forgetAttemptedVersion(ctx, renamedTo, contentFingerprint(content));
        await ctx.log(
            `[Smart Push] ${path} was renamed to ${renamedTo} during upload. Will move the remote file.`,
            "info",
        );
        return true;
    }
    const uploadedHash = contentFingerprint(content);
    for (const candidate of ctx.dirtyPaths.keys()) {
        if (candidate === path || ctx.index[candidate]) continue;
        try {
            if (!(await ctx.vault.exists(candidate))) continue;
            const stat = await ctx.vault.stat(candidate);
            if (stat?.type === "folder" || stat?.size !== content.byteLength) continue;
            if (contentFingerprint(await ctx.vault.readBinary(candidate)) !== uploadedHash) continue;
        } catch {
            continue;
        }
        const moved = { ...entry, forcePush: true, pendingMove: { oldPath: path } };
        ctx.index[candidate] = moved;
        ctx.localIndex[candidate] = { ...moved };
        ctx.dirtyPaths.delete(path);
        forgetAttemptedVersion(ctx, candidate, uploadedHash);
        await ctx.log(
            `[Smart Push] ${path} was renamed to ${candidate} during upload. Will move the remote file.`,
            "info",
        );
        return true;
    }
    // Deleted (or renamed + edited) during upload: register it so the next push deletes it remotely.
    ctx.index[path] = entry;
    ctx.localIndex[path] = { ...entry };
    ctx.dirtyPaths.set(path, Date.now());
    // Not marked as a deletion: the vault event of a rename made during the upload may
    // still be on its way. Deleting at once (before the event) and creating the note
    // anew under its new name left two copies once another device had edited it. The
    // usual wait for a late rename event applies; a delete event marks it right away.
    await ctx.log(`[Smart Push] ${path} disappeared during upload. Will remove it remotely.`, "info");
    return true;
}

/** Upload compressed index + raw backup */
async function uploadRemoteIndex(ctx: SyncContext): Promise<void> {
    await saveIndex(ctx);
    try {
        // Merge with entries other devices wrote since our last pull (no last-writer-wins loss)
        const indexContent = await buildRemoteIndexPayload(ctx);
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
            if (await ctx.vault.exists(rawPath)) {
                await ctx.adapter.uploadFile(rawPath, indexContent, Date.now());
                await ctx.log(`[Smart Push] Raw index backup uploaded.`, "debug");
            }
        } catch (rawErr) {
            await ctx.log(`[Smart Push] Failed to upload raw index: ${String(rawErr)}`, "debug");
        }

        clearIndexUploadOwed(ctx);
        await checkIndexOverwrite(ctx, uploadedIndex);
        await saveIndex(ctx);
        await ctx.log(`[Smart Push] Index uploaded. Hash: ${uploadedIndex.hash}`, "info");
    } catch (e) {
        markIndexUploadOwed(ctx);
        await saveIndex(ctx).catch(() => {});
        await ctx.log(`[Smart Push] Failed to upload index (retried next sync): ${String(e)}`, "error");
    }
}

/** Nothing to push, but an earlier index upload failed: upload it now. */
async function settleOwedIndexUpload(ctx: SyncContext): Promise<void> {
    if (!owesIndexUpload(ctx)) return;
    await ctx.log("[Smart Push] Uploading the index left over from an earlier failed upload.", "info");
    await uploadRemoteIndex(ctx);
}


/**
 * An upload of a NEW note whose response was lost, and the note was renamed or deleted
 * here before the upload was confirmed. The cloud copy under the old name is in no
 * index, and the Changes feed may already be past it (the app was restarted, or the
 * feed was read before the upload landed): no device ever pulled or removed it, and it
 * stayed in the cloud as a stray copy. Move it to the note's new name, or remove it.
 */
async function settleOrphanedUploads(ctx: SyncContext): Promise<void> {
    const attempts = attemptedUploadsSnapshot(ctx);
    if (!attempts) return;
    const queued = new Set((ctx.backgroundTransferQueue.getPendingTransfers?.() ?? []).map((t) => t.path));
    for (const path of Object.keys(attempts)) {
        if (ctx.index[path] || ctx.localIndex[path] || queued.has(path)) continue;
        if (await ctx.vault.exists(path)) continue;
        try {
            const meta = await ctx.adapter.getFileMetadata(path);
            if (!meta?.id || meta.kind === "folder") {
                if (!meta) forgetAttemptedUpload(ctx, path); // never reached the cloud
                continue;
            }
            // A synced file renamed here (pending move): the attempt was an edit of it,
            // not an orphan. Removing it deleted the note in the cloud for every device.
            const owner = Object.entries(ctx.index).find(([, e]) => e.fileId === meta.id)?.[0];
            if (owner) {
                moveAttemptedUploads(ctx, path, owner);
                continue;
            }
            let sent = meta.hash;
            let plainHash: string | undefined;
            if (storesTransformedContent(ctx)) {
                const content = await ctx.adapter.downloadFile(meta.id);
                sent = contentFingerprint(content); // recorded as the exact bytes sent
                plainHash = await hashContent(content);
            }
            if (!sent || !isAttemptedUpload(ctx, path, sent)) continue;
            const now = takeUnsyncedRename(ctx, path);
            if (now && !ctx.index[now] && (await ctx.vault.exists(now))) {
                await ctx.adapter.moveFile(meta.id, basename(now), dirname(now) || null);
                const hash = (meta.hash ?? "").toLowerCase();
                const entry = {
                    fileId: meta.id,
                    mtime: meta.mtime ?? Date.now(),
                    size: meta.size,
                    hash,
                    ...(plainHash ? { plainHash } : {}),
                    lastAction: "push" as const,
                    ancestorHash: hash,
                };
                ctx.index[now] = { ...entry };
                ctx.localIndex[now] = { ...entry };
                ctx.dirtyPaths.set(now, ctx.dirtyPaths.get(now) ?? Date.now());
                // Persist both indexes now: killed before the next save, the note
                // looked unsynced after the restart and its next rename left the moved
                // cloud file behind as a duplicate.
                await saveIndex(ctx);
                await ctx.log(`[Smart Push] Moved our earlier upload of ${path} to ${now}.`, "info");
            } else {
                await removeRemote(ctx, { id: meta.id, path, kind: "file" }, "superseded-upload");
                await ctx.log(`[Smart Push] Removed our earlier upload of ${path} (no longer here under that name).`, "info");
            }
            forgetAttemptedUpload(ctx, path);
            await saveLocalIndex(ctx, true);
        } catch (e) {
            await ctx.log(`[Smart Push] Could not settle earlier upload of ${path}: ${String(e)}`, "warn");
        }
    }
}

/**
 * Smart Push - upload only dirty files
 * O(1) when no dirty files, O(dirty count + .obsidian scan) otherwise
 * If scanVault is true, performs O(N) full vault scan before pushing
 */
export async function smartPush(ctx: SyncContext, scanVault: boolean): Promise<boolean> {
    if (scanVault) {
        ctx.progress?.setPhase("scanning");
        await scanVaultChanges(ctx);
    }

    await recheckEventsDuringSync(ctx);
    await settleOrphanedUploads(ctx);

    // Scan .obsidian files for changes (vault events don't fire for these)
    await scanObsidianChanges(ctx);

    if (ctx.forceCleanupNextSync) {
        for (const path of Object.keys(ctx.index)) {
            if (path === ctx.pluginDataPath) continue;
            if (isManagedSeparately(path)) continue;
            if (shouldNotBeOnRemote(ctx, path)) {
                ctx.dirtyPaths.set(path, Date.now());
            }
        }
    }

    await inferDeletedFolders(ctx);

    // Folder deletions are planned here but run only after the whole push was
    // planned and reviewed. Their contents are left out of the per-file loop:
    // the one folder removal removes them (as before, when it ran first).
    const plannedFolders = planFolderDeletions(ctx);
    const underPlannedFolder = (path: string) =>
        plannedFolders.some((f) => path.startsWith(f.path + "/"));
    let folderDeletedCount = 0;
    let moveCount = 0;

    if (ctx.dirtyPaths.size === 0 && plannedFolders.length === 0) {
        await ctx.log("[Smart Push] No dirty files to push. Skipping.", "debug");
        await settleOwedIndexUpload(ctx);
        return false;
    }

    await ctx.log(`[Smart Push] Pushing ${ctx.dirtyPaths.size} dirty files...`, "info");

    const commData = await loadCommunication(ctx);
    const now = Date.now();

    const uploadQueue: Array<{
        path: string;
        mtime: number;
        size: number;
        content: ArrayBuffer;
        dirtyAt: number | undefined;
        /** Result of the by-path lookup done during the hash check (undefined = not looked up) */
        remoteLookup?: CloudFile | null;
        /** md5 of `content`, already computed during the hash check */
        hash: string;
    }> = [];
    const deleteQueue: string[] = [];

    await collapseCollidingNewPaths(ctx);

    const dirtyPathTasks: (() => Promise<void>)[] = [];
    const dirtyPathsSnapshot = Array.from(ctx.dirtyPaths.keys());

    const processDirtyPath = async (path: string): Promise<void> => {
        {
            const mergeLock = findForeignLock(ctx, commData, path, undefined, now);
            if (mergeLock) {
                await ctx.log(
                    `[Smart Push] Skipping: ${path} is being merged by ${mergeLock.holder} (expires in ${Math.round((mergeLock.expiresAt - now) / 1000)}s)`,
                    "debug",
                );
                return;
            }

            // Priority 1: 完全に外部(専用ロジック)で管理するファイル。汎用ループでは一切触らない。
            if (isManagedSeparately(path)) {
                return;
            }

            // Left out on this device: never uploaded or deleted from here
            if (isDeviceExcluded(ctx, path)) {
                ctx.dirtyPaths.delete(path);
                return;
            }

            // A new note whose name differs from a synced one only by case/normalization
            // would be the same file on Windows/macOS: rename it before it reaches the cloud.
            if (!ctx.index[path] && (await ctx.vault.exists(path))) {
                const clash = findPathCollision(ctx, path);
                if (clash && (await ctx.vault.exists(clash))) {
                    const mine = await ctx.vault.readBinary(path);
                    const theirs = await ctx.vault.readBinary(clash);
                    if (contentFingerprint(mine) === contentFingerprint(theirs)) {
                        // Same physical file seen under another spelling (case-insensitive
                        // FS): sync it under its known name.
                        ctx.dirtyPaths.delete(path);
                        ctx.dirtyPaths.set(clash, Date.now());
                        return;
                    }
                }
                if (clash) {
                    const newPath = await freeCollisionPath(ctx, path);
                    await renameLocal(ctx, path, newPath);
                    ctx.dirtyPaths.delete(path);
                    ctx.dirtyPaths.set(newPath, Date.now());
                    await ctx.log(
                        `[Smart Push] ${path} has the same name as ${clash} on Windows/macOS. Renamed it to ${newPath}.`,
                        "warn",
                    );
                    return;
                }
            }

            // Priority 2: リモートに存在してはいけないファイル。
            if (shouldNotBeOnRemote(ctx, path)) {
                if (ctx.localIndex[path]) {
                    deleteQueue.push(path);
                }
                return;
            }

            const exists = await ctx.vault.exists(path);
            if (exists) {
                const stat = await ctx.vault.stat(path);
                if (stat) {
                    if (stat.type === "folder") {
                        const oldPath = ctx.pendingFolderMoves.get(path);
                        if (oldPath) {
                            try {
                                const oldMeta = await ctx.adapter.getFileMetadata(oldPath);
                                if (oldMeta?.id) {
                                    const newName = basename(path);
                                    const newParentPath = dirname(path);

                                    await ctx.adapter.moveFile(oldMeta.id, newName, newParentPath);
                                    ctx.logger.markActionTaken();
                                    recordActivity(ctx, "rename", path, oldPath);
                                    moveCount++;
                                    ctx.startActivity();
                                    await ctx.log(
                                        `[Smart Push] Moved folder: ${oldPath} -> ${path}`,
                                        "info",
                                    );
                                    await ctx.notify(
                                        "noticeFileMoved",
                                        `${basename(oldPath)} → ${newName}`,
                                    );

                                    // Cleanup pending moves for children
                                    const oldPrefix = oldPath + "/";
                                    for (const p of Object.keys(ctx.index)) {
                                        if (p.startsWith(path + "/")) {
                                            const entry = ctx.index[p];
                                            if (entry.pendingMove?.oldPath?.startsWith(oldPrefix)) {
                                                delete entry.pendingMove;
                                                delete entry.forcePush;
                                                if (ctx.localIndex[p]) {
                                                    delete ctx.localIndex[p].pendingMove;
                                                    delete ctx.localIndex[p].forcePush;
                                                }
                                            }
                                        }
                                    }

                                    ctx.pendingFolderMoves.delete(path);
                                    ctx.dirtyPaths.delete(path);
                                    return;
                                }
                            } catch (e) {
                                await ctx.log(
                                    `[Smart Push] Optimal folder move failed for ${path}, falling back: ${String(e)}`,
                                    "warn",
                                );
                            }
                        }

                        try {
                            await ctx.adapter.ensureFoldersExist([path]);
                            ctx.logger.markActionTaken();
                            await ctx.log(`[Smart Push] Synced folder: ${path}`, "info");
                            ctx.dirtyPaths.delete(path);
                            ctx.pendingFolderMoves.delete(path);
                            return;
                        } catch (e) {
                            await ctx.log(
                                `[Smart Push] Failed to sync folder ${path}: ${String(e)}`,
                                "error",
                            );
                            return;
                        }
                    }

                    const indexEntry = ctx.index[path];
                    if (indexEntry?.pendingMove && indexEntry.fileId) {
                        const moveInfo = indexEntry.pendingMove;
                        try {
                            const newName = basename(path);
                            const newParentPath = dirname(path);

                            const moved = await ctx.adapter.moveFile(
                                indexEntry.fileId,
                                newName,
                                newParentPath,
                            );
                            ctx.logger.markActionTaken();

                            if (!ctx.index[path]) {
                                // Renamed again (or deleted) while the move was in flight. The
                                // rename handler already moved the entry on, with pendingMove
                                // pointing at this path - which is exactly where the remote file
                                // is now. Re-creating an entry here would leave a ghost with the
                                // same fileId, which a later pull resurrects as a duplicate note.
                                moveCount++;
                                await ctx.log(
                                    `[Smart Push] Moved ${moveInfo.oldPath} -> ${path}, which was renamed again meanwhile.`,
                                    "debug",
                                );
                                return;
                            }

                            // Another device may have updated the file since we last synced
                            // it. Adopting moved.hash here would make our (older) local copy
                            // look like it is based on that newer version, and the following
                            // upload would silently overwrite the other device's edit. Keep
                            // our known base hash so the push/pull sees the remote change and
                            // merges it.
                            const knownHash = ctx.index[path]?.hash;
                            let adoptedOwnUpload = false;
                            let remoteChangedMeanwhile =
                                !!knownHash &&
                                !!moved.hash &&
                                knownHash.toLowerCase() !== moved.hash.toLowerCase() &&
                                // this device's own record (journaled at once) already has it
                                ctx.localIndex[path]?.hash?.toLowerCase() !== moved.hash.toLowerCase();
                            // ...unless it is our own upload whose index save was lost to an
                            // app kill: our later edits build on it, and merging them from the
                            // older base turned them into a conflict with our own version.
                            if (remoteChangedMeanwhile && !storesTransformedContent(ctx)) {
                                const h = moved.hash!.toLowerCase();
                                const owner = [path, moveInfo.oldPath].find((p) => isAttemptedUpload(ctx, p, h));
                                if (owner) {
                                    forgetAttemptedVersion(ctx, owner, h);
                                    remoteChangedMeanwhile = false;
                                    adoptedOwnUpload = true;
                                }
                            }
                            if (remoteChangedMeanwhile) {
                                await ctx.log(
                                    `[Smart Push] ${path} changed on another device before the move. Keeping base hash so the change is merged.`,
                                    "info",
                                );
                            }
                            const updatedEntry = {
                                ...ctx.index[path],
                                fileId: moved.id,
                                mtime: moved.mtime,
                                size: moved.size,
                                hash: remoteChangedMeanwhile ? knownHash : moved.hash,
                                // Keep "push" when the known hash is our own upload: the merge
                                // then knows the newer remote may have been built on it.
                                lastAction:
                                    remoteChangedMeanwhile && ctx.localIndex[path]?.lastAction === "push"
                                        ? ("push" as const)
                                        : ("pull" as const),
                                ancestorHash: ctx.localIndex[path]?.ancestorHash || moved.hash,
                                forcePush: false,
                                pendingMove: undefined,
                            };
                            // Adopted a newer cloud version as ours (our upload whose response
                            // was lost): the old ancestor and plaintext hash describe the
                            // version before it, and merging from there made our own edit
                            // conflict with the other devices' edits built on it.
                            if (!remoteChangedMeanwhile && knownHash && moved.hash && adoptedOwnUpload) {
                                updatedEntry.ancestorHash = moved.hash;
                                delete (updatedEntry as { plainHash?: string }).plainHash;
                            }
                            ctx.index[path] = updatedEntry;
                            ctx.localIndex[path] = { ...updatedEntry };
                            recordActivity(ctx, "rename", path, moveInfo.oldPath);
                            moveCount++;
                            ctx.startActivity();

                            const oldDir = dirname(moveInfo.oldPath);
                            const newDir = dirname(path);
                            const isMove = oldDir !== newDir;

                            if (isMove) {
                                await ctx.log(
                                    `[Smart Push] Moved: ${moveInfo.oldPath} -> ${path}`,
                                    "debug",
                                );
                                await ctx.notify(
                                    "noticeFileMoved",
                                    `${basename(moveInfo.oldPath)} → ${newName}`,
                                );
                            } else {
                                await ctx.log(
                                    `[Smart Push] Renamed: ${moveInfo.oldPath} -> ${path}`,
                                    "debug",
                                );
                                await ctx.notify(
                                    "noticeFileRenamed",
                                    `${basename(moveInfo.oldPath)} -> ${newName}`,
                                );
                            }
                            // Don't return — fall through to hash check.
                        } catch (e) {
                            // Still in the cloud (or unknown): the move may even have been
                            // applied (response lost). Uploading instead updated the file by
                            // id wherever it was, under a name this device no longer uses,
                            // and the note ended up under two names. Retry the move.
                            let remote: CloudFile | null | undefined;
                            try {
                                remote = await ctx.adapter.getFileMetadataById(indexEntry.fileId, path);
                            } catch {
                                remote = undefined;
                            }
                            if (remote !== null) {
                                ctx.dirtyPaths.set(path, Date.now());
                                await ctx.log(
                                    `[Smart Push] Move failed for ${path}: ${String(e)}. Retrying it next sync.`,
                                    "warn",
                                );
                                return;
                            }
                            await ctx.log(
                                `[Smart Push] Move API failed for ${path}, falling back to re-upload: ${String(e)}`,
                                "warn",
                            );
                            delete indexEntry.pendingMove;
                            if (ctx.localIndex[path]) {
                                delete ctx.localIndex[path].pendingMove;
                            }
                        }
                    }

                    try {
                        const dirtyAt = ctx.dirtyPaths.get(path);

                        const content = await ctx.vault.readBinary(path);
                        const statAfterRead = await ctx.vault.stat(path);
                        const mtimeAfterRead = statAfterRead?.mtime ?? stat.mtime;

                        const currentHash = contentFingerprint(content);
                        const localIndexEntry = ctx.localIndex[path];

                        let alreadyOnRemoteFile: CloudFile | null = null;
                        let remoteLookup: CloudFile | null | undefined = undefined;
                        if (!localIndexEntry) {
                            try {
                                alreadyOnRemoteFile = await ctx.adapter.getFileMetadata(path);
                                remoteLookup = alreadyOnRemoteFile;
                            } catch {
                                // ignore: treated as not on remote
                            }
                        }

                        const { localHash: computedHash, compareHash: baseHash } = await computeLocalHash(
                            ctx, content, localIndexEntry || {}, currentHash,
                        );
                        const contentMatches = baseHash
                            ? computedHash === baseHash.toLowerCase()
                            : false;

                        if (
                            contentMatches &&
                            localIndexEntry?.lastAction !== "merge" &&
                            !localIndexEntry.forcePush
                        ) {
                            ctx.localIndex[path].mtime = mtimeAfterRead;
                            if (ctx.index[path]) {
                                ctx.index[path].mtime = mtimeAfterRead;
                            }
                            if (ctx.dirtyPaths.get(path) === dirtyAt) {
                                ctx.dirtyPaths.delete(path);
                            }
                            await ctx.log(`[Smart Push] Skipped (${storesTransformedContent(ctx) ? "plainHash" : "hash"} match): ${path}`, "debug");
                            return;
                        } else if (
                            !localIndexEntry &&
                            alreadyOnRemoteFile?.hash &&
                            cloudHashMatches(ctx.adapter, alreadyOnRemoteFile.hash, currentHash)
                        ) {
                            const entry = {
                                fileId: alreadyOnRemoteFile.id,
                                mtime: mtimeAfterRead,
                                size: content.byteLength,
                                hash: alreadyOnRemoteFile.hash,
                                lastAction: "pull" as const,
                                ancestorHash: alreadyOnRemoteFile.hash,
                            };
                            ctx.index[path] = entry;
                            ctx.localIndex[path] = { ...entry };
                            if (ctx.dirtyPaths.get(path) === dirtyAt) {
                                ctx.dirtyPaths.delete(path);
                            }
                            // The shared index must list it: a device joining later starts its
                            // change feed after this file, and only finds it in the index.
                            markIndexUploadOwed(ctx);
                            await ctx.log(`[Smart Push] Adopted existing remote file: ${path}`, "info");
                            return;
                        }

                        uploadQueue.push({
                            path,
                            mtime: mtimeAfterRead,
                            size: content.byteLength,
                            content,
                            dirtyAt,
                            remoteLookup,
                            hash: currentHash,
                        });
                    } catch (e) {
                        await ctx.log(
                            `[Smart Push] Failed to read ${path} for hash check: ${String(e)}`,
                            "error",
                        );
                    }
                }
            } else {
                if (ctx.localIndex[path]) {
                    if (
                        path.startsWith(".obsidian/") ||
                        !ctx.localIndex[path].fileId ||
                        confirmMissingForDeletion(ctx, path)
                    ) {
                        deleteQueue.push(path);
                    } else {
                        await ctx.log(
                            `[Smart Push] ${path} is missing but no deletion was reported yet. Waiting one sync (it may have been renamed).`,
                            "debug",
                        );
                    }
                } else if (!ctx.index[path]) {
                    // Created (and maybe renamed) then deleted before it was ever synced:
                    // nothing exists anywhere, so the dirty mark would otherwise stay forever
                    // and every following sync would run a push for it.
                    ctx.dirtyPaths.delete(path);
                    await ctx.log(`[Smart Push] Dropped never-synced deleted path: ${path}`, "debug");
                }
            }
        }
    };
    for (const path of dirtyPathsSnapshot) {
        if (underPlannedFolder(path)) continue;
        dirtyPathTasks.push(() => processDirtyPath(path));
    }
    if (dirtyPathTasks.length > 0) {
        await runParallel(dirtyPathTasks, 20);
    }

    // === Plan -> review -> execute: nothing destructive has run yet ===
    const planned: PlannedChange[] = [
        ...plannedFolders.map((f): PlannedChange => ({
            action: "delete-remote",
            path: f.path,
            kind: "folder",
            contains: f.contains,
        })),
        ...deleteQueue.map((path): PlannedChange => ({ action: "delete-remote", path, kind: "file" })),
        ...uploadQueue
            .filter((f) => ctx.index[f.path]?.fileId)
            .map((f): PlannedChange => ({ action: "overwrite-remote", path: f.path, kind: "file" })),
    ];
    const decision = await reviewPlan(ctx, { step: "push", changes: planned });

    ({ folderDeletedCount } = await executeFolderDeletions(ctx, plannedFolders, decision));

    // A folder whose removal failed: handle its contents one by one, as when
    // folder deletions ran before the per-file loop (the folder is retried next sync).
    const failedFolders = plannedFolders.filter(
        (f) => decision.allows("delete-remote", f.path) && ctx.deletedFolders.has(f.path),
    );
    if (failedFolders.length > 0) {
        const inside = Array.from(ctx.dirtyPaths.keys()).filter((p) =>
            failedFolders.some((f) => p.startsWith(f.path + "/")),
        );
        await runParallel(
            inside.map((p) => () => processDirtyPath(p)),
            20,
        );
    }

    // Held changes stay marked as changed and are planned again next sync
    for (let i = deleteQueue.length - 1; i >= 0; i--) {
        if (!decision.allows("delete-remote", deleteQueue[i])) deleteQueue.splice(i, 1);
    }
    for (let i = uploadQueue.length - 1; i >= 0; i--) {
        if (!decision.allows("overwrite-remote", uploadQueue[i].path)) uploadQueue.splice(i, 1);
    }

    const thresholdBytes = getThresholdBytes(ctx);
    const inlineUploadQueue: typeof uploadQueue = [];
    let deferredCount = 0;

    if (thresholdBytes > 0) {
        for (const file of uploadQueue) {
            const isMetadata = file.path === ctx.pluginDataPath;
            const isMergeResult = ctx.localIndex[file.path]?.lastAction === "merge";
            const handedBack = takeHandBack(ctx, file.path);
            if (!isMetadata && !isMergeResult && !handedBack && file.size > thresholdBytes) {
                const snapshotHash = file.hash;
                ctx.backgroundTransferQueue.enqueue({
                    id: generateTransferId("push"),
                    direction: "push",
                    path: file.path,
                    size: file.size,
                    priority: TransferPriority.NORMAL,
                    status: "pending",
                    retryCount: 0,
                    createdAt: Date.now(),
                    content: file.content,
                    mtime: file.mtime,
                    snapshotHash,
                });
                markPendingTransfer(ctx, file.path, "push", snapshotHash);
                deferredCount++;
                await ctx.log(
                    `[Smart Push] Deferred to background (${formatSize(file.size)}): ${file.path}`,
                    "info",
                );
            } else {
                inlineUploadQueue.push(file);
            }
        }
    } else {
        inlineUploadQueue.push(...uploadQueue);
    }

    const totalOps = inlineUploadQueue.length + deleteQueue.length;
    if (totalOps === 0 && folderDeletedCount === 0 && moveCount === 0 && deferredCount === 0) {
        await ctx.log("[Smart Push] No changes after filtering.", "debug");
        await settleOwedIndexUpload(ctx);
        return false;
    }

    if (totalOps === 0 && deferredCount > 0 && folderDeletedCount === 0 && moveCount === 0) {
        await ctx.log(
            `[Smart Push] All ${deferredCount} file(s) deferred to background transfer.`,
            "info",
        );
        return true;
    }

    ctx.progress?.plan(
        "push",
        inlineUploadQueue.map((f) => ({ path: f.path, size: f.size })),
    );
    ctx.startActivity();

    try {
        const foldersToCreate = new Set<string>();
        for (const file of uploadQueue) {
            const parts = file.path.split("/");
            for (let i = 1; i < parts.length; i++) {
                foldersToCreate.add(parts.slice(0, i).join("/"));
            }
        }

        if (foldersToCreate.size > 0) {
            const sortedFolders = Array.from(foldersToCreate).sort((a, b) => a.length - b.length);
            await ctx.adapter.ensureFoldersExist(sortedFolders);
        }

        const tasks: (() => Promise<void>)[] = [];
        let completed = 0;

        // Write-ahead record of what we are about to upload. If the app is killed
        // after an upload reached the server but before the index was saved, the
        // next start recognises the cloud version as our own (not another device's
        // edit) instead of turning the local note into a conflict copy.
        const toRecord = inlineUploadQueue.filter((f) => f.hash && f.path !== ctx.pluginDataPath);
        if (toRecord.length > 0) {
            for (const f of toRecord) recordAttemptedUpload(ctx, f.path, f.hash);
            // The shared index that will list these files is owed from now on: killed
            // after the uploads but before the index upload, the restarted app had
            // nothing to push and the other devices never learned of the files.
            markIndexUploadOwed(ctx);
            await saveIndex(ctx);
        }

        for (const file of inlineUploadQueue) {
            tasks.push(async () => {
                const taskStartTime = Date.now();
                let uploadStarted = false;
                ctx.backgroundTransferQueue.markInlineStart(file.path, "push", file.size);
                try {
                    const currentStat = await ctx.vault.stat(file.path);
                    if (!currentStat) {
                        // Renamed or deleted since it was queued. The rename/delete handler
                        // already moved the index entry and the dirty mark to the new path;
                        // uploading here would hit a "conflict" (no base any more) and pull
                        // the file back under its old name, duplicating the note.
                        await ctx.log(
                            `[Smart Push] Skipped (renamed or deleted during sync): ${file.path}`,
                            "debug",
                        );
                        return;
                    }
                    if (currentStat.mtime !== file.mtime) {
                        ctx.dirtyPaths.set(file.path, Date.now());
                        await ctx.log(
                            `[Smart Push] Skipped (modified during sync): ${file.path}`,
                            "debug",
                        );
                        return;
                    }

                    let remoteMeta: CloudFile | null = null;
                    try {
                        const params = {
                            fileId: ctx.index[file.path]?.fileId ?? ctx.localIndex[file.path]?.fileId,
                            path: file.path,
                        };
                        // A failed lookup must NOT be treated as "not on remote": uploading
                        // without the conflict check below would silently overwrite another
                        // device's newer version (by fileId), or create a second file with
                        // the same name (by path). Leave the file dirty and retry next sync.
                        if (!params.fileId && file.remoteLookup) {
                            // Already looked up by path moments ago during the hash check.
                            // A "not found" is NOT reused: the queue may have waited a while,
                            // and if another device created the same name meanwhile, the
                            // upload (which updates an existing file by path) would overwrite
                            // that device's new note without any conflict check.
                            remoteMeta = file.remoteLookup;
                        } else if (params.fileId) {
                            remoteMeta = await ctx.adapter.getFileMetadataById(
                                params.fileId,
                                file.path,
                            );
                        } else {
                            remoteMeta = await ctx.adapter.getFileMetadata(file.path);
                        }
                        // The cloud file at this name belongs to another note here (our own
                        // move of it away from this name ran in this push, after the lookup).
                        // Taken as a remote edit of this new note, the conflict path pulled
                        // that note in under this name: a third copy once it was renamed.
                        const ownedElsewhere = (id: string | undefined) =>
                            !!id &&
                            Object.entries(ctx.index).some(([p, e]) => p !== file.path && e.fileId === id);
                        if (!params.fileId && remoteMeta && ownedElsewhere(remoteMeta.id)) {
                            if (remoteMeta === file.remoteLookup) {
                                remoteMeta = await ctx.adapter.getFileMetadata(file.path);
                            }
                            if (remoteMeta && ownedElsewhere(remoteMeta.id)) {
                                // Still there: our move has not reached the cloud. Uploading by
                                // name would overwrite that note; push this one next sync.
                                ctx.dirtyPaths.set(file.path, Date.now());
                                await ctx.log(
                                    `[Smart Push] ${file.path}: the cloud file of that name is another note here, moving away. Pushing it next sync.`,
                                    "info",
                                );
                                return;
                            }
                        }

                        if (remoteMeta) {
                            const lastKnownHash = ctx.localIndex[file.path]?.hash;
                            const remoteHash = remoteMeta.hash;

                            if (
                                remoteHash &&
                                (!lastKnownHash ||
                                    lastKnownHash.toLowerCase() !== remoteHash.toLowerCase())
                            ) {
                                const mergedOnto = ctx.localIndex[file.path]?.ancestorHash;
                                if (
                                    ctx.localIndex[file.path]?.lastAction === "merge" &&
                                    !!mergedOnto &&
                                    mergedOnto.toLowerCase() === remoteHash.toLowerCase()
                                ) {
                                    // The merge result was built on exactly this remote version.
                                    // If the remote moved on since (another device pushed after
                                    // our merge released its lock), uploading would drop that
                                    // device's edit: take the conflict path below instead, which
                                    // merges again on top of the newer remote.
                                    await ctx.log(
                                        `[Smart Push] Allowing push of merged file (hash mismatch expected): ${file.path}`,
                                        "debug",
                                    );
                                } else if (
                                    !storesTransformedContent(ctx) &&
                                    isAttemptedUpload(ctx, file.path, remoteHash)
                                ) {
                                    // The remote version is our own earlier upload whose result
                                    // was never recorded (response lost, or the app was killed
                                    // right after it). Not another device's edit: no conflict.
                                    await ctx.log(
                                        `[Smart Push] Remote version of ${file.path} is our own unrecorded upload. Updating it.`,
                                        "info",
                                    );
                                } else {
                                    await ctx.log(
                                        `[Smart Push] CONFLICT DETECTED: Remote changed for ${file.path}`,
                                        "warn",
                                    );
                                    await ctx.log(
                                        `[Smart Push] Local Base: ${lastKnownHash?.substring(0, 8)}, Remote: ${remoteHash.substring(0, 8)}`,
                                        "warn",
                                    );

                                    await ctx.log(
                                        `[Smart Push] [Deadlock Breaking] Attempting immediate pull/merge for ${file.path}...`,
                                        "debug",
                                    );
                                    if (!(await ctx.vault.exists(file.path))) {
                                        // Renamed/deleted while we were checking: pulling now
                                        // would resurrect the old path next to the new one.
                                        return;
                                    }
                                    if (
                                        remoteMeta.path &&
                                        remoteMeta.path !== file.path &&
                                        !ctx.index[file.path]?.pendingMove &&
                                        !ctx.index[remoteMeta.path] &&
                                        !(await ctx.vault.exists(remoteMeta.path))
                                    ) {
                                        // Another device also renamed the note. Pulling now would
                                        // write the new name next to ours and strand our edit
                                        // under the old one. Follow the rename; the next cycle
                                        // merges the content at the new path.
                                        await renameLocal(ctx, file.path, remoteMeta.path);
                                        moveIndexEntry(ctx, file.path, remoteMeta.path);
                                        ctx.dirtyPaths.set(remoteMeta.path, Date.now());
                                        await ctx.log(
                                            `[Smart Push] ${file.path} was renamed to ${remoteMeta.path} on another device. Following the rename before merging.`,
                                            "info",
                                        );
                                        return;
                                    }
                                    const resolved = await pullFileSafely(ctx, remoteMeta, "Push Conflict");

                                    // Upload only a merge result built on THIS remote version.
                                    // lastAction may already have been "merge" before the pull
                                    // (an older merge); if the pull failed or produced something
                                    // else, uploading here would overwrite the remote blindly.
                                    const mergedOntoNow = ctx.localIndex[file.path]?.ancestorHash;
                                    if (
                                        resolved &&
                                        ctx.localIndex[file.path]?.lastAction === "merge" &&
                                        !!mergedOntoNow &&
                                        mergedOntoNow.toLowerCase() === remoteHash.toLowerCase()
                                    ) {
                                        try {
                                            const mergedContent =
                                                await ctx.vault.readBinary(file.path);
                                            const mergedStat = await ctx.vault.stat(
                                                file.path,
                                            );
                                            const mergedFileId =
                                                ctx.index[file.path]?.fileId || remoteMeta.id;

                                            // A lost response may still have been applied: remember
                                            // what we sent, so the version is recognised as ours later
                                            // (and checked for overwriting another device's edit).
                                            const mergedSent = contentFingerprint(mergedContent);
                                            recordAttemptedUpload(ctx, file.path, mergedSent);
                                            await saveLocalIndex(ctx, true); // survives an app kill
                                            const mergedUploaded = await ctx.adapter.uploadFile(
                                                file.path,
                                                mergedContent,
                                                mergedStat?.mtime || Date.now(),
                                                mergedFileId,
                                            );
                                            forgetAttemptedVersion(ctx, file.path, mergedSent);

                                            const mergedPlainHash = await hashContent(mergedContent);

                                            const previousAncestorHash =
                                                ctx.localIndex[file.path]?.ancestorHash;
                                            const mergedEntry = {
                                                fileId: mergedUploaded.id,
                                                mtime: mergedStat?.mtime || Date.now(),
                                                size: mergedUploaded.size,
                                                hash: mergedUploaded.hash,
                                                plainHash: mergedPlainHash,
                                                lastAction: "push" as const,
                                                ancestorHash:
                                                    previousAncestorHash || mergedUploaded.hash,
                                            };
                                            // Renamed by the user while the merged version uploaded?
                                            // The entry moved with the file: update it there, or the
                                            // moved note keeps the old base and the next push sees
                                            // our own upload as another device's edit.
                                            const movedTo = ctx.index[file.path]
                                                ? undefined
                                                : Object.keys(ctx.index).find(
                                                      (p) =>
                                                          ctx.index[p].pendingMove?.oldPath === file.path &&
                                                          ctx.index[p].fileId === mergedUploaded.id,
                                                  );
                                            if (movedTo) {
                                                ctx.index[movedTo] = { ...ctx.index[movedTo], ...mergedEntry };
                                                ctx.localIndex[movedTo] = {
                                                    ...(ctx.localIndex[movedTo] ?? ctx.index[movedTo]),
                                                    ...mergedEntry,
                                                };
                                            } else {
                                                ctx.index[file.path] = mergedEntry;
                                                ctx.localIndex[file.path] = { ...mergedEntry };
                                            }
                                            // Typed into the note while the merged version uploaded?
                                            // (Vault events are suppressed meanwhile.) Keep it dirty
                                            // so that edit is pushed next, instead of dropping it.
                                            const latest = await ctx.vault
                                                .readBinary(file.path)
                                                .catch(() => null);
                                            if (latest && contentFingerprint(latest) !== contentFingerprint(mergedContent)) {
                                                ctx.dirtyPaths.set(file.path, Date.now());
                                            } else {
                                                ctx.dirtyPaths.delete(file.path);
                                            }
                                            ctx.logger.markActionTaken();
                                            completed++;

                                            await ctx.log(
                                                `[Smart Push] [Deadlock Breaking] Merged file uploaded: ${file.path}`,
                                                "notice",
                                            );
                                            await ctx.notify(
                                                "noticeFilePushed",
                                                basename(file.path),
                                            );
                                            if (mergedUploaded.hash && isMergeableText(file.path)) {
                                                await recoverOverwrittenVersion(
                                                    ctx,
                                                    file.path,
                                                    mergedUploaded.id,
                                                    mergedUploaded.hash,
                                                    [previousAncestorHash, remoteMeta.hash],
                                                );
                                            }
                                        } catch (uploadErr) {
                                            await ctx.log(
                                                `[Smart Push] [Deadlock Breaking] Failed to upload merged file: ${file.path} - ${String(uploadErr)}`,
                                                "error",
                                            );
                                        }
                                    }
                                    return;
                                }
                            }
                        }
                    } catch (e) {
                        await ctx.log(
                            `[Smart Push] Pre-upload check failed for ${file.path}, will retry next sync: ${String(e)}`,
                            "warn",
                        );
                        return;
                    }

                    const targetFileId = remoteMeta?.id || ctx.index[file.path]?.fileId;

                    // Read before the upload: a rename during it moves the entry away
                    const previousAncestorHash = ctx.localIndex[file.path]?.ancestorHash;
                    const previousHash = ctx.localIndex[file.path]?.hash;
                    uploadStarted = true;
                    const uploaded = await ctx.adapter.uploadFile(
                        file.path,
                        file.content,
                        file.mtime,
                        targetFileId,
                        // Checked just now that nothing is at this path: never let the
                        // upload turn into an update of a file another device created since.
                        targetFileId ? undefined : { createOnly: true },
                    );
                    forgetAttemptedUpload(ctx, file.path);

                    const plainHash = await hashContent(file.content);

                    const entry = {
                        fileId: uploaded.id,
                        mtime: file.mtime,
                        size: uploaded.size,
                        hash: uploaded.hash,
                        plainHash: plainHash,
                        lastAction: "push" as const,
                        ancestorHash: previousAncestorHash || uploaded.hash,
                    };
                    if (await reconcileVanishedAfterUpload(ctx, file.path, file.content, entry)) {
                        // Handled as a rename/delete that happened while uploading. Saved
                        // now: killed before the next save, the restart took the upload
                        // for a deleted note and removed it while the note lived on
                        // under its new name (a second copy once another device edited it).
                        await saveIndex(ctx);
                        // Our upload may still have replaced another device's version made
                        // at the same moment: check it under the note's new name. Skipped,
                        // that device merged onto our upload and its edit was gone.
                        const renamedTo = Object.keys(ctx.index).find(
                            (p) => p !== file.path && ctx.index[p].fileId === uploaded.id,
                        );
                        if (renamedTo && targetFileId && uploaded.hash && isMergeableText(renamedTo)) {
                            await recoverOverwrittenVersion(ctx, renamedTo, uploaded.id, uploaded.hash, [
                                previousAncestorHash,
                                previousHash,
                            ]);
                        }
                    } else {
                        ctx.index[file.path] = entry;
                        ctx.localIndex[file.path] = { ...entry };
                        // Journal it now: the attempt record is gone, and killed before the
                        // index save the restarted app took this upload for another device's
                        // edit (our later edits then conflicted with our own version).
                        await saveLocalIndex(ctx);
                        forgetAttemptedUpload(ctx, file.path);
                        noteUploadedForRetention(ctx, file.path, uploaded.id);
                        recordActivity(ctx, targetFileId ? "edit" : "create", file.path);

                        if (ctx.dirtyPaths.get(file.path) === file.dirtyAt) {
                            ctx.dirtyPaths.delete(file.path);
                        }
                        if (targetFileId && uploaded.hash && isMergeableText(file.path)) {
                            await recoverOverwrittenVersion(ctx, file.path, uploaded.id, uploaded.hash, [
                                previousAncestorHash,
                                previousHash,
                            ]);
                        }
                    }

                    ctx.logger.markActionTaken();
                    completed++;
                    await ctx.log(
                        `[Smart Push] [${completed}/${totalOps}] Pushed: ${file.path}`,
                        "notice",
                    );
                    await ctx.notify("noticeFilePushed", basename(file.path));

                    ctx.backgroundTransferQueue.recordInlineTransfer({
                        id: `inline-push-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                        direction: "push",
                        path: file.path,
                        size: file.size,
                        status: "completed",
                        startedAt: taskStartTime,
                        completedAt: Date.now(),
                        transferMode: "inline",
                    });
                } catch (e) {
                    await ctx.log(`[Smart Push] Upload failed: ${file.path} - ${String(e)}`, "error");
                    // A lost response may still have been applied by the server
                    recordAttemptedUpload(ctx, file.path, file.hash);
                } finally {
                    // Never sent: drop the write-ahead record (it was not attempted)
                    if (!uploadStarted) forgetAttemptedVersion(ctx, file.path, file.hash);
                    ctx.backgroundTransferQueue.markInlineEnd(file.path);
                    await releaseLockAfterPush(ctx, file.path);
                }
            });
        }

        const foldersToWipe = new Set<string>();
        const filesToWipeSimpler: string[] = [];

        for (const path of deleteQueue) {
            const parts = path.split("/");
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
                filesToWipeSimpler.push(path);
            }
        }

        for (const folderPath of foldersToWipe) {
            tasks.push(async () => {
                try {
                    const meta = await ctx.adapter.getFileMetadata(folderPath);
                    if (meta && meta.id) {
                        await removeRemote(
                            ctx,
                            { id: meta.id, path: folderPath, kind: "folder" },
                            "excluded-cleanup",
                        );
                        await ctx.log(
                            `[Smart Push] [Folder Wipe] Deleted ignored folder: ${folderPath}`,
                            "debug",
                        );

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
                        ctx.logger.markActionTaken();
                        completed++;
                    }
                } catch (e) {
                    await ctx.log(
                        `[Smart Push] [Folder Wipe] Failed to wipe folder ${folderPath}: ${String(e)}`,
                        "error",
                    );
                }
            });
        }

        for (const path of filesToWipeSimpler) {
            tasks.push(async () => {
                try {
                    const entry = ctx.index[path];
                    const sharedBy = entry?.fileId
                        ? Object.keys(ctx.index).find(
                              (p) => p !== path && ctx.index[p]?.fileId === entry.fileId,
                          )
                        : undefined;
                    if (entry && sharedBy) {
                        // Safety net: the remote file is still in use under another local
                        // path (rename/move). Deleting it by id would delete that note too.
                        delete ctx.index[path];
                        delete ctx.localIndex[path];
                        ctx.dirtyPaths.delete(path);
                        await ctx.log(
                            `[Smart Push] Not deleting ${path} remotely: its file is now ${sharedBy}.`,
                            "warn",
                        );
                    } else if (entry) {
                        // Deleting is by file id, and the id may now hold something else:
                        // another device may have edited it, or moved another note onto
                        // it. Check first, and let the newer edit win over our delete.
                        const remote = await ctx.adapter.getFileMetadataById(entry.fileId, path);
                        if (
                            remote &&
                            entry.hash &&
                            remote.hash &&
                            remote.hash.toLowerCase() !== entry.hash.toLowerCase()
                        ) {
                            delete ctx.index[path];
                            delete ctx.localIndex[path];
                            ctx.dirtyPaths.delete(path);
                            await ctx.log(
                                `[Smart Push] Not deleting ${path} remotely: it was changed on another device after our last sync. Restoring ${remote.path}.`,
                                "warn",
                            );
                            await pullFileSafely(ctx, remote, "Smart Push");
                            return;
                        }
                        if (remote) {
                            await removeRemote(
                                ctx,
                                { id: entry.fileId, path, kind: "file" },
                                "user-file",
                            );
                            recordActivity(ctx, "delete", path);
                        }
                        delete ctx.index[path];
                        delete ctx.localIndex[path];
                        // A new note made under the same name while the delete was on
                        // its way is marked dirty: keep that mark, or the new note was
                        // never uploaded (and a pull later wrote over it).
                        if (!(await ctx.vault.exists(path))) ctx.dirtyPaths.delete(path);
                        clearDeleteIntent(ctx, path);

                        ctx.logger.markActionTaken();
                        completed++;
                        await ctx.log(
                            `[Smart Push] [${completed}/${totalOps}] Deleted remote: ${path}`,
                            "notice",
                        );
                        await ctx.notify("noticeFileTrashed", basename(path));
                    } else {
                        delete ctx.localIndex[path];
                        ctx.dirtyPaths.delete(path);
                        await ctx.log(
                            `[Smart Push] Cleaned up zombie entry (local only): ${path}`,
                            "debug",
                        );
                    }
                } catch (e) {
                    // Still the user's deletion: the retry must not wait for a rename
                    // event again (meanwhile the file counted as vanished, and pulls of
                    // it were held back).
                    if (ctx.index[path]) noteDeleteIntent(ctx, path);
                    await ctx.log(`[Smart Push] Delete failed: ${path} - ${String(e)}`, "error");
                }
            });
        }

        await runParallel(tasks, ctx.settings.concurrency);

        if (ctx.forceCleanupNextSync) {
            ctx.forceCleanupNextSync = false;
            await ctx.log("[Smart Push] Full cleanup scan completed and flag reset.", "debug");
        }

        await uploadRemoteIndex(ctx);

        if (completed > 0) {
            await ctx.notify("noticePushCompleted", completed.toString());
        }
        if (deferredCount > 0) {
            await ctx.log(
                `[Smart Push] ${deferredCount} large file(s) queued for background transfer.`,
                "info",
            );
        }
        return true;
    } finally {
        // nothing to clean up
    }
}

/**
 * Two NEW dirty paths that differ only in case / Unicode form. On macOS the same
 * file is often reported under both spellings (created as NFC, listed as NFD), and
 * uploading each made two cloud files out of one note; on Linux they are two notes
 * that would overwrite each other on Windows/macOS. Same content: keep one spelling.
 * Different content: rename the later one before it reaches the cloud.
 */
async function collapseCollidingNewPaths(ctx: SyncContext): Promise<void> {
    const firstByKey = new Map<string, string>();
    for (const path of Array.from(ctx.dirtyPaths.keys())) {
        if (ctx.index[path] || isManagedSeparately(path)) continue;
        const key = pathKey(path);
        const first = firstByKey.get(key);
        if (first === undefined) {
            firstByKey.set(key, path);
            continue;
        }
        try {
            if (!(await ctx.vault.exists(path))) continue;
            if (!(await ctx.vault.exists(first))) {
                firstByKey.set(key, path);
                continue;
            }
            const [a, b] = [await ctx.vault.readBinary(first), await ctx.vault.readBinary(path)];
            if (contentFingerprint(a) === contentFingerprint(b)) {
                // Keep the spelling the disk lists: the other one only reaches the
                // same file because the disk ignores case / Unicode form.
                // (The folder part may be spelled differently again: compare the file name.)
                const onDisk = ctx.vault.getFiles().find((f) => pathKey(f.path) === key)?.path;
                const listed = (p: string) =>
                    onDisk !== undefined && (p === onDisk || basename(p) === basename(onDisk));
                const [keep, drop] = listed(path) && !listed(first) ? [path, first] : [first, path];
                ctx.dirtyPaths.delete(drop);
                firstByKey.set(key, keep);
                await ctx.log(`[Smart Push] ${drop} is the same note as ${keep}. Syncing it once.`, "debug");
                continue;
            }
            const newPath = await freeCollisionPath(ctx, path);
            await renameLocal(ctx, path, newPath);
            ctx.dirtyPaths.delete(path);
            ctx.dirtyPaths.set(newPath, Date.now());
            await ctx.log(
                `[Smart Push] ${path} has the same name as ${first} on Windows/macOS. Renamed it to ${newPath}.`,
                "warn",
            );
        } catch (e) {
            await ctx.log(`[Smart Push] Could not check ${path} for a name collision: ${String(e)}`, "warn");
        }
    }
}
