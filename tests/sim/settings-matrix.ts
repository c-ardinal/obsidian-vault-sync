/**
 * Settings combinations for the multi-device simulation.
 *
 * Each factor is a user-facing setting (or a group of related ones) with the
 * values worth telling apart. A pairwise (all-pairs) set of combinations is
 * built greedily and deterministically: every value of every factor meets
 * every value of every other factor in at least one combination. Each
 * combination becomes a simulation scenario (see settings-matrix.sim.test.ts).
 */
import type { SyncManagerSettings } from "../../src/sync-manager";
import { Rng } from "./rng";
import { DEFAULT_CONFIG, type SimConfig, type SettingChangeConfig } from "./simulation";

type Scenario = Omit<SimConfig, "seed">;

/** One value of a factor: how it shapes the scenario */
interface Level {
    id: string;
    apply: (s: Draft) => void;
}

interface Factor {
    name: string;
    levels: Level[];
}

/** Scenario under construction */
interface Draft {
    cfg: Scenario;
    /** Per-device overrides (3 devices) */
    dev: Partial<SyncManagerSettings>[];
    /** Settings the users may change during the run */
    changes: SettingChangeConfig["options"];
    shared: boolean;
}

const DEVICES = 3;

export const FACTORS: Factor[] = [
    {
        name: "conflict",
        levels: [
            { id: "smart-merge", apply: () => {} },
            { id: "always-fork", apply: (s) => s.dev.forEach((d) => (d.conflictResolutionStrategy = "always-fork")) },
            { id: "force-remote", apply: (s) => s.dev.forEach((d) => (d.conflictResolutionStrategy = "force-remote")) },
            {
                // Settings not synced, every device chose differently
                id: "mixed",
                apply: (s) => {
                    s.dev[0].conflictResolutionStrategy = "smart-merge";
                    s.dev[1].conflictResolutionStrategy = "force-local";
                    s.dev[2].conflictResolutionStrategy = "always-fork";
                },
            },
            {
                id: "changed-mid-run",
                apply: (s) =>
                    s.changes.push({
                        key: "conflictResolutionStrategy",
                        values: ["smart-merge", "always-fork", "force-local", "force-remote"],
                    }),
            },
        ],
    },
    {
        name: "exclusion",
        levels: [
            { id: "none", apply: () => {} },
            { id: "same-on-all", apply: (s) => s.dev.forEach((d) => (d.exclusionPatterns = "notes/sub/**")) },
            {
                id: "one-device-only",
                apply: (s) => (s.dev[1].exclusionPatterns = "notes/sub/**"),
            },
            {
                id: "changed-mid-run",
                apply: (s) => s.changes.push({ key: "exclusionPatterns", values: ["", "notes/sub/**", "archive/**"] }),
            },
        ],
    },
    {
        name: "images",
        levels: [
            { id: "on", apply: () => {} },
            { id: "off-on-one-device", apply: (s) => (s.dev[2].syncImagesAndMedia = false) },
            { id: "changed-mid-run", apply: (s) => s.changes.push({ key: "syncImagesAndMedia", values: [true, false] }) },
        ],
    },
    {
        name: "device-list",
        levels: [
            { id: "none", apply: () => {} },
            { id: "one-device", apply: (s) => (s.dev[0].desktopExclusionPatterns = "assets/**") },
            {
                id: "changed-mid-run",
                apply: (s) => s.changes.push({ key: "desktopExclusionPatterns", values: ["", "assets/**", "notes/sub/**"] }),
            },
        ],
    },
    {
        name: "settings-sync",
        levels: [
            { id: "shared", apply: (s) => (s.shared = true) },
            { id: "per-device", apply: (s) => (s.shared = false) },
        ],
    },
    {
        name: "deletes",
        levels: [
            { id: "none", apply: () => {} },
            { id: "deletes", apply: (s) => (s.cfg.deletes = true) },
            {
                id: "deletes+confirm",
                apply: (s) => {
                    s.cfg.deletes = true;
                    s.cfg.massDelete = { files: 3, percent: 10, declineRate: 0.5 };
                },
            },
        ],
    },
    {
        name: "large-files",
        levels: [
            { id: "inline", apply: (s) => (s.cfg.settings = { ...s.cfg.settings, largeFileThresholdMB: 0 }) },
            { id: "background", apply: (s) => (s.cfg.settings = { ...s.cfg.settings, largeFileThresholdMB: 0.0001 }) },
            {
                id: "background-throttled",
                apply: (s) =>
                    (s.cfg.settings = { ...s.cfg.settings, largeFileThresholdMB: 0.0001, bgTransferIntervalSec: 2 }),
            },
        ],
    },
    {
        name: "encryption",
        levels: [
            { id: "off", apply: () => {} },
            { id: "e2ee", apply: (s) => (s.cfg.e2ee = true) },
            { id: "non-md5-cloud", apply: (s) => (s.cfg.foreignHash = true) },
        ],
    },
    {
        name: "concurrency",
        levels: [
            { id: "1", apply: (s) => (s.cfg.settings = { ...s.cfg.settings, concurrency: 1 }) },
            { id: "2", apply: () => {} },
            { id: "5", apply: (s) => (s.cfg.settings = { ...s.cfg.settings, concurrency: 5 }) },
        ],
    },
    {
        name: "cloud-trash",
        levels: [
            { id: "30-days", apply: () => {} },
            { id: "remove-at-once", apply: (s) => (s.cfg.settings = { ...s.cfg.settings, remoteTrashRetentionDays: -1 }) },
        ],
    },
    {
        name: "keep-revisions",
        levels: [
            { id: "off", apply: () => {} },
            { id: "daily", apply: (s) => (s.cfg.settings = { ...s.cfg.settings, autoKeepRevisionDays: 1 }) },
        ],
    },
    {
        // Short trigger delays / intervals = syncs much more often between edits
        name: "sync-frequency",
        levels: [
            { id: "normal", apply: () => {} },
            { id: "near-realtime", apply: (s) => (s.cfg.meanGapMs = 400) },
        ],
    },
    {
        name: "network",
        levels: [
            { id: "clean", apply: () => {} },
            {
                id: "flaky",
                apply: (s) => {
                    s.cfg.network = { minLatencyMs: 20, maxLatencyMs: 1500, failureRate: 0.04, lostResponseRate: 0.3 };
                    s.cfg.offlineRate = 0.03;
                    s.cfg.maxClockSkewMs = 120_000;
                },
            },
        ],
    },
    {
        name: "devices",
        levels: [
            { id: "linux", apply: () => {} },
            {
                id: "mixed-os",
                apply: (s) => {
                    s.cfg.fs = ["linux", "windows", "macos"];
                    s.cfg.windowsLineEndings = true;
                },
            },
        ],
    },
    {
        name: "app-restarts",
        levels: [
            { id: "none", apply: () => {} },
            { id: "restarts", apply: (s) => (s.cfg.restartRate = 0.05) },
        ],
    },
];

export interface Combination {
    name: string;
    /** factor name -> level id */
    levels: Record<string, string>;
    scenario: Scenario;
}

/**
 * The baseline (first value of every factor) and every other value alone on
 * top of it: tells which single setting a failure needs.
 */
export function singleFactorCombinations(): Combination[] {
    const base = FACTORS.map(() => 0);
    const out: Combination[] = [build(base, 0, "single-baseline")];
    FACTORS.forEach((f, i) => {
        for (let l = 1; l < f.levels.length; l++) {
            const row = [...base];
            row[i] = l;
            out.push(build(row, 0, `single-${f.name}=${f.levels[l].id}`));
        }
    });
    return out;
}

function build(levels: number[], index: number, name?: string): Combination {
    const draft: Draft = {
        cfg: {
            ...DEFAULT_CONFIG,
            name: name ?? `combo-${String(index).padStart(2, "0")}`,
            profile: "disjoint",
            devices: DEVICES,
            actions: 50,
            binaryRate: 0.25,
        },
        dev: Array.from({ length: DEVICES }, () => ({})),
        changes: [],
        shared: true,
    };
    const named: Record<string, string> = {};
    FACTORS.forEach((f, i) => {
        const level = f.levels[levels[i]];
        level.apply(draft);
        named[f.name] = level.id;
    });
    draft.cfg.deviceSettings = draft.dev;
    if (draft.changes.length) {
        draft.cfg.settingChanges = { rate: 0.05, options: draft.changes, shared: draft.shared };
    }
    return { name: draft.cfg.name, levels: named, scenario: draft.cfg };
}

/**
 * Greedy all-pairs: each new row is the best of many random candidates (the
 * one covering most pairs not yet covered), until every pair is covered.
 */
export function pairwiseCombinations(seed = 1): Combination[] {
    const rng = new Rng(seed);
    const sizes = FACTORS.map((f) => f.levels.length);
    const uncovered = new Set<string>();
    const key = (i: number, a: number, j: number, b: number) => `${i}:${a}|${j}:${b}`;
    for (let i = 0; i < sizes.length; i++)
        for (let j = i + 1; j < sizes.length; j++)
            for (let a = 0; a < sizes[i]; a++) for (let b = 0; b < sizes[j]; b++) uncovered.add(key(i, a, j, b));
    const gain = (row: number[]) => {
        let n = 0;
        for (let i = 0; i < row.length; i++)
            for (let j = i + 1; j < row.length; j++) if (uncovered.has(key(i, row[i], j, row[j]))) n++;
        return n;
    };
    const rows: number[][] = [];
    while (uncovered.size > 0) {
        let best: number[] | null = null;
        let bestGain = -1;
        for (let c = 0; c < 200; c++) {
            // Start from one uncovered pair so every row makes progress
            const [first] = uncovered;
            const [pi, pj] = first.split("|").map((x) => x.split(":").map(Number));
            const row = sizes.map((n) => rng.int(0, n - 1));
            row[pi[0]] = pi[1];
            row[pj[0]] = pj[1];
            const g = gain(row);
            if (g > bestGain) {
                best = row;
                bestGain = g;
            }
        }
        rows.push(best!);
        for (let i = 0; i < best!.length; i++)
            for (let j = i + 1; j < best!.length; j++) uncovered.delete(key(i, best![i], j, best![j]));
    }
    return rows.map((r, i) => build(r, i + 1));
}
