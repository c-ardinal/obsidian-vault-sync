/**
 * @file Strategies index unit tests for branch coverage
 *
 * @description
 * Tests for src/sync-manager/strategies/index.ts to achieve 80%+ branch coverage:
 * 1. Getting each valid strategy by name
 * 2. Getting default strategy when unknown name is passed (uncovered branch)
 * 3. Edge cases like empty string, null, undefined
 */

import { describe, it, expect } from "vitest";

import {
    getMergeStrategy,
    SmartMergeStrategy,
    ForceLocalStrategy,
    ForceRemoteStrategy,
    AlwaysForkStrategy,
} from "../../../src/sync-manager/strategies";

describe("getMergeStrategy", () => {
    describe("valid strategy names", () => {
        it("should return SmartMergeStrategy for 'smart-merge'", () => {
            const strategy = getMergeStrategy("smart-merge");
            expect(strategy).toBeInstanceOf(SmartMergeStrategy);
        });

        it("should return ForceLocalStrategy for 'force-local'", () => {
            const strategy = getMergeStrategy("force-local");
            expect(strategy).toBeInstanceOf(ForceLocalStrategy);
        });

        it("should return ForceRemoteStrategy for 'force-remote'", () => {
            const strategy = getMergeStrategy("force-remote");
            expect(strategy).toBeInstanceOf(ForceRemoteStrategy);
        });

        it("should return AlwaysForkStrategy for 'always-fork'", () => {
            const strategy = getMergeStrategy("always-fork");
            expect(strategy).toBeInstanceOf(AlwaysForkStrategy);
        });
    });

    describe("invalid strategy names - fallback to default", () => {
        it("should return SmartMergeStrategy as default for unknown strategy name", () => {
            const strategy = getMergeStrategy("unknown-strategy");
            expect(strategy).toBeInstanceOf(SmartMergeStrategy);
        });

        it("should return SmartMergeStrategy as default for non-existent strategy", () => {
            const strategy = getMergeStrategy("does-not-exist");
            expect(strategy).toBeInstanceOf(SmartMergeStrategy);
        });

        it("should return SmartMergeStrategy for strategy name with special characters", () => {
            const strategy = getMergeStrategy("<script>alert('xss')</script>");
            expect(strategy).toBeInstanceOf(SmartMergeStrategy);
        });

        it("should return SmartMergeStrategy for very long strategy name", () => {
            const longName = "a".repeat(1000);
            const strategy = getMergeStrategy(longName);
            expect(strategy).toBeInstanceOf(SmartMergeStrategy);
        });
    });

    describe("edge cases", () => {
        it("should return SmartMergeStrategy for empty string", () => {
            const strategy = getMergeStrategy("");
            expect(strategy).toBeInstanceOf(SmartMergeStrategy);
        });

        it("should return SmartMergeStrategy for null", () => {
            const strategy = getMergeStrategy(null as unknown as string);
            expect(strategy).toBeInstanceOf(SmartMergeStrategy);
        });

        it("should return SmartMergeStrategy for undefined", () => {
            const strategy = getMergeStrategy(undefined as unknown as string);
            expect(strategy).toBeInstanceOf(SmartMergeStrategy);
        });

        it("should return SmartMergeStrategy for whitespace-only string", () => {
            const strategy = getMergeStrategy("   ");
            expect(strategy).toBeInstanceOf(SmartMergeStrategy);
        });

        it("should return SmartMergeStrategy for string with only newlines", () => {
            const strategy = getMergeStrategy("\n\r\t");
            expect(strategy).toBeInstanceOf(SmartMergeStrategy);
        });
    });

    describe("strategy identity - singleton pattern", () => {
        it("should return the same strategy instance for multiple calls", () => {
            const strategy1 = getMergeStrategy("smart-merge");
            const strategy2 = getMergeStrategy("smart-merge");
            expect(strategy1).toBe(strategy2);
        });

        it("should return the same default strategy instance for multiple unknown names", () => {
            const strategy1 = getMergeStrategy("unknown1");
            const strategy2 = getMergeStrategy("unknown2");
            expect(strategy1).toBe(strategy2);
            expect(strategy1).toBeInstanceOf(SmartMergeStrategy);
        });
    });
});
