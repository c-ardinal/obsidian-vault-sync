import { describe, it, expect, beforeEach, vi } from "vitest";
import { SyncManager, SyncManagerSettings } from "../../../src/sync-manager";
import { MockApp } from "../../helpers/mock-vault-adapter";
import { CloudAdapter } from "../../../src/types/adapter";
import { Notice } from "obsidian";
import { i18n as i18nDict } from "../../../src/i18n";

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
}

const DEFAULT_SETTINGS: SyncManagerSettings = {
    concurrency: 1,
    notificationLevel: "standard",
    conflictResolutionStrategy: "smart-merge",
    enableLogging: false,
    exclusionPatterns: "",
    syncAppearance: true,
    syncCommunityPlugins: true,
    syncCoreConfig: true,
    syncImagesAndMedia: true,
    syncDotfiles: true,
    syncPluginSettings: true,
    syncFlexibleData: true,
    syncDeviceLogs: true,
    syncWorkspace: true,
};

// ════════════════════════════════════════════════════════════════
// Notification Visibility Matrix
// Maps directly to: doc/notification-case-matrix.md
//
// Test approach: Call notify() directly with the same parameters
// (isDetailed, isSilent) used in production code paths.
// This validates the notify() filtering logic for every cell
// in the matrix document.
//
// Visibility rules in notify():
//   isDetailed=true + low-priority (📥/📤): Show if verbose OR not silent
//   isDetailed=true + other (trash/merge/conflict): Always show
//   isDetailed=false + starting (⚡): Show only if not silent
//   isDetailed=false + other (completed/scanning/status): Always show
//   level="error": Never show (not tested here, trivially suppresses all)
// ════════════════════════════════════════════════════════════════

type Exp = "Show" | "Hide";

/**
 * Scenario isSilent mapping:
 *   - initialSync/manualSync/fullScan: User-triggered → isSilent=false
 *   - startupSync/autoSync: Background → isSilent=true
 *   - pushConflict/pullConflict: isSilent=true (models conflict during background sync,
 *     which is the more restrictive case matching standard-mode Hide expectations)
 *   - auth/historyModal: User-triggered actions → isSilent=false
 */
const SCENARIO_CONFIG: Record<string, { isSilent: boolean }> = {
    initialSync: { isSilent: false },
    startupSync: { isSilent: true },
    manualSync: { isSilent: false },
    autoSync: { isSilent: true },
    fullScan: { isSilent: false },
    pushConflict: { isSilent: true },
    pullConflict: { isSilent: true },
    auth: { isSilent: false },
    historyModal: { isSilent: false },
};

interface MatrixEntry {
    /** i18n key for the notification */
    key: string;
    /** isDetailed parameter passed to notify() in production code */
    isDetailed: boolean;
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
        isDetailed: false,
        scenarios: {
            initialSync: { v: "Show", s: "Show" },
            startupSync: { v: "Hide", s: "Hide" },
            manualSync: { v: "Show", s: "Show" },
            autoSync: { v: "Hide", s: "Hide" },
            fullScan: { v: "Show", s: "Show" },
        },
    },
    {
        // 🔍️ 同期: ローカルファイルを走査中...
        key: "noticeScanningLocalFiles",
        isDetailed: false,
        scenarios: {
            initialSync: { v: "Show", s: "Show" },
            startupSync: { v: "Hide", s: "Hide" },
            fullScan: { v: "Show", s: "Show" },
        },
    },
    {
        // 💤 同期: リモート側の反映完了を待機中...
        key: "noticeWaitingForRemoteRegistration",
        isDetailed: false,
        scenarios: {
            initialSync: { v: "Show", s: "Show" },
        },
    },
    {
        // 📥 同期: ダウンロード中 {file}
        key: "noticeFilePulled",
        isDetailed: true,
        scenarios: {
            initialSync: { v: "Show", s: "Show" },
            startupSync: { v: "Show", s: "Hide" },
            manualSync: { v: "Show", s: "Show" },
            autoSync: { v: "Show", s: "Hide" },
            fullScan: { v: "Show", s: "Show" },
            pushConflict: { v: "Show", s: "Hide" },
            pullConflict: { v: "Show", s: "Hide" },
        },
    },
    {
        // ✅ 同期: ダウンロード完了 (x files)
        key: "noticePullCompleted",
        isDetailed: false,
        scenarios: {
            initialSync: { v: "Show", s: "Show" },
            startupSync: { v: "Show", s: "Show" },
            manualSync: { v: "Show", s: "Show" },
            autoSync: { v: "Show", s: "Show" },
            fullScan: { v: "Show", s: "Show" },
            pushConflict: { v: "Show", s: "Show" },
            pullConflict: { v: "Show", s: "Show" },
        },
    },
    {
        // 📤 同期: アップロード中 {file}
        key: "noticeFilePushed",
        isDetailed: true,
        scenarios: {
            initialSync: { v: "Show", s: "Show" },
            startupSync: { v: "Show", s: "Hide" },
            manualSync: { v: "Show", s: "Show" },
            autoSync: { v: "Show", s: "Hide" },
            fullScan: { v: "Show", s: "Show" },
            pushConflict: { v: "Show", s: "Hide" },
            pullConflict: { s: "Hide" }, // verbose="-" (no care), standard=非表示
        },
    },
    {
        // ✅ 同期: アップロード完了 (x files)
        key: "noticePushCompleted",
        isDetailed: false,
        scenarios: {
            initialSync: { v: "Show", s: "Show" },
            startupSync: { v: "Show", s: "Show" },
            manualSync: { v: "Show", s: "Show" },
            autoSync: { v: "Show", s: "Show" },
            fullScan: { v: "Show", s: "Show" },
            pushConflict: { v: "Show", s: "Show" },
        },
    },
    {
        // ✅ 同期: すべて最新の状態です
        key: "noticeVaultUpToDate",
        isDetailed: false,
        scenarios: {
            initialSync: { v: "Show", s: "Show" },
            startupSync: { v: "Hide", s: "Hide" },
            manualSync: { v: "Show", s: "Show" },
            autoSync: { v: "Hide", s: "Hide" },
            fullScan: { v: "Show", s: "Show" },
        },
    },
    {
        // 📝 同期: 正常にアップロード出来たか確認中...
        key: "noticeInitialSyncConfirmation",
        isDetailed: false,
        scenarios: {
            initialSync: { v: "Show", s: "Show" },
        },
    },
    {
        // ✅ 同期: 成功 {file}
        key: "noticeSyncConfirmed",
        isDetailed: true,
        scenarios: {
            initialSync: { v: "Show", s: "Show" },
        },
    },
    {
        // 🗑️ 同期: 削除 {file}
        key: "noticeFileTrashed",
        isDetailed: true,
        scenarios: {
            initialSync: { v: "Show", s: "Show" },
            startupSync: { v: "Show", s: "Show" },
            manualSync: { v: "Show", s: "Show" },
            autoSync: { v: "Show", s: "Show" },
            fullScan: { v: "Show", s: "Show" },
            pushConflict: { v: "Show", s: "Show" },
            pullConflict: { v: "Show", s: "Show" },
        },
    },
    {
        // ✏️ 同期: リネーム反映 {file}
        key: "noticeFileRenamed",
        isDetailed: true,
        scenarios: {
            initialSync: { v: "Show", s: "Show" },
            startupSync: { v: "Show", s: "Show" },
            manualSync: { v: "Show", s: "Show" },
            autoSync: { v: "Show", s: "Show" },
            fullScan: { v: "Show", s: "Show" },
            pushConflict: { v: "Show", s: "Show" },
            pullConflict: { v: "Show", s: "Show" },
        },
    },

    // ═══ Conflict Notifications ═══
    {
        // 📝 競合: マージ中: {file}
        key: "noticeMergingFile",
        isDetailed: true,
        scenarios: {
            initialSync: { v: "Show", s: "Show" },
            startupSync: { v: "Show", s: "Show" },
            manualSync: { v: "Show", s: "Show" },
            autoSync: { v: "Show", s: "Show" },
            fullScan: { v: "Show", s: "Show" },
            pushConflict: { v: "Show", s: "Show" },
            pullConflict: { v: "Show", s: "Show" },
        },
    },
    {
        // ✅ 競合: 自動解決されました: {file}
        key: "noticeMergeSuccess",
        isDetailed: true,
        scenarios: {
            initialSync: { v: "Show", s: "Show" },
            startupSync: { v: "Show", s: "Show" },
            manualSync: { v: "Show", s: "Show" },
            autoSync: { v: "Show", s: "Show" },
            fullScan: { v: "Show", s: "Show" },
            pushConflict: { v: "Show", s: "Show" },
            pullConflict: { v: "Show", s: "Show" },
        },
    },
    {
        // ⚠️ 競合: ローカル版を保護し、リモート版を反映しました: {file}
        key: "noticeConflictSaved",
        isDetailed: true,
        scenarios: {
            pushConflict: { v: "Show", s: "Show" },
            pullConflict: { v: "Show", s: "Show" },
        },
    },
    {
        // ⚠️ 競合: リモート版を保護し、ローカル版を反映しました: {file}
        key: "noticeConflictRemoteSaved",
        isDetailed: true,
        scenarios: {
            pushConflict: { v: "Show", s: "Show" },
            pullConflict: { v: "Show", s: "Show" },
        },
    },
    {
        // ⚠️ 競合: マージに失敗した可能性が有ります。詳細は他デバイスを確認してください
        key: "noticeCheckOtherDevice",
        isDetailed: true,
        scenarios: {
            pushConflict: { v: "Show", s: "Show" },
            pullConflict: { v: "Show", s: "Show" },
        },
    },
    {
        // 💤 競合: 他デバイスが解決するのを待機しています...: {file}
        key: "noticeWaitOtherDeviceMerge",
        isDetailed: true,
        scenarios: {
            pushConflict: { v: "Show", s: "Show" },
            pullConflict: { v: "Show", s: "Show" },
        },
    },
    {
        // ✅ 競合: 他デバイスの解決結果を反映しました: {file}
        key: "noticeRemoteMergeSynced",
        isDetailed: true,
        scenarios: {
            pushConflict: { v: "Show", s: "Show" },
            pullConflict: { v: "Show", s: "Show" },
        },
    },

    // ═══ Auth Notifications ═══
    {
        // ✅ 認証: 成功！
        key: "noticeAuthSuccess",
        isDetailed: false,
        scenarios: {
            auth: { v: "Show", s: "Show" },
        },
    },
    {
        // ❌ 認証: 失敗
        key: "noticeAuthFailed",
        isDetailed: false,
        scenarios: {
            auth: { v: "Show", s: "Show" },
        },
    },

    // ═══ History Modal Notifications ═══
    {
        // ✅ 履歴: 無期限保護設定完了
        key: "noticeSavedKeepForever",
        isDetailed: false,
        scenarios: {
            historyModal: { v: "Show", s: "Show" },
        },
    },
    {
        // ❌ 履歴: クラウド側の仕様により、無期限保存設定を解除することはできません。
        key: "historyKeepForeverError",
        isDetailed: false,
        scenarios: {
            historyModal: { v: "Show", s: "Show" },
        },
    },
    {
        // 📝 履歴: ファイルを復元しました。同期を開始します...
        key: "noticeFileRestored",
        isDetailed: false,
        scenarios: {
            historyModal: { v: "Show", s: "Show" },
        },
    },
    {
        // ✅ 履歴: ファイルを別名で復元しました: {file}
        key: "noticeHistoryRestoreAs",
        isDetailed: false,
        scenarios: {
            historyModal: { v: "Show", s: "Show" },
        },
    },
    {
        // 🗑️ 履歴: リビジョンを削除しました
        key: "noticeRevisionDeleted",
        isDetailed: false,
        scenarios: {
            historyModal: { v: "Show", s: "Show" },
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
    { key: "noticeFileRenamed", specJa: "✏️ [同期] リネーム反映: {file}" },
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
        key: "noticeWaitOtherDeviceMerge",
        specJa: "⌛️ [競合] 他デバイスが解決するのを待機しています...: {file}",
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
];

// ════════════════════════════════════════════════════════════════
// Tests
// ════════════════════════════════════════════════════════════════

describe("Notification Visibility Matrix", () => {
    let app: MockApp;
    let adapter: MockCloudAdapter;
    let syncManager: SyncManager;

    beforeEach(async () => {
        vi.clearAllMocks();
        app = new MockApp();
        adapter = new MockCloudAdapter();
        syncManager = new SyncManager(
            app as any,
            adapter,
            "idx.json",
            { ...DEFAULT_SETTINGS },
            "dir",
            (key) => i18nDict.ja[key] || key,
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
            // Conflict
            "noticeMergingFile",
            "noticeMergeSuccess",
            "noticeConflictSaved",
            "noticeConflictRemoteSaved",
            "noticeCheckOtherDevice",
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
    (["verbose", "standard"] as const).forEach((level) => {
        describe(`Level: ${level}`, () => {
            MATRIX.forEach((entry) => {
                Object.entries(entry.scenarios).forEach(([scenario, expectations]) => {
                    const expected = level === "verbose" ? expectations.v : expectations.s;
                    if (!expected) return; // "-" (no care) → skip

                    it(`[${scenario}] ${entry.key} → ${expected}`, async () => {
                        syncManager["settings"].notificationLevel = level;
                        const { isSilent } = SCENARIO_CONFIG[scenario];

                        // Construct message from i18n (replace {0} placeholder if present)
                        const msg = (i18nDict.ja[entry.key] || entry.key).replace("{0}", "1");

                        (Notice as any).mockClear();
                        await syncManager.notify(msg, entry.isDetailed, isSilent);

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

    // Error level: all notifications suppressed
    describe("Level: error", () => {
        it("suppresses all notifications regardless of parameters", async () => {
            syncManager["settings"].notificationLevel = "error" as any;

            for (const entry of MATRIX) {
                const msg = (i18nDict.ja[entry.key] || entry.key).replace("{0}", "1");
                (Notice as any).mockClear();
                await syncManager.notify(msg, entry.isDetailed, false);
                expect(
                    (Notice as any).mock.calls.length,
                    `${entry.key} should be suppressed at error level`,
                ).toBe(0);
            }
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

describe("Notification Message Format Validation", () => {
    // Verify i18n values don't end with ":" (code adds ": filename" separately)
    describe("i18n values must NOT end with colon (code appends `: filename`)", () => {
        const keysWithFilename = [
            "noticeMergingFile",
            "noticeMergeSuccess",
            "noticeRemoteMergeSynced",
            "noticeWaitOtherDeviceMerge",
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
// (e.g., noticeScanningLocalFiles during autoSync when scanVault=false)
// ════════════════════════════════════════════════════════════════

/** Sync scenario parameters for requestSmartSync(isSilent, scanVault) */
const SYNC_SCENARIOS: Record<string, { isSilent: boolean; scanVault: boolean }> = {
    manualSync: { isSilent: false, scanVault: false },
    autoSync: { isSilent: true, scanVault: false },
    startupSync: { isSilent: true, scanVault: true },
    fullScan: { isSilent: false, scanVault: true },
};

/**
 * Notifications that must NOT be triggered (notify() must not be called) per scenario.
 * Derived from matrix document "-" entries where the code path should not reach notify().
 *
 * This is distinct from "Hide" (notify is called but filtered out by level/isSilent).
 * These are cases where notify() itself must never be invoked.
 */
const MUST_NOT_TRIGGER: Record<string, string[]> = {
    manualSync: [
        "noticeScanningLocalFiles", // scanVault=false → if(scanVault) branch not entered
        "noticeWaitingForRemoteRegistration", // only during initial sync confirmation
        "noticeInitialSyncConfirmation", // only during initial sync confirmation
        "noticeSyncConfirmed", // only during initial sync confirmation
    ],
    autoSync: [
        "noticeScanningLocalFiles", // scanVault=false → if(scanVault) branch not entered
        "noticeWaitingForRemoteRegistration",
        "noticeInitialSyncConfirmation",
        "noticeSyncConfirmed",
    ],
    startupSync: [
        "noticeWaitingForRemoteRegistration", // not initial sync (smartPull returns false)
        "noticeInitialSyncConfirmation",
        "noticeSyncConfirmed",
    ],
    fullScan: [
        "noticeWaitingForRemoteRegistration",
        "noticeInitialSyncConfirmation",
        "noticeSyncConfirmed",
    ],
};

/** Notifications that should never appear during any sync scenario (clean sync, no conflicts) */
const NEVER_DURING_CLEAN_SYNC: string[] = [
    // Conflict notifications: no conflicts in clean sync
    "noticeMergingFile",
    "noticeMergeSuccess",
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
];

/**
 * Notifications that must NOT appear as Notice (user-visible) per scenario in standard mode.
 * Combines "-" (code path unreachable) and "非表示" (Hide, filtered by notify()).
 * Unlike MUST_NOT_TRIGGER (which checks notify() calls), this checks the actual
 * Notice constructor to verify end-to-end behavior: production code → notify() → Notice.
 */
const MUST_NOT_SHOW_NOTICE: Record<string, string[]> = {
    manualSync: [
        "noticeScanningLocalFiles", // "-": scanVault=false
        "noticeWaitingForRemoteRegistration", // "-": not initial sync
        "noticeInitialSyncConfirmation", // "-": not initial sync
        "noticeSyncConfirmed", // "-": not initial sync
    ],
    autoSync: [
        "noticeSyncing", // "Hide": silent background sync
        "noticeScanningLocalFiles", // "-": scanVault=false
        "noticeVaultUpToDate", // "Hide": silent background sync
        "noticeWaitingForRemoteRegistration", // "-": not initial sync
        "noticeInitialSyncConfirmation", // "-": not initial sync
        "noticeSyncConfirmed", // "-": not initial sync
    ],
    startupSync: [
        "noticeSyncing", // "Hide": silent background sync
        "noticeScanningLocalFiles", // "Hide": startup sync
        "noticeVaultUpToDate", // "Hide": silent background sync
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

describe("Integration: Sync scenarios trigger correct notifications", () => {
    let app: MockApp;
    let adapter: MockCloudAdapter;
    let syncManager: SyncManager;

    beforeEach(async () => {
        vi.clearAllMocks();
        app = new MockApp();
        adapter = new MockCloudAdapter();
        syncManager = new SyncManager(
            app as any,
            adapter,
            "idx.json",
            { ...DEFAULT_SETTINGS },
            "dir",
            (key) => i18nDict.ja[key] || key,
        );
        vi.spyOn(syncManager as any, "log").mockImplementation(async () => {});
        // Mock internal sync methods to make sync complete cleanly (no changes)
        vi.spyOn(syncManager as any, "smartPull").mockResolvedValue(false);
        vi.spyOn(syncManager as any, "smartPush").mockResolvedValue(false);
    });

    /** Helper: check if any notify() call contains the i18n message for the given key */
    const wasNotifyCalledWith = (notifySpy: ReturnType<typeof vi.spyOn>, key: string): boolean => {
        const msg = i18nDict.ja[key];
        if (!msg) return false;
        return notifySpy.mock.calls.some(
            ([m]: [unknown]) => typeof m === "string" && m.includes(msg),
        );
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
        describe(`${scenario} (isSilent=${params.isSilent}, scanVault=${params.scanVault})`, () => {
            it("scenario-specific forbidden notifications are NOT triggered", async () => {
                const notifySpy = vi.spyOn(syncManager, "notify");
                try {
                    await syncManager.requestSmartSync(params.isSilent, params.scanVault);
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
                    await syncManager.requestSmartSync(params.isSilent, params.scanVault);
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
                    await syncManager.requestSmartSync(params.isSilent, params.scanVault);
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
                    await syncManager.requestSmartSync(params.isSilent, params.scanVault);
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
    describe("startupSync with push (isSilent=true, scanVault=true, pushed=true)", () => {
        it("initial sync confirmation notifications are NOT shown as Notice", async () => {
            // Override smartPush to return true (simulates dirty files being pushed)
            vi.spyOn(syncManager as any, "smartPush").mockResolvedValue(true);
            vi.spyOn(syncManager as any, "pullViaChangesAPI").mockResolvedValue(undefined);

            syncManager["settings"].notificationLevel = "standard";
            (Notice as any).mockClear();
            try {
                await syncManager.requestSmartSync(true, true); // startup sync
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

            syncManager["settings"].notificationLevel = "standard";
            (Notice as any).mockClear();
            try {
                await syncManager.requestSmartSync(true, true); // startup sync
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
