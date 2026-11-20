import type { SyncFlags } from "./context";
import { contentFingerprint } from "./content-fingerprint";
import { hashContent } from "./file-utils";

/**
 * Which hash identifies a vault file's content in the sync index.
 *
 * Index entries carry two hashes:
 * - `hash`: the cloud's hash of the bytes it stores (also the conflict token:
 *   when it changes, another device uploaded).
 * - `plainHash`: hashContent() of the vault content (text with line endings
 *   normalized).
 *
 * When the cloud stores the vault bytes as they are, `hash` is also the
 * content's fingerprint and local content is compared with it directly. When an
 * add-on transforms the bytes before they are stored, `hash` describes only the
 * stored form: local content can be compared with `plainHash` alone, and a
 * cloud version can be identified only by reading it back.
 *
 * The sync code asks this module instead of checking add-on settings itself, so
 * the rule has one owner. A later cloud whose hash is not an MD5 (OneDrive,
 * Dropbox) needs the same "compare plainHash" rule, and only this module changes.
 */

type Ctx = Pick<SyncFlags, "e2eeEnabled">;

/** True when the cloud holds a transformed form of the vault bytes */
export function storesTransformedContent(ctx: Ctx): boolean {
    return ctx.e2eeEnabled;
}

/** Hash of local content in the form the index compares it with */
export async function localIdentityHash(ctx: Ctx, content: ArrayBuffer): Promise<string> {
    return storesTransformedContent(ctx) ? await hashContent(content) : contentFingerprint(content);
}

/** The index entry's hash comparable with localIdentityHash() (may be absent) */
export function entryIdentityHash(
    ctx: Ctx,
    entry: { hash?: string; plainHash?: string } | null | undefined,
): string | undefined {
    return storesTransformedContent(ctx) ? entry?.plainHash : entry?.hash;
}
