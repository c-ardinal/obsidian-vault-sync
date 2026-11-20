/**
 * Groups the transfer history for the transfer status screen: by day, then into
 * batches (transfers close together in time, usually one sync cycle). Pure
 * functions, no Obsidian dependency, so they can be unit-tested.
 */
import type { TransferRecord } from "../sync-manager/transfer-types";

export type HistoryFilter = "all" | "pull" | "push" | "failed";

/** Transfers more than this far apart start a new batch */
export const BATCH_GAP_MS = 2 * 60 * 1000;

export interface HistoryBatch {
    /** Stable key: id of the batch's newest record */
    key: string;
    /** Oldest and newest completion time */
    start: number;
    end: number;
    /** Newest first */
    records: TransferRecord[];
    pulls: number;
    pushes: number;
    failed: number;
    bytes: number;
}

export interface HistoryDay {
    /** Local midnight of the day */
    dayStart: number;
    kind: "today" | "yesterday" | "date";
    batches: HistoryBatch[];
}

function localMidnight(ms: number): number {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}

export function matchesFilter(r: TransferRecord, filter: HistoryFilter): boolean {
    switch (filter) {
        case "all":
            return true;
        case "pull":
        case "push":
            return r.direction === filter;
        case "failed":
            return r.status === "failed";
    }
}

export function groupHistory(
    records: TransferRecord[],
    filter: HistoryFilter,
    now: number,
): HistoryDay[] {
    const today = localMidnight(now);
    const yesterday = localMidnight(today - 1);
    const sorted = records
        .filter((r) => matchesFilter(r, filter))
        .sort((a, b) => b.completedAt - a.completedAt);

    const days: HistoryDay[] = [];
    let day: HistoryDay | null = null;
    let batch: HistoryBatch | null = null;
    for (const r of sorted) {
        const dayStart = localMidnight(r.completedAt);
        if (!day || day.dayStart !== dayStart) {
            day = {
                dayStart,
                kind: dayStart === today ? "today" : dayStart === yesterday ? "yesterday" : "date",
                batches: [],
            };
            days.push(day);
            batch = null;
        }
        if (!batch || batch.start - r.completedAt > BATCH_GAP_MS) {
            batch = {
                key: r.id,
                start: r.completedAt,
                end: r.completedAt,
                records: [],
                pulls: 0,
                pushes: 0,
                failed: 0,
                bytes: 0,
            };
            day.batches.push(batch);
        }
        batch.records.push(r);
        batch.start = r.completedAt;
        if (r.direction === "pull") batch.pulls++;
        else batch.pushes++;
        if (r.status === "failed") batch.failed++;
        if (r.status === "completed") batch.bytes += r.size;
    }
    return days;
}
