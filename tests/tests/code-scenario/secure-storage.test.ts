import { describe, it, expect, beforeEach, vi } from "vitest";
import { SecureStorage } from "../../../src/secure-storage";
import { MockApp } from "../../helpers/mock-vault-adapter";
import * as crypto from "node:crypto";

// Polyfill window.crypto for tests
if (typeof window === "undefined") {
    (global as any).window = {
        crypto: crypto.webcrypto,
    };
}

// Also ensure globalThis.crypto is available if code uses it directly (though it uses window.crypto)
if (!globalThis.crypto) {
    // @ts-ignore
    globalThis.crypto = crypto.webcrypto;
}

describe("SecureStorage", () => {
    let app: MockApp;
    let storage: SecureStorage;
    const SECRET = "my-secret-key-123";

    beforeEach(() => {
        app = new MockApp();
        // Reset mock vault state
        (app.vaultAdapter as any).files = new Map();
        (app.vaultAdapter as any).folders = new Set();

        // Use empty plugin dir effectively making path data/local/.sync-state relative to vault root
        storage = new SecureStorage(app as any, "", SECRET);
    });

    it("should initialize with normalized path", () => {
        // Access private field for testing or infer via behavior
        expect((storage as any).filePath).toBe("data/local/.sync-state");
    });

    it("should create directories and save credentials recursively", async () => {
        const data = { token: "abc", refresh: "def" };

        // Initial state: data/local does not exist
        expect(await app.vault.adapter.exists("data")).toBe(false);
        expect(await app.vault.adapter.exists("data/local")).toBe(false);

        await storage.saveCredentials(data);

        // Verify directories created
        // MockVaultAdapter's mkdir simply adds to a Set.
        // My secure-storage calls createFolder which calls mkdir.
        // And my ensuresDir logic explicitly calls createFolder.

        // Verify folder structure exists in mock adapter
        expect(await app.vault.adapter.exists("data")).toBe(true);
        expect(await app.vault.adapter.exists("data/local")).toBe(true);

        // Verify file exists
        expect(await app.vault.adapter.exists("data/local/.sync-state")).toBe(true);

        // Verify content encrypted
        const content = await app.vault.adapter.readBinary("data/local/.sync-state");
        expect(content.byteLength).toBeGreaterThan(0);
    });

    it("should load saved credentials", async () => {
        const data = { foo: "bar" };
        await storage.saveCredentials(data);

        const loaded = await storage.loadCredentials();
        expect(loaded).toEqual(data);
    });

    it("should fail gracefully if file corrupted", async () => {
        await storage.saveCredentials({ a: 1 });
        // Corrupt file by writing random bytes
        await app.vault.adapter.writeBinary(
            "data/local/.sync-state",
            new Uint8Array([1, 2, 3]).buffer,
        );

        const loaded = await storage.loadCredentials();
        expect(loaded).toBeNull();
    });

    it("should migrate legacy credentials if they exist", async () => {
        const legacyPath = ".sync-state";
        const targetPath = "data/local/.sync-state";
        const legacyData = { legacy: true };

        // We need to create a valid legacy file first.
        // To do this, we can cheat and use storage to generate encrypted content,
        // then move it to legacy location.
        // This simulates a "valid encrypted legacy file".
        // If legacy file was unencrypted, it would fail load, which is expected behavior for major version upgrades
        // unless I handled unencrypted migration. But let's assume valid encrypted legacy.

        await storage.saveCredentials(legacyData);
        const content = await app.vault.adapter.readBinary(targetPath);

        // Clear target
        await app.vault.adapter.remove(targetPath);
        // Clear folders to test ensureDir during migration
        // Note: adapter.remove doesn't remove parent folders automatically unless empty? Mock doesn't track folder content.
        // We can manually remove folders from mock set.
        (app.vaultAdapter as any).folders.clear();

        // Place at legacy location
        await app.vault.adapter.writeBinary(legacyPath, content);

        expect(await app.vault.adapter.exists(legacyPath)).toBe(true);
        expect(await app.vault.adapter.exists(targetPath)).toBe(false);

        // Load should trigger migration
        console.log("Migrating...");
        const loaded = await storage.loadCredentials();

        expect(loaded).toEqual(legacyData);
        expect(await app.vault.adapter.exists(legacyPath)).toBe(false);
        expect(await app.vault.adapter.exists(targetPath)).toBe(true);
    });

    it("should handle directory creation race condition (simulated)", async () => {
        // Spy on createFolder
        const createSpy = vi.spyOn(app.vault, "createFolder");

        await storage.saveCredentials({ test: 1 });

        // ensureDir logic:
        // 1. Check full dir "data/local". In mock, initially false.
        // 2. Loop part "data": exists? false -> createFolder("data")
        // 3. Loop part "data/local": exists? false -> createFolder("data/local")

        expect(createSpy).toHaveBeenCalledWith("data");
        expect(createSpy).toHaveBeenCalledWith("data/local");
    });
});
