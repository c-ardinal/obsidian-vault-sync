/**
 * A timer sync with nothing new reads only the change feed. Whenever the feed
 * lists something, or something waits on this device, the full checks (vault-lock,
 * merge locks) run as before.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { SimCloud } from "./sim-cloud";
import { SimDevice } from "./sim-device";
import { Rng } from "./rng";
import { drive } from "./simulation";
import { vaultLockPath } from "../../src/services/vault-lock-service";

const NET = { minLatencyMs: 1, maxLatencyMs: 5, failureRate: 0, lostResponseRate: 0 };

async function setup() {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"], now: Date.UTC(2026, 0, 1) });
    const rng = new Rng(11);
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
            cloudView: (d) => cloud.createDeviceView(name, devRng.fork(7), () => NET, () => d.online),
        });
    };
    const sync = async (dev: SimDevice, trigger: "manual-sync" | "timer-sync" = "manual-sync") => {
        expect(await drive(dev.startSync(trigger, false), 600_000)).toBe("ok");
        expect(await drive(dev.transfersSettled(), 600_000)).toBe("ok");
    };
    /** The cloud calls one sync of this device makes */
    const callsOf = async (dev: SimDevice, trigger: "manual-sync" | "timer-sync") => {
        const before = cloud.calls.length;
        await sync(dev, trigger);
        return cloud.calls.slice(before).filter((c) => c.device === dev.name).map((c) => c.method);
    };

    const a = make("A");
    await a.init();
    await a.userCreate("note.md", "first");
    await sync(a);
    const b = make("B");
    await b.init();
    await sync(b);
    // Settle both sides so the feed holds nothing new for either
    await sync(a);
    await sync(b);
    await sync(b, "timer-sync");
    return { cloud, a, b, sync, callsOf };
}

describe("quiet timer sync", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it("reads only the change feed when nothing changed anywhere", async () => {
        const { b, callsOf } = await setup();
        expect(await callsOf(b, "timer-sync")).toEqual(["getChanges"]);
    });

    it("still checks the vault-lock on a sync the user starts", async () => {
        const { b, callsOf } = await setup();
        expect(await callsOf(b, "manual-sync")).toContain("getFileMetadata");
    });

    it("runs the full checks and pulls when another device changed a note", async () => {
        const { a, b, sync, callsOf } = await setup();
        await a.userEdit("note.md", "second");
        await sync(a);
        const calls = await callsOf(b, "timer-sync");
        expect(calls).toContain("getFileMetadata");
        expect(b.read("note.md")).toBe("second");
    });

    it("runs the full checks when this device has an edit to upload", async () => {
        const { b, callsOf } = await setup();
        await b.userEdit("note.md", "from B");
        const calls = await callsOf(b, "timer-sync");
        expect(calls).toContain("getFileMetadata");
        expect(calls).toContain("uploadFile");
    });

    it("notices a vault-lock another device put up, on the next timer sync", async () => {
        const { cloud, b, callsOf } = await setup();
        await cloud.store.uploadFile(vaultLockPath(), new TextEncoder().encode("lock").buffer, Date.now());
        await callsOf(b, "timer-sync");
        expect(b.sm.settings.e2eeEnabled).toBe(true);
    });
});
