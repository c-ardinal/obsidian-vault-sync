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

    it("should NOT create directories or file if Keychain is active", async () => {
        const data = { token: "abc", refresh: "def" };

        // Initial state: data/local does not exist
        expect(await app.vault.adapter.exists("data")).toBe(false);

        await storage.saveCredentials(data);

        // Verify directories NOT created (we no longer need them if Keychain works)
        expect(await app.vault.adapter.exists("data")).toBe(false);

        // Verify file does NOT exist
        expect(await app.vault.adapter.exists("data/local/.sync-state")).toBe(false);

        // Verify it IS in Keychain
        const secretId = (storage as any).secretId;
        expect(app.secretStorage.getSecret(secretId)).toBe(JSON.stringify(data));
    });

    it("should load saved credentials", async () => {
        const data = { foo: "bar" };
        await storage.saveCredentials(data);

        // Should load from secretStorage first
        const loaded = await storage.loadCredentials();
        expect(loaded).toEqual(data);

        // Verify it was indeed in secretStorage
        const secretId = (storage as any).secretId;
        expect(app.secretStorage.getSecret(secretId)).toBe(JSON.stringify(data));
    });

    it("should fallback to file if secretStorage is empty", async () => {
        const data = { secret: "file-only" };

        // Bypass secretStorage for saving to test fallback
        const originalSecretStorage = app.secretStorage;
        (app as any).secretStorage = null;
        await storage.saveCredentials(data);
        (app as any).secretStorage = originalSecretStorage;

        // secretStorage is empty, should load from file
        const loaded = await storage.loadCredentials();
        expect(loaded).toEqual(data);

        // After loading, it should have migrated to secretStorage
        const secretId = (storage as any).secretId;
        expect(app.secretStorage.getSecret(secretId)).toBe(JSON.stringify(data));
    });

    it("should fail gracefully if file corrupted and secretStorage empty", async () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

        // Save to file only
        const originalSecretStorage = app.secretStorage;
        (app as any).secretStorage = null;
        await storage.saveCredentials({ a: 1 });

        // Corrupt file
        await app.vault.adapter.writeBinary(
            "data/local/.sync-state",
            new Uint8Array([1, 2, 3]).buffer,
        );

        (app as any).secretStorage = originalSecretStorage;
        // secretStorage is still empty (from before)
        app.secretStorage.setSecret((storage as any).secretId, "");

        const loaded = await storage.loadCredentials();
        expect(loaded).toBeNull();
        expect(errorSpy).toHaveBeenCalledWith("SecureStorage: Data too short");

        errorSpy.mockRestore();
    });

    it("should migrate legacy credentials to secretStorage and delete local file", async () => {
        const legacyPath = ".sync-state";
        const targetPath = "data/local/.sync-state";
        const legacyData = { legacy: true };

        // Save to file (simulating legacy)
        const originalSecretStorage = app.secretStorage;
        (app as any).secretStorage = null;
        await storage.saveCredentials(legacyData);
        (app as any).secretStorage = originalSecretStorage;

        const content = await app.vault.adapter.readBinary(targetPath);
        await app.vault.adapter.remove(targetPath);
        await app.vault.adapter.writeBinary(legacyPath, content);

        const loaded = await storage.loadCredentials();

        expect(loaded).toEqual(legacyData);
        // Verify migration and deletion
        expect(await app.vault.adapter.exists(legacyPath)).toBe(false);
        expect(await app.vault.adapter.exists(targetPath)).toBe(false); // Should be deleted now!
        const secretId = (storage as any).secretId;
        expect(app.secretStorage.getSecret(secretId)).toBe(JSON.stringify(legacyData));
    });

    it("should handle directory creation race condition in fallback mode", async () => {
        // Spy on createFolder
        const createSpy = vi.spyOn(app.vault, "createFolder");

        // Bypass secretStorage to trigger ensureDir via file-save fallback
        const originalSecretStorage = app.secretStorage;
        (app as any).secretStorage = null;
        await storage.saveCredentials({ test: 1 });
        (app as any).secretStorage = originalSecretStorage;

        // ensureDir logic:
        // 1. Check full dir "data/local". In mock, initially false.
        // 2. Loop part "data": exists? false -> createFolder("data")
        // 3. Loop part "data/local": exists? false -> createFolder("data/local")

        expect(createSpy).toHaveBeenCalledWith("data");
        expect(createSpy).toHaveBeenCalledWith("data/local");
    });
});
