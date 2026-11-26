/**
 * Progress figures for the sync status panel and the sync check dialog.
 * No Obsidian dependency: unit-tested as plain functions.
 */
import type { DirectionProgress, SyncPhase, SyncProgressSnapshot } from "../sync-manager/sync-progress";
import type { VerifyProgress } from "../sync-manager/sync-verify";

/** 0..1 of one direction over files and bytes (as the tracker's overall fraction) */
function directionFraction(d: DirectionProgress): number {
    if (d.total === 0) return 0;
    const byFiles = d.done / d.total;
    return d.bytesTotal > 0 ? (byFiles + d.bytesDone / d.bytesTotal) / 2 : byFiles;
}

/**
 * How full the bar of one step is: 0..1, or null when the step runs without a
 * measure (checking the cloud, the work after the uploads).
 */
export function stepFraction(s: SyncProgressSnapshot, id: SyncPhase, behind: boolean, current: boolean): number | null {
    // Transfers are measured whatever the step: one planned early or finishing late shows as it is.
    if (id === "pulling" && s.pull.total > 0) return directionFraction(s.pull);
    if (id === "pushing" && s.push.total > 0) return directionFraction(s.push);
    if (behind) return 1;
    if (!current) return 0;
    if (id === "scanning" && s.scan.total > 0) return s.scan.done / s.scan.total;
    return null;
}

/** No time-left estimate before the comparison has run this long (early rates are noise) */
const ETA_MIN_ELAPSED_MS = 2000;
/** Share done (0..1) and seconds left of a running check; null where not known yet. */
export function verifyEstimate(
    p: VerifyProgress,
    elapsedMs: number,
): { fraction: number | null; etaSec: number | null } {
    if (p.stage === "listing") return { fraction: null, etaSec: null };
    // Reading time follows the size of the files; without sizes, count files.
    const fraction =
        p.bytesTotal > 0 ? p.bytesDone / p.bytesTotal : p.total > 0 ? p.done / p.total : 1;
    const etaSec =
        fraction > 0 && fraction < 1 && elapsedMs >= ETA_MIN_ELAPSED_MS
            ? Math.ceil(((elapsedMs / fraction) * (1 - fraction)) / 1000)
            : null;
    return { fraction, etaSec };
}

