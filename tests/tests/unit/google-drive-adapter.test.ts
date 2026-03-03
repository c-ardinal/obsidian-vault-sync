/**
 * @file GoogleDriveAdapter ユニットテスト
 *
 * @description
 * GoogleDriveAdapter のファイルCRUD、Changes API、リビジョン管理を
 * http.fetchWithAuth をモックしてテストする。
 * auth-service / http-client 自体のテストは対象外（別途テスト済み）。
 *
 * @pass_criteria
 * - getFileMetadata: 存在→CloudFile, 不在→null
 * - getFileMetadataById: 正常→CloudFile, trashed→null, エラー→null
 * - downloadFile: ArrayBuffer返却
 * - uploadFile: 新規POST / 既存PATCH
 * - deleteFile: DELETE呼出
 * - moveFile: PATCH + addParents/removeParents
 * - getStartPageToken / getChanges: パース正常
 * - listRevisions / getRevisionContent / setRevisionKeepForever / deleteRevision
 * - cloneWithNewVaultName: トークン引き継ぎ
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { GoogleDriveAdapter } from "../../../src/cloud-adapters/google-drive/index";

// Mock the entire http-client and path-resolver at the adapter level
function mockAdapter() {
    const adapter = new GoogleDriveAdapter("test-client-id", "test-secret", "TestVault", "MyRoot");
    // Set tokens so auth check passes
    adapter.auth.accessToken = "mock-access-token";
    adapter.auth.refreshToken = "mock-refresh-token";
    adapter.auth.tokenExpiresAt = Date.now() + 3600 * 1000;

    // Mock fetchWithAuth on the http client
    const http = (adapter as any).http;
    const mockFetch = vi.fn();
    http.fetchWithAuth = mockFetch;

    // Mock path resolver
    const pathResolver = (adapter as any).pathResolver;
    pathResolver.resolveParentId = vi.fn().mockResolvedValue("parent-folder-id");
    pathResolver.resolveFullPath = vi.fn().mockResolvedValue("resolved/path");
    pathResolver.ensureRootFolders = vi.fn().mockResolvedValue(undefined);
    pathResolver.cacheIdToPath = vi.fn();
    pathResolver.clearFolderCaches = vi.fn();
    pathResolver.vaultRootId = "vault-root-id";

    return { adapter, mockFetch, pathResolver };
}

function jsonResponse(data: any, status = 200, headers?: Record<string, string>): Response {
    const h = new Headers(headers);
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: h,
        json: () => Promise.resolve(data),
        arrayBuffer: () => Promise.resolve(new TextEncoder().encode(JSON.stringify(data)).buffer),
    } as any;
}

describe("GoogleDriveAdapter", () => {
    let adapter: GoogleDriveAdapter;
    let mockFetch: ReturnType<typeof vi.fn>;
    let pathResolver: any;

    beforeEach(() => {
        ({ adapter, mockFetch, pathResolver } = mockAdapter());
    });

    // === Basic Properties ===

    it("should expose feature flags", () => {
        expect(adapter.supportsChangesAPI).toBe(true);
        expect(adapter.supportsHash).toBe(true);
        expect(adapter.supportsHistory).toBe(true);
    });

    // === getFileMetadata ===

    describe("getFileMetadata", () => {
        it("should return CloudFile when file exists", async () => {
            mockFetch.mockResolvedValueOnce(jsonResponse({
                files: [{
                    id: "file-123",
                    name: "test.md",
                    mimeType: "text/plain",
                    modifiedTime: "2026-01-01T00:00:00Z",
                    size: "1024",
                    md5Checksum: "abc123",
                }],
            }));

            const result = await adapter.getFileMetadata("notes/test.md");
            expect(result).not.toBeNull();
            expect(result!.id).toBe("file-123");
            expect(result!.path).toBe("notes/test.md");
            expect(result!.size).toBe(1024);
            expect(result!.hash).toBe("abc123");
            expect(result!.kind).toBe("file");
        });

        it("should return null when file does not exist", async () => {
            mockFetch.mockResolvedValueOnce(jsonResponse({ files: [] }));
            const result = await adapter.getFileMetadata("notes/missing.md");
            expect(result).toBeNull();
        });

        it("should return null when parent resolution fails", async () => {
            pathResolver.resolveParentId.mockRejectedValueOnce(new Error("not found"));
            const result = await adapter.getFileMetadata("bad/path.md");
            expect(result).toBeNull();
        });

        it("should detect folder kind", async () => {
            mockFetch.mockResolvedValueOnce(jsonResponse({
                files: [{
                    id: "folder-1",
                    name: "docs",
                    mimeType: "application/vnd.google-apps.folder",
                    modifiedTime: "2026-01-01T00:00:00Z",
                    size: "0",
                }],
            }));

            const result = await adapter.getFileMetadata("docs");
            expect(result!.kind).toBe("folder");
        });
    });

    // === getFileMetadataById ===

    describe("getFileMetadataById", () => {
        it("should return CloudFile by ID", async () => {
            mockFetch.mockResolvedValueOnce(jsonResponse({
                id: "file-456",
                name: "found.md",
                mimeType: "text/plain",
                modifiedTime: "2026-02-01T00:00:00Z",
                size: "512",
                md5Checksum: "def456",
                trashed: false,
            }));

            const result = await adapter.getFileMetadataById("file-456", "notes/found.md");
            expect(result!.id).toBe("file-456");
            expect(result!.path).toBe("notes/found.md");
        });

        it("should return null for trashed files", async () => {
            mockFetch.mockResolvedValueOnce(jsonResponse({
                id: "file-789",
                trashed: true,
            }));

            const result = await adapter.getFileMetadataById("file-789");
            expect(result).toBeNull();
        });

        it("should return null on error", async () => {
            mockFetch.mockRejectedValueOnce(new Error("404"));
            const result = await adapter.getFileMetadataById("nonexistent");
            expect(result).toBeNull();
        });
    });

    // === downloadFile ===

    describe("downloadFile", () => {
        it("should return file content as ArrayBuffer", async () => {
            const content = new TextEncoder().encode("hello world");
            mockFetch.mockResolvedValueOnce({
                arrayBuffer: () => Promise.resolve(content.buffer),
            });

            const result = await adapter.downloadFile("file-123");
            expect(new TextDecoder().decode(result)).toBe("hello world");
        });
    });

    // === uploadFile ===

    describe("uploadFile", () => {
        it("should PATCH when existingFileId is provided", async () => {
            mockFetch.mockResolvedValueOnce(jsonResponse({
                id: "existing-id",
                md5Checksum: "hash123",
                size: "100",
            }));

            const content = new TextEncoder().encode("data").buffer as ArrayBuffer;
            const result = await adapter.uploadFile("notes/file.md", content, Date.now(), "existing-id");

            expect(mockFetch).toHaveBeenCalledTimes(1);
            const callArgs = mockFetch.mock.calls[0];
            expect(callArgs[0]).toContain("existing-id");
            expect(callArgs[1].method).toBe("PATCH");
            expect(result.id).toBe("existing-id");
        });

        it("should POST for new file (no existingFileId)", async () => {
            // First call: getFileMetadata lookup returns null
            mockFetch.mockResolvedValueOnce(jsonResponse({ files: [] }));
            // Second call: actual upload
            mockFetch.mockResolvedValueOnce(jsonResponse({
                id: "new-id",
                md5Checksum: "newhash",
                size: "50",
            }));

            const content = new TextEncoder().encode("new").buffer as ArrayBuffer;
            const result = await adapter.uploadFile("notes/new.md", content, Date.now());

            expect(result.id).toBe("new-id");
            const uploadCall = mockFetch.mock.calls[1];
            expect(uploadCall[1].method).toBe("POST");
        });
    });

    // === deleteFile ===

    describe("deleteFile", () => {
        it("should call DELETE on the file", async () => {
            mockFetch.mockResolvedValueOnce(jsonResponse(null, 204));

            await adapter.deleteFile("file-to-delete");

            expect(mockFetch).toHaveBeenCalledTimes(1);
            expect(mockFetch.mock.calls[0][0]).toContain("file-to-delete");
            expect(mockFetch.mock.calls[0][1].method).toBe("DELETE");
        });
    });

    // === moveFile ===

    describe("moveFile", () => {
        it("should rename and move file", async () => {
            // First call: get current file metadata
            mockFetch.mockResolvedValueOnce(jsonResponse({
                id: "move-id",
                name: "old.md",
                parents: ["old-parent"],
                modifiedTime: "2026-01-01T00:00:00Z",
                size: "100",
                md5Checksum: "movehash",
            }));
            // Second call: PATCH
            mockFetch.mockResolvedValueOnce(jsonResponse({
                id: "move-id",
                name: "new.md",
                mimeType: "text/plain",
                modifiedTime: "2026-01-01T00:00:00Z",
                size: "100",
                md5Checksum: "movehash",
            }));

            const result = await adapter.moveFile("move-id", "new.md", "target/folder");
            expect(result.id).toBe("move-id");
            expect(result.path).toBe("target/folder/new.md");
        });
    });

    // === fileExistsById ===

    describe("fileExistsById", () => {
        it("should return true for existing file", async () => {
            mockFetch.mockResolvedValueOnce(jsonResponse({ id: "exists", trashed: false }));
            expect(await adapter.fileExistsById("exists")).toBe(true);
        });

        it("should return false for trashed file", async () => {
            mockFetch.mockResolvedValueOnce(jsonResponse({ id: "trashed", trashed: true }));
            expect(await adapter.fileExistsById("trashed")).toBe(false);
        });

        it("should return false on error", async () => {
            mockFetch.mockRejectedValueOnce(new Error("404"));
            expect(await adapter.fileExistsById("gone")).toBe(false);
        });
    });

    // === Changes API ===

    describe("getStartPageToken", () => {
        it("should return start page token", async () => {
            mockFetch.mockResolvedValueOnce(jsonResponse({ startPageToken: "token-42" }));
            const result = await adapter.getStartPageToken();
            expect(result).toBe("token-42");
        });
    });

    describe("getChanges", () => {
        it("should parse changes with files", async () => {
            mockFetch.mockResolvedValueOnce(jsonResponse({
                newStartPageToken: "next-token",
                changes: [{
                    fileId: "change-1",
                    removed: false,
                    file: {
                        id: "change-1",
                        name: "changed.md",
                        mimeType: "text/plain",
                        modifiedTime: "2026-01-01T00:00:00Z",
                        size: "200",
                        md5Checksum: "changehash",
                        parents: ["parent-1"],
                    },
                }],
            }));

            const result = await adapter.getChanges("page-token");
            expect(result.newStartPageToken).toBe("next-token");
            expect(result.changes).toHaveLength(1);
            expect(result.changes[0].file).toBeDefined();
            expect(result.changes[0].file!.hash).toBe("changehash");
        });

        it("should handle removed changes", async () => {
            mockFetch.mockResolvedValueOnce(jsonResponse({
                newStartPageToken: "next",
                changes: [{ fileId: "removed-1", removed: true }],
            }));

            const result = await adapter.getChanges("pt");
            expect(result.changes[0].removed).toBe(true);
            expect(result.changes[0].file).toBeUndefined();
        });

        it("should handle empty changes", async () => {
            mockFetch.mockResolvedValueOnce(jsonResponse({
                newStartPageToken: "same",
                changes: [],
            }));

            const result = await adapter.getChanges("pt");
            expect(result.changes).toHaveLength(0);
        });
    });

    // === Revisions ===

    describe("listRevisions", () => {
        it("should return revision list", async () => {
            // getFileMetadata call
            mockFetch.mockResolvedValueOnce(jsonResponse({
                files: [{ id: "rev-file", name: "doc.md", mimeType: "text/plain", modifiedTime: "2026-01-01T00:00:00Z", size: "100" }],
            }));
            // listRevisions call
            mockFetch.mockResolvedValueOnce(jsonResponse({
                revisions: [
                    { id: "r1", modifiedTime: "2026-01-01T00:00:00Z", size: "50", keepForever: false, md5Checksum: "h1" },
                    { id: "r2", modifiedTime: "2026-01-02T00:00:00Z", size: "60", keepForever: true, md5Checksum: "h2" },
                ],
            }));

            const revisions = await adapter.listRevisions("doc.md");
            expect(revisions).toHaveLength(2);
            expect(revisions[0].id).toBe("r1");
            expect(revisions[1].keepForever).toBe(true);
        });
    });

    describe("deleteRevision", () => {
        it("should call DELETE on revision", async () => {
            mockFetch.mockResolvedValueOnce(jsonResponse({
                files: [{ id: "f1", name: "x.md", mimeType: "text/plain", modifiedTime: "2026-01-01T00:00:00Z", size: "10" }],
            }));
            mockFetch.mockResolvedValueOnce(jsonResponse(null, 204));

            await adapter.deleteRevision("x.md", "rev-id");
            expect(mockFetch).toHaveBeenCalledTimes(2);
            expect(mockFetch.mock.calls[1][1].method).toBe("DELETE");
        });
    });

    // === Clone & Config ===

    describe("cloneWithNewVaultName", () => {
        it("should create a new adapter with same tokens", () => {
            adapter.setLogger(() => {});
            const cloned = adapter.cloneWithNewVaultName("NewVault") as GoogleDriveAdapter;
            expect(cloned.vaultName).toBe("NewVault");
            expect(cloned.auth.accessToken).toBe("mock-access-token");
            expect(cloned.auth.refreshToken).toBe("mock-refresh-token");
        });
    });

    describe("getBaseAdapter", () => {
        it("should return self", () => {
            expect(adapter.getBaseAdapter()).toBe(adapter);
        });
    });

    describe("updateConfig", () => {
        it("should update auth and path resolver", () => {
            adapter.updateConfig("new-id", "new-secret", "NewVault", "NewRoot");
            expect(adapter.clientId).toBe("new-id");
            expect(adapter.clientSecret).toBe("new-secret");
            expect(adapter.vaultName).toBe("NewVault");
        });
    });

    // === Path Validation ===

    describe("validatePath", () => {
        it("should reject paths with ..", async () => {
            mockFetch.mockResolvedValueOnce(jsonResponse({ files: [] }));
            await expect(adapter.listRevisions("../etc/passwd")).rejects.toThrow("Invalid path");
        });

        it("should reject paths with special characters", async () => {
            await expect(adapter.listRevisions("file<name>.md")).rejects.toThrow("Invalid path");
        });
    });

    // === Resumable Upload ===

    describe("initiateResumableSession", () => {
        it("should return session URI from Location header", async () => {
            mockFetch.mockResolvedValueOnce(jsonResponse({ files: [] })); // getFileMetadata
            mockFetch.mockResolvedValueOnce(
                jsonResponse({}, 200, { Location: "https://upload.googleapis.com/session/123" }),
            );

            const uri = await adapter.initiateResumableSession("big.zip", 100_000, Date.now());
            expect(uri).toBe("https://upload.googleapis.com/session/123");
        });

        it("should throw when no Location header", async () => {
            mockFetch.mockResolvedValueOnce(jsonResponse({ files: [] }));
            mockFetch.mockResolvedValueOnce(jsonResponse({}, 200));

            await expect(
                adapter.initiateResumableSession("big.zip", 100_000, Date.now()),
            ).rejects.toThrow("no session URI");
        });
    });

    describe("uploadChunk", () => {
        it("should return null on 308 (resume incomplete)", async () => {
            mockFetch.mockResolvedValueOnce({ status: 308, json: () => Promise.resolve({}) } as any);
            const chunk = new ArrayBuffer(100);
            const result = await adapter.uploadChunk("https://session/1", chunk, 0, 1000, "f.zip", Date.now());
            expect(result).toBeNull();
        });

        it("should return CloudFile on final chunk", async () => {
            mockFetch.mockResolvedValueOnce(jsonResponse({
                id: "final-id",
                md5Checksum: "finalhash",
                size: "1000",
            }));
            const chunk = new ArrayBuffer(100);
            const result = await adapter.uploadChunk("https://session/1", chunk, 900, 1000, "f.zip", Date.now());
            expect(result).not.toBeNull();
            expect(result!.id).toBe("final-id");
        });
    });
});
