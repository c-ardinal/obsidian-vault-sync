/**
 * @file sync-push 追加カバレッジテスト
 *
 * @description
 * pushFile の主要分岐（ハッシュスキップ、正常push、ファイル削除、
 * コンフリクト検出、マージ結果push）を DeviceSimulator で検証する。
 *
 * @pass_criteria
 * - ハッシュ一致 → pushed=false (スキップ)
 * - 正常push → pushed=true, index更新
 * - ファイル削除 → リモートから削除, index/localIndex クリア
 * - リモート変更 → conflictDetected=true
 * - merge結果 → pushed=true, conflictDetected=false
 */

import { describe, it, expect, beforeEach } from "vitest";
import { DeviceSimulator } from "../../helpers/device-simulator";
import { MockCloudAdapter } from "../../helpers/mock-cloud-adapter";

describe("smartPush additional coverage", () => {
    let cloud: MockCloudAdapter;
    let dev: DeviceSimulator;

    beforeEach(() => {
        cloud = new MockCloudAdapter();
        dev = new DeviceSimulator("A", cloud);
    });

    it("should return pushed=false when file hash matches (no actual change)", async () => {
        dev.setupSyncedFile("notes/same.md", "unchanged content", "file_1");

        // Mark as dirty but don't actually change content
        (dev.syncManager as any).dirtyPaths.set("notes/same.md", Date.now());

        const result = await dev.pushFile("notes/same.md");
        expect(result.pushed).toBe(false);
        expect(result.conflictDetected).toBe(false);
    });

    it("should push modified file and update index", async () => {
        const originalBuf = new TextEncoder().encode("original").buffer as ArrayBuffer;
        await cloud.uploadFile("notes/edit.md", originalBuf, Date.now());

        dev.setupSyncedFile("notes/edit.md", "original", "file_2");

        dev.editFile("notes/edit.md", "modified content");

        const result = await dev.pushFile("notes/edit.md");
        expect(result.pushed).toBe(true);
        expect(result.conflictDetected).toBe(false);

        const idx = dev.getLocalIndex("notes/edit.md");
        expect(idx).toBeDefined();
        expect(idx!.lastAction).toBe("push");
    });

    it("should delete remote file when local file is removed", async () => {
        const buf = new TextEncoder().encode("delete me").buffer as ArrayBuffer;
        const uploaded = await cloud.uploadFile("notes/old.md", buf, Date.now());

        dev.setupSyncedFile("notes/old.md", "delete me", uploaded.id);

        // Delete locally
        dev.app.vaultAdapter.remove("notes/old.md");
        (dev.syncManager as any).dirtyPaths.set("notes/old.md", Date.now());

        const result = await dev.pushFile("notes/old.md");
        expect(result.pushed).toBe(true);
        expect(dev.getIndex("notes/old.md")).toBeUndefined();
        expect(dev.getLocalIndex("notes/old.md")).toBeUndefined();
    });

    it("should detect conflict when remote changed since last sync", async () => {
        const originalBuf = new TextEncoder().encode("original").buffer as ArrayBuffer;
        const uploaded = await cloud.uploadFile("notes/conflict.md", originalBuf, Date.now());

        dev.setupSyncedFile("notes/conflict.md", "original", uploaded.id);

        // Another device modifies remote
        const remoteBuf = new TextEncoder().encode("remote edit").buffer as ArrayBuffer;
        await cloud.uploadFile("notes/conflict.md", remoteBuf, Date.now());

        dev.editFile("notes/conflict.md", "local edit");

        const result = await dev.pushFile("notes/conflict.md");
        expect(result.conflictDetected).toBe(true);
    });

    it("should allow push of merged file (lastAction=merge)", async () => {
        const originalBuf = new TextEncoder().encode("original").buffer as ArrayBuffer;
        const uploaded = await cloud.uploadFile("notes/merged.md", originalBuf, Date.now());

        dev.setupSyncedFile("notes/merged.md", "original", uploaded.id);

        dev.editFile("notes/merged.md", "merged content");
        const sm = dev.syncManager as any;
        sm.localIndex["notes/merged.md"].lastAction = "merge";

        // Remote may have changed
        const remoteBuf = new TextEncoder().encode("remote version").buffer as ArrayBuffer;
        await cloud.uploadFile("notes/merged.md", remoteBuf, Date.now());

        const result = await dev.pushFile("notes/merged.md");
        expect(result.pushed).toBe(true);
        expect(result.conflictDetected).toBe(false);
    });

    it("should handle push for file with no prior remote existence", async () => {
        dev.app.vaultAdapter.setFile("notes/brand-new.md", "brand new content");
        (dev.syncManager as any).dirtyPaths.set("notes/brand-new.md", Date.now());

        const result = await dev.pushFile("notes/brand-new.md");
        expect(result.pushed).toBe(true);

        const idx = dev.getLocalIndex("notes/brand-new.md");
        expect(idx).toBeDefined();
        expect(idx!.lastAction).toBe("push");
    });

    it("should handle deletion when file does not exist locally and is not dirty", async () => {
        // File not in vault, not dirty → nothing to push
        const result = await dev.pushFile("notes/nonexistent.md");
        expect(result.pushed).toBe(false);
        expect(result.conflictDetected).toBe(false);
    });
});
