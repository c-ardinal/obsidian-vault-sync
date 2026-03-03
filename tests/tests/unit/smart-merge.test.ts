/**
 * @file SmartMergeStrategy unit tests for branch coverage
 *
 * @description
 * Tests for uncovered branches in smart-merge.ts:
 * 1. Bulk apply failure + atomic recovery (lines 99-113)
 * 2. Decode error handling (lines 117-130)
 * 3. Validation failed path (lines 137-155)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { MockInstance } from "vitest";

// Import modules first to understand the structure
import * as historyModule from "../../../src/sync-manager/history";
import * as diffMatchPatchModule from "diff-match-patch";

// Mock the history module (no coverage issue since we're testing smart-merge)
vi.mock("../../../src/sync-manager/history", async () => {
    const actual = await vi.importActual<typeof historyModule>("../../../src/sync-manager/history");
    return {
        ...actual,
        listRevisions: vi.fn(),
        getRevisionContent: vi.fn(),
    };
});

vi.mock("../../../src/sync-manager/file-utils", async () => {
    return {
        normalizeLineEndings: vi.fn((s: string) => s.replace(/\r\n/g, "\n")),
    };
});

// Import the strategy after mocking dependencies
import { SmartMergeStrategy } from "../../../src/sync-manager/strategies/smart-merge";

describe("SmartMergeStrategy branch coverage", () => {
    let strategy: SmartMergeStrategy;
    let mockCtx: any;

    beforeEach(async () => {
        vi.clearAllMocks();
        strategy = new SmartMergeStrategy();
        mockCtx = {
            log: vi.fn().mockResolvedValue(undefined),
        };
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    /**
     * Test: Bulk apply failure + atomic recovery (lines 99-113)
     * Scenario: patch_apply returns some failures, triggering atomic recovery
     */
    describe("bulk apply failure + atomic recovery", () => {
        it("should attempt atomic recovery when bulk apply fails", async () => {
            const baseContent = "line1\nline2\nline3";
            const localContent = "line1\nline2_modified\nline3";
            const remoteContent = "line1\nline2\nline3_remote";

            // Mock revisions
            vi.mocked(historyModule.listRevisions).mockResolvedValue([
                { id: "rev1", hash: "abc123", modifiedTime: Date.now(), size: 100 },
            ]);
            vi.mocked(historyModule.getRevisionContent).mockResolvedValue(
                new TextEncoder().encode(baseContent).buffer as ArrayBuffer,
            );

            // Create spy on diff_match_patch prototype methods
            const diffMainSpy = vi
                .spyOn(diffMatchPatchModule.diff_match_patch.prototype, "diff_main")
                .mockReturnValue([[0, "test"]]);
            const patchMakeSpy = vi
                .spyOn(diffMatchPatchModule.diff_match_patch.prototype, "patch_make")
                .mockReturnValue([{ diffs: [] }, { diffs: [] }, { diffs: [] }] as any);

            // Setup patch_apply to fail on bulk but succeed on atomic
            const patchApplySpy = vi
                .spyOn(diffMatchPatchModule.diff_match_patch.prototype, "patch_apply")
                .mockReturnValueOnce(["bulk_failed", [true, false, false]]) // bulk fails
                .mockReturnValueOnce(["atomic1", [true]]) // atomic patch 0
                .mockReturnValueOnce(["atomic2", [false]]) // atomic patch 1 fails
                .mockReturnValueOnce(["atomic3", [true]]); // atomic patch 2

            await strategy.merge({
                ctx: mockCtx,
                path: "test.md",
                localContent: localContent,
                remoteContent: remoteContent,
                baseHash: "abc123",
            });

            // Verify atomic recovery was attempted (patch_apply called multiple times)
            expect(patchApplySpy.mock.calls.length).toBeGreaterThanOrEqual(4);

            // Verify warning log was called
            const warnCalls = mockCtx.log.mock.calls.filter(
                (call: any[]) => call[1] === "warn" && call[0].includes("Bulk apply failed"),
            );
            expect(warnCalls.length).toBeGreaterThan(0);

            diffMainSpy.mockRestore();
            patchMakeSpy.mockRestore();
            patchApplySpy.mockRestore();
        });
    });

    /**
     * Test: Decode error handling (lines 117-130)
     * Scenario: mergedChars contains char codes >= lineArray.length
     */
    describe("decode error handling", () => {
        it("should handle decode errors when idx >= lineArray.length", async () => {
            const baseContent = "line1\nline2";
            const localContent = "line1\nline2";
            const remoteContent = "line1\nline2\nline3";

            // Mock revisions
            vi.mocked(historyModule.listRevisions).mockResolvedValue([
                { id: "rev1", hash: "abc123", modifiedTime: Date.now(), size: 100 },
            ]);
            vi.mocked(historyModule.getRevisionContent).mockResolvedValue(
                new TextEncoder().encode(baseContent).buffer as ArrayBuffer,
            );

            const diffMainSpy = vi
                .spyOn(diffMatchPatchModule.diff_match_patch.prototype, "diff_main")
                .mockReturnValue([[0, "test"]]);
            const patchMakeSpy = vi
                .spyOn(diffMatchPatchModule.diff_match_patch.prototype, "patch_make")
                .mockReturnValue([{ diffs: [] }] as any);

            // Return a string with high char code that will cause decode error
            // linesToChars3 creates lineArray: ["", "line1", "line2", "line3"]
            // So valid indices are 0, 1, 2, 3. Index 100 will cause error.
            const highCharCode = String.fromCharCode(100);
            const patchApplySpy = vi
                .spyOn(diffMatchPatchModule.diff_match_patch.prototype, "patch_apply")
                .mockReturnValue([highCharCode, [true]]);

            await strategy.merge({
                ctx: mockCtx,
                path: "test.md",
                localContent: localContent,
                remoteContent: remoteContent,
                baseHash: "abc123",
            });

            // Verify decode error warning was logged
            const decodeErrorCalls = mockCtx.log.mock.calls.filter(
                (call: any[]) =>
                    call[1] === "warn" && call[0].includes("Encoding error during decode"),
            );
            expect(decodeErrorCalls.length).toBeGreaterThan(0);

            diffMainSpy.mockRestore();
            patchMakeSpy.mockRestore();
            patchApplySpy.mockRestore();
        });

        it("should continue to next margin after decode error", async () => {
            const baseContent = "A\nB";
            const localContent = "A\nB";
            const remoteContent = "A\nB\nC";

            vi.mocked(historyModule.listRevisions).mockResolvedValue([
                { id: "rev1", hash: "abc123", modifiedTime: Date.now(), size: 100 },
            ]);
            vi.mocked(historyModule.getRevisionContent).mockResolvedValue(
                new TextEncoder().encode(baseContent).buffer as ArrayBuffer,
            );

            const diffMainSpy = vi
                .spyOn(diffMatchPatchModule.diff_match_patch.prototype, "diff_main")
                .mockReturnValue([[0, "test"]]);
            const patchMakeSpy = vi
                .spyOn(diffMatchPatchModule.diff_match_patch.prototype, "patch_make")
                .mockReturnValue([{ diffs: [] }] as any);

            // First margin: decode error (high char code)
            // Second margin: success with valid indices
            const patchApplySpy = vi
                .spyOn(diffMatchPatchModule.diff_match_patch.prototype, "patch_apply")
                .mockReturnValueOnce([String.fromCharCode(1000), [true]]) // decode error
                .mockReturnValueOnce(["\u0000\u0001\u0002", [true]]); // success

            await strategy.merge({
                ctx: mockCtx,
                path: "test.md",
                localContent: localContent,
                remoteContent: remoteContent,
                baseHash: "abc123",
            });

            // Should have tried multiple margins
            expect(patchApplySpy).toHaveBeenCalledTimes(2);

            diffMainSpy.mockRestore();
            patchMakeSpy.mockRestore();
            patchApplySpy.mockRestore();
        });
    });

    /**
     * Test: Validation failed path (lines 137-155)
     * Scenario: localAddedLines has content but mergedLines is missing some lines
     */
    describe("validation failed path", () => {
        it("should detect when local lines are lost in merge", async () => {
            const baseContent = "base line";
            const localContent = "base line\nlocal unique line";
            const remoteContent = "base line\nremote change";

            vi.mocked(historyModule.listRevisions).mockResolvedValue([
                { id: "rev1", hash: "abc123", modifiedTime: Date.now(), size: 100 },
            ]);
            vi.mocked(historyModule.getRevisionContent).mockResolvedValue(
                new TextEncoder().encode(baseContent).buffer as ArrayBuffer,
            );

            const diffMainSpy = vi
                .spyOn(diffMatchPatchModule.diff_match_patch.prototype, "diff_main")
                .mockReturnValue([[0, "test"]]);
            const patchMakeSpy = vi
                .spyOn(diffMatchPatchModule.diff_match_patch.prototype, "patch_make")
                .mockReturnValue([{ diffs: [] }] as any);

            // linesToChars3 result mapping:
            // base: "base line" -> idx 1
            // local unique: "local unique line" -> idx 2
            // remote change: "remote change" -> idx 3
            // Merged result only has base + remote (indices 0, 1, 3)
            // This loses the local unique line (idx 2)
            const patchApplySpy = vi
                .spyOn(diffMatchPatchModule.diff_match_patch.prototype, "patch_apply")
                .mockReturnValue(["\u0000\u0001\u0003", [true]]);

            await strategy.merge({
                ctx: mockCtx,
                path: "test.md",
                localContent: localContent,
                remoteContent: remoteContent,
                baseHash: "abc123",
            });

            // Verify validation failed warning was logged
            const validationFailedCalls = mockCtx.log.mock.calls.filter(
                (call: any[]) => call[1] === "warn" && call[0].includes("VALIDATION FAILED"),
            );
            expect(validationFailedCalls.length).toBeGreaterThan(0);

            diffMainSpy.mockRestore();
            patchMakeSpy.mockRestore();
            patchApplySpy.mockRestore();
        });

        it("should try all margins when validation keeps failing", async () => {
            const baseContent = "base";
            const localContent = "base\nLOCAL_ONLY";
            const remoteContent = "base\nREMOTE_ONLY";

            vi.mocked(historyModule.listRevisions).mockResolvedValue([
                { id: "rev1", hash: "abc123", modifiedTime: Date.now(), size: 100 },
            ]);
            vi.mocked(historyModule.getRevisionContent).mockResolvedValue(
                new TextEncoder().encode(baseContent).buffer as ArrayBuffer,
            );

            const diffMainSpy = vi
                .spyOn(diffMatchPatchModule.diff_match_patch.prototype, "diff_main")
                .mockReturnValue([[0, "test"]]);
            const patchMakeSpy = vi
                .spyOn(diffMatchPatchModule.diff_match_patch.prototype, "patch_make")
                .mockReturnValue([{ diffs: [] }] as any);

            // All margins fail validation (lose local line)
            // Return merged result without LOCAL_ONLY (only has base at idx 1)
            const patchApplySpy = vi
                .spyOn(diffMatchPatchModule.diff_match_patch.prototype, "patch_apply")
                .mockReturnValue(["\u0000\u0001", [true]]);

            const result = await strategy.merge({
                ctx: mockCtx,
                path: "test.md",
                localContent: localContent,
                remoteContent: remoteContent,
                baseHash: "abc123",
            });

            // Should return null after all margins fail
            expect(result).toBeNull();

            // Verify validation failed was logged for each margin attempt
            const validationFailedCalls = mockCtx.log.mock.calls.filter(
                (call: any[]) => call[1] === "warn" && call[0].includes("VALIDATION FAILED"),
            );
            // Should be called for each margin (4, 2, 1) - 3 times
            expect(validationFailedCalls.length).toBe(3);

            diffMainSpy.mockRestore();
            patchMakeSpy.mockRestore();
            patchApplySpy.mockRestore();
        });
    });
});
