/**
 * @file Migration Service ユニットテスト
 *
 * @description
 * Migration serviceのブランチカバレッジ向上のためのテスト:
 * - Engine getter error handling
 * - Integrity check failures (size/content mismatch)
 * - Folder swap error handling and recovery
 * - Backup deletion error handling
 * - Interrupted migration auto-recovery (success/failure)
 * - checkForInterruptedMigration catch block
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { MigrationService } from "../../../src/services/migration-service";
import type { SyncContext } from "../../../src/sync-manager/context";

// Mock the EncryptedAdapter module
vi.mock("../../../src/encryption/encrypted-adapter", () => {
    return {
        EncryptedAdapter: class MockEncryptedAdapter {
            constructor(public adapter: any, public engine: any, public _version: number) {}
        }
    };
});

// ─── Mock factories ───

function createMockBaseAdapter(vaultName = "TestVault") {
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
        _uploads: uploads,
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

describe("MigrationService - Branch Coverage Tests", () => {
    describe("engine getter", () => {
        it("should throw when cryptoEngine is null", async () => {
            const ctx = createMockCtx({ cryptoEngine: null });
            const svc = new MigrationService(
                createMockBaseAdapter(),
                createMockLockService(),
                ctx,
            );

            await expect(svc.startMigration("password")).rejects.toThrow(
                "E2EE Engine not loaded.",
            );
        });
    });

    describe("runMigration - integrity checks", () => {
        it("should throw when integrity check fails with size mismatch", async () => {
            const ctx = createMockCtx();
            const baseAdapter = createMockBaseAdapter();
            const lockService = createMockLockService();

            // Setup local files
            const makeTFile = (path: string, mtime: number, size: number) => {
                const tf: any = { path, name: path.split("/").pop(), stat: { mtime, size, ctime: mtime } };
                return tf;
            };
            (ctx.vault.getFiles as any).mockReturnValue([makeTFile("notes/a.md", 1000, 50)]);

            const svc = new MigrationService(baseAdapter, lockService, ctx);
            await svc.startMigration("password");

            // Create temp adapter with modified download that returns different size
            const tempAdapter = createMockBaseAdapter("TestVault-Temp-Encrypted");
            tempAdapter.getBaseAdapter = vi.fn(() => tempAdapter);
            
            // Override downloadFile to return content with different size
            tempAdapter.downloadFile = vi.fn(async () => {
                return new TextEncoder().encode("different size content here").buffer;
            });

            await expect(svc.runMigration(tempAdapter, vi.fn())).rejects.toThrow(
                /Migration aborted: Encryption\/decryption integrity check failed/,
            );
        });

        it("should throw when integrity check fails with content mismatch at specific byte", async () => {
            const ctx = createMockCtx();
            const baseAdapter = createMockBaseAdapter();
            const lockService = createMockLockService();

            const originalContent = new TextEncoder().encode("hello world").buffer;
            
            // Setup local files
            const makeTFile = (path: string, mtime: number, size: number) => {
                const tf: any = { path, name: path.split("/").pop(), stat: { mtime, size, ctime: mtime } };
                return tf;
            };
            (ctx.vault.getFiles as any).mockReturnValue([makeTFile("notes/a.md", 1000, 11)]);
            (ctx.vault.readBinary as any).mockResolvedValue(originalContent);

            const svc = new MigrationService(baseAdapter, lockService, ctx);
            await svc.startMigration("password");

            // Create temp adapter with modified download that returns slightly different content
            const tempAdapter = createMockBaseAdapter("TestVault-Temp-Encrypted");
            tempAdapter.getBaseAdapter = vi.fn(() => tempAdapter);
            
            // Same size but different content
            tempAdapter.downloadFile = vi.fn(async () => {
                return new TextEncoder().encode("hello worle").buffer; // 'd' -> 'e' at byte 10
            });

            await expect(svc.runMigration(tempAdapter, vi.fn())).rejects.toThrow(
                /Content mismatch at byte 10/,
            );
        });

        it("should collect up to 5 verification samples distributed across files", async () => {
            const ctx = createMockCtx();
            const baseAdapter = createMockBaseAdapter();
            const lockService = createMockLockService();

            // Create 10 files to trigger sample collection logic
            const files: any[] = [];
            for (let i = 0; i < 10; i++) {
                files.push({
                    path: `notes/file${i}.md`,
                    name: `file${i}.md`,
                    stat: { mtime: 1000 + i, size: 100, ctime: 1000 + i }
                });
            }
            (ctx.vault.getFiles as any).mockReturnValue(files);

            const svc = new MigrationService(baseAdapter, lockService, ctx);
            await svc.startMigration("password");

            const tempAdapter = createMockBaseAdapter("TestVault-Temp-Encrypted");
            tempAdapter.getBaseAdapter = vi.fn(() => tempAdapter);

            const progress: any[] = [];
            await svc.runMigration(tempAdapter, (p) => progress.push(p));

            // Should upload all 10 files
            expect(tempAdapter.uploadFile).toHaveBeenCalledTimes(10);
            // Should succeed without errors
            expect(progress.length).toBe(10);
        });

        it("should handle errors during file upload in runMigration", async () => {
            const ctx = createMockCtx();
            const baseAdapter = createMockBaseAdapter();
            const lockService = createMockLockService();

            const makeTFile = (path: string, mtime: number, size: number) => {
                const tf: any = { path, name: path.split("/").pop(), stat: { mtime, size, ctime: mtime } };
                return tf;
            };
            (ctx.vault.getFiles as any).mockReturnValue([
                makeTFile("notes/a.md", 1000, 50),
                makeTFile("notes/b.md", 2000, 100)
            ]);

            const svc = new MigrationService(baseAdapter, lockService, ctx);
            await svc.startMigration("password");

            const tempAdapter = createMockBaseAdapter("TestVault-Temp-Encrypted");
            tempAdapter.getBaseAdapter = vi.fn(() => tempAdapter);
            
            // Make upload fail for second file
            let uploadCount = 0;
            tempAdapter.uploadFile = vi.fn(async () => {
                uploadCount++;
                if (uploadCount === 2) {
                    throw new Error("Upload failed: network error");
                }
                return { id: `id-${uploadCount}`, hash: `hash-${uploadCount}`, size: 100 };
            });

            await expect(svc.runMigration(tempAdapter, vi.fn())).rejects.toThrow("Upload failed");
        });
    });

    describe("finalizeMigration - folder swap error handling", () => {
        it("should trigger recovery when folder swap fails and recovery succeeds", async () => {
            const ctx = createMockCtx();
            const baseAdapter = createMockBaseAdapter();
            const lockService = createMockLockService();
            const tempAdapter = createMockBaseAdapter("TestVault-Temp-Encrypted");
            tempAdapter.getBaseAdapter = vi.fn(() => tempAdapter);

            // Simulate folder state during recovery
            // After first rename: original -> backup, so primary is null
            // When second rename fails, recovery checks: primary missing? yes, backup exists? yes
            let primaryExists = true;
            lockService.getFolderId = vi.fn(async (name: string, _parentId?: string) => {
                if (name === "TestVault") return primaryExists ? "original-folder-id" : null;
                if (name.includes("Backup")) return "backup-folder-id";
                if (name.includes("Temp")) return "temp-folder-id";
                return null;
            });

            // Track rename calls to simulate failure at critical step
            let renameCallCount = 0;
            lockService.renameFolder = vi.fn(async (id: string, newName: string) => {
                renameCallCount++;
                // First call: original-folder-id -> backup name (succeeds)
                // Second call: temp-folder-id -> TestVault (fails)
                if (renameCallCount === 1) {
                    primaryExists = false; // After renaming original to backup, primary no longer exists
                    return;
                }
                if (renameCallCount === 2) {
                    throw new Error("Rename failed: network error");
                }
                // Recovery call: backup-folder-id -> TestVault (succeeds)
            });

            const svc = new MigrationService(baseAdapter, lockService, ctx);
            await svc.startMigration("password");

            await expect(svc.finalizeMigration(tempAdapter)).rejects.toThrow("Rename failed");
            
            // Recovery should have been attempted - check that backup was renamed to vault name
            const renameCalls = lockService.renameFolder.mock.calls;
            expect(renameCalls.length).toBeGreaterThanOrEqual(3);
            // Last call should be recovery: backup -> TestVault
            expect(renameCalls[renameCalls.length - 1]).toEqual(["backup-folder-id", "TestVault"]);
            expect(ctx.log).toHaveBeenCalledWith(
                expect.stringContaining("Recovery successful"),
                "info",
            );
        });

        it("should log error when folder swap fails and recovery also fails", async () => {
            const ctx = createMockCtx();
            const baseAdapter = createMockBaseAdapter();
            const lockService = createMockLockService();
            const tempAdapter = createMockBaseAdapter("TestVault-Temp-Encrypted");
            tempAdapter.getBaseAdapter = vi.fn(() => tempAdapter);

            // Simulate folder state during recovery
            let primaryExists = true;
            lockService.getFolderId = vi.fn(async (name: string, _parentId?: string) => {
                if (name === "TestVault") return primaryExists ? "original-folder-id" : null;
                if (name.includes("Backup")) return "backup-folder-id";
                if (name.includes("Temp")) return "temp-folder-id";
                return null;
            });

            // Track rename calls - recovery fails
            let renameCallCount = 0;
            lockService.renameFolder = vi.fn(async (id: string, newName: string) => {
                renameCallCount++;
                if (renameCallCount === 1) {
                    // First rename (original -> backup) succeeds
                    primaryExists = false;
                    return;
                }
                if (renameCallCount === 2) {
                    // Second rename (temp -> vaultName) fails
                    throw new Error("Critical rename failed");
                }
                if (renameCallCount === 3) {
                    // Recovery rename also fails
                    throw new Error("Recovery rename failed");
                }
            });

            const svc = new MigrationService(baseAdapter, lockService, ctx);
            await svc.startMigration("password");

            await expect(svc.finalizeMigration(tempAdapter)).rejects.toThrow("Critical rename failed");
            
            // Recovery should have been attempted and failed
            expect(ctx.log).toHaveBeenCalledWith(
                expect.stringContaining("Recovery failed"),
                "error",
            );
        });

        it("should handle backup folder deletion error gracefully", async () => {
            const ctx = createMockCtx();
            const baseAdapter = createMockBaseAdapter();
            const lockService = createMockLockService();
            const tempAdapter = createMockBaseAdapter("TestVault-Temp-Encrypted");
            tempAdapter.getBaseAdapter = vi.fn(() => tempAdapter);

            // Make deleteFile fail for backup deletion
            baseAdapter.deleteFile = vi.fn(async () => {
                throw new Error("Permission denied");
            });

            const svc = new MigrationService(baseAdapter, lockService, ctx);
            await svc.startMigration("password");

            // Should not throw even though delete fails
            await svc.finalizeMigration(tempAdapter);

            // Should log warning
            expect(ctx.log).toHaveBeenCalledWith(
                expect.stringContaining("Failed to delete backup folder"),
                "warn",
            );
            
            // Migration should still complete successfully
            expect(ctx.syncState).toBe("IDLE");
            expect(svc.isMigrating).toBe(false);
        });
    });

    describe("checkForInterruptedMigration - auto-recovery", () => {
        it("should complete auto-recovery successfully when conditions are met", async () => {
            const lockService = createMockLockService();
            lockService.getFolderId = vi.fn(async (name: string) => {
                if (name === "TestVault") return null; // Primary missing
                if (name.includes("Temp")) return "temp-id";
                if (name.includes("Backup")) return "backup-id";
                return null;
            });

            const baseAdapter = createMockBaseAdapter();
            baseAdapter.listFiles = vi.fn(async () => [
                {
                    kind: "folder",
                    id: "backup-folder-id",
                    path: "TestVault-Backup-2026-01-01T00-00-00-000Z",
                },
            ]);

            const ctx = createMockCtx();
            const svc = new MigrationService(baseAdapter, lockService, ctx);

            const result = await svc.checkForInterruptedMigration();

            // Auto-recovery renames temp to primary
            expect(result).toBe(false); // Migration is now complete
            expect(lockService.renameFolder).toHaveBeenCalledWith("temp-id", "TestVault");
            expect(ctx.log).toHaveBeenCalledWith(
                expect.stringContaining("Detected incomplete migration"),
                "warn",
            );
            expect(ctx.log).toHaveBeenCalledWith(
                expect.stringContaining("Auto-recovery successful"),
                "info",
            );
        });

        it("should return true when auto-recovery fails", async () => {
            const lockService = createMockLockService();
            lockService.getFolderId = vi.fn(async (name: string) => {
                if (name === "TestVault") return null; // Primary missing
                if (name.includes("Temp")) return "temp-id";
                if (name.includes("Backup")) return "backup-id";
                return null;
            });
            // Make rename fail
            lockService.renameFolder = vi.fn(async () => {
                throw new Error("Rename failed during recovery");
            });

            const baseAdapter = createMockBaseAdapter();
            baseAdapter.listFiles = vi.fn(async () => [
                {
                    kind: "folder",
                    id: "backup-folder-id",
                    path: "TestVault-Backup-2026-01-01T00-00-00-000Z",
                },
            ]);

            const ctx = createMockCtx();
            const svc = new MigrationService(baseAdapter, lockService, ctx);

            const result = await svc.checkForInterruptedMigration();

            // Returns true because temp still exists (recovery failed)
            expect(result).toBe(true);
            expect(ctx.log).toHaveBeenCalledWith(
                expect.stringContaining("Auto-recovery failed"),
                "error",
            );
        });

        it("should return false from catch block when an error occurs", async () => {
            const lockService = createMockLockService();
            // Make getAppRootId throw to hit the catch block
            const baseAdapter = createMockBaseAdapter();
            baseAdapter.getAppRootId = vi.fn(async () => {
                throw new Error("Network error");
            });

            const ctx = createMockCtx();
            const svc = new MigrationService(baseAdapter, lockService, ctx);

            const result = await svc.checkForInterruptedMigration();

            expect(result).toBe(false);
        });
    });
});
