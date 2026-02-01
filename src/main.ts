import {
    App,
    Notice,
    Plugin,
    PluginSettingTab,
    Setting,
    TFile,
    setIcon,
    requestUrl,
} from "obsidian";
import { GoogleDriveAdapter } from "./adapters/google-drive";
import { SyncManager } from "./sync-manager";
import { SecureStorage } from "./secure-storage";

// i18n Localization
const i18n: Record<string, Record<string, string>> = {
    en: {
        settingsTitle: "VaultSync Settings",
        authSection: "Authentication",
        authStatus: "Authentication Status",
        checkStatus: "Check Status",
        clientId: "Google Client ID",
        clientIdDesc: "Enter your Google Cloud Project Client ID",
        clientSecret: "Google Client Secret",
        clientSecretDesc: "Enter your Google Cloud Project Client Secret",
        login: "Login",
        loginDesc: "Authorize with Google Drive",
        authorize: "Authorize",
        authSuccess: "Successfully authenticated!",
        triggerSection: "Sync Triggers",
        startupSync: "Enable Startup Sync",
        startupSyncDesc: "Sync with cloud automatically upon starting Obsidian",
        startupDelay: "Startup Delay (seconds)",
        startupDelayDesc: "Wait for Obsidian to index files before syncing (0-600s)",
        autoSyncInterval: "Auto-sync Interval (seconds)",
        autoSyncIntervalDesc:
            "Sync periodically in the background (30-86400s). Set to 0 to disable.",
        triggerSave: "Trigger: Save (Ctrl+S)",
        triggerSaveDesc: "Sync when you explicitly save a file",
        triggerModify: "Trigger: On Modify (Mobile/Debounce)",
        triggerModifyDesc: "Sync after a period of inactivity while editing",
        modifyDelay: "Modify Delay (seconds)",
        modifyDelayDesc: "Seconds of inactivity before syncing (1-60s)",
        triggerLayout: "Trigger: Layout Change",
        triggerLayoutDesc: "Sync when switching between files or closing tabs",
        perfSection: "Performance",
        concurrency: "Concurrency",
        concurrencyDesc: "Number of parallel file Push/Pull during sync (1-10)",
        advancedSection: "Advanced",
        detailedNotifications: "Show Detailed Notifications",
        detailedNotificationsDesc: "Show progress notifications for each file pushed/pulled",
        enableLogging: "Enable Logging",
        enableLoggingDesc: "Developer: Write daily logs to obsidian-vault-sync/logs folder",
        cloudRootFolder: "Cloud Root Folder",
        cloudRootFolderDesc: "Root folder name on Google Drive (default: ObsidianVaultSync)",
        exclusionSection: "Exclusion Patterns",
        exclusionPatterns: "Exclude Files/Folders",
        exclusionPatternsDesc:
            "Glob patterns (one per line). Use * for any chars, ** for recursive dirs. Example: *.tmp, temp/**",
    },
    ja: {
        settingsTitle: "VaultSync 設定",
        authSection: "認証",
        authStatus: "認証ステータス",
        checkStatus: "確認",
        clientId: "Google Client ID",
        clientIdDesc: "Google Cloud Project の Client ID を入力してください",
        clientSecret: "Google Client Secret",
        clientSecretDesc: "Google Cloud Project の Client Secret を入力してください",
        login: "ログイン",
        loginDesc: "Google Drive と連携します",
        authorize: "認証",
        authSuccess: "認証に成功しました！",
        triggerSection: "同期トリガー",
        startupSync: "起動時に同期",
        startupSyncDesc: "Obsidian 起動時に自動でクラウドと同期します",
        startupDelay: "起動時の遅延 (秒)",
        startupDelayDesc: "同期開始前に待機する時間 (0-600秒)",
        autoSyncInterval: "自動同期の間隔 (秒)",
        autoSyncIntervalDesc: "バックグラウンドで定期的に同期 (30-86400秒, 0で無効)",
        triggerSave: "トリガー: 保存時 (Ctrl+S)",
        triggerSaveDesc: "明示的にファイルを保存した際に同期を実行",
        triggerModify: "トリガー: 編集時 (モバイル/デバウンス)",
        triggerModifyDesc: "編集後、一定時間操作がなければ同期を実行",
        modifyDelay: "編集後の遅延 (秒)",
        modifyDelayDesc: "同期を実行するまでの待機時間 (1-60秒)",
        triggerLayout: "トリガー: レイアウト変更時",
        triggerLayoutDesc: "ファイルを切り替えたり、タブを閉じたときに同期",
        perfSection: "パフォーマンス",
        concurrency: "並列実行数",
        concurrencyDesc: "同期時に並列で実行するファイルのプッシュ/プル数 (1-10)",
        advancedSection: "高度な設定",
        detailedNotifications: "詳細な通知を表示",
        detailedNotificationsDesc: "プッシュ/プルごとに進捗通知を表示します",
        enableLogging: "ログ出力を有効化",
        enableLoggingDesc: "開発者向け: obsidian-vault-sync/logs フォルダに日別ログを出力します",
        cloudRootFolder: "クラウドルートフォルダ",
        cloudRootFolderDesc:
            "Google Drive 上の同期先ルートフォルダ名 (デフォルト: ObsidianVaultSync)",
        exclusionSection: "除外パターン",
        exclusionPatterns: "除外ファイル/フォルダ",
        exclusionPatternsDesc:
            "globパターン (1行1パターン)。* は任意の文字、** は再帰ディレクトリ。例: *.tmp, temp/**",
    },
};

function t(key: string): string {
    const lang = window.localStorage.getItem("language") || "en";
    const dict = i18n[lang] || i18n["en"];
    return dict[key] || i18n["en"][key] || key;
}

interface VaultSyncSettings {
    // Sync Triggers
    enableStartupSync: boolean;
    startupDelaySec: number;

    enableAutoSyncInInterval: boolean;
    autoSyncIntervalSec: number;

    enableOnSaveTrigger: boolean;
    enableOnModifyTrigger: boolean;
    onModifyDelaySec: number;
    enableOnLayoutChangeTrigger: boolean;

    // Performance
    concurrency: number;

    // UI/Notifications
    showDetailedNotifications: boolean;

    // Developer
    enableLogging: boolean;
    cloudRootFolder: string;

    // Exclusion
    exclusionPatterns: string;
}

const DEFAULT_SETTINGS: VaultSyncSettings = {
    enableStartupSync: true,
    startupDelaySec: 10,
    enableAutoSyncInInterval: true,
    autoSyncIntervalSec: 1800, // 30 minutes
    enableOnSaveTrigger: true,
    enableOnModifyTrigger: true,
    onModifyDelaySec: 5,
    enableOnLayoutChangeTrigger: true,
    concurrency: 5,
    showDetailedNotifications: true,
    enableLogging: false,
    cloudRootFolder: "ObsidianVaultSync",
    exclusionPatterns:
        ".obsidian/plugins/obsidian-vault-sync/logs\n.obsidian/plugins/obsidian-vault-sync/.sync-state\n.git",
};

export default class VaultSync extends Plugin {
    settings!: VaultSyncSettings;
    adapter!: GoogleDriveAdapter;
    syncManager!: SyncManager;
    secureStorage!: SecureStorage;
    private isReady = false;
    private ribbonIconEl: HTMLElement | null = null;

    async onload() {
        // Initialize adapter first with defaults
        this.adapter = new GoogleDriveAdapter(
            "",
            "",
            this.app.vault.getName(),
            DEFAULT_SETTINGS.cloudRootFolder, // temp default
        );

        this.secureStorage = new SecureStorage(this.app, this.manifest.dir || "");

        await this.loadSettings();

        // Update adapter with loaded settings
        this.adapter.updateConfig(
            this.adapter.clientId, // set inside loadSettings
            this.adapter.clientSecret, // set inside loadSettings
            this.app.vault.getName(),
            this.settings.cloudRootFolder,
        );

        // Settings are loaded in onload, but we need to ensure adapter has credentials
        // This is handled in loadSettings now.

        this.syncManager = new SyncManager(
            this.app,
            this.adapter,
            `${this.manifest.dir}/sync-index.json`,
            this.settings,
            this.manifest.dir || "",
        );

        await this.syncManager.loadIndex();

        // 0. Startup Grace Period
        this.app.workspace.onLayoutReady(() => {
            if (this.settings.enableStartupSync) {
                window.setTimeout(async () => {
                    this.isReady = true;
                    this.syncManager.log(
                        "Startup grace period ended. Triggering initial auto-sync.",
                    );
                    await this.syncManager.sync(true); // Silent startup sync
                }, this.settings.startupDelaySec * 1000);
            } else {
                this.isReady = true;
                this.syncManager.log("Startup sync disabled. Auto-sync hooks enabled.");
            }
        });

        this.ribbonIconEl = this.addRibbonIcon("upload-cloud", "Push to Cloud", async () => {
            if (this.ribbonIconEl) {
                await this.performSyncOperation(this.ribbonIconEl, () => this.syncManager.push());
            }
        });

        this.addCommand({
            id: "push-vault",
            name: "Push Changes to Cloud",
            callback: () => {
                if (this.ribbonIconEl) {
                    this.performSyncOperation(this.ribbonIconEl, () => this.syncManager.push());
                }
            },
        });

        this.addCommand({
            id: "pull-vault",
            name: "Pull Changes from Cloud",
            callback: () => {
                if (this.ribbonIconEl) {
                    this.performSyncOperation(this.ribbonIconEl, () => this.syncManager.pull());
                } else {
                    this.syncManager.pull();
                }
            },
        });

        this.addCommand({
            id: "gdrive-login",
            name: "Google Drive: Login",
            callback: () => this.adapter.login(),
        });

        this.addSettingTab(new VaultSyncSettingTab(this.app, this));

        this.setupAutoSyncInterval();
        this.registerTriggers();
    }

    private autoSyncInterval: number | null = null;

    setupAutoSyncInterval() {
        // Clear existing
        if (this.autoSyncInterval) {
            window.clearInterval(this.autoSyncInterval);
            this.autoSyncInterval = null;
        }

        // 1. Interval
        if (this.settings.enableAutoSyncInInterval && this.settings.autoSyncIntervalSec > 0) {
            this.autoSyncInterval = window.setInterval(() => {
                this.triggerAutoSync();
            }, this.settings.autoSyncIntervalSec * 1000);
            this.registerInterval(this.autoSyncInterval);
        }
    }

    private async triggerAutoSync() {
        if (!this.isReady) return;
        if (this.ribbonIconEl) {
            // Auto-sync does a full Sync (Pull -> Push)
            await this.performSyncOperation(this.ribbonIconEl, () => this.syncManager.sync(true));
        } else {
            await this.syncManager.sync(true);
        }
    }

    private registerTriggers() {
        // 2. Save Trigger (Ctrl+S)
        this.registerDomEvent(document, "keydown", (evt: KeyboardEvent) => {
            if (!this.settings.enableOnSaveTrigger) return;
            if ((evt.ctrlKey || evt.metaKey) && evt.key === "s") {
                this.triggerAutoSync();
            }
        });

        // 3. Modify trigger with debounce
        let modifyTimeout: number | null = null;
        this.registerEvent(
            this.app.vault.on("modify", (file) => {
                if (!this.settings.enableOnModifyTrigger || !this.isReady) return;
                if (!(file instanceof TFile)) return;
                if (this.syncManager.shouldIgnore(file.path)) return;

                if (modifyTimeout) window.clearTimeout(modifyTimeout);
                modifyTimeout = window.setTimeout(() => {
                    this.triggerAutoSync();
                }, this.settings.onModifyDelaySec * 1000);
            }),
        );

        // 4. Layout Change trigger
        this.registerEvent(
            this.app.workspace.on("layout-change", () => {
                if (this.settings.enableOnLayoutChangeTrigger) {
                    this.triggerAutoSync();
                }
            }),
        );
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

        // Load credentials from Secure Storage
        const credentials = await this.secureStorage.loadCredentials();
        if (credentials) {
            this.adapter.setCredentials(credentials.clientId || "", credentials.clientSecret || "");
            this.adapter.setTokens(
                credentials.accessToken || null,
                credentials.refreshToken || null,
            );
        }

        // MIGRATION: Check if legacy credentials exist in data.json and move them
        const data = (await this.loadData()) as any;
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
            await this.saveData(this.settings);
            console.log("VaultSync: Migration complete.");
        }
    }

    async saveSettings() {
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
    }

    async performSyncOperation(iconEl: HTMLElement, operation: () => Promise<void>) {
        if (iconEl.classList.contains("vault-sync-spinning")) return; // Prevent concurrent clicks

        // Change to sync icon (circle arrow) and animate
        setIcon(iconEl, "sync");
        iconEl.addClass("vault-sync-spinning");

        try {
            await operation();
        } finally {
            iconEl.removeClass("vault-sync-spinning");
            // Revert to cloud icon
            setIcon(iconEl, "upload-cloud");
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
        containerEl.empty();
        containerEl.createEl("h2", { text: t("settingsTitle") });

        // 1. Authentication
        containerEl.createEl("h3", { text: t("authSection") });

        new Setting(containerEl)
            .setName(t("authStatus"))
            .setDesc(this.plugin.adapter.getAuthStatus())
            .addButton((button) =>
                button.setButtonText(t("checkStatus")).onClick(() => {
                    this.display();
                }),
            );

        new Setting(containerEl)
            .setName(t("clientId"))
            .setDesc(t("clientIdDesc"))
            .addText((text) =>
                text.setValue(this.plugin.adapter.clientId).onChange(async (value) => {
                    // Update adapter temporarily so config is live
                    this.plugin.adapter.updateConfig(
                        value,
                        this.plugin.adapter.clientSecret,
                        this.app.vault.getName(),
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
            .setName(t("clientSecret"))
            .setDesc(t("clientSecretDesc"))
            .addText((text) =>
                text.setValue(this.plugin.adapter.clientSecret).onChange(async (value) => {
                    // Update adapter temporarily
                    this.plugin.adapter.updateConfig(
                        this.plugin.adapter.clientId,
                        value,
                        this.app.vault.getName(),
                        this.plugin.settings.cloudRootFolder,
                    );
                    // Persist securely
                    await this.plugin.saveCredentials(
                        this.plugin.adapter.clientId,
                        value,
                        this.plugin.adapter.getTokens().accessToken,
                        this.plugin.adapter.getTokens().refreshToken,
                    );
                }),
            );

        new Setting(containerEl)
            .setName(t("login"))
            .setDesc(t("loginDesc"))
            .addButton((button) =>
                button.setButtonText(t("authorize")).onClick(async () => {
                    await this.plugin.adapter.login();
                    const tokens = this.plugin.adapter.getTokens();
                    await this.plugin.saveCredentials(
                        this.plugin.adapter.clientId,
                        this.plugin.adapter.clientSecret,
                        tokens.accessToken,
                        tokens.refreshToken,
                    );
                    new Notice(t("authSuccess"));
                    this.display();
                }),
            );

        // 2. Sync Triggers
        containerEl.createEl("h3", { text: t("triggerSection") });

        new Setting(containerEl)
            .setName(t("startupSync"))
            .setDesc(t("startupSyncDesc"))
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.enableStartupSync).onChange(async (value) => {
                    this.plugin.settings.enableStartupSync = value;
                    await this.plugin.saveSettings();
                    this.display();
                }),
            );

        if (this.plugin.settings.enableStartupSync) {
            new Setting(containerEl)
                .setName(t("startupDelay"))
                .setDesc(t("startupDelayDesc"))
                .addText((text) =>
                    text
                        .setValue(String(this.plugin.settings.startupDelaySec))
                        .onChange(async (value) => {
                            this.plugin.settings.startupDelaySec = this.validateNumber(
                                value,
                                0,
                                600,
                                10,
                            );
                            await this.plugin.saveSettings();
                        }),
                );
        }

        new Setting(containerEl)
            .setName(t("autoSyncInterval"))
            .setDesc(t("autoSyncIntervalDesc"))
            .addText((text) =>
                text
                    .setValue(String(this.plugin.settings.autoSyncIntervalSec))
                    .onChange(async (value) => {
                        const validated = this.validateNumber(value, 0, 86400, 1800);
                        this.plugin.settings.autoSyncIntervalSec = validated;
                        this.plugin.settings.enableAutoSyncInInterval = validated > 0;
                        await this.plugin.saveSettings();
                        this.plugin.setupAutoSyncInterval();
                    }),
            );

        new Setting(containerEl)
            .setName(t("triggerSave"))
            .setDesc(t("triggerSaveDesc"))
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.enableOnSaveTrigger)
                    .onChange(async (value) => {
                        this.plugin.settings.enableOnSaveTrigger = value;
                        await this.plugin.saveSettings();
                    }),
            );

        new Setting(containerEl)
            .setName(t("triggerModify"))
            .setDesc(t("triggerModifyDesc"))
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.enableOnModifyTrigger)
                    .onChange(async (value) => {
                        this.plugin.settings.enableOnModifyTrigger = value;
                        await this.plugin.saveSettings();
                        this.display();
                    }),
            );

        if (this.plugin.settings.enableOnModifyTrigger) {
            new Setting(containerEl)
                .setName(t("modifyDelay"))
                .setDesc(t("modifyDelayDesc"))
                .addText((text) =>
                    text
                        .setValue(String(this.plugin.settings.onModifyDelaySec))
                        .onChange(async (value) => {
                            this.plugin.settings.onModifyDelaySec = this.validateNumber(
                                value,
                                1,
                                60,
                                5,
                            );
                            await this.plugin.saveSettings();
                        }),
                );
        }

        new Setting(containerEl)
            .setName(t("triggerLayout"))
            .setDesc(t("triggerLayoutDesc"))
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.enableOnLayoutChangeTrigger)
                    .onChange(async (value) => {
                        this.plugin.settings.enableOnLayoutChangeTrigger = value;
                        await this.plugin.saveSettings();
                    }),
            );

        // 3. Performance
        containerEl.createEl("h3", { text: t("perfSection") });

        new Setting(containerEl)
            .setName(t("concurrency"))
            .setDesc(t("concurrencyDesc"))
            .addText((text) =>
                text.setValue(String(this.plugin.settings.concurrency)).onChange(async (value) => {
                    this.plugin.settings.concurrency = this.validateNumber(value, 1, 10, 5);
                    await this.plugin.saveSettings();
                }),
            );

        // 4. Advanced
        containerEl.createEl("h3", { text: t("advancedSection") });

        new Setting(containerEl)
            .setName(t("detailedNotifications"))
            .setDesc(t("detailedNotificationsDesc"))
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.showDetailedNotifications)
                    .onChange(async (value) => {
                        this.plugin.settings.showDetailedNotifications = value;
                        await this.plugin.saveSettings();
                    }),
            );

        new Setting(containerEl)
            .setName(t("enableLogging"))
            .setDesc(t("enableLoggingDesc"))
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.enableLogging).onChange(async (value) => {
                    this.plugin.settings.enableLogging = value;
                    await this.plugin.saveSettings();
                }),
            );

        new Setting(containerEl)
            .setName(t("cloudRootFolder"))
            .setDesc(t("cloudRootFolderDesc"))
            .addText((text) =>
                text
                    .setPlaceholder("ObsidianVaultSync")
                    .setValue(this.plugin.settings.cloudRootFolder)
                    .onChange(async (value) => {
                        // Validation: empty or invalid -> default
                        const sanitized = value.trim();
                        if (
                            !sanitized ||
                            sanitized.startsWith("/") ||
                            sanitized.includes("\\") ||
                            sanitized.length > 255 ||
                            /[<>:"|?*]/.test(sanitized)
                        ) {
                            this.plugin.settings.cloudRootFolder = "ObsidianVaultSync";
                        } else {
                            this.plugin.settings.cloudRootFolder = sanitized;
                        }
                        this.plugin.adapter.updateConfig(
                            this.plugin.adapter.clientId,
                            this.plugin.adapter.clientSecret,
                            this.app.vault.getName(),
                            this.plugin.settings.cloudRootFolder,
                        );
                    }),
            );

        // 5. Exclusion Patterns
        containerEl.createEl("h3", { text: t("exclusionSection") });

        new Setting(containerEl)
            .setName(t("exclusionPatterns"))
            .setDesc(t("exclusionPatternsDesc"))
            .addTextArea((textarea) =>
                textarea
                    .setPlaceholder("*.tmp\ntemp/**\n.git/**")
                    .setValue(this.plugin.settings.exclusionPatterns)
                    .onChange(async (value) => {
                        this.plugin.settings.exclusionPatterns = value;
                        await this.plugin.saveSettings();
                    }),
            );
    }

    private validateNumber(value: string, min: number, max: number, defaultValue: number): number {
        const num = Number(value);
        if (isNaN(num)) return defaultValue;
        return Math.min(Math.max(num, min), max);
    }
}
