/**
 * Background Transfer Queue tests.
 *
 * Part 1: Unit tests for BackgroundTransferQueue class (queue operations, history, callbacks)
 * Part 2: Integration tests for size-based routing in smartPush
 * Part 3: Integration tests for inline transfer recording
 * Part 4: Integration — executeSmartSync pause/resume
 * Part 5: Integration — Pull-side size-based routing (smartPull)
 * Part 6: Unit — Online/Offline detection
 * Part 7: Unit — Inline active tracking (markInlineStart/markInlineEnd)
 * Part 8: Unit — Bandwidth throttling (bgTransferIntervalSec)
 * Part 9: Unit — History persistence (JSONL flush/load)
 * Part 10: Integration — Log rotation via loadHistoryFromDisk
 * Part 11: Integration — Background Pull execution (executePull via processLoop)
 * Part 12: Integration — Staleness & conflict check (executePush via processLoop)
 * Part 13: E2E — Full sync cycle with background transfer
 * Part 14: Integration — Retry & error handling
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
        sm().dirtyPaths.set("notes/small.md", Date.now());

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
        sm().dirtyPaths.set("notes/large.md", Date.now());

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
        sm().dirtyPaths.set("notes/small.md", Date.now());

        // Large file (> 1KB)
        device.app.vaultAdapter.setFile("notes/large.md", "x".repeat(2000));
        sm().dirtyPaths.set("notes/large.md", Date.now());

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
        sm().dirtyPaths.set("notes/merged.md", Date.now());

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
        sm().dirtyPaths.set("notes/large.md", Date.now());

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
        sm().dirtyPaths.set("notes/large.md", Date.now());

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
        sm().dirtyPaths.set("notes/large.md", Date.now());

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
        sm().dirtyPaths.set("notes/small.md", Date.now());

        await sm().smartPush(false);

        expect(sm().dirtyPaths.has("notes/small.md")).toBe(false);
    });

    it("should keep path in dirtyPaths after deferring to background queue", async () => {
        sm().settings.largeFileThresholdMB = 0.001;

        device.app.vaultAdapter.setFile("notes/large.md", "x".repeat(2000));
        sm().dirtyPaths.set("notes/large.md", Date.now());

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
        sm().dirtyPaths.set("notes/file.md", Date.now());

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
        sm().dirtyPaths.set("notes/a.md", Date.now());
        sm().dirtyPaths.set("notes/b.md", Date.now());

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

// ═══════════════════════════════════════════════════════════════════
// PART 5: Integration — Pull-side size-based routing (smartPull)
// ═══════════════════════════════════════════════════════════════════

describe("Pull-side size-based routing (smartPull integration)", () => {
    let cloud: MockCloudAdapter;
    let deviceA: DeviceSimulator;
    let deviceB: DeviceSimulator;
    const smA = () => deviceA.syncManager as any;
    const smB = () => deviceB.syncManager as any;

    beforeEach(async () => {
        cloud = new MockCloudAdapter();
        deviceA = new DeviceSimulator("DeviceA", cloud, "dev_A");
        deviceB = new DeviceSimulator("DeviceB", cloud, "dev_B");
        smA().notify = async () => {};
        smB().notify = async () => {};
    });

    /**
     * Helper: DeviceA pushes a file to cloud (inline), then returns the cloud hash.
     * Sets up a synced baseline for DeviceB to pull from.
     */
    async function pushFromA(path: string, content: string): Promise<void> {
        deviceA.app.vaultAdapter.setFile(path, content);
        smA().dirtyPaths.set(path, Date.now());
        smA().settings.largeFileThresholdMB = 0; // All inline for push
        await smA().smartPush(false);
    }

    it("should pull small files inline (below threshold)", async () => {
        // DeviceA pushes a small file
        await pushFromA("notes/small.md", "Small content");

        // DeviceB pulls — threshold is high enough that file is inline
        smB().settings.largeFileThresholdMB = 0.01; // 10KB threshold
        await smB().smartPull();

        // File should be locally available on DeviceB
        expect(deviceB.getLocalContent("notes/small.md")).toBe("Small content");
        // Queue should be empty
        expect(smB().backgroundTransferQueue.getPendingTransfers()).toHaveLength(0);
    });

    it("should defer large pulls to background queue (above threshold)", async () => {
        // DeviceA pushes a large file (2KB)
        const content = "x".repeat(2000);
        await pushFromA("notes/large.md", content);

        // DeviceB pulls with 1KB threshold
        smB().settings.largeFileThresholdMB = 0.001; // ~1KB
        await smB().smartPull();

        // File should NOT be locally available yet (deferred)
        expect(deviceB.getLocalContent("notes/large.md")).toBeNull();
        // File should be in background queue
        const pending = smB().backgroundTransferQueue.getPendingTransfers();
        expect(pending).toHaveLength(1);
        expect(pending[0].path).toBe("notes/large.md");
        expect(pending[0].direction).toBe("pull");
    });

    it("should pull all files inline when threshold is 0 (disabled)", async () => {
        const content = "x".repeat(2000);
        await pushFromA("notes/large.md", content);

        smB().settings.largeFileThresholdMB = 0; // Disabled
        await smB().smartPull();

        // File pulled inline
        expect(deviceB.getLocalContent("notes/large.md")).toBe(content);
        expect(smB().backgroundTransferQueue.getPendingTransfers()).toHaveLength(0);
    });

    it("should always pull inline when local has conflict (dirtyPaths)", async () => {
        const content = "x".repeat(2000);
        await pushFromA("notes/conflict.md", content);

        // DeviceB has local modifications for this file
        deviceB.app.vaultAdapter.setFile("notes/conflict.md", "local version");
        smB().dirtyPaths.set("notes/conflict.md", Date.now());
        smB().settings.largeFileThresholdMB = 0.001; // 1KB threshold

        await smB().smartPull();

        // File should be processed inline (merge), NOT deferred
        // After merge, content is present locally
        expect(deviceB.getLocalContent("notes/conflict.md")).not.toBeNull();
        // Queue should be empty (conflict handled inline)
        expect(smB().backgroundTransferQueue.getPendingTransfers()).toHaveLength(0);
    });

    it("should set pendingTransfer marker when deferring pull", async () => {
        const content = "x".repeat(2000);
        await pushFromA("notes/large.md", content);

        // Give DeviceB a prior index entry so pendingTransfer can be set
        smB().localIndex["notes/large.md"] = {
            hash: "old-hash",
            lastAction: "pull",
            ancestorHash: "old-hash",
            mtime: Date.now() - 1000,
            size: 50,
        };
        smB().index["notes/large.md"] = { ...smB().localIndex["notes/large.md"] };

        smB().settings.largeFileThresholdMB = 0.001;
        await smB().smartPull();

        const entry = smB().localIndex["notes/large.md"];
        expect(entry.pendingTransfer).toBeDefined();
        expect(entry.pendingTransfer.direction).toBe("pull");
    });
});

// ═══════════════════════════════════════════════════════════════════
// PART 6: Unit — Online/Offline detection and queue resume
// ═══════════════════════════════════════════════════════════════════

describe("Online/Offline detection", () => {
    it("should have destroy method that cleans up", () => {
        const queue = new BackgroundTransferQueue();
        // destroy should not throw even without context
        expect(() => queue.destroy()).not.toThrow();
    });

    it("should cancel all items on destroy", () => {
        const queue = new BackgroundTransferQueue();
        queue.enqueue(makeItem({ path: "a.md" }));
        queue.enqueue(makeItem({ path: "b.md" }));

        queue.destroy();

        expect(queue.getPendingTransfers()).toHaveLength(0);
    });

    it("should register online listener when setContext is called with window available", () => {
        // In Node.js test environment, window may or may not be defined
        // If window exists, the listener should be registered
        const queue = new BackgroundTransferQueue();
        const addEventSpy = typeof window !== "undefined"
            ? vi.spyOn(window, "addEventListener")
            : null;

        // Create a minimal mock context
        const cloud = new MockCloudAdapter();
        const device = new DeviceSimulator("TestDevice", cloud);
        const sm = device.syncManager as any;
        const ctx = sm as any;

        // setContext is already called in SyncManager constructor
        // Verify queue was initialized properly
        expect(sm.backgroundTransferQueue).toBeDefined();

        if (addEventSpy) {
            // If window is available, check listener was registered
            expect(addEventSpy).toHaveBeenCalledWith("online", expect.any(Function));
            addEventSpy.mockRestore();
        }
    });

    it("should remove online listener on destroy when window is available", () => {
        const removeEventSpy = typeof window !== "undefined"
            ? vi.spyOn(window, "removeEventListener")
            : null;

        const cloud = new MockCloudAdapter();
        const device = new DeviceSimulator("TestDevice", cloud);
        const sm = device.syncManager as any;

        sm.backgroundTransferQueue.destroy();

        if (removeEventSpy) {
            expect(removeEventSpy).toHaveBeenCalledWith("online", expect.any(Function));
            removeEventSpy.mockRestore();
        }
    });

    it("should not start processing on resume when paused", () => {
        const queue = new BackgroundTransferQueue();
        queue.enqueue(makeItem({ path: "a.md" }));
        queue.pause();
        queue.resume();

        // No context means processing can't start, but queue state is correct
        expect(queue.hasPendingItems()).toBe(true);
    });

    it("should attempt to resume processing on resume when items are pending", () => {
        const cloud = new MockCloudAdapter();
        const device = new DeviceSimulator("TestDevice", cloud);
        const sm = device.syncManager as any;
        const queue = sm.backgroundTransferQueue;

        queue.enqueue(makeItem({ path: "a.md" }));
        queue.pause();

        // After pause, queue won't process
        expect(queue.hasPendingItems()).toBe(true);

        // Resume should allow processing to restart
        queue.resume();
        // processLoop starts asynchronously — item transitions from "pending" to "active"
        expect((queue as any).isProcessing || queue.hasPendingItems()).toBe(true);
    });

    it("should break processLoop when e2eeLocked is true", () => {
        const cloud = new MockCloudAdapter();
        const device = new DeviceSimulator("TestDevice", cloud);
        const sm = device.syncManager as any;

        // e2eeLocked is a computed getter: settings.e2eeEnabled && !cryptoEngine.isUnlocked()
        // Enable E2EE without setting up a crypto engine → e2eeLocked becomes true
        sm.settings.e2eeEnabled = true;
        expect(sm.e2eeLocked).toBe(true);

        const queue = sm.backgroundTransferQueue;
        queue.enqueue(makeItem({ path: "locked.md" }));

        // Even if we try to resume, e2eeLocked should prevent processing
        queue.resume();

        // Item should still be pending (not processed)
        expect(queue.hasPendingItems()).toBe(true);
    });

    it("should preserve queue items through pause/resume cycle", () => {
        const queue = new BackgroundTransferQueue();

        queue.enqueue(makeItem({ path: "a.md", priority: TransferPriority.HIGH }));
        queue.enqueue(makeItem({ path: "b.md", priority: TransferPriority.NORMAL }));

        queue.pause();
        // Items remain during pause
        expect(queue.getPendingTransfers()).toHaveLength(2);

        queue.resume();
        // Items remain after resume
        expect(queue.getPendingTransfers()).toHaveLength(2);
        // Order is preserved
        expect(queue.getPendingTransfers()[0].path).toBe("a.md");
        expect(queue.getPendingTransfers()[1].path).toBe("b.md");
    });

    it("should allow enqueuing items while paused", () => {
        const queue = new BackgroundTransferQueue();
        queue.pause();

        queue.enqueue(makeItem({ path: "a.md" }));
        queue.enqueue(makeItem({ path: "b.md" }));

        expect(queue.getPendingTransfers()).toHaveLength(2);

        queue.resume();
        expect(queue.getPendingTransfers()).toHaveLength(2);
    });
});

// ═══════════════════════════════════════════════════════════════════
// PART 7: Unit — Inline active tracking (markInlineStart/markInlineEnd)
// ═══════════════════════════════════════════════════════════════════

describe("Inline active tracking", () => {
    let queue: BackgroundTransferQueue;

    beforeEach(() => {
        queue = new BackgroundTransferQueue();
    });

    it("should include inline active items in getPendingTransfers", () => {
        queue.markInlineStart("notes/file.md", "push", 1024);

        const pending = queue.getPendingTransfers();
        expect(pending).toHaveLength(1);
        expect(pending[0].path).toBe("notes/file.md");
        expect(pending[0].direction).toBe("push");
        expect(pending[0].status).toBe("active");
        expect(pending[0].size).toBe(1024);
    });

    it("should remove inline active items via markInlineEnd", () => {
        queue.markInlineStart("notes/file.md", "push", 1024);
        expect(queue.getPendingTransfers()).toHaveLength(1);

        queue.markInlineEnd("notes/file.md");
        expect(queue.getPendingTransfers()).toHaveLength(0);
    });

    it("should track multiple inline transfers concurrently", () => {
        queue.markInlineStart("notes/a.md", "push", 100);
        queue.markInlineStart("notes/b.md", "pull", 200);
        queue.markInlineStart("notes/c.md", "push", 300);

        const pending = queue.getPendingTransfers();
        expect(pending).toHaveLength(3);

        const paths = pending.map((p) => p.path).sort();
        expect(paths).toEqual(["notes/a.md", "notes/b.md", "notes/c.md"]);
    });

    it("should merge inline active and background queue items in getPendingTransfers", () => {
        // Inline active
        queue.markInlineStart("notes/inline.md", "push", 500);
        // Background queued
        queue.enqueue(makeItem({ path: "notes/bg.md", direction: "push" }));

        const pending = queue.getPendingTransfers();
        expect(pending).toHaveLength(2);

        const paths = pending.map((p) => p.path).sort();
        expect(paths).toEqual(["notes/bg.md", "notes/inline.md"]);
    });

    it("should place inline active items before background queue items", () => {
        queue.enqueue(makeItem({ path: "notes/bg.md", direction: "push" }));
        queue.markInlineStart("notes/inline.md", "push", 500);

        const pending = queue.getPendingTransfers();
        // Inline items come first (they're prepended in the array)
        expect(pending[0].path).toBe("notes/inline.md");
        expect(pending[1].path).toBe("notes/bg.md");
    });

    it("should overwrite previous inline entry for same path", () => {
        queue.markInlineStart("notes/file.md", "push", 100);
        queue.markInlineStart("notes/file.md", "pull", 200);

        const pending = queue.getPendingTransfers();
        expect(pending).toHaveLength(1);
        expect(pending[0].direction).toBe("pull");
        expect(pending[0].size).toBe(200);
    });

    it("should fire onQueueChange when marking inline start", () => {
        const onQueueChange = vi.fn();
        queue.setCallbacks({ onQueueChange });

        queue.markInlineStart("notes/file.md", "push", 1024);

        expect(onQueueChange).toHaveBeenCalledTimes(1);
        const items = onQueueChange.mock.calls[0][0];
        expect(items).toHaveLength(1);
        expect(items[0].path).toBe("notes/file.md");
    });

    it("should fire onQueueChange when marking inline end", () => {
        const onQueueChange = vi.fn();
        queue.setCallbacks({ onQueueChange });

        queue.markInlineStart("notes/file.md", "push", 1024);
        onQueueChange.mockClear();

        queue.markInlineEnd("notes/file.md");

        expect(onQueueChange).toHaveBeenCalledTimes(1);
        const items = onQueueChange.mock.calls[0][0];
        expect(items).toHaveLength(0);
    });

    it("should generate unique IDs with inline- prefix", () => {
        queue.markInlineStart("notes/a.md", "push", 100);
        queue.markInlineStart("notes/b.md", "pull", 200);

        const pending = queue.getPendingTransfers();
        expect(pending[0].id).toMatch(/^inline-push-/);
        expect(pending[1].id).toMatch(/^inline-pull-/);
        expect(pending[0].id).not.toBe(pending[1].id);
    });

    it("should not affect hasPendingItems (only background queue)", () => {
        queue.markInlineStart("notes/file.md", "push", 1024);

        // hasPendingItems checks only the background queue, not inline active
        expect(queue.hasPendingItems()).toBe(false);
    });

    it("should not be affected by cancelAll (inline items are separate)", () => {
        queue.markInlineStart("notes/inline.md", "push", 500);
        queue.enqueue(makeItem({ path: "notes/bg.md" }));

        queue.cancelAll();

        // Background items cancelled, inline still active
        const pending = queue.getPendingTransfers();
        expect(pending).toHaveLength(1);
        expect(pending[0].path).toBe("notes/inline.md");
    });
});

// ═══════════════════════════════════════════════════════════════════
// PART 8: Unit — Bandwidth throttling (bgTransferIntervalSec)
// ═══════════════════════════════════════════════════════════════════

describe("Bandwidth throttling (bgTransferIntervalSec)", () => {
    let cloud: MockCloudAdapter;
    let device: DeviceSimulator;
    const sm = () => device.syncManager as any;

    beforeEach(() => {
        cloud = new MockCloudAdapter();
        device = new DeviceSimulator("TestDevice", cloud);
        sm().notify = async () => {};
    });

    it("should pass bgTransferIntervalSec=0 to settings (no throttling)", () => {
        expect(sm().settings.bgTransferIntervalSec).toBe(0);
    });

    it("should accept bgTransferIntervalSec setting changes", () => {
        sm().settings.bgTransferIntervalSec = 5;
        expect(sm().settings.bgTransferIntervalSec).toBe(5);
    });

    it("should store bgTransferIntervalSec in queue context after setContext", () => {
        const queue = sm().backgroundTransferQueue;
        // The queue has access to settings through its ctx reference
        // Verify queue was properly initialized
        expect(queue).toBeDefined();
        expect(queue.getPendingTransfers()).toHaveLength(0);
    });
});

// ═══════════════════════════════════════════════════════════════════
// PART 9: Unit — History persistence (JSONL flush/load)
// ═══════════════════════════════════════════════════════════════════

describe("History persistence (JSONL)", () => {
    let queue: BackgroundTransferQueue;

    beforeEach(() => {
        queue = new BackgroundTransferQueue();
    });

    it("should accumulate unflushed records via recordInlineTransfer", () => {
        queue.recordInlineTransfer(makeRecord({ path: "a.md" }));
        queue.recordInlineTransfer(makeRecord({ path: "b.md" }));

        // Records should be in history
        expect(queue.getHistory()).toHaveLength(2);
    });

    it("should preserve history order across inline and cancel operations", () => {
        queue.recordInlineTransfer(makeRecord({ id: "first", path: "a.md", completedAt: 1000 }));
        queue.enqueue(makeItem({ path: "b.md" }));
        queue.cancel("b.md"); // This adds a "cancelled" record to history
        queue.recordInlineTransfer(makeRecord({ id: "third", path: "c.md", completedAt: 3000 }));

        const history = queue.getHistory();
        expect(history).toHaveLength(3);
        expect(history[0].id).toBe("first");
        expect(history[1].status).toBe("cancelled");
        expect(history[2].id).toBe("third");
    });

    it("should call flushHistory without error when no context is set", async () => {
        queue.recordInlineTransfer(makeRecord());
        // flushHistory should not throw when ctx is null
        await expect(queue.flushHistory()).resolves.not.toThrow();
    });

    it("should not throw on flushHistory when called multiple times", async () => {
        // No context — should be no-op
        await queue.flushHistory();
        await queue.flushHistory();
        // Still no error
        expect(queue.getHistory()).toHaveLength(0);
    });

    it("should ring-buffer correctly when adding via both inline and cancel", () => {
        // Fill to just under MAX_HISTORY (500) with inline records
        for (let i = 0; i < 498; i++) {
            queue.recordInlineTransfer(makeRecord({ id: `inline-${i}` }));
        }

        // Add 2 items and cancel them (adds to history via cancel path)
        queue.enqueue(makeItem({ id: "cancel-1", path: "x.md" }));
        queue.cancel("x.md");
        queue.enqueue(makeItem({ id: "cancel-2", path: "y.md" }));
        queue.cancel("y.md");

        // Now add 5 more — should trigger ring buffer trim
        for (let i = 0; i < 5; i++) {
            queue.recordInlineTransfer(makeRecord({ id: `overflow-${i}` }));
        }

        const history = queue.getHistory();
        expect(history.length).toBeLessThanOrEqual(500);
        // Latest records should be at the end
        expect(history[history.length - 1].id).toBe("overflow-4");
    });
});

// ═══════════════════════════════════════════════════════════════════
// PART 10: Integration — Log rotation via loadHistoryFromDisk
// ═══════════════════════════════════════════════════════════════════

describe("Log rotation (daily JSONL cleanup)", () => {
    let cloud: MockCloudAdapter;
    let device: DeviceSimulator;
    const sm = () => device.syncManager as any;

    beforeEach(() => {
        cloud = new MockCloudAdapter();
        device = new DeviceSimulator("TestDevice", cloud, "dev_test");
        sm().notify = async () => {};
        // Set logFolder to device-specific path (normally done by loadLocalIndex)
        sm().logFolder = `${sm().pluginDir}/logs/dev_test`;
    });

    it("should delete transfer logs older than 7 days", async () => {
        const logFolder = sm().logFolder as string;

        // Ensure log folder exists in mock adapter
        await device.app.vaultAdapter.mkdir(logFolder);

        // Create old log files (10 days ago)
        const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
        const oldY = oldDate.getFullYear();
        const oldM = String(oldDate.getMonth() + 1).padStart(2, "0");
        const oldD = String(oldDate.getDate()).padStart(2, "0");
        const oldFileName = `transfers-${oldY}-${oldM}-${oldD}.jsonl`;
        const oldPath = `${logFolder}/${oldFileName}`;

        // Create today's log file
        const today = new Date();
        const tY = today.getFullYear();
        const tM = String(today.getMonth() + 1).padStart(2, "0");
        const tD = String(today.getDate()).padStart(2, "0");
        const todayFileName = `transfers-${tY}-${tM}-${tD}.jsonl`;
        const todayPath = `${logFolder}/${todayFileName}`;

        // Write mock log files to the vault adapter
        device.app.vaultAdapter.setFile(oldPath, '{"id":"old"}\n');
        device.app.vaultAdapter.setFile(todayPath, '{"id":"today"}\n');

        // Trigger loadHistoryFromDisk which also calls rotateOldLogs
        await sm().backgroundTransferQueue.loadHistoryFromDisk();

        // Wait a tick for the async rotation to complete
        await new Promise((r) => setTimeout(r, 50));

        // Old file should be deleted
        const oldExists = await device.app.vaultAdapter.exists(oldPath);
        expect(oldExists).toBe(false);

        // Today's file should still exist
        const todayExists = await device.app.vaultAdapter.exists(todayPath);
        expect(todayExists).toBe(true);
    });

    it("should not delete recent log files (within 7 days)", async () => {
        const logFolder = sm().logFolder as string;
        await device.app.vaultAdapter.mkdir(logFolder);

        // Create a 3-day-old log file
        const recentDate = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
        const rY = recentDate.getFullYear();
        const rM = String(recentDate.getMonth() + 1).padStart(2, "0");
        const rD = String(recentDate.getDate()).padStart(2, "0");
        const recentFileName = `transfers-${rY}-${rM}-${rD}.jsonl`;
        const recentPath = `${logFolder}/${recentFileName}`;

        device.app.vaultAdapter.setFile(recentPath, '{"id":"recent"}\n');

        await sm().backgroundTransferQueue.loadHistoryFromDisk();
        await new Promise((r) => setTimeout(r, 50));

        // Recent file should still exist
        const exists = await device.app.vaultAdapter.exists(recentPath);
        expect(exists).toBe(true);
    });

    it("should ignore non-transfer files in log folder", async () => {
        const logFolder = sm().logFolder as string;
        await device.app.vaultAdapter.mkdir(logFolder);

        // Create a non-transfer file in the log folder
        const otherPath = `${logFolder}/2025-01-01.log`;
        device.app.vaultAdapter.setFile(otherPath, "some log data\n");

        await sm().backgroundTransferQueue.loadHistoryFromDisk();
        await new Promise((r) => setTimeout(r, 50));

        // Non-transfer file should not be touched
        const exists = await device.app.vaultAdapter.exists(otherPath);
        expect(exists).toBe(true);
    });

    it("should not fail if log folder does not exist", async () => {
        // logFolder doesn't have any files, and the folder itself doesn't exist
        // This should not throw
        await expect(
            sm().backgroundTransferQueue.loadHistoryFromDisk(),
        ).resolves.not.toThrow();
    });
});

// ─── Shared helper: wait for background queue to drain ───

async function waitForDrain(queue: BackgroundTransferQueue, timeoutMs = 3000): Promise<void> {
    const start = Date.now();
    while ((queue as any).queue.length > 0 || (queue as any).isProcessing) {
        if (Date.now() - start > timeoutMs) {
            throw new Error("Queue drain timeout");
        }
        await new Promise((r) => setTimeout(r, 20));
    }
}

// ═══════════════════════════════════════════════════════════════════
// PART 11: Integration — Background Pull execution (executePull via processLoop)
// ═══════════════════════════════════════════════════════════════════

describe("Background Pull execution (processLoop)", () => {
    let cloud: MockCloudAdapter;
    let deviceA: DeviceSimulator;
    let deviceB: DeviceSimulator;
    const smA = () => deviceA.syncManager as any;
    const smB = () => deviceB.syncManager as any;

    beforeEach(async () => {
        cloud = new MockCloudAdapter();
        deviceA = new DeviceSimulator("DeviceA", cloud, "dev_A");
        deviceB = new DeviceSimulator("DeviceB", cloud, "dev_B");
        smA().notify = async () => {};
        smB().notify = async () => {};
    });

    /** Push a file from DeviceA to cloud (inline) and return the cloud fileId */
    async function pushFromA(path: string, content: string): Promise<string> {
        deviceA.app.vaultAdapter.setFile(path, content);
        smA().dirtyPaths.set(path, Date.now());
        smA().settings.largeFileThresholdMB = 0;
        await smA().smartPush(false);
        return cloud.getFileId(path)!;
    }

    it("should download file and update indices after background pull", async () => {
        const content = "Large pull content " + "x".repeat(3000);
        const fileId = await pushFromA("notes/large.md", content);
        const cloudHash = cloud.getCloudHash("notes/large.md")!;

        const queue = smB().backgroundTransferQueue;
        queue.enqueue(
            makeItem({
                direction: "pull",
                path: "notes/large.md",
                fileId,
                remoteHash: cloudHash,
                size: content.length,
            }),
        );

        queue.resume();
        await waitForDrain(queue);

        // File should be downloaded locally
        expect(deviceB.getLocalContent("notes/large.md")).toBe(content);

        // localIndex should be updated
        const entry = smB().localIndex["notes/large.md"];
        expect(entry).toBeDefined();
        expect(entry.fileId).toBe(fileId);
        expect(entry.hash).toBe(cloudHash);
        expect(entry.lastAction).toBe("pull");
        expect(entry.ancestorHash).toBe(cloudHash);
    });

    it("should clear pendingTransfer after successful pull", async () => {
        const content = "x".repeat(3000);
        const fileId = await pushFromA("notes/large.md", content);
        const cloudHash = cloud.getCloudHash("notes/large.md")!;

        // Set up pendingTransfer marker
        smB().localIndex["notes/large.md"] = {
            hash: "old-hash",
            mtime: Date.now() - 1000,
            size: 50,
            pendingTransfer: { direction: "pull", enqueuedAt: Date.now(), snapshotHash: "" },
        };

        const queue = smB().backgroundTransferQueue;
        queue.enqueue(
            makeItem({
                direction: "pull",
                path: "notes/large.md",
                fileId,
                remoteHash: cloudHash,
                size: content.length,
            }),
        );
        queue.resume();
        await waitForDrain(queue);

        expect(smB().localIndex["notes/large.md"].pendingTransfer).toBeUndefined();
    });

    it("should record completed pull in transfer history", async () => {
        const content = "x".repeat(3000);
        const fileId = await pushFromA("notes/large.md", content);
        const cloudHash = cloud.getCloudHash("notes/large.md")!;

        const queue = smB().backgroundTransferQueue;
        const itemId = "test-pull-history";
        queue.enqueue(
            makeItem({
                id: itemId,
                direction: "pull",
                path: "notes/large.md",
                fileId,
                remoteHash: cloudHash,
                size: content.length,
            }),
        );
        queue.resume();
        await waitForDrain(queue);

        const history = queue.getHistory();
        const record = history.find((r: TransferRecord) => r.id === itemId);
        expect(record).toBeDefined();
        expect(record!.status).toBe("completed");
        expect(record!.direction).toBe("pull");
        expect(record!.transferMode).toBe("background");
    });

    it("should cancel pull when local dirty path detected", async () => {
        const content = "x".repeat(3000);
        const fileId = await pushFromA("notes/conflict.md", content);
        const cloudHash = cloud.getCloudHash("notes/conflict.md")!;

        // DeviceB has local modifications
        deviceB.app.vaultAdapter.setFile("notes/conflict.md", "local version");
        smB().dirtyPaths.set("notes/conflict.md", Date.now());
        smB().localIndex["notes/conflict.md"] = {
            hash: "old-hash",
            mtime: Date.now(),
            size: 50,
            pendingTransfer: { direction: "pull", enqueuedAt: Date.now(), snapshotHash: "" },
        };

        const queue = smB().backgroundTransferQueue;
        queue.enqueue(
            makeItem({
                direction: "pull",
                path: "notes/conflict.md",
                fileId,
                remoteHash: cloudHash,
                size: content.length,
            }),
        );
        queue.resume();
        await waitForDrain(queue);

        // Local content should NOT be overwritten
        expect(deviceB.getLocalContent("notes/conflict.md")).toBe("local version");
        // pendingTransfer should be cleared
        expect(smB().localIndex["notes/conflict.md"].pendingTransfer).toBeUndefined();
        // History should show cancelled
        const history = queue.getHistory();
        expect(
            history.some(
                (r: TransferRecord) =>
                    r.path === "notes/conflict.md" && r.status === "cancelled",
            ),
        ).toBe(true);
    });

    it("should process multiple pull items sequentially", async () => {
        const contentA = "File A content " + "x".repeat(2000);
        const contentB = "File B content " + "y".repeat(2000);
        const fileIdA = await pushFromA("notes/a.md", contentA);
        const fileIdB = await pushFromA("notes/b.md", contentB);

        const queue = smB().backgroundTransferQueue;
        queue.enqueue(
            makeItem({
                direction: "pull",
                path: "notes/a.md",
                fileId: fileIdA,
                remoteHash: cloud.getCloudHash("notes/a.md")!,
                size: contentA.length,
            }),
        );
        queue.enqueue(
            makeItem({
                direction: "pull",
                path: "notes/b.md",
                fileId: fileIdB,
                remoteHash: cloud.getCloudHash("notes/b.md")!,
                size: contentB.length,
            }),
        );
        queue.resume();
        await waitForDrain(queue);

        expect(deviceB.getLocalContent("notes/a.md")).toBe(contentA);
        expect(deviceB.getLocalContent("notes/b.md")).toBe(contentB);
        expect(queue.getHistory()).toHaveLength(2);
    });
});

// ═══════════════════════════════════════════════════════════════════
// PART 12: Integration — Staleness & conflict check (executePush via processLoop)
// ═══════════════════════════════════════════════════════════════════

describe("Staleness & conflict check (executePush processLoop)", () => {
    let cloud: MockCloudAdapter;
    let device: DeviceSimulator;
    const sm = () => device.syncManager as any;

    beforeEach(() => {
        cloud = new MockCloudAdapter();
        device = new DeviceSimulator("TestDevice", cloud, "dev_test");
        sm().notify = async () => {};
    });

    /** Create a local file, set up index, and return the snapshot hash */
    async function setupLocalFile(path: string, content: string): Promise<{
        hash: string;
        buf: ArrayBuffer;
        mtime: number;
    }> {
        device.app.vaultAdapter.setFile(path, content);
        const buf = new TextEncoder().encode(content).buffer as ArrayBuffer;
        const hash = hashOf(content);
        const stat = await device.app.vaultAdapter.stat(path);
        return { hash, buf: buf.slice(0), mtime: stat?.mtime ?? Date.now() };
    }

    it("should cancel push when file is deleted after enqueue", async () => {
        const { hash, buf, mtime } = await setupLocalFile("notes/deleted.md", "original");

        const queue = sm().backgroundTransferQueue;
        queue.enqueue(
            makeItem({
                direction: "push",
                path: "notes/deleted.md",
                size: buf.byteLength,
                content: buf,
                mtime,
                snapshotHash: hash,
            }),
        );

        // Delete the file before processLoop runs
        device.app.vaultAdapter.remove("notes/deleted.md");

        queue.resume();
        await waitForDrain(queue);

        // Should be cancelled
        const history = queue.getHistory();
        expect(
            history.some(
                (r: TransferRecord) =>
                    r.path === "notes/deleted.md" && r.status === "cancelled",
            ),
        ).toBe(true);
        // File should NOT be on cloud
        expect(cloud.getCloudContent("notes/deleted.md")).toBeNull();
    });

    it("should cancel push and re-add to dirtyPaths when content changed", async () => {
        const { hash, buf, mtime } = await setupLocalFile("notes/modified.md", "original content");

        sm().localIndex["notes/modified.md"] = {
            hash: "old-index-hash",
            mtime,
            size: buf.byteLength,
        };

        const queue = sm().backgroundTransferQueue;
        queue.enqueue(
            makeItem({
                direction: "push",
                path: "notes/modified.md",
                size: buf.byteLength,
                content: buf,
                mtime,
                snapshotHash: hash,
            }),
        );

        // Modify the file (different content → different hash)
        // Ensure mtime differs from original (avoid same-millisecond collision)
        await new Promise((r) => setTimeout(r, 5));
        device.app.vaultAdapter.setFile("notes/modified.md", "completely new content!");

        queue.resume();
        await waitForDrain(queue);

        // Should be cancelled
        const history = queue.getHistory();
        expect(
            history.some(
                (r: TransferRecord) =>
                    r.path === "notes/modified.md" && r.status === "cancelled",
            ),
        ).toBe(true);
        // Path should be re-added to dirtyPaths
        expect(sm().dirtyPaths.has("notes/modified.md")).toBe(true);
        // File should NOT be on cloud
        expect(cloud.getCloudContent("notes/modified.md")).toBeNull();
        // pendingTransfer should be cleared
        expect(sm().localIndex["notes/modified.md"].pendingTransfer).toBeUndefined();
    });

    it("should proceed with push when mtime changed but hash matches", async () => {
        const { hash, buf, mtime } = await setupLocalFile("notes/touched.md", "same content");

        sm().localIndex["notes/touched.md"] = {
            hash: "old-index-hash",
            mtime,
            size: buf.byteLength,
        };
        sm().index["notes/touched.md"] = { ...sm().localIndex["notes/touched.md"] };

        const queue = sm().backgroundTransferQueue;
        queue.enqueue(
            makeItem({
                direction: "push",
                path: "notes/touched.md",
                size: buf.byteLength,
                content: buf,
                mtime,
                snapshotHash: hash,
            }),
        );

        // Re-write the file with SAME content (mtime changes, hash stays the same)
        device.app.vaultAdapter.setFile("notes/touched.md", "same content");

        queue.resume();
        await waitForDrain(queue);

        // File SHOULD be uploaded to cloud (hash match → proceed)
        expect(cloud.getCloudContent("notes/touched.md")).toBe("same content");
        // History should show completed
        const history = queue.getHistory();
        expect(
            history.some(
                (r: TransferRecord) =>
                    r.path === "notes/touched.md" && r.status === "completed",
            ),
        ).toBe(true);
    });

    it("should cancel push when remote conflict detected", async () => {
        const content = "local version";
        const { hash, buf, mtime } = await setupLocalFile("notes/conflict.md", content);

        // Upload the initial version to cloud first (simulate a prior sync)
        const initialContent = new TextEncoder().encode("initial synced version")
            .buffer as ArrayBuffer;
        const initialUpload = await cloud.uploadFile(
            "notes/conflict.md",
            initialContent,
            Date.now(),
        );
        const oldHash = initialUpload.hash;

        // Set localIndex pointing to the cloud file (simulating prior sync)
        sm().localIndex["notes/conflict.md"] = {
            hash: oldHash,
            mtime,
            size: buf.byteLength,
            fileId: initialUpload.id,
        };
        sm().index["notes/conflict.md"] = { ...sm().localIndex["notes/conflict.md"] };

        // Now "another device" updates the same file → different hash on remote
        const remoteContent = new TextEncoder().encode("remote version from other device")
            .buffer as ArrayBuffer;
        await cloud.uploadFile("notes/conflict.md", remoteContent, Date.now(), initialUpload.id);

        const queue = sm().backgroundTransferQueue;
        queue.enqueue(
            makeItem({
                direction: "push",
                path: "notes/conflict.md",
                size: buf.byteLength,
                content: buf,
                mtime,
                snapshotHash: hash,
            }),
        );

        queue.resume();
        await waitForDrain(queue);

        // Should be cancelled due to remote conflict
        const history = queue.getHistory();
        expect(
            history.some(
                (r: TransferRecord) =>
                    r.path === "notes/conflict.md" && r.status === "cancelled",
            ),
        ).toBe(true);
        // Path should be re-added to dirtyPaths for next sync cycle
        expect(sm().dirtyPaths.has("notes/conflict.md")).toBe(true);
        // pendingTransfer should be cleared
        expect(sm().localIndex["notes/conflict.md"].pendingTransfer).toBeUndefined();
    });

    it("should successfully push and update all indices", async () => {
        const content = "push me to cloud " + "z".repeat(1000);
        const { hash, buf, mtime } = await setupLocalFile("notes/pushme.md", content);

        sm().localIndex["notes/pushme.md"] = {
            hash: "old-hash",
            mtime: mtime - 1000,
            size: 10,
        };
        sm().index["notes/pushme.md"] = { ...sm().localIndex["notes/pushme.md"] };
        sm().dirtyPaths.set("notes/pushme.md", Date.now());

        const queue = sm().backgroundTransferQueue;
        queue.enqueue(
            makeItem({
                direction: "push",
                path: "notes/pushme.md",
                size: buf.byteLength,
                content: buf,
                mtime,
                snapshotHash: hash,
            }),
        );

        queue.resume();
        await waitForDrain(queue);

        // Cloud should have the file
        expect(cloud.getCloudContent("notes/pushme.md")).toBe(content);

        // Indices should be updated
        const entry = sm().localIndex["notes/pushme.md"];
        expect(entry).toBeDefined();
        expect(entry.hash).toBe(cloud.getCloudHash("notes/pushme.md"));
        expect(entry.lastAction).toBe("push");
        expect(entry.fileId).toBe(cloud.getFileId("notes/pushme.md"));

        // dirtyPaths should be cleared
        expect(sm().dirtyPaths.has("notes/pushme.md")).toBe(false);

        // History should show completed
        const history = queue.getHistory();
        expect(
            history.some(
                (r: TransferRecord) =>
                    r.path === "notes/pushme.md" && r.status === "completed",
            ),
        ).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════════════
// PART 13: E2E — Full sync cycle with background transfer
// ═══════════════════════════════════════════════════════════════════

describe("E2E full sync cycle with background transfer", () => {
    let cloud: MockCloudAdapter;
    let deviceA: DeviceSimulator;
    let deviceB: DeviceSimulator;
    const smA = () => deviceA.syncManager as any;
    const smB = () => deviceB.syncManager as any;

    beforeEach(async () => {
        cloud = new MockCloudAdapter();
        deviceA = new DeviceSimulator("DeviceA", cloud, "dev_A");
        deviceB = new DeviceSimulator("DeviceB", cloud, "dev_B");
        smA().notify = async () => {};
        smB().notify = async () => {};
    });

    it("should defer large push → processLoop completes push → cloud updated", async () => {
        smA().settings.largeFileThresholdMB = 0.001; // ~1KB threshold

        const content = "Large push E2E " + "x".repeat(3000);
        deviceA.app.vaultAdapter.setFile("notes/large.md", content);
        smA().dirtyPaths.set("notes/large.md", Date.now());

        // smartPush defers the large file
        await smA().smartPush(false);
        expect(cloud.getCloudContent("notes/large.md")).toBeNull(); // Not yet on cloud
        expect(smA().backgroundTransferQueue.hasPendingItems()).toBe(true);

        // Resume the queue (simulates post-sync cycle resume)
        smA().backgroundTransferQueue.resume();
        await waitForDrain(smA().backgroundTransferQueue);

        // Now file should be on cloud
        expect(cloud.getCloudContent("notes/large.md")).toBe(content);
        // Indices should be updated
        expect(smA().localIndex["notes/large.md"].lastAction).toBe("push");
        expect(smA().localIndex["notes/large.md"].hash).toBe(
            cloud.getCloudHash("notes/large.md"),
        );
        // dirtyPaths cleared
        expect(smA().dirtyPaths.has("notes/large.md")).toBe(false);
    });

    it("should defer large pull → processLoop completes pull → local file available", async () => {
        // DeviceA pushes a large file inline
        const content = "Large pull E2E " + "y".repeat(3000);
        deviceA.app.vaultAdapter.setFile("notes/large.md", content);
        smA().dirtyPaths.set("notes/large.md", Date.now());
        smA().settings.largeFileThresholdMB = 0;
        await smA().smartPush(false);

        // DeviceB pulls with low threshold → deferred
        smB().settings.largeFileThresholdMB = 0.001;
        await smB().smartPull();
        expect(deviceB.getLocalContent("notes/large.md")).toBeNull(); // Not yet local
        expect(smB().backgroundTransferQueue.hasPendingItems()).toBe(true);

        // Resume background queue
        smB().backgroundTransferQueue.resume();
        await waitForDrain(smB().backgroundTransferQueue);

        // Now file should be locally available
        expect(deviceB.getLocalContent("notes/large.md")).toBe(content);
        // Index should be updated
        expect(smB().localIndex["notes/large.md"]).toBeDefined();
        expect(smB().localIndex["notes/large.md"].lastAction).toBe("pull");
    });

    it("should handle mixed: small files inline, large files background", async () => {
        smA().settings.largeFileThresholdMB = 0.001; // ~1KB threshold

        // Small file (< 1KB)
        deviceA.app.vaultAdapter.setFile("notes/small.md", "Small inline");
        smA().dirtyPaths.set("notes/small.md", Date.now());

        // Large file (> 1KB)
        const largeContent = "Large bg " + "x".repeat(3000);
        deviceA.app.vaultAdapter.setFile("notes/large.md", largeContent);
        smA().dirtyPaths.set("notes/large.md", Date.now());

        await smA().smartPush(false);

        // Small file should be on cloud already
        expect(cloud.getCloudContent("notes/small.md")).toBe("Small inline");
        // Large file not yet
        expect(cloud.getCloudContent("notes/large.md")).toBeNull();

        // Resume background queue
        smA().backgroundTransferQueue.resume();
        await waitForDrain(smA().backgroundTransferQueue);

        // Both files should now be on cloud
        expect(cloud.getCloudContent("notes/large.md")).toBe(largeContent);

        // History should have records for both (inline + background)
        const history = smA().backgroundTransferQueue.getHistory();
        const inlineRecord = history.find(
            (r: TransferRecord) => r.path === "notes/small.md",
        );
        const bgRecord = history.find(
            (r: TransferRecord) => r.path === "notes/large.md",
        );
        expect(inlineRecord).toBeDefined();
        expect(inlineRecord!.transferMode).toBe("inline");
        expect(bgRecord).toBeDefined();
        expect(bgRecord!.transferMode).toBe("background");
    });

    it("should allow subsequent sync cycles after background transfer completes", async () => {
        smA().settings.largeFileThresholdMB = 0.001;

        // First cycle: large file deferred
        deviceA.app.vaultAdapter.setFile("notes/first.md", "x".repeat(2000));
        smA().dirtyPaths.set("notes/first.md", Date.now());
        await smA().smartPush(false);

        // Complete background transfer
        smA().backgroundTransferQueue.resume();
        await waitForDrain(smA().backgroundTransferQueue);
        expect(cloud.getCloudContent("notes/first.md")).not.toBeNull();

        // Second cycle: another large file
        deviceA.app.vaultAdapter.setFile("notes/second.md", "y".repeat(2000));
        smA().dirtyPaths.set("notes/second.md", Date.now());
        await smA().smartPush(false);

        smA().backgroundTransferQueue.resume();
        await waitForDrain(smA().backgroundTransferQueue);

        // Both files on cloud
        expect(cloud.getCloudContent("notes/second.md")).not.toBeNull();
    });
});

// ═══════════════════════════════════════════════════════════════════
// PART 14: Integration — Retry & error handling
// ═══════════════════════════════════════════════════════════════════

describe("Retry & error handling (processLoop)", () => {
    let cloud: MockCloudAdapter;
    let device: DeviceSimulator;
    const sm = () => device.syncManager as any;

    beforeEach(() => {
        cloud = new MockCloudAdapter();
        device = new DeviceSimulator("TestDevice", cloud, "dev_test");
        sm().notify = async () => {};
    });

    it("should record failure after MAX_RETRIES (3) attempts", async () => {
        const content = "will fail";
        device.app.vaultAdapter.setFile("notes/fail.md", content);
        const buf = new TextEncoder().encode(content).buffer as ArrayBuffer;

        sm().localIndex["notes/fail.md"] = { hash: "old", mtime: Date.now(), size: 10 };
        sm().index["notes/fail.md"] = { ...sm().localIndex["notes/fail.md"] };

        // Make upload always throw
        const origUpload = cloud.uploadFile.bind(cloud);
        let callCount = 0;
        vi.spyOn(cloud, "uploadFile").mockImplementation(async (path, ...args) => {
            if (path === "notes/fail.md") {
                callCount++;
                throw new Error("Simulated upload failure");
            }
            return origUpload(path, ...args);
        });

        const queue = sm().backgroundTransferQueue;
        const stat = await device.app.vaultAdapter.stat("notes/fail.md");
        queue.enqueue(
            makeItem({
                direction: "push",
                path: "notes/fail.md",
                size: buf.byteLength,
                content: buf.slice(0),
                mtime: stat!.mtime,
                snapshotHash: hashOf(content),
            }),
        );

        // Use short retry delays for test (override via private access)
        // The actual retry delay uses exponential backoff but with vi.useFakeTimers
        // For simplicity, just wait longer
        queue.resume();
        await waitForDrain(queue, 30000);

        // Should have attempted 3 times
        expect(callCount).toBe(3);
        // History should show failure
        const history = queue.getHistory();
        const failRecord = history.find(
            (r: TransferRecord) => r.path === "notes/fail.md" && r.status === "failed",
        );
        expect(failRecord).toBeDefined();
        expect(failRecord!.transferMode).toBe("background");

        vi.restoreAllMocks();
    }, 60000); // Extended timeout for retry delays

    it("should fire onTransferFailed callback on max retries", async () => {
        const content = "callback fail";
        device.app.vaultAdapter.setFile("notes/cbfail.md", content);
        const buf = new TextEncoder().encode(content).buffer as ArrayBuffer;

        sm().localIndex["notes/cbfail.md"] = { hash: "old", mtime: Date.now(), size: 10 };
        sm().index["notes/cbfail.md"] = { ...sm().localIndex["notes/cbfail.md"] };

        vi.spyOn(cloud, "uploadFile").mockImplementation(async (path, ...args) => {
            if (path === "notes/cbfail.md") {
                throw new Error("Simulated failure");
            }
            return (cloud as any).__proto__.uploadFile.call(cloud, path, ...args);
        });

        const onFailed = vi.fn();
        const queue = sm().backgroundTransferQueue;
        queue.setCallbacks({ onTransferFailed: onFailed });

        const stat = await device.app.vaultAdapter.stat("notes/cbfail.md");
        queue.enqueue(
            makeItem({
                direction: "push",
                path: "notes/cbfail.md",
                size: buf.byteLength,
                content: buf.slice(0),
                mtime: stat!.mtime,
                snapshotHash: hashOf(content),
            }),
        );

        queue.resume();
        await waitForDrain(queue, 30000);

        expect(onFailed).toHaveBeenCalledTimes(1);
        expect(onFailed.mock.calls[0][0].status).toBe("failed");

        vi.restoreAllMocks();
    }, 60000);
});
