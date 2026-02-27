/**
 * @file Migration Service テスト
 *
 * @description
 * E2EE移行サービスの全フロー:
 * startMigration, runMigration, finalizeMigration, cancelMigration,
 * checkForInterruptedMigration をテストする。
 *
 * @pass_criteria
 * - startMigration: IDLE以外で例外 / vault-lock存在で例外 / 他デバイスロックで例外 / 正常開始
 * - runMigration: ファイル暗号化アップロード / 整合性検証 / localIndex更新
 * - finalizeMigration: フォルダスワップ / vault-lock.vault アップロード / リカバリ
 * - cancelMigration: テンポラリフォルダ削除 / ロック解除 / 状態リセット
 * - checkForInterruptedMigration: 中断検出 / 自動リカバリ
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { MigrationService } from "../../../src/services/migration-service";
import type { SyncContext } from "../../../src/sync-manager/context";

// ─── Mock factories ───

function createMockBaseAdapter(vaultName = "TestVault") {
    // Track uploaded content for download verification
    const uploads = new Map<string, ArrayBuffer>();
    return {
        vaultName,
        cloneWithNewVaultName: vi.fn((name: string) => createMockBaseAdapter(name)),
        setLogger: vi.fn(),
        initialize: vi.fn(),
        uploadFile: vi.fn(async (path: string, content: ArrayBuffer, mtime: number) => {
            uploads.set(path, content.slice(0));
            return {
                id: `id-${path}`,
                hash: `hash-${path}`,
                size: content.byteLength,
            };
        }),
        downloadFile: vi.fn(async (fileId: string) => {
            // Return matching uploaded content for integrity verification
            for (const [path, content] of uploads.entries()) {
                if (`id-${path}` === fileId) return content.slice(0);
            }
            return new TextEncoder().encode("file content").buffer;
        }),
        deleteFile: vi.fn(),
        moveFile: vi.fn(),
        listFiles: vi.fn(async () => []),
        getAppRootId: vi.fn(async () => "root-id"),
        reset: vi.fn(),
        getBaseAdapter: vi.fn(),
    } as any;
}

function createMockLockService() {
    return {
        checkForLockFile: vi.fn(async () => false),
        createMigrationLock: vi.fn(),
        removeMigrationLock: vi.fn(),
        getMigrationLock: vi.fn(async () => null),
        uploadLockFileToAdapter: vi.fn(),
        getFolderId: vi.fn(async (name: string) => {
            if (name.includes("Temp")) return "temp-folder-id";
            if (name.includes("Backup")) return null;
            return "original-folder-id";
        }),
        renameFolder: vi.fn(),
    } as any;
}

function createMockCtx(overrides: Partial<SyncContext> = {}): SyncContext {
    return {
        syncState: "IDLE" as any,
        deviceId: "test-device",
        settings: { concurrency: 2, exclusionPatterns: "" },
        vault: {
            readBinary: vi.fn(async () => new TextEncoder().encode("file content").buffer),
            getFiles: vi.fn(() => []),
            exists: vi.fn(async () => true),
            write: vi.fn(),
            writeBinary: vi.fn(),
            mkdir: vi.fn(),
            list: vi.fn(async () => ({ files: [], folders: [] })),
        },
        index: {},
        localIndex: {},
        pluginDataPath: ".obsidian/plugins/obsidian-vault-sync/sync-index.json",
        pluginDir: ".obsidian/plugins/obsidian-vault-sync",
        localIndexPath: ".obsidian/plugins/obsidian-vault-sync/local-index.json",
        startPageToken: "token-1",
        cryptoEngine: {
            initializeNewVault: vi.fn(async () => "lock-blob-data"),
        },
        log: vi.fn(),
        notify: vi.fn(),
        e2eeEnabled: false,
        ...overrides,
    } as unknown as SyncContext;
}

// ═══════════════════════════════════════════════════════════════════

describe("MigrationService", () => {
    describe("startMigration", () => {
        it("should throw when syncState is not IDLE", async () => {
            const ctx = createMockCtx({ syncState: "SMART_SYNCING" as any });
            const svc = new MigrationService(
                createMockBaseAdapter(),
                createMockLockService(),
                ctx,
            );

            await expect(svc.startMigration("password")).rejects.toThrow(
                /Cannot start migration/,
            );
        });

        it("should throw when vault-lock.vault already exists", async () => {
            const ctx = createMockCtx();
            const lockService = createMockLockService();
            lockService.checkForLockFile.mockResolvedValue(true);

            const svc = new MigrationService(
                createMockBaseAdapter(),
                lockService,
                ctx,
            );

            await expect(svc.startMigration("password")).rejects.toThrow(
                /already encrypted/,
            );
        });

        it("should throw when another device holds migration lock", async () => {
            const ctx = createMockCtx();
            const lockService = createMockLockService();
            lockService.getMigrationLock.mockResolvedValue({
                deviceId: "other-device",
                timestamp: Date.now(), // Recent lock
            });

            const svc = new MigrationService(
                createMockBaseAdapter(),
                lockService,
                ctx,
            );

            await expect(svc.startMigration("password")).rejects.toThrow(
                /Another device/,
            );
        });

        it("should override stale migration lock from another device (>24h)", async () => {
            const ctx = createMockCtx();
            const lockService = createMockLockService();
            lockService.getMigrationLock.mockResolvedValue({
                deviceId: "old-device",
                timestamp: Date.now() - 25 * 3600 * 1000, // 25 hours ago
            });

            const svc = new MigrationService(
                createMockBaseAdapter(),
                lockService,
                ctx,
            );

            const result = await svc.startMigration("password");
            expect(result).toBeDefined();
            expect(lockService.createMigrationLock).toHaveBeenCalledWith(
                "test-device",
            );
        });

        it("should set syncState to MIGRATING and create temp adapter", async () => {
            const ctx = createMockCtx();
            const baseAdapter = createMockBaseAdapter();
            const lockService = createMockLockService();

            const svc = new MigrationService(
                baseAdapter,
                lockService,
                ctx,
            );

            const tempAdapter = await svc.startMigration("password");

            expect(ctx.syncState).toBe("MIGRATING");
            expect(svc.isMigrating).toBe(true);
            expect(tempAdapter).toBeDefined();
            expect(baseAdapter.cloneWithNewVaultName).toHaveBeenCalledWith(
                "TestVault-Temp-Encrypted",
            );
            expect(ctx.cryptoEngine!.initializeNewVault).toHaveBeenCalledWith(
                "password",
            );
        });
    });

    describe("cancelMigration", () => {
        it("should delete temp folder, remove lock, and reset state", async () => {
            const ctx = createMockCtx({ syncState: "MIGRATING" as any });
            const baseAdapter = createMockBaseAdapter();
            const lockService = createMockLockService();

            const svc = new MigrationService(baseAdapter, lockService, ctx);
            (svc as any).isMigrating = true;

            await svc.cancelMigration();

            expect(baseAdapter.deleteFile).toHaveBeenCalledWith(
                "temp-folder-id",
            );
            expect(lockService.removeMigrationLock).toHaveBeenCalled();
            expect(ctx.syncState).toBe("IDLE");
            expect(svc.isMigrating).toBe(false);
            expect(svc.currentProgress).toBeNull();
        });

        it("should handle missing temp folder gracefully", async () => {
            const ctx = createMockCtx();
            const lockService = createMockLockService();
            lockService.getFolderId.mockResolvedValue(null);

            const svc = new MigrationService(
                createMockBaseAdapter(),
                lockService,
                ctx,
            );

            await expect(svc.cancelMigration()).resolves.not.toThrow();
            expect(lockService.removeMigrationLock).toHaveBeenCalled();
        });
    });

    describe("checkForInterruptedMigration", () => {
        it("should return false when no temp folder exists", async () => {
            const lockService = createMockLockService();
            lockService.getFolderId.mockResolvedValue(null);

            const svc = new MigrationService(
                createMockBaseAdapter(),
                lockService,
                createMockCtx(),
            );

            const result = await svc.checkForInterruptedMigration();
            expect(result).toBe(false);
        });

        it("should detect interrupted migration (temp folder exists)", async () => {
            const lockService = createMockLockService();
            // Primary exists, temp also exists
            lockService.getFolderId.mockImplementation(
                async (name: string) => {
                    if (name === "TestVault") return "primary-id";
                    if (name.includes("Temp")) return "temp-id";
                    return null;
                },
            );

            const baseAdapter = createMockBaseAdapter();
            baseAdapter.listFiles.mockResolvedValue([]);

            const svc = new MigrationService(
                baseAdapter,
                lockService,
                createMockCtx(),
            );

            const result = await svc.checkForInterruptedMigration();
            expect(result).toBe(true);
        });

        it("should auto-recover when primary missing but temp and backup exist", async () => {
            const lockService = createMockLockService();
            lockService.getFolderId.mockImplementation(
                async (name: string) => {
                    if (name === "TestVault") return null; // Primary missing
                    if (name.includes("Temp")) return "temp-id";
                    if (name.includes("Backup")) return "backup-id";
                    return null;
                },
            );

            const baseAdapter = createMockBaseAdapter();
            baseAdapter.listFiles.mockResolvedValue([
                {
                    kind: "folder",
                    id: "backup-id",
                    path: "TestVault-Backup-2026-01-01",
                },
            ]);

            const svc = new MigrationService(
                baseAdapter,
                lockService,
                createMockCtx(),
            );

            const result = await svc.checkForInterruptedMigration();
            // Auto-recovery renames temp to primary, returns false (migration complete)
            expect(result).toBe(false);
            expect(lockService.renameFolder).toHaveBeenCalledWith(
                "temp-id",
                "TestVault",
            );
        });

        it("should return false when an error occurs", async () => {
            const lockService = createMockLockService();
            lockService.getFolderId.mockRejectedValue(
                new Error("Network error"),
            );

            const svc = new MigrationService(
                createMockBaseAdapter(),
                lockService,
                createMockCtx(),
            );

            const result = await svc.checkForInterruptedMigration();
            expect(result).toBe(false);
        });
    });

    describe("finalizeMigration", () => {
        it("should throw when pendingLockBlob is missing", async () => {
            const svc = new MigrationService(
                createMockBaseAdapter(),
                createMockLockService(),
                createMockCtx(),
            );

            await expect(
                svc.finalizeMigration(createMockBaseAdapter()),
            ).rejects.toThrow(/Missing lock data/);
        });

        it("should throw when temp folder is not found", async () => {
            const lockService = createMockLockService();
            lockService.getFolderId.mockImplementation(
                async (name: string) => {
                    if (name.includes("Temp")) return null;
                    return "original-id";
                },
            );

            const ctx = createMockCtx();
            const svc = new MigrationService(
                createMockBaseAdapter(),
                lockService,
                ctx,
            );
            // Start migration first to set pendingLockBlob
            await svc.startMigration("password");

            await expect(
                svc.finalizeMigration(createMockBaseAdapter()),
            ).rejects.toThrow(/Temporary encrypted folder not found/);
        });

        it("should perform folder swap and cleanup on success", async () => {
            const ctx = createMockCtx();
            const baseAdapter = createMockBaseAdapter();
            const lockService = createMockLockService();
            const tempAdapter = createMockBaseAdapter("TestVault-Temp-Encrypted");
            tempAdapter.getBaseAdapter = vi.fn(() => tempAdapter);

            const svc = new MigrationService(baseAdapter, lockService, ctx);
            await svc.startMigration("password");

            await svc.finalizeMigration(tempAdapter);

            // Verify folder swap: original → backup, temp → original
            expect(lockService.renameFolder).toHaveBeenCalledWith(
                "original-folder-id",
                expect.stringContaining("TestVault-Backup-"),
            );
            expect(lockService.renameFolder).toHaveBeenCalledWith(
                "temp-folder-id",
                "TestVault",
            );
            // Lock file uploaded to temp before swap
            expect(lockService.uploadLockFileToAdapter).toHaveBeenCalled();
            // Migration lock removed
            expect(lockService.removeMigrationLock).toHaveBeenCalled();
            // State reset
            expect(ctx.syncState).toBe("IDLE");
            expect(svc.isMigrating).toBe(false);
            expect(ctx.startPageToken).toBeNull();
            // Adapter reset for re-discovery
            expect(baseAdapter.reset).toHaveBeenCalled();
        });
    });

    describe("runMigration", () => {
        it("should upload files and update localIndex with encrypted hashes", async () => {
            const ctx = createMockCtx();
            const baseAdapter = createMockBaseAdapter();
            const lockService = createMockLockService();

            // Setup local files via vault mock - getLocalFiles reads from vault.getFiles()
            // which returns TFile objects with stat property
            const makeTFile = (path: string, mtime: number, size: number) => {
                const tf: any = { path, name: path.split("/").pop(), stat: { mtime, size, ctime: mtime } };
                return tf;
            };
            (ctx.vault.getFiles as any).mockReturnValue([
                makeTFile("notes/a.md", 1000, 50),
                makeTFile("notes/b.md", 2000, 100),
            ]);

            const svc = new MigrationService(baseAdapter, lockService, ctx);

            // startMigration returns a cloned adapter wrapped in EncryptedAdapter,
            // but EncryptedAdapter needs cryptoEngine methods. Use the cloned adapter directly.
            await svc.startMigration("password");

            // Use a simple mock tempAdapter instead of EncryptedAdapter
            const tempAdapter = createMockBaseAdapter("TestVault-Temp-Encrypted");
            tempAdapter.getBaseAdapter = vi.fn(() => tempAdapter);

            const progress: any[] = [];
            await svc.runMigration(tempAdapter, (p) => progress.push(p));

            // Files should be uploaded
            expect(tempAdapter.uploadFile).toHaveBeenCalledTimes(2);

            // localIndex should be updated
            expect(ctx.localIndex["notes/a.md"]).toBeDefined();
            expect(ctx.localIndex["notes/a.md"].hash).toBe("hash-notes/a.md");
            expect(ctx.localIndex["notes/a.md"].plainHash).toBeDefined();

            // Progress should have been reported
            expect(progress.length).toBe(2);
            expect(progress[0].current).toBe(1);
            expect(progress[1].current).toBe(2);
        });
    });
});
