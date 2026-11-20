/**
 * Destructive changes of one sync step, collected BEFORE any of them runs.
 *
 * A sync used to remove and overwrite files as it found them, so nothing could
 * look at the whole set first: a folder deletion ran before the files it
 * contained were even counted. Now each step builds a SyncPlan, a PlanGuard
 * reviews it, and only what the guard approved is executed. The guard is the
 * single place where "ask before deleting many files", a deletion preview or
 * a safety limit can be added later without touching the sync code again.
 *
 * The default guard approves everything, so behaviour is the same as before.
 */

import type { LogLevel } from "./logger";

/** What a planned change does */
export type PlannedAction =
    /** Remove a file or folder from the cloud (deleted on this device) */
    | "delete-remote"
    /** Replace the content of a file that already exists on the cloud */
    | "overwrite-remote"
    /** Move a local file to the trash (deleted on another device) */
    | "delete-local";

export interface PlannedChange {
    action: PlannedAction;
    /** Vault path of the file or folder */
    path: string;
    kind: "file" | "folder";
    /**
     * For a folder: the synced files inside it, which the one folder removal also
     * removes. A guard counting "how many files go away" must count these.
     */
    contains?: string[];
}

export interface SyncPlan {
    /** Which step of the sync built the plan */
    readonly step: "push" | "pull";
    readonly changes: readonly PlannedChange[];
}

/** Totals a guard typically needs */
export interface PlanSummary {
    /** Files removed from the cloud, including the files inside removed folders */
    remoteFilesDeleted: number;
    remoteFoldersDeleted: number;
    remoteFilesOverwritten: number;
    localFilesDeleted: number;
}

export function summarizePlan(plan: SyncPlan): PlanSummary {
    const s: PlanSummary = {
        remoteFilesDeleted: 0,
        remoteFoldersDeleted: 0,
        remoteFilesOverwritten: 0,
        localFilesDeleted: 0,
    };
    for (const c of plan.changes) {
        if (c.action === "delete-remote") {
            if (c.kind === "folder") {
                s.remoteFoldersDeleted++;
                s.remoteFilesDeleted += c.contains?.length ?? 0;
            } else {
                s.remoteFilesDeleted++;
            }
        } else if (c.action === "overwrite-remote") {
            s.remoteFilesOverwritten++;
        } else {
            s.localFilesDeleted++;
        }
    }
    return s;
}

/** The guard's answer: which planned changes must NOT run in this sync */
export class PlanDecision {
    private readonly held: Set<string>;

    constructor(held: Iterable<string> = []) {
        this.held = new Set(held);
    }

    static approveAll(): PlanDecision {
        return new PlanDecision();
    }

    static holdAll(plan: SyncPlan): PlanDecision {
        return new PlanDecision(plan.changes.map((c) => keyOf(c.action, c.path)));
    }

    /** True when the change may run. A change that was never planned is allowed. */
    allows(action: PlannedAction, path: string): boolean {
        return !this.held.has(keyOf(action, path));
    }

    get heldCount(): number {
        return this.held.size;
    }
}

function keyOf(action: PlannedAction, path: string): string {
    return `${action}\u0000${path}`;
}

/**
 * Reviews a plan before it runs. Held changes are not executed in this sync;
 * what happens to them instead is defined per action:
 * - delete-remote / overwrite-remote: the path stays marked as changed, so the
 *   next sync plans it again.
 * - delete-local: the local file is kept and uploaded again, as when it had
 *   local edits (the deletion made elsewhere does not win).
 */
export interface PlanGuard {
    review(plan: SyncPlan): Promise<PlanDecision>;
}

/** Approves every change (the behaviour of every version so far). */
export const approveAllPlanGuard: PlanGuard = {
    review: async () => PlanDecision.approveAll(),
};

/** Review a plan with the context's guard. An empty plan is not shown to the guard. */
export async function reviewPlan(
    ctx: { planGuard?: PlanGuard; log?: (msg: string, level?: LogLevel) => Promise<void> },
    plan: SyncPlan,
): Promise<PlanDecision> {
    if (plan.changes.length === 0) return PlanDecision.approveAll();
    const guard = ctx.planGuard ?? approveAllPlanGuard;
    const decision = await guard.review(plan);
    if (decision.heldCount > 0 && ctx.log) {
        await ctx.log(
            `[Sync Plan] ${decision.heldCount} of ${plan.changes.length} planned ${plan.step} change(s) held back by the guard.`,
            "warn",
        );
    }
    return decision;
}
