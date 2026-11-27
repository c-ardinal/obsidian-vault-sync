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
    const kept = rebaseOntoVaultFolder(ctx, await readRemoteIndex());
    ctx.startPageToken = null;
    knownRoot.set(ctx, current);
    await ctx.log(
        `[Vault Folder] ${kept.same} file(s) carried over, ${kept.changed} changed on the cloud since, ${kept.dropped} without history.`,
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
 * A file the new folder does not list (or one being renamed here) is forgotten:
 * the sync meets it as a file it has no history of.
 */
export function rebaseOntoVaultFolder(
    ctx: Pick<Ctx, "index" | "localIndex">,
    remote: LocalFileIndex,
): { same: number; changed: number; dropped: number } {
    const count = { same: 0, changed: 0, dropped: 0 };
    const paths = new Set([...Object.keys(ctx.localIndex), ...Object.keys(ctx.index)]);
    for (const path of paths) {
        const old = ctx.localIndex[path] ?? ctx.index[path];
        const now = remote[path];
        // Without an add-on the cloud hash was the content's own hash
        const lastSynced = old.plainHash ?? old.hash;
        const moving = !!old.pendingMove || !!ctx.index[path]?.pendingMove;
        if (!now?.fileId || !lastSynced || moving) {
            delete ctx.localIndex[path];
            delete ctx.index[path];
            count.dropped++;
            continue;
        }
        const same = now.plainHash === lastSynced;
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
        };
        ctx.localIndex[path] = { ...entry };
        ctx.index[path] = same ? { ...now } : { ...entry };
        if (same) count.same++;
        else count.changed++;
    }
    return count;
}
