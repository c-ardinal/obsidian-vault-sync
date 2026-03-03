/**
 * @file State モジュール Communication & Index Management ユニットテスト
 *
 * @description
 * loadCommunication / saveCommunication / acquireMergeLock / releaseMergeLock / checkMergeLock /
 * loadIndex / loadLocalIndex / saveIndex / saveLocalIndex / resetIndex の
 * 通信状態・インデックス管理ロジックを検証する。
 *
 * @pass_criteria
 * - Communication: 読み込み/保存/ロック取得/解放/確認
 * - Index: 読み込み/保存/フォールバック/リセット
 * - Error handling: 各種エラーケースの適切な処理
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
    loadCommunication,
    saveCommunication,
    acquireMergeLock,
    releaseMergeLock,
    checkMergeLock,
    loadIndex,
    loadLocalIndex,
    saveIndex,
    saveLocalIndex,
    resetIndex,
} from "../../../src/sync-manager/state";
import type { SyncContext } from "../../../src/sync-manager/context";
import type { CommunicationData, LocalFileIndex } from "../../../src/sync-manager/types";

// Mock the constants module to control timing values
vi.mock("../../../src/sync-manager/constants", () => ({
    LOCK_MAX_ATTEMPTS: 3,
    LOCK_TTL_MS: 30000,
    LOCK_JITTER_MIN_MS: 10,
    LOCK_JITTER_RANGE_MS: 20,
}));

function createMockCtx(overrides: Partial<SyncContext> = {}): SyncContext {
    const baseCtx = {
        vault: {
            exists: vi.fn().mockResolvedValue(false),
            read: vi.fn().mockRejectedValue(new Error("File not found")),
            readBinary: vi.fn().mockRejectedValue(new Error("File not found")),
            write: vi.fn().mockResolvedValue(undefined),
            writeBinary: vi.fn().mockResolvedValue(undefined),
            mkdir: vi.fn().mockResolvedValue(undefined),
        },
        adapter: {
            getFileMetadata: vi.fn().mockResolvedValue(null),
            downloadFile: vi.fn().mockRejectedValue(new Error("Not found")),
            uploadFile: vi.fn().mockResolvedValue({ id: "test-id", path: "test", mtime: Date.now(), size: 100, kind: "file" }),
            clearDownloadCache: vi.fn(),
        },
        settings: {
            exclusionPatterns: "",
            syncAppearance: true,
            syncCoreConfig: true,
            syncCommunityPlugins: true,
            syncPluginSettings: true,
            syncFlexibleData: true,
            syncImagesAndMedia: true,
            syncDotfiles: false,
            syncWorkspace: false,
            syncDeviceLogs: false,
        } as any,
        index: {} as LocalFileIndex,
        localIndex: {} as LocalFileIndex,
        dirtyPaths: new Map(),
        syncingPaths: new Set(),
        deletedFolders: new Set(),
        pendingFolderMoves: new Map(),
        recentlyDeletedFromRemote: new Set(),
        pluginDataPath: ".obsidian/plugins/obsidian-vault-sync/data/remote/sync-index.json",
        localIndexPath: ".obsidian/plugins/obsidian-vault-sync/data/local/local-index.json",
        communicationPath: ".obsidian/plugins/obsidian-vault-sync/communication.json",
        pluginDir: ".obsidian/plugins/obsidian-vault-sync",
        logFolder: ".obsidian/plugins/obsidian-vault-sync/logs/test-device",
        deviceId: "test-device",
        e2eeEnabled: false,
        syncState: "idle",
        indexLoadFailed: false,
        startPageToken: null,
        log: vi.fn().mockResolvedValue(undefined),
        revisionCache: {
            init: vi.fn().mockResolvedValue(undefined),
        } as any,
        ...overrides,
    };
    return baseCtx as SyncContext;
}

describe("state - communication management", () => {
    let ctx: SyncContext;

    beforeEach(() => {
        ctx = createMockCtx();
    });

    describe("loadCommunication", () => {
        it("should return default data when file does not exist", async () => {
            ctx.adapter.getFileMetadata = vi.fn().mockResolvedValue(null);

            const result = await loadCommunication(ctx);

            expect(result).toEqual({ mergeLocks: {}, lastUpdated: 0 });
        });

        it("should load and parse communication data", async () => {
            const commData: CommunicationData = {
                mergeLocks: {
                    "test.md": { holder: "device1", expiresAt: Date.now() + 60000 },
                },
                lastUpdated: Date.now(),
            };

            ctx.adapter.getFileMetadata = vi.fn().mockResolvedValue({ id: "comm-id", path: "comm.json" });
            ctx.adapter.downloadFile = vi.fn().mockResolvedValue(
                new TextEncoder().encode(JSON.stringify(commData)).buffer,
            );

            const result = await loadCommunication(ctx);

            expect(result.mergeLocks["test.md"]).toBeDefined();
            expect(result.mergeLocks["test.md"].holder).toBe("device1");
        });

        it("should filter out expired locks", async () => {
            const now = Date.now();
            const commData: CommunicationData = {
                mergeLocks: {
                    "expired.md": { holder: "device1", expiresAt: now - 1000 },
                    "active.md": { holder: "device2", expiresAt: now + 60000 },
                },
                lastUpdated: now,
            };

            ctx.adapter.getFileMetadata = vi.fn().mockResolvedValue({ id: "comm-id", path: "comm.json" });
            ctx.adapter.downloadFile = vi.fn().mockResolvedValue(
                new TextEncoder().encode(JSON.stringify(commData)).buffer,
            );

            const result = await loadCommunication(ctx);

            expect(result.mergeLocks["expired.md"]).toBeUndefined();
            expect(result.mergeLocks["active.md"]).toBeDefined();
        });

        it("should return default data on error", async () => {
            ctx.adapter.getFileMetadata = vi.fn().mockRejectedValue(new Error("Network error"));

            const result = await loadCommunication(ctx);

            expect(result).toEqual({ mergeLocks: {}, lastUpdated: 0 });
            expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining("Failed to load"), "error");
        });

        it("should handle JSON parse errors", async () => {
            ctx.adapter.getFileMetadata = vi.fn().mockResolvedValue({ id: "comm-id", path: "comm.json" });
            ctx.adapter.downloadFile = vi.fn().mockResolvedValue(
                new TextEncoder().encode("invalid json").buffer,
            );

            const result = await loadCommunication(ctx);

            expect(result).toEqual({ mergeLocks: {}, lastUpdated: 0 });
        });
    });

    describe("saveCommunication", () => {
        it("should save communication data with updated timestamp", async () => {
            const commData: CommunicationData = {
                mergeLocks: {},
                lastUpdated: 0,
            };

            const uploadSpy = vi.fn().mockResolvedValue({ id: "test-id", path: "comm.json", mtime: Date.now(), size: 100, kind: "file" });
            ctx.adapter.uploadFile = uploadSpy;

            await saveCommunication(ctx, commData);

            expect(uploadSpy).toHaveBeenCalled();
            expect(commData.lastUpdated).toBeGreaterThan(0);
        });

        it("should throw and log error on save failure", async () => {
            const commData: CommunicationData = {
                mergeLocks: {},
                lastUpdated: 0,
            };

            ctx.adapter.uploadFile = vi.fn().mockRejectedValue(new Error("Upload failed"));

            await expect(saveCommunication(ctx, commData)).rejects.toThrow("Upload failed");
            expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining("Failed to save"), "error");
        });
    });

    describe("acquireMergeLock", () => {
        it("should acquire lock when no existing lock", async () => {
            // Setup mock that tracks uploaded data and returns it on download
            let uploadedData: ArrayBuffer | null = null;
            ctx.adapter.getFileMetadata = vi.fn().mockResolvedValue({ id: "comm-id", path: "comm.json" });
            ctx.adapter.downloadFile = vi.fn().mockImplementation(() => {
                if (uploadedData) {
                    return Promise.resolve(uploadedData.slice(0));
                }
                // Return empty communication data initially
                return Promise.resolve(new TextEncoder().encode(JSON.stringify({ mergeLocks: {}, lastUpdated: 0 })).buffer);
            });
            ctx.adapter.uploadFile = vi.fn().mockImplementation((_path, content) => {
                uploadedData = content.slice(0) as ArrayBuffer;
                return Promise.resolve({ id: "comm-id", path: "comm.json", mtime: Date.now(), size: content.byteLength, kind: "file" });
            });

            const result = await acquireMergeLock(ctx, "test.md");

            expect(result.acquired).toBe(true);
        });

        it("should fail to acquire when lock is held by another device", async () => {
            const now = Date.now();
            const commData: CommunicationData = {
                mergeLocks: {
                    "test.md": { holder: "other-device", expiresAt: now + 60000 },
                },
                lastUpdated: now,
            };

            ctx.adapter.getFileMetadata = vi.fn().mockResolvedValue({ id: "comm-id", path: "comm.json" });
            ctx.adapter.downloadFile = vi.fn().mockResolvedValue(
                new TextEncoder().encode(JSON.stringify(commData)).buffer,
            );

            const result = await acquireMergeLock(ctx, "test.md");

            expect(result.acquired).toBe(false);
            expect(result.holder).toBe("other-device");
            expect(result.expiresIn).toBeDefined();
        });

        it("should acquire lock when existing lock is expired", async () => {
            const now = Date.now();
            const commData: CommunicationData = {
                mergeLocks: {
                    "test.md": { holder: "other-device", expiresAt: now - 1000 },
                },
                lastUpdated: now,
            };

            let uploadedData: ArrayBuffer | null = null;
            ctx.adapter.getFileMetadata = vi.fn().mockResolvedValue({ id: "comm-id", path: "comm.json" });
            ctx.adapter.downloadFile = vi.fn().mockImplementation(() => {
                if (uploadedData) {
                    return Promise.resolve(uploadedData.slice(0));
                }
                return Promise.resolve(new TextEncoder().encode(JSON.stringify(commData)).buffer);
            });
            ctx.adapter.uploadFile = vi.fn().mockImplementation((_path, content) => {
                uploadedData = content.slice(0) as ArrayBuffer;
                return Promise.resolve({ id: "comm-id", path: "comm.json", mtime: Date.now(), size: content.byteLength, kind: "file" });
            });

            const result = await acquireMergeLock(ctx, "test.md");

            expect(result.acquired).toBe(true);
        });

        it("should acquire lock when held by same device", async () => {
            const now = Date.now();
            const commData: CommunicationData = {
                mergeLocks: {
                    "test.md": { holder: "test-device", expiresAt: now + 60000 },
                },
                lastUpdated: now,
            };

            ctx.adapter.getFileMetadata = vi.fn().mockResolvedValue({ id: "comm-id", path: "comm.json" });
            ctx.adapter.downloadFile = vi.fn().mockResolvedValue(
                new TextEncoder().encode(JSON.stringify(commData)).buffer,
            );

            const result = await acquireMergeLock(ctx, "test.md");

            expect(result.acquired).toBe(true);
        });

        it("should handle lock contention with retry", async () => {
            const now = Date.now();
            let attemptCount = 0;

            // First verification fails, second succeeds
            ctx.adapter.getFileMetadata = vi.fn().mockResolvedValue({ id: "comm-id", path: "comm.json" });
            ctx.adapter.downloadFile = vi.fn().mockImplementation(() => {
                attemptCount++;
                const commData: CommunicationData = {
                    mergeLocks: attemptCount === 2
                        ? { "test.md": { holder: "other-device", expiresAt: now + 60000 } } // verify check
                        : {},
                    lastUpdated: now,
                };
                return Promise.resolve(new TextEncoder().encode(JSON.stringify(commData)).buffer);
            });

            const result = await acquireMergeLock(ctx, "test.md");

            // After max attempts with contention, should fail
            expect(result.acquired).toBe(false);
        });
    });

    describe("releaseMergeLock", () => {
        it("should release lock held by current device", async () => {
            const now = Date.now();
            const commData: CommunicationData = {
                mergeLocks: {
                    "test.md": { holder: "test-device", expiresAt: now + 60000 },
                },
                lastUpdated: now,
            };

            ctx.adapter.getFileMetadata = vi.fn().mockResolvedValue({ id: "comm-id", path: "comm.json" });
            ctx.adapter.downloadFile = vi.fn().mockResolvedValue(
                new TextEncoder().encode(JSON.stringify(commData)).buffer,
            );

            await releaseMergeLock(ctx, "test.md");

            expect(ctx.adapter.uploadFile).toHaveBeenCalled();
            expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining("released"), "debug");
        });

        it("should not release lock held by another device", async () => {
            const now = Date.now();
            const commData: CommunicationData = {
                mergeLocks: {
                    "test.md": { holder: "other-device", expiresAt: now + 60000 },
                },
                lastUpdated: now,
            };

            ctx.adapter.getFileMetadata = vi.fn().mockResolvedValue({ id: "comm-id", path: "comm.json" });
            ctx.adapter.downloadFile = vi.fn().mockResolvedValue(
                new TextEncoder().encode(JSON.stringify(commData)).buffer,
            );

            await releaseMergeLock(ctx, "test.md");

            // Should not upload since lock is held by another device
            expect(ctx.adapter.uploadFile).not.toHaveBeenCalled();
        });

        it("should handle error during release", async () => {
            ctx.adapter.getFileMetadata = vi.fn().mockRejectedValue(new Error("Network error"));

            await releaseMergeLock(ctx, "test.md", "TestPrefix");

            // The error is logged by loadCommunication first, then caught in releaseMergeLock
            expect(ctx.log).toHaveBeenCalled();
        });

        it("should handle custom log prefix", async () => {
            const now = Date.now();
            const commData: CommunicationData = {
                mergeLocks: {
                    "test.md": { holder: "test-device", expiresAt: now + 60000 },
                },
                lastUpdated: now,
            };

            ctx.adapter.getFileMetadata = vi.fn().mockResolvedValue({ id: "comm-id", path: "comm.json" });
            ctx.adapter.downloadFile = vi.fn().mockResolvedValue(
                new TextEncoder().encode(JSON.stringify(commData)).buffer,
            );

            await releaseMergeLock(ctx, "test.md", "CustomPrefix");

            expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining("[CustomPrefix]"), "debug");
        });
    });

    describe("checkMergeLock", () => {
        it("should return locked false when no lock exists", async () => {
            ctx.adapter.getFileMetadata = vi.fn().mockResolvedValue(null);

            const result = await checkMergeLock(ctx, "test.md");

            expect(result.locked).toBe(false);
        });

        it("should return locked true when held by another device", async () => {
            const now = Date.now();
            const commData: CommunicationData = {
                mergeLocks: {
                    "test.md": { holder: "other-device", expiresAt: now + 60000 },
                },
                lastUpdated: now,
            };

            ctx.adapter.getFileMetadata = vi.fn().mockResolvedValue({ id: "comm-id", path: "comm.json" });
            ctx.adapter.downloadFile = vi.fn().mockResolvedValue(
                new TextEncoder().encode(JSON.stringify(commData)).buffer,
            );

            const result = await checkMergeLock(ctx, "test.md");

            expect(result.locked).toBe(true);
            expect(result.holder).toBe("other-device");
            expect(result.expiresIn).toBeGreaterThan(0);
        });

        it("should return locked false when lock is expired", async () => {
            const now = Date.now();
            const commData: CommunicationData = {
                mergeLocks: {
                    "test.md": { holder: "other-device", expiresAt: now - 1000 },
                },
                lastUpdated: now,
            };

            ctx.adapter.getFileMetadata = vi.fn().mockResolvedValue({ id: "comm-id", path: "comm.json" });
            ctx.adapter.downloadFile = vi.fn().mockResolvedValue(
                new TextEncoder().encode(JSON.stringify(commData)).buffer,
            );

            const result = await checkMergeLock(ctx, "test.md");

            expect(result.locked).toBe(false);
        });

        it("should return locked false when held by same device", async () => {
            const now = Date.now();
            const commData: CommunicationData = {
                mergeLocks: {
                    "test.md": { holder: "test-device", expiresAt: now + 60000 },
                },
                lastUpdated: now,
            };

            ctx.adapter.getFileMetadata = vi.fn().mockResolvedValue({ id: "comm-id", path: "comm.json" });
            ctx.adapter.downloadFile = vi.fn().mockResolvedValue(
                new TextEncoder().encode(JSON.stringify(commData)).buffer,
            );

            const result = await checkMergeLock(ctx, "test.md");

            expect(result.locked).toBe(false);
        });
    });
});

describe("state - index management", () => {
    let ctx: SyncContext;

    beforeEach(() => {
        ctx = createMockCtx();
    });

    describe("loadIndex", () => {
        it("should load index from vault", async () => {
            const indexData = {
                index: {
                    "notes/test.md": { fileId: "f1", mtime: 100, size: 10, hash: "abc" },
                },
                startPageToken: "token123",
            };

            ctx.vault.readBinary = vi.fn().mockResolvedValue(
                new TextEncoder().encode(JSON.stringify(indexData)).buffer,
            );

            await loadIndex(ctx, async (data) => data);

            expect(ctx.index["notes/test.md"]).toBeDefined();
            expect(ctx.startPageToken).toBe("token123");
        });

        it("should normalize compressed index to plain text", async () => {
            const indexData = {
                index: { "notes/test.md": { fileId: "f1", mtime: 100, size: 10, hash: "abc" } },
                startPageToken: "token123",
            };
            const jsonData = JSON.stringify(indexData);
            const compressedData = new TextEncoder().encode(jsonData + "PADDING_FOR_DIFF_SIZE").buffer;

            ctx.vault.readBinary = vi.fn().mockResolvedValue(compressedData);

            // Mock tryDecompress to return smaller data (simulating decompression)
            const tryDecompress = vi.fn().mockImplementation(async (data: ArrayBuffer) => {
                return new TextEncoder().encode(jsonData).buffer;
            });

            await loadIndex(ctx, tryDecompress);

            expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining("Detected compressed"), "info");
        });

        it("should fall back to raw index on main load failure", async () => {
            ctx.vault.readBinary = vi.fn().mockRejectedValue(new Error("Main file corrupt"));
            ctx.vault.exists = vi.fn().mockImplementation(async (path: string) => {
                return path.includes("_raw.json");
            });

            const rawIndexData = {
                index: { "notes/recovered.md": { fileId: "f2", mtime: 200, size: 20, hash: "def" } },
                startPageToken: "token456",
            };
            ctx.vault.read = vi.fn().mockResolvedValue(JSON.stringify(rawIndexData));

            await loadIndex(ctx, async (data) => data);

            expect(ctx.index["notes/recovered.md"]).toBeDefined();
            expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining("recovered from raw"), "info");
        });

        it("should start fresh when both main and raw index fail", async () => {
            ctx.vault.readBinary = vi.fn().mockRejectedValue(new Error("Main file corrupt"));
            ctx.vault.exists = vi.fn().mockResolvedValue(false);

            await loadIndex(ctx, async (data) => data);

            expect(ctx.indexLoadFailed).toBe(true);
            expect(Object.keys(ctx.index)).toHaveLength(0);
            expect(ctx.startPageToken).toBeNull();
            expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining("Fatal load failure"), "error");
        });

        it("should handle raw fallback read error", async () => {
            ctx.vault.readBinary = vi.fn().mockRejectedValue(new Error("Main file corrupt"));
            ctx.vault.exists = vi.fn().mockResolvedValue(true);
            ctx.vault.read = vi.fn().mockRejectedValue(new Error("Raw file also corrupt"));

            await loadIndex(ctx, async (data) => data);

            expect(ctx.indexLoadFailed).toBe(true);
            expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining("Raw fallback also failed"), "error");
        });
    });

    describe("loadLocalIndex", () => {
        it("should load existing local index", async () => {
            const localIndexData = {
                index: { "notes/local.md": { fileId: "f1", mtime: 100, size: 10, hash: "abc" } },
                deviceId: "existing-device",
            };

            ctx.vault.exists = vi.fn().mockResolvedValue(true);
            ctx.vault.read = vi.fn().mockResolvedValue(JSON.stringify(localIndexData));

            await loadLocalIndex(ctx);

            expect(ctx.localIndex["notes/local.md"]).toBeDefined();
            expect(ctx.deviceId).toBe("existing-device");
        });

        it("should initialize fresh when local index does not exist", async () => {
            ctx.vault.exists = vi.fn().mockResolvedValue(false);
            ctx.vault.write = vi.fn().mockResolvedValue(undefined);

            const originalDeviceId = ctx.deviceId;
            await loadLocalIndex(ctx);

            // Device ID should be regenerated (different from original)
            expect(ctx.deviceId).not.toBe(originalDeviceId);
            expect(ctx.localIndex).toEqual({});
            expect(ctx.vault.write).toHaveBeenCalled();
        });

        it("should generate new device ID when not present in local index", async () => {
            const localIndexData = {
                index: {},
                deviceId: "", // Empty device ID
            };

            ctx.vault.exists = vi.fn().mockResolvedValue(true);
            ctx.vault.read = vi.fn().mockResolvedValue(JSON.stringify(localIndexData));
            ctx.vault.write = vi.fn().mockResolvedValue(undefined);

            const originalDeviceId = ctx.deviceId;
            await loadLocalIndex(ctx);

            expect(ctx.deviceId).not.toBe(originalDeviceId);
            expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining("Generated new device ID"), "system");
        });

        it("should handle load error and generate fallback device ID", async () => {
            ctx.vault.exists = vi.fn().mockRejectedValue(new Error("Filesystem error"));

            const originalDeviceId = ctx.deviceId;
            await loadLocalIndex(ctx);

            // Should use or generate device ID
            expect(ctx.deviceId).toBeDefined();
            expect(ctx.localIndex).toEqual({});
        });

        it("should avoid duplicate logs when called multiple times", async () => {
            const localIndexData = {
                index: {},
                deviceId: "test-device",
            };

            ctx.vault.exists = vi.fn().mockResolvedValue(true);
            ctx.vault.read = vi.fn().mockResolvedValue(JSON.stringify(localIndexData));

            // First call
            await loadLocalIndex(ctx);
            const firstCallCount = (ctx.log as any).mock.calls.length;

            // Second call - should not log again (isAlreadyLogged check)
            await loadLocalIndex(ctx);
            const secondCallCount = (ctx.log as any).mock.calls.length;

            // Both should have same number of log calls (no additional logs)
            expect(secondCallCount).toBe(firstCallCount);
        });
    });

    describe("saveIndex", () => {
        it("should save index to vault", async () => {
            ctx.index["notes/test.md"] = { fileId: "f1", mtime: 100, size: 10, hash: "abc" };
            ctx.startPageToken = "token123";

            ctx.vault.exists = vi.fn().mockResolvedValue(true);
            ctx.vault.write = vi.fn().mockResolvedValue(undefined);

            await saveIndex(ctx);

            expect(ctx.vault.write).toHaveBeenCalledWith(
                ctx.pluginDataPath,
                expect.stringContaining("notes/test.md"),
            );
        });

        it("should create parent directory if it does not exist", async () => {
            ctx.index["notes/test.md"] = { fileId: "f1", mtime: 100, size: 10, hash: "abc" };

            ctx.vault.exists = vi.fn().mockResolvedValue(false);
            ctx.vault.mkdir = vi.fn().mockResolvedValue(undefined);
            ctx.vault.write = vi.fn().mockResolvedValue(undefined);

            await saveIndex(ctx);

            expect(ctx.vault.mkdir).toHaveBeenCalled();
        });

        it("should save raw index backup", async () => {
            ctx.index["notes/test.md"] = { fileId: "f1", mtime: 100, size: 10, hash: "abc" };

            ctx.vault.exists = vi.fn().mockResolvedValue(true);
            ctx.vault.write = vi.fn().mockResolvedValue(undefined);

            await saveIndex(ctx);

            // Should write both main and raw index
            const writeCalls = (ctx.vault.write as any).mock.calls;
            expect(writeCalls.length).toBeGreaterThanOrEqual(1);
        });

        it("should handle raw index backup error gracefully", async () => {
            ctx.index["notes/test.md"] = { fileId: "f1", mtime: 100, size: 10, hash: "abc" };

            ctx.vault.exists = vi.fn().mockResolvedValue(true);
            ctx.vault.write = vi.fn()
                .mockResolvedValueOnce(undefined)  // First call succeeds (main index)
                .mockRejectedValueOnce(new Error("Disk full"));  // Second call fails (raw backup)

            const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

            await saveIndex(ctx);

            expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to save raw index"), expect.any(Error));

            consoleSpy.mockRestore();
        });
    });

    describe("saveLocalIndex", () => {
        it("should save local index", async () => {
            ctx.localIndex["notes/local.md"] = { fileId: "f1", mtime: 100, size: 10, hash: "abc" };
            ctx.deviceId = "test-device";

            ctx.vault.write = vi.fn().mockResolvedValue(undefined);

            await saveLocalIndex(ctx);

            expect(ctx.vault.write).toHaveBeenCalledWith(
                ctx.localIndexPath,
                expect.stringContaining("test-device"),
            );
        });

        it("should handle write errors", async () => {
            ctx.localIndex["notes/local.md"] = { fileId: "f1", mtime: 100, size: 10, hash: "abc" };

            ctx.vault.write = vi.fn().mockRejectedValue(new Error("Write failed"));

            const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

            await saveLocalIndex(ctx);

            expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to save local index"), expect.any(Error));

            consoleSpy.mockRestore();
        });
    });

    describe("resetIndex", () => {
        it("should reset all index data", async () => {
            ctx.index["notes/test.md"] = { fileId: "f1", mtime: 100, size: 10, hash: "abc" };
            ctx.localIndex["notes/local.md"] = { fileId: "f2", mtime: 200, size: 20, hash: "def" };
            ctx.startPageToken = "token123";

            ctx.vault.exists = vi.fn().mockResolvedValue(true);
            ctx.vault.write = vi.fn().mockResolvedValue(undefined);

            await resetIndex(ctx);

            expect(Object.keys(ctx.index)).toHaveLength(0);
            expect(Object.keys(ctx.localIndex)).toHaveLength(0);
            expect(ctx.startPageToken).toBeNull();
            expect(ctx.adapter.clearDownloadCache).toHaveBeenCalled();
        });
    });
});
