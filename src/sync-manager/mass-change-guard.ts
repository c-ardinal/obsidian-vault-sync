import { PlanDecision, summarizePlan, type PlanGuard, type PlanSummary, type PlannedChange, type SyncPlan } from "./sync-plan";
import { inConfigDir } from "../utils/config-dir";

export interface MassChangeThresholds {
    /** Ask at this many deleted (or overwritten) files or more; -1 (or less than 1) = off */
    massDeleteConfirmFiles: number;
    /** Ask at this share (%) of the synced files or more; -1 (or less than 1) = off */
    massDeleteConfirmPercent: number;
}

/**
 * The share rule alone would ask on every single deletion in a small vault
 * (one file of five is 20%). It applies only from this many files on.
 */
export const PERCENT_RULE_MIN_FILES = 5;

/** Files a plan deletes, cloud side and device side (files inside folders included) */
export function deletedFileCount(summary: PlanSummary): number {
    return summary.remoteFilesDeleted + summary.localFilesDeleted;
}

/**
 * Overwrites that count toward the confirmation: notes and attachments. Settings
 * in the config folder are left out: updating a few plugins rewrites dozens of their
 * files, and asking each time would teach the user to click through.
 */
export function isCountedOverwrite(c: PlannedChange): boolean {
    return c.action === "overwrite-remote" && !inConfigDir(c.path);
}

/** Files of the user's vault content a plan overwrites on the cloud */
export function overwrittenFileCount(plan: SyncPlan): number {
    return plan.changes.filter(isCountedOverwrite).length;
}

/** True when this many files is enough to need the user's confirmation */
export function exceedsMassChangeThreshold(count: number, syncedFileCount: number, t: MassChangeThresholds): boolean {
    if (count === 0) return false;
    if (t.massDeleteConfirmFiles >= 1 && count >= t.massDeleteConfirmFiles) return true;
    return (
        t.massDeleteConfirmPercent >= 1 &&
        syncedFileCount > 0 &&
        count >= PERCENT_RULE_MIN_FILES &&
        (count / syncedFileCount) * 100 >= t.massDeleteConfirmPercent
    );
}

/** What a confirmation is about; a kind below its threshold is false */
export interface MassChangeAsk {
    deletes: boolean;
    overwrites: boolean;
}

/** Asks the user; resolves true to run the changes, false to hold them */
export type MassChangeConfirm = (plan: SyncPlan, summary: PlanSummary, ask: MassChangeAsk) => Promise<boolean>;

const isDeletion = (c: PlannedChange) => c.action === "delete-remote" || c.action === "delete-local";
const keyOf = (c: PlannedChange) => `${c.action}\u0000${c.path}`;

/**
 * Lets a plan run unless it deletes or overwrites more files than the thresholds
 * allow; then the user is asked. When the user declines, the kind that was asked
 * about is held (see PlanGuard for what a held change becomes); the rest still runs.
 *
 * A held change is planned again by every following sync. An automatic sync does
 * not ask again about changes the user already held: it holds them quietly, until
 * a sync the user starts or a plan with changes not held before.
 */
export class MassChangeGuard implements PlanGuard {
    private held = new Set<string>();

    constructor(
        private readonly thresholds: () => MassChangeThresholds,
        private readonly syncedFileCount: () => number,
        private readonly confirm: MassChangeConfirm,
        private readonly userStarted: () => boolean = () => true,
    ) {}

    async review(plan: SyncPlan): Promise<PlanDecision> {
        const summary = summarizePlan(plan);
        const synced = this.syncedFileCount();
        const t = this.thresholds();
        const ask: MassChangeAsk = {
            deletes: exceedsMassChangeThreshold(deletedFileCount(summary), synced, t),
            overwrites: exceedsMassChangeThreshold(overwrittenFileCount(plan), synced, t),
        };
        if (!ask.deletes && !ask.overwrites) return PlanDecision.approveAll();

        const asked = (c: PlannedChange) => (ask.deletes && isDeletion(c)) || (ask.overwrites && isCountedOverwrite(c));
        const inQuestion = plan.changes.filter(asked);
        const heldBefore = !this.userStarted() && inQuestion.every((c) => this.held.has(keyOf(c)));
        const ok = heldBefore ? false : await this.confirm(plan, summary, ask);
        if (ok) {
            for (const c of inQuestion) this.held.delete(keyOf(c));
            return PlanDecision.approveAll();
        }
        this.held = new Set([...this.held, ...inQuestion.map(keyOf)]);
        return PlanDecision.holdWhere(plan, asked);
    }
}

/**
 * Paths for a confirmation list, folded like the deletion list: a folder that
 * holds two or more of them is one entry with its file count.
 */
export function groupPathsByFolder(paths: string[]): { path: string; count: number }[] {
    const byFolder = new Map<string, string[]>();
    for (const p of paths) {
        const i = p.lastIndexOf("/");
        const folder = i < 0 ? "" : p.slice(0, i);
        const list = byFolder.get(folder) ?? [];
        list.push(p);
        byFolder.set(folder, list);
    }
    const out: { path: string; count: number }[] = [];
    for (const [folder, list] of byFolder) {
        if (folder !== "" && list.length >= 2) out.push({ path: folder, count: list.length });
        else for (const p of list) out.push({ path: p, count: 1 });
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
}
