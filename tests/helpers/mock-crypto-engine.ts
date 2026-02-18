/**
 * Shared mock ICryptoEngine for tests.
 * Implements all methods including VSC2 chunked encryption.
 *
 * Mock encrypt: ciphertext = [plaintext][16-byte mock tag (0xDD)], iv = 12 bytes of 0xBB
 * Mock decrypt: strip last 16 bytes of ciphertext
 */
import type { ICryptoEngine } from "../../src/encryption/interfaces";
import { DecryptionError } from "../../src/encryption/errors";

// VSC2 wire format constants (exported for test assertions)
export const VSC2_MAGIC = new Uint8Array([0x56, 0x53, 0x43, 0x32]);
export const VSC2_HEADER_SIZE = 12;

export const MOCK_IV_SIZE = 12;
export const MOCK_TAG_SIZE = 16;
export const MOCK_CHUNK_SIZE = 1_048_548; // 1 MiB - IV - tag

const MOCK_IV_FILL = 0xBB;
const MOCK_TAG_FILL = 0xDD;

export function createMockEngine(overrides?: Partial<ICryptoEngine>): ICryptoEngine {
    const engine: ICryptoEngine = {
        ivSize: MOCK_IV_SIZE,
        tagSize: MOCK_TAG_SIZE,
        initializeNewVault: async () => "",
        unlockVault: async () => {},
        isUnlocked: () => true,

        async encrypt(data: ArrayBuffer) {
            const plain = new Uint8Array(data);
            const ct = new Uint8Array(plain.byteLength + MOCK_TAG_SIZE);
            ct.set(plain, 0);
            ct.set(new Uint8Array(MOCK_TAG_SIZE).fill(MOCK_TAG_FILL), plain.byteLength);
            return {
                ciphertext: ct.buffer.slice(ct.byteOffset, ct.byteOffset + ct.byteLength),
                iv: new Uint8Array(MOCK_IV_SIZE).fill(MOCK_IV_FILL),
            };
        },

        async decrypt(ciphertext: ArrayBuffer, _iv: Uint8Array) {
            return ciphertext.slice(0, ciphertext.byteLength - MOCK_TAG_SIZE);
        },

        async encryptToBlob(data: ArrayBuffer) {
            const { iv, ciphertext } = await this.encrypt(data);
            const combined = new Uint8Array(iv.byteLength + ciphertext.byteLength);
            combined.set(iv, 0);
            combined.set(new Uint8Array(ciphertext), iv.byteLength);
            return combined.buffer.slice(combined.byteOffset, combined.byteOffset + combined.byteLength);
        },

        async decryptFromBlob(blob: ArrayBuffer) {
            const iv = new Uint8Array(blob.slice(0, this.ivSize));
            const ciphertext = blob.slice(this.ivSize);
            return this.decrypt(ciphertext, iv);
        },

        getOptimalChunkSize() { return MOCK_CHUNK_SIZE; },

        isChunkedFormat(data: ArrayBuffer): boolean {
            if (data.byteLength < 4) return false;
            const v = new Uint8Array(data, 0, 4);
            return v[0] === 0x56 && v[1] === 0x53 && v[2] === 0x43 && v[3] === 0x32;
        },

        async encryptChunked(data: ArrayBuffer): Promise<ArrayBuffer> {
            const chunkSize = this.getOptimalChunkSize();
            const outputSize = this.calculateChunkedSize(data.byteLength);
            const output = new Uint8Array(outputSize);
            const header = this.buildChunkedHeader(data.byteLength);
            output.set(header, 0);
            let writeOffset = header.byteLength;
            for await (const { iv, ciphertext } of this.encryptChunks(data)) {
                output.set(iv, writeOffset);
                writeOffset += this.ivSize;
                output.set(new Uint8Array(ciphertext), writeOffset);
                writeOffset += ciphertext.byteLength;
            }
            return output.buffer.slice(output.byteOffset, output.byteOffset + writeOffset);
        },

        async decryptChunked(data: ArrayBuffer): Promise<ArrayBuffer> {
            if (data.byteLength < VSC2_HEADER_SIZE) {
                throw new DecryptionError("VSC2: data too short for header", "format");
            }
            const view = new DataView(data, 0, VSC2_HEADER_SIZE);
            const magic = new Uint8Array(data, 0, 4);
            if (magic[0] !== 0x56 || magic[1] !== 0x53 || magic[2] !== 0x43 || magic[3] !== 0x32) {
                throw new DecryptionError("VSC2: invalid magic bytes", "format");
            }
            const chunkSize = view.getUint32(4, true);
            const totalChunks = view.getUint32(8, true);
            if (chunkSize === 0) throw new DecryptionError("VSC2: chunkSize is 0", "format");
            if (totalChunks === 0) throw new DecryptionError("VSC2: totalChunks is 0", "format");

            const maxPlaintextSize = totalChunks * chunkSize;
            const output = new Uint8Array(maxPlaintextSize);
            let writeOffset = 0;
            let readOffset = VSC2_HEADER_SIZE;

            for (let i = 0; i < totalChunks; i++) {
                if (readOffset + this.ivSize > data.byteLength) {
                    throw new DecryptionError(`VSC2: truncated data at chunk ${i} (missing IV)`, "format", i);
                }
                const iv = new Uint8Array(data.slice(readOffset, readOffset + this.ivSize));
                readOffset += this.ivSize;

                let ciphertextSize: number;
                if (i < totalChunks - 1) {
                    ciphertextSize = chunkSize + this.tagSize;
                } else {
                    ciphertextSize = data.byteLength - readOffset;
                }
                if (ciphertextSize < this.tagSize) {
                    throw new DecryptionError(`VSC2: truncated ciphertext at chunk ${i}`, "format", i);
                }
                if (readOffset + ciphertextSize > data.byteLength) {
                    throw new DecryptionError(`VSC2: truncated data at chunk ${i} (missing ciphertext)`, "format", i);
                }
                const ciphertext = data.slice(readOffset, readOffset + ciphertextSize);
                readOffset += ciphertextSize;

                let decrypted: ArrayBuffer;
                try {
                    decrypted = await this.decrypt(ciphertext, iv);
                } catch (e) {
                    if (e instanceof DecryptionError) throw e;
                    throw new DecryptionError(`VSC2: decryption failed at chunk ${i}`, "authentication", i);
                }
                output.set(new Uint8Array(decrypted), writeOffset);
                writeOffset += decrypted.byteLength;
            }
            return output.buffer.slice(output.byteOffset, output.byteOffset + writeOffset);
        },

        calculateChunkedSize(plaintextSize: number): number {
            const chunkSize = this.getOptimalChunkSize();
            const totalChunks = Math.max(1, Math.ceil(plaintextSize / chunkSize));
            return VSC2_HEADER_SIZE + totalChunks * this.ivSize + plaintextSize + totalChunks * this.tagSize;
        },

        buildChunkedHeader(plaintextSize: number): Uint8Array {
            const chunkSize = this.getOptimalChunkSize();
            const totalChunks = Math.max(1, Math.ceil(plaintextSize / chunkSize));
            const header = new Uint8Array(VSC2_HEADER_SIZE);
            header.set(VSC2_MAGIC, 0);
            const dv = new DataView(header.buffer, header.byteOffset, VSC2_HEADER_SIZE);
            dv.setUint32(4, chunkSize, true);
            dv.setUint32(8, totalChunks, true);
            return header;
        },

        async *encryptChunks(data: ArrayBuffer) {
            const chunkSize = this.getOptimalChunkSize();
            const totalChunks = Math.max(1, Math.ceil(data.byteLength / chunkSize));
            for (let i = 0; i < totalChunks; i++) {
                const start = i * chunkSize;
                const end = Math.min(start + chunkSize, data.byteLength);
                const { iv, ciphertext } = await this.encrypt(data.slice(start, end));
                yield { iv, ciphertext, index: i, totalChunks };
            }
        },

        showSetupModal: () => {},
        showUnlockModal: () => {},
        getSettingsSections: () => [],
    };

    if (overrides) {
        Object.assign(engine, overrides);
    }
    return engine;
}

/** Engine that always fails on decrypt (simulates wrong password). */
export function createFailingEngine(): ICryptoEngine {
    return createMockEngine({
        async decrypt() { throw new Error("OperationError"); },
        async decryptFromBlob() { throw new Error("OperationError"); },
    });
}
