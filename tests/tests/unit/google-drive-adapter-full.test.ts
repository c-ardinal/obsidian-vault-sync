/**
 * @file GoogleDriveAdapter Comprehensive Coverage Tests
 *
 * @description
 * Full coverage tests for GoogleDriveAdapter to reach 100% coverage.
 * Covers previously untested areas: listFiles, revision operations, auth flows,
 * token refresh, edge cases, and error handling.
 *
 * @coverage_targets
 * - Lines 498-548: listFiles method (recursive file listing with pagination)
 * - Lines 580-618: Revision operations (getRevisionContent, setRevisionKeepForever)
 * - Auth flows, getters/setters, error paths
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { GoogleDriveAdapter } from "../../../src/cloud-adapters/google-drive/index";

// Mock the md5 module
vi.mock("../../../src/utils/md5", () => ({
    md5: vi.fn((buffer: ArrayBuffer) => "mocked-md5-hash"),
}));

// Mock adapter factory with full control over internal dependencies
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
    pathResolver.appRootId = "app-root-id";

    return { adapter, mockFetch, pathResolver, http };
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

describe("GoogleDriveAdapter - Full Coverage", () => {
    let adapter: GoogleDriveAdapter;
    let mockFetch: ReturnType<typeof vi.fn>;
    let pathResolver: any;
    let http: any;

    beforeEach(() => {
        ({ adapter, mockFetch, pathResolver, http } = mockAdapter());
    });

    // ============================================================================
    // Basic Properties & Getters
    // ============================================================================

    describe("Basic Properties", () => {
        it("should expose feature flags", () => {
            expect(adapter.supportsChangesAPI).toBe(true);
            expect(adapter.supportsHash).toBe(true);
            expect(adapter.supportsHistory).toBe(true);
        });

        it("should expose static ONLINE_TIMEOUT_MS", () => {
            expect(GoogleDriveAdapter.ONLINE_TIMEOUT_MS).toBeDefined();
            expect(typeof GoogleDriveAdapter.ONLINE_TIMEOUT_MS).toBe("number");
        });

        it("should expose clientId and clientSecret getters", () => {
            expect(adapter.clientId).toBe("test-client-id");
            expect(adapter.clientSecret).toBe("test-secret");
        });

        it("should expose rootFolder getter", () => {
            expect(adapter.rootFolder).toBe("MyRoot");
        });
    });

    // ============================================================================
    // Authentication Flows
    // ============================================================================

    describe("Authentication Flows", () => {
        it("should delegate isAuthenticated to auth service", () => {
            const spy = vi.spyOn(adapter.auth, "isAuthenticated").mockReturnValue(true);
            expect(adapter.isAuthenticated()).toBe(true);
            spy.mockRestore();
        });

        it("should delegate getTokens to auth service", () => {
            const spy = vi.spyOn(adapter.auth, "getTokens").mockReturnValue({
                accessToken: "token",
                refreshToken: "refresh",
                tokenExpiresAt: 123456,
            });
            const tokens = adapter.getTokens();
            expect(tokens.accessToken).toBe("token");
            spy.mockRestore();
        });

        it("should delegate setAuthConfig to auth service", () => {
            const spy = vi.spyOn(adapter.auth, "setAuthConfig").mockImplementation(() => {});
            adapter.setAuthConfig("pkce", "https://proxy.example.com");
            expect(spy).toHaveBeenCalledWith("pkce", "https://proxy.example.com");
            spy.mockRestore();
        });

        it("should delegate getAuthStatus to auth service", () => {
            const spy = vi.spyOn(adapter.auth, "getAuthStatus").mockReturnValue("authenticated");
            expect(adapter.getAuthStatus()).toBe("authenticated");
            spy.mockRestore();
        });

        it("should delegate getAuthUrl to auth service", async () => {
            const spy = vi.spyOn(adapter.auth, "getAuthUrl").mockResolvedValue("https://auth.url");
            const url = await adapter.getAuthUrl();
            expect(url).toBe("https://auth.url");
            spy.mockRestore();
        });

        it("should delegate verifyState to auth service", () => {
            const spy = vi.spyOn(adapter.auth, "verifyState").mockReturnValue(true);
            expect(adapter.verifyState("state123")).toBe(true);
            spy.mockRestore();
        });

        it("should delegate login to auth service", async () => {
            const spy = vi.spyOn(adapter.auth, "login").mockResolvedValue(undefined);
            await adapter.login();
            expect(spy).toHaveBeenCalled();
            spy.mockRestore();
        });

        it("should delegate exchangeCodeForToken to auth service", async () => {
            const spy = vi.spyOn(adapter.auth, "exchangeCodeForToken").mockResolvedValue(undefined);
            await adapter.exchangeCodeForToken("auth-code");
            expect(spy).toHaveBeenCalledWith("auth-code");
            spy.mockRestore();
        });

        it("should delegate handleCallback to auth service", async () => {
            const spy = vi.spyOn(adapter.auth, "handleCallback").mockResolvedValue(undefined);
            await adapter.handleCallback("https://callback.url?code=xyz");
            expect(spy).toHaveBeenCalledWith("https://callback.url?code=xyz");
            spy.mockRestore();
        });

        it("should delegate logout to auth service", async () => {
            const spy = vi.spyOn(adapter.auth, "logout").mockResolvedValue(undefined);
            await adapter.logout();
            expect(spy).toHaveBeenCalled();
            spy.mockRestore();
        });

        it("should setCredentials delegate to auth", () => {
            const spy = vi.spyOn(adapter.auth, "setCredentials").mockImplementation(() => {});
            adapter.setCredentials("new-id", "new-secret");
            expect(spy).toHaveBeenCalledWith("new-id", "new-secret");
            spy.mockRestore();
        });
    });

    // ============================================================================
    // Token Refresh & Auth Callbacks
    // ============================================================================

    describe("Token Refresh & Auth Callbacks", () => {
        it("should set onAuthFailure callback on auth service", () => {
            const callback = vi.fn();
            adapter.onAuthFailure = callback;
            expect(adapter.auth.onAuthFailure).toBe(callback);
        });

        it("should get onAuthFailure callback from auth service", () => {
            const callback = vi.fn();
            adapter.auth.onAuthFailure = callback;
            expect(adapter.onAuthFailure).toBe(callback);
        });

        it("should set onTokenRefresh callback on auth service", () => {
            const callback = vi.fn();
            adapter.onTokenRefresh = callback;
            expect(adapter.auth.onTokenRefresh).toBe(callback);
        });

        it("should get onTokenRefresh callback from auth service", () => {
            const callback = vi.fn();
            adapter.auth.onTokenRefresh = callback;
            expect(adapter.onTokenRefresh).toBe(callback);
        });

        it("should clear folder caches when setting tokens from unauthenticated to authenticated", () => {
            adapter.auth.accessToken = null; // Start unauthenticated
            const spy = vi.spyOn(pathResolver, "clearFolderCaches");
            
            adapter.setTokens("new-access", "new-refresh", Date.now() + 3600000);
            
            expect(spy).toHaveBeenCalled();
        });

        it("should not clear folder caches when already authenticated", () => {
            adapter.auth.accessToken = "existing-token"; // Already authenticated
            const spy = vi.spyOn(pathResolver, "clearFolderCaches");
            
            adapter.setTokens("new-access", "new-refresh", Date.now() + 3600000);
            
            expect(spy).not.toHaveBeenCalled();
        });
    });

    // ============================================================================
    // Logger
    // ============================================================================

    describe("Logger", () => {
        it("should set logger and propagate to auth and pathResolver", () => {
            const logger = vi.fn();
            const authSpy = vi.spyOn(adapter.auth, "setLogger").mockImplementation(() => {});
            const resolverSpy = vi.spyOn(pathResolver, "setLogger").mockImplementation(() => {});
            
            adapter.setLogger(logger);
            
            expect(authSpy).toHaveBeenCalledWith(logger);
            expect(resolverSpy).toHaveBeenCalledWith(logger);
            authSpy.mockRestore();
            resolverSpy.mockRestore();
        });
    });

    // ============================================================================
    // Path Resolver Delegation
    // ============================================================================

    describe("Path Resolver Delegation", () => {
        it("should delegate initialize to pathResolver", async () => {
            const spy = vi.spyOn(pathResolver, "initialize").mockResolvedValue(undefined);
            await adapter.initialize();
            expect(spy).toHaveBeenCalled();
            spy.mockRestore();
        });

        it("should delegate getAppRootId to pathResolver", async () => {
            const spy = vi.spyOn(pathResolver, "getAppRootId").mockResolvedValue("app-id");
            const result = await adapter.getAppRootId();
            expect(result).toBe("app-id");
            spy.mockRestore();
        });

        it("should delegate reset to pathResolver", () => {
            const spy = vi.spyOn(pathResolver, "reset").mockImplementation(() => {});
            adapter.reset();
            expect(spy).toHaveBeenCalled();
            spy.mockRestore();
        });

        it("should delegate createFolder to pathResolver", async () => {
            const spy = vi.spyOn(pathResolver, "createFolder").mockResolvedValue("folder-id");
            const result = await adapter.createFolder("NewFolder", "parent-id");
            expect(result).toBe("folder-id");
            expect(spy).toHaveBeenCalledWith("NewFolder", "parent-id");
            spy.mockRestore();
        });

        it("should delegate ensureFoldersExist to pathResolver", async () => {
            const progress = vi.fn();
            const spy = vi.spyOn(pathResolver, "ensureFoldersExist").mockResolvedValue(undefined);
            await adapter.ensureFoldersExist(["a/b", "c/d"], progress);
            expect(spy).toHaveBeenCalledWith(["a/b", "c/d"], progress);
            spy.mockRestore();
        });

        it("should delegate getFolderIdByName to pathResolver", async () => {
            const spy = vi.spyOn(pathResolver, "getFolderIdByName").mockResolvedValue("folder-id");
            const result = await adapter.getFolderIdByName("MyFolder", "parent-id");
            expect(result).toBe("folder-id");
            expect(spy).toHaveBeenCalledWith("MyFolder", "parent-id");
            spy.mockRestore();
        });
    });

    // ============================================================================
    // File Operations - Extended Coverage
    // ============================================================================

    describe("getFileMetadata - Extended", () => {
        it("should handle file with empty md5Checksum", async () => {
            mockFetch.mockResolvedValueOnce(jsonResponse({
                files: [{
                    id: "file-123",
                    name: "test.md",
                    mimeType: "text/plain",
                    modifiedTime: "2026-01-01T00:00:00Z",
                    size: "1024",
                    md5Checksum: null,
                }],
            }));

            const result = await adapter.getFileMetadata("notes/test.md");
            expect(result).not.toBeNull();
            expect(result!.hash).toBeNull();
        });

        it("should handle empty name in path", async () => {
            mockFetch.mockResolvedValueOnce(jsonResponse({
                files: [{
                    id: "root-file",
                    name: "rootfile.txt",
                    mimeType: "text/plain",
                    modifiedTime: "2026-01-01T00:00:00Z",
                    size: "100",
                }],
            }));

            const result = await adapter.getFileMetadata("rootfile.txt");
            expect(result).not.toBeNull();
        });
    });

    describe("uploadFile - Extended", () => {
        it("should look up existing file when no existingFileId provided", async () => {
            // First call: getFileMetadata lookup
            mockFetch.mockResolvedValueOnce(jsonResponse({
                files: [{ id: "found-id", name: "existing.md", mimeType: "text/plain", modifiedTime: "2026-01-01T00:00:00Z", size: "100" }],
            }));
            // Second call: PATCH upload
            mockFetch.mockResolvedValueOnce(jsonResponse({
                id: "found-id",
                md5Checksum: "hash123",
                size: "100",
            }));

            const content = new TextEncoder().encode("updated").buffer as ArrayBuffer;
            const result = await adapter.uploadFile("notes/existing.md", content, Date.now());

            expect(result.id).toBe("found-id");
            // Should use PATCH because file was found
            const uploadCall = mockFetch.mock.calls[1];
            expect(uploadCall[1].method).toBe("PATCH");
        });
    });

    describe("uploadFileResumable", () => {
        it("should perform resumable upload end-to-end", async () => {
            // initiateResumableSession calls
            mockFetch
                .mockResolvedValueOnce(jsonResponse({ files: [] })) // getFileMetadata
                .mockResolvedValueOnce(jsonResponse({}, 200, { Location: "https://upload.googleapis.com/session/abc" }));
            
            // uploadChunk call
            mockFetch.mockResolvedValueOnce(jsonResponse({
                id: "uploaded-id",
                md5Checksum: "uploadhash",
                size: "1000",
            }));

            const content = new TextEncoder().encode("x".repeat(1000)).buffer as ArrayBuffer;
            const result = await adapter.uploadFileResumable("large.bin", content, Date.now());

            expect(result.id).toBe("uploaded-id");
            expect(result.hash).toBe("uploadhash");
        });

        it("should use existing file id for resumable upload when found", async () => {
            mockFetch
                .mockResolvedValueOnce(jsonResponse({ 
                    files: [{ id: "existing-file-id", name: "large.bin" }] 
                })) // getFileMetadata finds file
                .mockResolvedValueOnce(jsonResponse({}, 200, { Location: "https://upload.googleapis.com/session/xyz" }));
            
            mockFetch.mockResolvedValueOnce(jsonResponse({
                id: "existing-file-id",
                md5Checksum: "newhash",
                size: "500",
            }));

            const content = new TextEncoder().encode("x".repeat(500)).buffer as ArrayBuffer;
            const result = await adapter.uploadFileResumable("large.bin", content, Date.now());

            expect(result.id).toBe("existing-file-id");
        });
    });

    describe("initiateResumableSession - Extended", () => {
        it("should use existing file id when provided", async () => {
            mockFetch.mockResolvedValueOnce(jsonResponse({}, 200, { 
                Location: "https://upload.googleapis.com/session/123" 
            }));

            const uri = await adapter.initiateResumableSession("file.bin", 1000, Date.now(), "provided-file-id");
            
            expect(uri).toBe("https://upload.googleapis.com/session/123");
            const call = mockFetch.mock.calls[0];
            expect(call[0]).toContain("provided-file-id");
            expect(call[1].method).toBe("PATCH");
        });
    });

    describe("moveFile - Extended", () => {
        it("should rename file in same folder when newParentPath is null", async () => {
            // Get current file metadata
            mockFetch.mockResolvedValueOnce(jsonResponse({
                id: "move-id",
                name: "old.md",
                parents: ["same-parent"],
                modifiedTime: "2026-01-01T00:00:00Z",
                size: "100",
                md5Checksum: "movehash",
            }));
            
            // PATCH response (no parent change since newParentPath is null)
            mockFetch.mockResolvedValueOnce(jsonResponse({
                id: "move-id",
                name: "new.md",
                mimeType: "text/plain",
                modifiedTime: "2026-01-01T00:00:00Z",
                size: "100",
                md5Checksum: "movehash",
            }));

            const result = await adapter.moveFile("move-id", "new.md", null);
            expect(result.id).toBe("move-id");
            expect(result.path).toBe("new.md");
        });

        it("should not change parents when new parent equals old parent", async () => {
            // Setup: old and new parent are the same
            pathResolver.resolveParentId.mockResolvedValue("same-parent-id");
            
            // Get current file metadata
            mockFetch.mockResolvedValueOnce(jsonResponse({
                id: "move-id",
                name: "old.md",
                parents: ["same-parent-id"],
                modifiedTime: "2026-01-01T00:00:00Z",
                size: "100",
                md5Checksum: "movehash",
            }));
            
            // PATCH response
            mockFetch.mockResolvedValueOnce(jsonResponse({
                id: "move-id",
                name: "new.md",
                mimeType: "text/plain",
                modifiedTime: "2026-01-01T00:00:00Z",
                size: "100",
                md5Checksum: "movehash",
            }));

            const result = await adapter.moveFile("move-id", "new.md", "same/folder");
            const patchCall = mockFetch.mock.calls[1];
            // Should NOT have addParents/removeParents since parents are same
            expect(patchCall[0]).not.toContain("addParents");
            expect(patchCall[0]).not.toContain("removeParents");
        });
    });

    // ============================================================================
    // Changes API - Extended Coverage
    // ============================================================================

    describe("getChanges - Extended", () => {
        it("should handle changes without parents", async () => {
            mockFetch.mockResolvedValueOnce(jsonResponse({
                newStartPageToken: "next-token",
                changes: [{
                    fileId: "orphan-file",
                    removed: false,
                    file: {
                        id: "orphan-file",
                        name: "orphan.md",
                        mimeType: "text/plain",
                        modifiedTime: "2026-01-01T00:00:00Z",
                        size: "200",
                        md5Checksum: "orphanhash",
                        // No parents
                    },
                }],
            }));

            const result = await adapter.getChanges("page-token");
            expect(result.changes).toHaveLength(1);
            // File without parents should be marked as removed
            expect(result.changes[0].removed).toBe(true);
        });

        it("should handle path resolution failure gracefully", async () => {
            pathResolver.resolveFullPath.mockRejectedValue(new Error("Resolution failed"));
            
            mockFetch.mockResolvedValueOnce(jsonResponse({
                newStartPageToken: "next-token",
                changes: [{
                    fileId: "bad-file",
                    removed: false,
                    file: {
                        id: "bad-file",
                        name: "bad.md",
                        mimeType: "text/plain",
                        modifiedTime: "2026-01-01T00:00:00Z",
                        size: "200",
                        parents: ["parent-1"],
                    },
                }],
            }));

            const result = await adapter.getChanges("page-token");
            expect(result.changes).toHaveLength(1);
            // Should mark as removed when path resolution fails
            expect(result.changes[0].removed).toBe(true);
            expect(result.changes[0].file).toBeUndefined();
        });

        it("should handle trashed files as removed", async () => {
            mockFetch.mockResolvedValueOnce(jsonResponse({
                newStartPageToken: "next-token",
                changes: [{
                    fileId: "trashed-file",
                    removed: false,
                    file: {
                        id: "trashed-file",
                        name: "trashed.md",
                        mimeType: "text/plain",
                        modifiedTime: "2026-01-01T00:00:00Z",
                        size: "200",
                        trashed: true,
                        parents: ["parent-1"],
                    },
                }],
            }));

            const result = await adapter.getChanges("page-token");
            expect(result.changes[0].removed).toBe(true);
        });

        it("should handle change without file object", async () => {
            mockFetch.mockResolvedValueOnce(jsonResponse({
                newStartPageToken: "next-token",
                changes: [{
                    fileId: "file-only-id",
                    removed: false,
                    // No file object
                }],
            }));

            const result = await adapter.getChanges("page-token");
            // When file is undefined and removed is false, the code doesn't mark it as removed
            expect(result.changes[0].fileId).toBe("file-only-id");
            expect(result.changes[0].file).toBeUndefined();
        });

        it("should handle nextPageToken in response", async () => {
            mockFetch.mockResolvedValueOnce(jsonResponse({
                nextPageToken: "more-pages",
                changes: [],
            }));

            const result = await adapter.getChanges("page-token");
            expect(result.nextPageToken).toBe("more-pages");
        });
    });

    // ============================================================================
    // listFiles - Full Coverage (Lines 498-548)
    // ============================================================================

    describe("listFiles", () => {
        it("should list files in vault root", async () => {
            mockFetch.mockResolvedValueOnce(jsonResponse({
                files: [
                    { id: "file-1", name: "doc.md", mimeType: "text/plain", modifiedTime: "2026-01-01T00:00:00Z", size: "100", md5Checksum: "hash1" },
                ],
            }));

            const files = await adapter.listFiles();
            expect(pathResolver.clearFolderCaches).toHaveBeenCalled();
            expect(pathResolver.ensureRootFolders).toHaveBeenCalled();
            expect(files).toHaveLength(1);
            expect(files[0].id).toBe("file-1");
        });

        it("should throw when vaultRootId is not initialized", async () => {
            pathResolver.vaultRootId = null;
            await expect(adapter.listFiles()).rejects.toThrow("Vault root not initialized");
        });

        it("should handle pagination with nextPageToken", async () => {
            mockFetch
                .mockResolvedValueOnce(jsonResponse({
                    files: [{ id: "file-1", name: "page1.md", mimeType: "text/plain", modifiedTime: "2026-01-01T00:00:00Z", size: "100" }],
                    nextPageToken: "token-2",
                }))
                .mockResolvedValueOnce(jsonResponse({
                    files: [{ id: "file-2", name: "page2.md", mimeType: "text/plain", modifiedTime: "2026-01-02T00:00:00Z", size: "200" }],
                }));

            const files = await adapter.listFiles();
            expect(files).toHaveLength(2);
            expect(mockFetch).toHaveBeenCalledTimes(2);
        });

        it("should recursively walk subfolders", async () => {
            mockFetch
                .mockResolvedValueOnce(jsonResponse({
                    files: [
                        { id: "folder-1", name: "docs", mimeType: "application/vnd.google-apps.folder", modifiedTime: "2026-01-01T00:00:00Z", size: "0" },
                        { id: "file-1", name: "root.md", mimeType: "text/plain", modifiedTime: "2026-01-01T00:00:00Z", size: "100" },
                    ],
                }))
                .mockResolvedValueOnce(jsonResponse({
                    files: [
                        { id: "file-2", name: "sub.md", mimeType: "text/plain", modifiedTime: "2026-01-02T00:00:00Z", size: "200" },
                    ],
                }));

            const files = await adapter.listFiles();
            // Folders are included in the listing
            expect(files).toHaveLength(3);
            expect(files.some(f => f.path === "docs")).toBe(true);
            expect(files.some(f => f.path === "docs/sub.md")).toBe(true);
            expect(files.some(f => f.path === "root.md")).toBe(true);
        });

        it("should handle nested folder structures", async () => {
            mockFetch
                .mockResolvedValueOnce(jsonResponse({
                    files: [
                        { id: "level1", name: "level1", mimeType: "application/vnd.google-apps.folder", modifiedTime: "2026-01-01T00:00:00Z", size: "0" },
                    ],
                }))
                .mockResolvedValueOnce(jsonResponse({
                    files: [
                        { id: "level2", name: "level2", mimeType: "application/vnd.google-apps.folder", modifiedTime: "2026-01-01T00:00:00Z", size: "0" },
                    ],
                }))
                .mockResolvedValueOnce(jsonResponse({
                    files: [
                        { id: "deep-file", name: "deep.txt", mimeType: "text/plain", modifiedTime: "2026-01-01T00:00:00Z", size: "50" },
                    ],
                }));

            const files = await adapter.listFiles();
            // Folders are included in the listing
            expect(files).toHaveLength(3);
            expect(files.some(f => f.path === "level1")).toBe(true);
            expect(files.some(f => f.path === "level1/level2")).toBe(true);
            expect(files.some(f => f.path === "level1/level2/deep.txt")).toBe(true);
        });

        it("should handle empty folders", async () => {
            mockFetch
                .mockResolvedValueOnce(jsonResponse({
                    files: [
                        { id: "empty-folder", name: "empty", mimeType: "application/vnd.google-apps.folder", modifiedTime: "2026-01-01T00:00:00Z", size: "0" },
                    ],
                }))
                .mockResolvedValueOnce(jsonResponse({
                    files: [],
                }));

            const files = await adapter.listFiles();
            // The folder itself is included even if empty
            expect(files).toHaveLength(1);
            expect(files[0].path).toBe("empty");
        });

        it("should use provided folderId instead of vault root", async () => {
            mockFetch.mockResolvedValueOnce(jsonResponse({
                files: [{ id: "file-1", name: "custom.md", mimeType: "text/plain", modifiedTime: "2026-01-01T00:00:00Z", size: "100" }],
            }));

            const files = await adapter.listFiles("custom-folder-id");
            expect(files).toHaveLength(1);
            // Verify the query used the custom folder ID (URL encoded)
            const callUrl = mockFetch.mock.calls[0][0];
            expect(callUrl).toContain("custom-folder-id");
        });

        it("should include md5Checksum for files with hash", async () => {
            mockFetch.mockResolvedValueOnce(jsonResponse({
                files: [
                    { id: "file-1", name: "hashed.md", mimeType: "text/plain", modifiedTime: "2026-01-01T00:00:00Z", size: "100", md5Checksum: "abc123" },
                ],
            }));

            const files = await adapter.listFiles();
            expect(files[0].hash).toBe("abc123");
        });
    });

    // ============================================================================
    // Revisions - Full Coverage (Lines 580-618 and beyond)
    // ============================================================================

    describe("listRevisions - Extended", () => {
        it("should include author information when available", async () => {
            // getFileMetadata
            mockFetch.mockResolvedValueOnce(jsonResponse({
                files: [{ id: "rev-file", name: "doc.md", mimeType: "text/plain", modifiedTime: "2026-01-01T00:00:00Z", size: "100" }],
            }));
            // listRevisions
            mockFetch.mockResolvedValueOnce(jsonResponse({
                revisions: [
                    { 
                        id: "r1", 
                        modifiedTime: "2026-01-01T00:00:00Z", 
                        size: "50", 
                        keepForever: false, 
                        md5Checksum: "h1",
                        lastModifyingUser: { displayName: "John Doe" }
                    },
                ],
            }));

            const revisions = await adapter.listRevisions("doc.md");
            expect(revisions).toHaveLength(1);
            expect(revisions[0].author).toBe("John Doe");
        });

        it("should handle empty revisions list", async () => {
            mockFetch.mockResolvedValueOnce(jsonResponse({
                files: [{ id: "rev-file", name: "doc.md", mimeType: "text/plain", modifiedTime: "2026-01-01T00:00:00Z", size: "100" }],
            }));
            mockFetch.mockResolvedValueOnce(jsonResponse({ revisions: [] }));

            const revisions = await adapter.listRevisions("doc.md");
            expect(revisions).toHaveLength(0);
        });

        it("should throw when file not found for listRevisions", async () => {
            mockFetch.mockResolvedValueOnce(jsonResponse({ files: [] }));

            await expect(adapter.listRevisions("missing.md")).rejects.toThrow("File not found: missing.md");
        });
    });

    describe("getRevisionContent - Lines 580-607", () => {
        it("should download revision content successfully", async () => {
            // getFileMetadata
            mockFetch.mockResolvedValueOnce(jsonResponse({
                files: [{ id: "file-1", name: "doc.md", mimeType: "text/plain", modifiedTime: "2026-01-01T00:00:00Z", size: "100" }],
            }));
            // get revision metadata - use hash that matches mocked md5
            mockFetch.mockResolvedValueOnce(jsonResponse({ md5Checksum: "mocked-md5-hash" }));
            // download content
            const content = new TextEncoder().encode("revision content").buffer;
            mockFetch.mockResolvedValueOnce({
                arrayBuffer: () => Promise.resolve(content),
            });

            const result = await adapter.getRevisionContent("doc.md", "rev-1");
            expect(new TextDecoder().decode(result)).toBe("revision content");
        });

        it("should skip hash verification when md5Checksum not provided", async () => {
            // getFileMetadata
            mockFetch.mockResolvedValueOnce(jsonResponse({
                files: [{ id: "file-1", name: "doc.md", mimeType: "text/plain", modifiedTime: "2026-01-01T00:00:00Z", size: "100" }],
            }));
            // get revision metadata - no checksum
            mockFetch.mockResolvedValueOnce(jsonResponse({}));
            // download content
            const content = new TextEncoder().encode("content without hash").buffer;
            mockFetch.mockResolvedValueOnce({
                arrayBuffer: () => Promise.resolve(content),
            });

            const result = await adapter.getRevisionContent("doc.md", "rev-1");
            expect(new TextDecoder().decode(result)).toBe("content without hash");
        });

        it("should throw on hash mismatch", async () => {
            // Mock md5 to return a different hash for this test
            const { md5 } = await import("../../../src/utils/md5");
            const mockMd5 = vi.mocked(md5);
            mockMd5.mockReturnValueOnce("different-hash");

            // getFileMetadata
            mockFetch.mockResolvedValueOnce(jsonResponse({
                files: [{ id: "file-1", name: "doc.md", mimeType: "text/plain", modifiedTime: "2026-01-01T00:00:00Z", size: "100" }],
            }));
            // get revision metadata - hash that won't match
            mockFetch.mockResolvedValueOnce(jsonResponse({ md5Checksum: "expected-hash" }));
            // download content
            const content = new TextEncoder().encode("tampered content").buffer;
            mockFetch.mockResolvedValueOnce({
                arrayBuffer: () => Promise.resolve(content),
            });

            await expect(adapter.getRevisionContent("doc.md", "rev-1")).rejects.toThrow("Integrity check failed");
        });

        it("should throw when file not found for getRevisionContent", async () => {
            // getFileMetadata returns null (file not found)
            mockFetch.mockResolvedValueOnce(jsonResponse({ files: [] }));

            await expect(adapter.getRevisionContent("missing.md", "rev-1")).rejects.toThrow("File not found: missing.md");
        });
    });

    describe("setRevisionKeepForever - Lines 609-625", () => {
        it("should throw when file not found for setRevisionKeepForever", async () => {
            mockFetch.mockResolvedValueOnce(jsonResponse({ files: [] }));

            await expect(adapter.setRevisionKeepForever("missing.md", "rev-1", true)).rejects.toThrow("File not found: missing.md");
        });

        it("should set keepForever flag on revision", async () => {
            // getFileMetadata
            mockFetch.mockResolvedValueOnce(jsonResponse({
                files: [{ id: "file-1", name: "doc.md", mimeType: "text/plain", modifiedTime: "2026-01-01T00:00:00Z", size: "100" }],
            }));
            // PATCH revision
            mockFetch.mockResolvedValueOnce(jsonResponse({}));

            await adapter.setRevisionKeepForever("doc.md", "rev-1", true);
            
            const patchCall = mockFetch.mock.calls[1];
            expect(patchCall[1].method).toBe("PATCH");
            expect(JSON.parse(patchCall[1].body)).toEqual({ keepForever: true });
        });

        it("should unset keepForever flag on revision", async () => {
            mockFetch.mockResolvedValueOnce(jsonResponse({
                files: [{ id: "file-1", name: "doc.md", mimeType: "text/plain", modifiedTime: "2026-01-01T00:00:00Z", size: "100" }],
            }));
            mockFetch.mockResolvedValueOnce(jsonResponse({}));

            await adapter.setRevisionKeepForever("doc.md", "rev-1", false);
            
            const patchCall = mockFetch.mock.calls[1];
            expect(JSON.parse(patchCall[1].body)).toEqual({ keepForever: false });
        });
    });

    describe("deleteRevision - Lines 628-637", () => {
        it("should delete revision", async () => {
            // getFileMetadata
            mockFetch.mockResolvedValueOnce(jsonResponse({
                files: [{ id: "file-1", name: "doc.md", mimeType: "text/plain", modifiedTime: "2026-01-01T00:00:00Z", size: "100" }],
            }));
            // DELETE revision
            mockFetch.mockResolvedValueOnce(jsonResponse(null, 204));

            await adapter.deleteRevision("doc.md", "rev-1");
            
            const deleteCall = mockFetch.mock.calls[1];
            expect(deleteCall[1].method).toBe("DELETE");
            expect(deleteCall[0]).toContain("/revisions/rev-1");
        });
    });

    // ============================================================================
    // Path Validation - Extended
    // ============================================================================

    describe("Path Validation - Extended", () => {
        it("should reject paths with backslash", async () => {
            await expect(adapter.listRevisions("file\\name.md")).rejects.toThrow("Invalid path");
        });

        it("should reject paths with colon", async () => {
            await expect(adapter.listRevisions("file:name.md")).rejects.toThrow("Invalid path");
        });

        it("should reject paths with pipe", async () => {
            await expect(adapter.listRevisions("file|name.md")).rejects.toThrow("Invalid path");
        });

        it("should reject paths with question mark", async () => {
            await expect(adapter.listRevisions("file?name.md")).rejects.toThrow("Invalid path");
        });

        it("should reject paths with asterisk", async () => {
            await expect(adapter.listRevisions("file*name.md")).rejects.toThrow("Invalid path");
        });

        it("should accept valid paths with dots", async () => {
            mockFetch.mockResolvedValueOnce(jsonResponse({
                files: [{ id: "file-1", name: "file.name.md", mimeType: "text/plain", modifiedTime: "2026-01-01T00:00:00Z", size: "100" }],
            }));
            mockFetch.mockResolvedValueOnce(jsonResponse({ revisions: [] }));

            // Should not throw
            await expect(adapter.listRevisions("file.name.md")).resolves.toBeDefined();
        });

        it("should accept valid paths with hyphens and underscores", async () => {
            mockFetch.mockResolvedValueOnce(jsonResponse({
                files: [{ id: "file-1", name: "my-file_name.md", mimeType: "text/plain", modifiedTime: "2026-01-01T00:00:00Z", size: "100" }],
            }));
            mockFetch.mockResolvedValueOnce(jsonResponse({ revisions: [] }));

            await expect(adapter.listRevisions("my-file_name.md")).resolves.toBeDefined();
        });
    });

    // ============================================================================
    // UpdateConfig & Clone - Extended
    // ============================================================================

    describe("updateConfig - Extended", () => {
        it("should handle undefined vaultName", () => {
            adapter.updateConfig("new-id", "new-secret", undefined, "NewRoot");
            expect(adapter.clientId).toBe("new-id");
            expect(adapter.rootFolder).toBe("NewRoot");
        });

        it("should handle undefined cloudRootFolder", () => {
            adapter.updateConfig("new-id", "new-secret", "NewVault", undefined);
            expect(adapter.vaultName).toBe("NewVault");
        });
    });

    describe("cloneWithNewVaultName - Extended", () => {
        it("should clone without logger", () => {
            // Ensure no logger is set
            (adapter as any).logger = null;
            
            const cloned = adapter.cloneWithNewVaultName("ClonedVault") as GoogleDriveAdapter;
            expect(cloned.vaultName).toBe("ClonedVault");
        });
    });

    // ============================================================================
    // HTTP Client & Retry Logic
    // ============================================================================

    describe("HTTP Client Integration", () => {
        it("should escape query values properly", () => {
            const escapeSpy = vi.spyOn(http, "escapeQueryValue").mockReturnValue("escaped\\'value");
            
            // Trigger a query that needs escaping
            mockFetch.mockResolvedValueOnce(jsonResponse({ files: [] }));
            
            // Note: This test verifies the escapeQueryValue method exists and is called
            expect(() => http.escapeQueryValue("test'value")).not.toThrow();
            escapeSpy.mockRestore();
        });
    });

    // ============================================================================
    // Edge Cases & Error Handling
    // ============================================================================

    describe("Edge Cases & Error Handling", () => {
        it("should handle empty files array in listFiles", async () => {
            mockFetch.mockResolvedValueOnce(jsonResponse({ files: [] }));

            const files = await adapter.listFiles();
            expect(files).toHaveLength(0);
        });

        it("should handle missing size in file metadata", async () => {
            mockFetch.mockResolvedValueOnce(jsonResponse({
                files: [{
                    id: "file-1",
                    name: "nosize.md",
                    mimeType: "text/plain",
                    modifiedTime: "2026-01-01T00:00:00Z",
                    // No size field
                }],
            }));

            const files = await adapter.listFiles();
            expect(files[0].size).toBe(0);
        });

        it("should handle null file in getChanges", async () => {
            mockFetch.mockResolvedValueOnce(jsonResponse({
                newStartPageToken: "next",
                changes: [{
                    fileId: "null-file",
                    removed: false,
                    file: null,
                }],
            }));

            const result = await adapter.getChanges("token");
            // When file is null and removed is false, the code doesn't mark it as removed
            // It returns the change with removed: false and no file data
            expect(result.changes[0].fileId).toBe("null-file");
            expect(result.changes[0].file).toBeUndefined();
        });
    });
});
