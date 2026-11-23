import type { SyncContext } from "./context";
import {
    ensureLocalFolder,
    exceedsDeviceSizeLimit,
    isDeviceExcluded,
    isManagedSeparately,
} from "./file-utils";
import { downloadRemoteIndex, lastRemoteIndex } from "./sync-helpers";

/**
 * Cloud files this device leaves out (its exclusion list, its size limit, its
 * content settings) can still be fetched one by one: to look at a large PDF on
 * the phone now and then without syncing every large file there.
 *
 * A fetched copy is like any copy of a left-out file already on the device: the
 * sync neither uploads it nor, when it is deleted here, deletes it from the
 * cloud. It is never updated either: fetching again gets the cloud's version.
 */

export interface CloudOnlyFile {
    path: string;
    size: number;
    fileId: string;
}

/** Folders a user never opens (settings, dot folders): not offered */
function isUserFile(path: string): boolean {
    return !path.split("/").some((seg) => seg.startsWith("."));
}

/** Left out here: by this kind of device's lists and settings, or its size limit */
export function isLeftOutHere(ctx: Pick<SyncContext, "settings">, path: string, size: number | undefined): boolean {
    return isDeviceExcluded(ctx, path) || exceedsDeviceSizeLimit(ctx, size);
}

/**
 * The shared index: this device's index leaves left-out files out, the shared
 * one lists every cloud file. As last read by a sync, or read now (one download).
 */
async function sharedIndex(ctx: SyncContext): Promise<Record<string, { fileId?: string; size?: number }>> {
    const cached = lastRemoteIndex(ctx);
    if (cached) return cached;
    const fileId =
        ctx.index[ctx.pluginDataPath]?.fileId ?? (await ctx.adapter.getFileMetadata(ctx.pluginDataPath))?.id;
    return fileId ? downloadRemoteIndex(ctx, fileId) : {};
}

/** Files in the cloud this device leaves out and does not have, sorted by path */
export async function listCloudOnlyFiles(ctx: SyncContext): Promise<CloudOnlyFile[]> {
    const out: CloudOnlyFile[] = [];
    const all = { ...(await sharedIndex(ctx)), ...ctx.index };
    for (const [path, entry] of Object.entries(all)) {
        if (!entry?.fileId || isManagedSeparately(path) || !isUserFile(path)) continue;
        if (!isLeftOutHere(ctx, path, entry.size)) continue;
        if (await ctx.vault.exists(path)) continue;
        out.push({ path, size: entry.size ?? 0, fileId: entry.fileId });
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Of the cloud-only files, the ones `links` point to (a note's embeds and links,
 * as written: full path, path without extension, or file name only)
 */
export function matchLinkedFiles(files: CloudOnlyFile[], links: string[]): CloudOnlyFile[] {
    const wanted = links.map((l) => l.split("#")[0].split("|")[0].trim()).filter((l) => l.length > 0);
    const hit = (f: CloudOnlyFile, link: string) => {
        const noExt = f.path.replace(/\.[^/.]+$/, "");
        return (
            f.path === link ||
            noExt === link ||
            f.path.endsWith("/" + link) ||
            noExt.endsWith("/" + link)
        );
    };
    return files.filter((f) => wanted.some((l) => hit(f, l)));
}

/** Download one cloud-only file to its place in the vault */
export async function fetchCloudOnlyFile(ctx: SyncContext, file: CloudOnlyFile): Promise<void> {
    if (await ctx.vault.exists(file.path)) return;
    const content = await ctx.adapter.downloadFile(file.fileId);
    // A file made at this path while downloading wins; never overwrite it
    if (await ctx.vault.exists(file.path)) {
        await ctx.log(`[On demand] ${file.path} appeared locally during the download; kept the local file.`, "warn");
        return;
    }
    await ensureLocalFolder(ctx, file.path);
    await ctx.vault.writeBinary(file.path, content);
    await ctx.log(`[On demand] Fetched ${file.path} (${content.byteLength} bytes); not synced on this device.`, "info");
}
