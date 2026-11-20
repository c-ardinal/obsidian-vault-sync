import { describe, it, expect } from "vitest";
import { MockCloudAdapter } from "../../helpers/mock-cloud-adapter";
import {
    MAX_ACTIVITY,
    deviceRecordPath,
    getDeviceName,
    listDevices,
    mergeActivity,
    publishDeviceRecordIfDue,
    recordActivity,
    type DeviceCtx,
} from "../../../src/sync-manager/device-registry";
import { isManagedSeparately, setPluginDir } from "../../../src/sync-manager/file-utils";

const HOUR = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 10, 20, 12);

function makeCtx(cloud: MockCloudAdapter, deviceId: string): DeviceCtx & { uploads: () => number } {
    const local = new Map<string, string>();
    let uploads = 0;
    const adapter = new Proxy(cloud, {
        get(target, prop, recv) {
            if (prop === "uploadFile") {
                return (...args: Parameters<MockCloudAdapter["uploadFile"]>) => {
                    uploads++;
                    return target.uploadFile(...args);
                };
            }
            const v = Reflect.get(target, prop, recv);
            return typeof v === "function" ? v.bind(target) : v;
        },
    });
    return {
        adapter,
        vault: {
            exists: async (p) => local.has(p),
            read: async (p) => local.get(p) ?? "",
            write: async (p, d) => void local.set(p, d),
            mkdir: async () => {},
        },
        pluginDir: ".obsidian/plugins/cardinal-vault-sync",
        deviceId,
        deviceInfo: { platform: "Linux", defaultName: "Linux" },
        log: async () => {},
        uploads: () => uploads,
    };
}

describe("device registry", () => {
    it("writes after a sync with changes, else only when the last write is old", async () => {
        const cloud = new MockCloudAdapter();
        const ctx = makeCtx(cloud, "abcd1234");
        expect(await publishDeviceRecordIfDue(ctx, T0)).toBe(true); // first write
        expect(await publishDeviceRecordIfDue(ctx, T0 + HOUR)).toBe(false);
        recordActivity(ctx, "edit", "a.md", undefined, T0 + HOUR);
        expect(await publishDeviceRecordIfDue(ctx, T0 + HOUR)).toBe(true);
        expect(await publishDeviceRecordIfDue(ctx, T0 + 7 * HOUR)).toBe(true);
        expect(ctx.uploads()).toBe(3);
        const [rec] = await listDevices(ctx);
        expect(rec).toMatchObject({ id: "abcd1234", name: "Linux (abcd)", platform: "Linux", lastSyncAt: T0 + 7 * HOUR });
        expect(rec.activity).toEqual([{ t: T0 + HOUR, op: "edit", path: "a.md" }]);
    });

    it("leaves settings files out and keeps the newest changes", async () => {
        const cloud = new MockCloudAdapter();
        const ctx = makeCtx(cloud, "dev1");
        recordActivity(ctx, "edit", ".obsidian/app.json", undefined, T0);
        for (let i = 0; i < MAX_ACTIVITY + 5; i++) recordActivity(ctx, "create", `n${i}.md`, undefined, T0 + i);
        await publishDeviceRecordIfDue(ctx, T0 + 1000);
        const [rec] = await listDevices(ctx);
        expect(rec.activity).toHaveLength(MAX_ACTIVITY);
        expect(rec.activity[0].path).toBe(`n${MAX_ACTIVITY + 4}.md`);
        expect(rec.activity.some((a) => a.path.startsWith(".obsidian/"))).toBe(false);
    });

    it("keeps earlier changes after a restart and merges devices newest first", async () => {
        const cloud = new MockCloudAdapter();
        const a = makeCtx(cloud, "devA");
        recordActivity(a, "create", "x.md", undefined, T0);
        await publishDeviceRecordIfDue(a, T0);
        const a2 = makeCtx(cloud, "devA"); // the plugin started again
        recordActivity(a2, "edit", "x.md", undefined, T0 + 2);
        await publishDeviceRecordIfDue(a2, T0 + 2);
        const b = makeCtx(cloud, "devB");
        recordActivity(b, "delete", "y.md", undefined, T0 + 1);
        await publishDeviceRecordIfDue(b, T0 + 1);

        const records = await listDevices(a2);
        expect(records.map((r) => r.id)).toEqual(["devA", "devB"]);
        expect(mergeActivity(records).map((x) => [x.deviceId, x.op, x.path])).toEqual([
            ["devA", "edit", "x.md"],
            ["devB", "delete", "y.md"],
            ["devA", "create", "x.md"],
        ]);
    });

    it("uses the name the user gave", async () => {
        const ctx = makeCtx(new MockCloudAdapter(), "dev1");
        await ctx.vault.write(`${ctx.pluginDir}/data/local/device.json`, JSON.stringify({ name: " Desk " }));
        expect(await getDeviceName(ctx)).toBe("Desk");
    });

    it("record files are kept out of the file sync", () => {
        setPluginDir(".obsidian/plugins/cardinal-vault-sync", ".obsidian");
        const ctx = makeCtx(new MockCloudAdapter(), "dev1");
        expect(isManagedSeparately(deviceRecordPath(ctx, "dev1"))).toBe(true);
        expect(isManagedSeparately(".obsidian/plugins/cardinal-vault-sync/data/remote/other.json")).toBe(false);
    });
});
