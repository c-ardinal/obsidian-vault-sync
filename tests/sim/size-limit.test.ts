/**
 * The file-size limit of one kind of device (PC here), on the real SyncManager:
 * files over it are not downloaded or uploaded there, the cloud keeps them for
 * the other devices, a copy already there is kept, and they sync again once the
 * limit is raised.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { SimCloud } from "./sim-cloud";
import { SimDevice } from "./sim-device";
import { Rng } from "./rng";
import { drive } from "./simulation";

const NET = { minLatencyMs: 1, maxLatencyMs: 5, failureRate: 0, lostResponseRate: 0 };
/** About 100 bytes */
const LIMIT_MB = 0.0001;
const BIG = (tag: string) => `${tag}\n${"x".repeat(400)}`;

function setup() {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"], now: Date.UTC(2026, 0, 1) });
    const rng = new Rng(29);
    vi.spyOn(Math, "random").mockImplementation(() => rng.next());
    const cloud = new SimCloud();
    const make = (name: string, desktopMaxFileSizeMB = -1) => {
        const devRng = rng.fork(name.charCodeAt(0));
        return new SimDevice({
            name,
            rng: devRng,
            maxEventDelayMs: 0,
            clockSkewMs: 0,
            log: (n: string, m: string) => {
                if (process.env.SIM_LOG) console.log(n, m);
            },
            settings: { desktopMaxFileSizeMB },
            cloudView: (d) => cloud.createDeviceView(name, devRng.fork(7), () => NET, () => d.online),
        });
    };
    const sync = async (dev: SimDevice, scan = false) => {
        expect(await drive(dev.startSync("manual-sync", scan), 600_000)).toBe("ok");
        expect(await drive(dev.transfersSettled(), 600_000)).toBe("ok");
        expect(dev.syncErrors).toEqual([]);
    };
    const setLimit = (dev: SimDevice, mb: number) => {
        (dev.ctx.settings as { desktopMaxFileSizeMB: number }).desktopMaxFileSizeMB = mb;
    };
    return { cloud, make, sync, setLimit };
}

describe("file-size limit of one kind of device", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it("does not download larger files there; other devices keep syncing them", async () => {
        const { make, sync } = setup();
        const a = make("A");
        await a.init();
        await a.userCreate("big.md", BIG("v1"));
        await a.userCreate("small.md", "s1");
        await sync(a);

        const b = make("B", LIMIT_MB);
        await b.init();
        await sync(b, true);
        expect(b.userFiles()).toEqual({ "small.md": "s1" });

        await a.userEdit("big.md", BIG("v2"));
        await a.userEdit("small.md", "s2");
        await sync(a);
        await sync(b);
        expect(b.userFiles()).toEqual({ "small.md": "s2" });

        const c = make("C");
        await c.init();
        await sync(c, true);
        expect(c.read("big.md")).toBe(BIG("v2"));
    });

    it("does not upload a larger file made there, and keeps it there", async () => {
        const { make, sync } = setup();
        const b = make("B", LIMIT_MB);
        await b.init();
        await b.userCreate("big.md", BIG("local"));
        await b.userCreate("small.md", "s1");
        await sync(b, true);
        await sync(b);
        expect(b.read("big.md")).toBe(BIG("local"));
        const a = make("A");
        await a.init();
        await sync(a, true);
        expect(a.userFiles()).toEqual({ "small.md": "s1" });
    });

    it("keeps a copy synced before the limit as it is, and never deletes the cloud file", async () => {
        const { make, sync, setLimit } = setup();
        const a = make("A");
        await a.init();
        await a.userCreate("big.md", BIG("v1"));
        await sync(a);
        const b = make("B");
        await b.init();
        await sync(b, true);
        expect(b.read("big.md")).toBe(BIG("v1"));

        setLimit(b, LIMIT_MB);
        await a.userEdit("big.md", BIG("v2"));
        await sync(a);
        await sync(b);
        expect(b.read("big.md")).toBe(BIG("v1"));

        // A full scan on B (as after a settings change) neither deletes nor overwrites it
        await sync(b, true);
        await sync(a);
        expect(a.read("big.md")).toBe(BIG("v2"));
        expect(b.read("big.md")).toBe(BIG("v1"));
    });

    it("syncs the files again once the limit is taken off", async () => {
        const { make, sync, setLimit } = setup();
        const a = make("A");
        await a.init();
        await a.userCreate("big.md", BIG("v1"));
        await sync(a);
        const b = make("B", LIMIT_MB);
        await b.init();
        await b.userCreate("mine.md", BIG("from B"));
        await sync(b, true);
        expect(b.read("big.md")).toBeNull();

        setLimit(b, -1);
        b.sm.triggerFullCleanup();
        await sync(b, true);
        expect(b.read("big.md")).toBe(BIG("v1"));
        await sync(a);
        expect(a.read("mine.md")).toBe(BIG("from B"));
    });

    it("fetches a left-out file on demand; it stays out of sync and the cloud keeps it", async () => {
        const { make, sync } = setup();
        const a = make("A");
        await a.init();
        await a.userCreate("docs/big.md", BIG("v1"));
        await a.userCreate("small.md", "s1");
        await sync(a);
        const b = make("B", LIMIT_MB);
        await b.init();
        await sync(b, true);

        const run = async <T>(p: Promise<T>): Promise<T> => {
            expect(await drive(p, 600_000)).toBe("ok");
            return p;
        };
        const list = await run(b.sm.listCloudOnlyFiles());
        expect(list.map((f) => f.path)).toEqual(["docs/big.md"]);
        await run(b.sm.fetchCloudOnlyFile(list[0]));
        expect(b.read("docs/big.md")).toBe(BIG("v1"));
        expect(await run(b.sm.listCloudOnlyFiles())).toEqual([]);

        // Neither uploaded nor counted as a change, and deleting it here keeps the cloud file
        await sync(b, true);
        await b.userDelete("docs/big.md");
        await sync(b);
        await sync(b, true);
        await sync(a);
        expect(a.read("docs/big.md")).toBe(BIG("v1"));
        expect((await run(b.sm.listCloudOnlyFiles())).map((f) => f.path)).toEqual(["docs/big.md"]);
    });
});
