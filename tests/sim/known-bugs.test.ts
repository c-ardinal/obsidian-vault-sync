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
    /** Omit to replay the full plan generated from config.seed */
    plan?: Action[];
    /** Failure kinds that prove the bug is present */
    expect: string[];
    /** Fixed cases only: upper bound on 3-way merges in the whole run (catches needless merges) */
    maxMerges?: number;
}

const NET = { minLatencyMs: 5, maxLatencyMs: 400, failureRate: 0, lostResponseRate: 0 };
/** Same settings as the flaky-network / e2ee scenarios in multi-device.sim.test.ts */
const FLAKY: Partial<SimConfig> = {
    profile: "disjoint",
    devices: 3,
    actions: 50,
    network: { minLatencyMs: 20, maxLatencyMs: 2000, failureRate: 0.05, lostResponseRate: 0.3 },
    offlineRate: 0.05,
    maxClockSkewMs: 120_000,
};
const E2EE: Partial<SimConfig> = {
    profile: "disjoint",
    devices: 3,
    actions: 45,
    e2ee: true,
    fs: ["linux", "windows", "macos"],
    windowsLineEndings: true,
    binaryRate: 0.2,
    network: { minLatencyMs: 5, maxLatencyMs: 800, failureRate: 0.02, lostResponseRate: 0.15 },
};

const KNOWN_BUGS: Case[] = [
    // Empty: every bug found so far is fixed and lives in FIXED_REGRESSIONS.
];

/** Former bugs that must stay fixed (move cases here when fixing them) */
const FIXED_REGRESSIONS: Case[] = [
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
        expect: [],
    },
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
        expect: [],
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
        expect: [],
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
        expect: [],
    },
    {
        title: "CRLF + BOM note edited on two devices: one merge, no conflict copy",
        symptom: "Notes written by Windows editors got conflict copies / needless merges on every pull",
        config: { seed: 1, devices: 2, fs: ["windows", "linux"], windowsLineEndings: true },
        plan: [
            { t: 0, dev: "A", kind: "join" },
            { t: 0, dev: "B", kind: "join" },
            { t: 1000, dev: "A", kind: "create", fid: "f1", path: "notes/A-1.md" },
            { t: 2000, dev: "A", kind: "sync", scan: false },
            { t: 8000, dev: "B", kind: "sync", scan: false },
            { t: 14000, dev: "A", kind: "edit", pick: 0, line: "A", value: "A1" },
            { t: 14000, dev: "B", kind: "edit", pick: 0, line: "B", value: "B1" },
            { t: 15000, dev: "A", kind: "sync", scan: false },
            { t: 25000, dev: "B", kind: "sync", scan: false },
        ],
        expect: [],
        // Only B (the device that pulls A's concurrent edit) needs to merge; A must just accept.
        maxMerges: 1,
    },
    {
        title: "edits made during a merge, and edits to a note renamed on another device, are kept",
        symptom:
            "A line typed while 'merging' was shown disappeared; a renamed note lost another device's edit",
        // Full clean-network seed 12 run: C types while its merge downloads revisions, and A
        // renames + edits the note C just merged into.
        config: { seed: 12, profile: "disjoint", devices: 3, actions: 40, network: NET },
        expect: [],
    },
    {
        title: "a note renamed while its upload is in flight is not deleted remotely",
        symptom: "Rename a note right after editing it on a slow network: the note vanishes on every device",
        config: { seed: 282, ...FLAKY },
        expect: [],
    },
    {
        title: "a network error while fetching the merge base does not create a conflict copy",
        symptom: "'(Conflict ...)' copies appear for edits on different lines after a network hiccup",
        config: { seed: 6, ...E2EE },
        expect: [],
    },
    {
        title: "E2EE: a file changed by another device mid-sync is not served from a stale download cache",
        symptom: "With E2EE on, another device's edit silently disappears after the next sync",
        config: { seed: 102, ...E2EE },
        expect: [],
    },
    {
        title: "merge locks hold even when the two devices know the note under different paths",
        symptom: "Right after a rename, two devices merge the same note at once and one overwrites the other",
        config: { seed: 255, ...E2EE },
        expect: [],
    },
];

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
    it("placeholder so the suite is never empty", () => {
        expect(KNOWN_BUGS.length).toBeGreaterThanOrEqual(0);
    });
});

describe("fixed multi-device bugs (must stay clean)", () => {
    FIXED_REGRESSIONS.forEach((c, i) => {
        it(c.title, async () => {
            const result = await runSimulation(configOf(c, `fixed-${i + 1}`), c.plan);
            if (!result.ok) expect.fail(formatFailure(result));
            if (c.maxMerges !== undefined) {
                const merges = result.timeline.filter((l) => l.includes("[Merge] Attempting 3-way merge"));
                expect(merges.length, merges.join("\n")).toBeLessThanOrEqual(c.maxMerges);
            }
        });
    });
    it("placeholder so the suite is never empty", () => {
        expect(FIXED_REGRESSIONS.length).toBeGreaterThanOrEqual(0);
    });
});
