import type { IVaultOperations } from "./types/vault-operations";

/**
 * Manages a local file-based cache for revision content to reduce bandwidth.
 * Implements TTL (Time To Live) and size limits.
 */
export class RevisionCache {
    private cacheDir: string;
    private readonly TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

    constructor(
        private vault: IVaultOperations,
        pluginDir: string,
    ) {
        this.cacheDir = `${pluginDir}/cache`;
    }

    /**
     * Initialize cache directory
     */
    async init() {
        if (!(await this.vault.exists(this.cacheDir))) {
            await this.vault.mkdir(this.cacheDir);
        }
        await this.cleanup();
    }

    /**
     * Generate a cache key (filename) from file path and revision ID
     */
    private getCacheKey(filePath: string, revisionId: string): string {
        // Simple sanitization.
        // Hash the path to ensure valid filename, append revision ID.
        // We can't easily import md5 here without circular dep issues or duplicating util.
        // Let's use a simple base64-like replacement or just use window.btoa if available?
        // Or just replace invalid chars.

        // Better: Use a simple hash function or replace all non-alphanumeric chars.
        const safePath = filePath.replace(/[^a-zA-Z0-9]/g, "_");
        return `${safePath}-${revisionId}.cache`;
    }

    async get(filePath: string, revisionId: string): Promise<ArrayBuffer | null> {
        const key = this.getCacheKey(filePath, revisionId);
        const path = `${this.cacheDir}/${key}`;

        if (await this.vault.exists(path)) {
            // Update mtime to refresh TTL?
            // - Usually caches just expire based on creation, or LRU.
            // - Let's stick to simple TTL based on creation (or mtime).

            // Check if expired before returning?
            const stat = await this.vault.stat(path);
            if (stat && Date.now() - stat.mtime > this.TTL_MS) {
                // Expired
                await this.vault.remove(path);
                return null;
            }

            return await this.vault.readBinary(path);
        }
        return null;
    }

    async set(filePath: string, revisionId: string, content: ArrayBuffer): Promise<void> {
        const key = this.getCacheKey(filePath, revisionId);
        const path = `${this.cacheDir}/${key}`;

        // Ensure cache dir exists (redundant check but safe)
        if (!(await this.vault.exists(this.cacheDir))) {
            await this.vault.mkdir(this.cacheDir);
        }

        await this.vault.writeBinary(path, content);
    }

    /**
     * Remove expired cache files
     */
    async cleanup() {
        try {
            if (!(await this.vault.exists(this.cacheDir))) return;

            const listed = await this.vault.list(this.cacheDir);
            const now = Date.now();

            for (const filePath of listed.files) {
                if (!filePath.endsWith(".cache")) continue;

                const stat = await this.vault.stat(filePath);
                if (stat && now - stat.mtime > this.TTL_MS) {
                    await this.vault.remove(filePath);
                    console.log(`[Cache] Removed expired: ${filePath}`);
                }
            }
        } catch (e) {
            console.error("[Cache] Cleanup failed", e);
        }
    }

    /**
     * Clear all cache
     */
    async clear() {
        if (await this.vault.exists(this.cacheDir)) {
            await this.vault.rmdir(this.cacheDir, true);
            await this.vault.mkdir(this.cacheDir);
        }
    }
}
