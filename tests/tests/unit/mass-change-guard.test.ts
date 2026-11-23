import { describe, it, expect, vi } from "vitest";
import {
    MassChangeGuard,
    PERCENT_RULE_MIN_FILES,
    deletedFileCount,
    exceedsMassChangeThreshold,
} from "../../../src/sync-manager/mass-change-guard";
import { summarizePlan, type SyncPlan } from "../../../src/sync-manager/sync-plan";
import { DEFAULT_SETTINGS } from "../../../src/constants";

const files = (n: number, action: "delete-remote" | "delete-local" = "delete-remote") =>
    Array.from({ length: n }, (_, i) => ({ action, path: `n${i}.md`, kind: "file" as const }));
const plan = (changes: SyncPlan["changes"], step: SyncPlan["step"] = "push"): SyncPlan => ({ step, changes });
const exceedsMassDeleteThreshold = (
    summary: ReturnType<typeof summarizePlan>,
    synced: number,
    t: { massDeleteConfirmFiles: number; massDeleteConfirmPercent: number },
) => exceedsMassChangeThreshold(deletedFileCount(summary), synced, t);
const overwrites = (n: number, dir = "") =>
    Array.from({ length: n }, (_, i) => ({ action: "overwrite-remote" as const, path: `${dir}o${i}.md`, kind: "file" as const }));
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

    it("can be turned off", () => {
        const off = { massDeleteConfirmFiles: -1, massDeleteConfirmPercent: -1 };
        expect(exceedsMassDeleteThreshold(summarizePlan(plan(files(500))), 500, off)).toBe(false);
    });
});

describe("MassChangeGuard", () => {
    const overwrite = { action: "overwrite-remote" as const, path: "edit.md", kind: "file" as const };

    it("does not ask below the thresholds", async () => {
        const confirm = vi.fn(async () => true);
        const guard = new MassChangeGuard(() => defaults, () => 10_000, confirm);
        const d = await guard.review(plan(files(3)));
        expect(confirm).not.toHaveBeenCalled();
        expect(d.heldCount).toBe(0);
    });

    it("runs everything when the user confirms", async () => {
        const confirm = vi.fn(async () => true);
        const guard = new MassChangeGuard(() => defaults, () => 10_000, confirm);
        const p = plan([...files(20), overwrite]);
        const d = await guard.review(p);
        expect(confirm).toHaveBeenCalledWith(p, summarizePlan(p), { deletes: true, overwrites: false });
        expect(d.heldCount).toBe(0);
    });

    it("holds only the deletions when the user declines", async () => {
        const guard = new MassChangeGuard(() => defaults, () => 10_000, async () => false);
        const d = await guard.review(plan([...files(20), overwrite]));
        expect(d.heldCount).toBe(20);
        expect(d.allows("delete-remote", "n0.md")).toBe(false);
        expect(d.allows("overwrite-remote", "edit.md")).toBe(true);
    });

    it("reads the thresholds at review time (settings changes apply at once)", async () => {
        let t = { ...defaults };
        const confirm = vi.fn(async () => true);
        const guard = new MassChangeGuard(() => t, () => 10_000, confirm);
        t = { massDeleteConfirmFiles: 3, massDeleteConfirmPercent: -1 };
        await guard.review(plan(files(3)));
        expect(confirm).toHaveBeenCalledTimes(1);
    });

    it("asks before overwriting many notes on the cloud, and holds them when declined", async () => {
        const confirm = vi.fn(async () => false);
        const guard = new MassChangeGuard(() => defaults, () => 10_000, confirm);
        const p = plan([...overwrites(20), ...files(1)]);
        const d = await guard.review(p);
        expect(confirm).toHaveBeenCalledWith(p, summarizePlan(p), { deletes: false, overwrites: true });
        expect(d.allows("overwrite-remote", "o0.md")).toBe(false);
        // The one deletion was not asked about: it runs
        expect(d.allows("delete-remote", "n0.md")).toBe(true);
    });

    it("does not count settings files under .obsidian as overwrites", async () => {
        const confirm = vi.fn(async () => true);
        const guard = new MassChangeGuard(() => defaults, () => 100, confirm);
        await guard.review(plan(overwrites(60, ".obsidian/plugins/x/")));
        expect(confirm).not.toHaveBeenCalled();
    });

    it("does not ask an automatic sync again about changes already held", async () => {
        let userStarted = false;
        const confirm = vi.fn(async () => false);
        const guard = new MassChangeGuard(() => defaults, () => 10_000, confirm, () => userStarted);
        await guard.review(plan(overwrites(20)));
        expect(confirm).toHaveBeenCalledTimes(1);

        // Same changes on the next timer sync: held without asking
        const again = await guard.review(plan(overwrites(20)));
        expect(confirm).toHaveBeenCalledTimes(1);
        expect(again.allows("overwrite-remote", "o0.md")).toBe(false);

        // One more edited note: the question is a new one
        await guard.review(plan(overwrites(21)));
        expect(confirm).toHaveBeenCalledTimes(2);

        // A sync the user starts always asks
        userStarted = true;
        await guard.review(plan(overwrites(21)));
        expect(confirm).toHaveBeenCalledTimes(3);
    });
});

describe("groupPathsByFolder", () => {
    it("folds a folder holding two or more paths, keeps single files", async () => {
        const { groupPathsByFolder } = await import("../../../src/sync-manager/mass-change-guard");
        expect(groupPathsByFolder(["a/x.md", "a/y.md", "b/z.md", "top.md"])).toEqual([
            { path: "a", count: 2 },
            { path: "b/z.md", count: 1 },
            { path: "top.md", count: 1 },
        ]);
    });
});
