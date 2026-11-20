/**
 * Files one device leaves out (deviceExclusionPatterns), on the real
 * SyncManager: the cloud keeps them for the other devices, deleting them on
 * the device that leaves them out does not delete them in the cloud, and they
 * come back when the pattern is taken off.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { SimCloud } from "./sim-cloud";
import { SimDevice } from "./sim-device";
import { Rng } from "./rng";
import { drive } from "./simulation";

const NET = { minLatencyMs: 1, maxLatencyMs: 5, failureRate: 0, lostResponseRate: 0 };

function setup() {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"], now: Date.UTC(2026, 0, 1) });
    const rng = new Rng(23);
    vi.spyOn(Math, "random").mockImplementation(() => rng.next());
    const cloud = new SimCloud();
    const make = (name: string, deviceExclusionPatterns = "") => {
        const devRng = rng.fork(name.charCodeAt(0));
        return new SimDevice({
            name,
            rng: devRng,
            maxEventDelayMs: 0,
            clockSkewMs: 0,
            log: (n: string, m: string) => {
                if (process.env.SIM_LOG) console.log(n, m);
            },
            settings: { deviceExclusionPatterns },
            cloudView: (d) => cloud.createDeviceView(name, devRng.fork(7), () => NET, () => d.online),
        });
    };
    const sync = async (dev: SimDevice) => {
        expect(await drive(dev.startSync("manual-sync", true), 600_000)).toBe("ok");
        expect(await drive(dev.transfersSettled(), 600_000)).toBe("ok");
        expect(dev.syncErrors).toEqual([]);
    };
    const run = async <T>(p: Promise<T>): Promise<T> => {
        let value: T | undefined;
        expect(await drive(p.then((v) => (value = v)), 600_000)).toBe("ok");
        return value as T;
    };
    const setPatterns = (dev: SimDevice, patterns: string) => {
        (dev.ctx.settings as { deviceExclusionPatterns: string }).deviceExclusionPatterns = patterns;
    };
    /** The user deletes a whole folder (one folder event, like Obsidian) */
    const deleteFolder = async (dev: SimDevice, path: string) => {
        await dev.ops.rmdir(path, true);
    };
    return { make, sync, run, setPatterns, deleteFolder };
}

describe("files left out on one device", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it("are not downloaded there and keep syncing between the other devices", async () => {
        const { make, sync } = setup();
        const a = make("A");
        await a.init();
        await a.userCreate("Big/x.md", "x1");
        await a.userCreate("Notes/n.md", "n1");
        await sync(a);

        const b = make("B", "Big/**");
        await b.init();
        await sync(b);
        expect(b.userFiles()).toEqual({ "Notes/n.md": "n1" });

        await a.userEdit("Big/x.md", "x2");
        await sync(a);
        await sync(b);
        expect(b.read("Big/x.md")).toBeNull();

        // A third device without the pattern gets everything
        const c = make("C");
        await c.init();
        await sync(c);
        expect(c.userFiles()).toEqual({ "Big/x.md": "x2", "Notes/n.md": "n1" });
    });

    it("are not deleted in the cloud when deleted there, even with their parent folder", async () => {
        const { make, sync, setPatterns, deleteFolder } = setup();
        const a = make("A");
        await a.init();
        await a.userCreate("Big/x.md", "x");
        await a.userCreate("Notes/big/y.md", "y");
        await a.userCreate("Notes/n.md", "n");
        await sync(a);

        const b = make("B");
        await b.init();
        await sync(b);
        expect(Object.keys(b.userFiles()).sort()).toEqual(["Big/x.md", "Notes/big/y.md", "Notes/n.md"]);

        // B starts leaving them out, then frees the space
        setPatterns(b, "Big/**\nNotes/big/**");
        await deleteFolder(b, "Big");
        await deleteFolder(b, "Notes");
        await sync(b);
        await sync(a);
        // Notes/n.md was synced by B: its deletion reaches A. The rest stays.
        expect(a.userFiles()).toEqual({ "Big/x.md": "x", "Notes/big/y.md": "y" });
    });

    it("come back when the pattern is taken off", async () => {
        const { make, sync, run, setPatterns, deleteFolder } = setup();
        const a = make("A");
        await a.init();
        await a.userCreate("Big/x.md", "x1");
        await a.userCreate("Big/old.md", "old");
        await sync(a);

        const b = make("B");
        await b.init();
        await sync(b);
        setPatterns(b, "Big/**");
        await deleteFolder(b, "Big");
        await sync(b);

        // Meanwhile on A: one edited, one deleted, one added
        await a.userEdit("Big/x.md", "x2");
        await a.userDelete("Big/old.md");
        await a.userCreate("Big/new.md", "new");
        await sync(a);
        await sync(b); // B uploads its index: must not undo A's changes in it
        await sync(a);
        expect(a.userFiles()).toEqual({ "Big/new.md": "new", "Big/x.md": "x2" });

        setPatterns(b, "");
        await run(b.sm.applyDeviceScopeChange("Big/**"));
        await sync(b);
        expect(b.userFiles()).toEqual({ "Big/new.md": "new", "Big/x.md": "x2" });

        const c = make("C");
        await c.init();
        await sync(c);
        expect(c.userFiles()).toEqual({ "Big/new.md": "new", "Big/x.md": "x2" });
    });
});
