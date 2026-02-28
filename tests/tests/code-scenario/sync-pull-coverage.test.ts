/**
 * @file sync-pull 追加カバレッジテスト
 *
 * @description
 * pullFile / syncPull の主要分岐（リモート不在、新規ダウンロード、
 * ハッシュ一致スキップ、ローカル削除、コンテンツ更新）を
 * DeviceSimulator で検証する。
 *
 * @pass_criteria
 * - リモート不在 → pullFile=false
 * - 新規ファイル → ローカルにダウンロード
 * - ハッシュ一致 → syncPull=skipped_hash_match
 * - リモート削除 → ローカル削除
 * - コンテンツ更新 → ローカル更新
 */

import { describe, it, expect, beforeEach } from "vitest";
import { DeviceSimulator, hashOf } from "../../helpers/device-simulator";
import { MockCloudAdapter } from "../../helpers/mock-cloud-adapter";

function encode(str: string): ArrayBuffer {
    return new TextEncoder().encode(str).buffer as ArrayBuffer;
}

describe("smartPull additional coverage", () => {
    let cloud: MockCloudAdapter;
    let devA: DeviceSimulator;
    let devB: DeviceSimulator;

    beforeEach(() => {
        cloud = new MockCloudAdapter();
        devA = new DeviceSimulator("A", cloud);
        devB = new DeviceSimulator("B", cloud);
    });

    it("should return false when remote file does not exist", async () => {
        const result = await devA.pullFile("notes/nonexistent.md");
        expect(result).toBe(false);
    });

    it("should download new file from remote", async () => {
        // Device A pushes a file
        devA.app.vaultAdapter.setFile("notes/new.md", "Hello from A");
        (devA.syncManager as any).dirtyPaths.set("notes/new.md", Date.now());
        await devA.pushFile("notes/new.md");

        // Device B pulls
        const result = await devB.pullFile("notes/new.md");
        expect(result).toBe(true);

        const content = devB.getLocalContent("notes/new.md");
        expect(content).toBe("Hello from A");

        const idx = devB.getLocalIndex("notes/new.md");
        expect(idx).toBeDefined();
        expect(idx!.lastAction).toBe("pull");
    });

    it("should skip download when hash matches (syncPull)", async () => {
        // Both devices have the same file
        const buf = encode("same content");
        const uploaded = await cloud.uploadFile("notes/same.md", buf, Date.now());

        devA.setupSyncedFile("notes/same.md", "same content", uploaded.id);

        // Mark as pushed so syncPull can confirm it
        (devA.syncManager as any).localIndex["notes/same.md"].lastAction = "push";

        const result = await devA.syncPull("notes/same.md");
        expect(result).toBe("skipped_hash_match");

        // lastAction should be reset to pull (sync confirmed)
        const idx = devA.getLocalIndex("notes/same.md");
        expect(idx!.lastAction).toBe("pull");
    });

    it("should delete local file when removed from remote", async () => {
        // Setup synced file on device A
        const buf = encode("shared content");
        const uploaded = await cloud.uploadFile("notes/shared.md", buf, Date.now());
        devA.setupSyncedFile("notes/shared.md", "shared content", uploaded.id);

        // Remove from remote
        await cloud.deleteFile(uploaded.id);

        // Pull should delete locally
        const result = await devA.pullFile("notes/shared.md");
        expect(result).toBe(true);
        expect(devA.getIndex("notes/shared.md")).toBeUndefined();
        expect(devA.getLocalIndex("notes/shared.md")).toBeUndefined();
        expect(devA.getLocalContent("notes/shared.md")).toBeNull();
    });

    it("should download updated content from remote", async () => {
        // Both devices start synced
        const originalBuf = encode("original");
        const uploaded = await cloud.uploadFile("notes/update.md", originalBuf, Date.now());
        devB.setupSyncedFile("notes/update.md", "original", uploaded.id);

        // Device A pushes updated content
        const newBuf = encode("updated by A");
        await cloud.uploadFile("notes/update.md", newBuf, Date.now());

        // Device B pulls (syncPull detects hash mismatch)
        const result = await devB.syncPull("notes/update.md");
        expect(result).toBe("pulled");

        const content = devB.getLocalContent("notes/update.md");
        expect(content).toBe("updated by A");
    });

    it("should return no_remote when file never existed on cloud", async () => {
        const result = await devA.syncPull("notes/ghost.md");
        expect(result).toBe("no_remote");
    });

    it("should handle two-device push-then-pull cycle", async () => {
        // Device A creates and pushes
        devA.app.vaultAdapter.setFile("notes/cycle.md", "v1 from A");
        (devA.syncManager as any).dirtyPaths.set("notes/cycle.md", Date.now());
        await devA.pushFile("notes/cycle.md");
        await devA.uploadIndex();

        // Device B pulls
        const pullResult = await devB.pullFile("notes/cycle.md");
        expect(pullResult).toBe(true);
        expect(devB.getLocalContent("notes/cycle.md")).toBe("v1 from A");

        // Device B edits and pushes
        devB.editFile("notes/cycle.md", "v2 from B");
        const pushResult = await devB.pushFile("notes/cycle.md");
        expect(pushResult.pushed).toBe(true);

        // Device A pulls update
        const pullA = await devA.syncPull("notes/cycle.md");
        expect(pullA).toBe("pulled");
        expect(devA.getLocalContent("notes/cycle.md")).toBe("v2 from B");
    });
});
