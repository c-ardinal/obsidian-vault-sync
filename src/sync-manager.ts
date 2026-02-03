import { CloudAdapter } from "./types/adapter";
import { App, TFile, TFolder, TAbstractFile, Notice } from "obsidian";
import { matchWildcard } from "./utils/wildcard";
import { md5 } from "./utils/md5";
import { RevisionCache } from "./revision-cache";

export interface SyncManagerSettings {
    concurrency: number;
    showDetailedNotifications: boolean;
    enableLogging: boolean;
    exclusionPatterns: string;
}

export interface LocalFileIndex {
    [path: string]: {
        fileId: string;
        mtime: number;
        size: number;
        hash?: string;
    };
}

// === Hybrid Sync Types ===

/** Sync engine states for preemption control */
export type SyncState = "IDLE" | "SMART_SYNCING" | "FULL_SCANNING" | "PAUSED";

/** Progress state for resumable full scan */
export interface FullScanProgress {
    /** Current index in the file list being processed */
    currentIndex: number;
    /** Total files to process */
    totalFiles: number;
    /** Cached local file list (for resume) */
    localFiles: Array<{ path: string; mtime: number; size: number }>;
    /** Cached remote file list (for resume) */
    remoteFiles: Array<{ id: string; path: string; mtime: number; size: number; hash?: string }>;
    /** Timestamp when the scan started (for staleness check) */
    startedAt: number;
}

export class SyncManager {
    private index: LocalFileIndex = {};
    private startPageToken: string | null = null;

    private logFolder: string;
    private revisionCache: RevisionCache;

    // === Hybrid Sync State ===
    /** Current sync state for preemption control */
    private syncState: SyncState = "IDLE";
    /** Dirty paths that need to be pushed (modified locally) */
    private dirtyPaths: Set<string> = new Set();
    /** Paths currently being synced (to prevent re-marking as dirty) */
    private syncingPaths: Set<string> = new Set();
    /** Flag to interrupt running full scan */
    private isInterrupted = false;
    /** Progress for resumable full scan */
    private fullScanProgress: FullScanProgress | null = null;
    /** Promise for current running sync operation (for awaiting) */
    private currentSyncPromise: Promise<void> | null = null;
    /** Maximum age for full scan progress before reset (5 minutes) */
    private readonly FULL_SCAN_MAX_AGE_MS = 5 * 60 * 1000;

    private onActivityStart: () => void = () => {};
    private onActivityEnd: () => void = () => {};

    constructor(
        private app: App,
        private adapter: CloudAdapter,
        private pluginDataPath: string,

        private settings: SyncManagerSettings,
        private pluginDir: string,
        private t: (key: string) => string,
    ) {
        this.logFolder = `${this.pluginDir}/logs`;
        this.adapter.setLogger((msg) => this.log(msg));
        this.revisionCache = new RevisionCache(this.app, this.pluginDir);
    }

    public setActivityCallbacks(onStart: () => void, onEnd: () => void) {
        this.onActivityStart = onStart;
        this.onActivityEnd = onEnd;
    }

    async log(message: string) {
        const now = new Date();
        // Use local timezone for timestamp
        const timestamp = now.toLocaleString("ja-JP", {
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        });
        const line = `[${timestamp}] ${message}\n`;
        console.log(`VaultSync: ${message}`);

        if (!this.settings.enableLogging) return;

        try {
            // Use local timezone for file name
            const year = now.getFullYear();
            const month = String(now.getMonth() + 1).padStart(2, "0");
            const day = String(now.getDate()).padStart(2, "0");
            const today = `${year}-${month}-${day}`;
            const logPath = `${this.logFolder}/${today}.log`;

            // Ensure log folder exists (use adapter for recursive mkdir)
            if (!(await this.app.vault.adapter.exists(this.logFolder))) {
                await this.ensureLocalFolder(this.logFolder + "/dummy.txt"); // Simple trick for recursive
            }

            const existingContent = await this.app.vault.adapter.read(logPath).catch(() => "");
            await this.app.vault.adapter.write(logPath, existingContent + line);
        } catch (e) {
            console.error("Failed to write to log file:", e);
        }
    }

    private async ensureLocalFolder(filePath: string) {
        const parts = filePath.split("/");
        if (parts.length <= 1) return;

        const folderPath = parts.slice(0, -1).join("/");
        if (await this.app.vault.adapter.exists(folderPath)) return;

        // Iterate and create each segment if needed
        let currentPath = "";
        for (const part of parts.slice(0, -1)) {
            currentPath += (currentPath ? "/" : "") + part;
            if (!(await this.app.vault.adapter.exists(currentPath))) {
                try {
                    await this.app.vault.createFolder(currentPath);
                } catch (e) {
                    // Ignore race conditions
                    console.debug("VaultSync: Race condition in mkdir ignored", e);
                }
            }
        }
    }

    async loadIndex() {
        try {
            // Read as binary to support potential Gzip content (e.g. manual restore from cloud)
            const data = await this.app.vault.adapter.readBinary(this.pluginDataPath);
            const decompressed = await this.tryDecompress(data);
            const text = new TextDecoder().decode(decompressed);
            const parsed = JSON.parse(text);
            this.index = parsed.index || {};
            this.startPageToken = parsed.startPageToken || null;

            // If we successfully loaded a compressed file, rewrite it as plain text immediately
            // to normalize the state
            if (data.byteLength !== decompressed.byteLength) {
                await this.log(
                    "[Index] Detected compressed local index. Normalizing to plain text...",
                );
                await this.saveIndex();
            }

            // Init & Cleanup revision cache
            await this.revisionCache.init();
        } catch (e) {
            // FALLBACK TO RAW INDEX
            const rawPath = this.pluginDataPath.replace(".json", "_raw.json");
            try {
                await this.log(
                    `[Index] Main load failed (${e}). Attempting fallback to raw index: ${rawPath}`,
                );
                if (await this.app.vault.adapter.exists(rawPath)) {
                    const data = await this.app.vault.adapter.read(rawPath);
                    const parsed = JSON.parse(data);
                    this.index = parsed.index || {};
                    this.startPageToken = parsed.startPageToken || null;
                    await this.log("[Index] Successfully recovered from raw index.");

                    // Save back to main file to restore normalcy
                    await this.saveIndex();
                    return;
                }
            } catch (rawErr) {
                await this.log(`[Index] Raw fallback also failed: ${rawErr}`);
            }

            await this.log(`[Index] Fatal load failure. Starting fresh.`);
            this.index = {};
            this.startPageToken = null;
        }
    }

    async saveIndex() {
        const data = JSON.stringify({
            index: this.index,
            startPageToken: this.startPageToken,
        });

        // Save main file
        await this.app.vault.adapter.write(this.pluginDataPath, data);

        // Save raw backup (local only, for recovery)
        const rawPath = this.pluginDataPath.replace(".json", "_raw.json");
        try {
            await this.app.vault.adapter.write(rawPath, data);
        } catch (e) {
            console.error("VaultSync: Failed to save raw index backup", e);
        }
    }

    async resetIndex() {
        this.index = {};
        this.startPageToken = null;
        await this.saveIndex();
    }

    private async runParallel<T>(
        tasks: (() => Promise<T>)[],
        concurrency: number = this.settings.concurrency,
    ): Promise<T[]> {
        const results: T[] = [];
        const queue = [...tasks];
        const workers = Array(Math.min(concurrency, queue.length))
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

    private async listFilesRecursive(path: string): Promise<string[]> {
        const result: string[] = [];
        const listed = await this.app.vault.adapter.list(path);

        for (const file of listed.files) {
            result.push(file);
        }

        for (const folder of listed.folders) {
            const subFiles = await this.listFilesRecursive(folder);
            result.push(...subFiles);
        }

        return result;
    }

    private async getLocalFiles() {
        // Standard vault files
        const standardFiles = this.app.vault.getFiles().map((f) => ({
            path: f.path,
            mtime: f.stat.mtime,
            size: f.stat.size,
            name: f.name,
        }));

        // Hidden .obsidian files
        const obsidianFiles: { path: string; mtime: number; size: number; name: string }[] = [];
        try {
            const files = await this.listFilesRecursive(".obsidian");
            for (const path of files) {
                const stat = await this.app.vault.adapter.stat(path);
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
            await this.log(`  Failed to list .obsidian: ${e}`);
        }

        return [...standardFiles, ...obsidianFiles];
    }

    // === Compression Helpers ===
    private async compress(data: ArrayBuffer): Promise<ArrayBuffer> {
        try {
            const stream = new Blob([data]).stream().pipeThrough(new CompressionStream("gzip"));
            return await new Response(stream).arrayBuffer();
        } catch (e) {
            console.error("Compression failed:", e);
            return data;
        }
    }

    private async tryDecompress(data: ArrayBuffer): Promise<ArrayBuffer> {
        try {
            const view = new Uint8Array(data);
            // GZIP magic number: 1F 8B
            if (view.length > 2 && view[0] === 0x1f && view[1] === 0x8b) {
                const stream = new Blob([data])
                    .stream()
                    .pipeThrough(new DecompressionStream("gzip"));
                return await new Response(stream).arrayBuffer();
            }
        } catch (e) {
            // If it looked like GZIP but failed, we MUST throw, otherwise we pass binary to JSON.parse
            if (e instanceof Error) {
                // Check if it was definitely GZIP
                const view = new Uint8Array(data);
                if (view.length > 2 && view[0] === 0x1f && view[1] === 0x8b) {
                    throw new Error(`Gzip decompression failed: ${e.message}`);
                }
            }
        }
        return data;
    }

    public shouldIgnore(path: string): boolean {
        // User-defined exclusion patterns (check first)
        if (this.settings.exclusionPatterns) {
            const patterns = this.settings.exclusionPatterns
                .split("\n")
                .map((p) => p.trim())
                .filter((p) => p);
            for (const pattern of patterns) {
                if (matchWildcard(pattern, path)) {
                    return true;
                }
            }
        }

        // Core ignored prefixes
        const ignorePrefixes = ["_VaultSync_Debug.log", "_VaultSync_Orphans/"];
        if (ignorePrefixes.some((p) => path.startsWith(p))) return true;

        // Selective .obsidian sync
        if (path.startsWith(".obsidian/")) {
            const obsidianExclusions = [
                "workspace.json",
                "workspace-mobile.json",
                "cache/",
                "indexedDB/",
                "backups/",
                "obsidian-vault-sync/sync-index.json", // Don't sync the index ITSELF as a normal file to avoid recursive loops?
                "obsidian-vault-sync/sync-index_raw.json", // Don't sync the index ITSELF as a normal file to avoid recursive loops?
                // Actually, we WANT to sync it, but maybe manually or via specialized logic.
                // For now, let's allow the index but ignore transient UI state.
            ];

            // Re-allow specific critical files and plugins
            const isExcluded = obsidianExclusions.some(
                (e) => path.includes("/" + e) || path.endsWith("/" + e),
            );
            if (isExcluded) return true;

            return false; // Sync everything else in .obsidian
        }

        // Ignore hidden files (except .obsidian folder and its contents)
        if (path.startsWith(".") && path !== ".obsidian" && !path.startsWith(".obsidian/"))
            return true;

        return false;
    }

    // ==========================================================================
    // Hybrid Sync Implementation (Smart Sync + Interruptible Background Scan)
    // ==========================================================================

    /**
     * Mark a file as dirty (modified locally, needs push)
     * Called from main.ts on file modify/create events
     */
    markDirty(path: string) {
        if (!this.shouldIgnore(path) && !this.syncingPaths.has(path)) {
            this.dirtyPaths.add(path);
            this.log(`[Dirty] Marked: ${path}`);
        }
    }

    /**
     * Scan .obsidian directory for changes
     * Vault events don't fire for .obsidian files, so we need to scan manually
     */
    private async scanObsidianChanges(): Promise<void> {
        try {
            const obsidianFiles = await this.listFilesRecursive(".obsidian");

            for (const filePath of obsidianFiles) {
                if (this.shouldIgnore(filePath)) continue;
                if (this.syncingPaths.has(filePath)) continue;

                const stat = await this.app.vault.adapter.stat(filePath);
                if (!stat) continue;

                const indexEntry = this.index[filePath];

                // New file (not in index)
                if (!indexEntry) {
                    this.dirtyPaths.add(filePath);
                    await this.log(`[Obsidian Scan] New: ${filePath}`);
                    continue;
                }

                // Check if modified (mtime changed)
                if (stat.mtime > indexEntry.mtime) {
                    // Mtime changed: verify content hash to confirm actual modification
                    try {
                        const content = await this.app.vault.adapter.readBinary(filePath);
                        const localHash = md5(content);
                        if (indexEntry.hash && localHash !== indexEntry.hash.toLowerCase()) {
                            this.dirtyPaths.add(filePath);
                            await this.log(`[Obsidian Scan] Modified (hash mismatch): ${filePath}`);
                        } else if (!indexEntry.hash) {
                            // No previous hash, but mtime changed. Assume dirty to be safe and update hash.
                            this.dirtyPaths.add(filePath);
                            await this.log(`[Obsidian Scan] Modified (no prev hash): ${filePath}`);
                        } else {
                            // Hash matches, just update mtime in index to avoid future re-hashing
                            this.index[filePath].mtime = stat.mtime;
                            // await this.log(`[Obsidian Scan] Skipped (hash match): ${filePath}`);
                        }
                    } catch {
                        // Read failed, assume dirty
                        this.dirtyPaths.add(filePath);
                    }
                }
            }
        } catch (e) {
            await this.log(`[Obsidian Scan] Error: ${e}`);
        }
    }

    /**
     * Scan all vault files for changes (missing events while app was closed)
     * This is O(N) but fast because it uses Obsidian's cached file metadata
     */
    private async scanVaultChanges(): Promise<void> {
        try {
            await this.log("[Vault Scan] Starting full vault scan...");
            const start = Date.now();

            const files = this.app.vault.getFiles();
            const currentPaths = new Set<string>();

            // 1. Check for New and Modified files
            for (const file of files) {
                if (this.shouldIgnore(file.path)) continue;

                // Track existence for deletion check
                currentPaths.add(file.path);

                // .obsidian files are handled by scanObsidianChanges, so we skip them here
                // (getFiles() usually doesn't return them anyway, but safety first)
                if (file.path.startsWith(".obsidian/")) continue;

                const indexEntry = this.index[file.path];

                if (!indexEntry) {
                    // New file (not in index)
                    this.dirtyPaths.add(file.path);
                    await this.log(`[Vault Scan] New: ${file.path}`);
                } else if (file.stat.mtime > indexEntry.mtime) {
                    // Mtime changed: verify content hash
                    try {
                        const content = await this.app.vault.adapter.readBinary(file.path);
                        const localHash = md5(content);

                        if (indexEntry.hash && localHash !== indexEntry.hash.toLowerCase()) {
                            this.dirtyPaths.add(file.path);
                            await this.log(`[Vault Scan] Modified (hash mismatch): ${file.path}`);
                        } else if (!indexEntry.hash) {
                            this.dirtyPaths.add(file.path);
                            await this.log(`[Vault Scan] Modified (no prev hash): ${file.path}`);
                        } else {
                            // Hash matches, update index mtime
                            this.index[file.path].mtime = file.stat.mtime;
                        }
                    } catch (e) {
                        // Read failed
                        await this.log(`[Vault Scan] Hash check failed for ${file.path}: ${e}`);
                    }
                }
            }

            // 2. Check for Deleted files (in index but not in vault)
            for (const path of Object.keys(this.index)) {
                // Skip .obsidian files (handled by scanObsidianChanges) and ignored files
                if (path.startsWith(".obsidian/")) continue;
                if (path === this.pluginDataPath) continue;
                if (this.shouldIgnore(path)) continue;

                if (!currentPaths.has(path)) {
                    // Path is in index but not in current vault files
                    // Mark for deletion
                    this.dirtyPaths.add(path);
                    await this.log(`[Vault Scan] Detect Deleted: ${path}`);
                }
            }

            await this.log(`[Vault Scan] Completed in ${Date.now() - start}ms`);
        } catch (e) {
            await this.log(`[Vault Scan] Error: ${e}`);
        }
    }

    /**
     * Mark a file as deleted locally (needs remote deletion)
     * Called from main.ts on file delete events
     */
    markDeleted(path: string) {
        // Keep in dirtyPaths so smartPush can detect and delete from remote
        // (smartPush checks if file exists, and if not + in index, adds to deleteQueue)
        if (!this.shouldIgnore(path) && this.index[path]) {
            this.dirtyPaths.add(path);
            this.log(`[Dirty] Marked for deletion: ${path}`);
        }
    }

    /**
     * Mark all files in a folder as deleted locally
     * Called from main.ts on folder delete events
     */
    markFolderDeleted(folderPath: string) {
        const prefix = folderPath + "/";
        for (const path of Object.keys(this.index)) {
            if (path.startsWith(prefix) && !this.shouldIgnore(path)) {
                this.dirtyPaths.add(path);
                this.log(`[Dirty] Marked for deletion (folder): ${path}`);
            }
        }
    }

    /**
     * Mark a file as renamed (handles both regular renames and "create then rename" cases)
     * Called from main.ts on file rename events
     */
    markRenamed(oldPath: string, newPath: string) {
        // Case 1: oldPath is in dirtyPaths but NOT in index
        // This means the file was created and renamed before being synced
        // We should just remove oldPath from dirtyPaths (no remote deletion needed)
        if (this.dirtyPaths.has(oldPath) && !this.index[oldPath]) {
            this.dirtyPaths.delete(oldPath);
            this.log(`[Dirty] Removed (renamed before sync): ${oldPath}`);
        } else {
            // Case 2: Normal rename - file was already synced
            // Mark old path for deletion from remote
            this.markDeleted(oldPath);
        }

        // Always mark new path as dirty (for upload)
        if (!this.shouldIgnore(newPath) && !this.syncingPaths.has(newPath)) {
            this.dirtyPaths.add(newPath);
            this.log(`[Dirty] Marked (renamed): ${newPath}`);
        }
    }

    /**
     * Mark all files in a renamed folder for update
     * Called from main.ts on folder rename events
     */
    markFolderRenamed(oldFolderPath: string, newFolderPath: string) {
        const oldPrefix = oldFolderPath + "/";
        const newPrefix = newFolderPath + "/";

        for (const oldPath of Object.keys(this.index)) {
            if (oldPath.startsWith(oldPrefix)) {
                // Mark old path for deletion
                this.dirtyPaths.add(oldPath);
                this.log(`[Dirty] Marked for deletion (folder rename): ${oldPath}`);

                // Mark new path for upload
                const newPath = newPrefix + oldPath.slice(oldPrefix.length);
                if (!this.shouldIgnore(newPath)) {
                    this.dirtyPaths.add(newPath);
                    this.log(`[Dirty] Marked for upload (folder rename): ${newPath}`);
                }
            }
        }
    }

    /**
     * Get current sync state
     */
    getSyncState(): SyncState {
        return this.syncState;
    }

    /**
     * Check if there are pending dirty files
     */
    hasDirtyFiles(): boolean {
        return this.dirtyPaths.size > 0;
    }

    /**
     * Request Smart Sync - high priority, interrupts full scan
     * This is the main entry point for user-triggered syncs
     */
    /**
     * Request Smart Sync - high priority, interrupts full scan
     * This is the main entry point for user-triggered syncs
     * @param isSilent If true, suppress initial notifications (errors still shown)
     * @param scanVault If true, perform a full vault scan for changes (O(N)) - useful for startup
     */
    async requestSmartSync(isSilent: boolean = true, scanVault: boolean = false): Promise<void> {
        // If already smart syncing, just wait for it
        if (this.syncState === "SMART_SYNCING") {
            if (this.currentSyncPromise) {
                await this.currentSyncPromise;
            }
            return;
        }

        // Interrupt running full scan
        if (this.syncState === "FULL_SCANNING") {
            await this.log("[Smart Sync] Interrupting full scan...");
            this.isInterrupted = true;
            // Wait for full scan to pause
            if (this.currentSyncPromise) {
                await this.currentSyncPromise;
            }

            // RACE CONDITION FIX:
            // After waiting, another request might have woken up first and started syncing.
            // Re-check state to ensure we don't run parallel syncs.
            if ((this.syncState as SyncState) === "SMART_SYNCING") {
                if (this.currentSyncPromise) {
                    await this.currentSyncPromise;
                }
                return;
            }
        }

        // Execute smart sync
        this.syncState = "SMART_SYNCING";
        this.currentSyncPromise = this.executeSmartSync(isSilent, scanVault);

        try {
            await this.currentSyncPromise;
        } finally {
            this.syncState = "IDLE";
            this.currentSyncPromise = null;
        }
    }

    /**
     * Execute Smart Sync logic
     * - Pull: Check remote changes via sync-index.json hash comparison (or Changes API)
     * - Push: Upload dirty files
     */
    private async executeSmartSync(isSilent: boolean, scanVault: boolean): Promise<void> {
        try {
            await this.log("=== SMART SYNC START ===");
            if (!isSilent) new Notice(`⚡ ${this.t("syncing")}`);

            // Pre-warm adapter (ensure root folders exist) to avoid delay in push phase
            if (this.adapter.initialize) {
                await this.adapter.initialize();
            }

            // === PULL PHASE ===
            const pulled = await this.smartPull(isSilent);

            // === PUSH PHASE ===
            const pushed = await this.smartPush(isSilent, scanVault);

            if (!pulled && !pushed && !isSilent) {
                new Notice(this.t("vaultUpToDate"));
            }

            await this.log("=== SMART SYNC COMPLETED ===");
        } catch (e) {
            await this.log(`Smart Sync failed: ${e}`);
            throw e;
        }
    }

    /**
     * Smart Pull - O(1) check for remote changes using sync-index.json hash
     */
    private async smartPull(isSilent: boolean): Promise<boolean> {
        await this.log("[Smart Pull] Checking for remote changes...");

        // Check if adapter supports Changes API for faster detection
        if (this.adapter.supportsChangesAPI) {
            if (this.startPageToken) {
                await this.log("[Smart Pull] Using Changes API (fast path)");
                return await this.pullViaChangesAPI(isSilent);
            } else {
                await this.log(
                    "[Smart Pull] Initializing Changes API token (will be used next time)",
                );
                try {
                    this.startPageToken = await this.adapter.getStartPageToken();
                    await this.saveIndex();
                } catch (e) {
                    await this.log(`[Smart Pull] Failed to init Changes API: ${e}`);
                }
                // Fall through to standard hash check for this run
            }
        }

        // Core path: sync-index.json hash comparison
        await this.log("[Smart Pull] Using sync-index.json hash comparison (core path)");

        // Get remote index metadata (O(1) operation)
        const remoteIndexMeta = await this.adapter.getFileMetadata(this.pluginDataPath);

        if (!remoteIndexMeta) {
            await this.log("[Smart Pull] No remote index found. Skipping pull.");
            return false;
        }

        // Compare hashes - use stored hash (from last push) instead of calculating
        // because local file includes self-reference which differs from uploaded content
        const localIndexHash = this.index[this.pluginDataPath]?.hash?.toLowerCase() || "";
        const remoteIndexHash = remoteIndexMeta.hash?.toLowerCase() || "";

        if (localIndexHash && remoteIndexHash && localIndexHash === remoteIndexHash) {
            await this.log("[Smart Pull] Index hash matches. No remote changes detected.");
            return false;
        }

        // Hashes differ - download remote index and compare
        await this.log(
            `[Smart Pull] Index hash differs (local: ${localIndexHash}, remote: ${remoteIndexHash}). Fetching remote index...`,
        );

        const remoteIndexContent = await this.adapter.downloadFile(remoteIndexMeta.id);
        const decompressed = await this.tryDecompress(remoteIndexContent);
        const remoteIndexData = JSON.parse(new TextDecoder().decode(decompressed));
        const remoteIndex: LocalFileIndex = remoteIndexData.index || {};

        // === CORRUPTION CHECK ===
        // If index is empty but file is large (>200 bytes), assume corruption.
        // Also if index is empty but we have > 20 local files, be very suspicious
        const remoteKeys = Object.keys(remoteIndex);
        const localKeys = Object.keys(this.index);

        if (remoteKeys.length === 0) {
            if (remoteIndexMeta.size > 200) {
                throw new Error(
                    `Remote index corruption detected: File size is ${remoteIndexMeta.size} bytes but parsed 0 files.`,
                );
            }
            if (localKeys.length > 20) {
                // Prevent accidental wipe of large local vault if remote index appears empty
                throw new Error(
                    `Safety Halt: Remote index is empty but local has ${localKeys.length} files. This looks like data corruption. Aborting to prevent data loss.`,
                );
            }
        }

        // Compare indexes to find changes
        const toDownload: Array<{ path: string; fileId: string; hash?: string }> = [];
        const toDeleteLocal: string[] = [];

        // Find files to download (new or modified on remote)
        for (const [path, remoteEntry] of Object.entries(remoteIndex)) {
            if (path === this.pluginDataPath) continue;
            if (this.shouldIgnore(path)) continue;

            const localEntry = this.index[path];

            if (!localEntry) {
                // New file on remote
                toDownload.push({ path, fileId: remoteEntry.fileId, hash: remoteEntry.hash });
            } else if (
                remoteEntry.hash &&
                localEntry.hash &&
                remoteEntry.hash.toLowerCase() !== localEntry.hash.toLowerCase()
            ) {
                // Modified on remote (hash differs)
                toDownload.push({ path, fileId: remoteEntry.fileId, hash: remoteEntry.hash });
            }
        }

        // Find files to delete locally (removed on remote)
        for (const path of Object.keys(this.index)) {
            if (path === this.pluginDataPath) continue;
            if (this.shouldIgnore(path)) continue;

            if (!remoteIndex[path]) {
                toDeleteLocal.push(path);
            }
        }

        await this.log(
            `[Smart Pull] Changes: ${toDownload.length} to download, ${toDeleteLocal.length} to delete`,
        );

        if (toDownload.length === 0 && toDeleteLocal.length === 0) {
            await this.log("[Smart Pull] No file changes detected.");
            // Update index metadata
            this.index[this.pluginDataPath] = {
                fileId: remoteIndexMeta.id,
                mtime: remoteIndexMeta.mtime,
                size: remoteIndexMeta.size,
                hash: remoteIndexMeta.hash,
            };
            await this.saveIndex();
            return false;
        }

        // Download changed files
        const tasks: (() => Promise<void>)[] = [];
        let completed = 0;
        const total = toDownload.length + toDeleteLocal.length;

        for (const item of toDownload) {
            tasks.push(async () => {
                try {
                    // Mark as syncing to prevent dirty marking from modify event
                    this.syncingPaths.add(item.path);

                    // Ensure parent folder exists
                    await this.ensureLocalFolder(item.path);

                    const content = await this.adapter.downloadFile(item.fileId);
                    await this.app.vault.adapter.writeBinary(item.path, content);

                    const stat = await this.app.vault.adapter.stat(item.path);
                    this.index[item.path] = {
                        fileId: item.fileId,
                        mtime: stat?.mtime || Date.now(),
                        size: stat?.size || content.byteLength,
                        hash: item.hash,
                    };

                    completed++;
                    await this.log(`[Smart Pull] [${completed}/${total}] Downloaded: ${item.path}`);
                    if (this.settings.showDetailedNotifications || !isSilent) {
                        new Notice(`⬇️ ${item.path.split("/").pop()}`);
                    }
                } catch (e) {
                    await this.log(`[Smart Pull] Download failed: ${item.path} - ${e}`);
                } finally {
                    this.syncingPaths.delete(item.path);
                }
            });
        }

        // Delete local files that were removed on remote
        for (const path of toDeleteLocal) {
            tasks.push(async () => {
                try {
                    const file = this.app.vault.getAbstractFileByPath(path);
                    if (file) {
                        await this.app.vault.trash(file, true);
                    }
                    delete this.index[path];

                    completed++;
                    await this.log(`[Smart Pull] [${completed}/${total}] Deleted locally: ${path}`);
                    if (this.settings.showDetailedNotifications || !isSilent) {
                        new Notice(`🗑️ ${path.split("/").pop()}`);
                    }
                } catch (e) {
                    await this.log(`[Smart Pull] Delete failed: ${path} - ${e}`);
                }
            });
        }

        if (tasks.length > 0) {
            this.onActivityStart();
            try {
                await this.runParallel(tasks);
            } finally {
                this.onActivityEnd();
            }
        }

        // Update index with remote index metadata
        this.index[this.pluginDataPath] = {
            fileId: remoteIndexMeta.id,
            mtime: remoteIndexMeta.mtime,
            size: remoteIndexMeta.size,
            hash: remoteIndexMeta.hash,
        };
        await this.saveIndex();

        if (total > 0) {
            new Notice(`⬇️ ${this.t("pullCompleted")} (${total} files)`);
            return true;
        }
        return false;
    }

    /**
     * Pull via Changes API (for adapters that support it)
     */
    private async pullViaChangesAPI(isSilent: boolean): Promise<boolean> {
        if (!this.startPageToken) {
            this.startPageToken = await this.adapter.getStartPageToken();
            await this.saveIndex();
        }

        const changes = await this.adapter.getChanges(this.startPageToken);

        if (changes.changes.length === 0) {
            await this.log("[Smart Pull] No changes from Changes API");
            if (changes.newStartPageToken) {
                this.startPageToken = changes.newStartPageToken;
                await this.saveIndex();
            }
            return false;
        }

        await this.log(`[Smart Pull] Changes API returned ${changes.changes.length} changes`);

        const tasks: (() => Promise<void>)[] = [];
        let completed = 0;

        for (const change of changes.changes) {
            if (change.removed) {
                // File was deleted on remote
                const pathToDelete = Object.entries(this.index).find(
                    ([, entry]) => entry.fileId === change.fileId,
                )?.[0];

                if (pathToDelete && pathToDelete !== this.pluginDataPath) {
                    tasks.push(async () => {
                        try {
                            const file = this.app.vault.getAbstractFileByPath(pathToDelete);
                            if (file) {
                                await this.app.vault.trash(file, true);
                            }
                            delete this.index[pathToDelete];
                            completed++;
                            await this.log(`[Smart Pull] Deleted: ${pathToDelete}`);
                            if (this.settings.showDetailedNotifications || !isSilent) {
                                new Notice(`🗑️ ${pathToDelete.split("/").pop()}`);
                            }
                        } catch (e) {
                            await this.log(`[Smart Pull] Delete failed: ${pathToDelete} - ${e}`);
                        }
                    });
                }
            } else if (change.file && change.file.kind === "file") {
                // File was added or modified
                const cloudFile = change.file;
                if (cloudFile.path === this.pluginDataPath) continue;
                if (this.shouldIgnore(cloudFile.path)) continue;

                // Skip if local index hash matches (already synced by this client)
                const localEntry = this.index[cloudFile.path];
                if (
                    localEntry?.hash &&
                    cloudFile.hash &&
                    localEntry.hash.toLowerCase() === cloudFile.hash.toLowerCase()
                ) {
                    await this.log(`[Smart Pull] Skipping (hash match): ${cloudFile.path}`);
                    continue;
                }

                tasks.push(async () => {
                    try {
                        // Mark as syncing to prevent dirty marking from modify event
                        this.syncingPaths.add(cloudFile.path);

                        await this.ensureLocalFolder(cloudFile.path);
                        const content = await this.adapter.downloadFile(cloudFile.id);
                        await this.app.vault.adapter.writeBinary(cloudFile.path, content);

                        const stat = await this.app.vault.adapter.stat(cloudFile.path);
                        this.index[cloudFile.path] = {
                            fileId: cloudFile.id,
                            mtime: stat?.mtime || cloudFile.mtime,
                            size: stat?.size || cloudFile.size,
                            hash: cloudFile.hash,
                        };

                        completed++;
                        await this.log(`[Smart Pull] Downloaded: ${cloudFile.path}`);
                        if (this.settings.showDetailedNotifications || !isSilent) {
                            new Notice(`⬇️ ${cloudFile.path.split("/").pop()}`);
                        }
                    } catch (e) {
                        await this.log(`[Smart Pull] Download failed: ${cloudFile.path} - ${e}`);
                    } finally {
                        this.syncingPaths.delete(cloudFile.path);
                    }
                });
            }
        }

        if (tasks.length > 0) {
            this.onActivityStart();
            try {
                await this.runParallel(tasks);
            } finally {
                this.onActivityEnd();
            }
        }

        if (changes.newStartPageToken) {
            this.startPageToken = changes.newStartPageToken;
        }
        await this.saveIndex();

        if (tasks.length > 0) {
            new Notice(`⬇️ ${this.t("pullCompleted")} (${tasks.length} changes)`);
            return true;
        }
        return false;
    }

    /**
     * Smart Push - upload only dirty files
     * O(1) when no dirty files, O(dirty count + .obsidian scan) otherwise
     * If scanVault is true, performs O(N) full vault scan before pushing
     */
    private async smartPush(isSilent: boolean, scanVault: boolean): Promise<boolean> {
        // Optional complete vault scan (for startup)
        if (scanVault) {
            await this.scanVaultChanges();
        }

        // Scan .obsidian files for changes (vault events don't fire for these)
        await this.scanObsidianChanges();

        if (this.dirtyPaths.size === 0) {
            await this.log("[Smart Push] No dirty files to push. Skipping.");
            return false;
        }

        await this.log(`[Smart Push] Pushing ${this.dirtyPaths.size} dirty files...`);

        // Prepare upload queue from dirty paths
        // Store content buffer to avoid re-reading (prevents data loss during active editing)
        const uploadQueue: Array<{
            path: string;
            mtime: number;
            size: number;
            content: ArrayBuffer;
        }> = [];
        const deleteQueue: string[] = [];

        for (const path of this.dirtyPaths) {
            if (this.shouldIgnore(path)) continue;

            const exists = await this.app.vault.adapter.exists(path);
            if (exists) {
                const stat = await this.app.vault.adapter.stat(path);
                if (stat) {
                    // OPTIONAL: Double check hash one last time before upload queue?
                    // But scan already did it. If markDirty came from event, we might want to check here.
                    // For now, let's calculate hash to store in queue so we don't have to read file twice if possible,
                    // OR just queue it and let uploadFile handle it.
                    // The user wants to avoid PUSH if hash is same.
                    // Since dirtyPaths can come from `markDirty` (events) which didn't check hash,
                    // we MUST check hash here to filter out "false alarms" from events.
                    try {
                        const content = await this.app.vault.adapter.readBinary(path);
                        // Get mtime AFTER reading content to ensure consistency
                        const statAfterRead = await this.app.vault.adapter.stat(path);
                        const mtimeAfterRead = statAfterRead?.mtime ?? stat.mtime;

                        const currentHash = md5(content);
                        const indexEntry = this.index[path];

                        // If index has hash and it matches current, SKIP upload
                        if (indexEntry?.hash && indexEntry.hash.toLowerCase() === currentHash) {
                            // match! update mtime and skip
                            this.index[path].mtime = mtimeAfterRead;
                            await this.log(`[Smart Push] Skipped (hash match): ${path}`);
                            continue;
                        }

                        // Hash differs or new file -> Queue for upload with buffered content
                        uploadQueue.push({
                            path,
                            mtime: mtimeAfterRead,
                            size: content.byteLength,
                            content,
                        });
                    } catch (e) {
                        await this.log(`[Smart Push] Failed to read ${path} for hash check: ${e}`);
                    }
                }
            } else {
                // File was deleted locally
                if (this.index[path]) {
                    deleteQueue.push(path);
                }
            }
        }

        const totalOps = uploadQueue.length + deleteQueue.length;
        if (totalOps === 0) {
            await this.log("[Smart Push] No changes after filtering.");
            return false;
        }

        this.onActivityStart();
        try {
            // Ensure folders exist on remote
            // OPTIMIZATION: Removed listFiles() call here. We just pass the folders we need.
            // The adapter's ensureFoldersExist is smart enough to check existence efficiently (O(depth) vs O(total_files))
            const foldersToCreate = new Set<string>();
            for (const file of uploadQueue) {
                const parts = file.path.split("/");
                for (let i = 1; i < parts.length; i++) {
                    foldersToCreate.add(parts.slice(0, i).join("/"));
                }
            }

            if (foldersToCreate.size > 0) {
                const sortedFolders = Array.from(foldersToCreate).sort(
                    (a, b) => a.length - b.length,
                );
                await this.adapter.ensureFoldersExist(sortedFolders);
            }

            // Execute uploads and deletions
            const tasks: (() => Promise<void>)[] = [];
            let completed = 0;

            for (const file of uploadQueue) {
                tasks.push(async () => {
                    try {
                        // Check if file was modified after queue creation (user still typing)
                        const currentStat = await this.app.vault.adapter.stat(file.path);
                        if (currentStat && currentStat.mtime !== file.mtime) {
                            // File was modified after queue creation - re-mark as dirty and skip
                            this.dirtyPaths.add(file.path);
                            await this.log(
                                `[Smart Push] Skipped (modified during sync): ${file.path}`,
                            );
                            return;
                        }

                        // Use buffered content from queue creation (no re-read)
                        const uploaded = await this.adapter.uploadFile(
                            file.path,
                            file.content,
                            file.mtime,
                        );

                        this.index[file.path] = {
                            fileId: uploaded.id,
                            mtime: file.mtime,
                            size: uploaded.size,
                            hash: uploaded.hash,
                        };

                        // Success: Remove from dirtyPaths
                        this.dirtyPaths.delete(file.path);

                        completed++;
                        await this.log(
                            `[Smart Push] [${completed}/${totalOps}] Pushed: ${file.path}`,
                        );
                        if (this.settings.showDetailedNotifications || !isSilent) {
                            new Notice(`⬆️ ${file.path.split("/").pop()}`);
                        }
                    } catch (e) {
                        await this.log(`[Smart Push] Upload failed: ${file.path} - ${e}`);
                    }
                });
            }

            for (const path of deleteQueue) {
                tasks.push(async () => {
                    try {
                        const entry = this.index[path];
                        if (entry) {
                            await this.adapter.deleteFile(entry.fileId);
                            delete this.index[path];

                            // Success: Remove from dirtyPaths
                            this.dirtyPaths.delete(path);

                            completed++;
                            await this.log(
                                `[Smart Push] [${completed}/${totalOps}] Deleted remote: ${path}`,
                            );
                            if (this.settings.showDetailedNotifications || !isSilent) {
                                new Notice(`🗑️ ${path.split("/").pop()} (Remote)`);
                            }
                        }
                    } catch (e) {
                        await this.log(`[Smart Push] Delete failed: ${path} - ${e}`);
                    }
                });
            }

            await this.runParallel(tasks);

            // Do NOT clear all dirty paths here.
            // Items are removed from dirtyPaths individually upon success in the tasks above.
            // This ensures that failed items remain dirty and will be retried.

            // Upload updated index
            await this.saveIndex();
            try {
                const indexContent = await this.app.vault.adapter.readBinary(this.pluginDataPath);
                const compressedIndex = await this.compress(indexContent);
                const uploadedIndex = await this.adapter.uploadFile(
                    this.pluginDataPath,
                    compressedIndex,
                    Date.now(),
                );
                this.index[this.pluginDataPath] = {
                    fileId: uploadedIndex.id,
                    mtime: Date.now(),
                    size: uploadedIndex.size,
                    hash: uploadedIndex.hash,
                };

                // Upload raw index backup (best effort, uncompressed)
                const rawPath = this.pluginDataPath.replace(".json", "_raw.json");
                try {
                    if (await this.app.vault.adapter.exists(rawPath)) {
                        const rawContent = await this.app.vault.adapter.readBinary(rawPath);
                        await this.adapter.uploadFile(rawPath, rawContent, Date.now());
                        await this.log(`[Smart Push] Raw index backup uploaded.`);
                    }
                } catch (rawErr) {
                    await this.log(`[Smart Push] Failed to upload raw index: ${rawErr}`);
                }

                await this.saveIndex();
                await this.log(`[Smart Push] Index uploaded. Hash: ${uploadedIndex.hash}`);
            } catch (e) {
                await this.log(`[Smart Push] Failed to upload index: ${e}`);
            }

            if (totalOps > 0) {
                new Notice(`⬆️ ${this.t("pushCompleted")} (${totalOps} files)`);
            }
            return true;
        } finally {
            this.onActivityEnd();
        }
    }

    /**
     * Request Background Full Scan - low priority, can be interrupted
     * @param resume If true, try to resume from previous progress
     */
    async requestBackgroundScan(resume: boolean = false): Promise<void> {
        // Don't start if already syncing
        if (this.syncState !== "IDLE") {
            await this.log("[Full Scan] Skipped - sync already in progress");
            return;
        }

        // Check if we should resume or start fresh
        if (!resume || !this.fullScanProgress || this.isProgressStale()) {
            this.fullScanProgress = null;
        }

        this.syncState = "FULL_SCANNING";
        this.isInterrupted = false;
        this.currentSyncPromise = this.executeFullScan();

        try {
            await this.currentSyncPromise;
        } finally {
            if (this.syncState === "FULL_SCANNING") {
                this.syncState = "IDLE";
            }
            this.currentSyncPromise = null;
        }
    }

    /**
     * Check if stored progress is too old
     */
    private isProgressStale(): boolean {
        if (!this.fullScanProgress) return true;
        return Date.now() - this.fullScanProgress.startedAt > this.FULL_SCAN_MAX_AGE_MS;
    }

    /**
     * Execute Full Scan with interrupt support
     */
    private async executeFullScan(): Promise<void> {
        try {
            await this.log("=== BACKGROUND FULL SCAN START ===");

            // Initialize or resume progress
            if (!this.fullScanProgress) {
                await this.log("[Full Scan] Fetching file lists...");
                const localFiles = await this.getLocalFiles();
                const remoteFiles = await this.adapter.listFiles();

                // Check for interrupt after heavy listing operation
                if (this.isInterrupted) {
                    this.syncState = "PAUSED"; // Or IDLE handled by finally/caller logic?
                    // Actually requestSmartSync handles the state transition after this promise resolves.
                    // But we should stop here.
                    return;
                }

                this.fullScanProgress = {
                    currentIndex: 0,
                    totalFiles: remoteFiles.length,
                    localFiles: localFiles.map((f) => ({
                        path: f.path,
                        mtime: f.mtime,
                        size: f.size,
                    })),
                    remoteFiles: remoteFiles.map((f) => ({
                        id: f.id,
                        path: f.path,
                        mtime: f.mtime,
                        size: f.size,
                        hash: f.hash,
                    })),
                    startedAt: Date.now(),
                };
            } else {
                await this.log(
                    `[Full Scan] Resuming from index ${this.fullScanProgress.currentIndex}/${this.fullScanProgress.totalFiles}`,
                );
            }

            const { localFiles, remoteFiles } = this.fullScanProgress;
            const localPathsMap = new Map(localFiles.map((f) => [f.path, f]));
            const CHUNK_SIZE = 10; // Process in chunks to allow interruption

            // Process remote files in chunks
            while (this.fullScanProgress.currentIndex < remoteFiles.length) {
                // Check for interrupt
                if (this.isInterrupted) {
                    await this.log(
                        `[Full Scan] Interrupted at index ${this.fullScanProgress.currentIndex}`,
                    );
                    this.syncState = "PAUSED";
                    return;
                }

                const chunk = remoteFiles.slice(
                    this.fullScanProgress.currentIndex,
                    this.fullScanProgress.currentIndex + CHUNK_SIZE,
                );

                for (const remoteFile of chunk) {
                    if (remoteFile.path === this.pluginDataPath) continue;
                    if (this.shouldIgnore(remoteFile.path)) continue;

                    const localFile = localPathsMap.get(remoteFile.path);
                    const indexEntry = this.index[remoteFile.path];

                    // Check for discrepancies
                    if (!localFile && indexEntry) {
                        // File exists in index but not locally - might have been deleted
                        await this.log(
                            `[Full Scan] Discrepancy: ${remoteFile.path} in index but not local`,
                        );
                    } else if (localFile && !indexEntry && remoteFile.hash) {
                        // File exists locally but not in index - check if it matches remote
                        try {
                            const content = await this.app.vault.adapter.readBinary(
                                remoteFile.path,
                            );
                            const localHash = md5(content);
                            if (localHash === remoteFile.hash.toLowerCase()) {
                                // Adopt into index
                                this.index[remoteFile.path] = {
                                    fileId: remoteFile.id,
                                    mtime: localFile.mtime,
                                    size: localFile.size,
                                    hash: remoteFile.hash,
                                };
                                await this.log(`[Full Scan] Adopted: ${remoteFile.path}`);
                            }
                        } catch {
                            // Ignore hash calculation errors
                        }
                    }
                }

                this.fullScanProgress.currentIndex += chunk.length;

                // Yield to allow interrupt check
                await new Promise((resolve) => setTimeout(resolve, 0));
            }

            // Scan completed
            await this.log("=== BACKGROUND FULL SCAN COMPLETED ===");
            this.fullScanProgress = null;
            await this.saveIndex();
        } catch (e) {
            await this.log(`[Full Scan] Error: ${e}`);
            this.fullScanProgress = null;
        }
    }

    // =========================================================================================
    // History Management
    // =========================================================================================

    get supportsHistory(): boolean {
        return this.adapter.supportsHistory ?? false;
    }

    async listRevisions(path: string): Promise<import("./types/adapter").FileRevision[]> {
        if (!this.adapter.supportsHistory || !this.adapter.listRevisions) {
            throw new Error(
                this.t("historyNotSupported") || "Cloud adapter does not support history.",
            );
        }
        return await this.adapter.listRevisions(path);
    }

    async getRevisionContent(path: string, revisionId: string): Promise<ArrayBuffer> {
        if (!this.adapter.supportsHistory || !this.adapter.getRevisionContent) {
            throw new Error(
                this.t("historyNotSupported") || "Cloud adapter does not support history.",
            );
        }

        // Try cache first
        const cached = await this.revisionCache.get(path, revisionId);
        if (cached) {
            return cached;
        }

        const content = await this.adapter.getRevisionContent(path, revisionId);

        // Save to cache
        await this.revisionCache.set(path, revisionId, content);

        return content;
    }

    async setRevisionKeepForever(
        path: string,
        revisionId: string,
        keepForever: boolean,
    ): Promise<void> {
        if (!this.adapter.supportsHistory || !this.adapter.setRevisionKeepForever) {
            throw new Error(
                this.t("historyNotSupported") || "Cloud adapter does not support history.",
            );
        }
        await this.adapter.setRevisionKeepForever(path, revisionId, keepForever);
        await this.log(`[History] Set keepForever=${keepForever} for ${path} (rev: ${revisionId})`);
    }

    async restoreRevision(
        path: string,
        revision: import("./types/adapter").FileRevision,
    ): Promise<void> {
        await this.log(`[History] Starting rollback for ${path} to revision ${revision.id}`);
        try {
            const content = await this.getRevisionContent(path, revision.id);

            // Overwrite local file
            // TFileを取得してmodifyBinaryを使うのがObsidianのお作法
            const file = this.app.vault.getAbstractFileByPath(path);
            if (file instanceof TFile) {
                await this.app.vault.modifyBinary(file, content);
            } else {
                // ファイルが存在しない（削除された）場合は再作成
                await this.app.vault.createBinary(path, content);
            }

            // Logging (Audit)
            const timestamp = new Date().toISOString();
            await this.log(
                `[History] Rollback executed: File=${path}, Revision=${revision.id}, Time=${timestamp}`,
            );

            // Note: modifyBinary triggers 'modify' event, which calls markDirty via main.ts listener.
            // So we don't need to manually call markDirty.
            new Notice("File restored. Syncing changes...");
        } catch (e) {
            await this.log(`[History] Rollback failed: ${e}`);
            throw e;
        }
    }
}
