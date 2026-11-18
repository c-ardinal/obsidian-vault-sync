import { md5 } from "../utils/md5";
import type { SyncContext } from "./context";
import { hashContent } from "./file-utils";
import { getRevisionContent, listRevisions, supportsHistory } from "./history";
import { perform3WayMerge } from "./merge";
import { acquireMergeLock, releaseMergeLock, saveLocalIndex } from "./state";

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

const pendingRepairs = new WeakMap<object, Map<string, PendingRepair>>();

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

/** An overwrite check that could not read the history yet (network error). */
interface PendingCheck {
    fileId: string;
    ourHash: string;
    known: string[];
    since: number;
}

const pendingChecks = new WeakMap<object, Map<string, PendingCheck>>();

/**
 * Looks for a version our upload replaced. Returns the repair (also queued) or null.
 * When the history cannot be read, the check itself is queued and retried later:
 * skipping it lost the overwritten edit for good.
 */
async function detectOverwrite(ctx: SyncContext, path: string, check: PendingCheck): Promise<PendingRepair | null> {
    const known = new Set(check.known);
    const ours = check.ourHash;
    let repair: PendingRepair;
    try {
        const revisions = await listRevisions(ctx, path, check.fileId);
        pendingChecks.get(ctx)?.delete(path);
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
        checks.set(path, check);
        await ctx.log(`[Overwrite Check] Could not read the history of ${path}: ${String(e)}. Checking again later.`, "debug");
        return null;
    }

    await ctx.log(
        `[Overwrite Check] Our upload of ${path} replaced another device's version ${repair.overwrittenHash.substring(0, 8)} (uploaded at the same time). Repairing.`,
        "warn",
    );
    pendingFor(ctx).set(path, repair);
    return repair;
}

/**
 * Retry the repairs we could not do yet. Called after each sync, when our copy of
 * the note has had a chance to catch up with the newest version in the cloud.
 */
export async function retryOverwriteRepairs(ctx: SyncContext): Promise<void> {
    const checks = pendingChecks.get(ctx);
    for (const [path, check] of [...(checks ?? [])]) {
        if (Date.now() - check.since > REPAIR_TIMEOUT_MS) {
            checks!.delete(path);
            continue;
        }
        await detectOverwrite(ctx, path, check);
    }
    const pending = pendingRepairs.get(ctx);
    if (!pending || pending.size === 0) return;
    for (const [path, repair] of [...pending]) {
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
        const head = await ctx.adapter.getFileMetadataById(repair.fileId, path).catch(() => null);
        if (!head) {
            pending.delete(path);
            return false;
        }
        if (!head.hash || head.hash.toLowerCase() !== expectedHead) {
            await ctx.log(`[Overwrite Check] ${path} changed again meanwhile. Repairing after the next pull.`, "info");
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
                await ctx.log(
                    `[Overwrite Check] Could not merge ${path} automatically. The other version stays in its history.`,
                    "warn",
                );
                return false;
            }
            const latest = await ctx.vault.readBinary(path);
            if (md5(latest) === md5(localBuf)) merged = result;
        }
        if (!merged || !localBuf) {
            // Still typing: the edit is pushed first, then we repair on top of it.
            ctx.dirtyPaths.set(path, Date.now());
            return false;
        }
        pending.delete(path);
        if (md5(merged) === md5(localBuf)) {
            // Our copy (= the newest version) already contains the overwritten edits.
            await ctx.log(`[Overwrite Check] ${path} already includes the overwritten edits.`, "debug");
            return false;
        }
        await ctx.vault.writeBinary(path, merged);
        const stat = await ctx.vault.stat(path);
        const uploaded = await ctx.adapter.uploadFile(path, merged, stat?.mtime ?? Date.now(), repair.fileId);
        const entry = {
            fileId: uploaded.id,
            mtime: stat?.mtime ?? Date.now(),
            size: uploaded.size,
            hash: uploaded.hash,
            plainHash: await hashContent(merged),
            lastAction: "push" as const,
            // Built on the overwritten version: that device sees its version included.
            ancestorHash: repair.overwrittenHash,
        };
        ctx.index[path] = { ...entry };
        ctx.localIndex[path] = { ...entry };
        ctx.dirtyPaths.delete(path);
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
