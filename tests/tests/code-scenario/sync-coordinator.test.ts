/**
 * @file Sync Coordinator テスト
 *
 * @description
 * requestSmartSync, executeSmartSync, requestBackgroundScan,
 * isProgressStale, postPushPull のテスト。
 *
 * @pass_criteria
 * - requestSmartSync: MIGRATING中はキューのみ / SMART_SYNCING中は再キュー / FULL_SCANNING中は中断
 * - executeSmartSync: エラー分類 (auth/network/generic) / recentlyDeletedFromRemoteクリーンアップ
 * - requestBackgroundScan: IDLE以外はスキップ
 * - isProgressStale: MAX_AGE超過で true
 * - re-queuing: triggerの優先度マージ
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
    requestSmartSync,
    executeSmartSync,
    requestBackgroundScan,
    isProgressStale,
} from "../../../src/sync-manager/sync-coordinator";
import type { SyncContext } from "../../../src/sync-manager/context";

// ─── Mock SyncContext factory ───

function createMockCtx(overrides: Partial<SyncContext> = {}): SyncContext {
    const logger = {
        startCycle: vi.fn(),
        endCycle: vi.fn(),
    };

    const backgroundTransferQueue = {
        pause: vi.fn(),
        resume: vi.fn(),
        flushHistory: vi.fn(async () => {}),
    };

    const adapter: any = {
        initialize: vi.fn(),
        clearDownloadCache: vi.fn(),
        supportsChangesAPI: false,
        listFiles: vi.fn(async () => []),
    };

    return {
        syncState: "IDLE",
        currentTrigger: "manual-sync",
        currentSyncPromise: null,
        syncRequestedWhileSyncing: false,
        nextSyncParams: null,
        isInterrupted: false,
        fullScanProgress: null,
        FULL_SCAN_MAX_AGE_MS: 30 * 60 * 1000, // 30 min

        index: {},
        localIndex: {},
        dirtyPaths: new Map(),
        recentlyDeletedFromRemote: new Set(),
        settingsUpdated: false,
        isSpinning: false,
        pluginDataPath: ".obsidian/plugins/obsidian-vault-sync/sync-index.json",
        settings: { hasCompletedFirstSync: true },

        vault: {
            exists: vi.fn(async () => false),
            getFiles: vi.fn(() => []),
        },
        adapter,
        logger,
        backgroundTransferQueue,

        log: vi.fn(),
        notify: vi.fn(),
        startActivity: vi.fn(),
        endActivity: vi.fn(),
        onSettingsUpdated: vi.fn(),

        smartPull: vi.fn(async () => false),
        smartPush: vi.fn(async () => false),
        pullViaChangesAPI: vi.fn(),

        ...overrides,
    } as unknown as SyncContext;
}

// ═══════════════════════════════════════════════════════════════════

describe("requestSmartSync", () => {
    it("should execute smart sync when IDLE", async () => {
        const ctx = createMockCtx();
        await requestSmartSync(ctx);

        expect(ctx.smartPull).toHaveBeenCalled();
        expect(ctx.smartPush).toHaveBeenCalled();
        expect(ctx.syncState).toBe("IDLE");
    });

    it("should skip execution when MIGRATING", async () => {
        const ctx = createMockCtx({ syncState: "MIGRATING" as any });
        await requestSmartSync(ctx);

        expect(ctx.smartPull).not.toHaveBeenCalled();
    });

    it("should re-queue when called during active sync", async () => {
        const ctx = createMockCtx();

        // Simulate: first call starts syncing, second call arrives mid-sync
        let callCount = 0;
        (ctx.smartPull as any).mockImplementation(async () => {
            callCount++;
            if (callCount === 1) {
                // During first sync, simulate another request arriving
                ctx.syncRequestedWhileSyncing = true;
                ctx.nextSyncParams = {
                    trigger: "save-sync" as any,
                    scanVault: true,
                };
            }
            return false;
        });

        await requestSmartSync(ctx);

        // smartPull should have been called twice (original + re-queue)
        expect(callCount).toBe(2);
    });

    it("should interrupt FULL_SCANNING state", async () => {
        const ctx = createMockCtx({
            syncState: "FULL_SCANNING" as any,
            currentSyncPromise: Promise.resolve(),
        });

        await requestSmartSync(ctx);

        expect(ctx.isInterrupted).toBe(true);
    });
});

describe("executeSmartSync", () => {
    it("should call smartPull and smartPush", async () => {
        const ctx = createMockCtx();
        await executeSmartSync(ctx, false);

        expect(ctx.smartPull).toHaveBeenCalled();
        expect(ctx.smartPush).toHaveBeenCalledWith(false);
    });

    it("should pass scanVault=true to smartPush", async () => {
        const ctx = createMockCtx();
        await executeSmartSync(ctx, true);

        expect(ctx.smartPush).toHaveBeenCalledWith(true);
    });

    it("should notify 'up to date' when no pull and no push", async () => {
        const ctx = createMockCtx();
        (ctx.smartPull as any).mockResolvedValue(false);
        (ctx.smartPush as any).mockResolvedValue(false);

        await executeSmartSync(ctx, false);

        expect(ctx.notify).toHaveBeenCalledWith("noticeVaultUpToDate");
    });

    it("should classify auth errors correctly", async () => {
        const ctx = createMockCtx();
        (ctx.smartPull as any).mockRejectedValue(
            new Error("Not authenticated"),
        );

        await expect(executeSmartSync(ctx, false)).rejects.toThrow();
        expect(ctx.notify).toHaveBeenCalledWith("noticeSyncFailedAuth");
    });

    it("should classify network errors correctly", async () => {
        const ctx = createMockCtx();
        (ctx.smartPull as any).mockRejectedValue(
            new Error("Network error: failed to fetch"),
        );

        await expect(executeSmartSync(ctx, false)).rejects.toThrow();
        expect(ctx.notify).toHaveBeenCalledWith("noticeSyncFailedNetwork");
    });

    it("should classify generic errors correctly", async () => {
        const ctx = createMockCtx();
        (ctx.smartPull as any).mockRejectedValue(
            new Error("Some unexpected error"),
        );

        await expect(executeSmartSync(ctx, false)).rejects.toThrow();
        expect(ctx.notify).toHaveBeenCalledWith(
            "noticeSyncFailed",
            expect.any(String),
        );
    });

    it("should pause and resume background transfer queue", async () => {
        const ctx = createMockCtx();
        await executeSmartSync(ctx, false);

        expect(ctx.backgroundTransferQueue.pause).toHaveBeenCalled();
        expect(ctx.backgroundTransferQueue.resume).toHaveBeenCalled();
    });

    it("should clear download cache and end cycle in finally block", async () => {
        const ctx = createMockCtx();
        await executeSmartSync(ctx, false);

        expect(ctx.adapter.clearDownloadCache).toHaveBeenCalled();
        expect(ctx.logger.endCycle).toHaveBeenCalled();
        expect(ctx.endActivity).toHaveBeenCalled();
    });

    it("should clean up recentlyDeletedFromRemote for missing files", async () => {
        const ctx = createMockCtx();
        ctx.recentlyDeletedFromRemote.add("notes/deleted.md");
        ctx.recentlyDeletedFromRemote.add("notes/exists.md");

        (ctx.vault.exists as any).mockImplementation(async (path: string) => {
            return path === "notes/exists.md";
        });

        await executeSmartSync(ctx, false);

        // deleted.md was removed from the set (file doesn't exist locally)
        expect(ctx.recentlyDeletedFromRemote.has("notes/deleted.md")).toBe(false);
        // exists.md still in the set (file exists locally)
        expect(ctx.recentlyDeletedFromRemote.has("notes/exists.md")).toBe(true);
    });

    it("should reload settings when settingsUpdated flag is set", async () => {
        const ctx = createMockCtx({ settingsUpdated: true });
        await executeSmartSync(ctx, false);

        expect(ctx.onSettingsUpdated).toHaveBeenCalled();
        expect(ctx.settingsUpdated).toBe(false);
    });
});

describe("requestBackgroundScan", () => {
    it("should skip when syncState is not IDLE", async () => {
        const ctx = createMockCtx({
            syncState: "SMART_SYNCING" as any,
        });
        await requestBackgroundScan(ctx);

        expect(ctx.syncState).toBe("SMART_SYNCING");
    });

    it("should set syncState to FULL_SCANNING and execute", async () => {
        const ctx = createMockCtx();
        // listFiles returns empty, so scan finishes immediately
        await requestBackgroundScan(ctx);

        // After completion, should be back to IDLE
        expect(ctx.syncState).toBe("IDLE");
    });
});

describe("isProgressStale", () => {
    it("should return true when no progress exists", () => {
        const ctx = createMockCtx({ fullScanProgress: null });
        expect(isProgressStale(ctx)).toBe(true);
    });

    it("should return true when progress is older than MAX_AGE", () => {
        const ctx = createMockCtx({
            fullScanProgress: {
                startedAt: Date.now() - 31 * 60 * 1000, // 31 min
                currentIndex: 0,
                totalFiles: 100,
                localFiles: [],
                remoteFiles: [],
            } as any,
        });
        expect(isProgressStale(ctx)).toBe(true);
    });

    it("should return false when progress is recent", () => {
        const ctx = createMockCtx({
            fullScanProgress: {
                startedAt: Date.now() - 5 * 60 * 1000, // 5 min
                currentIndex: 0,
                totalFiles: 100,
                localFiles: [],
                remoteFiles: [],
            } as any,
        });
        expect(isProgressStale(ctx)).toBe(false);
    });
});
