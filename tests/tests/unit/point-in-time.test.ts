import { describe, it, expect } from "vitest";
import {
    applyRestore,
    countByAction,
    normalizeFolder,
    planRestore,
    revisionAt,
    type RestoreSource,
    type RestoreTarget,
} from "../../../src/sync-manager/point-in-time";
import type { FileRevision } from "../../../src/types/adapter";
import type { TrashedFile } from "../../../src/sync-manager/remote-trash";

const DAY = 24 * 60 * 60 * 1000;
const T = Date.UTC(2026, 10, 15, 12, 0, 0);
const rev = (id: string, t: number): FileRevision => ({ id, modifiedTime: t, size: 1 });

function source(
    history: Record<string, FileRevision[] | Error>,
    trash: TrashedFile[] = [],
    present = Object.keys(history),
): RestoreSource {
    return {
        files: () => Object.keys(history).map((path) => ({ path, fileId: `id:${path}` })),
        listRevisions: async (path) => {
            const h = history[path];
            if (h instanceof Error) throw h;
            return h;
        },
        listTrash: async () => trash,
        exists: (path) => present.includes(path),
        excluded: (path) => path.startsWith(".obsidian/"),
    };
}

describe("point-in-time restore", () => {
    it("picks the revision a file had at the time", () => {
        const revs = [rev("a", T - 2 * DAY), rev("b", T - DAY), rev("c", T + DAY)];
        expect(revisionAt(revs, T)).toEqual({ action: "restore", revision: revs[1] });
        expect(revisionAt(revs, T + 2 * DAY)).toEqual({ action: "unchanged", revision: revs[2] });
        expect(revisionAt(revs, T - 3 * DAY)).toEqual({ action: "created-after" });
        expect(revisionAt([], T).action).toBe("created-after");
    });

    it("plans a folder: restore, unchanged, created after, no history, deleted since", async () => {
        const trash: TrashedFile[] = [
            { id: "t1", originalPath: "Notes/gone.md", day: "2026-11-16", size: 1, mtime: 0 },
            { id: "t0", originalPath: "Notes/gone.md", day: "2026-11-18", size: 1, mtime: 0 },
            { id: "t2", originalPath: "Notes/old-delete.md", day: "2026-11-10", size: 1, mtime: 0 },
            { id: "t3", originalPath: "Other/gone.md", day: "2026-11-16", size: 1, mtime: 0 },
        ];
        const plan = await planRestore(
            source(
                {
                    "Notes/a.md": [rev("a1", T - DAY), rev("a2", T + DAY)],
                    "Notes/b.md": [rev("b1", T - DAY)],
                    "Notes/new.md": [rev("n1", T + DAY)],
                    "Notes/broken.md": new Error("network"),
                    "Other/x.md": [rev("x1", T - DAY), rev("x2", T + DAY)],
                    ".obsidian/app.json": [rev("s1", T - DAY), rev("s2", T + DAY)],
                },
                trash,
            ),
            " /Notes/ ",
            T,
            { concurrency: 2 },
        );
        expect(plan.folder).toBe("Notes");
        expect(plan.entries.map((e) => [e.path, e.action])).toEqual([
            ["Notes/a.md", "restore"],
            ["Notes/b.md", "unchanged"],
            ["Notes/broken.md", "no-history"],
            ["Notes/gone.md", "recreate"],
            ["Notes/new.md", "created-after"],
        ]);
        expect(plan.entries.find((e) => e.path === "Notes/gone.md")?.trashed?.id).toBe("t1");
        expect(countByAction(plan)).toEqual({
            restore: 1,
            unchanged: 1,
            "created-after": 1,
            "no-history": 1,
            recreate: 1,
        });
    });

    it("applies: writes restored and recreated files, removes new ones only when asked", async () => {
        const plan = await planRestore(
            source(
                { "a.md": [rev("a1", T - DAY), rev("a2", T + DAY)], "new.md": [rev("n1", T + DAY)] },
                [{ id: "t1", originalPath: "gone.md", day: "2026-11-15", size: 1, mtime: 0 }],
            ),
            "",
            T,
        );
        const written: string[] = [];
        const removed: string[] = [];
        const target: RestoreTarget = {
            revisionContent: async (path, id) => new TextEncoder().encode(`${path}@${id}`).buffer,
            trashContent: async (t) => new TextEncoder().encode(`trash:${t.id}`).buffer,
            write: async (path, data) => {
                written.push(`${path}=${new TextDecoder().decode(data)}`);
            },
            remove: async (path) => {
                removed.push(path);
            },
        };
        const kept = await applyRestore(target, plan, { removeCreatedAfter: false });
        expect(kept).toEqual({ restored: 1, recreated: 1, removed: 0, failed: [] });
        expect(written).toEqual(["a.md=a.md@a1", "gone.md=trash:t1"]);
        expect(removed).toEqual([]);

        const all = await applyRestore(target, plan, { removeCreatedAfter: true });
        expect(all.removed).toBe(1);
        expect(removed).toEqual(["new.md"]);
    });

    it("reports files it could not write and goes on", async () => {
        const plan = await planRestore(
            source({ "a.md": [rev("a1", T - DAY), rev("a2", T + DAY)], "b.md": [rev("b1", T - DAY), rev("b2", T + DAY)] }),
            "",
            T,
        );
        const result = await applyRestore(
            {
                revisionContent: async (path) => {
                    if (path === "a.md") throw new Error("gone");
                    return new ArrayBuffer(1);
                },
                trashContent: async () => new ArrayBuffer(0),
                write: async () => {},
                remove: async () => {},
            },
            plan,
            { removeCreatedAfter: false },
        );
        expect(result).toEqual({ restored: 1, recreated: 0, removed: 0, failed: ["a.md"] });
    });

    it("stops planning when cancelled", async () => {
        const signal = { aborted: false };
        const history: Record<string, FileRevision[]> = {};
        for (let i = 0; i < 20; i++) history[`f${i}.md`] = [rev("r", T - DAY)];
        const src = source(history);
        const inner = src.listRevisions;
        src.listRevisions = async (p, id) => {
            signal.aborted = true;
            return inner(p, id);
        };
        await expect(planRestore(src, "", T, { signal })).rejects.toThrow("Cancelled");
        expect(normalizeFolder("/")).toBe("");
    });
});
