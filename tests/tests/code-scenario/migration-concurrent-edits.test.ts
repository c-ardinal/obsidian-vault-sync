/**
 * @file アドオン用 Vault 変換中の他端末編集
 *
 * @description
 * 変換（移行）端末は全ファイルを読込→一時フォルダへ送信→フォルダ交換→旧フォルダ削除の順に処理する。
 * その間に他端末が旧フォルダへ送信した編集が、旧フォルダの削除で消失しないことを検証する。
 * Drive 相当の擬似クラウド（ルート直下のフォルダ単位、ID 指定の更新は所在フォルダ内で反映、
 * フォルダ改名・削除あり）上で MigrationService の実処理を実行する。
 *
 * @pass_criteria
 * - 読込後に他端末が更新したファイル: 変換後の Vault と移行端末のローカルに他端末の内容
 * - 変換中に他端末が新規作成したファイル: 変換後の Vault とローカルに存在
 * - 変換開始前に他端末が更新済み（移行端末は未取得）のファイル: 他端末の内容を採用
 * - 双方が編集したファイル: 移行端末の編集を保持し、他端末の内容を競合コピーとして保存
 * - 変更の無いファイルは再送信しない
 */

import { describe, it, expect, vi } from "vitest";
import { MigrationService } from "../../../src/services/migration-service";
import { VaultLockService } from "../../../src/services/vault-lock-service";
import type { SyncContext } from "../../../src/sync-manager/context";
import type { CloudAdapter, CloudFile } from "../../../src/types/adapter";
import { md5 } from "../../../src/utils/md5";
import { hashContent } from "../../../src/sync-manager/file-utils";
import { createMockEngine } from "../../helpers/mock-crypto-engine";

const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
const dec = (b: ArrayBuffer) => new TextDecoder().decode(b);

interface Item { id: string; root: string; path: string; content: ArrayBuffer; mtime: number }

/** Drive-like cloud: vault folders under one app root; updates by id stay where the file is. */
class FakeDrive {
    roots = new Map<string, string>(); // root id -> folder name
    items = new Map<string, Item>();
    private next = 1;
    uploads: string[] = [];

    rootId(name: string): string | null {
        for (const [id, n] of this.roots) if (n === name) return id;
        return null;
    }
    ensureRoot(name: string): string {
        const id = this.rootId(name);
        if (id) return id;
        const nid = `root-${this.next++}`;
        this.roots.set(nid, name);
        return nid;
    }
    meta(i: Item): CloudFile {
        return { id: i.id, path: i.path, mtime: i.mtime, size: i.content.byteLength, kind: "file", hash: md5(i.content) };
    }
    filesOf(name: string): Item[] {
        const r = this.rootId(name);
        return [...this.items.values()].filter((i) => i.root === r);
    }
    /** Another device writing into the vault folder named `name` (by id when it knows the file) */
    write(name: string, path: string, text: string, id?: string): void {
        const existing = id ? this.items.get(id) : this.filesOf(name).find((i) => i.path === path);
        if (existing) {
            existing.content = enc(text);
            existing.mtime = Date.now();
            return;
        }
        const nid = `f-${this.next++}`;
        this.items.set(nid, { id: nid, root: this.ensureRoot(name), path, content: enc(text), mtime: Date.now() });
    }

    adapter(vaultName: string): CloudAdapter {
        const drive = this;
        const a: any = {
            name: "FakeDrive",
            vaultName,
            capabilities: { changeFeed: true, revisions: true, contentHash: "md5", stableIds: true },
            isAuthenticated: () => true,
            setLogger: () => {},
            reset: () => {},
            initialize: async () => {},
            getAppRootId: async () => "app-root",
            getBaseAdapter: () => a,
            cloneWithNewVaultName: (n: string) => drive.adapter(n),
            async getFolderIdByName(name: string) { return drive.rootId(name); },
            async moveFile(id: string, newName: string) {
                if (drive.roots.has(id)) { drive.roots.set(id, newName); return { id, path: newName, mtime: 0, size: 0, kind: "folder" }; }
                const i = drive.items.get(id)!; i.path = newName; return drive.meta(i);
            },
            async deleteFile(id: string) {
                if (drive.roots.has(id)) {
                    drive.roots.delete(id);
                    for (const [k, i] of drive.items) if (i.root === id) drive.items.delete(k);
                    return;
                }
                drive.items.delete(id);
            },
            async listFiles() { return drive.filesOf(vaultName).map((i) => drive.meta(i)); },
            async getFileMetadata(path: string) {
                const i = drive.filesOf(vaultName).find((x) => x.path === path);
                return i ? drive.meta(i) : null;
            },
            async downloadFile(id: string) {
                const i = drive.items.get(id);
                if (!i) throw new Error(`not found ${id}`);
                return i.content.slice(0);
            },
            async uploadFile(path: string, content: ArrayBuffer, mtime: number, existingId?: string) {
                drive.uploads.push(`${vaultName}:${path}`);
                const existing = existingId ? drive.items.get(existingId) : drive.filesOf(vaultName).find((x) => x.path === path);
                if (existing) {
                    existing.content = content.slice(0);
                    existing.mtime = mtime;
                    return drive.meta(existing);
                }
                const id = `f-${drive.next++}`;
                const item = { id, root: drive.ensureRoot(vaultName), path, content: content.slice(0), mtime };
                drive.items.set(id, item);
                return drive.meta(item);
            },
        };
        return a as CloudAdapter;
    }
}

const VAULT = "MyVault";

/** Device A: in-memory vault, synced with the cloud, then converted. */
async function setup(files: Record<string, string>) {
    const drive = new FakeDrive();
    const local = new Map<string, ArrayBuffer>();
    const index: Record<string, any> = {};
    for (const [path, text] of Object.entries(files)) {
        drive.write(VAULT, path, text);
        local.set(path, enc(text));
        const i = drive.filesOf(VAULT).find((x) => x.path === path)!;
        index[path] = { path, fileId: i.id, hash: md5(i.content), plainHash: await hashContent(i.content), mtime: 1, size: i.content.byteLength };
    }
    const onRead = new Map<string, () => void>();
    /** Runs once when the existence of this path is checked */
    const onExists = new Map<string, () => void>();
    const ctx = {
        syncState: "IDLE",
        deviceId: "device-A",
        settings: { concurrency: 1, exclusionPatterns: "" },
        vault: {
            getFiles: () => [...local.keys()].filter((p) => !p.startsWith(".obsidian/")).map((p) => ({
                path: p, name: p.split("/").pop(), stat: { mtime: 1, size: local.get(p)!.byteLength },
            })),
            readBinary: vi.fn(async (p: string) => {
                const c = local.get(p)!.slice(0);
                onRead.get(p)?.();
                return c;
            }),
            writeBinary: vi.fn(async (p: string, d: ArrayBuffer) => void local.set(p, d.slice(0))),
            write: vi.fn(async (p: string, d: string) => void local.set(p, enc(d))),
            exists: vi.fn(async (p: string) => {
                const hook = onExists.get(p);
                onExists.delete(p);
                hook?.();
                return local.has(p) || [...local.keys()].some((k) => k.startsWith(p + "/"));
            }),
            stat: vi.fn(async () => null),
            mkdir: vi.fn(async () => {}),
            createFolder: vi.fn(async () => {}),
            list: vi.fn(async () => ({ files: [], folders: [] })),
        },
        index: structuredClone(index),
        localIndex: structuredClone(index),
        dirtyPaths: new Map<string, number>(),
        pluginDataPath: ".obsidian/plugins/x/data/remote/sync-index.json",
        pluginDir: ".obsidian/plugins/x",
        localIndexPath: ".obsidian/plugins/x/data/local/local-index.json",
        startPageToken: "t",
        cryptoEngine: createMockEngine({ initializeNewVault: async () => "lock-blob" }),
        log: vi.fn(async () => {}),
        notify: vi.fn(async () => {}),
    } as unknown as SyncContext;
    const base = drive.adapter(VAULT);
    const svc = new MigrationService(base, new VaultLockService(base), ctx);
    const engine = ctx.cryptoEngine!;
    /** Plain contents of the vault folder after conversion */
    const converted = async () => {
        const out: Record<string, string> = {};
        for (const i of drive.filesOf(VAULT)) {
            if (i.path.startsWith(".obsidian/") || i.path === "migration.lock") continue;
            out[i.path] = dec(await engine.decryptFromBlob(i.content.slice(0)));
        }
        return out;
    };
    const localText = (p: string) => (local.has(p) ? dec(local.get(p)!) : undefined);
    const run = async () => {
        const temp = await svc.startMigration("pw");
        await svc.runMigration(temp, () => {});
        await svc.finalizeMigration(temp);
    };
    return { drive, local, ctx, svc, onRead, onExists, converted, localText, run, idOf: (p: string) => index[p].fileId as string };
}

describe("Vault conversion while another device keeps syncing", () => {
    it("keeps an edit another device pushed after the file was read", async () => {
        const t = await setup({ "a.md": "v1", "b.md": "b1" });
        t.onRead.set("a.md", () => t.drive.write(VAULT, "a.md", "v2 from B", t.idOf("a.md")));
        await t.run();
        expect((await t.converted())["a.md"]).toBe("v2 from B");
        expect(t.localText("a.md")).toBe("v2 from B");
        expect((await t.converted())["b.md"]).toBe("b1");
    });

    it("keeps a note another device created during the conversion", async () => {
        const t = await setup({ "a.md": "v1" });
        t.onRead.set("a.md", () => t.drive.write(VAULT, "new/c.md", "created by B"));
        await t.run();
        expect((await t.converted())["new/c.md"]).toBe("created by B");
        expect(t.localText("new/c.md")).toBe("created by B");
    });

    it("takes another device's edit this device had not pulled yet", async () => {
        const t = await setup({ "a.md": "v1" });
        t.drive.write(VAULT, "a.md", "v2 from B (not pulled)", t.idOf("a.md"));
        await t.run();
        expect((await t.converted())["a.md"]).toBe("v2 from B (not pulled)");
        expect(t.localText("a.md")).toBe("v2 from B (not pulled)");
    });

    it("keeps both versions when both devices edited the same note", async () => {
        const t = await setup({ "a.md": "v1" });
        t.onRead.set("a.md", () => {
            t.drive.write(VAULT, "a.md", "edit from B", t.idOf("a.md"));
            t.local.set("a.md", enc("edit on A"));
        });
        await t.run();
        expect(t.localText("a.md")).toBe("edit on A");
        const copies = Object.entries(await t.converted()).filter(([p]) => p.startsWith("a (Conflict "));
        expect(copies.map(([, v]) => v)).toEqual(["edit from B"]);
        expect([...t.local.keys()].some((p) => p.startsWith("a (Conflict ") && dec(t.local.get(p)!) === "edit from B")).toBe(true);
    });

    it("keeps an edit made here after the conversion started but before the file was read", async () => {
        const t = await setup({ "a.md": "v1" });
        const temp = await t.svc.startMigration("pw");
        t.local.set("a.md", enc("edit on A while queued"));
        t.drive.write(VAULT, "a.md", "edit from B", t.idOf("a.md"));
        await t.svc.runMigration(temp, () => {});
        await t.svc.finalizeMigration(temp);
        expect(t.localText("a.md")).toBe("edit on A while queued");
        const converted = await t.converted();
        expect(converted["a.md"]).toBe("edit on A while queued");
        expect(Object.entries(converted).filter(([p]) => p.startsWith("a (Conflict ")).map(([, v]) => v)).toEqual(["edit from B"]);
    });

    it("keeps an edit saved here while the catch-up is about to replace the note", async () => {
        const t = await setup({ "dir/a.md": "v1" });
        t.onRead.set("dir/a.md", () => {
            t.drive.write(VAULT, "dir/a.md", "edit from B", t.idOf("dir/a.md"));
            // The parent-folder check of the catch-up write is where the save lands
            t.onExists.set("dir", () => t.local.set("dir/a.md", enc("saved on A during catch-up")));
        });
        await t.run();
        expect(t.localText("dir/a.md")).toBe("saved on A during catch-up");
        const copies = Object.entries(await t.converted()).filter(([p]) => p.startsWith("dir/a (Conflict "));
        expect(copies.map(([, v]) => v)).toEqual(["edit from B"]);
    });

    it("does not upload unchanged files again", async () => {
        const t = await setup({ "a.md": "v1", "b.md": "b1" });
        await t.run();
        const fileUploads = t.drive.uploads.filter((u) => /:(a|b)\.md$/.test(u));
        expect(fileUploads).toEqual([`${VAULT}-Temp-Encrypted:a.md`, `${VAULT}-Temp-Encrypted:b.md`]);
    });
});
