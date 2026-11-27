/**
 * An update that changes the plugin ID: every device carries its state over to
 * the new plugin folder and syncs on. The cloud has no index at the new path
 * yet, so the first sync after the update must rebuild it without re-sending,
 * duplicating or losing anything.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { SimCloud } from "./sim-cloud";
import { SimDevice } from "./sim-device";
import { Rng } from "./rng";
import { drive } from "./simulation";
import { PLUGIN_IDS, setPluginDir } from "../../src/sync-manager/file-utils";
import { migrateLegacyPluginData } from "../../src/services/legacy-plugin-migration";

const NET = { minLatencyMs: 1, maxLatencyMs: 5, failureRate: 0, lostResponseRate: 0 };
const dirOf = (id: string) => `.obsidian/plugins/${id}`;
const BEFORE = dirOf(PLUGIN_IDS[1]);
const AFTER = dirOf(PLUGIN_IDS[2]);

describe("plugin ID change", () => {
    afterEach(() => {
        setPluginDir(dirOf(PLUGIN_IDS[0]), ".obsidian");
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it("devices keep syncing after the update, with nothing lost, duplicated or sent again", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"], now: Date.UTC(2026, 0, 1) });
        const rng = new Rng(23);
        vi.spyOn(Math, "random").mockImplementation(() => rng.next());
        setPluginDir(BEFORE, ".obsidian");
        const cloud = new SimCloud();
        const make = async (name: string) => {
            const devRng = rng.fork(name.charCodeAt(0));
            const dev = new SimDevice({
                name,
                rng: devRng,
                maxEventDelayMs: 0,
                clockSkewMs: 0,
                log: () => {},
                cloudView: (d) => cloud.createDeviceView(name, devRng.fork(7), () => NET, () => d.online),
            });
            dev.pluginDir = BEFORE;
            await dev.restart();
            await dev.vaultAdapter.mkdir(".obsidian");
            await dev.vaultAdapter.write(
                `${BEFORE}/data/local/local-index.json`,
                JSON.stringify({ index: {}, deviceId: `dev_${name}` }),
            );
            await dev.sm.loadLocalIndex();
            await dev.sm.loadIndex();
            return dev;
        };
        const sync = async (dev: SimDevice) => {
            expect(await drive(dev.startSync("manual-sync", false), 600_000)).toBe("ok");
            expect(await drive(dev.transfersSettled(), 600_000)).toBe("ok");
        };
        const notes = (dev: SimDevice) => dev.userFiles();

        const a = await make("A");
        await a.userCreate("one.md", "one");
        await a.userCreate("dir/two.md", "two");
        await sync(a);
        const b = await make("B");
        await sync(b);
        await sync(a);
        expect(notes(b)).toEqual({ "one.md": "one", "dir/two.md": "two" });

        // Both devices update: the plugin now lives in a new folder.
        setPluginDir(AFTER, ".obsidian");
        for (const dev of [a, b]) {
            // The mock disk only knows folders made by mkdir: name the parents of every file.
            for (const file of dev.vaultAdapter.listAllFiles().filter((f) => f.startsWith(`${BEFORE}/`))) {
                const parts = file.split("/");
                for (let i = 3; i < parts.length; i++) await dev.vaultAdapter.mkdir(parts.slice(0, i).join("/"));
            }
            const moved = await migrateLegacyPluginData(dev.vaultAdapter as any, AFTER);
            expect(moved?.fromId).toBe(PLUGIN_IDS[1]);
            dev.pluginDir = AFTER;
            await dev.restart();
        }

        const uploadsBefore = cloud.calls.filter((c) => c.method === "uploadFile").length;
        await sync(a);
        await sync(b);
        await sync(a);
        // No note was sent again: only the plugin's own files (index, device records).
        const noteUploads = cloud.calls
            .filter((c) => c.method === "uploadFile")
            .slice(uploadsBefore)
            .map((c) => c.arg)
            .filter((arg) => !arg.includes(".obsidian/"));
        expect(noteUploads).toEqual([]);
        expect(notes(a)).toEqual({ "one.md": "one", "dir/two.md": "two" });
        expect(notes(b)).toEqual(notes(a));

        // Work goes on in both directions.
        await a.userEdit("one.md", "one, edited on A");
        await b.userCreate("three.md", "three");
        await sync(a);
        await sync(b);
        await sync(a);
        const expected = { "one.md": "one, edited on A", "dir/two.md": "two", "three.md": "three" };
        expect(notes(a)).toEqual(expected);
        expect(notes(b)).toEqual(expected);
    });
});
