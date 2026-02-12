import { describe, it, expect, beforeEach, vi } from "vitest";
import { MockCloudAdapter } from "../../helpers/mock-cloud-adapter";
import { DeviceSimulator } from "../../helpers/device-simulator";

const FILE_PATH = "notes/test.md";

describe("Icon Rotation Behavior Scenarios", () => {
    let cloud: MockCloudAdapter;
    let device: DeviceSimulator;
    let activityStartSpy: ReturnType<typeof vi.fn>;
    let activityEndSpy: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
        cloud = new MockCloudAdapter();
        device = new DeviceSimulator("DeviceA", cloud);

        // Mock activity callbacks
        activityStartSpy = vi.fn();
        activityEndSpy = vi.fn();

        // Access private syncManager via 'sm' (cast to any)
        const sm = (device as any).sm;
        sm.onActivityStart = activityStartSpy;
        sm.onActivityEnd = activityEndSpy;
    });

    it("Scenario 1: 初回起動後の同期 (initial-sync) - Should spin from start to finish", async () => {
        // initial-sync: ALWAYS_SHOW_ACTIVITY triggers startActivity immediately
        await device.syncManager.requestSmartSync("initial-sync", true);
        expect(activityStartSpy).toHaveBeenCalled();
    });

    it("Scenario 2: 通常起動後の同期 (startup-sync) - Should spin from start to finish", async () => {
        // startup-sync: ALWAYS_SHOW_ACTIVITY triggers startActivity immediately
        await device.syncManager.requestSmartSync("startup-sync", true);
        expect(activityStartSpy).toHaveBeenCalled();
    });

    it("Scenario 3: 定期同期 (timer-sync) - Should spin ONLY if changes found", async () => {
        // timer-sync: NOT in ALWAYS_SHOW_ACTIVITY, spin only on changes

        // 3a. No changes
        await device.syncManager.requestSmartSync("timer-sync", false);
        expect(activityStartSpy).not.toHaveBeenCalled();

        // 3b. With changes (Pull)
        activityStartSpy.mockClear();
        const deviceB = new DeviceSimulator("DeviceB", cloud);
        deviceB.editFile("remote.md", "content");
        await deviceB.syncManager.requestSmartSync("manual-sync", false);

        await device.syncManager.requestSmartSync("timer-sync", false);

        expect(activityStartSpy).toHaveBeenCalled();
    });

    it("Scenario 4: 手動同期 (manual-sync) - Should spin from start to finish", async () => {
        // manual-sync: ALWAYS_SHOW_ACTIVITY triggers startActivity immediately
        await device.syncManager.requestSmartSync("manual-sync", false);
        expect(activityStartSpy).toHaveBeenCalled();
    });

    it("Scenario 5: 保存時同期 (save-sync) - Should spin ONLY if changes found", async () => {
        // save-sync: NOT in ALWAYS_SHOW_ACTIVITY

        // 5a. No changes
        await device.syncManager.requestSmartSync("save-sync", false);
        expect(activityStartSpy).not.toHaveBeenCalled();

        // 5b. With changes (Push)
        activityStartSpy.mockClear();
        device.editFile("new-file.md", "content");
        await device.syncManager.requestSmartSync("save-sync", false);
        expect(activityStartSpy).toHaveBeenCalled();
    });
});
