import { overwriteRepairsSnapshot, restoreOverwriteRepairs } from "./overwrite-recovery";
import { plainHashVersion, restorePlainHashVersion } from "./plain-hash-migration";
import { contentFingerprint } from "./content-fingerprint";
import { parseIndex, providerNameOf, serializeIndex, type ParsedIndex } from "./remote-layout";
import { toHex } from "../utils/format";
import { normalizePath, dirname } from "../utils/path";
import type { SyncContext } from "./context";
import type { CommunicationData, LocalFileIndex, MergeLockEntry } from "./types";
import { holdsDeviceExcluded, shouldIgnore } from "./file-utils";
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
} from "./sync-helpers";
import { CtxState } from "./context-state";
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
            await new Promise((r) => setTimeout(r, jitter));
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
                journalSeq?: unknown;
                plainHashVersion?: unknown;
            };
            ctx.localIndex = parsed.index || {};
            ctx.deviceId = parsed.deviceId || "";
            journalOf(ctx).seq = typeof parsed.journalSeq === "number" ? parsed.journalSeq : 0;
            await applyJournal(ctx, journalOf(ctx).seq);
            rememberWritten(ctx);
            restoreAttemptedUploads(ctx, parsed.attemptedUploads);
            restorePendingPulls(ctx, parsed.pendingPulls);
            restoreOverwriteRepairs(ctx, parsed.overwriteRepairs);
            restorePlainHashVersion(ctx, parsed.plainHashVersion, false);
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
            journalSeq: j.seq,
            plainHashVersion: plainHashVersion(ctx),
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
 * holds it composed (NFC: "é"), or the other way round. Both are the same file
 * there, so map an event path onto the index key it refers to. Only on such file
 * systems: on Linux / Windows the two spellings are two files. Case differences
 * are NOT folded: on Linux "Note.md" and "note.md" are two files.
 */
export function indexKeyFor(ctx: StateCtx, path: string): string {
    if (!ctx.unicodeInsensitiveFs || ctx.index[path] || ctx.localIndex[path]) return path;
    const nfc = path.normalize("NFC");
    if (nfc === path && path.normalize("NFD") === path) return path; // plain ASCII etc.
    for (const k of Object.keys(ctx.index)) if (k.normalize("NFC") === nfc) return k;
    return path;
}

export function markDirty(ctx: StateCtx, path: string): void {
    path = indexKeyFor(ctx, normalizePath(path));
    if (shouldIgnore(ctx, path)) return;
    if (ctx.syncingPaths.has(path)) {
        // Usually the echo of our own write, but it can be a user edit typed while the
        // engine still held the path (after its write, until the merge lock was
        // released). Dropping it lost that edit: the file was never pushed and the
        // device stayed different from the cloud. Checked against the index before
        // the next push (recheckEventsDuringSync).
        setOf(eventsDuringSync, ctx).add(path);
        return;
    }
    ctx.dirtyPaths.set(path, Date.now());
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
const missingOnce = new CtxState<Set<string>>("missingOnce", "Paths found missing once, waiting one sync for a late rename event");

function setOf(map: CtxState<Set<string>>, ctx: StateCtx): Set<string> {
    let s = map.get(ctx);
    if (!s) map.set(ctx, (s = new Set()));
    return s;
}

/** A deletion the sync engine itself established (no vault event will report it). */
export function noteDeleteIntent(ctx: StateCtx, path: string): void {
    setOf(deleteIntents, ctx).add(path);
}

/** True when a missing synced file may be deleted remotely now (see deleteIntents). */
export function confirmMissingForDeletion(ctx: StateCtx, path: string): boolean {
    if (setOf(deleteIntents, ctx).delete(path)) {
        setOf(missingOnce, ctx).delete(path);
        return true;
    }
    const seen = setOf(missingOnce, ctx);
    if (seen.delete(path)) return true;
    seen.add(path);
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
        await ctx.vault.rename(from, to);
    } catch (e) {
        takeOwnRename(ctx, from, to);
        throw e;
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
    for (const [k, v] of m) if (v === from) m.set(k, to);
    m.set(from, to);
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
    if (shouldIgnore(ctx, newPath)) return;
    oldPath = indexKeyFor(ctx, oldPath);

    const oldDir = dirname(oldPath);
    const newDir = dirname(newPath);
    const isMove = oldDir !== newDir;

    // 未同期ファイルのリネーム/移動（oldPath がインデックスになく dirtyPaths にある）
    // After a restart the dirty set is empty, but a saved upload record still says the
    // file was never confirmed: its lost upload may be in the cloud under the old name.
    if (!ctx.index[oldPath] && (ctx.dirtyPaths.has(oldPath) || peekAttemptedUpload(ctx, oldPath))) {
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
    const oldPrefix = oldFolderPath + "/";
    const newPrefix = newFolderPath + "/";

    // Track folder-level move for optimization in smartPush
    ctx.pendingFolderMoves.set(newFolderPath, oldFolderPath);
    ctx.dirtyPaths.set(newFolderPath, Date.now()); // Ensure the folder itself is processed

    // If the old folder was marked for deletion (via previous event),
    // we remove it since it's now a move.
    ctx.deletedFolders.delete(oldFolderPath);

    for (const oldPath of Object.keys(ctx.index)) {
        if (oldPath.startsWith(oldPrefix)) {
            if (shouldIgnore(ctx, oldPath)) continue;

            const newPath = newPrefix + oldPath.slice(oldPrefix.length);
            if (shouldIgnore(ctx, newPath)) continue;

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

            // dirtyPaths を更新
            ctx.dirtyPaths.delete(oldPath);
            ctx.dirtyPaths.set(newPath, Date.now());
            void ctx.log(
                `[Dirty] Marked (folder move child): ${oldPath} -> ${newPath} (Migrated ID)`,
                "debug",
            );
        }
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
