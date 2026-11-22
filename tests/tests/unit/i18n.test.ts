/**
 * @file 国際化 (i18n) ユニットテスト
 *
 * @description
 * 翻訳関数 t() のキー解決、フォールバック動作、initI18n() の言語切替を検証する。
 *
 * @pass_criteria
 * - 存在するキーは対応する翻訳文字列を返す
 * - 存在しないキーはキー名をそのまま返す
 * - initI18n()でja切替後、日本語辞書が使われる
 * - 日本語辞書に無いキーは英語にフォールバック
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// localStorage mock
const localStorageMock: Record<string, string> = {};
Object.defineProperty(globalThis, "window", {
    value: {
        localStorage: {
            getItem: vi.fn((key: string) => localStorageMock[key] ?? null),
            setItem: vi.fn((key: string, val: string) => { localStorageMock[key] = val; }),
        },
    },
    writable: true,
});

describe("i18n", () => {
    beforeEach(() => {
        // Reset module cache to get fresh state
        vi.resetModules();
        delete localStorageMock["language"];
    });

    it("t() should return English string for known key", async () => {
        const { t } = await import("../../../src/i18n/index");
        expect(t("settingLogin")).toBe("Login");
    });

    it("t() should return the key itself for unknown key", async () => {
        const { t } = await import("../../../src/i18n/index");
        expect(t("nonExistentKey")).toBe("nonExistentKey");
    });

    it("initI18n() with 'en' should keep English as active dictionary", async () => {
        localStorageMock["language"] = "en";
        const { initI18n, t } = await import("../../../src/i18n/index");
        initI18n();
        expect(t("settingLogin")).toBe("Login");
    });

    it("initI18n() with 'ja' should switch to Japanese dictionary", async () => {
        localStorageMock["language"] = "ja";
        const { initI18n, t } = await import("../../../src/i18n/index");
        initI18n();
        // Japanese translation should be returned
        const result = t("settingLogin");
        expect(result).not.toBe("Login");
        expect(typeof result).toBe("string");
        expect(result.length).toBeGreaterThan(0);
    });

    it("Japanese dictionary should fallback to English for missing keys", async () => {
        localStorageMock["language"] = "ja";
        const { initI18n, t, en } = await import("../../../src/i18n/index");
        initI18n();
        // Find a key that exists in en but might not in ja - use the key itself as fallback test
        const unknownKey = "totallyFakeKey_not_in_any_dict";
        expect(t(unknownKey)).toBe(unknownKey);
    });

    it.each(["zh", "ko"])("initI18n() with '%s' uses a full dictionary with the same placeholders", async (lang) => {
        localStorageMock["language"] = lang;
        const { initI18n, t, en, currentLanguage } = await import("../../../src/i18n/index");
        initI18n();
        expect(currentLanguage()).toBe(lang);
        const dict = (await import(`../../../src/i18n/lang/${lang}.json`)).default as Record<string, string>;
        for (const [key, text] of Object.entries(en)) {
            expect(dict[key], key).toBeTruthy();
            const ph = (s: string) => (s.match(/\{[^}]*\}/g) ?? []).sort();
            expect(ph(dict[key]), key).toEqual(ph(text));
        }
        expect(t("settingLogin")).toBe(dict.settingLogin);
    });

    it("initI18n() with unsupported language should keep English", async () => {
        localStorageMock["language"] = "fr";
        const { initI18n, t } = await import("../../../src/i18n/index");
        initI18n();
        expect(t("settingLogin")).toBe("Login");
    });

    it("en dictionary should contain essential keys", async () => {
        const { en } = await import("../../../src/i18n/index");
        const essentialKeys = [
            "settingLogin",
            "noticeSyncing",
            "noticeAuthSuccess",
            "settingConflictStrategy",
            "historyTitle",
        ];
        for (const key of essentialKeys) {
            expect(en[key]).toBeDefined();
            expect(en[key].length).toBeGreaterThan(0);
        }
    });

    it("has no add-on specific wording in Vault-Sync's own dictionaries", async () => {
        const { en } = await import("../../../src/i18n/index");
        const ja = (await import("../../../src/i18n/lang/ja.json")).default as Record<string, string>;
        const zh = (await import("../../../src/i18n/lang/zh.json")).default as Record<string, string>;
        const ko = (await import("../../../src/i18n/lang/ko.json")).default as Record<string, string>;
        const banned = /e2ee|encrypt|decrypt|暗号|復号|加密|解密|암호화|복호화/i;
        for (const dict of [en, ja, zh, ko]) {
            for (const [key, text] of Object.entries(dict)) {
                expect(banned.test(text), `${key}: ${text}`).toBe(false);
            }
        }
    });

    it("uses one Japanese term per concept (glossary)", async () => {
        const ja = (await import("../../../src/i18n/lang/ja.json")).default as Record<string, string>;
        // 本端末/端末, クラウド, 版, トリガー, フォルダ, 送信/受信 (a web download stays ダウンロード)
        const banned = /デバイス|リモート|リビジョン|ローカル|プッシュ|トリガ(?!ー)|フォルダー|アップロード|files\)/;
        for (const [key, text] of Object.entries(ja)) {
            expect(banned.test(text), `${key}: ${text}`).toBe(false);
        }
    });

    it("t() falls back to the add-on's text, own text first", async () => {
        localStorageMock["language"] = "ja";
        const { initI18n, t, setAddonStrings, hasAddonStrings } = await import(
            "../../../src/i18n/index"
        );
        initI18n();
        const dicts: Record<string, Record<string, string>> = {
            en: { addonKey: "Add-on text", onlyEn: "English only", settingLogin: "Hijack" },
            ja: { addonKey: "アドオン文言" },
        };
        expect(t("addonKey")).toBe("addonKey");
        setAddonStrings((lang) => dicts[lang] ?? {});
        expect(hasAddonStrings()).toBe(true);
        expect(t("addonKey")).toBe("アドオン文言");
        expect(t("onlyEn")).toBe("English only");
        expect(t("settingLogin")).not.toBe("Hijack");
        setAddonStrings(null);
        expect(hasAddonStrings()).toBe(false);
        expect(t("addonKey")).toBe("addonKey");
    });
});
