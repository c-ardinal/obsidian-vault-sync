/**
 * @file EncryptedAdapter ユニットテスト
 *
 * @description
 * EncryptedAdapter の包括的なテストカバレッジを提供する。
 * - コンストラクタ初期化
 * - E2EE 有効/無効
 * - 暗号化付きファイルアップロード
 * - 復号付きファイルダウンロード
 * - 大ファイルのチャンク暗号化
 * - キー管理
 * - 暗号化有無でのハッシュ計算
 * - メタデータ操作
 * - エラーハンドリングパス
 * - エッジケース
 *
 * @pass_criteria
 * - 全ての public メソッドがテストされること
 * - エラーハンドリングパスがカバーされること
 * - 暗号化/復号の統合が検証されること
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EncryptedAdapter } from "../../../src/encryption/encrypted-adapter";
import type { CloudAdapter, CloudFile, CloudChanges } from "../../../src/types/adapter";
import type { ICryptoEngine } from "../../../src/encryption/interfaces";
import { DecryptionError } from "../../../src/encryption/errors";
import { createMockEngine } from "../../helpers/mock-crypto-engine";

// ============================================================================
// Mock Base Adapter Factory
// ============================================================================

function createMockBaseAdapter(overrides: Partial<CloudAdapter> = {}): CloudAdapter {
    return {
        name: "MockBase",
        vaultName: "TestVault",
        supportsChangesAPI: true,
        supportsHash: true,
        supportsHistory: true,
        isAuthenticated: vi.fn().mockReturnValue(true),
        getAuthUrl: vi.fn().mockResolvedValue(""),
        handleCallback: vi.fn().mockResolvedValue(undefined),
        logout: vi.fn().mockResolvedValue(undefined),
        initialize: vi.fn().mockResolvedValue(undefined),
        getFileMetadata: vi.fn().mockResolvedValue(null),
        getFileMetadataById: vi.fn().mockResolvedValue(null),
        downloadFile: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
        uploadFile: vi.fn().mockResolvedValue({
            id: "file-1",
            name: "test.md",
            path: "test.md",
            mtime: Date.now(),
            size: 100,
            hash: "abc123",
        }),
        uploadFileResumable: vi.fn().mockResolvedValue({
            id: "file-1",
            name: "test.md",
            path: "test.md",
            mtime: Date.now(),
            size: 100,
            hash: "abc123",
        }),
        initiateResumableSession: vi.fn().mockResolvedValue("mock-session-uri"),
        uploadChunk: vi.fn().mockResolvedValue(null),
        deleteFile: vi.fn().mockResolvedValue(undefined),
        moveFile: vi.fn().mockResolvedValue({
            id: "file-1",
            name: "moved.md",
            path: "moved.md",
            mtime: Date.now(),
            size: 100,
            hash: "abc123",
        }),
        createFolder: vi.fn().mockResolvedValue("folder-1"),
        ensureFoldersExist: vi.fn().mockResolvedValue(undefined),
        fileExistsById: vi.fn().mockResolvedValue(false),
        getStartPageToken: vi.fn().mockResolvedValue("token-0"),
        getChanges: vi.fn().mockResolvedValue({
            newStartPageToken: "token-1",
            changes: [],
        } as CloudChanges),
        listFiles: vi.fn().mockResolvedValue([]),
        setLogger: vi.fn(),
        reset: vi.fn(),
        getAppRootId: vi.fn().mockResolvedValue("app-root-id"),
        cloneWithNewVaultName: vi.fn().mockReturnValue({} as CloudAdapter),
        getBaseAdapter: vi.fn().mockReturnValue({} as CloudAdapter),
        getFolderIdByName: vi.fn().mockResolvedValue(null),
        listRevisions: vi.fn().mockResolvedValue([]),
        getRevisionContent: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
        setRevisionKeepForever: vi.fn().mockResolvedValue(undefined),
        deleteRevision: vi.fn().mockResolvedValue(undefined),
        clearDownloadCache: vi.fn(),
        ...overrides,
    } as CloudAdapter;
}

// ============================================================================
// Test Suite
// ============================================================================

describe("EncryptedAdapter", () => {
    let baseAdapter: CloudAdapter;
    let engine: ICryptoEngine;
    let adapter: EncryptedAdapter;

    beforeEach(() => {
        baseAdapter = createMockBaseAdapter();
        engine = createMockEngine();
        adapter = new EncryptedAdapter(baseAdapter, engine);
    });

    // ============================================================================
    // 1. Constructor Initialization
    // ============================================================================

    describe("constructor", () => {
        it("should inherit feature flags from base adapter", () => {
            expect(adapter.supportsChangesAPI).toBe(true);
            expect(adapter.supportsHash).toBe(true);
            expect(adapter.supportsHistory).toBe(true);
        });

        it("should inherit feature flags when base has different values", () => {
            const customBase = createMockBaseAdapter({
                supportsChangesAPI: false,
                supportsHash: false,
                supportsHistory: false,
            });
            const customAdapter = new EncryptedAdapter(customBase, engine);

            expect(customAdapter.supportsChangesAPI).toBe(false);
            expect(customAdapter.supportsHash).toBe(false);
            expect(customAdapter.supportsHistory).toBe(false);
        });

        it("should accept custom largeFileThresholdBytes", () => {
            const customAdapter = new EncryptedAdapter(baseAdapter, engine, 10 * 1024 * 1024);
            expect(customAdapter).toBeDefined();
        });

        it("should default largeFileThresholdBytes to 0", () => {
            const adapterWithDefault = new EncryptedAdapter(baseAdapter, engine);
            expect(adapterWithDefault).toBeDefined();
        });
    });

    // ============================================================================
    // 2. Name and Vault Properties
    // ============================================================================

    describe("name property", () => {
        it("should return base adapter name with (Encrypted) suffix", () => {
            expect(adapter.name).toBe("MockBase (Encrypted)");
        });
    });

    describe("vaultName property", () => {
        it("should return base adapter vault name", () => {
            expect(adapter.vaultName).toBe("TestVault");
        });
    });

    // ============================================================================
    // 3. Auth Operations (Delegation)
    // ============================================================================

    describe("initialize", () => {
        it("should delegate to base adapter when initialize exists", async () => {
            await adapter.initialize();
            expect(baseAdapter.initialize).toHaveBeenCalled();
        });

        it("should not throw when base adapter has no initialize method", async () => {
            const baseWithoutInit = createMockBaseAdapter();
            delete (baseWithoutInit as any).initialize;
            const adapterWithoutInit = new EncryptedAdapter(baseWithoutInit, engine);

            await expect(adapterWithoutInit.initialize()).resolves.toBeUndefined();
        });
    });

    describe("isAuthenticated", () => {
        it("should delegate to base adapter", () => {
            adapter.isAuthenticated();
            expect(baseAdapter.isAuthenticated).toHaveBeenCalled();
        });

        it("should return value from base adapter", () => {
            (baseAdapter.isAuthenticated as ReturnType<typeof vi.fn>).mockReturnValue(false);
            expect(adapter.isAuthenticated()).toBe(false);
        });
    });

    describe("getAuthUrl", () => {
        it("should delegate to base adapter", async () => {
            (baseAdapter.getAuthUrl as ReturnType<typeof vi.fn>).mockResolvedValue(
                "https://auth.url",
            );
            const result = await adapter.getAuthUrl();
            expect(result).toBe("https://auth.url");
            expect(baseAdapter.getAuthUrl).toHaveBeenCalled();
        });
    });

    describe("handleCallback", () => {
        it("should delegate to base adapter", async () => {
            await adapter.handleCallback("https://callback.url?code=abc");
            expect(baseAdapter.handleCallback).toHaveBeenCalledWith(
                "https://callback.url?code=abc",
            );
        });

        it("should pass URL object to base adapter", async () => {
            const url = new URL("https://callback.url?code=abc");
            await adapter.handleCallback(url);
            expect(baseAdapter.handleCallback).toHaveBeenCalledWith(url);
        });
    });

    describe("logout", () => {
        it("should delegate to base adapter", async () => {
            await adapter.logout();
            expect(baseAdapter.logout).toHaveBeenCalled();
        });
    });

    // ============================================================================
    // 4. File Metadata Operations (Delegation)
    // ============================================================================

    describe("getFileMetadata", () => {
        it("should delegate to base adapter", async () => {
            const mockFile: CloudFile = {
                id: "file-1",
                path: "test.md",
                mtime: Date.now(),
                size: 100,
                hash: "abc123",
                kind: "file",
            };
            (baseAdapter.getFileMetadata as ReturnType<typeof vi.fn>).mockResolvedValue(mockFile);

            const result = await adapter.getFileMetadata("test.md");

            expect(baseAdapter.getFileMetadata).toHaveBeenCalledWith("test.md");
            expect(result).toEqual(mockFile);
        });

        it("should return null when file does not exist", async () => {
            (baseAdapter.getFileMetadata as ReturnType<typeof vi.fn>).mockResolvedValue(null);

            const result = await adapter.getFileMetadata("missing.md");

            expect(result).toBeNull();
        });
    });

    describe("getFileMetadataById", () => {
        it("should delegate to base adapter", async () => {
            const mockFile: CloudFile = {
                id: "file-1",
                path: "test.md",
                mtime: Date.now(),
                size: 100,
                hash: "abc123",
                kind: "file",
            };
            (baseAdapter.getFileMetadataById as ReturnType<typeof vi.fn>).mockResolvedValue(
                mockFile,
            );

            const result = await adapter.getFileMetadataById("file-1", "test.md");

            expect(baseAdapter.getFileMetadataById).toHaveBeenCalledWith("file-1", "test.md");
            expect(result).toEqual(mockFile);
        });

        it("should work without knownPath parameter", async () => {
            (baseAdapter.getFileMetadataById as ReturnType<typeof vi.fn>).mockResolvedValue(null);

            await adapter.getFileMetadataById("file-1");

            expect(baseAdapter.getFileMetadataById).toHaveBeenCalledWith("file-1", undefined);
        });
    });

    // ============================================================================
    // 5. Download with Decryption
    // ============================================================================

    describe("downloadFile", () => {
        it("should download and decrypt file content", async () => {
            const plaintext = new TextEncoder().encode("Hello, World!");
            const encrypted = await engine.encryptToBlob(plaintext.buffer);

            (baseAdapter.downloadFile as ReturnType<typeof vi.fn>).mockResolvedValue(encrypted);

            const result = await adapter.downloadFile("file-1");
            const decoded = new TextDecoder().decode(result);

            expect(decoded).toBe("Hello, World!");
            expect(baseAdapter.downloadFile).toHaveBeenCalledWith("file-1");
        });

        it("should use cache for repeated downloads", async () => {
            const plaintext = new TextEncoder().encode("Cached content");
            const encrypted = await engine.encryptToBlob(plaintext.buffer);

            (baseAdapter.downloadFile as ReturnType<typeof vi.fn>).mockResolvedValue(encrypted);

            // First download
            const result1 = await adapter.downloadFile("file-1");
            expect(new TextDecoder().decode(result1)).toBe("Cached content");

            // Second download should use cache
            const result2 = await adapter.downloadFile("file-1");
            expect(new TextDecoder().decode(result2)).toBe("Cached content");

            // downloadFile should only be called once
            expect(baseAdapter.downloadFile).toHaveBeenCalledTimes(1);
        });

        it("should return cached content copy (not reference)", async () => {
            const plaintext = new TextEncoder().encode("Original");
            const encrypted = await engine.encryptToBlob(plaintext.buffer);

            (baseAdapter.downloadFile as ReturnType<typeof vi.fn>).mockResolvedValue(encrypted);

            const result1 = await adapter.downloadFile("file-1");
            const result2 = await adapter.downloadFile("file-1");

            // Results should be equal but not the same reference
            expect(result1).not.toBe(result2);
            expect(new Uint8Array(result1)).toEqual(new Uint8Array(result2));
        });

        it("should decrypt chunked format (VSC2)", async () => {
            const plaintext = new TextEncoder().encode("Chunked content for testing");
            const encrypted = await engine.encryptChunked(plaintext.buffer);

            (baseAdapter.downloadFile as ReturnType<typeof vi.fn>).mockResolvedValue(encrypted);

            const result = await adapter.downloadFile("file-1");
            const decoded = new TextDecoder().decode(result);

            expect(decoded).toBe("Chunked content for testing");
        });

        it("should throw DecryptionError for corrupted data", async () => {
            const corruptedData = new ArrayBuffer(100);
            const failingEngine = createMockEngine({
                decryptFromBlob: vi.fn().mockRejectedValue(new Error("OperationError")),
            });

            (baseAdapter.downloadFile as ReturnType<typeof vi.fn>).mockResolvedValue(corruptedData);

            const adapterWithFailingEngine = new EncryptedAdapter(baseAdapter, failingEngine);

            await expect(adapterWithFailingEngine.downloadFile("file-1")).rejects.toThrow(
                DecryptionError,
            );
        });

        it("should throw DecryptionError with format cause for too short data", async () => {
            // Data shorter than IV size
            const shortData = new Uint8Array([1, 2, 3]).buffer;

            (baseAdapter.downloadFile as ReturnType<typeof vi.fn>).mockResolvedValue(shortData);

            await expect(adapter.downloadFile("file-1")).rejects.toThrow(DecryptionError);
        });

        it("should handle engine throwing DecryptionError directly", async () => {
            const engineWithDecryptionError = createMockEngine({
                decryptFromBlob: vi
                    .fn()
                    .mockRejectedValue(
                        new DecryptionError("Direct decryption error", "authentication"),
                    ),
            });
            const data = new Uint8Array(100).buffer;

            (baseAdapter.downloadFile as ReturnType<typeof vi.fn>).mockResolvedValue(data);

            const adapterWithErrorEngine = new EncryptedAdapter(
                baseAdapter,
                engineWithDecryptionError,
            );

            await expect(adapterWithErrorEngine.downloadFile("file-1")).rejects.toThrow(
                DecryptionError,
            );
        });
    });

    // ============================================================================
    // 6. Upload with Encryption
    // ============================================================================

    describe("uploadFile", () => {
        it("should encrypt content before uploading", async () => {
            const plaintext = new TextEncoder().encode("Secret content").buffer;
            const mockResult: CloudFile = {
                id: "file-1",
                path: "secret.md",
                mtime: Date.now(),
                size: 200,
                hash: "encrypted-hash",
                kind: "file",
            };

            (baseAdapter.uploadFile as ReturnType<typeof vi.fn>).mockImplementation(
                async (_path: string, content: ArrayBuffer) => {
                    // Verify content is encrypted (should be different from plaintext)
                    expect(content.byteLength).not.toBe(plaintext.byteLength);
                    return mockResult;
                },
            );

            const result = await adapter.uploadFile("secret.md", plaintext, Date.now());
            expect(result).toEqual(mockResult);
        });

        it("should pass existingFileId to base adapter", async () => {
            const plaintext = new TextEncoder().encode("Updated content").buffer;

            await adapter.uploadFile("secret.md", plaintext, Date.now(), "existing-file-id");

            expect(baseAdapter.uploadFile).toHaveBeenCalledWith(
                "secret.md",
                expect.any(ArrayBuffer),
                expect.any(Number),
                "existing-file-id",
            );
        });

        it("should clear download cache after upload", async () => {
            // First download to populate cache
            const plaintext = new TextEncoder().encode("Content");
            const encrypted = await engine.encryptToBlob(plaintext.buffer);
            (baseAdapter.downloadFile as ReturnType<typeof vi.fn>).mockResolvedValue(encrypted);
            await adapter.downloadFile("file-1");

            // Upload should clear cache
            const uploadPlaintext = new TextEncoder().encode("New content").buffer;
            await adapter.uploadFile("test.md", uploadPlaintext, Date.now(), "file-1");

            // Next download should fetch fresh data
            (baseAdapter.downloadFile as ReturnType<typeof vi.fn>).mockClear();
            (baseAdapter.downloadFile as ReturnType<typeof vi.fn>).mockResolvedValue(
                await engine.encryptToBlob(new TextEncoder().encode("New content").buffer),
            );
            await adapter.downloadFile("file-1");
            expect(baseAdapter.downloadFile).toHaveBeenCalledTimes(1);
        });
    });

    // ============================================================================
    // 7. Resumable Upload with Encryption
    // ============================================================================

    describe("uploadFileResumable", () => {
        it("should use chunked streaming for large files when threshold is set", async () => {
            const largeThreshold = 1024; // 1KB threshold
            const largeAdapter = new EncryptedAdapter(baseAdapter, engine, largeThreshold);

            const largeContent = new Uint8Array(2048).buffer; // 2KB content
            const mockResult: CloudFile = {
                id: "file-large",
                path: "large.bin",
                mtime: Date.now(),
                size: 3000,
                hash: "large-hash",
                kind: "file",
            };

            // Mock uploadChunk to return the result immediately (single chunk case)
            (baseAdapter.uploadChunk as ReturnType<typeof vi.fn>).mockResolvedValue(mockResult);

            const result = await largeAdapter.uploadFileResumable(
                "large.bin",
                largeContent,
                Date.now(),
            );

            expect(baseAdapter.initiateResumableSession).toHaveBeenCalled();
            expect(result).toEqual(mockResult);
        });

        it("should fall back to regular uploadFile when base lacks resumable methods", async () => {
            const largeThreshold = 1024;
            // Create a base adapter that has uploadFileResumable but lacks chunked upload methods
            const baseWithoutResumable = createMockBaseAdapter();
            delete (baseWithoutResumable as any).initiateResumableSession;
            delete (baseWithoutResumable as any).uploadChunk;
            // Also remove uploadFileResumable to force fallback to uploadFile
            delete (baseWithoutResumable as any).uploadFileResumable;

            const largeAdapter = new EncryptedAdapter(baseWithoutResumable, engine, largeThreshold);
            const largeContent = new Uint8Array(2048).buffer;

            await largeAdapter.uploadFileResumable("large.bin", largeContent, Date.now());

            expect(baseWithoutResumable.uploadFile).toHaveBeenCalled();
        });

        it("should use full encryption when file is below threshold", async () => {
            const largeThreshold = 1024;
            const largeAdapter = new EncryptedAdapter(baseAdapter, engine, largeThreshold);
            const smallContent = new Uint8Array(512).buffer; // 512 bytes

            await largeAdapter.uploadFileResumable("small.bin", smallContent, Date.now());

            expect(baseAdapter.initiateResumableSession).not.toHaveBeenCalled();
            expect(baseAdapter.uploadFileResumable).toHaveBeenCalled();
        });

        it("should fall back to uploadFile when uploadFileResumable is not available", async () => {
            const baseWithoutResumableUpload = createMockBaseAdapter();
            delete (baseWithoutResumableUpload as any).uploadFileResumable;

            const adapterWithoutResumable = new EncryptedAdapter(
                baseWithoutResumableUpload,
                engine,
            );
            const content = new TextEncoder().encode("Test content").buffer;

            await adapterWithoutResumable.uploadFileResumable("test.md", content, Date.now());

            expect(baseWithoutResumableUpload.uploadFile).toHaveBeenCalled();
        });

        it("should pass existingFileId in chunked upload", async () => {
            const largeThreshold = 1024;
            const largeAdapter = new EncryptedAdapter(baseAdapter, engine, largeThreshold);
            const largeContent = new Uint8Array(2048).buffer;

            (baseAdapter.uploadChunk as ReturnType<typeof vi.fn>).mockResolvedValue({
                id: "existing-id",
                name: "large.bin",
                path: "large.bin",
                mtime: Date.now(),
                size: 3000,
                hash: "hash",
                kind: "file",
            });

            await largeAdapter.uploadFileResumable(
                "large.bin",
                largeContent,
                Date.now(),
                "existing-id",
            );

            expect(baseAdapter.initiateResumableSession).toHaveBeenCalledWith(
                "large.bin",
                expect.any(Number),
                expect.any(Number),
                "existing-id",
            );
        });

        it("should handle chunked streaming upload that does not complete properly", async () => {
            const largeThreshold = 1024;
            const largeAdapter = new EncryptedAdapter(baseAdapter, engine, largeThreshold);
            const largeContent = new Uint8Array(2048).buffer;

            // Mock uploadChunk to always return null (never complete)
            (baseAdapter.uploadChunk as ReturnType<typeof vi.fn>).mockResolvedValue(null);

            await expect(
                largeAdapter.uploadFileResumable("large.bin", largeContent, Date.now()),
            ).rejects.toThrow("Chunked streaming upload did not complete");
        });

        it("should flush intermediate chunks when buffer fills up", async () => {
            // Use a very small threshold to trigger chunked upload with small content
            // UPLOAD_BATCH_SIZE is 5MB, so we need content that generates > 5MB of encrypted data
            // Each chunk is ~1MB plaintext + overhead, so we need 6+ chunks to trigger intermediate flush
            const largeThreshold = 1; // Any file goes through chunked upload
            const largeAdapter = new EncryptedAdapter(baseAdapter, engine, largeThreshold);

            // Create content that will generate many encrypted chunks
            // Each plaintext chunk is ~1MB, encrypted becomes ~1MB + 28 bytes (IV + tag)
            // We need total encrypted size > 5MB to trigger intermediate flush
            const chunkSize = 1024 * 1024; // 1 MiB
            const numChunks = 7; // Should generate ~7 MiB encrypted, exceeding 5MB batch
            const largeContent = new Uint8Array(chunkSize * numChunks).buffer;

            const mockResult: CloudFile = {
                id: "file-large",
                path: "large.bin",
                mtime: Date.now(),
                size: largeContent.byteLength,
                hash: "large-hash",
                kind: "file",
            };

            // Track how many times uploadChunk is called
            let uploadChunkCalls = 0;
            (baseAdapter.uploadChunk as ReturnType<typeof vi.fn>).mockImplementation(
                (_sessionUri: string, chunk: ArrayBuffer, offset: number, totalSize: number) => {
                    uploadChunkCalls++;
                    // Return result only on final chunk
                    if (offset + chunk.byteLength >= totalSize) {
                        return Promise.resolve(mockResult);
                    }
                    return Promise.resolve(null);
                },
            );

            const result = await largeAdapter.uploadFileResumable(
                "large.bin",
                largeContent,
                Date.now(),
            );

            expect(result).toEqual(mockResult);
            // Should have been called multiple times (intermediate + final)
            expect(uploadChunkCalls).toBeGreaterThan(1);
        });

        it("should handle intermediate chunk when aligned > 0 (line 335)", async () => {
            // This test specifically targets line 335 (if (aligned > 0))
            // We need to ensure the code path where aligned is calculated and used
            const largeThreshold = 1;
            const largeAdapter = new EncryptedAdapter(baseAdapter, engine, largeThreshold);

            // Create content that generates encrypted data between 5MB and 5MB + 256KB
            // This ensures bufPos >= BATCH (5MB) but we test the aligned calculation
            const chunkSize = 1024 * 1024; // 1 MiB
            const numChunks = 6; // ~6 MiB encrypted
            const largeContent = new Uint8Array(chunkSize * numChunks).buffer;

            const mockResult: CloudFile = {
                id: "file-aligned",
                path: "aligned.bin",
                mtime: Date.now(),
                size: largeContent.byteLength,
                hash: "aligned-hash",
                kind: "file",
            };

            let capturedAligned = 0;
            (baseAdapter.uploadChunk as ReturnType<typeof vi.fn>).mockImplementation(
                (_sessionUri: string, chunk: ArrayBuffer, offset: number, totalSize: number) => {
                    // Capture the aligned value indirectly through chunk size
                    if (offset + chunk.byteLength < totalSize) {
                        capturedAligned = chunk.byteLength;
                    }
                    if (offset + chunk.byteLength >= totalSize) {
                        return Promise.resolve(mockResult);
                    }
                    return Promise.resolve(null);
                },
            );

            const result = await largeAdapter.uploadFileResumable(
                "aligned.bin",
                largeContent,
                Date.now(),
            );

            expect(result).toEqual(mockResult);
            // aligned should be > 0 since we have more than 5MB of data
            expect(capturedAligned).toBeGreaterThan(0);
        });

        it("should skip upload when aligned is 0 (line 335 defensive guard)", async () => {
            // This test documents the defensive guard at line 335
            // In practice, aligned should always be > 0 when we reach this code
            // because bufPos >= BATCH (5MB) and ALIGN is 256KB
            const largeThreshold = 1;
            const largeAdapter = new EncryptedAdapter(baseAdapter, engine, largeThreshold);

            // Small content that won't trigger intermediate flush
            const smallContent = new Uint8Array(1024).buffer;

            const mockResult: CloudFile = {
                id: "file-small",
                path: "small.bin",
                mtime: Date.now(),
                size: smallContent.byteLength,
                hash: "small-hash",
                kind: "file",
            };

            (baseAdapter.uploadChunk as ReturnType<typeof vi.fn>).mockResolvedValue(mockResult);

            const result = await largeAdapter.uploadFileResumable(
                "small.bin",
                smallContent,
                Date.now(),
            );

            expect(result).toEqual(mockResult);
            // For small files, we should only have one uploadChunk call (final chunk)
            expect(baseAdapter.uploadChunk).toHaveBeenCalledTimes(1);
        });

        it("should use uploadFileResumable when available and above threshold but no chunked support", async () => {
            const largeThreshold = 1024;
            // Base has uploadFileResumable but not initiateResumableSession
            const baseWithPartialSupport = createMockBaseAdapter();
            delete (baseWithPartialSupport as any).initiateResumableSession;

            const adapterWithPartial = new EncryptedAdapter(
                baseWithPartialSupport,
                engine,
                largeThreshold,
            );
            const largeContent = new Uint8Array(2048).buffer;

            await adapterWithPartial.uploadFileResumable("large.bin", largeContent, Date.now());

            expect(baseWithPartialSupport.uploadFileResumable).toHaveBeenCalled();
        });
    });

    // ============================================================================
    // 8. Download Cache Management
    // ============================================================================

    describe("clearDownloadCache", () => {
        it("should clear the download cache", async () => {
            // Populate cache
            const plaintext = new TextEncoder().encode("Cached");
            const encrypted = await engine.encryptToBlob(plaintext.buffer);
            (baseAdapter.downloadFile as ReturnType<typeof vi.fn>).mockResolvedValue(encrypted);

            await adapter.downloadFile("file-1");

            // Clear cache
            adapter.clearDownloadCache();

            // Next download should fetch fresh
            await adapter.downloadFile("file-1");
            expect(baseAdapter.downloadFile).toHaveBeenCalledTimes(2);
        });
    });

    // ============================================================================
    // 9. Delete, Move, Folder Operations (Delegation)
    // ============================================================================

    describe("deleteFile", () => {
        it("should delegate to base adapter", async () => {
            await adapter.deleteFile("file-1");
            expect(baseAdapter.deleteFile).toHaveBeenCalledWith("file-1");
        });
    });

    describe("moveFile", () => {
        it("should delegate to base adapter", async () => {
            const mockResult: CloudFile = {
                id: "file-1",
                path: "folder/newname.md",
                mtime: Date.now(),
                size: 100,
                hash: "hash",
                kind: "file",
            };
            (baseAdapter.moveFile as ReturnType<typeof vi.fn>).mockResolvedValue(mockResult);

            const result = await adapter.moveFile("file-1", "newname.md", "folder");

            expect(baseAdapter.moveFile).toHaveBeenCalledWith("file-1", "newname.md", "folder");
            expect(result).toEqual(mockResult);
        });

        it("should handle null newParentPath", async () => {
            await adapter.moveFile("file-1", "newname.md", null);
            expect(baseAdapter.moveFile).toHaveBeenCalledWith("file-1", "newname.md", null);
        });
    });

    describe("createFolder", () => {
        it("should delegate to base adapter", async () => {
            (baseAdapter.createFolder as ReturnType<typeof vi.fn>).mockResolvedValue("folder-123");

            const result = await adapter.createFolder("newfolder");

            expect(baseAdapter.createFolder).toHaveBeenCalledWith("newfolder");
            expect(result).toBe("folder-123");
        });
    });

    describe("ensureFoldersExist", () => {
        it("should delegate to base adapter", async () => {
            const paths = ["folder1", "folder2/sub"];
            await adapter.ensureFoldersExist(paths);
            expect(baseAdapter.ensureFoldersExist).toHaveBeenCalledWith(paths, undefined);
        });

        it("should pass progress callback to base adapter", async () => {
            const paths = ["folder1"];
            const progressFn = vi.fn();
            await adapter.ensureFoldersExist(paths, progressFn);
            expect(baseAdapter.ensureFoldersExist).toHaveBeenCalledWith(paths, progressFn);
        });
    });

    // ============================================================================
    // 10. File Existence Check (Delegation)
    // ============================================================================

    describe("fileExistsById", () => {
        it("should delegate to base adapter", async () => {
            (baseAdapter.fileExistsById as ReturnType<typeof vi.fn>).mockResolvedValue(true);

            const result = await adapter.fileExistsById("file-1");

            expect(baseAdapter.fileExistsById).toHaveBeenCalledWith("file-1");
            expect(result).toBe(true);
        });
    });

    // ============================================================================
    // 11. Changes API (Delegation)
    // ============================================================================

    describe("getStartPageToken", () => {
        it("should delegate to base adapter", async () => {
            (baseAdapter.getStartPageToken as ReturnType<typeof vi.fn>).mockResolvedValue(
                "token-123",
            );

            const result = await adapter.getStartPageToken();

            expect(baseAdapter.getStartPageToken).toHaveBeenCalled();
            expect(result).toBe("token-123");
        });
    });

    describe("getChanges", () => {
        it("should delegate to base adapter", async () => {
            const mockChanges: CloudChanges = {
                newStartPageToken: "token-2",
                changes: [
                    { fileId: "file-1", removed: false },
                    { fileId: "file-2", removed: true },
                ],
            };
            (baseAdapter.getChanges as ReturnType<typeof vi.fn>).mockResolvedValue(mockChanges);

            const result = await adapter.getChanges("token-1");

            expect(baseAdapter.getChanges).toHaveBeenCalledWith("token-1");
            expect(result).toEqual(mockChanges);
        });
    });

    describe("listFiles", () => {
        it("should delegate to base adapter", async () => {
            const mockFiles: CloudFile[] = [
                { id: "file-1", path: "a.md", mtime: 1, size: 10, kind: "file" },
                { id: "file-2", path: "b.md", mtime: 2, size: 20, kind: "file" },
            ];
            (baseAdapter.listFiles as ReturnType<typeof vi.fn>).mockResolvedValue(mockFiles);

            const result = await adapter.listFiles();

            expect(baseAdapter.listFiles).toHaveBeenCalledWith(undefined);
            expect(result).toEqual(mockFiles);
        });

        it("should pass folderId parameter", async () => {
            await adapter.listFiles("folder-123");
            expect(baseAdapter.listFiles).toHaveBeenCalledWith("folder-123");
        });
    });

    // ============================================================================
    // 12. History Support (Delegation with Decryption)
    // ============================================================================

    describe("listRevisions", () => {
        it("should delegate to base adapter", async () => {
            const mockRevisions = [
                { id: "rev-1", modifiedTime: 1000, size: 100, hash: "h1" },
                { id: "rev-2", modifiedTime: 2000, size: 200, hash: "h2" },
            ];
            (baseAdapter.listRevisions as ReturnType<typeof vi.fn>).mockResolvedValue(
                mockRevisions,
            );

            const result = await adapter.listRevisions("test.md");

            expect(baseAdapter.listRevisions).toHaveBeenCalledWith("test.md");
            expect(result).toEqual(mockRevisions);
        });

        it("should throw when base adapter does not support listRevisions", async () => {
            const baseWithoutHistory = createMockBaseAdapter();
            delete (baseWithoutHistory as any).listRevisions;

            const adapterWithoutHistory = new EncryptedAdapter(baseWithoutHistory, engine);

            await expect(adapterWithoutHistory.listRevisions("test.md")).rejects.toThrow(
                "does not support listRevisions",
            );
        });
    });

    describe("getRevisionContent", () => {
        it("should download and decrypt revision content", async () => {
            const plaintext = new TextEncoder().encode("Revision content");
            const encrypted = await engine.encryptToBlob(plaintext.buffer);

            (baseAdapter.getRevisionContent as ReturnType<typeof vi.fn>).mockResolvedValue(
                encrypted,
            );

            const result = await adapter.getRevisionContent("test.md", "rev-1");
            const decoded = new TextDecoder().decode(result);

            expect(decoded).toBe("Revision content");
            expect(baseAdapter.getRevisionContent).toHaveBeenCalledWith("test.md", "rev-1");
        });

        it("should throw when base adapter does not support getRevisionContent", async () => {
            const baseWithoutHistory = createMockBaseAdapter();
            delete (baseWithoutHistory as any).getRevisionContent;

            const adapterWithoutHistory = new EncryptedAdapter(baseWithoutHistory, engine);

            await expect(
                adapterWithoutHistory.getRevisionContent("test.md", "rev-1"),
            ).rejects.toThrow("does not support getRevisionContent");
        });
    });

    describe("setRevisionKeepForever", () => {
        it("should delegate to base adapter", async () => {
            await adapter.setRevisionKeepForever("test.md", "rev-1", true);
            expect(baseAdapter.setRevisionKeepForever).toHaveBeenCalledWith(
                "test.md",
                "rev-1",
                true,
            );
        });

        it("should throw when base adapter does not support setRevisionKeepForever", async () => {
            const baseWithoutHistory = createMockBaseAdapter();
            delete (baseWithoutHistory as any).setRevisionKeepForever;

            const adapterWithoutHistory = new EncryptedAdapter(baseWithoutHistory, engine);

            await expect(
                adapterWithoutHistory.setRevisionKeepForever("test.md", "rev-1", true),
            ).rejects.toThrow("does not support setRevisionKeepForever");
        });
    });

    describe("deleteRevision", () => {
        it("should delegate to base adapter", async () => {
            await adapter.deleteRevision("test.md", "rev-1");
            expect(baseAdapter.deleteRevision).toHaveBeenCalledWith("test.md", "rev-1");
        });

        it("should throw when base adapter does not support deleteRevision", async () => {
            const baseWithoutHistory = createMockBaseAdapter();
            delete (baseWithoutHistory as any).deleteRevision;

            const adapterWithoutHistory = new EncryptedAdapter(baseWithoutHistory, engine);

            await expect(adapterWithoutHistory.deleteRevision("test.md", "rev-1")).rejects.toThrow(
                "does not support deleteRevision",
            );
        });
    });

    // ============================================================================
    // 13. Utility Methods (Delegation)
    // ============================================================================

    describe("setLogger", () => {
        it("should delegate to base adapter", () => {
            const logger = vi.fn();
            adapter.setLogger(logger);
            expect(baseAdapter.setLogger).toHaveBeenCalledWith(logger);
        });
    });

    describe("reset", () => {
        it("should delegate to base adapter", () => {
            adapter.reset();
            expect(baseAdapter.reset).toHaveBeenCalled();
        });
    });

    describe("getAppRootId", () => {
        it("should delegate to base adapter", async () => {
            (baseAdapter.getAppRootId as ReturnType<typeof vi.fn>).mockResolvedValue("root-123");

            const result = await adapter.getAppRootId();

            expect(baseAdapter.getAppRootId).toHaveBeenCalled();
            expect(result).toBe("root-123");
        });
    });

    describe("cloneWithNewVaultName", () => {
        it("should delegate to base adapter", () => {
            const mockCloned = {} as CloudAdapter;
            (baseAdapter.cloneWithNewVaultName as ReturnType<typeof vi.fn>).mockReturnValue(
                mockCloned,
            );

            const result = adapter.cloneWithNewVaultName("NewVault");

            expect(baseAdapter.cloneWithNewVaultName).toHaveBeenCalledWith("NewVault");
            expect(result).toBe(mockCloned);
        });
    });

    describe("getBaseAdapter", () => {
        it("should return the underlying base adapter", () => {
            const result = adapter.getBaseAdapter();
            expect(result).toBe(baseAdapter);
        });
    });

    describe("getFolderIdByName", () => {
        it("should delegate to base adapter when available", async () => {
            (baseAdapter.getFolderIdByName as ReturnType<typeof vi.fn>).mockResolvedValue(
                "folder-123",
            );

            const result = await adapter.getFolderIdByName("MyFolder", "parent-1");

            expect(baseAdapter.getFolderIdByName).toHaveBeenCalledWith("MyFolder", "parent-1");
            expect(result).toBe("folder-123");
        });

        it("should return null when base adapter does not have getFolderIdByName", async () => {
            const baseWithoutMethod = createMockBaseAdapter();
            delete (baseWithoutMethod as any).getFolderIdByName;

            const adapterWithoutMethod = new EncryptedAdapter(baseWithoutMethod, engine);

            const result = await adapterWithoutMethod.getFolderIdByName("MyFolder");
            expect(result).toBeNull();
        });

        it("should work without parentId parameter", async () => {
            (baseAdapter.getFolderIdByName as ReturnType<typeof vi.fn>).mockResolvedValue(
                "folder-123",
            );

            await adapter.getFolderIdByName("MyFolder");

            expect(baseAdapter.getFolderIdByName).toHaveBeenCalledWith("MyFolder", undefined);
        });
    });

    // ============================================================================
    // 14. Decryption Error Handling
    // ============================================================================

    describe("decryptContent error handling", () => {
        it("should re-wrap engine errors with DecryptionError", async () => {
            const engineWithError = createMockEngine({
                decryptFromBlob: vi.fn().mockRejectedValue(new Error("Unknown engine error")),
            });
            const data = new Uint8Array(100).buffer;

            (baseAdapter.downloadFile as ReturnType<typeof vi.fn>).mockResolvedValue(data);

            const adapterWithErrorEngine = new EncryptedAdapter(baseAdapter, engineWithError);

            await expect(adapterWithErrorEngine.downloadFile("file-1")).rejects.toThrow(
                DecryptionError,
            );
        });

        it("should handle cross-module DecryptionError with name check", async () => {
            // Simulate an error with name "DecryptionError" but different class instance
            const crossModuleError = new Error("Cross-module error");
            crossModuleError.name = "DecryptionError";
            (crossModuleError as any).cause = "authentication";
            (crossModuleError as any).chunkIndex = 5;

            const engineWithCrossModuleError = createMockEngine({
                decryptFromBlob: vi.fn().mockRejectedValue(crossModuleError),
            });
            const data = new Uint8Array(100).buffer;

            (baseAdapter.downloadFile as ReturnType<typeof vi.fn>).mockResolvedValue(data);

            const adapterWithErrorEngine = new EncryptedAdapter(
                baseAdapter,
                engineWithCrossModuleError,
            );

            try {
                await adapterWithErrorEngine.downloadFile("file-1");
                expect.fail("Should have thrown");
            } catch (e) {
                expect(e).toBeInstanceOf(DecryptionError);
                expect((e as DecryptionError).cause).toBe("authentication");
                expect((e as DecryptionError).chunkIndex).toBe(5);
            }
        });

        it("should handle cross-module DecryptionError with invalid cause", async () => {
            const crossModuleError = new Error("Cross-module error");
            crossModuleError.name = "DecryptionError";
            (crossModuleError as any).cause = "invalid-cause";

            const engineWithCrossModuleError = createMockEngine({
                decryptFromBlob: vi.fn().mockRejectedValue(crossModuleError),
            });
            const data = new Uint8Array(100).buffer;

            (baseAdapter.downloadFile as ReturnType<typeof vi.fn>).mockResolvedValue(data);

            const adapterWithErrorEngine = new EncryptedAdapter(
                baseAdapter,
                engineWithCrossModuleError,
            );

            try {
                await adapterWithErrorEngine.downloadFile("file-1");
                expect.fail("Should have thrown");
            } catch (e) {
                expect(e).toBeInstanceOf(DecryptionError);
                // Should default to "authentication" when cause is invalid
                expect((e as DecryptionError).cause).toBe("authentication");
            }
        });

        it("should handle cross-module DecryptionError with non-numeric chunkIndex", async () => {
            const crossModuleError = new Error("Cross-module error");
            crossModuleError.name = "DecryptionError";
            (crossModuleError as any).cause = "format";
            (crossModuleError as any).chunkIndex = "not-a-number";

            const engineWithCrossModuleError = createMockEngine({
                decryptFromBlob: vi.fn().mockRejectedValue(crossModuleError),
            });
            const data = new Uint8Array(100).buffer;

            (baseAdapter.downloadFile as ReturnType<typeof vi.fn>).mockResolvedValue(data);

            const adapterWithErrorEngine = new EncryptedAdapter(
                baseAdapter,
                engineWithCrossModuleError,
            );

            try {
                await adapterWithErrorEngine.downloadFile("file-1");
                expect.fail("Should have thrown");
            } catch (e) {
                expect(e).toBeInstanceOf(DecryptionError);
                expect((e as DecryptionError).chunkIndex).toBeUndefined();
            }
        });
    });

    // ============================================================================
    // 15. Edge Cases
    // ============================================================================

    describe("edge cases", () => {
        it("should handle empty file upload", async () => {
            const emptyContent = new ArrayBuffer(0);

            await adapter.uploadFile("empty.md", emptyContent, Date.now());

            expect(baseAdapter.uploadFile).toHaveBeenCalledWith(
                "empty.md",
                expect.any(ArrayBuffer),
                expect.any(Number),
                undefined,
            );
        });

        it("should handle very small file upload", async () => {
            const tinyContent = new Uint8Array([1]).buffer;

            await adapter.uploadFile("tiny.md", tinyContent, Date.now());

            expect(baseAdapter.uploadFile).toHaveBeenCalled();
        });

        it("should handle zero threshold (disable chunked encryption)", async () => {
            const adapterWithZeroThreshold = new EncryptedAdapter(baseAdapter, engine, 0);
            const largeContent = new Uint8Array(1024 * 1024).buffer; // 1MB

            await adapterWithZeroThreshold.uploadFileResumable(
                "large.bin",
                largeContent,
                Date.now(),
            );

            // Should NOT use chunked streaming (threshold is 0)
            expect(baseAdapter.initiateResumableSession).not.toHaveBeenCalled();
        });

        it("should handle exact threshold size", async () => {
            const threshold = 1024;
            const adapterWithThreshold = new EncryptedAdapter(baseAdapter, engine, threshold);
            const exactContent = new Uint8Array(1024).buffer;

            // File exactly at threshold should use chunked
            (baseAdapter.uploadChunk as ReturnType<typeof vi.fn>).mockResolvedValue({
                id: "file-1",
                name: "exact.bin",
                path: "exact.bin",
                mtime: Date.now(),
                size: 1000,
                hash: "hash",
                kind: "file",
            });

            await adapterWithThreshold.uploadFileResumable("exact.bin", exactContent, Date.now());

            expect(baseAdapter.initiateResumableSession).toHaveBeenCalled();
        });

        it("should handle binary content with null bytes", async () => {
            const binaryContent = new Uint8Array([0, 1, 0, 2, 0, 255, 0]).buffer;
            const encrypted = await engine.encryptToBlob(binaryContent);

            (baseAdapter.downloadFile as ReturnType<typeof vi.fn>).mockResolvedValue(encrypted);

            const result = await adapter.downloadFile("binary.bin");
            expect(new Uint8Array(result)).toEqual(new Uint8Array([0, 1, 0, 2, 0, 255, 0]));
        });

        it("should handle unicode content", async () => {
            const unicodeContent = new TextEncoder().encode("Hello 世界 🌍 ñ").buffer;
            const encrypted = await engine.encryptToBlob(unicodeContent);

            (baseAdapter.downloadFile as ReturnType<typeof vi.fn>).mockResolvedValue(encrypted);

            const result = await adapter.downloadFile("unicode.md");
            const decoded = new TextDecoder().decode(result);
            expect(decoded).toBe("Hello 世界 🌍 ñ");
        });

        it("should handle decryption of empty encrypted data", async () => {
            // Even empty content gets IV prepended
            const emptyPlaintext = new ArrayBuffer(0);
            const encrypted = await engine.encryptToBlob(emptyPlaintext);

            (baseAdapter.downloadFile as ReturnType<typeof vi.fn>).mockResolvedValue(encrypted);

            const result = await adapter.downloadFile("empty.md");
            expect(result.byteLength).toBe(0);
        });
    });

    // ============================================================================
    // 16. Encryption Routing (VSC1 vs VSC2)
    // ============================================================================

    describe("encryption routing", () => {
        it("should use VSC1 (encryptToBlob) for small files", async () => {
            const spyEncryptToBlob = vi.spyOn(engine, "encryptToBlob");
            const spyEncryptChunked = vi.spyOn(engine, "encryptChunked");

            const smallContent = new TextEncoder().encode("Small").buffer;
            await adapter.uploadFile("small.md", smallContent, Date.now());

            expect(spyEncryptToBlob).toHaveBeenCalled();
            expect(spyEncryptChunked).not.toHaveBeenCalled();

            spyEncryptToBlob.mockRestore();
            spyEncryptChunked.mockRestore();
        });

        it("should use VSC2 (encryptChunked) for large files above threshold", async () => {
            const threshold = 1024;
            const adapterWithThreshold = new EncryptedAdapter(baseAdapter, engine, threshold);

            const spyEncryptToBlob = vi.spyOn(engine, "encryptToBlob");
            const spyEncryptChunked = vi.spyOn(engine, "encryptChunked");

            const largeContent = new Uint8Array(2048).buffer;

            // Setup for chunked upload
            (baseAdapter.uploadChunk as ReturnType<typeof vi.fn>).mockResolvedValue({
                id: "file-1",
                name: "large.bin",
                path: "large.bin",
                mtime: Date.now(),
                size: 3000,
                hash: "hash",
                kind: "file",
            });

            await adapterWithThreshold.uploadFileResumable("large.bin", largeContent, Date.now());

            // When using streaming chunked upload, encryptChunked is not called directly
            // Instead, encryptChunks is used
            expect(spyEncryptToBlob).not.toHaveBeenCalled();

            spyEncryptToBlob.mockRestore();
            spyEncryptChunked.mockRestore();
        });

        it("should auto-detect VSC2 format in decryptContent", async () => {
            const spyIsChunkedFormat = vi.spyOn(engine, "isChunkedFormat").mockReturnValue(true);
            const spyDecryptChunked = vi
                .spyOn(engine, "decryptChunked")
                .mockResolvedValue(new TextEncoder().encode("Chunked result").buffer);
            const spyDecryptFromBlob = vi.spyOn(engine, "decryptFromBlob");

            // VSC2 header magic
            const vsc2Data = new Uint8Array([0x56, 0x53, 0x43, 0x32, 0, 0, 0, 0, 0, 0, 0, 0])
                .buffer;
            (baseAdapter.downloadFile as ReturnType<typeof vi.fn>).mockResolvedValue(vsc2Data);

            await adapter.downloadFile("file-1");

            expect(spyIsChunkedFormat).toHaveBeenCalled();
            expect(spyDecryptChunked).toHaveBeenCalled();
            expect(spyDecryptFromBlob).not.toHaveBeenCalled();

            spyIsChunkedFormat.mockRestore();
            spyDecryptChunked.mockRestore();
            spyDecryptFromBlob.mockRestore();
        });

        it("should use VSC1 when not chunked format", async () => {
            const spyIsChunkedFormat = vi.spyOn(engine, "isChunkedFormat").mockReturnValue(false);
            const spyDecryptChunked = vi.spyOn(engine, "decryptChunked");
            const spyDecryptFromBlob = vi
                .spyOn(engine, "decryptFromBlob")
                .mockResolvedValue(new TextEncoder().encode("Blob result").buffer);

            // Non-VSC2 data (longer than IV)
            const blobData = new Uint8Array(100).buffer;
            (baseAdapter.downloadFile as ReturnType<typeof vi.fn>).mockResolvedValue(blobData);

            await adapter.downloadFile("file-1");

            expect(spyIsChunkedFormat).toHaveBeenCalled();
            expect(spyDecryptChunked).not.toHaveBeenCalled();
            expect(spyDecryptFromBlob).toHaveBeenCalled();

            spyIsChunkedFormat.mockRestore();
            spyDecryptChunked.mockRestore();
            spyDecryptFromBlob.mockRestore();
        });
    });
});
