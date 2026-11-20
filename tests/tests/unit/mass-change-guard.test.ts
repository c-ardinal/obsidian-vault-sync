import { describe, it, expect, vi } from "vitest";
import {
    MassDeleteGuard,
    PERCENT_RULE_MIN_FILES,
    exceedsMassDeleteThreshold,
} from "../../../src/sync-manager/mass-change-guard";
import { summarizePlan, type SyncPlan } from "../../../src/sync-manager/sync-plan";
import { DEFAULT_SETTINGS } from "../../../src/constants";

const files = (n: number, action: "delete-remote" | "delete-local" = "delete-remote") =>
    Array.from({ length: n }, (_, i) => ({ action, path: `n${i}.md`, kind: "file" as const }));
const plan = (changes: SyncPlan["changes"], step: SyncPlan["step"] = "push"): SyncPlan => ({ step, changes });
const defaults = {
    massDeleteConfirmFiles: DEFAULT_SETTINGS.massDeleteConfirmFiles,
    massDeleteConfirmPercent: DEFAULT_SETTINGS.massDeleteConfirmPercent,
};

describe("mass deletion thresholds", () => {
    it("defaults to 20 files or 10% of the synced files", () => {
        expect(defaults).toEqual({ massDeleteConfirmFiles: 20, massDeleteConfirmPercent: 10 });
    });

    it("asks from the file count on", () => {
        expect(exceedsMassDeleteThreshold(summarizePlan(plan(files(19))), 10_000, defaults)).toBe(false);
        expect(exceedsMassDeleteThreshold(summarizePlan(plan(files(20))), 10_000, defaults)).toBe(true);
    });

    it("asks from the share on, but not for a handful of files", () => {
        // 10 of 100 = 10%
        expect(exceedsMassDeleteThreshold(summarizePlan(plan(files(10))), 100, defaults)).toBe(true);
        expect(exceedsMassDeleteThreshold(summarizePlan(plan(files(9))), 100, defaults)).toBe(false);
        // One note of a tiny vault is 50%, but too few files to ask about
        expect(exceedsMassDeleteThreshold(summarizePlan(plan(files(1))), 2, defaults)).toBe(false);
        expect(
            exceedsMassDeleteThreshold(summarizePlan(plan(files(PERCENT_RULE_MIN_FILES))), 10, defaults),
        ).toBe(true);
    });

    it("counts the files inside a deleted folder", () => {
        const folder = {
            action: "delete-remote" as const,
            path: "big",
            kind: "folder" as const,
            contains: Array.from({ length: 25 }, (_, i) => `big/${i}.md`),
        };
        expect(exceedsMassDeleteThreshold(summarizePlan(plan([folder])), 10_000, defaults)).toBe(true);
    });

    it("counts device-side deletions as well", () => {
        expect(
            exceedsMassDeleteThreshold(summarizePlan(plan(files(20, "delete-local"), "pull")), 10_000, defaults),
        ).toBe(true);
    });

    it("ignores overwrites and can be turned off", () => {
        const overwrites = Array.from({ length: 50 }, (_, i) => ({
            action: "overwrite-remote" as const,
            path: `o${i}.md`,
            kind: "file" as const,
        }));
        expect(exceedsMassDeleteThreshold(summarizePlan(plan(overwrites)), 50, defaults)).toBe(false);
        const off = { massDeleteConfirmFiles: -1, massDeleteConfirmPercent: -1 };
        expect(exceedsMassDeleteThreshold(summarizePlan(plan(files(500))), 500, off)).toBe(false);
    });
});

describe("MassDeleteGuard", () => {
    const overwrite = { action: "overwrite-remote" as const, path: "edit.md", kind: "file" as const };

    it("does not ask below the thresholds", async () => {
        const confirm = vi.fn(async () => true);
        const guard = new MassDeleteGuard(() => defaults, () => 10_000, confirm);
        const d = await guard.review(plan(files(3)));
        expect(confirm).not.toHaveBeenCalled();
        expect(d.heldCount).toBe(0);
    });

    it("runs everything when the user confirms", async () => {
        const confirm = vi.fn(async () => true);
        const guard = new MassDeleteGuard(() => defaults, () => 10_000, confirm);
        const p = plan([...files(20), overwrite]);
        const d = await guard.review(p);
        expect(confirm).toHaveBeenCalledWith(p, summarizePlan(p));
        expect(d.heldCount).toBe(0);
    });

    it("holds only the deletions when the user declines", async () => {
        const guard = new MassDeleteGuard(() => defaults, () => 10_000, async () => false);
        const d = await guard.review(plan([...files(20), overwrite]));
        expect(d.heldCount).toBe(20);
        expect(d.allows("delete-remote", "n0.md")).toBe(false);
        expect(d.allows("overwrite-remote", "edit.md")).toBe(true);
    });

    it("reads the thresholds at review time (settings changes apply at once)", async () => {
        let t = { ...defaults };
        const confirm = vi.fn(async () => true);
        const guard = new MassDeleteGuard(() => t, () => 10_000, confirm);
        t = { massDeleteConfirmFiles: 3, massDeleteConfirmPercent: -1 };
        await guard.review(plan(files(3)));
        expect(confirm).toHaveBeenCalledTimes(1);
    });
});
