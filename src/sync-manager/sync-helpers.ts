import { contentFingerprint } from "./content-fingerprint";
import type { SyncContext } from "./context";
import { parseIndex, providerNameOf, serializeIndex, type DeletionMark, type DeletionMarks, type MergeOrigins } from "./remote-layout";
import { noteIndexFormat } from "./state";
import type { LocalFileIndex } from "./types";
import { tryDecompress, hashContent, isDeviceExcluded } from "./file-utils";
import { storesTransformedContent } from "./content-identity";
import { CtxFlag, CtxState } from "./context-state";
import { capabilitiesOf } from "../types/adapter";
import { leftOutUnderAppliedScope, noteSkippedOutOfScope } from "./sync-scope";


/** What this module reads from the sync context */
export type SyncHelpersCtx = Pick<
    SyncContext,
    | "adapter"
    | "e2eeEnabled"
    | "index"
    | "localIndex"
    | "log"
    | "pluginDataPath"
    | "settings"
    | "startPageToken"
>;

export async function computeLocalHash(
    ctx: SyncHelpersCtx,
    content: ArrayBuffer,
    indexEntry: { hash?: string; plainHash?: string },
    /** contentFingerprint(content) if the caller already computed it */
    rawMd5?: string,
): Promise<{ localHash: string; compareHash: string | undefined }> {
    // An entry without plainHash (written before it existed) is compared by hash
    const usePlain = storesTransformedContent(ctx) && !!indexEntry.plainHash;
    const localHash = usePlain ? await hashContent(content) : (rawMd5 ?? contentFingerprint(content));
    const compareHash = usePlain ? indexEntry.plainHash : indexEntry.hash;
    return { localHash, compareHash };
}

export async function downloadRemoteIndex(ctx: SyncHelpersCtx, fileId: string): Promise<LocalFileIndex> {
    return (await downloadRemoteIndexData(ctx, fileId)).index;
}

/** The remote index plus the Changes API token its writer had when uploading it. */
export async function downloadRemoteIndexData(
    ctx: SyncHelpersCtx,
    fileId: string,
): Promise<{ index: LocalFileIndex; startPageToken: string | null }> {
    const data = await parseRemoteIndexBytes(ctx, await ctx.adapter.downloadFile(fileId));
    lastReadRemoteIndex.set(ctx, data.index);
    return data;
}

/**
 * Cloud version -> the versions it was merged from (its "includes" in the shared
 * index), as read here. An index upload of another device may already have
 * replaced that entry when our merge on top of it is uploaded.
 */
const knownIncludes = new CtxState<Map<string, string[]>>("knownIncludes", "Versions each cloud version was merged from, as read");
/** At most this many are kept (the newest), here and in the shared index */
const KNOWN_INCLUDES_MAX = 300;

function noteIncludes(ctx: SyncHelpersCtx, hash: string, from: string[]): void {
    if (!hash || from.length === 0) return;
    let m = knownIncludes.get(ctx);
    if (!m) knownIncludes.set(ctx, (m = new Map<string, string[]>()));
    const key = hash.toLowerCase();
    const all = [...new Set([...(m.get(key) ?? []), ...from.map((h) => String(h).toLowerCase())])].slice(0, 8);
    m.delete(key);
    m.set(key, all);
    while (m.size > KNOWN_INCLUDES_MAX) m.delete(m.keys().next().value as string);
}

function learnIncludes(ctx: SyncHelpersCtx, index: LocalFileIndex, merges: MergeOrigins): void {
    for (const [h, from] of Object.entries(merges)) if (Array.isArray(from)) noteIncludes(ctx, h, from);
    for (const e of Object.values(index)) if (e.hash && e.includes?.length) noteIncludes(ctx, e.hash, e.includes);
}

function mergeOriginsForUpload(ctx: SyncHelpersCtx, index: LocalFileIndex): MergeOrigins {
    learnIncludes(ctx, index, {});
    const out: MergeOrigins = {};
    for (const [h, from] of knownIncludes.get(ctx) ?? []) out[h] = from;
    return out;
}

/** The versions the cloud version with this hash was merged from, as far as known here */
export function includesOf(ctx: SyncHelpersCtx, hash: string | undefined): string[] {
    return (hash && knownIncludes.get(ctx)?.get(hash.toLowerCase())) || [];
}

/**
 * The shared index as this device last read or wrote it. Files this device
 * leaves out are never in its own index: their entries are taken from here
 * when the shared index has not changed since, or an upload dropped them
 * from the shared index and devices doing their first sync never got them.
 */
const lastReadRemoteIndex = new CtxState<LocalFileIndex>(
    "lastReadRemoteIndex",
    "The shared index as last read or written (source of the entries of files left out here)",
);

/** The shared index as last read here (null: not read since start) */
export function lastRemoteIndex(ctx: object): LocalFileIndex | null {
    return lastReadRemoteIndex.get(ctx) ?? null;
}

async function parseRemoteIndexBytes(
    ctx: SyncHelpersCtx,
    content: ArrayBuffer,
): Promise<{ index: LocalFileIndex; startPageToken: string | null }> {
    const decompressed = await tryDecompress(content);
    const parsed = parseIndex(new TextDecoder().decode(decompressed), providerNameOf(ctx.adapter));
    await noteIndexFormat(ctx, parsed, "remote");
    learnDeletionMarks(ctx, parsed.deleted);
    learnIncludes(ctx, parsed.index, parsed.merges);
    return { index: parsed.index, startPageToken: parsed.startPageToken };
}

/**
 * Deletion marks: which cloud version a device checked right before deleting a
 * file. The cloud cannot delete "only if unchanged", so another device's upload
 * can land between that check and the delete. The uploading device compares the
 * mark with its own upload: a different version means the deletion never saw its
 * edit, and the edit is uploaded again instead of being deleted with the file.
 */
const knownDeletionMarks = new CtxState<DeletionMarks>("knownDeletionMarks", "Deletion marks read from the shared index or written by us");
/** Marks are kept this long, and at most this many */
const DELETION_MARK_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DELETION_MARK_MAX = 1000;

function learnDeletionMarks(ctx: object, marks: DeletionMarks): void {
    const known = knownDeletionMarks.get(ctx) ?? {};
    for (const [id, m] of Object.entries(marks)) {
        if (!m || typeof m.at !== "number") continue;
        if (!known[id] || known[id].at < m.at) known[id] = m;
    }
    knownDeletionMarks.set(ctx, known);
}

/** Record that we deleted cloud file `fileId` after seeing version `hash` there. */
export function noteDeletionMark(ctx: object, fileId: string, hash: string | undefined): void {
    const mark: DeletionMark = { at: Date.now() };
    if (hash) mark.hash = hash.toLowerCase();
    learnDeletionMarks(ctx, { [fileId]: mark });
}

/** The mark another device (or we) left when deleting `fileId`, if known. */
export function deletionMarkOf(ctx: object, fileId: string): DeletionMark | undefined {
    return knownDeletionMarks.get(ctx)?.[fileId];
}

/** Marks for the next index upload: every known one, recent first, pruned. */
function deletionMarksForUpload(ctx: object): DeletionMarks {
    const now = Date.now();
    const entries = Object.entries(knownDeletionMarks.get(ctx) ?? {})
        .filter(([, m]) => now - m.at < DELETION_MARK_TTL_MS)
        .sort((a, b) => b[1].at - a[1].at)
        .slice(0, DELETION_MARK_MAX);
    const kept = Object.fromEntries(entries);
    knownDeletionMarks.set(ctx, kept);
    return kept;
}

export function getThresholdBytes(ctx: SyncHelpersCtx): number {
    return (ctx.settings.largeFileThresholdMB ?? 0) * 1024 * 1024;
}

export function generateTransferId(direction: "push" | "pull"): string {
    return `bg-${direction}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function markPendingTransfer(
    ctx: SyncHelpersCtx,
    path: string,
    direction: "push" | "pull",
    snapshotHash: string,
): void {
    if (ctx.localIndex[path]) {
        ctx.localIndex[path].pendingTransfer = {
            direction,
            enqueuedAt: Date.now(),
            snapshotHash,
        };
    }
}

/**
 * Build the sync-index.json payload to upload.
 *
 * Every device used to upload its own `ctx.index` wholesale, so when two devices
 * pushed close together the later upload silently dropped the entries the other
 * one had just added (last writer wins). Devices that sync from the index (new
 * devices, devices without a Changes API token) then never received those files.
 *
 * Here we re-read the remote index right before uploading and keep entries that
 * other devices added or updated since we last saw it:
 *  - remote-only entries are kept unless we moved that fileId elsewhere, or the
 *    file no longer exists on the remote (we deleted it);
 *  - entries we did not change in this cycle (lastAction "pull") take the remote
 *    value when it differs, so we never revert another device's newer push.
 * The download is skipped when the remote index is still the one we last saw.
 * Any failure falls back to uploading our own index (the previous behaviour).
 */
/**
 * Entries our last index upload took over from other devices but that our own
 * index does not have yet (a file not pulled yet: deferred to the background
 * queue, or its pull failed). When the remote index is still our own upload, the
 * merge below is skipped, and the next upload used to drop these entries again:
 * devices doing their first sync from the shared index then never got the file.
 */
const resolveInline = new CtxState<Set<string>>("resolveInline", "Large files the background queue handed back because the cloud copy changed");

/**
 * The background queue found the cloud copy of a large file changed and handed the
 * file back to the sync cycle. The push must then upload it inline (with its
 * conflict handling) instead of deferring it to the queue again: deferring sent it
 * straight back, forever, and the edit never reached the cloud.
 */
export function handBackToSyncCycle(ctx: object, path: string): void {
    let set = resolveInline.get(ctx);
    if (!set) resolveInline.set(ctx, (set = new Set()));
    set.add(path);
}

/** True (once) when the push must not defer this path to the background queue. */
export function takeHandBack(ctx: object, path: string): boolean {
    return resolveInline.get(ctx)?.delete(path) ?? false;
}

const indexUploadOwed = new CtxFlag("indexUploadOwed", "The shared index upload failed; the next push uploads it even with nothing else to do");

/**
 * The shared index could not be uploaded (files were pushed, but the index that
 * lists them was not). Without a retry, a later sync with nothing to push never
 * uploaded it, and devices doing their first sync from the cloud's index never
 * received those files. Kept in memory and, when the entry exists, in the saved
 * index (forcePush on the index's own entry), so a restart keeps the debt.
 */
export function markIndexUploadOwed(ctx: Pick<SyncContext, "index" | "pluginDataPath">): void {
    indexUploadOwed.add(ctx);
    const own = ctx.index[ctx.pluginDataPath];
    if (own) own.forcePush = true;
    // Never uploaded yet (no entry): record the debt anyway, or a restart forgot it and
    // the files just pushed stayed out of the shared index
    else ctx.index[ctx.pluginDataPath] = { fileId: "", mtime: 0, size: 0, hash: "", forcePush: true };
}

export function owesIndexUpload(ctx: Pick<SyncContext, "index" | "pluginDataPath">): boolean {
    return indexUploadOwed.has(ctx) || !!ctx.index[ctx.pluginDataPath]?.forcePush;
}

export function clearIndexUploadOwed(ctx: Pick<SyncContext, "index" | "pluginDataPath">): void {
    indexUploadOwed.delete(ctx);
}

const indexMergedFrom = new CtxState<string>("indexMergedFrom", "Hash of the cloud index our next index upload is merged with");

/**
 * The cloud cannot replace a file only if it is unchanged, so another device can
 * upload its index between our read (to merge) and our upload. Ours then replaced
 * theirs and the files they had just pushed were missing from the shared index:
 * a device doing its first sync from it never received them. When the revision
 * before ours is not the one we merged with, upload again on the next sync (by
 * then the pull has brought their changes into our index).
 */
export async function checkIndexOverwrite(ctx: SyncContext, uploaded: { id: string; hash?: string }): Promise<void> {
    const mergedFrom = indexMergedFrom.get(ctx);
    indexMergedFrom.delete(ctx);
    if (mergedFrom === undefined || !uploaded.hash || !capabilitiesOf(ctx.adapter).revisions) return;
    if (!ctx.adapter.listRevisions) return;
    try {
        const revisions = [...(await ctx.adapter.listRevisions(ctx.pluginDataPath, uploaded.id))].sort(
            (a, b) => a.modifiedTime - b.modifiedTime,
        );
        const ours = revisions.map((r) => r.hash?.toLowerCase()).lastIndexOf(uploaded.hash.toLowerCase());
        if (ours < 0) return;
        const before = ours > 0 ? revisions[ours - 1].hash?.toLowerCase() : "";
        if (before === undefined || before === mergedFrom) return;
        markIndexUploadOwed(ctx);
        await ctx.log("[Index] Another device uploaded the index at the same time. Uploading ours again next sync.", "info");
        // Ours replaced theirs: files only their index listed (a file it pushed that we
        // never saw as a change) would vanish from the shared index and never reach this
        // device. Pull them, which also puts them back into our next index upload.
        if (ours > 0 && ctx.adapter.getRevisionContent) {
            const bytes = await ctx.adapter.getRevisionContent(ctx.pluginDataPath, revisions[ours - 1].id, uploaded.id);
            await owePullsFromIndex(ctx, (await parseRemoteIndexBytes(ctx, bytes)).index);
        }
    } catch {
        // History unavailable: nothing to check against
    }
}

/**
 * Files another device's index lists that this device has never pulled (not in our
 * index by path or by id, still in the cloud): owed as pulls to the next sync.
 */
async function owePullsFromIndex(ctx: SyncContext, remote: LocalFileIndex): Promise<void> {
    const ourIds = new Set(Object.values(ctx.index).map((e) => e.fileId).filter(Boolean));
    const pending = pendingPullsOf(ctx);
    for (const [path, entry] of Object.entries(remote)) {
        if (path === ctx.pluginDataPath || !entry.fileId || ctx.index[path] || ourIds.has(entry.fileId)) continue;
        if (pending.has(entry.fileId) || ctx.dirtyPaths.has(path)) continue;
        if (isDeviceExcluded(ctx, path)) {
            // Left out here: never pulled, but the shared index must keep listing
            // it (ours just replaced theirs). Our next upload takes it from here.
            let relist = relistForOthers.get(ctx);
            if (!relist) relistForOthers.set(ctx, (relist = {}));
            relist[path] = entry;
            // The shared index may never list it again: pulled by id once synced here
            noteSkippedOutOfScope(ctx, path, entry, true);
            continue;
        }
        if (!(await ctx.adapter.fileExistsById(entry.fileId).catch(() => false))) continue;
        oweUnseenPull(ctx, path, entry);
        await ctx.log(`[Index] ${path} is listed by another device but was never pulled here. Pulling it next sync.`, "info");
    }
}

/**
 * Entries of an index ours replaced, for files this device leaves out (so never
 * pulls, and its own index never lists): the next upload lists them again.
 */
const relistForOthers = new CtxState<LocalFileIndex>("relistForOthers", "Entries of a replaced index for files left out here, listed again by the next upload");

/** A cloud file left out here that the shared index may not list: the next upload lists it */
export function relistForOthersAdd(ctx: object, path: string, entry: LocalFileIndex[string]): void {
    let relist = relistForOthers.get(ctx);
    if (!relist) relistForOthers.set(ctx, (relist = {}));
    relist[path] = entry;
}

export function oweUnseenPull(ctx: SyncHelpersCtx & { dirtyPaths?: Map<string, number> }, path: string, entry: LocalFileIndex[string]): void {
    if (!entry.fileId || ctx.dirtyPaths?.has(path)) return;
    if (ctx.settings && isDeviceExcluded({ settings: ctx.settings }, path)) return; // left out here
    const pending = pendingPullsOf(ctx);
    if (pending.has(entry.fileId)) return;
    pending.set(entry.fileId, {
        file: { id: entry.fileId, path, hash: entry.hash, size: entry.size ?? 0, mtime: entry.mtime },
        attempts: 0,
    });
}

const carriedRemoteEntries = new CtxState<LocalFileIndex>("carriedRemoteEntries", "Remote index entries kept for files this device has not pulled yet");

/**
 * Our own upload (made before this device started leaving the file out): the
 * shared index may not list it yet, and dropping it here hid the file from
 * every device that skipped its change while leaving it out.
 */
function ownUpload(entry: LocalFileIndex[string] | undefined): boolean {
    return !!entry && (entry.lastAction === "push" || entry.lastAction === "merge");
}

export async function buildRemoteIndexPayload(ctx: SyncHelpersCtx): Promise<ArrayBuffer> {
    const merged: LocalFileIndex = { ...ctx.index };
    // The cloud's index could not be read (network): give up instead of uploading
    // ours as-is. Ours may lack entries another device wrote (a file it pushed but we
    // have not pulled yet); replacing the shared index with it hid that file from
    // every device doing its first sync later. The caller retries on the next sync.
    let readingRemote = true;
    try {
        const meta = await ctx.adapter.getFileMetadata(ctx.pluginDataPath);
        readingRemote = false;
        indexMergedFrom.set(ctx, meta?.hash?.toLowerCase() ?? "");
        const lastSeen = ctx.index[ctx.pluginDataPath]?.hash?.toLowerCase() || "";
        if (meta?.id && meta.hash && meta.hash.toLowerCase() === lastSeen) {
            if (!knownDeletionMarks.has(ctx) || !lastReadRemoteIndex.has(ctx)) {
                // Not read since the app started: read it once, or our upload would drop
                // the deletion marks other devices left in it, and the entries of files
                // this device leaves out (never in our own index).
                readingRemote = true;
                const read = await parseRemoteIndexBytes(ctx, await ctx.adapter.downloadFile(meta.id));
                readingRemote = false;
                if (!lastReadRemoteIndex.has(ctx)) lastReadRemoteIndex.set(ctx, read.index);
            }
            const carried = carriedRemoteEntries.get(ctx) ?? {};
            // Files left out here: the shared index has not changed since we last read
            // (or wrote) it, so its entries are current. No lookups needed.
            const last = lastReadRemoteIndex.get(ctx);
            if (last) {
                for (const p of Object.keys(merged)) {
                    if (p !== ctx.pluginDataPath && isDeviceExcluded(ctx, p) && !last[p] && !ownUpload(merged[p])) delete merged[p];
                }
                for (const [p, e] of Object.entries(last)) {
                    if (p !== ctx.pluginDataPath && isDeviceExcluded(ctx, p)) merged[p] = e;
                    // Synced again by settings not applied yet: not pulled here so far
                    else if (p !== ctx.pluginDataPath && !merged[p] && leftOutUnderAppliedScope(ctx, p)) merged[p] = e;
                }
            }
            for (const [path, entry] of Object.entries(carried)) {
                if (path !== ctx.pluginDataPath && isDeviceExcluded(ctx, path)) continue; // taken above
                const mine = ctx.index[path];
                const caughtUp =
                    !!mine &&
                    (mine.lastAction === "push" ||
                        mine.lastAction === "merge" ||
                        !!mine.forcePush ||
                        !!mine.pendingMove ||
                        (!!mine.hash && !!entry.hash && mine.hash.toLowerCase() === entry.hash.toLowerCase()));
                if (caughtUp) {
                    delete carried[path];
                    continue;
                }
                if (!mine && entry.fileId) {
                    // Gone since (we deleted or moved it): don't bring it back.
                    const movedByUs = Object.values(ctx.index).some((e) => e.fileId === entry.fileId);
                    const exists = movedByUs
                        ? false
                        : await ctx.adapter.fileExistsById(entry.fileId).catch(() => true);
                    if (!exists) {
                        delete carried[path];
                        pendingPulls.get(ctx)?.delete(entry.fileId); // nothing left to pull
                        continue;
                    }
                }
                merged[path] = entry;
            }
        } else if (meta?.id && meta.hash) {
            readingRemote = true;
            const bytes = await ctx.adapter.downloadFile(meta.id);
            readingRemote = false;
            const remote = (await parseRemoteIndexBytes(ctx, bytes)).index;
            const ourPathById = new Map<string, string>();
            for (const [p, e] of Object.entries(ctx.index)) if (e.fileId) ourPathById.set(e.fileId, p);
            const changedByUs = (e: LocalFileIndex[string] | undefined) =>
                !!e &&
                (e.lastAction === "push" || e.lastAction === "merge" || !!e.forcePush || !!e.pendingMove);
            let kept = 0;
            for (const [path, entry] of Object.entries(remote)) {
                if (path === ctx.pluginDataPath) continue;
                const mine = ctx.index[path];
                if (!mine) {
                    const ourPath = entry.fileId ? ourPathById.get(entry.fileId) : undefined;
                    if (ourPath !== undefined) {
                        // Same file under another path. If WE moved it, our path wins. If not,
                        // ANOTHER device renamed it and our entry is just stale: keeping ours
                        // (as before) reverted their rename in the shared index, and devices
                        // doing their first sync from it then created the note at the old path.
                        if (changedByUs(ctx.index[ourPath])) continue;
                        // We may also have moved it ourselves while pulling (a name
                        // collision rename): ask the cloud which name is current.
                        const actual = await ctx.adapter
                            .getFileMetadataById(entry.fileId, ourPath)
                            .catch(() => null);
                        if (actual?.path === ourPath) continue;
                        delete merged[ourPath];
                    } else if (
                        entry.fileId &&
                        !(await ctx.adapter.fileExistsById(entry.fileId).catch(() => true))
                    ) {
                        continue; // deleted (on a lookup error keep the entry: dropping
                        // it would hide the file from devices doing their first sync)
                    } else if (entry.fileId) {
                        // Another device's file that never reached us (our Changes token
                        // may start after its upload): pull it, or it stays missing here.
                        oweUnseenPull(ctx, path, entry);
                    }
                    merged[path] = entry;
                    kept++;
                } else if (
                    mine.lastAction !== "push" &&
                    mine.lastAction !== "merge" &&
                    !mine.forcePush &&
                    entry.hash &&
                    mine.hash &&
                    entry.hash.toLowerCase() !== mine.hash.toLowerCase()
                ) {
                    merged[path] = entry;
                    kept++;
                }
            }
            // Files this device leaves out: it never changes them, so the cloud's
            // entries win (our copy is stale: an edit, rename or delete made elsewhere
            // would be undone in the shared index).
            for (const p of Object.keys(merged)) {
                if (p !== ctx.pluginDataPath && isDeviceExcluded(ctx, p) && !remote[p] && !ownUpload(merged[p])) delete merged[p];
            }
            for (const [p, e] of Object.entries(remote)) {
                if (p !== ctx.pluginDataPath && isDeviceExcluded(ctx, p)) merged[p] = e;
                // Synced again by settings not applied yet: not pulled here so far
                else if (p !== ctx.pluginDataPath && !merged[p] && leftOutUnderAppliedScope(ctx, p)) merged[p] = e;
            }
            const carried: LocalFileIndex = {};
            for (const [path, entry] of Object.entries(merged)) {
                if (entry !== ctx.index[path]) carried[path] = entry;
            }
            carriedRemoteEntries.set(ctx, carried);
            if (kept > 0) {
                await ctx.log(
                    `[Index] Merged ${kept} entr${kept === 1 ? "y" : "ies"} written by other devices into the remote index.`,
                    "info",
                );
            }
        }
    } catch (e) {
        if (readingRemote) throw e;
        // Unreadable (damaged) cloud index: ours replaces it
        await ctx.log(`[Index] Could not merge remote index, uploading local index as-is: ${String(e)}`, "warn");
    }
    const relist = relistForOthers.get(ctx);
    relistForOthers.delete(ctx);
    for (const [p, e] of Object.entries(relist ?? {})) {
        if (merged[p] || !isDeviceExcluded(ctx, p)) continue;
        if (Object.values(merged).some((m) => m.fileId === e.fileId)) continue;
        merged[p] = e;
    }
    // Cloud files we know of but have not pulled yet (deferred to the background queue,
    // or failed). The index carries our Changes token, which is already past them: a
    // device doing its first sync from this index read changes only after that token,
    // so a file missing here was never pulled there at all.
    for (const { file } of pendingPullsOf(ctx).values()) {
        if (!file.path || merged[file.path] || file.path === ctx.pluginDataPath) continue;
        if (Object.values(merged).some((e) => e.fileId === file.id)) continue;
        merged[file.path] = {
            fileId: file.id,
            mtime: file.mtime ?? 0,
            size: file.size,
            hash: file.hash,
        } as LocalFileIndex[string];
    }
    // A local rename not yet applied in the cloud: other devices that sync from this
    // index would pull the file by id under its new name while still holding it under
    // the old one (two copies, and the real move then finds its target taken). List it
    // under the name it still has in the cloud until the move is pushed.
    for (const [p, e] of Object.entries(merged)) {
        if (!e.pendingMove) continue;
        delete merged[p];
        const { pendingMove, forcePush: _f, ...rest } = e;
        if (!merged[pendingMove.oldPath]) merged[pendingMove.oldPath] = rest;
    }
    const own = merged[ctx.pluginDataPath];
    if (own?.forcePush) {
        // Our "index upload owed" mark is local bookkeeping, not for other devices
        const { forcePush: _owed, ...rest } = own;
        merged[ctx.pluginDataPath] = rest;
    }
    // A merge of ours carries the versions the remote version it merged carried
    // (another device's merge of a version our upload had replaced, see
    // overwrite-recovery): kept transitively, a few at most.
    for (const [p, e] of Object.entries(merged)) {
        if (!e.includes || !e.ancestorHash) continue;
        const inherited = includesOf(ctx, e.ancestorHash);
        if (inherited.length === 0) continue;
        merged[p] = { ...e, includes: [...new Set([...e.includes, ...inherited])].slice(0, 8) };
    }
    for (const [p, e] of Object.entries(merged)) {
        if (e.remoteDeletionSeenAt === undefined) continue;
        // Local bookkeeping (a deletion we are checking), not for other devices
        const { remoteDeletionSeenAt: _seen, ...rest } = e;
        merged[p] = rest;
    }
    lastReadRemoteIndex.set(ctx, merged);
    const data = serializeIndex(merged, ctx.startPageToken, providerNameOf(ctx.adapter), deletionMarksForUpload(ctx), mergeOriginsForUpload(ctx, merged));
    return new TextEncoder().encode(data).buffer;
}

/**
 * Uploads whose outcome is unknown (the request failed, but the server may have
 * applied it: "response lost"). path -> md5 of what we sent. When that exact
 * hash later shows up remotely it is our own content, not another device's
 * edit: adopting it avoids overwriting a new local note with it, or a false
 * 3-way conflict between our own older and newer edits.
 */
const attemptedUploads = new CtxState<Map<string, string[]>>("attemptedUploads", "Uploads whose outcome is unknown: hashes per path");
/** Unknown-outcome versions remembered per path (newest last) */
const MAX_ATTEMPTS_PER_PATH = 3;

export function recordAttemptedUpload(ctx: SyncHelpersCtx, path: string, hash: string): void {
    let m = attemptedUploads.get(ctx);
    if (!m) attemptedUploads.set(ctx, (m = new Map<string, string[]>()));
    const h = hash.toLowerCase();
    const list = (m.get(path) ?? []).filter((x) => x !== h);
    list.push(h);
    m.set(path, list.slice(-MAX_ATTEMPTS_PER_PATH));
}

/** Returns true (and forgets the record) if `hash` is what we tried to upload to `path`. */
export function takeAttemptedUpload(ctx: SyncHelpersCtx, path: string, hash: string | undefined): boolean {
    if (!isAttemptedUpload(ctx, path, hash)) return false;
    attemptedUploads.get(ctx)!.delete(path);
    return true;
}

/** Whether `hash` is one of our uploads to `path` with an unknown outcome */
export function isAttemptedUpload(ctx: SyncHelpersCtx, path: string, hash: string | undefined): boolean {
    const list = attemptedUploads.get(ctx)?.get(path);
    return !!list && !!hash && list.includes(hash.toLowerCase());
}

/** The hash we last tried to upload to `path` with an unknown outcome, if any. */
export function peekAttemptedUpload(ctx: SyncHelpersCtx, path: string): string | undefined {
    const list = attemptedUploads.get(ctx)?.get(path);
    return list?.[list.length - 1];
}

/** Every version we tried to upload to `path` with an unknown outcome, newest first. */
export function attemptedUploadsOf(ctx: SyncHelpersCtx, path: string): string[] {
    return [...(attemptedUploads.get(ctx)?.get(path) ?? [])].reverse();
}

/** Forget the unknown-outcome upload of `path` (a later upload succeeded). */
export function forgetAttemptedUpload(ctx: SyncHelpersCtx, path: string): void {
    attemptedUploads.get(ctx)?.delete(path);
}

/**
 * The file was renamed here: its unknown-outcome uploads went to the same cloud file,
 * now known by the new name. Without them a merge after the rename took the version
 * before that upload as the base, and the uploaded lines looked like a remote change.
 */
export function moveAttemptedUploads(ctx: SyncHelpersCtx, from: string, to: string): void {
    const m = attemptedUploads.get(ctx);
    const list = m?.get(from);
    if (!list) return;
    m!.delete(from);
    m!.set(to, list);
}

/** Forget only the given version (an upload of it was never sent). */
export function forgetAttemptedVersion(ctx: SyncHelpersCtx, path: string, hash: string | undefined): void {
    const m = attemptedUploads.get(ctx);
    const list = m?.get(path);
    if (!list || !hash) return;
    const rest = list.filter((x) => x !== hash.toLowerCase());
    if (rest.length) m!.set(path, rest);
    else m!.delete(path);
}

/** The unknown-outcome uploads, for persisting with the local index */
export function attemptedUploadsSnapshot(ctx: SyncHelpersCtx): Record<string, string[]> | undefined {
    const m = attemptedUploads.get(ctx);
    return m && m.size > 0 ? Object.fromEntries(m) : undefined;
}

/**
 * Restore persisted unknown-outcome uploads (plugin startup). A killed app does not
 * know whether its last uploads arrived; without the record, its own new note came
 * back as "another device's version" and the local copy became a conflict file.
 */
export function restoreAttemptedUploads(ctx: SyncHelpersCtx, data: unknown): void {
    if (!data || typeof data !== "object") return;
    let m = attemptedUploads.get(ctx);
    if (!m) attemptedUploads.set(ctx, (m = new Map<string, string[]>()));
    for (const [path, hashes] of Object.entries(data as Record<string, unknown>)) {
        const list = (Array.isArray(hashes) ? hashes : [hashes]).filter(
            (h): h is string => typeof h === "string",
        );
        if (list.length && !m.has(path)) m.set(path, list.map((h) => h.toLowerCase()));
        if (list.length) priorRunAttempts.set(ctx, { ...(priorRunAttempts.get(ctx) ?? {}), [path]: list.map((h) => h.toLowerCase()) });
    }
    priorRunSince.set(ctx, Date.now());
}

/**
 * Uploads the previous app run started and never confirmed. The killed app's request
 * may still be processed by the server a moment after the restart, and then replace
 * a version another device uploaded meanwhile (see watchLateLanding).
 */
const priorRunAttempts = new CtxState<Record<string, string[]>>("priorRunAttempts", "Unconfirmed uploads of the previous app run");
const priorRunSince = new CtxState<number>("priorRunSince", "When the previous run's unconfirmed uploads were restored");
/** How long after a restart an upload of the previous run may still land. */
export const PRIOR_RUN_LANDING_MS = 2 * 60 * 1000;

/** The previous run's unconfirmed uploads of `path`, while they may still land. */
export function takePriorRunAttempts(ctx: SyncHelpersCtx, path: string): string[] {
    const all = priorRunAttempts.get(ctx);
    const list = all?.[path];
    if (!list) return [];
    delete all[path];
    if (Date.now() - (priorRunSince.get(ctx) ?? 0) > PRIOR_RUN_LANDING_MS) return [];
    return list;
}

/**
 * Changes API changes whose file has not been pulled yet: the pull failed, or the
 * file went to the background queue. The page token has already moved past them,
 * so this list is the only record that they are still owed. It is persisted with
 * the local index: when the app was killed (or the queue gave up), those files
 * otherwise kept their old version on this device until they changed again.
 */
export interface PendingPull {
    file: { id: string; path: string; hash?: string; size: number; [key: string]: unknown };
    attempts: number;
    /** Handed to the background queue (not retried inline while it is queued there) */
    background?: boolean;
}

const pendingPulls = new CtxState<Map<string, PendingPull>>("pendingPulls", "Pulls owed to a later sync, by file id");

export function pendingPullsOf(ctx: SyncHelpersCtx): Map<string, PendingPull> {
    let m = pendingPulls.get(ctx);
    if (!m) pendingPulls.set(ctx, (m = new Map<string, PendingPull>()));
    return m;
}

/** The background queue finished (or dropped) the pull of this file */
export function settlePendingPull(ctx: SyncHelpersCtx, fileId: string | undefined): void {
    if (fileId) pendingPulls.get(ctx)?.delete(fileId);
}

/** The background queue gave up: let the Changes API retry pull it inline */
export function releasePendingPull(ctx: SyncHelpersCtx, fileId: string | undefined): void {
    const p = fileId ? pendingPulls.get(ctx)?.get(fileId) : undefined;
    if (p) p.background = false;
}

export function pendingPullsSnapshot(ctx: SyncHelpersCtx): Record<string, PendingPull> | undefined {
    const m = pendingPulls.get(ctx);
    if (!m || m.size === 0) return undefined;
    const out: Record<string, PendingPull> = {};
    for (const [id, p] of m) {
        const { id: fid, path, hash, size } = p.file;
        out[id] = { file: { id: fid, path, hash, size }, attempts: p.attempts };
    }
    return out;
}

export function restorePendingPulls(ctx: SyncHelpersCtx, data: unknown): void {
    if (!data || typeof data !== "object") return;
    const m = pendingPullsOf(ctx);
    for (const [id, p] of Object.entries(data as Record<string, PendingPull>)) {
        if (!p?.file?.id || typeof p.file.path !== "string" || m.has(id)) continue;
        // The background queue did not survive the restart: retry inline
        m.set(id, { file: p.file, attempts: Number(p.attempts) || 0 });
    }
}
