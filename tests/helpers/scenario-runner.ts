import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { describe, it, expect } from "vitest";
import { MockCloudAdapter } from "./mock-cloud-adapter";
import { DeviceSimulator, hashOf } from "./device-simulator";

export interface TestStep {
    device: string;
    action: "edit" | "push" | "forcePush" | "pull" | "sync" | "wait" | "delete";
    path: string;
    content?: string;
    expect?: {
        pushed?: boolean;
        pulled?: boolean;
        conflict?: boolean;
        lastAction?: string;
        localContent?: string;
        cloudContent?: string;
        isDirty?: boolean;
        ancestorHash?: string;
        exists?: string[];
    };
}

export interface Scenario {
    name: string;
    description: string;
    setup: {
        files: Record<string, string>;
        devices: Array<{ name: string; id: string }>;
        synced: boolean;
    };
    steps: TestStep[];
}

export class ScenarioRunner {
    private cloud: MockCloudAdapter;
    private devices: Record<string, DeviceSimulator> = {};

    constructor(private scenario: Scenario) {
        this.cloud = new MockCloudAdapter();
    }

    async run() {
        console.log(`\nScenario: ${this.scenario.name}`);
        console.log(`Description: ${this.scenario.description}`);

        // 1. Setup Files on Cloud
        for (const [path, content] of Object.entries(this.scenario.setup.files)) {
            const buf = new TextEncoder().encode(content).buffer as ArrayBuffer;
            await this.cloud.uploadFile(path, buf, Date.now());
        }

        // 2. Setup Devices
        for (const devConfig of this.scenario.setup.devices) {
            const device = new DeviceSimulator(devConfig.name, this.cloud, devConfig.id);
            this.devices[devConfig.name] = device;

            if (this.scenario.setup.synced) {
                for (const [path, content] of Object.entries(this.scenario.setup.files)) {
                    const fileId = this.cloud.getFileId(path)!;
                    device.setupSyncedFile(path, content, fileId);
                }
            }
        }

        // 3. Execute Steps
        for (let i = 0; i < this.scenario.steps.length; i++) {
            const step = this.scenario.steps[i];
            console.log(`\n--- Step ${i + 1}: ${step.device} ${step.action} ${step.path} ---`);

            const device = this.devices[step.device];
            if (!device) throw new Error(`Device ${step.device} not found`);

            switch (step.action) {
                case "edit":
                    device.editFile(step.path, step.content || "");
                    break;
                case "push":
                    const pushRes = await device.pushFile(step.path);
                    if (step.expect?.pushed !== undefined) {
                        expect(pushRes.pushed).toBe(step.expect.pushed);
                    }
                    if (step.expect?.conflict !== undefined) {
                        expect(pushRes.conflictDetected).toBe(step.expect.conflict);
                    }
                    break;
                case "forcePush":
                    // Simulate GDrive eventual consistency where device pushes
                    // without seeing recent remote changes.
                    await device.forcePush(step.path);
                    break;
                case "pull":
                    const pullRes = await device.pullFile(step.path);
                    if (step.expect?.pulled !== undefined) {
                        expect(pullRes).toBe(step.expect.pulled);
                    }
                    break;
                case "sync":
                    // Simulate smart sync request
                    await (device as any).sm.requestSmartSync(true);
                    break;
                case "delete":
                    await device.app.vault.adapter.remove(step.path);
                    (device as any).sm.dirtyPaths.set(step.path, Date.now());
                    break;
                case "wait":
                    await new Promise((r) => setTimeout(r, 50));
                    break;
            }

            // Global file existence assertions
            if (step.expect?.exists) {
                const files = device.listLocalFiles();
                for (const p of step.expect.exists) {
                    const found = files.some((f) => f.includes(p));
                    if (!found) {
                        console.log(`[FAIL] ${device.name} local files:`, files);
                        throw new Error(
                            `Expected file matching "${p}" not found in ${device.name}.`,
                        );
                    }
                }
            }

            // Assertions for specific path
            if (step.expect) {
                const state = device.describeState(step.path);
                if (step.expect.lastAction) {
                    try {
                        expect(state.localIndex?.lastAction).toBe(step.expect.lastAction);
                    } catch (e) {
                        console.log(
                            `[FAIL] ${step.device} ${step.path} state:`,
                            JSON.stringify(state.localIndex),
                        );
                        throw e;
                    }
                }
                if (step.expect.isDirty !== undefined) {
                    try {
                        expect(state.isDirty).toBe(step.expect.isDirty);
                    } catch (e) {
                        console.log(
                            `[FAIL] ${step.device} ${step.path} isDirty expected ${step.expect.isDirty}, got ${state.isDirty}`,
                        );
                        throw e;
                    }
                }
                if (step.expect.localContent !== undefined) {
                    expect(state.localContent).toBe(step.expect.localContent);
                }
                if (step.expect.cloudContent !== undefined) {
                    expect(this.cloud.getCloudContent(step.path)).toBe(step.expect.cloudContent);
                }
                if (step.expect.ancestorHash !== undefined) {
                    // Simple check if it matches the hash of some content
                    const expectedHash = hashOf(step.expect.ancestorHash).substring(0, 8);
                    expect(state.localIndex?.ancestorHash).toBe(expectedHash);
                }
            }
        }
    }
}
