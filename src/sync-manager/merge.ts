import { TFile } from "obsidian";
import { md5 } from "../utils/md5";
import { diff_match_patch } from "diff-match-patch";
import type { SyncContext } from "./context";
import { ensureLocalFolder } from "./file-utils";
import { checkMergeLock, acquireMergeLock, releaseMergeLock, saveLocalIndex } from "./state";
import { listRevisions, getRevisionContent } from "./history";

// === Pure Functions ===

/**
 * Custom 3-way line encoding to ensure ALL unique lines from Base, Local, and Remote
 * represent correctly in the character-based diff.
 */
export function linesToChars3(
    text1: string,
    text2: string,
    text3: string,
): {
    chars1: string;
    chars2: string;
    chars3: string;
    lineArray: string[];
} {
    const lineArray: string[] = [];
    const lineHash: { [key: string]: number } = {};

    const encode = (text: string) => {
        let chars = "";
        let lineStart = 0;
        let lineEnd = -1;
        while (lineEnd < text.length - 1) {
            lineEnd = text.indexOf("\n", lineStart);
            if (lineEnd == -1) {
                lineEnd = text.length - 1;
            }
            const line = text.substring(lineStart, lineEnd + 1);

            if (Object.prototype.hasOwnProperty.call(lineHash, line)) {
                chars += String.fromCharCode(lineHash[line]);
            } else {
                const i = lineArray.length;
                lineHash[line] = i;
                lineArray.push(line);
                chars += String.fromCharCode(i);
            }
            lineStart = lineEnd + 1;
        }
        return chars;
    };

    const chars1 = encode(text1);
    const chars2 = encode(text2);
    const chars3 = encode(text3);

    return { chars1, chars2, chars3, lineArray };
}

/**
 * Check if the subset content's lines are a strict subsequence of the superset content.
 */
export function isContentSubset(subset: string, superset: string): boolean {
    const normalize = (s: string) => s.replace(/\r\n/g, "\n");
    const subLines = normalize(subset)
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
    const superLines = normalize(superset)
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
    const normalizeLineEndings = (s: string) => s.replace(/\r\n/g, "\n");
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

// === Context-dependent Functions ===

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
        );
        await ctx.log(
            `[Merge] Available revisions: ${revisions.map((r) => r.hash?.substring(0, 8) || "no-hash").join(", ")}`,
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

        await ctx.log(`[Merge] localIdx=${localIdx}, remoteIdx=${remoteIdx} (Latest Occurrences)`);

        if (localIdx === -1 || remoteIdx === -1) {
            await ctx.log(`[Merge] Could not find both versions in history`);
            return null;
        }

        const pivotIdx = Math.min(localIdx, remoteIdx);

        const foundHash = revisions[pivotIdx].hash;
        await ctx.log(
            `[Merge] Selected ancestor at index ${pivotIdx}: ${foundHash?.substring(0, 8)}`,
        );
        return foundHash || null;
    } catch (e) {
        await ctx.log(`[Merge] Error finding common ancestor: ${e}`);
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
        const strategy = ctx.settings.conflictResolutionStrategy;
        if (strategy === "force-local") {
            await ctx.log(`[Merge] Strategy is 'Force Local'. Overwriting remote changes.`);
            return new TextEncoder().encode(localContentStr).buffer;
        }
        if (strategy === "force-remote") {
            await ctx.log(`[Merge] Strategy is 'Force Remote'. Overwriting local changes.`);
            return new TextEncoder().encode(remoteContentStr).buffer;
        }
        if (strategy === "always-fork") {
            await ctx.log(`[Merge] Strategy is 'Always Fork'. Skipping auto-merge.`);
            return null;
        }

        await ctx.log(`[Merge] Attempting 3-way merge for ${path}...`);
        await ctx.log(`[Merge] Looking for base revision with hash: ${baseHash}`);

        const revisions = await listRevisions(ctx, path);
        await ctx.log(
            `[Merge] Found ${revisions.length} revisions: ${revisions.map((r) => r.hash?.substring(0, 8) || "no-hash").join(", ")}`,
        );

        const baseRev = revisions
            .slice()
            .reverse()
            .find((r) => r.hash && r.hash.toLowerCase() === baseHash.toLowerCase());

        if (!baseRev) {
            await ctx.log(`[Merge] No base revision found matching hash ${baseHash}.`);
            await ctx.log(
                `[Merge] Available hashes: ${revisions.map((r) => r.hash || "null").join(", ")}`,
            );
            return null;
        }

        await ctx.log(`[Merge] Found base revision: ${baseRev.id} (hash: ${baseRev.hash})`);

        const baseBuffer = await getRevisionContent(ctx, path, baseRev.id);
        const baseContentStr = new TextDecoder().decode(baseBuffer);

        const normalize = (s: string) => s.replace(/\r\n/g, "\n");
        const baseNorm = normalize(baseContentStr);
        const localNorm = normalize(localContentStr);
        const remoteNorm = normalize(remoteContentStr);

        await ctx.log(
            `[Merge] Content lengths (raw/norm) - Base: ${baseContentStr.length}/${baseNorm.length}, Local: ${localContentStr.length}/${localNorm.length}, Remote: ${remoteContentStr.length}/${remoteNorm.length}`,
        );

        await ctx.log(`[Merge DEBUG] Base Content:\n---\n${baseNorm}\n---`);
        await ctx.log(`[Merge DEBUG] Local Content:\n---\n${localNorm}\n---`);
        await ctx.log(`[Merge DEBUG] Remote Content:\n---\n${remoteNorm}\n---`);

        const dmp = new diff_match_patch();
        dmp.Match_Threshold = 0.5;
        dmp.Match_Distance = 250;
        dmp.Patch_DeleteThreshold = 0.5;

        const {
            chars1: charsBase,
            chars2: charsLocal,
            chars3: charsRemote,
            lineArray,
        } = linesToChars3(baseNorm, localNorm, remoteNorm);

        const diffs = dmp.diff_main(charsBase, charsRemote, false);

        const getUniqueLines = (text: string, base: string) => {
            const lines = text
                .split("\n")
                .map((l) => l.trim())
                .filter((l) => l.length > 0);
            const baseLines = new Set(
                base
                    .split("\n")
                    .map((l) => l.trim())
                    .filter((l) => l.length > 0),
            );
            return lines.filter((l) => !baseLines.has(l));
        };
        const localAddedLines = getUniqueLines(localNorm, baseNorm);

        const margins = [4, 2, 1];
        for (const margin of margins) {
            await ctx.log(`[Merge] Attempting merge with Patch_Margin=${margin}...`);
            dmp.Patch_Margin = margin;

            const patches = dmp.patch_make(charsBase, diffs);

            let [mergedChars, successResults] = dmp.patch_apply(patches, charsLocal);

            const allSuccess = successResults.every((s: boolean) => s);
            if (!allSuccess) {
                await ctx.log(
                    `[Merge] Bulk apply failed (margin=${margin}). Attempting atomic recovery...`,
                );
                let currentMerged = charsLocal;
                for (let i = 0; i < patches.length; i++) {
                    const [res, success] = dmp.patch_apply([patches[i]], currentMerged);
                    if (success[0]) {
                        currentMerged = res;
                    }
                }
                mergedChars = currentMerged;
            }

            let mergedText = "";
            let decodeError = false;
            for (let i = 0; i < mergedChars.length; i++) {
                const idx = mergedChars.charCodeAt(i);
                if (idx < lineArray.length) {
                    mergedText += lineArray[idx];
                } else {
                    await ctx.log(
                        `[Merge] Encoding error during decode (idx=${idx}, margin=${margin})`,
                    );
                    decodeError = true;
                    break;
                }
            }
            if (decodeError) continue;

            await ctx.log(
                `[Merge DEBUG] Merged Content (margin=${margin}):\n---\n${mergedText}\n---`,
            );

            let validationFailed = false;
            if (localAddedLines.length > 0) {
                const mergedLines = new Set(
                    mergedText
                        .split("\n")
                        .map((l) => l.trim())
                        .filter((l) => l.length > 0),
                );
                for (const line of localAddedLines) {
                    if (!mergedLines.has(line)) {
                        await ctx.log(
                            `[Merge] VALIDATION FAILED (margin=${margin}): Local line was lost: "${line.substring(0, 40)}..."`,
                        );
                        validationFailed = true;
                        break;
                    }
                }
            }

            if (!validationFailed) {
                await ctx.log(`[Merge] SUCCESS: Auto-merged ${path} with Patch_Margin=${margin}`);
                return new TextEncoder().encode(mergedText).buffer;
            }
        }

        await ctx.log(
            `[Merge] FAIL: All Patch_Margin attempts failed for ${path}. (Safety Fallback)`,
        );
        return null;
    } catch (e) {
        await ctx.log(`[Merge] Error: ${e}`);
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
        mtime?: number;
        size?: number;
    },
    logPrefix: string,
): Promise<boolean> {
    if (!item) return false;

    const isRemoteDeleted = !item.hash && !item.fileId;
    const fileId = item.fileId || item.id;
    if (!fileId && !isRemoteDeleted) return false;

    const isText = item.path.endsWith(".md") || item.path.endsWith(".txt");

    const lockStatus = await checkMergeLock(ctx, item.path);
    if (lockStatus.locked) {
        await ctx.log(
            `[${logPrefix}] Skipping pull: ${item.path} is being merged by ${lockStatus.holder} (expires in ${lockStatus.expiresIn}s)`,
        );
        await ctx.notify("noticeWaitOtherDeviceMerge", item.path.split("/").pop());
        if (ctx.localIndex[item.path]) {
            ctx.localIndex[item.path].pendingConflict = true;
            await saveLocalIndex(ctx);
        }
        return false;
    }

    try {
        const exists = await ctx.app.vault.adapter.exists(item.path);
        if (exists) {
            ctx.syncingPaths.add(item.path);
            try {
                const localContent = await ctx.app.vault.adapter.readBinary(item.path);
                const currentHash = md5(localContent);
                const localBase = ctx.localIndex[item.path];

                await ctx.log(
                    `[${logPrefix}] Conflict check for ${item.path}: ` +
                        `currentHash=${currentHash.substring(0, 8)}, ` +
                        `localBaseHash=${localBase?.hash?.substring(0, 8) || "none"}, ` +
                        `remoteHash=${item.hash?.substring(0, 8) || "none"}`,
                );

                const hasRemoteConflict =
                    (localBase?.hash &&
                        item.hash &&
                        localBase.hash.toLowerCase() !== item.hash.toLowerCase()) ||
                    isRemoteDeleted;

                const isActuallyModified =
                    !localBase || !localBase.hash || localBase.hash.toLowerCase() !== currentHash;
                let isModifiedLocally = isActuallyModified || ctx.dirtyPaths.has(item.path);

                const hasRemoteUpdate =
                    (localBase?.hash &&
                        item.hash &&
                        localBase.hash.toLowerCase() !== item.hash.toLowerCase()) ||
                    isRemoteDeleted;

                let safetyGuardTriggered = false;
                if (
                    isModifiedLocally &&
                    (localBase?.lastAction === "push" || localBase?.lastAction === "merge") &&
                    hasRemoteUpdate &&
                    !localBase?.pendingConflict
                ) {
                    await ctx.log(
                        `[${logPrefix}] Safety Guard: Detected remote change after our ${localBase?.lastAction}. Forcing merge check to prevent data loss.`,
                    );
                    await ctx.notify("noticeMergingFile");
                    isModifiedLocally = true;
                    safetyGuardTriggered = true;
                }

                await ctx.log(
                    `[${logPrefix}] isModifiedLocally=${isModifiedLocally}, hasRemoteConflict=${hasRemoteConflict}, lastAction=${localBase?.lastAction || "none"} for ${item.path}`,
                );

                if (isModifiedLocally || hasRemoteConflict) {
                    // Content match check
                    if (item.hash && currentHash === item.hash.toLowerCase()) {
                        const stat = await ctx.app.vault.adapter.stat(item.path);
                        const entry = {
                            fileId: fileId || "",
                            mtime: stat?.mtime || Date.now(),
                            size: stat?.size || localContent.byteLength,
                            hash: item.hash || "",
                            lastAction: "pull" as const,
                            ancestorHash: item.hash || "",
                        };
                        ctx.index[item.path] = entry;
                        ctx.localIndex[item.path] = { ...entry };
                        ctx.dirtyPaths.delete(item.path);

                        if (localBase?.pendingConflict) {
                            delete ctx.localIndex[item.path].pendingConflict;
                            await saveLocalIndex(ctx);
                            await ctx.notify("noticeRemoteMergeSynced", item.path.split("/").pop());
                        } else {
                            await saveLocalIndex(ctx);
                        }

                        if (!ctx.settings.hasCompletedFirstSync) {
                            await ctx.notify("noticeSyncConfirmed", item.path.split("/").pop());
                        }
                        await ctx.log(`[${logPrefix}] Skipped (content match): ${item.path}`);
                        return true;
                    }

                    // REMOTE UPDATED, LOCAL UNMODIFIED
                    if (hasRemoteConflict && !isActuallyModified && !safetyGuardTriggered) {
                        const wasPendingConflict = localBase?.pendingConflict === true;

                        await ctx.log(
                            `[${logPrefix}] Remote updated, local unmodified. Accepting remote version. (wasPendingConflict=${wasPendingConflict})`,
                        );

                        if (wasPendingConflict) {
                            await ctx.notify("noticeRemoteMergeSynced", item.path.split("/").pop());
                        } else {
                            await ctx.notify("noticeFilePulled", item.path.split("/").pop());
                        }
                        ctx.syncingPaths.add(item.path);
                        const remoteContent = await ctx.adapter.downloadFile(fileId || "");
                        await ctx.app.vault.adapter.writeBinary(item.path, remoteContent);

                        const stat = await ctx.app.vault.adapter.stat(item.path);
                        const entry = {
                            fileId: fileId || "",
                            mtime: stat?.mtime || Date.now(),
                            size: remoteContent.byteLength,
                            hash: item.hash,
                            lastAction: "pull" as const,
                            ancestorHash: item.hash,
                        };
                        ctx.index[item.path] = entry;
                        ctx.localIndex[item.path] = { ...entry };
                        await saveLocalIndex(ctx);
                        return true;
                    }

                    // CONFLICT (Both Modified) -> Merge with lock
                    if (isText && localBase?.hash) {
                        await ctx.log(
                            `[${logPrefix}] Attempting to acquire merge lock for ${item.path}...`,
                        );

                        const lockResult = await acquireMergeLock(ctx, item.path);
                        if (!lockResult.acquired) {
                            await ctx.log(
                                `[${logPrefix}] Lock not acquired: ${item.path} is being handled by ${lockResult.holder} (expires in ${lockResult.expiresIn}s)`,
                            );
                            await ctx.notify(
                                "noticeWaitOtherDeviceMerge",
                                item.path.split("/").pop(),
                            );
                            if (ctx.localIndex[item.path]) {
                                ctx.localIndex[item.path].pendingConflict = true;
                            }
                            return false;
                        }
                        await ctx.log(`[${logPrefix}] Lock acquired successfully.`);

                        await ctx.notify("noticeMergingFile", item.path.split("/").pop());

                        let baseHash = localBase.ancestorHash;
                        let origin = "ancestorHash";

                        await ctx.log(
                            `[${logPrefix}] Base selection: ancestorHash=${baseHash?.substring(0, 8) || "null"}, localBase.hash=${localBase.hash?.substring(0, 8) || "null"}, remote.hash=${item.hash?.substring(0, 8) || "null"}`,
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
                            );
                        } else {
                            const baseHashFound = baseHash;
                            const remoteContent = await ctx.adapter.downloadFile(fileId || "");
                            const localContentStr = new TextDecoder().decode(localContent);
                            const remoteContentStr = new TextDecoder().decode(remoteContent);
                            const merged = await perform3WayMerge(
                                ctx,
                                item.path,
                                localContentStr,
                                remoteContentStr,
                                baseHashFound,
                            );

                            if (merged) {
                                const mergedStr = new TextDecoder().decode(merged);
                                const normalizedMerged = mergedStr.replace(/\r\n/g, "\n");
                                await ctx.app.vault.adapter.writeBinary(item.path, merged);
                                const mergedHash = md5(
                                    new TextEncoder().encode(normalizedMerged).buffer,
                                );

                                const isIdenticalToRemote =
                                    item.hash && mergedHash === item.hash.toLowerCase();

                                if (isIdenticalToRemote) {
                                    await ctx.log(
                                        `[${logPrefix}] Result matches remote. Marking as Synced.`,
                                    );
                                    const stat = await ctx.app.vault.adapter.stat(item.path);
                                    const entry = {
                                        fileId: fileId || "",
                                        mtime: stat?.mtime || Date.now(),
                                        size: merged.byteLength,
                                        hash: item.hash?.toLowerCase() || "",
                                        lastAction: "pull" as const,
                                        ancestorHash: item.hash?.toLowerCase() || "",
                                    };
                                    await ctx.notify(
                                        "noticeRemoteMergeSynced",
                                        item.path.split("/").pop(),
                                    );
                                    ctx.index[item.path] = entry;
                                    ctx.localIndex[item.path] = { ...entry };
                                    ctx.dirtyPaths.delete(item.path);
                                } else {
                                    const lockCheck = await checkMergeLock(ctx, item.path);
                                    if (!lockCheck.locked) {
                                        const stat = await ctx.app.vault.adapter.stat(item.path);
                                        const entryLocal = {
                                            fileId: fileId || "",
                                            mtime: stat?.mtime || Date.now(),
                                            size: merged.byteLength,
                                            hash: mergedHash,
                                            lastAction: "merge" as const,
                                            ancestorHash: baseHashFound,
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
                                        ctx.dirtyPaths.add(item.path);
                                        await saveLocalIndex(ctx);

                                        await ctx.log(
                                            `[${logPrefix}] Merged successfully. Queued for push.`,
                                        );

                                        if (localBase?.pendingConflict) {
                                            // Successfully merged our changes on top of a remote merge result from another device
                                            await ctx.notify(
                                                "noticeRemoteMergeSynced",
                                                item.path.split("/").pop(),
                                            );
                                            delete ctx.localIndex[item.path].pendingConflict;
                                            await saveLocalIndex(ctx);
                                        } else {
                                            await ctx.notify(
                                                "noticeMergeSuccess",
                                                item.path.split("/").pop(),
                                            );
                                        }
                                    } else {
                                        await ctx.log(
                                            `[${logPrefix}] Lock lost during merge. Content saved locally, queued for push on next cycle.`,
                                        );
                                        const statLockLost = await ctx.app.vault.adapter.stat(
                                            item.path,
                                        );
                                        ctx.localIndex[item.path] = {
                                            fileId: fileId || "",
                                            mtime: statLockLost?.mtime || Date.now(),
                                            size: merged.byteLength,
                                            hash: mergedHash,
                                            lastAction: "merge" as const,
                                            ancestorHash: baseHashFound,
                                        };
                                        ctx.dirtyPaths.add(item.path);
                                        await saveLocalIndex(ctx);
                                    }
                                }

                                await releaseMergeLock(ctx, item.path, logPrefix);
                                return true;
                            }
                        }

                        // Merge failed - fall through to conflict file
                    }

                    // CONFLICT FALLBACK
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
                    );

                    const localFile = ctx.app.vault.getAbstractFileByPath(item.path);
                    if (localFile instanceof TFile) {
                        await ctx.app.vault.rename(localFile, conflictPath);
                    } else {
                        await ctx.app.vault.adapter.rename(item.path, conflictPath);
                    }
                    await ctx.log(`[${logPrefix}] Renamed local version to ${conflictPath}`);

                    let remoteSize = 0;
                    if (!isRemoteDeleted) {
                        const remoteContent = await ctx.adapter.downloadFile(fileId || "");
                        await ensureLocalFolder(ctx, item.path);
                        await ctx.app.vault.adapter.writeBinary(item.path, remoteContent);
                        remoteSize = remoteContent.byteLength;
                    } else {
                        const exists = await ctx.app.vault.adapter.exists(item.path);
                        if (exists) {
                            await ctx.app.vault.adapter.remove(item.path);
                        }
                    }

                    const stat = await ctx.app.vault.adapter.stat(item.path);
                    const entry = {
                        fileId: fileId || "",
                        mtime: stat?.mtime || Date.now(),
                        size: remoteSize,
                        hash: item.hash?.toLowerCase() || "",
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

                    await ctx.notify("noticeConflictSaved", conflictPath.split("/").pop());
                    return true;
                } else {
                    await ctx.log(
                        `[${logPrefix}] Skipping redundant update (already in sync): ${item.path}`,
                    );

                    if (ctx.localIndex[item.path]?.pendingConflict) {
                        delete ctx.localIndex[item.path].pendingConflict;
                        await saveLocalIndex(ctx);

                        await ctx.notify("noticeRemoteMergeSynced", item.path.split("/").pop());
                    }

                    if (isRemoteDeleted) {
                        await ctx.log(
                            `[${logPrefix}] Deleting local file after moving to conflict (remote deleted): ${item.path}`,
                        );
                        delete ctx.index[item.path];
                        delete ctx.localIndex[item.path];
                        ctx.dirtyPaths.delete(item.path);
                        await saveLocalIndex(ctx);
                        return true;
                    }

                    return true;
                }
            } catch (err) {
                await ctx.log(`[${logPrefix}] Conflict check error for ${item.path}: ${err}`);
                return false;
            }
        }

        // Normal download flow
        ctx.syncingPaths.add(item.path);
        await ensureLocalFolder(ctx, item.path);

        const content = await ctx.adapter.downloadFile(fileId || "");
        await ctx.app.vault.adapter.writeBinary(item.path, content);

        const stat = await ctx.app.vault.adapter.stat(item.path);
        const entry = {
            fileId: fileId || "",
            mtime: stat?.mtime || item.mtime || Date.now(),
            size: stat?.size || item.size || content.byteLength,
            hash: item.hash || "",
            lastAction: "pull" as const,
            ancestorHash: item.hash || "",
        };
        ctx.index[item.path] = entry;
        ctx.localIndex[item.path] = { ...entry };
        await saveLocalIndex(ctx);

        await ctx.notify("noticeFilePulled", item.path.split("/").pop());
        return true;
    } catch (e) {
        await ctx.log(`[${logPrefix}] Pull failed: ${item.path} - ${e}`);
        return false;
    } finally {
        ctx.syncingPaths.delete(item.path);
    }
}
