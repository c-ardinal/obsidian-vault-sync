import type { VaultSyncSettings } from "../types/settings";

export type SyncManagerSettings = Pick<
    VaultSyncSettings,
    | "concurrency"
    | "remoteTrashRetentionDays"
    | "autoKeepRevisionDays"
    | "largeFileThresholdMB"
    | "bgTransferIntervalSec"
    | "notificationLevel"
    | "showSyncStatus"
    | "conflictResolutionStrategy"
    | "enableLogging"
    | "isDeveloperMode"
    | "exclusionPatterns"
    | "desktopExclusionPatterns"
    | "mobileExclusionPatterns"
    | "syncAppearance"
    | "syncCommunityPlugins"
    | "syncCoreConfig"
    | "syncImagesAndMedia"
    | "syncDotfiles"
    | "syncPluginSettings"
    | "syncFlexibleData"
    | "syncDeviceLogs"
    | "syncWorkspace"
    | "hasCompletedFirstSync"
    | "e2eeEnabled"
>;

export interface LocalFileIndex {
    [path: string]: {
        fileId: string;
        mtime: number;
        size: number;
        hash?: string; // Hash of the actual content on remote (encrypted if E2EE is enabled)
        /** For E2EE: Hash of the plaintext content before encryption.
         *  Used to detect if re-upload is needed (since same plaintext produces different ciphertext with AES-GCM) */
        plainHash?: string;
        /** Tracks last sync action: "push" = uploaded by this device, "pull" = downloaded, "merge" = locally merged (needs push) */
        lastAction?: "push" | "pull" | "merge";
        /** Hash of the common ancestor (last known synced state between devices).
         *  Set on pull, preserved on push. Used as base for 3-way merge. */
        ancestorHash?: string;
        /** Set when our own upload is confirmed: the version that upload was built on.
         *  A newer remote version that names its base is then checked against the file's
         *  history: another device may have uploaded over ours from an older base (the
         *  cloud has no compare-and-set), and then we merge instead of accepting it. */
        ownPushBase?: string;
/** True when this device detected a conflict and is waiting for another device to resolve it */
        pendingConflict?: boolean;
        /** If true, force upload even if hash matches (used for renaming to trigger PATCH) */
        forcePush?: boolean;
        /** If set, this file should be moved on remote instead of re-uploaded.
         *  Contains the old path from which the file was moved. */
        pendingMove?: {
            oldPath: string;
        };
        /** If set, a background transfer is in progress for this file */
        pendingTransfer?: {
            direction: "push" | "pull";
            enqueuedAt: number;
            snapshotHash: string;
        };
    };
}

// === Notification / Trigger Types ===
export type { SyncTrigger } from "./notification-matrix";

// === Hybrid Sync Types ===

/** Sync engine states for preemption control */
export type SyncState = "IDLE" | "SMART_SYNCING" | "FULL_SCANNING" | "PAUSED" | "MIGRATING";

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
    /** Cloud file id. Devices can know the same file under different paths
     *  (one has applied a rename, the other not yet), so locks also match by id. */
    fileId?: string;
}

/** Communication data for real-time device-to-device messaging */
export interface CommunicationData {
    /** Active merge locks by file path */
    mergeLocks: { [path: string]: MergeLockEntry };
    /** Last update timestamp */
    lastUpdated: number;
    // Future extensions: messages, deviceStatus, etc.
}
