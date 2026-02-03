import {
    App,
    Notice,
    Plugin,
    PluginSettingTab,
    Setting,
    TFile,
    setIcon,
    requestUrl,
    Platform,
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
        manualAuthSection: "Manual Authentication (Mobile)",
        manualAuthDesc:
            "If automatic redirect fails (localhost error), copy the browser URL and paste it below:",
        manualAuthPlaceholder: "Enter the resulting URL or code",
        manualAuthVerify: "Verify and Login",
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
        fetchingRemoteList: "Fetching remote file list...",
        reconcilingChanges: "Analyzing changes (MD5)...",
        scanningLocalFiles: "Scanning local files...",
        syncInProgress: "Sync in progress...",
        syncing: "Syncing...",
        authFailed: "Auth failed",
        pushCompleted: "✅ Push completed.",
        pullCompleted: "✅ Pull completed.",
        nothingToPush: "✅ Cloud is already up to date.",
        nothingToPull: "✅ Local vault is already up to date.",
        vaultUpToDate: "✅ Vault is up to date (Index verified).",
        changesToPush: "changes to push...",
        changesToPull: "changes detected. Syncing...",
        folderCreated: "📁 Created folder",
        filePushed: "📤 Pushed",
        filePulled: "📥 Pulled",
        fileTrashed: "🗑️ Trashed",
        fileRemoved: "🗑️ Removed",
        scanningOrphans: "🔍 Scanning for orphan files...",
        errRemoteEmpty: "⚠️ Remote file list empty. Orphan cleanup skipped.",
        errOrphanAborted: "⚠️ Orphan cleanup aborted: too many files affected.",
        orphanMoved: "🧹 Orphan moved",
        orphansMore: "and more orphans moved.",
        orphansDone: "orphan files moved to",
        syncTooltip: "Sync with Cloud",
        syncCommand: "Sync with Cloud",
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
        manualAuthSection: "手動認証 (モバイル用)",
        manualAuthDesc:
            "自動リダイレクトに失敗する場合（localhostエラー）、ブラウザのURLをコピーして以下に貼り付けてください：",
        manualAuthPlaceholder: "リダイレクト先のURLまたはコードを入力",
        manualAuthVerify: "検証してログイン",
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
        fetchingRemoteList: "リモートからファイル一覧を取得中...",
        reconcilingChanges: "変更内容を分析中 (MD5照合)...",
        scanningLocalFiles: "ローカルファイルを走査中...",
        syncInProgress: "現在同期中です...",
        syncing: "同期中...",
        authFailed: "認証に失敗しました",
        pushCompleted: "✅ アップロード完了",
        pullCompleted: "✅ ダウンロード完了",
        nothingToPush: "✅ クラウドは最新の状態です",
        nothingToPull: "✅ ローカルは最新の状態です",
        vaultUpToDate: "✅ Vaultは最新です (インデックス照合済み)",
        changesToPush: "件の変更をアップロード中...",
        changesToPull: "件の変更を検出しました。同期中...",
        folderCreated: "📁 フォルダを作成しました",
        filePushed: "📤 アップロード完了",
        filePulled: "📥 ダウンロード完了",
        fileTrashed: "🗑️ 削除しました（リモート）",
        fileRemoved: "🗑️ 削除しました（ローカル）",
        scanningOrphans: "🔍 未管理ファイルの走査中...",
        errRemoteEmpty: "⚠️ リモート一覧が空のため、クリーンアップを中止しました",
        errOrphanAborted: "⚠️ 安全のためクリーンアップを中止しました（対象ファイルが多すぎます）",
        orphanMoved: "🧹 未管理ファイルを移動しました",
        orphansMore: "件の未管理ファイルを移動しました",
        orphansDone: "件のファイルを移動しました：",
        syncTooltip: "クラウドと同期",
        syncCommand: "クラウドと同期",
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

    // Security
    encryptionSecret: string;
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
    exclusionPatterns: ".obsidian/plugins/obsidian-vault-sync/logs\n.git",
    encryptionSecret: "",
};

export default class VaultSync extends Plugin {
    settings!: VaultSyncSettings;
    adapter!: GoogleDriveAdapter;
    syncManager!: SyncManager;
    secureStorage!: SecureStorage;
    private isReady = false;
    private syncRibbonIconEl: HTMLElement | null = null;
    private manualSyncInProgress = false;

    async onload() {
        // Initialize adapter first with defaults
        this.adapter = new GoogleDriveAdapter(
            "",
            "",
            this.app.vault.getName(),
            DEFAULT_SETTINGS.cloudRootFolder, // temp default
        );

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
            t,
        );

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
                    // Use Smart Sync for faster startup (O(1) check)
                    await this.syncManager.requestSmartSync(true);
                    // Schedule background full scan after startup sync
                    this.scheduleBackgroundScan();
                }, this.settings.startupDelaySec * 1000);
            } else {
                this.isReady = true;
                this.syncManager.log("Startup sync disabled. Auto-sync hooks enabled.");
            }
        });

        // Ribbon button uses Smart Sync for O(1) performance when no changes
        this.syncRibbonIconEl = this.addRibbonIcon("sync", t("syncTooltip"), async () => {
            if (this.syncRibbonIconEl) {
                await this.performSyncOperation(
                    [{ element: this.syncRibbonIconEl, originalIcon: "sync" }],
                    () => this.syncManager.requestSmartSync(false),
                );
            }
        });

        this.addCommand({
            id: "sync-vault",
            name: t("syncCommand"),
            callback: () => {
                if (this.syncRibbonIconEl) {
                    this.performSyncOperation(
                        [{ element: this.syncRibbonIconEl, originalIcon: "sync" }],
                        () => this.syncManager.requestSmartSync(false),
                    );
                } else {
                    this.syncManager.requestSmartSync(false);
                }
            },
        });

        this.addSettingTab(new VaultSyncSettingTab(this.app, this));

        this.setupAutoSyncInterval();
        this.registerTriggers();
    }

    private autoSyncInterval: number | null = null;
    private backgroundScanTimeout: number | null = null;

    setupAutoSyncInterval() {
        // Clear existing
        if (this.autoSyncInterval) {
            window.clearInterval(this.autoSyncInterval);
            this.autoSyncInterval = null;
        }

        // 1. Interval - use Smart Sync for regular intervals
        if (this.settings.enableAutoSyncInInterval && this.settings.autoSyncIntervalSec > 0) {
            this.autoSyncInterval = window.setInterval(() => {
                this.triggerSmartSync();
            }, this.settings.autoSyncIntervalSec * 1000);
            this.registerInterval(this.autoSyncInterval);
        }
    }

    /**
     * Schedule a background full scan after a delay
     * This runs at low priority and can be interrupted by Smart Sync
     */
    private scheduleBackgroundScan(delayMs: number = 60000) {
        if (this.backgroundScanTimeout) {
            window.clearTimeout(this.backgroundScanTimeout);
        }

        this.backgroundScanTimeout = window.setTimeout(async () => {
            if (!this.isReady) return;
            this.syncManager.log("Starting scheduled background full scan...");
            await this.syncManager.requestBackgroundScan(true); // Resume if possible
        }, delayMs);
    }

    private async triggerAutoSync() {
        if (!this.isReady) return;
        // Auto-sync does a full Sync (Pull -> Push) without UI locking
        // Animation is handled via Activity Callbacks
        await this.syncManager.sync(true);
    }

    /**
     * Trigger Smart Sync - high priority, O(1) check via sync-index.json
     * Used for user-initiated actions (save, modify, layout change)
     */
    private async triggerSmartSync() {
        if (!this.isReady) return;
        // Helper for user-initiated actions that shouldn't lock UI immediately (like save/modify)
        // Animation is handled via Activity Callbacks if changes are found
        await this.syncManager.requestSmartSync(true);
    }

    private registerTriggers() {
        // 2. Save Trigger (Ctrl+S)
        this.registerDomEvent(document, "keydown", (evt: KeyboardEvent) => {
            if (!this.settings.enableOnSaveTrigger) return;
            if ((evt.ctrlKey || evt.metaKey) && evt.key === "s") {
                this.triggerSmartSync();
            }
        });

        // 3. Modify trigger with debounce - marks dirty and triggers Smart Sync
        let modifyTimeout: number | null = null;
        this.registerEvent(
            this.app.vault.on("modify", (file) => {
                if (!this.isReady) return;
                if (!(file instanceof TFile)) return;
                if (this.syncManager.shouldIgnore(file.path)) return;

                // Mark file as dirty immediately
                this.syncManager.markDirty(file.path);

                // Debounce the actual sync
                if (!this.settings.enableOnModifyTrigger) return;
                if (modifyTimeout) window.clearTimeout(modifyTimeout);
                modifyTimeout = window.setTimeout(() => {
                    this.triggerSmartSync();
                }, this.settings.onModifyDelaySec * 1000);
            }),
        );

        // 3b. Create trigger - mark new files as dirty
        this.registerEvent(
            this.app.vault.on("create", (file) => {
                if (!this.isReady) return;
                if (!(file instanceof TFile)) return;
                if (this.syncManager.shouldIgnore(file.path)) return;

                this.syncManager.markDirty(file.path);
            }),
        );

        // 3c. Delete trigger - mark deleted files (both files and folders)
        this.registerEvent(
            this.app.vault.on("delete", (file) => {
                if (!this.isReady) return;

                // Handle both files and folders
                if (file instanceof TFile) {
                    this.syncManager.markDeleted(file.path);
                } else {
                    // Folder deleted - mark all indexed files in this folder for deletion
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

        // 4. Layout Change trigger
        this.registerEvent(
            this.app.workspace.on("layout-change", () => {
                if (this.settings.enableOnLayoutChangeTrigger) {
                    this.triggerSmartSync();
                }
            }),
        );
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

        // SEC-001: Ensure encryption secret exists
        if (!this.settings.encryptionSecret) {
            const array = new Uint8Array(32);
            window.crypto.getRandomValues(array);
            this.settings.encryptionSecret = Array.from(array, (b) =>
                b.toString(16).padStart(2, "0"),
            ).join("");
            await this.saveData(this.settings);
        }

        // Initialize SecureStorage with the secret
        this.secureStorage = new SecureStorage(
            this.app,
            this.manifest.dir || "",
            this.settings.encryptionSecret,
        );

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
                    if (!Platform.isMobile) {
                        const tokens = this.plugin.adapter.getTokens();
                        await this.plugin.saveCredentials(
                            this.plugin.adapter.clientId,
                            this.plugin.adapter.clientSecret,
                            tokens.accessToken,
                            tokens.refreshToken,
                        );
                        new Notice(t("authSuccess"));
                        this.display();
                    }
                }),
            );

        // Manual Auth (Mobile Fallback)
        containerEl.createEl("h4", { text: t("manualAuthSection") });
        containerEl.createEl("p", {
            text: t("manualAuthDesc"),
            cls: "setting-item-description",
        });
        let textComponent: any;
        new Setting(containerEl)
            .addText((text) => {
                textComponent = text;
                text.setPlaceholder(t("manualAuthPlaceholder")).inputEl.style.width = "100%";
            })
            .addButton((btn) => {
                btn.setButtonText(t("manualAuthVerify")).onClick(async () => {
                    const val = textComponent.getValue().trim();
                    if (!val) return;

                    let code = val;
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
                        new Notice(t("authSuccess"));
                        this.display();
                    } catch (e) {
                        new Notice(
                            `${t("authFailed")}: ${e instanceof Error ? e.message : String(e)}`,
                        );
                    }
                });
            })
            .setClass("auth-manual-input");

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
