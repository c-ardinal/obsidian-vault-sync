/**
 * @file Engine Loader テスト
 *
 * @description
 * 同梱された E2EE エンジン（e2ee-engine サブモジュール）の生成と検証をテストする。
 *
 * @pass_criteria
 * - 同梱エンジンが必須メソッドをすべて実装している
 * - 同梱エンジンで Vault 初期化・ロック解除・暗号化・復号が往復できる
 * - 必須メソッド不足時 null 返却
 * - 生成時の例外で null 返却（起動を止めない）
 * - エンジン生成だけでは暗号化が有効にならない（ロック状態のまま）
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import {
    createCryptoEngine,
    findMissingEngineMethods,
    REQUIRED_ENGINE_METHODS,
} from "../../../src/encryption/engine-loader";

describe("createCryptoEngine (bundled engine)", () => {
    beforeAll(() => {
        // The engine uses window.crypto (WebCrypto); Node exposes the same API on globalThis.
        vi.stubGlobal("window", globalThis);
    });
    afterAll(() => {
        vi.unstubAllGlobals();
    });

    it("bundled engine implements every required method", () => {
        const engine = createCryptoEngine();
        expect(engine).not.toBeNull();
        expect(findMissingEngineMethods(engine)).toEqual([]);
    });

    it("creating the engine does not unlock or enable encryption", () => {
        const engine = createCryptoEngine();
        expect(engine!.isUnlocked()).toBe(false);
    });

    it("round-trips: initialize, unlock on a second instance, encrypt, decrypt", async () => {
        const deviceA = createCryptoEngine()!;
        const lockBlob = await deviceA.initializeNewVault("correct horse battery staple");

        const deviceB = createCryptoEngine()!;
        await deviceB.unlockVault(lockBlob, "correct horse battery staple");
        expect(deviceB.isUnlocked()).toBe(true);

        const plain = new TextEncoder().encode("# note\nhello").buffer;
        const { ciphertext, iv } = await deviceA.encrypt(plain);
        const decrypted = await deviceB.decrypt(ciphertext, iv);
        expect(new TextDecoder().decode(decrypted)).toBe("# note\nhello");
    });

    it("rejects a wrong password", async () => {
        const deviceA = createCryptoEngine()!;
        const lockBlob = await deviceA.initializeNewVault("right password 123");
        const deviceB = createCryptoEngine()!;
        await expect(deviceB.unlockVault(lockBlob, "wrong password 123")).rejects.toThrow();
        expect(deviceB.isUnlocked()).toBe(false);
    });

    it("returns null when the engine lacks required methods", () => {
        const spy = vi.spyOn(console, "error").mockImplementation(() => {});
        const partial: Record<string, () => void> = {};
        for (const m of REQUIRED_ENGINE_METHODS.slice(1)) partial[m] = () => {};
        expect(createCryptoEngine(() => partial)).toBeNull();
        expect(spy.mock.calls[0][0]).toContain(REQUIRED_ENGINE_METHODS[0]);
        spy.mockRestore();
    });

    it("returns null instead of throwing when the engine fails to construct", () => {
        const spy = vi.spyOn(console, "error").mockImplementation(() => {});
        expect(
            createCryptoEngine(() => {
                throw new Error("boom");
            }),
        ).toBeNull();
        spy.mockRestore();
    });

    it("findMissingEngineMethods handles null and non-function members", () => {
        expect(findMissingEngineMethods(null)).toEqual([...REQUIRED_ENGINE_METHODS]);
        expect(findMissingEngineMethods({ encrypt: "nope" })).toContain("encrypt");
    });
});
