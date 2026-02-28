/**
 * @file State モジュール Dirty Tracking ユニットテスト
 *
 * @description
 * markDirty / markDeleted / markFolderDeleted / markRenamed / markFolderRenamed の
 * dirty path追跡・インデックス移行ロジックを検証する。
 * 既存テストでカバーされているmerge lock系は対象外。
 *
 * @pass_criteria
 * - markDirty: 通常→追加, ignore対象→スキップ, syncing中→スキップ
 * - markDeleted: index有→追加, index無→スキップ
 * - markFolderDeleted: フォルダ+子ファイル全てdirty化
 * - markRenamed: index/localIndex移行, pendingMove設定, 未同期リネーム
 * - markFolderRenamed: 子ファイル一括移行, pendingFolderMoves追跡
 * - getSyncState / hasDirtyFiles / isFreshStart: 状態クエリ
 * - clearPendingPushStates: push/merge→pull変換
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
    markDirty,
    markDeleted,
    markFolderDeleted,
    markRenamed,
    markFolderRenamed,
    getSyncState,
    hasDirtyFiles,
    isFreshStart,
    clearPendingPushStates,
} from "../../../src/sync-manager/state";
import type { SyncContext } from "../../../src/sync-manager/context";

function createMockCtx(): SyncContext {
    return {
        vault: {} as any,
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
        index: {},
        localIndex: {},
        dirtyPaths: new Map(),
        syncingPaths: new Set(),
        deletedFolders: new Set(),
        pendingFolderMoves: new Map(),
        recentlyDeletedFromRemote: new Set(),
        pluginDataPath: ".obsidian/plugins/obsidian-vault-sync/data/remote/sync-index.json",
        pluginDir: ".obsidian/plugins/obsidian-vault-sync/",
        e2eeEnabled: false,
        syncState: "idle",
        indexLoadFailed: false,
        log: vi.fn(),
    } as any;
}

describe("state - dirty tracking", () => {
    let ctx: SyncContext;

    beforeEach(() => {
        ctx = createMockCtx();
    });

    describe("markDirty", () => {
        it("should add path to dirtyPaths", () => {
            markDirty(ctx, "notes/hello.md");
            expect(ctx.dirtyPaths.has("notes/hello.md")).toBe(true);
        });

        it("should skip paths currently being synced", () => {
            ctx.syncingPaths.add("notes/syncing.md");
            markDirty(ctx, "notes/syncing.md");
            expect(ctx.dirtyPaths.has("notes/syncing.md")).toBe(false);
        });

        it("should skip system ignore files", () => {
            markDirty(ctx, ".DS_Store");
            expect(ctx.dirtyPaths.has(".DS_Store")).toBe(false);
        });

        it("should normalize path before checking", () => {
            markDirty(ctx, "notes//hello.md");
            expect(ctx.dirtyPaths.has("notes/hello.md")).toBe(true);
        });
    });

    describe("markDeleted", () => {
        it("should mark file as dirty when it exists in index", () => {
            ctx.index["notes/old.md"] = { fileId: "f1", mtime: 100, size: 10, hash: "abc" };
            markDeleted(ctx, "notes/old.md");
            expect(ctx.dirtyPaths.has("notes/old.md")).toBe(true);
        });

        it("should not mark file when it does not exist in index", () => {
            markDeleted(ctx, "notes/unknown.md");
            expect(ctx.dirtyPaths.has("notes/unknown.md")).toBe(false);
        });
    });

    describe("markFolderDeleted", () => {
        it("should mark folder and all children as dirty", () => {
            ctx.index["docs/a.md"] = { fileId: "f1", mtime: 100, size: 10, hash: "a" };
            ctx.index["docs/sub/b.md"] = { fileId: "f2", mtime: 100, size: 10, hash: "b" };
            ctx.index["other/c.md"] = { fileId: "f3", mtime: 100, size: 10, hash: "c" };

            markFolderDeleted(ctx, "docs");

            expect(ctx.deletedFolders.has("docs")).toBe(true);
            expect(ctx.dirtyPaths.has("docs/a.md")).toBe(true);
            expect(ctx.dirtyPaths.has("docs/sub/b.md")).toBe(true);
            expect(ctx.dirtyPaths.has("other/c.md")).toBe(false);
        });
    });

    describe("markRenamed", () => {
        it("should migrate index entries from old to new path", () => {
            ctx.index["notes/old.md"] = { fileId: "f1", mtime: 100, size: 10, hash: "abc" };
            ctx.localIndex["notes/old.md"] = { fileId: "f1", mtime: 100, size: 10, hash: "abc" };

            markRenamed(ctx, "notes/old.md", "notes/new.md");

            expect(ctx.index["notes/old.md"]).toBeUndefined();
            expect(ctx.index["notes/new.md"]).toBeDefined();
            expect(ctx.index["notes/new.md"].pendingMove).toEqual({ oldPath: "notes/old.md" });
            expect(ctx.index["notes/new.md"].forcePush).toBe(true);
            expect(ctx.localIndex["notes/old.md"]).toBeUndefined();
            expect(ctx.localIndex["notes/new.md"]).toBeDefined();
            expect(ctx.dirtyPaths.has("notes/new.md")).toBe(true);
            expect(ctx.dirtyPaths.has("notes/old.md")).toBe(false);
        });

        it("should handle rename of file not yet synced (dirty only)", () => {
            ctx.dirtyPaths.set("notes/unsaved.md", Date.now());

            markRenamed(ctx, "notes/unsaved.md", "notes/renamed.md");

            expect(ctx.dirtyPaths.has("notes/unsaved.md")).toBe(false);
            expect(ctx.dirtyPaths.has("notes/renamed.md")).toBe(true);
            // No index entry should be created
            expect(ctx.index["notes/renamed.md"]).toBeUndefined();
        });

        it("should handle move (directory change)", () => {
            ctx.index["folder-a/file.md"] = { fileId: "f1", mtime: 100, size: 10, hash: "abc" };
            ctx.localIndex["folder-a/file.md"] = { fileId: "f1", mtime: 100, size: 10, hash: "abc" };

            markRenamed(ctx, "folder-a/file.md", "folder-b/file.md");

            expect(ctx.index["folder-a/file.md"]).toBeUndefined();
            expect(ctx.index["folder-b/file.md"]).toBeDefined();
            expect(ctx.index["folder-b/file.md"].pendingMove).toEqual({ oldPath: "folder-a/file.md" });
        });
    });

    describe("markFolderRenamed", () => {
        it("should migrate all children and track folder move", () => {
            ctx.index["project/a.md"] = { fileId: "f1", mtime: 100, size: 10, hash: "a" };
            ctx.index["project/sub/b.md"] = { fileId: "f2", mtime: 100, size: 10, hash: "b" };
            ctx.localIndex["project/a.md"] = { fileId: "f1", mtime: 100, size: 10, hash: "a" };
            ctx.localIndex["project/sub/b.md"] = { fileId: "f2", mtime: 100, size: 10, hash: "b" };

            markFolderRenamed(ctx, "project", "archived");

            // Folder move tracking
            expect(ctx.pendingFolderMoves.get("archived")).toBe("project");

            // Children migrated
            expect(ctx.index["project/a.md"]).toBeUndefined();
            expect(ctx.index["archived/a.md"]).toBeDefined();
            expect(ctx.index["archived/a.md"].pendingMove).toEqual({ oldPath: "project/a.md" });
            expect(ctx.index["archived/sub/b.md"]).toBeDefined();
            expect(ctx.index["archived/sub/b.md"].pendingMove).toEqual({ oldPath: "project/sub/b.md" });

            // Dirty paths updated
            expect(ctx.dirtyPaths.has("archived/a.md")).toBe(true);
            expect(ctx.dirtyPaths.has("archived/sub/b.md")).toBe(true);
            expect(ctx.dirtyPaths.has("project/a.md")).toBe(false);
        });

        it("should remove old folder from deletedFolders (move not delete)", () => {
            ctx.deletedFolders.add("myFolder");
            ctx.index["myFolder/file.md"] = { fileId: "f1", mtime: 100, size: 10, hash: "a" };

            markFolderRenamed(ctx, "myFolder", "renamedFolder");

            expect(ctx.deletedFolders.has("myFolder")).toBe(false);
        });
    });

    describe("state queries", () => {
        it("getSyncState should return current sync state", () => {
            (ctx as any).syncState = "syncing";
            expect(getSyncState(ctx)).toBe("syncing");
        });

        it("hasDirtyFiles should return true when dirty paths exist", () => {
            expect(hasDirtyFiles(ctx)).toBe(false);
            ctx.dirtyPaths.set("file.md", Date.now());
            expect(hasDirtyFiles(ctx)).toBe(true);
        });

        it("isFreshStart should return true when index is empty", () => {
            expect(isFreshStart(ctx)).toBe(true);
            ctx.index["file.md"] = { fileId: "f1", mtime: 1, size: 1, hash: "a" };
            expect(isFreshStart(ctx)).toBe(false);
        });

        it("isFreshStart should return true when indexLoadFailed", () => {
            ctx.index["file.md"] = { fileId: "f1", mtime: 1, size: 1, hash: "a" };
            ctx.indexLoadFailed = true;
            expect(isFreshStart(ctx)).toBe(true);
        });
    });

    describe("clearPendingPushStates", () => {
        it("should convert push/merge lastAction to pull", () => {
            ctx.localIndex["a.md"] = { fileId: "f1", mtime: 1, size: 1, hash: "a", lastAction: "push" };
            ctx.localIndex["b.md"] = { fileId: "f2", mtime: 1, size: 1, hash: "b", lastAction: "merge" };
            ctx.localIndex["c.md"] = { fileId: "f3", mtime: 1, size: 1, hash: "c", lastAction: "pull" };

            clearPendingPushStates(ctx);

            expect(ctx.localIndex["a.md"].lastAction).toBe("pull");
            expect(ctx.localIndex["b.md"].lastAction).toBe("pull");
            expect(ctx.localIndex["c.md"].lastAction).toBe("pull");
        });
    });
});
