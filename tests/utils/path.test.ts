import { describe, it, expect } from "vitest";
import { normalizePath } from "../../src/utils/path";

describe("normalizePath (Cross-platform path utility)", () => {
    it("should handle Windows paths (backslashes)", () => {
        expect(normalizePath("folder\\note.md")).toBe("folder/note.md");
        expect(normalizePath("nested\\folder\\path")).toBe("nested/folder/path");
    });

    it("should handle mixed slashes", () => {
        expect(normalizePath("folder/next\\note.md")).toBe("folder/next/note.md");
    });

    it("should remove leading slashes (relative to vault root)", () => {
        expect(normalizePath("/folder/note.md")).toBe("folder/note.md");
        expect(normalizePath("\\folder\\note.md")).toBe("folder/note.md");
    });

    it("should remove trailing slashes", () => {
        expect(normalizePath("folder/")).toBe("folder");
        expect(normalizePath("folder\\")).toBe("folder");
    });

    it("should collapse duplicate slashes", () => {
        expect(normalizePath("folder//note.md")).toBe("folder/note.md");
        expect(normalizePath("folder\\\\note.md")).toBe("folder/note.md");
    });

    it("should handle empty strings", () => {
        expect(normalizePath("")).toBe("");
    });

    it("should normalize complex paths correctly", () => {
        expect(normalizePath("/User/Documents\\Obsidian/My Vault//Notes/")).toBe(
            "User/Documents/Obsidian/My Vault/Notes",
        );
    });
});
