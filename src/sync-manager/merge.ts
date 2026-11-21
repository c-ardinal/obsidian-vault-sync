import { TFile } from "obsidian";
import { recordActivity } from "./device-registry";
import { contentFingerprint } from "./content-fingerprint";
import type { SyncContext } from "./context";
import type { FileRevision } from "../types/adapter";
import { ensureLocalFolder, hashContent, normalizeLineEndings, plainHashMatches } from "./file-utils";
import {
    checkMergeLock,
    acquireMergeLock,
    releaseMergeLock,
    holdsMergeLock,
    holdMergeLockUntilPush,
    saveLocalIndex,
    renameLocal,
    takeUnsyncedRename,
    peekUnsyncedRename,
    hasDeleteIntent,
    MISSING_EVENT_GRACE_MS,
} from "./state";
import { getRevisionContent, listRevisions, supportsHistory, TransientHistoryError } from "./history";
import { claimPullPath, findPathCollision, isPathClaimedByOther, freeCollisionPath, moveIndexEntry, pathKey, windowsNameProblem } from "./path-collision";
import { basename, dirname } from "../utils/path";
import { MERGE_MAX_INLINE_DOWNLOAD_BYTES } from "./constants";
import {
    attemptedUploadsOf,
    forgetAttemptedUpload,
    isAttemptedUpload,
    markIndexUploadOwed,
    moveAttemptedUploads,
    pendingPullsOf,
    peekAttemptedUpload,
    takeAttemptedUpload,
} from "./sync-helpers";
import { removeRemote } from "./remote-deletion";
import { getMergeStrategy } from "./strategies";
import { storesTransformedContent } from "./content-identity";
import { CtxState } from "./context-state";
import { checkLateUploadForOverwrite, isMergeableText } from "./overwrite-recovery";

/**
 * A local file this device never synced that may simply be replaced by the
 * remote version: anything in the config folder (Obsidian writes defaults on a
 * fresh device) and empty / "{}" / "[]" placeholders. Anything else is the
 * user's own data and must not be overwritten silently.
 */
function isDisposableUntrackedLocal(path: string, content: ArrayBuffer): boolean {
    if (path.startsWith(".obsidian/")) return true;
    if (content.byteLength > 64) return false;
    const text = new TextDecoder().decode(content).replace(/^\uFEFF/, "").trim();
    return text === "" || text === "{}" || text === "[]";
}

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
    fileId?: string,
): Promise<string | null> {
    try {
        const revisions = await listRevisions(ctx, path, fileId);

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
        // A network failure is not "no common ancestor": retry the pull later
        // instead of falling back to a conflict copy.
        if (e instanceof TransientHistoryError) throw e;
        await ctx.log(`[Merge] Error finding common ancestor: ${String(e)}`, "error");
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
    fileId?: string,
    knownRevisions?: FileRevision[],
    baseContent?: string,
): Promise<ArrayBuffer | null> {
    try {
        const strategy = getMergeStrategy(ctx.settings.conflictResolutionStrategy);
        return await strategy.merge({
            ctx,
            path,
            localContent: localContentStr,
            remoteContent: remoteContentStr,
            baseHash,
            fileId,
            knownRevisions,
            baseContent,
        });
    } catch (e) {
        if (e instanceof TransientHistoryError) throw e;
        await ctx.log(`[Merge] Error: ${String(e)}`, "error");
        return null;
    }
}

/**
 * Pull a single file from remote with conflict detection and auto-merge
 * @returns true if downloaded/merged, false if skipped or failed
 */
export async function pullFileSafely(
    ctx: SyncContext,
    item: Parameters<typeof pullFileSafelyClaimed>[1],
    logPrefix: string,
): Promise<boolean> {
    // Another file is being pulled under this name right now (pulls run in parallel):
    // renaming or writing one apart mid-pull merged one note into the other. Wait.
    if (!item) return pullFileSafelyClaimed(ctx, item, logPrefix);
    const fileId = item.fileId || item.id;
    const removed = !item.hash && !item.fileId;
    let claim: (() => void) | null = null;
    if (fileId && !removed) {
        claim = claimPullPath(ctx, item.path, fileId);
        if (!claim) {
            await ctx.log(
                `[${logPrefix}] Another file named ${item.path} is being pulled now. Pulling this one next sync.`,
                "debug",
            );
            return false;
        }
    }
    try {
        return await pullFileSafelyClaimed(ctx, item, logPrefix);
    } finally {
        claim?.();
    }
}

/**
 * Pull a single file from remote with conflict detection and auto-merge
 * @returns true if downloaded/merged, false if skipped or failed
 */
async function pullFileSafelyClaimed(
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

    // Made on macOS/Linux/iOS under a name this system refuses: writing it fails on
    // every sync. Leave it in the cloud (never delete it from here) and tell the user
    // once, so they know why the note is missing on this device.
    if (!isRemoteDeleted && ctx.windowsNameRules && windowsNameProblem(item.path)) {
        await noteUnstorableName(ctx, item.path);
        return false;
    }

    // Two cloud names that are one file on Windows/macOS ("Note.md" / "note.md",
    // NFC / NFD): give the incoming one a distinct name everywhere before pulling.
    let release: (() => void) | null = null;
    const sameNameDuplicate =
        !!fileId && !isRemoteDeleted && (await isSameNameDuplicate(ctx, item.path, fileId));
    // Known here, but on Windows/macOS another synced note now holds its name in
    // another spelling (this one was deleted here, that one renamed onto the name):
    // the local file is that note, and pulling merged the two into one file.
    const heldByOtherSpelling =
        !!fileId && !isRemoteDeleted && !!ctx.index[item.path] && !!ctx.caseInsensitiveFs &&
        hasDeleteIntent(ctx, item.path) && !!findPathCollision(ctx, item.path, fileId);
    if (fileId && !isRemoteDeleted && (!ctx.index[item.path] || sameNameDuplicate || heldByOtherSpelling)) {
        let clash = sameNameDuplicate ? item.path : findPathCollision(ctx, item.path, fileId);
        // A new note made here under another spelling ("Todo.md" while the cloud
        // has "todo.md") is not in the index yet, but on Windows/macOS it is the
        // same local file: pulling would overwrite it or take it for this file.
        if (!clash) clash = await unsyncedNoteUnderOtherSpelling(ctx, item.path);
        if (!clash) {
            release = claimPullPath(ctx, item.path, fileId);
            if (!release) clash = findPathCollision(ctx, item.path, fileId) ?? item.path;
        }
        // Every device must rename the SAME file of the pair, or each renames a
        // different one and the "(2)" names collide again: the larger file id moves.
        const clashId = clash ? ctx.index[clash]?.fileId : undefined;
        if (clash && clashId && fileId < clashId && (await ctx.vault.exists(clash))) {
            const alt = await freeCollisionPath(ctx, clash);
            try {
                await ctx.adapter.moveFile(clashId, basename(alt), dirname(alt) || null);
                await renameLocal(ctx, clash, alt);
            } catch (e) {
                await ctx.log(`[${logPrefix}] Could not rename colliding ${clash}: ${String(e)}`, "warn");
                return false;
            }
            moveIndexEntry(ctx, clash, alt);
            await ctx.log(
                `[${logPrefix}] ${clash} has the same name as ${item.path} on Windows/macOS. Renamed it to ${alt}.`,
                "warn",
            );
            clash = null;
            release = claimPullPath(ctx, item.path, fileId);
        }
        if (clash) {
            const newPath = await freeCollisionPath(ctx, item.path);
            try {
                await ctx.adapter.moveFile(fileId, basename(newPath), dirname(newPath) || null);
            } catch (e) {
                await ctx.log(`[${logPrefix}] Could not rename colliding ${item.path}: ${String(e)}`, "warn");
                return false;
            }
            await ctx.log(
                `[${logPrefix}] ${item.path} has the same name as ${clash} on Windows/macOS. Renamed it to ${newPath}.`,
                "warn",
            );
            item = { ...item, path: newPath };
            release = claimPullPath(ctx, newPath, fileId);
        }
    }
    // Renamed here meanwhile (the rename event moved the index entry to its new name):
    // pulling the old name would recreate the note there next to the renamed one. The
    // push moves it in the cloud first and then reconciles the remote change.
    if (fileId && !isRemoteDeleted && !(await ctx.vault.exists(item.path))) {
        const movedTo = Object.entries(ctx.index).find(
            ([p, e]) => p !== item.path && e.fileId === fileId && e.pendingMove?.oldPath === item.path,
        )?.[0];
        if (movedTo) {
            release?.();
            ctx.dirtyPaths.set(movedTo, ctx.dirtyPaths.get(movedTo) ?? Date.now());
            await ctx.log(
                `[${logPrefix}] ${item.path} was renamed to ${movedTo} here. Pushing the rename first.`,
                "info",
            );
            return false;
        }
    }
    try {
        const ok = await pullFileUnchecked(ctx, item, logPrefix, isRemoteDeleted, fileId);
        if (ok && fileId && ctx.index[item.path]?.fileId === fileId) {
            await dropStaleAliases(ctx, item.path, fileId, logPrefix);
        }
        return ok;
    } finally {
        release?.();
    }
}

/**
 * The same cloud file indexed under another (older) path too. That happens when a
 * device syncs from a remote index that still lists a file under its name from
 * before another device renamed it: the file lands at the old path, and a later
 * pull puts it at the new one. The old copy would stay forever, and the next
 * push or merge for it targets the same file id. Unmodified: remove it.
 * Edited: keep it as a separate new note, so the edit is uploaded, not lost.
 */
async function dropStaleAliases(ctx: SyncContext, path: string, fileId: string, logPrefix: string): Promise<void> {
    for (const [other, entry] of Object.entries(ctx.index)) {
        if (other === path || entry.fileId !== fileId) continue;
        if (entry.pendingMove) continue; // renamed here, not yet pushed: not a stale copy
        delete ctx.index[other];
        delete ctx.localIndex[other];
        try {
            if (!(await ctx.vault.exists(other)) || pathKey(other) === pathKey(path)) {
                ctx.dirtyPaths.delete(other);
                continue;
            }
            // Another cloud file is being pulled to that name right now: the file there
            // is (about to be) that note. Removing it lost the note, and its delete event
            // then deleted it from the cloud as well.
            if (isPathClaimedByOther(ctx, other, fileId)) continue;
            const content = await ctx.vault.readBinary(other);
            const unmodified = !!entry.hash && contentFingerprint(content) === entry.hash.toLowerCase();
            if (unmodified && !ctx.dirtyPaths.has(other) && !isPathClaimedByOther(ctx, other, fileId)) {
                await ctx.vault.remove(other);
                await ctx.log(`[${logPrefix}] Removed stale copy ${other} (the note is now at ${path}).`, "info");
            } else {
                ctx.dirtyPaths.set(other, Date.now());
                await ctx.log(
                    `[${logPrefix}] ${other} is an edited copy of ${path}. Keeping it as a separate note.`,
                    "warn",
                );
            }
        } catch (e) {
            await ctx.log(`[${logPrefix}] Could not clean up stale copy ${other}: ${String(e)}`, "warn");
        }
    }
}

/**
 * Another file with exactly this name: Drive allows two files with one name, and
 * two devices creating the same note at the same time end up that way. Treating
 * the incoming file as a new version of ours would merge two unrelated notes (one
 * note's lines silently replaced the other's). Only when our file still exists
 * under this name; a file deleted and re-created by another device is a new version.
 */
async function isSameNameDuplicate(ctx: SyncContext, path: string, fileId: string): Promise<boolean> {
    const ours = ctx.index[path]?.fileId;
    if (!ours || ours === fileId) return false;
    try {
        const meta = await ctx.adapter.getFileMetadataById(ours, path);
        return !!meta && pathKey(meta.path) === pathKey(path);
    } catch {
        return false;
    }
}

/**
 * True when the version `declaredBase` comes after `ourHash` in the file's history,
 * or the history can't tell (then we keep the earlier behaviour: accept the remote).
 */
async function builtOnLaterVersion(
    ctx: SyncContext,
    path: string,
    fileId: string | undefined,
    ourHash: string,
    declaredBase: string,
): Promise<boolean> {
    const order = await revisionOrder(ctx, path, fileId, ourHash, declaredBase);
    if (!order) return true;
    return order.declared > order.ours;
}

/**
 * True when the remote says it was built on a version strictly OLDER than ours
 * (another device uploaded over ours without seeing it). Then that older version,
 * not ours, is the common ancestor: merging from ours made our own edits look like
 * something the remote had deleted, and they were dropped.
 */
async function builtOnEarlierVersion(
    ctx: SyncContext,
    path: string,
    fileId: string | undefined,
    ourHash: string,
    declaredBase: string,
): Promise<boolean> {
    const order = await revisionOrder(ctx, path, fileId, ourHash, declaredBase);
    return !!order && order.declared < order.ours;
}

/**
 * The cloud hash of the bytes we just downloaded. item.hash comes from the remote index
 * (or a Changes API entry) and can be stale relative to them; a stale base hash makes
 * the next sync think the unmodified file was edited locally. With E2EE the bytes are
 * decrypted plaintext: the encrypted hash is looked up again when the plaintext shows
 * that item described an older version.
 */
async function hashOfDownload(
    ctx: SyncContext,
    item: { path: string; hash?: string; plainHash?: string },
    fileId: string | undefined,
    content: ArrayBuffer,
    plainHash: string,
    /** Fail (the pull is retried) when the version cannot be looked up, instead of guessing */
    strict = false,
): Promise<string> {
    if (!storesTransformedContent(ctx)) return contentFingerprint(content);
    // A lookup that failed (network) must not decide: recording the listed hash next to
    // newer content made the next merge start from the wrong version.
    const lookup = <T,>(p: Promise<T>): Promise<T | null> => (strict ? p : p.catch(() => null));
    let hash = item.hash || "";
    if (!fileId) return hash;
    if (item.plainHash) {
        if (!(await plainHashMatches(item.plainHash, content, plainHash.toLowerCase()))) {
            // Not the listed version. Do not assume it is the cloud's current one: a
            // version uploaded after our download started has that hash, and recording
            // it next to the older content we got made this device (and every device
            // reading its index) treat the newer version as already here. Find the
            // version by content; failing that keep the listed hash, which only costs
            // one more download when the newer version is reported.
            if (supportsHistory(ctx)) {
                const found = await lookup(findRevisionByContent(ctx, item.path, fileId, contentFingerprint(content)));
                if (found) hash = found.hash;
            }
        }
        return hash;
    }
    // No plaintext hash to tell: if the file changed since it was listed, find out
    // which version we actually got.
    const current = await lookup(ctx.adapter.getFileMetadataById(fileId, item.path));
    if (current?.hash && hash && current.hash.toLowerCase() !== hash.toLowerCase() && supportsHistory(ctx)) {
        const found = await lookup(findRevisionByContent(ctx, item.path, fileId, contentFingerprint(content)));
        if (found) hash = found.hash;
    }
    return hash;
}

/**
 * The newest of our unknown-outcome uploads of `path` that reached the cloud (it is in
 * the file's history), as its cloud hash. The newest attempt is often one still being
 * sent, so older ones are checked too: an earlier upload whose response was lost is
 * what our local content builds on.
 */
async function attemptedUploadInHistory(
    ctx: SyncContext,
    path: string,
    fileId: string | undefined,
): Promise<string | undefined> {
    const attempts = attemptedUploadsOf(ctx, path);
    if (attempts.length === 0) return undefined;
    if (!fileId || !supportsHistory(ctx)) {
        // Without history only the plain (untransformed) hash can be compared.
        return storesTransformedContent(ctx) ? undefined : attempts[0];
    }
    if (storesTransformedContent(ctx)) {
        // Recorded as the plaintext md5: find its (encrypted / differently hashed) cloud version.
        for (const sent of attempts) {
            const found = await findRevisionByContent(ctx, path, fileId, sent).catch((e) => {
                if (e instanceof TransientHistoryError) throw e;
                return null;
            });
            if (found?.hash) return found.hash.toLowerCase();
        }
        return undefined;
    }
    const revisions = await listRevisions(ctx, path, fileId).catch((e) => {
        if (e instanceof TransientHistoryError) throw e;
        return [];
    });
    const inHistory = new Set(revisions.map((r) => r.hash?.toLowerCase()).filter(Boolean));
    return attempts.find((h) => inHistory.has(h)) ?? attempts[0];
}

/**
 * plainHash of the version the cloud holds now, read back through the adapter.
 * The only way to identify a cloud version when its stored form is transformed
 * and the index has no plainHash for it yet. Undefined when it cannot be read.
 */
async function readStoredPlainHash(ctx: SyncContext, fileId: string): Promise<string | undefined> {
    return ctx.adapter
        .downloadFile(fileId)
        .then((b) => hashContent(b))
        .catch(() => undefined);
}

/**
 * The revision holding what we sent in an upload whose response was lost (`sent`
 * is the md5 of the content we sent). With E2EE the cloud hashes are of the
 * encrypted bytes, so the (few) revisions are decrypted and compared instead.
 */
async function findOwnUploadInHistory(
    ctx: SyncContext,
    path: string,
    fileId: string,
    sent: string,
): Promise<{ hash: string; plainHash?: string } | null> {
    if (!supportsHistory(ctx)) return null;
    try {
        const revisions = await listRevisions(ctx, path, fileId);
        if (!storesTransformedContent(ctx)) {
            return revisions.some((r) => r.hash?.toLowerCase() === sent) ? { hash: sent } : null;
        }
        return await findRevisionByContent(ctx, path, fileId, sent);
    } catch {
        // history unavailable: no base
    }
    return null;
}

/**
 * E2EE: the newest revision whose decrypted content has md5 `contentMd5`, with its
 * (encrypted) cloud hash. Only the last few revisions are checked.
 */
async function findRevisionByContent(
    ctx: SyncContext,
    path: string,
    fileId: string,
    contentMd5: string,
): Promise<{ hash: string; plainHash: string } | null> {
    const revisions = await listRevisions(ctx, path, fileId);
    for (const r of revisions.slice(-10).reverse()) {
        if (!r.hash) continue;
        const content = await getRevisionContent(ctx, path, r.id, fileId);
        if (contentFingerprint(content) === contentMd5) {
            return { hash: r.hash.toLowerCase(), plainHash: await hashContent(content) };
        }
    }
    return null;
}

/**
 * True (and the record is consumed) when the remote version is exactly what we sent
 * in an upload whose response was lost. With E2EE the record is the plaintext md5,
 * so the remote version is decrypted and compared.
 */
async function isOurLostUpload(
    ctx: SyncContext,
    item: { path: string; hash?: string },
    fileId: string,
): Promise<boolean> {
    if (!storesTransformedContent(ctx)) return takeAttemptedUpload(ctx, item.path, item.hash);
    // Every attempt counts, not only the newest: a lost upload followed by an edit and
    // a second attempt left the first one unrecognized, and our own version came back
    // as another device's edit (binary files: a conflict copy).
    const attempts = attemptedUploadsOf(ctx, item.path);
    if (attempts.length === 0 || !item.hash || !supportsHistory(ctx)) return false;
    const remoteHash = item.hash.toLowerCase();
    let sent: string | undefined;
    try {
        const revisions = await listRevisions(ctx, item.path, fileId);
        const rev = [...revisions].reverse().find((r) => r.hash?.toLowerCase() === remoteHash);
        if (!rev) return false;
        const content = await getRevisionContent(ctx, item.path, rev.id, fileId);
        const got = contentFingerprint(content);
        sent = attempts.find((a) => a === got);
    } catch (e) {
        // Unreadable history: retry later. Taking our own lost upload for another
        // device's edit merged from an older base and lost our later lines.
        if (e instanceof TransientHistoryError) throw e;
        return false;
    }
    if (!sent) return false;
    return takeAttemptedUpload(ctx, item.path, sent);
}

/** Positions (last occurrence) of two versions in the file's history, or null if unknown. */
async function revisionOrder(
    ctx: SyncContext,
    path: string,
    fileId: string | undefined,
    ourHash: string,
    declaredBase: string,
): Promise<{ ours: number; declared: number } | null> {
    try {
        const revisions = await listRevisions(ctx, path, fileId);
        let ours = -1;
        let declared = -1;
        revisions.forEach((r, i) => {
            const h = r.hash?.toLowerCase();
            if (h === ourHash.toLowerCase()) ours = i;
            if (h === declaredBase.toLowerCase()) declared = i;
        });
        return ours === -1 || declared === -1 ? null : { ours, declared };
    } catch (e) {
        // Unreachable history: retry later rather than guess the base (a wrong guess
        // turns our own earlier edit into a conflict with the remote's copy of it)
        if (e instanceof TransientHistoryError) throw e;
        return null;
    }
}

/**
 * Our upload of a new note whose response was lost, while the user renamed the note
 * before it was synced: the cloud has it under the OLD name. Pulling it back created
 * a second copy of the note on every device. Move the cloud file to the current name
 * and adopt it as pushed instead; the push uploads any later edits.
 */
async function adoptUploadOfRenamedFile(
    ctx: SyncContext,
    item: Parameters<typeof pullFileSafely>[1],
    fileId: string,
    logPrefix: string,
): Promise<boolean> {
    let sent = item.hash;
    let plainHash: string | undefined;
    const before = peekUnsyncedRename(ctx, item.path);
    if (!before) return false;
    // The record of the attempt follows the note's renames: look under both names.
    if (![item.path, before].some((p) => peekAttemptedUpload(ctx, p))) return false;
    if (storesTransformedContent(ctx)) {
        // The cloud hash is not the md5 we recorded (E2EE, non-MD5 cloud): compare the
        // content instead. Only downloaded when we did lose an upload of this name.
        const content = await ctx.adapter.downloadFile(fileId).catch(() => null);
        if (!content) return false;
        // Recorded as the exact bytes sent (not line-ending normalized)
        sent = contentFingerprint(content);
        plainHash = await hashContent(content);
    }
    // Renamed again while we downloaded: follow it to its current name
    const now = peekUnsyncedRename(ctx, item.path);
    let attemptedAs = [item.path, before, now].find((p) => p && isAttemptedUpload(ctx, p, sent));
    // Another device edited our lost upload since: it is still ours if the version we
    // sent is in its history. That version is then the base our later edits merge onto.
    let base: string | undefined;
    if (!attemptedAs && now && !storesTransformedContent(ctx) && supportsHistory(ctx)) {
        const revisions = await listRevisions(ctx, item.path, fileId).catch((e) => {
            if (e instanceof TransientHistoryError) throw e;
            return [];
        });
        const inHistory = new Set(revisions.map((r) => r.hash?.toLowerCase()).filter(Boolean));
        for (const p of [item.path, before, now]) {
            const hit = attemptedUploadsOf(ctx, p).find((h) => inHistory.has(h));
            if (hit) {
                attemptedAs = p;
                base = hit;
                break;
            }
        }
    }
    if (!now || !attemptedAs || ctx.index[now] || !(await ctx.vault.exists(now))) {
        return false;
    }
    try {
        await ctx.adapter.moveFile(fileId, basename(now), dirname(now) || null);
    } catch (e) {
        // Keep the records and fail this pull: it is retried, and pulling the file back
        // now made a second copy of the note under its old name.
        await ctx.log(`[${logPrefix}] Could not move our lost upload ${item.path} to ${now}: ${String(e)}`, "warn");
        // The move may have reached the cloud (response lost): the next pull then sees
        // the file at its new name, and without the record there our edited note became
        // a conflict copy of our own upload. A retry under the old name looks here too.
        if (attemptedAs !== now) {
            moveAttemptedUploads(ctx, attemptedAs, now);
            await saveLocalIndex(ctx);
        }
        throw e;
    }
    if (base) forgetAttemptedUpload(ctx, attemptedAs);
    else takeAttemptedUpload(ctx, attemptedAs, sent);
    takeUnsyncedRename(ctx, item.path);
    // Edited elsewhere since: record our version as the base, so the next push sees the
    // remote change and merges it with ours instead of overwriting it
    const hash = (base ?? item.hash!).toLowerCase();
    const entry = {
        fileId,
        mtime: item.mtime ?? Date.now(),
        size: item.size ?? 0,
        hash,
        ...(plainHash ? { plainHash } : {}),
        lastAction: "push" as const,
        ancestorHash: hash,
    };
    ctx.index[now] = { ...entry };
    ctx.localIndex[now] = { ...entry };
    ctx.dirtyPaths.set(now, Date.now());
    await saveLocalIndex(ctx);
    await ctx.log(
        `[${logPrefix}] ${item.path} is our own upload (response lost) of the note now at ${now}. Moved it there.`,
        "info",
    );
    return true;
}

/**
 * The cloud file is exactly a new note we uploaded (the response was lost), nobody
 * changed it since, and the note is no longer here under that name: it was deleted or
 * renamed here before the upload was confirmed (after an app restart we cannot tell
 * which). Pulling it back put a second copy next to the renamed note. Nothing in it
 * is lost by removing it: a renamed note is uploaded under its new name, and a deleted
 * one was meant to go.
 */
async function dropOrphanedOwnUpload(
    ctx: SyncContext,
    item: Parameters<typeof pullFileSafely>[1],
    fileId: string,
    logPrefix: string,
): Promise<boolean> {
    if (ctx.localIndex[item.path] || !peekAttemptedUpload(ctx, item.path)) return false;
    let sent = item.hash;
    if (storesTransformedContent(ctx)) {
        const content = await ctx.adapter.downloadFile(fileId).catch(() => null);
        if (!content) return false;
        sent = contentFingerprint(content); // recorded as the exact bytes sent
    }
    if (!sent || !isAttemptedUpload(ctx, item.path, sent)) return false;
    if (await ctx.vault.exists(item.path)) return false;
    try {
        await removeRemote(ctx, { id: fileId, path: item.path, kind: "file" }, "superseded-upload");
    } catch (e) {
        await ctx.log(`[${logPrefix}] Could not remove our orphaned upload ${item.path}: ${String(e)}`, "warn");
        return false;
    }
    forgetAttemptedUpload(ctx, item.path);
    await saveLocalIndex(ctx, true);
    await ctx.log(
        `[${logPrefix}] ${item.path} is our own upload (response lost) of a note no longer here under that name. Removed it from the cloud.`,
        "info",
    );
    return true;
}

const vanishedLocally = new CtxState<Map<string, number>>(
    "vanishedLocally",
    "Synced files found missing during a pull, waiting for their rename/delete event (first seen at)",
);

/**
 * A synced file is gone from the vault, but no rename or delete reached us yet: the
 * vault event may still be on its way. Writing the remote version now recreated the
 * note under its old name next to the renamed one (a stray copy on this device only).
 * The pull is retried by later syncs; still gone without an event after a while, the
 * file is restored.
 */
const unstorableNotified = new CtxState<Set<string>>("unstorableNotified", "Cloud files whose names this system cannot store (user told once)");

async function noteUnstorableName(ctx: SyncContext, path: string): Promise<void> {
    let told = unstorableNotified.get(ctx);
    if (!told) unstorableNotified.set(ctx, (told = new Set()));
    if (told.has(path)) return;
    told.add(path);
    await ctx.log(`[Pull] ${path}: this system cannot store a file under this name (${windowsNameProblem(path)}). Left in the cloud only.`, "warn");
    await ctx.notify("noticeNameNotSupported", path);
}

async function waitForVanishEvent(ctx: SyncContext, path: string): Promise<boolean> {
    const entry = ctx.localIndex[path];
    // A pull queued earlier (never written here yet) is not a vanished file
    if (!entry || entry.pendingTransfer || hasDeleteIntent(ctx, path) || (await ctx.vault.exists(path))) {
        vanishedLocally.get(ctx)?.delete(path);
        return false;
    }
    let seen = vanishedLocally.get(ctx);
    if (!seen) vanishedLocally.set(ctx, (seen = new Map<string, number>()));
    const since = seen.get(path);
    if (since !== undefined && Date.now() - since >= MISSING_EVENT_GRACE_MS) {
        seen.delete(path);
        return false;
    }
    if (since === undefined) {
        seen.set(path, Date.now());
        await ctx.log(`[Pull] ${path} is missing here without a rename or delete. Pulling it later.`, "info");
    }
    return true;
}

async function pullFileUnchecked(
    ctx: SyncContext,
    item: Parameters<typeof pullFileSafely>[1],
    logPrefix: string,
    isRemoteDeleted: boolean,
    fileId: string | undefined,
): Promise<boolean> {
    const isText = item.path.endsWith(".md") || item.path.endsWith(".txt") || item.path.endsWith(".json");

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
        lockSkipsOf(ctx).add(item.path);
        return false;
    }

    if (!isRemoteDeleted && fileId && (await waitForVanishEvent(ctx, item.path))) return false;

    try {
        const exists = await ctx.vault.exists(item.path);
        if (!exists && fileId && !ctx.index[item.path]) {
            if (await adoptUploadOfRenamedFile(ctx, item, fileId, logPrefix)) return true;
            if (await dropOrphanedOwnUpload(ctx, item, fileId, logPrefix)) return true;
        }
        if (exists && fileId && (await isOurLostUpload(ctx, item, fileId))) {
            // Our own upload of this file: the request "failed" but the server applied
            // it. Adopt it as pushed; the push uploads any later local edits.
            const before = ctx.localIndex[item.path];
            const entry = {
                ...(ctx.localIndex[item.path] ?? {}),
                fileId,
                mtime: item.mtime ?? Date.now(),
                size: item.size ?? 0,
                hash: item.hash!.toLowerCase(),
                lastAction: "push" as const,
                ancestorHash: item.hash!.toLowerCase(),
            };
            delete (entry as { pendingConflict?: boolean }).pendingConflict;
            // The plaintext hash we had belongs to the version before this upload. Kept
            // next to the new cloud hash, it went into the shared index and other devices
            // took their older copy for this version ("content match").
            delete (entry as { plainHash?: string }).plainHash;
            ctx.index[item.path] = { ...entry };
            ctx.localIndex[item.path] = { ...entry };
            ctx.dirtyPaths.set(item.path, Date.now());
            // Renamed while this pull ran: the rename found no synced entry to move, so
            // the note was a new file at its new name and the push uploaded it as a
            // second copy. Hand the adopted cloud file to the new name instead.
            const to = peekUnsyncedRename(ctx, item.path);
            if (to && !ctx.index[to] && !(await ctx.vault.exists(item.path)) && (await ctx.vault.exists(to))) {
                takeUnsyncedRename(ctx, item.path);
                const moved = { ...entry, forcePush: true, pendingMove: { oldPath: item.path } };
                delete ctx.index[item.path];
                delete ctx.localIndex[item.path];
                ctx.dirtyPaths.delete(item.path);
                ctx.index[to] = moved;
                ctx.localIndex[to] = { ...moved };
                ctx.dirtyPaths.set(to, Date.now());
                await saveLocalIndex(ctx);
                await ctx.log(
                    `[${logPrefix}] ${item.path}: adopted our own upload whose response was lost (renamed to ${to} since). Will move the remote file.`,
                    "info",
                );
                return true;
            }
            // The push finds nothing to upload (the cloud already has this content), so
            // without this the shared index never listed the file and devices syncing
            // from it never received it.
            markIndexUploadOwed(ctx);
            await saveLocalIndex(ctx);
            await ctx.log(
                `[${logPrefix}] ${item.path}: adopted our own upload whose response was lost.`,
                "info",
            );
            // It may have replaced a version another device uploaded meanwhile.
            await checkLateUploadForOverwrite(ctx, item.path, fileId, item.hash!, [
                before?.ancestorHash,
                before?.hash,
            ]);
            return true;
        }
        if (exists && fileId && !ctx.localIndex[item.path]) {
            // Our upload of this NEW note "failed" but reached the cloud, other devices
            // edited it since, and we edited it too. Without a base this was a "dual
            // modification": our edit went to a conflict copy. What we sent is the base.
            const sent = peekAttemptedUpload(ctx, item.path);
            // Only when it really reached the cloud: a request lost before the server saw
            // it means the remote file is someone else's note with the same name.
            const base = sent ? await findOwnUploadInHistory(ctx, item.path, fileId, sent) : null;
            if (base) {
                const entry = {
                    fileId,
                    mtime: item.mtime ?? Date.now(),
                    size: item.size ?? 0,
                    hash: base.hash,
                    ...(base.plainHash ? { plainHash: base.plainHash } : {}),
                    lastAction: "pull" as const,
                    ancestorHash: base.hash,
                };
                ctx.index[item.path] = { ...entry };
                ctx.localIndex[item.path] = { ...entry };
                await ctx.log(
                    `[${logPrefix}] ${item.path}: our earlier upload (response lost) is the common base.`,
                    "info",
                );
            } else if (!sent && !ctx.dirtyPaths.has(item.path) && supportsHistory(ctx)) {
                // (A note the user is writing is dirty: it is not an old pulled copy.)
                // No record at all, but the local file may be an older version of this very
                // cloud file: we pulled it and the app was closed before our index was saved.
                // Then it is the base and the remote version simply replaces it; without
                // this, an untouched note came back as a conflict copy of itself.
                const local = contentFingerprint(await ctx.vault.readBinary(item.path));
                const older =
                    item.hash && local !== item.hash.toLowerCase()
                        ? await findOwnUploadInHistory(ctx, item.path, fileId, local)
                        : null;
                if (older) {
                    const entry = {
                        fileId,
                        mtime: item.mtime ?? Date.now(),
                        size: item.size ?? 0,
                        hash: older.hash,
                        plainHash: older.plainHash ?? (await hashContent(await ctx.vault.readBinary(item.path))),
                        lastAction: "pull" as const,
                        ancestorHash: older.hash,
                    };
                    ctx.index[item.path] = { ...entry };
                    ctx.localIndex[item.path] = { ...entry };
                    await ctx.log(
                        `[${logPrefix}] ${item.path}: local copy is an earlier version of the cloud file; using it as the base.`,
                        "info",
                    );
                }
            }
        }
        if (exists) {
            ctx.syncingPaths.add(item.path);
            try {
                const localContent = await ctx.vault.readBinary(item.path);
                // Compare RAW bytes: localBase.hash / item.hash are raw-byte MD5s (Drive md5Checksum,
                // and push hashes raw content). Hashing a line-ending-normalized UTF-8 decode here
                // made every CRLF / BOM / binary file look "locally modified" -> false conflicts.
                const currentHash = contentFingerprint(localContent);
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
                // When !localBase (file never synced), remote content is "new" to this device.
                hasRemoteConflict =
                    (localBase?.hash &&
                        item.hash &&
                        localBase.hash.toLowerCase() !== item.hash.toLowerCase()) ||
                    (!localBase && !!item.hash) ||
                    isRemoteDeleted;

                if (storesTransformedContent(ctx) && localBase?.plainHash) {
                    // E2EE: detect local modification via plaintext hash comparison
                    const currentPlainHash = await hashContent(localContent);
                    isActuallyModified = localBase.plainHash !== currentPlainHash;
                } else {
                    // No E2EE or no plainHash: use regular hash comparison.
                    // A local file this device never synced (no base) that differs from the
                    // remote one is local data in its own right - e.g. both devices created
                    // a note at the same path. Treating it as "unmodified" accepted the remote
                    // version and silently overwrote the local note.
                    if (localBase) {
                        isActuallyModified =
                            !localBase.hash || localBase.hash.toLowerCase() !== currentHash;
                    } else if (isDisposableUntrackedLocal(item.path, localContent)) {
                        // Empty placeholder / default config on a fresh device: take the remote
                        isActuallyModified = false;
                    } else if (storesTransformedContent(ctx)) {
                        // Remote hash is of the ciphertext; compare plaintext hashes instead
                        const localPlain = await hashContent(localContent);
                        if (item.plainHash) {
                            isActuallyModified = !(await plainHashMatches(item.plainHash, localContent, localPlain));
                        } else if (fileId) {
                            // No plaintext hash in the index (e.g. our own upload whose response
                            // was lost, before our index was written): compare the content
                            // itself, or our own file came back as a "conflict" with itself.
                            const remotePlain = await readStoredPlainHash(ctx, fileId);
                            isActuallyModified = remotePlain !== localPlain;
                            if (!isActuallyModified) item = { ...item, plainHash: remotePlain };
                        } else {
                            isActuallyModified = true;
                        }
                    } else {
                        isActuallyModified = !(item.hash && item.hash.toLowerCase() === currentHash);
                    }
                }

                let isModifiedLocally = isActuallyModified || ctx.dirtyPaths.has(item.path);

                if (isModifiedLocally || hasRemoteConflict) {
                    let contentMatches = false;
                    if (storesTransformedContent(ctx) && item.plainHash) {
                        // E2EE with remote plainHash: compare plaintext hashes
                        contentMatches = await plainHashMatches(item.plainHash, localContent);
                    } else if (!storesTransformedContent(ctx)) {
                        contentMatches = !!(item.hash && currentHash === item.hash.toLowerCase());
                    } else if (fileId && hasRemoteConflict && isActuallyModified) {
                        // E2EE without a plaintext hash (the index does not describe this
                        // version yet, e.g. our own upload whose response was lost): compare
                        // the decrypted content, or our own upload comes back as a conflict.
                        const remotePlain = await readStoredPlainHash(ctx, fileId);
                        contentMatches = !!remotePlain && remotePlain === (await hashContent(localContent));
                    }

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

                    if (!hasRemoteConflict && !isRemoteDeleted && localBase?.hash && item.hash) {
                        // The remote is exactly the version we last synced: it has nothing we
                        // lack. Only our local edit is new, and the push uploads it. Merging
                        // here (e.g. a pending-conflict re-check) used an older base and
                        // turned our own edit into a conflict.
                        ctx.dirtyPaths.set(item.path, ctx.dirtyPaths.get(item.path) ?? Date.now());
                        if (localBase.pendingConflict) {
                            delete ctx.localIndex[item.path].pendingConflict;
                            await saveLocalIndex(ctx);
                        }
                        await ctx.log(
                            `[${logPrefix}] ${item.path}: remote unchanged, keeping the local edit for upload.`,
                            "debug",
                        );
                        return true;
                    }

                    if (hasRemoteConflict && !isActuallyModified) {
                        // Our upload, even once confirmed, when the remote says it was built on
                        // something else: another device uploaded over ours without seeing it
                        // (the cloud has no compare-and-set).
                        const isRecentlyPushed =
                            localBase?.lastAction === "push" ||
                            localBase?.lastAction === "merge" ||
                            (!!localBase?.ownPushBase && item.ancestorHash !== undefined);

                        let safeToAcceptRemote = !isRecentlyPushed;

                        if (isRecentlyPushed && localBase?.hash && item.hash) {
                            if (item.ancestorHash !== undefined) {
                                // Prefer explicit ancestor annotation from remote index
                                const remoteIncludesOurChanges =
                                    item.ancestorHash.toLowerCase() ===
                                        localBase.hash.toLowerCase() ||
                                    // Our upload is already confirmed: the remote may simply build
                                    // on a LATER version (that one included ours).
                                    (localBase.lastAction === "pull" &&
                                        (await builtOnLaterVersion(
                                            ctx,
                                            item.path,
                                            fileId,
                                            localBase.hash,
                                            item.ancestorHash,
                                        )));

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
                                // No (current) ancestor annotation - e.g. the remote index lags
                                // behind the file. Revision ORDER cannot prove descent: when two
                                // devices upload at nearly the same time, the later upload sits
                                // after ours in history although it overwrote it. Merge instead
                                // (base = the version our push was built on): if the remote does
                                // include our push the merge simply yields the remote version.
                                await ctx.log(
                                    `[${logPrefix}] Remote version is not known to include our ${localBase.lastAction}. Forcing merge check.`,
                                    "warn",
                                );
                                safeToAcceptRemote = false;
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
                            // The file may have changed again between the listing and the
                            // download: record the version we actually got (looked up before
                            // the edit check below, since the lookup takes a while too).
                            const plainHash = await hashContent(remoteContent);
                            const gotHash = await hashOfDownload(ctx, item, fileId, remoteContent, plainHash, true);
                            // The download takes a while, and vault events for this path are
                            // suppressed meanwhile (syncingPaths). If the user edited the note
                            // during the download, writing now would silently discard the edit.
                            // Keep it: mark dirty so the push detects the remote change and merges.
                            const latest = await ctx.vault.readBinary(item.path).catch(() => null);
                            if (!latest) {
                                // Renamed or deleted meanwhile: writing would resurrect the old
                                // path. The rename/delete is pushed next and reconciled then.
                                await ctx.log(
                                    `[${logPrefix}] ${item.path} was renamed or deleted during the download. Skipping.`,
                                    "info",
                                );
                                return false;
                            }
                            if (contentFingerprint(latest) !== currentHash) {
                                ctx.dirtyPaths.set(item.path, Date.now());
                                await ctx.log(
                                    `[${logPrefix}] ${item.path} was edited during the download. Keeping the local edit; it will be merged.`,
                                    "info",
                                );
                                return false;
                            }
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

                            const entry = {
                                fileId: fileId || "",
                                mtime: stat?.mtime || Date.now(),
                                size: remoteContent.byteLength,
                                hash: gotHash,
                                plainHash: plainHash,
                                lastAction: "pull" as const,
                                ancestorHash: gotHash,
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
                        const attempted = await attemptedUploadInHistory(ctx, item.path, fileId);

                        // The remote version was built directly on the version we pushed
                        // (e.g. another device merged our push before we saw it confirmed).
                        // Our local content also derives from that push, so it is the true
                        // common ancestor; the older ancestorHash would make our own pushed
                        // edit look like a conflicting change on both sides.
                        if (
                            (localBase.lastAction === "push" || localBase.lastAction === "merge") &&
                            item.ancestorHash &&
                            localBase.hash &&
                            item.ancestorHash.toLowerCase() === localBase.hash.toLowerCase()
                        ) {
                            baseHash = localBase.hash;
                        } else if (
                            attempted &&
                            item.hash &&
                            attempted !== item.hash.toLowerCase() &&
                            baseHash?.toLowerCase() !== attempted &&
                            (await revisionOrder(ctx, item.path, fileId, attempted, item.hash)) !== null &&
                            (await builtOnLaterVersion(ctx, item.path, fileId, attempted, item.hash))
                        ) {
                            // An upload of ours whose response was lost is in the history before
                            // the remote version. Our local content derives from it, and whoever
                            // uploaded over it repairs it (overwrite-recovery), so it is the
                            // common ancestor.
                            baseHash = attempted;
                            // That upload may itself have replaced another device's version
                            // (we never saw its response, so its overwrite check never ran).
                            if (fileId && isMergeableText(item.path)) {
                                await checkLateUploadForOverwrite(ctx, item.path, fileId, attempted, [
                                    localBase.hash,
                                    localBase.ancestorHash,
                                ]);
                            }
                        } else if (
                            localBase.lastAction === "push" &&
                            localBase.hash &&
                            item.hash &&
                            baseHash?.toLowerCase() !== localBase.hash.toLowerCase() &&
                            (await builtOnLaterVersion(ctx, item.path, fileId, localBase.hash, item.hash)) &&
                            (await revisionOrder(ctx, item.path, fileId, localBase.hash, item.hash)) !== null
                        ) {
                            // Our upload is in the history before the remote version, but we never
                            // saw it confirmed (another device uploaded right after). A version
                            // that replaced ours without including it is repaired by the device
                            // that uploaded it (overwrite-recovery), so the remote builds on ours.
                            // The older ancestorHash made our own pushed lines look like edits we
                            // made again, conflicting with the remote's copy of them.
                            baseHash = localBase.hash;
                        }

                        // History listed below, reused by the merge to find the base revision
                        let knownRevisions: FileRevision[] | undefined;
                        // Our content is exactly a cloud version newer than our recorded base
                        // (we pulled or merged it, but were closed before saving the index):
                        // we have no edits beyond it, so it is the base. The stale base made
                        // the other devices' later edits look like a conflict with ours.
                        if (
                            fileId &&
                            item.hash &&
                            baseHash &&
                            !storesTransformedContent(ctx) &&
                            supportsHistory(ctx) &&
                            currentHash !== baseHash.toLowerCase() &&
                            currentHash !== item.hash.toLowerCase()
                        ) {
                            knownRevisions = await listRevisions(ctx, item.path, fileId).catch((e) => {
                                if (e instanceof TransientHistoryError) throw e;
                                return undefined;
                            });
                            const at = (h: string) =>
                                knownRevisions?.map((r) => r.hash?.toLowerCase()).lastIndexOf(h.toLowerCase()) ?? -1;
                            const b = at(baseHash);
                            const c = at(currentHash);
                            const r = at(item.hash);
                            if (b !== -1 && c > b && r > c) baseHash = currentHash;
                        }

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

                        if (
                            needHistoryLookup &&
                            item.ancestorHash &&
                            localBase.hash &&
                            item.ancestorHash.toLowerCase() !== localBase.hash.toLowerCase() &&
                            !!item.hash &&
                            item.hash.toLowerCase() !== localBase.hash.toLowerCase() &&
                            (await builtOnEarlierVersion(
                                ctx,
                                item.path,
                                fileId,
                                localBase.hash,
                                item.ancestorHash,
                            ))
                        ) {
                            baseHash = item.ancestorHash;
                            await ctx.log(
                                `[${logPrefix}] Remote was built on ${baseHash.substring(0, 8)}, older than our ${localBase.hash.substring(0, 8)}. Merging from that base.`,
                                "debug",
                            );
                        } else if (needHistoryLookup) {
                            await ctx.log(
                                `[${logPrefix}] ancestorHash invalid (missing=${!baseHash}, sameAsLocal=${isBaseSameAsLocal}, sameAsRemote=${isBaseSameAsRemote}). Searching history...`,
                                "debug",
                            );
                            const computedAncestor = await findCommonAncestorHash(
                                ctx,
                                item.path,
                                localBase.hash,
                                item.hash || "",
                                fileId,
                            );
                            if (computedAncestor) {
                                baseHash = computedAncestor;
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
                            // The version we actually downloaded: one uploaded after the listing
                            // has a newer hash than item.hash. Recording item.hash as the merge
                            // base made the next merge start from a version without the remote
                            // lines we already merged, so they looked like our own edits.
                            // Strict: a guessed hash recorded as the merge base made the next
                            // merge start from the wrong version (a false conflict). On a
                            // lookup failure nothing is written and the pull is retried.
                            const remoteGotHash = (
                                await hashOfDownload(
                                    ctx,
                                    item,
                                    fileId,
                                    remoteContentBuffer,
                                    await hashContent(remoteContentBuffer),
                                    true,
                                )
                            ).toLowerCase();
                            const currentContentStr = new TextDecoder().decode(localContent);

                            let merged = await perform3WayMerge(
                                ctx,
                                item.path,
                                currentContentStr,
                                remoteContentStr,
                                baseHashFound,
                                fileId,
                                knownRevisions,
                            );

                            // The merge downloads revisions and can take seconds. If the user
                            // kept typing meanwhile, writing `merged` would silently discard
                            // those keystrokes. Re-read and merge again from the newest local
                            // content (bounded, so constant typing cannot stall the sync).
                            let latestLocal = localContent;
                            let vanished = false;
                            for (let retry = 0; merged && retry < 3; retry++) {
                                if (!(await ctx.vault.exists(item.path))) {
                                    vanished = true;
                                    break;
                                }
                                const reread = await ctx.vault.readBinary(item.path);
                                if (contentFingerprint(reread) === contentFingerprint(latestLocal)) break;
                                await ctx.log(
                                    `[${logPrefix}] ${item.path} was edited during the merge. Re-merging with the latest local content.`,
                                    "info",
                                );
                                // Fold only the new typing into the result: merging the newest
                                // text from the old base again could clash with the remote on a
                                // line the first merge had already settled (a false conflict).
                                // Merging from the old base again is the fallback: the typing
                                // may touch a line next to what the first merge changed.
                                const typedFrom = new TextDecoder().decode(latestLocal);
                                latestLocal = reread;
                                merged =
                                    (await perform3WayMerge(
                                        ctx,
                                        item.path,
                                        new TextDecoder().decode(reread),
                                        new TextDecoder().decode(merged),
                                        baseHashFound,
                                        fileId,
                                        knownRevisions,
                                        typedFrom,
                                    )) ??
                                    (await perform3WayMerge(
                                        ctx,
                                        item.path,
                                        new TextDecoder().decode(reread),
                                        remoteContentStr,
                                        baseHashFound,
                                        fileId,
                                        knownRevisions,
                                    ));
                            }

                            if (merged && (vanished || !(await ctx.vault.exists(item.path)))) {
                                // The user renamed/deleted the note while we merged. Writing the
                                // result would recreate the old path next to the renamed note.
                                // The rename is pushed next; that push sees the remote change
                                // and merges it into the note under its new name.
                                await ctx.log(
                                    `[${logPrefix}] ${item.path} was renamed or deleted during the merge. Discarding this merge.`,
                                    "info",
                                );
                                await releaseMergeLock(ctx, item.path, logPrefix);
                                return false;
                            }
                            if (merged) {
                                let heldForPush = false;
                                const mergedStr = new TextDecoder().decode(merged);
                                const normalizedMerged = normalizeLineEndings(mergedStr);
                                const remoteNormForWrite = normalizeLineEndings(remoteContentStr);
                                // If the merge result is the remote content (modulo line endings),
                                // keep the remote bytes so every device ends up byte-identical.
                                const normalizedBuffer =
                                    normalizedMerged === remoteNormForWrite
                                        ? remoteContentBuffer
                                        : new TextEncoder().encode(normalizedMerged).buffer;
                                try {
                                    await ctx.vault.writeBinary(
                                        item.path,
                                        normalizedBuffer,
                                    );
                                } catch (writeErr) {
                                    await ctx.log(`[${logPrefix}] Merge write failed for ${item.path}, restoring original content`, "error");
                                    try { await ctx.vault.writeBinary(item.path, latestLocal); } catch { /* best effort */ }
                                    throw writeErr;
                                }

                                markSettingsUpdatedIfNeeded(ctx, item.path);

                                const mergedHash = contentFingerprint(normalizedBuffer);
                                const remoteNorm = normalizeLineEndings(remoteContentStr);

                                const isIdenticalToRemote =
                                    (!!remoteGotHash && mergedHash === remoteGotHash) ||
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
                                        hash: remoteGotHash,
                                        plainHash: mergedPlainHash,
                                        lastAction: "pull" as const,
                                        ancestorHash: remoteGotHash,
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
                                            ancestorHash: remoteGotHash,
                                        };
                                        const entryCloud = {
                                            fileId: fileId || "",
                                            mtime: item.mtime || Date.now(),
                                            size: item.size || 0,
                                            hash: remoteGotHash || item.hash,
                                            lastAction: "pull" as const,
                                            ancestorHash: remoteGotHash || item.hash,
                                        };
                                        ctx.index[item.path] = entryCloud;
                                        ctx.localIndex[item.path] = entryLocal;
                                        ctx.dirtyPaths.set(item.path, Date.now());
                                        await saveLocalIndex(ctx);

                                        await ctx.log(
                                            `[${logPrefix}] Merged successfully. Queued for push.`,
                                            "info",
                                        );
                                        heldForPush = holdMergeLockUntilPush(ctx, item.path);

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

                                if (!heldForPush) {
                                    await releaseMergeLock(ctx, item.path, logPrefix);
                                }
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

                    // Download first: if it fails (network), the note must still be here
                    // under its name. Renaming it away first left it only as a conflict
                    // copy, and the retried pull then waited for a rename event that
                    // never came and gave up.
                    const remoteContent = isRemoteDeleted
                        ? null
                        : await ctx.adapter.downloadFile(fileId || "");
                    const localFile = ctx.vault.getAbstractFileByPath(item.path);
                    if (localFile instanceof TFile) {
                        await ctx.vault.renameFile(localFile, conflictPath);
                    } else {
                        await ctx.vault.rename(item.path, conflictPath);
                    }
                    await ctx.log(`[${logPrefix}] Renamed local version to ${conflictPath}`, "info");
                    recordActivity(ctx, "conflict", item.path);

                    let remoteSize = 0;
                    let remotePlainHash: string | undefined;
                    let remoteGotHash = item.hash?.toLowerCase() || "";
                    if (remoteContent) {
                        if (await ctx.vault.exists(item.path)) {
                            // Another note took this name (moved or created here) after
                            // our version went to the conflict copy. Writing would replace
                            // that note unseen: keep it, push it, and pull the cloud
                            // version on the next sync, which moves whichever is in the way.
                            await ctx.log(
                                `[${logPrefix}] ${item.path} was taken by another note during the conflict. Pulling the cloud version next sync.`,
                                "info",
                            );
                            if (fileId) {
                                pendingPullsOf(ctx).set(fileId, {
                                    file: { id: fileId, path: item.path, hash: item.hash, size: item.size ?? 0 },
                                    attempts: 0,
                                });
                            }
                            ctx.dirtyPaths.set(item.path, Date.now());
                            if (holdsMergeLock(ctx, item.path)) {
                                await releaseMergeLock(ctx, item.path, logPrefix).catch(() => {});
                            }
                            await ctx.notify("noticeConflictSaved", basename(conflictPath), {
                                sticky: true,
                                openPath: conflictPath,
                            });
                            return false;
                        }
                        await ensureLocalFolder(ctx, item.path);
                        await ctx.vault.writeBinary(item.path, remoteContent);
                        remoteSize = remoteContent.byteLength;
                        remotePlainHash = await hashContent(remoteContent);
                        // The version we got (newer than item.hash if uploaded since the listing)
                        remoteGotHash = (
                            await hashOfDownload(ctx, item, fileId, remoteContent, remotePlainHash)
                        ).toLowerCase();

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
                        hash: remoteGotHash,
                        plainHash: remotePlainHash,
                        lastAction: "pull" as const,
                        ancestorHash: remoteGotHash,
                    };
                    ctx.index[item.path] = entry;
                    ctx.localIndex[item.path] = { ...entry };
                    ctx.dirtyPaths.delete(item.path);
                    await saveLocalIndex(ctx);

                    if (isText && localBase?.hash) {
                        await releaseMergeLock(ctx, item.path, logPrefix);
                    }

                    // Conflict copies stay local (never synced), so this notice is the only
                    // pointer to them: keep it until dismissed, and open the copy on click.
                    await ctx.notify("noticeConflictSaved", basename(conflictPath), {
                        sticky: true,
                        openPath: conflictPath,
                    });
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
                    `[${logPrefix}] Conflict check error for ${item.path}: ${String(err)}`,
                    "error",
                );
                // Don't leave our lock blocking other devices until its TTL runs out.
                if (holdsMergeLock(ctx, item.path)) {
                    await releaseMergeLock(ctx, item.path, logPrefix).catch(() => {});
                }
                return false;
            }
        }

        ctx.syncingPaths.add(item.path);
        await ensureLocalFolder(ctx, item.path);

        const content = await ctx.adapter.downloadFile(fileId || "");
        if (
            !exists &&
            fileId &&
            Object.entries(ctx.index).some(
                ([p, e]) => p !== item.path && e.fileId === fileId && e.pendingMove?.oldPath === item.path,
            )
        ) {
            // Renamed here during the download: writing would recreate the old name next
            // to the renamed note. The push moves it and then reconciles the change.
            await ctx.log(`[${logPrefix}] ${item.path} was renamed here during the download. Skipping.`, "info");
            return false;
        }
        if (!exists && (await ctx.vault.exists(item.path))) {
            // The user created a note with this name while we were downloading (vault
            // events are suppressed meanwhile). Writing would replace it unseen; keep it
            // and let the push reconcile the two versions.
            ctx.dirtyPaths.set(item.path, Date.now());
            await ctx.log(
                `[${logPrefix}] ${item.path} was created locally during the download. Keeping the local file.`,
                "info",
            );
            return false;
        }
        // Work out which version we got BEFORE writing: lookups take a while, and an
        // edit typed after the write must not be mistaken for part of the download.
        const plainHash = await hashContent(content);
        // Record the hash of what we ACTUALLY downloaded. item.hash comes from the remote index
        // (or a Changes API entry) and can be stale relative to the bytes we just fetched; a
        // stale base hash makes the next pull think this unmodified file was edited locally.
        // With E2EE the bytes are decrypted plaintext, so the (encrypted) remote hash is kept.
        const downloadedHash = await hashOfDownload(ctx, item, fileId, content, plainHash, true);
        if (!exists && (await ctx.vault.exists(item.path))) {
            // Created locally during the lookup: same as above.
            ctx.dirtyPaths.set(item.path, Date.now());
            await ctx.log(
                `[${logPrefix}] ${item.path} was created locally during the download. Keeping the local file.`,
                "info",
            );
            return false;
        }
        await ctx.vault.writeBinary(item.path, content);

        const stat = await ctx.vault.stat(item.path);
        const entry = {
            fileId: fileId || "",
            mtime: stat?.mtime || item.mtime || Date.now(),
            size: stat?.size || item.size || content.byteLength,
            hash: downloadedHash,
            plainHash: plainHash,
            lastAction: "pull" as const,
            ancestorHash: downloadedHash,
        };
        ctx.index[item.path] = entry;
        ctx.localIndex[item.path] = { ...entry };
        await saveLocalIndex(ctx);

        await ctx.notify("noticeFilePulled", basename(item.path));
        ctx.logger.markActionTaken();
        return true;
    } catch (e) {
        await ctx.log(`[${logPrefix}] Pull failed: ${item.path} - ${String(e)}`, "error");
        if (e instanceof Error && e.name === "DecryptionError") {
            await ctx.notify("noticeE2EEDecryptFailed", basename(item.path));
        }
        return false;
    } finally {
        ctx.syncingPaths.delete(item.path);
    }
}

/** A new local note (not synced yet) whose name differs from `path` only in case or Unicode form */
async function unsyncedNoteUnderOtherSpelling(ctx: SyncContext, path: string): Promise<string | null> {
    const key = pathKey(path);
    for (const other of ctx.dirtyPaths.keys()) {
        if (other === path || ctx.index[other] || pathKey(other) !== key) continue;
        if (await ctx.vault.exists(other)) return other;
    }
    return null;
}

const lockSkips = new CtxState<Set<string>>("pullLockSkips", "Pulls skipped because another device holds the merge lock");
function lockSkipsOf(ctx: SyncContext): Set<string> {
    let set = lockSkips.get(ctx);
    if (!set) lockSkips.set(ctx, (set = new Set<string>()));
    return set;
}

/** True (once) when the last pull of `path` was skipped for another device's merge lock */
export function takePullLockSkip(ctx: SyncContext, path: string): boolean {
    return lockSkips.get(ctx)?.delete(path) ?? false;
}
