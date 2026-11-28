import type { SyncContext } from "./context";
import { CtxState } from "./context-state";
import type { LocalFileIndex } from "./types";

/**
 * Which cloud folder the indexes of this device describe.
 *
 * The indexes name every file by its cloud id. A vault conversion for an add-on
 * on another device replaces the vault folder with a new one of the same name:
 * every file is a new cloud file there, and the ids this device knows belong to
 * the old folder. Used unchanged, they made the sync take each file of the new
 * folder for a second file of the same name (both got renamed apart, the old
 * folder's copy was moved into the new vault as it was) and sent edits to the
 * old folder.
 *
 * The id of the vault folder is therefore saved with the local index. When the
 * folder the adapter resolves is another one, the indexes are rebased onto it
 * before anything is transferred (rebaseOntoVaultFolder).
 */
const knownRoot = new CtxState<string>("vaultRootId", "Cloud id of the vault folder the indexes describe");

export function knownVaultRootOf(ctx: object): string | undefined {
    return knownRoot.get(ctx);
}

export function restoreKnownVaultRoot(ctx: object, saved: unknown): void {
    if (typeof saved === "string" && saved) knownRoot.set(ctx, saved);
    else knownRoot.delete(ctx);
}

/**
 * The notes this device deleted on the cloud lately: cloud file id -> the note
 * and the content it had. Saved with the local index. A conversion on another
 * device may have read the old folder before such a deletion arrived there: the
 * converted vault then holds the note again, and only this device knows that
 * its user deleted it (see rebaseOntoVaultFolder).
 */
export interface OwnDeletion {
    path: string;
    plain: string;
    at: number;
}
const ownDeletions = new CtxState<Record<string, OwnDeletion>>("ownDeletions", "Notes this device deleted on the cloud lately");
const OWN_DELETION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const OWN_DELETION_MAX = 500;

export function rememberOwnDeletion(ctx: object, fileId: string, path: string, plain: string): void {
    const all = ownDeletions.get(ctx) ?? {};
    all[fileId] = { path, plain: plain.toLowerCase(), at: Date.now() };
    ownDeletions.set(ctx, all);
}

export function ownDeletionsSnapshot(ctx: object): Record<string, OwnDeletion> {
    const now = Date.now();
    const kept = Object.entries(ownDeletions.get(ctx) ?? {})
        .filter(([, d]) => now - d.at < OWN_DELETION_TTL_MS)
        .sort((a, b) => b[1].at - a[1].at)
        .slice(0, OWN_DELETION_MAX);
    const out = Object.fromEntries(kept);
    ownDeletions.set(ctx, out);
    return out;
}

export function restoreOwnDeletions(ctx: object, saved: unknown): void {
    const out: Record<string, OwnDeletion> = {};
    if (saved && typeof saved === "object") {
        for (const [id, d] of Object.entries(saved as Record<string, Partial<OwnDeletion>>)) {
            if (d && typeof d.path === "string" && typeof d.plain === "string" && typeof d.at === "number") {
                out[id] = { path: d.path, plain: d.plain, at: d.at };
            }
        }
    }
    ownDeletions.set(ctx, out);
}

/**
 * Notes this device holds in a version that reached the old folder, but not the
 * vault folder it followed into (the vault holds none, or the version the
 * conversion read): path -> content hash. They are sent (again). Until they are,
 * a deletion mark of the vault that names this very version says that the note
 * was carried over meanwhile (by the cleanup of the old folder) and deleted
 * there since: it is deleted here then, not sent again. Saved with the local
 * index (the app can stop between following and sending).
 */
const resent = new CtxState<Record<string, string>>("resentAfterFollow", "Notes sent again after following a vault folder");

export function rememberResent(ctx: object, path: string, plain: string): void {
    resent.set(ctx, { ...(resent.get(ctx) ?? {}), [path]: plain });
}

/** The content hash under which `path` waits to be sent again, if it does */
export function resentCandidate(ctx: object, path: string): string | undefined {
    return resent.get(ctx)?.[path];
}

export function resentSnapshot(ctx: object): Record<string, string> {
    return { ...(resent.get(ctx) ?? {}) };
}

export function restoreResent(ctx: object, saved: unknown): void {
    const out: Record<string, string> = {};
    if (saved && typeof saved === "object") {
        for (const [path, plain] of Object.entries(saved as Record<string, unknown>)) {
            if (typeof plain === "string") out[path] = plain;
        }
    }
    resent.set(ctx, out);
}

/**
 * Before a push: of the notes to be sent again, those the vault does not hold
 * and deleted in this very version since are named (the caller removes them
 * here). Those that are in the vault in this version by now, or changed here,
 * are no candidates any more.
 */
export async function resentDeletedSince(
    ctx: object & { index: LocalFileIndex },
    localContent: (path: string) => Promise<string | undefined>,
    deletedInVault: (path: string, plain: string) => boolean,
): Promise<string[]> {
    const all = resent.get(ctx) ?? {};
    if (Object.keys(all).length === 0) return [];
    const gone: string[] = [];
    const left: Record<string, string> = {};
    for (const [path, plain] of Object.entries(all)) {
        if ((await localContent(path)) !== plain) continue;
        const inVault = ctx.index[path];
        if (inVault?.fileId) {
            // Still the older version there: a deletion that arrives is checked
            // against the marks where it is applied
            if ((inVault.plainHash ?? inVault.hash) !== plain) left[path] = plain;
            continue;
        }
        if (deletedInVault(path, plain)) gone.push(path);
        else left[path] = plain;
    }
    resent.set(ctx, left);
    return gone;
}

/** The new vault folder is a converted vault this device has not unlocked yet */
export class VaultConvertedError extends Error {
    constructor() {
        super("The cloud vault was converted for an add-on on another device. Sync waits until it is unlocked here.");
        this.name = "VaultConvertedError";
    }
}

/**
 * True for the two ways a sync ends on purpose because the vault folder was
 * replaced: nothing failed, the sync has to start over with the new folder.
 */
export function isVaultFolderRestart(e: unknown): boolean {
    return e instanceof Error && (e.name === "VaultFolderReplacedError" || e.name === "VaultConvertedError");
}

/**
 * What the converting device knew when the converted vault replaced the old
 * folder (REMOTE_FILES.conversionBase), for the devices that follow later.
 */
export interface ConversionBase {
    /**
     * Content (plain hash) of every file the converted vault held at that
     * moment, by path: a file missing from the new folder was deleted there
     * (it is listed here) or never reached it (it is not).
     */
    paths: Record<string, string>;
    /**
     * Cloud hash of every file of the old folder as the conversion last read
     * it, by path: a version a device pushed there that is not this one was
     * either replaced before the conversion or pushed too late to be converted.
     * Absent when the record has none.
     */
    scan?: Record<string, string>;
    /** Cloud id of each of those files of the old folder, by path */
    ids?: Record<string, string>;
    /** Content (plain hash) of each of those files as the conversion read it */
    scanPlain?: Record<string, string>;
    /**
     * The old folder is gone and everything pushed into it late was brought
     * into the converted vault (or no other device existed).
     */
    cleaned: boolean;
}

export const NO_CONVERSION_BASE: ConversionBase = { paths: {}, cleaned: false };

export function conversionBaseOf(
    index: LocalFileIndex,
    scan: Record<string, string>,
    ids: Record<string, string>,
    scanPlain: Record<string, string>,
    cleaned: boolean,
): ConversionBase {
    const paths: Record<string, string> = {};
    for (const [path, e] of Object.entries(index)) {
        const content = e.plainHash ?? e.hash;
        if (content) paths[path] = content;
    }
    return { paths, scan, ids, scanPlain, cleaned };
}

function stringMap(value: unknown): Record<string, string> | undefined {
    if (!value || typeof value !== "object") return undefined;
    const out: Record<string, string> = {};
    for (const [p, h] of Object.entries(value)) if (typeof h === "string") out[p] = h;
    return out;
}

export function parseConversionBase(text: string): ConversionBase {
    try {
        const doc = JSON.parse(text) as {
            paths?: unknown;
            scan?: unknown;
            ids?: unknown;
            scanPlain?: unknown;
            cleaned?: unknown;
        };
        const scan = stringMap(doc.scan);
        const ids = stringMap(doc.ids);
        const scanPlain = stringMap(doc.scanPlain);
        return {
            paths: stringMap(doc.paths) ?? {},
            ...(scan ? { scan } : {}),
            ...(ids ? { ids } : {}),
            ...(scanPlain ? { scanPlain } : {}),
            cleaned: doc.cleaned === true,
        };
    } catch {
        return { ...NO_CONVERSION_BASE };
    }
}

type Ctx = Pick<SyncContext, "adapter" | "index" | "localIndex" | "log" | "startPageToken">;

/**
 * Called at the start of a sync, once the adapter is ready. Returns true when
 * the vault folder was replaced and the indexes were rebased (the caller saves
 * them and scans the vault). Throws when the new folder's index cannot be read:
 * a sync with the old ids must not run.
 */
export async function followVaultFolder(
    ctx: Ctx,
    readRemoteIndex: () => Promise<LocalFileIndex>,
    /** Throws when the new folder cannot be read with this device's current setup */
    canRead: () => Promise<void> = async () => {},
    /** What the new folder held when it replaced the old one (see ConversionBase) */
    readConversionBase: () => Promise<ConversionBase> = async () => NO_CONVERSION_BASE,
    /** Content hash of the file this device holds under the path now (undefined: none) */
    localContent: (path: string) => Promise<string | undefined> = async () => undefined,
    /** Cloud hash the file with this id holds now, wherever it is (null: gone) */
    oldVersionNow: (fileId: string) => Promise<string | null> = async () => null,
    /** What the caller has to do for single notes (see RebaseResult) */
    act: (result: RebaseResult) => Promise<void> = async () => {},
    /** A deletion mark of the new folder names this note in this version (read with its index) */
    deletedInVault: (path: string, plain: string) => boolean = () => false,
): Promise<boolean> {
    const current = await ctx.adapter.getVaultRootId?.();
    if (!current) return false;
    const known = knownRoot.get(ctx);
    if (known === current) return false;
    const hasEntries = Object.keys(ctx.localIndex).length > 0 || Object.keys(ctx.index).length > 0;
    if (!known || !hasEntries) {
        knownRoot.set(ctx, current);
        return false;
    }
    await ctx.log(
        `[Vault Folder] The cloud vault folder was replaced (${known} -> ${current}). Rebasing the indexes onto it.`,
        "system",
    );
    await canRead();
    const kept = await rebaseOntoVaultFolder(
        ctx,
        await readRemoteIndex(),
        await readConversionBase(),
        localContent,
        oldVersionNow,
        deletedInVault,
    );
    await act(kept);
    ctx.startPageToken = null;
    knownRoot.set(ctx, current);
    await ctx.log(
        `[Vault Folder] ${kept.same} file(s) carried over, ${kept.changed} changed on the cloud since, ${kept.deleted} deleted there since, ${kept.dropped} without history, ${kept.lateHere.length} sent too late to be converted, ${kept.deletedLate.length} deleted too late, ${kept.unsure.length} kept as a copy.`,
        "system",
    );
    return true;
}

/**
 * Point the indexes at the files of the new folder.
 *
 * A file whose last synced content is what the new folder holds is carried
 * over as synced at the new folder's version: an edit made here since is still
 * an ordinary edit on top of it.
 *
 * A file the new folder holds in another version keeps its last synced content
 * as the base, under the new file's id: the cloud version is then newer than
 * the base, so an untouched local file takes it and an edited one is merged or
 * kept as a conflict copy, as for any change made on another device.
 *
 * A file the new folder does not list, but held in this very version when it
 * replaced the old folder (or later: a deletion mark names the version), was
 * deleted there since. When this device still
 * holds that version untouched, its entry is kept as it is: its cloud file is
 * no longer part of the vault, so the sync handles it as any file deleted on
 * another device (with the usual review of deletions). Edited here since, it
 * is forgotten instead and uploaded as a new file: the edit wins, and nothing
 * is ever sent to the old folder's file.
 *
 * A file this device last synced in a version the conversion never read, the
 * old folder still holding that version, was pushed too late to be converted:
 * it is carried over as synced at the new folder's version, so that the content
 * here is sent as an edit of it (lateHere). When the old folder is gone without
 * its late pushes having been brought over, nobody can tell: the content here
 * is kept as a copy (unsure).
 *
 * A note this device deleted on the cloud, the very file the conversion then
 * converted (the deletion reached the old folder too late), is entered as synced
 * and reported (deletedLate): the caller deletes it in the converted vault.
 *
 * A note renamed here, the rename not yet on the cloud, is matched with the new
 * folder's file under its old name and stays a pending rename of that file:
 * forgotten instead, it was uploaded as a new note next to the old name's.
 *
 * Any other file the new folder does not list is forgotten: the sync meets it
 * as a file it has no history of, and uploads it. That covers a note this
 * device pushed into the old folder too late to be converted. Deleted here
 * since, it is reported (deletedHere), so that the deletion is recorded.
 */
export interface RebaseResult {
    same: number;
    changed: number;
    deleted: number;
    dropped: number;
    /** Notes this device deleted before it could tell the cloud (see rebaseOntoVaultFolder) */
    deletedHere: Array<{ path: string; fileId: string; hash?: string; plain: string }>;
    /**
     * Notes whose version here was pushed into the old folder after the
     * conversion had read it: newer than the converted one, to be sent again
     */
    lateHere: string[];
    /** Notes whose version here the new folder does not hold: sent (again) by this device (see rememberResent) */
    resent: Array<{ path: string; plain: string }>;
    /**
     * Notes this device deleted on the cloud too late for the conversion, which
     * converted them all the same: to be deleted in the converted vault
     */
    deletedLate: string[];
    /**
     * Notes whose version here cannot simply give way to the vault's: sent too
     * late while the vault moved on (two concurrent versions), or nobody can
     * tell any more whether it was converted (the old folder was removed by
     * hand). The caller keeps the local content as a copy before the vault's
     * version replaces it.
     */
    unsure: string[];
}

export async function rebaseOntoVaultFolder(
    ctx: Pick<Ctx, "index" | "localIndex">,
    remote: LocalFileIndex,
    base: ConversionBase = NO_CONVERSION_BASE,
    localContent: (path: string) => Promise<string | undefined> = async () => undefined,
    oldVersionNow: (fileId: string) => Promise<string | null> = async () => null,
    /** A deletion mark of the new folder names this note in this version */
    deletedInVault: (path: string, plain: string) => boolean = () => false,
): Promise<RebaseResult> {
    const count: RebaseResult = { same: 0, changed: 0, deleted: 0, dropped: 0, deletedHere: [], lateHere: [], resent: [], deletedLate: [], unsure: [] };
    const paths = new Set([...Object.keys(ctx.localIndex), ...Object.keys(ctx.index)]);
    for (const path of paths) {
        const old = ctx.localIndex[path] ?? ctx.index[path];
        // A note renamed here and not yet on the cloud: its cloud file is still under the old name
        const from = (old.pendingMove ?? ctx.index[path]?.pendingMove)?.oldPath;
        const moving = !!from;
        const now = remote[from ?? path];
        // Without an add-on the cloud hash was the content's own hash
        const lastSynced = old.plainHash ?? old.hash;
        if (
            !now?.fileId && !moving && !!lastSynced &&
            (base.paths[path] === lastSynced || deletedInVault(path, lastSynced)) &&
            (await localContent(path)) === lastSynced
        ) {
            // Synced and not changed by this device since, whoever uploaded it last:
            // "pushed by this device" would make the deletion look like a conflict
            if (ctx.localIndex[path]) ctx.localIndex[path].lastAction = "pull";
            if (ctx.index[path]) ctx.index[path].lastAction = "pull";
            count.deleted++;
            continue;
        }
        if (!now?.fileId || !lastSynced) {
            // Held here in this version and deleted here since, never told to the
            // cloud: the old folder may still hold it (a late push), and nothing
            // in the new folder says that it was deleted
            const held = ctx.localIndex[path];
            if (!now?.fileId && !moving && held?.fileId && lastSynced && (await localContent(path)) === undefined) {
                count.deletedHere.push({ path, fileId: held.fileId, hash: held.hash, plain: lastSynced });
            }
            if (!now?.fileId && !moving && lastSynced && (await localContent(path)) === lastSynced) {
                count.resent.push({ path, plain: lastSynced });
            }
            delete ctx.localIndex[path];
            delete ctx.index[path];
            count.dropped++;
            continue;
        }
        const same = now.plainHash === lastSynced;
        const move = from ? { forcePush: true, pendingMove: { oldPath: from } } : {};
        // The conversion did not read the version this device last synced. It was
        // replaced on another device before (the vault's version is the newer one),
        // or sent into the old folder too late (the one here is newer). The old
        // folder tells: its file still holds this device's version in the second case.
        const mine = old.hash?.toLowerCase();
        if (!same && base.scan && !base.cleaned && mine && old.fileId && base.scan[from ?? path]?.toLowerCase() !== mine) {
            const there = (await oldVersionNow(old.fileId))?.toLowerCase() ?? null;
            // The late version is an edit of what the conversion read. When the vault
            // still holds exactly that, the content here goes up as an edit of it.
            const ancestor = base.scanPlain?.[from ?? path];
            if (there === mine && ancestor !== undefined && now.plainHash === ancestor) {
                // Synced at the vault's version: the content here is an edit on top of it
                const entry = {
                    fileId: now.fileId,
                    mtime: old.mtime,
                    size: now.size,
                    hash: now.hash,
                    plainHash: now.plainHash,
                    ancestorHash: now.hash,
                    lastAction: "pull" as const,
                    ...move,
                };
                ctx.localIndex[path] = { ...entry };
                ctx.index[path] = { ...now, ...move };
                count.lateHere.push(path);
                if (!moving) count.resent.push({ path, plain: lastSynced });
                continue;
            }
            // The vault holds another version by now (the two are concurrent), or the
            // old folder is gone before its late pushes were brought over: an
            // untouched file here would be replaced by the vault's without a trace
            if ((there === mine || there === null) && (await localContent(path)) === lastSynced) count.unsure.push(path);
        }
        // The old folder's hash never equals a hash of the new file: "an older version"
        const hash = same ? now.hash : old.hash;
        const entry = {
            fileId: now.fileId,
            mtime: old.mtime,
            size: same ? now.size : old.size,
            hash,
            plainHash: lastSynced,
            ancestorHash: hash,
            lastAction: "pull" as const,
            // The rename is carried out on the new folder's file
            ...move,
        };
        ctx.localIndex[path] = { ...entry };
        ctx.index[path] = same ? { ...now, ...move } : { ...entry };
        if (same) count.same++;
        else count.changed++;
    }
    // The conversion converted a file this device had deleted (the deletion
    // reached the old folder after it was read). The vault still holds that very
    // version, and the note has not come back here: the deletion stands.
    const own = ownDeletions.get(ctx) ?? {};
    for (const [path, oldId] of Object.entries(base.cleaned ? {} : (base.ids ?? {}))) {
        const deleted = own[oldId];
        const now = remote[path];
        if (!deleted || deleted.path !== path || !now?.fileId || ctx.localIndex[path] || ctx.index[path]) continue;
        if (now.plainHash !== deleted.plain || base.paths[path] !== deleted.plain) continue;
        if ((await localContent(path)) !== undefined) continue;
        ctx.index[path] = { ...now };
        ctx.localIndex[path] = { ...now, lastAction: "pull" };
        count.deletedLate.push(path);
    }
    return count;
}
