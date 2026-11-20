import { describe, it, expect } from "vitest";
import { entryIdentityHash, localIdentityHash, storesTransformedContent } from "../../../src/sync-manager/content-identity";
import { contentFingerprint } from "../../../src/sync-manager/content-fingerprint";
import { hashContent } from "../../../src/sync-manager/file-utils";

const bytes = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

describe("content identity", () => {
    const entry = { hash: "cloud-hash", plainHash: "plain-hash" };

    it("compares by the cloud hash when the cloud stores the bytes as they are", async () => {
        const ctx = { e2eeEnabled: false };
        expect(storesTransformedContent(ctx)).toBe(false);
        expect(entryIdentityHash(ctx, entry)).toBe("cloud-hash");
        const content = bytes("a\r\nb");
        expect(await localIdentityHash(ctx, content)).toBe(contentFingerprint(content));
    });

    it("compares by plainHash when an add-on transforms the stored bytes", async () => {
        const ctx = { e2eeEnabled: true };
        expect(storesTransformedContent(ctx)).toBe(true);
        expect(entryIdentityHash(ctx, entry)).toBe("plain-hash");
        expect(entryIdentityHash(ctx, { hash: "only-cloud" })).toBeUndefined();
        const content = bytes("a\r\nb");
        expect(await localIdentityHash(ctx, content)).toBe(await hashContent(content));
    });
});
