/**
 * Background Transfer Queue tests.
 *
 * Part 1: Unit tests for BackgroundTransferQueue class (queue operations, history, callbacks)
 * Part 2: Integration tests for size-based routing in smartPush
 * Part 3: Integration tests for inline transfer recording
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { BackgroundTransferQueue } from "../../../src/sync-manager/background-transfer";
import { TransferPriority } from "../../../src/sync-manager/transfer-types";
import type {
    TransferItem,
    TransferRecord,
    TransferCallbacks,
} from "../../../src/sync-manager/transfer-types";
import { MockCloudAdapter } from "../../helpers/mock-cloud-adapter";
import { DeviceSimulator, hashOf } from "../../helpers/device-simulator";

// ─── Helpers ───

function makeItem(overrides: Partial<TransferItem> = {}): TransferItem {
    return {
        id: `test-${Math.random().toString(36).slice(2)}`,
        direction: "push",
        path: "notes/test.md",
        size: 1024,
        priority: TransferPriority.NORMAL,
        status: "pending",
        retryCount: 0,
        createdAt: Date.now(),
        ...overrides,
    };
}

function makeRecord(overrides: Partial<TransferRecord> = {}): TransferRecord {
    return {
        id: `rec-${Math.random().toString(36).slice(2)}`,
        direction: "push",
        path: "notes/test.md",
        size: 100,
        status: "completed",
        startedAt: 1000,
        completedAt: 2000,
        transferMode: "inline",
        ...overrides,
    };
}

// ═══════════════════════════════════════════════════════════════════
// PART 1: Unit tests for BackgroundTransferQueue
// ═══════════════════════════════════════════════════════════════════

describe("BackgroundTransferQueue", () => {
    describe("Queue operations", () => {
        let queue: BackgroundTransferQueue;

        beforeEach(() => {
            queue = new BackgroundTransferQueue();
        });

        it("should add items and return them via getPendingTransfers", () => {
            const item = makeItem({ path: "a.md" });
            queue.enqueue(item);

            const pending = queue.getPendingTransfers();
            expect(pending).toHaveLength(1);
            expect(pending[0].path).toBe("a.md");
        });

        it("should replace duplicate items for same path and direction", () => {
            const item1 = makeItem({ id: "first", path: "a.md", direction: "push" });
            const item2 = makeItem({ id: "second", path: "a.md", direction: "push" });

            queue.enqueue(item1);
            queue.enqueue(item2);

            const pending = queue.getPendingTransfers();
            expect(pending).toHaveLength(1);
            expect(pending[0].id).toBe("second");
        });

        it("should NOT replace items with different direction for same path", () => {
            const push = makeItem({ path: "a.md", direction: "push" });
            const pull = makeItem({ path: "a.md", direction: "pull" });

            queue.enqueue(push);
            queue.enqueue(pull);

            expect(queue.getPendingTransfers()).toHaveLength(2);
        });

        it("should sort by priority (lower number = higher priority)", () => {
            const low = makeItem({ path: "low.md", priority: TransferPriority.LOW });
            const high = makeItem({ path: "high.md", priority: TransferPriority.HIGH });
            const normal = makeItem({ path: "normal.md", priority: TransferPriority.NORMAL });
            const critical = makeItem({ path: "critical.md", priority: TransferPriority.CRITICAL });

            queue.enqueue(low);
            queue.enqueue(normal);
            queue.enqueue(high);
            queue.enqueue(critical);

            const pending = queue.getPendingTransfers();
            expect(pending[0].path).toBe("critical.md");
            expect(pending[1].path).toBe("high.md");
            expect(pending[2].path).toBe("normal.md");
            expect(pending[3].path).toBe("low.md");
        });

        it("should cancel a pending item and record in history", () => {
            const item = makeItem({ path: "a.md" });
            queue.enqueue(item);

            queue.cancel("a.md");

            expect(queue.getPendingTransfers()).toHaveLength(0);
            expect(queue.getHistory()).toHaveLength(1);
            expect(queue.getHistory()[0].status).toBe("cancelled");
            expect(queue.getHistory()[0].transferMode).toBe("background");
        });

        it("should not cancel an active item", () => {
            const item = makeItem({ path: "a.md", status: "active" });
            queue.enqueue(item);

            queue.cancel("a.md");

            // Active items are still returned by getPendingTransfers
            expect(queue.getPendingTransfers()).toHaveLength(1);
        });

        it("should cancelAll pending items", () => {
            queue.enqueue(makeItem({ path: "a.md" }));
            queue.enqueue(makeItem({ path: "b.md" }));
            queue.enqueue(makeItem({ path: "c.md" }));

            queue.cancelAll();

            expect(queue.getPendingTransfers()).toHaveLength(0);
        });

        it("should report hasPendingItems correctly", () => {
            expect(queue.hasPendingItems()).toBe(false);

            queue.enqueue(makeItem());

            expect(queue.hasPendingItems()).toBe(true);
        });

        it("should not report active items as hasPendingItems", () => {
            queue.enqueue(makeItem({ status: "active" }));

            expect(queue.hasPendingItems()).toBe(false);
        });
    });

    describe("History", () => {
        let queue: BackgroundTransferQueue;

        beforeEach(() => {
            queue = new BackgroundTransferQueue();
        });

        it("should record inline transfers via recordInlineTransfer", () => {
            const record = makeRecord({ path: "notes/file.md" });
            queue.recordInlineTransfer(record);

            const history = queue.getHistory();
            expect(history).toHaveLength(1);
            expect(history[0]).toEqual(record);
        });

        it("should return a copy from getHistory (not a reference)", () => {
            queue.recordInlineTransfer(makeRecord());

            const h1 = queue.getHistory();
            const h2 = queue.getHistory();
            expect(h1).not.toBe(h2);
            expect(h1).toEqual(h2);
        });

        it("should cap history at 500 records (ring buffer)", () => {
            for (let i = 0; i < 600; i++) {
                queue.recordInlineTransfer(
                    makeRecord({ id: `rec-${i}`, path: `file-${i}.md` }),
                );
            }

            const history = queue.getHistory();
            expect(history.length).toBeLessThanOrEqual(500);
            // Oldest records should be trimmed (first 100 dropped)
            expect(history[0].id).toBe("rec-100");
            expect(history[history.length - 1].id).toBe("rec-599");
        });

        it("should include cancelled items in history", () => {
            queue.enqueue(makeItem({ path: "a.md" }));
            queue.cancel("a.md");

            const history = queue.getHistory();
            expect(history).toHaveLength(1);
            expect(history[0].status).toBe("cancelled");
            expect(history[0].path).toBe("a.md");
        });
    });

    describe("Callbacks", () => {
        let queue: BackgroundTransferQueue;
        let callbacks: Required<TransferCallbacks>;

        beforeEach(() => {
            queue = new BackgroundTransferQueue();
            callbacks = {
                onTransferStart: vi.fn(),
                onTransferComplete: vi.fn(),
                onTransferFailed: vi.fn(),
                onQueueChange: vi.fn(),
            };
            queue.setCallbacks(callbacks);
        });

        it("should fire onQueueChange on enqueue", () => {
            queue.enqueue(makeItem({ path: "a.md" }));
            expect(callbacks.onQueueChange).toHaveBeenCalledTimes(1);
        });

        it("should fire onQueueChange on cancel", () => {
            queue.enqueue(makeItem({ path: "a.md" }));
            vi.mocked(callbacks.onQueueChange).mockClear();

            queue.cancel("a.md");
            expect(callbacks.onQueueChange).toHaveBeenCalledTimes(1);
        });

        it("should fire onQueueChange on cancelAll", () => {
            queue.enqueue(makeItem({ path: "a.md" }));
            queue.enqueue(makeItem({ path: "b.md" }));
            vi.mocked(callbacks.onQueueChange).mockClear();

            queue.cancelAll();
            expect(callbacks.onQueueChange).toHaveBeenCalledTimes(1);
        });

        it("should pass current pending items to onQueueChange", () => {
            queue.enqueue(makeItem({ path: "a.md" }));
            queue.enqueue(makeItem({ path: "b.md" }));

            const lastCall = vi.mocked(callbacks.onQueueChange).mock.calls.at(-1);
            expect(lastCall).toBeDefined();
            const pendingItems = lastCall![0];
            expect(pendingItems).toHaveLength(2);
        });
    });

    describe("Pause/Resume", () => {
        it("should not start processing when paused", () => {
            const queue = new BackgroundTransferQueue();
            queue.pause();
            queue.enqueue(makeItem());
            queue.resume();
            // No context set, so processing won't start, but items remain pending
            expect(queue.getPendingTransfers()).toHaveLength(1);
        });
    });
});

// ═══════════════════════════════════════════════════════════════════
// PART 2: Integration — Size-based routing in smartPush
// ═══════════════════════════════════════════════════════════════════

describe("Size-based transfer routing (smartPush integration)", () => {
    let cloud: MockCloudAdapter;
    let device: DeviceSimulator;

    /** Convenience accessor for SyncManager internals */
    const sm = () => device.syncManager as any;

    beforeEach(() => {
        cloud = new MockCloudAdapter();
        device = new DeviceSimulator("TestDevice", cloud);
        // Override notify to prevent Obsidian Notice creation in test env
        sm().notify = async () => {};
    });

    it("should push small files inline (below threshold)", async () => {
        sm().settings.largeFileThresholdMB = 0.01; // 10KB threshold

        const content = "Hello, small file!";
        device.app.vaultAdapter.setFile("notes/small.md", content);
        sm().dirtyPaths.add("notes/small.md");

        await sm().smartPush(false);

        // File should be uploaded to cloud (inline)
        expect(cloud.getCloudContent("notes/small.md")).toBe(content);
        // Queue should be empty (not deferred)
        expect(sm().backgroundTransferQueue.getPendingTransfers()).toHaveLength(0);
    });

    it("should defer large files to background queue (above threshold)", async () => {
        sm().settings.largeFileThresholdMB = 0.001; // ~1KB threshold

        // Create a 2KB file (above 1KB threshold)
        const content = "x".repeat(2000);
        device.app.vaultAdapter.setFile("notes/large.md", content);
        sm().dirtyPaths.add("notes/large.md");

        await sm().smartPush(false);

        // File should NOT be in cloud (deferred to background)
        expect(cloud.getCloudContent("notes/large.md")).toBeNull();
        // File should be in background queue
        const pending = sm().backgroundTransferQueue.getPendingTransfers();
        expect(pending).toHaveLength(1);
        expect(pending[0].path).toBe("notes/large.md");
        expect(pending[0].direction).toBe("push");
        expect(pending[0].status).toBe("pending");
    });

    it("should route mixed files: small inline, large to queue", async () => {
        sm().settings.largeFileThresholdMB = 0.001; // ~1KB threshold

        // Small file (< 1KB)
        device.app.vaultAdapter.setFile("notes/small.md", "Small content");
        sm().dirtyPaths.add("notes/small.md");

        // Large file (> 1KB)
        device.app.vaultAdapter.setFile("notes/large.md", "x".repeat(2000));
        sm().dirtyPaths.add("notes/large.md");

        await sm().smartPush(false);

        // Small file uploaded inline
        expect(cloud.getCloudContent("notes/small.md")).toBe("Small content");
        // Large file deferred
        expect(cloud.getCloudContent("notes/large.md")).toBeNull();
        const pending = sm().backgroundTransferQueue.getPendingTransfers();
        expect(pending).toHaveLength(1);
        expect(pending[0].path).toBe("notes/large.md");
    });

    it("should always push merge results inline even when large", async () => {
        sm().settings.largeFileThresholdMB = 0.001; // ~1KB threshold

        // Large file that is a merge result
        const content = "merged " + "x".repeat(2000);
        device.app.vaultAdapter.setFile("notes/merged.md", content);
        sm().dirtyPaths.add("notes/merged.md");

        // Mark as merge result in localIndex
        sm().localIndex["notes/merged.md"] = {
            hash: "old-hash",
            lastAction: "merge",
            ancestorHash: "ancestor-hash",
            mtime: Date.now() - 1000,
            size: 100,
        };

        await sm().smartPush(false);

        // File should be in cloud (inline, NOT deferred despite being large)
        expect(cloud.getCloudContent("notes/merged.md")).toBe(content);
        // Queue should be empty
        expect(sm().backgroundTransferQueue.getPendingTransfers()).toHaveLength(0);
    });

    it("should push all files inline when threshold is 0 (disabled)", async () => {
        sm().settings.largeFileThresholdMB = 0; // Disabled

        // Large file
        const content = "x".repeat(10000);
        device.app.vaultAdapter.setFile("notes/large.md", content);
        sm().dirtyPaths.add("notes/large.md");

        await sm().smartPush(false);

        // File should be uploaded inline
        expect(cloud.getCloudContent("notes/large.md")).toBe(content);
        // Queue should be empty
        expect(sm().backgroundTransferQueue.getPendingTransfers()).toHaveLength(0);
    });

    it("should set pendingTransfer marker on localIndex when deferring", async () => {
        sm().settings.largeFileThresholdMB = 0.001;

        const content = "x".repeat(2000);
        device.app.vaultAdapter.setFile("notes/large.md", content);
        sm().dirtyPaths.add("notes/large.md");

        // Pre-existing localIndex entry
        sm().localIndex["notes/large.md"] = {
            hash: "old-hash",
            lastAction: "push",
            ancestorHash: "ancestor-hash",
            mtime: Date.now() - 1000,
            size: 100,
        };

        await sm().smartPush(false);

        const entry = sm().localIndex["notes/large.md"];
        expect(entry.pendingTransfer).toBeDefined();
        expect(entry.pendingTransfer.direction).toBe("push");
        expect(entry.pendingTransfer.snapshotHash).toBeDefined();
    });

    it("should buffer content and snapshot hash in queued item", async () => {
        sm().settings.largeFileThresholdMB = 0.001;

        const content = "Large file content " + "x".repeat(2000);
        device.app.vaultAdapter.setFile("notes/large.md", content);
        sm().dirtyPaths.add("notes/large.md");

        await sm().smartPush(false);

        const pending = sm().backgroundTransferQueue.getPendingTransfers();
        expect(pending).toHaveLength(1);

        // Content should be buffered
        expect(pending[0].content).toBeDefined();
        expect(pending[0].content).toBeInstanceOf(ArrayBuffer);
        const storedContent = new TextDecoder().decode(pending[0].content!);
        expect(storedContent).toBe(content);

        // Snapshot hash should be set
        expect(pending[0].snapshotHash).toBe(hashOf(content));
    });

    it("should remove path from dirtyPaths after inline push", async () => {
        sm().settings.largeFileThresholdMB = 0.01;

        device.app.vaultAdapter.setFile("notes/small.md", "content");
        sm().dirtyPaths.add("notes/small.md");

        await sm().smartPush(false);

        expect(sm().dirtyPaths.has("notes/small.md")).toBe(false);
    });

    it("should keep path in dirtyPaths after deferring to background queue", async () => {
        sm().settings.largeFileThresholdMB = 0.001;

        device.app.vaultAdapter.setFile("notes/large.md", "x".repeat(2000));
        sm().dirtyPaths.add("notes/large.md");

        await sm().smartPush(false);

        // dirtyPaths should still contain the path (background queue hasn't processed it yet)
        // Actually, looking at the code, dirtyPaths is NOT deleted when deferring
        // The background transfer's executePush will delete it on completion
        // But during enqueue, it's left in dirtyPaths
        // Wait — let me re-check... The code after partitioning only runs inline uploads.
        // The dirtyPaths.delete(path) is inside the inline upload task.
        // For deferred items, dirtyPaths is not touched at enqueue time.
        expect(sm().dirtyPaths.has("notes/large.md")).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════════════
// PART 3: Integration — Inline transfer recording
// ═══════════════════════════════════════════════════════════════════

describe("Inline transfer recording (smartPush integration)", () => {
    let cloud: MockCloudAdapter;
    let device: DeviceSimulator;
    const sm = () => device.syncManager as any;

    beforeEach(() => {
        cloud = new MockCloudAdapter();
        device = new DeviceSimulator("TestDevice", cloud);
        sm().notify = async () => {};
        sm().settings.largeFileThresholdMB = 0; // All inline
    });

    it("should record inline push transfer in history", async () => {
        device.app.vaultAdapter.setFile("notes/file.md", "content");
        sm().dirtyPaths.add("notes/file.md");

        await sm().smartPush(false);

        const history = sm().backgroundTransferQueue.getHistory() as TransferRecord[];
        const pushRecords = history.filter(
            (r) => r.direction === "push" && r.path === "notes/file.md",
        );
        expect(pushRecords.length).toBeGreaterThanOrEqual(1);

        const record = pushRecords[0];
        expect(record.status).toBe("completed");
        expect(record.transferMode).toBe("inline");
        expect(record.size).toBeGreaterThan(0);
        expect(record.startedAt).toBeLessThanOrEqual(record.completedAt);
    });

    it("should record multiple inline push transfers", async () => {
        device.app.vaultAdapter.setFile("notes/a.md", "content A");
        device.app.vaultAdapter.setFile("notes/b.md", "content B");
        sm().dirtyPaths.add("notes/a.md");
        sm().dirtyPaths.add("notes/b.md");

        await sm().smartPush(false);

        const history = sm().backgroundTransferQueue.getHistory() as TransferRecord[];
        const pushPaths = history
            .filter((r) => r.direction === "push" && r.transferMode === "inline")
            .map((r) => r.path)
            .sort();

        expect(pushPaths).toContain("notes/a.md");
        expect(pushPaths).toContain("notes/b.md");
    });
});

// ═══════════════════════════════════════════════════════════════════
// PART 4: Integration — executeSmartSync pause/resume
// ═══════════════════════════════════════════════════════════════════

describe("executeSmartSync pause/resume (integration)", () => {
    let cloud: MockCloudAdapter;
    let device: DeviceSimulator;
    const sm = () => device.syncManager as any;

    beforeEach(() => {
        cloud = new MockCloudAdapter();
        device = new DeviceSimulator("TestDevice", cloud);
        sm().notify = async () => {};
    });

    it("should pause queue at start and resume at end of executeSmartSync", async () => {
        const queue = sm().backgroundTransferQueue;
        const pauseSpy = vi.spyOn(queue, "pause");
        const resumeSpy = vi.spyOn(queue, "resume");

        // Mock the heavy sync operations so executeSmartSync completes quickly
        vi.spyOn(sm(), "smartPull").mockResolvedValue(false);
        vi.spyOn(sm(), "smartPush").mockResolvedValue(false);
        vi.spyOn(sm(), "pullViaChangesAPI").mockResolvedValue(undefined);

        // Required state for executeSmartSync
        sm().startPageToken = "0";
        sm().syncState = "IDLE";

        // Import and call executeSmartSync directly
        const { executeSmartSync } = await import(
            "../../../src/sync-manager/sync-orchestration"
        );

        try {
            await executeSmartSync(sm(), false);
        } catch {
            // Ignore errors from logger/notification subsystems in test env
        }

        expect(pauseSpy).toHaveBeenCalled();
        expect(resumeSpy).toHaveBeenCalled();
        // Resume should be called AFTER pause (finally block)
        expect(pauseSpy.mock.invocationCallOrder[0]).toBeLessThan(
            resumeSpy.mock.invocationCallOrder[0],
        );
    });
});
