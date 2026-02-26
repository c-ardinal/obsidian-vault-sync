/**
 * @file ワイルドカード(glob)パターンマッチングのユニットテスト
 *
 * @description
 * matchWildcardの * (単一セグメント)、** (再帰)、? (単一文字)、フォルダプレフィックス、
 * 正規表現特殊文字のエスケープ、エッジケースを検証する。
 *
 * @pass_criteria
 * - *: ディレクトリ境界(/)を越えないこと
 * - **: 複数ディレクトリを跨いでマッチすること
 * - ?: 正確に1文字にマッチすること
 * - 正規表現特殊文字(.[]()+ 等)が安全にエスケープされること
 */

import { describe, it, expect } from "vitest";
import { matchWildcard } from "../../../src/utils/wildcard";

describe("matchWildcard", () => {
    // ─── Single-segment wildcard (*) ───

    describe("* (single segment)", () => {
        it("should match file extension at root", () => {
            expect(matchWildcard("*.md", "test.md")).toBe(true);
        });

        it("should not cross directory boundaries", () => {
            expect(matchWildcard("*.md", "folder/test.md")).toBe(false);
        });

        it("should match prefix wildcard", () => {
            expect(matchWildcard("test.*", "test.txt")).toBe(true);
        });

        it("should match middle wildcard", () => {
            expect(matchWildcard("test-*-file.md", "test-abc-file.md")).toBe(true);
        });

        it("should match empty segment", () => {
            expect(matchWildcard("*.md", ".md")).toBe(true);
        });

        it("should not match when extension differs", () => {
            expect(matchWildcard("*.md", "test.txt")).toBe(false);
        });
    });

    // ─── Recursive wildcard (**) ───

    describe("** (recursive)", () => {
        it("should match across directories", () => {
            expect(matchWildcard("**/*.md", "a/b/c.md")).toBe(true);
        });

        it("should match single level", () => {
            expect(matchWildcard("**/*.md", "folder/note.md")).toBe(true);
        });

        it("should match deeply nested paths", () => {
            expect(matchWildcard("temp/**", "temp/sub/deep/file.txt")).toBe(true);
        });

        it("should match everything with **", () => {
            expect(matchWildcard("**", "any/path/here.txt")).toBe(true);
        });

        it("should not match root level without directory separator for **/ prefix", () => {
            // **/ requires at least one directory level; root.md has no /
            expect(matchWildcard("**/*.md", "root.md")).toBe(false);
        });
    });

    // ─── Single character wildcard (?) ───

    describe("? (single character)", () => {
        it("should match exactly one character", () => {
            expect(matchWildcard("test?.md", "test1.md")).toBe(true);
        });

        it("should not match zero characters", () => {
            expect(matchWildcard("test?.md", "test.md")).toBe(false);
        });

        it("should not match multiple characters", () => {
            expect(matchWildcard("test?.md", "test12.md")).toBe(false);
        });

        it("should match any character including special", () => {
            expect(matchWildcard("file?.txt", "file-.txt")).toBe(true);
        });
    });

    // ─── Folder prefix matching ───

    describe("folder prefix matching", () => {
        it("should match files inside a named folder", () => {
            expect(matchWildcard("secret", "secret/data.json")).toBe(true);
        });

        it("should match nested content under folder", () => {
            expect(matchWildcard("build", "build/output/bundle.js")).toBe(true);
        });

        it("should not match partial folder names", () => {
            expect(matchWildcard("sec", "secret/data.json")).toBe(false);
        });

        it("should match exact file name (no prefix)", () => {
            expect(matchWildcard("readme.md", "readme.md")).toBe(true);
        });

        it("should not apply prefix matching when pattern ends with *", () => {
            // "temp*" should not match "temp/foo" because * doesn't cross /
            expect(matchWildcard("temp*", "temp/foo")).toBe(false);
        });
    });

    // ─── Special regex characters ───

    describe("special regex characters in patterns", () => {
        it("should escape dots in pattern", () => {
            expect(matchWildcard("file.txt", "file.txt")).toBe(true);
            expect(matchWildcard("file.txt", "fileatxt")).toBe(false);
        });

        it("should escape parentheses", () => {
            // *(Conflict* → [^/]*(Conflict[^/]* → matches "note(Conflict).md"
            expect(matchWildcard("*(Conflict*", "note(Conflict).md")).toBe(true);
            expect(matchWildcard("*(Conflict)*", "x(Conflict)y")).toBe(true);
        });

        it("should escape square brackets", () => {
            expect(matchWildcard("[test].md", "[test].md")).toBe(true);
        });

        it("should escape plus sign", () => {
            expect(matchWildcard("file+name.md", "file+name.md")).toBe(true);
        });
    });

    // ─── Edge cases ───

    describe("edge cases", () => {
        it("should match empty pattern against empty text", () => {
            expect(matchWildcard("", "")).toBe(true);
        });

        it("should not match empty pattern against non-empty text", () => {
            expect(matchWildcard("", "something")).toBe(false);
        });

        it("should not match non-empty pattern against empty text", () => {
            expect(matchWildcard("*.md", "")).toBe(false);
        });

        it("should handle pattern with only *", () => {
            expect(matchWildcard("*", "anything")).toBe(true);
        });

        it("should handle pattern with only * not crossing /", () => {
            expect(matchWildcard("*", "path/file")).toBe(false);
        });
    });
});
