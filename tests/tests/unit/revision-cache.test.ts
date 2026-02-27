/**
 * @file Revision Cache テスト
 *
 * @description
 * RevisionCacheのTTL、キャッシュヒット/ミス、cleanup、clearをテストする。
 *
 * @pass_criteria
 * - init() でキャッシュディレクトリ作成
 * - set/get ラウンドトリップ
 * - TTL期限切れでnull返却 + ファイル削除
 * - cleanup() で期限切れファイル削除
 * - clear() で全キャッシュ削除
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { RevisionCache } from "../../../src/services/revision-cache";
import { MockVaultAdapter, MockVaultOperations, MockVault } from "../../helpers/mock-vault-adapter";

const PLUGIN_DIR = ".obsidian/plugins/obsidian-vault-sync";

describe("RevisionCache", () => {
    let adapter: MockVaultAdapter;
    let vaultOps: MockVaultOperations;
    let cache: RevisionCache;

    beforeEach(() => {
        adapter = new MockVaultAdapter();
        const vault = new MockVault(adapter);
        vaultOps = new MockVaultOperations(adapter, vault);
        cache = new RevisionCache(vaultOps, PLUGIN_DIR);
    });

    describe("init", () => {
        it("should create cache directory if it does not exist", async () => {
            await cache.init();
            const exists = await adapter.exists(`${PLUGIN_DIR}/cache`);
            expect(exists).toBe(true);
        });

        it("should not fail if cache directory already exists", async () => {
            await adapter.mkdir(`${PLUGIN_DIR}/cache`);
            await expect(cache.init()).resolves.not.toThrow();
        });
    });

    describe("get/set round-trip", () => {
        it("should return null for non-existent cache entry", async () => {
            await cache.init();
            const result = await cache.get("notes/test.md", "rev-123");
            expect(result).toBeNull();
        });

        it("should store and retrieve cached content", async () => {
            await cache.init();
            const content = new TextEncoder().encode("hello world").buffer as ArrayBuffer;

            await cache.set("notes/test.md", "rev-123", content);
            const result = await cache.get("notes/test.md", "rev-123");

            expect(result).not.toBeNull();
            const text = new TextDecoder().decode(result!);
            expect(text).toBe("hello world");
        });

        it("should handle binary content correctly", async () => {
            await cache.init();
            const content = new Uint8Array([0, 1, 2, 255, 128, 64]).buffer as ArrayBuffer;

            await cache.set("image.png", "rev-456", content);
            const result = await cache.get("image.png", "rev-456");

            expect(result).not.toBeNull();
            const arr = new Uint8Array(result!);
            expect(arr).toEqual(new Uint8Array([0, 1, 2, 255, 128, 64]));
        });

        it("should separate cache entries for different revisions", async () => {
            await cache.init();
            const content1 = new TextEncoder().encode("version 1").buffer as ArrayBuffer;
            const content2 = new TextEncoder().encode("version 2").buffer as ArrayBuffer;

            await cache.set("test.md", "rev-1", content1);
            await cache.set("test.md", "rev-2", content2);

            const result1 = await cache.get("test.md", "rev-1");
            const result2 = await cache.get("test.md", "rev-2");

            expect(new TextDecoder().decode(result1!)).toBe("version 1");
            expect(new TextDecoder().decode(result2!)).toBe("version 2");
        });
    });

    describe("TTL expiration", () => {
        it("should return null and remove cache file when TTL expired", async () => {
            await cache.init();
            const content = new TextEncoder().encode("old data").buffer as ArrayBuffer;
            await cache.set("test.md", "rev-old", content);

            // Manually set mtime to 25 hours ago
            const safePath = "test_md";
            const cacheKey = `${safePath}-rev-old.cache`;
            const cachePath = `${PLUGIN_DIR}/cache/${cacheKey}`;
            const entry = (adapter as any).files.get(cachePath);
            if (entry) {
                entry.mtime = Date.now() - 25 * 60 * 60 * 1000;
            }

            const result = await cache.get("test.md", "rev-old");
            expect(result).toBeNull();

            // File should be removed
            const exists = await adapter.exists(cachePath);
            expect(exists).toBe(false);
        });

        it("should return content when within TTL", async () => {
            await cache.init();
            const content = new TextEncoder().encode("fresh data").buffer as ArrayBuffer;
            await cache.set("test.md", "rev-fresh", content);

            // mtime is current (just written), so within TTL
            const result = await cache.get("test.md", "rev-fresh");
            expect(result).not.toBeNull();
            expect(new TextDecoder().decode(result!)).toBe("fresh data");
        });
    });

    describe("cleanup", () => {
        it("should remove expired cache files", async () => {
            await cache.init();

            const fresh = new TextEncoder().encode("fresh").buffer as ArrayBuffer;
            const old = new TextEncoder().encode("old").buffer as ArrayBuffer;
            await cache.set("fresh.md", "rev-f", fresh);
            await cache.set("old.md", "rev-o", old);

            // Expire the old one via full path
            const oldKey = "old_md-rev-o.cache";
            const oldPath = `${PLUGIN_DIR}/cache/${oldKey}`;
            const entry = (adapter as any).files.get(oldPath);
            if (entry) {
                entry.mtime = Date.now() - 25 * 60 * 60 * 1000;
            }

            // cleanup() relies on list() returning paths usable by stat()/remove().
            // Mock list() returns relative names; stub stat/remove on vaultOps to match.
            const origStat = vaultOps.stat.bind(vaultOps);
            const origRemove = vaultOps.remove.bind(vaultOps);
            vi.spyOn(vaultOps, "stat").mockImplementation(async (p: string) => {
                if (!p.includes("/")) p = `${PLUGIN_DIR}/cache/${p}`;
                return origStat(p);
            });
            vi.spyOn(vaultOps, "remove").mockImplementation(async (p: string) => {
                if (!p.includes("/")) p = `${PLUGIN_DIR}/cache/${p}`;
                return origRemove(p);
            });

            await cache.cleanup();

            // Fresh should still be retrievable
            const freshResult = await cache.get("fresh.md", "rev-f");
            expect(freshResult).not.toBeNull();

            // Old should be removed
            const oldExists = await adapter.exists(oldPath);
            expect(oldExists).toBe(false);
        });

        it("should not fail when cache directory does not exist", async () => {
            await expect(cache.cleanup()).resolves.not.toThrow();
        });

        it("should skip non-.cache files", async () => {
            await cache.init();
            await adapter.write(`${PLUGIN_DIR}/cache/readme.txt`, "info");

            const entry = (adapter as any).files.get(`${PLUGIN_DIR}/cache/readme.txt`);
            if (entry) {
                entry.mtime = Date.now() - 25 * 60 * 60 * 1000;
            }

            await cache.cleanup();

            const exists = await adapter.exists(`${PLUGIN_DIR}/cache/readme.txt`);
            expect(exists).toBe(true);
        });
    });

    describe("clear", () => {
        it("should remove all cache files and recreate directory", async () => {
            await cache.init();
            const content = new TextEncoder().encode("data").buffer as ArrayBuffer;
            await cache.set("test.md", "rev-1", content);
            await cache.set("test.md", "rev-2", content);

            await cache.clear();

            // Cache entries should be gone
            const r1 = await cache.get("test.md", "rev-1");
            const r2 = await cache.get("test.md", "rev-2");
            expect(r1).toBeNull();
            expect(r2).toBeNull();

            // Cache dir should still exist (recreated)
            const dirExists = await adapter.exists(`${PLUGIN_DIR}/cache`);
            expect(dirExists).toBe(true);
        });

        it("should not fail when cache directory does not exist", async () => {
            await expect(cache.clear()).resolves.not.toThrow();
        });
    });
});
