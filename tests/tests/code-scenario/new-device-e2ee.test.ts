/**
 * @file 新規デバイス参加時のE2EE検出・初回同期テスト
 *
 * @description
 * E2EEが有効なVaultに新規デバイスが参加する際の自動検出フロー、
 * 空インデックスでの初回Full Pull、localIndex初期化、
 * checkForLockFileのエラーハンドリング、resetIndex時のキャッシュクリアを検証する。
 *
 * @prerequisites
 * - DeviceSimulator + MockCloudAdapter
 * - vault-lock.vault ファイルによるE2EE検出
 *
 * @pass_criteria
 * - vault-lock.vault存在時にE2EEを自動検出し、noticeE2EEAutoEnabledを表示すること
 * - 空インデックスではstartPageTokenがあってもFull Pullを実行すること
 * - localIndex.jsonが存在しない場合、空オブジェクトで初期化されること
 * - 認証済みでcheckForLockFileが例外→同期中断、未認証→同期続行
 * - resetIndex()がclearDownloadCache()を呼ぶこと
 */
import { describe, it, expect, vi } from "vitest";
import { DeviceSimulator, hashOf } from "../../helpers/device-simulator";
import { MockCloudAdapter } from "../../helpers/mock-cloud-adapter";
import { loadLocalIndex, resetIndex } from "../../../src/sync-manager/state";
import { VAULT_LOCK_PATH } from "../../../src/services/vault-lock-service";

const SYNC_INDEX_PATH = ".obsidian/plugins/obsidian-vault-sync/data/remote/sync-index.json";

// =============================================================================
// Helpers
// =============================================================================

/** Access SyncManager private fields */
const sm = (d: DeviceSimulator) => d.syncManager as any;

/**
 * Set up Device A with synced content files on the cloud.
 * Simulates an existing device that already pushed files to remote.
 */
function setupExistingDevice(cloud: MockCloudAdapter) {
    const deviceA = new DeviceSimulator("DeviceA", cloud);
    deviceA.setupSyncedFile("notes/hello.md", "Hello World", "f1");
    deviceA.setupSyncedFile("notes/readme.md", "Read Me", "f2");
    deviceA.setupSyncedFile("images/photo.png", "PNGDATA", "f3");
    return deviceA;
}

/**
 * Push all files from Device A to cloud (including index).
 * Uses forcePush to ensure files are uploaded even when local hash matches index
 * (setupSyncedFile pre-populates index, so pushFile would skip the upload).
 */
async function pushAllFiles(deviceA: DeviceSimulator) {
    await deviceA.forcePush("notes/hello.md");
    await deviceA.forcePush("notes/readme.md");
    await deviceA.forcePush("images/photo.png");
}

// =============================================================================
// Bug 1: E2EE auto-detection on first sync
// =============================================================================
/** vault-lock.vaultによるE2EE自動検出の検証 */
describe("Bug 1: E2EE auto-detection in requestSmartSync", () => {
    it("should detect remote E2EE and block sync instead of JSON parse error", async () => {
        const cloud = new MockCloudAdapter();
        const device = new DeviceSimulator("NewDevice", cloud);

        // Simulate: remote has vault-lock.vault (another device set up E2EE)
        await cloud.uploadFile(
            VAULT_LOCK_PATH,
            new TextEncoder().encode("encrypted-lock-blob").buffer as ArrayBuffer,
            Date.now(),
        );

        // Precondition: E2EE is NOT enabled locally (fresh device, no engine)
        expect(sm(device).settings.e2eeEnabled).toBe(false);

        // Track notifications
        const notifications: string[] = [];
        sm(device).notify = async (key: string) => {
            notifications.push(key);
        };

        // Track settings saves
        let settingsSaved = false;
        sm(device).onSaveSettings = async () => {
            settingsSaved = true;
        };

        // requestSmartSync should detect E2EE lock file and abort
        await device.syncManager.requestSmartSync("manual-sync");

        // E2EE should now be enabled
        expect(sm(device).settings.e2eeEnabled).toBe(true);

        // Should have notified about E2EE auto-enable AND vault locked
        expect(notifications).toContain("noticeE2EEAutoEnabled");
        expect(notifications).toContain("noticeVaultLocked");

        // Settings should have been saved
        expect(settingsSaved).toBe(true);
    });

    it("should not trigger E2EE detection when no lock file exists", async () => {
        const cloud = new MockCloudAdapter();
        const device = new DeviceSimulator("NewDevice", cloud);

        // No vault-lock.vault on remote
        expect(sm(device).settings.e2eeEnabled).toBe(false);

        const notifications: string[] = [];
        sm(device).notify = async (key: string) => {
            notifications.push(key);
        };

        // Mock smartPull/smartPush to avoid full sync flow
        vi.spyOn(sm(device), "smartPull").mockResolvedValue(false);
        vi.spyOn(sm(device), "smartPush").mockResolvedValue(false);

        await device.syncManager.requestSmartSync("manual-sync");

        // E2EE should remain disabled
        expect(sm(device).settings.e2eeEnabled).toBe(false);

        // Should NOT have E2EE notifications
        expect(notifications).not.toContain("noticeE2EEAutoEnabled");
        expect(notifications).not.toContain("noticeVaultLocked");
    });

    it("should skip E2EE detection when already enabled", async () => {
        const cloud = new MockCloudAdapter();
        const device = new DeviceSimulator("NewDevice", cloud);

        // E2EE already enabled (but locked — no crypto engine)
        sm(device).settings.e2eeEnabled = true;
        expect(sm(device).e2eeLocked).toBe(true);

        const checkSpy = vi.spyOn(sm(device).vaultLockService, "checkForLockFile");

        const notifications: string[] = [];
        sm(device).notify = async (key: string) => {
            notifications.push(key);
        };

        await device.syncManager.requestSmartSync("manual-sync");

        // Should not call checkForLockFile (E2EE already enabled)
        expect(checkSpy).not.toHaveBeenCalled();

        // Should show vault locked notification (not auto-enable)
        expect(notifications).not.toContain("noticeE2EEAutoEnabled");
        expect(notifications).toContain("noticeVaultLocked");
    });
});

// =============================================================================
// Bug 2: Stale startPageToken with empty index
// =============================================================================
/** 空インデックス時のFull Pull強制 */
describe("Bug 2: Stale startPageToken prevents full pull on fresh device", () => {
    it("should do full pull when index is empty despite having startPageToken", async () => {
        const cloud = new MockCloudAdapter();

        // Device A pushes content files
        const deviceA = setupExistingDevice(cloud);
        await pushAllFiles(deviceA);

        // Device B: fresh device with empty index but stale startPageToken
        const deviceB = new DeviceSimulator("DeviceB", cloud);
        expect(Object.keys(sm(deviceB).index)).toHaveLength(0);

        // Simulate stale startPageToken (saved from a previous failed sync)
        sm(deviceB).startPageToken = "stale_token_123";

        // Spy on cloud.getChanges: if Changes API is used, getChanges will be called
        // (smartPull calls the standalone pullViaChangesAPI(ctx) directly, not via
        //  ctx.pullViaChangesAPI(), so we spy on the cloud adapter instead)
        const getChangesSpy = vi.spyOn(cloud, "getChanges");

        // Mock notify to avoid uninitialized errors
        sm(deviceB).notify = async () => {};

        // Run smartPull
        const pulled = await sm(deviceB).smartPull();

        // Should NOT have used Changes API (index is empty → full pull path)
        expect(getChangesSpy).not.toHaveBeenCalled();

        // Should have pulled files via full index comparison
        expect(pulled).toBe(true);

        // All 3 content files should now be locally available
        expect(deviceB.getLocalContent("notes/hello.md")).toBe("Hello World");
        expect(deviceB.getLocalContent("notes/readme.md")).toBe("Read Me");
        expect(deviceB.getLocalContent("images/photo.png")).toBe("PNGDATA");
    });

    it("should use Changes API when index has entries", async () => {
        const cloud = new MockCloudAdapter();

        // Device A pushes content files
        const deviceA = setupExistingDevice(cloud);
        await pushAllFiles(deviceA);

        // Device B: has fully synced state (non-empty index)
        const deviceB = new DeviceSimulator("DeviceB", cloud);
        deviceB.setupSyncedFile("notes/hello.md", "Hello World", "f1");

        // Set startPageToken
        sm(deviceB).startPageToken = "valid_token";

        // Spy on cloud.getChanges to confirm Changes API path was taken
        const getChangesSpy = vi.spyOn(cloud, "getChanges");
        sm(deviceB).notify = async () => {};

        await sm(deviceB).smartPull();

        // SHOULD have called getChanges (Changes API path taken)
        expect(getChangesSpy).toHaveBeenCalled();
    });
});

// =============================================================================
// Bug 2b: localIndex migration — fresh device should start empty
// =============================================================================
/** 新規/既存デバイスでのlocalIndex初期化 */
describe("Bug 2b: localIndex initialization on fresh device", () => {
    it("should initialize localIndex as empty when localIndex.json does not exist", async () => {
        const cloud = new MockCloudAdapter();
        const device = new DeviceSimulator("NewDevice", cloud);

        // Simulate shared index with remote entries (as if loaded from sync-index.json)
        sm(device).index = {
            "notes/hello.md": {
                fileId: "f1",
                hash: hashOf("Hello World"),
                mtime: Date.now(),
                size: 11,
            },
            "notes/readme.md": {
                fileId: "f2",
                hash: hashOf("Read Me"),
                mtime: Date.now(),
                size: 7,
            },
        };

        // Ensure localIndex.json does NOT exist (fresh device)
        const localIndexPath = sm(device).localIndexPath;
        const vault = sm(device).vault;
        if (await vault.exists(localIndexPath)) {
            await vault.remove(localIndexPath);
        }

        // Call loadLocalIndex — should NOT copy from ctx.index
        await loadLocalIndex(sm(device));

        // localIndex should be empty (NOT a copy of ctx.index)
        expect(Object.keys(sm(device).localIndex)).toHaveLength(0);

        // index should remain unchanged
        expect(Object.keys(sm(device).index)).toHaveLength(2);
    });

    it("should preserve existing localIndex when localIndex.json exists", async () => {
        const cloud = new MockCloudAdapter();
        const device = new DeviceSimulator("ExistingDevice", cloud);

        // Simulate an already-synced device state
        const localIndexData = {
            index: {
                "notes/hello.md": {
                    fileId: "f1",
                    hash: hashOf("Hello World"),
                    mtime: Date.now(),
                    size: 11,
                    lastAction: "pull",
                },
            },
            deviceId: "dev_ExistingDevice",
        };

        // Write existing localIndex.json
        const localIndexPath = sm(device).localIndexPath;
        const vault = sm(device).vault;
        await vault.write(localIndexPath, JSON.stringify(localIndexData));

        // Call loadLocalIndex
        await loadLocalIndex(sm(device));

        // Should load from file (not initialize fresh)
        expect(Object.keys(sm(device).localIndex)).toHaveLength(1);
        expect(sm(device).localIndex["notes/hello.md"]).toBeDefined();
        expect(sm(device).deviceId).toBe("dev_ExistingDevice");
    });
});

// =============================================================================
// Integration: Full new-device-joining scenario
// =============================================================================
/** 新規デバイスのフル同期→Changes APIへの遷移 */
describe("Integration: New device joining existing sync group", () => {
    it("should pull all content files on first sync of a fresh device", async () => {
        const cloud = new MockCloudAdapter();

        // Device A: existing device with content
        const deviceA = setupExistingDevice(cloud);
        await pushAllFiles(deviceA);

        // Device B: brand new device, empty vault, empty indices
        const deviceB = new DeviceSimulator("DeviceB", cloud);
        sm(deviceB).notify = async () => {};

        // Precondition: both indices are empty
        expect(Object.keys(sm(deviceB).index)).toHaveLength(0);
        expect(Object.keys(sm(deviceB).localIndex)).toHaveLength(0);

        // First full smart sync (should do full pull)
        vi.spyOn(sm(deviceB), "smartPush").mockResolvedValue(false);
        await sm(deviceB).smartPull();

        // All 3 content files should be pulled
        expect(deviceB.getLocalContent("notes/hello.md")).toBe("Hello World");
        expect(deviceB.getLocalContent("notes/readme.md")).toBe("Read Me");
        expect(deviceB.getLocalContent("images/photo.png")).toBe("PNGDATA");
    });

    it("should use Changes API on second sync after successful first sync", async () => {
        const cloud = new MockCloudAdapter();

        // Device A pushes content
        const deviceA = setupExistingDevice(cloud);
        await pushAllFiles(deviceA);

        // Device B: first sync (full pull)
        const deviceB = new DeviceSimulator("DeviceB", cloud);
        sm(deviceB).notify = async () => {};

        await sm(deviceB).smartPull();

        // After first sync, index should have entries and startPageToken
        expect(Object.keys(sm(deviceB).index).length).toBeGreaterThan(0);
        expect(sm(deviceB).startPageToken).not.toBeNull();

        // Second sync should use Changes API (spy on cloud.getChanges since smartPull
        // calls the standalone pullViaChangesAPI(ctx) directly, not via ctx method)
        const getChangesSpy = vi.spyOn(cloud, "getChanges");
        await sm(deviceB).smartPull();
        expect(getChangesSpy).toHaveBeenCalled();
    });
});

// =============================================================================
// Fix 1: checkForLockFile failure handling based on auth state
// =============================================================================
/** 認証状態別のエラーハンドリング */
describe("Fix 1: checkForLockFile error handling by auth state", () => {
    it("should abort sync when authenticated and checkForLockFile throws", async () => {
        const cloud = new MockCloudAdapter();
        const device = new DeviceSimulator("DeviceA", cloud);

        // Authenticated by default (MockCloudAdapter returns true)
        expect(cloud.isAuthenticated()).toBe(true);

        // checkForLockFile throws (e.g. network error)
        vi.spyOn(sm(device).vaultLockService, "checkForLockFile").mockRejectedValue(
            new Error("Network timeout"),
        );

        // smartPull should NOT be called — sync should abort
        const pullSpy = vi.spyOn(sm(device), "smartPull");

        sm(device).notify = async () => {};

        await device.syncManager.requestSmartSync("manual-sync");

        expect(pullSpy).not.toHaveBeenCalled();
    });

    it("should continue sync when not authenticated and checkForLockFile throws", async () => {
        const cloud = new MockCloudAdapter();
        const device = new DeviceSimulator("DeviceA", cloud);

        // Override isAuthenticated to return false
        vi.spyOn(cloud, "isAuthenticated").mockReturnValue(false);

        // checkForLockFile throws
        vi.spyOn(sm(device).vaultLockService, "checkForLockFile").mockRejectedValue(
            new Error("Not authenticated"),
        );

        // smartPull SHOULD be called — sync continues past the catch
        const pullSpy = vi.spyOn(sm(device), "smartPull").mockResolvedValue(false);
        vi.spyOn(sm(device), "smartPush").mockResolvedValue(false);

        sm(device).notify = async () => {};

        await device.syncManager.requestSmartSync("manual-sync");

        expect(pullSpy).toHaveBeenCalled();
    });
});

// =============================================================================
// Fix 2: resetIndex clears download cache
// =============================================================================
/** resetIndex時のキャッシュクリア */
describe("Fix 2: resetIndex clears download cache", () => {
    it("should call clearDownloadCache when resetting index", async () => {
        const cloud = new MockCloudAdapter();
        const device = new DeviceSimulator("DeviceA", cloud);

        // Set up a clearDownloadCache spy on the adapter
        const ctx = sm(device);
        const clearSpy = vi.fn();
        ctx.adapter.clearDownloadCache = clearSpy;

        await resetIndex(ctx);

        expect(clearSpy).toHaveBeenCalledOnce();
        expect(ctx.index).toEqual({});
        expect(ctx.localIndex).toEqual({});
        expect(ctx.startPageToken).toBeNull();
    });
});
