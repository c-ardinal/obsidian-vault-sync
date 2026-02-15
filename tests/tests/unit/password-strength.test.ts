import { describe, it, expect } from "vitest";
import { checkPasswordStrength } from "../../../src/encryption/password-strength";

describe("checkPasswordStrength", () => {
    it("should reject passwords shorter than 8 characters", () => {
        const result = checkPasswordStrength("short");
        expect(result.score).toBe(0);
        expect(result.strength).toBe("weak");
        expect(result.feedback).toContain("passwordTooShort");
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
});
