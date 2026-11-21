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
import { pairwiseCombinations, singleFactorCombinations } from "./settings-matrix";

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
