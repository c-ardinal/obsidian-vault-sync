import { md5 } from "../utils/md5";
import type { SyncContext } from "./context";
import type { LocalFileIndex } from "./types";
import { tryDecompress, hashContent } from "./file-utils";

export async function computeLocalHash(
    ctx: SyncContext,
    content: ArrayBuffer,
    indexEntry: { hash?: string; plainHash?: string },
    /** md5(content) if the caller already computed it */
    rawMd5?: string,
): Promise<{ localHash: string; compareHash: string | undefined }> {
    const useE2EE = ctx.e2eeEnabled && !!indexEntry.plainHash;
    const localHash = useE2EE ? await hashContent(content) : (rawMd5 ?? md5(content));
    const compareHash = useE2EE ? indexEntry.plainHash : indexEntry.hash;
    return { localHash, compareHash };
}

export async function downloadRemoteIndex(ctx: SyncContext, fileId: string): Promise<LocalFileIndex> {
    return (await downloadRemoteIndexData(ctx, fileId)).index;
}

/** The remote index plus the Changes API token its writer had when uploading it. */
export async function downloadRemoteIndexData(
    ctx: SyncContext,
    fileId: string,
): Promise<{ index: LocalFileIndex; startPageToken: string | null }> {
    const content = await ctx.adapter.downloadFile(fileId);
    const decompressed = await tryDecompress(content);
    const data = JSON.parse(new TextDecoder().decode(decompressed));
    return { index: data.index || {}, startPageToken: data.startPageToken || null };
}

export function getThresholdBytes(ctx: SyncContext): number {
    return (ctx.settings.largeFileThresholdMB ?? 0) * 1024 * 1024;
}

export function generateTransferId(direction: "push" | "pull"): string {
    return `bg-${direction}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function markPendingTransfer(
    ctx: SyncContext,
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
export async function buildRemoteIndexPayload(ctx: SyncContext): Promise<ArrayBuffer> {
    const merged: LocalFileIndex = { ...ctx.index };
    try {
        const meta = await ctx.adapter.getFileMetadata(ctx.pluginDataPath);
        const lastSeen = ctx.index[ctx.pluginDataPath]?.hash?.toLowerCase() || "";
        if (meta?.id && meta.hash && meta.hash.toLowerCase() !== lastSeen) {
            const remote = await downloadRemoteIndex(ctx, meta.id);
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
                            .getFileMetadataById(entry.fileId!, ourPath)
                            .catch(() => null);
                        if (actual?.path === ourPath) continue;
                        delete merged[ourPath];
                    } else if (
                        entry.fileId &&
                        !(await ctx.adapter.fileExistsById(entry.fileId).catch(() => true))
                    ) {
                        continue; // deleted (on a lookup error keep the entry: dropping
                        // it would hide the file from devices doing their first sync)
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
            if (kept > 0) {
                await ctx.log(
                    `[Index] Merged ${kept} entr${kept === 1 ? "y" : "ies"} written by other devices into the remote index.`,
                    "info",
                );
            }
        }
    } catch (e) {
        await ctx.log(`[Index] Could not merge remote index, uploading local index as-is: ${e}`, "warn");
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
    const data = JSON.stringify({ index: merged, startPageToken: ctx.startPageToken });
    return new TextEncoder().encode(data).buffer as ArrayBuffer;
}

/**
 * Uploads whose outcome is unknown (the request failed, but the server may have
 * applied it: "response lost"). path -> md5 of what we sent. When that exact
 * hash later shows up remotely it is our own content, not another device's
 * edit: adopting it avoids overwriting a new local note with it, or a false
 * 3-way conflict between our own older and newer edits.
 */
const attemptedUploads = new WeakMap<object, Map<string, string>>();

export function recordAttemptedUpload(ctx: SyncContext, path: string, hash: string): void {
    let m = attemptedUploads.get(ctx);
    if (!m) attemptedUploads.set(ctx, (m = new Map()));
    m.set(path, hash.toLowerCase());
}

/** Returns true (and forgets the record) if `hash` is what we tried to upload to `path`. */
export function takeAttemptedUpload(ctx: SyncContext, path: string, hash: string | undefined): boolean {
    const m = attemptedUploads.get(ctx);
    const rec = m?.get(path);
    if (!rec || !hash || rec !== hash.toLowerCase()) return false;
    m!.delete(path);
    return true;
}

/** The hash we last tried to upload to `path` with an unknown outcome, if any. */
export function peekAttemptedUpload(ctx: SyncContext, path: string): string | undefined {
    return attemptedUploads.get(ctx)?.get(path);
}

/** Forget the unknown-outcome upload of `path` (a later upload succeeded). */
export function forgetAttemptedUpload(ctx: SyncContext, path: string): void {
    attemptedUploads.get(ctx)?.delete(path);
}
