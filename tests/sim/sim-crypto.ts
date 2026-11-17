/**
 * Deterministic stand-in for the E2EE engine, used by the "e2ee" sim scenario.
 *
 * Like real AES-GCM it uses a fresh IV for every encryption, so uploading the
 * same plaintext twice yields DIFFERENT ciphertext and a different cloud md5.
 * That is the property that matters for sync: cloud hashes stop identifying
 * content, and only the plaintext hash (plainHash) does.
 *
 * Cipher: plaintext XOR keystream(iv) + 16-byte tag. IVs come from the seeded
 * world RNG so runs are reproducible.
 */
import type { ICryptoEngine } from "../../src/encryption/interfaces";
import { createMockEngine, MOCK_TAG_SIZE } from "../helpers/mock-crypto-engine";
import type { Rng } from "./rng";

function keystream(iv: Uint8Array, i: number): number {
    return (iv[i % iv.length] ^ (i * 31 + 7)) & 0xff;
}

export function createSimCryptoEngine(rng: Rng): ICryptoEngine {
    return createMockEngine({
        async encrypt(data: ArrayBuffer) {
            const iv = new Uint8Array(12);
            for (let i = 0; i < iv.length; i++) iv[i] = rng.int(0, 255);
            const plain = new Uint8Array(data);
            const ct = new Uint8Array(plain.byteLength + MOCK_TAG_SIZE);
            for (let i = 0; i < plain.byteLength; i++) ct[i] = plain[i] ^ keystream(iv, i);
            ct.fill(0xdd, plain.byteLength);
            return { ciphertext: ct.buffer, iv };
        },
        async decrypt(ciphertext: ArrayBuffer, iv: Uint8Array) {
            const ct = new Uint8Array(ciphertext);
            const n = ct.byteLength - MOCK_TAG_SIZE;
            const out = new Uint8Array(n);
            for (let i = 0; i < n; i++) out[i] = ct[i] ^ keystream(iv, i);
            return out.buffer;
        },
    });
}
