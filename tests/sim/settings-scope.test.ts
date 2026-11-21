/**
 * Files one device leaves out through its own sync settings (exclusion list,
 * images and media toggle), on the real SyncManager. Settings can differ
 * between devices (settings file not synced, or not arrived yet), so files left
 * out on one device must stay in the cloud and on the other devices.
 * Found by the settings combination simulation (settings-matrix.sim.test.ts).
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { SimCloud } from "./sim-cloud";
import { SimDevice } from "./sim-device";
import { Rng } from "./rng";
import { advance, drive } from "./simulation";
import type { SyncManagerSettings } from "../../src/sync-manager";

const NET = { minLatencyMs: 1, maxLatencyMs: 5, failureRate: 0, lostResponseRate: 0 };

function setup() {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"], now: Date.UTC(2026, 0, 1) });
    const rng = new Rng(29);
    vi.spyOn(Math, "random").mockImplementation(() => rng.next());
    const cloud = new SimCloud();
    const make = async (name: string, settings: Partial<SyncManagerSettings> = {}) => {
        const devRng = rng.fork(name.charCodeAt(0));
        const d = new SimDevice({
            name,
            rng: devRng,
            maxEventDelayMs: 0,
            clockSkewMs: 0,
            log: (n: string, m: string) => {
                if (process.env.SIM_LOG) console.log(n, m);
            },
            settings,
            cloudView: (dev) => cloud.createDeviceView(name, devRng.fork(7), () => NET, () => dev.online),
        });
        await d.init();
        return d;
    };
    const sync = async (dev: SimDevice, scan = false) => {
        expect(await drive(dev.startSync("manual-sync", scan), 600_000)).toBe("ok");
        expect(await drive(dev.transfersSettled(), 600_000)).toBe("ok");
        expect(dev.syncErrors).toEqual([]);
    };
    /** A setting changed in the settings tab (which asks for a full cleanup) */
    const set = (dev: SimDevice, patch: Partial<SyncManagerSettings>) => {
        Object.assign(dev.settings, patch);
        dev.sm.triggerFullCleanup();
    };
    const cloudPaths = async () => Object.keys(await cloud.snapshot((p) => p.startsWith(".obsidian"))).sort();
    return { make, sync, set, cloud, cloudPaths };
}

describe("files left out by one device's sync settings", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it("turning images off on one device keeps them in the cloud and on the other devices", async () => {
        const { make, sync, set, cloudPaths } = setup();
        const a = await make("A");
        await a.userCreate("img/p.png", "PNG1");
        await a.userCreate("n.md", "n1");
        await sync(a);
        const b = await make("B");
        await sync(b);
        expect(b.read("img/p.png")).toBe("PNG1");

        set(b, { syncImagesAndMedia: false });
        await sync(b, true);
        await sync(a);
        await sync(b);
        // Used to: B removed the image from the cloud, then A moved its copy to the trash
        expect(a.read("img/p.png")).toBe("PNG1");
        expect(b.read("img/p.png")).toBe("PNG1");
        expect(await cloudPaths()).toEqual(["img/p.png", "n.md"]);

        // Edits on A still reach the cloud; B is not touched
        await a.userEdit("img/p.png", "PNG2");
        await sync(a);
        await sync(b);
        expect(b.read("img/p.png")).toBe("PNG1");

        // Turned on again: B gets the current version
        set(b, { syncImagesAndMedia: true });
        await sync(b);
        expect(b.read("img/p.png")).toBe("PNG2");
    });

    it("an exclusion on one device only: nothing downloaded there, nothing removed, no endless re-uploads", async () => {
        const { make, sync, cloud } = setup();
        const a = await make("A");
        await a.userCreate("private/x.md", "x1");
        await a.userCreate("n.md", "n1");
        await sync(a);
        const b = await make("B", { exclusionPatterns: "private/**" });
        await sync(b, true);
        // Used to: downloaded anyway, then marked for deletion on every sync
        expect(b.userFiles()).toEqual({ "n.md": "n1" });
        await sync(a);
        expect(a.read("private/x.md")).toBe("x1");
        const before = cloud.calls.length;
        await sync(b);
        const uploads = cloud.calls.slice(before).filter((c) => c.method === "uploadFile");
        expect(uploads).toEqual([]);
    });

    it.each([
        ["exclusion list", { exclusionPatterns: "notes/sub/**" }],
        ["PC-only list", { desktopExclusionPatterns: "notes/sub/**" }],
    ])("a device leaving a folder out keeps its files in the shared index (%s)", async (_label, settings) => {
        const { make, sync } = setup();
        const c = await make("C");
        await c.userCreate("notes/sub/x.md", "x1");
        await c.userCreate("notes/y.md", "y1");
        await sync(c);
        const b = await make("B", settings);
        await b.userCreate("notes/b.md", "b1");
        await sync(b);
        // Used to: B's index upload dropped notes/sub/x.md, so A never got it
        const a = await make("A");
        await sync(a);
        expect(a.userFiles()).toEqual({ "notes/b.md": "b1", "notes/sub/x.md": "x1", "notes/y.md": "y1" });
    });

    it("moving a note into an excluded folder removes it from the sync, the copy stays", async () => {
        const { make, sync, cloudPaths } = setup();
        const a = await make("A", { exclusionPatterns: "private/**" });
        await a.userCreate("notes/n.md", "n1");
        await sync(a);
        const b = await make("B");
        await sync(b);
        await a.userRename("notes/n.md", "private/n.md");
        await sync(a);
        await sync(b);
        expect(a.read("private/n.md")).toBe("n1");
        // Used to: the cloud kept notes/n.md, which A no longer had (never in step again)
        expect(await cloudPaths()).toEqual([]);
        expect(b.userFiles()).toEqual({});
    });

    it("a note moved elsewhere into a folder this device leaves out leaves this device", async () => {
        const { make, sync } = setup();
        const a = await make("A");
        await a.userCreate("notes/n.md", "n1");
        await sync(a);
        const b = await make("B", { exclusionPatterns: "archive/**" });
        await sync(b);
        await a.userRename("notes/n.md", "archive/n.md");
        await sync(a);
        await sync(b);
        // Used to: B kept notes/n.md as a stale copy and pushed it back as a new note
        expect(b.userFiles()).toEqual({});
        await sync(a);
        expect(a.userFiles()).toEqual({ "archive/n.md": "n1" });
    });

    it("taken off the PC-only list: changes made elsewhere meanwhile are pulled", async () => {
        const { make, sync } = setup();
        const a = await make("A");
        await a.userCreate("notes/sub/x.md", "x1");
        await sync(a);
        const b = await make("B");
        await sync(b);
        b.settings.desktopExclusionPatterns = "notes/sub/**";
        await drive(b.sm.applyDeviceScopeChange(""), 600_000);
        await sync(b);
        await a.userEdit("notes/sub/x.md", "x2");
        await sync(a);
        b.settings.desktopExclusionPatterns = "";
        await drive(b.sm.applyDeviceScopeChange("notes/sub/**"), 600_000);
        await sync(b);
        // The change was skipped while left out: it is pulled when synced again
        expect(b.read("notes/sub/x.md")).toBe("x2");
    });

    it("taken off the list: changes made elsewhere meanwhile are pulled, edits made here are merged", async () => {
        const { make, sync, set } = setup();
        const a = await make("A");
        await a.userCreate("notes/sub/x.md", "# x\n\nA: 1\n\nB: 1\n");
        await sync(a);
        const b = await make("B");
        await sync(b);
        set(b, { exclusionPatterns: "notes/sub/**" });
        await sync(b);
        await a.userEdit("notes/sub/x.md", "# x\n\nA: 2\n\nB: 1\n");
        await sync(a);
        await b.userEdit("notes/sub/x.md", "# x\n\nA: 1\n\nB: 2\n");
        await sync(b);
        set(b, { exclusionPatterns: "" });
        await sync(b);
        await sync(a);
        // Both edits survive: A's (made while B left the file out) and B's
        expect(b.read("notes/sub/x.md")).toBe("# x\n\nA: 2\n\nB: 2\n");
        expect(a.read("notes/sub/x.md")).toBe("# x\n\nA: 2\n\nB: 2\n");
    });

    it("turned off and on again before a sync: the edit made in between is uploaded", async () => {
        const { make, sync, set } = setup();
        const a = await make("A");
        await a.userCreate("img/p.png", "PNG1");
        await sync(a);
        const b = await make("B");
        await sync(b);
        set(a, { syncImagesAndMedia: false });
        await a.userEdit("img/p.png", "PNG2");
        await advance(50); // the edit's event arrives while images are off
        set(a, { syncImagesAndMedia: true });
        await sync(a);
        await sync(b);
        // Used to: the edit's event was ignored and nothing found it until a restart
        expect(b.read("img/p.png")).toBe("PNG2");
    });
});
