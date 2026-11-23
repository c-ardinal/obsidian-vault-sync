import { CloudAdapter } from "../types/adapter";
import { TFile } from "obsidian";
import { CtxFlag, describeCtxState } from "./context-state";
import { isQuietCycle } from "./change-peek";
import { logTail, MAX_LOG_LINES, type DiagnosticsSnapshot } from "./diagnostics";
import {
    forgetDevice as _forgetDevice,
    getDeviceName as _getDeviceName,
    listDevices as _listDevices,
    isSettingsPath,
    setDeviceName as _setDeviceName,
    type DeviceRecord,
} from "./device-registry";
import type { IVaultOperations } from "../types/vault-operations";
import type { INotificationService, NoticeOptions } from "../services/notification-service";
import { RevisionCache } from "../services/revision-cache";
import {
    CommunicationData,
    FullScanProgress,
    LocalFileIndex,
    SyncManagerSettings,
    SyncState,
} from "./types";
import { SyncLogger, type LogLevel } from "./logger";
import { ICryptoEngine } from "../encryption/interfaces";
import { EncryptedAdapter } from "../encryption/encrypted-adapter";
import { MIGRATION_LOCK_STALE_MS, VaultLockService } from "../services/vault-lock-service";
import { MigrationService } from "../services/migration-service";
import { SecureStorage } from "../services/secure-storage";
import {
    type SyncTrigger,
    shouldShowNotification,
    PROGRESS_NOTICE_KEYS,
    CONFLICT_NOTICE_KEYS,
} from "./notification-matrix";
import { SyncProgressTracker } from "./sync-progress";
import { RemoteDeletionService } from "./remote-deletion";
import { TrashRemoteDeletion, listTrash as _listTrash } from "./remote-trash";
import { applyRestore, planRestore, type PlanOptions, type RestorePlan, type RestoreResult } from "./point-in-time";
import { isFirstSyncDeferred, type FirstSyncGuard } from "./first-sync";
import { approveAllPlanGuard, type PlanGuard } from "./sync-plan";
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
import { SCAN_FULL_SCAN_MAX_AGE_MS } from "./constants";
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
import { forgetAutoKept } from "./revision-retention";
import { refreshStorage, storageSummary, storageSummaryNow, type StorageSummary } from "./storage-check";
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
import { syncErrorNotice } from "./sync-coordinator";
import { forgetReincludedFiles as _forgetReincludedFiles } from "./sync-pull";
import { noteFullCleanupRequest } from "./sync-push";
import { BackgroundTransferQueue } from "./background-transfer";
import type { TransferItem, TransferRecord, TransferCallbacks } from "./transfer-types";
export type { SyncManagerSettings, LocalFileIndex, SyncState, FullScanProgress, CommunicationData };
export type { SyncTrigger } from "./notification-matrix";

/** A vault-lock check found no lock since the plugin started */
const vaultLockClear = new CtxFlag("vaultLockClear", "A vault-lock check found no lock since the plugin started");

/** Automatic triggers whose vault-lock check can wait for a cycle that has changes */
const QUIET_TRIGGERS: ReadonlySet<SyncTrigger> = new Set<SyncTrigger>([
    "timer-sync",
    "save-sync",
    "modify-sync",
    "layout-sync",
]);
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
    private dirtyPaths: Map<string, number> = new Map();
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
    private readonly FULL_SCAN_MAX_AGE_MS = SCAN_FULL_SCAN_MAX_AGE_MS;

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

    /** Progress of the running sync, for the status display */
    public readonly progress = new SyncProgressTracker();

    /** Every removal on the cloud goes through this service */
    public readonly remoteDeletion = new RemoteDeletionService();

    /** Reviews each sync step's deletions and overwrites before they run */
    public planGuard: PlanGuard = approveAllPlanGuard;

    /** Asks how this device's first sync starts (unset = merge, as before) */
    public firstSyncGuard?: FirstSyncGuard;

    /** Platform label and default name of this device (set by the plugin) */
    public deviceInfo?: { platform: string; defaultName: string };

    /** Files the shared index lists (the plugin's own index file not counted) */
    syncedFileCount(): number {
        return Object.keys(this.index).filter((p) => p !== this.pluginDataPath).length;
    }

    /** Current sync trigger — controls notification visibility via matrix lookup */
    public currentTrigger: SyncTrigger = "manual-sync";

    public isSyncing(): boolean {
        return this.syncState !== "IDLE";
    }

    private onActivityStart: () => void = () => {};
    private onActivityEnd: () => void = () => {};
    public onSettingsUpdated: () => Promise<void> = async () => {};
    public onSaveSettings: () => Promise<void> = async () => {};
    private isSpinning = false;
    /** Set on macOS / iOS, whose file systems treat NFC and NFD names as one file */
    unicodeInsensitiveFs = false;
    /** Set on Windows / macOS / iOS / Android, whose file systems ignore letter case */
    caseInsensitiveFs = false;
    /** Set on Windows / Android, which refuse names such as "a?.md" or "con.md" */
    windowsNameRules = false;
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
                this.encryptedAdapter = new EncryptedAdapter(
                    this.baseAdapter,
                    this.cryptoEngine,
                    (this.settings.largeFileThresholdMB ?? 0) * 1024 * 1024,
                );
            }
            return this.encryptedAdapter;
        }
        return this.baseAdapter;
    }

    /** Whether the cloud account is signed in on this device */
    get isSignedIn(): boolean {
        return this.baseAdapter.isAuthenticated();
    }

    /**
     * Swap the add-on engine (null removes it). The cached adapter wraps the old
     * engine, so it is dropped as well.
     */
    setCryptoEngine(engine: ICryptoEngine | null): void {
        this.cryptoEngine = engine;
        this.encryptedAdapter = null;
    }

    get e2eeEnabled(): boolean {
        return this.settings.e2eeEnabled;
    }

    get e2eeLocked(): boolean {
        return this.settings.e2eeEnabled && (!this.cryptoEngine || !this.cryptoEngine.isUnlocked());
    }

    private vaultLockedNotified = false;
    private vaultConvertingNotified = false;

    private syncRequestedWhileSyncing: boolean = false;
    private nextSyncParams: { trigger: SyncTrigger; scanVault: boolean } | null = null;

    constructor(
        private vault: IVaultOperations,
        adapter: CloudAdapter,
        private pluginDataPath: string,
        private settings: SyncManagerSettings,
        private pluginDir: string,
        public t: (key: string) => string,
        private notifier: INotificationService,
        revisionCache: RevisionCache,
        backgroundQueue: BackgroundTransferQueue,
    ) {
        this.baseAdapter = adapter;
        this.revisionCache = revisionCache;
        this.backgroundTransferQueue = backgroundQueue;
        this.remoteDeletion.setStrategy(
            new TrashRemoteDeletion(() => this.settings.remoteTrashRetentionDays ?? -1),
        );
        this.vaultLockService = new VaultLockService(this.baseAdapter, this.remoteDeletion);
        this.migrationService = new MigrationService(
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

        this.baseAdapter.setLogger((msg, level) => {
            void this.log(msg, (level as LogLevel) || "debug");
        });
        this.backgroundTransferQueue.setContext(this as unknown as SyncContext);
    }

    /**
     * API to manually trigger a full cleanup scan on the next sync cycle.
     * Used when exclusion patterns are updated.
     */
    public triggerFullCleanup() {
        this.forceCleanupNextSync = true;
        noteFullCleanupRequest(this);
    }

    public setActivityCallbacks(onStart: () => void, onEnd: () => void) {
        this.onActivityStart = onStart;
        this.onActivityEnd = onEnd;
    }

    // === Background Transfer Public API ===

    /** Local changes waiting for the next upload */
    public get pendingChangeCount(): number {
        return this.dirtyPaths.size;
    }

    /** Why large transfers wait now (mobile network, low battery), or null */
    public getTransferDeferReason(): "cellular" | "low-battery" | null {
        return this.backgroundTransferQueue.deferredReason;
    }

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

    /** Load transfer history from disk. Must be called after loadLocalIndex() sets the correct logFolder. */
    public async loadTransferHistory(): Promise<void> {
        await this.backgroundTransferQueue.loadHistoryFromDisk();
    }

    /** Cancel all pending background transfers. */
    public cancelAllTransfers(): void {
        this.backgroundTransferQueue.cancelAll();
    }

    /** Clean up background transfer queue (event listeners, flush history). Call on plugin unload. */
    public destroyTransferQueue(): void {
        this.backgroundTransferQueue.destroy();
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
            if (!(await this.vault.exists(this.logFolder))) {
                await this.ensureLocalFolder(this.logFolder + "/dummy.txt"); // Simple trick for recursive
            }

            const existingContent = await this.vault.read(logPath).catch(() => "");
            await this.vault.write(logPath, existingContent + line);
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
    public async notify(key: string, suffix?: string, options?: NoticeOptions) {
        const level = this.settings.notificationLevel;

        let message = this.t(key);
        if (suffix) {
            message = message.includes("{0}")
                ? message.replace("{0}", suffix)
                : `${message}: ${suffix}`;
        }

        if (CONFLICT_NOTICE_KEYS.has(key)) this.progress.noteConflict();

        // With the status display on, it shows progress; notices are kept for what
        // needs attention (errors, conflicts) unless the user asked for everything.
        const show =
            shouldShowNotification(key, this.currentTrigger, level) &&
            !(this.settings.showSyncStatus && level !== "verbose" && PROGRESS_NOTICE_KEYS.has(key));

        if (show) {
            this.logger.markNoticeShown();
            if (options) this.notifier.show(message, options);
            else this.notifier.show(message);
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

    /**
     * The vault-lock check can wait for this sync: an automatic sync, nothing
     * to upload or re-check here, an earlier check found no lock, and the
     * change feed shows nothing new (a lock another device creates is a change
     * there). The next sync with any change checks again.
     */
    /**
     * Another device is converting this vault for an add-on (migration.lock): it
     * re-uploads every file into a new folder, swaps it in and deletes the old
     * folder. Whatever this device pushed meanwhile went into the old folder and
     * was deleted with it, so sync waits until the conversion is done (the
     * vault-lock then appears). A lock older than a day is a leftover of an
     * abandoned conversion (the converting device overrides it after that too).
     */
    private async otherDeviceConvertingVault(trigger: SyncTrigger): Promise<boolean> {
        const lock = await this.vaultLockService.getMigrationLock();
        if (!lock || lock.deviceId === this.deviceId) return false;
        if (!(lock.timestamp > Date.now() - MIGRATION_LOCK_STALE_MS)) return false;
        const isUserAction = trigger === "manual-sync" || trigger === "full-scan";
        await this.log(`Sync skipped: device ${lock.deviceId} is converting this vault.`, "warn");
        if (isUserAction || !this.vaultConvertingNotified) {
            this.currentTrigger = trigger;
            await this.notify("noticeVaultConverting");
            this.vaultConvertingNotified = true;
        }
        return true;
    }

    private async lockCheckCanWait(trigger: SyncTrigger): Promise<boolean> {
        if (!vaultLockClear.has(this) || !QUIET_TRIGGERS.has(trigger)) return false;
        try {
            return await isQuietCycle(this as unknown as SyncContext);
        } catch {
            return false; // the check itself reports the problem
        }
    }

    async requestSmartSync(
        trigger: SyncTrigger = "manual-sync",
        scanVault: boolean = false,
    ): Promise<void> {
        if (this.syncState === "MIGRATING") {
            await this.log(`Sync request (${trigger}) skipped: Migration in progress.`, "warn");
            return;
        }
        // Auto-detect remote E2EE before first sync attempt
        if (!this.settings.e2eeEnabled && !(await this.lockCheckCanWait(trigger))) {
            try {
                const hasRemoteLock = await this.vaultLockService.checkForLockFile();
                if (!hasRemoteLock) vaultLockClear.add(this);
                if (!hasRemoteLock && (await this.otherDeviceConvertingVault(trigger))) return;
                if (hasRemoteLock) {
                    await this.log("Remote E2EE detected. Enabling E2EE locally.", "system");
                    this.settings.e2eeEnabled = true;
                    await this.onSaveSettings();
                    await this.notify(
                        this.cryptoEngine ? "noticeE2EEAutoEnabled" : "noticeAddonRequired",
                    );
                }
            } catch (e) {
                if (this.baseAdapter.isAuthenticated()) {
                    await this.log(
                        `[E2EE Check] Remote E2EE state could not be verified: ${String(e)}. Aborting sync to prevent data corruption.`,
                        "warn",
                    );
                    // Automatic triggers stay quiet (they retry soon), but a sync the
                    // user asked for must not end without any feedback.
                    if (trigger === "manual-sync" || trigger === "full-scan") {
                        this.currentTrigger = trigger;
                        const notice = syncErrorNotice(e);
                        if (notice.suffix === undefined) await this.notify(notice.key);
                        else await this.notify(notice.key, notice.suffix);
                    }
                    return;
                }
                // Not authenticated — ignore (first API call will fail naturally)
            }
        }
        if (this.e2eeLocked) {
            const isUserAction = trigger === "manual-sync" || trigger === "full-scan";
            if (isUserAction || !this.vaultLockedNotified) {
                this.currentTrigger = trigger;
                await this.log("Sync skipped: Vault is locked (E2EE).", "warn");
                await this.notify(this.cryptoEngine ? "noticeVaultLocked" : "noticeAddonRequired");
                this.vaultLockedNotified = true;
            }
            return;
        }
        this.vaultLockedNotified = false;
        this.vaultConvertingNotified = false;
        if (isFirstSyncDeferred(this) && trigger !== "manual-sync" && trigger !== "full-scan") {
            await this.log(`Sync request (${trigger}) skipped: first sync held until a manual sync.`, "debug");
            return;
        }
        this.currentTrigger = trigger;
        // After a conversion: the old folder is checked and deleted once its grace time is over
        await this.migrationService.finishBackupCleanup();
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

    /** The cloud tells how much storage the account uses */
    get supportsStorageQuota(): boolean {
        return !!this.adapter?.getStorageQuota;
    }

    get supportsHistory(): boolean {
        return _supportsHistory(this as unknown as SyncContext);
    }

    // === Diagnostic info (diagnostics.ts) ===

    /** The sync's part of the diagnostic info */
    diagnosticsState(): Pick<
        DiagnosticsSnapshot,
        | "cloud"
        | "signedIn"
        | "addOnActive"
        | "syncState"
        | "lastError"
        | "syncedFiles"
        | "pendingChanges"
        | "backgroundTransfers"
        | "internalState"
    > {
        return {
            cloud: this.baseAdapter.name,
            signedIn: this.baseAdapter.isAuthenticated(),
            addOnActive: this.cryptoEngine !== null,
            syncState: this.syncState,
            lastError: (() => {
                const last = this.progress.snapshot().last;
                return last && last.outcome !== "ok" ? `${last.outcome}: ${last.message ?? ""}`.trim() : undefined;
            })(),
            syncedFiles: this.syncedFileCount(),
            pendingChanges: this.dirtyPaths.size,
            backgroundTransfers: this.backgroundTransferQueue.getPendingTransfers().length,
            internalState: describeCtxState(this),
        };
    }

    /**
     * This device's exclusion list changed (`previous`: the patterns before).
     * Files no longer left out come back with the next sync.
     */
    async applyDeviceScopeChange(previous: string): Promise<number> {
        // Files created or edited here while left out raised no upload: a scan finds them
        this.triggerFullCleanup();
        return _forgetReincludedFiles(this as unknown as SyncContext, previous);
    }

    /** The last lines of this device's log files (newest files first until enough) */
    async readRecentLog(max = MAX_LOG_LINES): Promise<string[]> {
        try {
            if (!(await this.vault.exists(this.logFolder))) return [];
            const files = (await this.vault.list(this.logFolder)).files.filter((f) => f.endsWith(".log")).sort();
            let lines: string[] = [];
            for (let i = files.length - 1; i >= 0 && lines.length < max; i--) {
                lines = [...logTail(await this.vault.read(files[i]), max), ...lines];
            }
            return lines.slice(Math.max(0, lines.length - max));
        } catch {
            return [];
        }
    }

    // === Point-in-time restore (point-in-time.ts) ===

    /** What a folder would get back from a past time (reads only) */
    async planPointInTimeRestore(folder: string, time: number, options: PlanOptions = {}): Promise<RestorePlan> {
        const ctx = this as unknown as SyncContext;
        return planRestore(
            {
                files: () =>
                    Object.entries(this.index)
                        .filter(([path, e]) => !!e.fileId && path !== this.pluginDataPath)
                        .map(([path, e]) => ({ path, fileId: e.fileId })),
                listRevisions: (path, fileId) => _listRevisions(ctx, path, fileId),
                listTrash: () => _listTrash(this.adapter),
                exists: (path) => this.vault.getAbstractFileByPath(path) !== null,
                excluded: (path) => this.isManagedSeparately(path) || isSettingsPath(ctx, path),
            },
            folder,
            time,
            { concurrency: this.settings.concurrency, ...options },
        );
    }

    /** Write a plan into the vault; `remove` takes away files created after the time (when asked) */
    async applyPointInTimeRestore(
        plan: RestorePlan,
        options: {
            removeCreatedAfter: boolean;
            remove: (path: string) => Promise<void>;
            onProgress?: (done: number, total: number) => void;
        },
    ): Promise<RestoreResult> {
        const ctx = this as unknown as SyncContext;
        const result = await applyRestore(
            {
                revisionContent: (path, revisionId, fileId) => _getRevisionContent(ctx, path, revisionId, fileId),
                trashContent: (file) => this.adapter.downloadFile(file.id),
                write: async (path, data) => {
                    await this.ensureLocalFolder(path);
                    const file = this.vault.getAbstractFileByPath(path);
                    if (file instanceof TFile) await this.vault.modifyBinary(file, data);
                    else await this.vault.createBinary(path, data);
                },
                remove: options.remove,
            },
            plan,
            options,
        );
        await this.log(
            `[Restore] Point in time ${new Date(plan.time).toISOString()} folder="${plan.folder}": ` +
                `restored ${result.restored}, recreated ${result.recreated}, removed ${result.removed}, failed ${result.failed.length}`,
            "info",
        );
        return result;
    }

    // === Devices and their changes (device-registry.ts) ===

    get thisDeviceId(): string {
        return this.deviceId;
    }

    async listDevices(): Promise<DeviceRecord[]> {
        return _listDevices(this as unknown as SyncContext);
    }

    async forgetDevice(deviceId: string): Promise<void> {
        return _forgetDevice(this as unknown as SyncContext, deviceId);
    }

    async getDeviceName(): Promise<string> {
        return _getDeviceName(this as unknown as SyncContext);
    }

    async setDeviceName(name: string): Promise<void> {
        return _setDeviceName(this as unknown as SyncContext, name);
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
        // Set by hand: the user's from now on, never thinned
        await forgetAutoKept(this as unknown as SyncContext, revisionId);
        return _setRevisionKeepForever(
            this as unknown as SyncContext,
            path,
            revisionId,
            keepForever,
        );
    }

    /** Cloud storage as last read (null: not read yet this session) */
    getStorageSummary(): StorageSummary | null {
        return storageSummaryNow(this as unknown as SyncContext);
    }

    /** Read the cloud storage now, or the stored reading (settings page) */
    async loadStorageSummary(refresh: boolean): Promise<StorageSummary> {
        const ctx = this as unknown as SyncContext;
        if (refresh) await refreshStorage(ctx);
        return storageSummary(ctx);
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
