/**
 * Simple glob/wildcard pattern matcher.
 * Supports:
 *   - `*`  : Match any characters except `/` (single segment)
 *   - `**` : Match any characters including `/` (recursive directories)
 *   - `?`  : Match single character
 *
 * Examples:
 *   matchWildcard("*.md", "test.md")          => true
 *   matchWildcard("*.md", "folder/test.md")   => false
 *   matchWildcard("starstar/star.md", "a/b/c.md") => true (use ** / * in actual code)
 *   matchWildcard("temp/**", "temp/sub/file") => true
 */
export function matchWildcard(pattern: string, text: string): boolean {
    // Escape regex special characters except our wildcards
    let regex = pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&") // Escape regex specials
        .replace(/\*\*/g, "<<GLOBSTAR>>") // Placeholder for **
        .replace(/\*/g, "[^/]*") // * = any except /
        .replace(/<<GLOBSTAR>>/g, ".*") // ** = any including /
        .replace(/\?/g, "."); // ? = single char

    try {
        // Exact match
        if (new RegExp(`^${regex}$`).test(text)) {
            return true;
        }

        // Also treat pattern as folder prefix (pattern + "/" matches start of path)
        // Only do this if the pattern doesn't already end with a wildcard
        if (!pattern.endsWith("*") && !pattern.endsWith("?")) {
            const prefixRegex = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
            if (new RegExp(`^${prefixRegex}/`).test(text)) {
                return true;
            }
        }

        return false;
    } catch {
        return false; // Invalid pattern
    }
}
