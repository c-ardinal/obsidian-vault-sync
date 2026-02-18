import type { App, Notice } from "obsidian";
import type { CloudAdapter } from "../types/adapter";
import type { RevisionCache } from "../revision-cache";
import type {
    SyncManagerSettings,
    LocalFileIndex,
    SyncState,
    FullScanProgress,
    CommunicationData,
} from "./types";
import type { SyncTrigger } from "./notification-matrix";
import type { SyncLogger, LogLevel } from "./logger";
import type { BackgroundTransferQueue } from "./background-transfer";

/**
 * Shared context interface for extracted sync-manager sub-modules.
 *
 * SyncManager implements this interface implicitly — extracted functions
 * receive `this` (cast as SyncContext) so they can access shared state
 * without depending on the SyncManager class directly.
 */
export interface SyncContext {
    // === Platform ===
    app: App;
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

    // === Caches ===
    revisionCache: RevisionCache;
    cryptoEngine: import("../encryption/interfaces").ICryptoEngine | null;

    // === Background Transfer ===
    backgroundTransferQueue: BackgroundTransferQueue;

    // === Utility Methods (remain on SyncManager, called via ctx) ===
    log: (message: string, level?: LogLevel) => Promise<void>;
    notify: (key: string, suffix?: string) => Promise<void>;
    startActivity: () => void;
    endActivity: () => void;
    onActivityStart: () => void;
    onActivityEnd: () => void;
    onSettingsUpdated: () => Promise<void>;

    // === Delegate Methods (called via ctx so vi.spyOn on facade class works) ===
    smartPull: () => Promise<boolean>;
    smartPush: (scanVault: boolean) => Promise<boolean>;
    pullViaChangesAPI: (drainAll?: boolean) => Promise<void>;
}
