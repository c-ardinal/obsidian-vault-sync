import type { CloudAdapter } from "../types/adapter";
import type { NoticeOptions } from "../services/notification-service";
import type { IVaultOperations } from "../types/vault-operations";
import type { RevisionCache } from "../services/revision-cache";
import type {
    SyncManagerSettings,
    LocalFileIndex,
    SyncState,
    FullScanProgress,
} from "./types";
import type { SyncTrigger } from "./notification-matrix";
import type { SyncLogger, LogLevel } from "./logger";
import type { BackgroundTransferQueue } from "./background-transfer";
import type { SyncProgressTracker } from "./sync-progress";
import type { RemoteDeletionService } from "./remote-deletion";
import type { PlanGuard } from "./sync-plan";
import type { FirstSyncGuard } from "./first-sync";

/*
 * The context is split into roles so a module can state which part it uses
 * (e.g. `ctx: SyncPlatform & SyncIndexState`) instead of taking all of it. A
 * module that takes a role can be tested with a context holding only that role.
 * SyncContext is the union of every role; SyncManager implements it.
 */

/** The vault, the cloud and the settings the sync works with */
export interface SyncPlatform {
    vault: IVaultOperations;
    adapter: CloudAdapter;
    settings: SyncManagerSettings;
    logger: SyncLogger;
    t: (key: string) => string;
}

/** Where the plugin keeps its own files */
export interface SyncPaths {
    pluginDataPath: string;
    pluginDir: string;
    localIndexPath: string;
    communicationPath: string;
    logFolder: string;
}

/** What is known to be synced: the indexes and the change-feed cursor */
export interface SyncIndexState {
    index: LocalFileIndex;
    localIndex: LocalFileIndex;
    startPageToken: string | null;
    deviceId: string;
}

/** Local changes waiting for a sync, and the state of the sync running now */
export interface SyncRuntimeState {
    syncState: SyncState;
    dirtyPaths: Map<string, number>;
    syncingPaths: Set<string>;
    deletedFolders: Set<string>;
    pendingFolderMoves: Map<string, string>; // newPath -> oldPath
    recentlyDeletedFromRemote: Set<string>;
    isInterrupted: boolean;
    fullScanProgress: FullScanProgress | null;
    currentSyncPromise: Promise<void> | null;
    syncRequestedWhileSyncing: boolean;
    nextSyncParams: { trigger: SyncTrigger; scanVault: boolean } | null;
    readonly FULL_SCAN_MAX_AGE_MS: number;
    currentTrigger: SyncTrigger;
}

/** One-off flags and the state of the add-on */
export interface SyncFlags {
    forceCleanupNextSync: boolean;
    indexLoadFailed: boolean;
    isSpinning: boolean;
    settingsUpdated: boolean;
    /** Read through content-identity.ts in the sync code, not directly */
    e2eeEnabled: boolean;
    e2eeLocked: boolean;
    /** The file system treats NFC and NFD names as one file (macOS / iOS) */
    unicodeInsensitiveFs?: boolean;
    /** The file system treats "Note.md" and "note.md" as one file (Windows / macOS / iOS / Android) */
    caseInsensitiveFs?: boolean;
    /** The file system refuses names Windows refuses (Windows / Android) */
    windowsNameRules?: boolean;
}

/** Services the sync steps delegate to */
export interface SyncServices {
    revisionCache: RevisionCache;
    cryptoEngine: import("../encryption/interfaces").ICryptoEngine | null;
    backgroundTransferQueue: BackgroundTransferQueue;
    /** Progress for the status display (optional so test contexts can omit it) */
    progress?: SyncProgressTracker;
    /** The single path for removals on the cloud (optional so test contexts can omit it) */
    remoteDeletion?: RemoteDeletionService;
    /** Reviews destructive changes before they run (optional; absent = approve all) */
    planGuard?: PlanGuard;
    /** Asks how a device's first sync starts when both sides have notes (absent = merge) */
    firstSyncGuard?: FirstSyncGuard;
    /** Platform label and default name of this device, for the device list (set by the plugin) */
    deviceInfo?: { platform: string; defaultName: string };
}

/** Logging, notices and the callbacks to the plugin */
export interface SyncHooks {
    log: (message: string, level?: LogLevel) => Promise<void>;
    notify: (key: string, suffix?: string, options?: NoticeOptions) => Promise<void>;
    startActivity: () => void;
    endActivity: () => void;
    onActivityStart: () => void;
    onActivityEnd: () => void;
    onSettingsUpdated: () => Promise<void>;
    onSaveSettings: () => Promise<void>;
}

/** Sync steps called through the context, so vi.spyOn on the facade class works */
export interface SyncSteps {
    smartPull: () => Promise<boolean>;
    smartPush: (scanVault: boolean) => Promise<boolean>;
    pullViaChangesAPI: (drainAll?: boolean) => Promise<void>;
}

/**
 * Everything the extracted sync-manager modules can reach.
 *
 * SyncManager implements this interface implicitly: extracted functions
 * receive `this` (cast as SyncContext) so they can access shared state
 * without depending on the SyncManager class directly.
 */
export interface SyncContext
    extends SyncPlatform,
        SyncPaths,
        SyncIndexState,
        SyncRuntimeState,
        SyncFlags,
        SyncServices,
        SyncHooks,
        SyncSteps {}
