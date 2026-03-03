/**
 * @file 通知表示制御マトリックスの検証テスト
 *
 * @description
 * 通知レベル(verbose/standard/error)×同期トリガー種別のマトリックスに基づく
 * 通知の表示/非表示制御を検証する。MATRIX定数の網羅性、i18n辞書との整合性、
 * メッセージフォーマット、シナリオ別の禁止通知チェックを含む。
 *
 * @prerequisites
 * - SyncManager + MockCloudAdapter (通知パスを通すための実同期)
 * - 日本語i18n辞書 (ja.json)
 * - Notice コンストラクタのモック
 *
 * @pass_criteria
 * - MATRIX定数が全35通知キーを網羅していること
 * - 全MATRIXキーがi18n辞書(ja/en両方)に存在すること
 * - 各レベル×トリガーの組み合わせでShow/Hideが仕様通りであること
 * - errorレベルでは全通知が抑制されること
 * - i18n値がコロン":"で終わらないこと (ファイル名結合時の二重コロン防止)
 * - クリーン同期時に競合/認証/履歴系通知が発火しないこと
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { SyncManager, SyncManagerSettings, type SyncTrigger } from "../../../src/sync-manager";
import { MockApp, MockVaultOperations } from "../../helpers/mock-vault-adapter";
import { CloudAdapter } from "../../../src/types/adapter";
import { Notice } from "obsidian";
import { en } from "../../../src/i18n";
import ja from "../../../src/i18n/lang/ja.json";
const i18nDict = { en, ja: ja as Record<string, string> };
import { RevisionCache } from "../../../src/services/revision-cache";
import { BackgroundTransferQueue } from "../../../src/sync-manager/background-transfer";
import type { INotificationService } from "../../../src/services/notification-service";

// Mock obsidian
vi.mock("obsidian", () => ({
    Notice: vi.fn(),
    App: class {},
    TFile: class {
        path: string = "";
        name: string = "";
        mtime: number = 0;
        size: number = 0;
    },
    TFolder: class {},
    Platform: { isMobile: false },
    normalizePath: (path: string) => path,
}));

class MockCloudAdapter implements CloudAdapter {
    name = "MockAdapter";
    vaultName = "MockVault";
    clientId = "mock";
    clientSecret = "mock";
    isReady = async () => true;
    supportsChangesAPI = true;
    supportsHash = false;
    supportsHistory = false;
    initialize = async () => {};
    login = async () => {};
    logout = async () => {};
    isAuthenticated = () => true;
    getAuthUrl = async () => "http://localhost";
    handleCallback = async () => {};
    getTokens = () => ({ accessToken: "m", refreshToken: "m" });
    setTokens = () => {};
    setCredentials = () => {};
    updateConfig = () => {};
    getUserInfo = async () => ({ name: "User", email: "u@e.com" });
    getUsage = async () => ({ used: 0, total: 1000 });
    listFiles = async () => [];
    uploadFile = async (p: string, c: ArrayBuffer) => ({
        id: "m-id",
        name: "m",
        mtime: Date.now(),
        size: c.byteLength,
        path: p,
        kind: "file" as const,
        hash: "m-hash",
    });
    downloadFile = async (id: string) => new TextEncoder().encode("{}").buffer;
    deleteFile = async (id: string) => {};
    moveFile = async (fileId: string, newName: string, newParentPath: string | null) => ({
        id: fileId,
        name: newName,
        mtime: Date.now(),
        size: 0,
        path: newParentPath ? `${newParentPath}/${newName}` : newName,
        kind: "file" as const,
        hash: "m-hash",
    });
    getFileMetadata = async (p: string) =>
        p.includes("idx.json") ? ({ id: "idx", mtime: 200, hash: "h1", size: 100 } as any) : null;
    createFolder = async (n: string, p?: string) => "folder-id";
    getChanges = async (t?: string) => ({ changes: [] as any[] });
    acknowledgeChanges = async (t: string) => {};
    trashFile = async (p: string) => true;
    getRevisions = async (p: string) => [];
    getFileMetadataById = async (id: string) => null;
    ensureFoldersExist = async (f: string[], onP?: any) => {};
    fileExistsById = async (id: string) => true;
    getStartPageToken = async () => "token";
    setLogger = () => {};
    onAuthFailure = () => {};
    reset = () => {};
    getAppRootId = async () => "mock-root";
    cloneWithNewVaultName = () => this as CloudAdapter;
}

const DEFAULT_SETTINGS: SyncManagerSettings = {
    concurrency: 1,
    notificationLevel: "standard",
    conflictResolutionStrategy: "smart-merge",
    enableLogging: false,
    isDeveloperMode: false,
    exclusionPatterns: "",
    largeFileThresholdMB: 0,
    bgTransferIntervalSec: 0,
    syncAppearance: true,
    syncCommunityPlugins: true,
    syncCoreConfig: true,
    syncImagesAndMedia: true,
    syncDotfiles: true,
    syncPluginSettings: true,
    syncFlexibleData: true,
    syncDeviceLogs: true,
    syncWorkspace: true,

    hasCompletedFirstSync: false,
    e2eeEnabled: false,
};

// ════════════════════════════════════════════════════════════════
// Notification Visibility Matrix
// Maps directly to: doc/notification-case-matrix.md
//
// Test approach: Set currentTrigger on SyncManager, then call
// notify(key). The matrix lookup in notify() determines visibility
// using (key, currentTrigger, notificationLevel).
// This validates every cell in the matrix document.
// ════════════════════════════════════════════════════════════════

type Exp = "Show" | "Hide";

/**
 * Scenario → SyncTrigger mapping.
 * Each test scenario maps to exactly one SyncTrigger value.
 */
const SCENARIO_TRIGGERS: Record<string, SyncTrigger> = {
    initialSync: "initial-sync",
    startupSync: "startup-sync",
    manualSync: "manual-sync",
    timerSync: "timer-sync",
    saveSync: "save-sync",
    modifySync: "modify-sync",
    layoutSync: "layout-sync",
    fullScan: "full-scan",
    pushConflict: "push-conflict",
    pullConflict: "pull-conflict",
    auth: "auth",
    historyModal: "history-modal",
};

interface MatrixEntry {
    /** i18n key for the notification */
    key: string;
    /** Expected visibility per scenario. Omit or set undefined for "-" (no care / not applicable) */
    scenarios: Record<string, { v?: Exp; s?: Exp }>;
}

/**
 * Complete notification matrix from doc/notification-case-matrix.md
 * 25 entries covering all notification types
 */
const MATRIX: MatrixEntry[] = [
    // ═══ Sync Notifications ═══
    {
        // ⚡ 同期: 処理開始...
        key: "noticeSyncing",
        scenarios: {
            initialSync: { v: "Show", s: "Show" },
            startupSync: { v: "Hide", s: "Hide" },
            manualSync: { v: "Show", s: "Show" },
            timerSync: { v: "Hide", s: "Hide" },
            saveSync: { v: "Hide", s: "Hide" },
            modifySync: { v: "Hide", s: "Hide" },
            layoutSync: { v: "Hide", s: "Hide" },
            fullScan: { v: "Show", s: "Show" },
        },
    },
    {
        // 🔍️ 同期: ローカルファイルを走査中...
        key: "noticeScanningLocalFiles",
        scenarios: {
            initialSync: { v: "Show", s: "Show" },
            startupSync: { v: "Hide", s: "Hide" },
            fullScan: { v: "Show", s: "Show" },
        },
    },
    {
        // 💤 同期: リモート側の反映完了を待機中...
        key: "noticeWaitingForRemoteRegistration",
        scenarios: {
            initialSync: { v: "Show", s: "Show" },
            startupSync: { v: "Hide", s: "Hide" },
            manualSync: { v: "Hide", s: "Hide" },
            timerSync: { v: "Hide", s: "Hide" },
            saveSync: { v: "Hide", s: "Hide" },
            modifySync: { v: "Hide", s: "Hide" },
            layoutSync: { v: "Hide", s: "Hide" },
            fullScan: { v: "Hide", s: "Hide" },
            pushConflict: { v: "Hide", s: "Hide" },
            pullConflict: { v: "Hide", s: "Hide" },
        },
    },
    {
        // 📥 同期: ダウンロード中 {file}
        key: "noticeFilePulled",
        scenarios: {
            initialSync: { v: "Show", s: "Show" },
            startupSync: { v: "Show", s: "Hide" },
            manualSync: { v: "Show", s: "Hide" },
            timerSync: { v: "Show", s: "Hide" },
            saveSync: { v: "Show", s: "Hide" },
            modifySync: { v: "Show", s: "Hide" },
            layoutSync: { v: "Show", s: "Hide" },
            fullScan: { v: "Show", s: "Show" },
            pushConflict: { v: "Show", s: "Hide" },
            pullConflict: { v: "Show", s: "Hide" },
        },
    },
    {
        // ✅ 同期: ダウンロード完了 (x files)
        key: "noticePullCompleted",
        scenarios: {
            initialSync: { v: "Show", s: "Show" },
            startupSync: { v: "Show", s: "Show" },
            manualSync: { v: "Show", s: "Show" },
            timerSync: { v: "Show", s: "Show" },
            saveSync: { v: "Show", s: "Show" },
            modifySync: { v: "Show", s: "Show" },
            layoutSync: { v: "Show", s: "Show" },
            fullScan: { v: "Show", s: "Show" },
            pushConflict: { v: "Show", s: "Show" },
            pullConflict: { v: "Show", s: "Show" },
        },
    },
    {
        // 📤 同期: アップロード中 {file}
        key: "noticeFilePushed",
        scenarios: {
            initialSync: { v: "Show", s: "Show" },
            startupSync: { v: "Show", s: "Hide" },
            manualSync: { v: "Show", s: "Hide" },
            timerSync: { v: "Show", s: "Hide" },
            saveSync: { v: "Show", s: "Hide" },
            modifySync: { v: "Show", s: "Hide" },
            layoutSync: { v: "Show", s: "Hide" },
            fullScan: { v: "Show", s: "Show" },
            pushConflict: { v: "Show", s: "Hide" },
            pullConflict: { v: "Show", s: "Hide" },
        },
    },
    {
        // ✅ 同期: アップロード完了 (x files)
        key: "noticePushCompleted",
        scenarios: {
            initialSync: { v: "Show", s: "Show" },
            startupSync: { v: "Show", s: "Show" },
            manualSync: { v: "Show", s: "Show" },
            timerSync: { v: "Show", s: "Show" },
            saveSync: { v: "Show", s: "Show" },
            modifySync: { v: "Show", s: "Show" },
            layoutSync: { v: "Show", s: "Show" },
            fullScan: { v: "Show", s: "Show" },
            pushConflict: { v: "Show", s: "Show" },
        },
    },
    {
        // ✅ 同期: すべて最新の状態です
        key: "noticeVaultUpToDate",
        scenarios: {
            initialSync: { v: "Show", s: "Show" },
            startupSync: { v: "Show", s: "Show" },
            manualSync: { v: "Show", s: "Show" },
            timerSync: { v: "Hide", s: "Hide" },
            saveSync: { v: "Hide", s: "Hide" },
            modifySync: { v: "Hide", s: "Hide" },
            layoutSync: { v: "Hide", s: "Hide" },
            fullScan: { v: "Show", s: "Show" },
        },
    },
    {
        // 📝 同期: 正常にアップロード出来たか確認中...
        key: "noticeInitialSyncConfirmation",
        scenarios: {
            initialSync: { v: "Show", s: "Show" },
            startupSync: { v: "Hide", s: "Hide" },
            manualSync: { v: "Hide", s: "Hide" },
            timerSync: { v: "Hide", s: "Hide" },
            saveSync: { v: "Hide", s: "Hide" },
            modifySync: { v: "Hide", s: "Hide" },
            layoutSync: { v: "Hide", s: "Hide" },
            fullScan: { v: "Hide", s: "Hide" },
            pushConflict: { v: "Hide", s: "Hide" },
            pullConflict: { v: "Hide", s: "Hide" },
        },
    },
    {
        // ✅ 同期: 成功 {file}
        key: "noticeSyncConfirmed",
        scenarios: {
            initialSync: { v: "Show", s: "Show" },
            startupSync: { v: "Hide", s: "Hide" },
            manualSync: { v: "Hide", s: "Hide" },
            timerSync: { v: "Hide", s: "Hide" },
            saveSync: { v: "Hide", s: "Hide" },
            modifySync: { v: "Hide", s: "Hide" },
            layoutSync: { v: "Hide", s: "Hide" },
            fullScan: { v: "Hide", s: "Hide" },
            pushConflict: { v: "Hide", s: "Hide" },
            pullConflict: { v: "Hide", s: "Hide" },
        },
    },
    {
        // 🗑️ 同期: 削除 {file}
        key: "noticeFileTrashed",
        scenarios: {
            initialSync: { v: "Show", s: "Show" },
            startupSync: { v: "Show", s: "Show" },
            manualSync: { v: "Show", s: "Show" },
            timerSync: { v: "Show", s: "Show" },
            saveSync: { v: "Show", s: "Show" },
            modifySync: { v: "Show", s: "Show" },
            layoutSync: { v: "Show", s: "Show" },
            fullScan: { v: "Show", s: "Show" },
            pushConflict: { v: "Show", s: "Show" },
            pullConflict: { v: "Show", s: "Show" },
        },
    },
    {
        // ✏️ 同期: リネーム {file}
        key: "noticeFileRenamed",
        scenarios: {
            initialSync: { v: "Show", s: "Show" },
            startupSync: { v: "Show", s: "Show" },
            manualSync: { v: "Show", s: "Show" },
            timerSync: { v: "Show", s: "Show" },
            saveSync: { v: "Show", s: "Show" },
            modifySync: { v: "Show", s: "Show" },
            layoutSync: { v: "Show", s: "Show" },
            fullScan: { v: "Show", s: "Show" },
            pushConflict: { v: "Show", s: "Show" },
            pullConflict: { v: "Show", s: "Show" },
        },
    },
    {
        // 📂 同期: 移動 {file}
        key: "noticeFileMoved",
        scenarios: {
            initialSync: { v: "Show", s: "Show" },
            startupSync: { v: "Show", s: "Show" },
            manualSync: { v: "Show", s: "Show" },
            timerSync: { v: "Show", s: "Show" },
            saveSync: { v: "Show", s: "Show" },
            modifySync: { v: "Show", s: "Show" },
            layoutSync: { v: "Show", s: "Show" },
            fullScan: { v: "Show", s: "Show" },
            pushConflict: { v: "Show", s: "Show" },
            pullConflict: { v: "Show", s: "Show" },
        },
    },

    // ═══ Conflict Notifications ═══
    {
        // 📝 競合: マージ中: {file}
        key: "noticeMergingFile",
        scenarios: {
            initialSync: { v: "Show", s: "Show" },
            startupSync: { v: "Show", s: "Show" },
            manualSync: { v: "Show", s: "Show" },
            timerSync: { v: "Show", s: "Show" },
            saveSync: { v: "Show", s: "Show" },
            modifySync: { v: "Show", s: "Show" },
            layoutSync: { v: "Show", s: "Show" },
            fullScan: { v: "Show", s: "Show" },
            pushConflict: { v: "Show", s: "Show" },
            pullConflict: { v: "Show", s: "Show" },
        },
    },
    {
        // ✅ 競合: 自動解決されました: {file}
        key: "noticeMergeSuccess",
        scenarios: {
            initialSync: { v: "Show", s: "Show" },
            startupSync: { v: "Show", s: "Show" },
            manualSync: { v: "Show", s: "Show" },
            timerSync: { v: "Show", s: "Show" },
            saveSync: { v: "Show", s: "Show" },
            modifySync: { v: "Show", s: "Show" },
            layoutSync: { v: "Show", s: "Show" },
            fullScan: { v: "Show", s: "Show" },
            pushConflict: { v: "Show", s: "Show" },
            pullConflict: { v: "Show", s: "Show" },
        },
    },
    {
        // ⚠️ 競合: ローカル版を保護し、リモート版を反映しました: {file}
        key: "noticeConflictSaved",
        scenarios: {
            pushConflict: { v: "Show", s: "Show" },
            pullConflict: { v: "Show", s: "Show" },
        },
    },
    {
        // ⚠️ 競合: リモート版を保護し、ローカル版を反映しました: {file}
        key: "noticeConflictRemoteSaved",
        scenarios: {
            pushConflict: { v: "Show", s: "Show" },
            pullConflict: { v: "Show", s: "Show" },
        },
    },
    {
        // ⚠️ 競合: マージに失敗した可能性が有ります。詳細は他デバイスを確認してください
        key: "noticeCheckOtherDevice",
        scenarios: {
            pushConflict: { v: "Show", s: "Show" },
            pullConflict: { v: "Show", s: "Show" },
        },
    },
    {
        // 💤 競合: 他デバイスが解決するのを待機しています...: {file}
        key: "noticeWaitOtherDeviceMerge",
        scenarios: {
            pushConflict: { v: "Show", s: "Show" },
            pullConflict: { v: "Show", s: "Show" },
        },
    },
    {
        // ⚠️ 競合: マージロックが失効しました: {file}
        key: "noticeMergeLockLost",
        scenarios: {
            pushConflict: { v: "Show", s: "Show" },
            pullConflict: { v: "Show", s: "Show" },
        },
    },
    {
        // ✅ 競合: 他デバイスの解決結果を反映しました: {file}
        key: "noticeRemoteMergeSynced",
        scenarios: {
            pushConflict: { v: "Show", s: "Show" },
            pullConflict: { v: "Show", s: "Show" },
        },
    },

    // ═══ Auth Notifications ═══
    {
        // ✅ 認証: 成功！
        key: "noticeAuthSuccess",
        scenarios: {
            auth: { v: "Show", s: "Show" },
        },
    },
    {
        // ❌ 認証: 失敗
        key: "noticeAuthFailed",
        scenarios: {
            auth: { v: "Show", s: "Show" },
        },
    },

    // ═══ History Modal Notifications ═══
    {
        // ✅ 履歴: 無期限保護設定完了
        key: "noticeSavedKeepForever",
        scenarios: {
            historyModal: { v: "Show", s: "Show" },
        },
    },
    {
        // ❌ 履歴: クラウド側の仕様により、無期限保存設定を解除することはできません。
        key: "historyKeepForeverError",
        scenarios: {
            historyModal: { v: "Show", s: "Show" },
        },
    },
    {
        // 📝 履歴: ファイルを復元しました。同期を開始します...
        key: "noticeFileRestored",
        scenarios: {
            historyModal: { v: "Show", s: "Show" },
        },
    },
    {
        // ✅ 履歴: ファイルを別名で復元しました: {file}
        key: "noticeHistoryRestoreAs",
        scenarios: {
            historyModal: { v: "Show", s: "Show" },
        },
    },
    {
        // 🗑️ 履歴: リビジョンを削除しました
        key: "noticeRevisionDeleted",
        scenarios: {
            historyModal: { v: "Show", s: "Show" },
        },
    },

    // ═══ Migration Notifications ═══
    {
        key: "noticeMigrationStarted",
        scenarios: {
            manualSync: { v: "Show", s: "Show" },
        },
    },
    {
        key: "noticeMigrationComplete",
        scenarios: {
            manualSync: { v: "Show", s: "Show" },
        },
    },
    {
        key: "noticeMigrationFailed",
        scenarios: {
            manualSync: { v: "Show", s: "Show" },
        },
    },

    // ═══ E2EE Notifications ═══
    {
        // 🔒 E2EE: Vaultがロック中
        key: "noticeVaultLocked",
        scenarios: {
            initialSync: { v: "Show", s: "Show" },
            startupSync: { v: "Show", s: "Show" },
            manualSync: { v: "Show", s: "Show" },
            timerSync: { v: "Show", s: "Show" },
            saveSync: { v: "Show", s: "Show" },
            modifySync: { v: "Show", s: "Show" },
            layoutSync: { v: "Show", s: "Show" },
            fullScan: { v: "Show", s: "Show" },
        },
    },
    {
        // 🔒 E2EE: 暗号化検出
        key: "noticeE2EEAutoEnabled",
        scenarios: {
            startupSync: { v: "Show", s: "Show" },
        },
    },
    {
        // ❌ E2EE: エンジン検証失敗
        key: "noticeEngineVerifyFailed",
        scenarios: {
            startupSync: { v: "Show", s: "Show" },
        },
    },
    {
        // ロック解除成功
        key: "e2eeUnlockSuccess",
        scenarios: {
            manualSync: { v: "Show", s: "Show" },
        },
    },
    {
        // パスワード誤り
        key: "e2eeUnlockFailed",
        scenarios: {
            manualSync: { v: "Show", s: "Show" },
        },
    },
    {
        // SecretStorage保存失敗
        key: "e2eeSetupKeychainFailed",
        scenarios: {},
    },
    {
        // 中断復旧完了
        key: "e2eeInterruptedDone",
        scenarios: {
            manualSync: { v: "Show", s: "Show" },
        },
    },
];

// ════════════════════════════════════════════════════════════════
// Message Format Specification
// Maps i18n keys to the EXACT format string from the specification.
// Tests verify that production code constructs messages matching
// these patterns, not just containing the i18n key text.
//
// Format: { key, specFormat }
//   specFormat uses "{file}" as placeholder for filename
//   null means no filename appended (standalone message)
// ════════════════════════════════════════════════════════════════

interface FormatSpec {
    key: string;
    /** Expected format from specification. null = no {file} placeholder */
    specJa: string;
}

/**
 * Notification format specifications from doc/spec/notification-case-matrix.md
 * These define the EXACT user-visible text including filename placement.
 */
const FORMAT_SPECS: FormatSpec[] = [
    { key: "noticeSyncing", specJa: "⚡ [同期] 処理開始..." },
    { key: "noticeScanningLocalFiles", specJa: "🔍️ [同期] ローカルファイルを走査中..." },
    {
        key: "noticeWaitingForRemoteRegistration",
        specJa: "⌛️ [同期] リモート側の反映完了を待機中...",
    },
    { key: "noticeFilePulled", specJa: "📥 [同期] ダウンロード中: {file}" },
    { key: "noticePullCompleted", specJa: "✅ [同期] ダウンロード完了 ({0} files)" },
    { key: "noticeFilePushed", specJa: "📤 [同期] アップロード中: {file}" },
    { key: "noticePushCompleted", specJa: "✅ [同期] アップロード完了 ({0} files)" },
    { key: "noticeVaultUpToDate", specJa: "✅ [同期] すべて最新の状態です" },
    {
        key: "noticeInitialSyncConfirmation",
        specJa: "📝 [同期] 正常にアップロード出来たか確認中...",
    },
    { key: "noticeSyncConfirmed", specJa: "✅ [同期] 成功: {file}" },
    { key: "noticeFileTrashed", specJa: "🗑️ [同期] 削除: {file}" },
    { key: "noticeFileRenamed", specJa: "✏️ [同期] リネーム: {file}" },
    { key: "noticeMergingFile", specJa: "⌛️ [競合] マージ中: {file}" },
    { key: "noticeMergeSuccess", specJa: "✅ [競合] 自動解決されました: {file}" },
    {
        key: "noticeConflictSaved",
        specJa: "⚠️ [競合] ローカル版を保護し、リモート版を反映しました: {file}",
    },
    {
        key: "noticeConflictRemoteSaved",
        specJa: "⚠️ [競合] リモート版を保護し、ローカル版を反映しました: {file}",
    },
    {
        key: "noticeCheckOtherDevice",
        specJa: "⚠️ [競合] マージに失敗した可能性が有ります。詳細は他デバイスを確認してください",
    },
    {
        key: "noticeMergeLockLost",
        specJa: "⚠️ [競合] マージロックが失効しました。ローカルに保存済み、次回同期でプッシュします。: {file}",
    },
    {
        key: "noticeWaitOtherDeviceMerge",
        specJa: "⌛️ [競合] 他デバイスが解決するのを待機しています...: {0}",
    },
    {
        key: "noticeRemoteMergeSynced",
        specJa: "✅ [競合] 他デバイスの解決結果を反映しました: {file}",
    },
    // ═══ Auth Notifications ═══
    { key: "noticeAuthSuccess", specJa: "✅ [認証] 成功！" },
    { key: "noticeAuthFailed", specJa: "❌ [認証] 失敗" },
    // ═══ History Notifications ═══
    { key: "noticeSavedKeepForever", specJa: "✅ [履歴] 無期限保護設定完了" },
    {
        key: "historyKeepForeverError",
        specJa: "❌ [履歴] クラウド側の仕様により、無期限保存設定を解除することはできません。",
    },
    { key: "noticeFileRestored", specJa: "💾 [履歴] ファイルを復元しました" },
    { key: "noticeHistoryRestoreAs", specJa: "💾 [履歴] 別名で復元しました: {0}" },
    { key: "noticeRevisionDeleted", specJa: "🗑️ [履歴] リビジョンを削除しました" },
    // ═══ Migration Notifications ═══
    {
        key: "noticeMigrationStarted",
        specJa: "🚀 [E2EE] 移行を開始しました。Obsidianを閉じないでください。",
    },
    { key: "noticeMigrationComplete", specJa: "✅ [E2EE] 移行完了！Vaultが暗号化されました。" },
    { key: "noticeMigrationFailed", specJa: "❌ [E2EE] 移行失敗。ログを確認してください。" },
    // ═══ E2EE Notifications ═══
    {
        key: "noticeVaultLocked",
        specJa: "🔒 [E2EE] Vaultがロック中のため同期を一時停止しています。コマンドパレットから「E2EE: ロック解除」を実行してください。",
    },
    {
        key: "noticeE2EEAutoEnabled",
        specJa: "🔒 [E2EE] このVaultは他デバイスで暗号化されています。パスワードを入力してロックを解除してください。",
    },
    {
        key: "noticeEngineVerifyFailed",
        specJa: "❌ [E2EE] エンジンの検証に失敗しました。プラグインを再インストールしてください。",
    },
    { key: "e2eeUnlockSuccess", specJa: "ロック解除しました！" },
    { key: "e2eeUnlockFailed", specJa: "パスワードが正しくありません。" },
    {
        key: "e2eeSetupKeychainFailed",
        specJa: "警告: SecretStorageへのパスワード保存に失敗しました。\n次回起動時にパスワードの再入力が必要です。",
    },
    {
        key: "e2eeInterruptedDone",
        specJa: "クリーンアップ完了。このモーダルを再度開いてください。",
    },
];

// ════════════════════════════════════════════════════════════════
// Tests
// ════════════════════════════════════════════════════════════════

/** MATRIX定数が全通知キーを網羅していることの検証 + レベル×トリガー×通知キーの全組み合わせテスト */
describe("Notification Visibility Matrix", () => {
    let app: MockApp;
    let adapter: MockCloudAdapter;
    let syncManager: SyncManager;

    beforeEach(async () => {
        vi.clearAllMocks();
        app = new MockApp();
        adapter = new MockCloudAdapter();
        const vaultOps = new MockVaultOperations(app.vaultAdapter, app.vault);
        const notifier: INotificationService = {
            show: (msg) => {
                new Notice(msg);
            },
        };
        syncManager = new SyncManager(
            vaultOps,
            adapter,
            "idx.json",
            { ...DEFAULT_SETTINGS },
            "dir",
            (key) => i18nDict.ja[key] || key,
            notifier,
            new RevisionCache(vaultOps, "dir"),
            new BackgroundTransferQueue(),
        );
        vi.spyOn(syncManager as any, "log").mockImplementation(async () => {});
    });

    // Completeness check: MATRIX covers all 25 notification types from the document
    it("MATRIX covers all expected notification keys", () => {
        const matrixKeys = new Set(MATRIX.map((e) => e.key));
        const expectedKeys = [
            // Sync
            "noticeSyncing",
            "noticeScanningLocalFiles",
            "noticeWaitingForRemoteRegistration",
            "noticeFilePulled",
            "noticePullCompleted",
            "noticeFilePushed",
            "noticePushCompleted",
            "noticeVaultUpToDate",
            "noticeInitialSyncConfirmation",
            "noticeSyncConfirmed",
            "noticeFileTrashed",
            "noticeFileRenamed",
            "noticeFileMoved",
            // Conflict
            "noticeMergingFile",
            "noticeMergeSuccess",
            "noticeConflictSaved",
            "noticeConflictRemoteSaved",
            "noticeCheckOtherDevice",
            "noticeMergeLockLost",
            "noticeWaitOtherDeviceMerge",
            "noticeRemoteMergeSynced",
            // Auth
            "noticeAuthSuccess",
            "noticeAuthFailed",
            // History
            "noticeSavedKeepForever",
            "historyKeepForeverError",
            "noticeFileRestored",
            "noticeHistoryRestoreAs",
            "noticeRevisionDeleted",
            // Migration
            "noticeMigrationStarted",
            "noticeMigrationComplete",
            "noticeMigrationFailed",
            // E2EE
            "noticeVaultLocked",
            "noticeE2EEAutoEnabled",
            "noticeEngineVerifyFailed",
            "e2eeUnlockSuccess",
            "e2eeUnlockFailed",
            "e2eeSetupKeychainFailed",
            "e2eeInterruptedDone",
        ];
        for (const key of expectedKeys) {
            expect(matrixKeys.has(key), `Missing MATRIX entry for: ${key}`).toBe(true);
        }
        expect(MATRIX.length).toBe(expectedKeys.length);
    });

    // Verify all i18n keys used in MATRIX exist in the Japanese dictionary
    it("all MATRIX keys exist in i18n.ja", () => {
        for (const entry of MATRIX) {
            expect(i18nDict.ja[entry.key], `i18n.ja missing key: ${entry.key}`).toBeDefined();
        }
    });

    // Matrix-driven visibility tests
    // For each notification key × scenario × level, set currentTrigger and call notify(key).
    // Verify Notice is shown/hidden according to the matrix.
    (["verbose", "standard"] as const).forEach((level) => {
        describe(`Level: ${level}`, () => {
            MATRIX.forEach((entry) => {
                Object.entries(entry.scenarios).forEach(([scenario, expectations]) => {
                    const expected = level === "verbose" ? expectations.v : expectations.s;
                    if (!expected) return; // "-" (no care) → skip

                    it(`[${scenario}] ${entry.key} → ${expected}`, async () => {
                        syncManager["settings"].notificationLevel = level;
                        syncManager.currentTrigger = SCENARIO_TRIGGERS[scenario];

                        (Notice as any).mockClear();
                        await syncManager.notify(entry.key);

                        const calls = (Notice as any).mock.calls;
                        if (expected === "Show") {
                            expect(
                                calls.length,
                                `Expected ${entry.key} to be SHOWN in ${level}/${scenario}`,
                            ).toBeGreaterThan(0);
                        } else {
                            expect(
                                calls.length,
                                `Expected ${entry.key} to be HIDDEN in ${level}/${scenario}`,
                            ).toBe(0);
                        }
                    });
                });
            });
        });
    });

    /** errorレベルでの全通知抑制 */
    describe("Level: error", () => {
        it("suppresses all notifications regardless of trigger", async () => {
            syncManager["settings"].notificationLevel = "error" as any;
            syncManager.currentTrigger = "manual-sync";

            for (const entry of MATRIX) {
                (Notice as any).mockClear();
                await syncManager.notify(entry.key);
                expect(
                    (Notice as any).mock.calls.length,
                    `${entry.key} should be suppressed at error level`,
                ).toBe(0);
            }
        });

        it("shows critical error notifications (ALWAYS_SHOW) even at error level", async () => {
            syncManager["settings"].notificationLevel = "error" as any;
            syncManager.currentTrigger = "manual-sync";

            const alwaysShowKeys = [
                "noticeSyncFailedAuth",
                "noticeSyncFailedNetwork",
                "noticeSyncFailed",
            ];

            for (const key of alwaysShowKeys) {
                (Notice as any).mockClear();
                await syncManager.notify(key);
                expect(
                    (Notice as any).mock.calls.length,
                    `${key} should be shown at error level (ALWAYS_SHOW)`,
                ).toBeGreaterThan(0);
            }
        });

        it("shows unknown keys at verbose/standard level (safe default)", async () => {
            // Unknown keys should show as safe default (line 319 coverage)
            // This only applies to non-error levels since error level returns false early
            syncManager["settings"].notificationLevel = "verbose";
            syncManager.currentTrigger = "manual-sync";

            (Notice as any).mockClear();
            await syncManager.notify("unknownNotificationKey");
            expect((Notice as any).mock.calls.length).toBeGreaterThan(0);
        });
    });
});

// ════════════════════════════════════════════════════════════════
// Message Format Validation Tests
//
// The MATRIX tests validate notify() filtering (Show/Hide), but they
// do NOT validate the actual message strings that production code passes.
// These tests verify that:
//   1. i18n values don't have trailing colons that would cause "text:: file"
//   2. The combined format "i18n_text: filename" matches the specification
//   3. No unexpected prefixes are added (e.g. "⏳ file: message")
//   4. i18n keys exist in both en and ja dictionaries
// ════════════════════════════════════════════════════════════════

/** i18nフォーマットの正確性 (コロン末尾禁止、結合形式) */
describe("Notification Message Format Validation", () => {
    // Verify i18n values don't end with ":" (code adds ": filename" separately)
    describe("i18n values must NOT end with colon (code appends `: filename`)", () => {
        const keysWithFilename = [
            "noticeMergingFile",
            "noticeMergeSuccess",
            "noticeMergeLockLost",
            "noticeRemoteMergeSynced",
            "noticeConflictSaved",
            "noticeConflictRemoteSaved",
            "noticeFilePulled",
            "noticeFilePushed",
            "noticeFileTrashed",
            "noticeFileRenamed",
            "noticeSyncConfirmed",
        ];

        for (const key of keysWithFilename) {
            it(`[ja] ${key} must not end with ":"`, () => {
                const value = i18nDict.ja[key];
                expect(value, `i18n.ja missing key: ${key}`).toBeDefined();
                expect(
                    value.endsWith(":"),
                    `i18n.ja["${key}"] = "${value}" ends with ":" → would cause "text:: file"`,
                ).toBe(false);
            });

            it(`[en] ${key} must not end with ":"`, () => {
                const value = i18nDict.en[key];
                expect(value, `i18n.en missing key: ${key}`).toBeDefined();
                expect(
                    value.endsWith(":"),
                    `i18n.en["${key}"] = "${value}" ends with ":" → would cause "text:: file"`,
                ).toBe(false);
            });
        }
    });

    // Verify the combined message format matches specification
    describe("combined message format matches specification", () => {
        const testFile = "demo.md";

        for (const spec of FORMAT_SPECS) {
            it(`${spec.key} format matches spec`, () => {
                const i18nValue = i18nDict.ja[spec.key];
                expect(i18nValue, `i18n.ja missing key: ${spec.key}`).toBeDefined();

                if (spec.specJa.includes("{file}")) {
                    // Messages with filename: verify "i18n_text: filename" pattern
                    const expectedMsg = spec.specJa.replace("{file}", testFile);
                    const actualMsg = `${i18nValue}: ${testFile}`;
                    expect(
                        actualMsg,
                        `Format mismatch for ${spec.key}.\n  Expected: "${expectedMsg}"\n  Actual:   "${actualMsg}"`,
                    ).toBe(expectedMsg);
                } else if (spec.specJa.includes("{0}")) {
                    // Messages with count placeholder
                    const expectedMsg = spec.specJa.replace("{0}", "3");
                    const actualMsg = i18nValue.replace("{0}", "3");
                    expect(actualMsg, `Format mismatch for ${spec.key}`).toBe(expectedMsg);
                } else {
                    // Standalone messages (no filename)
                    expect(
                        i18nValue,
                        `Format mismatch for ${spec.key}.\n  Expected: "${spec.specJa}"\n  Actual:   "${i18nValue}"`,
                    ).toBe(spec.specJa);
                }
            });
        }
    });

    // Verify all notification i18n keys exist in both dictionaries
    describe("i18n key consistency between en and ja", () => {
        const allNotificationKeys = MATRIX.map((e) => e.key);

        for (const key of allNotificationKeys) {
            it(`${key} exists in both en and ja`, () => {
                expect(i18nDict.en[key], `Missing in en: ${key}`).toBeDefined();
                expect(i18nDict.ja[key], `Missing in ja: ${key}`).toBeDefined();
            });
        }
    });
});

// ════════════════════════════════════════════════════════════════
// Integration Tests: Verify actual sync flow triggers correct notifications
//
// The MATRIX tests above validate notify() filtering logic in isolation.
// These integration tests run requestSmartSync and verify that:
//   1. Notifications that SHOULD appear are actually triggered
//   2. Notifications that should NOT appear are NOT triggered
//
// This catches bugs where code incorrectly calls notify() in wrong scenarios
// (e.g., noticeScanningLocalFiles during timerSync when scanVault=false)
// ════════════════════════════════════════════════════════════════

const SYNC_SCENARIOS: Record<
    string,
    { trigger: SyncTrigger; scanVault: boolean; isInitial?: boolean }
> = {
    manualSync: { trigger: "manual-sync", scanVault: false },
    timerSync: { trigger: "timer-sync", scanVault: false },
    saveSync: { trigger: "save-sync", scanVault: false },
    modifySync: { trigger: "modify-sync", scanVault: false },
    layoutSync: { trigger: "layout-sync", scanVault: false },
    startupSync: { trigger: "startup-sync", scanVault: true },
    fullScan: { trigger: "full-scan", scanVault: true },
    initialSync: { trigger: "initial-sync", scanVault: true, isInitial: true },
};

/**
 * Notifications that must NOT be triggered (notify() must not be called) per scenario.
 * Derived from matrix document "-" entries where the code path should not reach notify().
 *
 * This is distinct from "Hide" (notify is called but filtered out by level/trigger).
 * These are cases where notify() itself must never be invoked.
 */
const MUST_NOT_TRIGGER: Record<string, string[]> = {
    manualSync: [
        "noticeScanningLocalFiles", // scanVault=false → if(scanVault) branch not entered
        "noticeWaitingForRemoteRegistration", // only during initial sync confirmation
        "noticeInitialSyncConfirmation", // only during initial sync confirmation
        "noticeSyncConfirmed", // only during initial sync confirmation
    ],
    timerSync: [
        "noticeScanningLocalFiles", // scanVault=false
        "noticeWaitingForRemoteRegistration",
        "noticeInitialSyncConfirmation",
        "noticeSyncConfirmed",
    ],
    saveSync: [
        "noticeScanningLocalFiles", // scanVault=false
        "noticeWaitingForRemoteRegistration",
        "noticeInitialSyncConfirmation",
        "noticeSyncConfirmed",
    ],
    modifySync: [
        "noticeScanningLocalFiles", // scanVault=false
        "noticeWaitingForRemoteRegistration",
        "noticeInitialSyncConfirmation",
        "noticeSyncConfirmed",
    ],
    layoutSync: [
        "noticeScanningLocalFiles", // scanVault=false
        "noticeWaitingForRemoteRegistration",
        "noticeInitialSyncConfirmation",
        "noticeSyncConfirmed",
    ],
    startupSync: [
        "noticeWaitingForRemoteRegistration", // not initial sync
        "noticeInitialSyncConfirmation",
        "noticeSyncConfirmed",
    ],
    fullScan: [
        "noticeWaitingForRemoteRegistration",
        "noticeInitialSyncConfirmation",
        "noticeSyncConfirmed",
    ],
    initialSync: [], // All sync-related notifications are potentially reachable
};

/** Notifications that should never appear during any sync scenario (clean sync, no conflicts) */
const NEVER_DURING_CLEAN_SYNC: string[] = [
    // Conflict notifications: no conflicts in clean sync
    "noticeMergingFile",
    "noticeMergeSuccess",
    "noticeMergeLockLost",
    "noticeConflictSaved",
    "noticeConflictRemoteSaved",
    "noticeCheckOtherDevice",
    "noticeWaitOtherDeviceMerge",
    "noticeRemoteMergeSynced",
    // Auth: not triggered during sync
    "noticeAuthSuccess",
    "noticeAuthFailed",
    // History: not triggered during sync
    "noticeSavedKeepForever",
    "historyKeepForeverError",
    "noticeFileRestored",
    "noticeHistoryRestoreAs",
    "noticeRevisionDeleted",
    // Migration: not triggered during normal sync
    "noticeMigrationStarted",
    "noticeMigrationComplete",
    "noticeMigrationFailed",
    // E2EE: not triggered during clean sync (vault is unlocked)
    "noticeVaultLocked",
    "noticeE2EEAutoEnabled",
    "noticeEngineVerifyFailed",
    "e2eeUnlockSuccess",
    "e2eeUnlockFailed",
    "e2eeSetupKeychainFailed",
    "e2eeInterruptedDone",
];

/**
 * Notifications that must NOT appear as Notice (user-visible) per scenario in standard mode.
 * Combines "-" (code path unreachable) and "Hide" (filtered by matrix lookup).
 * Unlike MUST_NOT_TRIGGER (which checks notify() calls), this checks the actual
 * Notice constructor to verify end-to-end behavior: production code → notify() → Notice.
 */
const MUST_NOT_SHOW_NOTICE: Record<string, string[]> = {
    manualSync: [
        "noticeScanningLocalFiles", // "-": scanVault=false
        "noticeFilePulled", // "Hide": standard mode hides individual files
        "noticeFilePushed", // "Hide": standard mode hides individual files
        "noticeWaitingForRemoteRegistration", // "-": not initial sync
        "noticeInitialSyncConfirmation", // "-": not initial sync
        "noticeSyncConfirmed", // "-": not initial sync
    ],
    timerSync: [
        "noticeSyncing", // "Hide": silent background sync
        "noticeScanningLocalFiles", // "-": scanVault=false
        "noticeFilePulled", // "Hide": standard mode hides individual files
        "noticeFilePushed", // "Hide": standard mode hides individual files
        "noticeVaultUpToDate", // "Hide": silent background sync
        "noticeWaitingForRemoteRegistration", // "-": not initial sync
        "noticeInitialSyncConfirmation", // "-": not initial sync
        "noticeSyncConfirmed", // "-": not initial sync
    ],
    saveSync: [
        "noticeSyncing", // "Hide": silent background sync
        "noticeScanningLocalFiles", // "-": scanVault=false
        "noticeFilePulled", // "Hide": standard mode hides individual files
        "noticeFilePushed", // "Hide": standard mode hides individual files
        "noticeVaultUpToDate", // "Hide": silent background sync
        "noticeWaitingForRemoteRegistration", // "-": not initial sync
        "noticeInitialSyncConfirmation", // "-": not initial sync
        "noticeSyncConfirmed", // "-": not initial sync
    ],
    modifySync: [
        "noticeSyncing", // "Hide": silent background sync
        "noticeScanningLocalFiles", // "-": scanVault=false
        "noticeFilePulled", // "Hide": standard mode hides individual files
        "noticeFilePushed", // "Hide": standard mode hides individual files
        "noticeVaultUpToDate", // "Hide": silent background sync
        "noticeWaitingForRemoteRegistration", // "-": not initial sync
        "noticeInitialSyncConfirmation", // "-": not initial sync
        "noticeSyncConfirmed", // "-": not initial sync
    ],
    layoutSync: [
        "noticeSyncing", // "Hide": silent background sync
        "noticeScanningLocalFiles", // "-": scanVault=false
        "noticeFilePulled", // "Hide": standard mode hides individual files
        "noticeFilePushed", // "Hide": standard mode hides individual files
        "noticeVaultUpToDate", // "Hide": silent background sync
        "noticeWaitingForRemoteRegistration", // "-": not initial sync
        "noticeInitialSyncConfirmation", // "-": not initial sync
        "noticeSyncConfirmed", // "-": not initial sync
    ],
    startupSync: [
        "noticeSyncing", // "Hide": silent background sync
        "noticeScanningLocalFiles", // "Hide": startup sync
        "noticeFilePulled", // "Hide": standard mode hides individual files
        "noticeFilePushed", // "Hide": standard mode hides individual files
        "noticeWaitingForRemoteRegistration", // "-": not initial sync
        "noticeInitialSyncConfirmation", // "-": not initial sync
        "noticeSyncConfirmed", // "-": not initial sync
    ],
    fullScan: [
        "noticeWaitingForRemoteRegistration", // "-": not initial sync
        "noticeInitialSyncConfirmation", // "-": not initial sync
        "noticeSyncConfirmed", // "-": not initial sync
    ],
};

/** 実際の同期フロー内での通知発火/非発火の検証 */
describe("Integration: Sync scenarios trigger correct notifications", () => {
    let app: MockApp;
    let adapter: MockCloudAdapter;
    let syncManager: SyncManager;

    beforeEach(async () => {
        vi.clearAllMocks();
        app = new MockApp();
        adapter = new MockCloudAdapter();
        const vaultOps = new MockVaultOperations(app.vaultAdapter, app.vault);
        const notifier: INotificationService = {
            show: (msg) => {
                new Notice(msg);
            },
        };
        syncManager = new SyncManager(
            vaultOps,
            adapter,
            "idx.json",
            { ...DEFAULT_SETTINGS },
            "dir",
            (key) => i18nDict.ja[key] || key,
            notifier,
            new RevisionCache(vaultOps, "dir"),
            new BackgroundTransferQueue(),
        );
        vi.spyOn(syncManager as any, "log").mockImplementation(async () => {});
        // Mock internal sync methods to make sync complete cleanly (no changes)
        vi.spyOn(syncManager as any, "smartPull").mockResolvedValue(false);
        vi.spyOn(syncManager as any, "smartPush").mockResolvedValue(false);
    });

    /** Helper: check if any notify() call used the given i18n key */
    const wasNotifyCalledWith = (notifySpy: ReturnType<typeof vi.spyOn>, key: string): boolean => {
        return notifySpy.mock.calls.some(([k]: [unknown]) => k === key);
    };

    /** Helper: check if Notice constructor was called with a message containing the i18n text */
    const wasNoticeShown = (key: string): boolean => {
        const msg = i18nDict.ja[key];
        if (!msg) return false;
        return (Notice as any).mock.calls.some(
            ([m]: [unknown]) => typeof m === "string" && m.includes(msg),
        );
    };

    Object.entries(SYNC_SCENARIOS).forEach(([scenario, params]) => {
        describe(`${scenario} (trigger=${params.trigger}, scanVault=${params.scanVault})`, () => {
            beforeEach(() => {
                syncManager["settings"].hasCompletedFirstSync = !params.isInitial;
            });

            it("scenario-specific forbidden notifications are NOT triggered", async () => {
                const notifySpy = vi.spyOn(syncManager, "notify");
                try {
                    await syncManager.requestSmartSync(params.trigger, params.scanVault);
                } catch {
                    // ignore sync errors
                }

                const forbidden = MUST_NOT_TRIGGER[scenario] || [];
                for (const key of forbidden) {
                    expect(
                        wasNotifyCalledWith(notifySpy, key),
                        `${key} must NOT be triggered during ${scenario}`,
                    ).toBe(false);
                }
            });

            it("conflict/auth/history notifications are NOT triggered in clean sync", async () => {
                const notifySpy = vi.spyOn(syncManager, "notify");
                try {
                    await syncManager.requestSmartSync(params.trigger, params.scanVault);
                } catch {
                    // ignore sync errors
                }

                for (const key of NEVER_DURING_CLEAN_SYNC) {
                    expect(
                        wasNotifyCalledWith(notifySpy, key),
                        `${key} must NOT appear during clean ${scenario}`,
                    ).toBe(false);
                }
            });

            it("expected notifications ARE triggered", async () => {
                syncManager["settings"].notificationLevel = "verbose";
                const notifySpy = vi.spyOn(syncManager, "notify");
                try {
                    await syncManager.requestSmartSync(params.trigger, params.scanVault);
                } catch {
                    // ignore sync errors
                }

                // noticeSyncing: always called (may be filtered, but notify() is invoked)
                expect(
                    wasNotifyCalledWith(notifySpy, "noticeSyncing"),
                    "noticeSyncing should always be triggered",
                ).toBe(true);

                // noticeVaultUpToDate: called when no pull and no push
                expect(
                    wasNotifyCalledWith(notifySpy, "noticeVaultUpToDate"),
                    "noticeVaultUpToDate should be triggered in clean sync",
                ).toBe(true);

                // noticeScanningLocalFiles: only when scanVault=true
                expect(
                    wasNotifyCalledWith(notifySpy, "noticeScanningLocalFiles"),
                    `noticeScanningLocalFiles should ${params.scanVault ? "" : "NOT "}be triggered`,
                ).toBe(params.scanVault);
            });

            it("notifications hidden per matrix are NOT shown as Notice (standard)", async () => {
                syncManager["settings"].notificationLevel = "standard";
                (Notice as any).mockClear();
                try {
                    await syncManager.requestSmartSync(params.trigger, params.scanVault);
                } catch {
                    // ignore sync errors
                }

                const forbidden = MUST_NOT_SHOW_NOTICE[scenario] || [];
                for (const key of forbidden) {
                    expect(
                        wasNoticeShown(key),
                        `${key} must NOT appear as Notice during ${scenario} (standard)`,
                    ).toBe(false);
                }
            });
        });
    });

    // Startup sync with pushed files: confirmation flow must not trigger
    describe("startupSync with push (trigger=startup-sync, scanVault=true, pushed=true)", () => {
        it("initial sync confirmation notifications are NOT shown as Notice", async () => {
            // Override smartPush to return true (simulates dirty files being pushed)
            vi.spyOn(syncManager as any, "smartPush").mockResolvedValue(true);
            vi.spyOn(syncManager as any, "pullViaChangesAPI").mockResolvedValue(undefined);

            // Startup sync (not initial) → hasCompletedFirstSync = true
            syncManager["settings"].hasCompletedFirstSync = true;
            syncManager["settings"].notificationLevel = "standard";
            (Notice as any).mockClear();
            try {
                await syncManager.requestSmartSync("startup-sync", true);
            } catch {
                // ignore sync errors
            }

            // Matrix: these are "-" for startupSync → must not appear even when files are pushed
            const forbidden = [
                "noticeInitialSyncConfirmation",
                "noticeWaitingForRemoteRegistration",
                "noticeSyncConfirmed",
            ];
            for (const key of forbidden) {
                expect(
                    wasNoticeShown(key),
                    `${key} must NOT appear as Notice during startupSync with push`,
                ).toBe(false);
            }
        });

        it("Hide-marked notifications are still suppressed when files are pushed", async () => {
            vi.spyOn(syncManager as any, "smartPush").mockResolvedValue(true);
            vi.spyOn(syncManager as any, "pullViaChangesAPI").mockResolvedValue(undefined);

            syncManager["settings"].hasCompletedFirstSync = true;
            syncManager["settings"].notificationLevel = "standard";
            (Notice as any).mockClear();
            try {
                await syncManager.requestSmartSync("startup-sync", true);
            } catch {
                // ignore sync errors
            }

            // These are "Hide" for startupSync regardless of push result
            const hidden = ["noticeSyncing", "noticeScanningLocalFiles"];
            for (const key of hidden) {
                expect(
                    wasNoticeShown(key),
                    `${key} must NOT appear as Notice during startupSync with push`,
                ).toBe(false);
            }
        });
    });
});
