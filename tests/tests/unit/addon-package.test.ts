/**
 * @file Add-on package tests
 *
 * @description
 * readAddonPackage verifies a user-picked add-on zip (addon.json + entry + terms)
 * against pinned SHA-256 hashes before anything is shown or installed.
 *
 * @pass_criteria
 * - A package whose files all match is accepted, with terms by language
 * - Any changed, missing or unknown file/add-on is rejected
 * - Non-zip input and oversized input are rejected
 * - Packages nested in a folder are accepted
 * - The terms hash changes when the terms change
 */

import { describe, it, expect, vi } from "vitest";
import { createHash } from "crypto";
import { zipSync, strToU8 } from "fflate";
import { readAddonPackage, pickLocalized } from "../../../src/addons/addon-package";
import type { ApprovedAddon } from "../../../src/addons/approved-addons";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

const MANIFEST = JSON.stringify({
    id: "test-addon",
    name: "Test Add-on",
    version: "1.2.3",
    description: { en: "desc", ja: "説明" },
    entry: "addon.js",
    terms: { en: "TERMS.md", ja: "TERMS_ja.md" },
});
const FILES: Record<string, string> = {
    "addon.json": MANIFEST,
    "addon.js": "module.exports = {};",
    "TERMS.md": "# Terms\nBe nice.",
    "TERMS_ja.md": "# 規約\n仲良く。",
};

function registry(files: Record<string, string> = FILES): ApprovedAddon[] {
    return [
        {
            id: "test-addon",
            kind: "crypto-engine",
            installAs: "addon.js",
            downloadUrl: "https://example.invalid/releases",
            files: Object.fromEntries(Object.entries(files).map(([n, c]) => [n, sha(c)])),
        },
    ];
}

function zip(files: Record<string, string>, prefix = ""): Uint8Array {
    return zipSync(
        Object.fromEntries(Object.entries(files).map(([n, c]) => [prefix + n, strToU8(c)])),
    );
}

describe("readAddonPackage", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    it("accepts a package whose every file matches the pinned hashes", async () => {
        const result = await readAddonPackage(zip(FILES), registry());
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.pkg.manifest.name).toBe("Test Add-on");
        expect(result.pkg.entrySource).toBe(FILES["addon.js"]);
        expect(result.pkg.terms).toEqual({ en: FILES["TERMS.md"], ja: FILES["TERMS_ja.md"] });
        expect(result.pkg.termsHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("accepts a package whose files sit in a folder", async () => {
        const result = await readAddonPackage(zip(FILES, "vault-syncer-addon/"), registry());
        expect(result.ok).toBe(true);
    });

    it("rejects a package with modified terms", async () => {
        const tampered = { ...FILES, "TERMS.md": "# Terms\nAnything goes." };
        expect(await readAddonPackage(zip(tampered), registry())).toEqual({
            ok: false,
            reason: "hash-mismatch",
        });
    });

    it("rejects a package with modified code", async () => {
        const tampered = { ...FILES, "addon.js": "module.exports = { evil: true };" };
        expect(await readAddonPackage(zip(tampered), registry())).toEqual({
            ok: false,
            reason: "hash-mismatch",
        });
    });

    it("rejects a package missing a pinned file", async () => {
        const { ["TERMS_ja.md"]: _omit, ...partial } = FILES;
        expect(await readAddonPackage(zip(partial), registry())).toEqual({
            ok: false,
            reason: "hash-mismatch",
        });
    });

    it("rejects an add-on id that is not in the registry", async () => {
        const other = { ...FILES, "addon.json": MANIFEST.replace("test-addon", "other") };
        expect(await readAddonPackage(zip(other), registry())).toEqual({
            ok: false,
            reason: "unknown-addon",
        });
    });

    it("rejects a zip without addon.json", async () => {
        const { ["addon.json"]: _omit, ...noManifest } = FILES;
        expect(await readAddonPackage(zip(noManifest), registry())).toEqual({
            ok: false,
            reason: "no-manifest",
        });
    });

    it("rejects a bare .js file (not a zip)", async () => {
        expect(await readAddonPackage(strToU8(FILES["addon.js"]), registry())).toEqual({
            ok: false,
            reason: "not-zip",
        });
    });

    it("rejects oversized input without unzipping it", async () => {
        const big = new Uint8Array(10 * 1024 * 1024 + 1);
        expect(await readAddonPackage(big, registry())).toEqual({
            ok: false,
            reason: "too-large",
        });
    });

    it("terms hash changes when the terms change", async () => {
        const a = await readAddonPackage(zip(FILES), registry());
        const changed = { ...FILES, "TERMS.md": "# Terms v2" };
        const b = await readAddonPackage(zip(changed), registry(changed));
        expect(a.ok && b.ok).toBe(true);
        if (a.ok && b.ok) expect(a.pkg.termsHash).not.toBe(b.pkg.termsHash);
    });
});

describe("pickLocalized", () => {
    it("prefers the UI language, then English", () => {
        expect(pickLocalized({ en: "e", ja: "j" }, "ja")).toBe("j");
        expect(pickLocalized({ en: "e", ja: "j" }, "fr")).toBe("e");
        expect(pickLocalized({ ja: "j" }, "fr")).toBe("j");
        expect(pickLocalized(undefined, "en")).toBe("");
    });
});
