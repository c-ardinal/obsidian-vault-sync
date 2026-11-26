/**
 * @file Unit tests for the case / Unicode-normalization name collision helpers.
 *
 * @pass_criteria
 * - Names that are one file on Windows/macOS share a key; others don't
 * - A clash is reported against the index and against pulls in flight, not against the same file id
 * - Free "(n)" names skip names already used in the index, dirty paths, earlier picks and on disk
 * - NFD event paths map onto the NFC index key only on Unicode-insensitive file systems
 * - Other-case event paths map onto the index key only on case-insensitive file systems
 * - Names Windows / Android cannot store are recognised; names they can store are not
 */
import { describe, it, expect } from "vitest";
import {
    claimPullPath,
    findPathCollision,
    freeCollisionPath,
    moveIndexEntry,
    pathKey,
    windowsNameProblem,
} from "../../../src/sync-manager/path-collision";
import { indexKeyFor, markRenamed, renameLocal } from "../../../src/sync-manager/state";

const NFC = "notes/café.md";
const NFD = "notes/café.md";

function makeCtx(index: Record<string, any> = {}, onDisk: string[] = []) {
    return {
        index,
        localIndex: {} as Record<string, any>,
        dirtyPaths: new Map<string, number>(),
        unicodeInsensitiveFs: false,
        // Like Windows / macOS: the disk check ignores case
        vault: { exists: async (p: string) => onDisk.some((d) => pathKey(d) === pathKey(p)) },
    } as any;
}

describe("pathKey", () => {
    it("folds case and Unicode normalization, including folder names", () => {
        expect(pathKey(NFC)).toBe(pathKey(NFD));
        expect(pathKey("Projects/Todo.md")).toBe(pathKey("projects/todo.md"));
        expect(pathKey("notes/a.md")).not.toBe(pathKey("notes/b.md"));
    });
});

describe("findPathCollision", () => {
    it("reports another file with the same key, but not the same file", () => {
        const ctx = makeCtx({ "notes/Todo.md": { fileId: "f1" } });
        expect(findPathCollision(ctx, "notes/todo.md", "f2")).toBe("notes/Todo.md");
        expect(findPathCollision(ctx, "notes/todo.md", "f1")).toBeNull();
        expect(findPathCollision(ctx, "notes/Todo.md", "f2")).toBeNull(); // same path is no clash
        expect(findPathCollision(ctx, "notes/other.md", "f2")).toBeNull();
    });

    it("sees a colliding pull that is still downloading", () => {
        const ctx = makeCtx();
        const release = claimPullPath(ctx, NFC, "f1");
        expect(release).not.toBeNull();
        expect(findPathCollision(ctx, NFD, "f2")).toBe(NFC);
        expect(claimPullPath(ctx, NFD, "f2")).toBeNull(); // the name is taken
        const again = claimPullPath(ctx, NFC, "f1"); // the same file may claim again
        expect(again).not.toBeNull();
        again!();
        expect(findPathCollision(ctx, NFD, "f2")).toBeNull();
    });
});

describe("freeCollisionPath", () => {
    it("skips names used in the index, dirty paths, on disk and by earlier picks", async () => {
        const ctx = makeCtx({ "notes/Todo.md": {}, "notes/todo (2).md": {} }, ["notes/Todo (4).md"]);
        ctx.dirtyPaths.set("notes/TODO (3).md", 1);
        expect(await freeCollisionPath(ctx, "notes/todo.md")).toBe("notes/todo (5).md");
        // A second clash renamed in the same pass gets its own name
        expect(await freeCollisionPath(ctx, "notes/Todo.md")).toBe("notes/Todo (6).md");
    });

    it("keeps the extension and handles files at the vault root", async () => {
        expect(await freeCollisionPath(makeCtx(), "Image.PNG")).toBe("Image (2).PNG");
        expect(await freeCollisionPath(makeCtx(), "README")).toBe("README (2)");
    });
});

describe("moveIndexEntry", () => {
    it("moves index, local index and dirty mark together", () => {
        const ctx = makeCtx({ "a.md": { fileId: "f1" } });
        ctx.localIndex["a.md"] = { fileId: "f1" };
        ctx.dirtyPaths.set("a.md", 1);
        moveIndexEntry(ctx, "a.md", "a (2).md");
        expect(ctx.index).toEqual({ "a (2).md": { fileId: "f1" } });
        expect(ctx.localIndex).toEqual({ "a (2).md": { fileId: "f1" } });
        expect([...ctx.dirtyPaths.keys()]).toEqual(["a (2).md"]);
    });
});

describe("indexKeyFor", () => {
    it("maps an NFD event path onto the NFC index key on macOS / iOS only", () => {
        const ctx = makeCtx({ [NFC]: { fileId: "f1" } });
        expect(indexKeyFor(ctx, NFD)).toBe(NFD); // Linux / Windows: two different files
        ctx.unicodeInsensitiveFs = true;
        expect(indexKeyFor(ctx, NFD)).toBe(NFC);
        expect(indexKeyFor(ctx, "notes/plain.md")).toBe("notes/plain.md");
        // Case is never folded: on a case-sensitive Mac volume these are two files too
        expect(indexKeyFor(ctx, "notes/CAFÉ.md")).toBe("notes/CAFÉ.md");
    });
});

describe("indexKeyFor on a case-insensitive file system", () => {
    it("maps a path reported in other letter case onto the index key (Windows / macOS / Android)", () => {
        const ctx = makeCtx({ "Projects/idea.md": { fileId: "f1" } });
        expect(indexKeyFor(ctx, "projects/idea.md")).toBe("projects/idea.md"); // Linux: two files
        ctx.caseInsensitiveFs = true;
        expect(indexKeyFor(ctx, "projects/idea.md")).toBe("Projects/idea.md");
        expect(indexKeyFor(ctx, "projects/other.md")).toBe("projects/other.md");
        // The exact key wins when it is indexed itself
        ctx.index["projects/idea.md"] = { fileId: "f2" };
        expect(indexKeyFor(ctx, "projects/idea.md")).toBe("projects/idea.md");
    });

    it("folds case and Unicode form together on macOS", () => {
        const ctx = makeCtx({ [NFC]: { fileId: "f1" } });
        ctx.caseInsensitiveFs = true;
        ctx.unicodeInsensitiveFs = true;
        expect(indexKeyFor(ctx, NFD.toUpperCase())).toBe(NFC);
    });
});

describe("windowsNameProblem", () => {
    it.each([
        ["Q&A: why?.md", "character"],
        ['say "hi".md', "character"],
        ["a|b.md", "character"],
        ["star*.md", "character"],
        ["<tag>.md", "character"],
        ["inbox/con.md", "reserved name"],
        ["AUX.txt", "reserved name"],
        ["lpt1.md", "reserved name"],
        ["folder./note.md", "trailing dot or space"],
        ["Draft /note.md", "trailing dot or space"],
    ])("refuses %s (%s)", (path, reason) => {
        expect(windowsNameProblem(path)).toBe(reason);
    });

    it.each(["notes/café.md", "v1..v2 plan.md", "console.md", "COM10.md", "a (2).md", "日本語/メモ.md", ".hidden.md"])(
        "accepts %s",
        (path) => {
            expect(windowsNameProblem(path)).toBeNull();
        },
    );
});

describe("renames made by the sync engine itself", () => {
    it("are not reported back as user renames, even when another note took the old name", async () => {
        const ctx = makeCtx({ "a.md": { fileId: "f1" } });
        ctx.vault.rename = async () => {};
        ctx.log = () => {};
        ctx.settings = {};
        moveIndexEntry(ctx, "a.md", "b.md");
        await renameLocal(ctx, "a.md", "b.md");
        // Meanwhile a different note was pulled under the old name
        ctx.index["a.md"] = { fileId: "f2" };
        markRenamed(ctx, "a.md", "b.md"); // the late vault event
        expect(ctx.index["a.md"]).toEqual({ fileId: "f2" });
        expect(ctx.index["b.md"]).toEqual({ fileId: "f1" });
        expect(ctx.index["b.md"].pendingMove).toBeUndefined();
    });
});
