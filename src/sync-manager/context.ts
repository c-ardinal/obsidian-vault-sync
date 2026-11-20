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

/**
 * Shared context interface for extracted sync-manager sub-modules.
 *
 * SyncManager implements this interface implicitly — extracted functions
 * receive `this` (cast as SyncContext) so they can access shared state
 * without depending on the SyncManager class directly.
 */
export interface SyncContext {
    // === Platform ===
    vault: IVaultOperations;
    adapter: CloudAdapter;
    settings: SyncManagerSettings;
    logger: SyncLogger;
    t: (key: string) => string;

    // === Paths ===
    pluginDataPath: string;
    pluginDir: string;
    localIndexPath: string;
    communicationPath: string;
    logFolder: string;

    // === Core Sync State ===
    index: LocalFileIndex;
    localIndex: LocalFileIndex;
    startPageToken: string | null;
    deviceId: string;

    // === Hybrid Sync State ===
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

    // === Notification / Trigger ===
    currentTrigger: SyncTrigger;

    // === Flags ===
    forceCleanupNextSync: boolean;
    indexLoadFailed: boolean;
    isSpinning: boolean;
    settingsUpdated: boolean;
    e2eeEnabled: boolean;
    e2eeLocked: boolean;
    /** The file system treats NFC and NFD names as one file (macOS / iOS) */
    unicodeInsensitiveFs?: boolean;

    // === Caches ===
    revisionCache: RevisionCache;
    cryptoEngine: import("../encryption/interfaces").ICryptoEngine | null;

    // === Background Transfer ===
    backgroundTransferQueue: BackgroundTransferQueue;
    /** Progress for the status display (optional so test contexts can omit it) */
    progress?: SyncProgressTracker;
    /** The single path for removals on the cloud (optional so test contexts can omit it) */
    remoteDeletion?: RemoteDeletionService;
    /** Reviews destructive changes before they run (optional; absent = approve all) */
    planGuard?: PlanGuard;

    // === Utility Methods (remain on SyncManager, called via ctx) ===
    log: (message: string, level?: LogLevel) => Promise<void>;
    notify: (key: string, suffix?: string, options?: NoticeOptions) => Promise<void>;
    startActivity: () => void;
    endActivity: () => void;
    onActivityStart: () => void;
    onActivityEnd: () => void;
    onSettingsUpdated: () => Promise<void>;
    onSaveSettings: () => Promise<void>;

    // === Delegate Methods (called via ctx so vi.spyOn on facade class works) ===
    smartPull: () => Promise<boolean>;
    smartPush: (scanVault: boolean) => Promise<boolean>;
    pullViaChangesAPI: (drainAll?: boolean) => Promise<void>;
}
