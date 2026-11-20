import { describe, it, expect, beforeEach } from "vitest";
import { MockCloudAdapter } from "../../helpers/mock-cloud-adapter";
import {
    TrashRemoteDeletion,
    deleteFromTrash,
    listTrash,
    purgeTrash,
    restoreFromTrash,
    trashAdapterOf,
    trashRootName,
} from "../../../src/sync-manager/remote-trash";

const bytes = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 20, 12);

describe("remote trash", () => {
    let cloud: MockCloudAdapter;
    let now: number;
    let strategy: TrashRemoteDeletion;
    let retention: number;

    beforeEach(() => {
        cloud = new MockCloudAdapter();
        cloud.cloneRoots = true;
        now = NOW;
        retention = 30;
        strategy = new TrashRemoteDeletion(() => retention, () => now);
    });

    it("keeps a copy of a deleted file in the trash next to the vault, then removes the file", async () => {
        const f = await cloud.uploadFile("Notes/a.md", bytes("A"), 1);
        const token = await cloud.getStartPageToken();
        await strategy.remove(cloud, { id: f.id, path: "Notes/a.md", kind: "file" }, "user-file");

        expect(await cloud.getFileMetadata("Notes/a.md")).toBeNull();
        expect(trashAdapterOf(cloud)?.vaultName).toBe(trashRootName(cloud.vaultName));
        const trashed = await listTrash(cloud);
        expect(trashed).toEqual([expect.objectContaining({ originalPath: "Notes/a.md", day: "2026-11-20" })]);
        expect(trashed[0].id).not.toBe(f.id);
        expect(await cloud.fileExistsById(f.id)).toBe(false);
        // Other devices see a removal; the copy outside the vault is never reported as a vault file
        const changes = (await cloud.getChanges(token)).changes;
        expect(changes).toContainEqual({ fileId: f.id, removed: true });
        expect(changes.every((c) => c.removed)).toBe(true);
        expect((await cloud.listFiles()).map((x) => x.path)).not.toContain("Notes/a.md");
    });

    it("copies each file of a deleted folder, then removes the folder", async () => {
        const folderId = cloud.addFakeFolder("Dir");
        const a = await cloud.uploadFile("Dir/a.md", bytes("A"), 1);
        const b = await cloud.uploadFile("Dir/sub/b.md", bytes("B"), 1);
        const token = await cloud.getStartPageToken();
        await strategy.remove(cloud, { id: folderId, path: "Dir", kind: "folder" }, "user-folder");

        expect((await listTrash(cloud)).map((t) => t.originalPath).sort()).toEqual(["Dir/a.md", "Dir/sub/b.md"]);
        expect((await cloud.getChanges(token)).changes.every((c) => c.removed)).toBe(true);
        expect(await cloud.fileExistsById(folderId)).toBe(false);
        expect(a.id).not.toBe(b.id);
    });

    it("keeps no copy for cleanups, nor for anything when the trash is off", async () => {
        const f = await cloud.uploadFile("x.md", bytes("X"), 1);
        await strategy.remove(cloud, { id: f.id, path: "x.md", kind: "file" }, "excluded-cleanup");
        expect(await listTrash(cloud)).toEqual([]);

        retention = -1;
        const g = await cloud.uploadFile("y.md", bytes("Y"), 1);
        await strategy.remove(cloud, { id: g.id, path: "y.md", kind: "file" }, "user-file");
        expect(await listTrash(cloud)).toEqual([]);
        expect(await cloud.fileExistsById(g.id)).toBe(false);
    });

    it("restores to the original path, or beside it when the path is taken", async () => {
        const f = await cloud.uploadFile("a.md", bytes("old"), 1);
        await strategy.remove(cloud, { id: f.id, path: "a.md", kind: "file" }, "user-file");
        const [t] = await listTrash(cloud);
        expect(await restoreFromTrash(cloud, t)).toBe("a.md");
        expect(cloud.getFileId("a.md")).toBe(t.id);
        expect(cloud.getCloudContent("a.md")).toBe("old");
        expect(await listTrash(cloud)).toEqual([]);

        await strategy.remove(cloud, { id: t.id, path: "a.md", kind: "file" }, "user-file");
        await cloud.uploadFile("a.md", bytes("new"), 2);
        const [t2] = await listTrash(cloud);
        expect(await restoreFromTrash(cloud, t2)).toBe("a (restored 2026-11-20).md");
        expect(cloud.getCloudContent("a (restored 2026-11-20).md")).toBe("old");
    });

    it("purges day folders older than the retention period, and deletes single files on request", async () => {
        const old = await cloud.uploadFile("old.md", bytes("1"), 1);
        now = NOW - 31 * DAY;
        await strategy.remove(cloud, { id: old.id, path: "old.md", kind: "file" }, "user-file");
        const recent = await cloud.uploadFile("recent.md", bytes("2"), 1);
        now = NOW - 29 * DAY;
        await strategy.remove(cloud, { id: recent.id, path: "recent.md", kind: "file" }, "user-file");
        const other = await cloud.uploadFile("other.md", bytes("3"), 1);
        now = NOW;
        await strategy.remove(cloud, { id: other.id, path: "other.md", kind: "file" }, "user-file");

        expect(await purgeTrash(cloud, 30, NOW)).toBe(1);
        expect((await listTrash(cloud)).map((t) => t.originalPath)).toEqual(["other.md", "recent.md"]);
        expect(await purgeTrash(cloud, -1, NOW)).toBe(0);

        const [first] = await listTrash(cloud);
        await deleteFromTrash(cloud, first);
        expect((await listTrash(cloud)).map((t) => t.originalPath)).toEqual(["recent.md"]);
    });
});

describe("remote trash on an adapter that cannot address another folder", () => {
    it("removes at once (a clone that is the adapter itself would move files inside the vault)", async () => {
        const cloud = new MockCloudAdapter(); // cloneRoots off: the clone is the adapter
        const f = await cloud.uploadFile("a.md", bytes("A"), 1);
        await new TrashRemoteDeletion(() => 30).remove(cloud, { id: f.id, path: "a.md", kind: "file" }, "user-file");
        expect(await cloud.fileExistsById(f.id)).toBe(false);
        expect(trashAdapterOf(cloud)).toBeNull();
        expect(await listTrash(cloud)).toEqual([]);
    });
});

describe("remote trash when a copy cannot be made", () => {
    it("removes without a copy when the storage is full, and retries later on a network error", async () => {
        const { CloudError } = await import("../../../src/cloud-adapters/cloud-error");
        const cloud = new MockCloudAdapter();
        cloud.cloneRoots = true;
        const strategy = new TrashRemoteDeletion(() => 30);
        const f = await cloud.uploadFile("a.md", bytes("A"), 1);
        cloud.setErrorOnMethod("copyFile", new CloudError("full", "quota-exceeded", 403));
        await strategy.remove(cloud, { id: f.id, path: "a.md", kind: "file" }, "user-file");
        expect(await cloud.fileExistsById(f.id)).toBe(false);

        const g = await cloud.uploadFile("b.md", bytes("B"), 1);
        cloud.setErrorOnMethod("copyFile", new CloudError("offline", "network"));
        await expect(
            strategy.remove(cloud, { id: g.id, path: "b.md", kind: "file" }, "user-file"),
        ).rejects.toThrow("offline");
        expect(await cloud.fileExistsById(g.id)).toBe(true);
    });
});
