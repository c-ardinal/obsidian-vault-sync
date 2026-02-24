/**
 * @file マージユーティリティ関数のユニットテスト
 *
 * @description
 * isContentSubset (順序保持部分列判定)、areSemanticallyEquivalent (順序無視の行集合比較)、
 * linesToChars3 (3-way diff用行エンコーディング) を検証する。
 *
 * @pass_criteria
 * - isContentSubset: 行の出現順序を維持した部分列判定が正確であること
 * - areSemanticallyEquivalent: 行の順序を無視した集合比較が正確であること
 * - linesToChars3: 同一行が同一コードにエンコードされ、Round-tripで復元できること
 */

import { describe, it, expect } from "vitest";
import { isContentSubset, areSemanticallyEquivalent } from "../../../src/sync-manager/merge";
import { linesToChars3 } from "../../../src/sync-manager/diff-utils";

describe("isContentSubset", () => {
    it("should return true when subset lines appear in order in superset", () => {
        expect(isContentSubset("line1\nline3\n", "line1\nline2\nline3\n")).toBe(true);
    });

    it("should return false when lines appear in wrong order", () => {
        expect(isContentSubset("line3\nline1\n", "line1\nline2\nline3\n")).toBe(false);
    });

    it("should return true for identical content", () => {
        expect(isContentSubset("a\nb\nc\n", "a\nb\nc\n")).toBe(true);
    });

    it("should return true for empty subset", () => {
        expect(isContentSubset("", "anything\nhere\n")).toBe(true);
    });

    it("should return false when subset is larger than superset", () => {
        expect(isContentSubset("a\nb\nc\n", "a\nb\n")).toBe(false);
    });

    it("should ignore empty lines", () => {
        expect(isContentSubset("a\n\nb\n", "a\nb\n")).toBe(true);
    });

    it("should trim whitespace when comparing", () => {
        expect(isContentSubset("  a  \n  b  \n", "a\nb\n")).toBe(true);
    });

    it("should handle CRLF normalization", () => {
        expect(isContentSubset("a\r\nb\r\n", "a\nb\nc\n")).toBe(true);
    });

    it("should return false for completely different content", () => {
        expect(isContentSubset("x\ny\n", "a\nb\nc\n")).toBe(false);
    });
});

describe("areSemanticallyEquivalent", () => {
    it("should return true for identical content", () => {
        expect(areSemanticallyEquivalent("a\nb\nc\n", "a\nb\nc\n")).toBe(true);
    });

    it("should return true for same lines in different order", () => {
        expect(areSemanticallyEquivalent("a\nb\nc\n", "c\na\nb\n")).toBe(true);
    });

    it("should return false for different content", () => {
        expect(areSemanticallyEquivalent("a\nb\n", "a\nc\n")).toBe(false);
    });

    it("should return false for different line counts", () => {
        expect(areSemanticallyEquivalent("a\nb\n", "a\nb\nc\n")).toBe(false);
    });

    it("should ignore empty lines", () => {
        expect(areSemanticallyEquivalent("a\n\nb\n", "b\na\n")).toBe(true);
    });

    it("should trim whitespace", () => {
        expect(areSemanticallyEquivalent("  a  \n  b  \n", "b\na\n")).toBe(true);
    });

    it("should handle CRLF normalization", () => {
        expect(areSemanticallyEquivalent("a\r\nb\r\n", "b\na\n")).toBe(true);
    });

    it("should return true for two empty strings", () => {
        expect(areSemanticallyEquivalent("", "")).toBe(true);
    });

    it("should handle duplicate lines", () => {
        expect(areSemanticallyEquivalent("a\na\nb\n", "a\nb\na\n")).toBe(true);
    });

    it("should detect different duplicate counts", () => {
        expect(areSemanticallyEquivalent("a\na\nb\n", "a\nb\nb\n")).toBe(false);
    });
});

describe("linesToChars3", () => {
    it("should encode three texts sharing the same line array", () => {
        const result = linesToChars3("A\nB\n", "B\nC\n", "A\nC\n");
        expect(result.lineArray.length).toBeGreaterThanOrEqual(3);
        // Each unique line should appear exactly once in lineArray
        expect(result.lineArray).toContain("A\n");
        expect(result.lineArray).toContain("B\n");
        expect(result.lineArray).toContain("C\n");
    });

    it("should produce chars that decode back to original lines", () => {
        const text1 = "Line 1\nLine 2\n";
        const text2 = "Line 2\nLine 3\n";
        const text3 = "Line 1\nLine 3\n";
        const { chars1, chars2, chars3, lineArray } = linesToChars3(text1, text2, text3);

        // Decode chars back to text
        const decode = (chars: string) =>
            Array.from(chars).map((c) => lineArray[c.charCodeAt(0)]).join("");

        expect(decode(chars1)).toBe(text1);
        expect(decode(chars2)).toBe(text2);
        expect(decode(chars3)).toBe(text3);
    });

    it("should assign same char code to identical lines across texts", () => {
        const { chars1, chars2 } = linesToChars3("A\n", "A\n", "B\n");
        // Both text1 and text2 have "A\n" → same char code
        expect(chars1.charCodeAt(0)).toBe(chars2.charCodeAt(0));
    });

    it("should handle empty texts", () => {
        const result = linesToChars3("", "", "A\n");
        expect(result.chars1).toBe("");
        expect(result.chars2).toBe("");
        expect(result.chars3.length).toBe(1);
    });

    it("should handle text without trailing newline", () => {
        const result = linesToChars3("no newline", "", "");
        expect(result.lineArray).toContain("no newline");
        expect(result.chars1.length).toBe(1);
    });

    it("should handle many unique lines", () => {
        const lines = Array.from({ length: 50 }, (_, i) => `Line ${i}\n`);
        const text = lines.join("");
        const result = linesToChars3(text, text, text);
        expect(result.lineArray.length).toBe(50);
        // All three encodings should be identical
        expect(result.chars1).toBe(result.chars2);
        expect(result.chars2).toBe(result.chars3);
    });
});
