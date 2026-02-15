import { normalizePath } from "../utils/path";
import { matchWildcard } from "../utils/wildcard";
import { md5 } from "../utils/md5";
import type { SyncContext } from "./context";

// === System-level Constants ===

export const PLUGIN_DIR = ".obsidian/plugins/obsidian-vault-sync/";

export const INTERNAL_LOCAL_ONLY = ["cache/", "data/local/"];

/** Files managed by custom logic (e.g. saveIndex), skipped by generic sync loop */
export const INTERNAL_REMOTE_MANAGED = [
    "data/remote/sync-index.json",
    "data/remote/sync-index_raw.json",
    "data/remote/communication.json",
    "vault-lock.json",
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

// === File Operations ===

export async function ensureLocalFolder(ctx: SyncContext, filePath: string) {
    filePath = normalizePath(filePath);
    const parts = filePath.split("/");
    if (parts.length <= 1) return;

    const folderPath = parts.slice(0, -1).join("/");
    if (await ctx.app.vault.adapter.exists(folderPath)) return;

    let currentPath = "";
    for (const part of parts.slice(0, -1)) {
        currentPath += (currentPath ? "/" : "") + part;
        if (!(await ctx.app.vault.adapter.exists(currentPath))) {
            try {
                await ctx.app.vault.createFolder(currentPath);
            } catch (e) {
                console.debug("VaultSync: Race condition in mkdir ignored", e);
            }
        }
    }
}

export async function listFilesRecursive(ctx: SyncContext, path: string): Promise<string[]> {
    const result: string[] = [];
    const listed = await ctx.app.vault.adapter.list(path);

    for (const file of listed.files) {
        result.push(file);
    }

    for (const folder of listed.folders) {
        const subFiles = await listFilesRecursive(ctx, folder);
        result.push(...subFiles);
    }

    return result;
}

export async function getLocalFiles(ctx: SyncContext) {
    const standardFiles = ctx.app.vault.getFiles().map((f) => ({
        path: f.path,
        mtime: f.stat.mtime,
        size: f.stat.size,
        name: f.name,
    }));

    const obsidianFiles: { path: string; mtime: number; size: number; name: string }[] = [];
    try {
        const files = await listFilesRecursive(ctx, ".obsidian");
        for (const path of files) {
            const stat = await ctx.app.vault.adapter.stat(path);
            if (stat) {
                obsidianFiles.push({
                    path,
                    mtime: stat.mtime,
                    size: stat.size,
                    name: path.split("/").pop() || "",
                });
            }
        }
    } catch (e) {
        await ctx.log(`  Failed to list .obsidian: ${e}`);
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
    if (!path.startsWith(PLUGIN_DIR)) return false;
    const subPath = path.substring(PLUGIN_DIR.length);
    return INTERNAL_REMOTE_MANAGED.includes(subPath);
}

/**
 * リモートに存在してはいけない（クリーンアップ対象）ファイルかどうかを判定。
 */
export function shouldNotBeOnRemote(ctx: SyncContext, path: string): boolean {
    const normalizedPath = normalizePath(path).toLowerCase();
    const normalizedWithSlash = normalizedPath.endsWith("/")
        ? normalizedPath
        : normalizedPath + "/";

    // 0. 自分のプラグインの内部ファイルの制御
    if (normalizedPath.startsWith(".obsidian/plugins/obsidian-vault-sync/")) {
        const pluginDirPrefix = ".obsidian/plugins/obsidian-vault-sync/";
        const subPath = normalizedPath.substring(pluginDirPrefix.length);
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
    if (normalizedPath.startsWith(".obsidian/")) {
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

        if (!ctx.settings.syncWorkspace) {
            if (
                OBSIDIAN_WORKSPACE_FILES.some((f) => normalizedPath.endsWith("/" + f.toLowerCase()))
            ) {
                return true;
            }
        }

        if (!ctx.settings.syncAppearance) {
            if (
                normalizedPath.startsWith(".obsidian/themes/") ||
                normalizedPath.startsWith(".obsidian/snippets/")
            ) {
                return true;
            }
        }

        if (!ctx.settings.syncCommunityPlugins) {
            if (normalizedPath.startsWith(".obsidian/plugins/")) {
                return true;
            }
        }

        if (!ctx.settings.syncCoreConfig) {
            const coreFiles = [
                ".obsidian/app.json",
                ".obsidian/appearance.json",
                ".obsidian/hotkeys.json",
                ".obsidian/core-plugins.json",
                ".obsidian/community-plugins.json",
                ".obsidian/graph.json",
            ];
            if (coreFiles.includes(normalizedPath)) {
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
            normalizedPath !== ".obsidian" &&
            !normalizedPath.startsWith(".obsidian/")
        )
            return true;
    }

    return false;
}

export function shouldIgnore(ctx: SyncContext, path: string): boolean {
    return isManagedSeparately(path) || shouldNotBeOnRemote(ctx, path);
}

/**
 * Calculate MD5 hash of content (for plaintext comparison in E2EE scenarios)
 * @param content - ArrayBuffer containing the file content
 * @returns MD5 hash of the content as a lowercase hex string
 */
export async function hashContent(content: ArrayBuffer): Promise<string> {
    // Normalize line endings for consistent hash calculation across platforms
    const contentStr = new TextDecoder().decode(content);
    const normalizedContent = contentStr.replace(/\r\n/g, "\n");
    const normalizedBuffer = new TextEncoder().encode(normalizedContent).buffer;
    return md5(normalizedBuffer);
}
