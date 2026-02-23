import { TFile } from "obsidian";
import { md5 } from "../utils/md5";
import type { SyncContext } from "./context";
import { ensureLocalFolder, hashContent, normalizeLineEndings } from "./file-utils";
import { checkMergeLock, acquireMergeLock, releaseMergeLock, saveLocalIndex } from "./state";
import { listRevisions } from "./history";
import { basename } from "../utils/path";
import { MERGE_MAX_INLINE_DOWNLOAD_BYTES } from "./constants";
import { getMergeStrategy } from "./strategies";

function markSettingsUpdatedIfNeeded(ctx: SyncContext, path: string): void {
    if (path.endsWith("/open-data.json")) {
        ctx.settingsUpdated = true;
    }
}

// Re-export for backward compatibility (function moved to diff-utils.ts)
export { linesToChars3 } from "./diff-utils";

/**
 * Check if the subset content's lines are a strict subsequence of the superset content.
 */
export function isContentSubset(subset: string, superset: string): boolean {
    const subLines = normalizeLineEndings(subset)
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
    const superLines = normalizeLineEndings(superset)
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);

    if (subLines.length === 0) return true;
    if (subLines.length > superLines.length) return false;

    let superIdx = 0;
    for (const subLine of subLines) {
        let found = false;
        while (superIdx < superLines.length) {
            if (superLines[superIdx] === subLine) {
                found = true;
                superIdx++;
                break;
            }
            superIdx++;
        }
        if (!found) return false;
    }
    return true;
}

/**
 * Check if two contents are semantically equivalent (same lines, possibly different order)
 */
export function areSemanticallyEquivalent(contentA: string, contentB: string): boolean {
    const localNorm = normalizeLineEndings(contentA);
    const remoteNorm = normalizeLineEndings(contentB);

    const localLines = localNorm.split("\n").filter((line) => line.trim().length > 0);
    const remoteLines = remoteNorm.split("\n").filter((line) => line.trim().length > 0);

    const sortedLocal = localLines.map((line) => line.trim()).sort();
    const sortedRemote = remoteLines.map((line) => line.trim()).sort();

    if (sortedLocal.length !== sortedRemote.length) {
        return false;
    }

    for (let i = 0; i < sortedLocal.length; i++) {
        if (sortedLocal[i] !== sortedRemote[i]) {
            return false;
        }
    }

    return true;
}


/**
 * Find common ancestor hash from revision history
 */
export async function findCommonAncestorHash(
    ctx: SyncContext,
    path: string,
    localHash: string,
    remoteHash: string,
): Promise<string | null> {
    try {
        const revisions = await listRevisions(ctx, path);

        await ctx.log(
            `[Merge] Finding common ancestor for ${path}: local=${localHash.substring(0, 8)}, remote=${remoteHash.substring(0, 8)}`,
            "debug",
        );
        await ctx.log(
            `[Merge] Available revisions: ${revisions.map((r) => r.hash?.substring(0, 8) || "no-hash").join(", ")}`,
            "debug",
        );

        const localLower = localHash.toLowerCase();
        const remoteLower = remoteHash.toLowerCase();

        let localIdx = -1;
        let remoteIdx = -1;

        for (let i = revisions.length - 1; i >= 0; i--) {
            const hash = revisions[i].hash?.toLowerCase();
            if (hash === localLower && localIdx === -1) localIdx = i;
            if (hash === remoteLower && remoteIdx === -1) remoteIdx = i;
            if (localIdx !== -1 && remoteIdx !== -1) break;
        }

        await ctx.log(`[Merge] localIdx=${localIdx}, remoteIdx=${remoteIdx} (Latest Occurrences)`, "debug");

        if (localIdx === -1 || remoteIdx === -1) {
            await ctx.log(`[Merge] Could not find both versions in history`, "warn");
            return null;
        }

        const pivotIdx = Math.min(localIdx, remoteIdx);

        const foundHash = revisions[pivotIdx].hash;
        await ctx.log(
            `[Merge] Selected ancestor at index ${pivotIdx}: ${foundHash?.substring(0, 8)}`,
            "debug",
        );
        return foundHash || null;
    } catch (e) {
        await ctx.log(`[Merge] Error finding common ancestor: ${e}`, "error");
        return null;
    }
}

/**
 * Try to perform a 3-way merge
 * @returns Merged content as ArrayBuffer if successful, null if conflict persists
 */
export async function perform3WayMerge(
    ctx: SyncContext,
    path: string,
    localContentStr: string,
    remoteContentStr: string,
    baseHash: string,
): Promise<ArrayBuffer | null> {
    try {
        const strategy = getMergeStrategy(ctx.settings.conflictResolutionStrategy);
        return await strategy.merge({
            ctx,
            path,
            localContent: localContentStr,
            remoteContent: remoteContentStr,
            baseHash,
        });
    } catch (e) {
        await ctx.log(`[Merge] Error: ${e}`, "error");
        return null;
    }
}

/**
 * Pull a single file from remote with conflict detection and auto-merge
 * @returns true if downloaded/merged, false if skipped or failed
 */
export async function pullFileSafely(
    ctx: SyncContext,
    item: {
        path: string;
        fileId?: string;
        id?: string;
        hash?: string;
        plainHash?: string;
        mtime?: number;
        size?: number;
        ancestorHash?: string;
    },
    logPrefix: string,
): Promise<boolean> {
    if (!item) return false;

    // S11: Safety check — reject unreasonably large files to prevent OOM
    if (item.size && item.size > MERGE_MAX_INLINE_DOWNLOAD_BYTES) {
        await ctx.log(
            `[${logPrefix}] Skipping ${item.path}: file size ${(item.size / 1024 / 1024).toFixed(1)}MB exceeds inline download limit (100MB)`,
            "warn",
        );
        return false;
    }

    const isRemoteDeleted = !item.hash && !item.fileId;
    const fileId = item.fileId || item.id;
    if (!fileId && !isRemoteDeleted) return false;

    const isText = item.path.endsWith(".md") || item.path.endsWith(".txt");

    const lockStatus = await checkMergeLock(ctx, item.path);
    if (lockStatus.locked) {
        await ctx.log(
            `[${logPrefix}] Skipping pull: ${item.path} is being merged by ${lockStatus.holder} (expires in ${lockStatus.expiresIn}s)`,
            "info",
        );
        await ctx.notify("noticeWaitOtherDeviceMerge", basename(item.path));
        if (ctx.localIndex[item.path]) {
            ctx.localIndex[item.path].pendingConflict = true;
            await saveLocalIndex(ctx);
        }
        return false;
    }

    try {
        const exists = await ctx.vault.exists(item.path);
        if (exists) {
            ctx.syncingPaths.add(item.path);
            try {
                const localContent = await ctx.vault.readBinary(item.path);
                // Normalize line endings for consistent hash calculation across platforms
                const localContentStr = new TextDecoder().decode(localContent);
                const normalizedContent = normalizeLineEndings(localContentStr);
                const currentHash = md5(new TextEncoder().encode(normalizedContent).buffer);
                const localBase = ctx.localIndex[item.path];

                await ctx.log(
                    `[${logPrefix}] Conflict check for ${item.path}: ` +
                        `currentHash=${currentHash.substring(0, 8)}, ` +
                        `localBaseHash=${localBase?.hash?.substring(0, 8) || "none"}, ` +
                        `localBasePlainHash=${localBase?.plainHash?.substring(0, 8) || "none"}, ` +
                        `remoteHash=${item.hash?.substring(0, 8) || "none"}`,
                    "debug",
                );

                // For E2EE: Use plainHash for local modification detection.
                // Remote conflict detection uses encrypted hash (valid: both sides are encrypted).
                let hasRemoteConflict = false;
                let isActuallyModified = false;

                // Remote conflict: always use encrypted hash comparison (both sides encrypted)
                hasRemoteConflict =
                    (localBase?.hash &&
                        item.hash &&
                        localBase.hash.toLowerCase() !== item.hash.toLowerCase()) ||
                    isRemoteDeleted;

                if (ctx.e2eeEnabled && localBase?.plainHash) {
                    // E2EE: detect local modification via plaintext hash comparison
                    const currentPlainHash = await hashContent(localContent);
                    isActuallyModified = localBase.plainHash !== currentPlainHash;
                } else {
                    // No E2EE or no plainHash: use regular hash comparison
                    isActuallyModified =
                        !localBase || !localBase.hash || localBase.hash.toLowerCase() !== currentHash;
                }

                let isModifiedLocally = isActuallyModified || ctx.dirtyPaths.has(item.path);

                const hasRemoteUpdate = hasRemoteConflict;

                if (isModifiedLocally || hasRemoteConflict) {
                    let contentMatches = false;
                    if (ctx.e2eeEnabled && item.plainHash) {
                        // E2EE with remote plainHash: compare plaintext hashes
                        const currentPlainHash = await hashContent(localContent);
                        contentMatches = currentPlainHash === item.plainHash;
                    } else if (!ctx.e2eeEnabled) {
                        contentMatches = !!(item.hash && currentHash === item.hash.toLowerCase());
                    }
                    // E2EE without item.plainHash: can't detect content match pre-download

                    if (contentMatches) {
                        const stat = await ctx.vault.stat(item.path);
                        const plainHash = await hashContent(localContent);

                        const entry = {
                            fileId: fileId || "",
                            mtime: stat?.mtime || Date.now(),
                            size: stat?.size || localContent.byteLength,
                            hash: item.hash || "",
                            plainHash: plainHash,
                            lastAction: "pull" as const,
                            ancestorHash: item.hash || "",
                        };
                        ctx.index[item.path] = entry;
                        ctx.localIndex[item.path] = { ...entry };
                        ctx.dirtyPaths.delete(item.path);

                        if (localBase?.pendingConflict) {
                            delete ctx.localIndex[item.path].pendingConflict;
                            await saveLocalIndex(ctx);
                            await ctx.notify("noticeRemoteMergeSynced", basename(item.path));
                        } else {
                            await saveLocalIndex(ctx);
                        }

                        if (!ctx.settings.hasCompletedFirstSync) {
                            await ctx.notify("noticeSyncConfirmed", basename(item.path));
                        }
                        await ctx.log(`[${logPrefix}] Skipped (content match): ${item.path}`, "debug");
                        return true;
                    }

                    if (hasRemoteConflict && !isActuallyModified) {
                        const isRecentlyPushed =
                            localBase?.lastAction === "push" || localBase?.lastAction === "merge";

                        let safeToAcceptRemote = !isRecentlyPushed;

                        if (isRecentlyPushed && localBase?.hash && item.hash) {
                            if (item.ancestorHash !== undefined) {
                                // Prefer explicit ancestor annotation from remote index
                                const remoteIncludesOurChanges =
                                    item.ancestorHash.toLowerCase() ===
                                    localBase.hash.toLowerCase();

                                if (remoteIncludesOurChanges) {
                                    await ctx.log(
                                        `[${logPrefix}] Quick check: Confirmed that remote is a descendant via ancestorHash. Safe to pull.`,
                                        "debug",
                                    );
                                    safeToAcceptRemote = true;
                                } else {
                                    await ctx.log(
                                        `[${logPrefix}] Safety Warning: Remote version ignores our ${localBase.lastAction} (Remote.ancestor=${item.ancestorHash.substring(0, 8)}, Local.hash=${localBase.hash.substring(0, 8)}). Forcing merge check.`,
                                        "warn",
                                    );
                                    safeToAcceptRemote = false;
                                }
                            } else {
                                // Fallback for adapters/indices that don't provide ancestorHash
                                await ctx.log(
                                    `[${logPrefix}] Missing ancestorHash. Searching history for ${localBase.hash.substring(0, 8)}...`,
                                    "debug",
                                );
                                const common = await findCommonAncestorHash(
                                    ctx,
                                    item.path,
                                    localBase.hash,
                                    item.hash,
                                );
                                if (common?.toLowerCase() === localBase.hash.toLowerCase()) {
                                    await ctx.log(
                                        `[${logPrefix}] Confirmed via history: Remote is a descendant. Safe to pull.`,
                                        "debug",
                                    );
                                    safeToAcceptRemote = true;
                                } else {
                                    await ctx.log(
                                        `[${logPrefix}] Warning: Remote version seems to have overwritten our ${localBase.lastAction}. Forcing merge.`,
                                        "warn",
                                    );
                                    safeToAcceptRemote = false;
                                }
                            }
                        }

                        if (safeToAcceptRemote) {
                            const wasPendingConflict = localBase?.pendingConflict === true;

                            await ctx.log(
                                `[${logPrefix}] Remote updated, local unmodified. Accepting remote version. (wasPendingConflict=${wasPendingConflict})`,
                                "info",
                            );

                            if (wasPendingConflict) {
                                await ctx.notify(
                                    "noticeRemoteMergeSynced",
                                    basename(item.path),
                                );
                            } else {
                                await ctx.notify("noticeFilePulled", basename(item.path));
                            }
                            ctx.syncingPaths.add(item.path);
                            const remoteContent = await ctx.adapter.downloadFile(fileId || "");
                            try {
                                await ctx.vault.writeBinary(item.path, remoteContent);
                            } catch (writeErr) {
                                await ctx.log(`[${logPrefix}] Write failed for ${item.path}, restoring original content`, "error");
                                try { await ctx.vault.writeBinary(item.path, localContent); } catch { /* best effort */ }
                                throw writeErr;
                            }

                            markSettingsUpdatedIfNeeded(ctx, item.path);

                            const stat = await ctx.vault.stat(item.path);
                            // Calculate plainHash for downloaded content
                            const plainHash = await hashContent(remoteContent);

                            const entry = {
                                fileId: fileId || "",
                                mtime: stat?.mtime || Date.now(),
                                size: remoteContent.byteLength,
                                hash: item.hash,
                                plainHash: plainHash,
                                lastAction: "pull" as const,
                                ancestorHash: item.hash,
                            };
                            ctx.index[item.path] = entry;
                            ctx.localIndex[item.path] = { ...entry };
                            await saveLocalIndex(ctx);
                            ctx.logger.markActionTaken();
                            return true;
                        }
                    }

                    if (isText && localBase?.hash) {
                        await ctx.log(
                            `[${logPrefix}] Attempting to acquire merge lock for ${item.path}...`,
                            "debug",
                        );

                        const lockResult = await acquireMergeLock(ctx, item.path);
                        if (!lockResult.acquired) {
                            await ctx.log(
                                `[${logPrefix}] Lock not acquired: ${item.path} is being handled by ${lockResult.holder} (expires in ${lockResult.expiresIn}s)`,
                                "info",
                            );
                            await ctx.notify(
                                "noticeWaitOtherDeviceMerge",
                                `${basename(item.path)} (${lockResult.expiresIn}s)`,
                            );
                            if (ctx.localIndex[item.path]) {
                                ctx.localIndex[item.path].pendingConflict = true;
                            }
                            return false;
                        }
                        await ctx.log(`[${logPrefix}] Lock acquired successfully.`, "debug");

                        await ctx.notify("noticeMergingFile", basename(item.path));

                        let baseHash = localBase.ancestorHash;
                        let origin = "ancestorHash";

                        await ctx.log(
                            `[${logPrefix}] Base selection: ancestorHash=${baseHash?.substring(0, 8) || "null"}, localBase.hash=${localBase.hash?.substring(0, 8) || "null"}, remote.hash=${item.hash?.substring(0, 8) || "null"}`,
                            "debug",
                        );

                        const isBaseSameAsLocal =
                            baseHash &&
                            localBase.hash &&
                            baseHash.toLowerCase() === localBase.hash.toLowerCase();
                        const isBaseSameAsRemote =
                            baseHash &&
                            item.hash &&
                            baseHash.toLowerCase() === item.hash.toLowerCase();

                        const needHistoryLookup =
                            !baseHash ||
                            (isBaseSameAsLocal && !isActuallyModified) ||
                            isBaseSameAsRemote;

                        if (needHistoryLookup) {
                            await ctx.log(
                                `[${logPrefix}] ancestorHash invalid (missing=${!baseHash}, sameAsLocal=${isBaseSameAsLocal}, sameAsRemote=${isBaseSameAsRemote}). Searching history...`,
                                "debug",
                            );
                            const computedAncestor = await findCommonAncestorHash(
                                ctx,
                                item.path,
                                localBase.hash as string,
                                item.hash || "",
                            );
                            if (computedAncestor) {
                                baseHash = computedAncestor;
                                origin = "history lookup";
                            }
                        }

                        if (!baseHash) {
                            await ctx.log(
                                `[${logPrefix}] Genuinely unsolvable conflict. Falling back to conflict file.`,
                                "warn",
                            );
                        } else {
                            const baseHashFound = baseHash;
                            const remoteContentBuffer = await ctx.adapter.downloadFile(
                                fileId || "",
                            );
                            const remoteContentStr = new TextDecoder().decode(remoteContentBuffer);
                            const currentContentStr = new TextDecoder().decode(localContent);

                            const merged = await perform3WayMerge(
                                ctx,
                                item.path,
                                currentContentStr,
                                remoteContentStr,
                                baseHashFound,
                            );

                            if (merged) {
                                const mergedStr = new TextDecoder().decode(merged);
                                const normalizedMerged = normalizeLineEndings(mergedStr);
                                const normalizedBuffer = new TextEncoder().encode(
                                    normalizedMerged,
                                ).buffer;
                                try {
                                    await ctx.vault.writeBinary(
                                        item.path,
                                        normalizedBuffer,
                                    );
                                } catch (writeErr) {
                                    await ctx.log(`[${logPrefix}] Merge write failed for ${item.path}, restoring original content`, "error");
                                    try { await ctx.vault.writeBinary(item.path, localContent); } catch { /* best effort */ }
                                    throw writeErr;
                                }

                                markSettingsUpdatedIfNeeded(ctx, item.path);

                                const mergedHash = md5(normalizedBuffer);
                                const remoteNorm = normalizeLineEndings(remoteContentStr);

                                const isIdenticalToRemote =
                                    (item.hash && mergedHash === item.hash.toLowerCase()) ||
                                    normalizedMerged === remoteNorm;

                                if (isIdenticalToRemote) {
                                    await ctx.log(
                                        `[${logPrefix}] Result matches remote. Marking as Synced.`,
                                        "debug",
                                    );
                                    const stat = await ctx.vault.stat(item.path);
                                    const mergedPlainHash = await hashContent(merged);

                                    const entry = {
                                        fileId: fileId || "",
                                        mtime: stat?.mtime || Date.now(),
                                        size: merged.byteLength,
                                        hash: item.hash?.toLowerCase() || "",
                                        plainHash: mergedPlainHash,
                                        lastAction: "pull" as const,
                                        ancestorHash: item.hash?.toLowerCase() || "",
                                    };
                                    await ctx.notify(
                                        "noticeRemoteMergeSynced",
                                        basename(item.path),
                                    );
                                    ctx.index[item.path] = entry;
                                    ctx.localIndex[item.path] = { ...entry };
                                    ctx.dirtyPaths.delete(item.path);
                                } else {
                                    const lockCheck = await checkMergeLock(ctx, item.path);
                                    if (!lockCheck.locked) {
                                        const stat = await ctx.vault.stat(item.path);
                                        const entryLocal = {
                                            fileId: fileId || "",
                                            mtime: stat?.mtime || Date.now(),
                                            size: merged.byteLength,
                                            hash: mergedHash,
                                            lastAction: "merge" as const,
                                            ancestorHash: item.hash?.toLowerCase() || "",
                                        };
                                        const entryCloud = {
                                            fileId: fileId || "",
                                            mtime: item.mtime || Date.now(),
                                            size: item.size || 0,
                                            hash: item.hash,
                                            lastAction: "pull" as const,
                                            ancestorHash: item.hash,
                                        };
                                        ctx.index[item.path] = entryCloud;
                                        ctx.localIndex[item.path] = entryLocal;
                                        ctx.dirtyPaths.set(item.path, Date.now());
                                        await saveLocalIndex(ctx);

                                        await ctx.log(
                                            `[${logPrefix}] Merged successfully. Queued for push.`,
                                            "info",
                                        );

                                        if (localBase?.pendingConflict) {
                                            // Successfully merged our changes on top of a remote merge result from another device
                                            await ctx.notify(
                                                "noticeRemoteMergeSynced",
                                                basename(item.path),
                                            );
                                            delete ctx.localIndex[item.path].pendingConflict;
                                            await saveLocalIndex(ctx);
                                        } else {
                                            await ctx.notify(
                                                "noticeMergeSuccess",
                                                basename(item.path),
                                            );
                                        }
                                    } else {
                                        await ctx.log(
                                            `[${logPrefix}] Lock lost during merge. Content saved locally, queued for push on next cycle.`,
                                            "warn",
                                        );
                                        await ctx.notify("noticeMergeLockLost", basename(item.path));
                                        const statLockLost = await ctx.vault.stat(
                                            item.path,
                                        );
                                        ctx.localIndex[item.path] = {
                                            fileId: fileId || "",
                                            mtime: statLockLost?.mtime || Date.now(),
                                            size: merged.byteLength,
                                            hash: mergedHash,
                                            lastAction: "merge" as const,
                                            ancestorHash: item.hash?.toLowerCase() || "",
                                        };
                                        ctx.dirtyPaths.set(item.path, Date.now());
                                        await saveLocalIndex(ctx);
                                    }
                                }

                                await releaseMergeLock(ctx, item.path, logPrefix);
                                ctx.logger.markActionTaken();
                                return true;
                            }
                        }

                        // Merge failed - fall through to conflict file
                    }

                    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
                    const ext = item.path.split(".").pop();
                    const baseName = item.path.substring(0, item.path.lastIndexOf("."));
                    const conflictPath = `${baseName} (Conflict ${timestamp}).${ext}`;

                    const isLocalProbablyBetter =
                        localBase?.lastAction === "push" || localBase?.lastAction === "merge";

                    await ctx.log(
                        `[${logPrefix}] CONFLICT (Remote Priority): Accepting remote version as main. ` +
                            (isLocalProbablyBetter
                                ? "(Safety Guard/Recent action hit)"
                                : "(Standard dual modification)"),
                        "warn",
                    );

                    const localFile = ctx.vault.getAbstractFileByPath(item.path);
                    if (localFile instanceof TFile) {
                        await ctx.vault.renameFile(localFile, conflictPath);
                    } else {
                        await ctx.vault.rename(item.path, conflictPath);
                    }
                    await ctx.log(`[${logPrefix}] Renamed local version to ${conflictPath}`, "info");

                    let remoteSize = 0;
                    let remotePlainHash: string | undefined;
                    if (!isRemoteDeleted) {
                        const remoteContent = await ctx.adapter.downloadFile(fileId || "");
                        await ensureLocalFolder(ctx, item.path);
                        await ctx.vault.writeBinary(item.path, remoteContent);
                        remoteSize = remoteContent.byteLength;
                        remotePlainHash = await hashContent(remoteContent);

                        markSettingsUpdatedIfNeeded(ctx, item.path);
                    } else {
                        const exists = await ctx.vault.exists(item.path);
                        if (exists) {
                            await ctx.vault.remove(item.path);
                        }
                    }

                    const stat = await ctx.vault.stat(item.path);
                    const entry = {
                        fileId: fileId || "",
                        mtime: stat?.mtime || Date.now(),
                        size: remoteSize,
                        hash: item.hash?.toLowerCase() || "",
                        plainHash: remotePlainHash,
                        lastAction: "pull" as const,
                        ancestorHash: item.hash?.toLowerCase() || "",
                    };
                    ctx.index[item.path] = entry;
                    ctx.localIndex[item.path] = { ...entry };
                    ctx.dirtyPaths.delete(item.path);
                    await saveLocalIndex(ctx);

                    if (isText && localBase?.hash) {
                        await releaseMergeLock(ctx, item.path, logPrefix);
                    }

                    await ctx.notify("noticeConflictSaved", basename(conflictPath));
                    ctx.logger.markActionTaken();
                    return true;
                } else {
                    await ctx.log(
                        `[${logPrefix}] Skipping redundant update (already in sync): ${item.path}`,
                        "debug",
                    );

                    if (ctx.localIndex[item.path]?.pendingConflict) {
                        delete ctx.localIndex[item.path].pendingConflict;
                        await saveLocalIndex(ctx);

                        await ctx.notify("noticeRemoteMergeSynced", basename(item.path));
                    }

                    if (isRemoteDeleted) {
                        await ctx.log(
                            `[${logPrefix}] Deleting local file after moving to conflict (remote deleted): ${item.path}`,
                            "info",
                        );
                        delete ctx.index[item.path];
                        delete ctx.localIndex[item.path];
                        ctx.dirtyPaths.delete(item.path);
                        await saveLocalIndex(ctx);
                        ctx.logger.markActionTaken();
                        return true;
                    }

                    return true;
                }
            } catch (err) {
                await ctx.log(
                    `[${logPrefix}] Conflict check error for ${item.path}: ${err}`,
                    "error",
                );
                return false;
            }
        }

        ctx.syncingPaths.add(item.path);
        await ensureLocalFolder(ctx, item.path);

        const content = await ctx.adapter.downloadFile(fileId || "");
        await ctx.vault.writeBinary(item.path, content);

        const plainHash = await hashContent(content);

        const stat = await ctx.vault.stat(item.path);
        const entry = {
            fileId: fileId || "",
            mtime: stat?.mtime || item.mtime || Date.now(),
            size: stat?.size || item.size || content.byteLength,
            hash: item.hash || "",
            plainHash: plainHash,
            lastAction: "pull" as const,
            ancestorHash: item.hash || "",
        };
        ctx.index[item.path] = entry;
        ctx.localIndex[item.path] = { ...entry };
        await saveLocalIndex(ctx);

        await ctx.notify("noticeFilePulled", basename(item.path));
        ctx.logger.markActionTaken();
        return true;
    } catch (e) {
        await ctx.log(`[${logPrefix}] Pull failed: ${item.path} - ${e}`, "error");
        if (e instanceof Error && e.name === "DecryptionError") {
            await ctx.notify("noticeE2EEDecryptFailed", basename(item.path));
        }
        return false;
    } finally {
        ctx.syncingPaths.delete(item.path);
    }
}
