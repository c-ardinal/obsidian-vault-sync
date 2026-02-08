export const DATA_LOCAL_DIR = "data/local";
export const DATA_REMOTE_DIR = "data/remote";

export interface VaultSyncSettings {
    // Sync Triggers
    enableStartupSync: boolean;
    // DEPRECATED/MOVED to Developer: startupDelaySec: number;

    enableAutoSyncInInterval: boolean;
    autoSyncIntervalSec: number;

    onSaveDelaySec: number;
    onModifyDelaySec: number;
    onLayoutChangeDelaySec: number;

    // Performance
    concurrency: number; // Max Concurrent Uploads

    notificationLevel: "verbose" | "standard" | "error";

    // Conflict Resolution
    conflictResolutionStrategy: "smart-merge" | "force-local" | "force-remote" | "always-fork";

    // Developer (Hidden by default)
    isDeveloperMode: boolean;
    enableLogging: boolean;
    startupDelaySec: number;

    cloudRootFolder: string;

    // Exclusion
    exclusionPatterns: string;

    // Security
    encryptionSecret: string;
    // Internal State
    hasCompletedFirstSync: boolean;
}
