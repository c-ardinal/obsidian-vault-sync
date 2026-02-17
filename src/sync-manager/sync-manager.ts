import { CloudAdapter } from "../types/adapter";
import { App, Notice } from "obsidian";
import { RevisionCache } from "../revision-cache";
import {
    CommunicationData,
    FullScanProgress,
    LocalFileIndex,
    MergeLockEntry,
    SyncManagerSettings,
    SyncState,
} from "./types";
import { SyncLogger, type LogLevel } from "./logger";
import { ICryptoEngine } from "../encryption/interfaces";
import { EncryptedAdapter } from "../adapters/encrypted-adapter";
import { VaultLockService } from "../services/vault-lock-service";
import { MigrationService } from "../services/migration-service";
import { SecureStorage } from "../secure-storage";
import {
    type SyncTrigger,
    shouldShowNotification,
    ALWAYS_SHOW_ACTIVITY,
    TRIGGER_PRIORITY,
} from "./notification-matrix";
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
import { BackgroundTransferQueue } from "./background-transfer";
import type { TransferItem, TransferRecord, TransferCallbacks } from "./transfer-types";
export type { SyncManagerSettings, LocalFileIndex, SyncState, FullScanProgress, CommunicationData };
export type { SyncTrigger } from "./notification-matrix";
export type { TransferItem, TransferRecord, TransferCallbacks } from "./transfer-types";

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

    public logger: SyncLogger;
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
    /** Mapping of newly created folders to their source path (for move detection) */
    private pendingFolderMoves: Map<string, string> = new Map();
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
    private indexLoadFailed: boolean = false;

    public cryptoEngine: ICryptoEngine | null = null;
    public vaultLockService: VaultLockService;
    public migrationService: MigrationService;
    public secureStorage: SecureStorage | null = null;
    private baseAdapter: CloudAdapter;
    private encryptedAdapter: EncryptedAdapter | null = null;

    /** Background transfer queue for large file async transfers */
    private backgroundTransferQueue: BackgroundTransferQueue;

    /** Current sync trigger — controls notification visibility via matrix lookup */
    public currentTrigger: SyncTrigger = "manual-sync";

    public isSyncing(): boolean {
        return this.syncState !== "IDLE";
    }

    private onActivityStart: () => void = () => {};
    private onActivityEnd: () => void = () => {};
    public onSettingsUpdated: () => Promise<void> = async () => {};
    private isSpinning = false;
    public settingsUpdated = false;

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

    get adapter(): CloudAdapter {
        if (this.settings.e2eeEnabled && this.cryptoEngine?.isUnlocked()) {
            if (!this.encryptedAdapter) {
                this.encryptedAdapter = new EncryptedAdapter(this.baseAdapter, this.cryptoEngine);
            }
            return this.encryptedAdapter;
        }
        return this.baseAdapter;
    }

    get e2eeEnabled(): boolean {
        return this.settings.e2eeEnabled;
    }

    get e2eeLocked(): boolean {
        return this.settings.e2eeEnabled && (!this.cryptoEngine || !this.cryptoEngine.isUnlocked());
    }

    private vaultLockedNotified = false;

    private syncRequestedWhileSyncing: boolean = false;
    private nextSyncParams: { trigger: SyncTrigger; scanVault: boolean } | null = null;

    constructor(
        private app: App,
        adapter: CloudAdapter,
        private pluginDataPath: string,

        private settings: SyncManagerSettings,
        private pluginDir: string,
        public t: (key: string) => string,
    ) {
        this.baseAdapter = adapter;
        this.backgroundTransferQueue = new BackgroundTransferQueue();
        this.vaultLockService = new VaultLockService(this.baseAdapter);
        this.migrationService = new MigrationService(
            this.app,
            this.baseAdapter,
            this.vaultLockService,
            this as unknown as SyncContext,
        );

        // Initial log folder before device ID is known (will be corrected by loadLocalIndex)
        this.logFolder = `${this.pluginDir}/logs/identity_pending`;
        this.localIndexPath = `${this.pluginDir}/data/local/local-index.json`;
        // communication.json is in the data/remote directory
        this.communicationPath = this.pluginDataPath.replace(
            "sync-index.json",
            "communication.json",
        );

        this.logger = new SyncLogger({
            onWrite: (line) => this.writeToLogFile(line),
            enableLogging: this.settings.enableLogging,
            isDeveloperMode: this.settings.isDeveloperMode,
        });

        this.baseAdapter.setLogger((msg, level) => this.log(msg, (level as LogLevel) || "debug"));
        this.revisionCache = new RevisionCache(this.app, this.pluginDir);
        this.backgroundTransferQueue.setContext(this as unknown as SyncContext);
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

    // === Background Transfer Public API ===

    public getActiveTransfers(): TransferItem[] {
        return this.backgroundTransferQueue.getPendingTransfers();
    }

    public getTransferHistory(limit?: number): TransferRecord[] {
        const history = this.backgroundTransferQueue.getHistory();
        return limit ? history.slice(-limit) : history;
    }

    public setTransferCallbacks(callbacks: TransferCallbacks): void {
        this.backgroundTransferQueue.setCallbacks(callbacks);
    }

    /**
     * Live-update logger options when settings change.
     */
    public updateLoggerOptions() {
        this.logger.setOptions({
            enableLogging: this.settings.enableLogging,
            isDeveloperMode: this.settings.isDeveloperMode,
        });
    }

    async log(message: string, level: LogLevel = "info") {
        await this.logger.log(level, message);
    }

    /**
     * Internal disk-writing logic.
     * Only called by SyncLogger when it decides to persist.
     */
    private async writeToLogFile(line: string) {
        try {
            const now = new Date();
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
     * Show notification using table-driven visibility control.
     *
     * Visibility is determined by looking up (key, currentTrigger, notificationLevel)
     * in the notification matrix (notification-matrix.ts), which mirrors
     * doc/spec/notification-case-matrix.md.
     *
     * @param key    i18n message key (e.g. "noticeSyncing")
     * @param suffix Optional text: appended as ": {suffix}" or replaces {0} placeholder
     */
    public async notify(key: string, suffix?: string) {
        const level = this.settings.notificationLevel;

        let message = this.t(key);
        if (suffix) {
            message = message.includes("{0}")
                ? message.replace("{0}", suffix)
                : `${message}: ${suffix}`;
        }

        const show = shouldShowNotification(key, this.currentTrigger, level);

        if (show) {
            this.logger.markNoticeShown();
            new Notice(message);
            await this.logger.notice(message);
        } else {
            await this.logger.info(`[Silent] ${message}`);
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

    private async acquireMergeLock(
        path: string,
    ): Promise<{ acquired: boolean; holder?: string; expiresIn?: number }> {
        return _acquireMergeLock(this as unknown as SyncContext, path);
    }

    private async releaseMergeLock(path: string, logPrefix?: string): Promise<void> {
        return _releaseMergeLock(this as unknown as SyncContext, path, logPrefix);
    }

    private async checkMergeLock(
        path: string,
    ): Promise<{ locked: boolean; holder?: string; expiresIn?: number }> {
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

    async requestSmartSync(
        trigger: SyncTrigger = "manual-sync",
        scanVault: boolean = false,
    ): Promise<void> {
        if (this.syncState === "MIGRATING") {
            await this.log(`Sync request (${trigger}) skipped: Migration in progress.`, "warn");
            return;
        }
        if (this.e2eeLocked) {
            const isUserAction = trigger === "manual-sync" || trigger === "full-scan";
            if (isUserAction || !this.vaultLockedNotified) {
                this.currentTrigger = trigger;
                await this.log("Sync skipped: Vault is locked (E2EE).", "warn");
                await this.notify("noticeVaultLocked");
                this.vaultLockedNotified = true;
            }
            return;
        }
        this.vaultLockedNotified = false;
        this.currentTrigger = trigger;
        return _requestSmartSync(this as unknown as SyncContext, scanVault);
    }

    private async executeSmartSync(scanVault: boolean): Promise<void> {
        return _executeSmartSync(this as unknown as SyncContext, scanVault);
    }

    private async smartPull(): Promise<boolean> {
        return _smartPull(this as unknown as SyncContext);
    }

    private async pullViaChangesAPI(drainAll: boolean = false): Promise<boolean> {
        return _pullViaChangesAPI(this as unknown as SyncContext, drainAll);
    }

    private async smartPush(scanVault: boolean): Promise<boolean> {
        return _smartPush(this as unknown as SyncContext, scanVault);
    }

    public async requestBackgroundScan(resume: boolean = false): Promise<void> {
        if (this.e2eeLocked) return;
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

    async setRevisionKeepForever(
        path: string,
        revisionId: string,
        keepForever: boolean,
    ): Promise<void> {
        return _setRevisionKeepForever(
            this as unknown as SyncContext,
            path,
            revisionId,
            keepForever,
        );
    }

    async deleteRevision(path: string, revisionId: string): Promise<void> {
        return _deleteRevision(this as unknown as SyncContext, path, revisionId);
    }

    // === Merge / Conflict Resolution (delegated to merge.ts) ===

    private linesToChars3(text1: string, text2: string, text3: string) {
        return _linesToChars3(text1, text2, text3);
    }
    private async perform3WayMerge(
        path: string,
        localContentStr: string,
        remoteContentStr: string,
        baseHash: string,
    ): Promise<ArrayBuffer | null> {
        return _perform3WayMerge(
            this as unknown as SyncContext,
            path,
            localContentStr,
            remoteContentStr,
            baseHash,
        );
    }

    private async findCommonAncestorHash(
        path: string,
        localHash: string,
        remoteHash: string,
    ): Promise<string | null> {
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
        item: {
            path: string;
            fileId?: string;
            id?: string;
            hash?: string;
            mtime?: number;
            size?: number;
        },
        logPrefix: string,
    ): Promise<boolean> {
        return _pullFileSafely(this as unknown as SyncContext, item, logPrefix);
    }
}
