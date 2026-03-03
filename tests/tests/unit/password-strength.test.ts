/**
 * @file パスワード強度チェックのユニットテスト
 *
 * @description
 * checkPasswordStrengthのスコアリング (長さ・一般性・繰り返し・連続文字・多様性) とフィードバックメッセージを検証する。
 *
 * @pass_criteria
 * - 8文字未満→weak、一般的パスワード→weak
 * - 繰り返し・連続文字→ペナルティとフィードバック
 * - 長く多様なパスワード→strong (score=4)
 */

import { describe, it, expect } from "vitest";
import { checkPasswordStrength } from "../../../src/encryption/password-strength";

describe("checkPasswordStrength", () => {
    it("should reject passwords shorter than 8 characters (line 26 branch)", () => {
        const result = checkPasswordStrength("short");
        expect(result.score).toBe(0);
        expect(result.strength).toBe("weak");
        expect(result.feedback).toContain("passwordTooShort");
    });

    it("should cover line 29 (length >= 8 branch)", () => {
        // This test specifically ensures line 29 (if (password.length >= 8)) is covered
        // with the true branch - previous test covers the false branch (early return)
        const result = checkPasswordStrength("exactly8");
        // Should NOT have passwordTooShort feedback since length >= 8
        expect(result.feedback).not.toContain("passwordTooShort");
        expect(result.score).toBeGreaterThanOrEqual(0);
    });

    it("should cover exactly 8 character boundary (lines 29-31)", () => {
        // Test the boundary where length is exactly 8
        const result8 = checkPasswordStrength("aBcDe1Fg");
        // Just verify it was processed (line 29 is about checking length >= 8)
        expect(result8.feedback).not.toContain("passwordTooShort");

        // Test length 12 for next score increment (line 30)
        const result12 = checkPasswordStrength("aBcDeFgHiJ1K");
        expect(result12.score).toBeGreaterThanOrEqual(result8.score);

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
        const result = checkPasswordStrength("aaaaaaBB1!");
        expect(result.feedback).toContain("passwordHasRepeats");
    });

    it("should penalize sequential characters", () => {
        const result = checkPasswordStrength("abcdefgh1!");
        expect(result.feedback).toContain("passwordHasSequences");
    });

    it("should rate short passwords with variety as fair at best", () => {
        const result = checkPasswordStrength("Xk!9mP7z");
        expect(["weak", "fair"]).toContain(result.strength);
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

    it("should add 'passwordCouldBeStronger' feedback for weak passwords with no other issues", () => {
        // Password with length >= 8, 2 char types, no repeats/sequences, not common
        // Results in score = 1 with empty feedback, triggering line 70
        const result = checkPasswordStrength("a1b2c3d4");
        expect(result.score).toBe(1);
        expect(result.strength).toBe("weak");
        expect(result.feedback).toContain("passwordCouldBeStronger");
    });
});
