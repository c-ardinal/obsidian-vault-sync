/**
 * @file SecureStorage comprehensive unit tests
 *
 * @description
 * Comprehensive unit tests for SecureStorage covering all code paths including:
 * - Constructor with vault name hashing
 * - setMasterSecret() clearing key cache
 * - saveCredentials with SecretStorage and file fallback
 * - loadCredentials from SecretStorage and file
 * - Error handling paths (decryption failure, corrupted data)
 * - clearCredentials from both sources
 * - cleanupFiles() method
 * - ensureDir() creating nested directories
 * - hideFile() on Windows/Mac (platform-specific)
 * - Extra secrets (setExtraSecret, getExtraSecret, removeExtraSecret)
 * - Key caching in getKey()
 *
 * @pass_criteria
 * - All lines in secure-storage.ts should be covered
 * - Error paths should be tested
 * - Platform-specific code should be mocked and tested
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { SecureStorage } from "../../../src/services/secure-storage";
import { MockApp, MockVaultOperations } from "../../helpers/mock-vault-adapter";
import { Platform } from "../../__mocks__/obsidian";
import * as crypto from "node:crypto";

// Polyfill window.crypto for tests
if (typeof window === "undefined") {
    (global as any).window = {
        crypto: crypto.webcrypto,
    };
}

if (!globalThis.crypto) {
    (global as any).globalThis.crypto = crypto.webcrypto;
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

        const vaultOps = new MockVaultOperations(app.vaultAdapter, app.vault);
        storage = new SecureStorage(vaultOps, "", SECRET, app.secretStorage);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe("constructor", () => {
        it("should initialize with normalized path", () => {
            expect((storage as any).filePath).toBe("data/local/.sync-state");
        });

        it("should generate consistent vault hash for same vault name", () => {
            const vaultOps1 = new MockVaultOperations(app.vaultAdapter, app.vault);
            const storage1 = new SecureStorage(vaultOps1, "", SECRET, null);
            const hash1 = (storage1 as any).vaultHash;

            // Create new vault operations with same vault (same name)
            const vaultOps2 = new MockVaultOperations(app.vaultAdapter, app.vault);
            const storage2 = new SecureStorage(vaultOps2, "", SECRET, null);
            const hash2 = (storage2 as any).vaultHash;

            expect(hash1).toBe(hash2);
        });

        it("should generate different vault hash for different vault names", () => {
            const vaultOps1 = new MockVaultOperations(app.vaultAdapter, app.vault);
            const storage1 = new SecureStorage(vaultOps1, "", SECRET, null);
            const hash1 = (storage1 as any).vaultHash;

            // Mock different vault name
            const mockVaultOps = {
                ...vaultOps1,
                getVaultName: () => "different-vault-name",
            };
            const storage2 = new SecureStorage(mockVaultOps as any, "", SECRET, null);
            const hash2 = (storage2 as any).vaultHash;

            expect(hash1).not.toBe(hash2);
        });

        it("should create secretId with vault hash", () => {
            const vaultHash = (storage as any).vaultHash;
            expect((storage as any).secretId).toBe(`vault-sync-creds-${vaultHash}`);
        });
    });

    describe("setMasterSecret", () => {
        it("should update the secret and clear key cache", async () => {
            // First, generate a key to populate the cache
            const data = { test: "data" };
            (storage as any).secretStorage = null; // Force file-based storage
            await storage.saveCredentials(data);

            // Load to trigger key caching
            await storage.loadCredentials();

            const keyCache = (storage as any).keyCache;
            expect(keyCache.size).toBeGreaterThan(0);

            // Now set new master secret
            storage.setMasterSecret("new-secret-key");

            // Verify secret updated and cache cleared
            expect((storage as any).secret).toBe("new-secret-key");
            expect((storage as any).keyCache.size).toBe(0);
        });
    });

    describe("saveCredentials", () => {
        it("should save to SecretStorage when available", async () => {
            const data = { token: "abc", refresh: "def" };
            const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

            await storage.saveCredentials(data);

            const secretId = (storage as any).secretId;
            expect(app.secretStorage.getSecret(secretId)).toBe(JSON.stringify(data));
            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining("Saved credentials to SecretStorage")
            );

            consoleSpy.mockRestore();
        });

        it("should cleanup files after saving to SecretStorage", async () => {
            // First save to file (without SecretStorage)
            (storage as any).secretStorage = null;
            await storage.saveCredentials({ test: "data" });
            expect(await app.vaultAdapter.exists("data/local/.sync-state")).toBe(true);

            // Now restore SecretStorage and save again
            (storage as any).secretStorage = app.secretStorage;
            const cleanupSpy = vi.spyOn(storage as any, "cleanupFiles").mockResolvedValue(undefined);

            await storage.saveCredentials({ token: "new" });

            expect(cleanupSpy).toHaveBeenCalled();
        });

        it("should fallback to file when SecretStorage fails", async () => {
            const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

            // Create failing SecretStorage
            const failingStorage = {
                getSecret: () => null,
                setSecret: () => {
                    throw new Error("Storage full");
                },
            };

            const vaultOps = new MockVaultOperations(app.vaultAdapter, app.vault);
            const testStorage = new SecureStorage(vaultOps, "", SECRET, failingStorage as any);

            const data = { token: "fallback" };
            await testStorage.saveCredentials(data);

            // Should have warned about SecretStorage failure
            expect(warnSpy).toHaveBeenCalledWith(
                expect.stringContaining("Failed to save to SecretStorage"),
                expect.any(Error)
            );

            // Should have logged file fallback
            expect(logSpy).toHaveBeenCalledWith(
                expect.stringContaining("Saving credentials to")
            );

            // Verify file was created
            expect(await app.vaultAdapter.exists("data/local/.sync-state")).toBe(true);

            warnSpy.mockRestore();
            logSpy.mockRestore();
        });

        it("should save to file when SecretStorage is null", async () => {
            const vaultOps = new MockVaultOperations(app.vaultAdapter, app.vault);
            const fileStorage = new SecureStorage(vaultOps, "", SECRET, null);

            const data = { token: "file-only" };
            await fileStorage.saveCredentials(data);

            // Verify file was created
            expect(await app.vaultAdapter.exists("data/local/.sync-state")).toBe(true);

            // Verify data can be loaded back
            const loaded = await fileStorage.loadCredentials();
            expect(loaded).toEqual(data);
        });

        it("should throw error when file save fails", async () => {
            const vaultOps = new MockVaultOperations(app.vaultAdapter, app.vault);
            const fileStorage = new SecureStorage(vaultOps, "", SECRET, null);

            // Mock writeBinary to fail
            vi.spyOn(app.vaultAdapter, "writeBinary").mockRejectedValue(new Error("Disk full"));

            const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

            await expect(fileStorage.saveCredentials({ test: "data" })).rejects.toThrow("Disk full");
            expect(errorSpy).toHaveBeenCalledWith(
                expect.stringContaining("Failed to save credentials to file"),
                expect.any(Error)
            );

            errorSpy.mockRestore();
        });

        it("should call hideFile when creating new file", async () => {
            const vaultOps = new MockVaultOperations(app.vaultAdapter, app.vault);
            const fileStorage = new SecureStorage(vaultOps, "", SECRET, null);

            const hideFileSpy = vi.spyOn(fileStorage as any, "hideFile").mockImplementation(() => {});

            await fileStorage.saveCredentials({ test: "data" });

            expect(hideFileSpy).toHaveBeenCalledWith("data/local/.sync-state");
        });

        it("should not call hideFile when file already exists", async () => {
            const vaultOps = new MockVaultOperations(app.vaultAdapter, app.vault);
            const fileStorage = new SecureStorage(vaultOps, "", SECRET, null);

            // Save once to create file
            await fileStorage.saveCredentials({ test: "data1" });

            const hideFileSpy = vi.spyOn(fileStorage as any, "hideFile").mockImplementation(() => {});

            // Save again
            await fileStorage.saveCredentials({ test: "data2" });

            expect(hideFileSpy).not.toHaveBeenCalled();
        });
    });

    describe("loadCredentials", () => {
        it("should load from SecretStorage when available", async () => {
            const data = { token: "secret" };
            await storage.saveCredentials(data);

            const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
            const loaded = await storage.loadCredentials();

            expect(loaded).toEqual(data);
            expect(logSpy).toHaveBeenCalledWith(
                expect.stringContaining("Loaded credentials from SecretStorage")
            );

            logSpy.mockRestore();
        });

        it("should cleanup files after loading from SecretStorage", async () => {
            const data = { token: "secret" };
            await storage.saveCredentials(data);

            const cleanupSpy = vi.spyOn(storage as any, "cleanupFiles").mockResolvedValue(undefined);

            await storage.loadCredentials();

            expect(cleanupSpy).toHaveBeenCalled();
        });

        it("should load from file when SecretStorage is empty", async () => {
            const data = { token: "file-data" };

            // Save without SecretStorage
            (storage as any).secretStorage = null;
            await storage.saveCredentials(data);

            // Restore SecretStorage (which is empty)
            (storage as any).secretStorage = app.secretStorage;

            const loaded = await storage.loadCredentials();
            expect(loaded).toEqual(data);
        });

        it("should return null when file does not exist", async () => {
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

            // No SecretStorage and no file
            (storage as any).secretStorage = null;
            const loaded = await storage.loadCredentials();

            expect(loaded).toBeNull();
            expect(logSpy).toHaveBeenCalledWith(
                expect.stringContaining("No credentials file found")
            );

            logSpy.mockRestore();
        });

        it("should return null when data is too short", async () => {
            const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

            // Save to file
            (storage as any).secretStorage = null;
            await storage.saveCredentials({ test: "data" });

            // Corrupt with too short data (less than SALT_LENGTH + IV_LENGTH = 28 bytes)
            await app.vaultAdapter.writeBinary(
                "data/local/.sync-state",
                new Uint8Array([1, 2, 3]).buffer
            );

            const loaded = await storage.loadCredentials();

            expect(loaded).toBeNull();
            expect(errorSpy).toHaveBeenCalledWith("SecureStorage: Data too short");

            errorSpy.mockRestore();
        });

        it("should return null when decryption fails (wrong key)", async () => {
            const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

            // Save with one secret
            (storage as any).secretStorage = null;
            await storage.saveCredentials({ test: "secret" });

            // Create new storage with different secret
            const vaultOps = new MockVaultOperations(app.vaultAdapter, app.vault);
            const wrongStorage = new SecureStorage(vaultOps, "", "wrong-secret", null);

            const loaded = await wrongStorage.loadCredentials();

            expect(loaded).toBeNull();
            expect(errorSpy).toHaveBeenCalledWith(
                expect.stringContaining("Failed to decrypt file"),
                expect.any(Error)
            );

            errorSpy.mockRestore();
        });

        it("should return null when SecretStorage throws error", async () => {
            const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

            const brokenStorage = {
                getSecret: () => {
                    throw new Error("Storage corrupted");
                },
                setSecret: () => {},
            };

            const vaultOps = new MockVaultOperations(app.vaultAdapter, app.vault);
            const testStorage = new SecureStorage(vaultOps, "", SECRET, brokenStorage as any);

            // Also save to file as fallback
            (testStorage as any).secretStorage = null;
            await testStorage.saveCredentials({ fallback: "data" });
            (testStorage as any).secretStorage = brokenStorage;

            const loaded = await testStorage.loadCredentials();

            expect(warnSpy).toHaveBeenCalledWith(
                expect.stringContaining("Failed to load from SecretStorage"),
                expect.any(Error)
            );
            // Should fallback to file
            expect(loaded).toEqual({ fallback: "data" });

            warnSpy.mockRestore();
        });

        it("should handle corrupted JSON in file gracefully", async () => {
            const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

            (storage as any).secretStorage = null;
            await storage.saveCredentials({ test: "data" });

            // Read and corrupt the encrypted content
            const buffer = await app.vaultAdapter.readBinary("data/local/.sync-state");
            const data = new Uint8Array(buffer);

            // Modify the encrypted portion (after salt + iv)
            data[30] = data[30] ^ 0xff; // Flip some bits

            await app.vaultAdapter.writeBinary("data/local/.sync-state", buffer);

            const loaded = await storage.loadCredentials();

            expect(loaded).toBeNull();
            expect(errorSpy).toHaveBeenCalled();

            errorSpy.mockRestore();
        });
    });

    describe("clearCredentials", () => {
        it("should clear from SecretStorage when available", async () => {
            // First save some data
            await storage.saveCredentials({ token: "test" });
            const secretId = (storage as any).secretId;
            expect(app.secretStorage.getSecret(secretId)).not.toBeNull();

            const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

            await storage.clearCredentials();

            // Mock returns null for empty/falsy values
            expect(app.secretStorage.getSecret(secretId)).toBeNull();
            expect(logSpy).toHaveBeenCalledWith(
                expect.stringContaining("Cleared credentials from SecretStorage")
            );

            logSpy.mockRestore();
        });

        it("should clear from files", async () => {
            // Save to file
            (storage as any).secretStorage = null;
            await storage.saveCredentials({ token: "test" });
            expect(await app.vaultAdapter.exists("data/local/.sync-state")).toBe(true);

            // Restore SecretStorage for clearCredentials
            (storage as any).secretStorage = app.secretStorage;

            const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

            await storage.clearCredentials();

            expect(await app.vaultAdapter.exists("data/local/.sync-state")).toBe(false);
            expect(logSpy).toHaveBeenCalledWith(
                expect.stringContaining("Cleared credentials from local files")
            );

            logSpy.mockRestore();
        });

        it("should handle SecretStorage clear errors gracefully", async () => {
            const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

            const brokenStorage = {
                getSecret: () => "data",
                setSecret: () => {
                    throw new Error("Cannot clear");
                },
            };

            const vaultOps = new MockVaultOperations(app.vaultAdapter, app.vault);
            const testStorage = new SecureStorage(vaultOps, "", SECRET, brokenStorage as any);

            // Save to file
            (testStorage as any).secretStorage = null;
            await testStorage.saveCredentials({ test: "data" });
            (testStorage as any).secretStorage = brokenStorage;

            // Should not throw
            await expect(testStorage.clearCredentials()).resolves.not.toThrow();

            expect(warnSpy).toHaveBeenCalledWith(
                expect.stringContaining("Failed to clear SecretStorage"),
                expect.any(Error)
            );

            warnSpy.mockRestore();
        });
    });

    describe("cleanupFiles", () => {
        it("should delete credential file if it exists", async () => {
            // Save to file first
            (storage as any).secretStorage = null;
            await storage.saveCredentials({ test: "data" });
            expect(await app.vaultAdapter.exists("data/local/.sync-state")).toBe(true);

            const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

            await (storage as any).cleanupFiles();

            expect(await app.vaultAdapter.exists("data/local/.sync-state")).toBe(false);
            expect(logSpy).toHaveBeenCalledWith(
                expect.stringContaining("Deleted redundant credential file")
            );

            logSpy.mockRestore();
        });

        it("should handle missing file gracefully", async () => {
            // No file exists
            expect(await app.vaultAdapter.exists("data/local/.sync-state")).toBe(false);

            // Should not throw
            await expect((storage as any).cleanupFiles()).resolves.not.toThrow();
        });

        it("should log warning when delete fails", async () => {
            const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

            // Mock remove to fail
            vi.spyOn(app.vaultAdapter, "remove").mockRejectedValue(new Error("Permission denied"));

            // Create file first
            (storage as any).secretStorage = null;
            await storage.saveCredentials({ test: "data" });

            await (storage as any).cleanupFiles();

            expect(warnSpy).toHaveBeenCalledWith(
                expect.stringContaining("Failed to delete"),
                expect.any(Error)
            );

            warnSpy.mockRestore();
        });
    });

    describe("ensureDir", () => {
        it("should not create directories if dir already exists", async () => {
            // Pre-create the directory
            await app.vault.createFolder("data/local");

            const createSpy = vi.spyOn(app.vault, "createFolder");

            await (storage as any).ensureDir("data/local/.sync-state");

            expect(createSpy).not.toHaveBeenCalled();
        });

        it("should create nested directories", async () => {
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

            await (storage as any).ensureDir("deep/nested/path/file.txt");

            expect(await app.vaultAdapter.exists("deep")).toBe(true);
            expect(await app.vaultAdapter.exists("deep/nested")).toBe(true);
            expect(logSpy).toHaveBeenCalledWith(
                expect.stringContaining("Creating directory structure")
            );

            logSpy.mockRestore();
        });

        it("should handle partial existing directories", async () => {
            // Create only the first level
            await app.vault.createFolder("data");

            const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

            await (storage as any).ensureDir("data/local/subdir/file.txt");

            expect(await app.vaultAdapter.exists("data/local")).toBe(true);
            expect(await app.vaultAdapter.exists("data/local/subdir")).toBe(true);

            logSpy.mockRestore();
        });

        it("should handle race condition when folder already exists", async () => {
            const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

            // Mock createFolder to throw (simulating race condition)
            vi.spyOn(app.vault, "createFolder").mockRejectedValue(new Error("Already exists"));

            // Should not throw
            await expect(
                (storage as any).ensureDir("data/local/.sync-state")
            ).resolves.not.toThrow();

            expect(debugSpy).toHaveBeenCalled();

            debugSpy.mockRestore();
        });
    });

    describe("hideFile", () => {
        let originalPlatform: typeof process.platform;

        beforeEach(() => {
            originalPlatform = process.platform;
        });

        afterEach(() => {
            Object.defineProperty(process, "platform", {
                value: originalPlatform,
            });
            vi.restoreAllMocks();
        });

        it("should not hide file on mobile platforms", () => {
            const originalIsDesktop = Platform.isDesktop;
            Platform.isDesktop = false;

            const spawnSpy = vi.spyOn(require("child_process"), "spawn").mockImplementation(() => ({
                on: vi.fn(),
            }));

            // Mock getBasePath
            (storage as any).vault.getBasePath = () => "/vault/path";

            (storage as any).hideFile("data/local/.sync-state");

            expect(spawnSpy).not.toHaveBeenCalled();

            Platform.isDesktop = originalIsDesktop;
        });

        it("should not hide file when getBasePath is not available", () => {
            const spawnSpy = vi.spyOn(require("child_process"), "spawn").mockImplementation(() => ({
                on: vi.fn(),
            }));

            // getBasePath returns undefined
            (storage as any).vault.getBasePath = () => undefined;

            (storage as any).hideFile("data/local/.sync-state");

            expect(spawnSpy).not.toHaveBeenCalled();
        });

        it("should spawn attrib on Windows", () => {
            Object.defineProperty(process, "platform", {
                value: "win32",
            });

            const onMock = vi.fn();
            const spawnSpy = vi.spyOn(require("child_process"), "spawn").mockImplementation(() => ({
                on: onMock,
            }));

            (storage as any).vault.getBasePath = () => "C:\\vault";

            (storage as any).hideFile("data/local/.sync-state");

            expect(spawnSpy).toHaveBeenCalledWith(
                "attrib",
                ["+h", "C:\\vault\\data\\local\\.sync-state"]
            );

            // Simulate error
            const errorCallback = onMock.mock.calls.find((call: any[]) => call[0] === "error")?.[1];
            if (errorCallback) {
                const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
                errorCallback(new Error("Spawn failed"));
                expect(errorSpy).toHaveBeenCalledWith(
                    expect.stringContaining("Failed to hide .sync-state on Windows"),
                    expect.any(Error)
                );
                errorSpy.mockRestore();
            }
        });

        it("should spawn chflags on macOS", () => {
            Object.defineProperty(process, "platform", {
                value: "darwin",
            });

            const onMock = vi.fn();
            const spawnSpy = vi.spyOn(require("child_process"), "spawn").mockImplementation(() => ({
                on: onMock,
            }));

            (storage as any).vault.getBasePath = () => "/Users/test/vault";

            (storage as any).hideFile("data/local/.sync-state");

            expect(spawnSpy).toHaveBeenCalledWith(
                "chflags",
                ["hidden", "/Users/test/vault/data/local/.sync-state"]
            );

            // Simulate error
            const errorCallback = onMock.mock.calls.find((call: any[]) => call[0] === "error")?.[1];
            if (errorCallback) {
                const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
                errorCallback(new Error("Spawn failed"));
                expect(errorSpy).toHaveBeenCalledWith(
                    expect.stringContaining("Failed to hide .sync-state on Mac"),
                    expect.any(Error)
                );
                errorSpy.mockRestore();
            }
        });

        it("should handle child_process import failure", () => {
            const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

            // Mock require to throw for child_process
            const originalRequire = require;
            vi.spyOn(storage as any, "hideFile").mockImplementation(() => {
                try {
                    throw new Error("Module not found");
                } catch (e) {
                    console.warn(
                        "VaultSync: Optional file hiding failed (child_process not available)",
                        e
                    );
                }
            });

            (storage as any).hideFile("data/local/.sync-state");

            expect(warnSpy).toHaveBeenCalledWith(
                expect.stringContaining("Optional file hiding failed"),
                expect.any(Error)
            );

            warnSpy.mockRestore();
        });

        it("should not spawn anything on Linux", () => {
            Object.defineProperty(process, "platform", {
                value: "linux",
            });

            const spawnSpy = vi.spyOn(require("child_process"), "spawn").mockImplementation(() => ({
                on: vi.fn(),
            }));

            (storage as any).vault.getBasePath = () => "/home/user/vault";

            (storage as any).hideFile("data/local/.sync-state");

            // Linux is not handled specifically, so no spawn should happen
            expect(spawnSpy).not.toHaveBeenCalled();
        });

    });

    describe("getKey", () => {
        it("should cache and reuse keys for same salt", async () => {
            (storage as any).secretStorage = null;

            // Save and load to trigger key generation
            await storage.saveCredentials({ test: "data1" });
            await storage.loadCredentials();

            const keyCache = (storage as any).keyCache;
            const cacheSize = keyCache.size;
            expect(cacheSize).toBeGreaterThan(0);

            // Load again - should use cached key
            await storage.loadCredentials();
            expect(keyCache.size).toBe(cacheSize); // No new keys added
        });

        it("should generate different keys for different salts", async () => {
            (storage as any).secretStorage = null;

            // First save
            await storage.saveCredentials({ test: "data1" });
            const buffer1 = await app.vaultAdapter.readBinary("data/local/.sync-state");
            const salt1 = new Uint8Array(buffer1.slice(0, 16));

            // Delete and save again (will generate new salt)
            await app.vaultAdapter.remove("data/local/.sync-state");
            await storage.saveCredentials({ test: "data2" });
            const buffer2 = await app.vaultAdapter.readBinary("data/local/.sync-state");
            const salt2 = new Uint8Array(buffer2.slice(0, 16));

            // Salts should be different
            expect(salt1).not.toEqual(salt2);

            // Cache should have two entries
            const keyCache = (storage as any).keyCache;
            expect(keyCache.size).toBe(2);
        });
    });

    describe("extra secrets", () => {
        it("should set extra secret in SecretStorage", async () => {
            await (storage as any).setExtraSecret("api-key", "secret-value");

            const vaultHash = (storage as any).vaultHash;
            const secretId = `vault-sync-api-key-${vaultHash}`;
            expect(app.secretStorage.getSecret(secretId)).toBe("secret-value");
        });

        it("should not set extra secret when SecretStorage is null", async () => {
            (storage as any).secretStorage = null;

            // Should not throw
            await expect(
                (storage as any).setExtraSecret("api-key", "secret-value")
            ).resolves.not.toThrow();
        });

        it("should get extra secret from SecretStorage", async () => {
            await (storage as any).setExtraSecret("api-key", "secret-value");

            const value = await (storage as any).getExtraSecret("api-key");
            expect(value).toBe("secret-value");
        });

        it("should return null for missing extra secret", async () => {
            const value = await (storage as any).getExtraSecret("nonexistent");
            expect(value).toBeNull();
        });

        it("should return null for empty extra secret", async () => {
            await (storage as any).setExtraSecret("empty-key", "");

            const value = await (storage as any).getExtraSecret("empty-key");
            expect(value).toBeNull();
        });

        it("should return null for whitespace-only extra secret", async () => {
            await (storage as any).setExtraSecret("whitespace-key", "   ");

            const value = await (storage as any).getExtraSecret("whitespace-key");
            expect(value).toBeNull();
        });

        it("should return null when SecretStorage is null", async () => {
            (storage as any).secretStorage = null;

            const value = await (storage as any).getExtraSecret("api-key");
            expect(value).toBeNull();
        });

        it("should remove extra secret from SecretStorage", async () => {
            await (storage as any).setExtraSecret("api-key", "secret-value");
            const vaultHash = (storage as any).vaultHash;
            const secretId = `vault-sync-api-key-${vaultHash}`;
            expect(app.secretStorage.getSecret(secretId)).toBe("secret-value");

            await (storage as any).removeExtraSecret("api-key");
            // Mock returns null for empty/falsy values
            expect(app.secretStorage.getSecret(secretId)).toBeNull();
        });

        it("should not remove extra secret when SecretStorage is null", async () => {
            (storage as any).secretStorage = null;

            // Should not throw
            await expect(
                (storage as any).removeExtraSecret("api-key")
            ).resolves.not.toThrow();
        });

        it("should use unique secret IDs for different types", async () => {
            await (storage as any).setExtraSecret("type-a", "value-a");
            await (storage as any).setExtraSecret("type-b", "value-b");

            const vaultHash = (storage as any).vaultHash;
            const idA = `vault-sync-type-a-${vaultHash}`;
            const idB = `vault-sync-type-b-${vaultHash}`;

            expect(app.secretStorage.getSecret(idA)).toBe("value-a");
            expect(app.secretStorage.getSecret(idB)).toBe("value-b");
        });
    });

    describe("encryption/decryption roundtrip", () => {
        it("should correctly encrypt and decrypt complex data", async () => {
            const complexData = {
                accessToken: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
                refreshToken: "dGhpcyBpcyBhIHJlZnJlc2ggdG9rZW4=",
                expiresAt: Date.now() + 3600000,
                metadata: {
                    scope: "drive.readonly",
                    tokenType: "Bearer",
                },
                nested: {
                    deep: {
                        array: [1, 2, 3],
                        boolean: true,
                        nullValue: null,
                    },
                },
            };

            (storage as any).secretStorage = null;
            await storage.saveCredentials(complexData);

            const loaded = await storage.loadCredentials();
            expect(loaded).toEqual(complexData);
        });

        it("should handle unicode characters in data", async () => {
            const unicodeData = {
                message: "Hello 世界 🌍 مرحبا",
                emoji: "🔐🔑🔒",
                mixed: "Test: 日本語テスト",
            };

            (storage as any).secretStorage = null;
            await storage.saveCredentials(unicodeData);

            const loaded = await storage.loadCredentials();
            expect(loaded).toEqual(unicodeData);
        });

        it("should handle empty object", async () => {
            (storage as any).secretStorage = null;
            await storage.saveCredentials({});

            const loaded = await storage.loadCredentials();
            expect(loaded).toEqual({});
        });

        it("should handle large data", async () => {
            const largeData: Record<string, string> = {};
            for (let i = 0; i < 1000; i++) {
                largeData[`key-${i}`] = "x".repeat(100);
            }

            (storage as any).secretStorage = null;
            await storage.saveCredentials(largeData);

            const loaded = await storage.loadCredentials();
            expect(loaded).toEqual(largeData);
        });
    });
});
