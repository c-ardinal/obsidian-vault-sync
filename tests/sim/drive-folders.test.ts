/**
 * Folder operations between devices, on the real Google Drive adapter.
 *
 * The random multi-device simulation runs on an in-memory cloud keyed by path:
 * it has no folders of its own, so moving a folder there cannot happen and the
 * sync falls back to moving file by file. Drive keeps folders as items with ids:
 * a folder rename is ONE change (the children keep their parent id and are not
 * listed), and two requests that each create a missing folder leave two folders
 * of the same name. Here every device runs the real GoogleDriveAdapter, path
 * resolver and HTTP client against FakeDriveServer, which answers like Drive.
 *
 * @pass_criteria
 * - several uploads into a new folder create that folder once on Drive
 * - a folder renamed on one device: every device ends with the notes under the
 *   new name, contents intact, nothing left under the old name
 * - a note edited on another device while its folder was renamed keeps the edit
 * - a folder deleted on one device: its notes are gone everywhere
 * - known issue (it.fails): empty old folders stay behind on the other device and
 *   come back in the cloud after a folder rename or delete
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { SimDevice } from "./sim-device";
import { Rng } from "./rng";
import { drive } from "./simulation";
import { FakeDriveServer, driveAdapterOnFakeServer } from "../helpers/fake-drive-server";
import type { CloudAdapter } from "../../src/types/adapter";

async function setup() {
    vi.useFakeTimers({
        toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
        now: Date.UTC(2026, 0, 1),
    });
    const rng = new Rng(31);
    vi.spyOn(Math, "random").mockImplementation(() => rng.next());
    const server = new FakeDriveServer();
    const make = async (name: string) => {
        const devRng = rng.fork(name.charCodeAt(0));
        const { adapter } = driveAdapterOnFakeServer(server);
        const dev: SimDevice = new SimDevice({
            name,
            fs: "linux",
            rng: devRng,
            maxEventDelayMs: 0,
            clockSkewMs: 0,
            log: () => {},
            cloudView: () => adapter as unknown as CloudAdapter,
        });
        await dev.init();
        return dev;
    };
    /** One sync after the vault events so far were delivered (like the file watcher) */
    const sync = async (dev: SimDevice, scan = false) => {
        await vi.advanceTimersByTimeAsync(50);
        expect(await drive(dev.startSync("manual-sync", scan), 600_000)).toBe("ok");
        expect(await drive(dev.transfersSettled(), 600_000)).toBe("ok");
    };
    const syncAll = async (devs: SimDevice[], rounds = 2) => {
        for (let i = 0; i < rounds; i++) for (const d of devs) await sync(d);
        for (const d of devs) await sync(d, true);
    };
    /** The vault as Drive has it: user paths, folders end in "/" (duplicates listed twice) */
    const cloud = (): string[] => {
        const items = [...(server as unknown as { items: Map<string, { id: string; name: string; parents: string[]; mimeType: string }> }).items.values()];
        const pathOf = (it: (typeof items)[number]): string => {
            const parent = items.find((x) => x.id === it.parents[0]);
            return parent ? `${pathOf(parent)}/${it.name}` : it.name;
        };
        return items
            .map((it) => pathOf(it).replace(/^ContractRoot\/ContractVault\/?/, "") + (it.mimeType.endsWith("folder") ? "/" : ""))
            .filter((p) => p && p !== "/" && !p.startsWith(".obsidian") && !p.startsWith("ContractRoot"))
            .sort();
    };
    const cloudFiles = () => cloud().filter((p) => !p.endsWith("/"));
    const files = (d: SimDevice) => d.userFiles();
    const folders = (d: SimDevice): string[] =>
        [...(d.vaultAdapter as unknown as { folders: Set<string> }).folders].filter((f) => !f.startsWith(".obsidian")).sort();
    return { make, sync, syncAll, cloud, cloudFiles, files, folders };
}

describe("folders between devices on Drive", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it("creates a new folder once when several files go into it at the same time", async () => {
        const { make, sync, cloud } = await setup();
        const a = await make("A");
        await a.userCreate("Projects/one.md", "one");
        await a.userCreate("Projects/sub/two.md", "two");
        await a.userCreate("Projects/sub/three.md", "three");
        await sync(a);
        expect(cloud()).toEqual([
            "Projects/",
            "Projects/one.md",
            "Projects/sub/",
            "Projects/sub/three.md",
            "Projects/sub/two.md",
        ]);
    });

    it("follows a folder rename on every device, contents intact", async () => {
        const { make, sync, syncAll, cloudFiles, files } = await setup();
        const a = await make("A");
        const b = await make("B");
        await a.userCreate("Projects/one.md", "one");
        await sync(a);
        await a.userCreate("Projects/sub/two.md", "two");
        await sync(a);
        await sync(b);
        expect(await a.userRenameFolder("Projects", "Work")).toBe(true);
        await syncAll([a, b]);

        const expected = { "Work/one.md": "one", "Work/sub/two.md": "two" };
        expect(cloudFiles()).toEqual(Object.keys(expected));
        expect(files(a)).toEqual(expected);
        expect(files(b)).toEqual(expected);
    });

    it("keeps an edit made on another device while the folder was renamed", async () => {
        const { make, sync, syncAll, cloudFiles, files } = await setup();
        const a = await make("A");
        const b = await make("B");
        await a.userCreate("Projects/one.md", "one\n");
        await sync(a);
        await sync(b);
        expect(await a.userRenameFolder("Projects", "Work")).toBe(true);
        await b.userEdit("Projects/one.md", "one\nedited on B\n");
        await syncAll([a, b], 3);

        const expected = { "Work/one.md": "one\nedited on B\n" };
        expect(cloudFiles()).toEqual(Object.keys(expected));
        expect(files(a)).toEqual(expected);
        expect(files(b)).toEqual(expected);
    });

    it("deletes a folder's notes on every device", async () => {
        const { make, sync, syncAll, cloudFiles, files } = await setup();
        const a = await make("A");
        const b = await make("B");
        await a.userCreate("Old/one.md", "one");
        await sync(a);
        await a.userCreate("Old/sub/two.md", "two");
        await a.userCreate("Keep.md", "keep");
        await sync(a);
        await sync(b);
        await a.ops.rmdir("Old", true);
        await syncAll([a, b]);

        expect(cloudFiles()).toEqual(["Keep.md"]);
        expect(files(a)).toEqual({ "Keep.md": "keep" });
        expect(files(b)).toEqual({ "Keep.md": "keep" });
    });

    // Known issue: the other device keeps the old folders (empty) and its next push
    // creates them in the cloud again, so a renamed or deleted folder comes back
    // empty there and on devices set up later. Passes (and must be turned into a
    // normal test) once fixed.
    it.fails("leaves no empty old folder behind after a folder rename or delete", async () => {
        const { make, sync, syncAll, cloud, folders } = await setup();
        const a = await make("A");
        const b = await make("B");
        await a.userCreate("Projects/one.md", "one");
        await a.userCreate("Old/two.md", "two");
        await sync(a);
        await sync(b);
        expect(await a.userRenameFolder("Projects", "Work")).toBe(true);
        await a.ops.rmdir("Old", true);
        await syncAll([a, b]);

        expect(cloud()).toEqual(["Work/", "Work/one.md"]);
        expect(folders(b)).toEqual(["Work"]);
    });
});
