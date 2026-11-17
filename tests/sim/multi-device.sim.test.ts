/**
 * Randomized multi-device sync simulation.
 *
 *   npm run test:sim                              # default seeds for every scenario
 *   SIM_SEEDS=500 npm run test:sim                # more seeds
 *   SIM_SEED=1234 SIM_SCENARIO=flaky-network npm run test:sim   # replay one failure
 *   SIM_SEED=1234 SIM_SCENARIO=flaky-network SIM_MINIMIZE=1 npm run test:sim
 *       (shrinks the plan while the first failure kind still reproduces;
 *        SIM_MINIMIZE_KIND=FALSE_CONFLICT picks another kind)
 *
 * Failing runs write <scenario>-seed<N>.{json,log} into test-results/sim/
 * (override with SIM_REPORT_DIR). The .log is a merged timeline of every
 * device's sync log, user operations, vault events and cloud calls.
 */
import { describe, it, expect } from "vitest";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import {
    DEFAULT_CONFIG,
    formatFailure,
    generatePlan,
    minimizePlan,
    reportDir,
    runSimulation,
    type SimConfig,
} from "./simulation";

type Scenario = Omit<SimConfig, "seed">;

/** Scenario catalogue. Each one is run for SIM_SEEDS seeds. */
export const SCENARIOS: Scenario[] = [
    {
        // Baseline: healthy network, devices edit different lines of shared notes.
        ...DEFAULT_CONFIG,
        name: "clean-network",
        profile: "disjoint",
        devices: 3,
        actions: 40,
        network: { minLatencyMs: 5, maxLatencyMs: 400, failureRate: 0, lostResponseRate: 0 },
    },
    {
        // Same, but vault events reach the plugin without file-watcher delay.
        // Comparing with clean-network tells whether a bug depends on event timing.
        ...DEFAULT_CONFIG,
        name: "clean-network-instant-events",
        profile: "disjoint",
        devices: 3,
        actions: 40,
        maxEventDelayMs: 0,
        network: { minLatencyMs: 5, maxLatencyMs: 400, failureRate: 0, lostResponseRate: 0 },
    },
    {
        // Mobile-like: slow, lossy network, devices going offline, skewed clocks.
        ...DEFAULT_CONFIG,
        name: "flaky-network",
        profile: "disjoint",
        devices: 3,
        actions: 50,
        network: { minLatencyMs: 20, maxLatencyMs: 2000, failureRate: 0.05, lostResponseRate: 0.3 },
        offlineRate: 0.05,
        maxClockSkewMs: 120_000,
    },
    {
        // Linux + Windows (case-insensitive, CRLF+BOM) + macOS (case/NFD-insensitive)
        // in ONE vault, with binary attachments.
        ...DEFAULT_CONFIG,
        name: "cross-os",
        profile: "disjoint",
        devices: 3,
        actions: 45,
        fs: ["linux", "windows", "macos"],
        windowsLineEndings: true,
        binaryRate: 0.25,
    },
    {
        // Anything goes: same-line edits, deletes, renames, case/NFD path collisions, faults.
        ...DEFAULT_CONFIG,
        name: "chaos",
        profile: "chaos",
        devices: 4,
        actions: 60,
        fs: ["linux", "windows", "macos", "linux"],
        windowsLineEndings: true,
        binaryRate: 0.15,
        network: { minLatencyMs: 5, maxLatencyMs: 1500, failureRate: 0.03, lostResponseRate: 0.3 },
        offlineRate: 0.04,
        maxClockSkewMs: 120_000,
    },
    {
        // E2EE on every device: each upload gets a fresh IV, so the cloud md5 of
        // identical content differs per upload. Mixed OS + binaries + lossy network
        // exercise the plainHash paths (conflict detection, echo suppression, merge).
        ...DEFAULT_CONFIG,
        name: "e2ee",
        profile: "disjoint",
        devices: 3,
        actions: 45,
        e2ee: true,
        fs: ["linux", "windows", "macos"],
        windowsLineEndings: true,
        binaryRate: 0.2,
        network: { minLatencyMs: 5, maxLatencyMs: 800, failureRate: 0.02, lostResponseRate: 0.15 },
    },
    {
        // Devices use the REAL file system of the machine running the test.
        // Run this on the CI OS matrix to catch NTFS / APFS / ext4 differences.
        ...DEFAULT_CONFIG,
        name: "real-fs",
        profile: "disjoint",
        devices: 3,
        actions: 40,
        fs: ["real-fs"],
        binaryRate: 0.2,
    },
];

const envInt = (k: string, d: number) => (process.env[k] ? parseInt(process.env[k]!, 10) : d);
const SEED_COUNT = envInt("SIM_SEEDS", 10);
const SEED_BASE = envInt("SIM_SEED_BASE", 1);
const ONLY_SEED = process.env.SIM_SEED ? parseInt(process.env.SIM_SEED, 10) : null;
const ONLY_SCENARIO = process.env.SIM_SCENARIO || null;
const MINIMIZE = process.env.SIM_MINIMIZE === "1";

const seeds = ONLY_SEED !== null ? [ONLY_SEED] : Array.from({ length: SEED_COUNT }, (_, i) => SEED_BASE + i);

for (const scenario of SCENARIOS) {
    if (ONLY_SCENARIO && scenario.name !== ONLY_SCENARIO) continue;

    describe(`multi-device simulation: ${scenario.name}`, () => {
        it.each(seeds)("seed %i", async (seed) => {
            const cfg: SimConfig = { ...scenario, seed };
            const result = await runSimulation(cfg);

            if (!result.ok && MINIMIZE) {
                const kind = process.env.SIM_MINIMIZE_KIND ?? result.failures[0].kind;
                const min = await minimizePlan(cfg, generatePlan(cfg), kind);
                const dir = reportDir();
                mkdirSync(dir, { recursive: true });
                const file = join(dir, `${cfg.name}-seed${seed}.min-plan.json`);
                writeFileSync(file, JSON.stringify(min, null, 2));
                const minResult = await runSimulation({ ...cfg, name: `${cfg.name}-min` }, min);
                console.log(
                    `Minimized plan: ${min.length} actions -> ${file}\n` +
                        (minResult.reportPath ? `Minimized timeline: ${minResult.reportPath}` : ""),
                );
            }

            if (!result.ok) expect.fail(formatFailure(result));
        });
    });
}
