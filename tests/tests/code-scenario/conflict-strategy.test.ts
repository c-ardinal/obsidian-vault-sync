/**
 * @file 競合解決ストラテジーの動作検証
 *
 * @description
 * 4種のストラテジー (force-local / force-remote / always-fork / smart-merge) が
 * 競合発生時に仕様通りのコンテンツ選択・ファイル生成・状態遷移を行うことを検証する。
 * ランタイム切り替え・バイナリファイル競合(ストラテジー非適用)も含む。
 *
 * @prerequisites
 * - 2台のDeviceSimulator (DeviceA, DeviceB) が同一ファイルを同期済み
 * - MockCloudAdapterを共有
 *
 * @pass_criteria
 * - force-local: ローカル内容を保持し、リモートを上書きすること
 * - force-remote: リモート内容を受け入れ、ローカル変更を破棄すること
 * - always-fork: 常にコンフリクトファイルを生成すること (自動マージしない)
 * - smart-merge: 非重複編集は自動マージ、重複編集はコンフリクト検出
 * - ランタイム切り替え: 次回の競合から新ストラテジーが適用されること
 * - バイナリファイル: ストラテジーに関係なくコンフリクトファイルを生成すること
 */

import { describe, it, expect, beforeEach } from "vitest";
import { MockCloudAdapter } from "../../helpers/mock-cloud-adapter";
import { DeviceSimulator, hashOf } from "../../helpers/device-simulator";

const FILE = "notes/test.md";

/** Initial synced content */
const ANCESTOR = "Line 1\nLine 2\n";
/** Device A's edit: modifies line 1 (non-overlapping with B) */
const EDIT_A = "Line 1 edited by A\nLine 2\n";
/** Device B's edit: modifies line 2 (non-overlapping with A) */
const EDIT_B = "Line 1\nLine 2 edited by B\n";
/** Overlapping: both add line 3 */
const OVERLAP_A = "Line 1\nLine 2\nLine 3 from A\n";
const OVERLAP_B = "Line 1\nLine 2\nLine 3 from B\n";

/** Helper to change a device's conflict resolution strategy at runtime */
function setStrategy(device: DeviceSimulator, strategy: string): void {
    (device as any).sm.settings.conflictResolutionStrategy = strategy;
}

describe("Conflict Resolution Strategies", () => {
    let cloud: MockCloudAdapter;
    let deviceA: DeviceSimulator;
    let deviceB: DeviceSimulator;

    beforeEach(async () => {
        cloud = new MockCloudAdapter();
        const buf = new TextEncoder().encode(ANCESTOR).buffer as ArrayBuffer;
        await cloud.uploadFile(FILE, buf, Date.now());

        deviceA = new DeviceSimulator("DeviceA", cloud, "dev_A");
        deviceB = new DeviceSimulator("DeviceB", cloud, "dev_B");

        const fileId = cloud.getFileId(FILE)!;
        deviceA.setupSyncedFile(FILE, ANCESTOR, fileId);
        deviceB.setupSyncedFile(FILE, ANCESTOR, fileId);
    });

    /**
     * A pushes editA, B has editB locally, B pulls → triggers conflict resolution.
     */
    async function triggerConflict(editA = EDIT_A, editB = EDIT_B): Promise<void> {
        deviceA.editFile(FILE, editA);
        await deviceA.pushFile(FILE);
        deviceB.editFile(FILE, editB);
        await deviceB.pullFile(FILE);
    }

    // ═══════════════════════════════════════════════════════════════════
    // force-local
    // ═══════════════════════════════════════════════════════════════════

    /** ローカル優先 — 競合時にローカル内容を保持、Pushでリモートを上書き */
    describe("force-local", () => {
        beforeEach(() => setStrategy(deviceB, "force-local"));

        it("should preserve local content and discard remote changes", async () => {
            await triggerConflict();

            const content = deviceB.getLocalContent(FILE)!;
            expect(content).toContain("Line 2 edited by B");
            expect(content).not.toContain("edited by A");
        });

        it("should not create a conflict file", async () => {
            await triggerConflict();

            const conflictFiles = deviceB.listLocalFiles().filter((f) => f.includes("Conflict"));
            expect(conflictFiles).toHaveLength(0);
        });

        it("should mark as merge (queued for push to overwrite remote)", async () => {
            await triggerConflict();

            const state = deviceB.describeState(FILE);
            expect(state.localIndex!.lastAction).toBe("merge");
            expect(state.isDirty).toBe(true);
        });

        it("should push local content to overwrite remote", async () => {
            await triggerConflict();

            const result = await deviceB.pushFile(FILE);
            expect(result.pushed).toBe(true);

            // Verify remote now has B's local content
            const meta = await cloud.getFileMetadata(FILE);
            const remote = new TextDecoder().decode(await cloud.downloadFile(meta!.id));
            expect(remote).toContain("edited by B");
            expect(remote).not.toContain("edited by A");
        });

        it("should handle overlapping edits by preserving local", async () => {
            await triggerConflict(OVERLAP_A, OVERLAP_B);

            const content = deviceB.getLocalContent(FILE)!;
            expect(content).toContain("Line 3 from B");
            expect(content).not.toContain("Line 3 from A");
        });

        it("should allow Device A to pull B's force-local result", async () => {
            await triggerConflict();
            await deviceB.pushFile(FILE);
            await deviceA.pullFile(FILE);

            // A now has B's content (A's edits were overwritten)
            const contentA = deviceA.getLocalContent(FILE)!;
            expect(contentA).toContain("edited by B");
            expect(contentA).not.toContain("edited by A");
            expect(contentA).toBe(deviceB.getLocalContent(FILE));
        });
    });

    // ═══════════════════════════════════════════════════════════════════
    // force-remote
    // ═══════════════════════════════════════════════════════════════════

    /** リモート優先 — 競合時にリモート内容を受け入れ、追加Pushは不要 */
    describe("force-remote", () => {
        beforeEach(() => setStrategy(deviceB, "force-remote"));

        it("should accept remote content and discard local changes", async () => {
            await triggerConflict();

            const content = deviceB.getLocalContent(FILE)!;
            expect(content).toContain("Line 1 edited by A");
            expect(content).not.toContain("edited by B");
        });

        it("should not create a conflict file", async () => {
            await triggerConflict();

            const conflictFiles = deviceB.listLocalFiles().filter((f) => f.includes("Conflict"));
            expect(conflictFiles).toHaveLength(0);
        });

        it("should mark as synced (no push needed)", async () => {
            await triggerConflict();

            const state = deviceB.describeState(FILE);
            // Content matches remote → treated as "pull" (already synced)
            expect(state.localIndex!.lastAction).toBe("pull");
            expect(state.isDirty).toBe(false);
        });

        it("should handle overlapping edits by accepting remote", async () => {
            await triggerConflict(OVERLAP_A, OVERLAP_B);

            const content = deviceB.getLocalContent(FILE)!;
            expect(content).toContain("Line 3 from A");
            expect(content).not.toContain("Line 3 from B");
        });

        it("should converge both devices without extra sync", async () => {
            await triggerConflict();

            // B already has remote content, no push needed
            const stateB = deviceB.describeState(FILE);
            expect(stateB.isDirty).toBe(false);

            // Both devices now have the same content
            const contentA = deviceA.getLocalContent(FILE);
            const contentB = deviceB.getLocalContent(FILE);
            expect(contentB).toBe(contentA);
        });
    });

    // ═══════════════════════════════════════════════════════════════════
    // always-fork
    // ═══════════════════════════════════════════════════════════════════

    /** 常にフォーク — 自動マージせず必ずコンフリクトファイルを生成 */
    describe("always-fork", () => {
        beforeEach(() => setStrategy(deviceB, "always-fork"));

        it("should always create a conflict file", async () => {
            await triggerConflict();

            const conflictFiles = deviceB.listLocalFiles().filter((f) => f.includes("Conflict"));
            expect(conflictFiles.length).toBeGreaterThanOrEqual(1);
        });

        it("should place remote content in the main file", async () => {
            await triggerConflict();

            const main = deviceB.getLocalContent(FILE)!;
            expect(main).toContain("edited by A");
        });

        it("should place local content in the conflict file", async () => {
            await triggerConflict();

            const conflictFile = deviceB.listLocalFiles().find((f) => f.includes("Conflict"))!;
            expect(conflictFile).toBeTruthy();

            const content = deviceB.getLocalContent(conflictFile)!;
            expect(content).toContain("edited by B");
        });

        it("should mark main file as synced with remote", async () => {
            await triggerConflict();

            const state = deviceB.describeState(FILE);
            expect(state.localIndex!.lastAction).toBe("pull");
            expect(state.isDirty).toBe(false);
        });

        it("should create conflict file even for non-overlapping edits (no auto-merge)", async () => {
            // Non-overlapping edits would normally auto-merge with smart-merge,
            // but always-fork should still create a conflict file.
            await triggerConflict();

            const conflictFiles = deviceB.listLocalFiles().filter((f) => f.includes("Conflict"));
            expect(conflictFiles.length).toBeGreaterThanOrEqual(1);
        });

        it("should name conflict file with timestamp pattern", async () => {
            await triggerConflict();

            const conflictFile = deviceB.listLocalFiles().find((f) => f.includes("Conflict"));
            // Expected format: notes/test (Conflict 2026-02-23T16-00-00).md
            expect(conflictFile).toMatch(/\(Conflict \d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\)/);
        });
    });

    // ═══════════════════════════════════════════════════════════════════
    // Runtime strategy switching
    // ═══════════════════════════════════════════════════════════════════

    /** ランタイム切り替え — 設定変更が次回の競合から即座に反映 */
    describe("runtime strategy switching", () => {
        it("should apply changed strategy on the next conflict (smart-merge → force-local)", async () => {
            // First conflict: smart-merge (default)
            await triggerConflict();

            const merged = deviceB.getLocalContent(FILE)!;
            expect(merged).toContain("edited by A");
            expect(merged).toContain("edited by B");

            // Push merged result and sync both devices
            await deviceB.pushFile(FILE);
            await deviceA.syncPull(FILE);

            // ── Switch to force-local ──
            setStrategy(deviceB, "force-local");

            // Create a second conflict from the merged base
            const editA2 = merged.replace("edited by A", "edited by A v2");
            const editB2 = merged.replace("edited by B", "edited by B v2");

            deviceA.editFile(FILE, editA2);
            await deviceA.pushFile(FILE);
            deviceB.editFile(FILE, editB2);
            await deviceB.pullFile(FILE);

            // Verify force-local was applied (not smart-merge)
            const result = deviceB.getLocalContent(FILE)!;
            expect(result).toContain("edited by B v2");
            expect(result).not.toContain("edited by A v2");
        });

        it("should switch from force-local to always-fork", async () => {
            // First conflict: force-local (no conflict file)
            setStrategy(deviceB, "force-local");
            await triggerConflict();

            expect(deviceB.listLocalFiles().filter((f) => f.includes("Conflict"))).toHaveLength(0);

            // Push and sync
            await deviceB.pushFile(FILE);
            await deviceA.syncPull(FILE);

            // ── Switch to always-fork ──
            setStrategy(deviceB, "always-fork");

            const base = deviceB.getLocalContent(FILE)!;
            const editA2 = base.replace("Line 2", "Line 2 v2 from A");
            const editB2 = base.replace("Line 2", "Line 2 v2 from B");

            deviceA.editFile(FILE, editA2);
            await deviceA.pushFile(FILE);
            deviceB.editFile(FILE, editB2);
            await deviceB.pullFile(FILE);

            // always-fork: conflict file created
            const conflictFiles = deviceB.listLocalFiles().filter((f) => f.includes("Conflict"));
            expect(conflictFiles.length).toBeGreaterThanOrEqual(1);
        });

        it("should switch from force-remote to smart-merge", async () => {
            // First conflict: force-remote (local discarded)
            setStrategy(deviceB, "force-remote");
            await triggerConflict();

            expect(deviceB.getLocalContent(FILE)).toContain("edited by A");
            expect(deviceB.getLocalContent(FILE)).not.toContain("edited by B");

            // Both have A's content now (force-remote synced)
            // ── Switch to smart-merge ──
            setStrategy(deviceB, "smart-merge");

            // Setup a new conflict
            const base = deviceB.getLocalContent(FILE)!;
            const editA2 = base.replace("Line 1 edited by A", "Line 1 A-v2");
            const editB2 = base.replace("Line 2", "Line 2 B-v2");

            deviceA.editFile(FILE, editA2);
            await deviceA.pushFile(FILE);
            deviceB.editFile(FILE, editB2);
            await deviceB.pullFile(FILE);

            // smart-merge: both edits preserved
            const result = deviceB.getLocalContent(FILE)!;
            expect(result).toContain("A-v2");
            expect(result).toContain("B-v2");
        });
    });

    // ═══════════════════════════════════════════════════════════════════
    // Edge case: non-text files (strategy not consulted for merge)
    // ═══════════════════════════════════════════════════════════════════

    /** バイナリファイル — ストラテジーを無視して常にコンフリクトファイル生成 */
    describe("non-text file conflict (strategy bypassed)", () => {
        const BIN_FILE = "data/config.json";
        const BIN_ANCESTOR = '{"version": 1}';
        const BIN_A = '{"version": 2, "author": "A"}';
        const BIN_B = '{"version": 2, "author": "B"}';

        beforeEach(async () => {
            const buf = new TextEncoder().encode(BIN_ANCESTOR).buffer as ArrayBuffer;
            await cloud.uploadFile(BIN_FILE, buf, Date.now());

            const fileId = cloud.getFileId(BIN_FILE)!;

            for (const device of [deviceA, deviceB]) {
                device.setupSyncedFile(BIN_FILE, BIN_ANCESTOR, fileId);
            }
        });

        it("should create conflict file regardless of strategy (force-local set)", async () => {
            setStrategy(deviceB, "force-local");

            // A pushes edit
            deviceA.editFile(BIN_FILE, BIN_A);
            await deviceA.pushFile(BIN_FILE);

            // B has different edit
            deviceB.editFile(BIN_FILE, BIN_B);

            // B pulls → .json is not .md/.txt → isText=false → strategy NOT consulted
            await deviceB.pullFile(BIN_FILE);

            const files = deviceB.listLocalFiles().filter((f) => f.includes("Conflict"));
            // Non-text files always go to CONFLICT FALLBACK
            expect(files.length).toBeGreaterThanOrEqual(1);
        });

        it("should create conflict file with force-remote set too", async () => {
            setStrategy(deviceB, "force-remote");

            deviceA.editFile(BIN_FILE, BIN_A);
            await deviceA.pushFile(BIN_FILE);
            deviceB.editFile(BIN_FILE, BIN_B);
            await deviceB.pullFile(BIN_FILE);

            const files = deviceB.listLocalFiles().filter((f) => f.includes("Conflict"));
            expect(files.length).toBeGreaterThanOrEqual(1);
        });
    });
});
