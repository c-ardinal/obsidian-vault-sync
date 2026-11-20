import { PlanDecision, summarizePlan, type PlanGuard, type PlanSummary, type SyncPlan } from "./sync-plan";

export interface MassDeleteThresholds {
    /** Ask at this many deleted files or more; -1 (or less than 1) = off */
    massDeleteConfirmFiles: number;
    /** Ask at this share (%) of the synced files or more; -1 (or less than 1) = off */
    massDeleteConfirmPercent: number;
}

/**
 * The share rule alone would ask on every single deletion in a small vault
 * (one file of five is 20%). It applies only from this many deletions on.
 */
export const PERCENT_RULE_MIN_FILES = 5;

/** Files a plan deletes, cloud side and device side (files inside folders included) */
export function deletedFileCount(summary: PlanSummary): number {
    return summary.remoteFilesDeleted + summary.localFilesDeleted;
}

/** True when the plan deletes enough files to need the user's confirmation */
export function exceedsMassDeleteThreshold(
    summary: PlanSummary,
    syncedFileCount: number,
    t: MassDeleteThresholds,
): boolean {
    const deleted = deletedFileCount(summary);
    if (deleted === 0) return false;
    if (t.massDeleteConfirmFiles >= 1 && deleted >= t.massDeleteConfirmFiles) return true;
    if (
        t.massDeleteConfirmPercent >= 1 &&
        syncedFileCount > 0 &&
        deleted >= PERCENT_RULE_MIN_FILES &&
        (deleted / syncedFileCount) * 100 >= t.massDeleteConfirmPercent
    ) {
        return true;
    }
    return false;
}

/** Asks the user; resolves true to run the deletions, false to hold them */
export type MassDeleteConfirm = (plan: SyncPlan, summary: PlanSummary) => Promise<boolean>;

/**
 * Lets a plan run unless it deletes more than the thresholds allow; then the
 * user is asked. When the user declines, the step's deletions are held (see
 * PlanGuard for what a held change becomes); its other changes still run.
 */
export class MassDeleteGuard implements PlanGuard {
    constructor(
        private readonly thresholds: () => MassDeleteThresholds,
        private readonly syncedFileCount: () => number,
        private readonly confirm: MassDeleteConfirm,
    ) {}

    async review(plan: SyncPlan): Promise<PlanDecision> {
        const summary = summarizePlan(plan);
        if (!exceedsMassDeleteThreshold(summary, this.syncedFileCount(), this.thresholds())) {
            return PlanDecision.approveAll();
        }
        const ok = await this.confirm(plan, summary);
        // Declined: only the deletions wait; edits still upload
        return ok
            ? PlanDecision.approveAll()
            : PlanDecision.holdWhere(plan, (c) => c.action === "delete-remote" || c.action === "delete-local");
    }
}
