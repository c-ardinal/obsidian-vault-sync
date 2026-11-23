/**
 * @file クラウド容量の確認と事前警告の試験
 *
 * @pass_criteria
 * - 1 日 1 回のみ容量を照会すること
 * - 使用率 90% 以上で週 1 回のみ通知すること
 * - 照会結果を data/local に保存し、再起動後も参照可能なこと
 */
import { describe, it, expect, vi } from "vitest";
import {
    checkStorageIfDue,
    refreshStorage,
    storageSummary,
    STORAGE_CHECK_INTERVAL_MS,
    STORAGE_WARN_INTERVAL_MS,
} from "../../../src/sync-manager/storage-check";

function makeCtx(usage: number, limit: number | undefined, files = new Map<string, string>()) {
    const getStorageQuota = vi.fn(async () => ({ usage, limit, usageInTrash: 5 }));
    const notify = vi.fn(async () => {});
    const ctx = {
        adapter: { getStorageQuota } as any,
        log: async () => {},
        notify,
        index: { "a.md": { size: 100 }, "b.png": { size: 900 } },
        pluginDir: "p",
        vault: {
            exists: async (p: string) => files.has(p) || p === "p/data/local",
            read: async (p: string) => files.get(p)!,
            write: async (p: string, d: string) => void files.set(p, d),
            mkdir: async () => {},
        },
    };
    return { ctx, getStorageQuota, notify, files };
}

const T0 = 1_800_000_000_000;

describe("cloud storage check", () => {
    it("reads the storage at most once a day", async () => {
        const { ctx, getStorageQuota } = makeCtx(10, 100);
        await checkStorageIfDue(ctx, T0);
        await checkStorageIfDue(ctx, T0 + 1000);
        expect(getStorageQuota).toHaveBeenCalledTimes(1);
        await checkStorageIfDue(ctx, T0 + STORAGE_CHECK_INTERVAL_MS);
        expect(getStorageQuota).toHaveBeenCalledTimes(2);
    });

    it("warns at 90% and more, once a week", async () => {
        const { ctx, notify } = makeCtx(95, 100);
        await checkStorageIfDue(ctx, T0);
        expect(notify).toHaveBeenCalledWith("noticeStorageAlmostFull", "95%");
        await checkStorageIfDue(ctx, T0 + STORAGE_CHECK_INTERVAL_MS);
        expect(notify).toHaveBeenCalledTimes(1);
        await checkStorageIfDue(ctx, T0 + STORAGE_WARN_INTERVAL_MS);
        expect(notify).toHaveBeenCalledTimes(2);
    });

    it("does not warn below 90% or without a limit", async () => {
        const a = makeCtx(89, 100);
        await checkStorageIfDue(a.ctx, T0);
        const b = makeCtx(10 ** 15, undefined);
        await checkStorageIfDue(b.ctx, T0);
        expect(a.notify).not.toHaveBeenCalled();
        expect(b.notify).not.toHaveBeenCalled();
    });

    it("keeps the reading across restarts and sums the vault size", async () => {
        const first = makeCtx(40, 100);
        await refreshStorage(first.ctx, T0);
        const again = makeCtx(40, 100, first.files);
        const sum = await storageSummary(again.ctx);
        expect(sum.quota).toMatchObject({ usage: 40, limit: 100, usageInTrash: 5 });
        expect(sum.checkedAt).toBe(T0);
        expect(sum.vaultBytes).toBe(1000);
        await checkStorageIfDue(again.ctx, T0 + 1000);
        expect(again.getStorageQuota).not.toHaveBeenCalled();
    });

    it("a failed reading is logged and skipped", async () => {
        const { ctx } = makeCtx(1, 2);
        ctx.adapter.getStorageQuota = vi.fn(async () => {
            throw new Error("offline");
        });
        expect(await refreshStorage(ctx, T0)).toBeNull();
    });
});
