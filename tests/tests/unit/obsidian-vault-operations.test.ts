/**
 * @file ObsidianVaultOperations.rmdir: removing a folder only while it is empty
 *
 * @description
 * Obsidian's desktop adapter refuses rmdir(path, false) with EISDIR for every
 * folder, empty or not (seen in Obsidian 1.15). Folders a pull leaves empty were
 * then never removed. rmdir(path, false) now falls back to the file system's own
 * rmdir, which removes an empty folder in one step and refuses any other. It
 * never falls back to a recursive removal (a note written meanwhile would be lost).
 *
 * @pass_criteria
 * - an empty folder is removed although the adapter's non-recursive call fails
 * - a folder with something in it is kept: the file system's refusal is passed on
 * - without access to the file system the folder is kept (the adapter's error)
 * - a recursive remove is passed straight through
 */
import { describe, it, expect, vi } from "vitest";
import { ObsidianVaultOperations } from "../../../src/services/obsidian-vault-operations";

function appWith(opts: { nativeRmdir?: (full: string) => Promise<void> } = {}) {
    const eisdir = Object.assign(new Error("rm returned EISDIR (is a directory)"), { code: "ERR_FS_EISDIR" });
    const adapter: Record<string, unknown> = {
        rmdir: vi.fn(async (_path: string, recursive: boolean) => {
            if (!recursive) throw eisdir;
        }),
    };
    if (opts.nativeRmdir) {
        adapter.getFullPath = (p: string) => `/vault/${p}`;
        adapter.fsPromises = { rmdir: vi.fn(opts.nativeRmdir) };
    }
    return { app: { vault: { adapter } } as never, adapter: adapter as { rmdir: ReturnType<typeof vi.fn>; fsPromises?: { rmdir: ReturnType<typeof vi.fn> } }, eisdir };
}

describe("ObsidianVaultOperations.rmdir", () => {
    it("removes an empty folder when the adapter refuses the non-recursive call", async () => {
        const { app, adapter } = appWith({ nativeRmdir: async () => {} });
        await new ObsidianVaultOperations(app).rmdir("Notes", false);
        expect(adapter.fsPromises!.rmdir).toHaveBeenCalledWith("/vault/Notes");
        expect(adapter.rmdir).not.toHaveBeenCalledWith("Notes", true);
    });

    it("keeps a folder that is not empty", async () => {
        const notEmpty = Object.assign(new Error("ENOTEMPTY"), { code: "ENOTEMPTY" });
        const { app, adapter } = appWith({
            nativeRmdir: async () => {
                throw notEmpty;
            },
        });
        await expect(new ObsidianVaultOperations(app).rmdir("Notes", false)).rejects.toBe(notEmpty);
        expect(adapter.rmdir).not.toHaveBeenCalledWith("Notes", true);
    });

    it("keeps the folder when the file system cannot be reached", async () => {
        const { app, adapter, eisdir } = appWith();
        await expect(new ObsidianVaultOperations(app).rmdir("Notes", false)).rejects.toBe(eisdir);
        expect(adapter.rmdir).toHaveBeenCalledTimes(1);
    });

    it("passes a recursive remove straight through", async () => {
        const { app, adapter } = appWith({ nativeRmdir: async () => {} });
        await new ObsidianVaultOperations(app).rmdir("Old", true);
        expect(adapter.rmdir).toHaveBeenCalledTimes(1);
        expect(adapter.fsPromises!.rmdir).not.toHaveBeenCalled();
    });
});
