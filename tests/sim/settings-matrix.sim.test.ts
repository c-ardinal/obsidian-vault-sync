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
    {
        // A deletes a note (here: moves it out of its sync scope) while B uploads an
        // edit of it. A checks the cloud version right before deleting, but B's upload
        // lands in between (no conditional delete in the cloud APIs). A now leaves the
        // version it checked as a deletion mark in the shared index; B sees that the
        // mark is not its upload and uploads its edit again.
        title: "a delete racing another device's upload within the network latency keeps that edit",
        seed: 175,
        levels: {
            conflict: "always-fork", exclusion: "same-on-all", images: "off-on-one-device", "settings-sync": "per-device",
            deletes: "deletes", "large-files": "background-throttled", encryption: "e2ee", concurrency: "5",
            "cloud-trash": "remove-at-once", "sync-frequency": "near-realtime", devices: "mixed-os",
        },
    },
    {
        // An upload whose response was lost created the note under a name the user
        // renamed it away from while the app was closed (no rename event). Another
        // device pulled and edited it meanwhile. The stray file is now moved to the
        // new name (found by its content) instead of being removed.
        title: "a lost upload of a note renamed while the app was closed is moved, not removed",
        seed: 438,
        levels: {
            conflict: "force-remote", images: "changed-mid-run", "settings-sync": "per-device", concurrency: "2",
            "large-files": "background-throttled", encryption: "non-md5-cloud", "keep-revisions": "daily",
            "sync-frequency": "near-realtime", devices: "mixed-os", "app-restarts": "restarts",
        },
    },
    {
        // One device set to "keep local" uploads its older content over a newer edit.
        // The device that made the edit took that change for a late echo of the old
        // version; it now asks the cloud which version is current.
        title: "force-local reverting a note to its previous content reaches the device that edited it",
        seed: 594,
        levels: {
            conflict: "mixed", images: "off-on-one-device", "settings-sync": "per-device", deletes: "deletes",
            "cloud-trash": "remove-at-once", "keep-revisions": "daily", network: "flaky",
        },
    },
    {
        title: "conflict setting changed to force-local mid-run: its revert is not taken for an echo",
        seed: 721,
        levels: {
            conflict: "changed-mid-run", exclusion: "one-device-only", images: "changed-mid-run", "settings-sync": "shared",
            "large-files": "background", encryption: "non-md5-cloud", concurrency: "1", "cloud-trash": "30-days",
            "keep-revisions": "daily", "sync-frequency": "near-realtime",
        },
    },    {
        title: "an index uploaded right after settings synced again keeps the files not pulled yet",
        seed: 866,
        levels: {
            conflict: "always-fork", exclusion: "one-device-only", images: "on",
            "device-list": "changed-mid-run", "settings-sync": "shared", deletes: "deletes+confirm",
            "large-files": "background-throttled", encryption: "non-md5-cloud", concurrency: "5",
            "cloud-trash": "30-days", "keep-revisions": "daily", "sync-frequency": "near-realtime",
            network: "flaky", devices: "linux", "app-restarts": "restarts",
        },
    },
    {
        title: "a move into a folder left out survives an app restart right after the settings change",
        seed: 876,
        levels: {
            conflict: "smart-merge", exclusion: "changed-mid-run", images: "changed-mid-run",
            "device-list": "changed-mid-run", "settings-sync": "shared", deletes: "deletes+confirm",
            "large-files": "background-throttled", encryption: "off", concurrency: "5",
            "cloud-trash": "remove-at-once", "keep-revisions": "off", "sync-frequency": "normal",
            network: "clean", devices: "mixed-os", "app-restarts": "restarts",
        },
    },
    {
        title: "files left out at the first sync and synced again after it are pulled",
        seed: 881,
        levels: {
            conflict: "changed-mid-run", exclusion: "one-device-only", images: "changed-mid-run",
            "device-list": "none", "settings-sync": "shared", deletes: "none", "large-files": "background",
            encryption: "non-md5-cloud", concurrency: "1", "cloud-trash": "30-days", "keep-revisions": "daily",
            "sync-frequency": "near-realtime", network: "clean", devices: "linux", "app-restarts": "none",
        },
    },
    {
        title: "two devices keeping their edits of a note moved out of their scope merge them",
        seed: 820,
        levels: {
            conflict: "smart-merge", exclusion: "changed-mid-run", images: "changed-mid-run",
            "device-list": "changed-mid-run", "settings-sync": "shared", deletes: "deletes+confirm",
            "large-files": "background-throttled", encryption: "off", concurrency: "5",
            "cloud-trash": "remove-at-once", "keep-revisions": "off", "sync-frequency": "normal",
            network: "clean", devices: "mixed-os", "app-restarts": "restarts",
        },
    },
    {
        title: "folders created by a pull are not sent to the cloud again",
        seed: 856,
        levels: {
            conflict: "changed-mid-run", exclusion: "none", images: "on", "device-list": "changed-mid-run",
            "settings-sync": "per-device", deletes: "deletes+confirm", "large-files": "background-throttled",
            encryption: "e2ee", concurrency: "5", "cloud-trash": "remove-at-once", "keep-revisions": "off",
            "sync-frequency": "near-realtime", network: "flaky", devices: "linux", "app-restarts": "none",
        },
    },
    {
        title: "a note renamed away for a same-name pull does not keep that pull's transfer mark",
        seed: 901,
        levels: {
            conflict: "always-fork", exclusion: "same-on-all", images: "off-on-one-device",
            "device-list": "none", "settings-sync": "per-device", deletes: "deletes",
            "large-files": "background-throttled", encryption: "e2ee", concurrency: "5",
            "cloud-trash": "remove-at-once", "keep-revisions": "off", "sync-frequency": "near-realtime",
            network: "clean", devices: "mixed-os", "app-restarts": "none",
        },
    },
    {
        title: "an image renamed out of scope during its background upload is not left in transfer",
        seed: 968,
        levels: {
            conflict: "always-fork", exclusion: "one-device-only", images: "changed-mid-run",
            "device-list": "changed-mid-run", "settings-sync": "shared", deletes: "deletes",
            "large-files": "background-throttled", encryption: "non-md5-cloud", concurrency: "1",
            "cloud-trash": "remove-at-once", "keep-revisions": "off", "sync-frequency": "near-realtime",
            network: "clean", devices: "linux", "app-restarts": "none",
        },
    },
    {
        title: "an index uploaded right after an app restart keeps the files left out here",
        seed: 1070,
        levels: {
            conflict: "force-remote", exclusion: "same-on-all", "device-list": "changed-mid-run", "settings-sync": "shared",
            deletes: "deletes", "large-files": "inline", encryption: "e2ee", concurrency: "1", "cloud-trash": "remove-at-once",
            network: "flaky", devices: "mixed-os", "app-restarts": "restarts",
        },
    },
    {
        title: "a stale record of a lost upload is not taken as the merge base",
        seed: 1125,
        levels: {
            conflict: "smart-merge", images: "off-on-one-device", "device-list": "changed-mid-run", "settings-sync": "per-device",
            "large-files": "background", encryption: "non-md5-cloud", concurrency: "2", "cloud-trash": "remove-at-once",
        },
    },
    {
        title: "a move not pushed before its new folder was left out takes the note out of the sync",
        seed: 1146,
        levels: {
            conflict: "smart-merge", exclusion: "changed-mid-run", images: "changed-mid-run", "device-list": "changed-mid-run",
            "settings-sync": "shared", deletes: "deletes+confirm", "large-files": "background-throttled", concurrency: "5",
            "cloud-trash": "remove-at-once", devices: "mixed-os", "app-restarts": "restarts",
        },
    },
    {
        title: "late landing of a killed run's new-note upload is not kept as a second note",
        seed: 1211,
        levels: {
            conflict: "always-fork", exclusion: "none", images: "off-on-one-device", "device-list": "one-device",
            "settings-sync": "shared", deletes: "none", "large-files": "inline", encryption: "e2ee", concurrency: "2",
            "cloud-trash": "30-days", "keep-revisions": "off", "sync-frequency": "normal", network: "flaky", devices: "mixed-os",
            "app-restarts": "restarts",
        },
    },
    {
        title: "a replaced version merged back by its device is not saved again as a conflict copy",
        seed: 336,
        levels: {
            conflict: "smart-merge", exclusion: "none", images: "on", "device-list": "none", "settings-sync": "shared",
            deletes: "none", "large-files": "inline", encryption: "off", concurrency: "1", "cloud-trash": "30-days",
            "keep-revisions": "off", "sync-frequency": "normal", network: "flaky", devices: "linux", "app-restarts": "none",
        },
    },
    {
        title: "a replaced version merged back is known after a stale index upload of a third device",
        seed: 334,
        levels: {
            conflict: "smart-merge", exclusion: "none", images: "on", "device-list": "none", "settings-sync": "shared",
            deletes: "none", "large-files": "inline", encryption: "off", concurrency: "1", "cloud-trash": "30-days",
            "keep-revisions": "off", "sync-frequency": "near-realtime", network: "clean", devices: "linux", "app-restarts": "none",
        },
    },
    {
        title: "note moved, its folder left out, then deleted there: the late old-name upload goes",
        seed: 1345,
        levels: {
            conflict: "always-fork", exclusion: "one-device-only", images: "on", "device-list": "changed-mid-run",
            "settings-sync": "shared", deletes: "deletes+confirm", "large-files": "background-throttled",
            encryption: "non-md5-cloud", concurrency: "5", "cloud-trash": "30-days", "keep-revisions": "daily",
            "sync-frequency": "near-realtime", network: "flaky", devices: "linux", "app-restarts": "restarts",
        },
    },
    {
        title: "renamed away while a same-name pull is queued: the note is not left in transfer",
        seed: 1423,
        levels: {
            conflict: "always-fork", exclusion: "same-on-all", images: "off-on-one-device", "device-list": "none",
            "settings-sync": "per-device", deletes: "deletes", "large-files": "background-throttled", encryption: "e2ee",
            concurrency: "5", "cloud-trash": "remove-at-once", "keep-revisions": "off", "sync-frequency": "near-realtime",
            network: "clean", devices: "mixed-os", "app-restarts": "none",
        },
    },
    {
        title: "pending own move back from a folder left out is not taken as a move out of the sync",
        seed: 1531,
        levels: {
            conflict: "changed-mid-run", exclusion: "changed-mid-run", images: "off-on-one-device", "device-list": "one-device",
            "settings-sync": "per-device", deletes: "deletes", "large-files": "inline", encryption: "off", concurrency: "5",
            "cloud-trash": "30-days", "keep-revisions": "off", "sync-frequency": "near-realtime", network: "flaky",
            devices: "mixed-os", "app-restarts": "none",
        },
    },
    {
        title: "move into a folder left out later on that PC only: the note leaves the sync",
        seed: 1525,
        levels: {
            conflict: "smart-merge", exclusion: "none", images: "off-on-one-device", "device-list": "changed-mid-run",
            "settings-sync": "per-device", deletes: "none", "large-files": "background", encryption: "non-md5-cloud",
            concurrency: "2", "cloud-trash": "remove-at-once", "keep-revisions": "off", "sync-frequency": "normal",
            network: "clean", devices: "linux", "app-restarts": "none",
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
