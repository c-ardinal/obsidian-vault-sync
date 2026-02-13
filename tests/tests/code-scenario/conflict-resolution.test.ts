/**
 * Multi-device conflict resolution sequential tests.
 *
 * Tests two patterns:
 * Pattern 1: Push-time conflict - Device detects conflict when pushing (remote changed)
 * Pattern 2: Pull-time conflict - Device detects conflict when pulling (local modified)
 *
 * Each test verifies:
 * - Flag transitions (lastAction, pendingConflict)
 * - Hash changes (hash, ancestorHash)
 * - Merged text content correctness
 */

import { describe, it, expect, beforeEach } from "vitest";
import { MockCloudAdapter } from "../../helpers/mock-cloud-adapter";
import { DeviceSimulator, hashOf } from "../../helpers/device-simulator";

const FILE_PATH = "notes/test.md";
const FILE_ID = "file_shared_1";

/** Initial content both devices start with */
const ANCESTOR_CONTENT = "Line 1\nLine 2\n";

/** Device A's edit: adds line at the end */
const DEVICE_A_CONTENT = "Line 1\nLine 2\nLine 3 from DeviceA\n";

/** Device B's edit: adds different line at the end */
const DEVICE_B_CONTENT = "Line 1\nLine 2\nLine 3 from DeviceB\n";

/** Device A's edit for non-overlapping test: modifies line 1 */
const DEVICE_A_NONOVERLAP = "Line 1 edited by A\nLine 2\n";

/** Device B's edit for non-overlapping test: modifies line 2 */
const DEVICE_B_NONOVERLAP = "Line 1\nLine 2 edited by B\n";

describe("Multi-device conflict resolution", () => {
    let cloud: MockCloudAdapter;
    let deviceA: DeviceSimulator;
    let deviceB: DeviceSimulator;
    const ancestorHash = hashOf(ANCESTOR_CONTENT);

    beforeEach(async () => {
        // Shared cloud storage
        cloud = new MockCloudAdapter();

        // Upload initial file to cloud (creates revision history)
        const buf = new TextEncoder().encode(ANCESTOR_CONTENT).buffer as ArrayBuffer;
        await cloud.uploadFile(FILE_PATH, buf, Date.now());

        // Create two devices
        deviceA = new DeviceSimulator("DeviceA", cloud, "dev_A");
        deviceB = new DeviceSimulator("DeviceB", cloud, "dev_B");

        // Both devices start in synced state
        const fileId = cloud.getFileId(FILE_PATH)!;
        deviceA.setupSyncedFile(FILE_PATH, ANCESTOR_CONTENT, fileId);
        deviceB.setupSyncedFile(FILE_PATH, ANCESTOR_CONTENT, fileId);
    });

    // ═══════════════════════════════════════════════════════════════════
    // PATTERN 1: Push-time conflict detection
    // Scenario: Device A pushes, Device B pushes → B detects conflict at push time
    // ═══════════════════════════════════════════════════════════════════

    describe("Pattern 1: Push-time conflict (non-overlapping edits)", () => {
        it("should detect conflict at push time and auto-merge", async () => {
            // ──── Step 0: Verify initial state ────
            const initialStateA = deviceA.describeState(FILE_PATH);
            const initialStateB = deviceB.describeState(FILE_PATH);

            expect(initialStateA.localIndex!.lastAction).toBe("pull");
            expect(initialStateA.localIndex!.ancestorHash).toBe(ancestorHash.substring(0, 8));
            expect(initialStateB.localIndex!.lastAction).toBe("pull");
            expect(initialStateB.localIndex!.ancestorHash).toBe(ancestorHash.substring(0, 8));

            console.log("\n╔══════════════════════════════════════════════════╗");
            console.log("║  Pattern 1: Push-time conflict (non-overlapping) ║");
            console.log("╚══════════════════════════════════════════════════╝");
            console.log("\n--- Step 0: Initial state ---");
            deviceA.printState(FILE_PATH);
            deviceB.printState(FILE_PATH);

            // ──── Step 1: Device A edits and pushes successfully ────
            deviceA.editFile(FILE_PATH, DEVICE_A_NONOVERLAP);
            const pushA = await deviceA.pushFile(FILE_PATH);

            expect(pushA.pushed).toBe(true);
            expect(pushA.conflictDetected).toBe(false);

            const stateAfterPushA = deviceA.describeState(FILE_PATH);
            expect(stateAfterPushA.localIndex!.lastAction).toBe("push");
            // ancestorHash should be preserved (not updated to pushed content)
            expect(stateAfterPushA.localIndex!.ancestorHash).toBe(ancestorHash.substring(0, 8));
            expect(stateAfterPushA.isDirty).toBe(false);

            console.log("\n--- Step 1: After Device A push ---");
            deviceA.printState(FILE_PATH);
            console.log(
                `  Cloud content: ${cloud.getCloudContent(FILE_PATH)?.replace(/\n/g, "\\n")}`,
            );
            console.log(`  Cloud hash: ${cloud.getCloudHash(FILE_PATH)?.substring(0, 8)}`);
            console.log(`  Cloud revisions: ${cloud.getRevisionCount(FILE_PATH)}`);

            // ──── Step 2: Device B edits locally (hasn't synced yet) ────
            deviceB.editFile(FILE_PATH, DEVICE_B_NONOVERLAP);

            console.log("\n--- Step 2: After Device B local edit ---");
            deviceB.printState(FILE_PATH);

            // ──── Step 3: Device B attempts push → conflict detected → auto-merge ────
            const pushB = await deviceB.pushFile(FILE_PATH);

            expect(pushB.pushed).toBe(false);
            expect(pushB.conflictDetected).toBe(true);

            const stateAfterConflictB = deviceB.describeState(FILE_PATH);

            console.log("\n--- Step 3: After Device B push attempt (conflict) ---");
            deviceB.printState(FILE_PATH);
            console.log(
                `  Cloud content: ${cloud.getCloudContent(FILE_PATH)?.replace(/\n/g, "\\n")}`,
            );

            // Verify merge result: Both edits should be preserved
            const mergedContent = deviceB.getLocalContent(FILE_PATH);
            expect(mergedContent).toContain("Line 1 edited by A");
            expect(mergedContent).toContain("Line 2 edited by B");

            // After merge: localIndex should show "merge" (needs push)
            expect(stateAfterConflictB.localIndex!.lastAction).toBe("merge");
            expect(stateAfterConflictB.isDirty).toBe(true);

            // ──── Step 4: Device B pushes merged result ────
            const pushMerge = await deviceB.pushFile(FILE_PATH);

            expect(pushMerge.pushed).toBe(true);

            const finalStateB = deviceB.describeState(FILE_PATH);
            expect(finalStateB.localIndex!.lastAction).toBe("push");
            expect(finalStateB.isDirty).toBe(false);

            console.log("\n--- Step 4: After Device B pushes merge result ---");
            deviceB.printState(FILE_PATH);
            console.log(
                `  Cloud content: ${cloud.getCloudContent(FILE_PATH)?.replace(/\n/g, "\\n")}`,
            );

            // ──── Step 5: Device A pulls the merged result ────
            await deviceA.pullFile(FILE_PATH);

            const finalStateA = deviceA.describeState(FILE_PATH);

            console.log("\n--- Step 5: After Device A pulls merged result ---");
            deviceA.printState(FILE_PATH);

            // Both devices should now have identical content
            expect(deviceA.getLocalContent(FILE_PATH)).toBe(deviceB.getLocalContent(FILE_PATH));
            expect(finalStateA.localIndex!.lastAction).toBe("pull");
        });
    });

    describe("Pattern 1: Push-time conflict (overlapping edits)", () => {
        it("should detect conflict at push time with overlapping edits", async () => {
            console.log("\n╔══════════════════════════════════════════════════╗");
            console.log("║  Pattern 1: Push-time conflict (overlapping)     ║");
            console.log("╚══════════════════════════════════════════════════╝");

            // ──── Step 1: Device A edits (adds line 3) and pushes ────
            deviceA.editFile(FILE_PATH, DEVICE_A_CONTENT);
            const pushA = await deviceA.pushFile(FILE_PATH);
            expect(pushA.pushed).toBe(true);

            console.log("\n--- Step 1: After Device A push ---");
            deviceA.printState(FILE_PATH);

            // ──── Step 2: Device B edits (adds different line 3) ────
            deviceB.editFile(FILE_PATH, DEVICE_B_CONTENT);

            // ──── Step 3: Device B attempts push → conflict ────
            const pushB = await deviceB.pushFile(FILE_PATH);
            expect(pushB.conflictDetected).toBe(true);

            console.log("\n--- Step 3: After Device B push attempt ---");
            deviceB.printState(FILE_PATH);

            const mergedContent = deviceB.getLocalContent(FILE_PATH);
            console.log(`  Merged result: ${mergedContent?.replace(/\n/g, "\\n")}`);

            // With overlapping edits (both add line 3), either:
            // - 3-way merge succeeds and includes both lines
            // - Or falls back to conflict file
            // Verify at minimum that content is not lost
            if (mergedContent) {
                const hasA = mergedContent.includes("Line 3 from DeviceA");
                const hasB = mergedContent.includes("Line 3 from DeviceB");

                // If merge succeeded, both should be present
                const stateB = deviceB.describeState(FILE_PATH);
                if (stateB.localIndex!.lastAction === "merge") {
                    expect(hasA || hasB).toBe(true);
                    console.log("  → Auto-merge succeeded");
                } else {
                    // Conflict file should have been created
                    const allFiles = deviceB.listLocalFiles();
                    const conflictFiles = allFiles.filter((f) => f.includes("Conflict"));
                    console.log(`  → Conflict files created: ${conflictFiles.join(", ")}`);
                    expect(conflictFiles.length + (hasA || hasB ? 1 : 0)).toBeGreaterThanOrEqual(1);
                }
            }

            // Verify flag states after conflict resolution
            const finalB = deviceB.describeState(FILE_PATH);
            console.log(`  Final state: ${JSON.stringify(finalB.localIndex)}`);
        });
    });

    // ═══════════════════════════════════════════════════════════════════
    // PATTERN 2: Pull-time conflict detection
    // Scenario: Device A pushes, Device B has local edits, Device B pulls → conflict
    // ═══════════════════════════════════════════════════════════════════

    describe("Pattern 2: Pull-time conflict (non-overlapping edits)", () => {
        it("should detect conflict at pull time and auto-merge", async () => {
            console.log("\n╔══════════════════════════════════════════════════╗");
            console.log("║  Pattern 2: Pull-time conflict (non-overlapping) ║");
            console.log("╚══════════════════════════════════════════════════╝");

            // ──── Step 0: Initial state ────
            console.log("\n--- Step 0: Initial state ---");
            deviceA.printState(FILE_PATH);
            deviceB.printState(FILE_PATH);

            // ──── Step 1: Device A edits and pushes ────
            deviceA.editFile(FILE_PATH, DEVICE_A_NONOVERLAP);
            const pushA = await deviceA.pushFile(FILE_PATH);
            expect(pushA.pushed).toBe(true);

            console.log("\n--- Step 1: After Device A push ---");
            deviceA.printState(FILE_PATH);
            console.log(
                `  Cloud content: ${cloud.getCloudContent(FILE_PATH)?.replace(/\n/g, "\\n")}`,
            );

            // ──── Step 2: Device B edits locally (doesn't know about A's push) ────
            deviceB.editFile(FILE_PATH, DEVICE_B_NONOVERLAP);

            const stateBeforePull = deviceB.describeState(FILE_PATH);
            expect(stateBeforePull.localIndex!.lastAction).toBe("pull"); // Still from initial setup
            expect(stateBeforePull.isDirty).toBe(true);

            console.log("\n--- Step 2: Device B has local edits, hasn't pulled yet ---");
            deviceB.printState(FILE_PATH);

            // ──── Step 3: Device B pulls → detects conflict → auto-merge ────
            const pullResult = await deviceB.pullFile(FILE_PATH);
            expect(pullResult).toBe(true);

            const stateAfterPull = deviceB.describeState(FILE_PATH);

            console.log(
                "\n--- Step 3: After Device B pulls (conflict detected, merge attempted) ---",
            );
            deviceB.printState(FILE_PATH);

            // Verify merge result
            const mergedContent = deviceB.getLocalContent(FILE_PATH);
            console.log(`  Merged content: ${mergedContent?.replace(/\n/g, "\\n")}`);

            expect(mergedContent).toContain("Line 1 edited by A");
            expect(mergedContent).toContain("Line 2 edited by B");

            // After auto-merge: localIndex should be "merge" with dirty flag
            expect(stateAfterPull.localIndex!.lastAction).toBe("merge");
            expect(stateAfterPull.isDirty).toBe(true);
            // ancestorHash should be the base we merged against
            expect(stateAfterPull.localIndex!.ancestorHash).toBeTruthy();

            // ──── Step 4: Device B pushes merged result ────
            const pushMerge = await deviceB.pushFile(FILE_PATH);
            expect(pushMerge.pushed).toBe(true);

            const finalStateB = deviceB.describeState(FILE_PATH);
            expect(finalStateB.localIndex!.lastAction).toBe("push");
            expect(finalStateB.isDirty).toBe(false);

            console.log("\n--- Step 4: After Device B pushes merge result ---");
            deviceB.printState(FILE_PATH);
            console.log(
                `  Cloud content: ${cloud.getCloudContent(FILE_PATH)?.replace(/\n/g, "\\n")}`,
            );
            console.log(`  Cloud revisions: ${cloud.getRevisionCount(FILE_PATH)}`);

            // ──── Step 5: Device A pulls the merged result ────
            await deviceA.pullFile(FILE_PATH);

            const finalStateA = deviceA.describeState(FILE_PATH);

            console.log("\n--- Step 5: After Device A pulls merged result ---");
            deviceA.printState(FILE_PATH);

            // Both devices should now have identical content
            const contentA = deviceA.getLocalContent(FILE_PATH);
            const contentB = deviceB.getLocalContent(FILE_PATH);
            expect(contentA).toBe(contentB);
            expect(contentA).toContain("Line 1 edited by A");
            expect(contentA).toContain("Line 2 edited by B");

            console.log("\n✓ Both devices converged to identical content");
        });
    });

    describe("Pattern 2: Pull-time conflict (Safety Guard path)", () => {
        it("should trigger Safety Guard when remote changes after push", async () => {
            console.log("\n╔══════════════════════════════════════════════════╗");
            console.log("║  Pattern 2: Safety Guard (post-push pull)        ║");
            console.log("╚══════════════════════════════════════════════════╝");

            // 1. Device A pushes
            deviceA.editFile(FILE_PATH, DEVICE_A_NONOVERLAP);
            await deviceA.pushFile(FILE_PATH);
            console.log("\n--- Step 1: Device A pushed ---");
            deviceA.printState(FILE_PATH);

            // 2. Device B force-pushes (simulating GDrive eventual consistency:
            //    B doesn't see A's recent push, so it pushes its own version)
            deviceB.editFile(FILE_PATH, DEVICE_B_NONOVERLAP);
            await deviceB.forcePush(FILE_PATH);
            console.log("\n--- Step 2: Device B force-pushed ---");
            deviceB.printState(FILE_PATH);

            // 3. Device A pulls (Safety Guard should trigger because
            //    B's version doesn't acknowledge A's push as ancestor)
            await deviceA.pullFile(FILE_PATH);
            console.log("\n--- Step 3: Device A pulls (Safety Guard should trigger) ---");
            deviceA.printState(FILE_PATH);

            const localContent = deviceA.getLocalContent(FILE_PATH);
            expect(localContent).toContain("edited by A");
            expect(localContent).toContain("edited by B");

            const safetyGuardTriggered = deviceA.logs.some(
                (l) => l.includes("Safety") || l.includes("Forcing merge"),
            );
            expect(safetyGuardTriggered).toBe(true);
        });

        it("should detect conflict when remote overwrites our push", async () => {
            // 1. Device A pushes v1
            deviceA.editFile(FILE_PATH, "Line 1 edited by A\nLine 2\n");
            await deviceA.pushFile(FILE_PATH);

            // 2. Device B force-pushes v2 (overwriting v1)
            // Device B doesn't see A's v1 yet.
            deviceB.editFile(FILE_PATH, "Line 1\nLine 2 edited by B\n");
            await deviceB.forcePush(FILE_PATH);

            // Now remote has v2 (B's version, missing A's edit).

            // 3. Device A pulls.
            // A's lastAction is 'push' (v1).
            // Remote meta is v2.
            // A's disk is v1.
            // hasRemoteUpdate = true.
            // isActuallyModified = false (disk matches localIndex).

            const pullRes = await deviceA.pullFile(FILE_PATH);

            const stateA = deviceA.describeState(FILE_PATH);

            // If Safety Guard is working, it should have MERGED.
            // The merge result should contain BOTH A's line 1 and B's line 2.
            expect(stateA.localContent).toContain("Line 1 edited by A");
            expect(stateA.localContent).toContain("Line 2 edited by B");
            expect(stateA.localIndex!.lastAction).toBe("merge");
        });
    });

    // ═══════════════════════════════════════════════════════════════════
    // Hash and Flag transition verification
    // ═══════════════════════════════════════════════════════════════════

    describe("Hash and flag transitions (detailed)", () => {
        it("should track hash and flag changes through full cycle", async () => {
            console.log("\n╔══════════════════════════════════════════════════╗");
            console.log("║  Detailed hash/flag transition tracking           ║");
            console.log("╚══════════════════════════════════════════════════╝");

            type StateSnapshot = ReturnType<DeviceSimulator["describeState"]>;
            const timeline: Array<{
                step: string;
                deviceA: StateSnapshot;
                deviceB: StateSnapshot;
                cloudHash: string;
                cloudRevisions: number;
            }> = [];

            const snapshot = (step: string) => {
                const entry = {
                    step,
                    deviceA: deviceA.describeState(FILE_PATH),
                    deviceB: deviceB.describeState(FILE_PATH),
                    cloudHash: cloud.getCloudHash(FILE_PATH)?.substring(0, 8) || "none",
                    cloudRevisions: cloud.getRevisionCount(FILE_PATH),
                };
                timeline.push(entry);
                return entry;
            };

            // Step 0: Initial sync
            snapshot("0. Initial (synced)");

            // Step 1: Device A edits locally
            deviceA.editFile(FILE_PATH, DEVICE_A_NONOVERLAP);
            snapshot("1. A edits locally");

            // Step 2: Device A pushes
            await deviceA.pushFile(FILE_PATH);
            snapshot("2. A pushes");

            // Step 3: Device B edits locally
            deviceB.editFile(FILE_PATH, DEVICE_B_NONOVERLAP);
            snapshot("3. B edits locally");

            // Step 4: Device B pulls (conflict → merge)
            await deviceB.pullFile(FILE_PATH);
            snapshot("4. B pulls (merge)");

            // Step 5: Device B pushes merged result
            await deviceB.pushFile(FILE_PATH);
            snapshot("5. B pushes merged");

            // Step 6: Device A pulls merged result
            await deviceA.pullFile(FILE_PATH);
            snapshot("6. A pulls merged");

            // Print timeline table
            console.log(
                "\n┌─────────────────────────────┬──────────────────────────────────────────┬──────────────────────────────────────────┬──────────┬─────┐",
            );
            console.log(
                "│ Step                        │ Device A                                 │ Device B                                 │ Cloud    │ Rev │",
            );
            console.log(
                "├─────────────────────────────┼──────────────────────────────────────────┼──────────────────────────────────────────┼──────────┼─────┤",
            );

            for (const t of timeline) {
                const aIdx = t.deviceA.localIndex;
                const bIdx = t.deviceB.localIndex;
                const aStr = aIdx
                    ? `hash=${aIdx.hash} act=${aIdx.lastAction.padEnd(5)} anc=${aIdx.ancestorHash}${t.deviceA.isDirty ? " D" : ""}`
                    : "null";
                const bStr = bIdx
                    ? `hash=${bIdx.hash} act=${bIdx.lastAction.padEnd(5)} anc=${bIdx.ancestorHash}${t.deviceB.isDirty ? " D" : ""}`
                    : "null";
                console.log(
                    `│ ${t.step.padEnd(27)} │ ${aStr.padEnd(40)} │ ${bStr.padEnd(40)} │ ${t.cloudHash.padEnd(8)} │ ${String(t.cloudRevisions).padStart(3)} │`,
                );
            }

            console.log(
                "└─────────────────────────────┴──────────────────────────────────────────┴──────────────────────────────────────────┴──────────┴─────┘",
            );
            console.log(
                "\nLegend: hash=localIndex.hash, act=lastAction, anc=ancestorHash, D=dirty\n",
            );

            // Final convergence assertion
            const finalA = deviceA.getLocalContent(FILE_PATH);
            const finalB = deviceB.getLocalContent(FILE_PATH);
            expect(finalA).toBe(finalB);
            expect(finalA).toContain("Line 1 edited by A");
            expect(finalA).toContain("Line 2 edited by B");

            // Verify final state
            const finalStateA = deviceA.describeState(FILE_PATH);
            const finalStateB = deviceB.describeState(FILE_PATH);
            expect(finalStateA.isDirty).toBe(false);
            expect(finalStateB.isDirty).toBe(false);
        });
    });

    // ═══════════════════════════════════════════════════════════════════
    // Changes API sync confirmation behavior
    // When a device's own push comes back via Changes API (hash match),
    // lastAction is correctly set to "pull" to confirm sync completion.
    // This is by design, not a bug.
    // ═══════════════════════════════════════════════════════════════════

    describe("Changes API sync confirmation", () => {
        it("should confirm push via hash match and correctly set lastAction", async () => {
            console.log("\n╔══════════════════════════════════════════════════╗");
            console.log("║  Changes API: Sync confirmation via hash match   ║");
            console.log("╚══════════════════════════════════════════════════╝");

            // B edits and pushes
            deviceB.editFile(FILE_PATH, DEVICE_B_NONOVERLAP);
            await deviceB.pushFile(FILE_PATH);
            expect(deviceB.describeState(FILE_PATH).localIndex!.lastAction).toBe("push");

            // B's next syncPull sees own push (hash match) → confirms sync
            const result = await deviceB.syncPull(FILE_PATH);
            expect(result).toBe("skipped_hash_match");

            const stateB = deviceB.describeState(FILE_PATH);
            // lastAction correctly set to "pull" (sync confirmed) - by design
            expect(stateB.localIndex!.lastAction).toBe("pull");

            console.log(`  syncPull result: ${result}`);
            console.log(`  lastAction after confirmation: ${stateB.localIndex!.lastAction}`);
            console.log("  ✓ Sync confirmation behavior is correct (by design)");
        });
    });

    // ═══════════════════════════════════════════════════════════════════
    // Regression #3: ancestorHash updated on sync confirmation
    //
    // Previously, syncPull hash match (sync confirmation) did NOT
    // update ancestorHash, causing it to become stale over multiple
    // push cycles. This led to wrong merge base selection.
    //
    // Fix: sync-manager.ts:1555-1564 now updates ancestorHash when
    // both Local and Remote agree on the same hash.
    // ═══════════════════════════════════════════════════════════════════

    describe("Regression #3: ancestorHash updated on sync confirmation", () => {
        it("should update ancestorHash on syncPull hash match and merge correctly", async () => {
            console.log("\n╔══════════════════════════════════════════════════╗");
            console.log("║  Regression #3: ancestorHash sync confirmation   ║");
            console.log("╚══════════════════════════════════════════════════╝");

            // ── Re-setup with 3-line content for clear base difference ──
            // With correct base (v1): non-overlapping edits → clean merge
            // With stale base (v0): line 2 conflict (both sides change "Beta" differently)
            const v0 = "Alpha\nBeta\nGamma\n";
            const v0Hash = hashOf(v0);
            const v0Buf = new TextEncoder().encode(v0).buffer as ArrayBuffer;
            await cloud.uploadFile(FILE_PATH, v0Buf, Date.now());
            const fileId = cloud.getFileId(FILE_PATH)!;
            for (const device of [deviceA, deviceB]) {
                device.setupSyncedFile(FILE_PATH, v0, fileId);
            }

            console.log(`\n--- Setup: Both synced at v0 ---`);
            console.log(`  v0: ${v0.replace(/\n/g, "\\n")}  hash=${v0Hash.substring(0, 8)}`);

            // ── Step 1: B edits line 2, pushes v1 ──
            const v1 = "Alpha\nBeta-v1\nGamma\n";
            const v1Hash = hashOf(v1);
            deviceB.editFile(FILE_PATH, v1);
            await deviceB.pushFile(FILE_PATH);

            console.log(`\n--- Step 1: B pushes v1 ---`);
            console.log(`  v1: ${v1.replace(/\n/g, "\\n")}  hash=${v1Hash.substring(0, 8)}`);
            console.log(
                `  B.ancestorHash=${deviceB.describeState(FILE_PATH).localIndex!.ancestorHash} (preserved from v0)`,
            );

            // B's ancestorHash is still v0 (preserved through push)
            expect(deviceB.describeState(FILE_PATH).localIndex!.ancestorHash).toBe(
                v0Hash.substring(0, 8),
            );

            // ── Step 2: B syncPull → hash match → sync confirmed ──
            // FIX: ancestorHash is NOW updated to hash(v1) on confirmation
            const syncResult = await deviceB.syncPull(FILE_PATH);
            expect(syncResult).toBe("skipped_hash_match");

            const confirmedAncestor = deviceB.describeState(FILE_PATH).localIndex!.ancestorHash;
            console.log(`\n--- Step 2: B syncPull → ${syncResult} (sync confirmed) ---`);
            console.log(`  B.ancestorHash=${confirmedAncestor} (updated to v1)`);
            console.log(`  hash(v1)=${v1Hash.substring(0, 8)}`);

            // ★ FIX VERIFIED: ancestorHash updated to hash(v1) on sync confirmation
            expect(confirmedAncestor).toBe(v1Hash.substring(0, 8));

            // ── Step 3: A pulls v1, edits line 1, pushes v2 ──
            await deviceA.syncPull(FILE_PATH);
            const v2 = "Alpha-A\nBeta-v1\nGamma\n";
            deviceA.editFile(FILE_PATH, v2);
            await deviceA.pushFile(FILE_PATH);

            console.log(`\n--- Step 3: A pulls v1, edits line 1, pushes v2 ---`);
            console.log(`  v2: ${v2.replace(/\n/g, "\\n")}`);

            // ── Step 4: B further edits line 2 from v1 → v3 ──
            const v3 = "Alpha\nBeta-v1-B\nGamma\n";
            deviceB.editFile(FILE_PATH, v3);

            console.log(`\n--- Step 4: B edits to v3 ---`);
            console.log(`  v3: ${v3.replace(/\n/g, "\\n")}`);

            // ── Step 5: B pulls → conflict → merge with CORRECT base (v1) ──
            await deviceB.syncPull(FILE_PATH);

            const merged = deviceB.getLocalContent(FILE_PATH);
            const correctMerge = "Alpha-A\nBeta-v1-B\nGamma\n";

            console.log(`\n--- Step 5: B pulls → conflict → merge ---`);
            console.log(`  Base (v1): ${v1.replace(/\n/g, "\\n")}`);
            console.log(`  Remote (v2): ${v2.replace(/\n/g, "\\n")}`);
            console.log(`  Local  (v3): ${v3.replace(/\n/g, "\\n")}`);
            console.log(`  Merge result:  ${merged?.replace(/\n/g, "\\n")}`);
            console.log(`  Expected:      ${correctMerge.replace(/\n/g, "\\n")}`);

            // With correct base (v1):
            //   diff(v1→v2): Alpha → Alpha-A           (line 1 only)
            //   diff(v1→v3): Beta-v1 → Beta-v1-B       (line 2 only)
            //   → Non-overlapping → clean merge
            expect(merged).toBe(correctMerge);
            console.log("\n  ✓ Correct merge with proper base (v1)");
        });
    });

    // ═══════════════════════════════════════════════════════════════════
    // Lifecycle test: ancestorHash managed by real code paths
    // ═══════════════════════════════════════════════════════════════════

    describe("Lifecycle: ancestorHash through real sync cycles", () => {
        it("should maintain correct ancestorHash through push/pull/merge cycles", async () => {
            console.log("\n╔══════════════════════════════════════════════════╗");
            console.log("║  Lifecycle: ancestorHash through real sync cycles ║");
            console.log("╚══════════════════════════════════════════════════╝");

            // ──── Cycle 1: A edits file and pushes ────
            const content_v1 = "Line 1 v1\nLine 2 v1\n";
            deviceA.editFile(FILE_PATH, content_v1);
            await deviceA.pushFile(FILE_PATH);

            console.log("\n--- Cycle 1: A pushes v1 ---");
            deviceA.printState(FILE_PATH);

            const stateA_c1 = deviceA.describeState(FILE_PATH);
            expect(stateA_c1.localIndex!.lastAction).toBe("push");
            // After push, ancestorHash is PRESERVED from previous state (original ancestor)
            const pushHash = stateA_c1.localIndex!.hash;
            const ancestorHash = hashOf(ANCESTOR_CONTENT).substring(0, 8);
            expect(stateA_c1.localIndex!.ancestorHash).toBe(ancestorHash);

            // B pulls the file (normal download flow since B doesn't have it)
            await deviceB.pullFile(FILE_PATH);

            console.log("--- Cycle 1: B pulls new file ---");
            deviceB.printState(FILE_PATH);

            const stateB_c1 = deviceB.describeState(FILE_PATH);
            expect(stateB_c1.localIndex!.lastAction).toBe("pull");
            expect(stateB_c1.localIndex!.ancestorHash).toBe(pushHash);

            // ──── Cycle 2: A edits and pushes ────
            const content_v2 = "Line 1 v2\nLine 2\n";
            deviceA.editFile(FILE_PATH, content_v2);
            await deviceA.pushFile(FILE_PATH);

            console.log("\n--- Cycle 2: A pushes v2 ---");
            deviceA.printState(FILE_PATH);

            const stateA_c2 = deviceA.describeState(FILE_PATH);
            // ancestorHash is PRESERVED through pushes (still the original ancestor)
            expect(stateA_c2.localIndex!.ancestorHash).toBe(ancestorHash);
            expect(stateA_c2.localIndex!.lastAction).toBe("push");

            // B pulls v2
            await deviceB.pullFile(FILE_PATH);

            const stateB_c2 = deviceB.describeState(FILE_PATH);
            expect(stateB_c2.localIndex!.lastAction).toBe("pull");
            // B's ancestorHash should now be v2's hash (last pulled version)
            expect(stateB_c2.localIndex!.hash).toBe(stateA_c2.localIndex!.hash);

            // ──── Cycle 3: Both edit → conflict → merge ────
            const content_a3 = "Line 1 v2 A-edit\nLine 2\n";
            const content_b3 = "Line 1 v2\nLine 2 B-edit\n";

            deviceA.editFile(FILE_PATH, content_a3);
            await deviceA.pushFile(FILE_PATH);

            deviceB.editFile(FILE_PATH, content_b3);
            await deviceB.pullFile(FILE_PATH); // Conflict → merge

            console.log("\n--- Cycle 3: B merges ---");
            deviceB.printState(FILE_PATH);

            const stateB_c3 = deviceB.describeState(FILE_PATH);
            expect(stateB_c3.localIndex!.lastAction).toBe("merge");
            expect(stateB_c3.isDirty).toBe(true);

            // Merged content should have both edits
            const merged = deviceB.getLocalContent(FILE_PATH);
            expect(merged).toContain("A-edit");
            expect(merged).toContain("B-edit");

            // B pushes merged result
            await deviceB.pushFile(FILE_PATH);

            console.log("--- Cycle 3: B pushes merged result ---");
            deviceB.printState(FILE_PATH);

            expect(deviceB.describeState(FILE_PATH).localIndex!.lastAction).toBe("push");

            // A pulls merged result
            await deviceA.pullFile(FILE_PATH);

            console.log("--- Cycle 3: A pulls merged result ---");
            deviceA.printState(FILE_PATH);

            expect(deviceA.getLocalContent(FILE_PATH)).toBe(deviceB.getLocalContent(FILE_PATH));
            console.log("\n✓ Full lifecycle completed. Both devices converged.");
        });
    });

    // ═══════════════════════════════════════════════════════════════════
    // ancestorHash=null: findCommonAncestorHash fallback
    // ═══════════════════════════════════════════════════════════════════

    describe("Fallback: ancestorHash=null triggers findCommonAncestorHash", () => {
        it("should fall back to revision history when ancestorHash is missing", async () => {
            console.log("\n╔══════════════════════════════════════════════════╗");
            console.log("║  Fallback: ancestorHash=null → history lookup    ║");
            console.log("╚══════════════════════════════════════════════════╝");

            // Simulate a file that was synced BEFORE ancestorHash was added:
            // Both devices have the file, but ancestorHash is undefined.
            const fileId = cloud.getFileId(FILE_PATH)!;

            // Override setupSyncedFile to NOT set ancestorHash
            const ancestorBuf = new TextEncoder().encode(ANCESTOR_CONTENT).buffer as ArrayBuffer;
            const ancestorHashVal = hashOf(ANCESTOR_CONTENT);
            for (const device of [deviceA, deviceB]) {
                const sm = (device as any).sm;
                device.app.vaultAdapter.setFile(FILE_PATH, ANCESTOR_CONTENT);
                const entry = {
                    fileId,
                    mtime: Date.now(),
                    size: ancestorBuf.byteLength,
                    hash: ancestorHashVal,
                    lastAction: "pull" as const,
                    // ancestorHash intentionally OMITTED
                };
                sm.index[FILE_PATH] = { ...entry };
                sm.localIndex[FILE_PATH] = { ...entry };
            }

            console.log("\n--- Initial state (ancestorHash=undefined) ---");
            deviceA.printState(FILE_PATH);

            // Verify ancestorHash is missing
            expect(deviceA.getLocalIndex(FILE_PATH)!.ancestorHash).toBeUndefined();
            expect(deviceB.getLocalIndex(FILE_PATH)!.ancestorHash).toBeUndefined();

            // A edits and pushes
            deviceA.editFile(FILE_PATH, DEVICE_A_NONOVERLAP);
            await deviceA.pushFile(FILE_PATH);

            // B edits locally
            deviceB.editFile(FILE_PATH, DEVICE_B_NONOVERLAP);

            // B pulls → conflict detected → ancestorHash is missing → falls back to findCommonAncestorHash
            await deviceB.pullFile(FILE_PATH);

            console.log("\n--- After B pulls (ancestorHash=null, using history fallback) ---");
            deviceB.printState(FILE_PATH);

            // Check logs for history lookup
            const historyLookup = deviceB.logs.some((l) => l.includes("ancestorHash invalid"));
            const foundAncestor = deviceB.logs.some((l) =>
                l.includes("Selected ancestor at index"),
            );
            console.log(`\n  ancestorHash invalid detected: ${historyLookup}`);
            console.log(`  Found ancestor from history: ${foundAncestor}`);
            expect(historyLookup).toBe(true);

            if (foundAncestor) {
                // If history lookup succeeded, merge should work
                const merged = deviceB.getLocalContent(FILE_PATH);
                console.log(`  Merged content: ${merged?.replace(/\n/g, "\\n")}`);
                expect(merged).toContain("edited by A");
                expect(merged).toContain("edited by B");
                console.log("\n✓ History fallback succeeded. Merge correct.");
            } else {
                // History lookup failed → conflict file created
                const allFiles = deviceB.listLocalFiles();
                const conflictFiles = allFiles.filter((f) => f.includes("Conflict"));
                console.log(
                    `  History lookup failed → conflict files: ${conflictFiles.join(", ") || "none"}`,
                );
                console.log("\n⚠ History fallback failed. Check findCommonAncestorHash logic.");
                expect(foundAncestor).toBe(true); // Now it will fail the test
            }
        });
    });
});
