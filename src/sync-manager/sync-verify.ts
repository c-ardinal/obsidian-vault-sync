import type { SyncContext } from "./context";
import { entryIdentityHash, localIdentityHash, storesTransformedContent } from "./content-identity";
import { contentFingerprint } from "./content-fingerprint";
import { exceedsDeviceSizeLimit, getLocalFiles, shouldIgnore } from "./file-utils";

/**
 * Read-only check of the sync: every file on this device against the cloud.
 * Nothing is uploaded, downloaded or changed. One cloud listing (one request
 * per folder) and a read of each local file.
 *
 * Contents are compared directly when the cloud stores the vault's bytes as
 * they are (its MD5 against the local file). When it stores a transformed form
 * (an add-on), each side is compared with what the last sync recorded instead.
 */

export type VerifyDifference =
    /** Here, not in the cloud */
    | "local-only"
    /** In the cloud, not here */
    | "cloud-only"
    /** Changed here since the last sync (not sent yet) */
    | "local-changed"
    /** Changed in the cloud since the last sync (not received yet) */
    | "cloud-changed"
    /** Both sides changed, or the contents differ for no recorded reason */
    | "differs";

export interface VerifyReport {
    checkedAt: number;
    /** Files compared on both sides and found the same */
    matching: number;
    differences: { path: string; kind: VerifyDifference }[];
    /** Changes this device still waits to send (edits seen, sync not run yet) */
    pending: number;
}

/** How far the check is: the cloud listing has no known length, the comparison has */
export type VerifyProgress =
    | { stage: "listing" }
    | { stage: "comparing"; done: number; total: number; bytesDone: number; bytesTotal: number };

const key = (p: string) => p.normalize("NFC");

export async function verifySync(
    ctx: SyncContext,
    now = Date.now(),
    onProgress?: (p: VerifyProgress) => void,
): Promise<VerifyReport> {
    if (ctx.e2eeLocked) throw new Error("Add-on locked: cloud files cannot be compared now");
    onProgress?.({ stage: "listing" });
    const leftOut = (path: string, size?: number) => shouldIgnore(ctx, path) || exceedsDeviceSizeLimit(ctx, size);

    const cloud = new Map<string, { hash?: string; size?: number }>();
    for (const f of await ctx.adapter.listFiles()) {
        if (f.kind === "folder" || leftOut(f.path, f.size)) continue;
        cloud.set(key(f.path), { hash: f.hash?.toLowerCase(), size: f.size });
    }

    const transformed = storesTransformedContent(ctx);
    const differences: VerifyReport["differences"] = [];
    let matching = 0;
    const seen = new Set<string>();
    const localFiles = (await getLocalFiles(ctx)).filter((lf) => !leftOut(lf.path, lf.size));
    const bytesTotal = localFiles.reduce((sum, lf) => sum + lf.size, 0);
    let done = 0;
    let bytesDone = 0;
    const report = () => onProgress?.({ stage: "comparing", done, total: localFiles.length, bytesDone, bytesTotal });
    report();
    for (const lf of localFiles) {
        if (done > 0) report();
        done++;
        bytesDone += lf.size;
        const k = key(lf.path);
        seen.add(k);
        const c = cloud.get(k);
        if (!c) {
            differences.push({ path: lf.path, kind: "local-only" });
            continue;
        }
        const content = await ctx.vault.readBinary(lf.path);
        if (!transformed && c.hash) {
            if (contentFingerprint(content) === c.hash) {
                matching++;
                continue;
            }
        }
        const local = ctx.localIndex[lf.path];
        const recordedLocal = entryIdentityHash(ctx, local);
        const localChanged = !recordedLocal || (await localIdentityHash(ctx, content)) !== recordedLocal;
        const recordedCloud = (ctx.index[lf.path]?.hash ?? local?.hash)?.toLowerCase();
        const cloudChanged = !recordedCloud || !c.hash || recordedCloud !== c.hash;
        if (!localChanged && !cloudChanged) {
            matching++;
        } else {
            differences.push({
                path: lf.path,
                kind: localChanged && cloudChanged ? "differs" : localChanged ? "local-changed" : "cloud-changed",
            });
        }
    }
    report();
    for (const [k] of cloud) {
        if (!seen.has(k)) differences.push({ path: k, kind: "cloud-only" });
    }
    differences.sort((a, b) => a.path.localeCompare(b.path));
    return { checkedAt: now, matching, differences, pending: ctx.dirtyPaths.size };
}
