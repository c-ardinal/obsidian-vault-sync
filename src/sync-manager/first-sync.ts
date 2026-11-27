import type { SyncContext } from "./context";
import { entryIdentityHash, localIdentityHash } from "./content-identity";
import { ensureLocalFolder, isManagedSeparately, shouldIgnore } from "./file-utils";
import { downloadRemoteIndex } from "./sync-helpers";
import { isFreshStart, markDeleted, renameLocal, saveIndex } from "./state";
import type { LocalFileIndex } from "./types";
import { CtxFlag } from "./context-state";
import type { FileUtilsCtx } from "./file-utils";
import type { StateCtx } from "./state";
import type { SyncHelpersCtx } from "./sync-helpers";

/** What this module reads from the sync context */
export type FirstSyncCtx = Pick<
    SyncContext,
    | "adapter"
    | "dirtyPaths"
    | "e2eeEnabled"
    | "firstSyncGuard"
    | "index"
    | "localIndex"
    | "log"
    | "pluginDataPath"
    | "pluginDir"
    | "vault"
> & FileUtilsCtx & StateCtx & SyncHelpersCtx;

/**
 * The first sync of a device whose vault already has notes, into a cloud vault
 * that has notes too. Before anything is transferred, the user sees how the two
 * sides compare and chooses how to start:
 *
 * - merge: what every version did so far. Notes only on one side go to the
 *   other; for a note that differs, the cloud version wins and this device's
 *   version is kept as a conflict copy.
 * - cloud: start from the cloud. This device's differing notes and the notes
 *   only it has are moved to the orphans folder (never synced, never deleted),
 *   then the cloud's notes are downloaded.
 * - local: start from this device. Its differing notes replace the cloud's, and
 *   notes only the cloud has are deleted there (through the usual deletion path:
 *   reviewed by the mass-delete guard, copied to the cloud trash).
 * - later: nothing is synced. Automatic syncs wait until the user syncs by hand,
 *   which asks again.
 *
 * Only user notes count: plugin and settings files (config folder) follow their own
 * rules, as before.
 */

export type FirstSyncMode = "merge" | "cloud" | "local" | "later";

export interface FirstSyncSummary {
    /** Same content on both sides */
    identical: string[];
    /** On both sides with different content */
    differing: string[];
    /** Only on this device */
    localOnly: string[];
    /** Only on the cloud */
    cloudOnly: string[];
}

export interface FirstSyncGuard {
    choose(summary: FirstSyncSummary): Promise<FirstSyncMode>;
}

/** Folder (in the vault, never synced) that "start from the cloud" moves local notes to */
export const FIRST_SYNC_ORPHANS_DIR = "_VaultSyncer_Orphans";

const deferred = new CtxFlag("firstSyncDeferred", "The user chose to start the first sync later");

/** True while the user chose "later": automatic syncs wait for a manual one */
export function isFirstSyncDeferred(ctx: object): boolean {
    return deferred.has(ctx);
}

/** The vault's config folder, the parent of the plugins folder */
function configDirOf(ctx: FirstSyncCtx): string {
    const i = ctx.pluginDir.lastIndexOf("/plugins/");
    return i > 0 ? ctx.pluginDir.slice(0, i) : ctx.pluginDir;
}

function isUserNote(ctx: FirstSyncCtx, path: string): boolean {
    return (
        path !== ctx.pluginDataPath &&
        !path.startsWith(configDirOf(ctx) + "/") &&
        !isManagedSeparately(path) &&
        !shouldIgnore(ctx, path)
    );
}

/** Compare this device's notes with the cloud's (null when there is nothing to ask) */
export async function summarizeFirstSync(
    ctx: FirstSyncCtx,
): Promise<{ summary: FirstSyncSummary; remoteIndex: LocalFileIndex } | null> {
    const meta = await ctx.adapter.getFileMetadata(ctx.pluginDataPath);
    if (!meta?.id) return null;
    const remoteIndex = await downloadRemoteIndex(ctx, meta.id);
    const cloud = new Set(Object.keys(remoteIndex).filter((p) => remoteIndex[p]?.fileId && isUserNote(ctx, p)));
    const local = new Set(ctx.vault.getFiles().map((f) => f.path).filter((p) => isUserNote(ctx, p)));
    if (cloud.size === 0 || local.size === 0) return null;

    const summary: FirstSyncSummary = { identical: [], differing: [], localOnly: [], cloudOnly: [] };
    for (const path of local) {
        if (!cloud.has(path)) {
            summary.localOnly.push(path);
            continue;
        }
        const known = entryIdentityHash(ctx, remoteIndex[path])?.toLowerCase();
        let same = false;
        if (known) {
            try {
                same = (await localIdentityHash(ctx, await ctx.vault.readBinary(path))) === known;
            } catch {
                same = false;
            }
        }
        (same ? summary.identical : summary.differing).push(path);
    }
    for (const path of cloud) if (!local.has(path)) summary.cloudOnly.push(path);
    for (const list of Object.values(summary)) (list as string[]).sort();
    return { summary, remoteIndex };
}

/**
 * Runs before the first pull. Returns false when this sync must stop (the
 * user chose "later" or closed the screen).
 */
export async function prepareFirstSync(ctx: FirstSyncCtx): Promise<boolean> {
    if (!ctx.firstSyncGuard || !isFreshStart(ctx)) {
        deferred.delete(ctx);
        return true;
    }
    const found = await summarizeFirstSync(ctx);
    if (!found) {
        deferred.delete(ctx);
        return true;
    }
    const { summary, remoteIndex } = found;
    const mode = await ctx.firstSyncGuard.choose(summary);
    await ctx.log(
        `[First Sync] ${summary.identical.length} same, ${summary.differing.length} differ, ` +
            `${summary.localOnly.length} only here, ${summary.cloudOnly.length} only on the cloud. Chosen: ${mode}`,
        "info",
    );
    if (mode === "later") {
        deferred.add(ctx);
        return false;
    }
    deferred.delete(ctx);

    if (mode === "cloud") {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        for (const path of [...summary.differing, ...summary.localOnly]) {
            const to = `${FIRST_SYNC_ORPHANS_DIR}/first-sync-${stamp}/${path}`;
            try {
                await ensureLocalFolder(ctx, to);
                await renameLocal(ctx, path, to);
                ctx.dirtyPaths.delete(path);
            } catch (e) {
                await ctx.log(`[First Sync] Could not set aside ${path}: ${String(e)}`, "warn");
            }
        }
    } else if (mode === "local") {
        // Known as the cloud's current version, so the push sees this device's
        // differing notes as edits and the missing ones as deletions.
        const now = Date.now();
        for (const path of [...summary.differing, ...summary.cloudOnly]) {
            const r = remoteIndex[path];
            const entry = {
                fileId: r.fileId,
                mtime: r.mtime,
                size: r.size,
                hash: r.hash,
                ...(r.plainHash ? { plainHash: r.plainHash } : {}),
                ancestorHash: r.hash,
                lastAction: "pull" as const,
            };
            ctx.index[path] = { ...entry };
            ctx.localIndex[path] = { ...entry };
            ctx.dirtyPaths.set(path, now);
        }
        // Missing here on purpose: a deletion, not a lost file to download again
        for (const path of summary.cloudOnly) markDeleted(ctx, path);
        if (summary.differing.length + summary.cloudOnly.length > 0) await saveIndex(ctx);
    }
    return true;
}
