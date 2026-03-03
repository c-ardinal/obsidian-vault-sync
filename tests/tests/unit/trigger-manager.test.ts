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
 * - registerTriggers: 全イベントハンドラーの登録と動作
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TriggerManager } from "../../../src/services/trigger-manager";
import { DEFAULT_SETTINGS, SETTINGS_LIMITS } from "../../../src/constants";
import { TFile, TFolder } from "../../../tests/__mocks__/obsidian";

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

    // Store event handlers for triggering during tests
    const eventHandlers: Record<string, any[]> = {
        modify: [],
        create: [],
        delete: [],
        rename: [],
        "layout-change": [],
    };

    const mockWorkspace = {
        on: vi.fn((event: string, cb: any) => {
            if (!eventHandlers[event]) eventHandlers[event] = [];
            eventHandlers[event].push(cb);
            return { unref: vi.fn() };
        }),
        onLayoutReady: vi.fn((cb: any) => {
            // Store the callback and optionally auto-execute for tests
            mockWorkspace._layoutReadyCallback = cb;
        }),
        _layoutReadyCallback: null as any,
        _triggerLayoutReady: async () => {
            if (mockWorkspace._layoutReadyCallback) {
                await mockWorkspace._layoutReadyCallback();
            }
        },
    };

    const mockVault = {
        on: vi.fn((event: string, cb: any) => {
            if (!eventHandlers[event]) eventHandlers[event] = [];
            eventHandlers[event].push(cb);
            return { unref: vi.fn() };
        }),
    };

    return {
        deps: {
            app: {
                workspace: mockWorkspace,
                vault: mockVault,
                commands: {
                    commands: {} as Record<string, any>,
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
        eventHandlers,
        workspace: mockWorkspace,
        vault: mockVault,
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

        it("should return mobileTriggers when on mobile", async () => {
            const { Platform } = await import("../../../tests/__mocks__/obsidian");
            const originalIsMobile = Platform.isMobile;
            const originalIsDesktop = Platform.isDesktop;
            Platform.isMobile = true;
            Platform.isDesktop = false;

            const { deps } = createMockDeps({
                triggerConfigStrategy: "per-platform",
                mobileTriggers: { autoSyncIntervalSec: 300 },
                desktopTriggers: { autoSyncIntervalSec: 600 },
            });
            const tm = new TriggerManager(deps);
            expect(tm.currentTriggers.autoSyncIntervalSec).toBe(300);

            // Restore
            Platform.isMobile = originalIsMobile;
            Platform.isDesktop = originalIsDesktop;
        });

        it("should return desktopTriggers when on desktop", async () => {
            const { Platform } = await import("../../../tests/__mocks__/obsidian");
            const originalIsMobile = Platform.isMobile;
            const originalIsDesktop = Platform.isDesktop;
            Platform.isMobile = false;
            Platform.isDesktop = true;

            const { deps } = createMockDeps({
                triggerConfigStrategy: "per-platform",
                mobileTriggers: { autoSyncIntervalSec: 300 },
                desktopTriggers: { autoSyncIntervalSec: 600 },
            });
            const tm = new TriggerManager(deps);
            expect(tm.currentTriggers.autoSyncIntervalSec).toBe(600);

            // Restore
            Platform.isMobile = originalIsMobile;
            Platform.isDesktop = originalIsDesktop;
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

        it("should not throw when destroying without interval", () => {
            const { deps } = createMockDeps({
                triggerConfigStrategy: "unified",
                unifiedTriggers: {
                    ...DEFAULT_SETTINGS.unifiedTriggers,
                    autoSyncIntervalSec: SETTINGS_LIMITS.autoSyncInterval.disabled,
                },
            });
            const tm = new TriggerManager(deps);
            // autoSyncInterval is null by default

            expect(() => tm.destroy()).not.toThrow();
        });
    });

    describe("registerTriggers - save command hook", () => {
        it("should intercept 'editor:save' command callback", async () => {
            const { deps, syncManager, workspace } = createMockDeps({
                triggerConfigStrategy: "unified",
                unifiedTriggers: {
                    ...DEFAULT_SETTINGS.unifiedTriggers,
                    onSaveDelaySec: 0,
                },
            });

            // Setup command with callback
            const originalCallback = vi.fn();
            deps.app.commands.commands["editor:save"] = {
                callback: originalCallback,
            };

            const tm = new TriggerManager(deps);
            tm.setReady(true);
            tm.registerTriggers();

            // Trigger onLayoutReady
            await workspace._triggerLayoutReady();

            // Now call the hooked callback
            const hookedCmd = deps.app.commands.commands["editor:save"];
            await hookedCmd.callback();

            await new Promise((r) => process.nextTick(r));

            expect(syncManager.log).toHaveBeenCalledWith(
                expect.stringContaining("Manual save detected"),
                "system",
            );
            expect(syncManager.requestSmartSync).toHaveBeenCalled();
            expect(originalCallback).toHaveBeenCalled();
        });

        it("should intercept checkCallback commands", async () => {
            const { deps, syncManager, workspace } = createMockDeps({
                triggerConfigStrategy: "unified",
                unifiedTriggers: {
                    ...DEFAULT_SETTINGS.unifiedTriggers,
                    onSaveDelaySec: 0,
                },
            });

            // Setup command with checkCallback
            const originalCheckCallback = vi.fn(() => true);
            deps.app.commands.commands["editor:save"] = {
                checkCallback: originalCheckCallback,
            };

            const tm = new TriggerManager(deps);
            tm.setReady(true);
            tm.registerTriggers();

            // Trigger onLayoutReady
            await workspace._triggerLayoutReady();

            // Call with checking=false to trigger save
            const hookedCmd = deps.app.commands.commands["editor:save"];
            await hookedCmd.checkCallback(false);

            await new Promise((r) => process.nextTick(r));

            expect(syncManager.log).toHaveBeenCalledWith(
                expect.stringContaining("Manual save detected (check)"),
                "system",
            );
            expect(syncManager.requestSmartSync).toHaveBeenCalled();
        });

        it("should not trigger save when checkCallback is called with checking=true", async () => {
            const { deps, syncManager, workspace } = createMockDeps({
                triggerConfigStrategy: "unified",
                unifiedTriggers: {
                    ...DEFAULT_SETTINGS.unifiedTriggers,
                    onSaveDelaySec: 0,
                },
            });

            // Setup command with checkCallback
            const originalCheckCallback = vi.fn(() => true);
            deps.app.commands.commands["editor:save"] = {
                checkCallback: originalCheckCallback,
            };

            const tm = new TriggerManager(deps);
            tm.setReady(true);
            tm.registerTriggers();

            // Trigger onLayoutReady
            await workspace._triggerLayoutReady();

            // Call with checking=true - should NOT trigger save
            const hookedCmd = deps.app.commands.commands["editor:save"];
            const result = await hookedCmd.checkCallback(true);

            await new Promise((r) => process.nextTick(r));

            expect(originalCheckCallback).toHaveBeenCalledWith(true);
            expect(syncManager.log).not.toHaveBeenCalledWith(
                expect.stringContaining("Manual save detected (check)"),
                "system",
            );
            expect(syncManager.requestSmartSync).not.toHaveBeenCalled();
            expect(result).toBe(true);
        });

        it("should schedule delayed sync on checkCallback command with delay>0", async () => {
            const { deps, syncManager, workspace } = createMockDeps({
                triggerConfigStrategy: "unified",
                unifiedTriggers: {
                    ...DEFAULT_SETTINGS.unifiedTriggers,
                    onSaveDelaySec: 3,
                },
            });

            // Setup command with checkCallback
            const originalCheckCallback = vi.fn(() => true);
            deps.app.commands.commands["editor:save"] = {
                checkCallback: originalCheckCallback,
            };

            const tm = new TriggerManager(deps);
            tm.setReady(true);
            tm.registerTriggers();

            // Trigger onLayoutReady
            await workspace._triggerLayoutReady();

            // Call with checking=false to trigger save
            const hookedCmd = deps.app.commands.commands["editor:save"];
            await hookedCmd.checkCallback(false);

            await new Promise((r) => process.nextTick(r));

            // Should not trigger immediately
            expect(syncManager.requestSmartSync).not.toHaveBeenCalled();

            // Advance timer
            vi.advanceTimersByTime(3_000);
            await new Promise((r) => process.nextTick(r));

            expect(syncManager.requestSmartSync).toHaveBeenCalledWith("save-sync");
        });

        it("should trigger sync on save with delay=0", async () => {
            const { deps, syncManager, workspace } = createMockDeps({
                triggerConfigStrategy: "unified",
                unifiedTriggers: {
                    ...DEFAULT_SETTINGS.unifiedTriggers,
                    onSaveDelaySec: 0,
                },
            });

            deps.app.commands.commands["editor:save"] = {
                callback: vi.fn(),
            };

            const tm = new TriggerManager(deps);
            tm.setReady(true);
            tm.registerTriggers();

            await workspace._triggerLayoutReady();

            const hookedCmd = deps.app.commands.commands["editor:save"];
            await hookedCmd.callback();

            await new Promise((r) => process.nextTick(r));

            expect(syncManager.requestSmartSync).toHaveBeenCalledWith("save-sync");
        });

        it("should schedule delayed sync on save with delay>0", async () => {
            const { deps, syncManager, workspace } = createMockDeps({
                triggerConfigStrategy: "unified",
                unifiedTriggers: {
                    ...DEFAULT_SETTINGS.unifiedTriggers,
                    onSaveDelaySec: 5,
                },
            });

            deps.app.commands.commands["editor:save"] = {
                callback: vi.fn(),
            };

            const tm = new TriggerManager(deps);
            tm.setReady(true);
            tm.registerTriggers();

            await workspace._triggerLayoutReady();

            const hookedCmd = deps.app.commands.commands["editor:save"];
            await hookedCmd.callback();

            await new Promise((r) => process.nextTick(r));

            // Should not trigger immediately
            expect(syncManager.requestSmartSync).not.toHaveBeenCalled();

            // Advance timer
            vi.advanceTimersByTime(5_000);
            await new Promise((r) => process.nextTick(r));

            expect(syncManager.requestSmartSync).toHaveBeenCalledWith("save-sync");
        });

        it("should not double-hook commands", async () => {
            const { deps, workspace } = createMockDeps({
                triggerConfigStrategy: "unified",
                unifiedTriggers: {
                    ...DEFAULT_SETTINGS.unifiedTriggers,
                    onSaveDelaySec: 0,
                },
            });

            const originalCallback = vi.fn();
            deps.app.commands.commands["editor:save"] = {
                callback: originalCallback,
            };

            const tm = new TriggerManager(deps);
            tm.setReady(true);
            tm.registerTriggers();

            await workspace._triggerLayoutReady();

            const hookedCmd = deps.app.commands.commands["editor:save"];
            expect(hookedCmd._isVaultSyncHooked).toBe(true);

            // Try to register again
            tm.registerTriggers();
            await workspace._triggerLayoutReady();

            // Should still be hooked only once
            expect(deps.app.commands.commands["editor:save"].callback).toBe(hookedCmd.callback);
        });

        it("should handle other save commands (containing 'save')", async () => {
            const { deps, syncManager, workspace } = createMockDeps({
                triggerConfigStrategy: "unified",
                unifiedTriggers: {
                    ...DEFAULT_SETTINGS.unifiedTriggers,
                    onSaveDelaySec: 0,
                },
            });

            deps.app.commands.commands["custom:save-file"] = {
                callback: vi.fn(),
            };
            deps.app.commands.commands["save-all"] = {
                callback: vi.fn(),
            };

            const tm = new TriggerManager(deps);
            tm.setReady(true);
            tm.registerTriggers();

            await workspace._triggerLayoutReady();

            // Both commands should be hooked
            expect(deps.app.commands.commands["custom:save-file"]._isVaultSyncHooked).toBe(true);
            expect(deps.app.commands.commands["save-all"]._isVaultSyncHooked).toBe(true);

            await deps.app.commands.commands["custom:save-file"].callback();
            await new Promise((r) => process.nextTick(r));

            expect(syncManager.log).toHaveBeenCalledWith(
                expect.stringContaining("custom:save-file"),
                "system",
            );
        });

        it("should handle missing commands object gracefully", async () => {
            const { deps, workspace } = createMockDeps({
                triggerConfigStrategy: "unified",
                unifiedTriggers: DEFAULT_SETTINGS.unifiedTriggers,
            });

            // Remove commands object
            (deps.app as any).commands = undefined;

            const tm = new TriggerManager(deps);
            tm.setReady(true);

            // Should not throw
            expect(() => tm.registerTriggers()).not.toThrow();

            // onLayoutReady should still be called but return early
            await workspace._triggerLayoutReady();
        });

        it("should skip commands that have neither callback nor checkCallback", async () => {
            const { deps, workspace } = createMockDeps({
                triggerConfigStrategy: "unified",
                unifiedTriggers: DEFAULT_SETTINGS.unifiedTriggers,
            });

            // Add a command with neither callback nor checkCallback
            deps.app.commands.commands["editor:save"] = {
                name: "Save",
                // No callback or checkCallback
            };

            const tm = new TriggerManager(deps);
            tm.setReady(true);
            tm.registerTriggers();

            await workspace._triggerLayoutReady();

            // Should be marked as hooked but no callback modification
            expect(deps.app.commands.commands["editor:save"]._isVaultSyncHooked).toBe(true);
            expect(deps.app.commands.commands["editor:save"].callback).toBeUndefined();
            expect(deps.app.commands.commands["editor:save"].checkCallback).toBeUndefined();
        });
    });

    describe("registerTriggers - modify event", () => {
        it("should mark file dirty on modify", async () => {
            const { deps, syncManager, eventHandlers } = createMockDeps({
                triggerConfigStrategy: "unified",
                unifiedTriggers: {
                    ...DEFAULT_SETTINGS.unifiedTriggers,
                    onModifyDelaySec: 5,
                },
            });

            const tm = new TriggerManager(deps);
            tm.setReady(true);
            tm.registerTriggers();

            const file = new TFile();
            file.path = "test.md";

            // Trigger modify event
            for (const handler of eventHandlers.modify) {
                await handler(file);
            }

            expect(syncManager.markDirty).toHaveBeenCalledWith("test.md");
        });

        it("should trigger sync after debounce timeout", async () => {
            const { deps, syncManager, eventHandlers } = createMockDeps({
                triggerConfigStrategy: "unified",
                unifiedTriggers: {
                    ...DEFAULT_SETTINGS.unifiedTriggers,
                    onModifyDelaySec: 3,
                },
            });

            const tm = new TriggerManager(deps);
            tm.setReady(true);
            tm.registerTriggers();

            const file = new TFile();
            file.path = "test.md";

            // Trigger modify event
            for (const handler of eventHandlers.modify) {
                await handler(file);
            }

            // Should not trigger immediately
            expect(syncManager.requestSmartSync).not.toHaveBeenCalled();

            // Advance timer
            vi.advanceTimersByTime(3_000);
            await new Promise((r) => process.nextTick(r));

            expect(syncManager.requestSmartSync).toHaveBeenCalledWith("modify-sync");
        });

        it("should fast-track if recent save (within 5s)", async () => {
            const { deps, syncManager, workspace, eventHandlers } = createMockDeps({
                triggerConfigStrategy: "unified",
                unifiedTriggers: {
                    ...DEFAULT_SETTINGS.unifiedTriggers,
                    onSaveDelaySec: 0,
                    onModifyDelaySec: 10,
                },
            });

            deps.app.commands.commands["editor:save"] = {
                callback: vi.fn(),
            };

            const tm = new TriggerManager(deps);
            tm.setReady(true);
            tm.registerTriggers();

            await workspace._triggerLayoutReady();

            // Trigger save first
            await deps.app.commands.commands["editor:save"].callback();
            await new Promise((r) => process.nextTick(r));

            // Reset mock to check for fast-track
            syncManager.requestSmartSync.mockClear();

            const file = new TFile();
            file.path = "test.md";

            // Trigger modify event immediately after save
            for (const handler of eventHandlers.modify) {
                await handler(file);
            }

            await new Promise((r) => process.nextTick(r));

            expect(syncManager.log).toHaveBeenCalledWith(
                expect.stringContaining("Fast-tracking sync due to recent save"),
                "system",
            );
            expect(syncManager.requestSmartSync).toHaveBeenCalledWith("save-sync");
        });

        it("should not trigger if onModifyDelaySec is disabled", async () => {
            const { deps, syncManager, eventHandlers } = createMockDeps({
                triggerConfigStrategy: "unified",
                unifiedTriggers: {
                    ...DEFAULT_SETTINGS.unifiedTriggers,
                    onModifyDelaySec: SETTINGS_LIMITS.onModifyDelay.disabled,
                },
            });

            const tm = new TriggerManager(deps);
            tm.setReady(true);
            tm.registerTriggers();

            const file = new TFile();
            file.path = "test.md";

            // Trigger modify event
            for (const handler of eventHandlers.modify) {
                await handler(file);
            }

            // Advance timer - should still not trigger
            vi.advanceTimersByTime(60_000);
            await new Promise((r) => process.nextTick(r));

            expect(syncManager.requestSmartSync).not.toHaveBeenCalled();
        });

        it("should ignore files that should be ignored", async () => {
            const { deps, syncManager, eventHandlers } = createMockDeps({
                triggerConfigStrategy: "unified",
                unifiedTriggers: {
                    ...DEFAULT_SETTINGS.unifiedTriggers,
                    onModifyDelaySec: 5,
                },
            });

            syncManager.shouldIgnore.mockReturnValue(true);

            const tm = new TriggerManager(deps);
            tm.setReady(true);
            tm.registerTriggers();

            const file = new TFile();
            file.path = ".git/config";

            // Trigger modify event
            for (const handler of eventHandlers.modify) {
                await handler(file);
            }

            expect(syncManager.shouldIgnore).toHaveBeenCalledWith(".git/config");
            expect(syncManager.markDirty).not.toHaveBeenCalled();
        });

        it("should reset debounce timer on multiple modifies", async () => {
            const { deps, syncManager, eventHandlers } = createMockDeps({
                triggerConfigStrategy: "unified",
                unifiedTriggers: {
                    ...DEFAULT_SETTINGS.unifiedTriggers,
                    onModifyDelaySec: 5,
                },
            });

            const tm = new TriggerManager(deps);
            tm.setReady(true);
            tm.registerTriggers();

            const file = new TFile();
            file.path = "test.md";

            // First modify
            for (const handler of eventHandlers.modify) {
                await handler(file);
            }

            // Advance partially
            vi.advanceTimersByTime(3_000);

            // Second modify resets timer
            for (const handler of eventHandlers.modify) {
                await handler(file);
            }

            // Advance remaining time from first (should not trigger)
            vi.advanceTimersByTime(3_000);
            await new Promise((r) => process.nextTick(r));
            expect(syncManager.requestSmartSync).not.toHaveBeenCalled();

            // Now advance full debounce from second modify
            vi.advanceTimersByTime(5_000);
            await new Promise((r) => process.nextTick(r));
            expect(syncManager.requestSmartSync).toHaveBeenCalledTimes(1);
        });

        it("should ignore non-TFile in modify event", async () => {
            const { deps, syncManager, eventHandlers } = createMockDeps({
                triggerConfigStrategy: "unified",
                unifiedTriggers: DEFAULT_SETTINGS.unifiedTriggers,
            });

            const tm = new TriggerManager(deps);
            tm.setReady(true);
            tm.registerTriggers();

            // Create a folder (not a TFile)
            const folder = new TFolder();
            folder.path = "some-folder";

            // Trigger modify event with folder
            for (const handler of eventHandlers.modify) {
                await handler(folder);
            }

            expect(syncManager.markDirty).not.toHaveBeenCalled();
        });

        it("should not process modify event when !isReady", async () => {
            const { deps, syncManager, eventHandlers } = createMockDeps({
                triggerConfigStrategy: "unified",
                unifiedTriggers: DEFAULT_SETTINGS.unifiedTriggers,
            });

            const tm = new TriggerManager(deps);
            // isReady is false by default
            tm.registerTriggers();

            const file = new TFile();
            file.path = "test.md";

            // Trigger modify event
            for (const handler of eventHandlers.modify) {
                await handler(file);
            }

            expect(syncManager.markDirty).not.toHaveBeenCalled();
        });

        it("should clear existing modify timeout during fast-track", async () => {
            const { deps, syncManager, workspace, eventHandlers } = createMockDeps({
                triggerConfigStrategy: "unified",
                unifiedTriggers: {
                    ...DEFAULT_SETTINGS.unifiedTriggers,
                    onSaveDelaySec: 0,
                    onModifyDelaySec: 10,
                },
            });

            deps.app.commands.commands["editor:save"] = {
                callback: vi.fn(),
            };

            const tm = new TriggerManager(deps);
            tm.setReady(true);
            tm.registerTriggers();

            await workspace._triggerLayoutReady();

            const file = new TFile();
            file.path = "test.md";

            // First, trigger a modify event (sets up a debounce timeout)
            for (const handler of eventHandlers.modify) {
                await handler(file);
            }

            await new Promise((r) => process.nextTick(r));

            // Now trigger a save (fast-track should clear the timeout)
            await deps.app.commands.commands["editor:save"].callback();
            await new Promise((r) => process.nextTick(r));

            // Reset mocks
            syncManager.requestSmartSync.mockClear();

            // Now trigger another modify immediately (within 5s of save)
            for (const handler of eventHandlers.modify) {
                await handler(file);
            }

            await new Promise((r) => process.nextTick(r));

            // Should have fast-tracked immediately, not waited for debounce
            expect(syncManager.requestSmartSync).toHaveBeenCalledWith("save-sync");
        });
    });

    describe("registerTriggers - create/delete/rename", () => {
        it("should mark dirty on create", () => {
            const { deps, syncManager, eventHandlers } = createMockDeps({
                triggerConfigStrategy: "unified",
                unifiedTriggers: DEFAULT_SETTINGS.unifiedTriggers,
            });

            const tm = new TriggerManager(deps);
            tm.setReady(true);
            tm.registerTriggers();

            const file = new TFile();
            file.path = "new-file.md";

            // Trigger create event
            for (const handler of eventHandlers.create) {
                handler(file);
            }

            expect(syncManager.markDirty).toHaveBeenCalledWith("new-file.md");
        });

        it("should mark deleted on file delete", () => {
            const { deps, syncManager, eventHandlers } = createMockDeps({
                triggerConfigStrategy: "unified",
                unifiedTriggers: DEFAULT_SETTINGS.unifiedTriggers,
            });

            const tm = new TriggerManager(deps);
            tm.setReady(true);
            tm.registerTriggers();

            const file = new TFile();
            file.path = "deleted-file.md";

            // Trigger delete event
            for (const handler of eventHandlers.delete) {
                handler(file);
            }

            expect(syncManager.markDeleted).toHaveBeenCalledWith("deleted-file.md");
        });

        it("should mark folder deleted on folder delete", () => {
            const { deps, syncManager, eventHandlers } = createMockDeps({
                triggerConfigStrategy: "unified",
                unifiedTriggers: DEFAULT_SETTINGS.unifiedTriggers,
            });

            const tm = new TriggerManager(deps);
            tm.setReady(true);
            tm.registerTriggers();

            const folder = new TFolder();
            folder.path = "deleted-folder";

            // Trigger delete event
            for (const handler of eventHandlers.delete) {
                handler(folder);
            }

            expect(syncManager.markFolderDeleted).toHaveBeenCalledWith("deleted-folder");
        });

        it("should mark renamed on file rename", () => {
            const { deps, syncManager, eventHandlers } = createMockDeps({
                triggerConfigStrategy: "unified",
                unifiedTriggers: DEFAULT_SETTINGS.unifiedTriggers,
            });

            const tm = new TriggerManager(deps);
            tm.setReady(true);
            tm.registerTriggers();

            const file = new TFile();
            file.path = "new-name.md";

            // Trigger rename event
            for (const handler of eventHandlers.rename) {
                handler(file, "old-name.md");
            }

            expect(syncManager.markRenamed).toHaveBeenCalledWith("old-name.md", "new-name.md");
        });

        it("should mark folder renamed on folder rename", () => {
            const { deps, syncManager, eventHandlers } = createMockDeps({
                triggerConfigStrategy: "unified",
                unifiedTriggers: DEFAULT_SETTINGS.unifiedTriggers,
            });

            const tm = new TriggerManager(deps);
            tm.setReady(true);
            tm.registerTriggers();

            const folder = new TFolder();
            folder.path = "new-folder";

            // Trigger rename event
            for (const handler of eventHandlers.rename) {
                handler(folder, "old-folder");
            }

            expect(syncManager.markFolderRenamed).toHaveBeenCalledWith("old-folder", "new-folder");
        });

        it("should not trigger create when !isReady", () => {
            const { deps, syncManager, eventHandlers } = createMockDeps({
                triggerConfigStrategy: "unified",
                unifiedTriggers: DEFAULT_SETTINGS.unifiedTriggers,
            });

            const tm = new TriggerManager(deps);
            // isReady is false by default
            tm.registerTriggers();

            const file = new TFile();
            file.path = "new-file.md";

            // Trigger create event
            for (const handler of eventHandlers.create) {
                handler(file);
            }

            expect(syncManager.markDirty).not.toHaveBeenCalled();
        });

        it("should not trigger delete when !isReady", () => {
            const { deps, syncManager, eventHandlers } = createMockDeps({
                triggerConfigStrategy: "unified",
                unifiedTriggers: DEFAULT_SETTINGS.unifiedTriggers,
            });

            const tm = new TriggerManager(deps);
            tm.registerTriggers();

            const file = new TFile();
            file.path = "deleted-file.md";

            // Trigger delete event
            for (const handler of eventHandlers.delete) {
                handler(file);
            }

            expect(syncManager.markDeleted).not.toHaveBeenCalled();
        });

        it("should not trigger rename when !isReady", () => {
            const { deps, syncManager, eventHandlers } = createMockDeps({
                triggerConfigStrategy: "unified",
                unifiedTriggers: DEFAULT_SETTINGS.unifiedTriggers,
            });

            const tm = new TriggerManager(deps);
            tm.registerTriggers();

            const file = new TFile();
            file.path = "new-name.md";

            // Trigger rename event
            for (const handler of eventHandlers.rename) {
                handler(file, "old-name.md");
            }

            expect(syncManager.markRenamed).not.toHaveBeenCalled();
        });

        it("should not trigger create for ignored files", () => {
            const { deps, syncManager, eventHandlers } = createMockDeps({
                triggerConfigStrategy: "unified",
                unifiedTriggers: DEFAULT_SETTINGS.unifiedTriggers,
            });

            syncManager.shouldIgnore.mockReturnValue(true);

            const tm = new TriggerManager(deps);
            tm.setReady(true);
            tm.registerTriggers();

            const file = new TFile();
            file.path = ".gitignore";

            // Trigger create event
            for (const handler of eventHandlers.create) {
                handler(file);
            }

            expect(syncManager.markDirty).not.toHaveBeenCalled();
        });
    });

    describe("registerTriggers - layout-change", () => {
        it("should trigger sync on layout-change with delay=0", async () => {
            const { deps, syncManager, eventHandlers } = createMockDeps({
                triggerConfigStrategy: "unified",
                unifiedTriggers: {
                    ...DEFAULT_SETTINGS.unifiedTriggers,
                    onLayoutChangeDelaySec: 0,
                },
            });

            const tm = new TriggerManager(deps);
            tm.setReady(true);
            tm.registerTriggers();

            // Trigger layout-change event
            for (const handler of eventHandlers["layout-change"]) {
                handler();
            }

            await new Promise((r) => process.nextTick(r));

            expect(syncManager.requestSmartSync).toHaveBeenCalledWith("layout-sync");
        });

        it("should schedule delayed sync with delay>0", async () => {
            const { deps, syncManager, eventHandlers } = createMockDeps({
                triggerConfigStrategy: "unified",
                unifiedTriggers: {
                    ...DEFAULT_SETTINGS.unifiedTriggers,
                    onLayoutChangeDelaySec: 2,
                },
            });

            const tm = new TriggerManager(deps);
            tm.setReady(true);
            tm.registerTriggers();

            // Trigger layout-change event
            for (const handler of eventHandlers["layout-change"]) {
                handler();
            }

            // Should not trigger immediately
            expect(syncManager.requestSmartSync).not.toHaveBeenCalled();

            // Advance timer
            vi.advanceTimersByTime(2_000);
            await new Promise((r) => process.nextTick(r));

            expect(syncManager.requestSmartSync).toHaveBeenCalledWith("layout-sync");
        });

        it("should not trigger if disabled", async () => {
            const { deps, syncManager, eventHandlers } = createMockDeps({
                triggerConfigStrategy: "unified",
                unifiedTriggers: {
                    ...DEFAULT_SETTINGS.unifiedTriggers,
                    onLayoutChangeDelaySec: SETTINGS_LIMITS.onLayoutChangeDelay.disabled,
                },
            });

            const tm = new TriggerManager(deps);
            tm.setReady(true);
            tm.registerTriggers();

            // Trigger layout-change event
            for (const handler of eventHandlers["layout-change"]) {
                handler();
            }

            // Advance timer
            vi.advanceTimersByTime(60_000);
            await new Promise((r) => process.nextTick(r));

            expect(syncManager.requestSmartSync).not.toHaveBeenCalled();
        });

        it("should not trigger when !isReady", () => {
            const { deps, syncManager, eventHandlers } = createMockDeps({
                triggerConfigStrategy: "unified",
                unifiedTriggers: {
                    ...DEFAULT_SETTINGS.unifiedTriggers,
                    onLayoutChangeDelaySec: 0,
                },
            });

            const tm = new TriggerManager(deps);
            tm.registerTriggers();

            // Trigger layout-change event
            for (const handler of eventHandlers["layout-change"]) {
                handler();
            }

            expect(syncManager.requestSmartSync).not.toHaveBeenCalled();
        });
    });

    describe("triggerSmartSync edge cases", () => {
        it("should suppress interval trigger during active editing", async () => {
            const { deps, syncManager, eventHandlers } = createMockDeps({
                triggerConfigStrategy: "unified",
                unifiedTriggers: {
                    ...DEFAULT_SETTINGS.unifiedTriggers,
                    autoSyncIntervalSec: 30,
                    onModifyDelaySec: 10,
                },
            });

            const tm = new TriggerManager(deps);
            tm.setReady(true);
            tm.registerTriggers();

            // Setup auto sync interval
            tm.setupAutoSyncInterval();

            // Advance time to simulate running system
            vi.advanceTimersByTime(1000);

            // Simulate active editing by triggering modify
            const file = new TFile();
            file.path = "editing.md";

            for (const handler of eventHandlers.modify) {
                await handler(file);
            }

            await new Promise((r) => process.nextTick(r));

            // Reset mocks to check interval behavior
            syncManager.requestSmartSync.mockClear();
            syncManager.log.mockClear();

            // Advance only 5 seconds (less than onModifyDelaySec=10s)
            // This simulates the interval firing while user is still editing
            vi.advanceTimersByTime(5_000);

            // Manually trigger the interval callback to test suppression
            // (the interval is set to 30s, so it won't fire naturally yet)
            // Instead, we'll directly call the private triggerSmartSync method with "interval"
            await (tm as any).triggerSmartSync("interval");

            expect(syncManager.log).toHaveBeenCalledWith(
                expect.stringContaining("Skipped interval trigger"),
                "system",
            );
            expect(syncManager.requestSmartSync).not.toHaveBeenCalled();
        });

        it("should queue low-priority when already syncing", async () => {
            const { deps, syncManager } = createMockDeps({
                triggerConfigStrategy: "unified",
                unifiedTriggers: {
                    ...DEFAULT_SETTINGS.unifiedTriggers,
                    autoSyncIntervalSec: 30,
                },
            });

            syncManager.isSyncing.mockReturnValue(true);

            const tm = new TriggerManager(deps);
            tm.setReady(true);
            tm.setupAutoSyncInterval();

            // Fire interval
            vi.advanceTimersByTime(30_000);
            await new Promise((r) => process.nextTick(r));
            await new Promise((r) => process.nextTick(r));

            expect(syncManager.requestSmartSync).toHaveBeenCalledWith("timer-sync");
        });

        it("should not trigger when !isReady via interval", async () => {
            const { deps, syncManager } = createMockDeps({
                triggerConfigStrategy: "unified",
                unifiedTriggers: {
                    ...DEFAULT_SETTINGS.unifiedTriggers,
                    autoSyncIntervalSec: 10,
                },
            });

            const tm = new TriggerManager(deps);
            // isReady is false by default
            tm.setupAutoSyncInterval();

            vi.advanceTimersByTime(10_000);
            await new Promise((r) => process.nextTick(r));

            expect(syncManager.requestSmartSync).not.toHaveBeenCalled();
        });

        it("should not trigger when !isReady via layout-change", async () => {
            const { deps, syncManager, eventHandlers } = createMockDeps({
                triggerConfigStrategy: "unified",
                unifiedTriggers: {
                    ...DEFAULT_SETTINGS.unifiedTriggers,
                    onLayoutChangeDelaySec: 0,
                },
            });

            const tm = new TriggerManager(deps);
            tm.registerTriggers();

            // Trigger layout-change event
            for (const handler of eventHandlers["layout-change"]) {
                handler();
            }

            expect(syncManager.requestSmartSync).not.toHaveBeenCalled();
        });

        it("should use default trigger for unknown source", async () => {
            const { deps, syncManager } = createMockDeps({
                triggerConfigStrategy: "unified",
                unifiedTriggers: DEFAULT_SETTINGS.unifiedTriggers,
            });

            const tm = new TriggerManager(deps);
            tm.setReady(true);

            // Directly call triggerSmartSync with an unknown source
            await (tm as any).triggerSmartSync("unknown-source");

            expect(syncManager.log).toHaveBeenCalledWith(
                expect.stringContaining("Activated via unknown-source"),
                "system",
            );
            // Should fall back to "timer-sync" trigger type
            expect(syncManager.requestSmartSync).toHaveBeenCalledWith("timer-sync");
        });
    });
});
