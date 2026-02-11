import { CloudAdapter } from "../types/adapter";
import { App, TFile, TFolder, TAbstractFile, Notice } from "obsidian";
import { normalizePath } from "../utils/path";
import { matchWildcard } from "../utils/wildcard";
import { md5 } from "../utils/md5";
import { RevisionCache } from "../revision-cache";
import { diff_match_patch } from "diff-match-patch";
import { SETTINGS_LIMITS } from "../constants";
import type {
    SyncManagerSettings,
    LocalFileIndex,
    SyncState,
    FullScanProgress,
    MergeLockEntry,
    CommunicationData,
} from "./types";
import {
    PLUGIN_DIR,
    INTERNAL_LOCAL_ONLY,
    INTERNAL_REMOTE_MANAGED,
    SYSTEM_IGNORES,
    OBSIDIAN_SYSTEM_IGNORES,
    OBSIDIAN_WORKSPACE_FILES,
    ensureLocalFolder as _ensureLocalFolder,
    listFilesRecursive as _listFilesRecursive,
    getLocalFiles as _getLocalFiles,
    compress as _compress,
    tryDecompress as _tryDecompress,
    runParallel as _runParallel,
    isManagedSeparately as _isManagedSeparately,
    shouldNotBeOnRemote as _shouldNotBeOnRemote,
    shouldIgnore as _shouldIgnore,
} from "./file-utils";
import type { SyncContext } from "./context";
import {
    loadCommunication as _loadCommunication,
    saveCommunication as _saveCommunication,
    acquireMergeLock as _acquireMergeLock,
    releaseMergeLock as _releaseMergeLock,
    checkMergeLock as _checkMergeLock,
    loadIndex as _loadIndex,
    loadLocalIndex as _loadLocalIndex,
    saveIndex as _saveIndex,
    saveLocalIndex as _saveLocalIndex,
    resetIndex as _resetIndex,
    clearPendingPushStates as _clearPendingPushStates,
    markDirty as _markDirty,
    markDeleted as _markDeleted,
    markFolderDeleted as _markFolderDeleted,
    markRenamed as _markRenamed,
    markFolderRenamed as _markFolderRenamed,
    getSyncState as _getSyncState,
    hasDirtyFiles as _hasDirtyFiles,
    isFreshStart as _isFreshStart,
} from "./state";
import {
    supportsHistory as _supportsHistory,
    listRevisions as _listRevisions,
    getRevisionContent as _getRevisionContent,
    setRevisionKeepForever as _setRevisionKeepForever,
    deleteRevision as _deleteRevision,
    restoreRevision as _restoreRevision,
} from "./history";
export type { SyncManagerSettings, LocalFileIndex, SyncState, FullScanProgress, CommunicationData };

export class SyncManager {
    // Constants delegated to file-utils.ts
    private static readonly PLUGIN_DIR = PLUGIN_DIR;
    private static readonly INTERNAL_LOCAL_ONLY = INTERNAL_LOCAL_ONLY;
    private static readonly INTERNAL_REMOTE_MANAGED = INTERNAL_REMOTE_MANAGED;
    private static readonly SYSTEM_IGNORES = SYSTEM_IGNORES;
    private static readonly OBSIDIAN_SYSTEM_IGNORES = OBSIDIAN_SYSTEM_IGNORES;
    private static readonly OBSIDIAN_WORKSPACE_FILES = OBSIDIAN_WORKSPACE_FILES;

    private index: LocalFileIndex = {};
    private localIndex: LocalFileIndex = {};
    private localIndexPath: string;
    private startPageToken: string | null = null;
    private deviceId: string = "";

    /** Remote path for communication.json (merge locks, device messaging) */
    private communicationPath: string = "";

    private logFolder: string;
    private revisionCache: RevisionCache;

    // === Hybrid Sync State ===
    /** Current sync state for preemption control */
    private syncState: SyncState = "IDLE";
    /** Dirty paths that need to be pushed (modified locally) */
    private dirtyPaths: Set<string> = new Set();
    /** Paths currently being synced (to prevent re-marking as dirty) */
    private syncingPaths: Set<string> = new Set();
    /** Folders deleted locally that should be deleted remotely */
    private deletedFolders: Set<string> = new Set();
    /** Paths deleted during pull (to prevent re-upload as "new" if local deletion fails) */
    private recentlyDeletedFromRemote: Set<string> = new Set();
    /** Flag to interrupt running full scan */
    private isInterrupted = false;
    /** Progress for resumable full scan */
    private fullScanProgress: FullScanProgress | null = null;
    /** Promise for current running sync operation (for awaiting) */
    private currentSyncPromise: Promise<void> | null = null;
    /** Maximum age for full scan progress before reset (5 minutes) */
    private readonly FULL_SCAN_MAX_AGE_MS = 5 * 60 * 1000;

    private forceCleanupNextSync: boolean = false;
    private indexLoadFailed = false;

    public isSyncing(): boolean {
        return this.syncState !== "IDLE";
    }

    private onActivityStart: () => void = () => {};
    private onActivityEnd: () => void = () => {};
    private isSpinning = false;

    private startActivity() {
        if (!this.isSpinning) {
            this.isSpinning = true;
            this.onActivityStart();
        }
    }

    private endActivity() {
        if (this.isSpinning) {
            this.isSpinning = false;
            this.onActivityEnd();
        }
    }

    private syncRequestedWhileSyncing: boolean = false;
    private nextSyncParams: { isSilent: boolean; scanVault: boolean } | null = null;

    constructor(
        private app: App,
        private adapter: CloudAdapter,
        private pluginDataPath: string,

        private settings: SyncManagerSettings,
        private pluginDir: string,
        public t: (key: string) => string,
    ) {
        // Initial log folder before device ID is known
        this.logFolder = `${this.pluginDir}/logs/_startup`;
        this.localIndexPath = `${this.pluginDir}/data/local/local-index.json`;
        // communication.json is in the data/remote directory
        this.communicationPath = this.pluginDataPath.replace(
            "sync-index.json",
            "communication.json",
        );
        this.adapter.setLogger((msg) => this.log(msg));
        this.revisionCache = new RevisionCache(this.app, this.pluginDir);
    }

    /**
     * API to manually trigger a full cleanup scan on the next sync cycle.
     * Used when exclusion patterns are updated.
     */
    public triggerFullCleanup() {
        this.forceCleanupNextSync = true;
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

    /**
     * Helper to show notification and log it.
     * @param message The message to display/log
     * @param isDetailed If true, only show UI notice if notificationLevel is "verbose" (Detailed)
     * @param isSilent If true, suppress UI notice unless level is "verbose"
     */
    public async notify(message: string, isDetailed: boolean = false, isSilent: boolean = false) {
        const level = this.settings.notificationLevel;
        if (level === "error") {
            await this.log(`[Silent Notice (ErrorLevel)] ${message}`);
            return;
        }

        const showVerbose = level === "verbose";
        let shouldShow = false;

        if (isDetailed) {
            // Detailed Events (File-specific: Pushing file, Pulling file, Trash file, Merging file)
            // Identify if it's a "low priority" detailed event (Push/Pull)
            const isLowPriority =
                message.includes(this.t("noticeFilePulled")) ||
                message.includes(this.t("noticeFilePushed")) ||
                message.includes("📤") ||
                message.includes("📥");

            if (isLowPriority) {
                // Push/Pull: Hide if silent (Startup/Auto) unless in Verbose.
                shouldShow = showVerbose || !isSilent;
            } else {
                // Trash and Merge: Matrix says ALWAYS show in both Verbose and Standard.
                shouldShow = true;
            }
        } else {
            // Generic Status (Syncing..., Completed, Up to date, Scanning...)
            // Identify messages that should be hidden in silent (background) scenarios
            const isSilentSuppressed =
                message.includes(this.t("noticeSyncing")) ||
                message.includes("⚡") ||
                message.includes(this.t("noticeScanningLocalFiles")) ||
                message.includes("🔍") ||
                message.includes(this.t("noticeVaultUpToDate"));

            if (isSilentSuppressed) {
                // "Syncing...", "Scanning...", "Up to date": Hide if silent (Startup/Auto).
                shouldShow = !isSilent;
            } else {
                // "Completed", "Confirmation", etc.: Always show.
                shouldShow = true;
            }
        }

        if (shouldShow) {
            new Notice(message);
            await this.log(`[Notice] ${message}`);
        } else {
            await this.log(`[Silent Notice] ${message}`);
        }
    }

    private async ensureLocalFolder(filePath: string) {
        return _ensureLocalFolder(this as unknown as SyncContext, filePath);
    }

    private clearPendingPushStates(): void {
        _clearPendingPushStates(this as unknown as SyncContext);
    }

    // === Communication.json Management (delegated to state.ts) ===
    private async loadCommunication(): Promise<CommunicationData> {
        return _loadCommunication(this as unknown as SyncContext);
    }

    private async saveCommunication(data: CommunicationData): Promise<void> {
        return _saveCommunication(this as unknown as SyncContext, data);
    }

    private async acquireMergeLock(path: string): Promise<{ acquired: boolean; holder?: string; expiresIn?: number }> {
        return _acquireMergeLock(this as unknown as SyncContext, path);
    }

    private async releaseMergeLock(path: string, logPrefix?: string): Promise<void> {
        return _releaseMergeLock(this as unknown as SyncContext, path, logPrefix);
    }

    private async checkMergeLock(path: string): Promise<{ locked: boolean; holder?: string; expiresIn?: number }> {
        return _checkMergeLock(this as unknown as SyncContext, path);
    }

    // === Index Management (delegated to state.ts) ===
    async loadIndex() {
        return _loadIndex(this as unknown as SyncContext, (data) => this.tryDecompress(data));
    }

    async loadLocalIndex() {
        return _loadLocalIndex(this as unknown as SyncContext);
    }

    async saveIndex() {
        return _saveIndex(this as unknown as SyncContext);
    }

    async saveLocalIndex() {
        return _saveLocalIndex(this as unknown as SyncContext);
    }

    async resetIndex() {
        return _resetIndex(this as unknown as SyncContext);
    }

    private async runParallel<T>(
        tasks: (() => Promise<T>)[],
        concurrency: number = this.settings.concurrency,
    ): Promise<T[]> {
        return _runParallel(tasks, concurrency);
    }

    private async listFilesRecursive(path: string): Promise<string[]> {
        return _listFilesRecursive(this as unknown as SyncContext, path);
    }

    private async getLocalFiles() {
        return _getLocalFiles(this as unknown as SyncContext);
    }

    // === Compression Helpers (delegated to file-utils.ts) ===
    private async compress(data: ArrayBuffer): Promise<ArrayBuffer> {
        return _compress(data);
    }

    private async tryDecompress(data: ArrayBuffer): Promise<ArrayBuffer> {
        return _tryDecompress(data);
    }

    // === Path Filtering (delegated to file-utils.ts) ===
    private isManagedSeparately(path: string): boolean {
        return _isManagedSeparately(path);
    }

    private shouldNotBeOnRemote(path: string): boolean {
        return _shouldNotBeOnRemote(this as unknown as SyncContext, path);
    }

    public shouldIgnore(path: string): boolean {
        return _shouldIgnore(this as unknown as SyncContext, path);
    }

    // ==========================================================================
    // Hybrid Sync Implementation (Smart Sync + Interruptible Background Scan)
    // ==========================================================================

    markDirty(path: string) {
        _markDirty(this as unknown as SyncContext, path);
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

                const indexEntry = this.localIndex[filePath];

                // New file (not in local index)
                if (!indexEntry) {
                    // Skip if this file was recently deleted from remote
                    // (prevents re-upload when local deletion failed)
                    if (this.recentlyDeletedFromRemote.has(filePath)) {
                        await this.log(
                            `[Obsidian Scan] Skipped (recently deleted from remote): ${filePath}`,
                        );
                        continue;
                    }
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
                            await this.log(
                                `[Obsidian Scan] Modified (hash mismatch vs localIndex): ${filePath}`,
                            );
                        } else if (!indexEntry.hash) {
                            // No previous hash, but mtime changed. Assume dirty to be safe and update hash.
                            this.dirtyPaths.add(filePath);
                            await this.log(
                                `[Obsidian Scan] Modified (no prev hash in localIndex): ${filePath}`,
                            );
                        } else {
                            // Hash matches, just update mtime in indices to avoid future re-hashing
                            this.localIndex[filePath].mtime = stat.mtime;
                            if (this.index[filePath]) {
                                this.index[filePath].mtime = stat.mtime;
                            }
                            // await this.log(`[Obsidian Scan] Skipped (hash match): ${filePath}`);
                        }
                    } catch {
                        // Read failed, assume dirty
                        this.dirtyPaths.add(filePath);
                    }
                }
            }

            // Check for deleted or now-ignored .obsidian files
            const currentObsidianFiles = new Set(obsidianFiles);
            for (const path of Object.keys(this.localIndex)) {
                if (!path.startsWith(".obsidian/")) continue;
                if (path === this.pluginDataPath) continue;
                if (this.isManagedSeparately(path)) continue;

                const isIgnored = this.shouldNotBeOnRemote(path);
                const isMissing = !currentObsidianFiles.has(path);

                if (isMissing || isIgnored) {
                    if (this.index[path]) {
                        this.dirtyPaths.add(path);
                        await this.log(
                            `[Obsidian Scan] Marked for remote deletion (${isMissing ? "missing" : "ignored"}): ${path}`,
                        );
                    } else {
                        // Cleanup local-only entries without marking as dirty for remote deletion
                        delete this.localIndex[path];
                        this.dirtyPaths.delete(path);
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

                const indexEntry = this.localIndex[file.path];

                if (!indexEntry) {
                    // Skip if this file was recently deleted from remote
                    // (prevents re-upload when local deletion failed)
                    if (this.recentlyDeletedFromRemote.has(file.path)) {
                        await this.log(
                            `[Vault Scan] Skipped (recently deleted from remote): ${file.path}`,
                        );
                        continue;
                    }
                    // New file (not in local index)
                    this.dirtyPaths.add(file.path);
                    await this.log(`[Vault Scan] New: ${file.path}`);
                } else if (file.stat.mtime > indexEntry.mtime) {
                    // Mtime changed: verify content hash
                    try {
                        const content = await this.app.vault.adapter.readBinary(file.path);
                        const localHash = md5(content);

                        if (indexEntry.hash && localHash !== indexEntry.hash.toLowerCase()) {
                            this.dirtyPaths.add(file.path);
                            await this.log(
                                `[Vault Scan] Modified (hash mismatch vs localIndex): ${file.path}`,
                            );
                        } else if (!indexEntry.hash) {
                            this.dirtyPaths.add(file.path);
                            await this.log(
                                `[Vault Scan] Modified (no prev hash in localIndex): ${file.path}`,
                            );
                        } else {
                            // Hash matches, update indices mtime
                            this.localIndex[file.path].mtime = file.stat.mtime;
                            if (this.index[file.path]) {
                                this.index[file.path].mtime = file.stat.mtime;
                            }
                        }
                    } catch (e) {
                        // Read failed
                        await this.log(`[Vault Scan] Hash check failed for ${file.path}: ${e}`);
                    }
                }
            }

            // 2. Check for Deleted or now-Ignored files (in localIndex but not in vault/now ignored)
            for (const path of Object.keys(this.localIndex)) {
                // Skip .obsidian files (handled by scanObsidianChanges)
                if (path.startsWith(".obsidian/")) continue;
                if (path === this.pluginDataPath) continue;
                if (this.isManagedSeparately(path)) continue;

                const isIgnored = this.shouldNotBeOnRemote(path);
                const isMissing = !currentPaths.has(path);

                if (isMissing || isIgnored) {
                    if (this.index[path]) {
                        this.dirtyPaths.add(path);
                        await this.log(
                            `[Vault Scan] Marked for remote deletion (${isMissing ? "missing" : "ignored"}): ${path}`,
                        );
                    } else {
                        // Cleanup local-only entries without marking as dirty for remote deletion
                        delete this.localIndex[path];
                        this.dirtyPaths.delete(path);
                    }
                }
            }

            await this.log(`[Vault Scan] Completed in ${Date.now() - start}ms`);
        } catch (e) {
            await this.log(`[Vault Scan] Error: ${e}`);
        }
    }

    // === Dirty Tracking & State Queries (delegated to state.ts) ===
    markDeleted(path: string) {
        _markDeleted(this as unknown as SyncContext, path);
    }

    markFolderDeleted(folderPath: string) {
        _markFolderDeleted(this as unknown as SyncContext, folderPath);
    }

    markRenamed(oldPath: string, newPath: string) {
        _markRenamed(this as unknown as SyncContext, oldPath, newPath);
    }

    markFolderRenamed(oldFolderPath: string, newFolderPath: string) {
        _markFolderRenamed(this as unknown as SyncContext, oldFolderPath, newFolderPath);
    }

    getSyncState(): SyncState {
        return _getSyncState(this as unknown as SyncContext);
    }

    hasDirtyFiles(): boolean {
        return _hasDirtyFiles(this as unknown as SyncContext);
    }

    isFreshStart(): boolean {
        return _isFreshStart(this as unknown as SyncContext);
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
        // If already smart syncing, mark that we need another pass after and wait.
        if (this.syncState === "SMART_SYNCING") {
            this.syncRequestedWhileSyncing = true;
            if (!this.nextSyncParams) {
                this.nextSyncParams = { isSilent, scanVault };
            } else {
                // Merge requirements: if any request is NOT silent, the next pass should not be silent.
                // If any request wants a full scan, the next pass should scan.
                this.nextSyncParams.isSilent = this.nextSyncParams.isSilent && isSilent;
                this.nextSyncParams.scanVault = this.nextSyncParams.scanVault || scanVault;
            }

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

        let currentIsSilent = isSilent;
        let currentScanVault = scanVault;

        // Execute smart sync with re-queueing support
        do {
            this.syncRequestedWhileSyncing = false;
            this.syncState = "SMART_SYNCING";
            this.currentSyncPromise = this.executeSmartSync(currentIsSilent, currentScanVault);

            try {
                await this.currentSyncPromise;
            } finally {
                this.syncState = "IDLE";
                this.currentSyncPromise = null;
            }

            // If another request came in, prepare parameters for the next pass
            if (this.syncRequestedWhileSyncing && this.nextSyncParams) {
                currentIsSilent = this.nextSyncParams.isSilent;
                currentScanVault = this.nextSyncParams.scanVault;
                this.nextSyncParams = null;
            }
        } while (this.syncRequestedWhileSyncing);
    }

    /**
     * Execute Smart Sync logic
     * - Pull: Check remote changes via sync-index.json hash comparison (or Changes API)
     * - Push: Upload dirty files
     */
    private async executeSmartSync(isSilent: boolean, scanVault: boolean): Promise<void> {
        if (!isSilent) {
            this.startActivity();
        }
        try {
            await this.log("=== SMART SYNC START ===");
            await this.notify(this.t("noticeSyncing"), false, isSilent);

            // Clean up recentlyDeletedFromRemote: remove entries for files that no longer exist locally
            // (they were successfully deleted, so we don't need to track them anymore)
            for (const path of [...this.recentlyDeletedFromRemote]) {
                const exists = await this.app.vault.adapter.exists(path);
                if (!exists) {
                    this.recentlyDeletedFromRemote.delete(path);
                }
            }

            // Pre-warm adapter (ensure root folders exist) to avoid delay in push phase
            if (this.adapter.initialize) {
                await this.adapter.initialize();
            }

            // === PULL PHASE ===
            const pulled = await this.smartPull(isSilent);

            // === PUSH PHASE ===
            if (scanVault) {
                await this.notify(this.t("noticeScanningLocalFiles"), false, isSilent);
            }
            const pushed = await this.smartPush(isSilent, scanVault);

            // === CONFIRMATION PHASE (Initial Sync Only) ===
            // For initial sync (scanVault=true, isSilent=false) with Changes API support,
            // we immediately check for our own pushes to confirm identity and update ancestor hashes.
            // Skipped during startup sync (isSilent=true) since confirmation is only needed on first sync.
            if (pushed && scanVault && !isSilent && this.adapter.supportsChangesAPI) {
                await this.log(
                    "[Smart Sync] Initial sync push detected. Running immediate identity check...",
                );
                await this.notify(this.t("noticeInitialSyncConfirmation"), false, isSilent);

                await this.pullViaChangesAPI(isSilent, true);

                // Re-confirm completion after identity check
                await this.notify(
                    this.t("noticePushCompleted").replace("{0}", "1"),
                    false,
                    isSilent,
                );
            }

            if (!pulled && !pushed) {
                await this.notify(this.t("noticeVaultUpToDate"), false, isSilent);
            }

            await this.log("=== SMART SYNC COMPLETED ===");
        } catch (e) {
            await this.log(`Smart Sync failed: ${e}`);
            throw e;
        } finally {
            this.endActivity();
        }
    }

    /**
     * Smart Pull - O(1) check for remote changes using sync-index.json hash
     */
    private async smartPull(isSilent: boolean): Promise<boolean> {
        await this.log("[Smart Pull] Checking for remote changes...");

        // Check for active merge locks from other devices FIRST
        // This prevents race conditions where Changes API hasn't caught up yet
        const commData = await this.loadCommunication();
        const now = Date.now();
        for (const [path, lock] of Object.entries(commData.mergeLocks)) {
            if (lock.holder !== this.deviceId && lock.expiresAt > now) {
                await this.log(
                    `[Smart Pull] Active merge lock detected: ${path} by ${lock.holder} (expires in ${Math.round((lock.expiresAt - now) / 1000)}s)`,
                );
            }
        }

        // --- FORCED CLEANUP: Wipe forbidden system directories ---
        // We only do this if a full cleanup is requested (e.g., startup).
        if (this.forceCleanupNextSync) {
            for (const dirName of SyncManager.INTERNAL_LOCAL_ONLY) {
                if (dirName.endsWith("/")) {
                    const fullDirPath = SyncManager.PLUGIN_DIR + dirName.slice(0, -1);
                    try {
                        const meta = await this.adapter.getFileMetadata(fullDirPath);
                        if (meta?.id) {
                            await this.adapter.deleteFile(meta.id);
                            await this.log(
                                `[Smart Pull] [System Cleanup] Forced wipe of internal directory: ${fullDirPath}`,
                            );
                        }
                    } catch (e) {
                        // Ignore (already clean or not found)
                    }
                }
            }
        }

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
            // Sync confirmed - clear pending push/merge states
            this.clearPendingPushStates();
            await this.saveIndex();
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
        const toDownload: Array<{
            path: string;
            fileId: string;
            hash?: string;
            mergeLock?: { holder: string; expiresAt: number };
        }> = [];
        const toDeleteLocal: string[] = [];

        // Find files to download or cleanup
        const toDeleteRemote: Array<{ path: string; fileId: string }> = [];

        // Pre-calculate ID map for rename detection
        const localIdToPath = new Map<string, string>();
        for (const [p, entry] of Object.entries(this.index)) {
            if (entry.fileId) localIdToPath.set(entry.fileId, p);
        }

        for (const [path, remoteEntry] of Object.entries(remoteIndex)) {
            if (path === this.pluginDataPath) continue;
            if (this.isManagedSeparately(path)) continue;

            // NEW: リモートにあってはいけないファイルを見つけたら、即座に削除キューへ
            if (this.shouldNotBeOnRemote(path)) {
                toDeleteRemote.push({ path, fileId: remoteEntry.fileId });
                continue;
            }

            const localBaseEntry = this.localIndex[path];

            if (!localBaseEntry) {
                // Check if this fileId exists locally under a different name (Rename in progress)
                // If we renamed A -> B locally, remote still sees A.
                // We should NOT download A if we are about to push B (which patches A -> B).
                const renamedLocalPath = localIdToPath.get(remoteEntry.fileId);
                if (
                    renamedLocalPath &&
                    renamedLocalPath !== path &&
                    this.dirtyPaths.has(renamedLocalPath)
                ) {
                    await this.log(
                        `[Smart Pull] Skipped ghost file ${path} (renamed locally to ${renamedLocalPath})`,
                    );
                    continue;
                }

                // New file on remote (we don't even have a base for it)
                toDownload.push({
                    path,
                    fileId: remoteEntry.fileId,
                    hash: remoteEntry.hash,
                    mergeLock: remoteEntry.mergeLock,
                });
            } else if (
                remoteEntry.hash &&
                localBaseEntry.hash &&
                remoteEntry.hash.toLowerCase() !== localBaseEntry.hash.toLowerCase()
            ) {
                // Modified on remote (remote differs from our local base)
                toDownload.push({
                    path,
                    fileId: remoteEntry.fileId,
                    hash: remoteEntry.hash,
                    mergeLock: remoteEntry.mergeLock,
                });
            }
        }

        // Find files to delete locally (removed on remote)
        for (const path of Object.keys(this.localIndex)) {
            if (path === this.pluginDataPath) continue;
            if (this.shouldIgnore(path)) continue;

            if (!remoteIndex[path]) {
                const localBase = this.localIndex[path];
                const isModified =
                    this.dirtyPaths.has(path) ||
                    localBase?.lastAction === "push" ||
                    localBase?.lastAction === "merge";

                if (isModified) {
                    await this.log(
                        `[Smart Pull] Conflict: ${path} removed from remote but modified locally. Queuing for merge check.`,
                    );
                    toDownload.push({ path, fileId: "" } as any); // Dummy fileId for deletion conflict
                } else {
                    toDeleteLocal.push(path);
                }
            }
        }

        await this.log(
            `[Smart Pull] Changes: ${toDownload.length} to download, ${toDeleteLocal.length} to delete`,
        );

        if (toDownload.length === 0 && toDeleteLocal.length === 0) {
            await this.log("[Smart Pull] No file changes detected.");
            // Sync confirmed - clear pending push/merge states
            this.clearPendingPushStates();
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
                const success = await this.pullFileSafely(item, isSilent, "Smart Pull");
                if (success) {
                    completed++;
                    await this.log(`[Smart Pull] [${completed}/${total}] Synced: ${item.path}`);
                }
            });
        }

        // Delete local files that were removed on remote
        for (const path of toDeleteLocal) {
            // Track this path to prevent re-upload if local deletion fails
            this.recentlyDeletedFromRemote.add(path);
            tasks.push(async () => {
                try {
                    const file = this.app.vault.getAbstractFileByPath(path);
                    if (file) {
                        await this.app.vault.trash(file, true);
                    }
                    delete this.index[path];
                    delete this.localIndex[path];

                    completed++;
                    await this.log(`[Smart Pull] [${completed}/${total}] Deleted locally: ${path}`);
                    await this.notify(
                        `${this.t("noticeFileTrashed")}: ${path.split("/").pop()}`,
                        true,
                        isSilent,
                    );
                } catch (e) {
                    await this.log(`[Smart Pull] Delete failed: ${path} - ${e}`);
                }
            });
        }

        // Execute deletions for forbidden files found on remote
        if (toDeleteRemote.length > 0) {
            // Optimization: group by folders
            const foldersToWipe = new Set<string>();
            const separateFiles: Array<{ path: string; fileId: string }> = [];

            for (const item of toDeleteRemote) {
                const parts = item.path.split("/");
                let highestIgnoredParent: string | null = null;
                for (let i = 1; i < parts.length; i++) {
                    const parentPath = parts.slice(0, i).join("/");
                    if (this.shouldNotBeOnRemote(parentPath + "/")) {
                        highestIgnoredParent = parentPath;
                        break;
                    }
                }
                if (highestIgnoredParent) {
                    foldersToWipe.add(highestIgnoredParent);
                } else {
                    separateFiles.push(item);
                }
            }

            for (const folder of foldersToWipe) {
                tasks.push(async () => {
                    try {
                        const meta = await this.adapter.getFileMetadata(folder);
                        if (meta?.id) {
                            await this.adapter.deleteFile(meta.id);
                            await this.log(
                                `[Smart Pull] [Cleanup] Wiped forbidden folder: ${folder}`,
                            );
                            // Cleanup index entries
                            const prefix = folder + "/";
                            for (const path of Object.keys(this.index)) {
                                if (path.startsWith(prefix)) {
                                    delete this.index[path];
                                    delete this.localIndex[path];
                                }
                            }
                        }
                    } catch (e) {
                        await this.log(
                            `[Smart Pull] [Cleanup] Folder wipe failed: ${folder} - ${e}`,
                        );
                    }
                });
            }

            for (const file of separateFiles) {
                tasks.push(async () => {
                    try {
                        await this.adapter.deleteFile(file.fileId);
                        await this.log(
                            `[Smart Pull] [Cleanup] Deleted forbidden file: ${file.path}`,
                        );
                        delete this.index[file.path];
                        delete this.localIndex[file.path];
                    } catch (e) {
                        await this.log(
                            `[Smart Pull] [Cleanup] File delete failed: ${file.path} - ${e}`,
                        );
                    }
                });
            }
        }

        if (tasks.length > 0) {
            this.startActivity();
            try {
                await this.runParallel(tasks);
            } finally {
                // Keep spinning until executeSmartSync finishes
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
            await this.notify(
                this.t("noticePullCompleted").replace("{0}", total.toString()),
                false,
                false,
            );
            return true;
        }
        return false;
    }

    /**
     * Pull via Changes API (for adapters that support it)
     * @param isSilent Suppress notifications
     * @param drainAll If true, process all available pages of changes (useful after initial push)
     */
    private async pullViaChangesAPI(
        isSilent: boolean,
        drainAll: boolean = false,
    ): Promise<boolean> {
        if (!this.startPageToken) {
            this.startPageToken = await this.adapter.getStartPageToken();
            await this.saveIndex();
        }

        let hasTotalChanges = false;
        let currentPageToken = this.startPageToken;
        let confirmedCountTotal = 0;
        let pageCount = 1;
        let totalCompleted = 0;

        do {
            const changes = await this.adapter.getChanges(currentPageToken);

            if (changes.changes.length === 0) {
                await this.log("[Smart Pull] No changes from Changes API");
                if (changes.newStartPageToken) {
                    this.startPageToken = changes.newStartPageToken;
                    await this.saveIndex();
                }
                break; // No more changes
            }

            await this.log(
                `[Smart Pull] Changes API page processed (${changes.changes.length} items)`,
            );
            hasTotalChanges = true;

            // In confirmation mode, if we haven't confirmed anything yet, notify user about the wait
            if (drainAll && confirmedCountTotal === 0) {
                await this.notify(
                    `${this.t("noticeWaitingForRemoteRegistration")} (Page ${pageCount++})...`,
                    false,
                    isSilent,
                );
            }

            // Load communication data for mergeLock checks
            const commData = await this.loadCommunication();

            const tasks: (() => Promise<void>)[] = [];
            let completed = 0;

            // Pre-calculate ID map for rename detection (Ghost File Check)
            const localIdToPath = new Map<string, string>();
            for (const [p, entry] of Object.entries(this.index)) {
                if (entry.fileId) localIdToPath.set(entry.fileId, p);
            }

            for (const change of changes.changes) {
                if (change.removed) {
                    // File was deleted on remote
                    const pathToDelete = Object.entries(this.index).find(
                        ([, entry]) => entry.fileId === change.fileId,
                    )?.[0];

                    if (pathToDelete && pathToDelete !== this.pluginDataPath) {
                        // Track this path to prevent re-upload if local deletion fails
                        this.recentlyDeletedFromRemote.add(pathToDelete);
                        tasks.push(async () => {
                            try {
                                const file = this.app.vault.getAbstractFileByPath(pathToDelete);
                                if (file) {
                                    await this.app.vault.trash(file, true);
                                }
                                delete this.index[pathToDelete];
                                delete this.localIndex[pathToDelete]; // Added for consistency
                                completed++;
                                await this.log(`[Smart Pull] Deleted: ${pathToDelete}`);
                                await this.notify(
                                    `${this.t("noticeFileTrashed")}: ${pathToDelete.split("/").pop()}`,
                                    true,
                                    isSilent,
                                );
                            } catch (e) {
                                await this.log(
                                    `[Smart Pull] Delete failed: ${pathToDelete} - ${e}`,
                                );
                            }
                        });
                    }
                } else if (change.file && change.file.kind === "file") {
                    // File was added or modified
                    const cloudFile = change.file;
                    if (cloudFile.path === this.pluginDataPath) continue;
                    if (this.isManagedSeparately(cloudFile.path)) continue;

                    // NEW: もしリモート禁止対象ファイルが上がってきたら、即座に削除
                    if (this.shouldNotBeOnRemote(cloudFile.path)) {
                        tasks.push(async () => {
                            try {
                                await this.adapter.deleteFile(cloudFile.id);
                                await this.log(
                                    `[Smart Pull] [Cleanup] Deleted forbidden file (via Changes API): ${cloudFile.path}`,
                                );
                                delete this.index[cloudFile.path];
                                delete this.localIndex[cloudFile.path];
                            } catch (e) {
                                await this.log(
                                    `[Smart Pull] [Cleanup] Failed to delete forbidden file: ${cloudFile.path} - ${e}`,
                                );
                            }
                        });
                        continue;
                    }

                    // Check if another device is merging this file
                    const mergeLock = commData.mergeLocks[cloudFile.path];
                    const now = Date.now();
                    if (
                        mergeLock &&
                        mergeLock.holder !== this.deviceId &&
                        mergeLock.expiresAt > now
                    ) {
                        await this.log(
                            `[Smart Pull] Waiting: ${cloudFile.path} is being merged by ${mergeLock.holder} (expires in ${Math.round((mergeLock.expiresAt - now) / 1000)}s)`,
                        );
                        await this.notify(
                            `${this.t("noticeWaitOtherDeviceMerge")}: ${cloudFile.path.split("/").pop()}`,
                            true,
                            isSilent,
                        );
                        // Mark as pending conflict so next sync shows "merge result applied"
                        if (this.localIndex[cloudFile.path]) {
                            this.localIndex[cloudFile.path].pendingConflict = true;
                            await this.saveLocalIndex();
                        }
                        continue; // Skip this file, wait for merge to complete
                    }

                    // Skip if local index hash matches (already synced by this client)
                    const localEntry = this.index[cloudFile.path];
                    if (localIdToPath.has(cloudFile.id)) {
                        const prevPathForId = localIdToPath.get(cloudFile.id);
                        if (prevPathForId && prevPathForId !== cloudFile.path) {
                            const oldPath = prevPathForId;
                            const newPath = cloudFile.path;

                            // Detected Remote Rename (A -> B)
                            // We should rename locally to preserve history/content.

                            // Check if target already exists locally
                            const targetExists = await this.app.vault.adapter.exists(newPath);

                            if (!targetExists) {
                                try {
                                    // Check if source exists (it might have been deleted locally?)
                                    const sourceExists =
                                        await this.app.vault.adapter.exists(oldPath);
                                    if (sourceExists) {
                                        await this.log(
                                            `[Changes API] Remote Rename detected: ${oldPath} -> ${newPath}. Renaming locally.`,
                                        );

                                        // Execute Rename
                                        await this.app.vault.adapter.rename(oldPath, newPath);

                                        // Migrate Index Entries
                                        if (this.index[oldPath]) {
                                            this.index[newPath] = { ...this.index[oldPath] };
                                            delete this.index[oldPath];
                                        }
                                        if (this.localIndex[oldPath]) {
                                            this.localIndex[newPath] = {
                                                ...this.localIndex[oldPath],
                                            };
                                            delete this.localIndex[oldPath];
                                        }

                                        // Migrate Dirty State
                                        if (this.dirtyPaths.has(oldPath)) {
                                            this.dirtyPaths.delete(oldPath);
                                            this.dirtyPaths.add(newPath);
                                        }

                                        // Update ID Map so we don't process this again or inconsistently
                                        localIdToPath.set(cloudFile.id, newPath);

                                        await this.notify(
                                            `${this.t("noticeFileRenamed") || "Renamed"}: ${oldPath.split("/").pop()} -> ${newPath.split("/").pop()}`,
                                            true,
                                            isSilent,
                                        );
                                    } else {
                                        // Source doesn't exist locally? Just removed from index/map then.
                                        // pullFileSafely will treat as new download.
                                        await this.log(
                                            `[Changes API] Remote Rename: Source ${oldPath} missing locally. Skipping rename.`,
                                        );
                                        if (this.index[oldPath]) delete this.index[oldPath];
                                        if (this.localIndex[oldPath])
                                            delete this.localIndex[oldPath];
                                    }
                                } catch (e) {
                                    await this.log(
                                        `[Changes API] Failed to rename ${oldPath} -> ${newPath}: ${e}`,
                                    );
                                    // Fallback: Do nothing, let pullFileSafely download new file. Old file remains as ghost.
                                }
                            } else {
                                await this.log(
                                    `[Changes API] Remote Rename: Target ${newPath} exists. Skipping rename to avoid overwrite.`,
                                );
                                // Collision: A->B, but B exists.
                                // We can't rename. Old A remains.
                                // pullFileSafely will update B.
                                // We should probably disassociate A from this ID in our index to avoid confusion?
                                // If we leave A with ID 123, and B has ID 123...
                                // Next time we assume 123 is A again?
                                // localIdToPath will be rebuilt next run.
                                // If we don't delete A from index, it stays.
                                // Safe to leave it? Yes.
                            }
                        }
                    }

                    if (
                        localEntry?.hash &&
                        cloudFile.hash &&
                        localEntry.hash.toLowerCase() === cloudFile.hash.toLowerCase()
                    ) {
                        if (
                            this.localIndex[cloudFile.path]?.lastAction === "push" ||
                            this.localIndex[cloudFile.path]?.lastAction === "merge"
                        ) {
                            this.localIndex[cloudFile.path].lastAction = "pull";
                            this.localIndex[cloudFile.path].ancestorHash = cloudFile.hash;
                            this.index[cloudFile.path].ancestorHash = cloudFile.hash;
                            await this.log(
                                `[Smart Pull] Sync confirmed for ${cloudFile.path}. ancestorHash updated to ${cloudFile.hash?.substring(0, 8)}`,
                            );

                            // Notify individual confirmation if detailed notifications are on
                            confirmedCountTotal++;
                            await this.notify(
                                `${this.t("noticeSyncConfirmed")}: ${cloudFile.path.split("/").pop()}`,
                                true,
                                isSilent,
                            );
                        }
                        await this.log(`[Smart Pull] Skipping (hash match): ${cloudFile.path}`);
                        continue;
                    }

                    tasks.push(async () => {
                        const success = await this.pullFileSafely(
                            cloudFile,
                            isSilent,
                            "Changes API",
                        );
                        if (success) {
                            completed++;
                            await this.log(`[Changes API] Synced: ${cloudFile.path}`);
                        }
                    });
                }
            }

            if (tasks.length > 0) {
                this.startActivity();
                try {
                    await this.runParallel(tasks);
                    totalCompleted += completed;
                } finally {
                    // endActivity is handled by executeSmartSync
                }
            }

            // Advance to next page if supported, or settle on new start token
            if (changes.nextPageToken) {
                currentPageToken = changes.nextPageToken;
                this.startPageToken = currentPageToken;
                await this.saveIndex();
            } else if (changes.newStartPageToken) {
                this.startPageToken = changes.newStartPageToken;
                await this.saveIndex();
                break; // Reach the end
            } else {
                break; // No tokens, stop
            }

            if (!drainAll) break; // Only process one page unless drainAll is true
        } while (currentPageToken);

        if (hasTotalChanges) {
            // Notification for pulled files
            if (totalCompleted > 0) {
                await this.notify(
                    this.t("noticePullCompleted").replace("{0}", totalCompleted.toString()),
                    false, // isDetailed = false for summary
                    isSilent, // Use isSilent from caller
                );
            }
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

        // Pre-scan shared index for forbidden files
        // We only do this if full cleanup is requested to avoid O(N) overhead on every sync.
        if (this.forceCleanupNextSync) {
            for (const path of Object.keys(this.index)) {
                if (path === this.pluginDataPath) continue;
                if (this.isManagedSeparately(path)) continue;
                if (this.shouldNotBeOnRemote(path)) {
                    this.dirtyPaths.add(path);
                }
            }
        }

        // === INFER DELETED FOLDERS ===
        // Startup Scan/Full Scan only detects missing files, not missing folders.
        // We must walk up the tree of missing files to find their missing folders.
        if (this.dirtyPaths.size > 0) {
            const checkedFolders = new Set<string>();
            const missingFiles: string[] = [];

            // Identify missing files that were previously synced
            for (const path of this.dirtyPaths) {
                if (this.index[path]) {
                    // Quick check using adapter (async)
                    // We can batch this or just do it sequentially (robustness > speed here)
                    const exists = await this.app.vault.adapter.exists(path);
                    if (!exists) {
                        missingFiles.push(path);
                    }
                }
            }

            for (const path of missingFiles) {
                let folder = path.substring(0, path.lastIndexOf("/"));
                while (folder) {
                    if (checkedFolders.has(folder)) break; // Optimization
                    if (this.shouldIgnore(folder)) break;
                    if (this.deletedFolders.has(folder)) {
                        checkedFolders.add(folder);
                        break;
                    }

                    const exists = await this.app.vault.adapter.exists(folder);
                    // Do not mark as checked immediately, wait for existence check result logic

                    if (!exists) {
                        // Folder is missing locally, mark for remote deletion
                        this.deletedFolders.add(folder);
                        await this.log(`[Smart Push] Inferred deleted folder: ${folder}`);
                        // Continue walking up to check parent
                        folder = folder.substring(0, folder.lastIndexOf("/"));
                    } else {
                        // Folder exists, stop walking up
                        break;
                    }
                }
            }
        }

        // === FOLDER DELETION PHASE ===
        let folderDeletedCount = 0;
        if (this.deletedFolders.size > 0) {
            this.startActivity(); // Spin if folder deletion needed
            await this.log(
                `[Smart Push] Processing ${this.deletedFolders.size} deleted folder(s)...`,
            );

            // Sort by depth (deepest first) to handle nested deletions cleanly
            const folders = Array.from(this.deletedFolders).sort((a, b) => b.length - a.length);

            for (const folderPath of folders) {
                try {
                    // Try to find folder ID by path on remote
                    const meta = await this.adapter.getFileMetadata(folderPath);
                    if (meta && meta.id) {
                        if (meta.kind === "folder") {
                            await this.adapter.deleteFile(meta.id);
                            folderDeletedCount++;
                            await this.log(`[Smart Push] Deleted remote folder: ${folderPath}`);
                            await this.notify(
                                `${this.t("noticeFileTrashed")}: ${folderPath.split("/").pop()}`,
                                true,
                                isSilent,
                            );
                        }
                    } else {
                        await this.log(
                            `[Smart Push] Folder not found on remote (already deleted?): ${folderPath}`,
                        );
                    }

                    // Clean up Index & DirtyPaths for all descendants
                    // Since we deleted the parent, all children are gone on remote.
                    const prefix = folderPath + "/";

                    // 1. Remove from dirtyPaths to prevent redundant file deletion attempts
                    // (Iterate copy to safely delete while iterating)
                    for (const dirtyPath of Array.from(this.dirtyPaths)) {
                        if (dirtyPath.startsWith(prefix)) {
                            this.dirtyPaths.delete(dirtyPath);
                        }
                    }

                    // 2. Remove from Index
                    const allPaths = Object.keys(this.index);
                    for (const path of allPaths) {
                        if (path.startsWith(prefix)) {
                            delete this.index[path];
                            delete this.localIndex[path];
                        }
                    }

                    // Mark as handled
                    this.deletedFolders.delete(folderPath);
                } catch (e) {
                    await this.log(`[Smart Push] Failed to delete folder ${folderPath}: ${e}`);
                }
            }
        }

        if (this.dirtyPaths.size === 0 && folderDeletedCount === 0) {
            await this.log("[Smart Push] No dirty files to push. Skipping.");
            return false;
        }

        await this.log(`[Smart Push] Pushing ${this.dirtyPaths.size} dirty files...`);

        // Load communication data to check for active merge locks
        const commData = await this.loadCommunication();
        const now = Date.now();

        const uploadQueue: Array<{
            path: string;
            mtime: number;
            size: number;
            content: ArrayBuffer;
        }> = [];
        const deleteQueue: string[] = [];

        const dirtyPathTasks: (() => Promise<void>)[] = [];
        const dirtyPathsSnapshot = Array.from(this.dirtyPaths);

        for (const path of dirtyPathsSnapshot) {
            dirtyPathTasks.push(async () => {
                // Priority 0: Check if another device is currently merging this file
                const mergeLock = commData.mergeLocks[path];
                if (mergeLock && mergeLock.holder !== this.deviceId && mergeLock.expiresAt > now) {
                    await this.log(
                        `[Smart Push] Skipping: ${path} is being merged by ${mergeLock.holder} (expires in ${Math.round((mergeLock.expiresAt - now) / 1000)}s)`,
                    );
                    // Don't remove from dirtyPaths - we'll retry next sync cycle
                    return;
                }

                // Priority 1: 完全に外部(専用ロジック)で管理するファイル。汎用ループでは一切触らない。
                if (this.isManagedSeparately(path)) {
                    return;
                }

                // Priority 2: リモートに存在してはいけないファイル。
                // 以前同期されていた（インデックスにある）ならリモートから掃除する。
                if (this.shouldNotBeOnRemote(path)) {
                    if (this.localIndex[path]) {
                        deleteQueue.push(path);
                    }
                    return;
                }

                const exists = await this.app.vault.adapter.exists(path);
                if (exists) {
                    const stat = await this.app.vault.adapter.stat(path);
                    if (stat) {
                        // NEW: Handle folders
                        if (stat.type === "folder") {
                            try {
                                // Create folder on remote
                                await this.adapter.ensureFoldersExist([path]);
                                await this.log(`[Smart Push] Synced folder: ${path}`);
                                // Remove from dirty paths as it's handled
                                this.dirtyPaths.delete(path);
                                // Note: We don't index folders, so nothing to update in index
                                return;
                            } catch (e) {
                                await this.log(`[Smart Push] Failed to sync folder ${path}: ${e}`);
                                return;
                            }
                        }

                        // ... file handling continues ...
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
                            const localIndexEntry = this.localIndex[path];

                            // Adoption/Shortcut Check:
                            // If index has a hash and it matches current, just update mtime and skip.
                            // If it's a NEW file (!indexEntry), check remote to see if we can adopt it without uploading.
                            let alreadyOnRemoteFile: import("../types/adapter").CloudFile | null =
                                null;
                            if (!localIndexEntry) {
                                try {
                                    alreadyOnRemoteFile = await this.adapter.getFileMetadata(path);
                                } catch (e) {
                                    // Ignore metadata lookup errors
                                }
                            }

                            if (
                                localIndexEntry?.hash &&
                                localIndexEntry.hash.toLowerCase() === currentHash &&
                                localIndexEntry.lastAction !== "merge" && // Ensure pending merges are pushed
                                !localIndexEntry.forcePush // Force push if requested (e.g. rename)
                            ) {
                                // Local content matches our local base. No need to push.
                                // However, let's update mtimes to avoid re-calculating hash.
                                this.localIndex[path].mtime = mtimeAfterRead;
                                if (this.index[path]) {
                                    this.index[path].mtime = mtimeAfterRead;
                                }
                                this.dirtyPaths.delete(path); // Remove from dirty since content matches
                                await this.log(`[Smart Push] Skipped (hash match): ${path}`);
                                return;
                            } else if (
                                !localIndexEntry &&
                                alreadyOnRemoteFile?.hash &&
                                alreadyOnRemoteFile.hash.toLowerCase() === currentHash
                            ) {
                                // NEW file found on remote with SAME hash -> Adopt it!
                                // Treat as "pull" since we're accepting remote state
                                const entry = {
                                    fileId: alreadyOnRemoteFile.id,
                                    mtime: mtimeAfterRead,
                                    size: content.byteLength,
                                    hash: alreadyOnRemoteFile.hash,
                                    lastAction: "pull" as const,
                                    ancestorHash: alreadyOnRemoteFile.hash, // Set ancestor for future merges
                                };
                                this.index[path] = entry;
                                this.localIndex[path] = { ...entry };
                                this.dirtyPaths.delete(path);
                                await this.log(
                                    `[Smart Push] Adopted existing remote file: ${path}`,
                                );
                                return;
                            }

                            // Hash differs or new file -> Queue for upload with buffered content
                            uploadQueue.push({
                                path,
                                mtime: mtimeAfterRead,
                                size: content.byteLength,
                                content,
                            });
                        } catch (e) {
                            await this.log(
                                `[Smart Push] Failed to read ${path} for hash check: ${e}`,
                            );
                        }
                    }
                } else {
                    // File was deleted locally
                    if (this.localIndex[path]) {
                        deleteQueue.push(path);
                    }
                }
            });
        }
        if (dirtyPathTasks.length > 0) {
            await this.runParallel(dirtyPathTasks, 20);
        }

        const totalOps = uploadQueue.length + deleteQueue.length;
        if (totalOps === 0 && folderDeletedCount === 0) {
            await this.log("[Smart Push] No changes after filtering.");
            return false;
        }

        this.startActivity(); // Spin for upload/delete work

        // this.onActivityStart();
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

                        // === CONFLICT CHECK (Optimistic Locking) ===
                        // Before uploading, check if remote has changed since our last sync.
                        // If remote hash != index hash, someone else pushed. We MUST NOT overwrite.
                        let remoteMeta: import("../types/adapter").CloudFile | null = null;
                        try {
                            const params = {
                                fileId: this.index[file.path]?.fileId,
                                path: file.path,
                            };
                            // Use fileId if available for faster lookup, otherwise path
                            if (params.fileId) {
                                try {
                                    // CRITICAL FIX: Use ID-based lookup if available!
                                    // Google Drive Search API (q=name=...) is Eventually Consistent and may return stale hash.
                                    // Direct GET by ID is Strongly Consistent (mostly).
                                    remoteMeta = await this.adapter.getFileMetadataById(
                                        params.fileId,
                                        file.path,
                                    );
                                } catch {
                                    /* ignore not found */
                                }
                            } else {
                                try {
                                    remoteMeta = await this.adapter.getFileMetadata(file.path);
                                } catch {
                                    /* ignore not found */
                                }
                            }

                            if (remoteMeta) {
                                const lastKnownHash = this.localIndex[file.path]?.hash;
                                const remoteHash = remoteMeta.hash;

                                // If we have a previous record and remote hash differs -> CONFLICT
                                // If we are new (no index) but remote exists -> CONFLICT (or adoption)
                                // Standard conflict condition: Remote exists AND (We don't know it OR It changed since we knew it)
                                if (
                                    remoteHash &&
                                    (!lastKnownHash ||
                                        lastKnownHash.toLowerCase() !== remoteHash.toLowerCase())
                                ) {
                                    // EXCEPTION: If we just merged locally, we are ahead of remote.
                                    // The hash mismatch is expected (Local=Merged, Remote=Old).
                                    // We should treat this as a valid update, not a conflict.
                                    if (this.localIndex[file.path]?.lastAction === "merge") {
                                        await this.log(
                                            `[Smart Push] Allowing push of merged file (hash mismatch expected): ${file.path}`,
                                        );
                                    } else {
                                        await this.log(
                                            `[Smart Push] CONFLICT DETECTED: Remote changed for ${file.path}`,
                                        );
                                        await this.log(
                                            `[Smart Push] Local Base: ${lastKnownHash?.substring(0, 8)}, Remote: ${remoteHash.substring(0, 8)}`,
                                        );

                                        await this.log(
                                            `[Smart Push] [Deadlock Breaking] Attempting immediate pull/merge for ${file.path}...`,
                                        );
                                        await this.pullFileSafely(
                                            remoteMeta,
                                            isSilent,
                                            "Push Conflict",
                                        );
                                        // Critical: return here to skip uploading the OLD content in this closure.
                                        // The file remains in dirtyPaths (or is re-added by pullFileSafely),
                                        // so it will be picked up in the next sync cycle.
                                        return;
                                    }
                                }
                            }
                        } catch (e) {
                            // If check fails (network?), allow upload? Or fail safe?
                            // Safe: Fail validation, don't upload.
                            await this.log(`[Smart Push] Pre-upload validation failed: ${e}`);
                            // We don't return here? If we can't verify, maybe safe to fail this file sync.
                            // If just "Not Found", code above handles it (remoteMeta is null).
                            // If network error, we probably shouldn't upload.
                        }

                        // Use buffered content from queue creation (no re-read)
                        // CRITICAL FIX: Always prefer the ID from index if available (Migration/Renaming scenario)
                        // remoteMeta might be null if lookup failed or if we skipped lookup, but we might still have a valid ID in index.
                        const targetFileId = remoteMeta?.id || this.index[file.path]?.fileId;

                        const uploaded = await this.adapter.uploadFile(
                            file.path,
                            file.content,
                            file.mtime,
                            targetFileId,
                        );

                        // SUCCESS: Update indices with REMOTE metadata
                        // IMPORTANT: Do NOT update ancestorHash here!
                        // ancestorHash should only be updated when we CONFIRM that both Local and Remote
                        // have the same content (i.e., during Pull when hash matches).
                        // If we update ancestorHash here and another device pushes immediately after,
                        // ancestorHash would equal localBase.hash, causing the 3-way merge to incorrectly
                        // treat Local as "unchanged" and lose our pushed content.
                        const previousAncestorHash = this.localIndex[file.path]?.ancestorHash;
                        const entry = {
                            fileId: uploaded.id,
                            mtime: file.mtime,
                            size: uploaded.size,
                            hash: uploaded.hash,
                            lastAction: "push" as const,
                            ancestorHash: previousAncestorHash || uploaded.hash, // Preserve original ancestor, fallback for new files
                        };
                        this.index[file.path] = entry;
                        this.localIndex[file.path] = { ...entry };

                        // Success: Remove from dirtyPaths
                        this.dirtyPaths.delete(file.path);

                        completed++;
                        await this.log(
                            `[Smart Push] [${completed}/${totalOps}] Pushed: ${file.path}`,
                        );
                        await this.notify(
                            `${this.t("noticeFilePushed")}: ${file.path.split("/").pop()}`,
                            true,
                            isSilent,
                        );
                    } catch (e) {
                        await this.log(`[Smart Push] Upload failed: ${file.path} - ${e}`);
                    }
                });
            }

            // --- Deletion Logic Optimization: Folder Deletions ---
            const foldersToWipe = new Set<string>(); // Unique parent paths to delete
            const filesToWipeSimpler: string[] = []; // Files that don't belong to any wiped folder

            for (const path of deleteQueue) {
                const parts = path.split("/");
                let highestIgnoredParent: string | null = null;

                // Find the highest level parent directory that is now ignored
                for (let i = 1; i < parts.length; i++) {
                    const parentPath = parts.slice(0, i).join("/");
                    if (this.shouldNotBeOnRemote(parentPath + "/")) {
                        highestIgnoredParent = parentPath;
                        break;
                    }
                }

                if (highestIgnoredParent) {
                    foldersToWipe.add(highestIgnoredParent);
                } else {
                    filesToWipeSimpler.push(path);
                }
            }

            // Execute folder deletions first
            for (const folderPath of foldersToWipe) {
                tasks.push(async () => {
                    try {
                        // Find folder ID by looking up metadata by path
                        const meta = await this.adapter.getFileMetadata(folderPath);
                        if (meta && meta.id) {
                            await this.adapter.deleteFile(meta.id);
                            await this.log(
                                `[Smart Push] [Folder Wipe] Deleted ignored folder: ${folderPath}`,
                            );

                            // Cleanup ALL index entries that were under this folder
                            const prefix = folderPath + "/";
                            const allPaths = new Set([
                                ...Object.keys(this.index),
                                ...Object.keys(this.localIndex),
                            ]);
                            for (const path of allPaths) {
                                if (path.startsWith(prefix)) {
                                    delete this.index[path];
                                    delete this.localIndex[path];
                                    this.dirtyPaths.delete(path);
                                }
                            }
                            completed++; // Count folder deletion as one operation
                        }
                    } catch (e) {
                        await this.log(
                            `[Smart Push] [Folder Wipe] Failed to wipe folder ${folderPath}: ${e}`,
                        );
                    }
                });
            }

            // Execute individual file deletions (for those not in wiped folders)
            for (const path of filesToWipeSimpler) {
                tasks.push(async () => {
                    try {
                        const entry = this.index[path];
                        if (entry) {
                            await this.adapter.deleteFile(entry.fileId);
                            delete this.index[path];
                            delete this.localIndex[path];
                            this.dirtyPaths.delete(path);

                            completed++;
                            await this.log(
                                `[Smart Push] [${completed}/${totalOps}] Deleted remote: ${path}`,
                            );
                            await this.notify(
                                `${this.t("noticeFileTrashed")}: ${path.split("/").pop()}`,
                                true,
                                isSilent,
                            );
                        } else {
                            // Zombie entry: in localIndex but not in shared index.
                            // Already "deleted" on remote by others or previous run.
                            delete this.localIndex[path];
                            this.dirtyPaths.delete(path);
                            await this.log(
                                `[Smart Push] Cleaned up zombie entry (local only): ${path}`,
                            );
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

            // Reset cleanup flag after a successful cleanup run
            if (this.forceCleanupNextSync) {
                this.forceCleanupNextSync = false;
                await this.log("[Smart Push] Full cleanup scan completed and flag reset.");
            }

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

            if (completed > 0) {
                await this.notify(
                    this.t("noticePushCompleted").replace("{0}", completed.toString()),
                    false,
                    isSilent,
                );
            }
            return true;
        } finally {
            // this.onActivityEnd();
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
                                // Adopt into index - treat as "pull" since we're accepting remote state
                                this.index[remoteFile.path] = {
                                    fileId: remoteFile.id,
                                    mtime: localFile.mtime,
                                    size: localFile.size,
                                    hash: remoteFile.hash,
                                    lastAction: "pull",
                                    ancestorHash: remoteFile.hash, // Set ancestor for future merges
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

    // === History Management (delegated to history.ts) ===

    get supportsHistory(): boolean {
        return _supportsHistory(this as unknown as SyncContext);
    }

    async listRevisions(path: string): Promise<import("../types/adapter").FileRevision[]> {
        return _listRevisions(this as unknown as SyncContext, path);
    }

    async getRevisionContent(path: string, revisionId: string): Promise<ArrayBuffer> {
        return _getRevisionContent(this as unknown as SyncContext, path, revisionId);
    }

    async setRevisionKeepForever(path: string, revisionId: string, keepForever: boolean): Promise<void> {
        return _setRevisionKeepForever(this as unknown as SyncContext, path, revisionId, keepForever);
    }

    async deleteRevision(path: string, revisionId: string): Promise<void> {
        return _deleteRevision(this as unknown as SyncContext, path, revisionId);
    }

    /**
     * Try to perform a 3-way merge
     * @returns Merged content as ArrayBuffer if successful, null if conflict persists
     */
    /**
     * Custom 3-way line encoding to ensure ALL unique lines from Base, Local, and Remote
     * represent correctly in the character-based diff.
     * Standard dmp.diff_linesToChars only considers 2 texts, causing "unknown line" issues for the 3rd.
     */
    private linesToChars3(
        text1: string,
        text2: string,
        text3: string,
    ): {
        chars1: string;
        chars2: string;
        chars3: string;
        lineArray: string[];
    } {
        const lineArray: string[] = [];
        const lineHash: { [key: string]: number } = {};

        // Helper to encode text to chars based on shared unique line list
        const encode = (text: string) => {
            let chars = "";
            let lineStart = 0;
            let lineEnd = -1;
            while (lineEnd < text.length - 1) {
                lineEnd = text.indexOf("\n", lineStart);
                if (lineEnd == -1) {
                    lineEnd = text.length - 1;
                }
                const line = text.substring(lineStart, lineEnd + 1);

                if (Object.prototype.hasOwnProperty.call(lineHash, line)) {
                    chars += String.fromCharCode(lineHash[line]);
                } else {
                    const i = lineArray.length;
                    lineHash[line] = i;
                    lineArray.push(line);
                    chars += String.fromCharCode(i);
                }
                lineStart = lineEnd + 1;
            }
            return chars;
        };

        const chars1 = encode(text1); // Base
        const chars2 = encode(text2); // Local
        const chars3 = encode(text3); // Remote

        return { chars1, chars2, chars3, lineArray };
    }
    /**
     * Try to perform a 3-way merge
     * @returns Merged content as ArrayBuffer if successful, null if conflict persists
     */
    private async perform3WayMerge(
        path: string,
        localContentStr: string,
        remoteContentStr: string,
        baseHash: string,
    ): Promise<ArrayBuffer | null> {
        try {
            // Check Conflict Resolution Strategy
            const strategy = this.settings.conflictResolutionStrategy;
            if (strategy === "force-local") {
                await this.log(`[Merge] Strategy is 'Force Local'. Overwriting remote changes.`);
                return new TextEncoder().encode(localContentStr).buffer;
            }
            if (strategy === "force-remote") {
                await this.log(`[Merge] Strategy is 'Force Remote'. Overwriting local changes.`);
                return new TextEncoder().encode(remoteContentStr).buffer;
            }
            if (strategy === "always-fork") {
                await this.log(`[Merge] Strategy is 'Always Fork'. Skipping auto-merge.`);
                return null;
            }

            // Normal 'smart-merge' logic continues below...
            // 1. Find Base Revision (Common Ancestor)
            await this.log(`[Merge] Attempting 3-way merge for ${path}...`);
            await this.log(`[Merge] Looking for base revision with hash: ${baseHash}`);

            // 1. Find Base Revision from Cloud History
            const revisions = await this.listRevisions(path);
            await this.log(
                `[Merge] Found ${revisions.length} revisions: ${revisions.map((r) => r.hash?.substring(0, 8) || "no-hash").join(", ")}`,
            );

            // Find the MOST RECENT revision with matching hash (search from end)
            // revisions array is ordered oldest-first, so we need findLast or reverse search
            // Using slice().reverse().find() for compatibility with older JS targets
            const baseRev = revisions
                .slice()
                .reverse()
                .find((r) => r.hash && r.hash.toLowerCase() === baseHash.toLowerCase());

            if (!baseRev) {
                await this.log(`[Merge] No base revision found matching hash ${baseHash}.`);
                await this.log(
                    `[Merge] Available hashes: ${revisions.map((r) => r.hash || "null").join(", ")}`,
                );
                return null;
            }

            await this.log(`[Merge] Found base revision: ${baseRev.id} (hash: ${baseRev.hash})`);

            // 2. Get Base Content
            const baseBuffer = await this.getRevisionContent(path, baseRev.id);
            const baseContentStr = new TextDecoder().decode(baseBuffer);

            // CRITICAL FIX: Normalize line endings to LF to prevent CRLF vs LF mismatches
            // causing false-positive line differences (Windows vs Android/Unix).
            const normalize = (s: string) => s.replace(/\r\n/g, "\n");
            const baseNorm = normalize(baseContentStr);
            const localNorm = normalize(localContentStr);
            const remoteNorm = normalize(remoteContentStr);

            await this.log(
                `[Merge] Content lengths (raw/norm) - Base: ${baseContentStr.length}/${baseNorm.length}, Local: ${localContentStr.length}/${localNorm.length}, Remote: ${remoteContentStr.length}/${remoteNorm.length}`,
            );

            // DEBUG: Output full content for debugging merge issues
            await this.log(`[Merge DEBUG] Base Content:\n---\n${baseNorm}\n---`);
            await this.log(`[Merge DEBUG] Local Content:\n---\n${localNorm}\n---`);
            await this.log(`[Merge DEBUG] Remote Content:\n---\n${remoteNorm}\n---`);

            // 3. Perform Merge using improved 3-way line encoding
            const dmp = new diff_match_patch();
            dmp.Match_Threshold = 0.5;
            dmp.Match_Distance = 250;
            dmp.Patch_DeleteThreshold = 0.5;

            // Custom encoding that accounts for ALL lines in Base, Local, AND Remote.
            const {
                chars1: charsBase,
                chars2: charsLocal,
                chars3: charsRemote,
                lineArray,
            } = this.linesToChars3(baseNorm, localNorm, remoteNorm);

            // Step 1: Compute diffs between Base and Remote (Changes made by Remote)
            const diffs = dmp.diff_main(charsBase, charsRemote, false);

            // Define Helper for Added-Line Protection check
            const getUniqueLines = (text: string, base: string) => {
                const lines = text
                    .split("\n")
                    .map((l) => l.trim())
                    .filter((l) => l.length > 0);
                const baseLines = new Set(
                    base
                        .split("\n")
                        .map((l) => l.trim())
                        .filter((l) => l.length > 0),
                );
                return lines.filter((l) => !baseLines.has(l));
            };
            const localAddedLines = getUniqueLines(localNorm, baseNorm);

            // ATTEMPT LOOP: Dynamic Patch_Margin retry strategy (4 -> 2 -> 1)
            const margins = [4, 2, 1];
            for (const margin of margins) {
                await this.log(`[Merge] Attempting merge with Patch_Margin=${margin}...`);
                dmp.Patch_Margin = margin;

                // Step 2: Create patch derived from Remote changes
                const patches = dmp.patch_make(charsBase, diffs);

                // Step 3: Apply patch to Local content
                let [mergedChars, successResults] = dmp.patch_apply(patches, charsLocal);

                // ATOMIC FALLBACK: If any patch failed, try applying them one-by-one
                const allSuccess = successResults.every((s: boolean) => s);
                if (!allSuccess) {
                    await this.log(
                        `[Merge] Bulk apply failed (margin=${margin}). Attempting atomic recovery...`,
                    );
                    let currentMerged = charsLocal;
                    for (let i = 0; i < patches.length; i++) {
                        const [res, success] = dmp.patch_apply([patches[i]], currentMerged);
                        if (success[0]) {
                            currentMerged = res;
                        }
                    }
                    mergedChars = currentMerged;
                }

                // Decode the merged ID string back to actual text lines
                let mergedText = "";
                let decodeError = false;
                for (let i = 0; i < mergedChars.length; i++) {
                    const idx = mergedChars.charCodeAt(i);
                    if (idx < lineArray.length) {
                        mergedText += lineArray[idx];
                    } else {
                        await this.log(
                            `[Merge] Encoding error during decode (idx=${idx}, margin=${margin})`,
                        );
                        decodeError = true;
                        break;
                    }
                }
                if (decodeError) continue;

                // DEBUG: Output merged content
                await this.log(
                    `[Merge DEBUG] Merged Content (margin=${margin}):\n---\n${mergedText}\n---`,
                );

                // VALIDATION: ADDED-LINE PROTECTION (Final Integrity Check)
                let validationFailed = false;
                if (localAddedLines.length > 0) {
                    const mergedLines = new Set(
                        mergedText
                            .split("\n")
                            .map((l) => l.trim())
                            .filter((l) => l.length > 0),
                    );
                    for (const line of localAddedLines) {
                        if (!mergedLines.has(line)) {
                            await this.log(
                                `[Merge] VALIDATION FAILED (margin=${margin}): Local line was lost: "${line.substring(0, 40)}..."`,
                            );
                            validationFailed = true;
                            break;
                        }
                    }
                }

                if (!validationFailed) {
                    await this.log(
                        `[Merge] SUCCESS: Auto-merged ${path} with Patch_Margin=${margin}`,
                    );
                    return new TextEncoder().encode(mergedText).buffer;
                }
            }

            await this.log(
                `[Merge] FAIL: All Patch_Margin attempts failed for ${path}. (Safety Fallback)`,
            );
            return null;
        } catch (e) {
            await this.log(`[Merge] Error: ${e}`);
            return null;
        }
    }

    /**
     * Find common ancestor hash from revision history
     * This is used when both local and remote have diverged from a common base
     * @param path File path
     * @param localHash Hash of the local version (already pushed)
     * @param remoteHash Hash of the remote version
     * @returns Hash of the common ancestor, or null if not found
     */
    private async findCommonAncestorHash(
        path: string,
        localHash: string,
        remoteHash: string,
    ): Promise<string | null> {
        try {
            const revisions = await this.listRevisions(path);
            await this.log(
                `[Merge] Finding common ancestor for ${path}: local=${localHash.substring(0, 8)}, remote=${remoteHash.substring(0, 8)}`,
            );
            await this.log(
                `[Merge] Available revisions: ${revisions.map((r) => r.hash?.substring(0, 8) || "no-hash").join(", ")}`,
            );

            // Find indices of local and remote hashes in revision history
            // Revisions are ordered oldest-first (index 0 = oldest, highest index = newest)
            // We need to find the LAST occurrence (most recent) and also check for EARLIER occurrences
            const localLower = localHash.toLowerCase();
            const remoteLower = remoteHash.toLowerCase();

            let localIdx = -1;
            let remoteIdx = -1;

            // 1. Search full history for the LATEST occurrence of both versions.
            // Using the latest occurrence is safer as it represents the most recent
            // common point before divergence.
            for (let i = revisions.length - 1; i >= 0; i--) {
                const hash = revisions[i].hash?.toLowerCase();
                if (hash === localLower && localIdx === -1) localIdx = i;
                if (hash === remoteLower && remoteIdx === -1) remoteIdx = i;
                if (localIdx !== -1 && remoteIdx !== -1) break;
            }

            await this.log(
                `[Merge] localIdx=${localIdx}, remoteIdx=${remoteIdx} (Latest Occurrences)`,
            );

            if (localIdx === -1 || remoteIdx === -1) {
                await this.log(`[Merge] Could not find both versions in history`);
                return null;
            }

            // Determine common ancestor index.
            // In a linear history (like Google Drive file revisions), the older version (smaller index)
            // is by definition the common ancestor from which the newer version (higher index) originated.
            // We MUST NOT subtract 1 here, as that would pick an even older revision,
            // potentially containing data that would be misidentified as "deleted" in the newer branch.
            const pivotIdx = Math.min(localIdx, remoteIdx);

            const foundHash = revisions[pivotIdx].hash;
            await this.log(
                `[Merge] Selected ancestor at index ${pivotIdx}: ${foundHash?.substring(0, 8)}`,
            );
            return foundHash || null;
        } catch (e) {
            await this.log(`[Merge] Error finding common ancestor: ${e}`);
            return null;
        }
    }

    /**
     * Check if the subset content's lines are a strict subsequence of the superset content.
     * This detects if a version has lost some lines (bad merge or old version).
     */
    private isContentSubset(subset: string, superset: string): boolean {
        const normalize = (s: string) => s.replace(/\r\n/g, "\n");
        const subLines = normalize(subset)
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l.length > 0);
        const superLines = normalize(superset)
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l.length > 0);

        if (subLines.length === 0) return true;
        if (subLines.length > superLines.length) return false;

        let superIdx = 0;
        for (const subLine of subLines) {
            let found = false;
            while (superIdx < superLines.length) {
                if (superLines[superIdx] === subLine) {
                    found = true;
                    superIdx++; // Found match, move super pointer
                    break;
                }
                superIdx++;
            }
            if (!found) return false;
        }
        return true;
    }

    /**
     * Check if two contents are semantically equivalent (same lines, possibly different order)
     * This is used to detect ping-pong merge loops where both devices have merged the same content
     * but produced slightly different orderings or whitespace
     * @param contentA First content as string
     * @param contentB Second content as string
     * @returns true if both contain the same set of non-empty lines
     */
    private areSemanticallyEquivalent(contentA: string, contentB: string): boolean {
        // Normalize line endings for consistent comparison
        const normalizeLineEndings = (s: string) => s.replace(/\r\n/g, "\n");
        const localNorm = normalizeLineEndings(contentA);
        const remoteNorm = normalizeLineEndings(contentB);

        // Get all non-empty lines from local and remote
        const localLines = localNorm.split("\n").filter((line) => line.trim().length > 0);
        const remoteLines = remoteNorm.split("\n").filter((line) => line.trim().length > 0);

        // Sort and compare to ignore order differences
        const sortedLocal = localLines.map((line) => line.trim()).sort();
        const sortedRemote = remoteLines.map((line) => line.trim()).sort();

        if (sortedLocal.length !== sortedRemote.length) {
            return false;
        }

        for (let i = 0; i < sortedLocal.length; i++) {
            if (sortedLocal[i] !== sortedRemote[i]) {
                return false;
            }
        }

        return true;
    }

    async restoreRevision(
        path: string,
        revision: import("../types/adapter").FileRevision,
    ): Promise<void> {
        return _restoreRevision(this as unknown as SyncContext, path, revision);
    }

    /**
     * Pull a single file from remote with conflict detection and auto-merge
     * @returns true if downloaded/merged, false if skipped or failed
     */
    private async pullFileSafely(
        item: {
            path: string;
            fileId?: string;
            id?: string;
            hash?: string;
            mtime?: number;
            size?: number;
        },

        isSilent: boolean,
        logPrefix: string,
    ): Promise<boolean> {
        if (!item) return false;

        // Handle deletion check Early
        const isRemoteDeleted = !item.hash && !item.fileId;
        const fileId = item.fileId || item.id;
        if (!fileId && !isRemoteDeleted) return false;

        const isText = item.path.endsWith(".md") || item.path.endsWith(".txt");

        // EARLY MERGE LOCK CHECK:
        // If another device is currently merging this file, we should wait for their result
        // instead of proceeding with our own conflict detection/merge logic.
        const lockStatus = await this.checkMergeLock(item.path);
        if (lockStatus.locked) {
            await this.log(
                `[${logPrefix}] Skipping pull: ${item.path} is being merged by ${lockStatus.holder} (expires in ${lockStatus.expiresIn}s)`,
            );
            await this.notify(
                `${this.t("noticeWaitOtherDeviceMerge")}: ${item.path.split("/").pop()}`,
                true,
                isSilent,
            );
            // Mark as pending conflict so next sync shows "merge result applied"
            if (this.localIndex[item.path]) {
                this.localIndex[item.path].pendingConflict = true;
                await this.saveLocalIndex();
            }
            return false; // Wait for other device to finish
        }

        try {
            // CONFLICT DETECTION
            const exists = await this.app.vault.adapter.exists(item.path);
            if (exists) {
                this.syncingPaths.add(item.path);
                try {
                    const localContent = await this.app.vault.adapter.readBinary(item.path);
                    const currentHash = md5(localContent);
                    const localBase = this.localIndex[item.path];

                    // Debug logging for conflict detection
                    await this.log(
                        `[${logPrefix}] Conflict check for ${item.path}: ` +
                            `currentHash=${currentHash.substring(0, 8)}, ` +
                            `localBaseHash=${localBase?.hash?.substring(0, 8) || "none"}, ` +
                            `remoteHash=${item.hash?.substring(0, 8) || "none"}`,
                    );

                    // Check if remote was updated since our last sync
                    const hasRemoteConflict =
                        (localBase?.hash &&
                            item.hash &&
                            localBase.hash.toLowerCase() !== item.hash.toLowerCase()) ||
                        isRemoteDeleted; // Remote deletion is a conflict if we are modified

                    // Check if modified locally (New Local OR Modified Local)
                    // Comparison is against our local BASE state.
                    const isActuallyModified =
                        !localBase ||
                        !localBase.hash ||
                        localBase.hash.toLowerCase() !== currentHash;
                    let isModifiedLocally = isActuallyModified || this.dirtyPaths.has(item.path);

                    // SAFETY GUARD:
                    // Check 1: Remote was updated since our last sync
                    const hasRemoteUpdate =
                        (localBase?.hash &&
                            item.hash &&
                            localBase.hash.toLowerCase() !== item.hash.toLowerCase()) ||
                        isRemoteDeleted; // Remote deletion is a conflict if we are modified

                    // Check 2: Safety Guard for "Push then Remote Changed"
                    // Only trigger if local IS modified AND we pushed previously.
                    // If local is CLEAN (matches index), we assume remote is the source of truth
                    // (even if we just pushed, remote might have merged our push).
                    let safetyGuardTriggered = false;
                    if (
                        isModifiedLocally && // Only trigger if local IS modified
                        (localBase?.lastAction === "push" || localBase?.lastAction === "merge") &&
                        hasRemoteUpdate && // Use the general remote update check
                        !localBase?.pendingConflict // Skip if waiting for other device's merge result
                    ) {
                        await this.log(
                            `[${logPrefix}] Safety Guard: Detected remote change after our ${localBase?.lastAction}. Forcing merge check to prevent data loss.`,
                        );
                        await this.notify(`${this.t("noticeMergingFile")}`, true, isSilent);
                        isModifiedLocally = true;
                        safetyGuardTriggered = true;
                    }

                    await this.log(
                        `[${logPrefix}] isModifiedLocally=${isModifiedLocally}, hasRemoteConflict=${hasRemoteConflict}, lastAction=${localBase?.lastAction || "none"} for ${item.path}`,
                    );

                    // Handle conflict: either local was modified OR remote was updated by another device
                    if (isModifiedLocally || hasRemoteConflict) {
                        // Content match check (False alarm / Already updated by other client)
                        if (item.hash && currentHash === item.hash.toLowerCase()) {
                            const stat = await this.app.vault.adapter.stat(item.path);
                            // Mark as 'pull' to indicate sync is complete.
                            // This clears lastAction=push so future remote updates won't trigger Safety Guard.
                            const entry = {
                                fileId: fileId || "",
                                mtime: stat?.mtime || Date.now(),
                                size: stat?.size || localContent.byteLength,
                                hash: item.hash || "",
                                lastAction: "pull" as const, // Sync confirmed, clear push state
                                ancestorHash: item.hash || "", // Correctly set ancestor to current state
                            };
                            this.index[item.path] = entry;
                            this.localIndex[item.path] = { ...entry }; // Update local base for consistency
                            this.dirtyPaths.delete(item.path); // Clear dirty since it now matches remote exactly
                            await this.saveLocalIndex();
                            await this.log(`[${logPrefix}] Skipped (content match): ${item.path}`);
                            return true; // Already matched
                        }

                        // 3. REMOTE UPDATED, LOCAL UNMODIFIED
                        // If the local file matches our last known common base (localBase.hash),
                        // and we haven't performed any new (user) actions, it is SAFE
                        // to accept the remote version regardless of what it contains.
                        // IMPORTANT: Skip this if Safety Guard triggered - we need to merge instead!
                        if (hasRemoteConflict && !isActuallyModified && !safetyGuardTriggered) {
                            // Check if we were in a pending conflict state (waiting for merge resolution)
                            const wasPendingConflict = localBase?.pendingConflict === true;

                            await this.log(
                                `[${logPrefix}] Remote updated, local unmodified. Accepting remote version. (wasPendingConflict=${wasPendingConflict})`,
                            );

                            if (wasPendingConflict) {
                                // The other device resolved the conflict and pushed the result
                                await this.notify(
                                    `${this.t("noticeRemoteMergeSynced")}: ${item.path.split("/").pop()}`,
                                    true,
                                    isSilent,
                                );
                            } else {
                                // Normal pull - remote was simply updated
                                await this.notify(
                                    `${this.t("noticeFilePulled") || "📥 Pulled"}: ${item.path.split("/").pop()}`,
                                    true,
                                    isSilent,
                                );
                            }
                            this.syncingPaths.add(item.path);
                            const remoteContent = await this.adapter.downloadFile(fileId || "");
                            await this.app.vault.adapter.writeBinary(item.path, remoteContent);

                            const stat = await this.app.vault.adapter.stat(item.path);
                            const entry = {
                                fileId: fileId || "",
                                mtime: stat?.mtime || Date.now(),
                                size: remoteContent.byteLength,
                                hash: item.hash,
                                lastAction: "pull" as const,
                                ancestorHash: item.hash,
                                pendingConflict: false, // Clear the flag
                            };
                            this.index[item.path] = entry;
                            this.localIndex[item.path] = { ...entry };
                            return true;
                        }

                        // 4. CONFLICT (Both Modified) -> Proceed to Merger with lock
                        // We reach here if:
                        // - remote content != local content
                        // - AND local content has changed since the last known sync (isModifiedLocally = true)

                        if (isText && localBase?.hash) {
                            // === DISTRIBUTED MERGE LOCK ===
                            await this.log(
                                `[${logPrefix}] Attempting to acquire merge lock for ${item.path}...`,
                            );

                            const lockResult = await this.acquireMergeLock(item.path);
                            if (!lockResult.acquired) {
                                await this.log(
                                    `[${logPrefix}] Lock not acquired: ${item.path} is being handled by ${lockResult.holder} (expires in ${lockResult.expiresIn}s)`,
                                );
                                await this.notify(
                                    `${this.t("noticeWaitOtherDeviceMerge")}: ${item.path.split("/").pop()}`,
                                    true,
                                    isSilent,
                                );
                                // Mark as pending conflict so next sync shows "merge result applied"
                                if (this.localIndex[item.path]) {
                                    this.localIndex[item.path].pendingConflict = true;
                                }
                                return false; // Let other device solve it
                            }
                            await this.log(`[${logPrefix}] Lock acquired successfully.`);

                            await this.notify(
                                `${this.t("noticeMergingFile") || "Merging"}: ${item.path.split("/").pop()}`,
                                true,
                                isSilent,
                            );

                            // Use ancestorHash as common ancestor
                            let baseHash = localBase.ancestorHash;
                            let origin = "ancestorHash";

                            await this.log(
                                `[${logPrefix}] Base selection: ancestorHash=${baseHash?.substring(0, 8) || "null"}, localBase.hash=${localBase.hash?.substring(0, 8) || "null"}, remote.hash=${item.hash?.substring(0, 8) || "null"}`,
                            );

                            // Validate Ancestor
                            const isBaseSameAsLocal =
                                baseHash &&
                                localBase.hash &&
                                baseHash.toLowerCase() === localBase.hash.toLowerCase();
                            const isBaseSameAsRemote =
                                baseHash &&
                                item.hash &&
                                baseHash.toLowerCase() === item.hash.toLowerCase();

                            // Determine if ancestorHash is valid for 3-way merge
                            // We need history lookup if:
                            // - ancestorHash is missing
                            // - OR: ancestorHash is same as Local, BUT we have NO local changes (Safety Guard case)
                            //      In this case, ancestorHash=Local implies we have no delta, but there IS a conflict,
                            //      which means Remote diverged from an EARLIER version we don't know about.
                            // - OR: ancestorHash is same as Remote (Remote is our ancestor, but we diverged)
                            const needHistoryLookup =
                                !baseHash ||
                                (isBaseSameAsLocal && !isActuallyModified) ||
                                isBaseSameAsRemote;

                            if (needHistoryLookup) {
                                await this.log(
                                    `[${logPrefix}] ancestorHash invalid (missing=${!baseHash}, sameAsLocal=${isBaseSameAsLocal}, sameAsRemote=${isBaseSameAsRemote}). Searching history...`,
                                );
                                const computedAncestor = await this.findCommonAncestorHash(
                                    item.path,
                                    localBase.hash as string,
                                    item.hash || "",
                                );
                                if (computedAncestor) {
                                    baseHash = computedAncestor;
                                    origin = "history lookup";
                                }
                            }

                            if (!baseHash) {
                                await this.log(
                                    `[${logPrefix}] Genuinely unsolvable conflict. Falling back to conflict file.`,
                                );
                            } else {
                                const baseHashFound = baseHash;
                                const remoteContent = await this.adapter.downloadFile(fileId || "");
                                const localContentStr = new TextDecoder().decode(localContent);
                                const remoteContentStr = new TextDecoder().decode(remoteContent);
                                const merged = await this.perform3WayMerge(
                                    item.path,
                                    localContentStr,
                                    remoteContentStr,
                                    baseHashFound,
                                );

                                if (merged) {
                                    // SUCCESS: Write merged content
                                    const mergedStr = new TextDecoder().decode(merged);
                                    const normalizedMerged = mergedStr.replace(/\r\n/g, "\n");
                                    await this.app.vault.adapter.writeBinary(item.path, merged);
                                    const mergedHash = md5(
                                        new TextEncoder().encode(normalizedMerged).buffer,
                                    );

                                    const isIdenticalToRemote =
                                        item.hash && mergedHash === item.hash.toLowerCase();

                                    if (isIdenticalToRemote) {
                                        await this.log(
                                            `[${logPrefix}] Result matches remote. Marking as Synced.`,
                                        );
                                        const stat = await this.app.vault.adapter.stat(item.path);
                                        // SUCCESS: Result matches remote
                                        const entry = {
                                            fileId: fileId || "",
                                            mtime: stat?.mtime || Date.now(),
                                            size: merged.byteLength,
                                            hash: item.hash?.toLowerCase() || "",
                                            lastAction: "pull" as const,
                                            ancestorHash: item.hash?.toLowerCase() || "",
                                        };
                                        await this.notify(
                                            `${this.t("noticeRemoteMergeSynced")}: ${item.path.split("/").pop()}`,
                                            true,
                                            isSilent,
                                        );
                                        this.index[item.path] = entry; // Cloud matches remote
                                        this.localIndex[item.path] = { ...entry };
                                        this.dirtyPaths.delete(item.path);
                                    } else {
                                        // Final lock verify before push using communication.json
                                        const lockCheck = await this.checkMergeLock(item.path);
                                        // If we still own the lock (not locked by another device), we're good
                                        if (!lockCheck.locked) {
                                            const stat = await this.app.vault.adapter.stat(
                                                item.path,
                                            );
                                            // SUCCESS: Local merged, Cloud still has remote version
                                            const entryLocal = {
                                                fileId: fileId || "",
                                                mtime: stat?.mtime || Date.now(),
                                                size: merged.byteLength,
                                                hash: mergedHash,
                                                lastAction: "merge" as const,
                                                ancestorHash: baseHashFound, // The version we merged AGAINST is our new base locally
                                            };
                                            const entryCloud = {
                                                fileId: fileId || "",
                                                mtime: item.mtime || Date.now(),
                                                size: item.size || 0,
                                                hash: item.hash,
                                                lastAction: "pull" as const,
                                                ancestorHash: item.hash,
                                            };
                                            // Correctly reflect cloud vs local state and PERSIST!
                                            this.index[item.path] = entryCloud;
                                            this.localIndex[item.path] = entryLocal;
                                            this.dirtyPaths.add(item.path);
                                            await this.saveLocalIndex();

                                            await this.log(
                                                `[${logPrefix}] Merged successfully. Queued for push.`,
                                            );
                                            // Both cases (normal merge or resolving pending conflict) are successful merges.
                                            // The timing of noticeCheckOtherDevice was confusing users.
                                            await this.notify(
                                                `${this.t("noticeMergeSuccess")}: ${item.path.split("/").pop()}`,
                                                true,
                                                isSilent,
                                            );
                                        } else {
                                            // Lock was lost (expired or stolen), but merged content
                                            // is already written to disk. Update localIndex to reflect
                                            // the actual disk state so next sync can push it.
                                            await this.log(
                                                `[${logPrefix}] Lock lost during merge. Content saved locally, queued for push on next cycle.`,
                                            );
                                            const statLockLost = await this.app.vault.adapter.stat(
                                                item.path,
                                            );
                                            this.localIndex[item.path] = {
                                                fileId: fileId || "",
                                                mtime: statLockLost?.mtime || Date.now(),
                                                size: merged.byteLength,
                                                hash: mergedHash,
                                                lastAction: "merge" as const,
                                                ancestorHash: baseHashFound,
                                            };
                                            this.dirtyPaths.add(item.path);
                                            await this.saveLocalIndex();
                                        }
                                    }

                                    await this.releaseMergeLock(item.path, logPrefix);
                                    return true;
                                }
                            }

                            // Merge failed - check if local changes are already included in remote
                            // This logic was causing data loss on deletions (subset check passed -> overwrite).
                            // REMOVED: isLocalIncludedInRemote check. Now exclusively falling back to Conflict File.
                        }

                        // =========================================================================
                        // CONFLICT FALLBACK: Remote version is always primary to ensure global stability.
                        // Local version is moved to a conflict file.
                        // =========================================================================
                        const timestamp = new Date()
                            .toISOString()
                            .replace(/[:.]/g, "-")
                            .slice(0, 19);
                        const ext = item.path.split(".").pop();
                        const baseName = item.path.substring(0, item.path.lastIndexOf("."));
                        const conflictPath = `${baseName} (Conflict ${timestamp}).${ext}`;

                        const isLocalProbablyBetter =
                            localBase?.lastAction === "push" || localBase?.lastAction === "merge";

                        await this.log(
                            `[${logPrefix}] CONFLICT (Remote Priority): Accepting remote version as main. ` +
                                (isLocalProbablyBetter
                                    ? "(Safety Guard/Recent action hit)"
                                    : "(Standard dual modification)"),
                        );

                        // 1. Move local version to conflict path
                        const localFile = this.app.vault.getAbstractFileByPath(item.path);
                        if (localFile instanceof TFile) {
                            await this.app.vault.rename(localFile, conflictPath);
                        } else {
                            await this.app.vault.adapter.rename(item.path, conflictPath);
                        }
                        await this.log(`[${logPrefix}] Renamed local version to ${conflictPath}`);

                        // 2. Download remote version to primary path
                        let remoteSize = 0;
                        if (!isRemoteDeleted) {
                            const remoteContent = await this.adapter.downloadFile(fileId || "");
                            await this.ensureLocalFolder(item.path);
                            await this.app.vault.adapter.writeBinary(item.path, remoteContent);
                            remoteSize = remoteContent.byteLength;
                        } else {
                            // If remote was deleted, primary path is now empty
                            const exists = await this.app.vault.adapter.exists(item.path);
                            if (exists) {
                                await this.app.vault.adapter.remove(item.path);
                            }
                        }

                        // 3. Update index to match remote state
                        const stat = await this.app.vault.adapter.stat(item.path);
                        const entry = {
                            fileId: fileId || "",
                            mtime: stat?.mtime || Date.now(),
                            size: remoteSize,
                            hash: item.hash?.toLowerCase() || "",
                            lastAction: "pull" as const,
                            ancestorHash: item.hash?.toLowerCase() || "",
                        };
                        this.index[item.path] = entry;
                        this.localIndex[item.path] = { ...entry };
                        this.dirtyPaths.delete(item.path);
                        await this.saveLocalIndex();

                        // Ensure lock is released
                        if (isText && localBase?.hash) {
                            await this.releaseMergeLock(item.path, logPrefix);
                        }

                        await this.notify(
                            `${this.t("noticeConflictSaved") || "Conflict detected. Local file moved to"}: ${conflictPath.split("/").pop()}`,
                            true,
                            isSilent,
                        );
                        return true;
                    } else {
                        // Both Local and Remote match our last known index state.
                        await this.log(
                            `[${logPrefix}] Skipping redundant update (already in sync): ${item.path}`,
                        );

                        // If we were waiting for conflict resolution but nothing changed (e.g. other device kept its local version as conflict file),
                        // we should still notify the user to check the other device.
                        if (this.localIndex[item.path]?.pendingConflict) {
                            delete this.localIndex[item.path].pendingConflict;
                            // Persist the state change
                            await this.saveLocalIndex();

                            // If we were waiting for conflict resolution and content now matches,
                            // the other device successfully pushed the merge result.
                            await this.notify(
                                `${this.t("noticeRemoteMergeSynced")}: ${item.path.split("/").pop()}`,
                                true,
                                isSilent,
                            );
                        }

                        if (isRemoteDeleted) {
                            await this.log(
                                `[${logPrefix}] Deleting local file after moving to conflict (remote deleted): ${item.path}`,
                            );
                            // Primary file is gone (moved to conflict)
                            delete this.index[item.path];
                            delete this.localIndex[item.path];
                            this.dirtyPaths.delete(item.path);
                            await this.saveLocalIndex();
                            return true;
                        }

                        return true;
                    }
                } catch (err) {
                    await this.log(`[${logPrefix}] Conflict check error for ${item.path}: ${err}`);
                    // If error during check, stay safe and DON'T overwrite
                    return false;
                }
            }

            // Normal download flow (new file or unmodified local)
            this.syncingPaths.add(item.path);
            await this.ensureLocalFolder(item.path);

            const content = await this.adapter.downloadFile(fileId || "");
            await this.app.vault.adapter.writeBinary(item.path, content);

            const stat = await this.app.vault.adapter.stat(item.path);
            const entry = {
                fileId: fileId || "",
                mtime: stat?.mtime || item.mtime || Date.now(),
                size: stat?.size || item.size || content.byteLength,
                hash: item.hash || "",
                lastAction: "pull" as const,
                ancestorHash: item.hash || "", // Set ancestor for future merges
            };
            this.index[item.path] = entry;
            this.localIndex[item.path] = { ...entry };
            await this.saveLocalIndex();

            await this.notify(
                `${this.t("noticeFilePulled")}: ${item.path.split("/").pop()}`,
                true,
                isSilent,
            );
            return true;
        } catch (e) {
            await this.log(`[${logPrefix}] Pull failed: ${item.path} - ${e}`);
            return false;
        } finally {
            this.syncingPaths.delete(item.path);
        }
    }
}
