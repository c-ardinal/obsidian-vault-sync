import { CloudAdapter } from "../types/adapter";
import { App, Notice } from "obsidian";
import { RevisionCache } from "../revision-cache";
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
import {
    linesToChars3 as _linesToChars3,
    perform3WayMerge as _perform3WayMerge,
    findCommonAncestorHash as _findCommonAncestorHash,
    isContentSubset as _isContentSubset,
    areSemanticallyEquivalent as _areSemanticallyEquivalent,
    pullFileSafely as _pullFileSafely,
} from "./merge";
import {
    scanObsidianChanges as _scanObsidianChanges,
    scanVaultChanges as _scanVaultChanges,
    requestSmartSync as _requestSmartSync,
    executeSmartSync as _executeSmartSync,
    smartPull as _smartPull,
    pullViaChangesAPI as _pullViaChangesAPI,
    smartPush as _smartPush,
    requestBackgroundScan as _requestBackgroundScan,
    isProgressStale as _isProgressStale,
    executeFullScan as _executeFullScan,
} from "./sync-orchestration";
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

    // === Scanning (delegated to sync-orchestration.ts) ===
    private async scanObsidianChanges(): Promise<void> {
        return _scanObsidianChanges(this as unknown as SyncContext);
    }

    private async scanVaultChanges(): Promise<void> {
        return _scanVaultChanges(this as unknown as SyncContext);
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

    // === Sync Orchestration (delegated to sync-orchestration.ts) ===

    async requestSmartSync(isSilent: boolean = true, scanVault: boolean = false): Promise<void> {
        return _requestSmartSync(this as unknown as SyncContext, isSilent, scanVault);
    }

    private async executeSmartSync(isSilent: boolean, scanVault: boolean): Promise<void> {
        return _executeSmartSync(this as unknown as SyncContext, isSilent, scanVault);
    }

    private async smartPull(isSilent: boolean): Promise<boolean> {
        return _smartPull(this as unknown as SyncContext, isSilent);
    }

    private async pullViaChangesAPI(isSilent: boolean, drainAll: boolean = false): Promise<boolean> {
        return _pullViaChangesAPI(this as unknown as SyncContext, isSilent, drainAll);
    }

    private async smartPush(isSilent: boolean, scanVault: boolean): Promise<boolean> {
        return _smartPush(this as unknown as SyncContext, isSilent, scanVault);
    }

    async requestBackgroundScan(resume: boolean = false): Promise<void> {
        return _requestBackgroundScan(this as unknown as SyncContext, resume);
    }

    private isProgressStale(): boolean {
        return _isProgressStale(this as unknown as SyncContext);
    }

    private async executeFullScan(): Promise<void> {
        return _executeFullScan(this as unknown as SyncContext);
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

    // === Merge / Conflict Resolution (delegated to merge.ts) ===

    private linesToChars3(text1: string, text2: string, text3: string) {
        return _linesToChars3(text1, text2, text3);
    }
    private async perform3WayMerge(
        path: string, localContentStr: string, remoteContentStr: string, baseHash: string,
    ): Promise<ArrayBuffer | null> {
        return _perform3WayMerge(this as unknown as SyncContext, path, localContentStr, remoteContentStr, baseHash);
    }

    private async findCommonAncestorHash(path: string, localHash: string, remoteHash: string): Promise<string | null> {
        return _findCommonAncestorHash(this as unknown as SyncContext, path, localHash, remoteHash);
    }

    private isContentSubset(subset: string, superset: string): boolean {
        return _isContentSubset(subset, superset);
    }

    private areSemanticallyEquivalent(contentA: string, contentB: string): boolean {
        return _areSemanticallyEquivalent(contentA, contentB);
    }

    async restoreRevision(
        path: string,
        revision: import("../types/adapter").FileRevision,
    ): Promise<void> {
        return _restoreRevision(this as unknown as SyncContext, path, revision);
    }

    private async pullFileSafely(
        item: { path: string; fileId?: string; id?: string; hash?: string; mtime?: number; size?: number },
        isSilent: boolean,
        logPrefix: string,
    ): Promise<boolean> {
        return _pullFileSafely(this as unknown as SyncContext, item, isSilent, logPrefix);
    }
}
