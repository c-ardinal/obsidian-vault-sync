import { App, Plugin, PluginSettingTab, Setting, TFile, setIcon, Platform, Notice } from "obsidian";
import { GoogleDriveAdapter } from "./adapters/google-drive";
import { SyncManager } from "./sync-manager";
import { SecureStorage } from "./secure-storage";
import { HistoryModal } from "./ui/history-modal";
import { DEFAULT_SETTINGS, SETTINGS_LIMITS } from "./constants";
import { DATA_LOCAL_DIR, DATA_REMOTE_DIR, VaultSyncSettings } from "./types/settings";
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
    private autoSyncInterval: number | null = null;

    async onload() {
        // Initialize adapter first with defaults
        this.adapter = new GoogleDriveAdapter(
            "",
            "",
            this.app.vault.getName(),
            DEFAULT_SETTINGS.cloudRootFolder,
        );

        await this.loadSettings();

        // Update adapter with loaded settings
        this.adapter.updateConfig(
            this.adapter.clientId, // set inside loadSettings
            this.adapter.clientSecret, // set inside loadSettings
            this.app.vault.getName(),
            this.settings.cloudRootFolder,
        );

        // Handle Token Expiry / Revocation
        this.adapter.onAuthFailure = async () => {
            console.log("VaultSync: Auth failed (token expired/revoked). Clearing credentials.");
            new Notice(t("noticeAuthFailed") + ": Session expired. Please login again.", 0);
            await this.secureStorage.clearCredentials();
            this.adapter.setTokens(null, null);
        };

        // MIGRATION: Move files to new layout
        await this.migrateFileLayout();

        // Settings are loaded in onload, but we need to ensure adapter has credentials
        // This is handled in loadSettings now.
        this.syncManager = new SyncManager(
            this.app,
            this.adapter,
            `${this.manifest.dir}/${DATA_REMOTE_DIR}/sync-index.json`,
            this.settings,
            this.manifest.dir || "",
            t,
        );

        await this.syncManager.log(`=== Plugin Startup: version=${this.manifest.version} ===`);

        await this.syncManager.loadIndex();

        // Register Activity Callbacks for Auto-Sync Animation
        this.syncManager.setActivityCallbacks(
            () => {
                if (!this.manualSyncInProgress && this.syncRibbonIconEl) {
                    setIcon(this.syncRibbonIconEl, "sync");
                    this.syncRibbonIconEl.addClass("vault-sync-spinning");
                }
            },
            () => {
                if (!this.manualSyncInProgress && this.syncRibbonIconEl) {
                    this.syncRibbonIconEl.removeClass("vault-sync-spinning");
                    setIcon(this.syncRibbonIconEl, "sync");
                }
            },
        );

        // 0. Startup Grace Period
        this.app.workspace.onLayoutReady(() => {
            if (this.settings.enableStartupSync) {
                window.setTimeout(async () => {
                    this.isReady = true;
                    this.syncManager.log(
                        "Startup grace period ended. Triggering initial Smart Sync.",
                    );

                    // First time sync OR fresh start -> Loud (notify + icon spin). Subsequent -> Silent.
                    const isFirstSync = !this.settings.hasCompletedFirstSync;
                    const isFreshStart = this.syncManager.isFreshStart();
                    const shouldBeLoud = isFirstSync || isFreshStart;

                    await this.syncManager.requestSmartSync(!shouldBeLoud, true);

                    if (isFirstSync) {
                        this.settings.hasCompletedFirstSync = true;
                        await this.saveSettings();
                    }
                }, this.settings.startupDelaySec * 1000);
            } else {
                this.isReady = true;
                this.syncManager.log("Startup sync disabled. Auto-sync hooks enabled.");
            }
        });

        // 1. Ribbon Icon
        // Ribbon button uses Smart Sync for O(1) performance when no changes
        this.syncRibbonIconEl = this.addRibbonIcon("sync", t("labelSyncTooltip"), async () => {
            if (this.syncRibbonIconEl) {
                await this.performSyncOperation(
                    [{ element: this.syncRibbonIconEl, originalIcon: "sync" }],
                    () => this.syncManager.requestSmartSync(false),
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
                            await this.syncManager.requestSmartSync(false);
                        },
                    );
                } else {
                    await this.syncManager.requestSmartSync(false);
                }
            },
        });

        this.addCommand({
            id: "force-full-scan",
            name: t("labelFullAudit"),
            callback: async () => {
                await this.syncManager.notify(t("statusScanningLocalFiles"));
                await this.syncManager.requestBackgroundScan(false);
            },
        });

        this.addSettingTab(new VaultSyncSettingTab(this.app, this));

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
    }

    onunload() {
        if (this.autoSyncInterval) {
            window.clearInterval(this.autoSyncInterval);
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
        }

        try {
            await operation();
        } finally {
            for (const target of targets) {
                target.element.removeClass("vault-sync-spinning");
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
            this.settings.autoSyncIntervalSec !== SETTINGS_LIMITS.autoSyncInterval.disabled &&
            this.settings.autoSyncIntervalSec >= SETTINGS_LIMITS.autoSyncInterval.min
        ) {
            this.autoSyncInterval = window.setInterval(() => {
                this.triggerSmartSync("interval");
            }, this.settings.autoSyncIntervalSec * 1000);
            this.registerInterval(this.autoSyncInterval);
        }
    }

    /**
     * Trigger Smart Sync - high priority, O(1) check via sync-index.json
     * Used for user-initiated actions (save, modify, layout change)
     * @param source The source of the trigger for debugging and priority handling
     */
    private async triggerSmartSync(source: string = "unknown") {
        if (!this.isReady) return;

        // Respect debounce: If user is actively editing, suppressed triggers (layout, interval)
        // should NOT interrupt. The 'modify' trigger (debounced) will handle it eventually.
        if (source === "interval") {
            const timeSinceModify = Date.now() - this.lastModifyTime;
            if (timeSinceModify < this.settings.onModifyDelaySec * 1000) {
                await this.syncManager.log(
                    `[Trigger] Skipped ${source} trigger (active editing detected: ${timeSinceModify}ms ago)`,
                );
                return;
            }
        }

        if (source === "interval" && this.syncManager.isSyncing()) {
            // Already syncing, interval trigger should be quiet
            await this.syncManager.requestSmartSync(true);
            return;
        }

        await this.syncManager.log(`[Trigger] Activated via ${source}`);
        // Helper for user-initiated actions that shouldn't lock UI immediately (like save/modify)
        // Animation is handled via Activity Callbacks if changes are found
        await this.syncManager.requestSmartSync(true);
    }

    private registerTriggers() {
        // 2. Save Trigger (Ctrl+S)
        this.registerDomEvent(document, "keydown", (evt: KeyboardEvent) => {
            if (this.settings.onSaveDelaySec === SETTINGS_LIMITS.onSaveDelay.disabled) return;
            if ((evt.ctrlKey || evt.metaKey) && evt.key === "s") {
                this.lastSaveRequestTime = Date.now();
                if (this.settings.onSaveDelaySec === 0) {
                    this.triggerSmartSync("save");
                } else {
                    window.setTimeout(() => {
                        this.triggerSmartSync("save");
                    }, this.settings.onSaveDelaySec * 1000);
                }
            }
        });

        // 3. Modify trigger with debounce - marks dirty and triggers Smart Sync
        let modifyTimeout: number | null = null;
        this.registerEvent(
            this.app.vault.on("modify", (file) => {
                if (!this.isReady) return;
                if (!(file instanceof TFile)) return;
                if (this.syncManager.shouldIgnore(file.path)) return;
                // Track modification time for debounce protection
                this.lastModifyTime = Date.now();
                // Mark file as dirty immediately
                this.syncManager.markDirty(file.path);
                // Check if this modify is result of explicit save (happened closely after Ctrl+S)
                // If so, trigger immediately (bypass debounce)
                if (Date.now() - this.lastSaveRequestTime < 2000) {
                    if (modifyTimeout) window.clearTimeout(modifyTimeout);
                    this.triggerSmartSync("save");
                    return;
                }
                // Debounce the actual sync
                if (this.settings.onModifyDelaySec === SETTINGS_LIMITS.onModifyDelay.disabled)
                    return;
                if (modifyTimeout) window.clearTimeout(modifyTimeout);
                modifyTimeout = window.setTimeout(() => {
                    this.triggerSmartSync("modify");
                }, this.settings.onModifyDelaySec * 1000);
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
                    this.settings.onLayoutChangeDelaySec ===
                    SETTINGS_LIMITS.onLayoutChangeDelay.disabled
                )
                    return;
                if (this.settings.onLayoutChangeDelaySec === 0) {
                    this.triggerSmartSync("layout-change");
                } else {
                    window.setTimeout(() => {
                        this.triggerSmartSync("layout-change");
                    }, this.settings.onLayoutChangeDelaySec * 1000);
                }
            }),
        );
    }

    async loadSettings() {
        let loadedData: Partial<VaultSyncSettings> = {};
        const dataPath = `${this.manifest.dir}/${DATA_REMOTE_DIR}/data.json`;
        if (await this.app.vault.adapter.exists(dataPath)) {
            try {
                loadedData = JSON.parse(await this.app.vault.adapter.read(dataPath));
            } catch (e) {
                console.error("VaultSync: Failed to load data.json", e);
            }
        } else {
            // Fallback/Migration: Try load from root
            loadedData = (await this.loadData()) || {};
        }

        this.settings = Object.assign({}, DEFAULT_SETTINGS, loadedData);

        // SEC-001: Ensure encryption secret exists
        if (!this.settings.encryptionSecret) {
            const array = new Uint8Array(32);
            window.crypto.getRandomValues(array);
            this.settings.encryptionSecret = Array.from(array, (b) =>
                b.toString(16).padStart(2, "0"),
            ).join("");
            await this.saveSettings();
        }

        // Initialize SecureStorage with the secret
        this.secureStorage = new SecureStorage(
            this.app,
            this.manifest.dir || "",
            this.settings.encryptionSecret,
        );

        // DEBUG: Temporary notice to help debug path issues
        this.secureStorage.loadCredentials().then((creds) => {
            new Notice(
                `SecureStorage Path: ${(this.secureStorage as any).filePath}\nLoaded: ${!!creds}`,
            );
        });

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

        // MIGRATION: Check if legacy credentials exist in data.json (unencrypted) and move them
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
        // Ensure data dir exists
        const dataDir = `${this.manifest.dir}/${DATA_REMOTE_DIR}`;
        if (!(await this.app.vault.adapter.exists(dataDir))) {
            await this.app.vault.createFolder(dataDir).catch(() => {});
        }

        // Save to data.json in new layout
        const dataPath = `${dataDir}/data.json`;
        await this.app.vault.adapter.write(dataPath, JSON.stringify(this.settings, null, 2));

        // For compatibility with VaultSync mobile/other versions that use loadData
        await this.saveData(this.settings);
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
            { old: "data.json", new: `${DATA_REMOTE_DIR}/data.json` },
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
                        if (!Platform.isMobile) {
                            const tokens = this.plugin.adapter.getTokens();
                            await this.plugin.saveCredentials(
                                this.plugin.adapter.clientId,
                                this.plugin.adapter.clientSecret,
                                tokens.accessToken,
                                tokens.refreshToken,
                            );
                            await this.plugin.syncManager.notify(t("noticeAuthSuccess"));
                            this.display();
                        }
                    }),
            );

        // Mobile/Manual Auth
        if (Platform.isMobile) {
            containerEl.createEl("h4", { text: t("settingManualAuthSection") });
            containerEl.createEl("p", {
                text: t("settingManualAuthDesc"),
                cls: "setting-item-description",
            });

            let textComponent: any;
            new Setting(containerEl)
                .setName(t("settingAuthorize"))
                .addText((text) => {
                    textComponent = text;
                    text.setPlaceholder(t("settingManualAuthPlaceholder")).inputEl.style.width =
                        "100%";
                })
                .addButton((button) =>
                    button.setButtonText(t("settingManualAuthVerify")).onClick(async () => {
                        const val = textComponent.getValue().trim();
                        if (!val) return;

                        let code = val;
                        // Extract code from URL if full URL is pasted
                        if (val.includes("code=")) {
                            try {
                                const url = new window.URL(val);
                                code = url.searchParams.get("code") || val;
                            } catch (e) {
                                // ignore
                            }
                        }

                        try {
                            await this.plugin.adapter.exchangeCodeForToken(code);
                            const tokens = this.plugin.adapter.getTokens();
                            await this.plugin.saveCredentials(
                                this.plugin.adapter.clientId,
                                this.plugin.adapter.clientSecret,
                                tokens.accessToken,
                                tokens.refreshToken,
                            );
                            await this.plugin.syncManager.notify(t("noticeAuthSuccess"));
                            this.display();
                        } catch (e) {
                            await this.plugin.syncManager.notify(
                                `${t("noticeAuthFailed")}: ${e instanceof Error ? e.message : String(e)}`,
                            );
                        }
                    }),
                )
                .setClass("auth-manual-input");
        }

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
                                .setValue(this.plugin.settings[item.key] as boolean)
                                .onChange(async (val) => {
                                    (this.plugin.settings as any)[item.key] = val;
                                    await this.plugin.saveSettings();
                                    if (item.onChange) await item.onChange(val, this.plugin);
                                }),
                        );
                        break;
                    case "text":
                        setting.addText((text) => {
                            text.setValue(String(this.plugin.settings[item.key] || ""))
                                .setPlaceholder(item.placeholder || "")
                                .onChange(async (val) => {
                                    if (item.onChange) {
                                        await item.onChange(val, this.plugin);
                                    } else {
                                        (this.plugin.settings as any)[item.key] = val;
                                        await this.plugin.saveSettings();
                                    }
                                });
                        });
                        break;
                    case "textarea":
                        setting.addTextArea((text) => {
                            text.setValue(String(this.plugin.settings[item.key] || ""))
                                .setPlaceholder(item.placeholder || "")
                                .onChange(async (val) => {
                                    (this.plugin.settings as any)[item.key] = val;
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
                                .setValue(String(this.plugin.settings[item.key]))
                                .onChange(async (val) => {
                                    // Handle numeric strings back to number if needed?
                                    // Usually settings are typed. Dropdown values are strings.
                                    // conflictStrategy is string. notificationLevel is string.
                                    // So direct assignment is fine for string types.
                                    (this.plugin.settings as any)[item.key] = val;
                                    await this.plugin.saveSettings();
                                    if (item.onChange) await item.onChange(val, this.plugin);
                                });
                        });
                        break;
                    case "number":
                        setting.addText((text) => {
                            text.setValue(String(this.plugin.settings[item.key]))
                                .setPlaceholder(item.limits ? String(item.limits.default) : "")
                                .onChange(async (val) => {
                                    const numVal = this.validateNumber(
                                        val,
                                        item.limits?.min ?? -Infinity,
                                        item.limits?.max ?? Infinity,
                                        item.limits?.default ?? 0,
                                        item.limits?.disabled,
                                    );
                                    (this.plugin.settings as any)[item.key] = numVal;
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
}
