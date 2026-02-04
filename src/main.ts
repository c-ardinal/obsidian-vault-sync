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
import { HistoryModal } from "./ui/history-modal";

// i18n Localization
const i18n: Record<string, Record<string, string>> = {
    en: {
        // Settings UI
        settingSettingsTitle: "VaultSync Settings",
        settingAuthSection: "Authentication",
        settingAuthStatus: "Authentication Status",
        settingCheckStatus: "Check Status",
        settingClientId: "Google Client ID",
        settingClientIdDesc: "Enter your Google Cloud Project Client ID",
        settingClientSecret: "Google Client Secret",
        settingClientSecretDesc: "Enter your Google Cloud Project Client Secret",
        settingLogin: "Login",
        settingLoginDesc: "Authorize with Google Drive",
        settingManualAuthSection: "Manual Authentication (Mobile)",
        settingManualAuthDesc:
            "If automatic redirect fails (localhost error), copy the browser URL and paste it below:",
        settingManualAuthPlaceholder: "Enter the resulting URL or code",
        settingManualAuthVerify: "Verify and Login",
        settingAuthorize: "Authorize",
        settingTriggerSection: "Sync Triggers",
        settingStartupSync: "Enable Startup Sync",
        settingStartupSyncDesc: "Sync with cloud automatically upon starting Obsidian",
        settingStartupDelay: "Startup Delay (seconds)",
        settingStartupDelayDesc: "Wait for Obsidian to index files before syncing (0-600s)",
        settingAutoSyncInterval: "Auto-sync Interval (seconds)",
        settingAutoSyncIntervalDesc:
            "Sync periodically in the background (30-86400s). Set to 0 to disable.",
        settingTriggerSave: "Trigger: Save (Ctrl+S)",
        settingTriggerSaveDesc: "Sync when you explicitly save a file",
        settingTriggerModify: "Trigger: On Modify (Mobile/Debounce)",
        settingTriggerModifyDesc: "Sync after a period of inactivity while editing",
        settingModifyDelay: "Modify Delay (seconds)",
        settingModifyDelayDesc: "Seconds of inactivity before syncing (1-60s)",
        settingTriggerLayout: "Trigger: Layout Change",
        settingTriggerLayoutDesc: "Sync when switching between files or closing tabs",
        settingPerfSection: "Performance",
        settingConcurrency: "Concurrency",
        settingConcurrencyDesc: "Number of parallel file Push/Pull during sync (1-10)",
        settingAdvancedSection: "Advanced",
        settingDetailedNotifications: "Show Detailed Notifications",
        settingDetailedNotificationsDesc: "Show progress notifications for each file pushed/pulled",
        settingEnableLogging: "Enable Logging",
        settingEnableLoggingDesc: "Developer: Write daily logs to obsidian-vault-sync/logs folder",
        settingCloudRootFolder: "Cloud Root Folder",
        settingCloudRootFolderDesc: "Root folder name on Google Drive (default: ObsidianVaultSync)",
        settingExclusionSection: "Exclusion Patterns",
        settingExclusionPatterns: "Exclude Files/Folders",
        settingExclusionPatternsDesc:
            "Glob patterns (one per line). Use * for any chars, ** for recursive dirs. Example: *.tmp, temp/**",

        // Sync Status (Log/UI)
        statusFetchingRemoteList: "Fetching remote file list...",
        statusReconcilingChanges: "Analyzing changes (MD5)...",
        statusScanningLocalFiles: "Scanning local files...",
        statusSyncInProgress: "Sync in progress...",
        statusSyncing: "Syncing...",
        statusChangesToPush: "changes to push...",
        statusChangesToPull: "changes detected. Syncing...",
        statusScanningOrphans: "🔍 Scanning for orphan files...",

        // Notifications (Notice)
        noticeAuthSuccess: "Successfully authenticated!",
        noticeAuthFailed: "Auth failed",
        noticePushCompleted: "✅ Push completed.",
        noticePullCompleted: "✅ Pull completed.",
        noticeNothingToPush: "✅ Cloud is already up to date.",
        noticeNothingToPull: "✅ Local vault is already up to date.",
        noticeVaultUpToDate: "✅ Vault is up to date (Index verified).",
        noticeFolderCreated: "📁 Created folder",
        noticeFilePushed: "📤 Pushed",
        noticeFilePulled: "📥 Pulled",
        noticeFileTrashed: "🗑️ Trashed",
        noticeFileRemoved: "🗑️ Removed",
        noticeErrRemoteEmpty: "⚠️ Remote file list empty. Orphan cleanup skipped.",
        noticeErrOrphanAborted: "⚠️ Orphan cleanup aborted: too many files affected.",
        noticeOrphanMoved: "🧹 Orphan moved",
        noticeOrphansMore: "and more orphans moved.",
        noticeOrphansDone: "orphan files moved to",
        noticeFileMerged: "✅ Auto-merged",
        noticeConflictSaved: "⚠️ Conflict: Remote saved",
        noticeSavedKeepForever: "📌 Saved: Keep Forever",
        noticeFailedToSave: "❌ Failed to save",
        noticeFileRestored: "✅ File restored. Syncing changes...",

        // History Modal & Browser UI
        historyTitle: "History",
        historyActions: "Actions",
        historyKeepForever: "Keep Forever (Protect)",
        historyRevisions: "Revisions",
        historyNoHistoryFound: "No history found.",
        historyProtectedFromDeletion: "Protected from auto-deletion",
        historyByAuthor: "by",
        historySelectRevision: "Select a revision to view details.",
        historyRevisionLabel: "Revision",
        historyRestoreVersion: "Restore this version",
        historyRestoreConfirm:
            "Are you sure you want to restore this version ({0})?\n\nCurrent local changes will be replaced.",
        historyCompareWith: "Compare with: ",
        historyCurrentLocalFile: "Current Local File",
        historyPreviousVersion: "Previous",
        historyInitialEmptyVersion: "Initial / Empty",
        historyAuthorUnknown: "Unknown",
        historyError: "Error",
        historyFailedToLoadHistory: "Failed to load history",

        // Global Command/Tooltips
        labelSyncTooltip: "Sync with Cloud",
        labelSyncCommand: "Sync with Cloud",
        labelFullAudit: "Audit & Fix Consistency (Full Scan)",
        labelViewHistory: "View History in Cloud (VaultSync)",
    },
    ja: {
        // Settings UI
        settingSettingsTitle: "VaultSync 設定",
        settingAuthSection: "認証",
        settingAuthStatus: "認証ステータス",
        settingCheckStatus: "確認",
        settingClientId: "Google Client ID",
        settingClientIdDesc: "Google Cloud Project の Client ID を入力してください",
        settingClientSecret: "Google Client Secret",
        settingClientSecretDesc: "Google Cloud Project の Client Secret を入力してください",
        settingLogin: "ログイン",
        settingLoginDesc: "Google Drive と連携します",
        settingManualAuthSection: "手動認証 (モバイル用)",
        settingManualAuthDesc:
            "自動リダイレクトに失敗する場合（localhostエラー）、ブラウザのURLをコピーして以下に貼り付けてください：",
        settingManualAuthPlaceholder: "リダイレクト先のURLまたはコードを入力",
        settingManualAuthVerify: "検証してログイン",
        settingAuthorize: "認証",
        settingTriggerSection: "同期トリガー",
        settingStartupSync: "起動時に同期",
        settingStartupSyncDesc: "Obsidian 起動時に自動でクラウドと同期します",
        settingStartupDelay: "起動時の遅延 (秒)",
        settingStartupDelayDesc: "同期開始前に待機する時間 (0-600秒)",
        settingAutoSyncInterval: "自動同期の間隔 (秒)",
        settingAutoSyncIntervalDesc: "バックグラウンドで定期的に同期 (30-86400秒, 0で無効)",
        settingTriggerSave: "トリガー: 保存時 (Ctrl+S)",
        settingTriggerSaveDesc: "明示的にファイルを保存した際に同期を実行",
        settingTriggerModify: "トリガー: 編集時 (モバイル/デバウンス)",
        settingTriggerModifyDesc: "編集後、一定時間操作がなければ同期を実行",
        settingModifyDelay: "編集後の遅延 (秒)",
        settingModifyDelayDesc: "同期を実行するまでの待機時間 (1-60秒)",
        settingTriggerLayout: "トリガー: レイアウト変更時",
        settingTriggerLayoutDesc: "ファイルを切り替えたり、タブを閉じたときに同期",
        settingPerfSection: "パフォーマンス",
        settingConcurrency: "並列実行数",
        settingConcurrencyDesc: "同期時に並列で実行するファイルのプッシュ/プル数 (1-10)",
        settingAdvancedSection: "高度な設定",
        settingDetailedNotifications: "詳細な通知を表示",
        settingDetailedNotificationsDesc: "プッシュ/プルごとに進捗通知を表示します",
        settingEnableLogging: "ログ出力を有効化",
        settingEnableLoggingDesc:
            "開発者向け: obsidian-vault-sync/logs フォルダに日別ログを出力します",
        settingCloudRootFolder: "クラウドルートフォルダ",
        settingCloudRootFolderDesc:
            "Google Drive 上の同期先ルートフォルダ名 (デフォルト: ObsidianVaultSync)",
        settingExclusionSection: "除外パターン",
        settingExclusionPatterns: "除外ファイル/フォルダ",
        settingExclusionPatternsDesc:
            "globパターン (1行1パターン)。* は任意の文字、** は再帰ディレクトリ。例: *.tmp, temp/**",

        // Sync Status (Log/UI)
        statusFetchingRemoteList: "リモートからファイル一覧を取得中...",
        statusReconcilingChanges: "変更内容を分析中 (MD5照合)...",
        statusScanningLocalFiles: "ローカルファイルを走査中...",
        statusSyncInProgress: "現在同期中です...",
        statusSyncing: "同期中...",
        statusChangesToPush: "件の変更をアップロード中...",
        statusChangesToPull: "件の変更を検出しました。同期中...",
        statusScanningOrphans: "🔍 未管理ファイルの走査中...",

        // Notifications (Notice)
        noticeAuthSuccess: "認証に成功しました！",
        noticeAuthFailed: "認証に失敗しました",
        noticePushCompleted: "✅ アップロード完了",
        noticePullCompleted: "✅ ダウンロード完了",
        noticeNothingToPush: "✅ クラウドは最新の状態です",
        noticeNothingToPull: "✅ ローカルは最新の状態です",
        noticeVaultUpToDate: "✅ すべて最新の状態です",
        noticeFolderCreated: "📁 フォルダを作成しました",
        noticeFilePushed: "📤 アップロード",
        noticeFilePulled: "📥 ダウンロード",
        noticeFileTrashed: "🗑️ 削除 (リモート)",
        noticeFileRemoved: "🗑️ 削除 (ローカル)",
        noticeErrRemoteEmpty: "⚠️ リモート一覧が空のため、クリーンアップを中止しました",
        noticeErrOrphanAborted:
            "⚠️ 安全のためクリーンアップを中止しました（対象ファイルが多すぎます）",
        noticeOrphanMoved: "🧹 未管理ファイルを移動しました",
        noticeOrphansMore: "件の未管理ファイルを移動しました",
        noticeOrphansDone: "件のファイルを移動しました：",
        noticeFileMerged: "✅ 自動マージ",
        noticeConflictSaved: "⚠️ 競合保存: リモート版を保存",
        noticeSavedKeepForever: "📌 保存完了: 無期限",
        noticeFailedToSave: "❌ 保存に失敗しました",
        noticeFileRestored: "✅ ファイルを復元しました。同期を開始します...",

        // History Modal & Browser UI
        historyTitle: "履歴",
        historyActions: "操作",
        historyKeepForever: "無期限保存 (保護)",
        historyRevisions: "リビジョン一覧",
        historyNoHistoryFound: "履歴が見つかりません",
        historyProtectedFromDeletion: "自動削除から保護されています",
        historyByAuthor: "更新者:",
        historySelectRevision: "リビジョンを選択すると詳細が表示されます",
        historyRevisionLabel: "リビジョン",
        historyRestoreVersion: "このバージョンを復元",
        historyRestoreConfirm:
            "このバージョン ({0}) を復元してもよろしいですか？\n\n現在のローカルファイルの内容は上書きされます。",
        historyCompareWith: "比較対象: ",
        historyCurrentLocalFile: "現在のローカルファイル",
        historyPreviousVersion: "前のバージョン",
        historyInitialEmptyVersion: "最初（空）の状態",
        historyAuthorUnknown: "不明",
        historyError: "エラー",
        historyFailedToLoadHistory: "履歴の読み込みに失敗しました",

        // Global Command/Tooltips
        labelSyncTooltip: "クラウドと同期",
        labelSyncCommand: "クラウドと同期",
        labelFullAudit: "完全スキャンと整合性チェック (Full Audit)",
        labelViewHistory: "クラウドの変更履歴を表示 (VaultSync)",
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
    exclusionPatterns:
        ".obsidian/plugins/obsidian-vault-sync/logs\n.obsidian/plugins/obsidian-vault-sync/cache\n.git",
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
    private lastSaveRequestTime = 0;
    private lastModifyTime = 0;

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
                    // Use Smart Sync for faster startup (O(1) check), but enable vault scan (O(N)) for startup
                    await this.syncManager.requestSmartSync(true, true);
                }, this.settings.startupDelaySec * 1000);
            } else {
                this.isReady = true;
                this.syncManager.log("Startup sync disabled. Auto-sync hooks enabled.");
            }
        });

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

        this.addCommand({
            id: "force-full-scan",
            name: t("labelFullAudit"),
            callback: async () => {
                new Notice(t("statusScanningLocalFiles")); // Reuse existing message or add new one
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

    private autoSyncInterval: number | null = null;

    setupAutoSyncInterval() {
        // Clear existing
        if (this.autoSyncInterval) {
            window.clearInterval(this.autoSyncInterval);
            this.autoSyncInterval = null;
        }

        // 1. Interval - use Smart Sync for regular intervals
        if (this.settings.enableAutoSyncInInterval && this.settings.autoSyncIntervalSec > 0) {
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
        if (source === "layout" || source === "interval") {
            const timeSinceModify = Date.now() - this.lastModifyTime;
            if (timeSinceModify < this.settings.onModifyDelaySec * 1000) {
                await this.syncManager.log(
                    `[Trigger] Skipped ${source} trigger (active editing detected: ${timeSinceModify}ms ago)`,
                );
                return;
            }
        }

        await this.syncManager.log(`[Trigger] Activated via ${source}`);

        // Helper for user-initiated actions that shouldn't lock UI immediately (like save/modify)
        // Animation is handled via Activity Callbacks if changes are found
        await this.syncManager.requestSmartSync(true);
    }

    private registerTriggers() {
        // 2. Save Trigger (Ctrl+S)
        this.registerDomEvent(document, "keydown", (evt: KeyboardEvent) => {
            if (!this.settings.enableOnSaveTrigger) return;
            if ((evt.ctrlKey || evt.metaKey) && evt.key === "s") {
                this.lastSaveRequestTime = Date.now();
                this.triggerSmartSync("save");
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
                if (!this.settings.enableOnModifyTrigger) return;
                if (modifyTimeout) window.clearTimeout(modifyTimeout);
                modifyTimeout = window.setTimeout(() => {
                    this.triggerSmartSync("modify");
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
                    this.triggerSmartSync("layout");
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
        containerEl.createEl("h2", { text: t("settingSettingsTitle") });

        // 1. Authentication
        containerEl.createEl("h3", { text: t("settingAuthSection") });

        new Setting(containerEl)
            .setName(t("settingAuthStatus"))
            .setDesc(this.plugin.adapter.getAuthStatus())
            .addButton((button) =>
                button.setButtonText(t("settingCheckStatus")).onClick(() => {
                    this.display();
                }),
            );

        new Setting(containerEl)
            .setName(t("settingClientId"))
            .setDesc(t("settingClientIdDesc"))
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
            .setName(t("settingClientSecret"))
            .setDesc(t("settingClientSecretDesc"))
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
            .setName(t("settingLogin"))
            .setDesc(t("settingLoginDesc"))
            .addButton((button) =>
                button.setButtonText(t("settingAuthorize")).onClick(async () => {
                    await this.plugin.adapter.login();
                    if (!Platform.isMobile) {
                        const tokens = this.plugin.adapter.getTokens();
                        await this.plugin.saveCredentials(
                            this.plugin.adapter.clientId,
                            this.plugin.adapter.clientSecret,
                            tokens.accessToken,
                            tokens.refreshToken,
                        );
                        new Notice(t("noticeAuthSuccess"));
                        this.display();
                    }
                }),
            );

        // Manual Auth (Mobile Fallback)
        containerEl.createEl("h4", { text: t("settingManualAuthSection") });
        containerEl.createEl("p", {
            text: t("settingManualAuthDesc"),
            cls: "setting-item-description",
        });
        let textComponent: any;
        new Setting(containerEl)
            .addText((text) => {
                textComponent = text;
                text.setPlaceholder(t("settingManualAuthPlaceholder")).inputEl.style.width = "100%";
            })
            .addButton((btn) => {
                btn.setButtonText(t("settingManualAuthVerify")).onClick(async () => {
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
                        new Notice(t("noticeAuthSuccess"));
                        this.display();
                    } catch (e) {
                        new Notice(
                            `${t("noticeAuthFailed")}: ${e instanceof Error ? e.message : String(e)}`,
                        );
                    }
                });
            })
            .setClass("auth-manual-input");

        // 2. Sync Triggers
        containerEl.createEl("h3", { text: t("settingTriggerSection") });

        new Setting(containerEl)
            .setName(t("settingStartupSync"))
            .setDesc(t("settingStartupSyncDesc"))
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.enableStartupSync).onChange(async (value) => {
                    this.plugin.settings.enableStartupSync = value;
                    await this.plugin.saveSettings();
                    this.display();
                }),
            );

        if (this.plugin.settings.enableStartupSync) {
            new Setting(containerEl)
                .setName(t("settingStartupDelay"))
                .setDesc(t("settingStartupDelayDesc"))
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
            .setName(t("settingAutoSyncInterval"))
            .setDesc(t("settingAutoSyncIntervalDesc"))
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
            .setName(t("settingTriggerSave"))
            .setDesc(t("settingTriggerSaveDesc"))
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.enableOnSaveTrigger)
                    .onChange(async (value) => {
                        this.plugin.settings.enableOnSaveTrigger = value;
                        await this.plugin.saveSettings();
                    }),
            );

        new Setting(containerEl)
            .setName(t("settingTriggerModify"))
            .setDesc(t("settingTriggerModifyDesc"))
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
                .setName(t("settingModifyDelay"))
                .setDesc(t("settingModifyDelayDesc"))
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
            .setName(t("settingTriggerLayout"))
            .setDesc(t("settingTriggerLayoutDesc"))
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.enableOnLayoutChangeTrigger)
                    .onChange(async (value) => {
                        this.plugin.settings.enableOnLayoutChangeTrigger = value;
                        await this.plugin.saveSettings();
                    }),
            );

        // 3. Performance
        containerEl.createEl("h3", { text: t("settingPerfSection") });

        new Setting(containerEl)
            .setName(t("settingConcurrency"))
            .setDesc(t("settingConcurrencyDesc"))
            .addText((text) =>
                text.setValue(String(this.plugin.settings.concurrency)).onChange(async (value) => {
                    this.plugin.settings.concurrency = this.validateNumber(value, 1, 10, 5);
                    await this.plugin.saveSettings();
                }),
            );

        // 4. Advanced
        containerEl.createEl("h3", { text: t("settingAdvancedSection") });

        new Setting(containerEl)
            .setName(t("settingDetailedNotifications"))
            .setDesc(t("settingDetailedNotificationsDesc"))
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.showDetailedNotifications)
                    .onChange(async (value) => {
                        this.plugin.settings.showDetailedNotifications = value;
                        await this.plugin.saveSettings();
                    }),
            );

        new Setting(containerEl)
            .setName(t("settingEnableLogging"))
            .setDesc(t("settingEnableLoggingDesc"))
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.enableLogging).onChange(async (value) => {
                    this.plugin.settings.enableLogging = value;
                    await this.plugin.saveSettings();
                }),
            );

        new Setting(containerEl)
            .setName(t("settingCloudRootFolder"))
            .setDesc(t("settingCloudRootFolderDesc"))
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
        containerEl.createEl("h3", { text: t("settingExclusionSection") });

        new Setting(containerEl)
            .setName(t("settingExclusionPatterns"))
            .setDesc(t("settingExclusionPatternsDesc"))
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
