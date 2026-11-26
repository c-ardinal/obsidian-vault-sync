import { describe, it, expect } from "vitest";
import {
    INDEX_FORMAT_VERSION,
    REMOTE_FILES,
    parseIndex,
    providerNameOf,
    serializeIndex,
} from "../../../src/sync-manager/remote-layout";
import { INTERNAL_REMOTE_MANAGED } from "../../../src/sync-manager/file-utils";

const index = { "a.md": { fileId: "f1", mtime: 1, size: 2, hash: "h" } };

describe("index document", () => {
    it("records the format version and the provider of its cursor", () => {
        const doc = JSON.parse(serializeIndex(index, "tok-1", "Google Drive"));
        expect(doc).toEqual({
            formatVersion: INDEX_FORMAT_VERSION,
            provider: "Google Drive",
            index,
            startPageToken: "tok-1",
        });
    });

    it("round-trips for the same provider", () => {
        const parsed = parseIndex(serializeIndex(index, "tok-1", "Google Drive"), "Google Drive");
        expect(parsed.index).toEqual(index);
        expect(parsed.startPageToken).toBe("tok-1");
        expect(parsed.cursorDropped).toBe(false);
        expect(parsed.fromNewerBuild).toBe(false);
    });

    it("drops a cursor issued by another provider, keeping the entries", () => {
        const parsed = parseIndex(serializeIndex(index, "tok-1", "Google Drive"), "OneDrive");
        expect(parsed.index).toEqual(index);
        expect(parsed.startPageToken).toBeNull();
        expect(parsed.cursorDropped).toBe(true);
    });

    it("reads documents written before the version and provider were recorded", () => {
        const old = JSON.stringify({ index, startPageToken: "tok-0" });
        const parsed = parseIndex(old, "Google Drive");
        expect(parsed.formatVersion).toBe(0);
        expect(parsed.startPageToken).toBe("tok-0");
        expect(parsed.index).toEqual(index);
    });

    it("flags a document from a newer build", () => {
        const newer = JSON.stringify({ formatVersion: INDEX_FORMAT_VERSION + 1, provider: "X", index });
        expect(parseIndex(newer, "X").fromNewerBuild).toBe(true);
    });

    it("carries deletion marks, and reads documents without them", () => {
        const deleted = { f9: { hash: "abc", at: 5 } };
        const parsed = parseIndex(serializeIndex(index, "tok-1", "Google Drive", deleted), "Google Drive");
        expect(parsed.deleted).toEqual(deleted);
        expect(parseIndex(serializeIndex(index, "tok-1", "Google Drive"), "Google Drive").deleted).toEqual({});
        // No marks: the document is the same as before marks existed
        expect(JSON.parse(serializeIndex(index, "t", "X", {}))).not.toHaveProperty("deleted");
    });

    it("carries merge origins, and reads documents without them", () => {
        const merges = { aaa: ["bbb", "ccc"] };
        const parsed = parseIndex(serializeIndex(index, "tok-1", "Google Drive", {}, merges), "Google Drive");
        expect(parsed.merges).toEqual(merges);
        expect(parseIndex(serializeIndex(index, "tok-1", "Google Drive"), "Google Drive").merges).toEqual({});
        expect(JSON.parse(serializeIndex(index, "t", "X", {}, {}))).not.toHaveProperty("merges");
    });

    it("names the provider of a wrapped adapter by its base adapter", () => {
        const base = { name: "Google Drive" };
        expect(providerNameOf({ name: "Google Drive (Encrypted)", getBaseAdapter: () => base as never })).toBe(
            "Google Drive",
        );
        expect(providerNameOf(undefined)).toBe("");
    });

    it("lists every plugin-managed remote file as managed separately", () => {
        for (const p of Object.values(REMOTE_FILES)) expect(INTERNAL_REMOTE_MANAGED).toContain(p);
    });
});
