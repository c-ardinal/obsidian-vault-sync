/**
 * buildRemoteIndexPayload: the uploaded sync-index.json must not drop entries
 * that other devices wrote since this device last pulled (last-writer-wins).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { buildRemoteIndexPayload } from "../../../src/sync-manager/sync-helpers";
import type { SyncContext } from "../../../src/sync-manager/context";
import { MockCloudAdapter } from "../../helpers/mock-cloud-adapter";

const INDEX = ".obsidian/plugins/cardinal-vault-syncer/data/remote/sync-index.json";
const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
const dec = (b: ArrayBuffer) => JSON.parse(new TextDecoder().decode(b));

describe("buildRemoteIndexPayload", () => {
    let cloud: MockCloudAdapter;
    let ctx: any;

    beforeEach(() => {
        cloud = new MockCloudAdapter();
        ctx = {
            adapter: cloud,
            pluginDataPath: INDEX,
            startPageToken: "7",
            index: {},
            log: async () => {},
        } as Partial<SyncContext>;
    });

    async function putRemoteIndex(index: Record<string, unknown>) {
        return cloud.uploadFile(INDEX, enc(JSON.stringify({ index })), 0);
    }

    it("keeps entries another device added after our last pull", async () => {
        const other = await cloud.uploadFile("b.md", enc("b"), 0);
        await putRemoteIndex({ "b.md": { fileId: other.id, hash: other.hash, mtime: 0, size: 1 } });
        ctx.index = { "a.md": { fileId: "file_x", hash: "h-a", mtime: 0, size: 1, lastAction: "push" } };

        const out = dec(await buildRemoteIndexPayload(ctx));
        expect(Object.keys(out.index).sort()).toEqual(["a.md", "b.md"]);
        expect(out.startPageToken).toBe("7");
        // Our own in-memory index is not polluted with files we don't have locally
        expect(ctx.index["b.md"]).toBeUndefined();
    });

    it("drops remote-only entries whose file was deleted or moved by us", async () => {
        const moved = await cloud.uploadFile("old.md", enc("x"), 0);
        await putRemoteIndex({
            "old.md": { fileId: moved.id, hash: moved.hash, mtime: 0, size: 1 },
            "gone.md": { fileId: "file_deleted", hash: "h", mtime: 0, size: 1 },
        });
        ctx.index = { "new.md": { fileId: moved.id, hash: moved.hash, mtime: 0, size: 1, lastAction: "push" } };

        const out = dec(await buildRemoteIndexPayload(ctx));
        expect(Object.keys(out.index)).toEqual(["new.md"]);
    });

    it("does not revert another device's newer version of a file we only pulled", async () => {
        await putRemoteIndex({ "n.md": { fileId: "f1", hash: "newer", mtime: 2, size: 1 } });
        ctx.index = { "n.md": { fileId: "f1", hash: "older", mtime: 1, size: 1, lastAction: "pull" } };
        expect(dec(await buildRemoteIndexPayload(ctx)).index["n.md"].hash).toBe("newer");

        ctx.index["n.md"].lastAction = "push"; // ...but our own fresh push wins
        expect(dec(await buildRemoteIndexPayload(ctx)).index["n.md"].hash).toBe("older");
    });

    it("skips the download when the remote index is the one we last saw", async () => {
        const meta = await putRemoteIndex({ "b.md": { fileId: "f", hash: "h", mtime: 0, size: 1 } });
        ctx.index = { [INDEX]: { fileId: meta.id, hash: meta.hash, mtime: 0, size: 0 } };
        const out = dec(await buildRemoteIndexPayload(ctx));
        expect(out.index["b.md"]).toBeUndefined();
    });
});
