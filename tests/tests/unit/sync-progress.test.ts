/**
 * @file SyncProgressTracker: counts, phases, throughput, ETA and emit throttling.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SyncProgressTracker } from "../../../src/sync-manager/sync-progress";

describe("SyncProgressTracker", () => {
    let now = 0;
    let tracker: SyncProgressTracker;

    beforeEach(() => {
        vi.useFakeTimers();
        now = 1_000_000;
        tracker = new SyncProgressTracker(() => now);
    });
    afterEach(() => {
        tracker.dispose();
        vi.useRealTimers();
    });

    it("is idle with no result before the first cycle", () => {
        const s = tracker.snapshot();
        expect(s.active).toBe(false);
        expect(s.phase).toBe("idle");
        expect(s.fraction).toBeNull();
        expect(s.last).toBeNull();
    });

    it("counts planned and finished files per direction", () => {
        tracker.begin("manual-sync");
        tracker.plan("pull", [
            { path: "a.md", size: 100 },
            { path: "b.md", size: 300 },
        ]);
        tracker.plan("pull", [{ path: "a.md", size: 100 }]); // planned twice: counted once
        tracker.plan("push", [{ path: "c.md" }]);
        let s = tracker.snapshot();
        expect(s.pull).toEqual({ total: 2, done: 0, bytesTotal: 400, bytesDone: 0 });
        expect(s.push.total).toBe(1);
        expect(s.phase).toBe("pushing");

        tracker.fileStarted("pull", "b.md", 300);
        expect(tracker.snapshot().current).toEqual([{ path: "b.md", direction: "pull", size: 300 }]);
        tracker.fileFinished("pull", "b.md");
        tracker.fileFinished("pull", "b.md"); // a second finish is ignored
        s = tracker.snapshot();
        expect(s.pull.done).toBe(1);
        expect(s.pull.bytesDone).toBe(300);
        expect(s.current).toEqual([]);
        // files 1/3, bytes 300/400 -> (0.333 + 0.75) / 2
        expect(s.fraction).toBeCloseTo((1 / 3 + 0.75) / 2, 5);
    });

    it("counts an unplanned transfer when it starts", () => {
        tracker.begin("manual-sync");
        tracker.fileStarted("pull", "x.md", 50);
        expect(tracker.snapshot().pull.total).toBe(1);
        tracker.fileFinished("pull", "x.md");
        expect(tracker.snapshot().pull.done).toBe(1);
    });

    it("phases only move forward", () => {
        tracker.begin("manual-sync");
        tracker.setPhase("pushing");
        tracker.setPhase("pulling");
        expect(tracker.snapshot().phase).toBe("pushing");
    });

    it("the work after the uploads is a step of its own, kept by a late transfer", () => {
        tracker.begin("manual-sync");
        tracker.plan("push", [{ path: "a.md", size: 10 }]);
        tracker.fileFinished("push", "a.md");
        tracker.setPhase("finishing");
        // The confirmation pull after an upload does not move the display back.
        tracker.fileStarted("pull", "a.md", 10);
        expect(tracker.snapshot().phase).toBe("finishing");
        tracker.finish("ok");
        expect(tracker.snapshot().phase).toBe("idle");
    });

    it("ignores a second begin while a smart sync runs, but takes over from a full scan", () => {
        tracker.begin("manual-sync");
        tracker.plan("push", [{ path: "a.md" }]);
        tracker.begin("timer-sync");
        expect(tracker.snapshot().trigger).toBe("manual-sync");
        expect(tracker.snapshot().push.total).toBe(1);
        tracker.finish("ok");

        tracker.begin("full-scan", "scanning");
        tracker.scanProgress(10, 40);
        expect(tracker.snapshot().fraction).toBe(0.25);
        tracker.begin("manual-sync");
        const s = tracker.snapshot();
        expect(s.trigger).toBe("manual-sync");
        expect(s.scan).toEqual({ done: 0, total: 0 });
        expect(s.phase).toBe("checking");
    });

    it("records the result of a finished cycle", () => {
        tracker.begin("manual-sync");
        tracker.plan("push", [{ path: "a.md" }, { path: "b.md" }]);
        tracker.fileFinished("push", "a.md");
        tracker.noteConflict();
        now += 4200;
        tracker.finish("error", "boom");
        const s = tracker.snapshot();
        expect(s.active).toBe(false);
        expect(s.phase).toBe("idle");
        expect(s.fraction).toBe(0.5); // a failed cycle shows how far it got
        expect(s.last).toMatchObject({
            outcome: "error",
            durationMs: 4200,
            pushed: 1,
            pulled: 0,
            conflicts: 1,
            message: "boom",
        });
        expect(s.etaSec).toBeNull();
        expect(s.bytesPerSec).toBeNull();
    });

    it("a successful cycle shows as complete", () => {
        tracker.begin("manual-sync");
        tracker.plan("pull", [{ path: "a" }, { path: "b" }]);
        tracker.fileFinished("pull", "a");
        tracker.finish("ok");
        expect(tracker.snapshot().fraction).toBe(1);
    });

    it("estimates time left from throughput once the cycle has run a while", () => {
        tracker.begin("manual-sync");
        tracker.plan("pull", [
            { path: "a", size: 1000 },
            { path: "b", size: 1000 },
            { path: "c", size: 2000 },
        ]);
        now += 1000;
        expect(tracker.snapshot().etaSec).toBeNull(); // too early
        now += 1000;
        tracker.fileFinished("pull", "a");
        now += 2000;
        tracker.fileFinished("pull", "b");
        const s = tracker.snapshot();
        // 2000 bytes in 4 s -> 500 B/s; 2000 bytes left -> 4 s
        expect(s.bytesPerSec).toBe(500);
        expect(s.etaSec).toBe(4);
    });

    it("falls back to files per second when sizes are unknown", () => {
        tracker.begin("manual-sync");
        tracker.plan("push", [{ path: "a" }, { path: "b" }, { path: "c" }, { path: "d" }]);
        now += 4000;
        tracker.fileFinished("push", "a");
        tracker.fileFinished("push", "b");
        // 2 files in 4 s -> 2 s per file, 2 left -> 4 s
        expect(tracker.snapshot().etaSec).toBe(4);
    });

    it("coalesces listener updates, but sends begin and finish at once", () => {
        const seen: string[] = [];
        tracker.subscribe((s) => seen.push(`${s.phase}:${s.pull.done}`));
        expect(seen).toEqual(["idle:0"]);
        tracker.begin("manual-sync");
        expect(seen).toEqual(["idle:0", "checking:0"]);
        tracker.plan("pull", [{ path: "a" }, { path: "b" }]);
        tracker.fileFinished("pull", "a");
        tracker.fileFinished("pull", "b");
        expect(seen.length).toBe(2);
        vi.advanceTimersByTime(250);
        expect(seen).toEqual(["idle:0", "checking:0", "pulling:2"]);
        tracker.finish("ok");
        expect(seen[seen.length - 1]).toBe("idle:2");
    });

    it("a broken listener does not stop the others", () => {
        const good = vi.fn();
        tracker.subscribe(() => {
            throw new Error("view broke");
        });
        tracker.subscribe(good);
        good.mockClear();
        tracker.begin("manual-sync");
        expect(good).toHaveBeenCalledTimes(1);
    });
});
