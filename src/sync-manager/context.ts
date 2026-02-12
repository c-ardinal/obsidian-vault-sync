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
    dirtyPaths: Set<string>;
    syncingPaths: Set<string>;
    deletedFolders: Set<string>;
    recentlyDeletedFromRemote: Set<string>;
    isInterrupted: boolean;
    fullScanProgress: FullScanProgress | null;
    currentSyncPromise: Promise<void> | null;
    syncRequestedWhileSyncing: boolean;
    nextSyncParams: { isSilent: boolean; scanVault: boolean } | null;
    readonly FULL_SCAN_MAX_AGE_MS: number;

    // === Flags ===
    forceCleanupNextSync: boolean;
    indexLoadFailed: boolean;
    isSpinning: boolean;

    // === Caches ===
    revisionCache: RevisionCache;

    // === Utility Methods (remain on SyncManager, called via ctx) ===
    log: (message: string) => Promise<void>;
    notify: (message: string, isDetailed?: boolean, isSilent?: boolean) => Promise<void>;
    startActivity: () => void;
    endActivity: () => void;
    onActivityStart: () => void;
    onActivityEnd: () => void;

    // === Delegate Methods (called via ctx so vi.spyOn on facade class works) ===
    smartPull: (isSilent: boolean) => Promise<boolean>;
    smartPush: (isSilent: boolean, scanVault: boolean) => Promise<boolean>;
    pullViaChangesAPI: (isSilent: boolean, isIdentityCheck?: boolean) => Promise<void>;
}
