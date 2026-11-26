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
/** While the app is hidden on a PC and nothing local waits, the timer syncs at most this often (mobile: never) */
export const HIDDEN_INTERVAL_MS = 5 * 60 * 1000;
/** Longest the PC app's closing waits for the last changes to go out */
export const QUIT_FLUSH_MAX_MS = 8000;
const QUIT_FLUSH_POLL_MS = 200;
const QUIT_FLUSH_MAX_REQUESTS = 3;

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
 * Extracted from the main Vault Syncer plugin class to separate
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
    /** Edit delay running (send after the user stops typing) */
    private modifyTimeout: number | null = null;

    private static readonly TRIGGER_MAP: Record<string, SyncTrigger> = {
        interval: "timer-sync",
        // Quiet like the timer: the user did not ask for these
        resume: "timer-sync",
        online: "timer-sync",
        // Local edits going out early: like the edit trigger
        hide: "modify-sync",
        quit: "modify-sync",
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
            // Phones and tablets stop a hidden app within seconds: what waits for the
            // edit delay would stay here until the app comes back. Send it now.
            this.flushPendingChanges("hide");
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

    /**
     * Local changes wait (edit delay running or not yet sent): send them now
     * instead of after the delay. Nothing waits: nothing is sent. Follows the
     * edit trigger setting: when that is off, the user sends by hand.
     */
    private flushPendingChanges(source: "hide" | "quit"): boolean {
        if (!this.isReady) return false;
        if (this.deps.syncManager.pendingChangeCount === 0) return false;
        if (this.currentTriggers.onModifyDelaySec === SETTINGS_LIMITS.onModifyDelay.disabled) return false;
        if (this.modifyTimeout) {
            window.clearTimeout(this.modifyTimeout);
            this.modifyTimeout = null;
        }
        void this.triggerSmartSync(source);
        return true;
    }

    /**
     * PC app closing: send what waits, for at most QUIT_FLUSH_MAX_MS, so the
     * next device opened gets this device's last edits.
     */
    async onQuit(): Promise<void> {
        if (Platform.isMobile) return;
        if (!this.isReady || this.deps.syncManager.pendingChangeCount === 0) return;
        if (this.currentTriggers.onModifyDelaySec === SETTINGS_LIMITS.onModifyDelay.disabled) return;
        if (this.modifyTimeout) {
            window.clearTimeout(this.modifyTimeout);
            this.modifyTimeout = null;
        }
        await this.deps.syncManager.log("[Trigger] App closing: sending waiting changes", "system");
        const sm = this.deps.syncManager;
        let timer: number | undefined;
        const deadline = new Promise<"timeout">((resolve) => {
            timer = window.setTimeout(() => resolve("timeout"), QUIT_FLUSH_MAX_MS);
        });
        const pause = () => new Promise<void>((r) => window.setTimeout(r, QUIT_FLUSH_POLL_MS));
        // A sync already running only queues one more pass and returns with the
        // running one: wait until the queue has drained and nothing is left, still
        // inside the limit. At most a few requests, so a failing send does not loop.
        let stopped = false;
        const drain = async (): Promise<void> => {
            let requests = 0;
            while (!stopped && requests < QUIT_FLUSH_MAX_REQUESTS) {
                if (!sm.isSyncing()) {
                    if (sm.pendingChangeCount === 0) return;
                    requests++;
                    await this.requestSync("modify-sync");
                    continue;
                }
                await pause();
            }
        };
        await Promise.race([drain(), deadline]);
        stopped = true;
        if (timer !== undefined) window.clearTimeout(timer);
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
                    if (this.modifyTimeout) window.clearTimeout(this.modifyTimeout);
                    this.modifyTimeout = null;
                    void this.triggerSmartSync("save");
                    return;
                }

                if (
                    this.currentTriggers.onModifyDelaySec === SETTINGS_LIMITS.onModifyDelay.disabled
                )
                    return;
                if (this.modifyTimeout) window.clearTimeout(this.modifyTimeout);
                // Hidden (the editor saved on the way out): the app may stop any moment
                if (this.hiddenSince) {
                    this.modifyTimeout = null;
                    void this.triggerSmartSync("hide");
                    return;
                }
                this.modifyTimeout = window.setTimeout(() => {
                    this.modifyTimeout = null;
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

        // PC app closing: the last edits go out first (bounded wait)
        this.deps.registerEvent(
            app.workspace.on("quit", (tasks) => {
                tasks.add(() => this.onQuit());
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
        if (this.modifyTimeout) {
            window.clearTimeout(this.modifyTimeout);
            this.modifyTimeout = null;
        }
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
            // In the background nobody looks: sync now and then, unless local changes wait.
            // On a phone or tablet not at all: the sync when the app comes back to the
            // front fetches what changed, and the battery is spared meanwhile.
            const now = Date.now();
            if (syncManager.pendingChangeCount === 0) {
                if (Platform.isMobile || now - this.lastHiddenRun < HIDDEN_INTERVAL_MS) return;
            }
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
