import { App, Plugin, PluginSettingTab, Setting, TFile, setIcon, Platform, Notice } from "obsidian";
import { GoogleDriveAdapter } from "./adapters/google-drive";
import { SyncManager, type SyncTrigger } from "./sync-manager";
import { SecureStorage } from "./secure-storage";
import { HistoryModal } from "./ui/history-modal";
import { DEFAULT_SETTINGS, SETTINGS_LIMITS } from "./constants";
import {
    DATA_LOCAL_DIR,
    DATA_REMOTE_DIR,
    DATA_FLEXIBLE_DIR,
    VaultSyncSettings,
} from "./types/settings";
import { t } from "./i18n";
import { getSettingsSections } from "./ui/settings-schema";

export default class VaultSync extends Plugin {
    settings!: VaultSyncSettings;
    adapter!: GoogleDriveAdapter;
    syncManager!: SyncManager;
    secureStorage!: SecureStorage;
    private isReady = false;
    private syncRibbonIconEl: HTMLElement | null = null;
    private manualSyncInProgress = false;
    private lastSaveRequestTime = 0;
    private lastModifyTime = 0;
    private mobileSyncFabEl: HTMLElement | null = null;
    private autoSyncInterval: number | null = null;
    private settingTab: VaultSyncSettingTab | null = null;

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
        // 1. Initialize adapter first with defaults
        this.adapter = new GoogleDriveAdapter(
            "",
            "",
            this.app.vault.getName(),
            DEFAULT_SETTINGS.cloudRootFolder,
        );

        // 2. Load settings (populates adapter if credentials exist, handles data.json migration)
        await this.loadSettings();

        // 3. MIGRATION: Move files to new layout (ensures local-index.json is in the right place)
        await this.migrateFileLayout();

        // 4. Initialize SyncManager with REAL loaded settings
        this.syncManager = new SyncManager(
            this.app,
            this.adapter,
            `${this.manifest.dir}/${DATA_REMOTE_DIR}/sync-index.json`,
            this.settings,
            this.manifest.dir || "",
            t,
        );
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

        await this.syncManager.log(
            `=== Plugin Startup: version=${this.manifest.version} ===`,
            "system",
        );

        // Handle Token Expiry / Revocation
        this.adapter.onAuthFailure = async () => {
            console.log("VaultSync: Auth failed (token expired/revoked). Clearing credentials.");
            new Notice(t("noticeAuthFailed") + ": Session expired. Please login again.", 0);
            await this.secureStorage.clearCredentials();
            this.adapter.setTokens(null, null);
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
                        "Startup grace period ended. Triggering initial Smart Sync.",
                        "system",
                    );

                    // First time sync -> "initial-sync" (loud). Subsequent -> "startup-sync" (quiet).
                    const isFirstSync = !this.settings.hasCompletedFirstSync;
                    const trigger: SyncTrigger = isFirstSync ? "initial-sync" : "startup-sync";

                    await this.syncManager.requestSmartSync(trigger, true);

                    this.isReady = true;

                    if (isFirstSync) {
                        this.settings.hasCompletedFirstSync = true;
                        await this.saveSettings();
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
                await this.syncManager.notify("noticeScanningLocalFiles");
                await this.syncManager.requestBackgroundScan(false);
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
                new Notice(t("noticeAuthFailed") + ": Invalid state");
                return;
            }

            if (params.code) {
                try {
                    await this.adapter.exchangeCodeForToken(params.code);
                    const tokens = this.adapter.getTokens();
                    await this.saveCredentials(
                        this.adapter.clientId,
                        this.adapter.clientSecret,
                        tokens.accessToken,
                        tokens.refreshToken,
                    );
                    new Notice(t("noticeAuthSuccess"));

                    // Cleanup storage
                    window.localStorage.removeItem("vault-sync-verifier");
                    window.localStorage.removeItem("vault-sync-state");
                } catch (e: any) {
                    new Notice(`${t("noticeAuthFailed")}: ${e.message}`);
                    console.error("VaultSync: Auth failed via protocol handler", e);
                }
            } else if (params.error) {
                new Notice(`${t("noticeAuthFailed")}: ${params.error}`);
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
    }

    private async manualSyncTrigger() {
        const targets = [];
        if (this.syncRibbonIconEl)
            targets.push({ element: this.syncRibbonIconEl, originalIcon: "sync" });
        if (this.mobileSyncFabEl)
            targets.push({ element: this.mobileSyncFabEl, originalIcon: "sync" });

        await this.syncManager.log("[Trigger] Activated via manual", "system");

        if (targets.length > 0) {
            await this.performSyncOperation(targets, () =>
                this.syncManager.requestSmartSync("manual-sync"),
            );
        } else {
            await this.syncManager.requestSmartSync("manual-sync");
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
        const legacyRemoteDataPath = `${this.manifest.dir}/${DATA_REMOTE_DIR}/data.json`;
        const legacyRootDataPath = `${this.manifest.dir}/data.json`;

        // MIGRATION: Split data.json (root or remote) into open-data.json and local-data.json
        // Check for root data.json first (Obsidian standard), then remote data.json (VaultSync legacy)
        let legacySourcePath = null;
        if (await this.app.vault.adapter.exists(legacyRootDataPath)) {
            legacySourcePath = legacyRootDataPath;
        } else if (await this.app.vault.adapter.exists(legacyRemoteDataPath)) {
            legacySourcePath = legacyRemoteDataPath;
        }

        if (legacySourcePath && !(await this.app.vault.adapter.exists(openDataPath))) {
            try {
                console.log(`VaultSync: Migrating ${legacySourcePath} to new structure...`);
                const legacyContent = await this.app.vault.adapter.read(legacySourcePath);
                const legacyData = JSON.parse(legacyContent);

                // Extract Local Data
                const localData = {
                    encryptionSecret: legacyData.encryptionSecret,
                    hasCompletedFirstSync: legacyData.hasCompletedFirstSync,
                };
                // Extract Open Data (Everything else)
                const openData = { ...legacyData };
                delete openData.encryptionSecret;
                delete openData.hasCompletedFirstSync;
                // Remove deprecated credential fields if they exist
                delete openData.clientId;
                delete openData.clientSecret;
                delete openData.accessToken;
                delete openData.refreshToken;

                // Ensure directories exist
                await this.app.vault.adapter
                    .mkdir(`${this.manifest.dir}/${DATA_FLEXIBLE_DIR}`)
                    .catch(() => {});
                await this.app.vault.adapter
                    .mkdir(`${this.manifest.dir}/${DATA_LOCAL_DIR}`)
                    .catch(() => {});

                // Write new files
                await this.app.vault.adapter.write(
                    localDataPath,
                    JSON.stringify(localData, null, 2),
                );
                await this.app.vault.adapter.write(openDataPath, JSON.stringify(openData, null, 2));

                // Remove old file
                await this.app.vault.adapter.remove(legacySourcePath);
                console.log("VaultSync: Migration complete.");
            } catch (e) {
                console.error("VaultSync: Failed to migrate data.json", e);
            }
        }

        // Load Open Data
        if (await this.app.vault.adapter.exists(openDataPath)) {
            try {
                const openData = JSON.parse(await this.app.vault.adapter.read(openDataPath));
                loadedSettings = { ...loadedSettings, ...openData };
            } catch (e) {
                console.error("VaultSync: Failed to load open-data.json", e);
            }
        }

        // Load Local Data
        if (await this.app.vault.adapter.exists(localDataPath)) {
            try {
                const localData = JSON.parse(await this.app.vault.adapter.read(localDataPath));
                loadedSettings = { ...loadedSettings, ...localData };
            } catch (e) {
                console.error("VaultSync: Failed to load local-data.json", e);
            }
        }

        // Fallback: Try load from root (very old legacy)
        if (Object.keys(loadedSettings).length === 0) {
            const rootData = (await this.loadData()) || {};
            loadedSettings = { ...rootData };
        }

        this.settings = Object.assign({}, DEFAULT_SETTINGS, loadedSettings);

        // MIGRATION: Structured Triggers
        if (!(this.settings as any).triggerConfigStrategy) {
            this.settings.triggerConfigStrategy = "unified";
            const oldSettings = loadedSettings as any;
            if (
                oldSettings.autoSyncIntervalSec !== undefined ||
                oldSettings.enableStartupSync !== undefined
            ) {
                const triggers = {
                    enableStartupSync: oldSettings.enableStartupSync ?? true,
                    autoSyncIntervalSec:
                        oldSettings.autoSyncIntervalSec ?? SETTINGS_LIMITS.autoSyncInterval.default,
                    onSaveDelaySec:
                        oldSettings.onSaveDelaySec ?? SETTINGS_LIMITS.onSaveDelay.default,
                    onModifyDelaySec:
                        oldSettings.onModifyDelaySec ?? SETTINGS_LIMITS.onModifyDelay.default,
                    onLayoutChangeDelaySec:
                        oldSettings.onLayoutChangeDelaySec ??
                        SETTINGS_LIMITS.onLayoutChangeDelay.default,
                };
                this.settings.unifiedTriggers = { ...triggers };
                this.settings.desktopTriggers = { ...triggers };
                this.settings.mobileTriggers = { ...triggers };
            }
        }

        // SEC-010: Initialize SecureStorage early to use its Keychain methods
        this.secureStorage = new SecureStorage(
            this.app,
            this.manifest.dir || "",
            this.settings.encryptionSecret || "temp-key",
        );

        // SEC-011: Prioritize encryptionSecret from Keychain
        if (this.app.secretStorage) {
            const keychainSecret = await this.secureStorage.getExtraSecret("encryption-secret");
            if (keychainSecret) {
                this.settings.encryptionSecret = keychainSecret;
                // Update internal secret for file-based fallback support
                this.secureStorage.setMasterSecret(keychainSecret);
            } else if (this.settings.encryptionSecret) {
                // Migrate from file to Keychain
                console.log("VaultSync: Migrating encryptionSecret to Keychain...");
                await this.secureStorage.setExtraSecret(
                    "encryption-secret",
                    this.settings.encryptionSecret,
                );
                // After migration, we save settings to clean up the local file
                await this.saveSettings();
            }
        }

        // SEC-001: Ensure encryption secret exists (if not found in file or Keychain)
        if (!this.settings.encryptionSecret) {
            const array = new Uint8Array(32);
            window.crypto.getRandomValues(array);
            const newSecret = Array.from(array, (b) => b.toString(16).padStart(2, "0")).join("");
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
            );
            this.adapter.updateConfig(
                credentials.clientId || "",
                credentials.clientSecret || "",
                this.app.vault.getName(),
                this.settings.cloudRootFolder,
            );
        }

        // MIGRATION: Check if legacy credentials exist in settings (unencrypted) and move them
        const data: any = this.settings;
        if (data && (data.clientId || data.accessToken)) {
            console.log("VaultSync: Migrating credentials to secure storage...");
            await this.saveCredentials(
                data.clientId || "",
                data.clientSecret || "",
                data.accessToken || null,
                data.refreshToken || null,
            );

            // Access settings directly to delete properties
            const settingsAny = this.settings as any;
            delete settingsAny["clientId"];
            delete settingsAny["clientSecret"];
            delete settingsAny["accessToken"];
            delete settingsAny["refreshToken"];
            await this.saveSettings();
            console.log("VaultSync: Migration complete.");
        }
    }

    async saveSettings() {
        // Ensure directories exist
        const flexibleDir = `${this.manifest.dir}/${DATA_FLEXIBLE_DIR}`;
        const localDir = `${this.manifest.dir}/${DATA_LOCAL_DIR}`;

        if (!(await this.app.vault.adapter.exists(flexibleDir))) {
            await this.app.vault.createFolder(flexibleDir).catch(() => {});
        }
        if (!(await this.app.vault.adapter.exists(localDir))) {
            await this.app.vault.createFolder(localDir).catch(() => {});
        }

        // Split Settings
        const localKeys = ["encryptionSecret", "hasCompletedFirstSync"];
        const localData: any = {};
        const openData: any = {};

        for (const key in this.settings) {
            if (Object.prototype.hasOwnProperty.call(this.settings, key)) {
                if (localKeys.includes(key)) {
                    // SEC-012: Do not save encryptionSecret to file if Keychain is active
                    if (key === "encryptionSecret" && this.app.secretStorage) {
                        continue;
                    }
                    localData[key] = (this.settings as any)[key];
                } else {
                    openData[key] = (this.settings as any)[key];
                }
            }
        }

        // Save to respective files
        const openDataPath = `${flexibleDir}/open-data.json`;
        const localDataPath = `${localDir}/local-data.json`;

        await this.app.vault.adapter.write(openDataPath, JSON.stringify(openData, null, 2));
        await this.app.vault.adapter.write(localDataPath, JSON.stringify(localData, null, 2));
    }

    async saveCredentials(
        clientId: string,
        clientSecret: string,
        accessToken: string | null,
        refreshToken: string | null,
    ) {
        this.adapter.setCredentials(clientId, clientSecret);
        this.adapter.setTokens(accessToken, refreshToken);
        await this.secureStorage.saveCredentials({
            clientId,
            clientSecret,
            accessToken,
            refreshToken,
        });

        // Also update live adapter config
        this.adapter.updateConfig(
            clientId,
            clientSecret,
            this.app.vault.getName(),
            this.settings.cloudRootFolder,
        );
    }

    async migrateFileLayout() {
        const moves = [
            { old: "sync-index.json", new: `${DATA_REMOTE_DIR}/sync-index.json` },
            { old: "sync-index_raw.json", new: `${DATA_REMOTE_DIR}/sync-index_raw.json` },
            { old: "communication.json", new: `${DATA_REMOTE_DIR}/communication.json` },
            { old: "local-index.json", new: `${DATA_LOCAL_DIR}/local-index.json` },
            { old: "dirty.json", new: `${DATA_LOCAL_DIR}/dirty.json` },
            // Note: .sync-state migration handled/accessed by SecureStorage as well,
            // but we can move it here if it exists in old standard location.
            { old: ".sync-state", new: `${DATA_LOCAL_DIR}/.sync-state` },
        ];

        // Ensure directories exist
        const dirs = [
            `${this.manifest.dir}/${DATA_LOCAL_DIR}`,
            `${this.manifest.dir}/${DATA_REMOTE_DIR}`,
            `${this.manifest.dir}/${DATA_FLEXIBLE_DIR}`,
        ];
        for (const dir of dirs) {
            if (!(await this.app.vault.adapter.exists(dir))) {
                await this.app.vault.createFolder(dir).catch(() => {});
            }
        }

        for (const move of moves) {
            const oldPath = `${this.manifest.dir}/${move.old}`;
            const newPath = `${this.manifest.dir}/${move.new}`;

            if (
                (await this.app.vault.adapter.exists(oldPath)) &&
                !(await this.app.vault.adapter.exists(newPath))
            ) {
                try {
                    // Copy then remove to be safe
                    const content = await this.app.vault.adapter.readBinary(oldPath);
                    await this.app.vault.adapter.writeBinary(newPath, content);
                    await this.app.vault.adapter.remove(oldPath);
                    console.log(`VaultSync: Migrated ${move.old} to ${move.new}`);
                } catch (e) {
                    console.error(`VaultSync: Failed to migrate ${move.old}`, e);
                }
            }
        }
    }
}

class VaultSyncSettingTab extends PluginSettingTab {
    plugin: VaultSync;

    constructor(app: App, plugin: VaultSync) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        const scrollPos = containerEl.scrollTop;
        containerEl.empty();
        containerEl.addClass("vault-sync-settings-container");

        containerEl.createEl("h2", { text: t("settingSettingsTitle") });

        // 1. Authentication (Manually handled due to complex UI)
        containerEl.createEl("h3", { text: t("settingAuthSection") });

        new Setting(containerEl)
            .setName(t("settingClientId"))
            .setDesc(t("settingClientIdDesc"))
            .addText((text) =>
                text.setValue(this.plugin.adapter.clientId).onChange(async (value) => {
                    // Update adapter temporarily so config is live
                    this.plugin.adapter.updateConfig(
                        value,
                        this.plugin.adapter.clientSecret,
                        this.plugin.app.vault.getName(),
                        this.plugin.settings.cloudRootFolder,
                    );
                    // Persist securely
                    await this.plugin.saveCredentials(
                        value,
                        this.plugin.adapter.clientSecret,
                        this.plugin.adapter.getTokens().accessToken,
                        this.plugin.adapter.getTokens().refreshToken,
                    );
                }),
            );

        new Setting(containerEl)
            .setName(t("settingClientSecret"))
            .setDesc(t("settingClientSecretDesc"))
            .addText((text) =>
                text.setValue(this.plugin.adapter.clientSecret).onChange(async (value) => {
                    this.plugin.adapter.updateConfig(
                        this.plugin.adapter.clientId,
                        value,
                        this.plugin.app.vault.getName(),
                        this.plugin.settings.cloudRootFolder,
                    );
                    await this.plugin.saveCredentials(
                        this.plugin.adapter.clientId,
                        value,
                        this.plugin.adapter.getTokens().accessToken,
                        this.plugin.adapter.getTokens().refreshToken,
                    );
                }),
            );

        new Setting(containerEl)
            .setName(t("settingLogin"))
            .setDesc(t("settingLoginDesc"))
            .addButton((button) =>
                button
                    .setButtonText(
                        this.plugin.adapter.isAuthenticated()
                            ? t("settingRelogin")
                            : t("settingLogin"),
                    )
                    .setCta()
                    .onClick(async () => {
                        await this.plugin.adapter.login();
                    }),
            );

        // Render Schema-based Settings
        const sections = getSettingsSections(this.plugin);
        for (const section of sections) {
            // Check visibility
            // Since section doesn't have isHidden in schema (items do), we render title if at least one item is visible?
            // Or just render title. Schema definition has items hidden dynamically.
            // Let's check section definition update in previous step...
            // Ah, I added isHidden to items, but section "developer" also has isHidden in schema.ts.
            // But SettingSection interface definition in schema.ts DOES NOT have isHidden.
            // So my schema.ts code has a property that doesn't exist in the interface. Typescript might complain?
            // Or I might have omitted it.
            // Actually, I should cast or just ignore for a sec, or better, update the interface if needed.
            // But let's assume I need to handle it.

            // Wait, I need to import getSettingsSections first.

            if ((section as any).isHidden && (section as any).isHidden(this.plugin.settings)) {
                continue;
            }

            containerEl.createEl("h3", { text: section.title });
            if (section.description) {
                containerEl.createEl("p", {
                    text: section.description,
                    cls: "setting-item-description",
                });
            }

            for (const item of section.items) {
                if (item.isHidden && item.isHidden(this.plugin.settings)) continue;

                const setting = new Setting(containerEl)
                    .setName(item.label)
                    .setDesc(item.desc || "");

                switch (item.type) {
                    case "toggle":
                        setting.addToggle((toggle) =>
                            toggle
                                .setValue(this.getSettingValue(item.key) as boolean)
                                .onChange(async (val) => {
                                    this.setSettingValue(item.key, val);
                                    await this.plugin.saveSettings();
                                    if (item.onChange) await item.onChange(val, this.plugin);
                                }),
                        );
                        break;
                    case "text":
                        setting.addText((text) => {
                            text.setValue(String(this.getSettingValue(item.key) || ""))
                                .setPlaceholder(item.placeholder || "")
                                .onChange(async (val) => {
                                    if (item.onChange) {
                                        await item.onChange(val, this.plugin);
                                    } else {
                                        this.setSettingValue(item.key, val);
                                        await this.plugin.saveSettings();
                                    }
                                });
                        });
                        break;
                    case "textarea":
                        setting.addTextArea((text) => {
                            text.setValue(String(this.getSettingValue(item.key) || ""))
                                .setPlaceholder(item.placeholder || "")
                                .onChange(async (val) => {
                                    this.setSettingValue(item.key, val);
                                    await this.plugin.saveSettings();
                                    if (item.onChange) await item.onChange(val, this.plugin);
                                });
                            if (item.key === "exclusionPatterns") {
                                text.inputEl.addClass("vault-sync-exclusion-textarea");
                                text.inputEl.rows = 10;
                            }
                        });
                        break;
                    case "dropdown":
                        setting.addDropdown((dropdown) => {
                            if (item.options) {
                                for (const [k, v] of Object.entries(item.options)) {
                                    dropdown.addOption(k, v);
                                }
                            }
                            dropdown
                                .setValue(String(this.getSettingValue(item.key)))
                                .onChange(async (val) => {
                                    this.setSettingValue(item.key, val);
                                    await this.plugin.saveSettings();
                                    if (item.onChange) await item.onChange(val, this.plugin);
                                });
                        });
                        break;
                    case "number":
                        setting.addText((text) => {
                            text.setValue(String(this.getSettingValue(item.key)))
                                .setPlaceholder(item.limits ? String(item.limits.default) : "")
                                .onChange(async (val) => {
                                    const numVal = this.validateNumber(
                                        val,
                                        item.limits?.min ?? -Infinity,
                                        item.limits?.max ?? Infinity,
                                        item.limits?.default ?? 0,
                                        item.limits?.disabled,
                                    );
                                    this.setSettingValue(item.key, numVal);
                                    await this.plugin.saveSettings();
                                    if (item.onChange) await item.onChange(numVal, this.plugin);
                                });
                        });
                        break;
                }
            }
        }

        // Restore scroll position
        containerEl.scrollTop = scrollPos;
    }

    private validateNumber(
        value: string,
        min: number,
        max: number,
        defaultValue: number,
        disabledValue?: number,
    ): number {
        const num = Number(value);
        if (isNaN(num)) return defaultValue;
        if (disabledValue !== undefined && num === disabledValue) return num;
        if (num < min || num > max) return defaultValue;
        return num;
    }

    private getSettingValue(key: string): any {
        if (key.includes(".")) {
            // Path-based access: "nested.key"
            return key.split(".").reduce((o, i) => (o as any)?.[i], this.plugin.settings);
        }
        return (this.plugin.settings as any)[key];
    }

    private setSettingValue(key: string, value: any): void {
        if (key.includes(".")) {
            // Path-based update: "nested.key"
            const parts = key.split(".");
            const last = parts.pop()!;
            const target = parts.reduce((o, i) => (o as any)[i], this.plugin.settings);
            (target as any)[last] = value;
        } else {
            (this.plugin.settings as any)[key] = value;
        }
    }
}
