/**
 * @file Sync Scan テスト
 *
 * @description
 * scanObsidianChanges / scanVaultChanges の変更検出ロジックをテストする。
 * standalone関数をモックSyncContextで直接テストする。
 *
 * @pass_criteria
 * - 新規ファイル検出 → dirtyPaths に追加
 * - mtime変更+ハッシュ不一致 → dirtyPaths に追加
 * - mtime変更+ハッシュ一致 → mtime更新のみ (dirtyPathsに追加しない)
 * - ローカル削除 → dirtyPaths に追加 (リモートに存在する場合)
 * - recentlyDeletedFromRemote のファイルはスキップ
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { scanObsidianChanges, scanVaultChanges } from "../../../src/sync-manager/sync-scan";
import { md5 } from "../../../src/utils/md5";
import type { SyncContext } from "../../../src/sync-manager/context";
import { TFile } from "obsidian";

// ─── Helpers ───

function encode(str: string): ArrayBuffer {
    return new TextEncoder().encode(str).buffer as ArrayBuffer;
}

function hashStr(str: string): string {
    return md5(encode(str));
}

/** Create a mock SyncContext with controllable file system */
function createMockCtx(): SyncContext & {
    _files: Map<string, { content: ArrayBuffer; mtime: number }>;
} {
    const files = new Map<string, { content: ArrayBuffer; mtime: number }>();

    const vault: any = {
        stat: vi.fn(async (path: string) => {
            const f = files.get(path);
            if (!f) return null;
            return { mtime: f.mtime, size: f.content.byteLength, ctime: f.mtime };
        }),
        readBinary: vi.fn(async (path: string) => {
            const f = files.get(path);
            if (!f) throw new Error(`Not found: ${path}`);
            return f.content.slice(0);
        }),
        list: vi.fn(async (dir: string) => {
            const prefix = dir === "" || dir === "/" ? "" : dir + "/";
            const result: string[] = [];
            const folders = new Set<string>();
            for (const path of files.keys()) {
                if (path.startsWith(prefix)) {
                    const relative = path.slice(prefix.length);
                    const slashIdx = relative.indexOf("/");
                    if (slashIdx === -1) {
                        result.push(path); // Return full paths
                    } else {
                        folders.add(prefix + relative.slice(0, slashIdx));
                    }
                }
            }
            return { files: result, folders: [...folders] };
        }),
        getFiles: vi.fn(() => {
            const tfiles: TFile[] = [];
            for (const [path, data] of files.entries()) {
                const tf = new TFile();
                tf.path = path;
                tf.name = path.split("/").pop() || path;
                tf.basename = tf.name.replace(/\.[^.]+$/, "");
                tf.extension = tf.name.split(".").pop() || "";
                (tf as any).stat = { mtime: data.mtime, size: data.content.byteLength, ctime: data.mtime };
                tfiles.push(tf);
            }
            return tfiles;
        }),
    };

    const settings: any = {
        syncAppearance: true,
        syncCoreConfig: true,
        syncCommunityPlugins: true,
        syncPluginSettings: true,
        syncFlexibleData: true,
        syncImagesAndMedia: true,
        syncDotfiles: false,
        syncWorkspace: false,
        syncDeviceLogs: false,
        exclusionPatterns: "",
    };

    return {
        vault,
        settings,
        index: {},
        localIndex: {},
        dirtyPaths: new Map(),
        syncingPaths: new Set(),
        recentlyDeletedFromRemote: new Set(),
        pluginDataPath: ".obsidian/plugins/obsidian-vault-sync/sync-index.json",
        e2eeEnabled: false,
        log: vi.fn(),
        _files: files,
    } as any;
}

function addFile(ctx: any, path: string, content: string, mtime?: number) {
    ctx._files.set(path, {
        content: encode(content),
        mtime: mtime ?? Date.now(),
    });
}

function addSyncedFile(ctx: any, path: string, content: string, fileId: string) {
    const buf = encode(content);
    const hash = md5(buf);
    const mtime = Date.now() - 10000; // Old mtime
    ctx._files.set(path, { content: buf, mtime });
    const entry = {
        fileId,
        mtime,
        size: buf.byteLength,
        hash,
        lastAction: "pull",
        ancestorHash: hash,
    };
    ctx.index[path] = { ...entry };
    ctx.localIndex[path] = { ...entry };
}

// ═══════════════════════════════════════════════════════════════════

describe("scanObsidianChanges", () => {
    let ctx: ReturnType<typeof createMockCtx>;

    beforeEach(() => {
        ctx = createMockCtx();
    });

    it("should detect new .obsidian files", async () => {
        addFile(ctx, ".obsidian/appearance.json", '{"theme":"dark"}');

        await scanObsidianChanges(ctx);

        expect(ctx.dirtyPaths.has(".obsidian/appearance.json")).toBe(true);
    });

    it("should detect modified .obsidian files (hash mismatch)", async () => {
        const path = ".obsidian/app.json";
        addSyncedFile(ctx, path, '{"key":"value1"}', "file-id-1");

        // Modify content with newer mtime
        addFile(ctx, path, '{"key":"value2"}', Date.now());

        await scanObsidianChanges(ctx);

        expect(ctx.dirtyPaths.has(path)).toBe(true);
    });

    it("should NOT mark as dirty when mtime changed but hash matches", async () => {
        const path = ".obsidian/hotkeys.json";
        const content = '{"hotkeys":[]}';
        addSyncedFile(ctx, path, content, "file-id-2");

        // Touch file (same content, newer mtime)
        addFile(ctx, path, content, Date.now());

        await scanObsidianChanges(ctx);

        expect(ctx.dirtyPaths.has(path)).toBe(false);
    });

    it("should detect deleted .obsidian files (in index but not on disk)", async () => {
        const path = ".obsidian/plugins/some-plugin/data.json";
        addSyncedFile(ctx, path, "{}", "file-id-3");

        // Remove from file system
        ctx._files.delete(path);

        await scanObsidianChanges(ctx);

        expect(ctx.dirtyPaths.has(path)).toBe(true);
    });

    it("should skip files in recentlyDeletedFromRemote", async () => {
        const path = ".obsidian/templates.json";
        addFile(ctx, path, "{}");
        ctx.recentlyDeletedFromRemote.add(path);

        await scanObsidianChanges(ctx);

        expect(ctx.dirtyPaths.has(path)).toBe(false);
    });

    it("should mark file with no previous hash as dirty", async () => {
        const path = ".obsidian/nohash.json";
        // Index entry with no hash
        ctx.localIndex[path] = {
            fileId: "fid",
            mtime: Date.now() - 10000,
            size: 5,
        } as any;
        ctx.index[path] = { ...ctx.localIndex[path] };
        addFile(ctx, path, "data", Date.now());

        await scanObsidianChanges(ctx);

        expect(ctx.dirtyPaths.has(path)).toBe(true);
    });
});

describe("scanVaultChanges", () => {
    let ctx: ReturnType<typeof createMockCtx>;

    beforeEach(() => {
        ctx = createMockCtx();
    });

    it("should detect new vault files", async () => {
        addFile(ctx, "notes/new-note.md", "# New Note");

        await scanVaultChanges(ctx);

        expect(ctx.dirtyPaths.has("notes/new-note.md")).toBe(true);
    });

    it("should detect modified vault files (hash mismatch)", async () => {
        const path = "notes/existing.md";
        addSyncedFile(ctx, path, "original content", "file-id-10");

        // Modify content
        addFile(ctx, path, "modified content", Date.now());

        await scanVaultChanges(ctx);

        expect(ctx.dirtyPaths.has(path)).toBe(true);
    });

    it("should NOT mark as dirty when mtime changed but hash matches", async () => {
        const path = "notes/unchanged.md";
        const content = "same content";
        addSyncedFile(ctx, path, content, "file-id-11");

        // Touch file (same content)
        addFile(ctx, path, content, Date.now());

        await scanVaultChanges(ctx);

        expect(ctx.dirtyPaths.has(path)).toBe(false);
    });

    it("should detect deleted vault files (in index but not in getFiles)", async () => {
        const path = "notes/deleted.md";
        addSyncedFile(ctx, path, "will be deleted", "file-id-12");

        // Remove from file system
        ctx._files.delete(path);

        await scanVaultChanges(ctx);

        expect(ctx.dirtyPaths.has(path)).toBe(true);
    });

    it("should skip files in recentlyDeletedFromRemote", async () => {
        addFile(ctx, "notes/remote-deleted.md", "content");
        ctx.recentlyDeletedFromRemote.add("notes/remote-deleted.md");

        await scanVaultChanges(ctx);

        expect(ctx.dirtyPaths.has("notes/remote-deleted.md")).toBe(false);
    });

    it("should clean up localIndex when file is missing and has no remote entry", async () => {
        const path = "notes/orphan.md";
        ctx.localIndex[path] = {
            fileId: "orphan-id",
            mtime: 1000,
            size: 10,
            hash: "abc",
        } as any;
        // Don't add to index (no remote entry)

        await scanVaultChanges(ctx);

        expect(ctx.localIndex[path]).toBeUndefined();
        expect(ctx.dirtyPaths.has(path)).toBe(false);
    });

    it("should skip .obsidian files (handled by scanObsidianChanges)", async () => {
        addFile(ctx, ".obsidian/new.json", "{}");

        await scanVaultChanges(ctx);

        expect(ctx.dirtyPaths.has(".obsidian/new.json")).toBe(false);
    });

    it("should detect file with no previous hash as modified", async () => {
        const path = "notes/nohash.md";
        ctx.localIndex[path] = {
            fileId: "fid",
            mtime: Date.now() - 10000,
            size: 5,
        } as any;
        ctx.index[path] = { ...ctx.localIndex[path] };
        addFile(ctx, path, "data", Date.now());

        await scanVaultChanges(ctx);

        expect(ctx.dirtyPaths.has(path)).toBe(true);
    });
});
