export interface SyncManagerSettings {
    concurrency: number;
    notificationLevel: "verbose" | "standard" | "error";
    conflictResolutionStrategy: "smart-merge" | "force-local" | "force-remote" | "always-fork";
    enableLogging: boolean;
    exclusionPatterns: string;

    // Sync Scope Options
    syncAppearance: boolean;
    syncCommunityPlugins: boolean;
    syncCoreConfig: boolean;
    syncImagesAndMedia: boolean;
    syncDotfiles: boolean;
    syncPluginSettings: boolean;
    syncFlexibleData: boolean;
    syncDeviceLogs: boolean;
    syncWorkspace: boolean;
}

export interface LocalFileIndex {
    [path: string]: {
        fileId: string;
        mtime: number;
        size: number;
        hash?: string;
        /** Tracks last sync action: "push" = uploaded by this device, "pull" = downloaded, "merge" = locally merged (needs push) */
        lastAction?: "push" | "pull" | "merge";
        /** Hash of the common ancestor (last known synced state between devices).
         *  Set on pull, preserved on push. Used as base for 3-way merge. */
        ancestorHash?: string;
        /** @deprecated Merge locks are now stored in communication.json, not sync-index.json */
        mergeLock?: { holder: string; expiresAt: number };
        /** True when this device detected a conflict and is waiting for another device to resolve it */
        pendingConflict?: boolean;
        /** If true, force upload even if hash matches (used for renaming to trigger PATCH) */
        forcePush?: boolean;
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

// === Device Communication Types ===

/** Merge lock entry for a specific file */
export interface MergeLockEntry {
    holder: string;
    expiresAt: number;
}

/** Communication data for real-time device-to-device messaging */
export interface CommunicationData {
    /** Active merge locks by file path */
    mergeLocks: { [path: string]: MergeLockEntry };
    /** Last update timestamp */
    lastUpdated: number;
    // Future extensions: messages, deviceStatus, etc.
}
