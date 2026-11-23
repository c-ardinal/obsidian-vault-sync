/**
 * @file 未取得ファイルの個別取得（リンク照合）の試験
 *
 * @pass_criteria
 * - 完全パス・拡張子なし・ファイル名のみのリンク表記と照合可能なこと
 * - 見出し・別名付きリンクも照合可能なこと
 */
import { describe, it, expect } from "vitest";
import { matchLinkedFiles } from "../../../src/sync-manager/on-demand";

const files = [
    { path: "att/scan.pdf", size: 9, fileId: "1" },
    { path: "att/photo.png", size: 9, fileId: "2" },
    { path: "notes/other.md", size: 9, fileId: "3" },
];

describe("files a note links to", () => {
    it("matches full paths, names only, names without extension, headings and aliases", () => {
        expect(matchLinkedFiles(files, ["att/scan.pdf"]).map((f) => f.fileId)).toEqual(["1"]);
        expect(matchLinkedFiles(files, ["photo.png"]).map((f) => f.fileId)).toEqual(["2"]);
        expect(matchLinkedFiles(files, ["other#Part|alias"]).map((f) => f.fileId)).toEqual(["3"]);
        expect(matchLinkedFiles(files, ["missing.png", ""])).toEqual([]);
    });

    it("does not match a different file that only ends the same", () => {
        expect(matchLinkedFiles(files, ["can.pdf"])).toEqual([]);
    });
});
