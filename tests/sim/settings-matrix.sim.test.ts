/**
 * Multi-device simulation over pairwise combinations of the plugin settings
 * (see settings-matrix.ts). Same invariants as multi-device.sim.test.ts, plus
 * the scope checks (SCOPE_LOSS: a setting made a device lose a note nobody
 * deleted).
 *
 *   npm run test:sim -- tests/sim/settings-matrix.sim.test.ts
 *   SIM_SEEDS=200 npm run test:sim -- tests/sim/settings-matrix.sim.test.ts
 *   SIM_COMBO=combo-07 SIM_SEED=12 npm run test:sim -- tests/sim/settings-matrix.sim.test.ts
 *   SIM_MATRIX_LIST=1 ...   (prints the combinations)
 */
import { describe, it, expect } from "vitest";
import { formatFailure, runSimulation, type SimConfig } from "./simulation";
import { combinationOf, pairwiseCombinations, singleFactorCombinations } from "./settings-matrix";

const envInt = (k: string, d: number) => (process.env[k] ? parseInt(process.env[k]!, 10) : d);
const SEED_COUNT = envInt("SIM_SEEDS", 5);
const SEED_BASE = envInt("SIM_SEED_BASE", 1);
const ONLY_SEED = process.env.SIM_SEED ? parseInt(process.env.SIM_SEED, 10) : null;
const ONLY_COMBO = process.env.SIM_COMBO || null;
const seeds = ONLY_SEED !== null ? [ONLY_SEED] : Array.from({ length: SEED_COUNT }, (_, i) => SEED_BASE + i);

// SIM_MATRIX=single: baseline + one changed setting at a time (to tell which setting a failure needs)
const combos = process.env.SIM_MATRIX === "single" ? singleFactorCombinations() : pairwiseCombinations();
if (process.env.SIM_MATRIX_LIST) {
    for (const c of combos) console.log(c.name, JSON.stringify(c.levels));
}

for (const combo of combos) {
    if (ONLY_COMBO && combo.name !== ONLY_COMBO) continue;
    const title = combo.name.startsWith("single-") ? combo.name : `${combo.name}: ${Object.values(combo.levels).join(" / ")}`;
    describe(`settings combination ${title}`, () => {
        it.each(seeds)("seed %i", async (seed) => {
            const cfg: SimConfig = { ...combo.scenario, seed };
            const result = await runSimulation(cfg);
            if (!result.ok) expect.fail(formatFailure(result).replace(/SIM_SCENARIO=\S+/, `SIM_COMBO=${combo.name}`));
        });
    });
}

/**
 * Failures the pairwise run found, pinned by their settings (not by combo
 * number, which changes when a factor is added) and seed. All fixed.
 */
const PINNED: { title: string; seed: number; levels: Record<string, string> }[] = [
    {
        title: "PC-only list changed during a sync and back: the file skipped meanwhile is pulled",
        seed: 40,
        levels: {
            conflict: "always-fork", exclusion: "one-device-only", "device-list": "changed-mid-run",
            deletes: "deletes+confirm", "large-files": "background-throttled", encryption: "non-md5-cloud",
            concurrency: "5", "keep-revisions": "daily", "sync-frequency": "near-realtime", network: "flaky", "app-restarts": "restarts",
        },
    },
    {
        title: "PC-only list changed during a sync and back: files created meanwhile are uploaded",
        seed: 94,
        levels: {
            conflict: "always-fork", exclusion: "one-device-only", "device-list": "changed-mid-run",
            deletes: "deletes+confirm", "large-files": "background-throttled", encryption: "non-md5-cloud",
            concurrency: "5", "keep-revisions": "daily", "sync-frequency": "near-realtime", network: "flaky", "app-restarts": "restarts",
        },
    },
    {
        title: "an index upload that replaced another device's still lists the files this device leaves out",
        seed: 48,
        levels: {
            conflict: "always-fork", exclusion: "one-device-only", "device-list": "changed-mid-run",
            deletes: "deletes+confirm", "large-files": "background-throttled", encryption: "non-md5-cloud",
            concurrency: "5", "keep-revisions": "daily", "sync-frequency": "near-realtime", network: "flaky", "app-restarts": "restarts",
        },
    },
    {
        title: "background pull cancelled by our own earlier write: the newer version still arrives",
        seed: 44,
        levels: {
            conflict: "always-fork", exclusion: "same-on-all", images: "off-on-one-device", "settings-sync": "per-device",
            deletes: "deletes", "large-files": "background-throttled", encryption: "e2ee", concurrency: "5",
            "cloud-trash": "remove-at-once", "sync-frequency": "near-realtime", devices: "mixed-os",
        },
    },
    {
        title: "always-fork: an overwritten version that cannot be merged is kept as a conflict copy",
        seed: 85,
        levels: {
            conflict: "always-fork", exclusion: "changed-mid-run", "device-list": "one-device", "settings-sync": "per-device",
            "large-files": "background", concurrency: "5", "cloud-trash": "remove-at-once", "keep-revisions": "daily", network: "flaky",
        },
    },
    {
        title: "a merge lock on a file this device leaves out is not waited for",
        seed: 65,
        levels: {
            images: "off-on-one-device", "device-list": "changed-mid-run", "settings-sync": "per-device",
            "large-files": "background", encryption: "non-md5-cloud", "cloud-trash": "remove-at-once",
        },
    },
];

if (!ONLY_COMBO) {
    describe("settings combinations: fixed failures", () => {
        it.each(PINNED)("$title", async ({ title, seed, levels }) => {
            const combo = combinationOf("pinned", levels);
            const result = await runSimulation({ ...combo.scenario, seed });
            if (!result.ok) expect.fail(`${title}\n${formatFailure(result)}`);
        });
    });
}
