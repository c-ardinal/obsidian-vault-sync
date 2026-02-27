/**
 * @file Trigger Manager テスト
 *
 * @description
 * TriggerManager の自動同期インターバル、triggerSmartSync のゲートロジック、
 * currentTriggers の設定ストラテジー切り替えをテストする。
 *
 * @pass_criteria
 * - setupAutoSyncInterval: 有効時インターバル作成 / 無効時作成しない
 * - setReady: isReady=false で triggerSmartSync 抑制
 * - triggerSmartSync: interval 中のアクティブ編集検出で抑制
 * - currentTriggers: unified / per-platform 切り替え
 * - destroy: インターバルクリーンアップ
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TriggerManager } from "../../../src/services/trigger-manager";
import { DEFAULT_SETTINGS, SETTINGS_LIMITS } from "../../../src/constants";

// Stub global window for Node environment
if (typeof globalThis.window === "undefined") {
    (globalThis as any).window = globalThis;
}

// ─── Minimal mock deps ───

function createMockDeps(settingsOverrides: Record<string, any> = {}) {
    const settings = {
        ...DEFAULT_SETTINGS,
        ...settingsOverrides,
    };

    const syncManager = {
        requestSmartSync: vi.fn(),
        isSyncing: vi.fn(() => false),
        shouldIgnore: vi.fn(() => false),
        markDirty: vi.fn(),
        markDeleted: vi.fn(),
        markFolderDeleted: vi.fn(),
        markRenamed: vi.fn(),
        markFolderRenamed: vi.fn(),
        log: vi.fn(),
    };

    const events: any[] = [];
    const intervals: number[] = [];

    return {
        deps: {
            app: {
                workspace: {
                    on: vi.fn((_event: string, _cb: any) => ({ unref: vi.fn() })),
                    onLayoutReady: vi.fn(),
                },
                vault: {
                    on: vi.fn((_event: string, _cb: any) => ({ unref: vi.fn() })),
                },
            } as any,
            settings,
            syncManager: syncManager as any,
            registerEvent: (evt: any) => events.push(evt),
            registerInterval: (id: number) => intervals.push(id),
        },
        syncManager,
        events,
        intervals,
    };
}

describe("TriggerManager", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    describe("currentTriggers", () => {
        it("should return unified triggers when strategy is unified", () => {
            const { deps } = createMockDeps({
                triggerConfigStrategy: "unified",
                unifiedTriggers: { autoSyncIntervalSec: 120 },
            });
            const tm = new TriggerManager(deps);
            expect(tm.currentTriggers.autoSyncIntervalSec).toBe(120);
        });

        it("should return default triggers when settings is null", () => {
            const { deps } = createMockDeps();
            (deps as any).settings = null;
            const tm = new TriggerManager(deps);
            expect(tm.currentTriggers).toEqual(DEFAULT_SETTINGS.unifiedTriggers);
        });
    });

    describe("setupAutoSyncInterval", () => {
        it("should create interval when autoSyncIntervalSec is valid", async () => {
            const { deps, syncManager, intervals } = createMockDeps({
                triggerConfigStrategy: "unified",
                unifiedTriggers: {
                    ...DEFAULT_SETTINGS.unifiedTriggers,
                    autoSyncIntervalSec: 60,
                },
            });
            const tm = new TriggerManager(deps);
            tm.setReady(true);
            tm.setupAutoSyncInterval();

            expect(intervals.length).toBe(1);

            // Advance timer to fire the interval callback once
            vi.advanceTimersByTime(60_000);
            // Flush microtasks for async triggerSmartSync -> requestSmartSync
            await new Promise((r) => process.nextTick(r));
            await new Promise((r) => process.nextTick(r));
            expect(syncManager.requestSmartSync).toHaveBeenCalled();
        });

        it("should NOT create interval when disabled", () => {
            const { deps, intervals } = createMockDeps({
                triggerConfigStrategy: "unified",
                unifiedTriggers: {
                    ...DEFAULT_SETTINGS.unifiedTriggers,
                    autoSyncIntervalSec: SETTINGS_LIMITS.autoSyncInterval.disabled,
                },
            });
            const tm = new TriggerManager(deps);
            tm.setupAutoSyncInterval();

            expect(intervals.length).toBe(0);
        });

        it("should clear previous interval when called again", () => {
            const clearSpy = vi.spyOn(window, "clearInterval");
            const { deps } = createMockDeps({
                triggerConfigStrategy: "unified",
                unifiedTriggers: {
                    ...DEFAULT_SETTINGS.unifiedTriggers,
                    autoSyncIntervalSec: 60,
                },
            });
            const tm = new TriggerManager(deps);
            tm.setupAutoSyncInterval();
            tm.setupAutoSyncInterval();

            expect(clearSpy).toHaveBeenCalled();
        });
    });

    describe("setReady / triggerSmartSync gate", () => {
        it("should NOT trigger sync when not ready", () => {
            const { deps, syncManager } = createMockDeps({
                triggerConfigStrategy: "unified",
                unifiedTriggers: {
                    ...DEFAULT_SETTINGS.unifiedTriggers,
                    autoSyncIntervalSec: 10,
                },
            });
            const tm = new TriggerManager(deps);
            // Default isReady = false
            tm.setupAutoSyncInterval();

            vi.advanceTimersByTime(10_000);
            expect(syncManager.requestSmartSync).not.toHaveBeenCalled();
        });

        it("should trigger sync after setReady(true)", async () => {
            const { deps, syncManager } = createMockDeps({
                triggerConfigStrategy: "unified",
                unifiedTriggers: {
                    ...DEFAULT_SETTINGS.unifiedTriggers,
                    autoSyncIntervalSec: 10,
                },
            });
            const tm = new TriggerManager(deps);
            tm.setReady(true);
            tm.setupAutoSyncInterval();

            vi.advanceTimersByTime(10_000);
            // Flush microtasks for async triggerSmartSync -> requestSmartSync
            await new Promise((r) => process.nextTick(r));
            await new Promise((r) => process.nextTick(r));
            expect(syncManager.requestSmartSync).toHaveBeenCalled();
        });
    });

    describe("interval suppression during active editing", () => {
        it("should suppress interval trigger when user was editing recently", () => {
            const { deps, syncManager } = createMockDeps({
                triggerConfigStrategy: "unified",
                unifiedTriggers: {
                    ...DEFAULT_SETTINGS.unifiedTriggers,
                    autoSyncIntervalSec: 30,
                    onModifyDelaySec: 10,
                },
            });
            const tm = new TriggerManager(deps);
            tm.setReady(true);

            // Simulate recent editing by setting lastModifyTime via the private field
            (tm as any).lastModifyTime = Date.now();

            tm.setupAutoSyncInterval();

            // Interval fires but editing was very recent
            vi.advanceTimersByTime(30_000);
            expect(syncManager.requestSmartSync).not.toHaveBeenCalled();
        });
    });

    describe("destroy", () => {
        it("should clear auto-sync interval", () => {
            const clearSpy = vi.spyOn(window, "clearInterval");
            const { deps } = createMockDeps({
                triggerConfigStrategy: "unified",
                unifiedTriggers: {
                    ...DEFAULT_SETTINGS.unifiedTriggers,
                    autoSyncIntervalSec: 60,
                },
            });
            const tm = new TriggerManager(deps);
            tm.setupAutoSyncInterval();

            tm.destroy();

            expect(clearSpy).toHaveBeenCalled();
            expect((tm as any).autoSyncInterval).toBeNull();
        });
    });
});
