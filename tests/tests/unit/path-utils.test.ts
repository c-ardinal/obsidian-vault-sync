/**
 * Unit tests for path normalization utilities.
 *
 * Verifies cross-platform path handling:
 *   - normalizePath: backslashes, duplicate slashes, leading/trailing slashes
 *   - basename: extracting filename from path
 *   - dirname: extracting directory from path
 */

import { describe, it, expect } from "vitest";
import { normalizePath, basename, dirname } from "../../../src/utils/path";

describe("normalizePath", () => {
    it("should convert backslashes to forward slashes", () => {
        expect(normalizePath("folder\\sub\\file.md")).toBe("folder/sub/file.md");
    });

    it("should remove duplicate slashes", () => {
        expect(normalizePath("folder//sub///file.md")).toBe("folder/sub/file.md");
    });

    it("should remove leading slash", () => {
        expect(normalizePath("/folder/file.md")).toBe("folder/file.md");
    });

    it("should remove trailing slash", () => {
        expect(normalizePath("folder/sub/")).toBe("folder/sub");
    });

    it("should handle Windows absolute path", () => {
        expect(normalizePath("C:\\Users\\docs\\file.md")).toBe("C:/Users/docs/file.md");
    });

    it("should handle mixed separators", () => {
        expect(normalizePath("folder/sub\\deep//file.md")).toBe("folder/sub/deep/file.md");
    });

    it("should return empty string for empty input", () => {
        expect(normalizePath("")).toBe("");
    });

    it("should handle single filename", () => {
        expect(normalizePath("file.md")).toBe("file.md");
    });

    it("should handle root-only slash (becomes empty)", () => {
        expect(normalizePath("/")).toBe("");
    });

    it("should handle .obsidian paths correctly", () => {
        expect(normalizePath(".obsidian/plugins/test/main.js")).toBe(".obsidian/plugins/test/main.js");
    });

    it("should handle leading backslash", () => {
        expect(normalizePath("\\folder\\file.md")).toBe("folder/file.md");
    });
});

describe("basename", () => {
    it("should extract filename from path", () => {
        expect(basename("folder/sub/file.md")).toBe("file.md");
    });

    it("should return the full string if no slash", () => {
        expect(basename("file.md")).toBe("file.md");
    });

    it("should handle deeply nested paths", () => {
        expect(basename("a/b/c/d/e.txt")).toBe("e.txt");
    });

    it("should handle path ending with slash (empty basename)", () => {
        expect(basename("folder/sub/")).toBe("");
    });

    it("should handle root-level file", () => {
        expect(basename("readme.md")).toBe("readme.md");
    });

    it("should handle dotfiles", () => {
        expect(basename(".obsidian/app.json")).toBe("app.json");
    });
});

describe("dirname", () => {
    it("should extract directory from path", () => {
        expect(dirname("folder/sub/file.md")).toBe("folder/sub");
    });

    it("should return empty string for root-level file", () => {
        expect(dirname("file.md")).toBe("");
    });

    it("should handle single directory depth", () => {
        expect(dirname("folder/file.md")).toBe("folder");
    });

    it("should handle deeply nested paths", () => {
        expect(dirname("a/b/c/d/e.txt")).toBe("a/b/c/d");
    });

    it("should handle .obsidian paths", () => {
        expect(dirname(".obsidian/plugins/test/main.js")).toBe(".obsidian/plugins/test");
    });
});
