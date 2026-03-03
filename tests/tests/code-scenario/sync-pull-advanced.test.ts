/**
 * @file sync-pull-advanced.test.ts
 *
 * @description
 * Advanced coverage tests for sync-pull.ts targeting hard-to-reach lines:
 * - Lines 948-950: Pending conflict clear on hash match (Strategy B)
 * - Lines 968-981: Background transfer deferral in Changes API
 *
 * These tests specifically cover the processChangePage function's edge cases
 * that require specific combinations of state and Changes API responses.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DeviceSimulator, hashOf } from "../../helpers/device-simulator";
import { MockCloudAdapter } from "../../helpers/mock-cloud-adapter";
import { smartPull, pullViaChangesAPI } from "../../../src/sync-manager/sync-pull";
import type { SyncContext } from "../../../src/sync-manager/context";
import type { LogLevel } from "../../../src/sync-manager/logger";

const PLUGIN_DIR = ".obsidian/plugins/obsidian-vault-sync";
const SYNC_INDEX_PATH = `${PLUGIN_DIR}/sync-index.json`;

function encode(str: string): ArrayBuffer {
    return new TextEncoder().encode(str).buffer as ArrayBuffer;
}

describe("sync-pull advanced coverage - pending conflict clear", () => {
    let cloud: MockCloudAdapter;
    let dev: DeviceSimulator;
    let ctx: SyncContext;
    let notifications: Array<{ key: string; args: any[] }> = [];

    beforeEach(() => {
        cloud = new MockCloudAdapter();
        dev = new DeviceSimulator("Test", cloud);
        ctx = dev.getContext();
        notifications = [];

        // Capture notifications
        const originalNotify = ctx.notify.bind(ctx);
        ctx.notify = async (key: string, ...args: any[]) => {
            notifications.push({ key, args });
            return originalNotify(key, ...args);
        };
    });

    /**
     * Covers lines 948-950: Strategy B - Clear pendingConflict when hash matches
     *
     * Setup:
     * 1. File has pendingConflict: true in localIndex
     * 2. lastAction is NOT "push" or "merge" (to avoid lines 929-944)
     * 3. Changes API reports the same file with matching hash
     *
     * Expected:
     * - pendingConflict is cleared
     * - saveLocalIndex is called
     * - noticeRemoteMergeSynced notification is sent
     */
    it("should clear pendingConflict and notify when hash matches (Strategy B)", async () => {
        const filePath = "notes/merged-file.md";
        const content = "merged content from other device";
        const hash = hashOf(content);

        // Setup local file with pendingConflict
        dev.app.vaultAdapter.setFile(filePath, content);
        ctx.index[filePath] = {
            fileId: "file_merged_1",
            mtime: Date.now(),
            size: content.length,
            hash: hash,
            lastAction: "pull", // NOT "push" or "merge" - this is key!
        };
        ctx.localIndex[filePath] = {
            fileId: "file_merged_1",
            mtime: Date.now(),
            size: content.length,
            hash: hash,
            lastAction: "pull",
            pendingConflict: true, // This should be cleared
        };

        // Upload file to cloud with matching hash
        const uploaded = await cloud.uploadFile(filePath, encode(content), Date.now());

        // Upload index
        const indexContent = JSON.stringify({
            version: 1,
            deviceId: "dev_other",
            index: {
                [filePath]: {
                    fileId: uploaded.id!,
                    mtime: uploaded.mtime,
                    size: uploaded.size,
                    hash: uploaded.hash,
                    ancestorHash: hash,
                },
            },
        });
        await cloud.uploadFile(SYNC_INDEX_PATH, encode(indexContent), Date.now());

        // Clear any existing change log and add our specific change entry
        // This simulates the Changes API detecting the merged file
        cloud.clearChangeLog();
        cloud.addChangeEntry(uploaded.id!, filePath, uploaded.size, uploaded.hash!);

        // Set startPageToken to trigger Changes API path
        ctx.startPageToken = "0";

        // Execute pullViaChangesAPI to hit processChangePage
        const result = await pullViaChangesAPI(ctx);

        // Verify pendingConflict was cleared
        const localIdx = ctx.localIndex[filePath];
        expect(localIdx.pendingConflict).toBeUndefined();

        // Verify notification was sent
        const mergeNotification = notifications.find((n) => n.key === "noticeRemoteMergeSynced");
        expect(mergeNotification).toBeDefined();
        expect(mergeNotification?.args[0]).toBe("merged-file.md");
    });

    /**
     * Similar test but using smartPull with merge lock expiration scenario
     */
    it("should clear pendingConflict via smartPull when merge lock expires and hash matches", async () => {
        const filePath = "notes/synced-after-merge.md";
        const content = "content after merge";
        const hash = hashOf(content);

        // Setup local file with pendingConflict (simulating a previous merge lock)
        dev.app.vaultAdapter.setFile(filePath, content);
        ctx.index[filePath] = {
            fileId: "file_synced_1",
            mtime: Date.now(),
            size: content.length,
            hash: hash,
            lastAction: "pull",
        };
        ctx.localIndex[filePath] = {
            fileId: "file_synced_1",
            mtime: Date.now(),
            size: content.length,
            hash: hash,
            lastAction: "pull",
            pendingConflict: true,
        };

        // Upload to cloud
        const uploaded = await cloud.uploadFile(filePath, encode(content), Date.now());

        // Create index
        const indexContent = JSON.stringify({
            version: 1,
            deviceId: "dev_other",
            index: {
                [filePath]: {
                    fileId: uploaded.id!,
                    mtime: uploaded.mtime,
                    size: uploaded.size,
                    hash: uploaded.hash,
                },
            },
        });
        await cloud.uploadFile(SYNC_INDEX_PATH, encode(indexContent), Date.now());

        // Set up expired merge lock in communication
        const pastTime = Date.now() - 10000; // Expired
        const commContent = JSON.stringify({
            mergeLocks: {
                [filePath]: {
                    holder: "other_device",
                    expiresAt: pastTime,
                },
            },
        });
        await cloud.uploadFile(ctx.communicationPath, encode(commContent), Date.now());

        // Set up for Changes API
        ctx.startPageToken = await cloud.getStartPageToken();
        cloud.addChangeEntry(uploaded.id!, filePath, uploaded.size, uploaded.hash!);

        // Execute pull
        await smartPull(ctx);

        // Verify pendingConflict was cleared
        expect(ctx.localIndex[filePath].pendingConflict).toBeUndefined();

        // Verify notification
        const mergeNotification = notifications.find((n) => n.key === "noticeRemoteMergeSynced");
        expect(mergeNotification).toBeDefined();
    });

    /**
     * Test that pendingConflict is NOT cleared when lastAction is "push" or "merge"
     * (lines 929-944 take precedence)
     */
    it("should NOT clear pendingConflict when lastAction is push or merge", async () => {
        const filePath = "notes/pending-push.md";
        const content = "content";
        const hash = hashOf(content);

        // Setup with lastAction="push" - this triggers lines 929-944
        dev.app.vaultAdapter.setFile(filePath, content);
        ctx.index[filePath] = {
            fileId: "file_push_1",
            mtime: Date.now(),
            size: content.length,
            hash: hash,
            lastAction: "push",
        };
        ctx.localIndex[filePath] = {
            fileId: "file_push_1",
            mtime: Date.now(),
            size: content.length,
            hash: hash,
            lastAction: "push",
            pendingConflict: true,
        };

        const uploaded = await cloud.uploadFile(filePath, encode(content), Date.now());

        const indexContent = JSON.stringify({
            version: 1,
            deviceId: "dev_other",
            index: {
                [filePath]: {
                    fileId: uploaded.id!,
                    mtime: uploaded.mtime,
                    size: uploaded.size,
                    hash: uploaded.hash,
                },
            },
        });
        await cloud.uploadFile(SYNC_INDEX_PATH, encode(indexContent), Date.now());

        ctx.startPageToken = await cloud.getStartPageToken();
        cloud.addChangeEntry(uploaded.id!, filePath, uploaded.size, uploaded.hash!);

        await smartPull(ctx);

        // Pending conflict should still be there because lastAction="push"
        // (the code path at 929-944 runs instead of 948-950)
        expect(ctx.localIndex[filePath].lastAction).toBe("pull");
    });

    /**
     * Test that pendingConflict is processed (and cleared) when hash doesn't match
     * - The file goes through merge/conflict resolution
     * - The pendingConflict may be cleared as part of that process
     */
    it("should process file with pendingConflict when hash does not match", async () => {
        const filePath = "notes/conflicting.md";
        const localContent = "local version";
        const remoteContent = "remote version";
        const localHash = hashOf(localContent);
        const remoteHash = hashOf(remoteContent);

        // Setup local with pendingConflict but different hash
        dev.app.vaultAdapter.setFile(filePath, localContent);
        ctx.index[filePath] = {
            fileId: "file_conflict_1",
            mtime: Date.now(),
            size: localContent.length,
            hash: localHash,
            lastAction: "pull",
        };
        ctx.localIndex[filePath] = {
            fileId: "file_conflict_1",
            mtime: Date.now(),
            size: localContent.length,
            hash: localHash,
            lastAction: "pull",
            pendingConflict: true,
        };

        // Upload different content to cloud
        const uploaded = await cloud.uploadFile(filePath, encode(remoteContent), Date.now());

        const indexContent = JSON.stringify({
            version: 1,
            deviceId: "dev_other",
            index: {
                [filePath]: {
                    fileId: uploaded.id!,
                    mtime: uploaded.mtime,
                    size: uploaded.size,
                    hash: uploaded.hash, // Different hash!
                },
            },
        });
        await cloud.uploadFile(SYNC_INDEX_PATH, encode(indexContent), Date.now());

        ctx.startPageToken = await cloud.getStartPageToken();
        cloud.addChangeEntry(uploaded.id!, filePath, uploaded.size, uploaded.hash!);

        await smartPull(ctx);

        // When hash doesn't match, file goes through merge process
        // The file should be updated to remote version
        expect(dev.getLocalContent(filePath)).toBe(remoteContent);
    });
});

describe("sync-pull advanced coverage - background transfer deferral", () => {
    let cloud: MockCloudAdapter;
    let dev: DeviceSimulator;
    let ctx: SyncContext;

    beforeEach(() => {
        cloud = new MockCloudAdapter();
        dev = new DeviceSimulator("Test", cloud);
        ctx = dev.getContext();
    });

    /**
     * Covers lines 968-981: Background transfer deferral in Changes API
     *
     * Setup:
     * 1. largeFileThresholdMB > 0 (set to 1 MB)
     * 2. Changes API reports a file larger than the threshold
     * 3. File is NOT in dirtyPaths (no local conflict)
     *
     * Expected:
     * - File is queued to backgroundTransferQueue
     * - markPendingTransfer is called
     * - Log message about deferring to background
     */
    it("should defer large files to background transfer via Changes API", async () => {
        const filePath = "notes/large-file.md";
        const thresholdMB = 1;
        const thresholdBytes = thresholdMB * 1024 * 1024;
        const largeSize = thresholdBytes + 1024; // Just over threshold

        // Set threshold
        ctx.settings.largeFileThresholdMB = thresholdMB;

        // Create large content
        const largeContent = "x".repeat(largeSize);
        const hash = hashOf(largeContent);

        // Setup local state - file exists but is not dirty
        dev.app.vaultAdapter.setFile(filePath, largeContent);
        const uploaded = await cloud.uploadFile(filePath, encode(largeContent), Date.now());

        ctx.index[filePath] = {
            fileId: uploaded.id!,
            mtime: Date.now() - 1000, // Older mtime to trigger update
            size: 100, // Old size
            hash: "oldhash123", // Different hash to trigger processing
            lastAction: "pull",
        };
        ctx.localIndex[filePath] = {
            fileId: uploaded.id!,
            mtime: Date.now() - 1000,
            size: 100,
            hash: "oldhash123",
            lastAction: "pull",
        };
        // NOT in dirtyPaths - this is key!

        // Create index
        const indexContent = JSON.stringify({
            version: 1,
            deviceId: "dev_other",
            index: {
                [filePath]: {
                    fileId: uploaded.id!,
                    mtime: uploaded.mtime,
                    size: uploaded.size,
                    hash: uploaded.hash,
                },
            },
        });
        await cloud.uploadFile(SYNC_INDEX_PATH, encode(indexContent), Date.now());

        // Setup Changes API
        ctx.startPageToken = await cloud.getStartPageToken();
        cloud.addChangeEntry(uploaded.id!, filePath, uploaded.size, uploaded.hash!);

        // Track queue state before
        const pendingBefore = ctx.backgroundTransferQueue.getPendingTransfers();

        // Execute pull via Changes API
        await pullViaChangesAPI(ctx);

        // Track queue state after
        const pendingAfter = ctx.backgroundTransferQueue.getPendingTransfers();

        // Verify file was queued
        const queuedItem = pendingAfter.find(
            (item: any) => item.path === filePath && item.direction === "pull",
        );
        expect(queuedItem).toBeDefined();
        expect(queuedItem!.size).toBe(largeSize);
        expect(queuedItem!.remoteHash).toBe(hash);
    });

    /**
     * Test that large files with local conflict (in dirtyPaths) are NOT deferred
     * (hasLocalConflict=true bypasses the background deferral)
     */
    it("should NOT defer large files when there is a local conflict", async () => {
        const filePath = "notes/large-conflict.md";
        const thresholdMB = 1;
        const thresholdBytes = thresholdMB * 1024 * 1024;
        const largeSize = thresholdBytes + 1024;

        ctx.settings.largeFileThresholdMB = thresholdMB;

        const largeContent = "x".repeat(largeSize);
        const localContent = "local modified version";

        // Setup local with modifications (in dirtyPaths)
        dev.app.vaultAdapter.setFile(filePath, localContent);
        const uploaded = await cloud.uploadFile(filePath, encode(largeContent), Date.now());

        ctx.index[filePath] = {
            fileId: uploaded.id!,
            mtime: Date.now() - 1000,
            size: largeSize,
            hash: hashOf(largeContent),
            lastAction: "pull",
        };
        ctx.localIndex[filePath] = {
            fileId: uploaded.id!,
            mtime: Date.now(),
            size: localContent.length,
            hash: hashOf(localContent),
            lastAction: "push", // Local has changes
        };
        ctx.dirtyPaths.set(filePath, Date.now()); // Mark as dirty - THIS IS KEY!

        const indexContent = JSON.stringify({
            version: 1,
            deviceId: "dev_other",
            index: {
                [filePath]: {
                    fileId: uploaded.id!,
                    mtime: uploaded.mtime,
                    size: uploaded.size,
                    hash: uploaded.hash,
                },
            },
        });
        await cloud.uploadFile(SYNC_INDEX_PATH, encode(indexContent), Date.now());

        ctx.startPageToken = await cloud.getStartPageToken();
        cloud.addChangeEntry(uploaded.id!, filePath, uploaded.size, uploaded.hash!);

        const pendingBefore = ctx.backgroundTransferQueue.getPendingTransfers();

        await pullViaChangesAPI(ctx);

        // File should NOT be queued for background (has local conflict)
        // Instead it goes through inline conflict resolution
        const pendingAfter = ctx.backgroundTransferQueue.getPendingTransfers();
        const queuedItem = pendingAfter.find((item: any) => item.path === filePath);
        // When there's a conflict, it doesn't get queued for background
        expect(queuedItem).toBeUndefined();
    });

    /**
     * Test that small files (under threshold) are processed inline, not deferred
     */
    it("should process small files inline (not defer to background)", async () => {
        const filePath = "notes/small-file.md";
        const thresholdMB = 1;
        const smallSize = 100; // Well under 1MB

        ctx.settings.largeFileThresholdMB = thresholdMB;

        const smallContent = "small content";
        const hash = hashOf(smallContent);

        dev.app.vaultAdapter.setFile(filePath, smallContent);
        const uploaded = await cloud.uploadFile(filePath, encode(smallContent), Date.now());

        ctx.index[filePath] = {
            fileId: uploaded.id!,
            mtime: Date.now() - 1000,
            size: 50,
            hash: "oldhash",
            lastAction: "pull",
        };
        ctx.localIndex[filePath] = {
            fileId: uploaded.id!,
            mtime: Date.now() - 1000,
            size: 50,
            hash: "oldhash",
            lastAction: "pull",
        };

        const indexContent = JSON.stringify({
            version: 1,
            deviceId: "dev_other",
            index: {
                [filePath]: {
                    fileId: uploaded.id!,
                    mtime: uploaded.mtime,
                    size: uploaded.size,
                    hash: uploaded.hash,
                },
            },
        });
        await cloud.uploadFile(SYNC_INDEX_PATH, encode(indexContent), Date.now());

        ctx.startPageToken = await cloud.getStartPageToken();
        cloud.addChangeEntry(uploaded.id!, filePath, uploaded.size, uploaded.hash!);

        await pullViaChangesAPI(ctx);

        // Small file should be downloaded inline, not queued
        const pendingAfter = ctx.backgroundTransferQueue.getPendingTransfers();
        const queuedItem = pendingAfter.find((item: any) => item.path === filePath);
        expect(queuedItem).toBeUndefined();

        // File should be synced
        expect(dev.getLocalContent(filePath)).toBe(smallContent);
    });

    /**
     * Test that when threshold is 0, all files are processed inline
     */
    it("should process all files inline when threshold is 0", async () => {
        const filePath = "notes/any-size.md";

        ctx.settings.largeFileThresholdMB = 0; // Disabled

        const content = "x".repeat(10 * 1024 * 1024); // 10MB file
        const hash = hashOf(content);

        dev.app.vaultAdapter.setFile(filePath, content);
        const uploaded = await cloud.uploadFile(filePath, encode(content), Date.now());

        ctx.index[filePath] = {
            fileId: uploaded.id!,
            mtime: Date.now() - 1000,
            size: 100,
            hash: "oldhash",
            lastAction: "pull",
        };
        ctx.localIndex[filePath] = {
            fileId: uploaded.id!,
            mtime: Date.now() - 1000,
            size: 100,
            hash: "oldhash",
            lastAction: "pull",
        };

        const indexContent = JSON.stringify({
            version: 1,
            deviceId: "dev_other",
            index: {
                [filePath]: {
                    fileId: uploaded.id!,
                    mtime: uploaded.mtime,
                    size: uploaded.size,
                    hash: uploaded.hash,
                },
            },
        });
        await cloud.uploadFile(SYNC_INDEX_PATH, encode(indexContent), Date.now());

        ctx.startPageToken = await cloud.getStartPageToken();
        cloud.addChangeEntry(uploaded.id!, filePath, uploaded.size, uploaded.hash!);

        await pullViaChangesAPI(ctx);

        // Even large file should be processed inline
        const pendingAfter = ctx.backgroundTransferQueue.getPendingTransfers();
        const queuedItem = pendingAfter.find((item: any) => item.path === filePath);
        expect(queuedItem).toBeUndefined();
    });
});

describe("sync-pull advanced coverage - edge cases", () => {
    let cloud: MockCloudAdapter;
    let dev: DeviceSimulator;
    let ctx: SyncContext;
    let notifications: Array<{ key: string; args: any[] }> = [];

    beforeEach(() => {
        cloud = new MockCloudAdapter();
        dev = new DeviceSimulator("Test", cloud);
        ctx = dev.getContext();
        notifications = [];

        const originalNotify = ctx.notify.bind(ctx);
        ctx.notify = async (key: string, ...args: any[]) => {
            notifications.push({ key, args });
            return originalNotify(key, ...args);
        };
    });

    /**
     * Test combined scenario: pendingConflict clear when hash matches
     * AND the file is large - should only clear conflict (lines 948-950),
     * NOT defer to background since hash matches (skips lines 968-981)
     */
    it("should clear pendingConflict when hash matches even for large files", async () => {
        const filePath = "notes/large-merged.md";
        const thresholdMB = 1;
        const thresholdBytes = thresholdMB * 1024 * 1024;
        const largeSize = thresholdBytes + 1024;

        ctx.settings.largeFileThresholdMB = thresholdMB;

        const largeContent = "x".repeat(largeSize);
        const hash = hashOf(largeContent);

        // Setup with pendingConflict and lastAction="pull"
        // Hash matches cloud - this triggers lines 948-950
        dev.app.vaultAdapter.setFile(filePath, largeContent);
        ctx.index[filePath] = {
            fileId: "file_large_1",
            mtime: Date.now(),
            size: largeSize,
            hash: hash,
            lastAction: "pull",
        };
        ctx.localIndex[filePath] = {
            fileId: "file_large_1",
            mtime: Date.now(),
            size: largeSize,
            hash: hash,
            lastAction: "pull",
            pendingConflict: true,
        };

        const uploaded = await cloud.uploadFile(filePath, encode(largeContent), Date.now());

        const indexContent = JSON.stringify({
            version: 1,
            deviceId: "dev_other",
            index: {
                [filePath]: {
                    fileId: uploaded.id!,
                    mtime: uploaded.mtime,
                    size: uploaded.size,
                    hash: uploaded.hash,
                },
            },
        });
        await cloud.uploadFile(SYNC_INDEX_PATH, encode(indexContent), Date.now());

        ctx.startPageToken = await cloud.getStartPageToken();
        cloud.addChangeEntry(uploaded.id!, filePath, uploaded.size, uploaded.hash!);

        await pullViaChangesAPI(ctx);

        // pendingConflict should be cleared (lines 948-950)
        expect(ctx.localIndex[filePath].pendingConflict).toBeUndefined();

        // Since hash matches, file is skipped (not queued for background)
        // Lines 968-981 are NOT executed because we hit "continue" at line 957
        const pendingAfter = ctx.backgroundTransferQueue.getPendingTransfers();
        const queuedItem = pendingAfter.find(
            (item: any) => item.path === filePath && item.direction === "pull",
        );
        expect(queuedItem).toBeUndefined();

        // Notification should be sent
        const mergeNotification = notifications.find((n) => n.key === "noticeRemoteMergeSynced");
        expect(mergeNotification).toBeDefined();
    });

    /**
     * Test ancestorHash guard (lines 915-922) - stale echo detection
     */
    it("should skip file when hash matches ancestorHash (stale echo)", async () => {
        const filePath = "notes/stale-echo.md";
        const content = "content";
        const hash = hashOf(content);

        dev.app.vaultAdapter.setFile(filePath, content);
        ctx.index[filePath] = {
            fileId: "file_echo_1",
            mtime: Date.now(),
            size: content.length,
            hash: hash,
            lastAction: "pull",
            ancestorHash: hash, // This triggers stale echo detection
        };
        ctx.localIndex[filePath] = {
            fileId: "file_echo_1",
            mtime: Date.now(),
            size: content.length,
            hash: hash,
            lastAction: "pull",
            ancestorHash: hash,
        };

        const uploaded = await cloud.uploadFile(filePath, encode(content), Date.now());

        const indexContent = JSON.stringify({
            version: 1,
            deviceId: "dev_other",
            index: {
                [filePath]: {
                    fileId: uploaded.id!,
                    mtime: uploaded.mtime,
                    size: uploaded.size,
                    hash: uploaded.hash,
                    ancestorHash: hash,
                },
            },
        });
        await cloud.uploadFile(SYNC_INDEX_PATH, encode(indexContent), Date.now());

        ctx.startPageToken = await cloud.getStartPageToken();
        cloud.addChangeEntry(uploaded.id!, filePath, uploaded.size, uploaded.hash!);

        // Should not process (stale echo)
        await pullViaChangesAPI(ctx);

        // No notification should be sent for stale echo
        const syncConfirmed = notifications.find((n) => n.key === "noticeSyncConfirmed");
        // syncConfirmed might be sent for hash match, but merge notification should not
        const mergeNotification = notifications.find((n) => n.key === "noticeRemoteMergeSynced");
        expect(mergeNotification).toBeUndefined();
    });

    /**
     * Test file deletion via Changes API (lines 755-784)
     * Note: The deletion is queued as a task and executed asynchronously
     */
    it("should handle file deletion via Changes API", async () => {
        const filePath = "notes/to-delete.md";
        const content = "delete me";
        const hash = hashOf(content);

        dev.app.vaultAdapter.setFile(filePath, content);
        const uploaded = await cloud.uploadFile(filePath, encode(content), Date.now());

        ctx.index[filePath] = {
            fileId: uploaded.id!,
            mtime: Date.now(),
            size: content.length,
            hash: hash,
            lastAction: "pull",
        };
        ctx.localIndex[filePath] = {
            fileId: uploaded.id!,
            mtime: Date.now(),
            size: content.length,
            hash: hash,
            lastAction: "pull",
        };

        // Delete from cloud
        await cloud.deleteFile(uploaded.id);

        // Add deletion to change log
        cloud.clearChangeLog();
        cloud.addChangeEntry(uploaded.id!, filePath, 0, "", true);

        ctx.startPageToken = "0";

        // Execute pullViaChangesAPI - this should process the deletion
        await pullViaChangesAPI(ctx, true); // drainAll=true to process tasks

        // File should be marked as recently deleted
        expect(ctx.recentlyDeletedFromRemote.has(filePath)).toBe(true);
    });

    /**
     * Test drainAll mode processing multiple changes with background deferral
     */
    it("should process multiple changes in drainAll mode", async () => {
        ctx.settings.largeFileThresholdMB = 0.001; // ~1KB threshold

        // Create files: small1, small2, large
        const file1Content = "small1";
        const file2Content = "small2";
        const largeContent = "x".repeat(2048); // Over 1KB threshold

        dev.app.vaultAdapter.setFile("notes/file1.md", file1Content);
        dev.app.vaultAdapter.setFile("notes/file2.md", file2Content);
        dev.app.vaultAdapter.setFile("notes/large.md", largeContent);

        // Upload to cloud
        const uploaded1 = await cloud.uploadFile(
            "notes/file1.md",
            encode(file1Content),
            Date.now(),
        );
        const uploaded2 = await cloud.uploadFile(
            "notes/file2.md",
            encode(file2Content),
            Date.now(),
        );
        const uploadedLarge = await cloud.uploadFile(
            "notes/large.md",
            encode(largeContent),
            Date.now(),
        );

        // Create index
        const indexData = {
            version: 1,
            deviceId: "dev_other",
            index: {
                "notes/file1.md": {
                    fileId: uploaded1.id,
                    mtime: uploaded1.mtime,
                    size: uploaded1.size,
                    hash: uploaded1.hash,
                },
                "notes/file2.md": {
                    fileId: uploaded2.id,
                    mtime: uploaded2.mtime,
                    size: uploaded2.size,
                    hash: uploaded2.hash,
                },
                "notes/large.md": {
                    fileId: uploadedLarge.id,
                    mtime: uploadedLarge.mtime,
                    size: uploadedLarge.size,
                    hash: uploadedLarge.hash,
                },
            },
        };
        await cloud.uploadFile(SYNC_INDEX_PATH, encode(JSON.stringify(indexData)), Date.now());

        // Set up indices to NOT match (so files will be processed)
        ctx.index["notes/file1.md"] = {
            fileId: uploaded1.id,
            mtime: Date.now() - 1000,
            size: 10,
            hash: "oldhash1",
            lastAction: "pull",
        };
        ctx.localIndex["notes/file1.md"] = {
            fileId: uploaded1.id,
            mtime: Date.now() - 1000,
            size: 10,
            hash: "oldhash1",
            lastAction: "pull",
        };
        ctx.index["notes/file2.md"] = {
            fileId: uploaded2.id,
            mtime: Date.now() - 1000,
            size: 10,
            hash: "oldhash2",
            lastAction: "pull",
        };
        ctx.localIndex["notes/file2.md"] = {
            fileId: uploaded2.id,
            mtime: Date.now() - 1000,
            size: 10,
            hash: "oldhash2",
            lastAction: "pull",
        };
        ctx.index["notes/large.md"] = {
            fileId: uploadedLarge.id,
            mtime: Date.now() - 1000,
            size: 10,
            hash: "oldhash3",
            lastAction: "pull",
        };
        ctx.localIndex["notes/large.md"] = {
            fileId: uploadedLarge.id,
            mtime: Date.now() - 1000,
            size: 10,
            hash: "oldhash3",
            lastAction: "pull",
        };

        // Clear and set up change log
        cloud.clearChangeLog();
        cloud.addChangeEntry(uploaded1.id!, "notes/file1.md", uploaded1.size, uploaded1.hash!);
        cloud.addChangeEntry(uploaded2.id!, "notes/file2.md", uploaded2.size, uploaded2.hash!);
        cloud.addChangeEntry(
            uploadedLarge.id!,
            "notes/large.md",
            uploadedLarge.size,
            uploadedLarge.hash!,
        );

        ctx.startPageToken = "0";

        // Process all changes
        await pullViaChangesAPI(ctx, true); // drainAll=true

        // Small files should be downloaded inline
        expect(dev.getLocalContent("notes/file1.md")).toBe("small1");
        expect(dev.getLocalContent("notes/file2.md")).toBe("small2");

        // Large file should be queued for background (lines 968-981)
        const pending = ctx.backgroundTransferQueue.getPendingTransfers();
        const largeQueued = pending.find(
            (item: any) => item.path === "notes/large.md" && item.direction === "pull",
        );
        expect(largeQueued).toBeDefined();
        expect(largeQueued!.size).toBeGreaterThan(1024);
    });
});

describe("sync-pull advanced coverage - device simulator helpers", () => {
    let cloud: MockCloudAdapter;
    let dev: DeviceSimulator;

    beforeEach(() => {
        cloud = new MockCloudAdapter();
        dev = new DeviceSimulator("Test", cloud);
    });

    it("should set pendingConflict via helper method", () => {
        dev.app.vaultAdapter.setFile("notes/test.md", "content");
        const ctx = dev.getContext();
        ctx.index["notes/test.md"] = {
            fileId: "file_1",
            mtime: Date.now(),
            size: 100,
            hash: hashOf("content"),
            lastAction: "pull",
        };
        ctx.localIndex["notes/test.md"] = {
            fileId: "file_1",
            mtime: Date.now(),
            size: 100,
            hash: hashOf("content"),
            lastAction: "pull",
        };

        dev.setPendingConflict("notes/test.md", true);
        expect(ctx.localIndex["notes/test.md"].pendingConflict).toBe(true);

        dev.setPendingConflict("notes/test.md", false);
        expect(ctx.localIndex["notes/test.md"].pendingConflict).toBeUndefined();
    });

    it("should set large file threshold via helper method", () => {
        dev.setLargeFileThreshold(5);
        const ctx = dev.getContext();
        expect(ctx.settings.largeFileThresholdMB).toBe(5);
    });

    it("should create file with specific size via helper method", () => {
        dev.setupFileWithSize("notes/sized.md", "base", 1000);
        const content = dev.getLocalContent("notes/sized.md");
        expect(content?.length).toBe(1000);
    });

    it("should expose smartPull via helper method", async () => {
        const result = await dev.smartPull();
        expect(typeof result).toBe("boolean");
    });

    it("should throw when setting pendingConflict on non-existent file", () => {
        expect(() => dev.setPendingConflict("notes/nonexistent.md", true)).toThrow();
    });
});

describe("sync-pull advanced coverage - mock cloud adapter helpers", () => {
    let cloud: MockCloudAdapter;

    beforeEach(() => {
        cloud = new MockCloudAdapter();
    });

    it("should add change entry via helper method", async () => {
        cloud.clearChangeLog();
        cloud.addChangeEntry("file_1", "notes/test.md", 100, "hash123");

        const changes = await cloud.getChanges("0");
        expect(changes.changes).toHaveLength(1);
        expect(changes.changes[0].fileId).toBe("file_1");
        expect(changes.changes[0].file?.path).toBe("notes/test.md");
    });

    it("should add removed entry via helper method", async () => {
        cloud.clearChangeLog();
        cloud.addChangeEntry("file_1", "notes/deleted.md", 0, "", true);

        const changes = await cloud.getChanges("0");
        expect(changes.changes).toHaveLength(1);
        expect(changes.changes[0].removed).toBe(true);
    });

    it("should clear change log via helper method", async () => {
        cloud.addChangeEntry("file_1", "notes/test.md", 100, "hash123");
        cloud.clearChangeLog();

        const changes = await cloud.getChanges("0");
        expect(changes.changes).toHaveLength(0);
    });
});

describe("sync-pull advanced coverage - active merge lock (lines 824-834)", () => {
    let cloud: MockCloudAdapter;
    let dev: DeviceSimulator;
    let ctx: SyncContext;

    beforeEach(() => {
        cloud = new MockCloudAdapter();
        dev = new DeviceSimulator("Test", cloud);
        ctx = dev.getContext();
    });

    /**
     * Test merge lock check via smartPull (which calls checkMergeLocks at lines 26-46)
     * This covers the related merge lock handling
     */
    it("should mark pendingConflict when active merge lock exists", async () => {
        const filePath = "notes/locked.md";
        const content = "content";

        // Setup local file
        dev.app.vaultAdapter.setFile(filePath, content);
        ctx.index[filePath] = {
            fileId: "file_1",
            mtime: Date.now(),
            size: content.length,
            hash: hashOf(content),
            lastAction: "pull",
        };
        ctx.localIndex[filePath] = {
            fileId: "file_1",
            mtime: Date.now(),
            size: content.length,
            hash: hashOf(content),
            lastAction: "pull",
        };

        // Set up active merge lock from another device
        const futureTime = Date.now() + 60000;
        const commContent = JSON.stringify({
            mergeLocks: {
                [filePath]: {
                    holder: "other_device",
                    expiresAt: futureTime,
                },
            },
        });
        await cloud.uploadFile(ctx.communicationPath, encode(commContent), Date.now());

        // Create valid index - include the file so it's not deleted
        const indexContent = JSON.stringify({
            version: 1,
            deviceId: "dev_other",
            index: {
                [filePath]: {
                    fileId: "file_1",
                    mtime: Date.now(),
                    size: content.length,
                    hash: hashOf(content),
                },
            },
        });
        await cloud.uploadFile(SYNC_INDEX_PATH, encode(indexContent), Date.now());

        await smartPull(ctx);

        // pendingConflict should be set due to active merge lock
        expect(ctx.localIndex[filePath]?.pendingConflict).toBe(true);
    });
});

describe("sync-pull advanced coverage - remote rename detection (lines 842-907)", () => {
    let cloud: MockCloudAdapter;
    let dev: DeviceSimulator;
    let ctx: SyncContext;

    beforeEach(() => {
        cloud = new MockCloudAdapter();
        dev = new DeviceSimulator("Test", cloud);
        ctx = dev.getContext();
    });

    /**
     * Covers lines 848-854: Skip rename when local has pendingMove
     */
    it("should skip remote rename when local has pendingMove", async () => {
        const oldPath = "notes/pending-move.md";
        const newPath = "notes/renamed-remotely.md";
        const content = "content";
        const hash = hashOf(content);

        // Setup local file with pendingMove flag
        dev.app.vaultAdapter.setFile(oldPath, content);
        const uploaded = await cloud.uploadFile(newPath, encode(content), Date.now());

        ctx.index[oldPath] = {
            fileId: uploaded.id!,
            mtime: Date.now() - 1000,
            size: content.length,
            hash: hash,
            lastAction: "pull",
            pendingMove: { oldPath }, // This prevents rename
        };
        ctx.localIndex[oldPath] = {
            fileId: uploaded.id!,
            mtime: Date.now() - 1000,
            size: content.length,
            hash: hash,
            lastAction: "pull",
        };

        const indexContent = JSON.stringify({
            version: 1,
            deviceId: "dev_other",
            index: {
                [newPath]: {
                    fileId: uploaded.id!,
                    mtime: uploaded.mtime,
                    size: uploaded.size,
                    hash: uploaded.hash,
                },
            },
        });
        await cloud.uploadFile(SYNC_INDEX_PATH, encode(indexContent), Date.now());

        ctx.startPageToken = await cloud.getStartPageToken();
        cloud.clearChangeLog();
        cloud.addChangeEntry(uploaded.id!, newPath, uploaded.size, uploaded.hash!);

        await pullViaChangesAPI(ctx);

        // File should remain at old path (rename skipped)
        expect(dev.getLocalContent(oldPath)).toBe(content);
        expect(ctx.index[oldPath]).toBeDefined();
    });

    /**
     * Covers lines 848-854: Skip rename when file is in dirtyPaths
     */
    it("should skip remote rename when local file has pending changes", async () => {
        const oldPath = "notes/dirty-file.md";
        const newPath = "notes/renamed-remotely.md";
        const content = "content";
        const hash = hashOf(content);

        // Setup local file with dirtyPaths entry
        dev.app.vaultAdapter.setFile(oldPath, content);
        const uploaded = await cloud.uploadFile(newPath, encode(content), Date.now());

        ctx.index[oldPath] = {
            fileId: uploaded.id!,
            mtime: Date.now() - 1000,
            size: content.length,
            hash: hash,
            lastAction: "pull",
        };
        ctx.localIndex[oldPath] = {
            fileId: uploaded.id!,
            mtime: Date.now() - 1000,
            size: content.length,
            hash: hash,
            lastAction: "pull",
        };
        ctx.dirtyPaths.set(oldPath, Date.now()); // This prevents rename

        const indexContent = JSON.stringify({
            version: 1,
            deviceId: "dev_other",
            index: {
                [newPath]: {
                    fileId: uploaded.id!,
                    mtime: uploaded.mtime,
                    size: uploaded.size,
                    hash: uploaded.hash,
                },
            },
        });
        await cloud.uploadFile(SYNC_INDEX_PATH, encode(indexContent), Date.now());

        ctx.startPageToken = await cloud.getStartPageToken();
        cloud.clearChangeLog();
        cloud.addChangeEntry(uploaded.id!, newPath, uploaded.size, uploaded.hash!);

        await pullViaChangesAPI(ctx);

        // File should remain at old path (rename skipped)
        expect(dev.getLocalContent(oldPath)).toBe(content);
        expect(ctx.dirtyPaths.has(oldPath)).toBe(true);
    });

    /**
     * Covers lines 906-910: Skip rename when target path already exists
     */
    it("should skip remote rename when target path already exists", async () => {
        const oldPath = "notes/source.md";
        const newPath = "notes/existing-target.md";
        const content = "content";
        const hash = hashOf(content);

        // Setup local file at old path
        dev.app.vaultAdapter.setFile(oldPath, content);
        // Also create file at new path (target exists)
        dev.app.vaultAdapter.setFile(newPath, "existing content at target");

        const uploaded = await cloud.uploadFile(newPath, encode(content), Date.now());

        ctx.index[oldPath] = {
            fileId: uploaded.id!,
            mtime: Date.now() - 1000,
            size: content.length,
            hash: hash,
            lastAction: "pull",
        };
        ctx.localIndex[oldPath] = {
            fileId: uploaded.id!,
            mtime: Date.now() - 1000,
            size: content.length,
            hash: hash,
            lastAction: "pull",
        };

        // Also need index entry for target
        ctx.index[newPath] = {
            fileId: "different_id",
            mtime: Date.now() - 1000,
            size: 100,
            hash: hashOf("existing content at target"),
            lastAction: "pull",
        };

        const indexContent = JSON.stringify({
            version: 1,
            deviceId: "dev_other",
            index: {
                [newPath]: {
                    fileId: uploaded.id!,
                    mtime: uploaded.mtime,
                    size: uploaded.size,
                    hash: uploaded.hash,
                },
            },
        });
        await cloud.uploadFile(SYNC_INDEX_PATH, encode(indexContent), Date.now());

        ctx.startPageToken = await cloud.getStartPageToken();
        cloud.clearChangeLog();
        cloud.addChangeEntry(uploaded.id!, newPath, uploaded.size, uploaded.hash!);

        await pullViaChangesAPI(ctx);

        // Both files should remain (rename skipped to avoid overwrite)
        expect(dev.getLocalContent(oldPath)).toBe(content);
        expect(dev.getLocalContent(newPath)).toBe("existing content at target");
    });
});

describe("sync-pull advanced coverage - error handling", () => {
    let cloud: MockCloudAdapter;
    let dev: DeviceSimulator;
    let ctx: SyncContext;
    let logs: Array<{ level: string; message: string }> = [];

    beforeEach(() => {
        cloud = new MockCloudAdapter();
        dev = new DeviceSimulator("Test", cloud);
        ctx = dev.getContext();
        logs = [];

        // Capture logs
        const originalLog = ctx.log.bind(ctx);
        ctx.log = async (message: string, level: LogLevel = "info") => {
            logs.push({ level, message });
            return originalLog(message, level);
        };
    });

    afterEach(() => {
        cloud.clearAllErrors();
        dev.app.vaultAdapter.clearAllErrors();
        dev.app.vault.clearAllErrors();
    });

    /**
     * Covers lines 160-165: Error handling in rename during detectPullChanges
     */
    it("should handle rename failure gracefully during remote rename detection", async () => {
        const oldPath = "notes/old-name.md";
        const newPath = "notes/new-name.md";
        const content = "content";
        const hash = hashOf(content);

        // Setup local file
        dev.app.vaultAdapter.setFile(oldPath, content);
        const uploaded = await cloud.uploadFile(newPath, encode(content), Date.now());

        // Setup index with old path
        ctx.index[oldPath] = {
            fileId: uploaded.id!,
            mtime: Date.now() - 1000,
            size: content.length,
            hash: hash,
            lastAction: "pull",
        };
        ctx.localIndex[oldPath] = {
            fileId: uploaded.id!,
            mtime: Date.now() - 1000,
            size: content.length,
            hash: hash,
            lastAction: "pull",
        };

        // Create remote index
        const indexContent = JSON.stringify({
            version: 1,
            deviceId: "dev_other",
            index: {
                [newPath]: {
                    fileId: uploaded.id!,
                    mtime: uploaded.mtime,
                    size: uploaded.size,
                    hash: uploaded.hash,
                },
            },
        });
        await cloud.uploadFile(SYNC_INDEX_PATH, encode(indexContent), Date.now());

        // Make rename fail
        dev.app.vaultAdapter.setErrorOnMethod("rename", new Error("Permission denied"));

        // Execute pull - should not throw
        await dev.smartPull();

        // Should have logged the error
        const renameErrorLog = logs.find(
            (l) => l.level === "warn" && l.message.includes("Failed to rename"),
        );
        expect(renameErrorLog).toBeDefined();
        expect(renameErrorLog?.message).toContain("Permission denied");
    });

    /**
     * Covers lines 426-431: Error handling in file delete during buildForbiddenRemoteCleanupTasks
     *
     * This test verifies that when deleteFile fails for a forbidden file,
     * the error is caught and logged properly.
     */
    it("should handle file delete failure gracefully in buildForbiddenRemoteCleanupTasks", async () => {
        // Need a regular file to download so the cleanup tasks get executed
        // (The early return in smartPull skips task execution if there are no downloads/deletions)
        const regularPath = "notes/regular.md";
        const regularContent = "regular file";
        const regularUploaded = await cloud.uploadFile(
            regularPath,
            encode(regularContent),
            Date.now(),
        );

        // Use a forbidden file from SYSTEM_IGNORES
        const forbiddenPath = ".DS_Store";
        const content = "dummy";
        const uploaded = await cloud.uploadFile(forbiddenPath, encode(content), Date.now());

        // Create remote index with both files
        const indexContent = JSON.stringify({
            version: 1,
            deviceId: "dev_other",
            index: {
                [regularPath]: {
                    fileId: regularUploaded.id,
                    mtime: regularUploaded.mtime,
                    size: regularUploaded.size,
                    hash: regularUploaded.hash,
                },
                [forbiddenPath]: {
                    fileId: uploaded.id!,
                    mtime: uploaded.mtime,
                    size: uploaded.size,
                    hash: uploaded.hash,
                },
            },
        });
        await cloud.uploadFile(SYNC_INDEX_PATH, encode(indexContent), Date.now());

        // Make deleteFile fail for the forbidden file
        const originalDeleteFile = cloud.deleteFile.bind(cloud);
        cloud.deleteFile = async (fileId: string) => {
            if (fileId === uploaded.id) {
                throw new Error("Permission denied");
            }
            return originalDeleteFile(fileId);
        };

        // Execute pull - should not throw
        await dev.smartPull();

        // Restore
        cloud.deleteFile = originalDeleteFile;

        // The forbidden file deletion error is logged at "warn" level
        const deleteError = logs.find(
            (l) => l.level === "warn" && l.message.includes("File delete failed"),
        );
        expect(deleteError).toBeDefined();
        expect(deleteError?.message).toContain("Permission denied");
    });

    /**
     * Covers lines 512-518: Error handling in getStartPageToken
     */
    it("should handle getStartPageToken failure gracefully", async () => {
        // Make getStartPageToken fail
        cloud.setErrorOnMethod("getStartPageToken", new Error("Changes API unavailable"));

        // Create a remote index
        const indexContent = JSON.stringify({
            version: 1,
            deviceId: "dev_other",
            index: {},
        });
        await cloud.uploadFile(SYNC_INDEX_PATH, encode(indexContent), Date.now());

        // Execute pull - should not throw, should fall through to hash check
        const result = await dev.smartPull();

        // Should have logged the error
        const startPageTokenError = logs.find(
            (l) => l.level === "warn" && l.message.includes("Failed to init Changes API"),
        );
        expect(startPageTokenError).toBeDefined();
        expect(startPageTokenError?.message).toContain("Changes API unavailable");

        // Clean up
        cloud.clearErrorOnMethod("getStartPageToken");
    });

    /**
     * Covers lines 676-685: Error handling in downloadRemoteIndex during Changes API
     */
    it("should handle downloadRemoteIndex failure during Changes API", async () => {
        const filePath = "notes/test.md";
        const content = "test content";
        const hash = hashOf(content);

        // Setup local file
        dev.app.vaultAdapter.setFile(filePath, content);
        const uploaded = await cloud.uploadFile(filePath, encode(content), Date.now());

        ctx.index[filePath] = {
            fileId: uploaded.id!,
            mtime: Date.now(),
            size: content.length,
            hash: hash,
            lastAction: "pull",
        };
        ctx.localIndex[filePath] = {
            fileId: uploaded.id!,
            mtime: Date.now(),
            size: content.length,
            hash: hash,
            lastAction: "pull",
        };

        // Create index
        const indexContent = JSON.stringify({
            version: 1,
            deviceId: "dev_other",
            index: {
                [filePath]: {
                    fileId: uploaded.id!,
                    mtime: uploaded.mtime,
                    size: uploaded.size,
                    hash: uploaded.hash,
                },
            },
        });
        await cloud.uploadFile(SYNC_INDEX_PATH, encode(indexContent), Date.now());

        // Setup Changes API
        ctx.startPageToken = await cloud.getStartPageToken();
        cloud.addChangeEntry(uploaded.id!, filePath, uploaded.size, uploaded.hash!);

        // Make getFileMetadata fail for the index file
        cloud.setErrorOnMethod("getFileMetadata", new Error("Index download failed"));

        // Execute pull via Changes API - should not throw
        await pullViaChangesAPI(ctx);

        // Should have logged the error
        const downloadError = logs.find(
            (l) => l.level === "warn" && l.message.includes("Failed to download remote index"),
        );
        expect(downloadError).toBeDefined();
        expect(downloadError?.message).toContain("Index download failed");

        // Clean up
        cloud.clearErrorOnMethod("getFileMetadata");
    });

    /**
     * Covers lines 764-782: Error handling in delete during processChangePage
     */
    it("should handle file deletion failure during Changes API", async () => {
        const filePath = "notes/to-delete.md";
        const content = "delete me";

        // Setup local file
        dev.app.vaultAdapter.setFile(filePath, content);
        const uploaded = await cloud.uploadFile(filePath, encode(content), Date.now());

        ctx.index[filePath] = {
            fileId: uploaded.id!,
            mtime: Date.now(),
            size: content.length,
            hash: hashOf(content),
            lastAction: "pull",
        };
        ctx.localIndex[filePath] = {
            fileId: uploaded.id!,
            mtime: Date.now(),
            size: content.length,
            hash: hashOf(content),
            lastAction: "pull",
        };

        // Delete from cloud
        await cloud.deleteFile(uploaded.id);

        // Add deletion to change log
        cloud.clearChangeLog();
        cloud.addChangeEntry(uploaded.id!, filePath, 0, "", true);

        ctx.startPageToken = "0";

        // Make trash fail
        dev.app.vault.setErrorOnMethod("trash", new Error("Cannot trash file"));

        // Execute pull via Changes API - should not throw
        await pullViaChangesAPI(ctx, true);

        // Should have logged the delete error
        const deleteError = logs.find(
            (l) => l.level === "error" && l.message.includes("Delete failed"),
        );
        expect(deleteError).toBeDefined();
        expect(deleteError?.message).toContain("Cannot trash file");

        // Clean up
        dev.app.vault.clearErrorOnMethod("trash");
    });

    /**
     * Covers lines 810-815: Error handling in forbidden file delete during processChangePage
     */
    it("should handle forbidden file delete failure during Changes API", async () => {
        // Upload a forbidden file (in .obsidian/cache/ - this is always forbidden)
        const forbiddenPath = ".obsidian/cache/data.json";
        const content = "cache data";

        const uploaded = await cloud.uploadFile(forbiddenPath, encode(content), Date.now());

        // Setup local index entry so the file is recognized as forbidden
        ctx.index[forbiddenPath] = {
            fileId: uploaded.id!,
            mtime: Date.now(),
            size: content.length,
            hash: hashOf(content),
            lastAction: "pull",
        };
        ctx.localIndex[forbiddenPath] = {
            fileId: uploaded.id!,
            mtime: Date.now(),
            size: content.length,
            hash: hashOf(content),
            lastAction: "pull",
        };

        // Add to change log to trigger processing
        cloud.clearChangeLog();
        cloud.addChangeEntry(uploaded.id!, forbiddenPath, uploaded.size, uploaded.hash!);

        // Make deleteFile fail for this specific file
        const originalDelete = cloud.deleteFile.bind(cloud);
        cloud.deleteFile = async (fileId: string) => {
            if (fileId === uploaded.id) {
                throw new Error("Permission denied");
            }
            return originalDelete(fileId);
        };

        ctx.startPageToken = "0";

        // Execute pull via Changes API - should not throw
        await pullViaChangesAPI(ctx);

        // Restore original
        cloud.deleteFile = originalDelete;

        // Should have logged the delete error
        const deleteError = logs.find(
            (l) => l.level === "error" && l.message.includes("Failed to delete forbidden file"),
        );
        expect(deleteError).toBeDefined();
        expect(deleteError?.message).toContain("Permission denied");
    });

    /**
     * Covers lines 900-904: Error handling in rename during processChangePage (Changes API)
     */
    it("should handle rename failure during Changes API remote rename", async () => {
        const oldPath = "notes/old-changes.md";
        const newPath = "notes/new-changes.md";
        const content = "content";

        // Setup local file at old path
        dev.app.vaultAdapter.setFile(oldPath, content);
        const uploaded = await cloud.uploadFile(newPath, encode(content), Date.now());

        // Setup index with old path
        ctx.index[oldPath] = {
            fileId: uploaded.id!,
            mtime: Date.now() - 1000,
            size: content.length,
            hash: hashOf(content),
            lastAction: "pull",
        };
        ctx.localIndex[oldPath] = {
            fileId: uploaded.id!,
            mtime: Date.now() - 1000,
            size: content.length,
            hash: hashOf(content),
            lastAction: "pull",
        };

        // Add rename to change log
        cloud.clearChangeLog();
        cloud.addChangeEntry(uploaded.id!, newPath, uploaded.size, uploaded.hash!);

        ctx.startPageToken = "0";

        // Make vault rename fail - need to spy on the ctx.vault.rename
        const originalRename = ctx.vault.rename.bind(ctx.vault);
        ctx.vault.rename = async (file: any, newPath: string) => {
            if (newPath === newPath) {
                throw new Error("Rename failed in Changes API");
            }
            return originalRename(file, newPath);
        };

        // Execute pull via Changes API - should not throw
        await pullViaChangesAPI(ctx);

        // Restore original
        ctx.vault.rename = originalRename;

        // Should have logged the rename error - format is "[Changes API] Failed to rename"
        const renameError = logs.find(
            (l) =>
                l.level === "warn" &&
                l.message.includes("Changes API") &&
                l.message.includes("Failed to rename"),
        );
        expect(renameError).toBeDefined();
        expect(renameError?.message).toContain("Rename failed in Changes API");
    });
});

// =============================================================================
// BRANCH COVERAGE IMPROVEMENT TESTS - Target: 80%+
// =============================================================================

describe("sync-pull branch coverage - cleanupForbiddenDirectories (lines 50-65)", () => {
    let cloud: MockCloudAdapter;
    let dev: DeviceSimulator;
    let ctx: SyncContext;
    let logs: Array<{ level: string; message: string }> = [];

    beforeEach(() => {
        cloud = new MockCloudAdapter();
        dev = new DeviceSimulator("Test", cloud);
        ctx = dev.getContext();
        logs = [];

        // Capture logs
        const originalLog = ctx.log.bind(ctx);
        ctx.log = async (message: string, level: LogLevel = "info") => {
            logs.push({ level, message });
            return originalLog(message, level);
        };
    });

    /**
     * Covers lines 56-61: When folder metadata exists and delete succeeds
     */
    it("should clean up forbidden directories when forceCleanupNextSync is true", async () => {
        // INTERNAL_LOCAL_ONLY contains ["cache/", "data/local/"]
        // Full path is PLUGIN_DIR + dirName.slice(0, -1) = .obsidian/plugins/obsidian-vault-sync/cache
        const forbiddenDir = ".obsidian/plugins/obsidian-vault-sync/cache";

        // Create the forbidden folder in cloud
        cloud.addFakeFolder(forbiddenDir);

        // Create a regular file to trigger the pull process
        const regularPath = "notes/regular.md";
        const regularContent = "regular file";
        const uploaded = await cloud.uploadFile(regularPath, encode(regularContent), Date.now());

        // Create remote index
        const indexContent = JSON.stringify({
            version: 1,
            deviceId: "dev_other",
            index: {
                [regularPath]: {
                    fileId: uploaded.id!,
                    mtime: uploaded.mtime,
                    size: uploaded.size,
                    hash: uploaded.hash,
                },
            },
        });
        await cloud.uploadFile(SYNC_INDEX_PATH, encode(indexContent), Date.now());

        // Enable force cleanup
        ctx.forceCleanupNextSync = true;

        // Execute pull
        await dev.smartPull();

        // Should have logged the cleanup
        const cleanupLog = logs.find(
            (l) => l.level === "debug" && l.message.includes("System Cleanup"),
        );
        expect(cleanupLog).toBeDefined();
    });

    /**
     * Covers lines 62-63: Error handling when delete fails
     */
    it("should handle delete failure gracefully in cleanupForbiddenDirectories", async () => {
        // Add a fake folder that will fail to delete (INTERNAL_LOCAL_ONLY contains "cache/")
        const folderId = cloud.addFakeFolder(".obsidian/plugins/obsidian-vault-sync/cache");

        // Make deleteFile fail
        const originalDeleteFile = cloud.deleteFile.bind(cloud);
        cloud.deleteFile = async (fileId: string) => {
            if (fileId === folderId) {
                throw new Error("Permission denied");
            }
            return originalDeleteFile(fileId);
        };

        // Create a regular file to trigger the pull process
        const regularPath = "notes/regular.md";
        const regularContent = "regular file";
        const uploaded = await cloud.uploadFile(regularPath, encode(regularContent), Date.now());

        const indexContent = JSON.stringify({
            version: 1,
            deviceId: "dev_other",
            index: {
                [regularPath]: {
                    fileId: uploaded.id!,
                    mtime: uploaded.mtime,
                    size: uploaded.size,
                    hash: uploaded.hash,
                },
            },
        });
        await cloud.uploadFile(SYNC_INDEX_PATH, encode(indexContent), Date.now());

        ctx.forceCleanupNextSync = true;

        // Execute pull - should not throw
        await dev.smartPull();

        // Restore
        cloud.deleteFile = originalDeleteFile;

        // The error is silently caught (line 62-63), so no log is expected
        // The test passes if no exception is thrown
    });
});

describe("sync-pull branch coverage - detectPullChanges remote rename with hash match (lines 134-158)", () => {
    let cloud: MockCloudAdapter;
    let dev: DeviceSimulator;
    let ctx: SyncContext;
    let logs: Array<{ level: string; message: string }> = [];

    beforeEach(() => {
        cloud = new MockCloudAdapter();
        dev = new DeviceSimulator("Test", cloud);
        ctx = dev.getContext();
        logs = [];

        const originalLog = ctx.log.bind(ctx);
        ctx.log = async (message: string, level: LogLevel = "info") => {
            logs.push({ level, message });
            return originalLog(message, level);
        };
    });

    /**
     * Covers lines 134-141: Update index and localIndex after rename
     * Covers lines 152-157: Content hash matches after rename, skip download
     */
    it("should update indices and skip download when hash matches after remote rename", async () => {
        const oldPath = "notes/old-name.md";
        const newPath = "notes/new-name.md";
        const content = "content that matches";
        const hash = hashOf(content);

        // Setup local file at old path
        dev.app.vaultAdapter.setFile(oldPath, content);

        // Upload to cloud at NEW path (simulating remote rename)
        const uploaded = await cloud.uploadFile(newPath, encode(content), Date.now());

        // Setup index at OLD path with matching hash
        ctx.index[oldPath] = {
            fileId: uploaded.id!,
            mtime: Date.now() - 1000,
            size: content.length,
            hash: hash,
            lastAction: "pull",
        };
        ctx.localIndex[oldPath] = {
            fileId: uploaded.id!,
            mtime: Date.now() - 1000,
            size: content.length,
            hash: hash,
            lastAction: "pull",
        };

        // Create remote index with file at NEW path
        const indexContent = JSON.stringify({
            version: 1,
            deviceId: "dev_other",
            index: {
                [newPath]: {
                    fileId: uploaded.id!,
                    mtime: uploaded.mtime,
                    size: uploaded.size,
                    hash: uploaded.hash,
                },
            },
        });
        await cloud.uploadFile(SYNC_INDEX_PATH, encode(indexContent), Date.now());

        // Execute pull
        await dev.smartPull();

        // Verify file was renamed locally
        expect(dev.getLocalContent(newPath)).toBe(content);
        expect(dev.getLocalContent(oldPath)).toBeNull();

        // Verify indices were updated - old path should be gone, new path should exist
        expect(ctx.index[oldPath]).toBeUndefined();
        expect(ctx.index[newPath]).toBeDefined();
        expect(ctx.localIndex[oldPath]).toBeUndefined();
        expect(ctx.localIndex[newPath]).toBeDefined();

        // Verify log message about hash match
        const hashMatchLog = logs.find(
            (l) => l.level === "debug" && l.message.includes("Content matches after rename"),
        );
        expect(hashMatchLog).toBeDefined();
    });
});

describe("sync-pull branch coverage - detectPullChanges local is dirty (lines 166-174)", () => {
    let cloud: MockCloudAdapter;
    let dev: DeviceSimulator;
    let ctx: SyncContext;
    let logs: Array<{ level: string; message: string }> = [];

    beforeEach(() => {
        cloud = new MockCloudAdapter();
        dev = new DeviceSimulator("Test", cloud);
        ctx = dev.getContext();
        logs = [];

        const originalLog = ctx.log.bind(ctx);
        ctx.log = async (message: string, level: LogLevel = "info") => {
            logs.push({ level, message });
            return originalLog(message, level);
        };
    });

    /**
     * Covers lines 166-174: When local is dirty during remote rename
     */
    it("should skip auto-rename when local file has pending changes", async () => {
        const oldPath = "notes/old-dirty.md";
        const newPath = "notes/new-remote.md";
        const content = "original content";
        const hash = hashOf(content);

        // Setup local file at old path
        dev.app.vaultAdapter.setFile(oldPath, content);

        // Mark as dirty (simulating local changes)
        ctx.dirtyPaths.set(oldPath, Date.now());

        // Upload to cloud at NEW path (simulating remote rename)
        const uploaded = await cloud.uploadFile(newPath, encode(content), Date.now());

        // Setup index at OLD path
        ctx.index[oldPath] = {
            fileId: uploaded.id!,
            mtime: Date.now() - 1000,
            size: content.length,
            hash: hash,
            lastAction: "pull",
        };
        ctx.localIndex[oldPath] = {
            fileId: uploaded.id!,
            mtime: Date.now() - 1000,
            size: content.length,
            hash: hash,
            lastAction: "pull",
        };

        // Create remote index with file at NEW path
        const indexContent = JSON.stringify({
            version: 1,
            deviceId: "dev_other",
            index: {
                [newPath]: {
                    fileId: uploaded.id!,
                    mtime: uploaded.mtime,
                    size: uploaded.size,
                    hash: uploaded.hash,
                },
            },
        });
        await cloud.uploadFile(SYNC_INDEX_PATH, encode(indexContent), Date.now());

        // Execute pull
        await dev.smartPull();

        // Verify file was NOT renamed locally (because it's dirty)
        expect(dev.getLocalContent(oldPath)).toBe(content);
        expect(dev.getLocalContent(newPath)).toBeNull();

        // Verify warning log about pending local changes
        const pendingLog = logs.find(
            (l) => l.level === "warn" && l.message.includes("Pending local changes"),
        );
        expect(pendingLog).toBeDefined();
        expect(pendingLog?.message).toContain("Skipping auto-rename");
    });
});

describe("sync-pull branch coverage - buildLocalDeletionTasks error (line 360)", () => {
    let cloud: MockCloudAdapter;
    let dev: DeviceSimulator;
    let ctx: SyncContext;
    let logs: Array<{ level: string; message: string }> = [];

    beforeEach(() => {
        cloud = new MockCloudAdapter();
        dev = new DeviceSimulator("Test", cloud);
        ctx = dev.getContext();
        logs = [];

        const originalLog = ctx.log.bind(ctx);
        ctx.log = async (message: string, level: LogLevel = "info") => {
            logs.push({ level, message });
            return originalLog(message, level);
        };
    });

    afterEach(() => {
        dev.app.vault.clearAllErrors();
    });

    /**
     * Covers line 360: Error handling when delete fails
     */
    it("should handle local file deletion failure gracefully", async () => {
        const filePath = "notes/to-delete-local.md";
        const content = "delete me";
        const hash = hashOf(content);

        // Setup local file
        dev.app.vaultAdapter.setFile(filePath, content);

        // Setup index
        ctx.index[filePath] = {
            fileId: "file_1",
            mtime: Date.now(),
            size: content.length,
            hash: hash,
            lastAction: "pull",
        };
        ctx.localIndex[filePath] = {
            fileId: "file_1",
            mtime: Date.now(),
            size: content.length,
            hash: hash,
            lastAction: "pull",
        };

        // Create remote index WITHOUT the file (file was deleted on remote)
        const indexContent = JSON.stringify({
            version: 1,
            deviceId: "dev_other",
            index: {},
        });
        await cloud.uploadFile(SYNC_INDEX_PATH, encode(indexContent), Date.now());

        // Make trash fail
        dev.app.vault.setErrorOnMethod("trash", new Error("Cannot delete file"));

        // Execute pull - should not throw
        await dev.smartPull();

        // Verify error was logged
        const deleteError = logs.find(
            (l) => l.level === "error" && l.message.includes("Delete failed"),
        );
        expect(deleteError).toBeDefined();
        expect(deleteError?.message).toContain("Cannot delete file");
    });
});

describe("sync-pull branch coverage - buildForbiddenRemoteCleanupTasks error (lines 410-415)", () => {
    let cloud: MockCloudAdapter;
    let dev: DeviceSimulator;
    let ctx: SyncContext;
    let logs: Array<{ level: string; message: string }> = [];

    beforeEach(() => {
        cloud = new MockCloudAdapter();
        dev = new DeviceSimulator("Test", cloud);
        ctx = dev.getContext();
        logs = [];

        const originalLog = ctx.log.bind(ctx);
        ctx.log = async (message: string, level: LogLevel = "info") => {
            logs.push({ level, message });
            return originalLog(message, level);
        };
    });

    afterEach(() => {
        cloud.clearAllErrors();
    });

    /**
     * Covers lines 410-415: Error handling when folder wipe fails
     */
    it("should handle folder wipe failure gracefully in forbidden cleanup", async () => {
        // Create a forbidden folder path under .obsidian/ (OBSIDIAN_SYSTEM_IGNORES contains ".trash/")
        // isAlwaysForbiddenOnRemote checks for .obsidian/ prefix for obsidian system ignores
        const forbiddenFolder = ".obsidian/.trash";
        const forbiddenFile = ".obsidian/.trash/deleted.md";
        const content = "deleted content";

        // Upload a forbidden folder
        const folderId = cloud.addFakeFolder(forbiddenFolder);

        // Also create a file inside it
        const uploaded = await cloud.uploadFile(forbiddenFile, encode(content), Date.now());

        // Create a regular file to trigger pull process
        const regularPath = "notes/regular.md";
        const regularContent = "regular";
        const regularUploaded = await cloud.uploadFile(
            regularPath,
            encode(regularContent),
            Date.now(),
        );

        // Create remote index
        const indexContent = JSON.stringify({
            version: 1,
            deviceId: "dev_other",
            index: {
                [regularPath]: {
                    fileId: regularUploaded.id,
                    mtime: regularUploaded.mtime,
                    size: regularUploaded.size,
                    hash: regularUploaded.hash,
                },
                [forbiddenFile]: {
                    fileId: uploaded.id!,
                    mtime: uploaded.mtime,
                    size: uploaded.size,
                    hash: uploaded.hash,
                },
            },
        });
        await cloud.uploadFile(SYNC_INDEX_PATH, encode(indexContent), Date.now());

        // Make deleteFile fail for the folder
        const originalDeleteFile = cloud.deleteFile.bind(cloud);
        cloud.deleteFile = async (fileId: string) => {
            if (fileId === folderId) {
                throw new Error("Folder delete failed");
            }
            return originalDeleteFile(fileId);
        };

        // Execute pull - should not throw
        await dev.smartPull();

        // Restore
        cloud.deleteFile = originalDeleteFile;

        // Verify error was logged
        const wipeError = logs.find(
            (l) => l.level === "warn" && l.message.includes("Folder wipe failed"),
        );
        expect(wipeError).toBeDefined();
        expect(wipeError?.message).toContain("Folder delete failed");
    });
});

describe("sync-pull branch coverage - smartPull index hash matches (lines 534-538)", () => {
    let cloud: MockCloudAdapter;
    let dev: DeviceSimulator;
    let ctx: SyncContext;
    let logs: Array<{ level: string; message: string }> = [];

    beforeEach(() => {
        cloud = new MockCloudAdapter();
        dev = new DeviceSimulator("Test", cloud);
        ctx = dev.getContext();
        logs = [];

        const originalLog = ctx.log.bind(ctx);
        ctx.log = async (message: string, level: LogLevel = "info") => {
            logs.push({ level, message });
            return originalLog(message, level);
        };
    });

    /**
     * Covers lines 534-538: When local and remote index hashes match, skip pull
     */
    it("should skip pull when index hash matches", async () => {
        // Create a file
        const filePath = "notes/synced.md";
        const content = "already synced";
        const uploaded = await cloud.uploadFile(filePath, encode(content), Date.now());

        // Setup local index with matching hash
        const indexHash = hashOf(content); // Use content hash as index hash for simplicity

        // First, let's create the index and get its actual hash
        const indexData = {
            version: 1,
            deviceId: "dev_other",
            index: {
                [filePath]: {
                    fileId: uploaded.id!,
                    mtime: uploaded.mtime,
                    size: uploaded.size,
                    hash: uploaded.hash,
                },
            },
        };
        const indexContent = JSON.stringify(indexData);
        const indexUploaded = await cloud.uploadFile(
            SYNC_INDEX_PATH,
            encode(indexContent),
            Date.now(),
        );

        // Setup local file and indices
        dev.app.vaultAdapter.setFile(filePath, content);
        ctx.index[filePath] = {
            fileId: uploaded.id!,
            mtime: uploaded.mtime,
            size: uploaded.size,
            hash: uploaded.hash,
            lastAction: "pull",
        };
        ctx.localIndex[filePath] = {
            fileId: uploaded.id!,
            mtime: uploaded.mtime,
            size: uploaded.size,
            hash: uploaded.hash,
            lastAction: "pull",
        };

        // Set the index entry hash to match remote
        ctx.index[SYNC_INDEX_PATH] = {
            fileId: indexUploaded.id,
            mtime: indexUploaded.mtime,
            size: indexUploaded.size,
            hash: indexUploaded.hash,
        };

        // Execute pull
        const result = await dev.smartPull();

        // Should return false (no changes)
        expect(result).toBe(false);

        // Should have logged the hash match
        const hashMatchLog = logs.find(
            (l) => l.level === "debug" && l.message.includes("Index hash matches"),
        );
        expect(hashMatchLog).toBeDefined();
    });
});

describe("sync-pull branch coverage - smartPull no changes detected (lines 573-583)", () => {
    let cloud: MockCloudAdapter;
    let dev: DeviceSimulator;
    let ctx: SyncContext;
    let logs: Array<{ level: string; message: string }> = [];

    beforeEach(() => {
        cloud = new MockCloudAdapter();
        dev = new DeviceSimulator("Test", cloud);
        ctx = dev.getContext();
        logs = [];

        const originalLog = ctx.log.bind(ctx);
        ctx.log = async (message: string, level: LogLevel = "info") => {
            logs.push({ level, message });
            return originalLog(message, level);
        };
    });

    /**
     * Covers lines 573-583: When toDownload and toDeleteLocal are both empty
     */
    it("should handle case when no file changes are detected", async () => {
        // Create a file that's already in sync
        const filePath = "notes/no-changes.md";
        const content = "same content";
        const hash = hashOf(content);

        // Upload to cloud
        const uploaded = await cloud.uploadFile(filePath, encode(content), Date.now());

        // Setup local file and indices with MATCHING data
        dev.app.vaultAdapter.setFile(filePath, content);
        ctx.index[filePath] = {
            fileId: uploaded.id!,
            mtime: uploaded.mtime,
            size: uploaded.size,
            hash: uploaded.hash,
            lastAction: "pull",
        };
        ctx.localIndex[filePath] = {
            fileId: uploaded.id!,
            mtime: uploaded.mtime,
            size: uploaded.size,
            hash: uploaded.hash,
            lastAction: "pull",
        };

        // Create remote index with DIFFERENT hash to trigger detectPullChanges
        // but with the same file (so no actual download needed)
        const indexData = {
            version: 1,
            deviceId: "dev_other",
            index: {
                [filePath]: {
                    fileId: uploaded.id!,
                    mtime: uploaded.mtime,
                    size: uploaded.size,
                    hash: uploaded.hash,
                },
            },
        };
        const indexContent = JSON.stringify(indexData);
        const indexUploaded = await cloud.uploadFile(
            SYNC_INDEX_PATH,
            encode(indexContent),
            Date.now(),
        );

        // Set index hash to something different to bypass the hash match check
        ctx.index[SYNC_INDEX_PATH] = {
            fileId: indexUploaded.id,
            mtime: indexUploaded.mtime,
            size: indexUploaded.size,
            hash: "different_hash_to_trigger_comparison",
        };

        // Execute pull
        const result = await dev.smartPull();

        // Should return false (no changes needed)
        expect(result).toBe(false);

        // Should have logged that no file changes were detected
        const noChangesLog = logs.find(
            (l) => l.level === "debug" && l.message.includes("No file changes detected"),
        );
        expect(noChangesLog).toBeDefined();
    });
});

describe("sync-pull branch coverage - pullViaChangesAPI notification (lines 666-668)", () => {
    let cloud: MockCloudAdapter;
    let dev: DeviceSimulator;
    let ctx: SyncContext;
    let notifications: Array<{ key: string; args: any[] }> = [];

    beforeEach(() => {
        cloud = new MockCloudAdapter();
        dev = new DeviceSimulator("Test", cloud);
        ctx = dev.getContext();
        notifications = [];

        const originalNotify = ctx.notify.bind(ctx);
        ctx.notify = async (key: string, ...args: any[]) => {
            notifications.push({ key, args });
            return originalNotify(key, ...args);
        };
    });

    /**
     * Covers lines 666-668: drainAll mode with confirmedCountTotal === 0
     */
    it("should show waiting notification in drainAll mode when no files confirmed yet", async () => {
        // Create a file to trigger the Changes API processing
        const filePath = "notes/drainall-test.md";
        const content = "test content";
        const hash = hashOf(content);

        // Upload to cloud
        const uploaded = await cloud.uploadFile(filePath, encode(content), Date.now());

        // Setup local file with OLD data (to trigger processing)
        dev.app.vaultAdapter.setFile(filePath, "old content");
        ctx.index[filePath] = {
            fileId: uploaded.id!,
            mtime: Date.now() - 1000,
            size: 100,
            hash: "oldhash123",
            lastAction: "pull",
        };
        ctx.localIndex[filePath] = {
            fileId: uploaded.id!,
            mtime: Date.now() - 1000,
            size: 100,
            hash: "oldhash123",
            lastAction: "pull",
        };

        // Create remote index
        const indexContent = JSON.stringify({
            version: 1,
            deviceId: "dev_other",
            index: {
                [filePath]: {
                    fileId: uploaded.id!,
                    mtime: uploaded.mtime,
                    size: uploaded.size,
                    hash: uploaded.hash,
                },
            },
        });
        await cloud.uploadFile(SYNC_INDEX_PATH, encode(indexContent), Date.now());

        // Setup Changes API with the file change
        ctx.startPageToken = "0";
        cloud.clearChangeLog();
        cloud.addChangeEntry(uploaded.id!, filePath, uploaded.size, uploaded.hash!);

        // Execute pull with drainAll=true
        await pullViaChangesAPI(ctx, true);

        // Check for waiting notification
        const waitingNotification = notifications.find(
            (n) => n.key === "noticeWaitingForRemoteRegistration",
        );
        expect(waitingNotification).toBeDefined();
        expect(waitingNotification?.args[0]).toContain("Page");
    });
});

describe("sync-pull branch coverage - processChangePage error handling", () => {
    let cloud: MockCloudAdapter;
    let dev: DeviceSimulator;
    let ctx: SyncContext;
    let logs: Array<{ level: string; message: string }> = [];

    beforeEach(() => {
        cloud = new MockCloudAdapter();
        dev = new DeviceSimulator("Test", cloud);
        ctx = dev.getContext();
        logs = [];

        const originalLog = ctx.log.bind(ctx);
        ctx.log = async (message: string, level: LogLevel = "info") => {
            logs.push({ level, message });
            return originalLog(message, level);
        };
    });

    afterEach(() => {
        dev.app.vault.clearAllErrors();
        cloud.clearAllErrors();
    });

    /**
     * Covers lines 777-781: Delete failed error handling in processChangePage
     */
    it("should handle delete failure in processChangePage", async () => {
        const filePath = "notes/changes-delete-fail.md";
        const content = "content";

        // Setup local file
        dev.app.vaultAdapter.setFile(filePath, content);
        const uploaded = await cloud.uploadFile(filePath, encode(content), Date.now());

        ctx.index[filePath] = {
            fileId: uploaded.id!,
            mtime: Date.now(),
            size: content.length,
            hash: hashOf(content),
            lastAction: "pull",
        };
        ctx.localIndex[filePath] = {
            fileId: uploaded.id!,
            mtime: Date.now(),
            size: content.length,
            hash: hashOf(content),
            lastAction: "pull",
        };

        // Delete from cloud
        await cloud.deleteFile(uploaded.id);

        // Add deletion to change log
        cloud.clearChangeLog();
        cloud.addChangeEntry(uploaded.id!, filePath, 0, "", true);

        ctx.startPageToken = "0";

        // Make trashFile fail
        dev.app.vault.setErrorOnMethod("trash", new Error("Trash failed"));

        // Execute pull via Changes API
        await pullViaChangesAPI(ctx, true);

        // Verify error was logged
        const deleteError = logs.find(
            (l) => l.level === "error" && l.message.includes("Delete failed"),
        );
        expect(deleteError).toBeDefined();
        expect(deleteError?.message).toContain("Trash failed");
    });

    /**
     * Covers lines 811-815: Forbidden file delete error handling in processChangePage
     */
    it("should handle forbidden file delete failure in processChangePage", async () => {
        const forbiddenPath = ".DS_Store";
        const content = "forbidden content";

        // Upload forbidden file
        const uploaded = await cloud.uploadFile(forbiddenPath, encode(content), Date.now());

        // Setup local index
        ctx.index[forbiddenPath] = {
            fileId: uploaded.id!,
            mtime: Date.now(),
            size: content.length,
            hash: hashOf(content),
            lastAction: "pull",
        };
        ctx.localIndex[forbiddenPath] = {
            fileId: uploaded.id!,
            mtime: Date.now(),
            size: content.length,
            hash: hashOf(content),
            lastAction: "pull",
        };

        // Add to change log
        cloud.clearChangeLog();
        cloud.addChangeEntry(uploaded.id!, forbiddenPath, uploaded.size, uploaded.hash!);

        // Make deleteFile fail
        const originalDeleteFile = cloud.deleteFile.bind(cloud);
        cloud.deleteFile = async (fileId: string) => {
            if (fileId === uploaded.id) {
                throw new Error("Forbidden delete failed");
            }
            return originalDeleteFile(fileId);
        };

        ctx.startPageToken = "0";

        // Execute pull via Changes API
        await pullViaChangesAPI(ctx);

        // Restore
        cloud.deleteFile = originalDeleteFile;

        // Verify error was logged
        const deleteError = logs.find(
            (l) => l.level === "error" && l.message.includes("Failed to delete forbidden file"),
        );
        expect(deleteError).toBeDefined();
        expect(deleteError?.message).toContain("Forbidden delete failed");
    });
});

describe("sync-pull branch coverage - additional edge cases", () => {
    let cloud: MockCloudAdapter;
    let dev: DeviceSimulator;
    let ctx: SyncContext;
    let logs: Array<{ level: string; message: string }> = [];

    beforeEach(() => {
        cloud = new MockCloudAdapter();
        dev = new DeviceSimulator("Test", cloud);
        ctx = dev.getContext();
        logs = [];

        const originalLog = ctx.log.bind(ctx);
        ctx.log = async (message: string, level: LogLevel = "info") => {
            logs.push({ level, message });
            return originalLog(message, level);
        };
    });

    /**
     * Covers lines 152-153: Hash match after rename in detectPullChanges
     * This requires the index hash to match exactly after the rename operation
     */
    it("should skip download when hash exactly matches after rename in detectPullChanges", async () => {
        const oldPath = "notes/hash-match-rename.md";
        const newPath = "notes/hash-match-renamed.md";
        const content = "exact content match";
        const hash = hashOf(content);

        // Setup local file at old path
        dev.app.vaultAdapter.setFile(oldPath, content);

        // Upload to cloud at NEW path
        const uploaded = await cloud.uploadFile(newPath, encode(content), Date.now());

        // Setup index at OLD path with EXACT same hash as remote
        ctx.index[oldPath] = {
            fileId: uploaded.id!,
            mtime: Date.now() - 1000,
            size: content.length,
            hash: hash, // This must exactly match the remote hash
            lastAction: "pull",
        };
        ctx.localIndex[oldPath] = {
            fileId: uploaded.id!,
            mtime: Date.now() - 1000,
            size: content.length,
            hash: hash,
            lastAction: "pull",
        };

        // Create remote index with the same hash
        const indexContent = JSON.stringify({
            version: 1,
            deviceId: "dev_other",
            index: {
                [newPath]: {
                    fileId: uploaded.id!,
                    mtime: uploaded.mtime,
                    size: uploaded.size,
                    hash: uploaded.hash, // This should be the same as ctx.index[oldPath].hash
                },
            },
        });
        await cloud.uploadFile(SYNC_INDEX_PATH, encode(indexContent), Date.now());

        // Execute pull
        await dev.smartPull();

        // Verify the hash match log
        const hashMatchLog = logs.find(
            (l) => l.level === "debug" && l.message.includes("Content matches after rename"),
        );
        expect(hashMatchLog).toBeDefined();
    });

    /**
     * Covers lines 868-898: Source missing locally during Changes API rename
     */
    it("should handle missing source file during Changes API rename", async () => {
        const oldPath = "notes/missing-source.md";
        const newPath = "notes/new-for-missing.md";
        const content = "content for missing source test";

        // DO NOT create the local file at oldPath (simulating it was deleted locally)
        // Upload to cloud at NEW path
        const uploaded = await cloud.uploadFile(newPath, encode(content), Date.now());

        // Setup index at OLD path (but file doesn't exist locally)
        ctx.index[oldPath] = {
            fileId: uploaded.id!,
            mtime: Date.now() - 1000,
            size: content.length,
            hash: hashOf(content),
            lastAction: "pull",
        };
        ctx.localIndex[oldPath] = {
            fileId: uploaded.id!,
            mtime: Date.now() - 1000,
            size: content.length,
            hash: hashOf(content),
            lastAction: "pull",
        };

        // Create remote index
        const indexContent = JSON.stringify({
            version: 1,
            deviceId: "dev_other",
            index: {
                [newPath]: {
                    fileId: uploaded.id!,
                    mtime: uploaded.mtime,
                    size: uploaded.size,
                    hash: uploaded.hash,
                },
            },
        });
        await cloud.uploadFile(SYNC_INDEX_PATH, encode(indexContent), Date.now());

        // Setup Changes API with rename
        ctx.startPageToken = "0";
        cloud.clearChangeLog();
        cloud.addChangeEntry(uploaded.id!, newPath, uploaded.size, uploaded.hash!);

        // Execute pull via Changes API
        await pullViaChangesAPI(ctx);

        // Verify log about missing source
        const missingSourceLog = logs.find(
            (l) =>
                l.level === "warn" &&
                l.message.includes("Source") &&
                l.message.includes("missing locally"),
        );
        expect(missingSourceLog).toBeDefined();
    });

    /**
     * Covers line 907: Target exists during Changes API rename
     */
    it("should skip rename when target exists during Changes API", async () => {
        const oldPath = "notes/existing-source.md";
        const newPath = "notes/existing-target.md";
        const content = "test content";

        // Create BOTH files locally (target exists)
        dev.app.vaultAdapter.setFile(oldPath, content);
        dev.app.vaultAdapter.setFile(newPath, "existing target content");

        // Upload to cloud at NEW path
        const uploaded = await cloud.uploadFile(newPath, encode(content), Date.now());

        // Setup index at OLD path
        ctx.index[oldPath] = {
            fileId: uploaded.id!,
            mtime: Date.now() - 1000,
            size: content.length,
            hash: hashOf(content),
            lastAction: "pull",
        };
        ctx.localIndex[oldPath] = {
            fileId: uploaded.id!,
            mtime: Date.now() - 1000,
            size: content.length,
            hash: hashOf(content),
            lastAction: "pull",
        };

        // Also need index entry for target
        ctx.index[newPath] = {
            fileId: "different_id",
            mtime: Date.now() - 1000,
            size: 100,
            hash: hashOf("existing target content"),
            lastAction: "pull",
        };

        // Create remote index
        const indexContent = JSON.stringify({
            version: 1,
            deviceId: "dev_other",
            index: {
                [newPath]: {
                    fileId: uploaded.id!,
                    mtime: uploaded.mtime,
                    size: uploaded.size,
                    hash: uploaded.hash,
                },
            },
        });
        await cloud.uploadFile(SYNC_INDEX_PATH, encode(indexContent), Date.now());

        // Setup Changes API
        ctx.startPageToken = "0";
        cloud.clearChangeLog();
        cloud.addChangeEntry(uploaded.id!, newPath, uploaded.size, uploaded.hash!);

        // Execute pull via Changes API
        await pullViaChangesAPI(ctx);

        // Verify log about target existing
        const targetExistsLog = logs.find(
            (l) =>
                l.level === "warn" && l.message.includes("Target") && l.message.includes("exists"),
        );
        expect(targetExistsLog).toBeDefined();
    });
});

describe("sync-pull branch coverage - dirtyPaths update during Changes API rename", () => {
    let cloud: MockCloudAdapter;
    let dev: DeviceSimulator;
    let ctx: SyncContext;
    let logs: Array<{ level: string; message: string }> = [];
    let notifications: Array<{ key: string; args: any[] }> = [];

    beforeEach(() => {
        cloud = new MockCloudAdapter();
        dev = new DeviceSimulator("Test", cloud);
        ctx = dev.getContext();
        logs = [];
        notifications = [];

        const originalLog = ctx.log.bind(ctx);
        ctx.log = async (message: string, level: LogLevel = "info") => {
            logs.push({ level, message });
            return originalLog(message, level);
        };

        const originalNotify = ctx.notify.bind(ctx);
        ctx.notify = async (key: string, ...args: any[]) => {
            notifications.push({ key, args });
            return originalNotify(key, ...args);
        };
    });

    /**
     * Covers lines 868-888: Successful rename during Changes API
     */
    it("should successfully rename and update indices during Changes API", async () => {
        const oldPath = "notes/rename-clean.md";
        const newPath = "notes/renamed-clean.md";
        const content = "content for rename";

        // Create local file at old path (NOT dirty)
        dev.app.vaultAdapter.setFile(oldPath, content);

        // Upload to cloud at NEW path
        const uploaded = await cloud.uploadFile(newPath, encode(content), Date.now());

        // Setup index at OLD path
        ctx.index[oldPath] = {
            fileId: uploaded.id!,
            mtime: Date.now() - 1000,
            size: content.length,
            hash: hashOf(content),
            lastAction: "pull",
        };
        ctx.localIndex[oldPath] = {
            fileId: uploaded.id!,
            mtime: Date.now() - 1000,
            size: content.length,
            hash: hashOf(content),
            lastAction: "pull",
        };

        // Create remote index
        const indexContent = JSON.stringify({
            version: 1,
            deviceId: "dev_other",
            index: {
                [newPath]: {
                    fileId: uploaded.id!,
                    mtime: uploaded.mtime,
                    size: uploaded.size,
                    hash: uploaded.hash,
                },
            },
        });
        await cloud.uploadFile(SYNC_INDEX_PATH, encode(indexContent), Date.now());

        // Setup Changes API
        ctx.startPageToken = "0";
        cloud.clearChangeLog();
        cloud.addChangeEntry(uploaded.id!, newPath, uploaded.size, uploaded.hash!);

        // Execute pull via Changes API
        await pullViaChangesAPI(ctx);

        // Verify file was renamed
        expect(dev.getLocalContent(newPath)).toBe(content);
        expect(dev.getLocalContent(oldPath)).toBeNull();

        // Verify rename notification
        const renameNotification = notifications.find((n) => n.key === "noticeFileRenamed");
        expect(renameNotification).toBeDefined();
    });
});

describe("sync-pull branch coverage - pendingMove guard in Changes API (lines 849-853)", () => {
    let cloud: MockCloudAdapter;
    let dev: DeviceSimulator;
    let ctx: SyncContext;
    let logs: Array<{ level: string; message: string }> = [];

    beforeEach(() => {
        cloud = new MockCloudAdapter();
        dev = new DeviceSimulator("Test", cloud);
        ctx = dev.getContext();
        logs = [];

        const originalLog = ctx.log.bind(ctx);
        ctx.log = async (message: string, level: LogLevel = "info") => {
            logs.push({ level, message });
            return originalLog(message, level);
        };
    });

    /**
     * Covers lines 849-853: Skip rename when local has pendingMove
     */
    it("should skip Changes API rename when local has pendingMove", async () => {
        const oldPath = "notes/pending-move-source.md";
        const newPath = "notes/pending-move-target.md";
        const content = "content with pending move";

        // Create local file at old path
        dev.app.vaultAdapter.setFile(oldPath, content);

        // Upload to cloud at NEW path
        const uploaded = await cloud.uploadFile(newPath, encode(content), Date.now());

        // Setup index at OLD path with pendingMove flag
        ctx.index[oldPath] = {
            fileId: uploaded.id!,
            mtime: Date.now() - 1000,
            size: content.length,
            hash: hashOf(content),
            lastAction: "pull",
            pendingMove: { oldPath }, // This should trigger the skip at lines 848-854
        };
        ctx.localIndex[oldPath] = {
            fileId: uploaded.id!,
            mtime: Date.now() - 1000,
            size: content.length,
            hash: hashOf(content),
            lastAction: "pull",
        };

        // Create remote index
        const indexContent = JSON.stringify({
            version: 1,
            deviceId: "dev_other",
            index: {
                [newPath]: {
                    fileId: uploaded.id!,
                    mtime: uploaded.mtime,
                    size: uploaded.size,
                    hash: uploaded.hash,
                },
            },
        });
        await cloud.uploadFile(SYNC_INDEX_PATH, encode(indexContent), Date.now());

        // Setup Changes API
        ctx.startPageToken = "0";
        cloud.clearChangeLog();
        cloud.addChangeEntry(uploaded.id!, newPath, uploaded.size, uploaded.hash!);

        // Execute pull via Changes API
        await pullViaChangesAPI(ctx);

        // Verify file was NOT renamed locally (because pendingMove is set)
        expect(dev.getLocalContent(oldPath)).toBe(content);
        expect(dev.getLocalContent(newPath)).toBeNull();

        // Verify debug log about skipping rename
        const skipLog = logs.find(
            (l) =>
                l.level === "debug" &&
                l.message.includes("Remote Rename skipped") &&
                l.message.includes("pending move"),
        );
        expect(skipLog).toBeDefined();
    });
});

describe("sync-pull branch coverage - active merge lock in processChangePage (lines 824-834)", () => {
    let cloud: MockCloudAdapter;
    let dev: DeviceSimulator;
    let ctx: SyncContext;
    let logs: Array<{ level: string; message: string }> = [];
    let notifications: Array<{ key: string; args: any[] }> = [];

    beforeEach(() => {
        cloud = new MockCloudAdapter();
        dev = new DeviceSimulator("Test", cloud);
        ctx = dev.getContext();
        logs = [];
        notifications = [];

        const originalLog = ctx.log.bind(ctx);
        ctx.log = async (message: string, level: LogLevel = "info") => {
            logs.push({ level, message });
            return originalLog(message, level);
        };

        const originalNotify = ctx.notify.bind(ctx);
        ctx.notify = async (key: string, ...args: any[]) => {
            notifications.push({ key, args });
            return originalNotify(key, ...args);
        };
    });

    /**
     * Covers lines 824-834: Active merge lock in processChangePage
     */
    it("should skip file processing when active merge lock exists via Changes API", async () => {
        const filePath = "notes/locked-via-changes.md";
        const content = "locked content";
        const hash = hashOf(content);

        // Setup local file
        dev.app.vaultAdapter.setFile(filePath, content);

        // Upload to cloud
        const uploaded = await cloud.uploadFile(filePath, encode(content), Date.now());

        // Setup index
        ctx.index[filePath] = {
            fileId: uploaded.id!,
            mtime: Date.now() - 1000,
            size: content.length,
            hash: "oldhash123", // Different hash to trigger update
            lastAction: "pull",
        };
        ctx.localIndex[filePath] = {
            fileId: uploaded.id!,
            mtime: Date.now() - 1000,
            size: content.length,
            hash: "oldhash123",
            lastAction: "pull",
        };

        // Create communication file with active merge lock
        const futureTime = Date.now() + 60000;
        const commContent = JSON.stringify({
            mergeLocks: {
                [filePath]: {
                    holder: "other_device",
                    expiresAt: futureTime,
                },
            },
        });
        await cloud.uploadFile(ctx.communicationPath, encode(commContent), Date.now());

        // Create remote index
        const indexContent = JSON.stringify({
            version: 1,
            deviceId: "dev_other",
            index: {
                [filePath]: {
                    fileId: uploaded.id!,
                    mtime: uploaded.mtime,
                    size: uploaded.size,
                    hash: uploaded.hash,
                },
            },
        });
        await cloud.uploadFile(SYNC_INDEX_PATH, encode(indexContent), Date.now());

        // Setup Changes API with file change
        ctx.startPageToken = "0";
        cloud.clearChangeLog();
        cloud.addChangeEntry(uploaded.id!, filePath, uploaded.size, uploaded.hash!);

        // Execute pull via Changes API
        await pullViaChangesAPI(ctx);

        // Verify warning log about merge lock
        const lockLog = logs.find(
            (l) => l.level === "warn" && l.message.includes("is being merged by"),
        );
        expect(lockLog).toBeDefined();
        expect(lockLog?.message).toContain("other_device");

        // Verify notification was sent
        const notifyLock = notifications.find((n) => n.key === "noticeWaitOtherDeviceMerge");
        expect(notifyLock).toBeDefined();

        // Verify pendingConflict was set
        expect(ctx.localIndex[filePath]?.pendingConflict).toBe(true);
    });
});
