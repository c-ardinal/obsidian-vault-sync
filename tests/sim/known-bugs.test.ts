/**
 * Known multi-device bugs, each pinned as a tiny deterministic scenario that
 * was found by the randomized simulation and shrunk with SIM_MINIMIZE=1.
 *
 * Every test asserts that the bug STILL reproduces. When you fix one, its
 * test fails with "no longer reproduces" — then move the case to
 * FIXED_REGRESSIONS below (which asserts the run is clean) so it can never
 * come back.
 *
 * Each run writes its full timeline to test-results/sim/known-<n>-seed<seed>.log,
 * which is the quickest way to study a bug before fixing it.
 */
import { describe, it, expect } from "vitest";
import { DEFAULT_CONFIG, formatFailure, runSimulation, type Action, type SimConfig } from "./simulation";

interface Case {
    title: string;
    /** What a user would see */
    symptom: string;
    config: Partial<SimConfig>;
    plan: Action[];
    /** Failure kinds that prove the bug is present */
    expect: string[];
}

const NET = { minLatencyMs: 5, maxLatencyMs: 400, failureRate: 0, lostResponseRate: 0 };

const KNOWN_BUGS: Case[] = [
    {
        title: "rename while the first upload of a new note is in flight leaves a duplicate",
        symptom: "Create 'Untitled.md', sync starts, rename it: both names exist on every device forever",
        config: { seed: 17, maxEventDelayMs: 0, network: NET },
        plan: [
            { t: 0, dev: "A", kind: "join" },
            { t: 8181, dev: "B", kind: "join" },
            { t: 11488, dev: "C", kind: "join" },
            { t: 13051, dev: "B", kind: "create", fid: "f1", path: "notes/B-1.md" },
            { t: 13778, dev: "B", kind: "sync", scan: true },
            { t: 16509, dev: "B", kind: "rename", pick: 0, to: "notes/B-r8.md" },
        ],
        expect: ["DUPLICATE"],
    },
    {
        title: "two devices pushing at the same time overwrite each other's sync-index entries",
        symptom:
            "A note is missing on a device that syncs from sync-index.json (e.g. a newly added device) and never arrives",
        config: { seed: 18, maxEventDelayMs: 0, network: NET },
        plan: [
            { t: 0, dev: "A", kind: "join" },
            { t: 5499, dev: "B", kind: "join" },
            { t: 16172, dev: "C", kind: "join" },
            { t: 41972, dev: "B", kind: "create", fid: "f6", path: "notes/sub/B-3.md" },
            { t: 44148, dev: "B", kind: "sync", scan: false },
            { t: 44948, dev: "A", kind: "create", fid: "f7", path: "notes/A-3.md" },
            { t: 45948, dev: "A", kind: "sync", scan: false },
        ],
        expect: ["DIVERGED"],
    },
    {
        title: "remote rename is dropped while the old path is dirty; the old file is stuck forever",
        symptom: "Edits made on another device to a just-renamed note are lost; every sync logs CONFLICT DETECTED",
        config: { seed: 12, maxEventDelayMs: 0, network: NET },
        plan: [
            { t: 0, dev: "A", kind: "join" },
            { t: 5743, dev: "A", kind: "create", fid: "f1", path: "notes/A-1.md" },
            { t: 8950, dev: "A", kind: "sync", scan: false },
            { t: 10664, dev: "B", kind: "join" },
            { t: 13243, dev: "C", kind: "join" },
            { t: 18209, dev: "A", kind: "rename", pick: 0, to: "archive/A-r12.md" },
            { t: 20780, dev: "A", kind: "edit", pick: 0, line: "A", value: "A13" },
            { t: 23362, dev: "C", kind: "edit", pick: 0, line: "C", value: "C14" },
        ],
        expect: ["LOST_UPDATE", "NOT_IDLE"],
    },
    {
        title: "a binary edited on ONE device produces conflict copies on every other device",
        symptom: "Images/PDFs get '(Conflict ...)' copies although nobody else touched them; copies are never synced",
        config: {
            seed: 13,
            fs: ["linux", "windows", "macos"],
            windowsLineEndings: true,
            binaryRate: 0.25,
        },
        plan: [
            { t: 0, dev: "A", kind: "join" },
            { t: 4581, dev: "B", kind: "join" },
            { t: 5987, dev: "C", kind: "join" },
            { t: 6829, dev: "C", kind: "create", fid: "f1", path: "assets/C-1.png", binary: true },
            { t: 10222, dev: "C", kind: "editBinary", pick: 0, version: 7 },
        ],
        expect: ["FALSE_CONFLICT", "DIVERGED"],
    },
];

/** Former bugs that must stay fixed (move cases here when fixing them) */
const FIXED_REGRESSIONS: Case[] = [];

function configOf(c: Case, name: string): SimConfig {
    return { ...DEFAULT_CONFIG, seed: 1, ...c.config, name } as SimConfig;
}

describe("known multi-device bugs (assert they still reproduce)", () => {
    KNOWN_BUGS.forEach((c, i) => {
        it(`${c.title}`, async () => {
            const result = await runSimulation(configOf(c, `known-${i + 1}`), c.plan);
            const kinds = result.failures.map((f) => f.kind);
            for (const k of c.expect) {
                expect(
                    kinds,
                    `Known bug no longer reproduces (${k} missing) — if you fixed it, move this case to FIXED_REGRESSIONS.\n` +
                        `Symptom: ${c.symptom}\nCurrent result: ${JSON.stringify(result.failures, null, 2)}`,
                ).toContain(k);
            }
        });
    });
});

describe("fixed multi-device bugs (must stay clean)", () => {
    FIXED_REGRESSIONS.forEach((c, i) => {
        it(c.title, async () => {
            const result = await runSimulation(configOf(c, `fixed-${i + 1}`), c.plan);
            if (!result.ok) expect.fail(formatFailure(result));
        });
    });
    it("placeholder so the suite is never empty", () => {
        expect(FIXED_REGRESSIONS.length).toBeGreaterThanOrEqual(0);
    });
});
