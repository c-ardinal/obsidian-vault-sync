/**
 * @file フォーマットユーティリティのユニットテスト
 *
 * @description
 * formatSize (B/KB/MB表示) と toHex (Uint8Array→16進文字列) の変換精度を検証する。
 *
 * @pass_criteria
 * - サイズ表示: 0B, KB, MB境界で正しい単位と小数点
 * - toHex: 0パディング、空配列、マルチバイト変換の正確性
 */

import { describe, it, expect } from "vitest";
import { formatSize, toHex } from "../../../src/utils/format";

describe("formatSize", () => {
    it("should format bytes (< 1024)", () => {
        expect(formatSize(0)).toBe("0 B");
        expect(formatSize(1)).toBe("1 B");
        expect(formatSize(512)).toBe("512 B");
        expect(formatSize(1023)).toBe("1023 B");
    });

    it("should format kilobytes (1024 - 1MB)", () => {
        expect(formatSize(1024)).toBe("1.0 KB");
        expect(formatSize(1536)).toBe("1.5 KB");
        expect(formatSize(10240)).toBe("10.0 KB");
        expect(formatSize(1024 * 1024 - 1)).toBe("1024.0 KB");
    });

    it("should format megabytes (>= 1MB)", () => {
        expect(formatSize(1024 * 1024)).toBe("1.0 MB");
        expect(formatSize(1024 * 1024 * 5)).toBe("5.0 MB");
        expect(formatSize(1024 * 1024 * 1.5)).toBe("1.5 MB");
        expect(formatSize(1024 * 1024 * 100)).toBe("100.0 MB");
    });
});

describe("toHex", () => {
    it("should convert empty array", () => {
        expect(toHex(new Uint8Array([]))).toBe("");
    });

    it("should convert single byte", () => {
        expect(toHex(new Uint8Array([0]))).toBe("00");
        expect(toHex(new Uint8Array([255]))).toBe("ff");
        expect(toHex(new Uint8Array([16]))).toBe("10");
    });

    it("should convert multiple bytes", () => {
        expect(toHex(new Uint8Array([0xde, 0xad, 0xbe, 0xef]))).toBe("deadbeef");
    });

    it("should zero-pad single digit hex values", () => {
        expect(toHex(new Uint8Array([1, 2, 3]))).toBe("010203");
    });

    it("should handle all zeros", () => {
        expect(toHex(new Uint8Array([0, 0, 0, 0]))).toBe("00000000");
    });
});
