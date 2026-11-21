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
        title: "a note created from the same template is not taken as a deleted note's lost rename",
        seed: 160,
        levels: {
            conflict: "force-remote", exclusion: "same-on-all", "device-list": "changed-mid-run", deletes: "deletes",
            encryption: "e2ee", concurrency: "1", "cloud-trash": "remove-at-once", network: "flaky",
            devices: "mixed-os", "app-restarts": "restarts",
        },
    },
    {
        title: "a move not uploaded yet whose new folder is then left out: the cloud file stays listed",
        seed: 295,
        levels: {
            conflict: "changed-mid-run", "device-list": "changed-mid-run", "settings-sync": "per-device",
            deletes: "deletes+confirm", "large-files": "background-throttled", encryption: "e2ee", concurrency: "5",
            "cloud-trash": "remove-at-once", "sync-frequency": "near-realtime", network: "flaky",
        },
    },
    {
        title: "force-remote: two devices repairing the same overwrite at once end up with the same version",
        seed: 322,
        levels: {
            conflict: "force-remote", images: "changed-mid-run", "settings-sync": "per-device", concurrency: "2",
            "large-files": "background-throttled", encryption: "non-md5-cloud", "keep-revisions": "daily",
            "sync-frequency": "near-realtime", devices: "mixed-os", "app-restarts": "restarts",
        },
    },
    {
        title: "images turned on again: a file listed only by an index ours replaced is still pulled",
        seed: 426,
        levels: {
            conflict: "changed-mid-run", exclusion: "one-device-only", images: "changed-mid-run",
            "large-files": "background", encryption: "non-md5-cloud", "keep-revisions": "daily",
            "sync-frequency": "near-realtime",
        },
    },
    {
        title: "always-fork: two conflict copies made in the same second do not overwrite each other",
        seed: 418,
        levels: {
            conflict: "always-fork", images: "off-on-one-device", "device-list": "one-device", encryption: "e2ee",
            concurrency: "2", network: "flaky", devices: "mixed-os", "app-restarts": "restarts",
        },
    },
    {
        title: "left out again before the comparison ran: changes skipped meanwhile still arrive",
        seed: 134,
        levels: { exclusion: "changed-mid-run" },
    },
    {
        title: "a move not uploaded yet whose new folder is then excluded: the note comes back under its synced name",
        seed: 581,
        levels: {
            conflict: "always-fork", exclusion: "changed-mid-run", "device-list": "one-device", "settings-sync": "per-device",
            "large-files": "background", concurrency: "5", "cloud-trash": "remove-at-once", "keep-revisions": "daily", network: "flaky",
        },
    },
    {
        title: "a note renamed here while its comparison was owed is not taken as moved in the cloud",
        seed: 606,
        levels: {
            exclusion: "changed-mid-run", images: "changed-mid-run", "device-list": "changed-mid-run",
            deletes: "deletes+confirm", "large-files": "background-throttled", concurrency: "5",
            "cloud-trash": "remove-at-once", devices: "mixed-os", "app-restarts": "restarts",
        },
    },
    {
        title: "an edit to a note another device moved out of this device's scope is kept as a new note",
        seed: 693,
        levels: {
            conflict: "changed-mid-run", exclusion: "one-device-only", images: "changed-mid-run",
            "large-files": "background", encryption: "non-md5-cloud", "keep-revisions": "daily",
            "sync-frequency": "near-realtime",
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

/**
 * Still reproducing, kept here so a fix shows up (the test then fails: move
 * the case to PINNED).
 */
const KNOWN: { title: string; seed: number; levels: Record<string, string>; expect: string }[] = [
    {
        // A moves a note out of its sync scope (= deleted in the cloud) while B uploads
        // an edit of it. A checks the cloud version right before deleting, but B's
        // upload lands between that check and the delete (no conditional delete in the
        // cloud APIs). With the cloud trash on (default 30 days) the edit stays there.
        title: "a delete racing another device's upload within the network latency removes that edit",
        seed: 175,
        levels: {
            conflict: "always-fork", exclusion: "same-on-all", images: "off-on-one-device", "settings-sync": "per-device",
            deletes: "deletes", "large-files": "background-throttled", encryption: "e2ee", concurrency: "5",
            "cloud-trash": "remove-at-once", "sync-frequency": "near-realtime", devices: "mixed-os",
        },
        expect: "LOST_UPDATE",
    },
    {
        // An upload whose response was lost created the note under a name the user
        // had just renamed away from; the uploading device removes that stray file, but
        // another device had pulled and edited it meanwhile. Edit beats deletion: two
        // files with the same note, nothing lost.
        title: "a stray upload edited elsewhere before its removal stays as a second file",
        seed: 438,
        levels: {
            conflict: "force-remote", images: "changed-mid-run", "settings-sync": "per-device", concurrency: "2",
            "large-files": "background-throttled", encryption: "non-md5-cloud", "keep-revisions": "daily",
            "sync-frequency": "near-realtime", devices: "mixed-os", "app-restarts": "restarts",
        },
        expect: "DUPLICATE",
    },
    {
        // One device set to "keep local" uploads its older content over a newer edit
        // (as chosen). That content equals what the other device had before its edit,
        // so the other device takes the change for a late echo of the old version and
        // keeps its edit locally: the two differ until either edits the note again.
        title: "force-local reverting a note to its previous content is taken for a stale echo elsewhere",
        seed: 594,
        levels: {
            conflict: "mixed", images: "off-on-one-device", "settings-sync": "per-device", deletes: "deletes",
            "cloud-trash": "remove-at-once", "keep-revisions": "daily", network: "flaky",
        },
        expect: "DIVERGED",
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

if (!ONLY_COMBO) {
    describe("settings combinations: known residual failures", () => {
        it.each(KNOWN)("$title", async ({ seed, levels, expect: kind }) => {
            const result = await runSimulation({ ...combinationOf("known", levels).scenario, seed });
            expect(
                result.failures.map((f) => f.kind),
                "No longer reproduces: if fixed, move this case to PINNED",
            ).toContain(kind);
        });
    });
}
