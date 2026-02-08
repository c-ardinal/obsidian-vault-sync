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

    it("Scenario 1: 初回起動後の同期 (isSilent=false) - Should spin from start to finish", async () => {
        // isSilent=false, scanVault=true
        await device.syncManager.requestSmartSync(false, true);
        expect(activityStartSpy).toHaveBeenCalled();
    });

    it("Scenario 2: 通常起動後の同期 (isSilent=true) - Should spin ONLY if changes found", async () => {
        // isSilent=true, scanVault=true

        // 2a. No changes
        await device.syncManager.requestSmartSync(true, true);
        expect(activityStartSpy).not.toHaveBeenCalled();

        // 2b. With changes (Push)
        activityStartSpy.mockClear();
        device.editFile("new-file.md", "content");
        await device.syncManager.requestSmartSync(true, true);
        expect(activityStartSpy).toHaveBeenCalled();
    });

    it("Scenario 3: 定期同期 (isSilent=true) - Should spin ONLY if changes found", async () => {
        // isSilent=true, scanVault=false

        // 3a. No changes
        await device.syncManager.requestSmartSync(true, false);
        expect(activityStartSpy).not.toHaveBeenCalled();

        // 3b. With changes (Pull)
        activityStartSpy.mockClear();
        const deviceB = new DeviceSimulator("DeviceB", cloud);
        deviceB.editFile("remote.md", "content");
        await deviceB.syncManager.requestSmartSync(false, false);

        await device.syncManager.requestSmartSync(true, false);

        expect(activityStartSpy).toHaveBeenCalled();
    });

    it("Scenario 4: 手動同期 (isSilent=false) - Should spin from start to finish", async () => {
        // isSilent=false, scanVault=false
        await device.syncManager.requestSmartSync(false, false);
        expect(activityStartSpy).toHaveBeenCalled();
    });
});
