import { deflateSync, inflateSync, strFromU8, strToU8 } from "fflate";
import { isValidCloudRootFolder } from "../utils/cloud-root";

/**
 * Moving this plugin's settings to another device, as one link
 * (obsidian://<action>?d=<data>) that a QR code carries.
 *
 * Only settings that differ from the defaults go in, as flat "path" keys
 * (e.g. "unifiedTriggers.autoSyncIntervalSec"), compressed and base64url
 * encoded, so the code stays small.
 *
 * Left out:
 * - sign-in: credentials, tokens, the auth method and the auth proxy URL
 *   (a link that set a proxy could send the next sign-in elsewhere);
 * - add-on settings and agreements (each device installs and agrees itself);
 * - this device's own state (first sync done, developer mode, internal flags).
 *
 * Reading a link accepts only known keys whose value has the default's type;
 * anything else is dropped, so a crafted link can set nothing else.
 */

/** Obsidian URI action of the link */
export const SETTINGS_TRANSFER_ACTION = "cardinal-vault-sync-settings";
const FORMAT_VERSION = 1;

const EXCLUDED = new Set([
    "authMethod",
    "customProxyUrl",
    "encryptionSecret",
    "hasCompletedFirstSync",
    "isDeveloperMode",
    "startupDelaySec",
    "enableAutoSyncInInterval",
    "settingsVersion",
    "addonAgreements",
]);
/** Add-on owned settings (by name), never moved */
const EXCLUDED_PATTERN = /^e2ee/i;

type Flat = Record<string, string | number | boolean>;

function isMovable(key: string): boolean {
    return !EXCLUDED.has(key) && !EXCLUDED_PATTERN.test(key);
}

/** Leaf settings as "a.b" -> value (strings, numbers, booleans only) */
export function flattenSettings(settings: object, prefix = ""): Flat {
    const out: Flat = {};
    for (const [key, value] of Object.entries(settings)) {
        if (!prefix && !isMovable(key)) continue;
        const path = prefix + key;
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
            out[path] = value;
        } else if (value && typeof value === "object" && !Array.isArray(value)) {
            Object.assign(out, flattenSettings(value as object, `${path}.`));
        }
    }
    return out;
}

function toBase64Url(bytes: Uint8Array): string {
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array {
    const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
}

/** The data part of a link: the settings that differ from the defaults */
export function encodeSettingsTransfer(settings: object, defaults: object): string {
    const current = flattenSettings(settings);
    const base = flattenSettings(defaults);
    const changed: Flat = {};
    for (const [key, value] of Object.entries(current)) {
        if (Object.prototype.hasOwnProperty.call(base, key) && base[key] !== value) changed[key] = value;
    }
    const json = JSON.stringify({ v: FORMAT_VERSION, s: changed });
    return toBase64Url(deflateSync(strToU8(json), { level: 9 }));
}

/** The whole link */
export function settingsTransferLink(data: string): string {
    return `obsidian://${SETTINGS_TRANSFER_ACTION}?d=${data}`;
}

/** The data part of a pasted link (or the data itself); null if none */
export function dataFromLink(text: string): string | null {
    const trimmed = text.trim();
    const m = /[?&]d=([A-Za-z0-9_-]+)/.exec(trimmed);
    if (m) return m[1];
    return /^[A-Za-z0-9_-]+$/.test(trimmed) ? trimmed : null;
}

/**
 * Settings a link holds, checked against the defaults: known keys with the
 * default's type only. Throws when the data is not a settings link at all.
 */
export function decodeSettingsTransfer(data: string, defaults: object): Flat {
    let parsed: unknown;
    try {
        parsed = JSON.parse(strFromU8(inflateSync(fromBase64Url(data))));
    } catch {
        throw new Error("Not a settings link");
    }
    const body = parsed as { v?: unknown; s?: unknown };
    if (body?.v !== FORMAT_VERSION || !body.s || typeof body.s !== "object") {
        throw new Error("Not a settings link");
    }
    const base = flattenSettings(defaults);
    const out: Flat = {};
    for (const [key, value] of Object.entries(body.s as Record<string, unknown>)) {
        if (!Object.prototype.hasOwnProperty.call(base, key) || typeof value !== typeof base[key]) continue;
        if (typeof value === "number" && !Number.isFinite(value)) continue;
        if (key === "cloudRootFolder" && !isValidCloudRootFolder(String(value).trim())) continue;
        out[key] = value as string | number | boolean;
    }
    return out;
}

/** Write flat "a.b" values into a settings object */
export function applyFlatSettings(target: object, values: Flat): void {
    for (const [path, value] of Object.entries(values)) {
        const parts = path.split(".");
        let obj: Record<string, unknown> | null = target as Record<string, unknown>;
        for (const part of parts.slice(0, -1)) {
            const next: unknown = Object.prototype.hasOwnProperty.call(obj, part) ? obj?.[part] : null;
            obj = next && typeof next === "object" ? (next as Record<string, unknown>) : null;
            if (!obj) break;
        }
        if (obj) obj[parts[parts.length - 1]] = value;
    }
}
