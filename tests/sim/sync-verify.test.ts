/**
 * Read-only sync check on the real SyncManager: after a sync every file
 * matches; edits not sent, edits not received and files on one side only are
 * each named; the check changes nothing.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { SimCloud } from "./sim-cloud";
import { SimDevice } from "./sim-device";
import { Rng } from "./rng";
import { drive } from "./simulation";

const NET = { minLatencyMs: 1, maxLatencyMs: 5, failureRate: 0, lostResponseRate: 0 };

function setup() {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"], now: Date.UTC(2026, 0, 1) });
    const rng = new Rng(31);
    vi.spyOn(Math, "random").mockImplementation(() => rng.next());
    const cloud = new SimCloud();
    const make = (name: string) => {
        const devRng = rng.fork(name.charCodeAt(0));
        return new SimDevice({
            name,
            rng: devRng,
            maxEventDelayMs: 0,
            clockSkewMs: 0,
            log: () => {},
            settings: {},
            cloudView: (d) => cloud.createDeviceView(name, devRng.fork(7), () => NET, () => d.online),
        });
    };
    const sync = async (dev: SimDevice, scan = false) => {
        expect(await drive(dev.startSync("manual-sync", scan), 600_000)).toBe("ok");
        expect(await drive(dev.transfersSettled(), 600_000)).toBe("ok");
        expect(dev.syncErrors).toEqual([]);
    };
    const verify = async (dev: SimDevice) => {
        const p = dev.sm.verifySync();
        expect(await drive(p, 600_000)).toBe("ok");
        return p;
    };
    return { make, sync, verify };
}

describe("sync check", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it("finds every kind of difference and changes nothing", async () => {
        const { make, sync, verify } = setup();
        const a = make("A");
        const b = make("B");
        await a.init();
        await a.userCreate("same.md", "s");
        await a.userCreate("edit-here.md", "1");
        await a.userCreate("edit-there.md", "1");
        await sync(a);
        await b.init();
        await sync(b, true);

        const clean = await verify(b);
        expect(clean.differences).toEqual([]);
        expect(clean.matching).toBeGreaterThanOrEqual(3);

        await a.userEdit("edit-there.md", "2");
        await a.userCreate("new-there.md", "n");
        await sync(a);
        await b.userEdit("edit-here.md", "2");
        await b.userCreate("new-here.md", "h");

        const r = await verify(b);
        const kinds = Object.fromEntries(r.differences.map((d) => [d.path, d.kind]));
        expect(kinds).toMatchObject({
            "edit-here.md": "local-changed",
            "edit-there.md": "cloud-changed",
            "new-there.md": "cloud-only",
            "new-here.md": "local-only",
        });
        expect(kinds["same.md"]).toBeUndefined();
        // Read-only: B's files are as they were
        expect(b.read("edit-there.md")).toBe("1");
        expect(b.read("new-there.md")).toBeNull();

        await sync(b);
        await sync(a);
        expect((await verify(b)).differences).toEqual([]);
        expect((await verify(a)).differences).toEqual([]);
    });

    it("reports its progress: the cloud listing first, then each file compared", async () => {
        const { make, sync } = setup();
        const a = make("A");
        await a.init();
        await a.userCreate("one.md", "1");
        await a.userCreate("two.md", "22");
        await sync(a);

        const seen: import("../../src/sync-manager/sync-verify").VerifyProgress[] = [];
        const p = a.sm.verifySync((x) => seen.push(x));
        expect(await drive(p, 600_000)).toBe("ok");
        const report = await p;

        expect(seen[0]).toEqual({ stage: "listing" });
        const steps = seen.filter((x) => x.stage === "comparing");
        expect(steps[0]).toMatchObject({ done: 0 });
        const last = steps[steps.length - 1];
        expect(last.done).toBe(last.total);
        expect(last.bytesDone).toBe(last.bytesTotal);
        expect(last.total).toBe(report.matching + report.differences.length);
        // never backwards
        expect(steps.map((x) => x.done)).toEqual([...steps.map((x) => x.done)].sort((x, y) => x - y));
    });
});
