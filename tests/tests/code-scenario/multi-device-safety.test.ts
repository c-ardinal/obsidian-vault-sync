/**
 * @file 複数端末でのみ顕在化する安全性の回帰テスト
 *
 * @description
 * ランダム化シミュレーションで見つかったデータ消失系バグを、決定的な最小シナリオで固定する。
 *
 * @pass_criteria
 * - 他端末の削除より、こちらの未同期の編集が優先される（ノートは残り、再アップロード対象になる）
 * - リモート削除は、相手側で内容が変わっていれば実行しない
 * - 鍵の read-modify-write 用の読み込み失敗は空の鍵一覧として扱わない
 * - マージロックはパスが違っても fileId が同じなら衝突とみなす
 */
import { describe, it, expect, beforeEach } from "vitest";
import { MockCloudAdapter } from "../../helpers/mock-cloud-adapter";
import { DeviceSimulator } from "../../helpers/device-simulator";
import { smartPush } from "../../../src/sync-manager/sync-push";
import { findForeignLock, loadCommunication } from "../../../src/sync-manager/state";

const PATH = "notes/shared.md";
const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

describe("multi-device safety", () => {
    let cloud: MockCloudAdapter;
    let a: DeviceSimulator;
    let b: DeviceSimulator;
    let fileId: string;

    beforeEach(async () => {
        cloud = new MockCloudAdapter();
        const up = await cloud.uploadFile(PATH, enc("v1\n"), Date.now());
        fileId = up.id;
        a = new DeviceSimulator("A", cloud, "dev_A");
        b = new DeviceSimulator("B", cloud, "dev_B");
        a.setupSyncedFile(PATH, "v1\n", fileId);
        b.setupSyncedFile(PATH, "v1\n", fileId);
        b.getContext().startPageToken = await cloud.getStartPageToken();
        // The folder still exists, so the local delete is not taken for a folder delete
        await b.app.vaultAdapter.mkdir("notes");
    });

    it("keeps a locally edited note when another device deletes it", async () => {
        await cloud.deleteFile(fileId); // A deleted the note
        b.editFile(PATH, "v1\nedit made on B\n");

        await b.smartPull();

        expect(b.getLocalContent(PATH)).toBe("v1\nedit made on B\n");
        expect(b.getDirtyPaths().has(PATH)).toBe(true);
        expect(b.getIndex(PATH)).toBeUndefined(); // re-uploaded as a new file
    });

    it("still applies the deletion when the note was not edited locally", async () => {
        await cloud.deleteFile(fileId);
        await b.smartPull();
        expect(b.getLocalContent(PATH)).toBeNull();
    });

    it("does not delete a remote note that another device changed after our last sync", async () => {
        // A edits and uploads; B deletes its (older) copy before seeing that edit
        await cloud.uploadFile(PATH, enc("v1\nedit made on A\n"), Date.now(), fileId);
        const ctx = b.getContext();
        await ctx.vault.remove(PATH);
        b.syncManager.markDeleted(PATH);

        await smartPush(ctx, false);

        expect(cloud.getCloudContent(PATH)).toBe("v1\nedit made on A\n");
        expect(b.getLocalContent(PATH)).toBe("v1\nedit made on A\n"); // restored
    });

    it("deletes the remote note when nobody changed it", async () => {
        const ctx = b.getContext();
        await ctx.vault.remove(PATH);
        b.syncManager.markDeleted(PATH);
        await smartPush(ctx, false);
        expect(cloud.getCloudContent(PATH)).toBeNull();
    });

    it("never turns a failed fresh read of communication.json into an empty lock map", async () => {
        const ctx = a.getContext();
        const original = ctx.adapter.getFileMetadata.bind(ctx.adapter);
        ctx.adapter.getFileMetadata = async () => {
            throw new Error("network down");
        };
        try {
            await expect(loadCommunication(ctx, { fresh: true })).rejects.toThrow("network down");
            // Non-fresh readers (status checks) still degrade gracefully
            await expect(loadCommunication(ctx)).resolves.toMatchObject({ mergeLocks: {} });
        } finally {
            ctx.adapter.getFileMetadata = original;
        }
    });

    it("sees another device's merge lock on the same file under a different path", () => {
        const ctx = b.getContext();
        const comm = {
            mergeLocks: {
                "archive/renamed.md": { holder: "dev_A", expiresAt: Date.now() + 60_000, fileId },
            },
        };
        const lock = findForeignLock(ctx, comm, PATH);
        expect(lock?.holder).toBe("dev_A");
        expect(lock?.path).toBe("archive/renamed.md");
        // Our own lock is not foreign
        comm.mergeLocks["archive/renamed.md"].holder = "dev_B";
        expect(findForeignLock(ctx, comm, PATH)).toBeNull();
    });
});

describe("names that are one file on Windows/macOS", () => {
    let cloud: MockCloudAdapter;
    let b: DeviceSimulator;

    beforeEach(async () => {
        cloud = new MockCloudAdapter();
        b = new DeviceSimulator("B", cloud, "dev_B");
        b.getContext().startPageToken = await cloud.getStartPageToken();
        await b.app.vaultAdapter.mkdir("notes");
    });

    async function pullBoth(existing: string, incoming: string) {
        const ex = await cloud.uploadFile(existing, enc("existing\n"), Date.now());
        b.setupSyncedFile(existing, "existing\n", ex.id);
        await cloud.uploadFile(incoming, enc("incoming\n"), Date.now());
        await b.smartPull();
        const cloudFiles = ["notes/Todo.md", "notes/todo.md", "notes/Todo (2).md", "notes/todo (2).md"]
            .map((p) => [p, cloud.getCloudContent(p)] as const)
            .filter(([, c]) => c !== null);
        return Object.fromEntries(cloudFiles);
    }

    it("keeps both notes under names that no longer collide, in the cloud and locally", async () => {
        const onCloud = await pullBoth("notes/todo.md", "notes/Todo.md");
        expect(Object.values(onCloud).sort()).toEqual(["existing\n", "incoming\n"]);
        const keys = Object.keys(onCloud).map((p) => p.toLowerCase());
        expect(new Set(keys).size).toBe(2);
        for (const [p, c] of Object.entries(onCloud)) expect(b.getLocalContent(p)).toBe(c);
    });

    it("renames the same note of the pair whichever one a device sees first", async () => {
        // Device B knows "todo.md" and pulls "Todo.md"; device C the other way round.
        const onB = await pullBoth("notes/todo.md", "notes/Todo.md");
        const renamedOnB = Object.entries(onB).find(([p]) => p.includes("(2)"))![1];

        const cloud2 = new MockCloudAdapter();
        const c = new DeviceSimulator("C", cloud2, "dev_C");
        c.getContext().startPageToken = await cloud2.getStartPageToken();
        await c.app.vaultAdapter.mkdir("notes");
        // Same file ids as on B's cloud: "existing" first, "incoming" second
        const first = await cloud2.uploadFile("notes/todo.md", enc("existing\n"), Date.now());
        const second = await cloud2.uploadFile("notes/Todo.md", enc("incoming\n"), Date.now());
        c.getContext().startPageToken = await cloud2.getStartPageToken();
        c.setupSyncedFile("notes/Todo.md", "incoming\n", second.id);
        await cloud2.uploadFile("notes/todo.md", enc("existing\n"), Date.now(), first.id); // C now sees it arrive
        await c.smartPull();
        const renamedOnC = ["notes/Todo (2).md", "notes/todo (2).md"]
            .map((p) => cloud2.getCloudContent(p))
            .find((x) => x !== null);
        expect(renamedOnC).toBe(renamedOnB);
    });
});
