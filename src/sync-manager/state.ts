import { appliedScopeOf, restoreAppliedScope } from "./sync-scope";
import { overwriteRepairsSnapshot, restoreOverwriteRepairs } from "./overwrite-recovery";
import { plainHashVersion, restorePlainHashVersion } from "./plain-hash-migration";
import { contentFingerprint } from "./content-fingerprint";
import { parseIndex, providerNameOf, serializeIndex, type ParsedIndex } from "./remote-layout";
import { toHex } from "../utils/format";
import { normalizePath, dirname } from "../utils/path";
import type { SyncContext } from "./context";
import type { CommunicationData, LocalFileIndex, MergeLockEntry } from "./types";
import { ensureLocalFolder, holdsDeviceExcluded, isDeviceExcluded, shouldIgnore, takeOwnFolderEvent } from "./file-utils";
import {
    LOCK_MAX_ATTEMPTS,
    LOCK_TTL_MS,
    LOCK_JITTER_MIN_MS,
    LOCK_JITTER_RANGE_MS,
} from "./constants";
import {
    attemptedUploadsSnapshot,
    restoreAttemptedUploads,
    pendingPullsSnapshot,
    restorePendingPulls,
    peekAttemptedUpload,
    moveAttemptedUploads,
} from "./sync-helpers";
import { CtxState } from "./context-state";
import { pathKey } from "./path-collision";
import type { FileUtilsCtx } from "./file-utils";
import type { PlainHashCtx } from "./plain-hash-migration";
import type { SyncHelpersCtx } from "./sync-helpers";

/** What this module reads from the sync context */
export type StateCtx = Pick<
    SyncContext,
    | "adapter"
    | "communicationPath"
    | "deletedFolders"
    | "deviceId"
    | "dirtyPaths"
    | "e2eeEnabled"
    | "index"
    | "indexLoadFailed"
    | "localIndex"
    | "localIndexPath"
    | "log"
    | "logFolder"
    | "pendingFolderMoves"
    | "pluginDataPath"
    | "pluginDir"
    | "revisionCache"
    | "startPageToken"
    | "syncState"
    | "syncingPaths"
    | "unicodeInsensitiveFs"
    | "caseInsensitiveFs"
    | "vault"
> & FileUtilsCtx & PlainHashCtx & SyncHelpersCtx;

function generateDeviceId(): string {
    const randomArray = new Uint8Array(4);
    if (typeof crypto !== "undefined") crypto.getRandomValues(randomArray);
    const suffix = toHex(randomArray);
    return contentFingerprint(new TextEncoder().encode(Date.now().toString() + suffix).buffer).substring(0, 8);
}

// === Per-sync-cycle state (performance) ===
//
// communication.json (merge locks) used to be fetched from the cloud for every
// single pulled file (checkMergeLock) and read-modify-written 2-3 times per
// merge. With parallel pulls that is the dominant API cost, and parallel merges
// on ONE device even raced each other on the read-modify-write (a lost lock,
// then a jittered retry). Within a sync cycle we now
//   - serve read-only lock checks from a short-lived cache,
//   - serialize this device's lock updates and coalesce the ones that are
//     queued at the same time into a single load/save/verify round, and
//   - defer local-index writes (one JSON dump of the whole index per pulled
//     file) to periodic checkpoints and the end of the cycle.
// Outside a cycle (unit tests calling helpers directly) behaviour is unchanged.

/** Max age of the cached communication.json used for read-only lock checks */
export const COMM_CACHE_MAX_AGE_MS = 10_000;
/** While deferring, still write the local index after this many skipped saves (crash safety) */
export const LOCAL_INDEX_CHECKPOINT_EVERY = 50;

interface LockOpResult {
    acquired: boolean;
    holder?: string;
    expiresIn?: number;
    /** Our write was overwritten by another device (worth retrying) */
    contended?: boolean;
}

interface LockOp {
    kind: "acquire" | "release";
    path: string;
    logPrefix?: string;
    resolve: (r: LockOpResult) => void;
    reject: (e: unknown) => void;
}

interface CycleState {
    active: boolean;
    comm: { data: CommunicationData; at: number } | null;
    lockChain: Promise<void>;
    pendingLockOps: LockOp[];
    deferDepth: number;
    localIndexDirty: boolean;
    skippedLocalIndexSaves: number;
    /** Merge locks this device currently holds (acquired and not yet released) */
    heldLocks: Set<string>;
    /** Held locks whose merged result still has to be uploaded (released after the push) */
    locksAwaitingPush: Set<string>;
}

const cycleStates = new CtxState<CycleState>("syncCycle", "Caches and held merge locks of the running sync cycle");

function cycleState(ctx: StateCtx): CycleState {
    let s = cycleStates.get(ctx);
    if (!s) {
        s = {
            active: false,
            comm: null,
            lockChain: Promise.resolve(),
            pendingLockOps: [],
            deferDepth: 0,
            localIndexDirty: false,
            skippedLocalIndexSaves: 0,
            heldLocks: new Set(),
            locksAwaitingPush: new Set(),
        };
        cycleStates.set(ctx, s);
    }
    return s;
}

/** Start of a sync cycle: enable caching, defer local-index writes. */
export function beginSyncCycle(ctx: StateCtx): void {
    const s = cycleState(ctx);
    s.active = true;
    s.comm = null;
    s.deferDepth++;
}

/** End of a sync cycle: drop caches and flush deferred local-index writes. */
export async function endSyncCycle(ctx: StateCtx): Promise<void> {
    const s = cycleState(ctx);
    // A merged result that could not be pushed this cycle: stop blocking other devices.
    for (const path of [...s.locksAwaitingPush]) {
        await releaseMergeLock(ctx, path, "Sync");
    }
    s.active = false;
    s.comm = null;
    s.deferDepth = Math.max(0, s.deferDepth - 1);
    if (s.deferDepth === 0 && s.localIndexDirty) {
        await saveLocalIndex(ctx);
    }
}

function cloneComm(data: CommunicationData): CommunicationData {
    return { ...data, mergeLocks: { ...data.mergeLocks } };
}

function dropExpiredLocks(data: CommunicationData): CommunicationData {
    const now = Date.now();
    for (const [path, lock] of Object.entries(data.mergeLocks)) {
        if (lock.expiresAt < now) {
            delete data.mergeLocks[path];
        }
    }
    return data;
}

// === Communication.json Management ===

/**
 * Load communication.json. Inside a sync cycle a copy cached for up to
 * COMM_CACHE_MAX_AGE_MS is returned unless `fresh` is set; lock updates
 * always read fresh data.
 */
export async function loadCommunication(
    ctx: StateCtx,
    opts: { fresh?: boolean } = {},
): Promise<CommunicationData> {
    const s = cycleState(ctx);
    if (!opts.fresh && s.active && s.comm && Date.now() - s.comm.at < COMM_CACHE_MAX_AGE_MS) {
        return dropExpiredLocks(cloneComm(s.comm.data));
    }
    try {
        const meta = await ctx.adapter.getFileMetadata(ctx.communicationPath);
        let data: CommunicationData;
        if (!meta) {
            data = { mergeLocks: {}, lastUpdated: 0 };
        } else {
            const content = await ctx.adapter.downloadFile(meta.id);
            const text = new TextDecoder().decode(content);
            data = JSON.parse(text) as CommunicationData;
            data.mergeLocks ??= {};
        }
        dropExpiredLocks(data);
        if (s.active) s.comm = { data: cloneComm(data), at: Date.now() };
        return data;
    } catch (e) {
        await ctx.log(`[Communication] Failed to load: ${String(e)}`, "error");
        // A fresh read feeds a read-modify-write of the lock map. Returning an
        // empty map here would make the following save wipe every other
        // device's locks, so surface the error instead.
        if (opts.fresh) throw e;
        return { mergeLocks: {}, lastUpdated: 0 };
    }
}

export async function saveCommunication(ctx: StateCtx, data: CommunicationData): Promise<void> {
    try {
        data.lastUpdated = Date.now();
        const content = new TextEncoder().encode(JSON.stringify(data, null, 2));
        await ctx.adapter.uploadFile(
            ctx.communicationPath,
            content.buffer,
            Date.now(),
        );
        const s = cycleState(ctx);
        if (s.active) s.comm = { data: cloneComm(data), at: Date.now() };
    } catch (e) {
        const s = cycleState(ctx);
        s.comm = null;
        await ctx.log(`[Communication] Failed to save: ${String(e)}`, "error");
        throw e;
    }
}

/**
 * Queue a lock update. Updates queued while another round is in flight are
 * applied together in ONE load -> save -> verify round, so N parallel merges
 * cost ~5 API calls instead of ~5N, and this device never overwrites its own
 * concurrent lock writes.
 */
function enqueueLockOp(
    ctx: StateCtx,
    kind: LockOp["kind"],
    path: string,
    logPrefix?: string,
): Promise<LockOpResult> {
    const s = cycleState(ctx);
    return new Promise<LockOpResult>((resolve, reject) => {
        s.pendingLockOps.push({ kind, path, logPrefix, resolve, reject });
        s.lockChain = s.lockChain.then(() => flushLockOps(ctx));
    });
}

async function flushLockOps(ctx: StateCtx): Promise<void> {
    const s = cycleState(ctx);
    const ops = s.pendingLockOps.splice(0);
    if (ops.length === 0) return;
    try {
        const comm = await loadCommunication(ctx, { fresh: true });
        const now = Date.now();
        const results = new Map<LockOp, LockOpResult>();
        let changed = false;
        const released: LockOp[] = [];

        for (const op of ops) {
            const existing = comm.mergeLocks[op.path];
            if (op.kind === "acquire") {
                const fileId = fileIdOf(ctx, op.path);
                const foreign = findForeignLock(ctx, comm, op.path, fileId, now);
                if (foreign) {
                    results.set(op, {
                        acquired: false,
                        holder: foreign.holder,
                        expiresIn: Math.floor((foreign.expiresAt - now) / 1000),
                    });
                } else {
                    comm.mergeLocks[op.path] = {
                        holder: ctx.deviceId,
                        expiresAt: now + LOCK_TTL_MS,
                        ...(fileId ? { fileId } : {}),
                    };
                    // Count as held from the moment we write it (releaseOrphanedOwnLocks)
                    s.heldLocks.add(op.path);
                    changed = true;
                }
            } else {
                s.heldLocks.delete(op.path);
                s.locksAwaitingPush.delete(op.path);
                if (existing && existing.holder === ctx.deviceId) {
                    delete comm.mergeLocks[op.path];
                    changed = true;
                    released.push(op);
                }
                results.set(op, { acquired: false });
            }
        }

        if (changed) {
            await saveCommunication(ctx, comm);
            for (const op of released) {
                await ctx.log(
                    `[${op.logPrefix || "Communication"}] Merge lock released for ${op.path}.`,
                    "debug",
                );
            }
            const toVerify = ops.filter((op) => op.kind === "acquire" && !results.has(op));
            if (toVerify.length > 0) {
                const verify = await loadCommunication(ctx, { fresh: true });
                for (const op of toVerify) {
                    const lock = verify.mergeLocks[op.path];
                    if (lock && lock.holder === ctx.deviceId) {
                        s.heldLocks.add(op.path);
                        results.set(op, { acquired: true });
                    } else {
                        s.heldLocks.delete(op.path);
                        results.set(op, {
                            acquired: false,
                            contended: true,
                            holder: lock?.holder,
                            expiresIn: lock ? Math.floor((lock.expiresAt - now) / 1000) : 0,
                        });
                    }
                }
            }
        }
        for (const op of ops) op.resolve(results.get(op) ?? { acquired: false });
    } catch (e) {
        for (const op of ops) {
            // A failed release must not leave the lock counted as held: then the next
            // sync's releaseOrphanedOwnLocks skipped it, and other devices waited on it
            // until its TTL ran out (their pending merges stalled meanwhile).
            s.heldLocks.delete(op.path);
            if (op.kind === "release") s.locksAwaitingPush.delete(op.path);
            op.reject(e);
        }
    }
}

export async function acquireMergeLock(
    ctx: StateCtx,
    path: string,
): Promise<{ acquired: boolean; holder?: string; expiresIn?: number }> {
    for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt++) {
        const r = await enqueueLockOp(ctx, "acquire", path);
        if (r.acquired) return { acquired: true };
        if (!r.contended) {
            return { acquired: false, holder: r.holder, expiresIn: r.expiresIn };
        }

        // Verification failed — another device wrote concurrently. Retry with jitter.
        if (attempt < LOCK_MAX_ATTEMPTS - 1) {
            const jitter = LOCK_JITTER_MIN_MS + Math.random() * LOCK_JITTER_RANGE_MS;
            await ctx.log(
                `[Communication] Lock contention for ${path} (attempt ${attempt + 1}/${LOCK_MAX_ATTEMPTS}). Retrying in ${Math.round(jitter)}ms...`,
                "warn",
            );
            await new Promise((r) => window.setTimeout(r, jitter));
        } else {
            return { acquired: false, holder: r.holder, expiresIn: r.expiresIn };
        }
    }

    return { acquired: false };
}

export async function releaseMergeLock(
    ctx: StateCtx,
    path: string,
    logPrefix?: string,
): Promise<void> {
    try {
        await enqueueLockOp(ctx, "release", path, logPrefix);
    } catch (e) {
        await ctx.log(
            `[${logPrefix || "Communication"}] Failed to release lock for ${path}: ${String(e)}`,
            "error",
        );
    }
}

/**
 * Keep the merge lock on `path` until its merged result has been uploaded
 * (see releaseLockAfterPush). Releasing right after the local merge let other
 * devices push in the gap, and the merged upload then overwrote their edit.
 */
/** True while this device holds the merge lock for `path` in the current cycle. */
export function holdsMergeLock(ctx: StateCtx, path: string): boolean {
    return cycleState(ctx).heldLocks.has(path);
}

export function holdMergeLockUntilPush(ctx: StateCtx, path: string): boolean {
    const s = cycleState(ctx);
    // Only inside a sync cycle: its push (or endSyncCycle) is guaranteed to release it
    if (!s.active || !s.heldLocks.has(path)) return false;
    s.locksAwaitingPush.add(path);
    return true;
}

/** Release a lock kept by holdMergeLockUntilPush once the push of `path` finished (or failed). */
export async function releaseLockAfterPush(ctx: StateCtx, path: string): Promise<void> {
    const s = cycleState(ctx);
    if (!s.locksAwaitingPush.has(path)) return;
    await releaseMergeLock(ctx, path, "Smart Push");
}

/**
 * communication.json is read-modify-written by every device without
 * compare-and-swap, so another device that read it just before we released a
 * lock can write our lock back ("ghost lock"); everyone then waits for the
 * TTL. A lock in our name that we do not hold is always such a ghost (or left
 * over from a crash): release it.
 */
export async function releaseOrphanedOwnLocks(ctx: StateCtx, comm: CommunicationData): Promise<void> {
    const s = cycleState(ctx);
    const now = Date.now();
    for (const [path, lock] of Object.entries(comm.mergeLocks)) {
        if (lock.holder === ctx.deviceId && lock.expiresAt > now && !s.heldLocks.has(path)) {
            await ctx.log(`[Communication] Releasing orphaned merge lock on ${path}.`, "debug");
            await releaseMergeLock(ctx, path, "Communication");
        }
    }
}

function fileIdOf(ctx: StateCtx, path: string): string | undefined {
    return ctx.index[path]?.fileId || ctx.localIndex[path]?.fileId || undefined;
}

/**
 * Another device's live lock on this file: by path, or by file id when the
 * other device knows the file under a different path (pending rename).
 */
export function findForeignLock(
    ctx: StateCtx,
    comm: Pick<CommunicationData, "mergeLocks">,
    path: string,
    fileId: string | undefined = fileIdOf(ctx, path),
    now: number = Date.now(),
): (MergeLockEntry & { path: string }) | null {
    const live = (l: MergeLockEntry | undefined) =>
        !!l && l.expiresAt > now && l.holder !== ctx.deviceId;
    const direct = comm.mergeLocks[path];
    if (live(direct)) return { ...direct, path };
    if (!fileId) return null;
    for (const [p, l] of Object.entries(comm.mergeLocks)) {
        if (l.fileId === fileId && live(l)) return { ...l, path: p };
    }
    return null;
}

export async function checkMergeLock(
    ctx: StateCtx,
    path: string,
): Promise<{ locked: boolean; holder?: string; expiresIn?: number }> {
    const comm = await loadCommunication(ctx);
    const now = Date.now();
    const existing = findForeignLock(ctx, comm, path, undefined, now);

    if (existing) {
        return {
            locked: true,
            holder: existing.holder,
            expiresIn: Math.floor((existing.expiresAt - now) / 1000),
        };
    }
    return { locked: false };
}

// === Index Management ===

/** Log what parseIndex() had to adapt (a foreign cursor, a document from a newer build) */
export async function noteIndexFormat(ctx: Pick<SyncContext, "log">, parsed: ParsedIndex, which: "local" | "remote"): Promise<void> {
    if (parsed.cursorDropped) {
        await ctx.log(
            `[Index] The ${which} index cursor belongs to another cloud provider; ignoring it (full comparison instead).`,
            "warn",
        );
    }
    if (parsed.fromNewerBuild) {
        await ctx.log(
            `[Index] The ${which} index was written by a newer version (format ${parsed.formatVersion}). Only the fields this version knows are read; consider updating the plugin on this device.`,
            "warn",
        );
    }
}

export async function loadIndex(
    ctx: StateCtx,
    tryDecompress: (data: ArrayBuffer) => Promise<ArrayBuffer>,
): Promise<void> {
    try {
        const data = await ctx.vault.readBinary(ctx.pluginDataPath);
        const decompressed = await tryDecompress(data);
        const text = new TextDecoder().decode(decompressed);
        const parsed = parseIndex(text, providerNameOf(ctx.adapter));
        ctx.index = parsed.index;
        ctx.startPageToken = parsed.startPageToken;
        await noteIndexFormat(ctx, parsed, "local");

        if (data.byteLength !== decompressed.byteLength) {
            await ctx.log(
                "[Index] Detected compressed local index. Normalizing to plain text...",
                "info",
            );
            await saveIndex(ctx);
        }

        await ctx.revisionCache.init();
        await loadLocalIndex(ctx);
        adoptLocalOnlyEntries(ctx);
    } catch (e) {
        const rawPath = ctx.pluginDataPath.replace(".json", "_raw.json");
        try {
            await ctx.log(
                `[Index] Main load failed (${String(e)}). Attempting fallback to raw index: ${rawPath}`,
                "warn",
            );
            if (await ctx.vault.exists(rawPath)) {
                const data = await ctx.vault.read(rawPath);
                const parsed = parseIndex(data, providerNameOf(ctx.adapter));
                ctx.index = parsed.index;
                ctx.startPageToken = parsed.startPageToken;
                await ctx.log("[Index] Successfully recovered from raw index.", "info");
                await saveIndex(ctx);
                return;
            }
        } catch (rawErr) {
            await ctx.log(`[Index] Raw fallback also failed: ${String(rawErr)}`, "error");
        }

        await ctx.log(`[Index] Fatal load failure. Starting fresh.`, "error");
        ctx.indexLoadFailed = true;
        ctx.index = {};
        ctx.localIndex = {};
        ctx.startPageToken = null;
    }
}

/**
 * The local index is saved after every pull (with a journal), the sync index only at
 * the end of a sync. When the app was killed in between, a pulled file was in the local
 * index only: the next pull did not recognise a rename of it by another device (that
 * goes by the sync index), and the file stayed here under its old name next to the
 * renamed copy. Such entries describe a synced file: take them into the sync index.
 */
function adoptLocalOnlyEntries(ctx: StateCtx): void {
    const knownIds = new Set(Object.values(ctx.index).map((e) => e.fileId).filter(Boolean));
    for (const [path, entry] of Object.entries(ctx.localIndex)) {
        if (path === ctx.pluginDataPath || ctx.index[path] || !entry.fileId || knownIds.has(entry.fileId)) continue;
        // Our own upload is journaled the same way (push), so it is a synced file too
        if ((entry.lastAction !== "pull" && entry.lastAction !== "push") || !entry.hash) continue;
        ctx.index[path] = { ...entry };
        knownIds.add(entry.fileId);
    }
}

export async function loadLocalIndex(ctx: StateCtx): Promise<void> {
    try {
        if (await ctx.vault.exists(ctx.localIndexPath)) {
            const data = await ctx.vault.read(ctx.localIndexPath);
            const parsed = JSON.parse(data) as {
                index?: LocalFileIndex;
                deviceId?: string;
                attemptedUploads?: unknown;
                pendingPulls?: unknown;
                overwriteRepairs?: unknown;
                unsyncedRenames?: unknown;
                journalSeq?: unknown;
                plainHashVersion?: unknown;
                syncScope?: unknown;
            };
            ctx.localIndex = parsed.index || {};
            ctx.deviceId = parsed.deviceId || "";
            journalOf(ctx).seq = typeof parsed.journalSeq === "number" ? parsed.journalSeq : 0;
            // The saved file holds the entries without the journal: only they count as
            // written. Marked after the replay, the replayed entries left the next journal
            // while the saved file still lacked them, and a second app kill lost them (a
            // synced note then had no base and every edit became a conflict copy).
            rememberWritten(ctx);
            await applyJournal(ctx, journalOf(ctx).seq);
            restoreAttemptedUploads(ctx, parsed.attemptedUploads);
            restorePendingPulls(ctx, parsed.pendingPulls);
            restoreOverwriteRepairs(ctx, parsed.overwriteRepairs);
            restoreUnsyncedRenames(ctx, parsed.unsyncedRenames);
            restorePlainHashVersion(ctx, parsed.plainHashVersion, false);
            restoreAppliedScope(ctx, parsed.syncScope);
            // The background queue does not survive a restart. Its owed pulls are in
            // pendingPulls (retried by the next sync) and unpushed files are found by
            // the startup scan, so the markers only kept the device "busy" forever.
            for (const entry of Object.values(ctx.localIndex)) {
                if (entry.pendingTransfer) delete entry.pendingTransfer;
            }

            if (!ctx.deviceId) {
                ctx.deviceId = generateDeviceId();

                // Set folder BEFORE logging
                ctx.logFolder = `${ctx.pluginDir}/logs/${ctx.deviceId}`;
                await ctx.log(`[Local Index] Generated new device ID: ${ctx.deviceId}`, "system");
                await saveLocalIndex(ctx);
            } else {
                const isAlreadyLogged = ctx.logFolder === `${ctx.pluginDir}/logs/${ctx.deviceId}`;
                // Set folder BEFORE logging
                ctx.logFolder = `${ctx.pluginDir}/logs/${ctx.deviceId}`;
                if (!isAlreadyLogged) {
                    await ctx.log(
                        `[Local Index] Loaded successfully. Device ID: ${ctx.deviceId}`,
                        "system",
                    );
                }
            }
        } else {
            // Always start with empty localIndex on a new device.
            // Copying ctx.index would make the plugin think all remote files
            // exist locally, preventing full pull on a fresh device.
            ctx.localIndex = {};
            restorePlainHashVersion(ctx, undefined, true);
            ctx.deviceId = generateDeviceId();

            const isAlreadyLogged = ctx.logFolder === `${ctx.pluginDir}/logs/${ctx.deviceId}`;

            // Set folder BEFORE logging
            ctx.logFolder = `${ctx.pluginDir}/logs/${ctx.deviceId}`;
            if (!isAlreadyLogged) {
                await ctx.log(
                    `[Local Index] Not found. Initialized fresh. Device ID: ${ctx.deviceId}`,
                    "system",
                );
            }
            await saveLocalIndex(ctx);
        }
    } catch (e) {
        const isAlreadyLogged =
            ctx.deviceId && ctx.logFolder === `${ctx.pluginDir}/logs/${ctx.deviceId}`;

        // Fallback device ID
        ctx.deviceId = ctx.deviceId || generateDeviceId();
        ctx.logFolder = `${ctx.pluginDir}/logs/${ctx.deviceId}`;

        if (!isAlreadyLogged) {
            await ctx.log(`[Local Index] Load failed: ${String(e)}`, "error");
        }
        ctx.localIndex = {};
        restorePlainHashVersion(ctx, undefined, true);
    }
}

export async function saveIndex(ctx: StateCtx): Promise<void> {
    const data = serializeIndex(ctx.index, ctx.startPageToken, providerNameOf(ctx.adapter));

    // Ensure parent directory exists (may not on fresh install)
    const dir = ctx.pluginDataPath.replace(/\/[^/]+$/, "");
    if (!(await ctx.vault.exists(dir))) {
        await ctx.vault.mkdir(dir);
    }

    await ctx.vault.write(ctx.pluginDataPath, data);
    // A readable index exists now: the next sync is no longer this device's first
    // (left set, every later sync of the session showed the first-sync screen again)
    ctx.indexLoadFailed = false;

    const rawPath = ctx.pluginDataPath.replace(".json", "_raw.json");
    try {
        await ctx.vault.write(rawPath, data);
    } catch (e) {
        console.error("Vault-Sync: Failed to save raw index backup", e);
    }

    // Never deferred: the index (and its Changes API token) was just written, and a
    // local index older than it means, after the app is killed, files we already
    // pulled look locally modified against a change we will never see again.
    await saveLocalIndex(ctx, true);
}

/**
 * Local-index journal. Inside a sync cycle full writes of the local index are batched
 * (one per LOCAL_INDEX_CHECKPOINT_EVERY changes). If the app was closed in between,
 * files pulled since the last write had no entry after the restart, and the next pull
 * of such a file found "no base" and made a conflict copy. Between full writes only
 * the entries that changed are written, to a small journal applied on load.
 */
interface JournalState {
    /** Entry objects as last written in full (compared by identity) */
    written: Map<string, unknown>;
    seq: number;
    journalDirty: boolean;
}
const journals = new CtxState<JournalState>("indexJournal", "Index entries written since the last full save");

function journalOf(ctx: StateCtx): JournalState {
    let j = journals.get(ctx);
    if (!j) journals.set(ctx, (j = { written: new Map(), seq: 0, journalDirty: false }));
    return j;
}

export function localIndexJournalPath(ctx: StateCtx): string {
    return ctx.localIndexPath.replace(/\.json$/, "") + "-journal.json";
}

function rememberWritten(ctx: StateCtx): void {
    const j = journalOf(ctx);
    j.written = new Map(Object.entries(ctx.localIndex));
}

async function writeJournal(ctx: StateCtx): Promise<void> {
    const j = journalOf(ctx);
    const changed: Record<string, unknown> = {};
    let n = 0;
    for (const [p, e] of Object.entries(ctx.localIndex)) {
        if (j.written.get(p) !== e) {
            changed[p] = e;
            n++;
        }
    }
    for (const p of j.written.keys()) {
        if (!(p in ctx.localIndex)) {
            changed[p] = null;
            n++;
        }
    }
    if (n === 0 && !j.journalDirty) return;
    try {
        await ctx.vault.write(localIndexJournalPath(ctx), JSON.stringify({ seq: j.seq, entries: changed }));
        j.journalDirty = n > 0;
    } catch (e) {
        console.error("Vault-Sync: Failed to write local index journal", e);
    }
}

async function applyJournal(ctx: StateCtx, seq: number): Promise<void> {
    const path = localIndexJournalPath(ctx);
    try {
        if (!(await ctx.vault.exists(path))) return;
        const parsed = JSON.parse(await ctx.vault.read(path)) as {
            seq?: unknown;
            entries?: Record<string, unknown>;
        } | null;
        // Written before the last full write: already contained in it
        if (parsed?.seq !== seq || !parsed.entries) return;
        for (const [p, e] of Object.entries(parsed.entries)) {
            if (e === null) delete ctx.localIndex[p];
            else ctx.localIndex[p] = e as SyncContext["localIndex"][string];
        }
    } catch {
        // a torn journal is ignored: the full index is still consistent
    }
}

export async function saveLocalIndex(ctx: StateCtx, immediate = false): Promise<void> {
    const s = cycleState(ctx);
    if (s.deferDepth > 0 && !immediate) {
        s.localIndexDirty = true;
        if (++s.skippedLocalIndexSaves < LOCAL_INDEX_CHECKPOINT_EVERY) {
            await writeJournal(ctx);
            return;
        }
    }
    s.localIndexDirty = false;
    s.skippedLocalIndexSaves = 0;
    const j = journalOf(ctx);
    try {
        j.seq++;
        const data = JSON.stringify({
            index: ctx.localIndex,
            deviceId: ctx.deviceId,
            attemptedUploads: attemptedUploadsSnapshot(ctx),
            pendingPulls: pendingPullsSnapshot(ctx),
            overwriteRepairs: overwriteRepairsSnapshot(ctx),
            unsyncedRenames: unsyncedRenamesSnapshot(ctx),
            journalSeq: j.seq,
            plainHashVersion: plainHashVersion(ctx),
            syncScope: appliedScopeOf(ctx),
        });
        await ctx.vault.write(ctx.localIndexPath, data);
        rememberWritten(ctx);
    } catch (e) {
        console.error("Vault-Sync: Failed to save local index", e);
    }
}

export async function resetIndex(ctx: StateCtx): Promise<void> {
    ctx.index = {};
    ctx.localIndex = {};
    restorePlainHashVersion(ctx, undefined, true);
    ctx.startPageToken = null;
    ctx.adapter.clearDownloadCache?.();
    await saveIndex(ctx);
}

export function clearPendingPushStates(ctx: StateCtx): void {
    for (const path of Object.keys(ctx.localIndex)) {
        const entry = ctx.localIndex[path];
        if (entry.lastAction === "push" || entry.lastAction === "merge") {
            entry.lastAction = "pull";
        }
    }
}

// === Dirty Path Tracking ===

/**
 * macOS can report a name in decomposed Unicode (NFD: "e" + accent) while the index
 * holds it composed (NFC: "é"), or the other way round. On Windows, macOS and
 * Android a file pulled as "Projects/a.md" lands in an existing "projects" folder and
 * is reported as "projects/a.md" from then on. Both spellings are the same file
 * there, so map an event path onto the index key it refers to (a delete reported
 * under the other spelling was ignored, and the note stayed in the cloud). Only on
 * such file systems: on Linux "Note.md" and "note.md" are two files.
 */
export function indexKeyFor(ctx: StateCtx, path: string): string {
    const nfdAware = !!ctx.unicodeInsensitiveFs;
    const caseAware = !!ctx.caseInsensitiveFs;
    if ((!nfdAware && !caseAware) || ctx.index[path] || ctx.localIndex[path]) return path;
    const fold = (p: string) => {
        const q = nfdAware ? p.normalize("NFC") : p;
        return caseAware ? q.toLowerCase() : q;
    };
    const key = fold(path);
    if (key === path && (!nfdAware || path.normalize("NFD") === path) && !caseAware) return path;
    for (const k of Object.keys(ctx.index)) {
        if (fold(k) !== key) continue;
        // Deleted here and not yet removed from the cloud: a note created now under
        // another spelling is a new note, not that one coming back.
        if (!deleteIntents.get(ctx)?.has(k)) return k;
    }
    return path;
}

export function markDirty(ctx: StateCtx, path: string): void {
    path = indexKeyFor(ctx, normalizePath(path));
    if (shouldIgnore(ctx, path)) return;
    // A folder the pull made to place a note (see ensureLocalFolder)
    if (takeOwnFolderEvent(ctx, "create", path)) return;
    // An edit reported under a name the sync has just moved the note away from (its
    // rename event not here yet): the edit went with the note. Checked at the push
    // (unchanged content is skipped); left unmarked, the moved note kept the edit
    // here only and never uploaded it.
    for (const key of ownRenames.get(ctx)?.keys() ?? []) {
        const [from, to] = key.split("\u0000");
        if (from === path && to && !shouldIgnore(ctx, to)) ctx.dirtyPaths.set(to, Date.now());
    }
    if (ctx.syncingPaths.has(path)) {
        // Usually the echo of our own write, but it can be a user edit typed while the
        // engine still held the path (after its write, until the merge lock was
        // released). Dropping it lost that edit: the file was never pushed and the
        // device stayed different from the cloud. Checked against the index before
        // the next push (recheckEventsDuringSync).
        setOf(eventsDuringSync, ctx).add(path);
        return;
    }
    deleteIntents.get(ctx)?.delete(path); // there again: no longer deleted
    // On a case-insensitive disk a note deleted here and created again under another
    // letter case takes the same place: it cannot sit next to the old name on any such
    // device. Uploading it as a new note while the old one was not yet removed from
    // the cloud wrote the new content into the old cloud file under the OLD name.
    // Treat it as a rename of the deleted note, so the cloud gets the new spelling.
    const replaced = deletedUnderOtherSpelling(ctx, path);
    if (replaced) {
        deleteIntents.get(ctx)?.delete(replaced);
        markRenamed(ctx, replaced, path);
        let m = replacedNotes.get(ctx);
        if (!m) replacedNotes.set(ctx, (m = new Map<string, string>()));
        m.set(path, replaced);
        return;
    }
    ctx.dirtyPaths.set(path, Date.now());
}

/**
 * New notes taken as a rename of a note deleted under another letter case (see
 * markDirty): new path -> deleted path. Only a rename in name: when another device
 * edited the deleted note meanwhile, its edit wins over our delete as usual and the
 * new note gets a name of its own (merging two different notes mangled both).
 */
const replacedNotes = new CtxState<Map<string, string>>("replacedNotes", "New notes taken as a rename of a note deleted under another letter case");

/** The deleted note this new note took the place of, if it is still pending as a rename. */
export function takeReplacedNote(ctx: StateCtx, path: string, oldPath: string): boolean {
    const m = replacedNotes.get(ctx);
    if (m?.get(path) !== oldPath) return false;
    m.delete(path);
    return true;
}

function deletedUnderOtherSpelling(ctx: StateCtx, path: string): string | undefined {
    if (!ctx.caseInsensitiveFs || ctx.index[path]) return undefined;
    const intents = deleteIntents.get(ctx);
    if (!intents || intents.size === 0) return undefined;
    const fold = (p: string) => (ctx.unicodeInsensitiveFs ? p.normalize("NFC") : p).toLowerCase();
    const key = fold(path);
    return [...intents].find((k) => k !== path && fold(k) === key && !!ctx.index[k]);
}

/** Vault edits reported while the engine held the path (see markDirty) */
const eventsDuringSync = new CtxState<Set<string>>("eventsDuringSync", "Vault edits reported while the engine was writing the path; checked before the next push");

/** Takes the paths whose edits arrived while the engine held them (and no longer does). */
export function takeEventsDuringSync(ctx: StateCtx): string[] {
    const set = eventsDuringSync.get(ctx);
    if (!set || set.size === 0) return [];
    const ready = [...set].filter((p) => !ctx.syncingPaths.has(p));
    for (const p of ready) set.delete(p);
    return ready;
}

/**
 * Paths the vault reported as deleted. A synced file that is merely missing when a
 * push runs may instead have been renamed a moment ago, with the rename event still
 * on its way: deleting it from the cloud then made other devices resurrect it under
 * the old name next to the renamed copy. Such a path waits one sync for its event.
 */
const deleteIntents = new CtxState<Set<string>>("deleteIntents", "Paths the user deleted, waiting to be removed from the cloud");
const missingOnce = new CtxState<Map<string, number>>("missingOnce", "Paths found missing, waiting for a late rename event (first seen at)");
/**
 * How long a missing file waits for its rename event. Counted in time as well as in
 * syncs: a sync that starts right after the previous one ran before the event of a
 * rename made a moment earlier, and the file was deleted from the cloud.
 */
export const MISSING_EVENT_GRACE_MS = 3000;

function setOf(map: CtxState<Set<string>>, ctx: StateCtx): Set<string> {
    let s = map.get(ctx);
    if (!s) map.set(ctx, (s = new Set()));
    return s;
}

/** A deletion the sync engine itself established (no vault event will report it). */
export function noteDeleteIntent(ctx: StateCtx, path: string): void {
    setOf(deleteIntents, ctx).add(path);
}

/** The deletion reached the cloud: nothing left to do for this path. */
export function clearDeleteIntent(ctx: StateCtx, path: string): void {
    deleteIntents.get(ctx)?.delete(path);
}

/** The vault reported this path as deleted (the event has arrived). */
export function hasDeleteIntent(ctx: StateCtx, path: string): boolean {
    return !!deleteIntents.get(ctx)?.has(path);
}

/** True when a missing synced file may be deleted remotely now (see deleteIntents). */
export function confirmMissingForDeletion(ctx: StateCtx, path: string): boolean {
    // Kept until the path is written again (markDirty): consuming it here lost it
    // when the sync then failed before the delete, and the retry waited for a
    // rename event that never comes while pulls of the path were held back.
    if (setOf(deleteIntents, ctx).has(path)) {
        missingOnce.get(ctx)?.delete(path);
        return true;
    }
    let seen = missingOnce.get(ctx);
    if (!seen) missingOnce.set(ctx, (seen = new Map<string, number>()));
    const since = seen.get(path);
    if (since !== undefined && Date.now() - since >= MISSING_EVENT_GRACE_MS) {
        seen.delete(path);
        return true;
    }
    if (since === undefined) seen.set(path, Date.now());
    return false;
}

export function markDeleted(ctx: StateCtx, path: string): void {
    path = indexKeyFor(ctx, path);
    if (shouldIgnore(ctx, path)) return;
    if (ctx.index[path]) {
        setOf(deleteIntents, ctx).add(path);
        ctx.dirtyPaths.set(path, Date.now());
        void ctx.log(`[Dirty] Marked for deletion: ${path}`, "debug");
    }
}

export function markFolderDeleted(ctx: StateCtx, folderPath: string): void {
    if (shouldIgnore(ctx, folderPath)) return;
    // An empty folder the pull removed (see removeVacatedFolders)
    if (takeOwnFolderEvent(ctx, "delete", folderPath)) return;
    if (holdsDeviceExcluded(ctx, folderPath, Object.keys(ctx.index))) {
        void ctx.log(`[Dirty] Folder ${folderPath} holds files this device leaves out: its files are deleted one by one`, "debug");
    } else {
        ctx.deletedFolders.add(folderPath);
        void ctx.log(`[Dirty] Marked for deletion (folder root): ${folderPath}`, "debug");
    }

    const prefix = folderPath + "/";
    for (const path of Object.keys(ctx.index)) {
        if (path.startsWith(prefix) && !shouldIgnore(ctx, path)) {
            setOf(deleteIntents, ctx).add(path);
            ctx.dirtyPaths.set(path, Date.now());
            void ctx.log(`[Dirty] Marked for deletion (child): ${path}`, "debug");
        }
    }
}

/**
 * Renames the sync engine itself performs (following a remote rename, resolving a
 * name collision). The vault reports them as user renames, possibly late: by then
 * another file may already be indexed under the old name, and treating the event as
 * a user rename moved THAT file in the cloud too. Such events are ignored.
 */
const ownRenames = new CtxState<Map<string, number>>("ownRenames", "Renames the sync made itself, so their vault events are ignored");

export async function renameLocal(ctx: StateCtx, from: string, to: string): Promise<void> {
    let m = ownRenames.get(ctx);
    if (!m) ownRenames.set(ctx, (m = new Map<string, number>()));
    const key = `${from}\u0000${to}`;
    m.set(key, (m.get(key) ?? 0) + 1);
    try {
        await ensureLocalFolder(ctx, to);
        await ctx.vault.rename(from, to);
    } catch (e) {
        takeOwnRename(ctx, from, to);
        throw e;
    }
}

/**
 * After a remote rename that changed only letter case (or Unicode form), make the
 * folders above `path` use the new spelling too. On a case-insensitive disk a file
 * renamed into "notes/" stays inside the existing "Notes" folder, so the folder
 * itself has to be renamed, or this device keeps the old folder name.
 */
export async function alignFolderSpelling(ctx: StateCtx, path: string): Promise<void> {
    if (!ctx.caseInsensitiveFs) return;
    const segs = path.split("/").slice(0, -1);
    let parent = "";
    for (const seg of segs) {
        let listing: { folders: string[] };
        try {
            listing = await ctx.vault.list(parent || "/");
        } catch {
            return;
        }
        const actual = listing.folders.map((f) => f.split("/").pop()!).find((f) => pathKey(f) === pathKey(seg));
        if (actual === undefined) return;
        if (actual !== seg) {
            const from = parent ? `${parent}/${actual}` : actual;
            const to = parent ? `${parent}/${seg}` : seg;
            // Obsidian may also report a rename for each file inside the folder
            const own = ownRenames.get(ctx) ?? new Map<string, number>();
            ownRenames.set(ctx, own);
            const childPairs = ctx.vault
                .getFiles()
                .filter((f) => f.path.startsWith(from + "/"))
                .map((f) => `${f.path}\u0000${to}${f.path.slice(from.length)}`);
            for (const k of childPairs) own.set(k, (own.get(k) ?? 0) + 1);
            try {
                await renameLocal(ctx, from, to);
                await ctx.log(`[Smart Pull] Folder renamed to follow the cloud: ${from} -> ${to}`, "info");
            } catch (e) {
                for (const k of childPairs) {
                    const n = own.get(k) ?? 0;
                    if (n > 1) own.set(k, n - 1);
                    else own.delete(k);
                }
                await ctx.log(`[Smart Pull] Could not rename folder ${from} -> ${to}: ${String(e)}`, "warn");
                return;
            }
        }
        parent = parent ? `${parent}/${seg}` : seg;
    }
}

function takeOwnRename(ctx: StateCtx, from: string, to: string): boolean {
    const m = ownRenames.get(ctx);
    const key = `${from}\u0000${to}`;
    const n = m?.get(key);
    if (!n) return false;
    if (n > 1) m!.set(key, n - 1);
    else m!.delete(key);
    return true;
}

/**
 * Renames of files not synced yet: old path -> current path. An upload of the old
 * path whose response was lost may still have reached the cloud; when it shows up
 * there, it is moved to the current name instead of being pulled back as a copy.
 */
const unsyncedRenames = new CtxState<Map<string, string>>("unsyncedRenames", "Renames of files not synced yet: old path to current path");

function noteUnsyncedRename(ctx: StateCtx, from: string, to: string): void {
    let m = unsyncedRenames.get(ctx);
    if (!m) unsyncedRenames.set(ctx, (m = new Map<string, string>()));
    let ownsUpload = !!peekAttemptedUpload(ctx, from);
    for (const [k, v] of m) {
        if (v !== from) continue;
        m.set(k, to);
        if (peekAttemptedUpload(ctx, k)) ownsUpload = true;
    }
    m.set(from, to);
    // An upload of the old name may be in flight: killed before the next save, the
    // restarted app took that upload for a deleted note and removed it from the cloud
    // (a second copy once another device had edited it). Save the rename at once.
    if (ownsUpload) void saveLocalIndex(ctx, true);
}

/** Renames of never-synced files, for persisting with the local index */
function unsyncedRenamesSnapshot(ctx: StateCtx): Record<string, string> | undefined {
    const m = unsyncedRenames.get(ctx);
    return m && m.size > 0 ? Object.fromEntries(m) : undefined;
}

function restoreUnsyncedRenames(ctx: StateCtx, data: unknown): void {
    if (!data || typeof data !== "object") return;
    let m = unsyncedRenames.get(ctx);
    if (!m) unsyncedRenames.set(ctx, (m = new Map<string, string>()));
    for (const [from, to] of Object.entries(data as Record<string, unknown>)) {
        // Only a rename whose upload is still unsettled matters after a restart
        // (its record may follow the note to the new name, after a failed move)
        if (typeof to === "string" && !m.has(from) && (peekAttemptedUpload(ctx, from) || peekAttemptedUpload(ctx, to))) {
            m.set(from, to);
        }
    }
}

/** Where a never-synced file once at `path` lives now, if it was renamed (keeps it). */
export function peekUnsyncedRename(ctx: StateCtx, path: string): string | undefined {
    return unsyncedRenames.get(ctx)?.get(path);
}

/** Where a never-synced file once at `path` lives now, if it was renamed (forgets it). */
export function takeUnsyncedRename(ctx: StateCtx, path: string): string | undefined {
    const m = unsyncedRenames.get(ctx);
    const to = m?.get(path);
    if (to !== undefined) m!.delete(path);
    return to;
}

export function markRenamed(ctx: StateCtx, oldPath: string, newPath: string): void {
    if (takeOwnRename(ctx, oldPath, newPath)) {
        void ctx.log(`[Dirty] Ignored our own rename: ${oldPath} -> ${newPath}`, "debug");
        return;
    }
    if (shouldIgnore(ctx, newPath)) {
        // Moved to where this device does not sync (an excluded folder, say): for the
        // cloud the file is gone, as when deleted. The copy stays here.
        if (!shouldIgnore(ctx, oldPath)) {
            void ctx.log(`[Dirty] ${oldPath} moved out of the synced files (${newPath}): deleting it in the cloud`, "debug");
            markDeleted(ctx, oldPath);
        }
        return;
    }
    if (isDeviceExcluded(ctx, oldPath)) {
        // Comes from where this device does not sync: a new file for the cloud. Its old
        // index entry (if any) describes another device's file, which must not move.
        ctx.dirtyPaths.set(newPath, Date.now());
        void ctx.log(`[Dirty] Marked (moved in from outside the synced files): ${newPath}`, "debug");
        return;
    }
    oldPath = indexKeyFor(ctx, oldPath);

    const oldDir = dirname(oldPath);
    const newDir = dirname(newPath);
    const isMove = oldDir !== newDir;

    // 未同期ファイルのリネーム/移動（oldPath がインデックスになく dirtyPaths にある）
    // After a restart the dirty set is empty, but a saved upload record still says the
    // file was never confirmed: its lost upload may be in the cloud under the old name.
    // A never-synced file renamed again (after a restart nothing else marks it): follow
    // the recorded chain, or the first name's upload was taken for a deleted note.
    const renamedAgain = [...(unsyncedRenames.get(ctx)?.values() ?? [])].includes(oldPath);
    if (
        !ctx.index[oldPath] &&
        (ctx.dirtyPaths.has(oldPath) || peekAttemptedUpload(ctx, oldPath) || renamedAgain)
    ) {
        noteUnsyncedRename(ctx, oldPath, newPath);
        ctx.dirtyPaths.delete(oldPath);
        ctx.dirtyPaths.set(newPath, Date.now());
        void ctx.log(`[Dirty] Removed (renamed before sync): ${oldPath}`, "debug");
        void ctx.log(`[Dirty] Marked (renamed before sync): ${newPath}`, "debug");
        return;
    }

    // The new name was already synced as a NEW file (a vault scan found it before this
    // event arrived). Moving the old entry onto it would orphan that upload and leave
    // two cloud files with one name. Keep it; the old name is a plain deletion now.
    if (ctx.index[oldPath] && ctx.index[newPath]?.fileId && ctx.index[newPath].fileId !== ctx.index[oldPath].fileId) {
        setOf(deleteIntents, ctx).add(oldPath);
        ctx.dirtyPaths.set(oldPath, Date.now());
        void ctx.log(`[Dirty] ${newPath} was already uploaded as a new file. Deleting ${oldPath} instead of moving it.`, "debug");
        return;
    }

    // 既存インデックスエントリを移行（リネームでも移動でも共通）
    ctx.dirtyPaths.delete(oldPath);

    if (ctx.index[oldPath]) {
        ctx.index[newPath] = {
            ...ctx.index[oldPath],
            forcePush: true,
            pendingMove: { oldPath },
        };
        delete ctx.index[oldPath];
    }

    if (ctx.localIndex[oldPath]) {
        ctx.localIndex[newPath] = {
            ...ctx.localIndex[oldPath],
            forcePush: true,
            pendingMove: { oldPath },
        };
        delete ctx.localIndex[oldPath];
    }
    moveAttemptedUploads(ctx, oldPath, newPath);

    ctx.dirtyPaths.set(newPath, Date.now());
    void ctx.log(
        `[Dirty] Marked (${isMove ? "moved" : "renamed"}): ${newPath} (Migrated ID from ${oldPath})`,
        "debug",
    );
    persistMove(ctx);
}

/**
 * Save a rename at once: it lives only in memory until the next push, and if the app
 * was closed before that, the next start saw the old name as deleted and the new one
 * as a new note, so the note ended up twice in the cloud.
 */
function persistMove(ctx: StateCtx): void {
    void saveIndex(ctx).catch((e) => console.error("Vault-Sync: Failed to save index after a rename", e));
}

export function markFolderRenamed(
    ctx: StateCtx,
    oldFolderPath: string,
    newFolderPath: string,
): void {
    if (takeOwnRename(ctx, oldFolderPath, newFolderPath)) {
        void ctx.log(`[Dirty] Ignored our own folder rename: ${oldFolderPath} -> ${newFolderPath}`, "debug");
        return;
    }
    const oldPrefix = oldFolderPath + "/";
    const newPrefix = newFolderPath + "/";

    // Track folder-level move for optimization in smartPush. Not when this device
    // leaves out files in either place: moving the cloud folder would move (or drop
    // from the sync) files this device does not handle. Files then move one by one.
    const indexed = Object.keys(ctx.index);
    const wholeFolder =
        !holdsDeviceExcluded(ctx, oldFolderPath, indexed) && !holdsDeviceExcluded(ctx, newFolderPath, indexed);
    if (wholeFolder) {
        ctx.pendingFolderMoves.set(newFolderPath, oldFolderPath);
        ctx.dirtyPaths.set(newFolderPath, Date.now()); // Ensure the folder itself is processed
    }

    // If the old folder was marked for deletion (via previous event),
    // we remove it since it's now a move.
    ctx.deletedFolders.delete(oldFolderPath);

    for (const oldPath of Object.keys(ctx.index)) {
        if (oldPath.startsWith(oldPrefix)) {
            const newPath = newPrefix + oldPath.slice(oldPrefix.length);
            if (shouldIgnore(ctx, oldPath)) {
                // Comes in from where this device does not sync: a new file
                if (!shouldIgnore(ctx, newPath)) ctx.dirtyPaths.set(newPath, Date.now());
                continue;
            }
            if (shouldIgnore(ctx, newPath)) {
                // Moved out of the synced files: gone for the cloud, kept here
                markDeleted(ctx, oldPath);
                continue;
            }

            // インデックスを移行（削除+再追加ではなく Move として追跡）
            ctx.index[newPath] = {
                ...ctx.index[oldPath],
                forcePush: true,
                pendingMove: { oldPath },
            };
            delete ctx.index[oldPath];

            if (ctx.localIndex[oldPath]) {
                ctx.localIndex[newPath] = {
                    ...ctx.localIndex[oldPath],
                    forcePush: true,
                    pendingMove: { oldPath },
                };
                delete ctx.localIndex[oldPath];
            }
            moveAttemptedUploads(ctx, oldPath, newPath);

            // dirtyPaths を更新
            ctx.dirtyPaths.delete(oldPath);
            ctx.dirtyPaths.set(newPath, Date.now());
            void ctx.log(
                `[Dirty] Marked (folder move child): ${oldPath} -> ${newPath} (Migrated ID)`,
                "debug",
            );
        }
    }
    // Notes made in the folder and not synced yet: only marked, not indexed. Left
    // under the old name, the push found nothing there and dropped them for good.
    for (const [oldPath, at] of Array.from(ctx.dirtyPaths)) {
        if (!oldPath.startsWith(oldPrefix) || ctx.index[oldPath]) continue;
        const newPath = newPrefix + oldPath.slice(oldPrefix.length);
        ctx.dirtyPaths.delete(oldPath);
        if (!shouldIgnore(ctx, newPath)) ctx.dirtyPaths.set(newPath, at);
        void ctx.log(`[Dirty] Marked (folder move, not synced yet): ${oldPath} -> ${newPath}`, "debug");
    }
    persistMove(ctx);
}

// === State Queries ===

export function getSyncState(ctx: StateCtx) {
    return ctx.syncState;
}

export function hasDirtyFiles(ctx: StateCtx): boolean {
    return ctx.dirtyPaths.size > 0;
}

export function isFreshStart(ctx: StateCtx): boolean {
    return ctx.indexLoadFailed || Object.keys(ctx.index).length === 0;
}
