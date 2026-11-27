import type { CloudAdapter } from "../types/adapter";
import type { LocalFileIndex } from "./types";

/**
 * What the plugin keeps in the cloud besides the vault's own files, and the
 * format of the shared index document.
 *
 * The index carries a format version and the provider its change-feed cursor
 * (startPageToken) belongs to. A cursor is only meaningful to the cloud that
 * issued it: a Google Drive page token means nothing to OneDrive's delta API.
 * When the provider differs, the cursor is dropped and the reader falls back
 * to a full comparison, instead of feeding a foreign token to its change feed.
 */

/** Plugin files under the plugin folder that sync by their own logic (relative to the plugin dir) */
export const REMOTE_DATA_DIR = "data/remote";
/** One record file per device (device-registry.ts), each written only by its device */
export const REMOTE_DEVICE_DIR = `${REMOTE_DATA_DIR}/devices`;
export const REMOTE_FILES = {
    index: `${REMOTE_DATA_DIR}/sync-index.json`,
    rawIndex: `${REMOTE_DATA_DIR}/sync-index_raw.json`,
    communication: `${REMOTE_DATA_DIR}/communication.json`,
    vaultLock: `${REMOTE_DATA_DIR}/vault-lock.vault`,
    /** What a converted vault held when it replaced the old folder (vault-folder.ts) */
    conversionBase: `${REMOTE_DATA_DIR}/conversion-base.json`,
} as const;

/**
 * Version of the index document this build writes.
 * 1: { formatVersion, provider, index, startPageToken }. Documents without
 *    formatVersion (version 0) have the same fields minus the two new ones.
 */
export const INDEX_FORMAT_VERSION = 1;

export interface IndexDocument {
    formatVersion?: number;
    /** Name of the cloud the cursor belongs to (CloudAdapter.name of the base adapter) */
    provider?: string;
    index?: LocalFileIndex;
    startPageToken?: string | null;
    /**
     * Recent deletions: cloud file id -> the version the deleting device checked
     * right before removing it. Optional (older builds neither write nor read it).
     */
    deleted?: DeletionMarks;
    /**
     * Recent merges: cloud version hash -> the versions it was merged from besides the
     * one it was built on. Kept apart from the entries, which a device that has not
     * pulled the newest version yet still writes with its own older entry.
     */
    merges?: MergeOrigins;
}

export type MergeOrigins = Record<string, string[]>;

/** The cloud version a device saw right before it deleted a file */
export interface DeletionMark {
    /** Cloud hash of that version (lower case); absent when the cloud gave none */
    hash?: string;
    /** Unix time (ms) of the deletion */
    at: number;
}

export type DeletionMarks = Record<string, DeletionMark>;

export interface ParsedIndex {
    index: LocalFileIndex;
    /** null when the document has none, or it belongs to another provider */
    startPageToken: string | null;
    formatVersion: number;
    /** Written by a newer build: only the fields this build knows are read */
    fromNewerBuild: boolean;
    /** The cursor was dropped because the document names another provider */
    cursorDropped: boolean;
    deleted: DeletionMarks;
    merges: MergeOrigins;
}

/** The provider name the cursor is recorded under (the base adapter of a wrapper) */
export function providerNameOf(
    adapter: Partial<Pick<CloudAdapter, "name" | "getBaseAdapter">> | null | undefined,
): string {
    return (adapter?.getBaseAdapter?.() ?? adapter)?.name ?? "";
}

export function serializeIndex(
    index: LocalFileIndex,
    startPageToken: string | null,
    provider: string,
    deleted?: DeletionMarks,
    merges?: MergeOrigins,
): string {
    const doc: IndexDocument = {
        formatVersion: INDEX_FORMAT_VERSION,
        provider,
        index,
        startPageToken,
    };
    if (deleted && Object.keys(deleted).length > 0) doc.deleted = deleted;
    if (merges && Object.keys(merges).length > 0) doc.merges = merges;
    return JSON.stringify(doc);
}

export function parseIndex(text: string, provider: string): ParsedIndex {
    const doc = JSON.parse(text) as IndexDocument;
    const formatVersion = typeof doc.formatVersion === "number" ? doc.formatVersion : 0;
    // Documents from before the provider was recorded were all written for the
    // one provider those builds had, so their cursor is kept.
    const foreign = !!doc.provider && !!provider && doc.provider !== provider;
    const token = doc.startPageToken || null;
    return {
        index: doc.index || {},
        startPageToken: foreign ? null : token,
        formatVersion,
        fromNewerBuild: formatVersion > INDEX_FORMAT_VERSION,
        cursorDropped: foreign && !!token,
        deleted: doc.deleted && typeof doc.deleted === "object" ? doc.deleted : {},
        merges: doc.merges && typeof doc.merges === "object" ? doc.merges : {},
    };
}
