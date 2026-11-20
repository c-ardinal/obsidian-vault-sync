import { describe, it, expect } from "vitest";
import {
    applyFlatSettings,
    dataFromLink,
    decodeSettingsTransfer,
    encodeSettingsTransfer,
    flattenSettings,
    settingsTransferLink,
} from "../../../src/services/settings-transfer";
import { DEFAULT_SETTINGS } from "../../../src/constants";
import { deflateSync, strToU8 } from "fflate";

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function craft(body: unknown): string {
    const bytes = deflateSync(strToU8(JSON.stringify(body)));
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

describe("settings transfer", () => {
    it("moves changed settings and nothing private", () => {
        const s = clone(DEFAULT_SETTINGS);
        s.concurrency = 7;
        s.unifiedTriggers.autoSyncIntervalSec = 600;
        s.cloudRootFolder = "MyVaults";
        s.syncDotfiles = true;
        s.encryptionSecret = "secret-value";
        s.customProxyUrl = "https://proxy.example.com";
        s.authMethod = "custom-proxy";
        s.e2eeEnabled = true;
        s.hasCompletedFirstSync = true;

        const data = encodeSettingsTransfer(s, DEFAULT_SETTINGS);
        expect(data).toMatch(/^[A-Za-z0-9_-]+$/);
        const got = decodeSettingsTransfer(data, DEFAULT_SETTINGS);
        expect(got).toEqual({
            concurrency: 7,
            "unifiedTriggers.autoSyncIntervalSec": 600,
            cloudRootFolder: "MyVaults",
            syncDotfiles: true,
        });

        const target = clone(DEFAULT_SETTINGS);
        applyFlatSettings(target, got);
        expect(target.unifiedTriggers.autoSyncIntervalSec).toBe(600);
        expect(target.desktopTriggers.autoSyncIntervalSec).toBe(DEFAULT_SETTINGS.desktopTriggers.autoSyncIntervalSec);
        expect(target.concurrency).toBe(7);
        expect(target.encryptionSecret).toBe("");
    });

    it("keeps the link small enough for a QR code", () => {
        const s = clone(DEFAULT_SETTINGS);
        for (const [k, v] of Object.entries(flattenSettings(s))) {
            if (typeof v === "boolean") applyFlatSettings(s, { [k]: !v });
            if (typeof v === "number") applyFlatSettings(s, { [k]: v + 1 });
        }
        s.exclusionPatterns = Array.from({ length: 30 }, (_, i) => `folder-${i}/**`).join("\n");
        expect(settingsTransferLink(encodeSettingsTransfer(s, DEFAULT_SETTINGS)).length).toBeLessThan(1500);
    });

    it("drops unknown keys, wrong types and private keys from a crafted link", () => {
        const data = craft({
            v: 1,
            s: {
                concurrency: "9",
                syncDotfiles: true,
                customProxyUrl: "https://evil.example.com",
                authMethod: "custom-proxy",
                encryptionSecret: "x",
                __proto__: { polluted: true },
                constructor: 1,
                "unifiedTriggers.__proto__": 1,
                cloudRootFolder: "bad:name",
                notThere: 1,
            },
        });
        const got = decodeSettingsTransfer(data, DEFAULT_SETTINGS);
        expect(got).toEqual({ syncDotfiles: true });
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it("rejects data that is not a settings link", () => {
        expect(() => decodeSettingsTransfer("not-valid", DEFAULT_SETTINGS)).toThrow();
        expect(() => decodeSettingsTransfer(craft({ v: 2, s: {} }), DEFAULT_SETTINGS)).toThrow();
    });

    it("finds the data in a pasted link", () => {
        expect(dataFromLink("obsidian://cardinal-vault-sync-settings?d=abc_-1")).toBe("abc_-1");
        expect(dataFromLink("  abc  ")).toBe("abc");
        expect(dataFromLink("https://x?y=1")).toBeNull();
    });
});
