/**
 * @file Sync-cycle performance behaviour
 *
 * @description
 * - communication.json is cached for read-only lock checks inside a sync cycle
 * - parallel merge-lock acquisitions on ONE device are coalesced into one
 *   load/save/verify round and never overwrite each other
 * - local-index writes are deferred inside a cycle and flushed at its end
 * - Changes API: all pages are processed in one call, and failed pulls are
 *   retried on the next call instead of being lost
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
    beginSyncCycle,
    endSyncCycle,
    acquireMergeLock,
    releaseMergeLock,
    checkMergeLock,
    loadCommunication,
    saveLocalIndex,
    LOCAL_INDEX_CHECKPOINT_EVERY,
} from "../../../src/sync-manager/state";
import { pullViaChangesAPI } from "../../../src/sync-manager/sync-pull";
import type { SyncContext } from "../../../src/sync-manager/context";
import { MockCloudAdapter } from "../../helpers/mock-cloud-adapter";

const COMM = ".obsidian/plugins/obsidian-vault-sync/communication.json";

function makeCtx(adapter: any, overrides: Record<string, unknown> = {}): SyncContext {
    const files = new Map<string, ArrayBuffer>();
    const vault = {
        exists: vi.fn(async (p: string) => files.has(p)),
        read: vi.fn(async (p: string) => new TextDecoder().decode(files.get(p)!)),
        readBinary: vi.fn(async (p: string) => files.get(p)!.slice(0)),
        write: vi.fn(async (p: string, d: string) => {
            files.set(p, new TextEncoder().encode(d).buffer as ArrayBuffer);
        }),
        writeBinary: vi.fn(async (p: string, d: ArrayBuffer) => {
            files.set(p, d.slice(0));
        }),
        mkdir: vi.fn(async () => {}),
        createFolder: vi.fn(async () => {}),
        stat: vi.fn(async (p: string) =>
            files.has(p) ? { type: "file", mtime: 1, size: files.get(p)!.byteLength } : null,
        ),
        getAbstractFileByPath: vi.fn(() => null),
    };
    return {
        vault,
        adapter,
        settings: { concurrency: 5, largeFileThresholdMB: 0, exclusionPatterns: "" } as any,
        index: {},
        localIndex: {},
        dirtyPaths: new Map(),
        syncingPaths: new Set(),
        deletedFolders: new Set(),
        pendingFolderMoves: new Map(),
        recentlyDeletedFromRemote: new Set(),
        pluginDataPath: ".obsidian/plugins/obsidian-vault-sync/data/remote/sync-index.json",
        localIndexPath: ".obsidian/plugins/obsidian-vault-sync/data/local/local-index.json",
        communicationPath: COMM,
        pluginDir: ".obsidian/plugins/obsidian-vault-sync",
        deviceId: "dev_A",
        e2eeEnabled: false,
        startPageToken: null,
        log: vi.fn(async () => {}),
        notify: vi.fn(async () => {}),
        startActivity: vi.fn(),
        logger: { markActionTaken: vi.fn() },
        backgroundTransferQueue: {
            markInlineStart: vi.fn(),
            markInlineEnd: vi.fn(),
            recordInlineTransfer: vi.fn(),
            enqueue: vi.fn(),
        },
        ...overrides,
    } as unknown as SyncContext;
}

function countingAdapter() {
    const cloud = new MockCloudAdapter();
    const calls: string[] = [];
    const proxy = new Proxy(cloud, {
        get(target, prop, receiver) {
            const v = Reflect.get(target, prop, receiver);
            if (typeof v !== "function") return v;
            return (...args: unknown[]) => {
                calls.push(String(prop));
                return (v as Function).apply(target, args);
            };
        },
    });
    return { cloud, adapter: proxy as any, calls };
}

describe("merge locks inside a sync cycle", () => {
    it("coalesces parallel acquisitions into one round and grants all of them", async () => {
        const { adapter, calls } = countingAdapter();
        const ctx = makeCtx(adapter);
        beginSyncCycle(ctx);
        const paths = ["a.md", "b.md", "c.md", "d.md", "e.md"];
        const results = await Promise.all(paths.map((p) => acquireMergeLock(ctx, p)));
        expect(results.every((r) => r.acquired)).toBe(true);

        // Every lock survived (no self-overwrite) — check from a fresh read
        const comm = await loadCommunication(ctx, { fresh: true });
        expect(Object.keys(comm.mergeLocks).sort()).toEqual(paths);

        // Queued together -> at most two load/save/verify rounds instead of five
        expect(calls.filter((c) => c === "uploadFile").length).toBeLessThanOrEqual(2);
        await endSyncCycle(ctx);
    });

    it("does not grant a lock held by another device", async () => {
        const { cloud, adapter } = countingAdapter();
        await cloud.uploadFile(
            COMM,
            new TextEncoder().encode(
                JSON.stringify({ mergeLocks: { "x.md": { holder: "dev_B", expiresAt: Date.now() + 60_000 } } }),
            ).buffer as ArrayBuffer,
            Date.now(),
        );
        const ctx = makeCtx(adapter);
        beginSyncCycle(ctx);
        const [x, y] = await Promise.all([acquireMergeLock(ctx, "x.md"), acquireMergeLock(ctx, "y.md")]);
        expect(x.acquired).toBe(false);
        expect(x.holder).toBe("dev_B");
        expect(y.acquired).toBe(true);
        await endSyncCycle(ctx);
    });

    it("serves checkMergeLock from the cycle cache and releases correctly", async () => {
        const { adapter, calls } = countingAdapter();
        const ctx = makeCtx(adapter);
        beginSyncCycle(ctx);
        for (let i = 0; i < 20; i++) await checkMergeLock(ctx, `f${i}.md`);
        expect(calls.filter((c) => c === "getFileMetadata").length).toBe(1);

        await acquireMergeLock(ctx, "a.md");
        await releaseMergeLock(ctx, "a.md");
        const comm = await loadCommunication(ctx, { fresh: true });
        expect(comm.mergeLocks["a.md"]).toBeUndefined();
        await endSyncCycle(ctx);

        // Outside a cycle every check hits the cloud again
        const before = calls.length;
        await checkMergeLock(ctx, "a.md");
        await checkMergeLock(ctx, "a.md");
        expect(calls.length - before).toBeGreaterThanOrEqual(2);
    });
});

describe("deferred local-index writes", () => {
    it("writes once at the end of the cycle (plus checkpoints)", async () => {
        const ctx = makeCtx(new MockCloudAdapter());
        beginSyncCycle(ctx);
        for (let i = 0; i < 10; i++) {
            ctx.localIndex[`f${i}.md`] = { fileId: `id${i}`, mtime: 0, size: 0, hash: "h" };
            await saveLocalIndex(ctx);
        }
        // Only the small journal (changed entries) is written in between
        const fullWrites = () =>
            (ctx.vault.write as any).mock.calls.filter((c: unknown[]) => c[0] === ctx.localIndexPath).length;
        expect(fullWrites()).toBe(0);
        await endSyncCycle(ctx);
        expect(fullWrites()).toBe(1);
        const saved = JSON.parse(await ctx.vault.read(ctx.localIndexPath));
        expect(Object.keys(saved.index)).toHaveLength(10);
    });

    it("still checkpoints during a long cycle", async () => {
        const ctx = makeCtx(new MockCloudAdapter());
        beginSyncCycle(ctx);
        for (let i = 0; i < LOCAL_INDEX_CHECKPOINT_EVERY; i++) await saveLocalIndex(ctx);
        expect(ctx.vault.write).toHaveBeenCalledTimes(1);
        await endSyncCycle(ctx);
    });
});

describe("Changes API draining and retry", () => {
    let cloud: MockCloudAdapter;
    beforeEach(() => {
        cloud = new MockCloudAdapter();
        cloud.changesPageSize = 3;
        cloud.changesLatestStateOnly = true;
    });

    const upload = (path: string, text: string) =>
        cloud.uploadFile(path, new TextEncoder().encode(text).buffer as ArrayBuffer, Date.now());

    it("processes every page in one call", async () => {
        const ctx = makeCtx(cloud);
        ctx.startPageToken = await cloud.getStartPageToken();
        ctx.index = { "seed.md": { fileId: "x", mtime: 0, size: 0, hash: "h" } };
        for (let i = 0; i < 10; i++) await upload(`notes/n${i}.md`, `note ${i}`);

        await pullViaChangesAPI(ctx);

        for (let i = 0; i < 10; i++) {
            expect(await ctx.vault.exists(`notes/n${i}.md`)).toBe(true);
        }
        expect(ctx.startPageToken).toBe(await cloud.getStartPageToken());
    });

    it("retries a failed pull on the next call", async () => {
        const ctx = makeCtx(cloud);
        ctx.startPageToken = await cloud.getStartPageToken();
        await upload("notes/a.md", "A");

        const realDownload = cloud.downloadFile.bind(cloud);
        const spy = vi.spyOn(cloud, "downloadFile").mockRejectedValueOnce(new Error("network"));
        await pullViaChangesAPI(ctx);
        expect(await ctx.vault.exists("notes/a.md")).toBe(false);

        spy.mockImplementation(realDownload);
        await pullViaChangesAPI(ctx); // no new changes, but the failed pull is retried
        expect(await ctx.vault.exists("notes/a.md")).toBe(true);
    });

    it("pulls a file the remote index lists but no change ever announced", async () => {
        const ctx = makeCtx(cloud);
        // File uploaded BEFORE this device took its first page token
        const early = await upload("notes/early.md", "early");
        ctx.startPageToken = await cloud.getStartPageToken();
        ctx.index = { "seed.md": { fileId: "x", mtime: 0, size: 0, hash: "h" } };
        // Another device then publishes an index that lists it
        await upload(
            ctx.pluginDataPath,
            JSON.stringify({ index: { "notes/early.md": { fileId: early.id, mtime: 0, size: 5, hash: early.hash } } }),
        );

        await pullViaChangesAPI(ctx);
        expect(await ctx.vault.exists("notes/early.md")).toBe(true);
    });

    it("does not resurrect a file the remote index still lists after it was deleted", async () => {
        const ctx = makeCtx(cloud);
        const gone = await upload("notes/gone.md", "gone");
        await cloud.deleteFile(gone.id);
        ctx.startPageToken = await cloud.getStartPageToken();
        ctx.index = { "seed.md": { fileId: "x", mtime: 0, size: 0, hash: "h" } };
        await upload(
            ctx.pluginDataPath,
            JSON.stringify({ index: { "notes/gone.md": { fileId: gone.id, mtime: 0, size: 4, hash: gone.hash } } }),
        );

        await pullViaChangesAPI(ctx);
        expect(await ctx.vault.exists("notes/gone.md")).toBe(false);
    });
});
