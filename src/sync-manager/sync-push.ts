import { md5 } from "../utils/md5";
import type { CloudFile } from "../types/adapter";
import type { SyncContext } from "./context";
import {
    runParallel,
    compress,
    isManagedSeparately,
    shouldNotBeOnRemote,
    shouldIgnore,
    hashContent,
} from "./file-utils";
import { loadCommunication, saveIndex } from "./state";
import { pullFileSafely } from "./merge";
import { TransferPriority } from "./transfer-types";
import { formatSize } from "../utils/format";
import { basename, dirname } from "../utils/path";
import { scanObsidianChanges, scanVaultChanges } from "./sync-scan";
import {
    computeLocalHash,
    getThresholdBytes,
    generateTransferId,
    markPendingTransfer,
} from "./sync-helpers";


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

/** Delete folders from remote (deepest first) */
async function executeFolderDeletions(ctx: SyncContext): Promise<{ folderDeletedCount: number; moveCount: number }> {
    let folderDeletedCount = 0;
    const moveCount = 0;

    if (ctx.deletedFolders.size === 0) return { folderDeletedCount, moveCount };

    ctx.startActivity();
    await ctx.log(
        `[Smart Push] Processing ${ctx.deletedFolders.size} deleted folder(s)...`,
        "debug",
    );

    // Sort by depth (deepest first) to handle nested deletions cleanly
    const folders = Array.from(ctx.deletedFolders).sort((a, b) => b.length - a.length);

    for (const folderPath of folders) {
        try {
            const meta = await ctx.adapter.getFileMetadata(folderPath);
            if (meta && meta.id) {
                if (meta.kind === "folder") {
                    await ctx.adapter.deleteFile(meta.id);
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
            await ctx.log(`[Smart Push] Failed to delete folder ${folderPath}: ${e}`, "error");
        }
    }

    return { folderDeletedCount, moveCount };
}

/** Upload compressed index + raw backup */
async function uploadRemoteIndex(ctx: SyncContext): Promise<void> {
    await saveIndex(ctx);
    try {
        const indexContent = await ctx.vault.readBinary(ctx.pluginDataPath);
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
                const rawContent = await ctx.vault.readBinary(rawPath);
                await ctx.adapter.uploadFile(rawPath, rawContent, Date.now());
                await ctx.log(`[Smart Push] Raw index backup uploaded.`, "debug");
            }
        } catch (rawErr) {
            await ctx.log(`[Smart Push] Failed to upload raw index: ${rawErr}`, "debug");
        }

        await saveIndex(ctx);
        await ctx.log(`[Smart Push] Index uploaded. Hash: ${uploadedIndex.hash}`, "info");
    } catch (e) {
        await ctx.log(`[Smart Push] Failed to upload index: ${e}`, "error");
    }
}


/**
 * Smart Push - upload only dirty files
 * O(1) when no dirty files, O(dirty count + .obsidian scan) otherwise
 * If scanVault is true, performs O(N) full vault scan before pushing
 */
export async function smartPush(ctx: SyncContext, scanVault: boolean): Promise<boolean> {
    if (scanVault) {
        await scanVaultChanges(ctx);
    }

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

    let { folderDeletedCount, moveCount } = await executeFolderDeletions(ctx);

    if (ctx.dirtyPaths.size === 0 && folderDeletedCount === 0) {
        await ctx.log("[Smart Push] No dirty files to push. Skipping.", "debug");
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
    }> = [];
    const deleteQueue: string[] = [];

    const dirtyPathTasks: (() => Promise<void>)[] = [];
    const dirtyPathsSnapshot = Array.from(ctx.dirtyPaths.keys());

    for (const path of dirtyPathsSnapshot) {
        dirtyPathTasks.push(async () => {
            const mergeLock = commData.mergeLocks[path];
            if (mergeLock && mergeLock.holder !== ctx.deviceId && mergeLock.expiresAt > now) {
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
                                    `[Smart Push] Optimal folder move failed for ${path}, falling back: ${e}`,
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
                                `[Smart Push] Failed to sync folder ${path}: ${e}`,
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

                            const updatedEntry = {
                                ...ctx.index[path],
                                fileId: moved.id,
                                mtime: moved.mtime,
                                size: moved.size,
                                hash: moved.hash,
                                lastAction: "pull" as const,
                                ancestorHash: ctx.localIndex[path]?.ancestorHash || moved.hash,
                                forcePush: false,
                                pendingMove: undefined,
                            };
                            ctx.index[path] = updatedEntry;
                            ctx.localIndex[path] = { ...updatedEntry };
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
                            await ctx.log(
                                `[Smart Push] Move API failed for ${path}, falling back to re-upload: ${e}`,
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

                        const currentHash = md5(content);
                        const localIndexEntry = ctx.localIndex[path];

                        let alreadyOnRemoteFile: CloudFile | null = null;
                        if (!localIndexEntry) {
                            try {
                                alreadyOnRemoteFile = await ctx.adapter.getFileMetadata(path);
                            } catch (e) {
                            }
                        }

                        const { localHash: computedHash, compareHash: baseHash } = await computeLocalHash(
                            ctx, content, localIndexEntry || {},
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
                            await ctx.log(`[Smart Push] Skipped (${ctx.e2eeEnabled ? "plainHash" : "hash"} match): ${path}`, "debug");
                            return;
                        } else if (
                            !localIndexEntry &&
                            alreadyOnRemoteFile?.hash &&
                            alreadyOnRemoteFile.hash.toLowerCase() === currentHash
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
                            await ctx.log(`[Smart Push] Adopted existing remote file: ${path}`, "info");
                            return;
                        }

                        uploadQueue.push({
                            path,
                            mtime: mtimeAfterRead,
                            size: content.byteLength,
                            content,
                            dirtyAt,
                        });
                    } catch (e) {
                        await ctx.log(
                            `[Smart Push] Failed to read ${path} for hash check: ${e}`,
                            "error",
                        );
                    }
                }
            } else {
                if (ctx.localIndex[path]) {
                    deleteQueue.push(path);
                }
            }
        });
    }
    if (dirtyPathTasks.length > 0) {
        await runParallel(dirtyPathTasks, 20);
    }

    const thresholdBytes = getThresholdBytes(ctx);
    const inlineUploadQueue: typeof uploadQueue = [];
    let deferredCount = 0;

    if (thresholdBytes > 0) {
        for (const file of uploadQueue) {
            const isMetadata = file.path === ctx.pluginDataPath;
            const isMergeResult = ctx.localIndex[file.path]?.lastAction === "merge";
            if (!isMetadata && !isMergeResult && file.size > thresholdBytes) {
                const snapshotHash = md5(file.content);
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
        return false;
    }

    if (totalOps === 0 && deferredCount > 0 && folderDeletedCount === 0 && moveCount === 0) {
        await ctx.log(
            `[Smart Push] All ${deferredCount} file(s) deferred to background transfer.`,
            "info",
        );
        return true;
    }

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

        for (const file of inlineUploadQueue) {
            tasks.push(async () => {
                const taskStartTime = Date.now();
                ctx.backgroundTransferQueue.markInlineStart(file.path, "push", file.size);
                try {
                    const currentStat = await ctx.vault.stat(file.path);
                    if (currentStat && currentStat.mtime !== file.mtime) {
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
                            fileId: ctx.index[file.path]?.fileId,
                            path: file.path,
                        };
                        if (params.fileId) {
                            try {
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

                            if (
                                remoteHash &&
                                (!lastKnownHash ||
                                    lastKnownHash.toLowerCase() !== remoteHash.toLowerCase())
                            ) {
                                if (ctx.localIndex[file.path]?.lastAction === "merge") {
                                    await ctx.log(
                                        `[Smart Push] Allowing push of merged file (hash mismatch expected): ${file.path}`,
                                        "debug",
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
                                    await pullFileSafely(ctx, remoteMeta, "Push Conflict");

                                    if (ctx.localIndex[file.path]?.lastAction === "merge") {
                                        try {
                                            const mergedContent =
                                                await ctx.vault.readBinary(file.path);
                                            const mergedStat = await ctx.vault.stat(
                                                file.path,
                                            );
                                            const mergedFileId =
                                                ctx.index[file.path]?.fileId || remoteMeta.id;

                                            const mergedUploaded = await ctx.adapter.uploadFile(
                                                file.path,
                                                mergedContent,
                                                mergedStat?.mtime || Date.now(),
                                                mergedFileId,
                                            );

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
                                            ctx.index[file.path] = mergedEntry;
                                            ctx.localIndex[file.path] = { ...mergedEntry };
                                            ctx.dirtyPaths.delete(file.path);
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
                                        } catch (uploadErr) {
                                            await ctx.log(
                                                `[Smart Push] [Deadlock Breaking] Failed to upload merged file: ${file.path} - ${uploadErr}`,
                                                "error",
                                            );
                                        }
                                    }
                                    return;
                                }
                            }
                        }
                    } catch (e) {
                        await ctx.log(`[Smart Push] Pre-upload validation failed: ${e}`, "warn");
                    }

                    const targetFileId = remoteMeta?.id || ctx.index[file.path]?.fileId;

                    const uploaded = await ctx.adapter.uploadFile(
                        file.path,
                        file.content,
                        file.mtime,
                        targetFileId,
                    );

                    const plainHash = await hashContent(file.content);

                    const previousAncestorHash = ctx.localIndex[file.path]?.ancestorHash;
                    const entry = {
                        fileId: uploaded.id,
                        mtime: file.mtime,
                        size: uploaded.size,
                        hash: uploaded.hash,
                        plainHash: plainHash,
                        lastAction: "push" as const,
                        ancestorHash: previousAncestorHash || uploaded.hash,
                    };
                    ctx.index[file.path] = entry;
                    ctx.localIndex[file.path] = { ...entry };

                    if (ctx.dirtyPaths.get(file.path) === file.dirtyAt) {
                        ctx.dirtyPaths.delete(file.path);
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
                    await ctx.log(`[Smart Push] Upload failed: ${file.path} - ${e}`, "error");
                } finally {
                    ctx.backgroundTransferQueue.markInlineEnd(file.path);
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
                        await ctx.adapter.deleteFile(meta.id);
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
                        `[Smart Push] [Folder Wipe] Failed to wipe folder ${folderPath}: ${e}`,
                        "error",
                    );
                }
            });
        }

        for (const path of filesToWipeSimpler) {
            tasks.push(async () => {
                try {
                    const entry = ctx.index[path];
                    if (entry) {
                        await ctx.adapter.deleteFile(entry.fileId);
                        delete ctx.index[path];
                        delete ctx.localIndex[path];
                        ctx.dirtyPaths.delete(path);

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
                    await ctx.log(`[Smart Push] Delete failed: ${path} - ${e}`, "error");
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
    }
}
