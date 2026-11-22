/**
 * @file パスワード強度チェックのユニットテスト
 *
 * @description
 * checkPasswordStrengthのスコアリング (長さ・一般性・繰り返し・連続文字・多様性) とフィードバックメッセージを検証する。
 *
 * @pass_criteria
 * - 12文字未満→weak、一般的パスワード→weak
 * - 繰り返し・連続文字→ペナルティとフィードバック
 * - 長く多様なパスワード→strong (score=4)
 */

import { describe, it, expect } from "vitest";
import { checkPasswordStrength, MIN_PASSWORD_LENGTH } from "../../../src/encryption/password-strength";

describe("checkPasswordStrength", () => {
    it("should reject passwords shorter than 12 characters", () => {
        expect(MIN_PASSWORD_LENGTH).toBe(12);
        const eleven = checkPasswordStrength("Xk!9mP7zQ2w");
        expect(eleven.strength).toBe("weak");
        expect(eleven.feedback).toContain("passwordTooShort");
        const result = checkPasswordStrength("short");
        expect(result.score).toBe(0);
        expect(result.strength).toBe("weak");
        expect(result.feedback).toContain("passwordTooShort");
    });

    it("accepts the length at exactly 12 characters", () => {
        const result = checkPasswordStrength("exactly12chr");
        // Should NOT have passwordTooShort feedback since length >= 12
        expect(result.feedback).not.toContain("passwordTooShort");
        expect(result.score).toBeGreaterThanOrEqual(0);
    });

    it("scores longer passwords at least as high", () => {
        const result12 = checkPasswordStrength("aBcDeFgHiJ1K");
        expect(result12.feedback).not.toContain("passwordTooShort");

        // Test length 16 for final score increment (line 31)
        const result16 = checkPasswordStrength("aBcDeFgHiJkLmN1P");
        expect(result16.score).toBeGreaterThanOrEqual(result12.score);
    });

    it("should reject common passwords", () => {
        const result = checkPasswordStrength("password1");
        expect(result.score).toBe(0);
        expect(result.strength).toBe("weak");
        expect(result.feedback).toContain("passwordTooCommon");
    });

    it("should penalize repeated characters", () => {
        const result = checkPasswordStrength("aaaaaaBB1!xY");
        expect(result.feedback).toContain("passwordHasRepeats");
    });

    it("should penalize sequential characters", () => {
        const result = checkPasswordStrength("abcdefgh1!XY");
        expect(result.feedback).toContain("passwordHasSequences");
    });

    it("should rate short passwords with variety as weak", () => {
        const result = checkPasswordStrength("Xk!9mP7z");
        expect(result.strength).toBe("weak");
    });

    it("should rate medium passwords with variety as good", () => {
        const result = checkPasswordStrength("MyP@ssw0rd!x");
        expect(result.strength).toBe("good");
    });

    it("should rate long diverse passwords as strong", () => {
        const result = checkPasswordStrength("Tr0ub4dor&Hors3!xQ");
        expect(result.score).toBe(4);
        expect(result.strength).toBe("strong");
    });

    it("should penalize low character diversity", () => {
        const result = checkPasswordStrength("abcdefghijklmnop");
        expect(result.feedback).toContain("passwordNeedsVariety");
    });

    it("should return feedback for borderline passwords", () => {
        const result = checkPasswordStrength("simpleee");
        expect(result.feedback.length).toBeGreaterThan(0);
    });

    it("should add 'passwordCouldBeStronger' feedback for fair passwords with no other issues", () => {
        // 12 characters, 2 char types, no repeats/sequences, not common: score 2
        const result = checkPasswordStrength("a1b2c3d4e5f6");
        expect(result.score).toBe(2);
        expect(result.strength).toBe("fair");
        expect(result.feedback).toContain("passwordCouldBeStronger");
    });
});
