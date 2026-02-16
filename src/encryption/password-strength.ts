export type PasswordStrength = "weak" | "fair" | "good" | "strong";

export interface PasswordStrengthResult {
    score: number; // 0-4
    strength: PasswordStrength;
    feedback: string[];
}

const COMMON_PASSWORDS = new Set([
    "password", "12345678", "123456789", "1234567890", "qwerty123",
    "abc12345", "password1", "iloveyou", "sunshine", "princess",
    "admin123", "welcome1", "monkey123", "dragon12", "master12",
    "letmein1", "trustno1", "baseball", "football", "shadow12",
]);

/**
 * Lightweight password strength checker (no external dependencies).
 * Returns a score from 0 (weak) to 4 (strong) with feedback messages.
 */
export function checkPasswordStrength(password: string): PasswordStrengthResult {
    const feedback: string[] = [];
    let score = 0;

    // Length scoring
    if (password.length < 8) {
        feedback.push("passwordTooShort");
        return { score: 0, strength: "weak", feedback };
    }
    if (password.length >= 8) score++;
    if (password.length >= 12) score++;
    if (password.length >= 16) score++;

    // Character diversity
    const hasLower = /[a-z]/.test(password);
    const hasUpper = /[A-Z]/.test(password);
    const hasDigit = /[0-9]/.test(password);
    const hasSymbol = /[^a-zA-Z0-9]/.test(password);
    const charTypes = [hasLower, hasUpper, hasDigit, hasSymbol].filter(Boolean).length;

    if (charTypes >= 3) score++;
    if (charTypes < 2) {
        feedback.push("passwordNeedsVariety");
        score = Math.max(score - 1, 0);
    }

    // Repetition penalty
    if (/(.)\1{3,}/.test(password)) {
        feedback.push("passwordHasRepeats");
        score = Math.max(score - 1, 0);
    }

    // Sequential chars penalty
    if (/(?:abc|bcd|cde|def|efg|fgh|ghi|hij|ijk|jkl|klm|lmn|mno|nop|opq|pqr|qrs|rst|stu|tuv|uvw|vwx|wxy|xyz|012|123|234|345|456|567|678|789)/i.test(password)) {
        feedback.push("passwordHasSequences");
        score = Math.max(score - 1, 0);
    }

    // Common password check
    if (COMMON_PASSWORDS.has(password.toLowerCase())) {
        feedback.push("passwordTooCommon");
        return { score: 0, strength: "weak", feedback };
    }

    // Clamp score
    score = Math.min(Math.max(score, 0), 4);

    const strengthMap: PasswordStrength[] = ["weak", "weak", "fair", "good", "strong"];

    if (feedback.length === 0 && score <= 1) {
        feedback.push("passwordCouldBeStronger");
    }

    return { score, strength: strengthMap[score], feedback };
}
