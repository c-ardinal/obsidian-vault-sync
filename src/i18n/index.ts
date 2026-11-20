// i18n Localization
// All languages are bundled inline.

import { getLanguage } from "obsidian";
import ja from "./lang/ja.json";

const languages: Record<string, Record<string, string>> = { ja };

export const en: Record<string, string> = {
    // Settings UI
    settingSettingsTitle: "Vault-Sync Settings",
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
    settingLogout: "Logout",
    settingLogoutDesc:
        "Sign out of Google Drive on this device and revoke the sign-in. Files are not deleted.",
    settingLogoutConfirm:
        "Sign out of Google Drive on this device?\nSyncing stops until you log in again. No files are deleted.",
    noticeLoggedOut: "[Auth] Logged out",
    noticeLogoutBusy: "[Auth] Sync is running. Try again when it has finished.",
    confirmOk: "OK",
    confirmCancel: "Cancel",
    settingDefaultHint: "{0} ~ {1} (default: {2})",
    unitSec: "sec",
    unitFiles: "files",
    unitMB: "MB",

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
    settingDetailedNotificationsDesc: "Show progress notifications for each file pushed/pulled.",
    settingEnableLogging: "Enable Detailed Logging",
    settingEnableLoggingDesc: "Developer: Write detailed logs to the logs folder inside this plugin's folder.",
    settingCloudRootFolder: "Cloud Root Folder",
    settingCloudRootFolderDesc: "Root folder name on Cloud.\n(default: ObsidianVaultSync)",

    settingSyncScopeSection: "Sync Scope",
    settingSyncAppearance: "Sync Appearance Settings",
    settingSyncAppearanceDesc: "Sync .obsidian/themes and .obsidian/snippets.",
    settingSyncCommunityPlugins: "Sync Community Plugins",
    settingSyncCommunityPluginsDesc:
        "Sync installed plugins.\n(Caution: Vault-Sync itself is always synced)",
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
    settingSyncFlexibleData: "Sync Vault-Sync Data",
    settingSyncFlexibleDataDesc: "Sync Vault-Sync plugin data (data/flexible/ directory).",
    settingSyncDeviceLogs: "Sync Device Logs",
    settingSyncDeviceLogsDesc: "Sync device-specific logs (logs/{deviceId}/).",
    settingExclusionPatterns: "Exclude Files/Folders",
    settingExclusionPatternsDesc:
        "Glob patterns (one per line).\nUse * for any chars, ** for recursive dirs.\nExample: *.tmp, temp/**",
    settingExclusionPatternsInvalid:
        "Invalid patterns detected. Check glob syntax (unmatched [ ] or { }).",
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
    settingCloudRootFolderInvalid:
        "This folder name cannot be used. Enter a name that does not start with / and contains none of \\ < > : \" | ? *",
    settingCloudRootFolderChange: "Change",
    settingCloudRootFolderWarning:
        "Changing the root folder disconnects from current synced data. A full re-sync will occur. Continue?",
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
    noticeEngineVerifyFailed:
        "Add-on verification failed: it does not match an approved release. Download the latest package and install it again.",

    noticeSyncFailedAuth: "[Sync] Not authenticated. Please login from Settings.",
    noticeSyncFailedNetwork: "[Sync] Network error. Check your connection and try again.",
    noticeSyncFailed: "[Sync] Sync failed: {0}",

    noticeMergeLockLost:
        "[Conflict] Merge lock expired. Result saved locally, will push on next sync.",
    noticeMergeSuccess: "[Conflict] Auto-resolved",
    noticeCheckOtherDevice: "[Conflict] Merge may have failed. Check other device for details",
    noticeRemoteMergeSynced: "[Conflict] Remote merge result applied",
    noticeConflictSaved: "[Conflict] Local preserved as conflict file, Remote pulled",
    noticeConflictRemoteSaved: "[Conflict] Remote preserved as conflict file, Local pulled",
    noticeSavedKeepForever: "[History] Saved to Keep Forever",
    noticeFailedToSave: "[History] Failed to keep forever because of cloud-side specifications.",
    noticeFileRestored: "[History] File restored",
    noticeHistoryRestoreAs: "[History] File restored as: {0}",
    noticeRevisionDeleted: "[History] Revision deleted",

    // History Modal & Browser UI
    historyTitle: "History",
    historyActions: "Menu",
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
    labelViewHistory: "View History in Cloud (Vault-Sync)",
    noticeLegacyCopyEnabled:
        "Vault-Sync: An older copy of this plugin (ID obsidian-vault-sync) is still enabled. Turn it off or uninstall it in Settings → Community plugins, then restart the app. Syncing is paused until then.",
    noticeLegacyDataMigrated:
        "Vault-Sync: Settings and sync data were carried over from the older copy of the plugin. You can uninstall the older copy (ID obsidian-vault-sync).",
    labelInstallAddon: "Install add-on",
    settingNavBack: "Settings",
    settingNavBackAria: "Back to the settings list",
    settingCategoryAccountDesc: "Login method, login and logout",
    settingCategoryAccountSignedIn: "Logged in",
    settingCategoryAccountSignedOut: "Not logged in",
    settingCategoryTriggersDesc: "When to sync: on startup, on save, at intervals",
    settingCategoryScopeDesc: "Cloud folder, file types to sync, exclusions",
    settingCategoryPerformanceDesc: "Conflict handling, notifications, transfers",
    settingCategoryAddonsDesc: "Install and manage optional add-ons",
    settingCategoryAdvancedDesc: "Logging and other detailed settings",
    addonSectionTitle: "Add-ons",
    addonStatusNone: "No add-ons installed",
    addonStatusNoneDesc:
        "Add-ons are optional extensions distributed separately from Vault-Sync, each with its own terms of use. Install one only if you want it.",
    addonStatusInstalled: "Installed add-ons",
    addonStatusInstalledManually: "Installed manually",
    addonInstallOpen: "Install add-on...",
    addonReinstall: "Update / reinstall...",
    addonRemove: "Remove",
    addonRemoveConfirm:
        "Remove the add-on from this device?\nIf this vault uses it, syncing on this device pauses until you install it again. Nothing is deleted from the cloud.",
    addonRemoved: "Add-on removed.",
    addonRemoveBusy: "Sync is running. Try again when it has finished.",
    addonRemoveFailed: "The add-on could not be removed. Check the logs.",
    addonStatusUpdateRequired: "Add-on update required",
    addonStatusUpdateRequiredDesc:
        "This version of Vault-Sync needs a newer release of the add-on. Download the latest package and install it.",
    addonUpdateOpen: "Update add-on...",
    noticeAddonUpdateRequired:
        "The installed add-on is out of date for this version of Vault-Sync. Download the latest package and install it from Settings → Add-ons. Sync paused.",
    addonInstallTitle: "Install an add-on",
    addonRequiredByVault:
        "This vault uses an add-on that is not installed on this device. Install it to keep syncing.",
    addonInstallIntro:
        "Add-ons are distributed separately from Vault-Sync. Download the add-on package (.zip) yourself, then choose it here. Vault-Sync checks it and shows its terms of use before installing.",
    addonStepDownload: "1. Download",
    addonStepDownloadDesc:
        "Open the download page and save the .zip package from the latest release. On a phone it goes to your Downloads / Files.",
    addonOpenDownloadPage: "Open download page",
    addonStepChoose: "2. Choose the package",
    addonStepChooseDesc: "Choose the downloaded .zip file.",
    addonChooseFile: "Choose file",
    addonVerifying: "Verifying...",
    addonStepTerms: "3. Terms of use",
    addonAgreeTerms: "I have read and agree to these terms of use",
    addonInstallButton: "Install",
    addonInstalling: "Installing...",
    addonInstallSuccess: "Add-on installed.",
    addonErrorNotPackage:
        "This file is not an add-on package. Choose the .zip file from the download page.",
    addonErrorUnknown: "This add-on is not supported by this version of Vault-Sync.",
    addonErrorHash:
        "This package does not match the approved release. Download the latest release again. If it still fails, update Vault-Sync.",
    addonErrorWrite: "The add-on could not be saved. Check storage space and try again.",
    noticeAddonRequired:
        "This vault uses an add-on that is not installed on this device. Install it from Settings → Add-ons. Sync paused.",

    // Transfer Status
    labelTransferStatus: "Transfer Status (Vault-Sync)",
    labelTransferStatusCommand: "Show Transfer Status",
    transferTitle: "Transfer Status",
    transferActiveSection: "Active Transfers",
    transferHistorySection: "Recent History",
    transferNoActive: "Nothing waiting to transfer",
    transferNoHistory: "No transfer history",
    transferPush: "Upload",
    transferPull: "Download",
    transferCompleted: "Completed",
    transferFailed: "Failed",
    transferCancelled: "Cancelled",
    transferPending: "Pending",
    transferActive: "Transferring",
    transferInline: "Inline",
    transferBackground: "Background",
    transferCancelAll: "Cancel All",
    transferQueueTitle: "Queue",
    transferMore: "{0} more",
    transferRetrying: "Retry {0}/{1}",
    transferFilterAll: "All",
    transferFilterPull: "Download",
    transferFilterPush: "Upload",
    transferFilterFailed: "Failed",
    transferToday: "Today",
    transferYesterday: "Yesterday",
    transferNoMatch: "No matching transfers",
    transferBatchFailed: "{0} failed",

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

    // Add-on specific text (its settings, commands, dialogs and notices) is not
    // here: the add-on supplies it at runtime (see setAddonStrings).

    // Display settings (diff text size + preview)
    settingDisplaySection: "Display",
    settingCategoryDisplayDesc: "Sync status display, diff text size",
    settingSubheaderSyncStatus: "Sync status",
    settingSubheaderDiff: "Diff view",
    settingDiffFontSizeDesktop: "Text size (desktop)",
    settingDiffFontSizeDesktopDesc: "Text size of the diff in the file history on desktop.",
    settingDiffFontSizeMobile: "Text size (mobile)",
    settingDiffFontSizeMobileDesc: "Text size of the diff in the file history on phones and tablets.",
    settingDiffPreview: "Preview",
    settingDiffPreviewDesc: "How the diff looks with the sizes above.",
    settingDiffPreviewDesktop: "Desktop",
    settingDiffPreviewMobile: "Mobile",
    diffPreviewLine1: "# Meeting notes",
    diffPreviewLine2: "- Next meeting: Monday 10:00",
    diffPreviewLine3: "- Next meeting: Tuesday 10:00",
    diffPreviewLine4a: "- Owner: ",
    diffPreviewLine4b: "Alex",
    diffPreviewLine4c: "Sam",

    // Sync status display (status bar / mobile pill / detail panel)
    labelShowSyncStatusCommand: "Show Sync Status",
    settingShowSyncStatus: "Show sync status",
    settingShowSyncStatusDesc: "Show sync progress, file counts and time left in the status bar (at the top of the screen on phones). While on, progress notices are left out unless the notification level is All.",
    statusPanelTitle: "Sync status",
    statusOpenDetails: "Show sync status details",
    statusSyncing: "Syncing",
    statusScanning: "Scanning",
    statusSynced: "Synced",
    statusFailed: "Sync failed",
    statusOffline: "Offline",
    statusAuth: "Not signed in",
    statusNever: "Not synced yet",
    statusSeconds: "{0}s",
    statusMinutes: "{0} min",
    statusJustNow: "just now",
    statusMinutesAgo: "{0} min ago",
    statusAbout: "about ",
    statusEta: "Time left:",
    statusStartedAt: "started {0}",
    statusLastSync: "Last sync {0} (took {1})",
    statusTrigger_default: "Sync",
    "statusTrigger_manual-sync": "Manual sync",
    "statusTrigger_startup-sync": "Startup sync",
    "statusTrigger_initial-sync": "First sync",
    "statusTrigger_timer-sync": "Scheduled sync",
    "statusTrigger_save-sync": "Sync on save",
    "statusTrigger_modify-sync": "Sync on edit",
    "statusTrigger_layout-sync": "Sync on layout change",
    "statusTrigger_full-scan": "Full scan",
    statusStepCheck: "Check",
    statusStepScan: "Scan",
    statusStepPull: "Download",
    statusStepPush: "Upload",
    statusStepDone: "Done",
    statusFiles: "{0} / {1} files",
    statusScanCount: "{0} / {1} checked",
    statusCheckingRemote: "Checking for changes",
    statusPull: "↓ Download",
    statusPush: "↑ Upload",
    statusConflicts: "Conflicts",
    statusParallel: "{0} at once",
    statusPending: "{0} local changes waiting",
    statusBackground: "{0} background transfers",
    statusDownloading: "Downloading",
    statusUploading: "Uploading",
    statusAuthHint: "Not signed in. Sign in from the settings to sync.",
    statusOfflineHint: "No network connection. Retry once you are back online.",
    statusFailedHint: "An error occurred during sync. See the log for details.",
    statusTransferDetails: "Transfer details",
    statusOpenSettings: "Open settings",
    statusRetry: "Retry",
    statusSyncNow: "Sync now",
};

let activeDict: Record<string, string> = en;

/**
 * Initialize i18n by selecting the appropriate bundled language.
 * Must be called during plugin startup before any UI rendering.
 */
export function initI18n(): void {
    const lang = getLanguage() || "en";
    if (lang === "en") return;

    if (languages[lang]) {
        activeDict = languages[lang];
    }
}

/** Language code of the active UI dictionary ("en", "ja", ...). */
export function currentLanguage(): string {
    for (const [code, dict] of Object.entries(languages)) {
        if (dict === activeDict) return code;
    }
    return "en";
}

/** Text supplied by an installed add-on, per language. */
let addonStrings: ((lang: string) => Record<string, string>) | null = null;
let addonActive: Record<string, string> = {};
let addonEn: Record<string, string> = {};

/** Register (or with null, remove) the display text of the installed add-on. */
export function setAddonStrings(provider: ((lang: string) => Record<string, string>) | null): void {
    addonStrings = provider;
    try {
        addonEn = provider?.("en") ?? {};
        const lang = currentLanguage();
        addonActive = lang === "en" ? addonEn : (provider?.(lang) ?? {});
    } catch {
        addonEn = {};
        addonActive = {};
    }
}

/** True while an add-on supplies text. */
export function hasAddonStrings(): boolean {
    return addonStrings !== null;
}

export function t(key: string): string {
    return activeDict[key] || addonActive[key] || en[key] || addonEn[key] || key;
}
