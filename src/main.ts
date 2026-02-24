import { Plugin, TFile, setIcon, Platform } from "obsidian";
import { GoogleDriveAdapter } from "./adapters/google-drive";
import { SyncManager, type SyncTrigger } from "./sync-manager";
import type { SecureStorage } from "./secure-storage";
import { HistoryModal } from "./ui/history-modal";
import { TransferStatusModal } from "./ui/transfer-status-modal";
import { DEFAULT_SETTINGS } from "./constants";
import {
    DATA_REMOTE_DIR,
    VaultSyncSettings,
} from "./types/settings";
import { t, initI18n } from "./i18n";
import { VaultSyncSettingTab } from "./ui/vault-sync-setting-tab";
import { loadExternalCryptoEngine } from "./encryption/engine-loader";
import { checkPasswordStrength } from "./encryption/password-strength";
import type { E2EEPluginContext } from "./encryption/interfaces";
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
import { TriggerManager } from "./services/trigger-manager";
import { SettingsManager } from "./services/settings-manager";
import { CredentialManager } from "./services/credential-manager";

export default class VaultSync extends Plugin {
    settings!: VaultSyncSettings;
    adapter!: GoogleDriveAdapter;
    syncManager!: SyncManager;
    secureStorage!: SecureStorage;
    public vaultOps!: IVaultOperations;

    // Exposed for external engine UI (password strength feedback, i18n)
    public checkPasswordStrength = checkPasswordStrength;
    public i18n = t;

    private syncRibbonIconEl: HTMLElement | null = null;
    private manualSyncInProgress = false;
    private mobileSyncFabEl: HTMLElement | null = null;
    private settingTab: VaultSyncSettingTab | null = null;
    private triggerManager!: TriggerManager;
    private settingsMgr!: SettingsManager;
    private credentialMgr!: CredentialManager;
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

    get currentTriggers(): import("./types/settings").TriggerSettings {
        return this.triggerManager.currentTriggers;
    }

    async onload() {
        // Composition root
        this.vaultOps = new ObsidianVaultOperations(this.app);

        this.adapter = new GoogleDriveAdapter(
            "",
            "",
            this.vaultOps.getVaultName(),
            DEFAULT_SETTINGS.cloudRootFolder,
        );

        this.settingsMgr = new SettingsManager({
            vaultOps: this.vaultOps,
            manifestDir: this.manifest.dir || "",
            adapter: this.adapter,
            appSecretStorage: this.app.secretStorage,
        });

        // i18n and settings load in parallel (independent of each other)
        await Promise.all([
            initI18n(
                (path) => this.vaultOps.read(path),
                this.manifest.dir || "",
            ),
            this.loadSettings(),
        ]);

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

        this.syncManager.onSettingsUpdated = async () => {
            await this.loadSettings();
            this.triggerManager.setupAutoSyncInterval();
            if (this.settingTab) {
                this.settingTab.display();
            }
        };
        this.syncManager.onSaveSettings = () => this.saveSettings();

        // Establish identity (needed for logging), then parallelize remaining I/O
        await this.syncManager.loadLocalIndex();

        // Transfer history, crypto engine, and shared index load in parallel
        // (all depend on loadLocalIndex for logging, but are independent of each other)
        const [, engine] = await Promise.all([
            this.syncManager.loadTransferHistory(),
            loadExternalCryptoEngine(
                this.vaultOps,
                this.manifest.dir!,
                (key) => this.syncManager.notify(key),
            ),
            this.syncManager.loadIndex(),
        ]);

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

        this.credentialMgr = new CredentialManager({
            adapter: this.adapter,
            getSecureStorage: () => this.secureStorage,
            getSyncManager: () => this.syncManager,
            getVaultName: () => this.vaultOps.getVaultName(),
            getCloudRootFolder: () => this.settings.cloudRootFolder,
        });
        this.credentialMgr.setupAdapterCallbacks();

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
                        this.triggerManager.setReady(true);
                    }
                }, this.settings.startupDelaySec * 1000);
            } else {
                this.triggerManager.setReady(true);
                await this.syncManager.log(
                    "Startup sync disabled. Auto-sync hooks enabled.",
                    "system",
                );
            }
        });

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

        this.triggerManager = new TriggerManager({
            app: this.app,
            settings: this.settings,
            syncManager: this.syncManager,
            registerEvent: (evt) => this.registerEvent(evt),
            registerInterval: (id) => this.registerInterval(id),
        });
        this.triggerManager.setupAutoSyncInterval();
        this.triggerManager.registerTriggers();

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
            await this.credentialMgr.handleAuthCallback(params);
        });
    }

    onunload() {
        this.triggerManager.destroy();
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
        if (targets.some((t) => t.element.classList.contains("vault-sync-spinning"))) return;

        this.manualSyncInProgress = true;
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
                setIcon(target.element, target.originalIcon);
            }
            this.manualSyncInProgress = false;
        }
    }

    setupAutoSyncInterval(): void {
        this.triggerManager.setupAutoSyncInterval();
    }

    async loadSettings() {
        await this.settingsMgr.loadSettings();
        this.settings = this.settingsMgr.settings;
        this.secureStorage = this.settingsMgr.secureStorage;
    }

    async saveSettings() {
        await this.settingsMgr.saveSettings();
    }

    async saveCredentials(
        clientId: string, clientSecret: string,
        accessToken: string | null, refreshToken: string | null, tokenExpiresAt?: number,
    ): Promise<void> {
        await this.credentialMgr.saveCredentials(clientId, clientSecret, accessToken, refreshToken, tokenExpiresAt);
    }

    setAuthConfig(method: "default" | "custom-proxy" | "client-credentials", proxyUrl: string): void {
        this.credentialMgr.setAuthConfig(method, proxyUrl);
    }

    getClientId(): string { return this.credentialMgr.getClientId(); }
    getClientSecret(): string { return this.credentialMgr.getClientSecret(); }
    isAdapterAuthenticated(): boolean { return this.credentialMgr.isAdapterAuthenticated(); }
    async adapterLogin(): Promise<void> { await this.credentialMgr.adapterLogin(); }

    async updateClientCredential(field: "clientId" | "clientSecret", value: string): Promise<void> {
        await this.credentialMgr.updateClientCredential(field, value);
    }

    // === SyncManager Facade (eliminates LoD chains in settings-schema.ts) ===

    triggerFullCleanup(): void {
        this.syncManager.triggerFullCleanup();
    }

    updateLoggerOptions(): void {
        this.syncManager.updateLoggerOptions();
    }

    updateAdapterCloudRoot(): void {
        this.adapter.updateConfig(
            this.adapter.clientId,
            this.adapter.clientSecret,
            this.vaultOps.getVaultName(),
            this.settings.cloudRootFolder,
        );
    }

    getE2EESettingsSections(): ReturnType<NonNullable<typeof this.syncManager.cryptoEngine>["getSettingsSections"]> {
        return this.syncManager.cryptoEngine?.getSettingsSections(this.buildE2EEContext()) || [];
    }

}
