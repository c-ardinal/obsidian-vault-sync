import { describe, it, expect } from "vitest";
import { driveAdapterOnFakeServer, FakeDriveServer } from "../../helpers/fake-drive-server";
import type { CloudAdapter } from "../../../src/types/adapter";
import { TrashRemoteDeletion, listTrash, purgeTrash, restoreFromTrash } from "../../../src/sync-manager/remote-trash";

const bytes = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

/** A Drive adapter on the fake server whose clones (the trash folder) use the same server */
function driveOnFake(): { adapter: CloudAdapter; server: FakeDriveServer } {
    const { adapter, server } = driveAdapterOnFakeServer();
    const clone = adapter.cloneWithNewVaultName.bind(adapter);
    adapter.cloneWithNewVaultName = (name: string) => {
        const c = clone(name);
        (c as unknown as { http: { limitedFetch: FakeDriveServer["fetch"] } }).http.limitedFetch = server.fetch;
        return c;
    };
    return { adapter, server };
}

describe("remote trash on Google Drive", () => {
    it("copies into a folder next to the vault, removes the file, and restores the copy", async () => {
        const { adapter } = driveOnFake();
        const f = await adapter.uploadFile("Notes/a.md", bytes("hello"), 1000);
        const token = await adapter.getStartPageToken!();

        await new TrashRemoteDeletion(() => 30, () => Date.UTC(2026, 10, 20)).remove(
            adapter,
            { id: f.id, path: "Notes/a.md", kind: "file" },
            "user-file",
        );

        expect(await adapter.fileExistsById(f.id)).toBe(false);
        const listed = (await adapter.listFiles()).map((x) => x.path);
        expect(listed).not.toContain("Notes/a.md");
        // The vault's change feed reports the removal and never the copy as a vault file
        const changes = (await adapter.getChanges!(token)).changes;
        expect(changes).toContainEqual(expect.objectContaining({ fileId: f.id, removed: true }));
        expect(changes.filter((c) => !c.removed && c.file?.kind === "file")).toEqual([]);

        const trashed = await listTrash(adapter);
        expect(trashed).toEqual([expect.objectContaining({ originalPath: "Notes/a.md", day: "2026-11-20", size: 5 })]);

        expect(await restoreFromTrash(adapter, trashed[0])).toBe("Notes/a.md");
        const back = await adapter.getFileMetadata("Notes/a.md");
        expect(back?.id).toBe(trashed[0].id);
        expect(new TextDecoder().decode(await adapter.downloadFile(back!.id))).toBe("hello");
        expect(await listTrash(adapter)).toEqual([]);
    });

    it("purges day folders past the retention period", async () => {
        const { adapter } = driveOnFake();
        const day = (d: number) => Date.UTC(2026, 9, d);
        for (const [name, d] of [["old.md", 1], ["new.md", 30]] as const) {
            const f = await adapter.uploadFile(name, bytes(name), 1000);
            await new TrashRemoteDeletion(() => 30, () => day(d)).remove(adapter, { id: f.id, path: name, kind: "file" }, "user-file");
        }
        expect(await purgeTrash(adapter, 30, Date.UTC(2026, 10, 5))).toBe(1);
        expect((await listTrash(adapter)).map((t) => t.originalPath)).toEqual(["new.md"]);
    });
});
