/**
 * @file Transfer status screen: history grouping (day / batch).
 */
import { describe, it, expect } from "vitest";
import {
    BATCH_GAP_MS,
    groupHistory,
} from "../../../src/ui/transfer-history-groups";
import type { TransferRecord } from "../../../src/sync-manager/transfer-types";

const NOW = new Date(2026, 10, 20, 12, 0, 0).getTime();
const MIN = 60_000;

let seq = 0;
function rec(minutesAgo: number, over: Partial<TransferRecord> = {}): TransferRecord {
    const t = NOW - minutesAgo * MIN;
    return {
        id: `r${seq++}`,
        direction: "pull",
        path: "a.md",
        size: 100,
        status: "completed",
        startedAt: t - 500,
        completedAt: t,
        transferMode: "inline",
        ...over,
    };
}

describe("groupHistory", () => {
    it("groups by day (today / yesterday / older) and newest first", () => {
        const records = [rec(60 * 24 * 3), rec(1.5), rec(60 * 13), rec(1)];
        const days = groupHistory(records, "all", NOW);
        expect(days.map((d) => d.kind)).toEqual(["today", "yesterday", "date"]);
        const firstBatch = days[0].batches[0];
        expect(firstBatch.records[0].completedAt).toBeGreaterThan(firstBatch.records[1].completedAt);
    });

    it("splits a day into batches at gaps longer than BATCH_GAP_MS", () => {
        const gapMin = BATCH_GAP_MS / MIN;
        const records = [rec(1), rec(1.5), rec(2), rec(2 + gapMin + 1), rec(2 + gapMin + 1.2)];
        const [today] = groupHistory(records, "all", NOW);
        expect(today.batches.map((b) => b.records.length)).toEqual([3, 2]);
        expect(today.batches[0].start).toBe(NOW - 2 * MIN);
        expect(today.batches[0].end).toBe(NOW - 1 * MIN);
    });

    it("counts directions, failures and completed bytes per batch", () => {
        const records = [
            rec(1, { direction: "push", size: 300 }),
            rec(1.1, { direction: "pull", size: 200 }),
            rec(1.2, { direction: "push", status: "failed", size: 999, error: "x" }),
            rec(1.3, { direction: "pull", status: "cancelled", size: 999 }),
        ];
        const b = groupHistory(records, "all", NOW)[0].batches[0];
        expect(b).toMatchObject({ pulls: 2, pushes: 2, failed: 1, bytes: 500 });
        expect(b.key).toBe(records[0].id);
    });

    it("filters by direction and by failure", () => {
        const records = [
            rec(1, { direction: "push" }),
            rec(2, { direction: "pull" }),
            rec(3, { direction: "pull", status: "failed" }),
        ];
        const count = (f: "pull" | "push" | "failed") =>
            groupHistory(records, f, NOW).flatMap((d) => d.batches.flatMap((b) => b.records)).length;
        expect(count("push")).toBe(1);
        expect(count("pull")).toBe(2);
        expect(count("failed")).toBe(1);
    });

    it("returns nothing for an empty history", () => {
        expect(groupHistory([], "all", NOW)).toEqual([]);
    });
});
