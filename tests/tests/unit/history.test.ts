/**
 * @file History module テスト
 *
 * @description
 * supportsHistory, listRevisions, getRevisionContent (キャッシュ連携),
 * setRevisionKeepForever, deleteRevision, restoreRevision をテストする。
 *
 * @pass_criteria
 * - supportsHistory: adapter.supportsHistory に基づく
 * - listRevisions: adapter 委譲 / 非対応時エラー
 * - getRevisionContent: キャッシュヒット時はadapter呼ばない / ミス時はadapter + キャッシュ保存
 * - setRevisionKeepForever: adapter 委譲
 * - deleteRevision: adapter 委譲
 * - restoreRevision: コンテンツ取得→既存ファイル上書き/新規作成→通知
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { TFile } from "obsidian";
import {
    supportsHistory,
    listRevisions,
    getRevisionContent,
    setRevisionKeepForever,
    deleteRevision,
    restoreRevision,
} from "../../../src/sync-manager/history";
import type { SyncContext } from "../../../src/sync-manager/context";

// ─── Mock SyncContext factory ───

function createMockCtx(
    opts: {
        adapterSupportsHistory?: boolean;
        cachedContent?: ArrayBuffer | null;
    } = {},
): SyncContext {
    const { adapterSupportsHistory = true, cachedContent = null } = opts;

    const adapter: any = {
        supportsHistory: adapterSupportsHistory,
        listRevisions: vi.fn(async () => [
            { id: "rev-1", modifiedTime: 1000, size: 100 },
            { id: "rev-2", modifiedTime: 2000, size: 200 },
        ]),
        getRevisionContent: vi.fn(async () => new TextEncoder().encode("remote content").buffer),
        setRevisionKeepForever: vi.fn(),
        deleteRevision: vi.fn(),
    };

    const revisionCache: any = {
        get: vi.fn(async () => cachedContent),
        set: vi.fn(),
    };

    const vault: any = {
        getAbstractFileByPath: vi.fn(() => null),
        modifyBinary: vi.fn(),
        createBinary: vi.fn(),
    };

    return {
        adapter,
        revisionCache,
        vault,
        t: (key: string) => key,
        log: vi.fn(),
        notify: vi.fn(),
    } as unknown as SyncContext;
}

// ═══════════════════════════════════════════════════════════════════

describe("supportsHistory", () => {
    it("should return true when adapter supports history", () => {
        const ctx = createMockCtx({ adapterSupportsHistory: true });
        expect(supportsHistory(ctx)).toBe(true);
    });

    it("should return false when adapter does not support history", () => {
        const ctx = createMockCtx({ adapterSupportsHistory: false });
        expect(supportsHistory(ctx)).toBe(false);
    });

    it("should return false when supportsHistory is undefined", () => {
        const ctx = createMockCtx();
        (ctx.adapter as any).supportsHistory = undefined;
        expect(supportsHistory(ctx)).toBe(false);
    });
});

describe("listRevisions", () => {
    it("should delegate to adapter and return revisions", async () => {
        const ctx = createMockCtx();
        const revisions = await listRevisions(ctx, "test.md");

        expect(ctx.adapter.listRevisions).toHaveBeenCalledWith("test.md");
        expect(revisions).toHaveLength(2);
        expect(revisions[0].id).toBe("rev-1");
    });

    it("should throw when adapter does not support history", async () => {
        const ctx = createMockCtx({ adapterSupportsHistory: false });
        await expect(listRevisions(ctx, "test.md")).rejects.toThrow();
    });

    it("should throw with fallback error message when t returns falsy", async () => {
        const ctx = createMockCtx({ adapterSupportsHistory: false });
        ctx.t = () => "";
        await expect(listRevisions(ctx, "test.md")).rejects.toThrow(
            "Cloud adapter does not support history.",
        );
    });
});

describe("getRevisionContent", () => {
    it("should return cached content when available (no adapter call)", async () => {
        const cachedData = new TextEncoder().encode("cached data").buffer as ArrayBuffer;
        const ctx = createMockCtx({ cachedContent: cachedData });

        const result = await getRevisionContent(ctx, "test.md", "rev-1");

        expect(new TextDecoder().decode(result)).toBe("cached data");
        expect(ctx.adapter.getRevisionContent).not.toHaveBeenCalled();
    });

    it("should fetch from adapter and cache when not in cache", async () => {
        const ctx = createMockCtx({ cachedContent: null });

        const result = await getRevisionContent(ctx, "test.md", "rev-1");

        expect(new TextDecoder().decode(result)).toBe("remote content");
        expect(ctx.adapter.getRevisionContent).toHaveBeenCalledWith("test.md", "rev-1");
        expect(ctx.revisionCache.set).toHaveBeenCalledWith(
            "test.md",
            "rev-1",
            expect.any(ArrayBuffer),
        );
    });

    it("should throw when adapter does not support history", async () => {
        const ctx = createMockCtx({ adapterSupportsHistory: false });
        await expect(getRevisionContent(ctx, "test.md", "rev-1")).rejects.toThrow();
    });

    it("should throw with fallback error message when t returns falsy", async () => {
        const ctx = createMockCtx({ adapterSupportsHistory: false });
        ctx.t = () => "";
        await expect(getRevisionContent(ctx, "test.md", "rev-1")).rejects.toThrow(
            "Cloud adapter does not support history.",
        );
    });
});

describe("setRevisionKeepForever", () => {
    it("should delegate to adapter", async () => {
        const ctx = createMockCtx();
        await setRevisionKeepForever(ctx, "test.md", "rev-1", true);
        expect(ctx.adapter.setRevisionKeepForever).toHaveBeenCalledWith("test.md", "rev-1", true);
    });

    it("should throw when adapter does not support history", async () => {
        const ctx = createMockCtx({ adapterSupportsHistory: false });
        await expect(setRevisionKeepForever(ctx, "test.md", "rev-1", true)).rejects.toThrow();
    });

    it("should throw with fallback error message when t returns falsy", async () => {
        const ctx = createMockCtx({ adapterSupportsHistory: false });
        ctx.t = () => "";
        await expect(setRevisionKeepForever(ctx, "test.md", "rev-1", true)).rejects.toThrow(
            "Cloud adapter does not support history.",
        );
    });
});

describe("deleteRevision", () => {
    it("should delegate to adapter", async () => {
        const ctx = createMockCtx();
        await deleteRevision(ctx, "test.md", "rev-1");
        expect(ctx.adapter.deleteRevision).toHaveBeenCalledWith("test.md", "rev-1");
    });

    it("should throw when adapter does not support history", async () => {
        const ctx = createMockCtx({ adapterSupportsHistory: false });
        await expect(deleteRevision(ctx, "test.md", "rev-1")).rejects.toThrow();
    });

    it("should throw with fallback error message when t returns falsy", async () => {
        const ctx = createMockCtx({ adapterSupportsHistory: false });
        ctx.t = () => "";
        await expect(deleteRevision(ctx, "test.md", "rev-1")).rejects.toThrow(
            "Cloud adapter does not support history.",
        );
    });
});

describe("restoreRevision", () => {
    it("should restore content to existing file via modifyBinary", async () => {
        const ctx = createMockCtx({ cachedContent: null });
        const mockFile = new TFile();
        (ctx.vault.getAbstractFileByPath as any).mockReturnValue(mockFile);

        await restoreRevision(ctx, "test.md", {
            id: "rev-1",
            modifiedTime: 1000,
            size: 100,
        } as any);

        expect(ctx.vault.modifyBinary).toHaveBeenCalledWith(mockFile, expect.any(ArrayBuffer));
        expect(ctx.notify).toHaveBeenCalledWith("noticeFileRestored");
    });

    it("should create new file via createBinary when file does not exist", async () => {
        const ctx = createMockCtx({ cachedContent: null });
        (ctx.vault.getAbstractFileByPath as any).mockReturnValue(null);

        await restoreRevision(ctx, "test.md", {
            id: "rev-1",
            modifiedTime: 1000,
            size: 100,
        } as any);

        expect(ctx.vault.createBinary).toHaveBeenCalledWith("test.md", expect.any(ArrayBuffer));
        expect(ctx.notify).toHaveBeenCalledWith("noticeFileRestored");
    });

    it("should use cache for content if available", async () => {
        const cachedData = new TextEncoder().encode("cached revision").buffer as ArrayBuffer;
        const ctx = createMockCtx({ cachedContent: cachedData });
        const mockFile = new TFile();
        (ctx.vault.getAbstractFileByPath as any).mockReturnValue(mockFile);

        await restoreRevision(ctx, "test.md", {
            id: "rev-1",
            modifiedTime: 1000,
            size: 100,
        } as any);

        // Should use cached content, not fetch from adapter
        expect(ctx.adapter.getRevisionContent).not.toHaveBeenCalled();
        expect(ctx.vault.modifyBinary).toHaveBeenCalled();
    });

    it("should throw and log error on failure", async () => {
        const ctx = createMockCtx({ cachedContent: null });
        (ctx.adapter.getRevisionContent as any).mockRejectedValue(new Error("Download failed"));

        await expect(
            restoreRevision(ctx, "test.md", {
                id: "rev-1",
                modifiedTime: 1000,
                size: 100,
            } as any),
        ).rejects.toThrow("Download failed");

        expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining("Rollback failed"), "error");
    });
});
