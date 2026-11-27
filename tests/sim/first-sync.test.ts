/**
 * First sync of a device that already has notes, into a cloud vault that has
 * notes too: the three ways to start, and "later", on the real SyncManager.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { SimCloud } from "./sim-cloud";
import { SimDevice } from "./sim-device";
import { Rng } from "./rng";
import { drive } from "./simulation";
import type { FirstSyncMode, FirstSyncSummary } from "../../src/sync-manager/first-sync";

const NET = { minLatencyMs: 1, maxLatencyMs: 5, failureRate: 0, lostResponseRate: 0 };

async function setup() {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"], now: Date.UTC(2026, 0, 1) });
    const rng = new Rng(7);
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
        return dev;
    };
    const sync = async (dev: SimDevice, trigger: "manual-sync" | "timer-sync" = "manual-sync") => {
        expect(await drive(dev.startSync(trigger, true), 600_000)).toBe("ok");
        expect(await drive(dev.transfersSettled(), 600_000)).toBe("ok");
    };

    const a = make("A");
    await a.init();
    await a.userCreate("same.md", "same");
    await a.userCreate("diff.md", "cloud version");
    await a.userCreate("cloud-only.md", "only on the cloud");
    await sync(a);

    const b = make("B");
    await b.init();
    await b.userCreate("same.md", "same");
    await b.userCreate("diff.md", "local version");
    await b.userCreate("local-only.md", "only here");
    return { cloud, a, b, sync };
}

function guard(dev: SimDevice, mode: FirstSyncMode) {
    const seen: FirstSyncSummary[] = [];
    dev.sm.firstSyncGuard = {
        choose: async (s) => {
            seen.push(s);
            return mode;
        },
    };
    return seen;
}

const userNotes = (dev: SimDevice) =>
    Object.fromEntries(Object.entries(dev.userFiles()).filter(([p]) => !p.startsWith("_VaultSyncer_Orphans/")));

describe("first sync of a device with notes", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it("shows how both sides compare, and merge keeps everything (as before)", async () => {
        const { a, b, sync } = await setup();
        const seen = guard(b, "merge");
        await sync(b);
        expect(seen).toEqual([
            { identical: ["same.md"], differing: ["diff.md"], localOnly: ["local-only.md"], cloudOnly: ["cloud-only.md"] },
        ]);
        expect(b.read("diff.md")).toBe("cloud version");
        expect(Object.keys(b.userFiles()).some((p) => /diff \(Conflict/.test(p))).toBe(true);
        await sync(a);
        expect(a.read("local-only.md")).toBe("only here");
    });

    it("asks only once: the next sync of the same session is an ordinary one", async () => {
        const { b, sync } = await setup();
        const seen = guard(b, "merge");
        await sync(b);
        await b.userCreate("new.md", "new");
        await sync(b);
        await sync(b, "timer-sync");
        expect(seen).toHaveLength(1);
    });

    it("start from the cloud: this device's differing and own notes are set aside, never uploaded", async () => {
        const { a, b, sync } = await setup();
        guard(b, "cloud");
        await sync(b);
        expect(userNotes(b)).toEqual({ "same.md": "same", "diff.md": "cloud version", "cloud-only.md": "only on the cloud" });
        const aside = Object.entries(b.userFiles()).filter(([p]) => p.startsWith("_VaultSyncer_Orphans/"));
        expect(aside.map(([p, c]) => [p.replace(/first-sync-[^/]+\//, ""), c]).sort()).toEqual([
            ["_VaultSyncer_Orphans/diff.md", "local version"],
            ["_VaultSyncer_Orphans/local-only.md", "only here"],
        ]);
        await sync(a);
        expect(userNotes(a)).toEqual({ "same.md": "same", "diff.md": "cloud version", "cloud-only.md": "only on the cloud" });
    });

    it("start from this device: its notes replace the cloud's, and cloud-only notes are deleted (kept in the trash)", async () => {
        const { a, b, cloud, sync } = await setup();
        guard(b, "local");
        await sync(b);
        expect(userNotes(b)).toEqual({ "same.md": "same", "diff.md": "local version", "local-only.md": "only here" });
        await sync(a);
        expect(userNotes(a)).toEqual({ "same.md": "same", "diff.md": "local version", "local-only.md": "only here" });
        const { listTrash } = await import("../../src/sync-manager/remote-trash");
        expect((await listTrash(cloud.store)).map((t) => t.originalPath)).toEqual(["cloud-only.md"]);
    });

    it("later: nothing is synced, automatic syncs wait, and a manual sync asks again", async () => {
        const { b, cloud, sync } = await setup();
        const seen = guard(b, "later");
        await sync(b);
        expect(b.read("cloud-only.md")).toBeNull();
        expect(cloud.store.getCloudContent("local-only.md")).toBeNull();
        await sync(b, "timer-sync");
        expect(seen).toHaveLength(1);
        expect(b.read("cloud-only.md")).toBeNull();

        guard(b, "merge");
        await sync(b);
        expect(b.read("cloud-only.md")).toBe("only on the cloud");
    });

    it("does not ask when this device has no notes of its own", async () => {
        const { b, sync } = await setup();
        await b.userDelete("same.md");
        await b.userDelete("diff.md");
        await b.userDelete("local-only.md");
        const seen = guard(b, "later");
        await sync(b);
        expect(seen).toEqual([]);
        expect(b.read("diff.md")).toBe("cloud version");
    });
});
