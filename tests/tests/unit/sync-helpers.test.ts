/**
 * @file sync-helpers.ts Unit Tests
 *
 * @description
 * Tests for sync-helpers module to achieve 100% coverage:
 * - downloadRemoteIndex (lines 17-22)
 * - getThresholdBytes (lines 24-26)
 * - computeLocalHash (lines 6-15)
 * - generateTransferId (lines 28-30)
 * - markPendingTransfer (lines 32-44)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
    computeLocalHash,
    downloadRemoteIndex,
    getThresholdBytes,
    generateTransferId,
    markPendingTransfer,
} from "../../../src/sync-manager/sync-helpers";
import type { SyncContext } from "../../../src/sync-manager/context";
import type { LocalFileIndex } from "../../../src/sync-manager/types";
import type { CloudAdapter } from "../../../src/types/adapter";
import { MockCloudAdapter } from "../../helpers/mock-cloud-adapter";

describe("sync-helpers", () => {
    let mockAdapter: MockCloudAdapter;
    let baseCtx: Partial<SyncContext>;

    beforeEach(() => {
        mockAdapter = new MockCloudAdapter();
        baseCtx = {
            adapter: mockAdapter as unknown as CloudAdapter,
            e2eeEnabled: false,
            settings: {
                largeFileThresholdMB: 10,
                concurrency: 2,
                notificationLevel: "standard",
                conflictResolutionStrategy: "smart-merge",
                enableLogging: false,
                isDeveloperMode: false,
                exclusionPatterns: "",
                bgTransferIntervalSec: 0,
                syncAppearance: true,
                syncCommunityPlugins: true,
                syncCoreConfig: true,
                syncImagesAndMedia: true,
                syncDotfiles: false,
                syncPluginSettings: true,
                syncFlexibleData: true,
                syncDeviceLogs: false,
                syncWorkspace: false,
                hasCompletedFirstSync: false,
                e2eeEnabled: false,
            },
            localIndex: {},
        };
    });

    describe("downloadRemoteIndex", () => {
        it("should return data.index when it exists (line 21)", async () => {
            const testIndex: LocalFileIndex = {
                "notes/test.md": {
                    fileId: "file_1",
                    mtime: Date.now(),
                    size: 100,
                    hash: "abc123",
                },
            };

            // Upload a valid index file with 'index' property
            const indexData = { index: testIndex, version: 1 };
            const uploaded = await mockAdapter.uploadFile(
                "sync-index.json",
                new TextEncoder().encode(JSON.stringify(indexData)).buffer as ArrayBuffer,
                Date.now(),
            );

            const ctx = baseCtx as SyncContext;
            const result = await downloadRemoteIndex(ctx, uploaded.id);

            expect(result).toEqual(testIndex);
        });

        it("should return empty object when data.index is undefined (line 21 - coverage for || {})", async () => {
            // Upload a file without 'index' property (to trigger the || {} fallback)
            const dataWithoutIndex = { version: 1, deviceId: "test" };
            const uploaded = await mockAdapter.uploadFile(
                "sync-index-no-index.json",
                new TextEncoder().encode(JSON.stringify(dataWithoutIndex)).buffer as ArrayBuffer,
                Date.now(),
            );

            const ctx = baseCtx as SyncContext;
            const result = await downloadRemoteIndex(ctx, uploaded.id);

            expect(result).toEqual({});
        });

        it("should return empty object when data.index is null (line 21 - coverage for || {})", async () => {
            // Upload a file with null index (to trigger the || {} fallback)
            const dataWithNullIndex = { index: null, version: 1 };
            const uploaded = await mockAdapter.uploadFile(
                "sync-index-null.json",
                new TextEncoder().encode(JSON.stringify(dataWithNullIndex)).buffer as ArrayBuffer,
                Date.now(),
            );

            const ctx = baseCtx as SyncContext;
            const result = await downloadRemoteIndex(ctx, uploaded.id);

            expect(result).toEqual({});
        });
    });

    describe("getThresholdBytes", () => {
        it("should return correct bytes for largeFileThresholdMB (line 25)", () => {
            const ctx = {
                ...baseCtx,
                settings: { largeFileThresholdMB: 5 },
            } as SyncContext;

            const result = getThresholdBytes(ctx);

            expect(result).toBe(5 * 1024 * 1024);
        });

        it("should return 0 when largeFileThresholdMB is 0 (line 25)", () => {
            const ctx = {
                ...baseCtx,
                settings: { largeFileThresholdMB: 0 },
            } as SyncContext;

            const result = getThresholdBytes(ctx);

            expect(result).toBe(0);
        });

        it("should return 0 when largeFileThresholdMB is undefined (line 25 - coverage for ?? 0)", () => {
            const ctx = {
                ...baseCtx,
                settings: {},
            } as SyncContext;

            const result = getThresholdBytes(ctx);

            expect(result).toBe(0);
        });

        it("should return correct bytes for decimal MB values (line 25)", () => {
            const ctx = {
                ...baseCtx,
                settings: { largeFileThresholdMB: 1.5 },
            } as SyncContext;

            const result = getThresholdBytes(ctx);

            expect(result).toBe(1.5 * 1024 * 1024);
        });
    });

    describe("computeLocalHash", () => {
        it("should compute MD5 hash when E2EE is disabled", async () => {
            const ctx = {
                ...baseCtx,
                e2eeEnabled: false,
            } as SyncContext;

            const content = new TextEncoder().encode("test content").buffer as ArrayBuffer;
            const indexEntry = { hash: "abc123" };

            const result = await computeLocalHash(ctx, content, indexEntry);

            expect(result.localHash).toBeDefined();
            expect(result.localHash.length).toBe(32); // MD5 is 32 hex chars
            expect(result.compareHash).toBe("abc123");
        });

        it("should compute content hash and use plainHash when E2EE is enabled and plainHash exists", async () => {
            const ctx = {
                ...baseCtx,
                e2eeEnabled: true,
            } as SyncContext;

            const content = new TextEncoder().encode("test content").buffer as ArrayBuffer;
            const indexEntry = { hash: "encrypted_hash", plainHash: "plain_abc123" };

            const result = await computeLocalHash(ctx, content, indexEntry);

            expect(result.localHash).toBeDefined();
            expect(result.compareHash).toBe("plain_abc123");
        });

        it("should compute MD5 hash when E2EE is enabled but plainHash is missing", async () => {
            const ctx = {
                ...baseCtx,
                e2eeEnabled: true,
            } as SyncContext;

            const content = new TextEncoder().encode("test content").buffer as ArrayBuffer;
            const indexEntry = { hash: "encrypted_hash" };

            const result = await computeLocalHash(ctx, content, indexEntry);

            expect(result.localHash).toBeDefined();
            expect(result.localHash.length).toBe(32); // MD5 is 32 hex chars
            expect(result.compareHash).toBe("encrypted_hash");
        });
    });

    describe("generateTransferId", () => {
        it("should generate unique transfer IDs for push direction", () => {
            const id1 = generateTransferId("push");
            const id2 = generateTransferId("push");

            expect(id1).toMatch(/^bg-push-\d+-[a-z0-9]+$/);
            expect(id2).toMatch(/^bg-push-\d+-[a-z0-9]+$/);
            expect(id1).not.toBe(id2);
        });

        it("should generate unique transfer IDs for pull direction", () => {
            const id1 = generateTransferId("pull");
            const id2 = generateTransferId("pull");

            expect(id1).toMatch(/^bg-pull-\d+-[a-z0-9]+$/);
            expect(id2).toMatch(/^bg-pull-\d+-[a-z0-9]+$/);
            expect(id1).not.toBe(id2);
        });
    });

    describe("markPendingTransfer", () => {
        it("should mark pending transfer for existing local index entry", () => {
            const ctx = {
                ...baseCtx,
                localIndex: {
                    "notes/test.md": {
                        fileId: "file_1",
                        mtime: Date.now(),
                        size: 100,
                        hash: "abc123",
                    },
                },
            } as unknown as SyncContext;

            const beforeTime = Date.now();
            markPendingTransfer(ctx, "notes/test.md", "push", "snapshot_abc");
            const afterTime = Date.now();

            const entry = ctx.localIndex["notes/test.md"];
            expect(entry.pendingTransfer).toBeDefined();
            expect(entry.pendingTransfer?.direction).toBe("push");
            expect(entry.pendingTransfer?.snapshotHash).toBe("snapshot_abc");
            expect(entry.pendingTransfer?.enqueuedAt).toBeGreaterThanOrEqual(beforeTime);
            expect(entry.pendingTransfer?.enqueuedAt).toBeLessThanOrEqual(afterTime);
        });

        it("should do nothing when local index entry does not exist", () => {
            const ctx = {
                ...baseCtx,
                localIndex: {},
            } as SyncContext;

            // Should not throw
            markPendingTransfer(ctx, "notes/nonexistent.md", "pull", "snapshot_xyz");

            expect(ctx.localIndex["notes/nonexistent.md"]).toBeUndefined();
        });

        it("should mark pending transfer with pull direction", () => {
            const ctx = {
                ...baseCtx,
                localIndex: {
                    "notes/test.md": {
                        fileId: "file_1",
                        mtime: Date.now(),
                        size: 100,
                        hash: "abc123",
                    },
                },
            } as unknown as SyncContext;

            markPendingTransfer(ctx, "notes/test.md", "pull", "snapshot_def");

            const entry = ctx.localIndex["notes/test.md"];
            expect(entry.pendingTransfer?.direction).toBe("pull");
            expect(entry.pendingTransfer?.snapshotHash).toBe("snapshot_def");
        });
    });
});
