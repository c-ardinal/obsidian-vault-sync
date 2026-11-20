import { describe, it, expect, beforeEach } from "vitest";
import type { CloudAdapter, CloudChanges } from "../../src/types/adapter";
import { cloudErrorKind, isCloudNotFound } from "../../src/cloud-adapters/cloud-error";
import { md5 } from "../../src/utils/md5";

export interface ContractHarness {
    adapter: CloudAdapter;
    /** Make getChanges() return at most n entries per page, to exercise paging */
    setChangesPageSize?(n: number): void;
}

const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
const dec = (b: ArrayBuffer) => new TextDecoder().decode(b);
const T0 = Date.UTC(2026, 0, 1);

async function drainChanges(adapter: CloudAdapter, token: string) {
    const all: CloudChanges["changes"] = [];
    let pages = 0;
    for (;;) {
        const page = await adapter.getChanges!(token);
        all.push(...page.changes);
        pages++;
        if (page.newStartPageToken) return { changes: all, next: page.newStartPageToken, pages };
        if (!page.nextPageToken) throw new Error("change page without either token");
        token = page.nextPageToken;
        if (pages > 1000) throw new Error("change feed does not end");
    }
}

/** Last reported state per file id */
function latest(changes: CloudChanges["changes"]) {
    const m = new Map<string, CloudChanges["changes"][number]>();
    for (const c of changes) m.set(c.fileId, c);
    return m;
}

/**
 * What every CloudAdapter must do, whatever cloud it talks to. Behaviour that
 * differs between clouds is checked against the adapter's own capabilities,
 * so a new provider declares what it is and the same suite tells whether the
 * declaration is true.
 */
export function describeAdapterContract(name: string, makeHarness: () => ContractHarness | Promise<ContractHarness>): void {
    describe(`CloudAdapter contract: ${name}`, () => {
        let h: ContractHarness;
        let a: CloudAdapter;
        beforeEach(async () => {
            h = await makeHarness();
            a = h.adapter;
        });

        it("declares its capabilities consistently with the methods it has", () => {
            const c = a.capabilities;
            expect(c).toBeDefined();
            for (const key of [
                "changeFeed", "revisions", "contentHash", "stableIds", "sameNameSiblings",
                "resumableChunkAlignment", "trash", "conditionalWrite",
            ]) {
                expect(c, key).toHaveProperty(key);
            }
            if (c.changeFeed) {
                expect(typeof a.getStartPageToken).toBe("function");
                expect(typeof a.getChanges).toBe("function");
            }
            if (c.revisions) {
                expect(typeof a.listRevisions).toBe("function");
                expect(typeof a.getRevisionContent).toBe("function");
            }
            if (c.resumableChunkAlignment !== null) {
                expect(Number.isInteger(c.resumableChunkAlignment)).toBe(true);
                expect(c.resumableChunkAlignment).toBeGreaterThan(0);
                expect(typeof a.initiateResumableSession).toBe("function");
                expect(typeof a.uploadChunk).toBe("function");
            }
        });

        it("stores an upload and finds it by path and by id", async () => {
            const bytes = enc("hello");
            const up = await a.uploadFile("notes/a.md", bytes, T0);
            expect(up.id).toBeTruthy();
            expect(up.path).toBe("notes/a.md");
            expect(up.size).toBe(5);
            expect(up.kind).toBe("file");

            const byPath = await a.getFileMetadata("notes/a.md");
            expect(byPath?.id).toBe(up.id);
            expect(byPath?.size).toBe(5);
            expect(byPath?.kind).toBe("file");

            const byId = await a.getFileMetadataById(up.id, "notes/a.md");
            expect(byId?.id).toBe(up.id);
            expect(byId?.path).toBe("notes/a.md");
            expect(await a.fileExistsById(up.id)).toBe(true);

            if (a.capabilities.contentHash === "md5") {
                expect(up.hash).toBe(md5(bytes));
                expect(byPath?.hash).toBe(md5(bytes));
            }
        });

        it("downloads the same bytes it stored", async () => {
            const bytes = new Uint8Array([0, 1, 2, 250, 255, 13, 10]).buffer;
            const up = await a.uploadFile("bin/data.bin", bytes, T0);
            expect(new Uint8Array(await a.downloadFile(up.id))).toEqual(new Uint8Array(bytes));
        });

        it("reports a missing file as null, not as an error", async () => {
            expect(await a.getFileMetadata("missing.md")).toBeNull();
            expect(await a.getFileMetadata("no/such/folder/missing.md")).toBeNull();
            const up = await a.uploadFile("gone.md", enc("x"), T0);
            await a.deleteFile(up.id);
            expect(await a.getFileMetadataById(up.id)).toBeNull();
            expect(await a.fileExistsById(up.id)).toBe(false);
        });

        it("updates in place when given the file id", async () => {
            const v1 = await a.uploadFile("u.md", enc("one"), T0);
            const v2 = await a.uploadFile("u.md", enc("two!"), T0 + 1000, v1.id);
            expect(v2.id).toBe(v1.id);
            expect(v2.size).toBe(4);
            expect(dec(await a.downloadFile(v1.id))).toBe("two!");
            if (a.capabilities.contentHash === "md5") expect(v2.hash).not.toBe(v1.hash);
        });

        it("updates the file already at the path when no id is given", async () => {
            const v1 = await a.uploadFile("same.md", enc("one"), T0);
            const v2 = await a.uploadFile("same.md", enc("two"), T0 + 1000);
            expect(v2.id).toBe(v1.id);
            expect(dec(await a.downloadFile(v1.id))).toBe("two");
        });

        it("handles a createOnly upload to a taken name as its capabilities say", async () => {
            const first = await a.uploadFile("dup.md", enc("first"), T0);
            const attempt = a.uploadFile("dup.md", enc("second"), T0 + 1000, undefined, { createOnly: true });
            if (a.capabilities.sameNameSiblings) {
                const second = await attempt;
                expect(second.id).not.toBe(first.id);
                expect(dec(await a.downloadFile(first.id))).toBe("first");
                expect(dec(await a.downloadFile(second.id))).toBe("second");
                const listed = (await a.listFiles()).filter((f) => f.path === "dup.md").map((f) => f.id);
                expect(listed.sort()).toEqual([first.id, second.id].sort());
            } else {
                await expect(attempt).rejects.toSatisfy((e: unknown) => cloudErrorKind(e) === "conflict");
                expect(dec(await a.downloadFile(first.id))).toBe("first");
            }
        });

        it("renames in place", async () => {
            const up = await a.uploadFile("r/old.md", enc("body"), T0);
            const moved = await a.moveFile(up.id, "new.md", "r");
            expect(moved.path).toBe("r/new.md");
            expect(await a.getFileMetadata("r/old.md")).toBeNull();
            const found = await a.getFileMetadata("r/new.md");
            expect(found).not.toBeNull();
            if (a.capabilities.stableIds) {
                expect(moved.id).toBe(up.id);
                expect(found?.id).toBe(up.id);
                // A caller holding the old path learns the current one
                expect((await a.getFileMetadataById(up.id, "r/old.md"))?.path).toBe("r/new.md");
            }
            expect(dec(await a.downloadFile(found!.id))).toBe("body");
        });

        it("moves into another folder, creating it", async () => {
            const up = await a.uploadFile("src.md", enc("moving"), T0);
            const moved = await a.moveFile(up.id, "dst.md", "dest/sub");
            expect(moved.path).toBe("dest/sub/dst.md");
            expect(await a.getFileMetadata("src.md")).toBeNull();
            const found = await a.getFileMetadata("dest/sub/dst.md");
            if (a.capabilities.stableIds) expect(found?.id).toBe(up.id);
            expect(dec(await a.downloadFile(found!.id))).toBe("moving");
        });

        it("deletes: the file is gone by path and id, and a download fails as not-found", async () => {
            const up = await a.uploadFile("d/x.md", enc("bye"), T0);
            await a.deleteFile(up.id);
            expect(await a.getFileMetadata("d/x.md")).toBeNull();
            expect(await a.getFileMetadataById(up.id, "d/x.md")).toBeNull();
            expect(await a.fileExistsById(up.id)).toBe(false);
            await expect(a.downloadFile(up.id)).rejects.toSatisfy((e: unknown) => isCloudNotFound(e));
        });

        it("lists every stored file with its vault path", async () => {
            const x = await a.uploadFile("l/one.md", enc("1"), T0);
            const y = await a.uploadFile("l/deep/two.md", enc("22"), T0);
            const files = (await a.listFiles()).filter((f) => f.kind === "file");
            const byId = new Map(files.map((f) => [f.id, f]));
            expect(byId.get(x.id)?.path).toBe("l/one.md");
            expect(byId.get(y.id)?.path).toBe("l/deep/two.md");
            expect(byId.get(y.id)?.size).toBe(2);
        });

        it("change feed: reports uploads and deletions since a token, page by page", async (ctx) => {
            if (!a.capabilities.changeFeed) return ctx.skip();
            const start = await a.getStartPageToken!();
            h.setChangesPageSize?.(1);
            const keep = await a.uploadFile("feed/keep.md", enc("k"), T0);
            const drop = await a.uploadFile("feed/drop.md", enc("d"), T0);
            await a.deleteFile(drop.id);

            const { changes, next, pages } = await drainChanges(a, start);
            if (h.setChangesPageSize) expect(pages).toBeGreaterThan(1);
            const last = latest(changes);
            expect(last.get(keep.id)?.removed).toBe(false);
            expect(last.get(keep.id)?.file?.path).toBe("feed/keep.md");
            if (a.capabilities.contentHash === "md5") expect(last.get(keep.id)?.file?.hash).toBe(md5(enc("k")));
            expect(last.get(drop.id)?.removed).toBe(true);

            // Nothing new since the returned token
            const again = await drainChanges(a, next);
            expect(again.changes.filter((c) => c.fileId === keep.id || c.fileId === drop.id)).toEqual([]);
        });

        it("change feed: a rename is reported with the new path", async (ctx) => {
            if (!a.capabilities.changeFeed) return ctx.skip();
            const up = await a.uploadFile("feed/before.md", enc("r"), T0);
            const start = await a.getStartPageToken!();
            await a.moveFile(up.id, "after.md", "feed");
            const { changes } = await drainChanges(a, start);
            const c = latest(changes).get(up.id);
            expect(c?.removed).toBe(false);
            expect(c?.file?.path).toBe("feed/after.md");
        });

        it("revisions: keeps earlier versions readable", async (ctx) => {
            if (!a.capabilities.revisions) return ctx.skip();
            const v1 = await a.uploadFile("h.md", enc("version one"), T0);
            await a.uploadFile("h.md", enc("version two"), T0 + 60_000, v1.id);
            const revs = await a.listRevisions!("h.md", v1.id);
            expect(revs.length).toBeGreaterThanOrEqual(2);
            const contents = await Promise.all(revs.map((r) => a.getRevisionContent!("h.md", r.id, v1.id)));
            expect(contents.map(dec)).toContain("version one");
            expect(contents.map(dec)).toContain("version two");
        });

        it("resumable upload: aligned chunks, null until the last one", async (ctx) => {
            const align = a.capabilities.resumableChunkAlignment;
            if (align === null) return ctx.skip();
            const total = align * 2 + 100;
            const data = new Uint8Array(total);
            for (let i = 0; i < total; i++) data[i] = i % 251;
            const uri = await a.initiateResumableSession!("big/file.bin", total, T0);
            expect(await a.uploadChunk!(uri, data.slice(0, align).buffer, 0, total, "big/file.bin", T0)).toBeNull();
            expect(await a.uploadChunk!(uri, data.slice(align, align * 2).buffer, align, total, "big/file.bin", T0)).toBeNull();
            const done = await a.uploadChunk!(uri, data.slice(align * 2).buffer, align * 2, total, "big/file.bin", T0);
            expect(done).not.toBeNull();
            expect(done!.size).toBe(total);
            expect(new Uint8Array(await a.downloadFile(done!.id))).toEqual(data);
            expect((await a.getFileMetadata("big/file.bin"))?.id).toBe(done!.id);
        });
    });
}
