// ==========================================================================
// Notification Visibility Matrix
// Source of truth: doc/spec/notification-case-matrix.md
//
// This table-driven approach replaces flag-based notification control
// (isSilent, isDetailed). The notify() function looks up visibility
// by (messageKey, currentTrigger, notificationLevel).
// ==========================================================================

/**
 * Sync trigger context — determines notification visibility.
 * Maps 1:1 to columns in notification-case-matrix.md.
 */
export type SyncTrigger =
    | "initial-sync" // 初回同期
    | "startup-sync" // 起動時同期
    | "manual-sync" // 手動同期
    | "timer-sync" // タイマー同期
    | "save-sync" // 保存時同期
    | "modify-sync" // 編集時同期
    | "layout-sync" // レイアウト変更時同期
    | "full-scan" // フルスキャン
    | "push-conflict" // Push時競合検出
    | "pull-conflict" // Pull時競合検出
    | "auth" // 認証
    | "migration" // 移行
    | "history-modal" // 履歴モーダル
    | "e2ee-modal"; // E2EEモーダル

type VisibilityMap = Partial<Record<SyncTrigger, boolean>>;

// --------------------------------------------------------------------------
// Verbose (すべて表示)
// --------------------------------------------------------------------------
const VERBOSE: Record<string, VisibilityMap> = {
    // ═══ Sync ═══
    noticeSyncing: {
        "initial-sync": true,
        "startup-sync": false,
        "manual-sync": true,
        "timer-sync": false,
        "save-sync": false,
        "modify-sync": false,
        "layout-sync": false,
        "full-scan": true,
    },
    noticeScanningLocalFiles: {
        "initial-sync": true,
        "startup-sync": false,
        "full-scan": true,
    },
    noticeWaitingForRemoteRegistration: {
        "initial-sync": true,
        // All other triggers: hide (confirmation only needed during initial sync)
        "startup-sync": false,
        "manual-sync": false,
        "timer-sync": false,
        "save-sync": false,
        "modify-sync": false,
        "layout-sync": false,
        "full-scan": false,
        "push-conflict": false,
        "pull-conflict": false,
    },
    noticeFilePulled: {
        "initial-sync": true,
        "startup-sync": true,
        "manual-sync": true,
        "timer-sync": true,
        "save-sync": true,
        "modify-sync": true,
        "layout-sync": true,
        "full-scan": true,
        "push-conflict": true,
        "pull-conflict": true,
    },
    noticePullCompleted: {
        "initial-sync": true,
        "startup-sync": true,
        "manual-sync": true,
        "timer-sync": true,
        "save-sync": true,
        "modify-sync": true,
        "layout-sync": true,
        "full-scan": true,
    },
    noticeFilePushed: {
        "initial-sync": true,
        "startup-sync": true,
        "manual-sync": true,
        "timer-sync": true,
        "save-sync": true,
        "modify-sync": true,
        "layout-sync": true,
        "full-scan": true,
        "push-conflict": true,
        "pull-conflict": true,
    },
    noticePushCompleted: {
        "initial-sync": true,
        "startup-sync": true,
        "manual-sync": true,
        "timer-sync": true,
        "save-sync": true,
        "modify-sync": true,
        "layout-sync": true,
        "full-scan": true,
    },
    noticeVaultUpToDate: {
        "initial-sync": true,
        "startup-sync": true,
        "manual-sync": true,
        "timer-sync": false,
        "save-sync": false,
        "modify-sync": false,
        "layout-sync": false,
        "full-scan": true,
    },
    noticeInitialSyncConfirmation: {
        "initial-sync": true,
        // All other triggers: hide (confirmation only needed during initial sync)
        "startup-sync": false,
        "manual-sync": false,
        "timer-sync": false,
        "save-sync": false,
        "modify-sync": false,
        "layout-sync": false,
        "full-scan": false,
        "push-conflict": false,
        "pull-conflict": false,
    },
    noticeSyncConfirmed: {
        "initial-sync": true,
        // All other triggers: hide (confirmation only needed during initial sync)
        "startup-sync": false,
        "manual-sync": false,
        "timer-sync": false,
        "save-sync": false,
        "modify-sync": false,
        "layout-sync": false,
        "full-scan": false,
        "push-conflict": false,
        "pull-conflict": false,
    },
    noticeFileTrashed: {
        "initial-sync": true,
        "startup-sync": true,
        "manual-sync": true,
        "timer-sync": true,
        "save-sync": true,
        "modify-sync": true,
        "layout-sync": true,
        "full-scan": true,
    },
    noticeFileRenamed: {
        "initial-sync": true,
        "startup-sync": true,
        "manual-sync": true,
        "timer-sync": true,
        "save-sync": true,
        "modify-sync": true,
        "layout-sync": true,
        "full-scan": true,
    },
    noticeFileMoved: {
        "initial-sync": true,
        "startup-sync": true,
        "manual-sync": true,
        "timer-sync": true,
        "save-sync": true,
        "modify-sync": true,
        "layout-sync": true,
        "full-scan": true,
    },

    // ═══ Conflict ═══
    noticeMergingFile: { "push-conflict": true, "pull-conflict": true },
    noticeMergeSuccess: { "push-conflict": true, "pull-conflict": true },
    noticeConflictSaved: { "push-conflict": true, "pull-conflict": true },
    noticeConflictRemoteSaved: { "push-conflict": true, "pull-conflict": true },
    noticeCheckOtherDevice: { "push-conflict": true, "pull-conflict": true },
    noticeWaitOtherDeviceMerge: { "push-conflict": true, "pull-conflict": true },
    noticeRemoteMergeSynced: { "push-conflict": true, "pull-conflict": true },

    // ═══ Sync Errors (shown for all sync triggers) ═══
    noticeSyncFailedAuth: {
        "initial-sync": true, "startup-sync": true, "manual-sync": true,
        "timer-sync": true, "save-sync": true, "modify-sync": true,
        "layout-sync": true, "full-scan": true,
    },
    noticeSyncFailedNetwork: {
        "initial-sync": true, "startup-sync": true, "manual-sync": true,
        "timer-sync": true, "save-sync": true, "modify-sync": true,
        "layout-sync": true, "full-scan": true,
    },
    noticeSyncFailed: {
        "initial-sync": true, "startup-sync": true, "manual-sync": true,
        "timer-sync": true, "save-sync": true, "modify-sync": true,
        "layout-sync": true, "full-scan": true,
    },

    // ═══ Auth ═══
    noticeAuthSuccess: { auth: true },
    noticeAuthFailed: { auth: true },

    // ═══ History Modal ═══
    noticeSavedKeepForever: { "history-modal": true },
    historyKeepForeverError: { "history-modal": true },
    noticeFileRestored: { "history-modal": true },
    noticeHistoryRestoreAs: { "history-modal": true },
    noticeRevisionDeleted: { "history-modal": true },
    // ═══ Migration ═══
    noticeMigrationStarted: { migration: true, "manual-sync": true },
    noticeMigrationComplete: { migration: true, "manual-sync": true },
    noticeMigrationFailed: { migration: true, "manual-sync": true },

    // ═══ E2EE ═══
    noticeVaultLocked: {
        "manual-sync": true,
        "full-scan": true,
        "initial-sync": true,
        "startup-sync": true,
        "timer-sync": true,
        "save-sync": true,
        "modify-sync": true,
        "layout-sync": true,
    },
    noticeE2EEAutoEnabled: {
        "startup-sync": true,
    },
    noticeEngineVerifyFailed: {
        "startup-sync": true,
    },
    e2eeUnlockSuccess: { "e2ee-modal": true },
    e2eeUnlockFailed: { "e2ee-modal": true },
    e2eeSetupKeychainFailed: { migration: true },
    e2eeInterruptedDone: { "manual-sync": true },
    noticeE2EEPasswordChanged: { "e2ee-modal": true },
    noticeE2EERecoveryComplete: { "e2ee-modal": true },
    noticeE2EEDecryptFailed: {
        "initial-sync": true,
        "startup-sync": true,
        "manual-sync": true,
        "timer-sync": true,
        "save-sync": true,
        "modify-sync": true,
        "layout-sync": true,
        "full-scan": true,
    },
};

// --------------------------------------------------------------------------
// Standard (標準)
// Identical to Verbose EXCEPT for per-file download/upload notifications
// which are hidden in most scenarios.
// --------------------------------------------------------------------------
const STANDARD: Record<string, VisibilityMap> = {
    ...VERBOSE,

    // Override: per-file download — show only for initial-sync and full-scan
    noticeFilePulled: {
        "initial-sync": true,
        "startup-sync": false,
        "manual-sync": false,
        "timer-sync": false,
        "save-sync": false,
        "modify-sync": false,
        "layout-sync": false,
        "full-scan": true,
        "push-conflict": false,
        "pull-conflict": false,
    },

    // Override: per-file upload — show only for initial-sync and full-scan
    noticeFilePushed: {
        "initial-sync": true,
        "startup-sync": false,
        "manual-sync": false,
        "timer-sync": false,
        "save-sync": false,
        "modify-sync": false,
        "layout-sync": false,
        "full-scan": true,
        "push-conflict": false,
        "pull-conflict": false,
    },
};

// --------------------------------------------------------------------------
// Public API
// --------------------------------------------------------------------------

/** Critical notifications shown even in "error" (minimal) notification level. */
const ALWAYS_SHOW = new Set([
    "noticeSyncFailedAuth",
    "noticeSyncFailedNetwork",
    "noticeSyncFailed",
]);

/**
 * Look up whether a notification should be shown.
 *
 * @param key       i18n message key (e.g. "noticeSyncing")
 * @param trigger   Current sync trigger context
 * @param level     User's notification level setting ("verbose" | "standard" | "error")
 * @returns true → show Notice, false → log only
 */
export function shouldShowNotification(
    key: string,
    trigger: SyncTrigger,
    level: "verbose" | "standard" | "error",
): boolean {
    // Critical error notifications bypass the "error" (minimal) level
    if (level === "error" && !ALWAYS_SHOW.has(key)) return false;

    const matrix = level === "error" ? VERBOSE : level === "verbose" ? VERBOSE : STANDARD;
    const entry = matrix[key];
    if (!entry) return true; // Unknown key → safe default: show

    const value = entry[trigger];
    return value !== false; // undefined ("-") → true (show)
}

/**
 * Triggers that should always show the activity indicator (ribbon icon spin)
 * from the start of the sync operation.
 * Other triggers only show the indicator when actual push/pull work begins.
 */
export const ALWAYS_SHOW_ACTIVITY = new Set<SyncTrigger>([
    "initial-sync",
    "startup-sync",
    "manual-sync",
    "full-scan",
]);

/**
 * Priority for trigger merging when sync requests queue up.
 * Higher number = louder trigger wins.
 */
export const TRIGGER_PRIORITY: Record<SyncTrigger, number> = {
    "manual-sync": 10,
    "initial-sync": 9,
    "full-scan": 8,
    "startup-sync": 7,
    "save-sync": 4,
    "modify-sync": 3,
    "layout-sync": 2,
    "timer-sync": 1,
    "push-conflict": 0,
    "pull-conflict": 0,
    auth: 0,
    migration: 11,
    "history-modal": 0,
    "e2ee-modal": 0,
};
