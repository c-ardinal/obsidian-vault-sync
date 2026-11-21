/**
 * @file 同期の安全網（2026-11-20 テスト監査でシミュレーションが検出した不具合の回帰テスト）
 *
 * @pass_criteria
 * - 共有インデックスの送信に失敗した場合、送信対象が無い次回同期で再送する（再起動後も）
 * - クラウド側インデックスの読込に通信失敗した場合、自端末のインデックスで上書きしない
 * - 同期処理がパスを保持中に届いた編集通知を破棄せず、内容が変化していれば送信対象にする
 * - 上書き修復の予約（overwrite repair）をローカルインデックスと共に保存・復元する
 */
import { describe, it, expect, beforeEach } from "vitest";
import { MockCloudAdapter } from "../../helpers/mock-cloud-adapter";
import { DeviceSimulator } from "../../helpers/device-simulator";
import { smartPush } from "../../../src/sync-manager/sync-push";
import { markDirty, saveLocalIndex, loadLocalIndex } from "../../../src/sync-manager/state";
import { buildRemoteIndexPayload, owesIndexUpload } from "../../../src/sync-manager/sync-helpers";
import { overwriteRepairsSnapshot, restoreOverwriteRepairs } from "../../../src/sync-manager/overwrite-recovery";

const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

describe("shared index upload is retried", () => {
    let cloud: MockCloudAdapter;
    let device: DeviceSimulator;
    let ctx: any;

    beforeEach(() => {
        cloud = new MockCloudAdapter();
        device = new DeviceSimulator("A", cloud, "dev_A");
        ctx = device.getContext();
    });

    it("uploads the index on the next sync even when nothing else changed", async () => {
        device.app.vaultAdapter.setFile("note.md", "hello");
        ctx.dirtyPaths.set("note.md", Date.now());
        const realUpload = cloud.uploadFile.bind(cloud);
        cloud.uploadFile = async (path: string, ...rest: any[]) => {
            if (path === ctx.pluginDataPath) throw new Error("Network error");
            return (realUpload as any)(path, ...rest);
        };

        await smartPush(ctx, false);
        expect(cloud.getCloudContent("note.md")).toBe("hello");
        expect(await cloud.getFileMetadata(ctx.pluginDataPath)).toBeNull();
        expect(owesIndexUpload(ctx)).toBe(true);

        cloud.uploadFile = realUpload;
        expect(ctx.dirtyPaths.size).toBe(0);
        await smartPush(ctx, false);

        expect(await cloud.getFileMetadata(ctx.pluginDataPath)).not.toBeNull();
        expect(owesIndexUpload(ctx)).toBe(false);
    });

    it("keeps the debt across a restart once the index has an entry of its own", async () => {
        device.app.vaultAdapter.setFile("a.md", "1");
        ctx.dirtyPaths.set("a.md", Date.now());
        await smartPush(ctx, false); // index uploaded once: it has its own entry now
        expect(ctx.index[ctx.pluginDataPath]).toBeDefined();

        device.app.vaultAdapter.setFile("b.md", "2");
        ctx.dirtyPaths.set("b.md", Date.now());
        const realUpload = cloud.uploadFile.bind(cloud);
        cloud.uploadFile = async (path: string, ...rest: any[]) => {
            if (path === ctx.pluginDataPath) throw new Error("Network error");
            return (realUpload as any)(path, ...rest);
        };
        await smartPush(ctx, false);
        cloud.uploadFile = realUpload;

        // A fresh context (app restarted) reading what was saved
        const restarted = new DeviceSimulator("A", cloud, "dev_A");
        (restarted.app.vaultAdapter as any).files = (device.app.vaultAdapter as any).files;
        const rctx = restarted.getContext();
        rctx.index = JSON.parse(JSON.stringify(ctx.index));
        expect(owesIndexUpload(rctx)).toBe(true);
    });

    it("does not replace the cloud index when it cannot be read", async () => {
        // Another device's index lists a file this device does not know yet
        const other = await cloud.uploadFile("theirs.md", enc("x"), Date.now());
        const remoteIndex = { "theirs.md": { fileId: other.id, mtime: 1, size: 1, hash: other.hash } };
        const idx = await cloud.uploadFile(
            ctx.pluginDataPath,
            enc(JSON.stringify({ formatVersion: 1, index: remoteIndex })),
            Date.now(),
        );
        ctx.index[ctx.pluginDataPath] = { fileId: idx.id, mtime: 1, size: 1, hash: "older" };
        cloud.setErrorOnMethod("getFileMetadata", new Error("Network error (offline)"));

        await expect(buildRemoteIndexPayload(ctx)).rejects.toThrow(/Network/);
    });
});

describe("vault events that arrive while the engine holds the path", () => {
    let ctx: any;
    let device: DeviceSimulator;

    beforeEach(() => {
        const cloud = new MockCloudAdapter();
        device = new DeviceSimulator("A", cloud, "dev_A");
        ctx = device.getContext();
        device.setupSyncedFile("n.md", "synced", "file_x");
    });

    it("marks a real edit dirty at the next push", async () => {
        ctx.syncingPaths.add("n.md");
        device.app.vaultAdapter.setFile("n.md", "synced + typed during the merge");
        markDirty(ctx, "n.md");
        expect(ctx.dirtyPaths.has("n.md")).toBe(false); // held back while the engine works

        ctx.syncingPaths.delete("n.md");
        const { recheckEventsDuringSync } = await import("../../../src/sync-manager/sync-scan");
        await recheckEventsDuringSync(ctx);
        expect(ctx.dirtyPaths.has("n.md")).toBe(true);
    });

    it("ignores the echo of the engine's own write", async () => {
        ctx.syncingPaths.add("n.md");
        markDirty(ctx, "n.md"); // content unchanged: our own write
        ctx.syncingPaths.delete("n.md");
        const { recheckEventsDuringSync } = await import("../../../src/sync-manager/sync-scan");
        await recheckEventsDuringSync(ctx);
        expect(ctx.dirtyPaths.has("n.md")).toBe(false);
    });

    it("waits while the engine still holds the path", async () => {
        ctx.syncingPaths.add("n.md");
        device.app.vaultAdapter.setFile("n.md", "edited");
        markDirty(ctx, "n.md");
        const { recheckEventsDuringSync } = await import("../../../src/sync-manager/sync-scan");
        await recheckEventsDuringSync(ctx);
        expect(ctx.dirtyPaths.has("n.md")).toBe(false);
        ctx.syncingPaths.delete("n.md");
        await recheckEventsDuringSync(ctx);
        expect(ctx.dirtyPaths.has("n.md")).toBe(true);
    });
});

describe("owed overwrite repairs are saved with the local index", () => {
    it("restores repairs and checks after a restart", async () => {
        const cloud = new MockCloudAdapter();
        const device = new DeviceSimulator("A", cloud, "dev_A");
        const ctx = device.getContext();
        const repair = { fileId: "f1", overwrittenId: "rev_3", overwrittenHash: "aa", baseHash: "bb", since: 123 };
        const check = { fileId: "f2", ourHash: "cc", known: ["dd"], since: 456 };
        restoreOverwriteRepairs(ctx, { repairs: { "a.md": repair }, checks: { "b.md": check } });
        await saveLocalIndex(ctx, true);

        const restarted = new DeviceSimulator("A", cloud, "dev_A");
        (restarted.app.vaultAdapter as any).files = (device.app.vaultAdapter as any).files;
        const rctx = restarted.getContext();
        await loadLocalIndex(rctx);
        expect(overwriteRepairsSnapshot(rctx)).toEqual({ repairs: { "a.md": repair }, checks: { "b.md": check } });
    });

    it("drops malformed saved entries", () => {
        const ctx = {};
        restoreOverwriteRepairs(ctx, { repairs: { "a.md": { fileId: "f" } }, checks: { "b.md": "x" } });
        expect(overwriteRepairsSnapshot(ctx)).toBeUndefined();
    });
});
