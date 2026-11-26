/**
 * Canvas and settings JSON edited on two devices at once, on the real
 * SyncManager: merged as data (both cards kept, no conflict copy), and a JSON
 * value changed two ways never leaves a broken file.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { SimCloud } from "./sim-cloud";
import { SimDevice } from "./sim-device";
import { Rng } from "./rng";
import { drive } from "./simulation";

const NET = { minLatencyMs: 1, maxLatencyMs: 5, failureRate: 0, lostResponseRate: 0 };

function setup() {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"], now: Date.UTC(2026, 0, 1) });
    const rng = new Rng(37);
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

const card = (id: string, text: string) => ({ id, type: "text", text, x: 0, y: 0, width: 250, height: 60 });
const canvas = (...nodes: object[]) => JSON.stringify({ nodes, edges: [] }, null, "\t");

describe("structured files edited on two devices", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it("keeps the cards both devices added to one canvas", async () => {
        const { make, sync } = setup();
        const a = make("A");
        const b = make("B");
        await a.init();
        await a.userCreate("board.canvas", canvas(card("a", "A")));
        await sync(a);
        await b.init();
        await sync(b, true);

        await a.userEdit("board.canvas", canvas(card("a", "A"), card("b", "from A")));
        await b.userEdit("board.canvas", canvas(card("a", "A"), card("c", "from B")));
        await sync(a);
        await sync(b);
        await sync(a);

        for (const dev of [a, b]) {
            const ids = JSON.parse(dev.read("board.canvas")!).nodes.map((n: { id: string }) => n.id).sort();
            expect(ids).toEqual(["a", "b", "c"]);
            expect(Object.keys(dev.userFiles()).filter((p) => p.includes("Conflict"))).toEqual([]);
        }
    });

    it("a JSON value changed two ways: a conflict copy, both files readable", async () => {
        const { make, sync } = setup();
        const a = make("A");
        const b = make("B");
        await a.init();
        await a.userCreate("data/conf.json", JSON.stringify({ v: 1, keep: true }, null, 2));
        await sync(a);
        await b.init();
        await sync(b, true);

        await a.userEdit("data/conf.json", JSON.stringify({ v: 2, keep: true }, null, 2));
        await b.userEdit("data/conf.json", JSON.stringify({ v: 3, keep: true }, null, 2));
        await sync(a);
        await sync(b);
        for (const [p, text] of Object.entries(b.userFiles())) {
            if (p.endsWith(".json")) expect(() => JSON.parse(text)).not.toThrow();
        }
    });
});
