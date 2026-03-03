import { App, TFile, Platform } from "obsidian";
import type { SyncManager, SyncTrigger } from "../sync-manager";
import type { VaultSyncSettings, TriggerSettings } from "../types/settings";
import { DEFAULT_SETTINGS, SETTINGS_LIMITS } from "../constants";

interface TriggerManagerDeps {
    app: App;
    settings: VaultSyncSettings;
    syncManager: SyncManager;
    registerEvent: (evt: import("obsidian").EventRef) => void;
    registerInterval: (id: number) => void;
}

/**
 * Manages sync triggers: save hooks, modify debounce, interval timer,
 * layout-change events, and file create/delete/rename tracking.
 *
 * Extracted from the main Vault-Sync plugin class to separate
 * trigger management from plugin lifecycle orchestration.
 */
export class TriggerManager {
    private isReady = false;
    private lastSaveRequestTime = 0;
    private lastModifyTime = 0;
    private autoSyncInterval: number | null = null;

    private static readonly TRIGGER_MAP: Record<string, SyncTrigger> = {
        interval: "timer-sync",
        save: "save-sync",
        modify: "modify-sync",
        "layout-change": "layout-sync",
    };

    constructor(private deps: TriggerManagerDeps) {}

    get currentTriggers(): TriggerSettings {
        const settings = this.deps.settings;
        if (!settings) return DEFAULT_SETTINGS.unifiedTriggers;
        if (settings.triggerConfigStrategy === "unified") {
            return settings.unifiedTriggers;
        }
        return Platform.isMobile ? settings.mobileTriggers : settings.desktopTriggers;
    }

    setReady(ready: boolean): void {
        this.isReady = ready;
    }

    setupAutoSyncInterval(): void {
        if (this.autoSyncInterval) {
            window.clearInterval(this.autoSyncInterval);
            this.autoSyncInterval = null;
        }

        if (
            this.currentTriggers.autoSyncIntervalSec !==
                SETTINGS_LIMITS.autoSyncInterval.disabled &&
            this.currentTriggers.autoSyncIntervalSec >= SETTINGS_LIMITS.autoSyncInterval.min
        ) {
            this.autoSyncInterval = window.setInterval(() => {
                this.triggerSmartSync("interval");
            }, this.currentTriggers.autoSyncIntervalSec * 1000);
            this.deps.registerInterval(this.autoSyncInterval);
        }
    }

    registerTriggers(): void {
        const { app, syncManager } = this.deps;

        // Save Trigger (Obsidian Command Hook)
        app.workspace.onLayoutReady(async () => {
            const commands = (app as any).commands?.commands;
            if (!commands) return;

            // Broad discovery: catch editor:save and any other custom save commands
            const targetIds = Object.keys(commands).filter(
                (id) => id === "editor:save" || id.includes(":save") || id.includes("save-"),
            );

            targetIds.forEach((id) => {
                const cmd = commands[id];
                if (cmd && !cmd._isVaultSyncHooked) {
                    cmd._isVaultSyncHooked = true;

                    if (cmd.callback) {
                        const originalCallback = cmd.callback;
                        cmd.callback = async (...args: any[]) => {
                            this.lastSaveRequestTime = Date.now();
                            await syncManager.log(
                                `[Trigger] Manual save detected: ${id}`,
                                "system",
                            );

                            if (this.currentTriggers.onSaveDelaySec === 0) {
                                this.triggerSmartSync("save");
                            } else {
                                window.setTimeout(() => {
                                    this.triggerSmartSync("save");
                                }, this.currentTriggers.onSaveDelaySec * 1000);
                            }
                            return originalCallback.apply(cmd, args);
                        };
                    } else if (cmd.checkCallback) {
                        const originalCheckCallback = cmd.checkCallback;
                        cmd.checkCallback = async (checking: boolean) => {
                            if (!checking) {
                                this.lastSaveRequestTime = Date.now();
                                await syncManager.log(
                                    `[Trigger] Manual save detected (check): ${id}`,
                                    "system",
                                );

                                if (this.currentTriggers.onSaveDelaySec === 0) {
                                    this.triggerSmartSync("save");
                                } else {
                                    window.setTimeout(() => {
                                        this.triggerSmartSync("save");
                                    }, this.currentTriggers.onSaveDelaySec * 1000);
                                }
                            }
                            return originalCheckCallback.call(cmd, checking);
                        };
                    }
                }
            });
        });

        let modifyTimeout: number | null = null;
        this.deps.registerEvent(
            app.vault.on("modify", async (file) => {
                if (!this.isReady) return;
                if (!(file instanceof TFile)) return;

                if (syncManager.shouldIgnore(file.path)) return;

                this.lastModifyTime = Date.now();
                syncManager.markDirty(file.path);

                // Check if this modify is result of explicit save (happened closely after Ctrl+S)
                // If so, trigger immediately (bypass debounce)
                const timeSinceLastSave = Date.now() - this.lastSaveRequestTime;
                if (timeSinceLastSave < 5000) {
                    await syncManager.log(
                        `[Trigger] Fast-tracking sync due to recent save`,
                        "system",
                    );
                    if (modifyTimeout) window.clearTimeout(modifyTimeout);
                    this.triggerSmartSync("save");
                    return;
                }

                if (
                    this.currentTriggers.onModifyDelaySec === SETTINGS_LIMITS.onModifyDelay.disabled
                )
                    return;
                if (modifyTimeout) window.clearTimeout(modifyTimeout);
                modifyTimeout = window.setTimeout(() => {
                    this.triggerSmartSync("modify");
                }, this.currentTriggers.onModifyDelaySec * 1000);
            }),
        );

        this.deps.registerEvent(
            app.vault.on("create", (file) => {
                if (!this.isReady) return;
                if (syncManager.shouldIgnore(file.path)) return;
                syncManager.markDirty(file.path);
            }),
        );

        this.deps.registerEvent(
            app.vault.on("delete", (file) => {
                if (!this.isReady) return;
                if (file instanceof TFile) {
                    syncManager.markDeleted(file.path);
                } else {
                    syncManager.markFolderDeleted(file.path);
                }
            }),
        );

        this.deps.registerEvent(
            app.vault.on("rename", (file, oldPath) => {
                if (!this.isReady) return;
                if (file instanceof TFile) {
                    syncManager.markRenamed(oldPath, file.path);
                } else {
                    syncManager.markFolderRenamed(oldPath, file.path);
                }
            }),
        );

        // Layout change trigger (switching files/tabs)
        this.deps.registerEvent(
            app.workspace.on("layout-change", () => {
                if (!this.isReady) return;
                if (
                    this.currentTriggers.onLayoutChangeDelaySec ===
                    SETTINGS_LIMITS.onLayoutChangeDelay.disabled
                )
                    return;
                if (this.currentTriggers.onLayoutChangeDelaySec === 0) {
                    this.triggerSmartSync("layout-change");
                } else {
                    window.setTimeout(() => {
                        this.triggerSmartSync("layout-change");
                    }, this.currentTriggers.onLayoutChangeDelaySec * 1000);
                }
            }),
        );
    }

    destroy(): void {
        if (this.autoSyncInterval) {
            window.clearInterval(this.autoSyncInterval);
            this.autoSyncInterval = null;
        }
    }

    private async triggerSmartSync(source: string = "unknown") {
        if (!this.isReady) return;

        const trigger: SyncTrigger = TriggerManager.TRIGGER_MAP[source] || "timer-sync";
        const syncManager = this.deps.syncManager;

        // Respect debounce: If user is actively editing, suppressed triggers (layout, interval)
        // should NOT interrupt. The 'modify' trigger (debounced) will handle it eventually.
        if (source === "interval") {
            const timeSinceModify = Date.now() - this.lastModifyTime;
            if (timeSinceModify < this.currentTriggers.onModifyDelaySec * 1000) {
                await syncManager.log(
                    `[Trigger] Skipped ${source} trigger (active editing detected: ${timeSinceModify}ms ago)`,
                    "system",
                );
                return;
            }
        }

        if (source === "interval" && syncManager.isSyncing()) {
            // Already syncing, interval trigger queues with low priority
            await syncManager.requestSmartSync(trigger);
            return;
        }

        await syncManager.log(`[Trigger] Activated via ${source}`, "system");

        // Animation is handled via Activity Callbacks if changes are found
        await syncManager.requestSmartSync(trigger);
    }
}
