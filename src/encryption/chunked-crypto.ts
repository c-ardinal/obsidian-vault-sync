import type { ICryptoEngine } from "./interfaces";

/** VSC2 magic bytes: "VSC2" (VaultSync Chunked v2) */
export const CHUNK_MAGIC = new Uint8Array([0x56, 0x53, 0x43, 0x32]);

export const HEADER_SIZE = 12; // magic(4) + chunkSize(4) + totalChunks(4)
export const IV_SIZE = 12;
export const GCM_TAG_SIZE = 16;

/**
 * Default plaintext chunk size.
 * Chosen so that each encrypted chunk = IV(12) + plaintext(1,048,548) + GCM_TAG(16) = 1,048,576 (1 MiB).
 * This satisfies Google Drive's 256 KiB alignment requirement (1 MiB = 4 × 256 KiB).
 */
export const DEFAULT_PLAIN_CHUNK_SIZE = 1_048_548;

/** Check whether an ArrayBuffer starts with the VSC2 magic header. */
export function isChunkedFormat(data: ArrayBuffer): boolean {
    if (data.byteLength < 4) return false;
    const view = new Uint8Array(data, 0, 4);
    return (
        view[0] === CHUNK_MAGIC[0] &&
        view[1] === CHUNK_MAGIC[1] &&
        view[2] === CHUNK_MAGIC[2] &&
        view[3] === CHUNK_MAGIC[3]
    );
}

/** Calculate the total encrypted size for a given plaintext size using VSC2 format. */
export function calculateVSC2Size(
    plaintextSize: number,
    chunkSize: number = DEFAULT_PLAIN_CHUNK_SIZE,
): number {
    const totalChunks = Math.max(1, Math.ceil(plaintextSize / chunkSize));
    // HEADER + per-chunk: IV + plaintext + GCM tag
    return HEADER_SIZE + totalChunks * IV_SIZE + plaintextSize + totalChunks * GCM_TAG_SIZE;
}

/** Build a 12-byte VSC2 header. */
export function buildVSC2Header(chunkSize: number, totalChunks: number): Uint8Array {
    const header = new Uint8Array(HEADER_SIZE);
    header.set(CHUNK_MAGIC, 0);
    const dv = new DataView(header.buffer, header.byteOffset, HEADER_SIZE);
    dv.setUint32(4, chunkSize, true); // little-endian
    dv.setUint32(8, totalChunks, true);
    return header;
}

/**
 * Encrypt an ArrayBuffer into VSC2 chunked format.
 * Each chunk is encrypted independently with its own IV, allowing
 * streaming decryption and reducing peak memory during encryption.
 */
export async function encryptChunked(
    plaintext: ArrayBuffer,
    engine: ICryptoEngine,
    chunkSize: number = DEFAULT_PLAIN_CHUNK_SIZE,
): Promise<ArrayBuffer> {
    const totalChunks = Math.max(1, Math.ceil(plaintext.byteLength / chunkSize));
    const outputSize = calculateVSC2Size(plaintext.byteLength, chunkSize);
    const output = new Uint8Array(outputSize);

    // Write header
    output.set(buildVSC2Header(chunkSize, totalChunks), 0);
    let writeOffset = HEADER_SIZE;

    const plaintextView = new Uint8Array(plaintext);

    for (let i = 0; i < totalChunks; i++) {
        const start = i * chunkSize;
        const end = Math.min(start + chunkSize, plaintext.byteLength);
        const chunk = plaintext.slice(start, end);

        const { iv, ciphertext } = await engine.encrypt(chunk);

        // Write IV
        output.set(iv, writeOffset);
        writeOffset += IV_SIZE;

        // Write ciphertext (includes GCM tag)
        output.set(new Uint8Array(ciphertext), writeOffset);
        writeOffset += ciphertext.byteLength;
    }

    return output.buffer.slice(output.byteOffset, output.byteOffset + writeOffset);
}

/**
 * Decrypt a VSC2 chunked-format ArrayBuffer back to plaintext.
 * Automatically detects chunk boundaries from the header.
 */
export async function decryptChunked(
    data: ArrayBuffer,
    engine: ICryptoEngine,
): Promise<ArrayBuffer> {
    if (data.byteLength < HEADER_SIZE) {
        throw new Error("VSC2: data too short for header");
    }

    const view = new DataView(data, 0, HEADER_SIZE);

    // Validate magic
    const magic = new Uint8Array(data, 0, 4);
    if (
        magic[0] !== CHUNK_MAGIC[0] ||
        magic[1] !== CHUNK_MAGIC[1] ||
        magic[2] !== CHUNK_MAGIC[2] ||
        magic[3] !== CHUNK_MAGIC[3]
    ) {
        throw new Error("VSC2: invalid magic bytes");
    }

    const chunkSize = view.getUint32(4, true);
    const totalChunks = view.getUint32(8, true);

    if (chunkSize === 0) throw new Error("VSC2: chunkSize is 0");
    if (totalChunks === 0) throw new Error("VSC2: totalChunks is 0");

    // Calculate max possible plaintext size for pre-allocation
    const maxPlaintextSize = totalChunks * chunkSize;
    const output = new Uint8Array(maxPlaintextSize);
    let writeOffset = 0;
    let readOffset = HEADER_SIZE;

    for (let i = 0; i < totalChunks; i++) {
        if (readOffset + IV_SIZE > data.byteLength) {
            throw new Error(`VSC2: truncated data at chunk ${i} (missing IV)`);
        }

        // Read IV
        const iv = new Uint8Array(data.slice(readOffset, readOffset + IV_SIZE));
        readOffset += IV_SIZE;

        // Determine ciphertext size
        let ciphertextSize: number;
        if (i < totalChunks - 1) {
            // Full chunk: plaintext chunk size + GCM tag
            ciphertextSize = chunkSize + GCM_TAG_SIZE;
        } else {
            // Last chunk: all remaining bytes
            ciphertextSize = data.byteLength - readOffset;
        }

        if (ciphertextSize < GCM_TAG_SIZE) {
            throw new Error(`VSC2: truncated ciphertext at chunk ${i}`);
        }

        if (readOffset + ciphertextSize > data.byteLength) {
            throw new Error(`VSC2: truncated data at chunk ${i} (missing ciphertext)`);
        }

        const ciphertext = data.slice(readOffset, readOffset + ciphertextSize);
        readOffset += ciphertextSize;

        const decrypted = await engine.decrypt(ciphertext, iv);
        output.set(new Uint8Array(decrypted), writeOffset);
        writeOffset += decrypted.byteLength;
    }

    return output.buffer.slice(output.byteOffset, output.byteOffset + writeOffset);
}
