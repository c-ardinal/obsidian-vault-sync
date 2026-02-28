/**
 * @file VaultLockService ユニットテスト
 *
 * @description
 * vault-lock.vault ロックファイルと migration.lock の CRUD 操作を
 * MockCloudAdapter でテストする。
 *
 * @pass_criteria
 * - checkForLockFile: 存在→true、不在→false
 * - downloadLockFile: 内容を文字列で取得、不在→throw
 * - uploadLockFile / uploadLockFileToAdapter: アダプタに書き込み
 * - createMigrationLock / getMigrationLock / removeMigrationLock: ライフサイクル
 * - getFolderId: アダプタ委譲、非対応→throw
 * - renameFolder: moveFile委譲
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { VaultLockService, VAULT_LOCK_PATH, MIGRATION_LOCK_FILENAME } from "../../../src/services/vault-lock-service";
import type { CloudAdapter, CloudFile } from "../../../src/types/adapter";

function encode(str: string): ArrayBuffer {
    return new TextEncoder().encode(str).buffer as ArrayBuffer;
}

function createMockAdapter(): CloudAdapter & { _store: Map<string, { id: string; content: ArrayBuffer }> } {
    const store = new Map<string, { id: string; content: ArrayBuffer }>();
    let idCounter = 0;

    return {
        _store: store,
        getFileMetadata: vi.fn(async (path: string): Promise<CloudFile | null> => {
            const entry = store.get(path);
            if (!entry) return null;
            return { id: entry.id, name: path, path, mtime: Date.now(), size: entry.content.byteLength, hash: "mock" } as CloudFile;
        }),
        downloadFile: vi.fn(async (id: string): Promise<ArrayBuffer> => {
            for (const entry of store.values()) {
                if (entry.id === id) return entry.content.slice(0);
            }
            throw new Error("Not found");
        }),
        uploadFile: vi.fn(async (path: string, content: ArrayBuffer, _mtime: number, existingId?: string): Promise<CloudFile> => {
            const id = existingId || `file_${++idCounter}`;
            store.set(path, { id, content: content instanceof ArrayBuffer ? content : (content as any).buffer || content });
            return { id, name: path, path, mtime: Date.now(), size: content.byteLength, hash: "mock" } as CloudFile;
        }),
        deleteFile: vi.fn(async (id: string): Promise<void> => {
            for (const [path, entry] of store.entries()) {
                if (entry.id === id) { store.delete(path); return; }
            }
        }),
        moveFile: vi.fn(async (id: string, newName: string, _newParent: string | null): Promise<CloudFile> => {
            return { id, name: newName, path: newName, mtime: Date.now(), size: 0, hash: "mock" } as CloudFile;
        }),
        getFolderIdByName: vi.fn(async (name: string, _parentId?: string): Promise<string | null> => {
            return `folder_${name}`;
        }),
    } as any;
}

describe("VaultLockService", () => {
    let adapter: ReturnType<typeof createMockAdapter>;
    let svc: VaultLockService;

    beforeEach(() => {
        adapter = createMockAdapter();
        svc = new VaultLockService(adapter);
    });

    describe("checkForLockFile", () => {
        it("should return false when vault-lock does not exist", async () => {
            expect(await svc.checkForLockFile()).toBe(false);
        });

        it("should return true when vault-lock exists", async () => {
            adapter._store.set(VAULT_LOCK_PATH, { id: "lock1", content: encode("blob") });
            expect(await svc.checkForLockFile()).toBe(true);
        });
    });

    describe("downloadLockFile", () => {
        it("should return lock file content as string", async () => {
            adapter._store.set(VAULT_LOCK_PATH, { id: "lock1", content: encode("encrypted-blob") });
            const result = await svc.downloadLockFile();
            expect(result).toBe("encrypted-blob");
        });

        it("should throw when lock file does not exist", async () => {
            await expect(svc.downloadLockFile()).rejects.toThrow("vault-lock.vault not found");
        });
    });

    describe("uploadLockFile", () => {
        it("should upload lock file to base adapter", async () => {
            await svc.uploadLockFile("new-blob");
            expect(adapter.uploadFile).toHaveBeenCalled();
            expect(adapter._store.has(VAULT_LOCK_PATH)).toBe(true);
        });

        it("should update existing lock file", async () => {
            adapter._store.set(VAULT_LOCK_PATH, { id: "existing", content: encode("old") });
            await svc.uploadLockFile("updated-blob");
            const stored = adapter._store.get(VAULT_LOCK_PATH)!;
            expect(new TextDecoder().decode(stored.content)).toBe("updated-blob");
        });
    });

    describe("uploadLockFileToAdapter", () => {
        it("should upload to a different adapter", async () => {
            const otherAdapter = createMockAdapter();
            await svc.uploadLockFileToAdapter(otherAdapter, "other-blob");
            expect(otherAdapter._store.has(VAULT_LOCK_PATH)).toBe(true);
            expect(adapter._store.has(VAULT_LOCK_PATH)).toBe(false);
        });
    });

    describe("migration lock lifecycle", () => {
        it("should return null when no migration lock exists", async () => {
            expect(await svc.getMigrationLock()).toBeNull();
        });

        it("should create and read migration lock", async () => {
            await svc.createMigrationLock("device_A");
            const lock = await svc.getMigrationLock();
            expect(lock).not.toBeNull();
            expect(lock!.deviceId).toBe("device_A");
            expect(lock!.timestamp).toBeGreaterThan(0);
        });

        it("should remove migration lock", async () => {
            await svc.createMigrationLock("device_B");
            expect(await svc.getMigrationLock()).not.toBeNull();
            await svc.removeMigrationLock();
            expect(await svc.getMigrationLock()).toBeNull();
        });

        it("should return null for corrupted migration lock", async () => {
            adapter._store.set(MIGRATION_LOCK_FILENAME, { id: "bad", content: encode("not-json") });
            expect(await svc.getMigrationLock()).toBeNull();
        });
    });

    describe("getFolderId", () => {
        it("should delegate to adapter.getFolderIdByName", async () => {
            const result = await svc.getFolderId("MyFolder", "parent123");
            expect(adapter.getFolderIdByName).toHaveBeenCalledWith("MyFolder", "parent123");
            expect(result).toBe("folder_MyFolder");
        });

        it("should throw if adapter does not support getFolderIdByName", async () => {
            delete (adapter as any).getFolderIdByName;
            await expect(svc.getFolderId("X")).rejects.toThrow("does not support folder search");
        });
    });

    describe("renameFolder", () => {
        it("should delegate to adapter.moveFile", async () => {
            await svc.renameFolder("folder123", "NewName");
            expect(adapter.moveFile).toHaveBeenCalledWith("folder123", "NewName", null);
        });
    });
});
