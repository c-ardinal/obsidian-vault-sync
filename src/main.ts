import { Plugin, TFile, setIcon, Platform } from "obsidian";
import { GoogleDriveAdapter } from "./adapters/google-drive";
import { SyncManager, type SyncTrigger } from "./sync-manager";
import { SecureStorage } from "./secure-storage";
import { HistoryModal } from "./ui/history-modal";
import { TransferStatusModal } from "./ui/transfer-status-modal";
import { DEFAULT_SETTINGS, SETTINGS_LIMITS } from "./constants";
import {
    DATA_LOCAL_DIR,
    DATA_REMOTE_DIR,
    DATA_FLEXIBLE_DIR,
    VaultSyncSettings,
} from "./types/settings";
import { t } from "./i18n";
import { VaultSyncSettingTab } from "./ui/vault-sync-setting-tab";
import { loadExternalCryptoEngine } from "./encryption/engine-loader";
import { checkPasswordStrength } from "./encryption/password-strength";
import type { E2EEPluginContext } from "./encryption/interfaces";
import { toHex } from "./utils/format";
import {
    openDemoHistoryModal,
    openDemoTransferStatusModal,
    showDemoNotifications,
    startDemoSyncAnimation,
    openDemoPromptModal,
} from "./ui/dev-screenshot-helpers";
import { ObsidianVaultOperations } from "./services/obsidian-vault-operations";
import { ObsidianNotificationService } from "./services/notification-service";
import { RevisionCache } from "./revision-cache";
import { BackgroundTransferQueue } from "./sync-manager/background-transfer";
import type { IVaultOperations } from "./types/vault-operations";

export default class VaultSync extends Plugin {
    settings!: VaultSyncSettings;
    adapter!: GoogleDriveAdapter;
    syncManager!: SyncManager;
    secureStorage!: SecureStorage;
    public vaultOps!: IVaultOperations;

    // Exposed for external engine UI (password strength feedback, i18n)
    public checkPasswordStrength = checkPasswordStrength;
    public i18n = t;

    private isReady = false;
    private syncRibbonIconEl: HTMLElement | null = null;
    private manualSyncInProgress = false;
    private lastSaveRequestTime = 0;
    private lastModifyTime = 0;
    private mobileSyncFabEl: HTMLElement | null = null;
    private autoSyncInterval: number | null = null;
    private settingTab: VaultSyncSettingTab | null = null;
    public t = t;

    public refreshSettingsUI() {
        if (this.settingTab) {
            this.settingTab.display();
        }
    }

    public buildE2EEContext(): E2EEPluginContext {
        return {
            app: this.app,
            t: (key: string) => this.t(key),
            checkPasswordStrength: this.checkPasswordStrength,
            settings: this.settings,
            saveSettings: () => this.saveSettings(),
            refreshSettingsUI: () => this.refreshSettingsUI(),
            cryptoEngine: this.syncManager.cryptoEngine!,
            vaultLockService: this.syncManager.vaultLockService,
            secureStorage: this.syncManager.secureStorage,
            migrationService: this.syncManager.migrationService,
            notify: (key: string) => this.syncManager.notify(key),
            log: (msg: string, level: "system" | "error" | "warn" | "notice" | "info" | "debug") => this.syncManager.log(msg, level),
            setCurrentTrigger: (trigger: string) => {
                this.syncManager.currentTrigger = trigger as SyncTrigger;
            },
        };
    }

    /**
     * Resolves the effective sync triggers for the current device and strategy.
     */
    get currentTriggers(): import("./types/settings").TriggerSettings {
        if (!this.settings) return DEFAULT_SETTINGS.unifiedTriggers;
        if (this.settings.triggerConfigStrategy === "unified") {
            return this.settings.unifiedTriggers;
        }
        return Platform.isMobile ? this.settings.mobileTriggers : this.settings.desktopTriggers;
    }

    async onload() {
        // 0. Create vault operations facade (composition root)
        this.vaultOps = new ObsidianVaultOperations(this.app);

        // 1. Initialize adapter first with defaults
        this.adapter = new GoogleDriveAdapter(
            "",
            "",
            this.vaultOps.getVaultName(),
            DEFAULT_SETTINGS.cloudRootFolder,
        );

        // 2. Load settings (populates adapter if credentials exist)
        await this.loadSettings();

        // 3. Initialize SyncManager with REAL loaded settings (DI)
        const revisionCache = new RevisionCache(this.vaultOps, this.manifest.dir || "");
        const backgroundQueue = new BackgroundTransferQueue();
        this.syncManager = new SyncManager(
            this.vaultOps,
            this.adapter,
            `${this.manifest.dir}/${DATA_REMOTE_DIR}/sync-index.json`,
            this.settings,
            this.manifest.dir || "",
            t,
            new ObsidianNotificationService(),
            revisionCache,
            backgroundQueue,
        );
        this.syncManager.secureStorage = this.secureStorage;

        // Detect and apply remote settings updates
        this.syncManager.onSettingsUpdated = async () => {
            await this.loadSettings();
            this.setupAutoSyncInterval();
            // Refresh settings UI if open
            if (this.settingTab) {
                this.settingTab.display();
            }
        };

        // 5. Establish Identity & Log Folder (loads local-index.json)
        // This is the earliest point where we can log to the correct device-specific folder.
        await this.syncManager.loadLocalIndex();

        // 5.1 Load transfer history (must be after loadLocalIndex sets the correct logFolder)
        await this.syncManager.loadTransferHistory();

        // 5.5 Load external crypto engine (Moved here to ensure logs are captured in sync log)
        const engine = await loadExternalCryptoEngine(
            this.vaultOps,
            this.manifest.dir!,
            (key) => this.syncManager.notify(key),
        );
        if (engine) {
            this.syncManager.cryptoEngine = engine;
            await this.syncManager.log("External E2EE engine loaded successfully.", "system");
        } else {
            await this.syncManager.log(
                "External E2EE engine not found or failed to load. E2EE disabled.",
                "system",
            );
        }

        await this.syncManager.log(
            `=== Plugin Startup: version=${this.manifest.version} ===`,
            "system",
        );

        // Handle Token Expiry / Revocation (credential cleanup only;
        // user-facing notification is handled by executeSmartSync catch)
        this.adapter.onAuthFailure = async () => {
            console.log("VaultSync: Auth failed (token expired/revoked). Clearing credentials.");
            await this.secureStorage.clearCredentials();
            this.adapter.setTokens(null, null);
        };

        // Persist refreshed tokens to secure storage
        this.adapter.onTokenRefresh = async () => {
            const tokens = this.adapter.getTokens();
            if (tokens.accessToken && tokens.refreshToken) {
                await this.secureStorage.saveCredentials({
                    clientId: this.adapter.clientId,
                    clientSecret: this.adapter.clientSecret,
                    accessToken: tokens.accessToken,
                    refreshToken: tokens.refreshToken,
                    tokenExpiresAt: tokens.tokenExpiresAt,
                });
            }
        };

        // 6. Load shared index
        await this.syncManager.loadIndex();

        // Register Activity Callbacks for Auto-Sync Animation
        this.syncManager.setActivityCallbacks(
            () => {
                const targets = [];
                if (!this.manualSyncInProgress && this.syncRibbonIconEl)
                    targets.push(this.syncRibbonIconEl);
                if (this.mobileSyncFabEl) {
                    targets.push(this.mobileSyncFabEl);
                    this.mobileSyncFabEl.addClass("is-active");
                }

                for (const el of targets) {
                    setIcon(el, "sync");
                    el.addClass("vault-sync-spinning");
                }
            },
            () => {
                const targets = [];
                if (!this.manualSyncInProgress && this.syncRibbonIconEl)
                    targets.push(this.syncRibbonIconEl);
                if (this.mobileSyncFabEl) {
                    targets.push(this.mobileSyncFabEl);
                    this.mobileSyncFabEl.removeClass("is-active");
                }

                for (const el of targets) {
                    el.removeClass("vault-sync-spinning");
                    setIcon(el, "sync");
                }
            },
        );

        // 0. Startup Grace Period
        this.app.workspace.onLayoutReady(async () => {
            if (this.currentTriggers.enableStartupSync) {
                window.setTimeout(async () => {
                    await this.syncManager.log(
                        "Startup grace period ended. Checking E2EE status...",
                        "system",
                    );

                    // E2EE Guard: If enabled but locked, show unlock modal
                    if (!this.settings.e2eeEnabled) {
                        const hasRemoteLock =
                            await this.syncManager.vaultLockService.checkForLockFile();
                        if (hasRemoteLock) {
                            await this.syncManager.log(
                                "Remote E2EE detected. Enabling E2EE locally.",
                                "system",
                            );
                            this.settings.e2eeEnabled = true;
                            await this.saveSettings();
                            await this.syncManager.notify("noticeE2EEAutoEnabled");
                        }
                    }

                    if (this.settings.e2eeEnabled && this.syncManager.e2eeLocked) {
                        let autoUnlocked = false;
                        // Only attempt auto-unlock if explicitly enabled by user
                        if (this.settings.e2eeAutoUnlock && this.app.secretStorage) {
                            const savedPassword =
                                await this.secureStorage.getExtraSecret("e2ee-password");
                            if (savedPassword) {
                                try {
                                    const blob =
                                        await this.syncManager.vaultLockService.downloadLockFile();
                                    await this.syncManager.cryptoEngine?.unlockVault(
                                        blob,
                                        savedPassword,
                                    );
                                    autoUnlocked = true;
                                    await this.syncManager.log(
                                        "Vault auto-unlocked using saved password.",
                                        "info",
                                    );
                                } catch (err) {
                                    await this.syncManager.log(
                                        "Auto-unlock failed. Manual entry required.",
                                        "warn",
                                    );
                                    // Clear invalid saved password
                                    await this.secureStorage.removeExtraSecret("e2ee-password");
                                }
                            }
                        }

                        if (!autoUnlocked) {
                            this.syncManager.cryptoEngine?.showUnlockModal(this.buildE2EEContext());
                        }
                    }

                    // First time sync -> "initial-sync" (loud). Subsequent -> "startup-sync" (quiet).
                    const isFirstSync = !this.settings.hasCompletedFirstSync;
                    const trigger: SyncTrigger = isFirstSync ? "initial-sync" : "startup-sync";

                    try {
                        await this.syncManager.requestSmartSync(trigger, true);

                        if (isFirstSync) {
                            this.settings.hasCompletedFirstSync = true;
                            await this.saveSettings();
                        }
                    } catch {
                        // Startup sync may fail (e.g. not authenticated yet).
                        // Don't block the plugin — timer/save/modify syncs must still fire.
                    } finally {
                        this.isReady = true;
                    }
                }, this.settings.startupDelaySec * 1000);
            } else {
                this.isReady = true;
                await this.syncManager.log(
                    "Startup sync disabled. Auto-sync hooks enabled.",
                    "system",
                );
            }
        });

        // 1. Ribbon Icon
        // Ribbon button uses Smart Sync for O(1) performance when no changes
        this.syncRibbonIconEl = this.addRibbonIcon("sync", t("labelSyncTooltip"), async () => {
            if (this.syncRibbonIconEl) {
                await this.performSyncOperation(
                    [{ element: this.syncRibbonIconEl, originalIcon: "sync" }],
                    () => this.syncManager.requestSmartSync("manual-sync"),
                );
            }
        });

        this.addCommand({
            id: "sync-vault",
            name: t("labelSyncCommand"),
            callback: async () => {
                if (this.syncRibbonIconEl) {
                    await this.performSyncOperation(
                        [{ element: this.syncRibbonIconEl, originalIcon: "sync" }],
                        async () => {
                            await this.syncManager.requestSmartSync("manual-sync");
                        },
                    );
                } else {
                    await this.syncManager.requestSmartSync("manual-sync");
                }
            },
        });

        this.addCommand({
            id: "force-full-scan",
            name: t("labelFullAudit"),
            callback: async () => {
                this.syncManager.currentTrigger = "full-scan";
                if (this.syncManager.e2eeLocked) {
                    await this.syncManager.notify("noticeVaultLocked");
                    return;
                }
                await this.syncManager.notify("noticeScanningLocalFiles");
                await this.syncManager.requestBackgroundScan(false);
            },
        });

        this.addCommand({
            id: "e2ee-setup",
            name: t("labelE2EESetup"),
            checkCallback: (checking: boolean) => {
                if (!this.syncManager.cryptoEngine || this.settings.e2eeEnabled) return false;
                if (!checking) {
                    this.syncManager.cryptoEngine.showSetupModal(this.buildE2EEContext());
                }
                return true;
            },
        });

        this.addCommand({
            id: "e2ee-unlock",
            name: t("labelE2EEUnlock"),
            checkCallback: (checking: boolean) => {
                const isLocked =
                    this.settings.e2eeEnabled &&
                    this.syncManager.cryptoEngine &&
                    !this.syncManager.cryptoEngine.isUnlocked();
                if (!isLocked) return false;
                if (!checking) {
                    this.syncManager.cryptoEngine?.showUnlockModal(this.buildE2EEContext());
                }
                return true;
            },
        });

        this.addCommand({
            id: "e2ee-change-password",
            name: t("labelE2EEChangePassword"),
            checkCallback: (checking: boolean) => {
                const engine = this.syncManager.cryptoEngine;
                if (!engine?.showPasswordChangeModal || !engine.isUnlocked()) return false;
                if (!checking) engine.showPasswordChangeModal(this.buildE2EEContext());
                return true;
            },
        });

        this.addCommand({
            id: "e2ee-show-recovery",
            name: t("labelE2EEShowRecovery"),
            checkCallback: (checking: boolean) => {
                const engine = this.syncManager.cryptoEngine;
                if (!engine?.showRecoveryExportModal || !engine.isUnlocked()) return false;
                if (!checking) engine.showRecoveryExportModal(this.buildE2EEContext());
                return true;
            },
        });

        this.addCommand({
            id: "e2ee-recover",
            name: t("labelE2EERecover"),
            checkCallback: (checking: boolean) => {
                const engine = this.syncManager.cryptoEngine;
                if (!engine?.showRecoveryImportModal || !this.settings.e2eeEnabled) return false;
                if (engine.isUnlocked()) return false;
                if (!checking) engine.showRecoveryImportModal(this.buildE2EEContext());
                return true;
            },
        });

        // 2.5 Transfer Status ribbon + command
        this.addRibbonIcon("arrow-up-down", t("labelTransferStatus"), () => {
            new TransferStatusModal(this.app, this.syncManager).open();
        });

        this.addCommand({
            id: "transfer-status",
            name: t("labelTransferStatus"),
            callback: () => {
                new TransferStatusModal(this.app, this.syncManager).open();
            },
        });

        // 2.6 Dev-only screenshot helper commands (visible only in developer mode)
        this.addCommand({
            id: "dev-demo-history",
            name: "[Dev] Screenshot: History / Diff Viewer",
            checkCallback: (checking: boolean) => {
                if (!this.settings.isDeveloperMode) return false;
                if (!checking) {
                    openDemoHistoryModal(this.app, this.syncManager);
                }
                return true;
            },
        });

        this.addCommand({
            id: "dev-demo-transfer-status",
            name: "[Dev] Screenshot: Transfer Status",
            checkCallback: (checking: boolean) => {
                if (!this.settings.isDeveloperMode) return false;
                if (!checking) {
                    openDemoTransferStatusModal(this.app, this.syncManager);
                }
                return true;
            },
        });

        this.addCommand({
            id: "dev-demo-notifications",
            name: "[Dev] Screenshot: Notification Showcase",
            checkCallback: (checking: boolean) => {
                if (!this.settings.isDeveloperMode) return false;
                if (!checking) {
                    showDemoNotifications(this.syncManager);
                }
                return true;
            },
        });

        this.addCommand({
            id: "dev-demo-sync-animation",
            name: "[Dev] Screenshot: Sync Animation (5s)",
            checkCallback: (checking: boolean) => {
                if (!this.settings.isDeveloperMode) return false;
                if (!checking) {
                    startDemoSyncAnimation(this.syncRibbonIconEl, this.mobileSyncFabEl);
                }
                return true;
            },
        });

        this.addCommand({
            id: "dev-demo-prompt-modal",
            name: "[Dev] Screenshot: Restore As Dialog",
            checkCallback: (checking: boolean) => {
                if (!this.settings.isDeveloperMode) return false;
                if (!checking) {
                    openDemoPromptModal(this.app, this.syncManager);
                }
                return true;
            },
        });

        // 3. Mobile Floating Action Button (FAB) -> Fixed Top Center Indicator
        if (Platform.isMobile) {
            this.app.workspace.onLayoutReady(() => {
                this.mobileSyncFabEl = document.body.createDiv("vault-sync-mobile-fab");
                setIcon(this.mobileSyncFabEl, "sync");
                this.mobileSyncFabEl.setAttribute("aria-label", t("labelSyncTooltip"));
            });
        }

        this.settingTab = new VaultSyncSettingTab(this.app, this);
        this.addSettingTab(this.settingTab);

        this.setupAutoSyncInterval();
        this.registerTriggers();

        // 5. History Menu
        this.registerEvent(
            this.app.workspace.on("file-menu", (menu, file) => {
                if (this.syncManager && this.syncManager.supportsHistory) {
                    if (file instanceof TFile) {
                        menu.addItem((item) => {
                            item.setTitle(t("labelViewHistory"))
                                .setIcon("history")
                                .onClick(() => {
                                    new HistoryModal(this.app, this.syncManager, file).open();
                                });
                        });
                    }
                }
            }),
        );

        // 6. Protocol Handler for OAuth Callback (vault-sync-auth)
        this.registerObsidianProtocolHandler("vault-sync-auth", async (params) => {
            // Verify state
            if (params.state && !this.adapter.verifyState(params.state)) {
                await this.syncManager.notify("noticeAuthFailed", "Invalid state");
                return;
            }

            if (params.access_token && params.refresh_token) {
                // Proxy mode: tokens delivered directly from auth proxy callback
                try {
                    // Compute tokenExpiresAt from expires_in (default 3600s for Google OAuth)
                    const expiresIn = params.expires_in ? parseInt(params.expires_in, 10) : 3600;
                    const tokenExpiresAt = Date.now() + expiresIn * 1000;

                    this.adapter.setTokens(params.access_token, params.refresh_token, tokenExpiresAt);
                    await this.saveCredentials(
                        this.adapter.clientId,
                        this.adapter.clientSecret,
                        params.access_token,
                        params.refresh_token,
                        tokenExpiresAt,
                    );
                    await this.syncManager.notify("noticeAuthSuccess");

                    window.localStorage.removeItem("vault-sync-state");

                    // Auto-sync after successful authentication
                    this.syncManager.requestSmartSync("manual-sync").catch(() => {});
                } catch (e: any) {
                    await this.syncManager.notify("noticeAuthFailed", e.message);
                    console.error("VaultSync: Auth failed via proxy protocol handler", e);
                }
            } else if (params.code) {
                // Client-credentials mode: exchange code for token locally
                try {
                    await this.adapter.exchangeCodeForToken(params.code);
                    const tokens = this.adapter.getTokens();
                    await this.saveCredentials(
                        this.adapter.clientId,
                        this.adapter.clientSecret,
                        tokens.accessToken,
                        tokens.refreshToken,
                        tokens.tokenExpiresAt,
                    );
                    await this.syncManager.notify("noticeAuthSuccess");

                    window.localStorage.removeItem("vault-sync-verifier");
                    window.localStorage.removeItem("vault-sync-state");

                    // Auto-sync after successful authentication
                    this.syncManager.requestSmartSync("manual-sync").catch(() => {});
                } catch (e: any) {
                    await this.syncManager.notify("noticeAuthFailed", e.message);
                    console.error("VaultSync: Auth failed via protocol handler", e);
                }
            } else if (params.error) {
                await this.syncManager.notify("noticeAuthFailed", params.error);
            }
        });
    }

    onunload() {
        if (this.autoSyncInterval) {
            window.clearInterval(this.autoSyncInterval);
        }
        if (this.mobileSyncFabEl) {
            this.mobileSyncFabEl.remove();
        }
        // Clean up background transfer queue (remove event listeners, flush history)
        if (this.syncManager) {
            this.syncManager.destroyTransferQueue();
        }
    }

    async performSyncOperation(
        targets: { element: HTMLElement; originalIcon: string }[],
        operation: () => Promise<void>,
    ) {
        // Prevent concurrent clicks if any icon is already spinning
        if (targets.some((t) => t.element.classList.contains("vault-sync-spinning"))) return;

        this.manualSyncInProgress = true;
        // Change to sync icon (circle arrow) and animate all targets
        for (const target of targets) {
            setIcon(target.element, "sync");
            target.element.addClass("vault-sync-spinning");
            if (target.element.classList.contains("vault-sync-mobile-fab")) {
                target.element.addClass("is-active");
            }
        }

        try {
            await operation();
        } finally {
            for (const target of targets) {
                target.element.removeClass("vault-sync-spinning");
                if (target.element.classList.contains("vault-sync-mobile-fab")) {
                    target.element.removeClass("is-active");
                }
                // Revert to original icon
                setIcon(target.element, target.originalIcon);
            }
            this.manualSyncInProgress = false;
        }
    }

    setupAutoSyncInterval() {
        // Clear existing
        if (this.autoSyncInterval) {
            window.clearInterval(this.autoSyncInterval);
            this.autoSyncInterval = null;
        }

        // 1. Interval - use Smart Sync for regular intervals
        if (
            this.currentTriggers.autoSyncIntervalSec !==
                SETTINGS_LIMITS.autoSyncInterval.disabled &&
            this.currentTriggers.autoSyncIntervalSec >= SETTINGS_LIMITS.autoSyncInterval.min
        ) {
            this.autoSyncInterval = window.setInterval(() => {
                this.triggerSmartSync("interval");
            }, this.currentTriggers.autoSyncIntervalSec * 1000);
            this.registerInterval(this.autoSyncInterval);
        }
    }

    /** Map source strings to SyncTrigger values */
    private static readonly TRIGGER_MAP: Record<string, SyncTrigger> = {
        interval: "timer-sync",
        save: "save-sync",
        modify: "modify-sync",
        "layout-change": "layout-sync",
    };

    /**
     * Trigger Smart Sync - high priority, O(1) check via sync-index.json
     * Used for background/implicit actions (save, modify, layout change, interval)
     * @param source The source of the trigger for debugging and priority handling
     */
    private async triggerSmartSync(source: string = "unknown") {
        if (!this.isReady) return;

        const trigger: SyncTrigger = VaultSync.TRIGGER_MAP[source] || "timer-sync";

        // Respect debounce: If user is actively editing, suppressed triggers (layout, interval)
        // should NOT interrupt. The 'modify' trigger (debounced) will handle it eventually.
        if (source === "interval") {
            const timeSinceModify = Date.now() - this.lastModifyTime;
            if (timeSinceModify < this.currentTriggers.onModifyDelaySec * 1000) {
                await this.syncManager.log(
                    `[Trigger] Skipped ${source} trigger (active editing detected: ${timeSinceModify}ms ago)`,
                    "system",
                );
                return;
            }
        }

        if (source === "interval" && this.syncManager.isSyncing()) {
            // Already syncing, interval trigger queues with low priority
            await this.syncManager.requestSmartSync(trigger);
            return;
        }

        await this.syncManager.log(`[Trigger] Activated via ${source}`, "system");

        // Animation is handled via Activity Callbacks if changes are found
        await this.syncManager.requestSmartSync(trigger);
    }

    private registerTriggers() {
        // 2. Save Trigger (Obsidian Command Hook)
        this.app.workspace.onLayoutReady(async () => {
            const commands = (this.app as any).commands?.commands;
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
                            await this.syncManager.log(
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
                                await this.syncManager.log(
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

        // 3. Modify trigger with debounce - marks dirty and triggers Smart Sync
        let modifyTimeout: number | null = null;
        this.registerEvent(
            this.app.vault.on("modify", async (file) => {
                if (!this.isReady) return;
                if (!(file instanceof TFile)) return;

                if (this.syncManager.shouldIgnore(file.path)) return;

                // Track modification time for debounce protection
                this.lastModifyTime = Date.now();
                // Mark file as dirty immediately
                this.syncManager.markDirty(file.path);

                // Check if this modify is result of explicit save (happened closely after Ctrl+S)
                // If so, trigger immediately (bypass debounce)
                const timeSinceLastSave = Date.now() - this.lastSaveRequestTime;
                if (timeSinceLastSave < 5000) {
                    await this.syncManager.log(
                        `[Trigger] Fast-tracking sync due to recent save`,
                        "system",
                    );
                    if (modifyTimeout) window.clearTimeout(modifyTimeout);
                    this.triggerSmartSync("save");
                    return;
                }

                // Debounce the actual sync for auto-saves
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

        // 3b. Create trigger
        this.registerEvent(
            this.app.vault.on("create", (file) => {
                if (!this.isReady) return;
                if (this.syncManager.shouldIgnore(file.path)) return;
                this.syncManager.markDirty(file.path);
            }),
        );

        // 3c. Delete trigger
        this.registerEvent(
            this.app.vault.on("delete", (file) => {
                if (!this.isReady) return;
                if (file instanceof TFile) {
                    this.syncManager.markDeleted(file.path);
                } else {
                    this.syncManager.markFolderDeleted(file.path);
                }
            }),
        );

        // 3d. Rename trigger - mark both old and new paths (files and folders)
        this.registerEvent(
            this.app.vault.on("rename", (file, oldPath) => {
                if (!this.isReady) return;
                if (file instanceof TFile) {
                    // File renamed/moved - use markRenamed to handle both
                    // normal renames and "create then rename" cases
                    this.syncManager.markRenamed(oldPath, file.path);
                } else {
                    // Folder renamed/moved - mark all indexed files for update
                    this.syncManager.markFolderRenamed(oldPath, file.path);
                }
            }),
        );

        // 3d. Layout change trigger (switching files/tabs)
        this.registerEvent(
            this.app.workspace.on("layout-change", () => {
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

    async loadSettings() {
        let loadedSettings: Partial<VaultSyncSettings> = {};

        const openDataPath = `${this.manifest.dir}/${DATA_FLEXIBLE_DIR}/open-data.json`;
        const localDataPath = `${this.manifest.dir}/${DATA_LOCAL_DIR}/local-data.json`;
        // Load Open Data
        if (await this.vaultOps.exists(openDataPath)) {
            try {
                const openData = JSON.parse(await this.vaultOps.read(openDataPath));
                loadedSettings = { ...loadedSettings, ...openData };
            } catch (e) {
                console.error("VaultSync: Failed to load open-data.json", e);
            }
        }

        // Load Local Data
        if (await this.vaultOps.exists(localDataPath)) {
            try {
                const localData = JSON.parse(await this.vaultOps.read(localDataPath));
                loadedSettings = { ...loadedSettings, ...localData };
            } catch (e) {
                console.error("VaultSync: Failed to load local-data.json", e);
            }
        }

        this.settings = Object.assign({}, DEFAULT_SETTINGS, loadedSettings);

        // SEC-010: Initialize SecureStorage early to use its Keychain methods
        this.secureStorage = new SecureStorage(
            this.vaultOps,
            this.manifest.dir || "",
            this.settings.encryptionSecret || "temp-key",
            this.app.secretStorage,
        );

        // SEC-011: Prioritize encryptionSecret from Keychain
        if (this.app.secretStorage) {
            const keychainSecret = await this.secureStorage.getExtraSecret("encryption-secret");
            if (keychainSecret) {
                this.settings.encryptionSecret = keychainSecret;
                this.secureStorage.setMasterSecret(keychainSecret);
            }
        }

        // SEC-001: Ensure encryption secret exists (if not found in file or Keychain)
        if (!this.settings.encryptionSecret) {
            const array = new Uint8Array(32);
            window.crypto.getRandomValues(array);
            const newSecret = toHex(array);
            this.settings.encryptionSecret = newSecret;
            this.secureStorage.setMasterSecret(newSecret);

            if (this.app.secretStorage) {
                await this.secureStorage.setExtraSecret("encryption-secret", newSecret);
            }
            await this.saveSettings();
        }

        // Load credentials from Secure Storage
        const credentials = await this.secureStorage.loadCredentials();

        if (credentials) {
            this.adapter.setCredentials(credentials.clientId || "", credentials.clientSecret || "");
            this.adapter.setTokens(
                credentials.accessToken || null,
                credentials.refreshToken || null,
                credentials.tokenExpiresAt || 0,
            );
            this.adapter.updateConfig(
                credentials.clientId || "",
                credentials.clientSecret || "",
                this.vaultOps.getVaultName(),
                this.settings.cloudRootFolder,
            );

            // Backward compatibility: existing users with clientId/clientSecret
            // should default to client-credentials mode if authMethod is not explicitly set
            if (
                !loadedSettings.authMethod &&
                credentials.clientId &&
                credentials.clientSecret
            ) {
                this.settings.authMethod = "client-credentials";
            }
        }

        // Apply auth config to adapter
        this.adapter.setAuthConfig(
            this.settings.authMethod,
            this.settings.customProxyUrl,
        );

    }

    async saveSettings() {
        // Ensure directories exist
        const flexibleDir = `${this.manifest.dir}/${DATA_FLEXIBLE_DIR}`;
        const localDir = `${this.manifest.dir}/${DATA_LOCAL_DIR}`;
        const remoteDir = `${this.manifest.dir}/${DATA_REMOTE_DIR}`;

        if (!(await this.vaultOps.exists(flexibleDir))) {
            await this.vaultOps.createFolder(flexibleDir).catch(() => {});
        }
        if (!(await this.vaultOps.exists(localDir))) {
            await this.vaultOps.createFolder(localDir).catch(() => {});
        }
        if (!(await this.vaultOps.exists(remoteDir))) {
            await this.vaultOps.createFolder(remoteDir).catch(() => {});
        }

        // Split Settings
        const localKeys = ["encryptionSecret", "hasCompletedFirstSync"];
        const localData: Record<string, unknown> = {};
        const openData: Record<string, unknown> = {};
        const settingsRecord = this.settings as unknown as Record<string, unknown>;

        for (const key in this.settings) {
            if (Object.prototype.hasOwnProperty.call(this.settings, key)) {
                if (localKeys.includes(key)) {
                    // SEC-012: Do not save encryptionSecret to file if Keychain is active
                    if (key === "encryptionSecret" && this.app.secretStorage) {
                        continue;
                    }
                    localData[key] = settingsRecord[key];
                } else {
                    openData[key] = settingsRecord[key];
                }
            }
        }

        // Save to respective files
        const openDataPath = `${flexibleDir}/open-data.json`;
        const localDataPath = `${localDir}/local-data.json`;

        await this.vaultOps.write(openDataPath, JSON.stringify(openData, null, 2));
        await this.vaultOps.write(localDataPath, JSON.stringify(localData, null, 2));
    }

    async saveCredentials(
        clientId: string,
        clientSecret: string,
        accessToken: string | null,
        refreshToken: string | null,
        tokenExpiresAt?: number,
    ) {
        this.adapter.setCredentials(clientId, clientSecret);
        this.adapter.setTokens(accessToken, refreshToken, tokenExpiresAt);
        await this.secureStorage.saveCredentials({
            clientId,
            clientSecret,
            accessToken,
            refreshToken,
            tokenExpiresAt: tokenExpiresAt || 0,
        });

        // Also update live adapter config
        this.adapter.updateConfig(
            clientId,
            clientSecret,
            this.vaultOps.getVaultName(),
            this.settings.cloudRootFolder,
        );
    }

}
