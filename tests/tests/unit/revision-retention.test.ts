import { describe, it, expect, beforeEach } from "vitest";
import { forgetAutoKept, keepRevisionsIfDue, noteUploadedForRetention, versionsToThin } from "../../../src/sync-manager/revision-retention";
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

    it("only looks at Markdown notes by default", async () => {
        revisions["b.png"] = [rev("9", 0)];
        const { ctx, listed } = makeCtx(1, revisions);
        noteUploadedForRetention(ctx, "b.png", "id-b");
        expect(await keepRevisionsIfDue(ctx, NOW)).toBe(0);
        expect(listed).toEqual([]);
    });

    it("includes attachments when opted in, but never files under dot folders", async () => {
        revisions["img/b.png"] = [rev("9", 0)];
        revisions[".obsidian/plugins/x/main.js"] = [rev("8", 0)];
        const { ctx, marked } = makeCtx(1, revisions);
        (ctx.settings as { autoKeepAttachmentRevisions?: boolean }).autoKeepAttachmentRevisions = true;
        noteUploadedForRetention(ctx, "img/b.png", "id-b");
        noteUploadedForRetention(ctx, ".obsidian/plugins/x/main.js", "id-p");
        expect(await keepRevisionsIfDue(ctx, NOW)).toBe(1);
        expect(marked).toEqual([{ path: "img/b.png", id: "9" }]);
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

    describe("thinning auto-kept versions near Drive's limit", () => {
        const memVault = () => {
            const files = new Map<string, string>();
            return {
                files,
                exists: async (p: string) => files.has(p) || [...files.keys()].some((k) => k.startsWith(p + "/")),
                read: async (p: string) => files.get(p)!,
                write: async (p: string, d: string) => void files.set(p, d),
                mkdir: async () => {},
            };
        };

        it("removes auto-kept versions sharing a week, then keeps the new one", async () => {
            // 150 daily versions kept by this device, the oldest 400+ days back
            revisions["a.md"] = Array.from({ length: 150 }, (_, i) => rev(`k${i}`, 1 + i * 3, true));
            revisions["a.md"].push(rev("new", 0));
            const { ctx, marked } = makeCtx(1, revisions);
            const vault = memVault();
            vault.files.set("p/data/local/auto-kept-revisions.json", JSON.stringify({ "id-a": revisions["a.md"].slice(0, 150).map((r) => r.id) }));
            Object.assign(ctx, { vault, pluginDir: "p" });
            const released: string[] = [];
            const setKeep = ctx.adapter.setRevisionKeepForever!.bind(ctx.adapter);
            // As Drive: keepForever cannot be turned off; a version can be removed
            (ctx.adapter as any).setRevisionKeepForever = async (path: string, id: string, keep: boolean) => {
                if (!keep) throw new Error("Cannot update a revision to false");
                return setKeep(path, id, keep);
            };
            (ctx.adapter as any).deleteRevision = async (path: string, id: string) => {
                released.push(id);
                revisions[path] = revisions[path].filter((r) => r.id !== id);
            };
            noteUploadedForRetention(ctx, "a.md", "id-a");
            expect(await keepRevisionsIfDue(ctx, NOW)).toBe(1);
            expect(released.length).toBeGreaterThan(0);
            // Everything in the last 30 days stays
            const recent = revisions["a.md"].filter((r) => NOW - r.modifiedTime <= 30 * DAY && r.id !== "new");
            expect(recent.length).toBe(10);
            expect(recent.every((r) => r.keepForever)).toBe(true);
            expect(marked.at(-1)).toEqual({ path: "a.md", id: "new" });
            const rec = JSON.parse(vault.files.get("p/data/local/auto-kept-revisions.json")!);
            expect(rec["id-a"]).toContain("new");
            for (const id of released) expect(rec["id-a"]).not.toContain(id);
        });

        it("without version removal, a file at the cap is left as it is", async () => {
            revisions["a.md"] = Array.from({ length: 150 }, (_, i) => rev(`k${i}`, 1 + i * 3, true));
            revisions["a.md"].push(rev("new", 0));
            const { ctx, marked } = makeCtx(1, revisions);
            const vault = memVault();
            vault.files.set("p/data/local/auto-kept-revisions.json", JSON.stringify({ "id-a": revisions["a.md"].slice(0, 150).map((r) => r.id) }));
            Object.assign(ctx, { vault, pluginDir: "p" });
            noteUploadedForRetention(ctx, "a.md", "id-a");
            expect(await keepRevisionsIfDue(ctx, NOW)).toBe(0);
            expect(marked).toEqual([]);
            expect(revisions["a.md"].length).toBe(151);
        });

        it("never releases versions the user kept by hand", async () => {
            const kept = Array.from({ length: 150 }, (_, i) => ({ id: `k${i}`, modifiedTime: NOW - (40 + i) * DAY }));
            const auto = new Set(kept.filter((_, i) => i % 2 === 0).map((r) => r.id));
            const thin = versionsToThin(kept, auto, NOW);
            expect(thin.length).toBeGreaterThan(0);
            expect(thin.every((id) => auto.has(id))).toBe(true);
        });

        it("a version set by hand leaves the record", async () => {
            const { ctx } = makeCtx(1, revisions);
            const vault = memVault();
            vault.files.set("p/data/local/auto-kept-revisions.json", JSON.stringify({ f: ["x", "y"] }));
            Object.assign(ctx, { vault, pluginDir: "p" });
            await forgetAutoKept(ctx, "x");
            expect(JSON.parse(vault.files.get("p/data/local/auto-kept-revisions.json")!)).toEqual({ f: ["y"] });
        });
    });
});
