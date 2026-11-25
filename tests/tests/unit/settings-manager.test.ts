/**
 * @file SettingsManager: loading and saving the split settings files
 *
 * @description
 * Settings live in two files: open-data.json (synced with the vault) and
 * local-data.json (this device only). The encryption secret for the stored
 * sign-in is made on first start and kept in the OS keychain (SecretStorage)
 * when there is one, else in local-data.json. Runs on the in-memory vault.
 *
 * @pass_criteria
 * - first start: a secret is made and saved; it is never written to open-data.json
 * - with SecretStorage: the secret is in the keychain only and comes back from there
 * - open-data.json + local-data.json are merged; missing nested fields get defaults
 * - a damaged settings file falls back to defaults instead of failing the start
 * - a reload keeps the same settings object (other parts hold a reference)
 * - stored sign-in reaches the adapter; old installs with a client ID default to
 *   "client-credentials", an explicit choice is kept
 * - a per-device exclusion list from an early build moves to this device kind's list
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import * as nodeCrypto from "node:crypto";
import { SettingsManager } from "../../../src/services/settings-manager";
import { SecureStorage } from "../../../src/services/secure-storage";
import { DEFAULT_SETTINGS } from "../../../src/constants";
import { MockApp, MockVaultOperations } from "../../helpers/mock-vault-adapter";

if (typeof window === "undefined") (globalThis as any).window = { crypto: nodeCrypto.webcrypto };
if (!(window as any).crypto) (window as any).crypto = nodeCrypto.webcrypto;

const DIR = ".obsidian/plugins/cardinal-vault-sync";
const OPEN = `${DIR}/data/flexible/open-data.json`;
const LOCAL = `${DIR}/data/local/local-data.json`;

function fakeAdapter() {
    return {
        setCredentials: vi.fn(),
        setTokens: vi.fn(),
        updateConfig: vi.fn(),
        setAuthConfig: vi.fn(),
    };
}

describe("SettingsManager", () => {
    let app: MockApp;
    let vaultOps: MockVaultOperations;
    let adapter: ReturnType<typeof fakeAdapter>;

    const manager = (secretStorage: MockApp["secretStorage"] | null = null) =>
        new SettingsManager({
            vaultOps,
            manifestDir: DIR,
            adapter: adapter as never,
            appSecretStorage: secretStorage,
        });
    const readJson = async (path: string) => JSON.parse(await vaultOps.read(path)) as Record<string, unknown>;

    beforeEach(() => {
        app = new MockApp();
        vaultOps = new MockVaultOperations(app.vaultAdapter, app.vault);
        adapter = fakeAdapter();
    });

    it("makes and saves a secret on first start, never in the synced file", async () => {
        const m = manager();
        await m.loadSettings();

        expect(m.settings.encryptionSecret).toMatch(/^[0-9a-f]{64}$/);
        expect((await readJson(LOCAL)).encryptionSecret).toBe(m.settings.encryptionSecret);
        const open = await readJson(OPEN);
        expect(open).not.toHaveProperty("encryptionSecret");
        expect(open).not.toHaveProperty("hasCompletedFirstSync");
        expect(open.concurrency).toBe(DEFAULT_SETTINGS.concurrency);
        expect(adapter.setAuthConfig).toHaveBeenCalledWith(DEFAULT_SETTINGS.authMethod, DEFAULT_SETTINGS.customProxyUrl);

        // The next start keeps the same secret
        const again = manager();
        await again.loadSettings();
        expect(again.settings.encryptionSecret).toBe(m.settings.encryptionSecret);
    });

    it("keeps the secret in the keychain only when there is one", async () => {
        const m = manager(app.secretStorage);
        await m.loadSettings();
        const secret = m.settings.encryptionSecret;

        expect((await readJson(LOCAL)).encryptionSecret).toBeUndefined();
        const again = manager(app.secretStorage);
        await again.loadSettings();
        expect(again.settings.encryptionSecret).toBe(secret);
    });

    it("merges both files and fills nested fields the files lack", async () => {
        await vaultOps.createFolder(`${DIR}/data/flexible`);
        await vaultOps.createFolder(`${DIR}/data/local`);
        await vaultOps.write(OPEN, JSON.stringify({ concurrency: 2, unifiedTriggers: { autoSyncIntervalSec: 60 } }));
        await vaultOps.write(LOCAL, JSON.stringify({ encryptionSecret: "a".repeat(64), concurrency: 3 }));

        const m = manager();
        await m.loadSettings();

        expect(m.settings.concurrency).toBe(3); // the device's own file wins
        expect(m.settings.encryptionSecret).toBe("a".repeat(64));
        expect(m.settings.unifiedTriggers.autoSyncIntervalSec).toBe(60);
        expect(m.settings.unifiedTriggers.onModifyDelaySec).toBe(DEFAULT_SETTINGS.unifiedTriggers.onModifyDelaySec);
    });

    it("starts with defaults when a settings file is damaged", async () => {
        await vaultOps.createFolder(`${DIR}/data/flexible`);
        await vaultOps.write(OPEN, "{ not json");
        vi.spyOn(console, "error").mockImplementation(() => {});

        const m = manager();
        await expect(m.loadSettings()).resolves.toBeUndefined();
        expect(m.settings.concurrency).toBe(DEFAULT_SETTINGS.concurrency);
        // Saved again in a readable form
        expect((await readJson(OPEN)).concurrency).toBe(DEFAULT_SETTINGS.concurrency);
    });

    it("keeps the same settings object on a reload", async () => {
        const m = manager();
        await m.loadSettings();
        const held = m.settings;
        await vaultOps.write(OPEN, JSON.stringify({ ...(await readJson(OPEN)), concurrency: 7 }));

        await m.loadSettings();
        expect(m.settings).toBe(held);
        expect(held.concurrency).toBe(7);
    });

    it("hands the stored sign-in to the adapter", async () => {
        const first = manager();
        await first.loadSettings();
        await first.secureStorage.saveCredentials({
            clientId: "cid",
            clientSecret: "csec",
            accessToken: "at",
            refreshToken: "rt",
            tokenExpiresAt: 123,
        });
        // Settings saved by a build from before the sign-in choice (no authMethod)
        const { authMethod: _dropped, ...older } = await readJson(OPEN);
        await vaultOps.write(OPEN, JSON.stringify(older));

        const m = manager();
        await m.loadSettings();
        expect(adapter.setCredentials).toHaveBeenLastCalledWith("cid", "csec");
        expect(adapter.setTokens).toHaveBeenLastCalledWith("at", "rt", 123);
        expect(adapter.updateConfig).toHaveBeenLastCalledWith(
            "cid",
            "csec",
            vaultOps.getVaultName(),
            DEFAULT_SETTINGS.cloudRootFolder,
        );
        // An install from before the sign-in choice, with its own client ID
        expect(m.settings.authMethod).toBe("client-credentials");
        expect(adapter.setAuthConfig).toHaveBeenLastCalledWith("client-credentials", DEFAULT_SETTINGS.customProxyUrl);
    });

    it("keeps an explicit sign-in choice even with a stored client ID", async () => {
        const first = manager();
        await first.loadSettings();
        first.settings.authMethod = "default";
        await first.saveSettings();
        await first.secureStorage.saveCredentials({ clientId: "cid", clientSecret: "csec" });

        const m = manager();
        await m.loadSettings();
        expect(m.settings.authMethod).toBe("default");
    });

    it("moves an early build's per-device exclusion list to the desktop list", async () => {
        await vaultOps.createFolder(`${DIR}/data/local`);
        await vaultOps.write(LOCAL, JSON.stringify({ encryptionSecret: "b".repeat(64), deviceExclusionPatterns: "big/**" }));

        const m = manager();
        await m.loadSettings();
        expect(m.settings.desktopExclusionPatterns).toBe("big/**");
        expect(m.settings).not.toHaveProperty("deviceExclusionPatterns");
    });

    it("works with SecureStorage made from the loaded secret", async () => {
        const m = manager();
        await m.loadSettings();
        expect(m.secureStorage).toBeInstanceOf(SecureStorage);
    });
});
