import { md5 } from "../utils/md5";
import type { SyncContext } from "./context";
import { legacyHashContent, runParallel } from "./file-utils";

/**
 * Plaintext hashes (index `plainHash`) of files that are not valid UTF-8 used to be
 * taken of the lossily decoded text, so two versions differing only in invalid bytes
 * had the same hash and the edit was missed. They are now taken of the raw bytes.
 *
 * Version 1: the old hash. Version 2: the current one. Saved in the local index.
 */
export const PLAIN_HASH_VERSION = 2;

const versions = new WeakMap<object, number>();

export function restorePlainHashVersion(ctx: SyncContext, saved: unknown, freshIndex: boolean): void {
    // A local index without the field was written by an older version.
    versions.set(ctx, freshIndex ? PLAIN_HASH_VERSION : typeof saved === "number" ? saved : 1);
}

export function plainHashVersion(ctx: SyncContext): number {
    return versions.get(ctx) ?? PLAIN_HASH_VERSION;
}

/**
 * One-time conversion of this device's stored plaintext hashes. Every local file
 * whose index entry still holds the old hash of its current content gets the new
 * hash, in the local index and in the copy of the remote index alike. Entries whose
 * file changed since (their old hash no longer matches) are left alone: the change
 * is found as usual. Runs only while the add-on that uses these hashes is active,
 * so a device that turns it on later converts then. Returns the number converted,
 * or -1 if nothing had to run. The caller saves the indexes.
 *
 * Remote index entries for files this device does not have, and entries written by
 * devices not yet updated, keep the old hash; comparisons against index hashes
 * accept it (plainHashMatches), and the next upload of such a file replaces it.
 */
export async function migratePlainHashes(ctx: SyncContext): Promise<number> {
    if (!ctx.e2eeEnabled || plainHashVersion(ctx) >= PLAIN_HASH_VERSION) return -1;
    const paths = Object.keys(ctx.localIndex).filter((p) => !!ctx.localIndex[p]?.plainHash);
    let converted = 0;
    await runParallel(
        paths.map((path) => async () => {
            let content: ArrayBuffer;
            try {
                if (!(await ctx.vault.exists(path))) return;
                content = await ctx.vault.readBinary(path);
            } catch {
                return;
            }
            const legacy = legacyHashContent(content);
            if (!legacy) return; // valid UTF-8: the hash did not change
            const entry = ctx.localIndex[path];
            if (!entry?.plainHash || entry.plainHash.toLowerCase() !== legacy) return;
            const next = md5(content);
            entry.plainHash = next;
            const remote = ctx.index[path];
            if (remote?.plainHash?.toLowerCase() === legacy) remote.plainHash = next;
            converted++;
        }),
        Math.max(1, ctx.settings.concurrency || 5),
    );
    versions.set(ctx, PLAIN_HASH_VERSION);
    await ctx.log(`[Hash Migration] Updated ${converted} of ${paths.length} plaintext hashes.`, "info");
    return converted;
}
