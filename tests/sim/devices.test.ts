/**
 * Device records and their changes, on the real SyncManager: each device
 * writes only its own record, the records never show up as vault files, and
 * every device sees what the others changed.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { SimCloud } from "./sim-cloud";
import { SimDevice } from "./sim-device";
import { Rng } from "./rng";
import { drive } from "./simulation";

const NET = { minLatencyMs: 1, maxLatencyMs: 5, failureRate: 0, lostResponseRate: 0 };

async function setup() {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"], now: Date.UTC(2026, 0, 1) });
    const rng = new Rng(11);
    vi.spyOn(Math, "random").mockImplementation(() => rng.next());
    const cloud = new SimCloud();
    const make = (name: string) => {
        const devRng = rng.fork(name.charCodeAt(0));
        const dev: SimDevice = new SimDevice({
            name,
            rng: devRng,
            maxEventDelayMs: 0,
            clockSkewMs: 0,
            log: () => {},
            cloudView: (d) => cloud.createDeviceView(name, devRng.fork(7), () => NET, () => d.online),
        });
        dev.sm.deviceInfo = { platform: `Platform ${name}`, defaultName: `Device ${name}` };
        return dev;
    };
    const sync = async (dev: SimDevice) => {
        expect(await drive(dev.startSync("manual-sync", true), 600_000)).toBe("ok");
        expect(await drive(dev.transfersSettled(), 600_000)).toBe("ok");
    };
    /** Runs a call to the end under the fake clock and returns its value */
    const run = async <T>(p: Promise<T>): Promise<T> => {
        let value: T | undefined;
        let error: unknown;
        expect(await drive(p.then((v) => (value = v), (e) => (error = e)), 600_000)).toBe("ok");
        if (error) throw error;
        return value as T;
    };
    return { cloud, make, sync, run };
}

describe("device records", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it("lists every device with the changes it made", async () => {
        const { cloud, make, sync, run } = await setup();
        const a = make("A");
        await a.init();
        await a.userCreate("a.md", "from A");
        await sync(a);

        const b = make("B");
        await b.init();
        await sync(b);
        await b.userEdit("a.md", "edited on B");
        await b.userCreate("b.md", "from B");
        await sync(b);
        await b.userRename("b.md", "Folder/b2.md");
        await sync(b);
        await b.userDelete("a.md");
        await sync(b);
        await sync(a);

        const devices = await run(a.sm.listDevices());
        expect(devices.map((d) => d.platform).sort()).toEqual(["Platform A", "Platform B"]);
        const recA = devices.find((d) => d.platform === "Platform A")!;
        const recB = devices.find((d) => d.platform === "Platform B")!;
        expect(recA.id).toBe(a.sm.thisDeviceId);
        expect(recA.name).toMatch(/^Device A \(/);
        expect(recA.activity.map((x) => [x.op, x.path])).toEqual([["create", "a.md"]]);
        const opsB = recB.activity.map((x) => [x.op, x.path, x.from ?? ""]);
        expect(opsB.slice(0, 2)).toEqual([
            ["delete", "a.md", ""],
            ["rename", "Folder/b2.md", "b.md"],
        ]);
        // Uploaded in the same sync: either order
        expect(opsB.slice(2).sort()).toEqual([
            ["create", "b.md", ""],
            ["edit", "a.md", ""],
        ]);

        // Records stay out of the vaults and the shared index
        expect(a.userFiles()).toEqual({ "Folder/b2.md": "from B" });
        expect(b.userFiles()).toEqual({ "Folder/b2.md": "from B" });
        for (const dev of [a, b]) {
            expect(Object.keys((dev.sm as any).index).filter((p) => p.includes("/devices/"))).toEqual([]);
        }
        expect(cloud.store.getCloudContent(`.obsidian/plugins/obsidian-vault-sync/data/remote/devices/${b.sm.thisDeviceId}.json`)).not.toBeNull();
    });

    it("a renamed device shows its new name, and a forgotten device comes back when it syncs", async () => {
        const { make, sync, run } = await setup();
        const a = make("A");
        await a.init();
        await a.userCreate("a.md", "x");
        await sync(a);
        const b = make("B");
        await b.init();
        await sync(b);

        await run(b.sm.setDeviceName("Laptop"));
        await sync(b);
        let devices = await run(a.sm.listDevices());
        expect(devices.find((d) => d.id === b.sm.thisDeviceId)?.name).toBe("Laptop");

        await run(a.sm.forgetDevice(b.sm.thisDeviceId));
        devices = await run(a.sm.listDevices());
        expect(devices.map((d) => d.id)).toEqual([a.sm.thisDeviceId]);
        await expect(run(a.sm.forgetDevice(a.sm.thisDeviceId))).rejects.toThrow();

        await b.userEdit("a.md", "y");
        await sync(b);
        devices = await run(a.sm.listDevices());
        const back = devices.find((d) => d.id === b.sm.thisDeviceId);
        expect(back?.name).toBe("Laptop");
        expect(back?.activity.map((x) => x.op)).toEqual(["edit"]);
        await sync(a);
        expect(a.read("a.md")).toBe("y");
    });
});
