// i18n Localization
// All languages are bundled inline.

import ja from "./lang/ja.json";

const languages: Record<string, Record<string, string>> = { ja };

export const en: Record<string, string> = {
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

    settingSubheaderSyncBehavior: "Sync Behavior",
    settingSubheaderPerformance: "Transfer Settings",
    settingSubheaderStartup: "Startup",
    settingSubheaderEventTriggers: "Event Triggers",
    settingSubheaderTriggerMode: "Trigger Mode",
    settingSubheaderCloudStorage: "Cloud Storage",
    settingSubheaderObsidian: "Obsidian Settings",
    settingSubheaderAppearance: "Appearance & Layout",
    settingSubheaderContent: "Content",
    settingSubheaderExclusion: "Exclusions",
    settingSubheaderLogging: "Logging",
    settingSubheaderDebug: "Debug",
    settingSubheaderSecurity: "Security",
    settingSubheaderAccount: "Account",
    settingExclusionModalToggleExclusion: "Managed by toggle",
    settingSyncFlexibleData: "Sync VaultSync Data",
    settingSyncFlexibleDataDesc: "Sync VaultSync plugin data (data/flexible/ directory).",
    settingSyncDeviceLogs: "Sync Device Logs",
    settingSyncDeviceLogsDesc: "Sync device-specific logs (logs/{deviceId}/).",
    settingExclusionPatterns: "Exclude Files/Folders",
    settingExclusionPatternsDesc:
        "Glob patterns (one per line).\nUse * for any chars, ** for recursive dirs.\nExample: *.tmp, temp/**",
    settingExclusionPatternsInvalid: "Invalid patterns detected. Check glob syntax (unmatched [ ] or { }).",
    settingExclusionPatternCount: "patterns configured",
    settingExclusionPatternNone: "No exclusion patterns",
    settingExclusionConfigure: "Configure",
    settingExclusionModalTitle: "Exclusion Patterns",
    settingExclusionModalAdd: "Add Pattern",
    settingExclusionModalPlaceholder: "Type a path or glob pattern...",
    settingExclusionModalEmpty: "No exclusion patterns configured.",
    settingExclusionModalMatchCount: "{0} files match",
    settingExclusionModalDuplicate: "This pattern already exists.",
    settingExclusionModalScanning: "Scanning vault files...",
    settingExclusionModalFileCount: "{0} files scanned",
    settingCloudRootFolderWarning: "Changing the root folder disconnects from current synced data. A full re-sync will occur. Continue?",
    settingNotificationLevel: "Notification Level",
    settingNotificationLevelDesc: "Choose how much feedback you want during sync.",
    settingNotificationLevelVerbose: "All (Verbose)",
    settingNotificationLevelStandard: "Standard (Default)",
    settingNotificationLevelError: "Errors Only",
    settingConflictStrategy: "Conflict Resolution Strategy",
    settingConflictStrategyDesc: "How to handle conflicts when both sides changed.",
    settingConflictStrategySmart: "Smart Merge (Try Auto-Merge)",
    settingConflictStrategyFork: "Create Copies (Keep Both Versions)",
    settingConflictStrategyLocal: "Keep This Device (Overwrite Cloud)",
    settingConflictStrategyRemote: "Keep Cloud (Overwrite This Device)",
    settingAdvancedSection: "Advanced Settings",
    settingAdvancedSectionDesc: "Advanced settings for power users.",
    settingSecuritySection: "Security (E2EE)",
    settingSubheaderE2EEStatus: "Encryption",
    settingE2EEStatus: "Encryption Status",
    settingE2EEStatusDisabled: "Disabled",
    settingE2EEStatusLocked: "Locked",
    settingE2EEStatusUnlocked: "Unlocked",
    settingE2EEStatusGuide: "Manage via Command Palette (E2EE: Start/Unlock Vault Encryption)",
    settingE2EEAutoUnlock: "Auto-unlock on Startup",
    settingE2EEAutoUnlockDesc:
        "WARNING: Stores E2EE password in Obsidian's SecretStorage for auto-unlock. " +
        "This reduces security to device-level rather than password-level protection. " +
        "Anyone with access to your device can decrypt your vault.",
    settingDevSection: "Developer Settings",
    settingStartupDelay: "Trigger: Startup Delay",
    settingStartupDelayDesc: "Wait for Obsidian to index files before starting sync.",

    // Notifications (Notice)
    noticeAuthSuccess: "[Auth] Successfully authenticated!",
    noticeAuthFailed: "[Auth] Auth failed",
    noticeSyncing: "[Sync] Processing...",
    noticeScanningLocalFiles: "[Sync] Scanning local files...",
    noticeInitialSyncConfirmation: "[Sync] Verifying upload identity...",
    noticeWaitingForRemoteRegistration: "[Sync] Waiting for remote registration...",
    noticePushCompleted: "[Sync] Upload completed ({0} files)",
    noticePullCompleted: "[Sync] Download completed ({0} files)",
    noticeVaultUpToDate: "[Sync] All files are up to date",
    noticeFilePushed: "[Sync] Uploading",
    noticeFilePulled: "[Sync] Downloading",
    noticeFileRenamed: "[Sync] Renamed",
    noticeFileMoved: "[Sync] Moved",
    noticeFileTrashed: "[Sync] Deleted",
    noticeSyncConfirmed: "[Sync] Success",
    noticeWaitOtherDeviceMerge: "[Conflict] Waiting for other device to resolve...: {0}",
    noticeMergingFile: "[Conflict] Merging",
    noticeMigrationStarted: "[E2EE] Migration started. Please do not close Obsidian.",
    noticeMigrationComplete: "[E2EE] Migration complete! Your vault is now encrypted.",
    noticeMigrationFailed: "[E2EE] Migration failed! Check logs for details.",
    noticeE2EEAutoEnabled:
        "[E2EE] This vault is encrypted on another device. Please enter your password to unlock.",
    noticeVaultLocked: "[E2EE] Vault is locked. Sync paused. Use Command Palette → 'E2EE: Unlock'.",
    noticeEngineVerifyFailed: "[E2EE] Engine verification failed. Please reinstall the plugin.",
    noticeE2EEPasswordChanged: "[E2EE] Encryption password changed successfully.",
    noticeE2EERecoveryComplete: "[E2EE] Vault recovered successfully with recovery code.",
    noticeE2EEDecryptFailed: "[E2EE] Decryption failed. Wrong password or corrupted data.",

    noticeSyncFailedAuth: "[Sync] Not authenticated. Please login from Settings.",
    noticeSyncFailedNetwork: "[Sync] Network error. Check your connection and try again.",
    noticeSyncFailed: "[Sync] Sync failed: {0}",

    noticeMergeLockLost: "[Conflict] Merge lock expired. Result saved locally, will push on next sync.",
    noticeMergeSuccess: "[Conflict] Auto-resolved",
    noticeCheckOtherDevice:
        "[Conflict] Merge may have failed. Check other device for details",
    noticeRemoteMergeSynced: "[Conflict] Remote merge result applied",
    noticeConflictSaved: "[Conflict] Local preserved as conflict file, Remote pulled",
    noticeConflictRemoteSaved: "[Conflict] Remote preserved as conflict file, Local pulled",
    noticeSavedKeepForever: "[History] Saved to Keep Forever",
    noticeFailedToSave:
        "[History] Failed to keep forever because of cloud-side specifications.",
    noticeFileRestored: "[History] File restored",
    noticeHistoryRestoreAs: "[History] File restored as: {0}",
    noticeRevisionDeleted: "[History] Revision deleted",

    // History Modal & Browser UI
    historyTitle: "History",
    historyActions: "Menue",
    historyKeepForever: "Keep Forever (Protect)",
    historyKeepForeverConfirm:
        "【Warning】Do you want to enable indefinite preservation (Keep Forever) for this revision?\n\nDue to Cloud-side specifications, once enabled, it cannot be disabled.\n(Only file deletion will be possible.)",
    historyKeepForeverError:
        "[History] Due to cloud-side specifications, Keep Forever cannot be disabled once enabled.",
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
        "Warning: Failed to save password to SecretStorage.\nYou will need to re-enter it next time.",

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
};

let activeDict: Record<string, string> = en;

/**
 * Initialize i18n by selecting the appropriate bundled language.
 * Must be called during plugin startup before any UI rendering.
 */
export function initI18n(): void {
    const lang = window.localStorage.getItem("language") || "en";
    if (lang === "en") return;

    if (languages[lang]) {
        activeDict = languages[lang];
    }
}

export function t(key: string): string {
    return activeDict[key] || en[key] || key;
}
