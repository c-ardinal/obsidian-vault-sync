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
/** Same settings as the clean-network scenario in multi-device.sim.test.ts */
const CLEAN: Partial<SimConfig> = { profile: "disjoint", devices: 3, actions: 40, network: NET };
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

/** Same settings as the chaos / cross-os scenarios in multi-device.sim.test.ts */
const CHAOS: Partial<SimConfig> = {
    profile: "chaos",
    devices: 4,
    actions: 60,
    fs: ["linux", "windows", "macos", "linux"],
    windowsLineEndings: true,
    binaryRate: 0.15,
    network: { minLatencyMs: 5, maxLatencyMs: 1500, failureRate: 0.03, lostResponseRate: 0.3 },
    offlineRate: 0.04,
    maxClockSkewMs: 120_000,
};
const CROSS_OS: Partial<SimConfig> = {
    profile: "disjoint",
    devices: 3,
    actions: 45,
    fs: ["linux", "windows", "macos"],
    windowsLineEndings: true,
    binaryRate: 0.25,
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
    {
        title: "two notes whose names differ only in case / Unicode form both survive on macOS and Windows",
        symptom: "'projects/café.md' and 'Projects/café.md' from two Linux devices: one overwrites the other on a Mac",
        config: { seed: 216, ...CHAOS },
        expect: [],
    },
    {
        title: "every device renames the same note of a colliding pair",
        symptom: "Both colliding notes get renamed to '(2)' on different devices, collide again and one is lost",
        config: { seed: 116, ...CHAOS },
        expect: [],
    },
    {
        title: "a note created while a pull of the same name is downloading is not overwritten",
        symptom: "Create a note (or attachment) right as another device's file with that name syncs in: yours vanishes",
        config: { seed: 225, ...CHAOS },
        expect: [],
    },
    {
        title: "an edit to a note renamed on another device follows the rename instead of being stranded",
        symptom: "A note edited on one device while renamed on another stays forever under its old name",
        config: { seed: 137, ...CROSS_OS },
        expect: [],
    },
    {
        title: "a note created on macOS is uploaded once, not under both its NFC and NFD names",
        symptom: "'café.md' made on a Mac shows up twice on other devices",
        config: { seed: 113, ...CHAOS },
        expect: [],
    },
    {
        title: "two devices creating the same note name at once keep two notes instead of merging them",
        symptom: "Lines of one note replaced by another note's lines (e.g. the first line vanished)",
        config: { seed: 206, ...CHAOS },
        expect: [],
    },
    {
        title: "same-name creates on two devices: neither upload overwrites the other",
        symptom: "A brand-new note disappears right after another device creates one with the same name",
        config: { seed: 192, ...CHAOS },
        expect: [],
    },
    {
        title: "a late vault event for a rename the sync engine made is not taken for a user rename",
        symptom: "After a name-collision rename, a different note was moved in the cloud and lost",
        config: { seed: 202, ...CHAOS },
        expect: [],
    },
    {
        title: "a note indexed under an old name (from a lagging index) does not stay as a stale copy",
        symptom: "A renamed note also stays under its old name on a newly synced device",
        config: { seed: 170, ...CHAOS },
        expect: [],
    },
    {
        title: "chaos run that used to lose a note (name collisions + renames + lost responses) stays clean",
        symptom: "A note disappeared from every device",
        config: { seed: 141, ...CHAOS },
        expect: [],
    },
    {
        title: "an edit typed while a merged upload is in flight is not dropped",
        symptom: "Text typed during 'merging' disappears after the sync",
        config: { seed: 233, ...CLEAN, maxEventDelayMs: 0 },
        expect: [],
    },
    {
        title: "a first sync from a lagging remote index still follows renames made just before",
        symptom: "A new device keeps a note under its old name forever",
        config: { seed: 264, ...CLEAN },
        expect: [],
    },
    {
        title: "E2EE: a first sync from a lagging index records the version it really downloaded",
        symptom: "With E2EE, a note pulled on a new device later gets a conflict copy and loses an edit",
        config: { seed: 112, ...E2EE },
        expect: [],
    },
    {
        title: "E2EE: a retried pull does not trust a lagging index's plaintext hash",
        symptom: "After a network error, another device's edit is never pulled (the note stays different)",
        config: { seed: 174, ...E2EE },
        expect: [],
    },
    {
        title: "a note renamed just before a sync starts is moved, not deleted, in the cloud",
        symptom: "Rename a note right as a sync starts: other devices keep it under the old name too",
        config: { seed: 274, ...E2EE },
        expect: [],
    },
    {
        title: "a lost-response upload of a note renamed before it synced is moved to the new name",
        symptom: "On a flaky network, a new note renamed right away exists twice on every device",
        config: { seed: 193, ...FLAKY },
        expect: [],
    },
    {
        title: "a merge lock whose release failed on the network is released on the next sync",
        symptom: "After a network hiccup, every other device keeps 'waiting for merge' on a note for a minute",
        config: { seed: 185, ...CHAOS },
        expect: [],
    },
    {
        title: "a note renamed then deleted here, but renamed and edited on another device, comes back",
        symptom: "A note edited on another device never arrives here (another note took its old name)",
        config: { seed: 131, ...CHAOS },
        expect: [],
    },
    {
        title: "a lost upload request is not taken as the base of another device's same-name note",
        symptom: "A new note is replaced by another device's note with the same name",
        config: { seed: 268, ...CHAOS },
        expect: [],
    },
    {
        title: "E2EE: our own upload whose response was lost is not a conflict with itself",
        symptom: "With E2EE on a flaky network, images get '(Conflict ...)' copies nobody caused",
        config: { seed: 131, ...E2EE },
        expect: [],
    },
    {
        title: "E2EE: an edited file whose upload response was lost is recognised as ours",
        symptom: "With E2EE, an edited image gets a conflict copy after a network error",
        config: { seed: 198, ...E2EE },
        expect: [],
    },
    {
        title: "a new note whose upload response was lost, then edited on several devices, merges",
        symptom: "Edits made offline to a just-created note end up in a conflict copy",
        config: { seed: 152, ...FLAKY },
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
