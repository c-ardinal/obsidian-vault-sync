import { describe, it, expect } from "vitest";
import { matchesWords, normalizeForSearch, queryWords } from "../../../src/ui/settings-search";

describe("settings search", () => {
    it("ignores case, width and accents", () => {
        expect(normalizeForSearch("ＬＯＧ Café")).toBe("log cafe");
        // Japanese voiced marks stay (ガ is not カ)
        expect(normalizeForSearch("ガ")).toBe("ガ");
        expect(normalizeForSearch("ｶﾞ")).toBe("ガ");
    });

    it("splits the query at spaces, full-width ones too", () => {
        expect(queryWords("  sync　interval ")).toEqual(["sync", "interval"]);
        expect(queryWords("   ")).toEqual([]);
    });

    it("needs every word somewhere in the texts", () => {
        const texts = ["Performance", "Deletion safety", "Cloud trash", undefined];
        expect(matchesWords(queryWords("trash"), texts)).toBe(true);
        expect(matchesWords(queryWords("cloud perf"), texts)).toBe(true);
        expect(matchesWords(queryWords("cloud token"), texts)).toBe(false);
        expect(matchesWords([], texts)).toBe(false);
        expect(matchesWords(queryWords("削除"), ["削除ファイルの保管"])).toBe(true);
    });
});
