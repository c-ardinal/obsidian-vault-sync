import { deviceScopePatterns } from "./sync-manager/file-utils";
import { Notice, Plugin, TFile, TFolder, setIcon, Platform, apiVersion } from "obsidian";
import { createCloudAdapter, DEFAULT_CLOUD_PROVIDER } from "./cloud-adapters";
import { MassDeleteGuard } from "./sync-manager/mass-change-guard";
import { ConflictResolveModal, openConflictResolver } from "./ui/conflict-resolve-modal";
import { isConflictCopyPath } from "./sync-manager/conflict-resolution";
import { DevicesModal } from "./ui/devices-modal";
import { DiagnosticsModal } from "./ui/diagnostics-modal";
import { PointInTimeModal } from "./ui/point-in-time-modal";
import { formatDiagnostics } from "./sync-manager/diagnostics";
import { MassDeleteModal } from "./ui/mass-delete-modal";
import { RemoteTrashModal } from "./ui/remote-trash-modal";
import { FirstSyncModal } from "./ui/first-sync-modal";
import type { OAuthCloudAdapter } from "./types/oauth-adapter";
import { SyncManager, type SyncTrigger } from "./sync-manager";
import type { SecureStorage } from "./services/secure-storage";
import { HistoryModal } from "./ui/history-modal";
import { TransferStatusModal, type TransferModalActions } from "./ui/transfer-status-modal";
import { SyncStatusView } from "./ui/sync-status-view";
import { DEFAULT_SETTINGS } from "./constants";
import { DATA_REMOTE_DIR, VaultSyncSettings } from "./types/settings";
import { t, initI18n, setAddonStrings, currentLanguage } from "./i18n";
import type { ICryptoEngine } from "./encryption/interfaces";
import { VaultSyncSettingTab } from "./ui/vault-sync-setting-tab";
import {
    installEngineFromContent,
    loadExternalCryptoEngine,
    removeInstalledEngine,
} from "./encryption/engine-loader";
import { AddonInstallModal, type AddonInstallOutcome } from "./ui/addon-install-modal";
import type { AddonPackage } from "./addons/addon-package";
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
import { RevisionCache } from "./services/revision-cache";
import { BackgroundTransferQueue } from "./sync-manager/background-transfer";
import type { IVaultOperations } from "./types/vault-operations";
import { TriggerManager } from "./services/trigger-manager";
import { SettingsManager } from "./services/settings-manager";
import { CredentialManager } from "./services/credential-manager";
import { setPluginDir } from "./sync-manager/file-utils";
import { isLegacyCopyEnabled, migrateLegacyPluginData } from "./services/legacy-plugin-migration";

export default class VaultSync extends Plugin {
    settings!: VaultSyncSettings;
    adapter!: OAuthCloudAdapter;
    syncManager!: SyncManager;
    secureStorage!: SecureStorage;
    public vaultOps!: IVaultOperations;

    // Exposed for external engine UI (password strength feedback, i18n)
    public checkPasswordStrength = checkPasswordStrength;
    public i18n = t;

    private syncRibbonIconEl: HTMLElement | null = null;
    private manualSyncInProgress = false;
    private mobileSyncFabEl: HTMLElement | null = null;
    private syncStatusView: SyncStatusView | null = null;
    private settingTab: VaultSyncSettingTab | null = null;
    private triggerManager!: TriggerManager;
    private settingsMgr!: SettingsManager;
    private credentialMgr!: CredentialManager;
    public t = t;

    /**
     * Installs a verified add-on package the user picked and agreed to (see
     * AddonInstallModal), records the agreement, and activates the add-on
     * immediately, without restarting Obsidian.
     */
    public async installAddonPackage(pkg: AddonPackage): Promise<AddonInstallOutcome> {
        // Only one kind of add-on exists today.
        if (pkg.addon.kind !== "crypto-engine") return { ok: false, errorKey: "addonErrorUnknown" };

        const result = await installEngineFromContent(
            this.vaultOps,
            this.manifest.dir!,
            pkg.entrySource,
        );
        if (!result.ok) {
            await this.syncManager.log(`Add-on install rejected: ${result.reason}`, "warn");
            return {
                ok: false,
                errorKey: result.reason === "write-failed" ? "addonErrorWrite" : "addonErrorHash",
            };
        }

        this.attachCryptoEngine(result.engine);
        this.settings.addonAgreements = {
            ...(this.settings.addonAgreements ?? {}),
            [pkg.addon.id]: {
                name: pkg.manifest.name,
                version: pkg.manifest.version,
                termsHash: pkg.termsHash,
                agreedAt: new Date().toISOString(),
            },
        };
        await this.saveSettings();
        await this.syncManager.log(
            `Add-on installed: ${pkg.manifest.id} ${pkg.manifest.version} (terms ${pkg.termsHash.slice(0, 12)})`,
            "system",
        );
        this.refreshSettingsUI();
        return { ok: true };
    }

    /**
     * Removes the installed add-on from this device. If this vault uses it,
     * syncing pauses on this device until it is installed again.
     */
    public async removeAddon(): Promise<boolean> {
        if (this.syncManager.isSyncing()) {
            new Notice(t("addonRemoveBusy"));
            return false;
        }
        try {
            await removeInstalledEngine(this.vaultOps, this.manifest.dir!);
        } catch (e) {
            await this.syncManager.log(`Add-on removal failed: ${String(e)}`, "error");
            new Notice(t("addonRemoveFailed"));
            return false;
        }
        this.attachCryptoEngine(null);
        this.settings.addonAgreements = {};
        await this.saveSettings();
        await this.syncManager.log("Add-on removed from this device.", "system");
        new Notice(t("addonRemoved"));
        this.refreshSettingsUI();
        return true;
    }

    private addonCommandsRegistered = false;

    /**
     * Activate (or with null, remove) the add-on engine: hand it to the sync
     * manager, take its display text, and register its commands. Commands are
     * registered on first activation so their names come from the add-on; they
     * hide themselves while no add-on is present.
     */
    private attachCryptoEngine(engine: ICryptoEngine | null): void {
        this.syncManager.setCryptoEngine(engine);
        setAddonStrings(engine?.getStrings ? (lang) => engine.getStrings!(lang) : null);
        if (engine && !this.addonCommandsRegistered) {
            this.addonCommandsRegistered = true;
            this.registerAddonCommands();
        }
    }

    private registerAddonCommands(): void {
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
    }

    public openAddonInstallModal(): void {
        new AddonInstallModal(
            this.app,
            (pkg) => this.installAddonPackage(pkg),
            () => {
                // The vault already uses the add-on on another device: go straight to unlocking.
                if (this.settings.e2eeEnabled && this.syncManager.e2eeLocked) {
                    this.syncManager.cryptoEngine?.showUnlockModal(this.buildE2EEContext());
                }
            },
            this.settings.e2eeEnabled,
        ).open();
    }

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
            log: (msg: string, level: "system" | "error" | "warn" | "notice" | "info" | "debug") =>
                this.syncManager.log(msg, level),
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
        const configDir = this.app.vault.configDir;
        const pluginDir = this.manifest.dir || `${configDir}/plugins/${this.manifest.id}`;
        setPluginDir(pluginDir, configDir);
        initI18n();

        // The plugin's ID changed for the community directory. While the old copy is
        // still enabled, both would sync the same vault: stay idle until it is off.
        if (isLegacyCopyEnabled(this.app)) {
            new Notice(t("noticeLegacyCopyEnabled"), 0);
            return;
        }
        try {
            const migrated = await migrateLegacyPluginData(
                this.app.vault.adapter,
                configDir,
                pluginDir,
            );
            if (migrated) new Notice(t("noticeLegacyDataMigrated"), 15000);
        } catch (e) {
            console.error("Vault-Sync: Could not carry over data from the old plugin folder", e);
        }

        this.vaultOps = new ObsidianVaultOperations(this.app);

        this.adapter = createCloudAdapter(
            DEFAULT_CLOUD_PROVIDER,
            this.vaultOps.getVaultName(),
            DEFAULT_SETTINGS.cloudRootFolder,
        );

        this.settingsMgr = new SettingsManager({
            vaultOps: this.vaultOps,
            manifestDir: this.manifest.dir || "",
            adapter: this.adapter,
            appSecretStorage: this.app.secretStorage,
        });

        await this.loadSettings();
        this.applyDiffFontSize();

        const revisionCache = new RevisionCache(this.vaultOps, this.manifest.dir || "");
        const backgroundQueue = new BackgroundTransferQueue();
        this.syncManager = new SyncManager(
            this.vaultOps,
            this.adapter,
            `${this.manifest.dir}/${DATA_REMOTE_DIR}/sync-index.json`,
            this.settings,
            this.manifest.dir || "",
            t,
            new ObsidianNotificationService((path) => {
                if (isConflictCopyPath(path)) new ConflictResolveModal(this.app, path).open();
                else void this.app.workspace.openLinkText(path, "", true);
            }),
            revisionCache,
            backgroundQueue,
        );
        this.syncManager.secureStorage = this.secureStorage;
        this.syncManager.planGuard = new MassDeleteGuard(
            () => this.settings,
            () => this.syncManager.syncedFileCount(),
            async (plan, summary) => {
                const ok = await new MassDeleteModal(this.app, plan, summary).ask();
                if (!ok) new Notice(t("noticeMassDeleteHeld"));
                return ok;
            },
        );
        this.syncManager.firstSyncGuard = {
            choose: (summary) => new FirstSyncModal(this.app, summary).ask(),
        };
        const platform = Platform.isIosApp
            ? Platform.isTablet
                ? "iPad"
                : "iPhone"
            : Platform.isAndroidApp
              ? Platform.isTablet
                  ? "Android tablet"
                  : "Android"
              : Platform.isMacOS
                ? "Mac"
                : Platform.isWin
                  ? "Windows"
                  : Platform.isLinux
                    ? "Linux"
                    : "";
        this.syncManager.deviceInfo = { platform, defaultName: platform || "Device" };
        this.syncManager.unicodeInsensitiveFs = Platform.isMacOS || Platform.isIosApp;
        this.syncManager.caseInsensitiveFs =
            Platform.isWin || Platform.isMacOS || Platform.isIosApp || Platform.isAndroidApp;
        this.syncManager.windowsNameRules = Platform.isWin || Platform.isAndroidApp;

        this.syncManager.onSettingsUpdated = async () => {
            const scopeBefore = deviceScopePatterns(this.settings);
            await this.loadSettings();
            // Another device of this kind changed the exclusion list
            if (deviceScopePatterns(this.settings) !== scopeBefore) {
                await this.syncManager.applyDeviceScopeChange(scopeBefore);
            }
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
            loadExternalCryptoEngine(this.vaultOps, this.manifest.dir!, (key) =>
                this.syncManager.notify(key),
            ),
            this.syncManager.loadIndex(),
        ]);

        if (engine) {
            this.attachCryptoEngine(engine);
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

        // Created before the onLayoutReady callback below: when the plugin is enabled
        // after startup, that callback runs at once and reads currentTriggers.
        this.triggerManager = new TriggerManager({
            app: this.app,
            settings: this.settings,
            syncManager: this.syncManager,
            registerEvent: (evt) => this.registerEvent(evt),
            registerInterval: (id) => this.registerInterval(id),
            registerDomEvent: (target, type, cb) => {
                if (type === "online" && target instanceof Window) this.registerDomEvent(target, "online", cb);
                else if (type === "visibilitychange" && !(target instanceof Window))
                    this.registerDomEvent(target, "visibilitychange", cb);
            },
        });

        this.app.workspace.onLayoutReady(() => {
            void (async () => {
                if (this.currentTriggers.enableStartupSync) {
                    window.setTimeout(() => {
                        void (async () => {
                            await this.syncManager.log(
                                "Startup grace period ended. Checking E2EE status...",
                                "system",
                            );

                            // E2EE Guard: If enabled but locked, show unlock modal
                            if (!this.settings.e2eeEnabled) {
                                const hasRemoteLock = await this.syncManager.vaultLockService
                                    .checkForLockFile()
                                    .catch(async (e) => {
                                        await this.syncManager.log(
                                            `E2EE status check failed: ${e}`,
                                            "warn",
                                        );
                                        return false;
                                    });
                                if (hasRemoteLock) {
                                    await this.syncManager.log(
                                        "Remote E2EE detected. Enabling E2EE locally.",
                                        "system",
                                    );
                                    this.settings.e2eeEnabled = true;
                                    await this.saveSettings();
                                    await this.syncManager.notify(
                                        this.syncManager.cryptoEngine
                                            ? "noticeE2EEAutoEnabled"
                                            : "noticeAddonRequired",
                                    );
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
                                            await this.upgradeVaultLockIfNeeded(savedPassword);
                                            await this.syncManager.log(
                                                "Vault auto-unlocked using saved password.",
                                                "info",
                                            );
                                        } catch {
                                            await this.syncManager.log(
                                                "Auto-unlock failed. Manual entry required.",
                                                "warn",
                                            );
                                            // Clear invalid saved password
                                            await this.secureStorage.removeExtraSecret(
                                                "e2ee-password",
                                            );
                                        }
                                    }
                                }

                                if (!this.syncManager.cryptoEngine) {
                                    // Used on another device, but this device lacks the add-on:
                                    // walk the user through installing it (it then asks for the password).
                                    this.openAddonInstallModal();
                                } else if (!autoUnlocked) {
                                    this.syncManager.cryptoEngine.showUnlockModal(
                                        this.buildE2EEContext(),
                                    );
                                }
                            }

                            // First time sync -> "initial-sync" (loud). Subsequent -> "startup-sync" (quiet).
                            const isFirstSync = !this.settings.hasCompletedFirstSync;
                            const trigger: SyncTrigger = isFirstSync
                                ? "initial-sync"
                                : "startup-sync";

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
                        })();
                    }, this.settings.startupDelaySec * 1000);
                } else {
                    this.triggerManager.setReady(true);
                    await this.syncManager.log(
                        "Startup sync disabled. Auto-sync hooks enabled.",
                        "system",
                    );
                }
            })();
        });

        // Ribbon button uses Smart Sync for O(1) performance when no changes
        this.syncRibbonIconEl = this.addRibbonIcon("sync", t("labelSyncTooltip"), async () => {
            if (this.syncRibbonIconEl) {
                await this.performSyncOperation(
                    [{ element: this.syncRibbonIconEl, originalIcon: "sync" }],
                    () => this.requestManualSync(),
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
                        () => this.requestManualSync(),
                    );
                } else {
                    await this.requestManualSync();
                }
            },
        });

        this.addCommand({
            id: "force-full-scan",
            name: t("labelFullAudit"),
            callback: async () => {
                this.syncManager.currentTrigger = "full-scan";
                if (this.syncManager.e2eeLocked) {
                    await this.syncManager.notify(
                        this.syncManager.cryptoEngine ? "noticeVaultLocked" : "noticeAddonRequired",
                    );
                    return;
                }
                await this.syncManager.notify("noticeScanningLocalFiles");
                await this.syncManager.requestBackgroundScan(false);
            },
        });

        this.addCommand({
            id: "install-addon",
            name: t("labelInstallAddon"),
            // Also used to update or reinstall an installed add-on
            callback: () => this.openAddonInstallModal(),
        });

        this.addRibbonIcon("arrow-up-down", t("labelTransferStatus"), () => {
            new TransferStatusModal(this.app, this.syncManager, this.transferModalActions()).open();
        });

        this.addCommand({
            id: "transfer-status",
            name: t("labelTransferStatusCommand"),
            callback: () => {
                new TransferStatusModal(this.app, this.syncManager, this.transferModalActions()).open();
            },
        });

        this.addCommand({
            id: "show-remote-trash",
            name: t("labelRemoteTrashCommand"),
            callback: () => this.openRemoteTrash(),
        });

        this.addCommand({
            id: "resolve-conflicts",
            name: t("labelResolveConflictCommand"),
            callback: () => openConflictResolver(this.app),
        });

        this.addCommand({
            id: "show-devices",
            name: t("labelDevicesCommand"),
            callback: () => this.openDevices(),
        });

        this.addCommand({
            id: "report-issue",
            name: t("labelReportIssueCommand"),
            callback: () => this.openDiagnostics(),
        });

        this.addCommand({
            id: "copy-diagnostics",
            name: t("labelDiagnosticsCommand"),
            callback: () => this.openDiagnostics(),
        });

        this.addCommand({
            id: "restore-to-point-in-time",
            name: t("labelPointInTimeCommand"),
            checkCallback: (checking: boolean) => {
                if (!this.syncManager?.supportsHistory) return false;
                if (!checking) this.openPointInTime("");
                return true;
            },
        });

        this.addCommand({
            id: "show-sync-status",
            name: t("labelShowSyncStatusCommand"),
            checkCallback: (checking: boolean) => {
                if (!this.syncStatusView?.mounted) return false;
                if (!checking) this.syncStatusView.openDetails();
                return true;
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

        // 3. Sync status display (status bar / mobile pill). On mobile, the older
        // spinning indicator (FAB) is used only when the status display is off.
        this.app.workspace.onLayoutReady(() => this.refreshSyncStatusView());

        this.settingTab = new VaultSyncSettingTab(this.app, this);
        this.addSettingTab(this.settingTab);

        this.triggerManager.setupAutoSyncInterval();
        this.triggerManager.registerTriggers();

        this.registerEvent(
            this.app.workspace.on("file-menu", (menu, file) => {
                if (file instanceof TFile && isConflictCopyPath(file.path)) {
                    menu.addItem((item) => {
                        item.setTitle(t("labelResolveConflict"))
                            .setIcon("git-merge")
                            .onClick(() => new ConflictResolveModal(this.app, file.path).open());
                    });
                }
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
                    if (file instanceof TFolder) {
                        menu.addItem((item) => {
                            item.setTitle(t("labelPointInTimeFolder"))
                                .setIcon("history")
                                .onClick(() => this.openPointInTime(file.isRoot() ? "" : file.path));
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
        this.triggerManager?.destroy();
        this.syncStatusView?.unmount();
        this.syncStatusView = null;
        activeDocument.body.style.removeProperty("--vault-sync-diff-font-size");
        if (this.mobileSyncFabEl) {
            this.mobileSyncFabEl.remove();
        }
        this.syncManager?.progress.dispose();
        // Clean up background transfer queue (remove event listeners, flush history)
        if (this.syncManager) {
            this.syncManager.destroyTransferQueue();
        }
    }

    /** Diff view text size for this device type (history screen). */
    applyDiffFontSize(): void {
        const px = Platform.isMobile
            ? this.settings.diffFontSizeMobile
            : this.settings.diffFontSizeDesktop;
        activeDocument.body.style.setProperty("--vault-sync-diff-font-size", `${px}px`);
    }

    /** Show or hide the sync status display to match the setting. */
    refreshSyncStatusView(): void {
        if (this.settings.showSyncStatus) {
            this.mobileSyncFabEl?.remove();
            this.mobileSyncFabEl = null;
            if (!this.syncStatusView) this.syncStatusView = new SyncStatusView(this);
            this.syncStatusView.mount();
        } else {
            this.syncStatusView?.unmount();
            this.syncStatusView = null;
            if (Platform.isMobile && !this.mobileSyncFabEl) {
                this.mobileSyncFabEl = activeDocument.body.createDiv("vault-sync-mobile-fab");
                setIcon(this.mobileSyncFabEl, "sync");
                this.mobileSyncFabEl.setAttribute("aria-label", t("labelSyncTooltip"));
            }
        }
    }

    /** Manual sync started from the status panel (same path as the ribbon). */
    async runManualSync(): Promise<void> {
        if (this.syncRibbonIconEl) {
            await this.performSyncOperation(
                [{ element: this.syncRibbonIconEl, originalIcon: "sync" }],
                () => this.requestManualSync(),
            );
        } else {
            await this.requestManualSync();
        }
    }

    /** Buttons for the status panel at the top of the transfer status screen. */
    transferModalActions(): TransferModalActions {
        return {
            onSyncNow: () => void this.runManualSync(),
            onOpenSettings: () => this.openSettingsTab(),
            onReport: (title) => this.openDiagnostics(title),
        };
    }

    /** Open this plugin's settings tab. */
    openSettingsTab(): void {
        const setting = (
            this.app as unknown as {
                setting?: { open(): void; openTabById(id: string): void };
            }
        ).setting;
        if (!setting) return;
        setting.open();
        setting.openTabById(this.manifest.id);
    }

    /**
     * Manual sync from the ribbon or a command. The sync already logs a failure and
     * shows a notice, so it must not also surface as an unhandled rejection.
     */
    private async requestManualSync(): Promise<void> {
        try {
            await this.syncManager.requestSmartSync("manual-sync");
        } catch {
            /* reported by the sync */
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

    /**
     * Re-save an old (v1) vault-lock in the v2 key format after a successful unlock.
     * Non-fatal: on failure the next unlock tries again.
     */
    private async upgradeVaultLockIfNeeded(hashedPassword: string): Promise<void> {
        const engine = this.syncManager.cryptoEngine;
        if (!engine?.needsLockMigration?.() || !engine.updatePassword) return;
        try {
            const upgraded = await engine.updatePassword(hashedPassword);
            await this.syncManager.vaultLockService.uploadLockFile(upgraded);
            await this.syncManager.log("E2EE: vault-lock upgraded to the v2 key format.", "info");
        } catch (e) {
            await this.syncManager.log(`E2EE: vault-lock upgrade failed, will retry: ${String(e)}`, "warn");
        }
    }

    async loadSettings() {
        await this.settingsMgr.loadSettings();
        this.settings = this.settingsMgr.settings;
        this.secureStorage = this.settingsMgr.secureStorage;
    }

    /** The devices that sync this vault, and their changes */
    openDevices(): void {
        new DevicesModal(this.app, this.syncManager).open();
    }

    /** A folder (or the whole vault) back to a past time */
    openPointInTime(folder: string): void {
        if (!this.syncManager.supportsHistory) {
            new Notice(t("pitNotSupported"));
            return;
        }
        new PointInTimeModal(this.app, this.syncManager, folder).open();
    }

    /** Diagnostic info for a support request, to copy */
    openDiagnostics(issueTitle = ""): void {
        new DiagnosticsModal(this.app, async (includeLog) => {
            const agreements = this.settings.addonAgreements ?? {};
            const snapshot = {
                pluginVersion: this.manifest.version,
                obsidianVersion: apiVersion,
                platform: this.syncManager.deviceInfo?.platform ?? "",
                language: currentLanguage(),
                addOns: Object.values(agreements).map((a) => `${a.name} ${a.version}`),
                firstSyncDone: this.settings.hasCompletedFirstSync,
                settings: this.settings as unknown as Record<string, unknown>,
                ...this.syncManager.diagnosticsState(),
            };
            const log = includeLog ? await this.syncManager.readRecentLog() : null;
            return formatDiagnostics(snapshot, log);
        }, issueTitle).open();
    }

    /** The list of files kept in the cloud trash, with restore */
    openRemoteTrash(): void {
        new RemoteTrashModal(this.app, this.syncManager.adapter, this.settings.remoteTrashRetentionDays).open();
    }

    async saveSettings() {
        await this.settingsMgr.saveSettings();
    }

    async saveCredentials(
        clientId: string,
        clientSecret: string,
        accessToken: string | null,
        refreshToken: string | null,
        tokenExpiresAt?: number,
    ): Promise<void> {
        await this.credentialMgr.saveCredentials(
            clientId,
            clientSecret,
            accessToken,
            refreshToken,
            tokenExpiresAt,
        );
    }

    setAuthConfig(
        method: "default" | "custom-proxy" | "client-credentials",
        proxyUrl: string,
    ): void {
        this.credentialMgr.setAuthConfig(method, proxyUrl);
    }

    getClientId(): string {
        return this.credentialMgr.getClientId();
    }
    getClientSecret(): string {
        return this.credentialMgr.getClientSecret();
    }
    isAdapterAuthenticated(): boolean {
        return this.credentialMgr.isAdapterAuthenticated();
    }
    async adapterLogin(): Promise<void> {
        await this.credentialMgr.adapterLogin();
    }

    /** Sign out of the cloud account on this device. Returns false if refused. */
    async adapterLogout(): Promise<boolean> {
        if (this.syncManager.isSyncing()) {
            new Notice(t("noticeLogoutBusy"));
            return false;
        }
        await this.credentialMgr.adapterLogout();
        await this.syncManager.log("Signed out of the cloud account.", "system");
        new Notice(t("noticeLoggedOut"));
        return true;
    }

    async updateClientCredential(field: "clientId" | "clientSecret", value: string): Promise<void> {
        await this.credentialMgr.updateClientCredential(field, value);
    }

    // === SyncManager Facade (eliminates LoD chains in settings-schema.ts) ===

    triggerFullCleanup(): void {
        this.syncManager.triggerFullCleanup();
    }

    /**
     * The PC or mobile exclusion list changed. When it is the list of this kind of
     * device, files no longer left out are fetched now (the other kind of device
     * applies it when the settings reach it).
     */
    async applyExclusionListChange(
        key: "desktopExclusionPatterns" | "mobileExclusionPatterns",
        previous: string,
    ): Promise<void> {
        const ownKey = Platform.isMobile ? "mobileExclusionPatterns" : "desktopExclusionPatterns";
        if (key !== ownKey) return;
        await this.syncManager.applyDeviceScopeChange(previous);
        if (this.settings.hasCompletedFirstSync) void this.requestManualSync();
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

    getE2EESettingsSections(): ReturnType<
        NonNullable<typeof this.syncManager.cryptoEngine>["getSettingsSections"]
    > {
        return this.syncManager.cryptoEngine?.getSettingsSections(this.buildE2EEContext()) || [];
    }
}
