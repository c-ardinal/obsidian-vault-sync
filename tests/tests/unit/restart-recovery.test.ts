/**
 * @file Recovery after the app is killed mid-sync, and hashing
 *
 * @description
 * The multi-device simulator's "restart" and "large-files" scenarios found
 * these; each case here pins one of them at unit level:
 * - saveIndex writes the local index at once even inside a sync cycle
 *   (the index and its Changes token were newer than the local index)
 * - unknown-outcome uploads and owed pulls are persisted with the local index
 *   and restored on startup; stale background-transfer markers are cleared
 * - a sync manager scans the vault on its first sync even when not asked,
 *   until a scan got through (see sync-coordinator.test.ts)
 * - the vault scan re-marks renames recorded in the index but never pushed
 * - remote index entries this device carried into its upload survive the next
 *   upload while the remote index is still its own
 * - md5 / hashContent: speed-ups give byte-identical results
 */
import { describe, it, expect, vi } from "vitest";
import { createHash } from "crypto";
import {
    beginSyncCycle,
    endSyncCycle,
    saveIndex,
    saveLocalIndex,
    loadLocalIndex,
} from "../../../src/sync-manager/state";
import {
    recordAttemptedUpload,
    isAttemptedUpload,
    peekAttemptedUpload,
    forgetAttemptedVersion,
    pendingPullsOf,
    buildRemoteIndexPayload,
} from "../../../src/sync-manager/sync-helpers";
import { scanVaultChanges } from "../../../src/sync-manager/sync-scan";
import { hashContent } from "../../../src/sync-manager/file-utils";
import { md5 } from "../../../src/utils/md5";
import type { SyncContext } from "../../../src/sync-manager/context";

const LOCAL = ".obsidian/plugins/obsidian-vault-sync/data/local/local-index.json";
const REMOTE = ".obsidian/plugins/obsidian-vault-sync/data/remote/sync-index.json";

function makeCtx(overrides: Record<string, unknown> = {}): SyncContext & { files: Map<string, ArrayBuffer> } {
    const files = new Map<string, ArrayBuffer>();
    const mtimes = new Map<string, number>();
    const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
    const vault = {
        exists: vi.fn(async (p: string) => files.has(p)),
        read: vi.fn(async (p: string) => new TextDecoder().decode(files.get(p)!)),
        readBinary: vi.fn(async (p: string) => files.get(p)!.slice(0)),
        write: vi.fn(async (p: string, d: string) => {
            files.set(p, enc(d));
        }),
        writeBinary: vi.fn(async (p: string, d: ArrayBuffer) => {
            files.set(p, d.slice(0));
        }),
        mkdir: vi.fn(async () => {}),
        stat: vi.fn(async (p: string) => (files.has(p) ? { type: "file", mtime: mtimes.get(p) ?? 1, size: 1 } : null)),
        getFiles: vi.fn(() =>
            [...files.keys()]
                .filter((p) => !p.startsWith(".obsidian/"))
                .map((p) => ({ path: p, stat: { mtime: mtimes.get(p) ?? 1, size: files.get(p)!.byteLength } })),
        ),
    };
    return {
        files,
        vault,
        settings: { exclusionPatterns: "" } as any,
        index: {},
        localIndex: {},
        dirtyPaths: new Map(),
        syncingPaths: new Set(),
        recentlyDeletedFromRemote: new Set(),
        pluginDataPath: REMOTE,
        localIndexPath: LOCAL,
        pluginDir: ".obsidian/plugins/obsidian-vault-sync",
        logFolder: ".obsidian/plugins/obsidian-vault-sync/logs/dev_A",
        deviceId: "dev_A",
        e2eeEnabled: false,
        startPageToken: "42",
        log: vi.fn(async () => {}),
        ...overrides,
    } as unknown as SyncContext & { files: Map<string, ArrayBuffer> };
}

function persistedLocal(ctx: { files: Map<string, ArrayBuffer> }): any {
    return JSON.parse(new TextDecoder().decode(ctx.files.get(LOCAL)!));
}

describe("index persistence inside a sync cycle", () => {
    it("saveLocalIndex is deferred inside a cycle, but saveIndex writes the local index at once", async () => {
        const ctx = makeCtx();
        beginSyncCycle(ctx);
        ctx.localIndex["a.md"] = { fileId: "1", hash: "h1", mtime: 1, size: 1 } as any;
        await saveLocalIndex(ctx);
        expect(ctx.files.has(LOCAL)).toBe(false); // deferred

        ctx.index["a.md"] = { fileId: "1", hash: "h1", mtime: 1, size: 1 } as any;
        await saveIndex(ctx); // e.g. the Changes API token moved on
        expect(persistedLocal(ctx).index["a.md"].hash).toBe("h1");
        await endSyncCycle(ctx);
    });
});

describe("state that must survive a restart", () => {
    it("persists unknown-outcome uploads and restores them on startup", async () => {
        const before = makeCtx();
        recordAttemptedUpload(before, "new.md", "AAA");
        recordAttemptedUpload(before, "new.md", "bbb");
        await saveLocalIndex(before);

        const after = makeCtx();
        after.files.set(LOCAL, before.files.get(LOCAL)!);
        await loadLocalIndex(after);
        expect(isAttemptedUpload(after, "new.md", "aaa")).toBe(true);
        expect(isAttemptedUpload(after, "new.md", "BBB")).toBe(true);
        expect(peekAttemptedUpload(after, "new.md")).toBe("bbb");
    });

    it("keeps an older unknown-outcome version when a newer upload is written ahead", () => {
        const ctx = makeCtx();
        recordAttemptedUpload(ctx, "n.md", "old");
        recordAttemptedUpload(ctx, "n.md", "new"); // write-ahead of the next attempt
        forgetAttemptedVersion(ctx, "n.md", "new"); // ...that was never sent
        expect(isAttemptedUpload(ctx, "n.md", "old")).toBe(true);
        expect(isAttemptedUpload(ctx, "n.md", "new")).toBe(false);
    });

    it("persists owed Changes API pulls; restored ones are retried inline", async () => {
        const before = makeCtx();
        pendingPullsOf(before).set("f1", {
            file: { id: "f1", path: "big.pdf", hash: "h", size: 9, mimeType: "x" },
            attempts: 1,
            background: true,
        });
        await saveLocalIndex(before);
        const saved = persistedLocal(before).pendingPulls.f1;
        expect(saved).toEqual({ file: { id: "f1", path: "big.pdf", hash: "h", size: 9 }, attempts: 1 });

        const after = makeCtx();
        after.files.set(LOCAL, before.files.get(LOCAL)!);
        await loadLocalIndex(after);
        const restored = pendingPullsOf(after).get("f1")!;
        expect(restored.file.path).toBe("big.pdf");
        expect(restored.background).toBeUndefined(); // the queue did not survive
    });

    it("clears background-transfer markers on startup (the queue is gone)", async () => {
        const ctx = makeCtx();
        ctx.files.set(
            LOCAL,
            new TextEncoder().encode(
                JSON.stringify({
                    deviceId: "dev_A",
                    index: { "a.png": { fileId: "1", hash: "h", mtime: 1, size: 1, pendingTransfer: { direction: "pull", enqueuedAt: 1, snapshotHash: "h" } } },
                }),
            ).buffer as ArrayBuffer,
        );
        await loadLocalIndex(ctx);
        expect(ctx.localIndex["a.png"].pendingTransfer).toBeUndefined();
    });
});

describe("vault scan after a restart", () => {
    it("re-marks a rename that is recorded in the index but was never pushed", async () => {
        const ctx = makeCtx();
        ctx.files.set("new-name.md", new TextEncoder().encode("x").buffer as ArrayBuffer);
        const entry = { fileId: "1", hash: md5(ctx.files.get("new-name.md")!), mtime: 5, size: 1 };
        ctx.index["new-name.md"] = { ...entry, forcePush: true, pendingMove: { oldPath: "old.md" } } as any;
        ctx.localIndex["new-name.md"] = { ...entry, forcePush: true, pendingMove: { oldPath: "old.md" } } as any;

        await scanVaultChanges(ctx);
        expect(ctx.dirtyPaths.has("new-name.md")).toBe(true);
    });
});

describe("remote index entries carried between uploads", () => {
    it("keeps a remote-only entry in the next upload while the remote index is still ours", async () => {
        const remote = { index: { "big.pdf": { fileId: "f9", hash: "rh", mtime: 1, size: 1 } } };
        let remoteHash = "other";
        const adapter = {
            getFileMetadata: vi.fn(async () => ({ id: "idx", hash: remoteHash })),
            downloadFile: vi.fn(async () => new TextEncoder().encode(JSON.stringify(remote)).buffer),
            fileExistsById: vi.fn(async () => true),
            getFileMetadataById: vi.fn(async () => null),
        };
        const ctx = makeCtx({ adapter });
        ctx.index[REMOTE] = { fileId: "idx", hash: "seen-before", mtime: 1, size: 1 } as any;

        const first = JSON.parse(new TextDecoder().decode(await buildRemoteIndexPayload(ctx)));
        expect(first.index["big.pdf"]).toBeDefined();

        // We uploaded that payload; the remote index is now our own upload
        remoteHash = "ours";
        ctx.index[REMOTE] = { fileId: "idx", hash: "ours", mtime: 2, size: 1 } as any;
        const second = JSON.parse(new TextDecoder().decode(await buildRemoteIndexPayload(ctx)));
        expect(adapter.downloadFile).toHaveBeenCalledTimes(1); // no re-download
        expect(second.index["big.pdf"]).toEqual(remote.index["big.pdf"]);
    });

    it("drops a carried entry once the file is gone from the cloud", async () => {
        const remote = { index: { "gone.pdf": { fileId: "f9", hash: "rh", mtime: 1, size: 1 } } };
        let exists = true;
        let remoteHash = "other";
        const adapter = {
            getFileMetadata: vi.fn(async () => ({ id: "idx", hash: remoteHash })),
            downloadFile: vi.fn(async () => new TextEncoder().encode(JSON.stringify(remote)).buffer),
            fileExistsById: vi.fn(async () => exists),
            getFileMetadataById: vi.fn(async () => null),
        };
        const ctx = makeCtx({ adapter });
        ctx.index[REMOTE] = { fileId: "idx", hash: "seen-before", mtime: 1, size: 1 } as any;
        await buildRemoteIndexPayload(ctx);

        remoteHash = "ours";
        ctx.index[REMOTE] = { fileId: "idx", hash: "ours", mtime: 2, size: 1 } as any;
        exists = false;
        const next = JSON.parse(new TextDecoder().decode(await buildRemoteIndexPayload(ctx)));
        expect(next.index["gone.pdf"]).toBeUndefined();
    });
});

describe("hashing", () => {
    const legacyHashContent = (c: ArrayBuffer) =>
        md5(new TextEncoder().encode(new TextDecoder().decode(c).replace(/\r\n/g, "\n")).buffer as ArrayBuffer);

    it("md5 matches the reference implementation for every length around block boundaries", () => {
        for (let len = 0; len < 300; len++) {
            const b = new Uint8Array(len).map((_, i) => (i * 31 + len) & 0xff);
            expect(md5(b.buffer)).toBe(createHash("md5").update(b).digest("hex"));
        }
        const big = new Uint8Array(3 * 1024 * 1024 + 17).map((_, i) => (i * 2654435761) >>> 24);
        expect(md5(big.buffer)).toBe(createHash("md5").update(big).digest("hex"));
    });

    it("hashContent's fast path gives exactly the previous results", async () => {
        const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
        const cases: ArrayBuffer[] = [
            enc(""),
            enc("plain\n"),
            enc("crlf\r\nline"),
            enc("﻿bom"),
            enc("日本語のノート\n"),
            enc("lone\rcr"),
            new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x80, 0x00]).buffer,
            new Uint8Array([0xef, 0xbb]).buffer,
            new Uint8Array([0xc3]).buffer,
        ];
        for (let n = 0; n < 200; n++) {
            const b = new Uint8Array(n % 40).map(() => (Math.random() < 0.6 ? 0x61 : Math.floor(Math.random() * 256)));
            cases.push(b.buffer);
        }
        for (const c of cases) expect(await hashContent(c)).toBe(legacyHashContent(c));
    });
});

describe("renames survive a restart", () => {
    it("a rename of a synced note is saved at once, not at the next push", async () => {
        const { markRenamed } = await import("../../../src/sync-manager/state");
        const ctx = makeCtx();
        const entry = { fileId: "f1", hash: "h", mtime: 1, size: 1 } as any;
        ctx.index["old.md"] = { ...entry };
        ctx.localIndex["old.md"] = { ...entry };
        markRenamed(ctx, "old.md", "new.md");
        await vi.waitFor(() => expect(ctx.files.has(LOCAL)).toBe(true));
        const saved = persistedLocal(ctx).index;
        expect(saved["old.md"]).toBeUndefined();
        expect(saved["new.md"].pendingMove).toEqual({ oldPath: "old.md" });
    });

    it("after a restart, renaming a note whose upload result is unknown is tracked as unsynced", async () => {
        const { markRenamed, takeUnsyncedRename } = await import("../../../src/sync-manager/state");
        const ctx = makeCtx(); // fresh start: nothing dirty in memory
        recordAttemptedUpload(ctx, "draft.md", "abc");
        markRenamed(ctx, "draft.md", "final.md");
        expect(takeUnsyncedRename(ctx, "draft.md")).toBe("final.md");
    });
});
