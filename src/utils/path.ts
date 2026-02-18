/**
 * Cross-platform path normalization utility.
 * Guarantees consistent POSIX-style paths (forward slashes) on all operating systems.
 */
export function normalizePath(path: string): string {
    if (!path) return "";

    // 1. Replace all backslashes with forward slashes (Handle Windows paths)
    let res = path.replace(/\\/g, "/");

    // 2. Remove duplicate slashes (e.g., // -> /)
    res = res.replace(/\/+/g, "/");

    // 3. Remove leading slash.
    // In Obsidian context, paths are relative to the vault root, so no leading slash is expected.
    // Example: /folder/note.md -> folder/note.md
    if (res.startsWith("/")) {
        res = res.slice(1);
    }

    // 4. Remove trailing slash, unless the path is just "/" (which became empty string in step 3)
    if (res.endsWith("/") && res.length > 0) {
        res = res.slice(0, -1);
    }

    return res;
}

export function basename(path: string): string {
    const idx = path.lastIndexOf("/");
    return idx >= 0 ? path.substring(idx + 1) : path;
}

export function dirname(path: string): string {
    const idx = path.lastIndexOf("/");
    return idx >= 0 ? path.substring(0, idx) : "";
}
