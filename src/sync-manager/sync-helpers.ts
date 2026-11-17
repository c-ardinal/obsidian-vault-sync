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
    const content = await ctx.adapter.downloadFile(fileId);
    const decompressed = await tryDecompress(content);
    const data = JSON.parse(new TextDecoder().decode(decompressed));
    return data.index || {};
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
            const ourFileIds = new Set(
                Object.values(ctx.index)
                    .map((e) => e.fileId)
                    .filter(Boolean),
            );
            let kept = 0;
            for (const [path, entry] of Object.entries(remote)) {
                if (path === ctx.pluginDataPath) continue;
                const mine = ctx.index[path];
                if (!mine) {
                    if (entry.fileId && ourFileIds.has(entry.fileId)) continue; // we moved it
                    if (entry.fileId && !(await ctx.adapter.fileExistsById(entry.fileId))) continue; // deleted
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
    const data = JSON.stringify({ index: merged, startPageToken: ctx.startPageToken });
    return new TextEncoder().encode(data).buffer as ArrayBuffer;
}
