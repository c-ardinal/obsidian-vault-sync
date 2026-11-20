import { describe, it, expect, beforeEach } from "vitest";
import { keepRevisionsIfDue, noteUploadedForRetention } from "../../../src/sync-manager/revision-retention";
import { NO_CLOUD_CAPABILITIES, type CloudAdapter, type FileRevision } from "../../../src/types/adapter";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 20, 12);

function makeCtx(days: number, revisions: Record<string, FileRevision[]>) {
    const marked: { path: string; id: string }[] = [];
    const listed: string[] = [];
    const adapter = {
        capabilities: { ...NO_CLOUD_CAPABILITIES, revisions: true },
        async listRevisions(path: string) {
            listed.push(path);
            if (!revisions[path]) throw new Error("boom");
            return revisions[path].map((r) => ({ ...r }));
        },
        async setRevisionKeepForever(path: string, id: string) {
            marked.push({ path, id });
            const r = revisions[path].find((x) => x.id === id);
            if (r) r.keepForever = true;
        },
    } as unknown as CloudAdapter;
    const ctx = {
        adapter,
        settings: { autoKeepRevisionDays: days },
        log: async () => {},
    };
    return { ctx, marked, listed };
}

const rev = (id: string, ageDays: number, keepForever = false): FileRevision => ({
    id,
    modifiedTime: NOW - ageDays * DAY,
    size: 1,
    keepForever,
});

describe("revision retention", () => {
    let revisions: Record<string, FileRevision[]>;
    beforeEach(() => {
        revisions = { "a.md": [rev("1", 5), rev("2", 0)] };
    });

    it("keeps the newest version of an uploaded note", async () => {
        const { ctx, marked } = makeCtx(1, revisions);
        noteUploadedForRetention(ctx, "a.md", "id-a");
        expect(await keepRevisionsIfDue(ctx, NOW)).toBe(1);
        expect(marked).toEqual([{ path: "a.md", id: "2" }]);
    });

    it("does nothing when disabled", async () => {
        const { ctx, marked, listed } = makeCtx(-1, revisions);
        noteUploadedForRetention(ctx, "a.md", "id-a");
        expect(await keepRevisionsIfDue(ctx, NOW)).toBe(0);
        expect(marked).toEqual([]);
        expect(listed).toEqual([]);
    });

    it("only looks at Markdown notes", async () => {
        revisions["b.png"] = [rev("9", 0)];
        const { ctx, listed } = makeCtx(1, revisions);
        noteUploadedForRetention(ctx, "b.png", "id-b");
        expect(await keepRevisionsIfDue(ctx, NOW)).toBe(0);
        expect(listed).toEqual([]);
    });

    it("skips a note with a version kept within the interval", async () => {
        revisions["a.md"] = [rev("1", 0.5, true), rev("2", 0)];
        const { ctx, marked } = makeCtx(1, revisions);
        noteUploadedForRetention(ctx, "a.md", "id-a");
        expect(await keepRevisionsIfDue(ctx, NOW)).toBe(0);
        expect(marked).toEqual([]);
    });

    it("marks again once the last kept version is older than the interval", async () => {
        revisions["a.md"] = [rev("1", 3, true), rev("2", 0)];
        const { ctx, marked } = makeCtx(2, revisions);
        noteUploadedForRetention(ctx, "a.md", "id-a");
        expect(await keepRevisionsIfDue(ctx, NOW)).toBe(1);
        expect(marked).toEqual([{ path: "a.md", id: "2" }]);
    });

    it("looks at a note at most once per interval", async () => {
        const { ctx, listed } = makeCtx(1, revisions);
        noteUploadedForRetention(ctx, "a.md", "id-a");
        await keepRevisionsIfDue(ctx, NOW);
        noteUploadedForRetention(ctx, "a.md", "id-a");
        await keepRevisionsIfDue(ctx, NOW + DAY / 2);
        expect(listed).toEqual(["a.md"]);
        revisions["a.md"].push(rev("3", -1.5));
        noteUploadedForRetention(ctx, "a.md", "id-a");
        expect(await keepRevisionsIfDue(ctx, NOW + 1.5 * DAY)).toBe(1);
        expect(listed).toEqual(["a.md", "a.md"]);
    });

    it("leaves a note alone once it has many kept versions", async () => {
        revisions["a.md"] = Array.from({ length: 150 }, (_, i) => rev(`k${i}`, 400 + i, true));
        revisions["a.md"].push(rev("new", 0));
        const { ctx, marked } = makeCtx(1, revisions);
        noteUploadedForRetention(ctx, "a.md", "id-a");
        expect(await keepRevisionsIfDue(ctx, NOW)).toBe(0);
        expect(marked).toEqual([]);
    });

    it("skips failures and carries on with other notes", async () => {
        revisions["c.md"] = [rev("5", 0)];
        const { ctx, marked } = makeCtx(1, revisions);
        noteUploadedForRetention(ctx, "missing.md", "id-x");
        noteUploadedForRetention(ctx, "c.md", "id-c");
        expect(await keepRevisionsIfDue(ctx, NOW)).toBe(1);
        expect(marked).toEqual([{ path: "c.md", id: "5" }]);
    });
});
