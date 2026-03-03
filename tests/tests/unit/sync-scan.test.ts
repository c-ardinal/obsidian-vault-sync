/**
 * @file sync-scan.ts Comprehensive Unit Tests
 *
 * @description
 * Tests for scanObsidianChanges and scanVaultChanges to achieve 100% coverage.
 * Covers edge cases, error handling, folder handling, and binary file handling.
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
    _files: Map<string, { content: ArrayBuffer; mtime: number; isFolder?: boolean }>;
} {
    const files = new Map<string, { content: ArrayBuffer; mtime: number; isFolder?: boolean }>();

    const vault: any = {
        stat: vi.fn(async (path: string) => {
            const f = files.get(path);
            if (!f) return null;
            if (f.isFolder) {
                return { mtime: f.mtime, size: 0, ctime: f.mtime };
            }
            return { mtime: f.mtime, size: f.content.byteLength, ctime: f.mtime };
        }),
        readBinary: vi.fn(async (path: string) => {
            const f = files.get(path);
            if (!f) throw new Error(`Not found: ${path}`);
            if (f.isFolder) throw new Error(`Is a directory: ${path}`);
            return f.content.slice(0);
        }),
        list: vi.fn(async (dir: string) => {
            const prefix = dir === "" || dir === "/" ? "" : dir + "/";
            const result: string[] = [];
            const folders = new Set<string>();
            for (const [path, data] of files.entries()) {
                if (path.startsWith(prefix)) {
                    const relative = path.slice(prefix.length);
                    const slashIdx = relative.indexOf("/");
                    if (slashIdx === -1) {
                        if (!data.isFolder) {
                            result.push(path); // Return full paths for files
                        }
                    } else {
                        const folderName = prefix + relative.slice(0, slashIdx);
                        folders.add(folderName);
                    }
                }
            }
            return { files: result, folders: [...folders] };
        }),
        getFiles: vi.fn(() => {
            const tfiles: TFile[] = [];
            for (const [path, data] of files.entries()) {
                if (data.isFolder) continue;
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
        exists: vi.fn(async (path: string) => {
            return files.has(path);
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

function addBinaryFile(ctx: any, path: string, content: ArrayBuffer, mtime?: number) {
    ctx._files.set(path, {
        content,
        mtime: mtime ?? Date.now(),
    });
}

function addFolder(ctx: any, path: string, mtime?: number) {
    ctx._files.set(path, {
        content: new ArrayBuffer(0),
        mtime: mtime ?? Date.now(),
        isFolder: true,
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
        lastAction: "pull" as const,
        ancestorHash: hash,
    };
    ctx.index[path] = { ...entry };
    ctx.localIndex[path] = { ...entry };
}

// ═══════════════════════════════════════════════════════════════════
// Edge Cases and Error Handling Tests
// ═══════════════════════════════════════════════════════════════════

describe("scanObsidianChanges - Edge Cases", () => {
    let ctx: ReturnType<typeof createMockCtx>;

    beforeEach(() => {
        ctx = createMockCtx();
    });

    it("should handle readBinary failure by marking file as dirty (line 65)", async () => {
        const path = ".obsidian/config.json";
        addSyncedFile(ctx, path, '{"key": "value"}', "file-id-1");

        // Modify with newer mtime
        addFile(ctx, path, '{"key": "new-value"}', Date.now());

        // Mock readBinary to throw error
        ctx.vault.readBinary = vi.fn().mockRejectedValue(new Error("Read failed"));

        await scanObsidianChanges(ctx);

        // Should mark as dirty when read fails
        expect(ctx.dirtyPaths.has(path)).toBe(true);
    });

    it("should clean up localIndex when file is ignored and has no remote entry (lines 87-93)", async () => {
        const path = ".obsidian/workspace.json";
        
        // Add file to localIndex only (no remote entry in index)
        ctx.localIndex[path] = {
            fileId: "local-only-id",
            mtime: Date.now() - 10000,
            size: 100,
            hash: "abc123",
        };

        // File exists but is ignored
        addFile(ctx, path, "workspace data", Date.now());

        await scanObsidianChanges(ctx);

        // localIndex entry should be cleaned up
        expect(ctx.localIndex[path]).toBeUndefined();
        expect(ctx.dirtyPaths.has(path)).toBe(false);
    });

    it("should clean up localIndex when file is missing and has no remote entry (lines 87-93)", async () => {
        const path = ".obsidian/missing.json";
        
        // Add file to localIndex only (no remote entry in index)
        ctx.localIndex[path] = {
            fileId: "local-only-id",
            mtime: Date.now() - 10000,
            size: 100,
            hash: "abc123",
        };

        // File does not exist in _files

        await scanObsidianChanges(ctx);

        // localIndex entry should be cleaned up
        expect(ctx.localIndex[path]).toBeUndefined();
        expect(ctx.dirtyPaths.has(path)).toBe(false);
    });

    it("should skip files currently being synced", async () => {
        const path = ".obsidian/appearance.json";
        addFile(ctx, path, '{"theme":"dark"}');
        ctx.syncingPaths.add(path);

        await scanObsidianChanges(ctx);

        // Should not be marked as dirty because it's being synced
        expect(ctx.dirtyPaths.has(path)).toBe(false);
    });

    it("should handle stat returning null for a listed file", async () => {
        const path = ".obsidian/config.json";
        addFile(ctx, path, "{}");

        // Mock stat to return null
        ctx.vault.stat = vi.fn().mockResolvedValue(null);

        await scanObsidianChanges(ctx);

        // Should skip this file (continue in the loop)
        expect(ctx.dirtyPaths.has(path)).toBe(false);
    });

    it("should update mtime when hash matches", async () => {
        const path = ".obsidian/app.json";
        const content = '{"key":"value"}';
        addSyncedFile(ctx, path, content, "file-id-1");

        const newMtime = Date.now();
        // Same content, newer mtime
        addFile(ctx, path, content, newMtime);

        await scanObsidianChanges(ctx);

        // Should update mtime but NOT mark as dirty
        expect(ctx.dirtyPaths.has(path)).toBe(false);
        expect(ctx.localIndex[path].mtime).toBe(newMtime);
        expect(ctx.index[path].mtime).toBe(newMtime);
    });

    it("should handle empty .obsidian directory", async () => {
        // No files added
        await scanObsidianChanges(ctx);

        // Should complete without errors
        expect(ctx.log).not.toHaveBeenCalledWith(expect.stringContaining("Error"), "error");
    });

    it("should handle binary files in .obsidian", async () => {
        const path = ".obsidian/plugins/plugin-icon.png";
        // Binary content (PNG header bytes)
        const binaryContent = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        addBinaryFile(ctx, path, binaryContent.buffer);

        await scanObsidianChanges(ctx);

        expect(ctx.dirtyPaths.has(path)).toBe(true);
    });

    it("should handle deeply nested .obsidian folders", async () => {
        const path = ".obsidian/plugins/some-plugin/data/nested/config.json";
        addFile(ctx, path, '{"enabled":true}');

        await scanObsidianChanges(ctx);

        expect(ctx.dirtyPaths.has(path)).toBe(true);
    });
});

describe("scanObsidianChanges - Error Handling", () => {
    let ctx: ReturnType<typeof createMockCtx>;

    beforeEach(() => {
        ctx = createMockCtx();
    });

    it("should handle listFilesRecursive throwing an error (lines 92-93)", async () => {
        ctx.vault.list = vi.fn().mockRejectedValue(new Error("List failed"));

        await scanObsidianChanges(ctx);

        // Should log error
        expect(ctx.log).toHaveBeenCalledWith(
            expect.stringContaining("[Obsidian Scan] Error:"),
            "error",
        );
    });
});

describe("scanVaultChanges - Edge Cases", () => {
    let ctx: ReturnType<typeof createMockCtx>;

    beforeEach(() => {
        ctx = createMockCtx();
    });

    it("should log warning when hash check fails (line 153)", async () => {
        const path = "notes/test.md";
        addSyncedFile(ctx, path, "original content", "file-id-1");
        
        // Modify with newer mtime
        addFile(ctx, path, "modified content", Date.now());

        // Mock readBinary to throw on hash check
        ctx.vault.readBinary = vi.fn().mockRejectedValue(new Error("Hash check failed"));

        await scanVaultChanges(ctx);

        // Should log warning
        expect(ctx.log).toHaveBeenCalledWith(
            expect.stringContaining("[Vault Scan] Hash check failed"),
            "warn",
        );
    });

    it("should handle outer error in scanVaultChanges (line 182)", async () => {
        // Make vault.getFiles throw
        ctx.vault.getFiles = vi.fn().mockImplementation(() => {
            throw new Error("Vault inaccessible");
        });

        await scanVaultChanges(ctx);

        // Should log error
        expect(ctx.log).toHaveBeenCalledWith(
            expect.stringContaining("[Vault Scan] Error:"),
            "error",
        );
    });

    it("should handle shouldIgnore returning true for all files", async () => {
        addFile(ctx, ".git/config", "git data");
        
        // Set exclusion pattern to match all
        ctx.settings.exclusionPatterns = "*";

        await scanVaultChanges(ctx);

        // No dirty paths should be added
        expect(ctx.dirtyPaths.size).toBe(0);
    });

    it("should clean up localIndex when file is ignored and has no remote entry", async () => {
        const path = "_ignored/path.md";
        
        // Add to localIndex only (no remote entry)
        ctx.localIndex[path] = {
            fileId: "local-id",
            mtime: Date.now() - 10000,
            size: 100,
            hash: "abc123",
        };

        // Set exclusion pattern to match this path
        ctx.settings.exclusionPatterns = "_ignored/*";

        await scanVaultChanges(ctx);

        // Should clean up localIndex
        expect(ctx.localIndex[path]).toBeUndefined();
    });

    it("should handle empty vault (no files)", async () => {
        ctx.vault.getFiles = vi.fn().mockReturnValue([]);

        await scanVaultChanges(ctx);

        // Should complete without errors
        expect(ctx.log).toHaveBeenCalledWith(
            expect.stringContaining("[Vault Scan] Starting full vault scan..."),
            "debug",
        );
        expect(ctx.log).toHaveBeenCalledWith(
            expect.stringContaining("[Vault Scan] Completed in"),
            "debug",
        );
    });

    it("should handle files with special characters in names", async () => {
        const paths = [
            "notes/file with spaces.md",
            "notes/file-with-dashes.md",
            "notes/file_with_underscores.md",
            "notes/日本語.md",
            "notes/emoji-😀.md",
        ];

        for (const path of paths) {
            addFile(ctx, path, `# ${path}`);
        }

        await scanVaultChanges(ctx);

        for (const path of paths) {
            expect(ctx.dirtyPaths.has(path)).toBe(true);
        }
    });

    it("should handle large vault with many files", async () => {
        // Add 100 files
        for (let i = 0; i < 100; i++) {
            addFile(ctx, `notes/file-${i}.md`, `Content ${i}`);
        }

        await scanVaultChanges(ctx);

        expect(ctx.dirtyPaths.size).toBe(100);
    });

    it("should detect modified files with hash mismatch", async () => {
        const path = "notes/existing.md";
        const originalContent = "original";
        addSyncedFile(ctx, path, originalContent, "file-id-1");

        // Modify content with newer mtime
        const modifiedContent = "modified content";
        addFile(ctx, path, modifiedContent, Date.now());

        await scanVaultChanges(ctx);

        expect(ctx.dirtyPaths.has(path)).toBe(true);
    });

    it("should not mark as dirty when mtime changed but hash matches", async () => {
        const path = "notes/unchanged.md";
        const content = "same content";
        addSyncedFile(ctx, path, content, "file-id-1");

        // Same content, newer mtime
        addFile(ctx, path, content, Date.now());

        await scanVaultChanges(ctx);

        expect(ctx.dirtyPaths.has(path)).toBe(false);
        // mtime should be updated
        expect(ctx.localIndex[path].mtime).toBeGreaterThan(Date.now() - 1000);
    });

    it("should handle file without hash in index", async () => {
        const path = "notes/nohash.md";
        const mtime = Date.now() - 10000;
        
        // Index entry without hash
        const entry = {
            fileId: "file-id",
            mtime,
            size: 10,
        };
        ctx.localIndex[path] = { ...entry };
        ctx.index[path] = { ...entry };
        
        // File exists with newer mtime
        addFile(ctx, path, "content", Date.now());

        await scanVaultChanges(ctx);

        expect(ctx.dirtyPaths.has(path)).toBe(true);
    });
});

describe("scanVaultChanges - Folder Handling", () => {
    let ctx: ReturnType<typeof createMockCtx>;

    beforeEach(() => {
        ctx = createMockCtx();
    });

    it("should handle folders in vault correctly", async () => {
        // Add files in nested folders
        addFile(ctx, "folder1/file1.md", "content1");
        addFile(ctx, "folder1/subfolder/file2.md", "content2");
        addFile(ctx, "folder2/file3.md", "content3");

        await scanVaultChanges(ctx);

        expect(ctx.dirtyPaths.has("folder1/file1.md")).toBe(true);
        expect(ctx.dirtyPaths.has("folder1/subfolder/file2.md")).toBe(true);
        expect(ctx.dirtyPaths.has("folder2/file3.md")).toBe(true);
    });

    it("should skip .obsidian folder in vault scan", async () => {
        addFile(ctx, ".obsidian/config.json", "{}");
        addFile(ctx, "regular.md", "content");

        await scanVaultChanges(ctx);

        expect(ctx.dirtyPaths.has(".obsidian/config.json")).toBe(false);
        expect(ctx.dirtyPaths.has("regular.md")).toBe(true);
    });

    it("should detect deleted folder contents", async () => {
        const path1 = "folder/file1.md";
        const path2 = "folder/file2.md";
        
        // Setup synced files
        addSyncedFile(ctx, path1, "content1", "id1");
        addSyncedFile(ctx, path2, "content2", "id2");

        // Remove files from vault (simulate folder deletion)
        ctx._files.delete(path1);
        ctx._files.delete(path2);

        await scanVaultChanges(ctx);

        expect(ctx.dirtyPaths.has(path1)).toBe(true);
        expect(ctx.dirtyPaths.has(path2)).toBe(true);
    });
});

describe("scanVaultChanges - Binary File Handling", () => {
    let ctx: ReturnType<typeof createMockCtx>;

    beforeEach(() => {
        ctx = createMockCtx();
    });

    it("should handle binary files (images)", async () => {
        const path = "images/photo.png";
        // PNG signature bytes
        const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        addBinaryFile(ctx, path, pngBytes.buffer);

        await scanVaultChanges(ctx);

        expect(ctx.dirtyPaths.has(path)).toBe(true);
    });

    it("should handle binary files (PDF)", async () => {
        const path = "docs/document.pdf";
        // PDF signature bytes
        const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
        addBinaryFile(ctx, path, pdfBytes.buffer);

        await scanVaultChanges(ctx);

        expect(ctx.dirtyPaths.has(path)).toBe(true);
    });

    it("should handle modified binary files with hash check", async () => {
        const path = "images/icon.png";
        const originalBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
        
        // Setup synced binary file
        const hash = md5(originalBytes.buffer);
        const mtime = Date.now() - 10000;
        ctx._files.set(path, { content: originalBytes.buffer.slice(0), mtime });
        const entry = {
            fileId: "img-id",
            mtime,
            size: originalBytes.byteLength,
            hash,
            lastAction: "pull" as const,
            ancestorHash: hash,
        };
        ctx.index[path] = { ...entry };
        ctx.localIndex[path] = { ...entry };

        // Modify binary content with newer mtime
        const modifiedBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
        ctx._files.set(path, { content: modifiedBytes.buffer.slice(0), mtime: Date.now() });

        await scanVaultChanges(ctx);

        expect(ctx.dirtyPaths.has(path)).toBe(true);
    });

    it("should handle large binary files", async () => {
        const path = "videos/large.mp4";
        // Create a large-ish buffer (1MB)
        const largeBuffer = new ArrayBuffer(1024 * 1024);
        const view = new Uint8Array(largeBuffer);
        // Fill with some pattern
        for (let i = 0; i < view.length; i++) {
            view[i] = i % 256;
        }
        addBinaryFile(ctx, path, largeBuffer);

        await scanVaultChanges(ctx);

        expect(ctx.dirtyPaths.has(path)).toBe(true);
    });

    it("should handle empty binary files", async () => {
        const path = "empty.bin";
        addBinaryFile(ctx, path, new ArrayBuffer(0));

        await scanVaultChanges(ctx);

        expect(ctx.dirtyPaths.has(path)).toBe(true);
    });
});

describe("scanObsidianChanges - Folder Handling", () => {
    let ctx: ReturnType<typeof createMockCtx>;

    beforeEach(() => {
        ctx = createMockCtx();
    });

    it("should handle folders in .obsidian directory", async () => {
        addFile(ctx, ".obsidian/snippets/custom.css", "/* css */");
        addFile(ctx, ".obsidian/themes/theme.css", "/* theme */");

        await scanObsidianChanges(ctx);

        expect(ctx.dirtyPaths.has(".obsidian/snippets/custom.css")).toBe(true);
        expect(ctx.dirtyPaths.has(".obsidian/themes/theme.css")).toBe(true);
    });

    it("should skip pluginDataPath in cleanup phase", async () => {
        const path = ctx.pluginDataPath;
        
        // Add to localIndex (no remote entry)
        ctx.localIndex[path] = {
            fileId: "local-id",
            mtime: Date.now() - 10000,
            size: 100,
            hash: "abc123",
        };

        // File doesn't exist

        await scanObsidianChanges(ctx);

        // Should still exist (was skipped)
        expect(ctx.localIndex[path]).toBeDefined();
    });

    it("should skip paths managed separately in cleanup phase", async () => {
        const path = ".obsidian/plugins/obsidian-vault-sync/data/remote/sync-index.json";
        
        // Add to localIndex (no remote entry)
        ctx.localIndex[path] = {
            fileId: "local-id",
            mtime: Date.now() - 10000,
            size: 100,
            hash: "abc123",
        };

        await scanObsidianChanges(ctx);

        // Should still exist (was skipped)
        expect(ctx.localIndex[path]).toBeDefined();
    });
});

describe("scanObsidianChanges - recentlyDeletedFromRemote edge cases", () => {
    let ctx: ReturnType<typeof createMockCtx>;

    beforeEach(() => {
        ctx = createMockCtx();
    });

    it("should skip new files in recentlyDeletedFromRemote", async () => {
        const path = ".obsidian/deleted.json";
        addFile(ctx, path, "{}");
        ctx.recentlyDeletedFromRemote.add(path);

        await scanObsidianChanges(ctx);

        expect(ctx.dirtyPaths.has(path)).toBe(false);
        expect(ctx.log).toHaveBeenCalledWith(
            expect.stringContaining("Skipped (recently deleted from remote)"),
            "debug",
        );
    });
});

describe("scanObsidianChanges - hash mismatch detection (lines 47-48)", () => {
    let ctx: ReturnType<typeof createMockCtx>;

    beforeEach(() => {
        ctx = createMockCtx();
    });

    it("should detect hash mismatch in .obsidian file and log debug (lines 47-48)", async () => {
        const path = ".obsidian/app.json";
        const originalContent = '{"key": "value1"}';
        const modifiedContent = '{"key": "value2"}';
        
        // Setup synced file
        addSyncedFile(ctx, path, originalContent, "file-id-1");
        
        // Modify content with newer mtime
        addFile(ctx, path, modifiedContent, Date.now());

        await scanObsidianChanges(ctx);

        // Should mark as dirty
        expect(ctx.dirtyPaths.has(path)).toBe(true);
        // Should log debug message with hash mismatch info
        expect(ctx.log).toHaveBeenCalledWith(
            expect.stringContaining("[Obsidian Scan] Modified (hash mismatch vs localIndex)"),
            "debug",
        );
    });
});

describe("scanObsidianChanges - no previous hash detection (lines 53-54)", () => {
    let ctx: ReturnType<typeof createMockCtx>;

    beforeEach(() => {
        ctx = createMockCtx();
    });

    it("should mark file with no hash as dirty and log debug (lines 53-54)", async () => {
        const path = ".obsidian/config.json";
        const content = '{"setting": "value"}';
        const buf = encode(content);
        
        // Setup index entry WITHOUT hash (only compareHash from indexEntry.hash would be undefined)
        const mtime = Date.now() - 10000;
        ctx._files.set(path, { content: buf.slice(0), mtime: Date.now() });
        
        // localIndex entry with no hash - but wait, looking at the code:
        // `compareHash = useE2EE ? indexEntry.plainHash : indexEntry.hash`
        // So we need to make sure compareHash is undefined/falsy
        const entry = {
            fileId: "file-id",
            mtime,
            size: buf.byteLength,
            // hash is undefined - this makes compareHash undefined
            lastAction: "pull" as const,
        };
        ctx.localIndex[path] = { ...entry };
        // Also need to ensure index has it for the branch at line 52
        ctx.index[path] = { ...entry };

        await scanObsidianChanges(ctx);

        // Should mark as dirty because no hash to compare
        expect(ctx.dirtyPaths.has(path)).toBe(true);
        // Should log debug message with no prev hash info
        expect(ctx.log).toHaveBeenCalledWith(
            expect.stringContaining("[Obsidian Scan] Modified (no prev hash in localIndex)"),
            "debug",
        );
    });
});

describe("scanObsidianChanges - remote deletion marking (lines 81-82)", () => {
    let ctx: ReturnType<typeof createMockCtx>;

    beforeEach(() => {
        ctx = createMockCtx();
    });

    it("should mark missing file for remote deletion when index exists (lines 81-82)", async () => {
        const path = ".obsidian/config.json";
        const content = '{"key": "value"}';
        
        // Setup synced file (has both localIndex AND index entry)
        addSyncedFile(ctx, path, content, "file-id-1");
        
        // Remove file from filesystem (simulate deletion)
        ctx._files.delete(path);

        await scanObsidianChanges(ctx);

        // Should mark as dirty for remote deletion
        expect(ctx.dirtyPaths.has(path)).toBe(true);
        // Should log debug message about remote deletion
        expect(ctx.log).toHaveBeenCalledWith(
            expect.stringContaining("[Obsidian Scan] Marked for remote deletion (missing)"),
            "debug",
        );
    });

    it("should mark ignored file for remote deletion when index exists (lines 81-82)", async () => {
        const path = ".obsidian/workspace.json";
        const content = "workspace data";
        
        // Setup synced file with index entry
        const buf = encode(content);
        const hash = md5(buf);
        const mtime = Date.now() - 10000;
        ctx._files.set(path, { content: buf, mtime });
        const entry = {
            fileId: "file-id",
            mtime,
            size: buf.byteLength,
            hash,
            lastAction: "pull" as const,
            ancestorHash: hash,
        };
        ctx.index[path] = { ...entry };
        ctx.localIndex[path] = { ...entry };
        
        // File is ignored (workspace.json is ignored by default)
        // Do NOT delete from _files - it exists but is ignored

        await scanObsidianChanges(ctx);

        // Should mark as dirty for remote deletion (ignored)
        expect(ctx.dirtyPaths.has(path)).toBe(true);
        // Should log debug message about ignored
        expect(ctx.log).toHaveBeenCalledWith(
            expect.stringContaining("[Obsidian Scan] Marked for remote deletion (ignored)"),
            "debug",
        );
    });
});

describe("scanVaultChanges - recentlyDeletedFromRemote edge cases", () => {
    let ctx: ReturnType<typeof createMockCtx>;

    beforeEach(() => {
        ctx = createMockCtx();
    });

    it("should skip new files in recentlyDeletedFromRemote", async () => {
        const path = "notes/deleted.md";
        addFile(ctx, path, "# Deleted");
        ctx.recentlyDeletedFromRemote.add(path);

        await scanVaultChanges(ctx);

        expect(ctx.dirtyPaths.has(path)).toBe(false);
        expect(ctx.log).toHaveBeenCalledWith(
            expect.stringContaining("Skipped (recently deleted from remote)"),
            "debug",
        );
    });
});

describe("scanVaultChanges - E2EE enabled", () => {
    let ctx: ReturnType<typeof createMockCtx>;

    beforeEach(() => {
        ctx = createMockCtx();
        ctx.e2eeEnabled = true;
    });

    it("should use plainHash when E2EE is enabled", async () => {
        const path = "notes/e2ee-file.md";
        const content = "secret content";
        const buf = encode(content);
        const plainHash = hashStr(content);
        const encryptedHash = md5(buf); // Different from plainHash
        
        const mtime = Date.now() - 10000;
        ctx._files.set(path, { content: buf.slice(0), mtime });
        
        // Setup with plainHash for E2EE
        const entry = {
            fileId: "e2ee-id",
            mtime,
            size: buf.byteLength,
            hash: encryptedHash,
            plainHash: plainHash,
            lastAction: "pull" as const,
            ancestorHash: encryptedHash,
        };
        ctx.index[path] = { ...entry };
        ctx.localIndex[path] = { ...entry };

        // Modify with newer mtime but same content (same plainHash)
        ctx._files.set(path, { content: buf.slice(0), mtime: Date.now() });

        await scanVaultChanges(ctx);

        // Should not be dirty because plainHash matches
        expect(ctx.dirtyPaths.has(path)).toBe(false);
    });

    it("should detect changes with plainHash mismatch when E2EE is enabled", async () => {
        const path = "notes/e2ee-modified.md";
        const originalContent = "original";
        const modifiedContent = "modified";
        
        const originalBuf = encode(originalContent);
        const originalPlainHash = hashStr(originalContent);
        const encryptedHash = md5(originalBuf);
        
        const mtime = Date.now() - 10000;
        ctx._files.set(path, { content: encode(modifiedContent).slice(0), mtime: Date.now() });
        
        // Setup with original plainHash
        const entry = {
            fileId: "e2ee-id",
            mtime,
            size: originalBuf.byteLength,
            hash: encryptedHash,
            plainHash: originalPlainHash,
            lastAction: "pull" as const,
            ancestorHash: encryptedHash,
        };
        ctx.index[path] = { ...entry };
        ctx.localIndex[path] = { ...entry };

        await scanVaultChanges(ctx);

        // Should be dirty because content changed
        expect(ctx.dirtyPaths.has(path)).toBe(true);
    });
});
