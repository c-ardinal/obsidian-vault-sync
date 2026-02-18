import { describe, it, expect, vi } from "vitest";
import { DecryptionError } from "../../../src/encryption/errors";
import {
    decryptChunked,
    encryptChunked,
    CHUNK_MAGIC,
    HEADER_SIZE,
    GCM_TAG_SIZE,
    buildVSC2Header,
    IV_SIZE,
} from "../../../src/encryption/chunked-crypto";
import { EncryptedAdapter } from "../../../src/adapters/encrypted-adapter";
import type { CloudAdapter, CloudFile } from "../../../src/types/adapter";
import type { ICryptoEngine } from "../../../src/encryption/interfaces";

// =============================================================================
// Helpers
// =============================================================================

const MOCK_IV = new Uint8Array(12).fill(0xbb);
const MOCK_TAG = new Uint8Array(16).fill(0xdd);

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
            return {
                ciphertext: ct.buffer.slice(ct.byteOffset, ct.byteOffset + ct.byteLength),
                iv: new Uint8Array(MOCK_IV),
            };
        },
        decrypt: async (ciphertext: ArrayBuffer, _iv: Uint8Array) => {
            return ciphertext.slice(0, ciphertext.byteLength - GCM_TAG_SIZE);
        },
        showSetupModal: () => {},
        showUnlockModal: () => {},
        getSettingsSections: () => [],
    };
}

/** Engine that always fails on decrypt (simulates wrong password). */
function createFailingEngine(): ICryptoEngine {
    return {
        ...createMockEngine(),
        decrypt: async () => {
            throw new Error("OperationError");
        },
    };
}

function createMockBaseAdapter(
    storedContent?: ArrayBuffer,
): CloudAdapter {
    return {
        name: "MockBase",
        supportsChangesAPI: true,
        supportsHash: true,
        supportsHistory: false,
        vaultName: "test",
        isAuthenticated: () => true,
        getAuthUrl: async () => "",
        handleCallback: async () => {},
        logout: async () => {},
        getFileMetadata: async () => null,
        getFileMetadataById: async () => null,
        downloadFile: async () => storedContent || new ArrayBuffer(0),
        uploadFile: async (_p, _c, _m, _e) =>
            ({ id: "f1", path: _p, mtime: _m, size: 0, kind: "file" as const, hash: "" }),
        deleteFile: async () => {},
        moveFile: async (_id, _name, _parent) =>
            ({ id: _id, path: _name, mtime: 0, size: 0, kind: "file" as const, hash: "" }),
        createFolder: async () => "folder1",
        ensureFoldersExist: async () => {},
        fileExistsById: async () => false,
        getStartPageToken: async () => "0",
        getChanges: async () => ({ newStartPageToken: "0", changes: [] }),
        listFiles: async () => [],
        setLogger: () => {},
    };
}

// =============================================================================
// DecryptionError class
// =============================================================================

describe("DecryptionError", () => {
    it("has correct name and properties for authentication cause", () => {
        const err = new DecryptionError("wrong key", "authentication");
        expect(err.name).toBe("DecryptionError");
        expect(err.cause).toBe("authentication");
        expect(err.message).toBe("wrong key");
        expect(err.chunkIndex).toBeUndefined();
        expect(err).toBeInstanceOf(Error);
        expect(err).toBeInstanceOf(DecryptionError);
    });

    it("has correct properties for format cause with chunkIndex", () => {
        const err = new DecryptionError("truncated", "format", 3);
        expect(err.cause).toBe("format");
        expect(err.chunkIndex).toBe(3);
    });
});

// =============================================================================
// decryptChunked — DecryptionError wrapping
// =============================================================================

describe("decryptChunked DecryptionError wrapping", () => {
    const engine = createMockEngine();

    it("throws DecryptionError with format cause for data too short", async () => {
        const short = new ArrayBuffer(4);
        try {
            await decryptChunked(short, engine);
            expect.unreachable("should have thrown");
        } catch (e) {
            expect(e).toBeInstanceOf(DecryptionError);
            expect((e as DecryptionError).cause).toBe("format");
        }
    });

    it("throws DecryptionError with format cause for invalid magic", async () => {
        const buf = new ArrayBuffer(HEADER_SIZE);
        new Uint8Array(buf).fill(0xff);
        try {
            await decryptChunked(buf, engine);
            expect.unreachable("should have thrown");
        } catch (e) {
            expect(e).toBeInstanceOf(DecryptionError);
            expect((e as DecryptionError).cause).toBe("format");
        }
    });

    it("throws DecryptionError with format cause for zero chunkSize", async () => {
        const header = buildVSC2Header(0, 1);
        try {
            await decryptChunked(header.buffer.slice(header.byteOffset, header.byteOffset + HEADER_SIZE) as ArrayBuffer, engine);
            expect.unreachable("should have thrown");
        } catch (e) {
            expect(e).toBeInstanceOf(DecryptionError);
            expect((e as DecryptionError).cause).toBe("format");
            expect((e as DecryptionError).message).toContain("chunkSize");
        }
    });

    it("throws DecryptionError with authentication cause on decrypt failure", async () => {
        // Build a valid VSC2 with 1 chunk but use a failing engine
        const plaintext = new Uint8Array([1, 2, 3]);
        const goodEngine = createMockEngine();
        const encrypted = await encryptChunked(plaintext.buffer, goodEngine, 100);

        const failEngine = createFailingEngine();
        try {
            await decryptChunked(encrypted, failEngine);
            expect.unreachable("should have thrown");
        } catch (e) {
            expect(e).toBeInstanceOf(DecryptionError);
            expect((e as DecryptionError).cause).toBe("authentication");
            expect((e as DecryptionError).chunkIndex).toBe(0);
        }
    });
});

// =============================================================================
// EncryptedAdapter decryptContent — DecryptionError wrapping
// =============================================================================

describe("EncryptedAdapter DecryptionError wrapping", () => {
    it("throws DecryptionError with format cause for data shorter than 12 bytes", async () => {
        const short = new ArrayBuffer(8);
        const base = createMockBaseAdapter(short);
        const adapter = new EncryptedAdapter(base, createMockEngine());

        try {
            await adapter.downloadFile("f1");
            expect.unreachable("should have thrown");
        } catch (e) {
            expect(e).toBeInstanceOf(DecryptionError);
            expect((e as DecryptionError).cause).toBe("format");
        }
    });

    it("throws DecryptionError with authentication cause for VSC1 decrypt failure", async () => {
        // Valid VSC1 format: [IV(12)][ciphertext(20)]
        const content = new ArrayBuffer(32);
        new Uint8Array(content).fill(0xaa);
        const base = createMockBaseAdapter(content);
        const adapter = new EncryptedAdapter(base, createFailingEngine());

        try {
            await adapter.downloadFile("f1");
            expect.unreachable("should have thrown");
        } catch (e) {
            expect(e).toBeInstanceOf(DecryptionError);
            expect((e as DecryptionError).cause).toBe("authentication");
        }
    });

    it("passes through DecryptionError from VSC2 chunked decryption", async () => {
        // Build valid VSC2 encrypted data, then try to decrypt with failing engine
        const plaintext = new Uint8Array([10, 20, 30]);
        const goodEngine = createMockEngine();
        const encrypted = await encryptChunked(plaintext.buffer, goodEngine, 100);

        const base = createMockBaseAdapter(encrypted);
        const adapter = new EncryptedAdapter(base, createFailingEngine());

        try {
            await adapter.downloadFile("f1");
            expect.unreachable("should have thrown");
        } catch (e) {
            expect(e).toBeInstanceOf(DecryptionError);
            expect((e as DecryptionError).cause).toBe("authentication");
        }
    });

    it("successful decrypt does not throw DecryptionError", async () => {
        // Build valid VSC1: [IV(12)][plaintext + tag(16)]
        const engine = createMockEngine();
        const plaintext = new TextEncoder().encode("hello world");
        const { iv, ciphertext } = await engine.encrypt(plaintext.buffer);
        const combined = new Uint8Array(iv.byteLength + ciphertext.byteLength);
        combined.set(iv, 0);
        combined.set(new Uint8Array(ciphertext), iv.byteLength);

        const base = createMockBaseAdapter(
            combined.buffer.slice(combined.byteOffset, combined.byteOffset + combined.byteLength),
        );
        const adapter = new EncryptedAdapter(base, engine);

        const result = await adapter.downloadFile("f1");
        expect(new TextDecoder().decode(result)).toBe("hello world");
    });
});
