/**
 * Tests for file and folder move logic, including regressions for identified bugs.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { MockCloudAdapter } from "../../helpers/mock-cloud-adapter";
import { DeviceSimulator, hashOf } from "../../helpers/device-simulator";
import { md5 } from "../../../src/utils/md5";

describe("Move Logic Regressions", () => {
    let cloud: MockCloudAdapter;
    let device: DeviceSimulator;

    beforeEach(async () => {
        cloud = new MockCloudAdapter();
        device = new DeviceSimulator("Device", cloud, "dev_A");
        // Ensure standard settings
        (device.syncManager as any).settings.concurrency = 1;
        (device.syncManager as any).settings.notificationLevel = "standard";
    });

    /**
     * Case 1: Move to Root folder bug
     */
    it("should correctly move a file from a subfolder to the root folder", async () => {
        const oldPath = "sub/file.md";
        const newPath = "file.md";
        const content = "Hello Root";

        await cloud.ensureFoldersExist(["sub"]);
        await cloud.uploadFile(oldPath, new TextEncoder().encode(content).buffer, Date.now());
        const fileId = cloud.getFileId(oldPath)!;
        device.setupSyncedFile(oldPath, content, fileId);

        await device.app.vaultAdapter.rename(oldPath, newPath);
        device.syncManager.markRenamed(oldPath, newPath);

        await (device.syncManager as any).executeSmartSync();

        expect(cloud.getCloudContent(newPath)).toBe(content);
        expect(cloud.getCloudContent(oldPath)).toBeNull();

        const entry = device.getIndex(newPath);
        expect(entry).toBeDefined();
        expect(entry?.fileId).toBe(fileId);
        expect(entry?.lastAction).toBe("pull");
    });

    /**
     * Case 2: Recursive state cleanup + Edit preservation
     * Scenario: Edit file content, THEN move its parent folder.
     */
    it("should preserve content edits when the parent folder is moved", async () => {
        const oldFolder = "old";
        const newFolder = "new";
        const oldFile = "old/test.md";
        const newFile = "new/test.md";
        const originalContent = "Original";
        const editedContent = "Edited Content";

        await cloud.ensureFoldersExist([oldFolder]);
        await device.app.vaultAdapter.mkdir(oldFolder);

        await cloud.uploadFile(
            oldFile,
            new TextEncoder().encode(originalContent).buffer,
            Date.now(),
        );
        const fileId = cloud.getFileId(oldFile)!;
        device.setupSyncedFile(oldFile, originalContent, fileId);

        // Action: Edit file content locally
        device.editFile(oldFile, editedContent); // Makes it dirty

        // Action: Move the directory
        await device.app.vaultAdapter.rename(oldFolder, newFolder);
        device.syncManager.markFolderRenamed(oldFolder, newFolder);

        expect(device.getDirtyPaths().has(newFile)).toBe(true);

        await (device.syncManager as any).executeSmartSync();

        // Check if content was uploaded
        expect(cloud.getCloudContent(newFile)).toBe(editedContent);

        const entry = device.getIndex(newFile);

        expect(entry?.hash).toBe(hashOf(editedContent));
        expect(["push", "pull"]).toContain(entry?.lastAction);
    });

    /**
     * Case 3: Same-folder rename notification and Move API
     */
    it("should use Move API and show Rename notification for same-folder renames", async () => {
        const oldPath = "file.md";
        const newPath = "renamed.md";
        const content = "Same folder content";

        await cloud.uploadFile(oldPath, new TextEncoder().encode(content).buffer, Date.now());
        const fileId = cloud.getFileId(oldPath)!;
        device.setupSyncedFile(oldPath, content, fileId);

        await device.app.vaultAdapter.rename(oldPath, newPath);
        device.syncManager.markRenamed(oldPath, newPath);

        const notifySpy = vi.spyOn(device.syncManager, "notify");

        await (device.syncManager as any).executeSmartSync();

        expect(notifySpy).toHaveBeenCalledWith(
            "noticeFileRenamed",
            expect.stringContaining("file.md -> renamed.md"),
        );

        expect(cloud.getCloudContent(newPath)).toBe(content);
        expect(cloud.getFileId(newPath)).toBe(fileId);

        const entry = device.getIndex(newPath);
        expect(entry?.lastAction).toBe("pull");
    });

    /**
     * Case 4: Changes API echo guard
     */
    it("should prioritize local move over DIFFERENT remote Changes API move", async () => {
        const oldPath = "conflict.md";
        const localNewPath = "locally-moved.md";
        const remoteNewPath = "remote-moved.md";

        await cloud.uploadFile(oldPath, new TextEncoder().encode("data").buffer, Date.now());
        const fileId = cloud.getFileId(oldPath)!;
        device.setupSyncedFile(oldPath, "data", fileId);

        await device.uploadIndex();

        // 1. Local action: Rename
        await device.app.vaultAdapter.rename(oldPath, localNewPath);
        device.syncManager.markRenamed(oldPath, localNewPath);

        // 2. Simulate Remote Change: Move on cloud to a DIFFERENT path
        await cloud.moveFile(fileId, "remote-moved.md", "");

        // 3. Sync
        await (device.syncManager as any).executeSmartSync();

        // 4. Verify: Skip log exists
        const logNames = device.logs.join("\n");
        expect(logNames).toMatch(/Remote Rename skipped|Skipping auto-rename for remote move/);

        expect(await device.app.vaultAdapter.exists(localNewPath)).toBe(true);
        expect(await device.app.vaultAdapter.exists(remoteNewPath)).toBe(false);
    });

    /**
     * Case 5: Icon spinning behavior
     */
    it("should trigger activity indicators for move-only operations", async () => {
        const path = "spin.md";
        const newPath = "spun.md";

        await cloud.uploadFile(path, new TextEncoder().encode("test").buffer, Date.now());
        const fileId = cloud.getFileId(path)!;
        device.setupSyncedFile(path, "test", fileId);

        await device.app.vaultAdapter.rename(path, newPath);
        device.syncManager.markRenamed(path, newPath);

        const startSpy = vi.fn();
        (device.syncManager as any).onActivityStart = startSpy;

        await (device.syncManager as any).executeSmartSync();

        expect(startSpy).toHaveBeenCalled();
    });

    /**
     * Case 6: Post-Push Pull Triggering
     */
    it("should trigger post-push confirmation pull even for move-only operations", async () => {
        const path = "confirm.md";
        const newPath = "confirmed.md";

        await cloud.uploadFile(path, new TextEncoder().encode("v1").buffer, Date.now());
        const fileId = cloud.getFileId(path)!;
        device.setupSyncedFile(path, "v1", fileId);

        await device.app.vaultAdapter.rename(path, newPath);
        device.syncManager.markRenamed(path, newPath);

        device.clearLogs();

        await (device.syncManager as any).executeSmartSync();

        const pullStarted = device.logs.some((l) =>
            l.includes("[Post-Push Pull] Starting confirmation pull"),
        );
        expect(pullStarted).toBe(true);
    });

    /**
     * Case 7: Edit File -> Move File -> Push
     */
    it("should handle 'Edit -> Move -> Push' in a single sync cycle", async () => {
        const oldPath = "edit-move.md";
        const newPath = "edit-moved-final.md";
        const originalContent = "Original";
        const editedContent = "Edited Content";

        await cloud.uploadFile(
            oldPath,
            new TextEncoder().encode(originalContent).buffer,
            Date.now(),
        );
        const fileId = cloud.getFileId(oldPath)!;
        device.setupSyncedFile(oldPath, originalContent, fileId);

        // 1. Edit
        device.editFile(oldPath, editedContent);
        // 2. Move
        await device.app.vaultAdapter.rename(oldPath, newPath);
        device.syncManager.markRenamed(oldPath, newPath);

        await (device.syncManager as any).executeSmartSync();

        expect(cloud.getCloudContent(newPath)).toBe(editedContent);
        expect(cloud.getCloudContent(oldPath)).toBeNull();
        expect(device.getIndex(newPath)?.hash).toBe(hashOf(editedContent));
    });

    /**
     * Case 8: Move File -> Edit File -> Push
     */
    it("should handle 'Move -> Edit -> Push' in a single sync cycle", async () => {
        const oldPath = "move-edit.md";
        const newPath = "move-edited-final.md";
        const originalContent = "Original";
        const editedContent = "Edited Content";

        await cloud.uploadFile(
            oldPath,
            new TextEncoder().encode(originalContent).buffer,
            Date.now(),
        );
        const fileId = cloud.getFileId(oldPath)!;
        device.setupSyncedFile(oldPath, originalContent, fileId);

        // 1. Move
        await device.app.vaultAdapter.rename(oldPath, newPath);
        device.syncManager.markRenamed(oldPath, newPath);
        // 2. Edit (at new path)
        device.editFile(newPath, editedContent);

        await (device.syncManager as any).executeSmartSync();

        expect(cloud.getCloudContent(newPath)).toBe(editedContent);
        expect(cloud.getCloudContent(oldPath)).toBeNull();
        expect(device.getIndex(newPath)?.hash).toBe(hashOf(editedContent));
    });
});
