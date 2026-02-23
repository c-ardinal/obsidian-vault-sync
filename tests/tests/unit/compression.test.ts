/**
 * Unit tests for compression utilities.
 *
 * Verifies:
 *   - compress: gzip compression produces smaller output
 *   - tryDecompress: decompresses gzip, passes through non-gzip
 *   - Round-trip: compress → decompress recovers original
 */

import { describe, it, expect } from "vitest";
import { compress, tryDecompress } from "../../../src/sync-manager/file-utils";

describe("compress", () => {
    it("should produce gzip output with magic bytes", async () => {
        const input = new TextEncoder().encode("Hello, World!").buffer as ArrayBuffer;
        const compressed = await compress(input);
        const view = new Uint8Array(compressed);
        // Gzip magic bytes: 0x1f 0x8b
        expect(view[0]).toBe(0x1f);
        expect(view[1]).toBe(0x8b);
    });

    it("should compress repetitive data to smaller size", async () => {
        const text = "AAAAAAAAAA".repeat(100);
        const input = new TextEncoder().encode(text).buffer as ArrayBuffer;
        const compressed = await compress(input);
        expect(compressed.byteLength).toBeLessThan(input.byteLength);
    });

    it("should handle empty input", async () => {
        const input = new ArrayBuffer(0);
        const compressed = await compress(input);
        expect(compressed.byteLength).toBeGreaterThan(0); // gzip header is non-zero
    });
});

describe("tryDecompress", () => {
    it("should decompress gzip data", async () => {
        const original = new TextEncoder().encode("Test content for compression").buffer as ArrayBuffer;
        const compressed = await compress(original);
        const decompressed = await tryDecompress(compressed);
        const result = new TextDecoder().decode(decompressed);
        expect(result).toBe("Test content for compression");
    });

    it("should pass through non-gzip data unchanged", async () => {
        const plainData = new TextEncoder().encode("Not compressed").buffer as ArrayBuffer;
        const result = await tryDecompress(plainData);
        const text = new TextDecoder().decode(result);
        expect(text).toBe("Not compressed");
    });

    it("should pass through data shorter than 3 bytes", async () => {
        const tiny = new Uint8Array([0x41, 0x42]).buffer as ArrayBuffer;
        const result = await tryDecompress(tiny);
        expect(new Uint8Array(result)).toEqual(new Uint8Array([0x41, 0x42]));
    });

    it("should round-trip text content correctly", async () => {
        const text = "Line 1\nLine 2\nLine 3\n日本語テスト\n";
        const original = new TextEncoder().encode(text).buffer as ArrayBuffer;
        const compressed = await compress(original);
        const decompressed = await tryDecompress(compressed);
        expect(new TextDecoder().decode(decompressed)).toBe(text);
    });

    it("should round-trip binary content correctly", async () => {
        const original = new Uint8Array([0, 1, 2, 255, 128, 64]).buffer as ArrayBuffer;
        const compressed = await compress(original);
        const decompressed = await tryDecompress(compressed);
        expect(new Uint8Array(decompressed)).toEqual(new Uint8Array([0, 1, 2, 255, 128, 64]));
    });
});
