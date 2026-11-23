/**
 * @file 未取得ファイルの個別取得（リンク照合）の試験
 *
 * @pass_criteria
 * - 完全パス・拡張子なし・ファイル名のみのリンク表記と照合可能なこと
 * - 見出し・別名付きリンクも照合可能なこと
 */
import { describe, it, expect, vi } from "vitest";
import { fetchCloudOnlyFile, listCloudOnlyFiles, matchLinkedFiles } from "../../../src/sync-manager/on-demand";
import { verifySync } from "../../../src/sync-manager/sync-verify";
import type { SyncContext } from "../../../src/sync-manager/context";

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

describe("while the add-on is locked", () => {
    it("lists, fetches and compares nothing, and never writes cloud bytes", async () => {
        const download = vi.fn();
        const write = vi.fn();
        const ctx = {
            e2eeLocked: true,
            adapter: { downloadFile: download, listFiles: vi.fn() },
            vault: { exists: async () => false, writeBinary: write },
        } as unknown as SyncContext;
        await expect(listCloudOnlyFiles(ctx)).rejects.toThrow();
        await expect(fetchCloudOnlyFile(ctx, files[0])).rejects.toThrow();
        await expect(verifySync(ctx)).rejects.toThrow();
        expect(download).not.toHaveBeenCalled();
        expect(write).not.toHaveBeenCalled();
    });
});
