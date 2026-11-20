import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import {
    cloudHashIsFingerprint,
    cloudHashMatches,
    contentFingerprint,
    sameContent,
} from "../../../src/sync-manager/content-fingerprint";
import { testCapabilities } from "../../helpers/mock-cloud-adapter";

const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
const md5Cloud = { capabilities: testCapabilities({ contentHash: "md5" }) };
const otherCloud = { capabilities: testCapabilities({ contentHash: null }) };

describe("content fingerprint", () => {
    it("is the lowercase MD5 of the bytes", () => {
        expect(contentFingerprint(enc("test"))).toBe("098f6bcd4621d373cade4e832627b4f6");
    });

    it("tells equal and different contents apart", () => {
        expect(sameContent(enc("a"), enc("a"))).toBe(true);
        expect(sameContent(enc("a"), enc("b"))).toBe(false);
        expect(sameContent(enc("a"), enc("aa"))).toBe(false);
    });

    it("compares a cloud hash only when the cloud's hash is an MD5", () => {
        const fp = contentFingerprint(enc("test"));
        expect(cloudHashIsFingerprint(md5Cloud)).toBe(true);
        expect(cloudHashMatches(md5Cloud, fp.toUpperCase(), fp)).toBe(true);
        expect(cloudHashMatches(md5Cloud, "ffff", fp)).toBe(false);
        expect(cloudHashMatches(md5Cloud, undefined, fp)).toBe(false);
        // Same string by coincidence, but another hash type: never a match
        expect(cloudHashIsFingerprint(otherCloud)).toBe(false);
        expect(cloudHashMatches(otherCloud, fp, fp)).toBe(false);
        // An adapter without a declaration has no comparable hash
        expect(cloudHashMatches(null, fp, fp)).toBe(false);
    });
});

describe("the sync computes content hashes in one place", () => {
    it("no sync module but content-fingerprint.ts imports utils/md5", () => {
        const dir = join("src", "sync-manager");
        const walk = (d: string): string[] =>
            readdirSync(d, { withFileTypes: true }).flatMap((e) =>
                e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith(".ts") ? [join(d, e.name)] : [],
            );
        const offenders = walk(dir)
            .filter((f) => !f.endsWith("content-fingerprint.ts"))
            .filter((f) => /from\s+["'][^"']*utils\/md5["']/.test(readFileSync(f, "utf8")));
        expect(offenders).toEqual([]);
    });
});
