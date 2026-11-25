import { Platform } from "obsidian";
import type { ObsidianScope, ObsidianScopeKey } from "../types/settings";
import { normalizePath, basename, dirname } from "../utils/path";
import { configDir, inConfigDir, setConfigDir } from "../utils/config-dir";
import { matchWildcard } from "../utils/wildcard";
import { contentFingerprint } from "./content-fingerprint";
import { REMOTE_DEVICE_DIR, REMOTE_FILES } from "./remote-layout";
import type { SyncContext } from "./context";
import { CtxState } from "./context-state";

/** What this module reads from the sync context */
export type FileUtilsCtx = Pick<
    SyncContext,
    | "log"
    | "settings"
    | "vault"
>;

// === System-level Constants ===

/** Plugin ID before the community-directory release (IDs may not contain "obsidian"). */
export const LEGACY_PLUGIN_ID = "obsidian-vault-sync";

/**
 * This plugin's folder, vault-relative with a trailing slash. main.ts sets it from
 * the manifest (the plugin ID and the vault's config folder) before anything syncs;
 * tests set it in their setup file.
 */
export let PLUGIN_DIR = "";

/**
 * The folder of the plugin under its old ID when it differs from PLUGIN_DIR, else null.
 * Devices not yet updated still write their sync data there (and may have the old
 * copy of the plugin installed), so the sync loop leaves everything in it alone.
 */
export let LEGACY_PLUGIN_DIR: string | null = null;

export function setPluginDir(pluginDir: string, vaultConfigDir: string): void {
    setConfigDir(vaultConfigDir);
    PLUGIN_DIR = normalizePath(pluginDir) + "/";
    const legacy = normalizePath(`${vaultConfigDir}/plugins/${LEGACY_PLUGIN_ID}`) + "/";
    LEGACY_PLUGIN_DIR = legacy === PLUGIN_DIR ? null : legacy;
}

export const INTERNAL_LOCAL_ONLY = ["cache/", "data/local/"];

/** Files managed by custom logic (e.g. saveIndex), skipped by generic sync loop */
export const INTERNAL_REMOTE_MANAGED: string[] = [
    REMOTE_FILES.index,
    REMOTE_FILES.rawIndex,
    REMOTE_FILES.communication,
    REMOTE_FILES.vaultLock,
    "migration.lock",
];

/** General system-level files that should be ignored and cleaned up from remote if found */
export const SYSTEM_IGNORES = [
    "_VaultSync_Debug.log",
    "_VaultSync_Orphans/",
    ".DS_Store",
    "Thumbs.db",
];

/** Obsidian internal transient files (Ignored and cleaned up from remote if not synced) */
export const OBSIDIAN_SYSTEM_IGNORES = ["cache/", "indexedDB/", "backups/", ".trash/"];

export const OBSIDIAN_WORKSPACE_FILES = ["workspace.json", "workspace-mobile.json"];

/** Obsidian's own settings files at the top of the config folder (the "core config" category) */
export const OBSIDIAN_CORE_CONFIG_FILES = [
    "app.json",
    "appearance.json",
    "hotkeys.json",
    "core-plugins.json",
    "community-plugins.json",
    "graph.json",
];

// === File Operations ===

/**
 * Folders the sync created or removed here itself (to place a pulled note, or after
 * the last note left a folder by a pull). The vault reports them as user changes;
 * taken as such, the push made the folder in the cloud again (an old folder name
 * came back after a rename on another device) or removed it there.
 */
const ownFolderEvents = new CtxState<Map<string, number>>(
    "ownFolderEvents",
    "Folders the sync created or removed itself, so their vault events are ignored",
);

function noteOwnFolderEvent(ctx: object, kind: "create" | "delete", path: string): void {
    let m = ownFolderEvents.get(ctx);
    if (!m) ownFolderEvents.set(ctx, (m = new Map<string, number>()));
    const key = `${kind}\u0000${path}`;
    m.set(key, (m.get(key) ?? 0) + 1);
}

/** True (once) when the vault event for this folder is the echo of the sync's own change */
export function takeOwnFolderEvent(ctx: object, kind: "create" | "delete", path: string): boolean {
    const m = ownFolderEvents.get(ctx);
    const key = `${kind}\u0000${path}`;
    const n = m?.get(key);
    if (!n) return false;
    if (n > 1) m!.set(key, n - 1);
    else m!.delete(key);
    return true;
}

/**
 * Folders a pull took notes out of (deleted or moved on another device). On Drive a
 * folder renamed or deleted elsewhere arrives as changes to its notes only, so the
 * folder itself stayed here, empty.
 */
const vacatedFolders = new CtxState<Set<string>>(
    "vacatedFolders",
    "Folders a pull took notes out of, removed when left empty",
);

export function noteVacatedFolder(ctx: object, filePath: string): void {
    const dir = dirname(normalizePath(filePath));
    if (!dir) return;
    let s = vacatedFolders.get(ctx);
    if (!s) vacatedFolders.set(ctx, (s = new Set<string>()));
    s.add(dir);
}

/** Remove the folders a pull left empty (and parents it left empty that way) */
export async function removeVacatedFolders(ctx: FileUtilsCtx): Promise<void> {
    const pending = vacatedFolders.get(ctx);
    if (!pending || pending.size === 0) return;
    vacatedFolders.set(ctx, new Set<string>());
    const queue = [...pending].sort((a, b) => b.length - a.length);
    const seen = new Set<string>();
    while (queue.length > 0) {
        const folder = queue.shift()!;
        if (!folder || seen.has(folder)) continue;
        seen.add(folder);
        if (shouldIgnore(ctx, folder)) continue;
        try {
            if (!(await ctx.vault.exists(folder))) continue;
            const { files, folders } = await ctx.vault.list(folder);
            if (files.length > 0 || folders.length > 0) continue;
            noteOwnFolderEvent(ctx, "delete", folder);
            try {
                await ctx.vault.rmdir(folder, false);
            } catch (e) {
                takeOwnFolderEvent(ctx, "delete", folder);
                throw e;
            }
            await ctx.log(`[Smart Pull] Removed empty folder: ${folder}`, "debug");
            const parent = dirname(folder);
            if (parent) {
                queue.push(parent);
                queue.sort((a, b) => b.length - a.length);
            }
        } catch (e) {
            await ctx.log(`[Smart Pull] Could not remove empty folder ${folder}: ${String(e)}`, "debug");
        }
    }
}

export async function ensureLocalFolder(ctx: FileUtilsCtx, filePath: string) {
    filePath = normalizePath(filePath);
    const parts = filePath.split("/");
    if (parts.length <= 1) return;

    const folderPath = parts.slice(0, -1).join("/");
    if (await ctx.vault.exists(folderPath)) return;

    let currentPath = "";
    for (const part of parts.slice(0, -1)) {
        currentPath += (currentPath ? "/" : "") + part;
        if (!(await ctx.vault.exists(currentPath))) {
            noteOwnFolderEvent(ctx, "create", currentPath);
            try {
                await ctx.vault.createFolder(currentPath);
            } catch (e) {
                takeOwnFolderEvent(ctx, "create", currentPath);
                console.debug("Vault-Sync: Race condition in mkdir ignored", e);
            }
        }
    }
}

export async function listFilesRecursive(ctx: FileUtilsCtx, path: string): Promise<string[]> {
    const result: string[] = [];
    const listed = await ctx.vault.list(path);

    for (const file of listed.files) {
        result.push(file);
    }

    for (const folder of listed.folders) {
        const subFiles = await listFilesRecursive(ctx, folder);
        result.push(...subFiles);
    }

    return result;
}

export async function getLocalFiles(ctx: FileUtilsCtx) {
    const standardFiles = ctx.vault.getFiles().map((f) => ({
        path: f.path,
        mtime: f.stat.mtime,
        size: f.stat.size,
        name: f.name,
    }));

    const obsidianFiles: { path: string; mtime: number; size: number; name: string }[] = [];
    try {
        const files = await listFilesRecursive(ctx, configDir());
        for (const path of files) {
            const stat = await ctx.vault.stat(path);
            if (stat) {
                obsidianFiles.push({
                    path,
                    mtime: stat.mtime,
                    size: stat.size,
                    name: basename(path),
                });
            }
        }
    } catch (e) {
        await ctx.log(`  Failed to list ${configDir()}: ${String(e)}`, "warn");
    }

    return [...standardFiles, ...obsidianFiles];
}

// === Compression Helpers ===

export async function compress(data: ArrayBuffer): Promise<ArrayBuffer> {
    try {
        const stream = new Blob([data]).stream().pipeThrough(new CompressionStream("gzip"));
        return await new Response(stream).arrayBuffer();
    } catch (e) {
        console.error("Compression failed:", e);
        return data;
    }
}

export async function tryDecompress(data: ArrayBuffer): Promise<ArrayBuffer> {
    try {
        const view = new Uint8Array(data);
        if (view.length > 2 && view[0] === 0x1f && view[1] === 0x8b) {
            const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("gzip"));
            return await new Response(stream).arrayBuffer();
        }
    } catch (e) {
        if (e instanceof Error) {
            const view = new Uint8Array(data);
            if (view.length > 2 && view[0] === 0x1f && view[1] === 0x8b) {
                throw new Error(`Gzip decompression failed: ${e.message}`);
            }
        }
    }
    return data;
}

// === Path Filtering ===

export async function runParallel<T>(
    tasks: (() => Promise<T>)[],
    concurrency: number,
): Promise<T[]> {
    const results: T[] = [];
    const queue = [...tasks];

    const workerCount = Math.max(0, Math.min(concurrency, queue.length));
    if (workerCount === 0) return [];

    const workers = Array(workerCount)
        .fill(null)
        .map(async () => {
            while (queue.length > 0) {
                const task = queue.shift();
                if (task) {
                    results.push(await task());
                }
            }
        });
    await Promise.all(workers);
    return results;
}

/**
 * リモートでも管理するデータだが、汎用同期ループ（Push/Pull）ではなく、
 * saveIndex などの専用ロジックで直接制御されるファイル。
 */
export function isManagedSeparately(path: string): boolean {
    if (INTERNAL_REMOTE_MANAGED.includes(path)) return true;
    if (LEGACY_PLUGIN_DIR && path.startsWith(LEGACY_PLUGIN_DIR)) return true;
    if (!path.startsWith(PLUGIN_DIR)) return false;
    const subPath = path.substring(PLUGIN_DIR.length);
    return INTERNAL_REMOTE_MANAGED.includes(subPath) || subPath.startsWith(REMOTE_DEVICE_DIR + "/");
}

/**
 * System-level check: files that must NEVER exist on remote regardless of user settings.
 * Used by the pull phase to avoid deleting files that another device legitimately synced
 * when the current device has stale settings (e.g., syncWorkspace=false while remote has true).
 *
 * Does NOT check settings-dependent exclusions (syncWorkspace, syncAppearance, etc.).
 * Those are enforced only during push, where the current device's settings are always up-to-date.
 */
export function isAlwaysForbiddenOnRemote(path: string): boolean {
    const normalizedPath = normalizePath(path).toLowerCase();
    const normalizedWithSlash = normalizedPath.endsWith("/")
        ? normalizedPath
        : normalizedPath + "/";

    // 1. Plugin internal local-only files (cache/, data/local/)
    if (normalizedPath.startsWith(PLUGIN_DIR.toLowerCase())) {
        const subPath = normalizedPath.substring(PLUGIN_DIR.length);
        const normalizedSubPath = subPath.endsWith("/") ? subPath : subPath + "/";

        if (
            INTERNAL_LOCAL_ONLY.some((p) => {
                const np = p.toLowerCase();
                return normalizedSubPath.startsWith(np.endsWith("/") ? np : np + "/");
            })
        ) {
            return true;
        }
    }

    // 2. System-level ignore files (.DS_Store, Thumbs.db, debug logs, orphans)
    if (
        SYSTEM_IGNORES.some((p) => {
            const np = p.toLowerCase();
            if (np.endsWith("/")) {
                return normalizedWithSlash.startsWith(np) || normalizedWithSlash.includes("/" + np);
            }
            return normalizedPath === np || normalizedPath.endsWith("/" + np);
        })
    ) {
        return true;
    }

    // 3. Obsidian system transient files (cache/, indexedDB/, backups/, .trash/)
    if (inConfigDir(normalizedPath, true)) {
        if (
            OBSIDIAN_SYSTEM_IGNORES.some((e) => {
                const ne = e.toLowerCase();
                if (ne.endsWith("/")) {
                    return (
                        normalizedWithSlash.includes("/" + ne) ||
                        normalizedWithSlash.endsWith("/" + ne)
                    );
                }
                return normalizedPath.endsWith("/" + ne);
            })
        ) {
            return true;
        }
    }

    // 4. Conflict resolution files
    if (/\(conflict \d{4}-\d{2}-\d{2}t\d{2}-\d{2}-\d{2}\)/.test(normalizedPath)) {
        return true;
    }

    return false;
}

/**
 * リモートに存在してはいけない（クリーンアップ対象）ファイルかどうかを判定。
 */
export function shouldNotBeOnRemote(ctx: FileUtilsCtx, path: string): boolean {
    const normalizedPath = normalizePath(path).toLowerCase();
    const normalizedWithSlash = normalizedPath.endsWith("/")
        ? normalizedPath
        : normalizedPath + "/";

    // 0. 自分のプラグインの内部ファイルの制御
    if (normalizedPath.startsWith(PLUGIN_DIR)) {
        const subPath = normalizedPath.substring(PLUGIN_DIR.length);
        const normalizedSubPath = subPath.endsWith("/") ? subPath : subPath + "/";

        if (normalizedSubPath.startsWith("logs/")) {
            if (!ctx.settings.syncDeviceLogs) {
                return true;
            }
        }

        if (normalizedSubPath.startsWith("data/flexible/")) {
            if (!ctx.settings.syncFlexibleData) {
                return true;
            }
        }
    }

    // 1. システム内部のローカル専用ファイル
    if (normalizedPath.startsWith(PLUGIN_DIR.toLowerCase())) {
        const subPath = normalizedPath.substring(PLUGIN_DIR.length);
        const normalizedSubPath = subPath.endsWith("/") ? subPath : subPath + "/";

        if (
            INTERNAL_LOCAL_ONLY.some((p) => {
                const np = p.toLowerCase();
                return normalizedSubPath.startsWith(np.endsWith("/") ? np : np + "/");
            })
        ) {
            return true;
        }
    }

    // 2. ユーザー設定による除外
    if (ctx.settings.exclusionPatterns) {
        const patterns = ctx.settings.exclusionPatterns
            .split("\n")
            .map((p) => p.trim())
            .filter((p) => p);
        for (const pattern of patterns) {
            if (
                matchWildcard(pattern.toLowerCase(), normalizedPath) ||
                matchWildcard(pattern.toLowerCase(), normalizedWithSlash)
            )
                return true;
        }
    }

    // 3. システムレベルの除外ファイル
    if (
        SYSTEM_IGNORES.some((p) => {
            const np = p.toLowerCase();
            if (np.endsWith("/")) {
                return normalizedWithSlash.startsWith(np) || normalizedWithSlash.includes("/" + np);
            }
            return normalizedPath === np || normalizedPath.endsWith("/" + np);
        })
    ) {
        return true;
    }

    // 4. Obsidian特定の除外
    if (inConfigDir(normalizedPath, true)) {
        const cfg = configDir().toLowerCase();
        if (
            OBSIDIAN_SYSTEM_IGNORES.some((e) => {
                const ne = e.toLowerCase();
                if (ne.endsWith("/")) {
                    return (
                        normalizedWithSlash.includes("/" + ne) ||
                        normalizedWithSlash.endsWith("/" + ne)
                    );
                }
                return normalizedPath.endsWith("/" + ne);
            })
        ) {
            return true;
        }

        if (!obsidianScopeOn(ctx.settings, "syncWorkspace")) {
            if (
                OBSIDIAN_WORKSPACE_FILES.some((f) => normalizedPath.endsWith("/" + f.toLowerCase()))
            ) {
                return true;
            }
        }

        if (!obsidianScopeOn(ctx.settings, "syncAppearance")) {
            if (
                normalizedPath.startsWith(`${cfg}/themes/`) ||
                normalizedPath.startsWith(`${cfg}/snippets/`)
            ) {
                return true;
            }
        }

        if (!obsidianScopeOn(ctx.settings, "syncCommunityPlugins")) {
            if (normalizedPath.startsWith(`${cfg}/plugins/`)) {
                return true;
            }
        }

        if (!obsidianScopeOn(ctx.settings, "syncCoreConfig")) {
            if (OBSIDIAN_CORE_CONFIG_FILES.some((f) => normalizedPath === `${cfg}/${f}`)) {
                return true;
            }
        }
    }

    // 5. 画像・メディアファイル
    if (!ctx.settings.syncImagesAndMedia) {
        const ext = normalizedPath.split(".").pop();
        const mediaExtensions = [
            "png",
            "jpg",
            "jpeg",
            "gif",
            "bmp",
            "svg",
            "webp",
            "mp3",
            "wav",
            "ogg",
            "m4a",
            "mp4",
            "mov",
            "webm",
            "pdf",
        ];
        if (ext && mediaExtensions.includes(ext)) {
            return true;
        }
    }

    // 5. 競合解決ファイル
    if (/\(conflict \d{4}-\d{2}-\d{2}t\d{2}-\d{2}-\d{2}\)/.test(normalizedPath)) {
        return true;
    }

    // 6. ドットファイル
    if (!ctx.settings.syncDotfiles) {
        if (
            normalizedPath.startsWith(".") &&
            !inConfigDir(normalizedPath, true)
        )
            return true;
    }

    return false;
}

export function shouldIgnore(ctx: FileUtilsCtx, path: string): boolean {
    return isManagedSeparately(path) || shouldNotBeOnRemote(ctx, path) || isDeviceExcluded(ctx, path);
}

function patternList(text: string | undefined): string[] {
    return (text ?? "")
        .split("\n")
        .map((p) => p.trim().toLowerCase())
        .filter((p) => p && !p.startsWith("#"));
}

/**
 * Whether a .obsidian category syncs on this device: the shared toggle, or with
 * "per PC / mobile" the toggle of this kind of device.
 */
export function obsidianScopeOn(
    settings: {
        obsidianScopeStrategy?: "unified" | "per-platform";
        desktopObsidianScope?: Partial<ObsidianScope>;
        mobileObsidianScope?: Partial<ObsidianScope>;
    } & Partial<ObsidianScope>,
    key: ObsidianScopeKey,
): boolean {
    if (settings.obsidianScopeStrategy === "per-platform") {
        const own = Platform.isMobile ? settings.mobileObsidianScope : settings.desktopObsidianScope;
        const v = own?.[key];
        if (typeof v === "boolean") return v;
    }
    return !!settings[key];
}

/** Bytes above which a file is left out on this kind of device (PC or mobile); null = no limit */
export function deviceMaxFileBytes(settings: { desktopMaxFileSizeMB?: number; mobileMaxFileSizeMB?: number }): number | null {
    const mb = Platform.isMobile ? settings.mobileMaxFileSizeMB : settings.desktopMaxFileSizeMB;
    return mb !== undefined && mb > 0 ? mb * 1024 * 1024 : null;
}

/**
 * Over this kind of device's size limit: left out here like an excluded file. Not
 * pulled, not pushed, and never deleted from the cloud on its account (other
 * devices may sync it). A copy already here stays as it is.
 */
export function exceedsDeviceSizeLimit(ctx: Pick<FileUtilsCtx, "settings">, size: number | undefined): boolean {
    const max = deviceMaxFileBytes(ctx.settings);
    return max !== null && size !== undefined && size > max;
}

/** The list of this kind of device (PC or mobile) */
export function deviceScopePatterns(settings: {
    desktopExclusionPatterns?: string;
    mobileExclusionPatterns?: string;
}): string {
    return (Platform.isMobile ? settings.mobileExclusionPatterns : settings.desktopExclusionPatterns) ?? "";
}

/**
 * Left out by this device's own sync settings: the exclusion list, the content
 * toggles (images and media, dotfiles, .obsidian categories, plugin data, logs).
 * Settings may differ between devices (settings file not synced, or not arrived
 * yet), so these files are treated like the device-only lists: never pulled,
 * pushed or deleted from here. Removing them from the cloud took them from every
 * device that still syncs them.
 */
export function isExcludedBySettings(ctx: Pick<FileUtilsCtx, "settings">, path: string): boolean {
    return shouldNotBeOnRemote(ctx as FileUtilsCtx, path) && !isAlwaysForbiddenOnRemote(path);
}

/**
 * Left out on this device: by this kind of device's list (desktop/mobileExclusionPatterns)
 * or by its sync settings (isExcludedBySettings). Such files are not "should not
 * be on remote": the other devices may keep syncing them, so no cleanup ever
 * removes them from the cloud, and a deletion in the cloud never removes the
 * copy kept here.
 */
export function isDeviceExcluded(ctx: Pick<FileUtilsCtx, "settings">, path: string): boolean {
    return matchesDeviceScope(deviceScopePatterns(ctx.settings), path) || isExcludedBySettings(ctx, path);
}

/** Settings that decide which files this device leaves out (see isDeviceExcluded) */
export const SCOPE_SETTING_KEYS = [
    "exclusionPatterns",
    "desktopExclusionPatterns",
    "mobileExclusionPatterns",
    "syncImagesAndMedia",
    "syncDotfiles",
    "syncAppearance",
    "syncCommunityPlugins",
    "syncCoreConfig",
    "syncWorkspace",
    "syncFlexibleData",
    "syncDeviceLogs",
    "obsidianScopeStrategy",
    "desktopObsidianScope",
    "mobileObsidianScope",
] as const;

/** The scope settings as one comparable value */
export function scopeSnapshot(settings: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const k of SCOPE_SETTING_KEYS) out[k] = settings[k];
    return out;
}

/** The path matches one of the patterns (one per line, "#" lines are comments) */
export function matchesDeviceScope(patternText: string | undefined, path: string): boolean {
    const patterns = patternList(patternText);
    if (patterns.length === 0) return false;
    const normalizedPath = normalizePath(path).toLowerCase();
    const withSlash = normalizedPath.endsWith("/") ? normalizedPath : normalizedPath + "/";
    return patterns.some((p) => matchWildcard(p, normalizedPath) || matchWildcard(p, withSlash));
}

/**
 * The folder holds synced files this device leaves out. Deleting the folder
 * here must not remove it in the cloud (it would take those files from the
 * other devices): only the files this device syncs are deleted, one by one.
 */
export function holdsDeviceExcluded(ctx: FileUtilsCtx, folderPath: string, indexed: string[]): boolean {
    if (isDeviceExcluded(ctx, folderPath)) return true;
    const prefix = folderPath + "/";
    // Files left out may be missing from the index (never pulled here): a pattern
    // that can match below the folder is enough. Deleting file by file is only slower.
    const lowerPrefix = normalizePath(folderPath).toLowerCase() + "/";
    const couldMatchBelow = (p: string) => {
        const literal = p.split(/[*?[{]/)[0];
        return literal.startsWith(lowerPrefix) || lowerPrefix.startsWith(literal);
    };
    if (patternList(deviceScopePatterns(ctx.settings)).some(couldMatchBelow)) return true;
    if (patternList(ctx.settings.exclusionPatterns).some(couldMatchBelow)) return true;
    // Images and media left out here may sit in any folder
    if (!ctx.settings.syncImagesAndMedia) return true;
    // Dotfiles and the config folder have their own toggles
    if (lowerPrefix.startsWith(".")) return true;
    return indexed.some((p) => p.startsWith(prefix) && isDeviceExcluded(ctx, p));
}

export function normalizeLineEndings(s: string): string {
    return s.replace(/\r\n/g, "\n");
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/** The text of `bytes`, or null if they are not valid UTF-8 (a binary file). */
function decodeUtf8(bytes: Uint8Array): string | null {
    try {
        return strictUtf8.decode(bytes);
    } catch {
        return null;
    }
}

/**
 * Hash of a file's content, used to tell whether the plaintext changed (with an
 * add-on whose cloud hashes are not of the plaintext).
 *
 * UTF-8 text is hashed with CRLF folded to LF and without a BOM, so the same note
 * saved on different platforms has one hash. Anything else is hashed as raw bytes:
 * decoding it as text replaced every invalid byte with U+FFFD, so two files that
 * differed only in such bytes had the same hash and an edit could go unnoticed.
 * Hashes stored before that change are handled by plain-hash-migration.ts.
 */
export async function hashContent(content: ArrayBuffer): Promise<string> {
    const bytes = new Uint8Array(content);
    const text = decodeUtf8(bytes);
    if (text === null) return contentFingerprint(content);
    // Fast path: valid UTF-8 without CR and without BOM decodes and re-encodes to the
    // very same bytes, so hash them directly.
    const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    if (!hasBom && bytes.indexOf(0x0d) === -1) return contentFingerprint(content);
    // The decoder already dropped the BOM; normalize line endings.
    return contentFingerprint(new TextEncoder().encode(normalizeLineEndings(text)).buffer);
}

/**
 * The hash older versions stored for `content`, when it differs from hashContent's:
 * only for content that is not valid UTF-8, which they decoded lossily as text.
 * Returns null when both are the same.
 */
export function legacyHashContent(content: ArrayBuffer): string | null {
    if (decodeUtf8(new Uint8Array(content)) !== null) return null;
    const lossy = normalizeLineEndings(new TextDecoder().decode(content));
    return contentFingerprint(new TextEncoder().encode(lossy).buffer);
}

/**
 * Whether a plaintext hash taken from an index describes `content`. Index entries
 * written by an older version (another device not yet updated, or an entry the
 * one-time migration could not convert) hold the old hash for non-UTF-8 files;
 * those are accepted too, or every such file would look changed and be merged or
 * uploaded again. `current` is hashContent(content) if the caller already has it.
 */
export async function plainHashMatches(
    stored: string | undefined,
    content: ArrayBuffer,
    current?: string,
): Promise<boolean> {
    if (!stored) return false;
    const s = stored.toLowerCase();
    if ((current ?? (await hashContent(content))) === s) return true;
    return legacyHashContent(content) === s;
}
