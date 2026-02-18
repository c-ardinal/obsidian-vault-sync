import { describe, it, expect, vi, beforeEach } from "vitest";
import {
    isChunkedFormat,
    calculateVSC2Size,
    buildVSC2Header,
    encryptChunked,
    decryptChunked,
    CHUNK_MAGIC,
    HEADER_SIZE,
    IV_SIZE,
    GCM_TAG_SIZE,
    DEFAULT_PLAIN_CHUNK_SIZE,
} from "../../../src/encryption/chunked-crypto";
import { EncryptedAdapter } from "../../../src/adapters/encrypted-adapter";
import type { CloudAdapter, CloudFile } from "../../../src/types/adapter";
import type { ICryptoEngine } from "../../../src/encryption/interfaces";

// =============================================================================
// Test Helpers
// =============================================================================

const MOCK_IV = new Uint8Array(12).fill(0xBB);
const MOCK_TAG = new Uint8Array(16).fill(0xDD);

/**
 * Mock engine that simulates AES-GCM behavior:
 * - encrypt: ciphertext = [plaintext][16-byte mock tag], iv = 12 bytes of 0xBB
 * - decrypt: strip last 16 bytes of ciphertext
 * This produces correctly-sized output matching real GCM behavior.
 */
function createMockEngine(): ICryptoEngine {
    return {
        initializeNewVault: async () => "",
        unlockVault: async () => {},
        isUnlocked: () => true,
        encrypt: async (data: ArrayBuffer) => {
            const plain = new Uint8Array(data);
            const ct = new Uint8Array(plain.byteLength + GCM_TAG_SIZE);
            ct.set(plain, 0);
            ct.set(MOCK_TAG, plain.byteLength);
            return { ciphertext: ct.buffer.slice(ct.byteOffset, ct.byteOffset + ct.byteLength), iv: new Uint8Array(MOCK_IV) };
        },
        decrypt: async (ciphertext: ArrayBuffer, _iv: Uint8Array) => {
            // Strip the 16-byte mock tag
            return ciphertext.slice(0, ciphertext.byteLength - GCM_TAG_SIZE);
        },
        showSetupModal: () => {},
        showUnlockModal: () => {},
        getSettingsSections: () => [],
    };
}

function createMockBaseAdapter(overrides: Partial<CloudAdapter> = {}): CloudAdapter {
    const storage = new Map<string, { content: ArrayBuffer; cf: CloudFile }>();
    let nextId = 1;

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
        downloadFile: async (fileId: string) => {
            const entry = storage.get(fileId);
            if (!entry) throw new Error(`Not found: ${fileId}`);
            return entry.content.slice(0);
        },
        uploadFile: async (path: string, content: ArrayBuffer, mtime: number, existingFileId?: string) => {
            const id = existingFileId || `file_${nextId++}`;
            const cf: CloudFile = { id, path, mtime, size: content.byteLength, kind: "file", hash: "mock-hash" };
            storage.set(id, { content: content.slice(0), cf });
            return cf;
        },
        uploadFileResumable: async (path: string, content: ArrayBuffer, mtime: number, existingFileId?: string) => {
            const id = existingFileId || `file_${nextId++}`;
            const cf: CloudFile = { id, path, mtime, size: content.byteLength, kind: "file", hash: "mock-hash" };
            storage.set(id, { content: content.slice(0), cf });
            return cf;
        },
        deleteFile: async () => {},
        moveFile: async () => ({ id: "1", path: "f", mtime: 0, size: 0, kind: "file" as const, hash: "" }),
        createFolder: async () => "fid",
        ensureFoldersExist: async () => {},
        fileExistsById: async () => false,
        getStartPageToken: async () => "0",
        getChanges: async () => ({ newStartPageToken: "0", changes: [] }),
        listFiles: async () => [],
        setLogger: () => {},
        listRevisions: async () => [],
        getRevisionContent: async (_path: string, _revId: string) => {
            // Return first stored content for simplicity
            for (const entry of storage.values()) return entry.content.slice(0);
            return new ArrayBuffer(0);
        },
        setRevisionKeepForever: async () => {},
        deleteRevision: async () => {},
        ...overrides,
    } as CloudAdapter;
}

/** Create a mock base adapter with chunked upload support (Phase 2). */
function createChunkedMockBaseAdapter(): CloudAdapter & {
    getStoredContent(fileId: string): ArrayBuffer | undefined;
} {
    const storage = new Map<string, ArrayBuffer>();
    const sessions = new Map<string, { chunks: ArrayBuffer[]; existingFileId?: string }>();
    let nextId = 1;
    let nextSessionId = 1;

    const adapter = createMockBaseAdapter({
        initiateResumableSession: async (_path: string, _totalSize: number, _mtime: number, existingFileId?: string) => {
            const uri = `session-${nextSessionId++}`;
            sessions.set(uri, { chunks: [], existingFileId });
            return uri;
        },
        uploadChunk: async (sessionUri: string, chunk: ArrayBuffer, offset: number, totalSize: number, path: string, mtime: number) => {
            const session = sessions.get(sessionUri);
            if (!session) throw new Error(`Unknown session: ${sessionUri}`);
            session.chunks.push(chunk.slice(0));

            if (offset + chunk.byteLength < totalSize) return null;

            // Final: combine and store
            const combined = new Uint8Array(totalSize);
            let pos = 0;
            for (const c of session.chunks) {
                combined.set(new Uint8Array(c), pos);
                pos += c.byteLength;
            }
            sessions.delete(sessionUri);
            const id = session.existingFileId || `file_${nextId++}`;
            storage.set(id, combined.buffer.slice(combined.byteOffset, combined.byteOffset + combined.byteLength));
            return { id, path, mtime, size: totalSize, kind: "file" as const, hash: "mock-hash" };
        },
        downloadFile: async (fileId: string) => {
            const content = storage.get(fileId);
            if (!content) throw new Error(`Not found: ${fileId}`);
            return content.slice(0);
        },
        uploadFile: async (path: string, content: ArrayBuffer, mtime: number, existingFileId?: string) => {
            const id = existingFileId || `file_${nextId++}`;
            storage.set(id, content.slice(0));
            return { id, path, mtime, size: content.byteLength, kind: "file" as const, hash: "mock-hash" };
        },
    });

    return Object.assign(adapter, {
        getStoredContent: (fileId: string) => storage.get(fileId),
    });
}

function makeBuffer(size: number, fillByte: number = 0x42): ArrayBuffer {
    return new Uint8Array(size).fill(fillByte).buffer;
}

function makePatternBuffer(size: number): ArrayBuffer {
    const arr = new Uint8Array(size);
    for (let i = 0; i < size; i++) arr[i] = i % 256;
    return arr.buffer;
}

function arraysEqual(a: ArrayBuffer, b: ArrayBuffer): boolean {
    if (a.byteLength !== b.byteLength) return false;
    const va = new Uint8Array(a);
    const vb = new Uint8Array(b);
    for (let i = 0; i < va.length; i++) {
        if (va[i] !== vb[i]) return false;
    }
    return true;
}

// =============================================================================
// Suite 1: isChunkedFormat
// =============================================================================

describe("isChunkedFormat", () => {
    it("returns false for empty buffer", () => {
        expect(isChunkedFormat(new ArrayBuffer(0))).toBe(false);
    });

    it("returns false for buffer shorter than 4 bytes", () => {
        expect(isChunkedFormat(new ArrayBuffer(3))).toBe(false);
    });

    it("returns false for legacy IV buffer", () => {
        const buf = new Uint8Array(28).fill(0xAA);
        expect(isChunkedFormat(buf.buffer)).toBe(false);
    });

    it("returns true for VSC2 magic", () => {
        const buf = new Uint8Array(12);
        buf.set(CHUNK_MAGIC, 0);
        expect(isChunkedFormat(buf.buffer)).toBe(true);
    });

    it("returns false when only partial magic matches", () => {
        const buf = new Uint8Array([0x56, 0x53, 0x43, 0x00]);
        expect(isChunkedFormat(buf.buffer)).toBe(false);
    });
});

// =============================================================================
// Suite 2: calculateVSC2Size
// =============================================================================

describe("calculateVSC2Size", () => {
    it("empty file → 40 bytes (header + 1 empty chunk)", () => {
        // HEADER(12) + 1 * IV(12) + 0 + 1 * TAG(16) = 40
        expect(calculateVSC2Size(0)).toBe(40);
    });

    it("1 byte → 41 bytes", () => {
        // HEADER(12) + 1 * IV(12) + 1 + 1 * TAG(16) = 41
        expect(calculateVSC2Size(1)).toBe(41);
    });

    it("exactly 1 chunk", () => {
        const size = DEFAULT_PLAIN_CHUNK_SIZE;
        // 1 chunk: HEADER(12) + IV(12) + size + TAG(16)
        expect(calculateVSC2Size(size)).toBe(HEADER_SIZE + IV_SIZE + size + GCM_TAG_SIZE);
    });

    it("1 chunk + 1 byte → 2 chunks", () => {
        const size = DEFAULT_PLAIN_CHUNK_SIZE + 1;
        // 2 chunks: HEADER + 2*IV + size + 2*TAG
        expect(calculateVSC2Size(size)).toBe(HEADER_SIZE + 2 * IV_SIZE + size + 2 * GCM_TAG_SIZE);
    });

    it("custom chunk size", () => {
        // 10 bytes with chunk size 3: ceil(10/3)=4 chunks
        expect(calculateVSC2Size(10, 3)).toBe(HEADER_SIZE + 4 * IV_SIZE + 10 + 4 * GCM_TAG_SIZE);
    });
});

// =============================================================================
// Suite 3: Round-trip (encryptChunked → decryptChunked)
// =============================================================================

describe("encryptChunked / decryptChunked round-trip", () => {
    let engine: ICryptoEngine;

    beforeEach(() => {
        engine = createMockEngine();
    });

    it("empty file (0 bytes)", async () => {
        const plain = new ArrayBuffer(0);
        const encrypted = await encryptChunked(plain, engine);
        const decrypted = await decryptChunked(encrypted, engine);
        expect(decrypted.byteLength).toBe(0);
    });

    it("1 byte", async () => {
        const plain = new Uint8Array([0x42]).buffer;
        const encrypted = await encryptChunked(plain, engine);
        const decrypted = await decryptChunked(encrypted, engine);
        expect(arraysEqual(decrypted, plain)).toBe(true);
    });

    it("exactly 1 chunk size", async () => {
        const plain = makeBuffer(DEFAULT_PLAIN_CHUNK_SIZE, 0xAB);
        const encrypted = await encryptChunked(plain, engine);
        const decrypted = await decryptChunked(encrypted, engine);
        expect(arraysEqual(decrypted, plain)).toBe(true);
    });

    it("1 chunk + 1 byte (2 chunks)", async () => {
        const plain = makeBuffer(DEFAULT_PLAIN_CHUNK_SIZE + 1, 0xCD);
        const encrypted = await encryptChunked(plain, engine);
        const decrypted = await decryptChunked(encrypted, engine);
        expect(arraysEqual(decrypted, plain)).toBe(true);
    });

    it("exactly 2 full chunks", async () => {
        const plain = makeBuffer(DEFAULT_PLAIN_CHUNK_SIZE * 2, 0xEF);
        const encrypted = await encryptChunked(plain, engine);
        const decrypted = await decryptChunked(encrypted, engine);
        expect(arraysEqual(decrypted, plain)).toBe(true);
    });

    it("5.1 MB (6 chunks)", async () => {
        const size = Math.ceil(5.1 * 1024 * 1024);
        const plain = makePatternBuffer(size);
        const encrypted = await encryptChunked(plain, engine);
        const decrypted = await decryptChunked(encrypted, engine);
        expect(arraysEqual(decrypted, plain)).toBe(true);
    });

    it("all byte values (0x00-0xFF)", async () => {
        const plain = makePatternBuffer(256);
        const encrypted = await encryptChunked(plain, engine);
        const decrypted = await decryptChunked(encrypted, engine);
        expect(arraysEqual(decrypted, plain)).toBe(true);
    });

    it("custom chunk size (256 bytes)", async () => {
        const plain = makeBuffer(1000, 0x77);
        const encrypted = await encryptChunked(plain, engine, 256);
        const decrypted = await decryptChunked(encrypted, engine);
        expect(arraysEqual(decrypted, plain)).toBe(true);
    });

    it("custom chunk size (64 bytes) with non-aligned data", async () => {
        const plain = makePatternBuffer(150); // ceil(150/64) = 3 chunks
        const encrypted = await encryptChunked(plain, engine, 64);
        const decrypted = await decryptChunked(encrypted, engine);
        expect(arraysEqual(decrypted, plain)).toBe(true);
    });
});

// =============================================================================
// Suite 4: Output format verification
// =============================================================================

describe("VSC2 output format verification", () => {
    let engine: ICryptoEngine;

    beforeEach(() => {
        engine = createMockEngine();
    });

    it("header contains correct magic, chunkSize, totalChunks", async () => {
        const plain = makeBuffer(300);
        const chunkSize = 128;
        const encrypted = await encryptChunked(plain, engine, chunkSize);

        const view = new DataView(encrypted);
        // Magic: "VSC2"
        expect(new Uint8Array(encrypted, 0, 4)).toEqual(CHUNK_MAGIC);
        // chunkSize
        expect(view.getUint32(4, true)).toBe(chunkSize);
        // totalChunks: ceil(300/128) = 3
        expect(view.getUint32(8, true)).toBe(3);
    });

    it("isChunkedFormat returns true for encrypted output", async () => {
        const encrypted = await encryptChunked(makeBuffer(100), engine, 50);
        expect(isChunkedFormat(encrypted)).toBe(true);
    });

    it("output size matches calculateVSC2Size prediction", async () => {
        const sizes = [0, 1, 100, DEFAULT_PLAIN_CHUNK_SIZE, DEFAULT_PLAIN_CHUNK_SIZE + 1];
        for (const size of sizes) {
            const encrypted = await encryptChunked(makeBuffer(size), engine);
            expect(encrypted.byteLength).toBe(calculateVSC2Size(size));
        }
    });

    it("output size matches with custom chunk size", async () => {
        const encrypted = await encryptChunked(makeBuffer(500), engine, 200);
        expect(encrypted.byteLength).toBe(calculateVSC2Size(500, 200));
    });

    it("each chunk starts with IV of correct size", async () => {
        const chunkSize = 64;
        const plain = makeBuffer(150); // 3 chunks
        const encrypted = await encryptChunked(plain, engine, chunkSize);

        let offset = HEADER_SIZE;
        for (let i = 0; i < 3; i++) {
            const iv = new Uint8Array(encrypted, offset, IV_SIZE);
            expect(iv).toEqual(MOCK_IV);
            offset += IV_SIZE;
            // Skip ciphertext
            const ctSize = (i < 2) ? chunkSize + GCM_TAG_SIZE : (150 - 2 * chunkSize) + GCM_TAG_SIZE;
            offset += ctSize;
        }
        expect(offset).toBe(encrypted.byteLength);
    });
});

// =============================================================================
// Suite 5: Error cases
// =============================================================================

describe("decryptChunked error cases", () => {
    let engine: ICryptoEngine;

    beforeEach(() => {
        engine = createMockEngine();
    });

    it("throws on data shorter than header (< 12 bytes)", async () => {
        await expect(decryptChunked(new ArrayBuffer(11), engine)).rejects.toThrow("too short");
    });

    it("throws on invalid magic", async () => {
        const buf = new ArrayBuffer(40);
        const view = new DataView(buf);
        // Wrong magic
        new Uint8Array(buf, 0, 4).set([0x00, 0x00, 0x00, 0x00]);
        view.setUint32(4, 64, true);
        view.setUint32(8, 1, true);
        await expect(decryptChunked(buf, engine)).rejects.toThrow("invalid magic");
    });

    it("throws on chunkSize = 0", async () => {
        const buf = new ArrayBuffer(40);
        new Uint8Array(buf, 0, 4).set(CHUNK_MAGIC);
        const view = new DataView(buf);
        view.setUint32(4, 0, true); // chunkSize = 0
        view.setUint32(8, 1, true);
        await expect(decryptChunked(buf, engine)).rejects.toThrow("chunkSize is 0");
    });

    it("throws on totalChunks = 0", async () => {
        const buf = new ArrayBuffer(40);
        new Uint8Array(buf, 0, 4).set(CHUNK_MAGIC);
        const view = new DataView(buf);
        view.setUint32(4, 64, true);
        view.setUint32(8, 0, true); // totalChunks = 0
        await expect(decryptChunked(buf, engine)).rejects.toThrow("totalChunks is 0");
    });

    it("throws on truncated chunk (missing IV)", async () => {
        // Header says 2 chunks but only enough data for 1
        const engine2 = createMockEngine();
        const plain = makeBuffer(100);
        const encrypted = await encryptChunked(plain, engine2, 64);
        // Truncate to remove 2nd chunk
        const truncated = encrypted.slice(0, HEADER_SIZE + IV_SIZE + 64 + GCM_TAG_SIZE + 2);
        // Overwrite totalChunks to 2 (it's already 2, but make sure)
        const view = new DataView(truncated);
        view.setUint32(8, 2, true);
        await expect(decryptChunked(truncated, engine2)).rejects.toThrow("truncated");
    });
});

// =============================================================================
// Suite 6: EncryptedAdapter threshold routing (Phase 1)
// =============================================================================

describe("EncryptedAdapter threshold routing", () => {
    let engine: ICryptoEngine;

    beforeEach(() => {
        engine = createMockEngine();
    });

    it("below threshold → VSC1 format", async () => {
        const baseAdapter = createMockBaseAdapter();
        const adapter = new EncryptedAdapter(baseAdapter, engine, 1000);

        const result = await adapter.uploadFile("test.md", makeBuffer(500), Date.now());
        // Verify uploaded content is NOT VSC2
        const uploaded = await baseAdapter.downloadFile(result.id);
        expect(isChunkedFormat(uploaded)).toBe(false);
        // VSC1: starts with IV (12 bytes of 0xBB from mock)
        expect(new Uint8Array(uploaded, 0, 1)[0]).toBe(0xBB);
    });

    it("at threshold → VSC2 format", async () => {
        const baseAdapter = createMockBaseAdapter();
        const adapter = new EncryptedAdapter(baseAdapter, engine, 500);

        const result = await adapter.uploadFile("test.md", makeBuffer(500), Date.now());
        const uploaded = await baseAdapter.downloadFile(result.id);
        expect(isChunkedFormat(uploaded)).toBe(true);
    });

    it("above threshold → VSC2 format", async () => {
        const baseAdapter = createMockBaseAdapter();
        const adapter = new EncryptedAdapter(baseAdapter, engine, 100);

        const result = await adapter.uploadFile("test.md", makeBuffer(500), Date.now());
        const uploaded = await baseAdapter.downloadFile(result.id);
        expect(isChunkedFormat(uploaded)).toBe(true);
    });

    it("threshold = 0 → always VSC1", async () => {
        const baseAdapter = createMockBaseAdapter();
        const adapter = new EncryptedAdapter(baseAdapter, engine, 0);

        const result = await adapter.uploadFile("test.md", makeBuffer(5000), Date.now());
        const uploaded = await baseAdapter.downloadFile(result.id);
        expect(isChunkedFormat(uploaded)).toBe(false);
    });

    it("downloadFile transparently decrypts VSC2", async () => {
        const baseAdapter = createMockBaseAdapter();
        const adapter = new EncryptedAdapter(baseAdapter, engine, 100);

        const original = makePatternBuffer(500);
        const result = await adapter.uploadFile("test.md", original, Date.now());
        const downloaded = await adapter.downloadFile(result.id);
        expect(arraysEqual(downloaded, original)).toBe(true);
    });

    it("downloadFile transparently decrypts VSC1 (backward compat)", async () => {
        const baseAdapter = createMockBaseAdapter();
        const adapter = new EncryptedAdapter(baseAdapter, engine, 0);

        const original = makePatternBuffer(500);
        const result = await adapter.uploadFile("test.md", original, Date.now());
        const downloaded = await adapter.downloadFile(result.id);
        expect(arraysEqual(downloaded, original)).toBe(true);
    });

    it("getRevisionContent decrypts VSC2", async () => {
        const baseAdapter = createMockBaseAdapter();
        const adapter = new EncryptedAdapter(baseAdapter, engine, 100);

        const original = makePatternBuffer(500);
        // Upload (stores encrypted content in mock)
        await adapter.uploadFile("test.md", original, Date.now());
        // getRevisionContent uses the same stored content in our mock
        const revContent = await adapter.getRevisionContent("test.md", "rev1");
        expect(arraysEqual(revContent, original)).toBe(true);
    });

    it("uploadFileResumable uses VSC2 for large files (Phase 1 fallback)", async () => {
        // Base adapter with uploadFileResumable but NO chunked upload methods
        const baseAdapter = createMockBaseAdapter();
        const adapter = new EncryptedAdapter(baseAdapter, engine, 100);

        const original = makePatternBuffer(500);
        const result = await adapter.uploadFileResumable("test.md", original, Date.now());
        const uploaded = await baseAdapter.downloadFile(result.id);
        expect(isChunkedFormat(uploaded)).toBe(true);
    });
});

// =============================================================================
// Suite 7: EncryptedAdapter streaming upload (Phase 2)
// =============================================================================

describe("EncryptedAdapter streaming upload (Phase 2)", () => {
    let engine: ICryptoEngine;

    beforeEach(() => {
        engine = createMockEngine();
    });

    it("large file uses initiateResumableSession + uploadChunk", async () => {
        const baseAdapter = createChunkedMockBaseAdapter();
        const initSpy = vi.spyOn(baseAdapter, "initiateResumableSession" as any);
        const chunkSpy = vi.spyOn(baseAdapter, "uploadChunk" as any);
        const adapter = new EncryptedAdapter(baseAdapter, engine, 100);

        await adapter.uploadFileResumable("test.md", makeBuffer(500), Date.now());

        expect(initSpy).toHaveBeenCalledOnce();
        expect(chunkSpy).toHaveBeenCalled();
    });

    it("uploadChunk is called multiple times for multi-chunk files", async () => {
        const baseAdapter = createChunkedMockBaseAdapter();
        const chunkSpy = vi.spyOn(baseAdapter, "uploadChunk" as any);
        // Use small threshold and default chunk size
        // File needs to be large enough to produce > 5 MiB encrypted data to trigger batch flush
        // With default chunk size ~1MB, a 6MB file = 6 chunks → ~6 MiB encrypted + header
        // The 5 MiB batch buffer should trigger at least one intermediate flush
        const size = 6 * 1024 * 1024;
        const adapter = new EncryptedAdapter(baseAdapter, engine, 100);

        await adapter.uploadFileResumable("big.bin", makeBuffer(size), Date.now());

        // Should have multiple uploadChunk calls (intermediate + final)
        expect(chunkSpy.mock.calls.length).toBeGreaterThan(1);
    });

    it("uploaded data can be downloaded and decrypted correctly", async () => {
        const baseAdapter = createChunkedMockBaseAdapter();
        const adapter = new EncryptedAdapter(baseAdapter, engine, 100);

        const original = makePatternBuffer(3000);
        const result = await adapter.uploadFileResumable("test.md", original, Date.now());

        // Download raw encrypted data and verify it's VSC2
        const raw = baseAdapter.getStoredContent(result.id);
        expect(raw).toBeDefined();
        expect(isChunkedFormat(raw!)).toBe(true);

        // Decrypt and verify
        const decrypted = await adapter.downloadFile(result.id);
        expect(arraysEqual(decrypted, original)).toBe(true);
    });

    it("small file does NOT use streaming path", async () => {
        const baseAdapter = createChunkedMockBaseAdapter();
        const initSpy = vi.spyOn(baseAdapter, "initiateResumableSession" as any);
        const adapter = new EncryptedAdapter(baseAdapter, engine, 1000);

        await adapter.uploadFileResumable("small.md", makeBuffer(500), Date.now());

        expect(initSpy).not.toHaveBeenCalled();
    });

    it("falls back to Phase 1 when base adapter lacks chunked methods", async () => {
        // Standard adapter without initiateResumableSession/uploadChunk
        const baseAdapter = createMockBaseAdapter();
        const adapter = new EncryptedAdapter(baseAdapter, engine, 100);

        const original = makePatternBuffer(500);
        const result = await adapter.uploadFileResumable("test.md", original, Date.now());

        // Should still produce valid encrypted output via Phase 1
        const uploaded = await baseAdapter.downloadFile(result.id);
        expect(isChunkedFormat(uploaded)).toBe(true);

        // Decrypt round-trip
        const downloaded = await adapter.downloadFile(result.id);
        expect(arraysEqual(downloaded, original)).toBe(true);
    });

    it("threshold = 0 → always VSC1, never streams", async () => {
        const baseAdapter = createChunkedMockBaseAdapter();
        const initSpy = vi.spyOn(baseAdapter, "initiateResumableSession" as any);
        const adapter = new EncryptedAdapter(baseAdapter, engine, 0);

        await adapter.uploadFileResumable("test.md", makeBuffer(5000), Date.now());

        expect(initSpy).not.toHaveBeenCalled();
    });

    it("empty file via streaming path", async () => {
        const baseAdapter = createChunkedMockBaseAdapter();
        const adapter = new EncryptedAdapter(baseAdapter, engine, 0); // threshold 0 → no streaming for empty

        // With threshold > 0, empty file still triggers VSC2 path (0 >= threshold won't match)
        // So empty files always use VSC1 (since 0 < any positive threshold)
        const original = new ArrayBuffer(0);
        const result = await adapter.uploadFile("empty.md", original, Date.now());
        const downloaded = await adapter.downloadFile(result.id);
        expect(downloaded.byteLength).toBe(0);
    });
});

// =============================================================================
// Suite 8: MockCloudAdapter chunked upload
// =============================================================================

describe("MockCloudAdapter chunked upload", () => {
    it("initiateResumableSession returns a valid session URI", async () => {
        const { MockCloudAdapter } = await import("../../helpers/mock-cloud-adapter");
        const adapter = new MockCloudAdapter();
        const uri = await adapter.initiateResumableSession("test.md", 1000, Date.now());
        expect(uri).toMatch(/^mock-session-/);
    });

    it("uploadChunk returns null for intermediate chunk", async () => {
        const { MockCloudAdapter } = await import("../../helpers/mock-cloud-adapter");
        const adapter = new MockCloudAdapter();
        const uri = await adapter.initiateResumableSession("test.md", 1000, Date.now());

        const chunk = makeBuffer(500);
        const result = await adapter.uploadChunk(uri, chunk, 0, 1000, "test.md", Date.now());
        expect(result).toBeNull();
    });

    it("uploadChunk returns CloudFile on final chunk", async () => {
        const { MockCloudAdapter } = await import("../../helpers/mock-cloud-adapter");
        const adapter = new MockCloudAdapter();
        const mtime = Date.now();
        const uri = await adapter.initiateResumableSession("test.md", 100, mtime);

        const result = await adapter.uploadChunk(uri, makeBuffer(100), 0, 100, "test.md", mtime);
        expect(result).not.toBeNull();
        expect(result!.path).toBe("test.md");
        expect(result!.id).toBeDefined();
    });

    it("multiple chunks combine correctly", async () => {
        const { MockCloudAdapter } = await import("../../helpers/mock-cloud-adapter");
        const adapter = new MockCloudAdapter();
        const mtime = Date.now();
        const totalSize = 300;
        const uri = await adapter.initiateResumableSession("test.md", totalSize, mtime);

        // Upload 3 chunks of 100 bytes each
        const chunk1 = new Uint8Array(100).fill(0xAA).buffer;
        const chunk2 = new Uint8Array(100).fill(0xBB).buffer;
        const chunk3 = new Uint8Array(100).fill(0xCC).buffer;

        expect(await adapter.uploadChunk(uri, chunk1, 0, totalSize, "test.md", mtime)).toBeNull();
        expect(await adapter.uploadChunk(uri, chunk2, 100, totalSize, "test.md", mtime)).toBeNull();
        const result = await adapter.uploadChunk(uri, chunk3, 200, totalSize, "test.md", mtime);
        expect(result).not.toBeNull();

        // Download and verify combined content
        const content = await adapter.downloadFile(result!.id);
        const view = new Uint8Array(content);
        expect(view.slice(0, 100).every(b => b === 0xAA)).toBe(true);
        expect(view.slice(100, 200).every(b => b === 0xBB)).toBe(true);
        expect(view.slice(200, 300).every(b => b === 0xCC)).toBe(true);
    });

    it("throws for unknown session URI", async () => {
        const { MockCloudAdapter } = await import("../../helpers/mock-cloud-adapter");
        const adapter = new MockCloudAdapter();
        await expect(
            adapter.uploadChunk("bad-session", makeBuffer(100), 0, 100, "test.md", Date.now()),
        ).rejects.toThrow("Unknown session");
    });
});
