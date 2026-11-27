/**
 * @file 設定スキーマ ユニットテスト
 *
 * @description
 * クラウド側ルートフォルダ名の検証規則を検証する。
 */
import { describe, it, expect } from "vitest";
import { isValidCloudRootFolder } from "../../../src/utils/cloud-root";

describe("isValidCloudRootFolder", () => {
    it("accepts plain folder names", () => {
        expect(isValidCloudRootFolder("ObsidianVaultSyncer")).toBe(true);
        expect(isValidCloudRootFolder("My Vault 2")).toBe(true);
    });

    it("rejects empty, absolute, backslash and reserved characters", () => {
        for (const bad of ["", "/abs", "a\\b", "a<b", "a:b", 'a"b', "a|b", "a?b", "a*b", "x".repeat(256)]) {
            expect(isValidCloudRootFolder(bad), bad).toBe(false);
        }
    });
});
