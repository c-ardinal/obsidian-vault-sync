export const DATA_LOCAL_DIR = "data/local";
export const DATA_REMOTE_DIR = "data/remote";
export const DATA_FLEXIBLE_DIR = "data/flexible";

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

    // Sync Scope Options
    syncAppearance: boolean; // .obsidian/themes, snippets, etc.
    syncCommunityPlugins: boolean; // .obsidian/plugins (excluding vault-sync)
    syncCoreConfig: boolean; // .obsidian/app.json, hotkeys.json, etc.
    syncImagesAndMedia: boolean; // Images, Audio, Video, PDF
    syncDotfiles: boolean; // .git, .trash, etc. (Default: false)
    syncPluginSettings: boolean; // data/flexible/open-data.json (renamed from this plugin's data.json)

    // New Flexible Sync Options
    syncFlexibleData: boolean; // data/flexible/*
    syncDeviceLogs: boolean; // logs/{deviceId}/*
    syncWorkspace: boolean; // workspace.json, workspace-mobile.json

    // Security
    encryptionSecret: string;
    // Internal State
    hasCompletedFirstSync: boolean;
}
