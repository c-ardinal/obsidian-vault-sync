import { normalizePath } from "./path";

/**
 * The vault's config folder (Vault#configDir), vault-relative without a trailing
 * slash. It is not always ".obsidian": the user can choose another name, and it
 * can differ per device. main.ts sets it on load before anything reads it; tests
 * set it in their setup file.
 */
let current = "";

export function setConfigDir(dir: string): void {
    current = normalizePath(dir);
}

export function configDir(): string {
    return current;
}

/** A path inside the config folder: configPath("app.json") */
export function configPath(rel: string): string {
    return `${current}/${rel}`;
}

/**
 * Whether a vault-relative path is the config folder or lies inside it.
 * With ignoreCase the path is compared lower-cased (for callers that lower-case
 * paths before matching).
 */
export function inConfigDir(path: string, ignoreCase = false): boolean {
    const dir = ignoreCase ? current.toLowerCase() : current;
    if (!dir) return false;
    const p = ignoreCase ? path.toLowerCase() : path;
    return p === dir || p.startsWith(dir + "/");
}
