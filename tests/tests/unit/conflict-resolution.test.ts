import { describe, it, expect } from "vitest";
import {
    buildConflictChunks,
    composeConflictResult,
    decodeText,
    findConflictCopies,
    freeConflictCopyPath,
    isConflictCopyPath,
    parseConflictCopyPath,
    resolveConflictCopy,
    type ConflictVault,
} from "../../../src/sync-manager/conflict-resolution";

const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
const dec = (b: ArrayBuffer) => new TextDecoder().decode(b);

describe("conflict copy paths", () => {
    it("maps a copy to its note", () => {
        expect(parseConflictCopyPath("Notes/a (Conflict 2026-11-20T08-00-00).md")).toEqual({
            originalPath: "Notes/a.md",
            stamp: "2026-11-20T08-00-00",
        });
        expect(parseConflictCopyPath("a.b (Conflict 2026-11-20T08-00-00).md")?.originalPath).toBe("a.b.md");
        expect(isConflictCopyPath("Notes/a.md")).toBe(false);
        expect(isConflictCopyPath("a (Conflict 2026-11-20).md")).toBe(false);
    });

    it("lists copies newest first", () => {
        const found = findConflictCopies([
            "a.md",
            "a (Conflict 2026-11-19T08-00-00).md",
            "b (Conflict 2026-11-20T08-00-00).md",
        ]);
        expect(found.map((f) => f.path)).toEqual([
            "b (Conflict 2026-11-20T08-00-00).md",
            "a (Conflict 2026-11-19T08-00-00).md",
        ]);
    });
});

describe("conflict chunks", () => {
    const local = "title\nmine 1\nshared\nend\n";
    const remote = "title\ntheirs 1\nshared\nend\nadded\n";

    it("splits into shared and differing parts", () => {
        const chunks = buildConflictChunks(local, remote);
        expect(chunks).toEqual([
            { kind: "same", lines: ["title\n"] },
            { kind: "differ", local: ["mine 1\n"], remote: ["theirs 1\n"] },
            { kind: "same", lines: ["shared\n", "end\n"] },
            { kind: "differ", local: [], remote: ["added\n"] },
        ]);
    });

    it("composes the result from the choices", () => {
        const chunks = buildConflictChunks(local, remote);
        expect(composeConflictResult(chunks, [])).toBe(remote);
        expect(composeConflictResult(chunks, ["local", "local"])).toBe(local);
        expect(composeConflictResult(chunks, ["both", "remote"])).toBe(
            "title\nmine 1\ntheirs 1\nshared\nend\nadded\n",
        );
    });

    it("keeps lines apart when a part ends without a newline", () => {
        const chunks = buildConflictChunks("a\nmine", "a\ntheirs");
        expect(composeConflictResult(chunks, ["both"])).toBe("a\nmine\ntheirs");
    });

    it("has no differing part for equal text", () => {
        const chunks = buildConflictChunks("x\ny\n", "x\ny\n");
        expect(chunks.every((c) => c.kind === "same")).toBe(true);
        expect(composeConflictResult(chunks, [])).toBe("x\ny\n");
    });
});

describe("decodeText", () => {
    it("tells text from binary", () => {
        expect(decodeText(enc("日本語"))).toBe("日本語");
        expect(decodeText(new Uint8Array([0xff, 0xfe, 0x00]).buffer)).toBeNull();
    });
});

describe("resolveConflictCopy", () => {
    function vault() {
        const files = new Map<string, ArrayBuffer>();
        const trashed: string[] = [];
        const v: ConflictVault = {
            exists: async (p) => files.has(p),
            readBinary: async (p) => files.get(p)!,
            writeNote: async (p, d) => void files.set(p, d),
            trash: async (p) => {
                trashed.push(p);
                files.delete(p);
            },
        };
        return { v, files, trashed };
    }
    const copy = "n (Conflict 2026-11-20T08-00-00).md";

    it("writes the result to the note and trashes the copy", async () => {
        const { v, files, trashed } = vault();
        files.set("n.md", enc("cloud"));
        files.set(copy, enc("mine"));
        expect(await resolveConflictCopy(v, copy, enc("merged"))).toBe("n.md");
        expect(dec(files.get("n.md")!)).toBe("merged");
        expect(trashed).toEqual([copy]);
    });

    it("keeps the note as it is when no result is given", async () => {
        const { v, files, trashed } = vault();
        files.set("n.md", enc("cloud"));
        files.set(copy, enc("mine"));
        await resolveConflictCopy(v, copy, null);
        expect(dec(files.get("n.md")!)).toBe("cloud");
        expect(trashed).toEqual([copy]);
    });

    it("refuses a path that is no conflict copy", async () => {
        const { v } = vault();
        await expect(resolveConflictCopy(v, "n.md", null)).rejects.toThrow();
    });
});

describe("freeConflictCopyPath", () => {
    it("never returns a name already taken (two copies made in the same second)", async () => {
        const taken = new Set<string>();
        const exists = async (p: string) => taken.has(p);
        const first = await freeConflictCopyPath(exists, "notes/a.md");
        taken.add(first);
        const second = await freeConflictCopyPath(exists, "notes/a.md");
        expect(second).not.toBe(first);
        // Both stay recognisable as conflict copies of the note
        expect(parseConflictCopyPath(first)?.originalPath).toBe("notes/a.md");
        expect(parseConflictCopyPath(second)?.originalPath).toBe("notes/a.md");
    });

    it("handles names without an extension", async () => {
        const p = await freeConflictCopyPath(async () => false, "notes/README");
        expect(parseConflictCopyPath(p)?.originalPath).toBe("notes/README");
    });
});
