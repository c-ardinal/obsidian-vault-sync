import { basename } from "../utils/path";
import { contentFingerprint } from "./content-fingerprint";
import type { SyncContext } from "./context";
import { hashContent } from "./file-utils";
import { getRevisionContent, listRevisions, supportsHistory } from "./history";
import { perform3WayMerge } from "./merge";
import { acquireMergeLock, releaseMergeLock, saveLocalIndex } from "./state";
import { CtxState } from "./context-state";
import { forgetAttemptedUpload, recordAttemptedUpload } from "./sync-helpers";

/** Files we can merge line by line; anything else keeps the newest version. */
export function isMergeableText(path: string): boolean {
    return path.endsWith(".md") || path.endsWith(".txt");
}

/** An overwritten version we still owe a repair for. */
interface PendingRepair {
    fileId: string;
    overwrittenId: string;
    overwrittenHash: string;
    baseHash: string;
    since: number;
}

/** Give up on a repair nobody could do for this long; the version stays in history. */
const REPAIR_TIMEOUT_MS = 10 * 60 * 1000;

const pendingRepairs = new CtxState<Map<string, PendingRepair>>("overwriteRepairs", "Overwritten versions waiting to be restored");

function pendingFor(ctx: SyncContext): Map<string, PendingRepair> {
    let map = pendingRepairs.get(ctx);
    if (!map) {
        map = new Map();
        pendingRepairs.set(ctx, map);
    }
    return map;
}

/**
 * Drive has no compare-and-set: two devices uploading the same note moments apart
 * both "succeed", and the later upload silently replaces the earlier one.
 *
 * Right after our upload, the revision just before ours should be a version we
 * knew: the one our edit was based on, or our own previous upload. If it is not,
 * we overwrote another device's version. Exactly one device repairs it: the one
 * whose upload did the overwriting (us). The overwritten device never repairs; it
 * treats the newer version as built on its own and simply takes it.
 *  - The repair runs under the file's merge lock, so nobody merges the note at the
 *    same time. Letting both sides repair produced chains of merges and conflict
 *    copies.
 *  - If another device holds the lock, or the note changed again before we got to
 *    it, the repair is NOT dropped: we keep it and retry after each sync, once our
 *    copy has caught up with the cloud, merging the overwritten edits into whatever
 *    the newest version is.
 *  - The merged result is uploaded at once, before the lock is released, and it
 *    declares the overwritten version as its base, so that device sees its own
 *    version included and simply takes the result.
 * Returns true when a merged version was uploaded.
 */
export async function recoverOverwrittenVersion(
    ctx: SyncContext,
    path: string,
    fileId: string,
    ourHash: string,
    knownHashes: (string | undefined)[],
): Promise<boolean> {
    if (!supportsHistory(ctx)) return false;
    const check: PendingCheck = {
        fileId,
        ourHash: ourHash.toLowerCase(),
        known: knownHashes.filter((h): h is string => !!h).map((h) => h.toLowerCase()),
        since: Date.now(),
    };
    if (check.known.length === 0) return false;
    const repair = await detectOverwrite(ctx, path, check);
    if (!repair) return false;
    return repairUnderLock(ctx, path, repair, check.ourHash);
}

/**
 * The overwrite check for an upload of ours we only learned about later (its response
 * was lost, and the pull found it in the cloud). The upload may have replaced another
 * device's version just like a confirmed one. Only queues the repair: our copy may
 * have changed since, and the repair runs once it has been pushed (see
 * retryOverwriteRepairs).
 */
export async function checkLateUploadForOverwrite(
    ctx: SyncContext,
    path: string,
    fileId: string,
    ourHash: string,
    knownHashes: (string | undefined)[],
): Promise<void> {
    if (!supportsHistory(ctx) || !isMergeableText(path)) return;
    const known = knownHashes.filter((h): h is string => !!h).map((h) => h.toLowerCase());
    if (known.length === 0) return;
    await detectOverwrite(ctx, path, { fileId, ourHash: ourHash.toLowerCase(), known, since: Date.now() });
}

/**
 * Uploads of the previous app run (killed before it learned their outcome) that may
 * still land after we uploaded the note again: such a late upload replaced the
 * version another device uploaded meanwhile, and nobody noticed. Checked after each
 * sync for a while, like our own upload.
 */
const lateLandings = new CtxState<Map<string, { fileId: string; hashes: string[]; known: string[]; until: number }>>(
    "lateLandings",
    "Uploads of the previous app run that may still land",
);

export function watchLateLanding(
    ctx: SyncContext,
    path: string,
    fileId: string,
    hashes: string[],
    knownHashes: (string | undefined)[],
    forMs: number,
): void {
    if (!supportsHistory(ctx) || !isMergeableText(path) || hashes.length === 0) return;
    let m = lateLandings.get(ctx);
    if (!m) lateLandings.set(ctx, (m = new Map()));
    const known = [...hashes, ...knownHashes].filter((h): h is string => !!h).map((h) => h.toLowerCase());
    m.set(path, { fileId, hashes: hashes.map((h) => h.toLowerCase()), known, until: Date.now() + forMs });
}

/** An overwrite check that could not read the history yet (network error). */
interface PendingCheck {
    fileId: string;
    ourHash: string;
    known: string[];
    since: number;
}

const pendingChecks = new CtxState<Map<string, PendingCheck>>("overwriteChecks", "Uploads whose overwrite check could not run yet");

/**
 * Looks for a version our upload replaced. Returns the repair (also queued) or null.
 * When the history cannot be read, the check itself is queued and retried later:
 * skipping it lost the overwritten edit for good.
 */
/**
 * Waiting checks are keyed by path; a later upload of the same note gets its own
 * entry ("path\0hash") so the earlier check is not replaced. Replacing it dropped the
 * check of the upload that overwrote another device's edit, and that edit was lost.
 */
function forgetCheck(ctx: SyncContext, path: string, check: PendingCheck): void {
    const map = pendingChecks.get(ctx);
    if (!map) return;
    for (const [key, c] of [...map]) {
        if (key.split("\0")[0] === path && c.ourHash === check.ourHash) map.delete(key);
    }
}

async function detectOverwrite(ctx: SyncContext, path: string, check: PendingCheck): Promise<PendingRepair | null> {
    // An earlier upload of this note still waits for its check: run it first.
    const earlier = pendingChecks.get(ctx)?.get(path);
    if (earlier && earlier.ourHash !== check.ourHash) await detectOverwrite(ctx, path, earlier);
    const known = new Set(check.known);
    const ours = check.ourHash;
    let repair: PendingRepair;
    try {
        const revisions = await listRevisions(ctx, path, check.fileId);
        forgetCheck(ctx, path, check);
        let idx = -1;
        revisions.forEach((r, i) => {
            if (r.hash?.toLowerCase() === ours) idx = i;
        });
        if (idx <= 0) return null;
        const prev = revisions[idx - 1];
        const prevHash = prev.hash?.toLowerCase();
        if (!prevHash || prevHash === ours || known.has(prevHash)) return null;
        const base = revisions
            .slice(0, idx - 1)
            .reverse()
            .find((r) => !!r.hash && known.has(r.hash.toLowerCase()));
        if (!base?.hash) return null;
        repair = {
            fileId: check.fileId,
            overwrittenId: prev.id,
            overwrittenHash: prevHash,
            baseHash: base.hash.toLowerCase(),
            since: Date.now(),
        };
    } catch (e) {
        let checks = pendingChecks.get(ctx);
        if (!checks) pendingChecks.set(ctx, (checks = new Map<string, PendingCheck>()));
        const cur = checks.get(path);
        checks.set(!cur || cur.ourHash === check.ourHash ? path : `${path}\0${check.ourHash}`, check);
        await saveLocalIndex(ctx, true);
        await ctx.log(`[Overwrite Check] Could not read the history of ${path}: ${String(e)}. Checking again later.`, "debug");
        return null;
    }

    await ctx.log(
        `[Overwrite Check] Our upload of ${path} replaced another device's version ${repair.overwrittenHash.substring(0, 8)} (uploaded at the same time). Repairing.`,
        "warn",
    );
    pendingFor(ctx).set(path, repair);
    await saveLocalIndex(ctx, true);
    return repair;
}

/**
 * Retry the repairs we could not do yet. Called after each sync, when our copy of
 * the note has had a chance to catch up with the newest version in the cloud.
 */
export async function retryOverwriteRepairs(ctx: SyncContext): Promise<void> {
    const watches = lateLandings.get(ctx);
    for (const [path, w] of [...(watches ?? [])]) {
        if (Date.now() > w.until) {
            watches!.delete(path);
            continue;
        }
        for (const ourHash of w.hashes) {
            if (await detectOverwrite(ctx, path, { fileId: w.fileId, ourHash, known: w.known, since: Date.now() })) {
                watches!.delete(path);
                break;
            }
        }
    }
    const checks = pendingChecks.get(ctx);
    for (const [key, check] of [...(checks ?? [])]) {
        if (!checks!.has(key)) continue; // run already as an earlier check
        if (Date.now() - check.since > REPAIR_TIMEOUT_MS) {
            checks!.delete(key);
            continue;
        }
        await detectOverwrite(ctx, key.split("\0")[0], check);
    }
    const pending = pendingRepairs.get(ctx);
    if (!pending || pending.size === 0) return;
    for (const [listedPath, repair] of [...pending]) {
        let path = listedPath;
        if (ctx.localIndex[path]?.fileId !== repair.fileId) {
            // Renamed (here or on another device) since: the repair goes with the note.
            // Dropping it lost the overwritten edit when the note was renamed meanwhile.
            const moved = Object.keys(ctx.localIndex).find((p) => ctx.localIndex[p].fileId === repair.fileId);
            if (moved && !pending.has(moved)) {
                pending.delete(path);
                pending.set(moved, repair);
                await saveLocalIndex(ctx, true);
                path = moved;
            }
        }
        if (Date.now() - repair.since > REPAIR_TIMEOUT_MS) {
            pending.delete(path);
            await ctx.log(
                `[Overwrite Check] Gave up repairing ${path}. The overwritten version ${repair.overwrittenHash.substring(0, 8)} stays in its history.`,
                "warn",
            );
            continue;
        }
        const entry = ctx.localIndex[path];
        if (!entry?.hash || entry.fileId !== repair.fileId) {
            // Renamed, deleted or replaced: the note is no longer the one we overwrote.
            if (!entry || (entry.fileId && entry.fileId !== repair.fileId)) pending.delete(path);
            continue;
        }
        // Wait until our copy matches the cloud: local edits are pushed first, and a
        // newer remote version is pulled first, so we merge into the newest content.
        if (ctx.dirtyPaths.has(path) || entry.pendingConflict) continue;
        await repairUnderLock(ctx, path, repair, entry.hash.toLowerCase());
    }
}

async function repairUnderLock(
    ctx: SyncContext,
    path: string,
    repair: PendingRepair,
    expectedHead: string,
): Promise<boolean> {
    const pending = pendingFor(ctx);
    const lock = await acquireMergeLock(ctx, path).catch(() => ({ acquired: false }));
    if (!lock.acquired) {
        await ctx.log(`[Overwrite Check] ${path} is being merged elsewhere. Repairing after that.`, "info");
        return false;
    }
    try {
        let head: Awaited<ReturnType<typeof ctx.adapter.getFileMetadataById>>;
        try {
            head = await ctx.adapter.getFileMetadataById(repair.fileId, path);
        } catch (e) {
            // Network: keep the repair (dropping it lost the overwritten edit for good)
            await ctx.log(`[Overwrite Check] Could not read ${path} from the cloud: ${String(e)}. Repairing later.`, "debug");
            return false;
        }
        if (!head) {
            pending.delete(path);
            return false;
        }
        if (!head.hash || head.hash.toLowerCase() !== expectedHead) {
            await ctx.log(`[Overwrite Check] ${path} changed again meanwhile. Repairing after the next pull.`, "info");
            return false;
        }
        const strategy = ctx.settings.conflictResolutionStrategy;
        if (strategy === "force-local" || strategy === "force-remote") {
            // One version wins by the user's choice, and the latest upload is the one
            // every device converges on. Repairing swapped versions instead: two devices
            // repairing at once each took the other's version, and ended up apart.
            pending.delete(path);
            await ctx.log(`[Overwrite Check] ${path}: the replaced version stays in its history (conflict setting: ${strategy}).`, "info");
            return false;
        }
        const theirs = new TextDecoder().decode(
            await getRevisionContent(ctx, path, repair.overwrittenId, repair.fileId),
        );
        let merged: ArrayBuffer | null = null;
        let localBuf: ArrayBuffer | null = null;
        // The merge downloads revisions and takes a while; if the user types meanwhile,
        // merge again from the newest local content (never write over their typing).
        for (let attempt = 0; attempt < 3 && !merged; attempt++) {
            localBuf = await ctx.vault.readBinary(path);
            const result = await perform3WayMerge(
                ctx,
                path,
                new TextDecoder().decode(localBuf),
                theirs,
                repair.baseHash,
                repair.fileId,
            );
            if (!result) {
                pending.delete(path);
                // Not merged (a real conflict, or the "always keep both" setting): keep the
                // other version next to ours as a conflict copy, as a pull does. Left only
                // in the file's history, nobody ever saw that it had been replaced.
                const copy = conflictCopyPathFor(path);
                await ctx.vault.writeBinary(copy, new TextEncoder().encode(theirs).buffer);
                await ctx.log(
                    `[Overwrite Check] Could not merge ${path} automatically. The other version was saved as ${copy}.`,
                    "warn",
                );
                await ctx.notify("noticeConflictSaved", basename(copy), { sticky: true, openPath: copy });
                return false;
            }
            const latest = await ctx.vault.readBinary(path);
            if (contentFingerprint(latest) === contentFingerprint(localBuf)) merged = result;
        }
        if (!merged || !localBuf) {
            // Still typing: the edit is pushed first, then we repair on top of it.
            ctx.dirtyPaths.set(path, Date.now());
            return false;
        }
        pending.delete(path);
        if (contentFingerprint(merged) === contentFingerprint(localBuf)) {
            // Our copy (= the newest version) already contains the overwritten edits.
            await ctx.log(`[Overwrite Check] ${path} already includes the overwritten edits.`, "debug");
            return false;
        }
        await ctx.vault.writeBinary(path, merged);
        const stat = await ctx.vault.stat(path);
        // Recorded like any push: if the response is lost, the next pull recognises the
        // repaired version as ours instead of merging it with itself as another
        // device's edit. The note is dirty until the upload is confirmed, so a failed
        // upload is pushed again by the next sync (the merged lines are in the note).
        recordAttemptedUpload(ctx, path, contentFingerprint(merged));
        ctx.dirtyPaths.set(path, Date.now());
        await saveLocalIndex(ctx, true);
        const uploaded = await ctx.adapter.uploadFile(path, merged, stat?.mtime ?? Date.now(), repair.fileId);
        forgetAttemptedUpload(ctx, path);
        const entry = {
            fileId: uploaded.id,
            mtime: stat?.mtime ?? Date.now(),
            size: uploaded.size,
            hash: uploaded.hash,
            plainHash: await hashContent(merged),
            lastAction: "push" as const,
            // Built on the version the cloud held (which every other device merges from).
            // The device whose version was overwritten finds its own upload earlier in
            // the history and merges from that (see the base selection in merge.ts).
            // Naming the overwritten version here made third devices merge from that
            // older version, and lines changed since looked like conflicting edits.
            ancestorHash: head.hash.toLowerCase(),
        };
        ctx.index[path] = { ...entry };
        ctx.localIndex[path] = { ...entry };
        // Typed into during the upload: that edit is still to be pushed. Clearing the
        // mark here dropped it, and the note stayed different from the cloud for good.
        const now = await ctx.vault.readBinary(path).catch(() => null);
        if (now && contentFingerprint(now) === contentFingerprint(merged)) ctx.dirtyPaths.delete(path);
        await saveLocalIndex(ctx);
        await ctx.log(`[Overwrite Check] Merged the overwritten edits back into ${path} and uploaded it.`, "info");
        return true;
    } catch (e) {
        await ctx.log(`[Overwrite Check] Repair of ${path} failed: ${String(e)}`, "warn");
        return false;
    } finally {
        await releaseMergeLock(ctx, path, "Overwrite Check");
    }
}

/**
 * Owed repairs and checks are saved with the local index. Kept only in memory,
 * they were dropped when the app was closed before the repair ran: the overwritten
 * device then took the newer version as built on its own, and its edit was gone
 * from the note (left only in the file's history).
 */
export function overwriteRepairsSnapshot(
    ctx: object,
): { repairs: Record<string, PendingRepair>; checks: Record<string, PendingCheck> } | undefined {
    const repairs = pendingRepairs.get(ctx);
    const checks = pendingChecks.get(ctx);
    if (!repairs?.size && !checks?.size) return undefined;
    return { repairs: Object.fromEntries(repairs ?? []), checks: Object.fromEntries(checks ?? []) };
}

export function restoreOverwriteRepairs(ctx: object, data: unknown): void {
    if (!data || typeof data !== "object") return;
    const { repairs, checks } = data as { repairs?: unknown; checks?: unknown };
    const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;
    if (repairs && typeof repairs === "object") {
        let map = pendingRepairs.get(ctx);
        if (!map) pendingRepairs.set(ctx, (map = new Map<string, PendingRepair>()));
        for (const [path, r] of Object.entries(repairs as Record<string, Partial<PendingRepair>>)) {
            if (!r || !str(r.fileId) || !str(r.overwrittenId) || !str(r.overwrittenHash) || !str(r.baseHash)) continue;
            if (typeof r.since !== "number" || map.has(path)) continue;
            map.set(path, r as PendingRepair);
        }
    }
    if (checks && typeof checks === "object") {
        let map = pendingChecks.get(ctx);
        if (!map) pendingChecks.set(ctx, (map = new Map<string, PendingCheck>()));
        for (const [path, c] of Object.entries(checks as Record<string, Partial<PendingCheck>>)) {
            if (!c || !str(c.fileId) || !str(c.ourHash) || !Array.isArray(c.known)) continue;
            if (typeof c.since !== "number" || map.has(path)) continue;
            map.set(path, { fileId: c.fileId, ourHash: c.ourHash, known: c.known.filter(str), since: c.since });
        }
    }
}

/** Where a conflict copy of `path` goes (same naming as a pull's conflict copies) */
function conflictCopyPathFor(path: string): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const dot = path.lastIndexOf(".");
    return dot > path.lastIndexOf("/") ? `${path.slice(0, dot)} (Conflict ${timestamp})${path.slice(dot)}` : `${path} (Conflict ${timestamp})`;
}
