import { md5 } from "../utils/md5";
import type { SyncContext } from "./context";
import type { LocalFileIndex } from "./types";
import { tryDecompress, hashContent } from "./file-utils";

export async function computeLocalHash(
    ctx: SyncContext,
    content: ArrayBuffer,
    indexEntry: { hash?: string; plainHash?: string },
): Promise<{ localHash: string; compareHash: string | undefined }> {
    const useE2EE = ctx.e2eeEnabled && !!indexEntry.plainHash;
    const localHash = useE2EE ? await hashContent(content) : md5(content);
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
