/**
 * .obsidian categories set per kind of device (obsidianScopeStrategy
 * "per-platform"), on the real SyncManager: a category off for PCs is left out
 * there, keeps syncing between the other devices, and is never deleted from the
 * cloud on its account.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { SimCloud } from "./sim-cloud";
import { SimDevice } from "./sim-device";
import { Rng } from "./rng";
import { drive } from "./simulation";
import { DEFAULT_SETTINGS } from "../../src/constants";

const NET = { minLatencyMs: 1, maxLatencyMs: 5, failureRate: 0, lostResponseRate: 0 };
const PLUGIN = ".obsidian/plugins/other/main.js";

function setup() {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"], now: Date.UTC(2026, 0, 1) });
    const rng = new Rng(31);
    vi.spyOn(Math, "random").mockImplementation(() => rng.next());
    const cloud = new SimCloud();
    const make = (name: string, pcPlugins = true) => {
        const devRng = rng.fork(name.charCodeAt(0));
        return new SimDevice({
            name,
            rng: devRng,
            maxEventDelayMs: 0,
            clockSkewMs: 0,
            log: (n: string, m: string) => {
                if (process.env.SIM_LOG && m.includes(process.env.SIM_LOG)) console.log(n, m);
            },
            settings: {
                obsidianScopeStrategy: "per-platform",
                desktopObsidianScope: { ...DEFAULT_SETTINGS.desktopObsidianScope, syncCommunityPlugins: pcPlugins },
                mobileObsidianScope: { ...DEFAULT_SETTINGS.mobileObsidianScope },
            },
            cloudView: (d) => cloud.createDeviceView(name, devRng.fork(7), () => NET, () => d.online),
        });
    };
    const sync = async (dev: SimDevice) => {
        expect(await drive(dev.startSync("manual-sync", true), 600_000)).toBe("ok");
        expect(await drive(dev.transfersSettled(), 600_000)).toBe("ok");
        expect(dev.syncErrors).toEqual([]);
    };
    return { make, sync };
}

describe(".obsidian categories set per kind of device", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it("leaves a category out on PCs only when it is off for PCs", async () => {
        const { make, sync } = setup();
        const a = make("A");
        await a.init();
        await a.userCreate(PLUGIN, "v1");
        await a.userCreate("n.md", "n");
        await sync(a);

        const b = make("B", false);
        await b.init();
        await sync(b);
        expect(b.read(PLUGIN)).toBeNull();
        expect(b.read("n.md")).toBe("n");

        // B's own copy is neither uploaded nor removed from the cloud
        await b.userCreate(PLUGIN, "from B");
        await sync(b);
        await a.userEdit(PLUGIN, "v2");
        await sync(a);
        await sync(b);
        expect(b.read(PLUGIN)).toBe("from B");

        const c = make("C");
        await c.init();
        await sync(c);
        expect(c.read(PLUGIN)).toBe("v2");
    });
});
