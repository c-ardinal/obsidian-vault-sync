/**
 * @file ハッシュ計算と改行正規化のユニットテスト
 *
 * @description
 * normalizeLineEndings (CRLF→LF)、md5 (RFC 1321テストベクタ)、hashContent (正規化+MD5) を検証する。
 * CRLF/LFの違いが同期判定に影響しないことを保証する。
 *
 * @pass_criteria
 * - CRLF→LF正規化で孤立CRが影響を受けないこと
 * - MD5がRFC 1321の全テストベクタと一致すること
 * - CRLF版とLF版のhashContentが同一ハッシュを返すこと
 */

import { describe, it, expect } from "vitest";
import { normalizeLineEndings, hashContent } from "../../../src/sync-manager/file-utils";
import { md5 } from "../../../src/utils/md5";

describe("normalizeLineEndings", () => {
    it("should convert CRLF to LF", () => {
        expect(normalizeLineEndings("line1\r\nline2\r\n")).toBe("line1\nline2\n");
    });

    it("should leave LF unchanged", () => {
        expect(normalizeLineEndings("line1\nline2\n")).toBe("line1\nline2\n");
    });

    it("should handle mixed CRLF and LF", () => {
        expect(normalizeLineEndings("a\r\nb\nc\r\nd\n")).toBe("a\nb\nc\nd\n");
    });

    it("should handle empty string", () => {
        expect(normalizeLineEndings("")).toBe("");
    });

    it("should handle string with no line endings", () => {
        expect(normalizeLineEndings("single line")).toBe("single line");
    });

    it("should not affect lone CR characters", () => {
        expect(normalizeLineEndings("a\rb\r")).toBe("a\rb\r");
    });
});

describe("md5", () => {
    // RFC 1321 test vectors
    it('should hash empty string to d41d8cd98f00b204e9800998ecf8427e', () => {
        const buf = new TextEncoder().encode("").buffer;
        expect(md5(buf)).toBe("d41d8cd98f00b204e9800998ecf8427e");
    });

    it('should hash "a" correctly', () => {
        const buf = new TextEncoder().encode("a").buffer;
        expect(md5(buf)).toBe("0cc175b9c0f1b6a831c399e269772661");
    });

    it('should hash "abc" correctly', () => {
        const buf = new TextEncoder().encode("abc").buffer;
        expect(md5(buf)).toBe("900150983cd24fb0d6963f7d28e17f72");
    });

    it('should hash "message digest" correctly', () => {
        const buf = new TextEncoder().encode("message digest").buffer;
        expect(md5(buf)).toBe("f96b697d7cb7938d525a2f31aaf161d0");
    });

    it('should hash alphabet correctly', () => {
        const buf = new TextEncoder().encode("abcdefghijklmnopqrstuvwxyz").buffer;
        expect(md5(buf)).toBe("c3fcd3d76192e4007dfb496cca67e13b");
    });

    it("should produce consistent hash for same input", () => {
        const buf1 = new TextEncoder().encode("test content").buffer;
        const buf2 = new TextEncoder().encode("test content").buffer;
        expect(md5(buf1)).toBe(md5(buf2));
    });

    it("should produce different hashes for different inputs", () => {
        const buf1 = new TextEncoder().encode("hello").buffer;
        const buf2 = new TextEncoder().encode("world").buffer;
        expect(md5(buf1)).not.toBe(md5(buf2));
    });
});

describe("hashContent", () => {
    it("should return MD5 hash of content", async () => {
        const buf = new TextEncoder().encode("test content").buffer as ArrayBuffer;
        const hash = await hashContent(buf);
        expect(hash).toMatch(/^[0-9a-f]{32}$/);
    });

    it("should normalize line endings before hashing", async () => {
        const crlfBuf = new TextEncoder().encode("line1\r\nline2\r\n").buffer as ArrayBuffer;
        const lfBuf = new TextEncoder().encode("line1\nline2\n").buffer as ArrayBuffer;
        expect(await hashContent(crlfBuf)).toBe(await hashContent(lfBuf));
    });

    it("should produce different hashes for different content", async () => {
        const buf1 = new TextEncoder().encode("content A").buffer as ArrayBuffer;
        const buf2 = new TextEncoder().encode("content B").buffer as ArrayBuffer;
        expect(await hashContent(buf1)).not.toBe(await hashContent(buf2));
    });

    it("should handle empty content", async () => {
        const buf = new TextEncoder().encode("").buffer as ArrayBuffer;
        const hash = await hashContent(buf);
        expect(hash).toBe("d41d8cd98f00b204e9800998ecf8427e");
    });
});
