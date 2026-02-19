// i18n Localization
export const i18n: Record<string, Record<string, string>> = {
    en: {
        // Settings UI
        settingSettingsTitle: "VaultSync Settings",
        settingAuthSection: "Authentication",
        settingClientId: "Google Client ID",
        settingClientIdDesc: "Enter your Google Cloud Project Client ID.",
        settingClientSecret: "Google Client Secret",
        settingClientSecretDesc: "Enter your Google Cloud Project Client Secret.",
        settingAuthMethod: "Login Method",
        settingAuthMethodDesc: "Choose how to authenticate with Google Drive.",
        settingAuthMethodDefault: "Default (Recommended)",
        settingAuthMethodCustomProxy: "Use Custom Auth Proxy",
        settingAuthMethodClientCredentials: "Use Client ID / Secret",
        settingCustomProxyUrl: "Auth Proxy URL",
        settingCustomProxyUrlDesc: "Base URL of your auth proxy (e.g. https://your-proxy.example.com).",
        settingLogin: "Login",
        settingRelogin: "Re-login",
        settingLoginDesc: "Authorize with Google Drive.",

        settingTriggerStrategy: "Sync Trigger Strategy",
        settingTriggerStrategyDesc: "Choose how sync triggers are configured across devices.",
        settingTriggerStrategyUnified: "Unified (Same for all devices)",
        settingTriggerStrategyPerPlatform: "Per Platform (PC/Mobile separately)",
        settingTriggerSectionUnified: "Sync Triggers Settings",
        settingTriggerSectionDesktop: "Desktop Sync Triggers",
        settingTriggerSectionMobile: "Mobile Sync Triggers",

        settingTriggerSection: "Sync Triggers",
        settingStartupSync: "Trigger: Enable Startup Sync",
        settingStartupSyncDesc: "Sync with cloud automatically upon starting Obsidian.",
        settingAutoSyncInterval: "Trigger: Auto-sync Interval",
        settingAutoSyncIntervalDesc:
            "Sync periodically in background.\nNote: To prevent data loss, sync is skipped while you are actively editing.",
        settingTriggerSave: "Trigger: Save [Ctrl+S]",
        settingTriggerSaveDesc: "Sync when you explicitly save a file.",
        settingModify: "Trigger: Modify Delay",
        settingModifyDesc: "Seconds of inactivity before syncing.",
        settingTriggerLayout: "Trigger: Layout Change Delay",
        settingTriggerLayoutDesc: "Sync delay after switching files/tabs.",
        settingPerfSection: "Performance",
        settingConcurrency: "Simultaneous Sync Files",
        settingConcurrencyDesc: "Max number of files to sync at the same time.",
        settingDetailedNotifications: "Show Detailed Notifications",
        settingDetailedNotificationsDesc:
            "Show progress notifications for each file pushed/pulled.",
        settingEnableLogging: "Enable Detailed Logging",
        settingEnableLoggingDesc:
            "Developer: Write detailed logs to obsidian-vault-sync/logs folder.",
        settingCloudRootFolder: "Cloud Root Folder",
        settingCloudRootFolderDesc: "Root folder name on Cloud.\n(default: ObsidianVaultSync)",

        settingSyncScopeSection: "Sync Scope",
        settingSyncAppearance: "Sync Appearance Settings",
        settingSyncAppearanceDesc: "Sync .obsidian/themes and .obsidian/snippets.",
        settingSyncCommunityPlugins: "Sync Community Plugins",
        settingSyncCommunityPluginsDesc:
            "Sync installed plugins.\n(Caution: VaultSync itself is always synced)",
        settingSyncCoreConfig: "Sync Core Configuration",
        settingSyncCoreConfigDesc: "Sync app.json, hotkeys.json, and core-plugins.json.",
        settingSyncImagesAndMedia: "Sync Images & Media",
        settingSyncImagesAndMediaDesc: "Sync images, audio, video, and PDF files.",
        settingSyncDotfiles: "Sync Dotfiles",
        settingSyncDotfilesDesc:
            "Sync files starting with '.' (e.g. .git, .trash).\n.obsidian is always synced.",
        settingSyncPluginSettings: "Sync This Plugin Settings",
        settingSyncPluginSettingsDesc:
            "Sync data/remote/data.json.\nIf disabled, uses local settings Only.",
        settingSyncWorkspace: "Sync Workspace Layout",
        settingSyncWorkspaceDesc:
            "Sync workspace.json and workspace-mobile.json (tabs and pane layout settings).",

        settingExclusionPatterns: "Exclude Files/Folders",
        settingExclusionPatternsDesc:
            "Glob patterns (one per line).\nUse * for any chars, ** for recursive dirs.\nExample: *.tmp, temp/**",
        settingNotificationLevel: "Notification Level",
        settingNotificationLevelDesc: "Choose how much feedback you want during sync.",
        settingNotificationLevelVerbose: "All (Verbose)",
        settingNotificationLevelStandard: "Standard (Default)",
        settingNotificationLevelError: "Errors Only",
        settingConflictStrategy: "Conflict Resolution Strategy",
        settingConflictStrategyDesc: "How to handle conflicts when both sides changed.",
        settingConflictStrategySmart: "Smart Merge (Try Auto-Merge)",
        settingConflictStrategyFork: "Always Fork (Create Conflict File)",
        settingConflictStrategyLocal: "Force Local (Overwrite Remote)",
        settingConflictStrategyRemote: "Force Remote (Overwrite Local)",
        settingAdvancedSection: "Advanced Settings",
        settingAdvancedSectionDesc: "Advanced settings for power users.",
        settingSecuritySection: "Security (E2EE)",
        settingE2EEStatus: "Encryption Status",
        settingE2EEStatusDisabled: "Disabled",
        settingE2EEStatusLocked: "Locked",
        settingE2EEStatusUnlocked: "Unlocked",
        settingE2EEStatusGuide: "Manage via Command Palette (E2EE: Start/Unlock Vault Encryption)",
        settingE2EEAutoUnlock: "Auto-unlock on Startup",
        settingE2EEAutoUnlockDesc:
            "⚠️ WARNING: Stores E2EE password in system keychain for auto-unlock. " +
            "This reduces security to device-level rather than password-level protection. " +
            "Anyone with access to your device can decrypt your vault.",
        settingDevSection: "Developer Settings",
        settingStartupDelay: "Trigger: Startup Delay",
        settingStartupDelayDesc: "Wait for Obsidian to index files before starting sync.",

        // Notifications (Notice)
        noticeAuthSuccess: "✅ [Auth] Successfully authenticated!",
        noticeAuthFailed: "❌ [Auth] Auth failed",
        noticeSyncing: "⚡ [Sync] Processing...",
        noticeScanningLocalFiles: "🔍️ [Sync] Scanning local files...",
        noticeInitialSyncConfirmation: "📝 [Sync] Verifying upload identity...",
        noticeWaitingForRemoteRegistration: "⌛️ [Sync] Waiting for remote registration...",
        noticePushCompleted: "✅ [Sync] Upload completed ({0} files)",
        noticePullCompleted: "✅ [Sync] Download completed ({0} files)",
        noticeVaultUpToDate: "✅ [Sync] All files are up to date",
        noticeFilePushed: "📤 [Sync] Uploading",
        noticeFilePulled: "📥 [Sync] Downloading",
        noticeFileRenamed: "✏️ [Sync] Renamed",
        noticeFileMoved: "📂 [Sync] Moved",
        noticeFileTrashed: "🗑️ [Sync] Deleted",
        noticeSyncConfirmed: "✅ [Sync] Success",
        noticeWaitOtherDeviceMerge: "⌛️ [Conflict] Waiting for other device to resolve...",
        noticeMergingFile: "⌛️ [Conflict] Merging",
        noticeMigrationStarted: "🚀 [E2EE] Migration started. Please do not close Obsidian.",
        noticeMigrationComplete: "✅ [E2EE] Migration complete! Your vault is now encrypted.",
        noticeMigrationFailed: "❌ [E2EE] Migration failed! Check logs for details.",
        noticeE2EEAutoEnabled:
            "🔒 [E2EE] This vault is encrypted on another device. Please enter your password to unlock.",
        noticeVaultLocked: "🔒 [E2EE] Vault is locked. Sync paused.",
        noticeEngineVerifyFailed: "❌ [E2EE] Engine verification failed. Please reinstall the plugin.",
        noticeE2EEPasswordChanged: "✅ [E2EE] Encryption password changed successfully.",
        noticeE2EERecoveryComplete: "✅ [E2EE] Vault recovered successfully with recovery code.",
        noticeE2EEDecryptFailed: "❌ [E2EE] Decryption failed. Wrong password or corrupted data.",

        noticeMergeSuccess: "✅ [Conflict] Auto-resolved",
        noticeCheckOtherDevice:
            "⚠️ [Conflict] Merge may have failed. Check other device for details",
        noticeRemoteMergeSynced: "✅ [Conflict] Remote merge result applied",
        noticeConflictSaved: "⚠️ [Conflict] Local preserved as conflict file, Remote pulled",
        noticeConflictRemoteSaved: "⚠️ [Conflict] Remote preserved as conflict file, Local pulled",
        noticeSavedKeepForever: "✅ [History] Saved to Keep Forever",
        noticeFailedToSave:
            "❌ [History] Failed to keep forever because of cloud-side specifications.",
        noticeFileRestored: "💾 [History] File restored",
        noticeHistoryRestoreAs: "💾 [History] File restored as: {0}",
        noticeRevisionDeleted: "🗑️ [History] Revision deleted",

        // History Modal & Browser UI
        historyTitle: "History",
        historyActions: "Menue",
        historyKeepForever: "Keep Forever (Protect)",
        historyKeepForeverConfirm:
            "【Warning】Do you want to enable indefinite preservation (Keep Forever) for this revision?\n\nDue to Cloud-side specifications, once enabled, it cannot be disabled.\n(Only file deletion will be possible.)",
        historyKeepForeverError:
            "❌ [History] Due to cloud-side specifications, Keep Forever cannot be disabled once enabled.",
        historyDeleteRevision: "Delete this revision",
        historyDeleteConfirm:
            "Are you sure you want to delete this revision ({0})?\n\nThere is a risk that automatic merging will not function correctly if future conflicts occur.\nThis action cannot be undone.",
        historyNoHistoryFound: "No history found.",
        historyProtectedFromDeletion: "Protected from auto-deletion",
        historyByAuthor: "by",
        historySelectRevision: "Select a revision to view details.",
        historyRestoreVersion: "Restore this revision",
        historyRestoreConfirm:
            "Are you sure you want to restore this revision ({0})?\n\nCurrent local changes will be replaced.",
        historyCompareWith: "Compare with: ",
        historyCurrentLocalFile: "Current Local File",
        historyPreviousVersion: "Previous",
        historyInitialEmptyVersion: "Initial / Empty",
        historyAuthorUnknown: "Unknown",
        historyRestoreAs: "Restore as...",
        historyRestoreAsTitle: "Restore as (Path)",
        historyRestoreAsErrorExists: "A file with this name already exists.",
        historyDiffModeUnified: "Unified View",
        historyDiffModeSplit: "Split View",
        historyError: "Error",
        historyFailedToLoadHistory: "Failed to load history",
        historyShowAll: "Show all lines",
        historyShowDiffOnly: "Show changes only",
        historyNextDiff: "Next change",
        historyPrevDiff: "Previous change",
        historyContextLines: "Context: {0}",

        // Global Command/Tooltips
        labelSyncTooltip: "Sync with Cloud",
        labelSyncCommand: "Sync with Cloud",
        labelFullAudit: "Audit & Fix Consistency (Full Scan)",
        labelViewHistory: "View History in Cloud (VaultSync)",
        labelE2EESetup: "E2EE: Start Vault Encryption",
        labelE2EEUnlock: "E2EE: Unlock Vault Encryption",
        labelE2EEChangePassword: "E2EE: Change Encryption Password",
        labelE2EEShowRecovery: "E2EE: Show Recovery Code",
        labelE2EERecover: "E2EE: Recover Vault with Recovery Code",

        // Transfer Status
        labelTransferStatus: "Transfer Status (VaultSync)",
        transferTitle: "Transfer Status",
        transferActiveSection: "Active Transfers",
        transferHistorySection: "Recent History",
        transferNoActive: "No active transfers",
        transferNoHistory: "No transfer history",
        transferPush: "Upload",
        transferPull: "Download",
        transferCompleted: "Completed",
        transferFailed: "Failed",
        transferCancelled: "Cancelled",
        transferPending: "Pending",
        transferActive: "Transferring...",
        transferInline: "Inline",
        transferBackground: "Background",
        transferCancelAll: "Cancel All",

        // Settings
        settingLargeFileThreshold: "Large File Threshold (Background Transfer)",
        settingLargeFileThresholdDesc:
            "Files larger than this are transferred in the background, outside the sync cycle.\nSet to 0 to disable (all files sync inline).",
        settingBgTransferInterval: "Background Transfer Interval",
        settingBgTransferIntervalDesc:
            "Delay between consecutive background transfers.\nSet to 0 for no throttling (fastest).",

        // Password Strength
        passwordTooShort: "Password must be at least 8 characters.",
        passwordNeedsVariety: "Use a mix of uppercase, lowercase, numbers, and symbols.",
        passwordHasRepeats: "Avoid repeated characters (e.g. aaaa).",
        passwordHasSequences: "Avoid sequential characters (e.g. 1234, abcd).",
        passwordTooCommon: "This password is too common. Choose a more unique one.",
        passwordCouldBeStronger: "Consider using a longer password for better security.",
        passwordStrengthWeak: "Weak",
        passwordStrengthFair: "Fair",
        passwordStrengthGood: "Good",
        passwordStrengthStrong: "Strong",

        // E2EE Setup Modal
        e2eeSetupTitle: "E2EE Setup",
        e2eeSetupDesc:
            "Welcome to VaultSync E2EE.\nThis wizard will migrate your vault to an encrypted format.",
        e2eeSetupMigratingBg: "Migration is currently running in the background.",
        e2eeSetupPasswordLabel: "Encryption Password",
        e2eeSetupPasswordDesc: "Used to derive your Master Key. Don't lose it!",
        e2eeSetupPasswordHint:
            "Minimum length: 8 characters.\nAllowed: A-Z, a-z, 0-9, space, and symbols: !\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~",
        e2eeSetupAsciiOnly: "Only ASCII characters are allowed.",
        e2eeSetupStartButton: "Start Migration",
        e2eeSetupMigratingButton: "Migrating...",
        e2eeSetupFinalizing: "Finalizing migration...",
        e2eeSetupSwapping: "Performing folder swap on remote...",
        e2eeSetupError: "Error occurred. Check logs.",
        e2eeSetupKeychainFailed:
            "Warning: Failed to save password to keychain.\nYou will need to re-enter it next time.",

        // E2EE Interrupted Migration
        e2eeInterruptedTitle: "Interrupted Migration Found",
        e2eeInterruptedDesc:
            "A previous migration attempt was interrupted.\nA temporary encrypted folder exists on the remote.",
        e2eeInterruptedCleanLabel: "Clean Up & Restart",
        e2eeInterruptedCleanDesc: "Delete the temporary folder and start over.",
        e2eeInterruptedResetButton: "Reset & Restart",
        e2eeInterruptedCleaning: "Cleaning up...",
        e2eeInterruptedDone: "Cleanup complete. Please reopen this modal.",

        // E2EE Unlock Modal
        e2eeUnlockTitle: "Unlock Vault",
        e2eeUnlockPasswordLabel: "Password",
        e2eeUnlockButton: "Unlock",
        e2eeUnlockAutoUnlock: "Remember password and auto-unlock on startup",
        e2eeUnlockSuccess: "Unlocked!",
        e2eeUnlockFailed: "Invalid password.",

        // E2EE Password Change Modal
        e2eeChangePasswordTitle: "Change Encryption Password",
        e2eeChangePasswordDesc: "Enter a new password to re-encrypt your master key.\nExisting encrypted data will remain unchanged.",
        e2eeChangePasswordNewLabel: "New Password",
        e2eeChangePasswordConfirmLabel: "Confirm New Password",
        e2eeChangePasswordButton: "Change Password",

        // E2EE Recovery Code Modal
        e2eeRecoveryExportTitle: "Recovery Code",
        e2eeRecoveryExportDesc: "This code can restore access to your vault if you forget your password.",
        e2eeRecoveryWarning: "Store this code in a safe place. Anyone with this code can decrypt your vault.",
        e2eeRecoveryCopy: "Copy to Clipboard",
        e2eeRecoveryCopied: "Copied!",
        e2eeRecoveryClose: "Close",
        e2eeRecoveryImportTitle: "Recover Vault",
        e2eeRecoveryImportDesc: "Enter your recovery code and set a new password to restore vault access.",
        e2eeRecoveryCodeLabel: "Recovery Code",
        e2eeRecoveryRestoreButton: "Recover Vault",
    },
    ja: {
        // Settings UI
        settingSettingsTitle: "VaultSync 設定",
        settingAuthSection: "認証",
        settingClientId: "Client ID",
        settingClientIdDesc: "Google Cloud Project の Client ID。",
        settingClientSecret: "Client Secret",
        settingClientSecretDesc: "Google Cloud Project の Client Secret。",
        settingAuthMethod: "ログイン方式",
        settingAuthMethodDesc: "Google Drive への認証方法を選択します。",
        settingAuthMethodDefault: "デフォルト（推奨）",
        settingAuthMethodCustomProxy: "他の認証プロキシを使用",
        settingAuthMethodClientCredentials: "Client ID / Secret を使用",
        settingCustomProxyUrl: "認証プロキシURL",
        settingCustomProxyUrlDesc: "認証プロキシのベースURL（例: https://your-proxy.example.com）。",
        settingLogin: "ログイン",
        settingRelogin: "再ログイン",
        settingLoginDesc: "Google Drive と連携します。",

        settingTriggerStrategy: "同期トリガーの設定方式",
        settingTriggerStrategyDesc:
            "デバイス間で同期トリガーの設定を共有するか、プラットフォームごとに分けるかを選択します。",
        settingTriggerStrategyUnified: "一括設定 (全デバイス共通)",
        settingTriggerStrategyPerPlatform: "環境別設定 (PC/モバイルで個別に設定)",
        settingTriggerSectionUnified:
            "同期トリガー詳細設定 (⚠注意: 時間を短くした場合、通信量も増加します。)",
        settingTriggerSectionDesktop:
            "PC用同期トリガー詳細設定 (⚠注意: 時間を短くした場合、通信量も増加します。)",
        settingTriggerSectionMobile:
            "モバイル用同期トリガー詳細設定 (⚠注意: 時間を短くした場合、通信量も増加します。)",

        settingTriggerSection: "同期トリガー設定",
        settingStartupSync: "トリガー: 起動時",
        settingStartupSyncDesc: "Obsidian 起動時に自動でクラウドと同期します。",
        settingAutoSyncInterval: "トリガー: タイマー",
        settingAutoSyncIntervalDesc:
            "バックグラウンドで定期的に同期します。\n注意: データ損失を防ぐため、編集操作中は同期をスキップします。",
        settingTriggerSave: "トリガー: 保存時 [Ctrl+S押下時]",
        settingTriggerSaveDesc: "明示的にファイルを保存した際に、一定時間後に同期を実行。",
        settingModify: "トリガー: 編集時",
        settingModifyDesc: "ファイル編集後、一定時間後に同期を実行。",
        settingTriggerLayout: "トリガー: レイアウト変更時",
        settingTriggerLayoutDesc:
            "ウィンドウの切替など表示を切り替えた際に、一定時間後に同期を実行。",
        settingPerfSection: "パフォーマンス",
        settingConcurrency: "同時同期ファイル数",
        settingConcurrencyDesc:
            "同時に同期(アップロード/ダウンロード)するファイルの最大数。\n2以上の場合、並列で行われます。",
        settingDetailedNotifications: "詳細な通知を表示",
        settingDetailedNotificationsDesc: "プッシュ/プルごとに進捗通知を表示します。",
        settingEnableLogging: "詳細なログ出力を有効化",
        settingEnableLoggingDesc:
            "開発者向け: obsidian-vault-sync/logs フォルダのログを詳細に出力します。",
        settingCloudRootFolder: "クラウドルートフォルダ",
        settingCloudRootFolderDesc:
            "クラウド上の同期先ルートフォルダ名。\n(デフォルト: ObsidianVaultSync)",

        settingSyncScopeSection: "同期範囲",
        settingSyncAppearance: "外観設定を同期",
        settingSyncAppearanceDesc: ".obsidian/themes と .obsidian/snippets を同期します。",
        settingSyncCommunityPlugins: "コミュニティプラグインを同期",
        settingSyncCommunityPluginsDesc:
            "インストール済みプラグインを同期します。\n注意: VaultSync自体は常に同期されます。",
        settingSyncCoreConfig: "コア設定を同期",
        settingSyncCoreConfigDesc: "app.json, hotkeys.json, core-plugins.json 等を同期します。",
        settingSyncImagesAndMedia: "画像・メディアファイルを同期",
        settingSyncImagesAndMediaDesc: "画像、音声、動画、PDFファイルを同期します。",
        settingSyncDotfiles: "ドットファイルを同期",
        settingSyncDotfilesDesc:
            ".から始まるファイル (.git, .trash等) を同期します。\n注意: .obsidian は常に同期されます。",
        settingSyncPluginSettings: "VaultSync設定を同期",
        settingSyncPluginSettingsDesc:
            "本プラグインの設定を同期します。\n無効の場合、設定はデバイスごとに管理されます。",
        settingSyncWorkspace: "ワークスペース設定を同期",
        settingSyncWorkspaceDesc:
            "workspace.json および workspace-mobile.json (開いているタブやペインの配置) を同期します。",

        settingExclusionPatterns: "除外ファイル/フォルダ",
        settingExclusionPatternsDesc:
            "globパターン (1行1パターン)。\n* は任意の文字、** は再帰ディレクトリ。\n例: *.tmp, temp/**",
        settingNotificationLevel: "通知レベル",
        settingNotificationLevelDesc: "同期中の通知フィードバックの量を選択してください。",
        settingNotificationLevelVerbose: "すべて (詳細)",
        settingNotificationLevelStandard: "標準 (デフォルト)",
        settingNotificationLevelError: "エラーのみ",
        settingConflictStrategy: "競合解決戦略",
        settingConflictStrategyDesc: "双方向で変更があった場合の競合解決方法。",
        settingConflictStrategySmart: "スマートマージ (自動マージを試行)",
        settingConflictStrategyFork: "レプリカ作成 (競合ファイルを生成)",
        settingConflictStrategyLocal: "ローカル優先 (リモートを上書き)",
        settingConflictStrategyRemote: "リモート優先 (ローカルを上書き)",
        settingAdvancedSection: "高度な設定",
        settingAdvancedSectionDesc: "高度な設定とデバッグツールを有効にします。",
        settingSecuritySection: "セキュリティ (E2EE)",
        settingE2EEStatus: "暗号化ステータス",
        settingE2EEStatusDisabled: "未設定",
        settingE2EEStatusLocked: "ロック中",
        settingE2EEStatusUnlocked: "解除済み",
        settingE2EEStatusGuide:
            "コマンドパレットで「E2EE: Vaultの暗号化を開始/解除する」を実行してください。",
        settingE2EEAutoUnlock: "起動時の自動ロック解除",
        settingE2EEAutoUnlockDesc:
            "⚠️ 警告: E2EEパスワードをシステムキーチェーンに保存し、起動時に自動的にロック解除します。" +
            "これによりセキュリティレベルがパスワードレベルからデバイスレベルに低下します。" +
            "デバイスにアクセスできる誰でもVaultを復号化できてしまいます。",
        settingDevSection: "開発者向け設定",
        settingStartupDelay: "起動時の遅延",
        settingStartupDelayDesc: "Obsidian 起動後、同期を開始するまでの待機時間。",

        // Notifications (Notice)
        noticeAuthSuccess: "✅ [認証] 成功！",
        noticeAuthFailed: "❌ [認証] 失敗",
        noticeSyncing: "⚡ [同期] 処理開始...",
        noticeScanningLocalFiles: "🔍️ [同期] ローカルファイルを走査中...",
        noticeInitialSyncConfirmation: "📝 [同期] 正常にアップロード出来たか確認中...",
        noticeWaitingForRemoteRegistration: "⌛️ [同期] リモート側の反映完了を待機中...",
        noticePushCompleted: "✅ [同期] アップロード完了 ({0} files)",
        noticePullCompleted: "✅ [同期] ダウンロード完了 ({0} files)",
        noticeVaultUpToDate: "✅ [同期] すべて最新の状態です",
        noticeFilePushed: "📤 [同期] アップロード中",
        noticeFilePulled: "📥 [同期] ダウンロード中",
        noticeFileRenamed: "✏️ [同期] リネーム",
        noticeFileMoved: "📂 [同期] 移動",
        noticeFileTrashed: "🗑️ [同期] 削除",
        noticeSyncConfirmed: "✅ [同期] 成功",
        noticeWaitOtherDeviceMerge: "⌛️ [競合] 他デバイスが解決するのを待機しています...",
        noticeMergingFile: "⌛️ [競合] マージ中",
        noticeMigrationStarted: "🚀 [E2EE] 移行を開始しました。Obsidianを閉じないでください。",
        noticeMigrationComplete: "✅ [E2EE] 移行完了！Vaultが暗号化されました。",
        noticeMigrationFailed: "❌ [E2EE] 移行失敗。ログを確認してください。",
        noticeE2EEAutoEnabled:
            "🔒 [E2EE] このVaultは他デバイスで暗号化されています。パスワードを入力してロックを解除してください。",
        noticeVaultLocked: "🔒 [E2EE] Vaultがロック中のため同期を一時停止しています。",
        noticeEngineVerifyFailed: "❌ [E2EE] エンジンの検証に失敗しました。プラグインを再インストールしてください。",
        noticeE2EEPasswordChanged: "✅ [E2EE] 暗号化パスワードを変更しました。",
        noticeE2EERecoveryComplete: "✅ [E2EE] リカバリーコードでVaultを復元しました。",
        noticeE2EEDecryptFailed: "❌ [E2EE] 復号に失敗しました。パスワードが間違っているか、データが破損しています。",
        noticeMergeSuccess: "✅ [競合] 自動解決されました",
        noticeCheckOtherDevice:
            "⚠️ [競合] マージに失敗した可能性が有ります。詳細は他デバイスを確認してください",
        noticeRemoteMergeSynced: "✅ [競合] 他デバイスの解決結果を反映しました",
        noticeConflictSaved: "⚠️ [競合] ローカル版を保護し、リモート版を反映しました",
        noticeConflictRemoteSaved: "⚠️ [競合] リモート版を保護し、ローカル版を反映しました",
        noticeSavedKeepForever: "✅ [履歴] 無期限保護設定完了",
        noticeFailedToSave:
            "❌ [履歴] クラウド側の仕様により、無期限保存設定を解除することはできません。",
        noticeHistoryRestoreAs: "💾 [履歴] 別名で復元しました: {0}",
        noticeFileRestored: "💾 [履歴] ファイルを復元しました",
        noticeRevisionDeleted: "🗑️ [履歴] リビジョンを削除しました",

        // History Modal & Browser UI
        historyTitle: "履歴",
        historyActions: "メニュー",
        historyKeepForever: "無期限保存 (保護)",
        historyKeepForeverConfirm:
            "【警告】このリビジョンを無期限保存(Keep Forever)しますか？\n\nクラウド側の仕様により、一度設定すると解除することはできません。\n（リビジョンの削除のみ可能となります）",
        historyKeepForeverError:
            "❌ [履歴] クラウド側の仕様により、無期限保存設定を解除することはできません。",
        historyDeleteRevision: "このリビジョンを削除",
        historyDeleteConfirm:
            "このリビジョン ({0}) を【削除】してもよろしいですか？\n\n今後競合が発生した場合に、自動マージが正常に実行出来ないリスクが有ります。\nまた、この操作は取り消せません。",
        historyNoHistoryFound: "履歴が見つかりません",
        historyProtectedFromDeletion: "自動削除から保護されています",
        historyByAuthor: "更新者:",
        historySelectRevision: "リビジョンを選択すると詳細が表示されます",
        historyRestoreVersion: "このリビジョンを復元",
        historyRestoreConfirm:
            "このリビジョン ({0}) を復元してもよろしいですか？\n\n現在のローカルファイルの内容は上書きされます。",
        historyCompareWith: "比較対象: ",
        historyCurrentLocalFile: "現在のローカルファイル",
        historyPreviousVersion: "前のリビジョン",
        historyInitialEmptyVersion: "最初（空）の状態",
        historyAuthorUnknown: "不明",
        historyRestoreAs: "別名で復元",
        historyRestoreAsTitle: "別名で復元 (パスを入力)",
        historyRestoreAsErrorExists: "同じ名前のファイルが既に存在します。",
        historyDiffModeUnified: "ユニファイド表示",
        historyDiffModeSplit: "左右分割表示",
        historyError: "エラー",
        historyFailedToLoadHistory: "履歴の読み込みに失敗しました",
        historyShowAll: "全文表示",
        historyShowDiffOnly: "差分のみ表示",
        historyNextDiff: "次の差分",
        historyPrevDiff: "前の差分",
        historyContextLines: "前後行数: {0}",

        // Global Command/Tooltips
        labelSyncTooltip: "クラウドと同期",
        labelSyncCommand: "クラウドと同期",
        labelFullAudit: "完全スキャンと整合性チェック (Full Audit)",
        labelViewHistory: "クラウドの変更履歴を表示 (VaultSync)",
        labelE2EESetup: "E2EE: Vaultの暗号化を開始する",
        labelE2EEUnlock: "E2EE: Vaultの暗号化を解除する",
        labelE2EEChangePassword: "E2EE: 暗号化パスワードを変更する",
        labelE2EEShowRecovery: "E2EE: リカバリーコードを表示する",
        labelE2EERecover: "E2EE: リカバリーコードでVaultを復元する",

        // Transfer Status
        labelTransferStatus: "転送ステータス (VaultSync)",
        transferTitle: "転送ステータス",
        transferActiveSection: "転送中",
        transferHistorySection: "転送履歴",
        transferNoActive: "転送中のファイルはありません",
        transferNoHistory: "転送履歴はありません",
        transferPush: "アップロード",
        transferPull: "ダウンロード",
        transferCompleted: "完了",
        transferFailed: "失敗",
        transferCancelled: "キャンセル",
        transferPending: "待機中",
        transferActive: "転送中...",
        transferInline: "インライン",
        transferBackground: "バックグラウンド",
        transferCancelAll: "すべてキャンセル",

        // Settings
        settingLargeFileThreshold: "バックグラウンド転送の閾値",
        settingLargeFileThresholdDesc:
            "この値を超えるファイルは同期サイクル外でバックグラウンド転送されます。\n0に設定すると無効（全ファイルがインライン同期）。",
        settingBgTransferInterval: "バックグラウンド転送の間隔",
        settingBgTransferIntervalDesc:
            "バックグラウンド転送間の待機時間。\n0に設定するとスロットリングなし（最速）。",

        // Password Strength
        passwordTooShort: "パスワードは8文字以上にしてください。",
        passwordNeedsVariety: "大文字・小文字・数字・記号を組み合わせてください。",
        passwordHasRepeats: "同じ文字の繰り返し（例：aaaa）は避けてください。",
        passwordHasSequences: "連続する文字（例：1234、abcd）は避けてください。",
        passwordTooCommon: "よく使われるパスワードです。もっとユニークなものを選んでください。",
        passwordCouldBeStronger: "より長いパスワードの使用を推奨します。",
        passwordStrengthWeak: "弱い",
        passwordStrengthFair: "普通",
        passwordStrengthGood: "良い",
        passwordStrengthStrong: "強い",

        // E2EE Setup Modal
        e2eeSetupTitle: "E2EE セットアップ",
        e2eeSetupDesc:
            "VaultSync E2EE へようこそ。\nこのウィザードでVaultを暗号化形式に移行します。",
        e2eeSetupMigratingBg: "移行はバックグラウンドで実行中です。",
        e2eeSetupPasswordLabel: "暗号化パスワード",
        e2eeSetupPasswordDesc: "マスターキーの生成に使用します。絶対に忘れないでください！",
        e2eeSetupPasswordHint:
            "最低文字数: 8文字\n使用可能な文字: A-Z, a-z, 0-9, スペース, 記号: !\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~",
        e2eeSetupAsciiOnly: "ASCII文字のみ使用できます。",
        e2eeSetupStartButton: "移行を開始",
        e2eeSetupMigratingButton: "移行中...",
        e2eeSetupFinalizing: "移行を完了中...",
        e2eeSetupSwapping: "リモートでフォルダ入替を実行中...",
        e2eeSetupError: "エラーが発生しました。ログを確認してください。",
        e2eeSetupKeychainFailed:
            "警告: キーチェーンへのパスワード保存に失敗しました。\n次回起動時にパスワードの再入力が必要です。",

        // E2EE Interrupted Migration
        e2eeInterruptedTitle: "中断された移行を検出",
        e2eeInterruptedDesc:
            "前回の移行が中断されました。\nリモートに一時暗号化フォルダが残っています。",
        e2eeInterruptedCleanLabel: "クリーンアップして再開",
        e2eeInterruptedCleanDesc: "一時フォルダを削除して最初からやり直します。",
        e2eeInterruptedResetButton: "リセットして再開",
        e2eeInterruptedCleaning: "クリーンアップ中...",
        e2eeInterruptedDone: "クリーンアップ完了。このモーダルを再度開いてください。",

        // E2EE Unlock Modal
        e2eeUnlockTitle: "Vaultのロック解除",
        e2eeUnlockPasswordLabel: "パスワード",
        e2eeUnlockButton: "ロック解除",
        e2eeUnlockAutoUnlock: "パスワードを保存し、次回から自動でロック解除する",
        e2eeUnlockSuccess: "ロック解除しました！",
        e2eeUnlockFailed: "パスワードが正しくありません。",

        // E2EE Password Change Modal
        e2eeChangePasswordTitle: "暗号化パスワードの変更",
        e2eeChangePasswordDesc: "新しいパスワードを入力してマスターキーを再暗号化します。\n既存の暗号化データはそのまま維持されます。",
        e2eeChangePasswordNewLabel: "新しいパスワード",
        e2eeChangePasswordConfirmLabel: "新しいパスワード (確認)",
        e2eeChangePasswordButton: "パスワードを変更",

        // E2EE Recovery Code Modal
        e2eeRecoveryExportTitle: "リカバリーコード",
        e2eeRecoveryExportDesc: "パスワードを忘れた場合にVaultへのアクセスを復元できるコードです。",
        e2eeRecoveryWarning: "このコードを安全な場所に保管してください。このコードがあればVaultを復号できます。",
        e2eeRecoveryCopy: "クリップボードにコピー",
        e2eeRecoveryCopied: "コピーしました！",
        e2eeRecoveryClose: "閉じる",
        e2eeRecoveryImportTitle: "Vaultの復元",
        e2eeRecoveryImportDesc: "リカバリーコードと新しいパスワードを入力してVaultへのアクセスを復元します。",
        e2eeRecoveryCodeLabel: "リカバリーコード",
        e2eeRecoveryRestoreButton: "Vaultを復元",
    },
};

export function t(key: string): string {
    const lang = window.localStorage.getItem("language") || "en";
    const dict = i18n[lang] || i18n["en"];
    return dict[key] || i18n["en"][key] || key;
}
