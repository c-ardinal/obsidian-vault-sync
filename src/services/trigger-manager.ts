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
    /** Plugin.registerDomEvent: removed with the plugin */
    registerDomEvent?: (
        target: Window | Document,
        type: "visibilitychange" | "online",
        callback: () => void,
    ) => void;
}

/** Hidden at least this long: coming back syncs at once (the timer may not have run meanwhile) */
export const RESUME_MIN_HIDDEN_MS = 3000;
/** While the app is hidden and nothing local waits, the timer syncs at most this often */
export const HIDDEN_INTERVAL_MS = 5 * 60 * 1000;

/** Shape of an Obsidian command entry (internal API) that we hook for save detection. */
interface HookableCommand {
    _isVaultSyncHooked?: boolean;
    callback?: (...args: unknown[]) => unknown;
    checkCallback?: (checking: boolean) => unknown;
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
    /** When the app was hidden (0: visible) */
    private hiddenSince = 0;
    /** Last timer sync run while hidden */
    private lastHiddenRun = 0;

    private static readonly TRIGGER_MAP: Record<string, SyncTrigger> = {
        interval: "timer-sync",
        // Quiet like the timer: the user did not ask for these
        resume: "timer-sync",
        online: "timer-sync",
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
                void this.triggerSmartSync("interval");
            }, this.currentTriggers.autoSyncIntervalSec * 1000);
            this.deps.registerInterval(this.autoSyncInterval);
        }
    }

    /** Timer sync is on: the resume and network triggers follow it */
    private get timerSyncEnabled(): boolean {
        const sec = this.currentTriggers.autoSyncIntervalSec;
        return sec !== SETTINGS_LIMITS.autoSyncInterval.disabled && sec >= SETTINGS_LIMITS.autoSyncInterval.min;
    }

    /** The app went to the background (true) or came back (false) */
    onVisibilityChange(hidden: boolean, now = Date.now()): void {
        if (hidden) {
            if (!this.hiddenSince) this.hiddenSince = now;
            return;
        }
        const since = this.hiddenSince;
        this.hiddenSince = 0;
        this.lastHiddenRun = 0;
        // Back in front: the other devices' changes come in before the user edits a stale note
        if (since && now - since >= RESUME_MIN_HIDDEN_MS && this.timerSyncEnabled) {
            void this.triggerSmartSync("resume");
        }
    }

    /** The network came back: what waited goes out, what changed comes in */
    onOnline(): void {
        if (this.timerSyncEnabled) void this.triggerSmartSync("online");
    }

    /** Sync when the app comes back to the front or the network comes back */
    registerResumeTriggers(): void {
        const register = this.deps.registerDomEvent;
        if (!register) return;
        const doc = activeDocument;
        register(doc, "visibilitychange", () => this.onVisibilityChange(doc.visibilityState === "hidden"));
        register(window, "online", () => this.onOnline());
    }

    registerTriggers(): void {
        const { app, syncManager } = this.deps;
        this.registerResumeTriggers();

        // Save Trigger (Obsidian Command Hook)
        app.workspace.onLayoutReady(async () => {
            const commands = (
                app as unknown as { commands?: { commands?: Record<string, HookableCommand> } }
            ).commands?.commands;
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
                        cmd.callback = async (...args: unknown[]) => {
                            this.lastSaveRequestTime = Date.now();
                            await syncManager.log(
                                `[Trigger] Manual save detected: ${id}`,
                                "system",
                            );

                            if (this.currentTriggers.onSaveDelaySec === 0) {
                                void this.triggerSmartSync("save");
                            } else {
                                window.setTimeout(() => {
                                    void this.triggerSmartSync("save");
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
                                    void this.triggerSmartSync("save");
                                } else {
                                    window.setTimeout(() => {
                                        void this.triggerSmartSync("save");
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
                    void this.triggerSmartSync("save");
                    return;
                }

                if (
                    this.currentTriggers.onModifyDelaySec === SETTINGS_LIMITS.onModifyDelay.disabled
                )
                    return;
                if (modifyTimeout) window.clearTimeout(modifyTimeout);
                modifyTimeout = window.setTimeout(() => {
                    void this.triggerSmartSync("modify");
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
                    void this.triggerSmartSync("layout-change");
                } else {
                    window.setTimeout(() => {
                        void this.triggerSmartSync("layout-change");
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
        if (source === "interval" && this.hiddenSince) {
            // In the background nobody looks: sync now and then, unless local changes wait
            const now = Date.now();
            if (syncManager.pendingChangeCount === 0 && now - this.lastHiddenRun < HIDDEN_INTERVAL_MS) return;
            this.lastHiddenRun = now;
        }

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
            await this.requestSync(trigger);
            return;
        }

        await syncManager.log(`[Trigger] Activated via ${source}`, "system");

        // Animation is handled via Activity Callbacks if changes are found
        await this.requestSync(trigger);
    }

    /**
     * Callers fire and forget, so a failed sync must not become an unhandled rejection.
     * The sync itself already logs the failure and shows a notice.
     */
    private async requestSync(trigger: SyncTrigger): Promise<void> {
        try {
            await this.deps.syncManager.requestSmartSync(trigger);
        } catch {
            /* reported by the sync */
        }
    }
}
