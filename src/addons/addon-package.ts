import { unzipSync, strFromU8 } from "fflate";
import { toHex } from "../utils/format";
import { APPROVED_ADDONS, type ApprovedAddon } from "./approved-addons";

/**
 * Generic add-on package: a zip with an `addon.json` manifest, an entry file
 * and terms of use in one or more languages, e.g.
 *
 *   addon.json      { id, name, version, description?, entry, terms: { en, ja } }
 *   <entry>.js
 *   TERMS.md, TERMS_ja.md
 *
 * Reading a package only verifies it; nothing is written or executed here.
 */
export interface AddonManifest {
    id: string;
    name: string;
    version: string;
    description?: Record<string, string>;
    entry: string;
    terms: Record<string, string>;
}

export interface AddonPackage {
    addon: ApprovedAddon;
    manifest: AddonManifest;
    entrySource: string;
    /** Terms text by language code. */
    terms: Record<string, string>;
    /** Identifies the exact terms the user agrees to (hash over all terms files). */
    termsHash: string;
}

export type AddonPackageError =
    | "too-large"
    | "not-zip"
    | "no-manifest"
    | "unknown-addon"
    | "hash-mismatch";

export type AddonPackageResult =
    | { ok: true; pkg: AddonPackage }
    | { ok: false; reason: AddonPackageError };

/** Packages are small (tens of KB). Anything near these limits is not ours. */
const MAX_PACKAGE_BYTES = 10 * 1024 * 1024;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MANIFEST_NAME = "addon.json";

async function sha256Hex(text: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return toHex(new Uint8Array(digest));
}

/** Matches "addon.json" and "some-folder/addon.json" (zips made by hand often nest). */
function baseName(path: string): string {
    return path.split("/").pop() ?? path;
}

function unzipOnly(bytes: Uint8Array, names: Set<string>): Record<string, string> | null {
    try {
        const files = unzipSync(bytes, {
            filter: (f) => names.has(baseName(f.name)) && f.originalSize <= MAX_FILE_BYTES,
        });
        const out: Record<string, string> = {};
        for (const [path, data] of Object.entries(files)) {
            const name = baseName(path);
            if (!(name in out)) out[name] = strFromU8(data);
        }
        return out;
    } catch {
        return null;
    }
}

/**
 * Verifies a user-picked add-on package against APPROVED_ADDONS.
 * Every pinned file must be present and match its SHA-256 exactly.
 */
export async function readAddonPackage(
    bytes: Uint8Array,
    approved: ApprovedAddon[] = APPROVED_ADDONS,
): Promise<AddonPackageResult> {
    if (bytes.length > MAX_PACKAGE_BYTES) return { ok: false, reason: "too-large" };

    const head = unzipOnly(bytes, new Set([MANIFEST_NAME]));
    if (!head) return { ok: false, reason: "not-zip" };
    if (!head[MANIFEST_NAME]) return { ok: false, reason: "no-manifest" };

    let manifest: AddonManifest;
    try {
        manifest = JSON.parse(head[MANIFEST_NAME]);
    } catch {
        return { ok: false, reason: "no-manifest" };
    }
    const addon = approved.find((a) => a.id === manifest?.id);
    if (!addon) return { ok: false, reason: "unknown-addon" };

    const files = unzipOnly(bytes, new Set(Object.keys(addon.files)));
    if (!files) return { ok: false, reason: "not-zip" };
    for (const [name, expected] of Object.entries(addon.files)) {
        if (files[name] === undefined || (await sha256Hex(files[name])) !== expected) {
            console.error(`Vault-Sync: add-on package file rejected: ${name}`);
            return { ok: false, reason: "hash-mismatch" };
        }
    }

    // The manifest is pinned too, so these only guard against a mistake in the registry.
    const termsNames = Object.values(manifest.terms ?? {});
    if (
        !(manifest.entry in addon.files) ||
        termsNames.length === 0 ||
        termsNames.some((n) => !(n in addon.files))
    ) {
        return { ok: false, reason: "no-manifest" };
    }

    const terms: Record<string, string> = {};
    for (const [lang, name] of Object.entries(manifest.terms)) terms[lang] = files[name];
    const termsHash = await sha256Hex(
        termsNames
            .slice()
            .sort()
            .map((n) => addon.files[n])
            .join(","),
    );

    return {
        ok: true,
        pkg: { addon, manifest, entrySource: files[manifest.entry], terms, termsHash },
    };
}

/** Picks the terms (or description) text for the UI language, falling back to English. */
export function pickLocalized(texts: Record<string, string> | undefined, lang: string): string {
    if (!texts) return "";
    return texts[lang] ?? texts.en ?? Object.values(texts)[0] ?? "";
}
