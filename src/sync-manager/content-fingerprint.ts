import { md5 } from "../utils/md5";
import { capabilitiesOf, type CloudAdapter } from "../types/adapter";

/**
 * How the sync tells file contents apart.
 *
 * The sync always computes its own fingerprint (MD5 of the bytes) for local
 * content. A cloud's own hash is a different thing: Google Drive reports MD5,
 * but OneDrive reports quickXorHash and Dropbox its own content hash. Code that
 * compares a cloud's hash with local content must go through
 * cloudHashMatches(), which answers false when the cloud's hash is not
 * comparable, so a cloud with another hash type is never mistaken for
 * "same content" or "different content" by accident.
 *
 * This module is the only place in the sync that calls md5().
 */

/** Fingerprint of content as the sync stores and compares it (lowercase hex) */
export function contentFingerprint(content: ArrayBuffer): string {
    return md5(content);
}

/** True when both contents have the same bytes */
export function sameContent(a: ArrayBuffer, b: ArrayBuffer): boolean {
    return a.byteLength === b.byteLength && contentFingerprint(a) === contentFingerprint(b);
}

/** True when CloudFile.hash of this adapter can be compared with contentFingerprint() */
export function cloudHashIsFingerprint(adapter: Pick<CloudAdapter, "capabilities"> | null | undefined): boolean {
    return capabilitiesOf(adapter).contentHash === "md5";
}

/**
 * True when the cloud's hash proves the cloud holds exactly the content with
 * this fingerprint. False when the hashes differ, when the cloud reported no
 * hash, or when its hash type cannot be compared.
 */
export function cloudHashMatches(
    adapter: Pick<CloudAdapter, "capabilities"> | null | undefined,
    cloudHash: string | null | undefined,
    fingerprint: string,
): boolean {
    if (!cloudHash || !cloudHashIsFingerprint(adapter)) return false;
    return cloudHash.toLowerCase() === fingerprint.toLowerCase();
}
