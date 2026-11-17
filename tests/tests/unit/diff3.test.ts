import { describe, expect, it } from "vitest";
import { mergeLines3 } from "../../../src/sync-manager/strategies/diff3";

describe("mergeLines3", () => {
    it("takes changes made on one side only", () => {
        expect(mergeLines3("a\nb\nm\nc", "a\nB\nm\nc", "a\nb\nm\nC")).toBe("a\nB\nm\nC");
    });

    it("keeps both sides' additions at the same spot, remote first", () => {
        expect(mergeLines3("h\nx", "h\nx\nL", "h\nR0\nx\nR1")).toBe("h\nR0\nx\nR1\nL");
    });

    it("never drops lines that neither side touched", () => {
        const merged = mergeLines3("# id\n\nA\n+ 1", "# id\n\nA\n+ 1\n+ L", "# id\n\nA\n+ R\n+ 1\n+ R2")!;
        expect(merged.split("\n")[0]).toBe("# id");
        expect(merged).toContain("+ L");
        expect(merged).toContain("+ R2");
    });

    it("applies the same change on both sides once", () => {
        expect(mergeLines3("a\nb", "a\nX", "a\nX")).toBe("a\nX");
    });

    it("returns null when both sides rewrote the same lines differently", () => {
        expect(mergeLines3("a\nb\nc", "a\nL\nc", "a\nR\nc")).toBeNull();
    });

    it("keeps a deletion made on one side", () => {
        expect(mergeLines3("a\nb\nc", "a\nc", "a\nb\nc\nd")).toBe("a\nc\nd");
    });
});
