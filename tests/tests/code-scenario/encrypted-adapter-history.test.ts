import { describe, it, expect, vi, beforeEach } from "vitest";
import { EncryptedAdapter } from "../../../src/adapters/encrypted-adapter";
import type { CloudAdapter, FileRevision } from "../../../src/types/adapter";
import type { ICryptoEngine } from "../../../src/encryption/interfaces";
import { createMockEngine as sharedMockEngine } from "../../helpers/mock-crypto-engine";

/**
 * Minimal mock for CloudAdapter with history support.
 */
function createMockBaseAdapter(overrides: Partial<CloudAdapter> = {}): CloudAdapter {
    return {
        name: "MockBase",
        vaultName: "TestVault",
        supportsChangesAPI: true,
        supportsHash: true,
        supportsHistory: true,
        isAuthenticated: () => true,
        getAuthUrl: async () => "",
        handleCallback: async () => {},
        logout: async () => {},
        getFileMetadata: async () => null,
        getFileMetadataById: async () => null,
        downloadFile: async () => new ArrayBuffer(0),
        uploadFile: async () => ({ id: "1", name: "f", path: "f", mtime: 0, size: 0, hash: "" }),
        deleteFile: async () => {},
        moveFile: async () => ({ id: "1", name: "f", path: "f", mtime: 0, size: 0, hash: "" }),
        createFolder: async () => "fid",
        ensureFoldersExist: async () => {},
        fileExistsById: async () => false,
        getStartPageToken: async () => "0",
        getChanges: async () => ({ newStartPageToken: "0", changes: [] }),
        listFiles: async () => [],
        setLogger: () => {},
        listRevisions: async () => [],
        getRevisionContent: async () => new ArrayBuffer(0),
        setRevisionKeepForever: async () => {},
        deleteRevision: async () => {},
        ...overrides,
    } as CloudAdapter;
}

/**
 * Helper: build IV(12) + ciphertext buffer, simulating encrypted storage.
 */
function buildEncryptedBuffer(iv: Uint8Array, ciphertext: ArrayBuffer): ArrayBuffer {
    const combined = new Uint8Array(iv.byteLength + ciphertext.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(ciphertext), iv.byteLength);
    return combined.buffer;
}

function createMockEngine(): ICryptoEngine {
    return sharedMockEngine({
        encrypt: async (data: ArrayBuffer) => {
            const iv = new Uint8Array(12).fill(0xAA);
            return { ciphertext: data, iv };
        },
        decrypt: async (ciphertext: ArrayBuffer, _iv: Uint8Array) => {
            return ciphertext;
        },
    });
}

describe("EncryptedAdapter History Support", () => {
    let baseAdapter: CloudAdapter;
    let engine: ICryptoEngine;
    let adapter: EncryptedAdapter;

    beforeEach(() => {
        baseAdapter = createMockBaseAdapter();
        engine = createMockEngine();
        adapter = new EncryptedAdapter(baseAdapter, engine);
    });

    describe("supportsHistory", () => {
        it("should reflect base adapter's supportsHistory = true", () => {
            expect(adapter.supportsHistory).toBe(true);
        });

        it("should reflect base adapter's supportsHistory = false", () => {
            const noHistoryAdapter = createMockBaseAdapter({ supportsHistory: false } as any);
            const enc = new EncryptedAdapter(noHistoryAdapter, engine);
            expect(enc.supportsHistory).toBe(false);
        });
    });

    describe("listRevisions", () => {
        it("should delegate to base adapter", async () => {
            const revisions: FileRevision[] = [
                { id: "rev1", modifiedTime: 1000, size: 100, hash: "abc123" },
                { id: "rev2", modifiedTime: 2000, size: 200, hash: "def456" },
            ];
            baseAdapter.listRevisions = vi.fn().mockResolvedValue(revisions);
            adapter = new EncryptedAdapter(baseAdapter, engine);

            const result = await adapter.listRevisions("test.md");
            expect(result).toEqual(revisions);
            expect(baseAdapter.listRevisions).toHaveBeenCalledWith("test.md");
        });

        it("should throw if base adapter does not support listRevisions", async () => {
            const noHistoryBase = createMockBaseAdapter();
            delete (noHistoryBase as any).listRevisions;
            const enc = new EncryptedAdapter(noHistoryBase, engine);

            await expect(enc.listRevisions("test.md")).rejects.toThrow("does not support listRevisions");
        });
    });

    describe("getRevisionContent", () => {
        it("should decrypt revision content from base adapter", async () => {
            const plaintext = new TextEncoder().encode("Hello, World!");
            const iv = new Uint8Array(12).fill(0x01);
            const encryptedBuffer = buildEncryptedBuffer(iv, plaintext.buffer);

            baseAdapter.getRevisionContent = vi.fn().mockResolvedValue(encryptedBuffer);
            engine.decrypt = vi.fn().mockResolvedValue(plaintext.buffer);
            adapter = new EncryptedAdapter(baseAdapter, engine);

            const result = await adapter.getRevisionContent("test.md", "rev1");
            const decoded = new TextDecoder().decode(result);
            expect(decoded).toBe("Hello, World!");

            expect(baseAdapter.getRevisionContent).toHaveBeenCalledWith("test.md", "rev1");
            expect(engine.decrypt).toHaveBeenCalledWith(
                expect.any(ArrayBuffer),
                expect.any(Uint8Array),
            );

            // Verify IV was correctly extracted (first 12 bytes)
            const passedIv = (engine.decrypt as ReturnType<typeof vi.fn>).mock.calls[0][1];
            expect(Array.from(passedIv)).toEqual(Array.from(iv));
        });

        it("should throw if encrypted content is too short (missing IV)", async () => {
            const shortBuffer = new ArrayBuffer(5);
            baseAdapter.getRevisionContent = vi.fn().mockResolvedValue(shortBuffer);
            adapter = new EncryptedAdapter(baseAdapter, engine);

            await expect(adapter.getRevisionContent("test.md", "rev1"))
                .rejects.toThrow("too short");
        });

        it("should throw if base adapter does not support getRevisionContent", async () => {
            const noHistoryBase = createMockBaseAdapter();
            delete (noHistoryBase as any).getRevisionContent;
            const enc = new EncryptedAdapter(noHistoryBase, engine);

            await expect(enc.getRevisionContent("test.md", "rev1"))
                .rejects.toThrow("does not support getRevisionContent");
        });
    });

    describe("setRevisionKeepForever", () => {
        it("should delegate to base adapter", async () => {
            baseAdapter.setRevisionKeepForever = vi.fn().mockResolvedValue(undefined);
            adapter = new EncryptedAdapter(baseAdapter, engine);

            await adapter.setRevisionKeepForever("test.md", "rev1", true);
            expect(baseAdapter.setRevisionKeepForever).toHaveBeenCalledWith("test.md", "rev1", true);
        });

        it("should throw if base adapter does not support setRevisionKeepForever", async () => {
            const noHistoryBase = createMockBaseAdapter();
            delete (noHistoryBase as any).setRevisionKeepForever;
            const enc = new EncryptedAdapter(noHistoryBase, engine);

            await expect(enc.setRevisionKeepForever("test.md", "rev1", true))
                .rejects.toThrow("does not support setRevisionKeepForever");
        });
    });

    describe("deleteRevision", () => {
        it("should delegate to base adapter", async () => {
            baseAdapter.deleteRevision = vi.fn().mockResolvedValue(undefined);
            adapter = new EncryptedAdapter(baseAdapter, engine);

            await adapter.deleteRevision("test.md", "rev1");
            expect(baseAdapter.deleteRevision).toHaveBeenCalledWith("test.md", "rev1");
        });

        it("should throw if base adapter does not support deleteRevision", async () => {
            const noHistoryBase = createMockBaseAdapter();
            delete (noHistoryBase as any).deleteRevision;
            const enc = new EncryptedAdapter(noHistoryBase, engine);

            await expect(enc.deleteRevision("test.md", "rev1"))
                .rejects.toThrow("does not support deleteRevision");
        });
    });
});
