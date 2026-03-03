/**
 * @file DrivePathResolver ユニットテスト
 *
 * @description
 * DrivePathResolver のフォルダ解決・キャッシュ・ルート探索ロジックを
 * http.fetchWithAuth をモックしてテストする。
 *
 * @pass_criteria
 * - validateRootFolder: 不正入力→デフォルト値、正常入力→そのまま
 * - ensureRootFolders: 既存→再利用、未存在→新規作成、グローバル検索→採用+移動
 * - resolveParentId: 階層フォルダ解決、キャッシュ利用、create=false→エラー
 * - resolveFullPath: vaultRoot到達まで辿る、キャッシュ、範囲外→エラー
 * - createFolder: parentId有無でbody変化
 * - ensureFoldersExist: 複数階層を並列作成
 * - getFolderIdByName: 存在→id、未存在→null
 * - updateConfig: 変更時キャッシュクリア、同値→維持
 * - reset / clearFolderCaches: 状態クリア
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { DrivePathResolver } from "../../../src/cloud-adapters/google-drive/path-resolver";

function createMockHttp() {
    return {
        fetchWithAuth: vi.fn(),
        escapeQueryValue: (v: string) => v.replace(/\\/g, "\\\\").replace(/'/g, "\\'"),
    };
}

function jsonResponse(data: any, status = 200): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve(data),
    } as any;
}

describe("DrivePathResolver", () => {
    let http: ReturnType<typeof createMockHttp>;
    let resolver: DrivePathResolver;

    beforeEach(() => {
        http = createMockHttp();
        resolver = new DrivePathResolver(http as any, "TestVault", "ObsidianVaultSync");
    });

    describe("validateRootFolder", () => {
        it("should return default for empty string", () => {
            const r = new DrivePathResolver(http as any, "V", "");
            expect(r.rootFolder).toBe("ObsidianVaultSync");
        });

        it("should return default for whitespace-only", () => {
            const r = new DrivePathResolver(http as any, "V", "   ");
            expect(r.rootFolder).toBe("ObsidianVaultSync");
        });

        it("should return default for path starting with /", () => {
            const r = new DrivePathResolver(http as any, "V", "/foo");
            expect(r.rootFolder).toBe("ObsidianVaultSync");
        });

        it("should return default for path with backslash", () => {
            const r = new DrivePathResolver(http as any, "V", "foo\\bar");
            expect(r.rootFolder).toBe("ObsidianVaultSync");
        });

        it("should return default for name exceeding 255 chars", () => {
            const r = new DrivePathResolver(http as any, "V", "a".repeat(256));
            expect(r.rootFolder).toBe("ObsidianVaultSync");
        });

        it("should return default for name with illegal characters", () => {
            const r = new DrivePathResolver(http as any, "V", 'bad<name');
            expect(r.rootFolder).toBe("ObsidianVaultSync");
        });

        it("should accept valid folder name", () => {
            const r = new DrivePathResolver(http as any, "V", "MyCustomRoot");
            expect(r.rootFolder).toBe("MyCustomRoot");
        });

        it("should trim whitespace from valid name", () => {
            const r = new DrivePathResolver(http as any, "V", "  CustomRoot  ");
            expect(r.rootFolder).toBe("CustomRoot");
        });
    });

    describe("ensureRootFolders", () => {
        it("should find existing app root and vault root", async () => {
            // First call: search app root
            http.fetchWithAuth
                .mockResolvedValueOnce(jsonResponse({ files: [{ id: "app-root-1", name: "ObsidianVaultSync" }] }))
                // Second call: search vault folder
                .mockResolvedValueOnce(jsonResponse({ files: [{ id: "vault-1", name: "TestVault", modifiedTime: "2025-01-01T00:00:00Z" }] }));

            const result = await resolver.ensureRootFolders();
            expect(result).toBe("vault-1");
            expect(resolver.appRootId).toBe("app-root-1");
            expect(resolver.vaultRootId).toBe("vault-1");
        });

        it("should create app root when not found", async () => {
            http.fetchWithAuth
                // App root search: not found
                .mockResolvedValueOnce(jsonResponse({ files: [] }))
                // Create app root
                .mockResolvedValueOnce(jsonResponse({ id: "new-app-root" }))
                // Vault search
                .mockResolvedValueOnce(jsonResponse({ files: [{ id: "vault-1", name: "TestVault", modifiedTime: "2025-01-01T00:00:00Z" }] }));

            await resolver.ensureRootFolders();
            expect(resolver.appRootId).toBe("new-app-root");

            // Verify createFolder was called with POST
            const createCall = http.fetchWithAuth.mock.calls[1];
            expect(createCall[0]).toBe("https://www.googleapis.com/drive/v3/files");
            expect(createCall[1].method).toBe("POST");
        });

        it("should create vault root when not found locally or globally", async () => {
            http.fetchWithAuth
                .mockResolvedValueOnce(jsonResponse({ files: [{ id: "app-root" }] }))
                // Vault not in app root
                .mockResolvedValueOnce(jsonResponse({ files: [] }))
                // Global search: not found
                .mockResolvedValueOnce(jsonResponse({ files: [] }))
                // Create vault
                .mockResolvedValueOnce(jsonResponse({ id: "new-vault" }));

            await resolver.ensureRootFolders();
            expect(resolver.vaultRootId).toBe("new-vault");
        });

        it("should adopt globally found vault and move to app root", async () => {
            http.fetchWithAuth
                .mockResolvedValueOnce(jsonResponse({ files: [{ id: "app-root" }] }))
                // Vault not in app root
                .mockResolvedValueOnce(jsonResponse({ files: [] }))
                // Global search: found in another parent
                .mockResolvedValueOnce(jsonResponse({ files: [{ id: "global-vault", name: "TestVault", parents: ["other-parent"], modifiedTime: "2025-01-01T00:00:00Z" }] }))
                // PATCH to move
                .mockResolvedValueOnce(jsonResponse({}));

            await resolver.ensureRootFolders();
            expect(resolver.vaultRootId).toBe("global-vault");

            // Verify PATCH call for move
            const patchCall = http.fetchWithAuth.mock.calls[3];
            expect(patchCall[0]).toContain("addParents=app-root");
            expect(patchCall[0]).toContain("removeParents=other-parent");
            expect(patchCall[1].method).toBe("PATCH");
        });

        it("should return cached promise on concurrent calls", async () => {
            http.fetchWithAuth
                .mockResolvedValueOnce(jsonResponse({ files: [{ id: "app-root" }] }))
                .mockResolvedValueOnce(jsonResponse({ files: [{ id: "vault-1", name: "TestVault", modifiedTime: "2025-01-01T00:00:00Z" }] }));

            const [r1, r2] = await Promise.all([
                resolver.ensureRootFolders(),
                resolver.ensureRootFolders(),
            ]);
            expect(r1).toBe(r2);
            // fetchWithAuth should be called only once for each query
            expect(http.fetchWithAuth).toHaveBeenCalledTimes(2);
        });

        it("should pick most recently modified vault when multiple exist", async () => {
            http.fetchWithAuth
                .mockResolvedValueOnce(jsonResponse({ files: [{ id: "app-root" }] }))
                .mockResolvedValueOnce(jsonResponse({
                    files: [
                        { id: "old-vault", name: "TestVault", modifiedTime: "2024-01-01T00:00:00Z" },
                        { id: "new-vault", name: "TestVault", modifiedTime: "2025-06-01T00:00:00Z" },
                    ]
                }));

            await resolver.ensureRootFolders();
            expect(resolver.vaultRootId).toBe("new-vault");
        });

        it("should clear initPromise on error so next call retries", async () => {
            http.fetchWithAuth.mockRejectedValueOnce(new Error("network fail"));

            await expect(resolver.ensureRootFolders()).rejects.toThrow("network fail");
            expect((resolver as any).initPromise).toBeNull();
        });
    });

    describe("resolveParentId", () => {
        beforeEach(async () => {
            // Pre-init root folders
            resolver.appRootId = "app-root";
            resolver.vaultRootId = "vault-root";
            (resolver as any).initPromise = Promise.resolve("vault-root");
        });

        it("should return vault root for top-level file", async () => {
            const result = await resolver.resolveParentId("file.md");
            expect(result).toBe("vault-root");
        });

        it("should resolve single-level folder", async () => {
            http.fetchWithAuth.mockResolvedValueOnce(
                jsonResponse({ files: [{ id: "notes-folder" }] })
            );

            const result = await resolver.resolveParentId("notes/file.md");
            expect(result).toBe("notes-folder");
        });

        it("should resolve multi-level folder path", async () => {
            http.fetchWithAuth
                .mockResolvedValueOnce(jsonResponse({ files: [{ id: "notes-folder" }] }))
                .mockResolvedValueOnce(jsonResponse({ files: [{ id: "sub-folder" }] }));

            const result = await resolver.resolveParentId("notes/sub/file.md");
            expect(result).toBe("sub-folder");
        });

        it("should create folders when they don't exist and create=true", async () => {
            http.fetchWithAuth
                // Search: not found
                .mockResolvedValueOnce(jsonResponse({ files: [] }))
                // Create folder
                .mockResolvedValueOnce(jsonResponse({ id: "created-folder" }));

            const result = await resolver.resolveParentId("newdir/file.md", true);
            expect(result).toBe("created-folder");
        });

        it("should throw when folder not found and create=false", async () => {
            http.fetchWithAuth.mockResolvedValueOnce(jsonResponse({ files: [] }));

            await expect(resolver.resolveParentId("missing/file.md", false)).rejects.toThrow("Folder not found");
        });

        it("should use folderCache for repeated lookups", async () => {
            http.fetchWithAuth.mockResolvedValueOnce(
                jsonResponse({ files: [{ id: "cached-folder" }] })
            );

            await resolver.resolveParentId("docs/file1.md");
            // Second call with same parent path should not call fetchWithAuth again
            const result = await resolver.resolveParentId("docs/file2.md");
            expect(result).toBe("cached-folder");
            // Only one search call for "docs" folder
            expect(http.fetchWithAuth).toHaveBeenCalledTimes(1);
        });
    });

    describe("resolveFullPath", () => {
        beforeEach(() => {
            resolver.vaultRootId = "vault-root";
            (resolver as any).initPromise = Promise.resolve("vault-root");
        });

        it("should walk up parent chain to build path", async () => {
            http.fetchWithAuth
                // File itself
                .mockResolvedValueOnce(jsonResponse({ id: "file-1", name: "hello.md", parents: ["folder-1"] }))
                // Parent folder
                .mockResolvedValueOnce(jsonResponse({ id: "folder-1", name: "notes", parents: ["vault-root"] }));

            const path = await resolver.resolveFullPath("file-1");
            expect(path).toBe("notes/hello.md");
        });

        it("should use idToPathCache if available", async () => {
            (resolver as any).idToPathCache.set("cached-id", "cached/path.md");
            const path = await resolver.resolveFullPath("cached-id");
            expect(path).toBe("cached/path.md");
            expect(http.fetchWithAuth).not.toHaveBeenCalled();
        });

        it("should use resolvePathCache if available", async () => {
            (resolver as any).resolvePathCache.set("cached-id-2", "other/path.md");
            const path = await resolver.resolveFullPath("cached-id-2");
            expect(path).toBe("other/path.md");
        });

        it("should throw for file outside vault root", async () => {
            http.fetchWithAuth
                .mockResolvedValueOnce(jsonResponse({ id: "file-1", name: "orphan.md", parents: ["random-parent"] }))
                .mockResolvedValueOnce(jsonResponse({ id: "random-parent", name: "Random", parents: [] }));

            await expect(resolver.resolveFullPath("file-1")).rejects.toThrow("outside the vault root");
        });

        it("should cache outsideFolderIds for repeat outside lookups", async () => {
            http.fetchWithAuth
                .mockResolvedValueOnce(jsonResponse({ id: "file-1", name: "a.md", parents: ["outside-1"] }))
                .mockResolvedValueOnce(jsonResponse({ id: "outside-1", name: "Other", parents: [] }));

            await expect(resolver.resolveFullPath("file-1")).rejects.toThrow("outside");

            // Now a second file under the same outside parent should fail immediately
            http.fetchWithAuth.mockResolvedValueOnce(
                jsonResponse({ id: "file-2", name: "b.md", parents: ["outside-1"] })
            );
            // The parent "outside-1" was cached as outside, so it should fail with cached message
            await expect(resolver.resolveFullPath("file-2")).rejects.toThrow("outside");
        });

        it("should use intermediate folder cache", async () => {
            (resolver as any).resolvePathCache.set("mid-folder", "docs");

            http.fetchWithAuth.mockResolvedValueOnce(
                jsonResponse({ id: "file-1", name: "file.md", parents: ["mid-folder"] })
            );

            const path = await resolver.resolveFullPath("file-1");
            expect(path).toBe("docs/file.md");
        });
    });

    describe("createFolder", () => {
        it("should create folder without parent", async () => {
            http.fetchWithAuth.mockResolvedValueOnce(jsonResponse({ id: "new-folder" }));

            const id = await resolver.createFolder("MyFolder");
            expect(id).toBe("new-folder");

            const body = JSON.parse(http.fetchWithAuth.mock.calls[0][1].body);
            expect(body.name).toBe("MyFolder");
            expect(body.mimeType).toBe("application/vnd.google-apps.folder");
            expect(body.parents).toBeUndefined();
        });

        it("should create folder with parent", async () => {
            http.fetchWithAuth.mockResolvedValueOnce(jsonResponse({ id: "child-folder" }));

            const id = await resolver.createFolder("Sub", "parent-id");
            expect(id).toBe("child-folder");

            const body = JSON.parse(http.fetchWithAuth.mock.calls[0][1].body);
            expect(body.parents).toEqual(["parent-id"]);
        });
    });

    describe("ensureFoldersExist", () => {
        beforeEach(() => {
            resolver.vaultRootId = "vault-root";
            (resolver as any).initPromise = Promise.resolve("vault-root");
        });

        it("should create folders at multiple depths", async () => {
            // For "a/b/file" path, parts are ["a", "b"]
            http.fetchWithAuth
                // Search "a" - not found
                .mockResolvedValueOnce(jsonResponse({ files: [] }))
                // Create "a"
                .mockResolvedValueOnce(jsonResponse({ id: "folder-a" }))
                // Search "b" under "a" - not found
                .mockResolvedValueOnce(jsonResponse({ files: [] }))
                // Create "b"
                .mockResolvedValueOnce(jsonResponse({ id: "folder-b" }));

            const progress = vi.fn();
            await resolver.ensureFoldersExist(["a/b"], progress);
            expect(progress).toHaveBeenCalledWith(1, 1, "a/b");
        });

        it("should deduplicate folder paths", async () => {
            http.fetchWithAuth
                .mockResolvedValueOnce(jsonResponse({ files: [{ id: "folder-a" }] }));

            await resolver.ensureFoldersExist(["alpha", "alpha"]);
            // Only one search call for "alpha" (deduplicated)
            expect(http.fetchWithAuth).toHaveBeenCalledTimes(1);
        });

        it("should use existing folders from cache", async () => {
            (resolver as any).folderCache.set("cached", "folder-cached");

            await resolver.ensureFoldersExist(["cached"]);
            // No fetch calls needed
            expect(http.fetchWithAuth).not.toHaveBeenCalled();
        });
    });

    describe("getFolderIdByName", () => {
        it("should return id when folder exists", async () => {
            http.fetchWithAuth.mockResolvedValueOnce(
                jsonResponse({ files: [{ id: "found-folder", name: "docs" }] })
            );

            const id = await resolver.getFolderIdByName("docs");
            expect(id).toBe("found-folder");
        });

        it("should return null when folder not found", async () => {
            http.fetchWithAuth.mockResolvedValueOnce(jsonResponse({ files: [] }));

            const id = await resolver.getFolderIdByName("nonexistent");
            expect(id).toBeNull();
        });

        it("should include parent in query when provided", async () => {
            http.fetchWithAuth.mockResolvedValueOnce(
                jsonResponse({ files: [{ id: "child-id" }] })
            );

            await resolver.getFolderIdByName("subfolder", "parent-123");
            const url = http.fetchWithAuth.mock.calls[0][0];
            expect(decodeURIComponent(url)).toContain("'parent-123' in parents");
        });
    });

    describe("updateConfig", () => {
        it("should clear caches when vaultName changes", () => {
            resolver.appRootId = "old-app";
            resolver.vaultRootId = "old-vault";

            resolver.updateConfig("NewVault", undefined);

            expect(resolver.vaultName).toBe("NewVault");
            expect(resolver.appRootId).toBeNull();
            expect(resolver.vaultRootId).toBeNull();
        });

        it("should clear caches when cloudRootFolder changes", () => {
            resolver.appRootId = "old-app";
            resolver.vaultRootId = "old-vault";
            (resolver as any).initPromise = Promise.resolve("x");

            resolver.updateConfig(undefined, "NewRoot");

            expect(resolver.rootFolder).toBe("NewRoot");
            expect(resolver.appRootId).toBeNull();
            expect(resolver.vaultRootId).toBeNull();
            expect((resolver as any).initPromise).toBeNull();
        });

        it("should not clear caches when values unchanged", () => {
            resolver.appRootId = "keep";
            resolver.vaultRootId = "keep-vault";

            resolver.updateConfig("TestVault", "ObsidianVaultSync");

            expect(resolver.appRootId).toBe("keep");
            expect(resolver.vaultRootId).toBe("keep-vault");
        });
    });

    describe("reset", () => {
        it("should clear all state", () => {
            resolver.appRootId = "x";
            resolver.vaultRootId = "y";
            (resolver as any).initPromise = Promise.resolve("z");
            (resolver as any).folderCache.set("a", "b");
            (resolver as any).resolveCache.set("c", Promise.resolve("d"));
            (resolver as any).idToPathCache.set("e", "f");
            (resolver as any).resolvePathCache.set("g", "h");
            (resolver as any).outsideFolderIds.add("i");

            resolver.reset();

            expect(resolver.appRootId).toBeNull();
            expect(resolver.vaultRootId).toBeNull();
            expect((resolver as any).initPromise).toBeNull();
            expect((resolver as any).folderCache.size).toBe(0);
            expect((resolver as any).resolveCache.size).toBe(0);
            expect((resolver as any).idToPathCache.size).toBe(0);
            expect((resolver as any).resolvePathCache.size).toBe(0);
            expect((resolver as any).outsideFolderIds.size).toBe(0);
        });
    });

    describe("cacheIdToPath", () => {
        it("should populate both caches", () => {
            resolver.cacheIdToPath("id-1", "path/to/file.md");
            expect((resolver as any).idToPathCache.get("id-1")).toBe("path/to/file.md");
            expect((resolver as any).resolvePathCache.get("id-1")).toBe("path/to/file.md");
        });
    });

    describe("setLogger", () => {
        it("should set logger callback", () => {
            const logger = vi.fn();
            resolver.setLogger(logger);
            expect((resolver as any).logger).toBe(logger);
        });
    });

    describe("getAppRootId", () => {
        it("should return appRootId after initialization", async () => {
            http.fetchWithAuth
                .mockResolvedValueOnce(jsonResponse({ files: [{ id: "app-1" }] }))
                .mockResolvedValueOnce(jsonResponse({ files: [{ id: "vault-1", modifiedTime: "2025-01-01T00:00:00Z" }] }));

            const id = await resolver.getAppRootId();
            expect(id).toBe("app-1");
        });

        it("should throw if appRootId is null after init", async () => {
            // Force a scenario where init completes but appRootId is null
            resolver.appRootId = null;
            (resolver as any).initPromise = Promise.resolve("vault-root");
            resolver.vaultRootId = "vault-root";

            await expect(resolver.getAppRootId()).rejects.toThrow("App root not found");
        });
    });

    describe("clearFolderCaches", () => {
        it("should clear vaultRootId, initPromise, folderCache, resolveCache", () => {
            resolver.vaultRootId = "old";
            (resolver as any).initPromise = Promise.resolve("x");
            (resolver as any).folderCache.set("a", "b");
            (resolver as any).resolveCache.set("c", Promise.resolve("d"));

            resolver.clearFolderCaches();

            expect(resolver.vaultRootId).toBeNull();
            expect((resolver as any).initPromise).toBeNull();
            expect((resolver as any).folderCache.size).toBe(0);
            expect((resolver as any).resolveCache.size).toBe(0);
        });
    });
});
