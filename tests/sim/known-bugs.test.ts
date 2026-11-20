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
/** Same settings as the restart scenario in multi-device.sim.test.ts */
const RESTART: Partial<SimConfig> = {
    profile: "disjoint",
    devices: 3,
    actions: 50,
    binaryRate: 0.25,
    restartRate: 0.08,
    settings: { largeFileThresholdMB: 0.0001 },
    network: { minLatencyMs: 20, maxLatencyMs: 1500, failureRate: 0.03, lostResponseRate: 0.3 },
    offlineRate: 0.03,
};
/** Same settings as the large-files scenario in multi-device.sim.test.ts */
const LARGE: Partial<SimConfig> = {
    profile: "disjoint",
    devices: 3,
    actions: 45,
    binaryRate: 0.3,
    settings: { largeFileThresholdMB: 0.0001 },
    network: { minLatencyMs: 20, maxLatencyMs: 1500, failureRate: 0.04, lostResponseRate: 0.3 },
    offlineRate: 0.03,
};
const CROSS_OS: Partial<SimConfig> = {
    profile: "disjoint",
    devices: 3,
    actions: 45,
    fs: ["linux", "windows", "macos"],
    windowsLineEndings: true,
    binaryRate: 0.25,
};

const NON_MD5: Partial<SimConfig> = {
    profile: "disjoint",
    devices: 3,
    actions: 45,
    foreignHash: true,
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
    {
        title: "two devices uploading the same note at the same moment: the overwritten edit is merged back",
        symptom: "An edit made on one device disappears when another device saves the same note at the same time",
        config: { seed: 278, ...CLEAN, maxEventDelayMs: 0 },
        expect: [],
    },
    {
        title: "an overwritten edit is repaired after the device that is merging the note finishes",
        symptom: "An edit vanishes when the note was being merged elsewhere while it was overwritten",
        config: { seed: 102, ...CROSS_OS },
        expect: [],
    },
    {
        title: "E2EE: an overwritten edit is repaired once the note's merge lock is free",
        symptom: "With E2EE, an edit vanishes after two devices saved the note at the same time",
        config: { seed: 164, ...E2EE },
        expect: [],
    },
    {
        title: "a note renamed right after its upload was overwritten merges with the repaired version",
        symptom: "A conflict copy appears for a renamed note whose edits were made on different lines",
        config: { seed: 269, ...E2EE },
        expect: [],
    },
    {
        title: "a version built on our lost-response upload merges from that upload",
        symptom: "A conflict copy appears after a network error, although the edits were on different lines",
        config: { seed: 136, ...FLAKY },
        expect: [],
    },
    {
        title: "the overwrite repair merges again when the user types during it",
        symptom: "An edit typed while another device's overwritten edit was being restored is lost",
        config: { seed: 276, ...CLEAN },
        expect: [],
    },
    {
        title: "lines both devices appended near the same spot keep the note's other lines",
        symptom: "A note loses its first line after two devices appended lines at the same time",
        config: { seed: 217, ...CHAOS },
        expect: [],
    },
    {
        title: "a merged upload made while breaking a push deadlock is checked for overwrites too",
        symptom: "An edit vanishes when a device uploads its merge result right after another device saved",
        config: { seed: 354, ...CLEAN },
        expect: [],
    },
    {
        title: "E2EE: a new note whose upload response was lost, then edited, merges from that upload",
        symptom: "With E2EE, edits to a just-created note end up in a conflict copy after a network error",
        config: { seed: 330, ...E2EE },
        expect: [],
    },
    {
        title: "E2EE: a pull records the version it actually downloaded",
        symptom: "With E2EE, a note pulled while it was being saved elsewhere later gets a conflict copy",
        config: { seed: 393, ...E2EE },
        expect: [],
    },
    {
        title: "E2EE: an edit whose upload response was lost is the merge base",
        symptom: "With E2EE, an edit is lost after a network error and a merge on another device",
        config: { seed: 396, ...E2EE },
        expect: [],
    },
    {
        title: "an overwrite check whose history read failed is retried",
        symptom: "After a network error, an edit overwritten by a simultaneous save on another device is lost",
        config: { seed: 306, ...E2EE },
        expect: [],
    },
    {
        title: "E2EE: a remote version that is our own lost-response upload is adopted, not merged",
        symptom: "With E2EE, an edit made after a network error ends up in a conflict copy",
        config: { seed: 438, ...E2EE },
        expect: [],
    },
    {
        title: "restart: a pulled note whose index entry was lost is the base, not a conflict",
        symptom: "After the app is closed mid-sync, an untouched note comes back as a conflict copy",
        config: { seed: 135, ...RESTART },
        expect: [],
    },
    {
        title: "restart: a background upload that finished after the app was closed is recognised",
        symptom: "An attachment stays 'not synced' forever after the app is closed during its upload",
        config: { seed: 143, ...RESTART },
        expect: [],
    },
    {
        title: "restart: a rename made before the app was closed is not lost",
        symptom: "A renamed note exists twice (old and new name) on every device",
        config: { seed: 258, ...RESTART },
        expect: [],
    },
    {
        title: "restart: renaming a note whose upload result was lost moves the cloud copy",
        symptom: "After a lost upload and a restart, renaming the note leaves a copy under the old name",
        config: { seed: 278, ...RESTART },
        expect: [],
    },
    {
        title: "restart: a lost background upload of a file renamed before the retry is moved, not orphaned",
        symptom: "A stray copy of an attachment under its old name stays in the cloud and on no device",
        config: { seed: 306, ...RESTART },
        expect: [],
    },
    {
        title: "restart: files still being pulled are listed in the uploaded index",
        symptom: "A device that joins later never receives a file another device was still downloading",
        config: { seed: 333, ...RESTART },
        expect: [],
    },
    {
        title: "restart: index entries changed between batched writes survive (journal)",
        symptom: "A note pulled and then edited around a restart becomes a conflict copy",
        config: { seed: 356, ...RESTART },
        expect: [],
    },
    {
        title: "restart: a merge result not pushed before the app was closed is pushed after the restart",
        symptom: "Another device's edit merged here never reaches the cloud",
        config: { seed: 393, ...RESTART },
        expect: [],
    },
    // Found by the 2026-11-20 test audit (3,000 random runs)
    {
        title: "a failed index upload is retried, and a merge-read failure does not upload a partial index",
        symptom: "A device that joins later never receives a note another device pushed",
        config: { seed: 5016, ...CHAOS },
        expect: [],
    },
    {
        title: "an edit typed while a merge result was being written is pushed",
        symptom: "The last edit to a note stays on one device and never reaches the others",
        config: { seed: 10089, ...CROSS_OS },
        expect: [],
    },
    {
        title: "an edit saved just before another device's rename arrived is pushed under the new name",
        symptom: "The last edit to a renamed note stays on one device and never reaches the others",
        config: { seed: 10171, ...CROSS_OS },
        expect: [],
    },
    {
        title: "non-MD5 cloud: a download is not recorded under a newer version's hash",
        symptom: "Two devices show different text for the same note, and both think they are in sync",
        config: { seed: 10297, ...NON_MD5 },
        expect: [],
    },
    {
        title: "restart: a repair owed for an overwritten version survives a restart",
        symptom: "An edit made at the same moment as another device's edit disappears from the note",
        config: { seed: 10064, ...RESTART },
        expect: [],
    },
    {
        title: "restart: a large file whose cloud copy changed is not bounced between sync and the background queue",
        symptom: "An attachment never finishes syncing and the other devices never get it",
        config: { seed: 10184, ...RESTART },
        expect: [],
    },
    // Found by the 2026-11-20 runs toward 0 failures in 10,000 (seeds 30000-30999, 40000-40999)
    {
        title: "an older-base merge keeps the lines this device added",
        symptom: "A line just typed into a note disappears after a merge with another device's edit",
        config: { seed: 30524, ...CHAOS },
        expect: [],
    },
    {
        title: "a collision rename made by the sync is not taken for a user rename",
        symptom: "A note vanishes after two devices create notes whose names differ only in letter case",
        config: { seed: 30045, ...CHAOS },
        expect: [],
    },
    {
        title: "E2EE: our lost upload of a note renamed during the download is moved, not pulled back",
        symptom: "A renamed note exists twice, under its old and new name",
        config: { seed: 30514, ...E2EE },
        expect: [],
    },
    {
        title: "E2EE: a merge does not guess the base when the stored hash cannot be read",
        symptom: "An edit disappears after a merge on an encrypted vault",
        config: { seed: 30744, ...E2EE },
        expect: [],
    },
    {
        title: "a merged upload keeps its hash on a note renamed during the upload",
        symptom: "A conflict copy appears for edits made on different lines",
        config: { seed: 40358, ...CLEAN },
        expect: [],
    },
    {
        title: "files only an overwritten shared index listed are pulled",
        symptom: "A note created on one device never reaches the others",
        config: { seed: 40889, ...FLAKY },
        expect: [],
    },
    {
        title: "a note that took a name during a conflict is not overwritten by the cloud version",
        symptom: "A renamed note's text is replaced by another note's text",
        config: { seed: 40924, ...CHAOS },
        expect: [],
    },
    {
        title: "E2EE: a merge waits when the revision history is unreachable",
        symptom: "A conflict copy appears for edits made on different lines",
        config: { seed: 40501, ...E2EE },
        expect: [],
    },
    {
        title: "our lost upload, edited by another device and renamed here twice, is adopted and merged",
        symptom: "A renamed note exists twice, under its first and its last name",
        config: { seed: 40247, ...LARGE },
        expect: [],
    },
    {
        title: "restart: a late-found upload of ours is checked for an overwrite",
        symptom: "An edit made at the same moment as another device's edit disappears from the note",
        config: { seed: 40165, ...RESTART },
        expect: [],
    },
    {
        title: "restart: new files a scan held back are uploaded later",
        symptom: "A note created just before the app was closed never reaches the other devices",
        config: { seed: 40207, ...RESTART },
        expect: [],
    },
    {
        title: "a remote deletion does not remove a file that took the deleted file's name",
        symptom: "A note pulled from another device disappears again on one device",
        config: { seed: 40536, ...CHAOS },
        expect: [],
    },
    {
        title: "delete and re-create under another letter case on Windows/macOS is a rename",
        symptom: "The note keeps its old name in the cloud and on the other devices",
        config: { seed: 40245, ...CHAOS },
        expect: [],
    },
    {
        title: "a remote index listing one file under two names is resolved against the cloud",
        symptom: "A device joining later gets the wrong text under one name and misses another note",
        config: { seed: 40952, ...CHAOS },
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
