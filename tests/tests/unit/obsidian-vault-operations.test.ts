/**
 * @file ObsidianVaultOperations.rmdir: removing a folder only while it is empty
 *
 * @description
 * Obsidian's desktop adapter refuses rmdir(path, false) with EISDIR for every
 * folder, empty or not (seen in Obsidian 1.15). Folders a pull leaves empty were
 * then never removed. rmdir(path, false) now falls back to a recursive remove
 * only when the folder is still empty.
 *
 * @pass_criteria
 * - an empty folder is removed although the non-recursive call fails
 * - a folder with something in it is kept and the error is passed on
 * - a recursive remove is passed straight through
 */
import { describe, it, expect, vi } from "vitest";
import { ObsidianVaultOperations } from "../../../src/services/obsidian-vault-operations";

function appWith(listing: { files: string[]; folders: string[] }) {
    const eisdir = Object.assign(new Error("rm returned EISDIR (is a directory)"), { code: "ERR_FS_EISDIR" });
    const adapter = {
        rmdir: vi.fn(async (_path: string, recursive: boolean) => {
            if (!recursive) throw eisdir;
        }),
        list: vi.fn(async () => listing),
    };
    return { app: { vault: { adapter } } as never, adapter, eisdir };
}

describe("ObsidianVaultOperations.rmdir", () => {
    it("removes an empty folder when the adapter refuses the non-recursive call", async () => {
        const { app, adapter } = appWith({ files: [], folders: [] });
        await new ObsidianVaultOperations(app).rmdir("Notes", false);
        expect(adapter.rmdir).toHaveBeenLastCalledWith("Notes", true);
    });

    it("keeps a folder that is not empty", async () => {
        const { app, adapter, eisdir } = appWith({ files: ["Notes/a.md"], folders: [] });
        await expect(new ObsidianVaultOperations(app).rmdir("Notes", false)).rejects.toBe(eisdir);
        expect(adapter.rmdir).not.toHaveBeenCalledWith("Notes", true);
    });

    it("passes a recursive remove straight through", async () => {
        const { app, adapter } = appWith({ files: ["x"], folders: [] });
        await new ObsidianVaultOperations(app).rmdir("Old", true);
        expect(adapter.rmdir).toHaveBeenCalledTimes(1);
        expect(adapter.list).not.toHaveBeenCalled();
    });
});
