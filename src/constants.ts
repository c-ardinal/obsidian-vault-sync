import { VaultSyncSettings } from "./types/settings";

export const OAUTH_REDIRECT_URI = "https://c-ardinal.github.io/obsidian-vault-sync/callback/";

export const SETTINGS_LIMITS = {
    autoSyncInterval: { min: 1, max: 86400, default: 1800, disabled: -1 },
    onSaveDelay: { min: 0, max: 60, default: 0, disabled: -1 },
    onModifyDelay: { min: 0, max: 60, default: 5, disabled: -1 },
    onLayoutChangeDelay: { min: 0, max: 60, default: 0, disabled: -1 },
    concurrency: { min: 1, max: 10, default: 5 },
    startupDelay: { min: 0, max: 600, default: 0 },
} as const;

export const DEFAULT_SETTINGS: VaultSyncSettings = {
    triggerConfigStrategy: "unified",
    unifiedTriggers: {
        enableStartupSync: true,
        autoSyncIntervalSec: SETTINGS_LIMITS.autoSyncInterval.default,
        onSaveDelaySec: SETTINGS_LIMITS.onSaveDelay.default,
        onModifyDelaySec: SETTINGS_LIMITS.onModifyDelay.default,
        onLayoutChangeDelaySec: SETTINGS_LIMITS.onLayoutChangeDelay.default,
    },
    desktopTriggers: {
        enableStartupSync: true,
        autoSyncIntervalSec: SETTINGS_LIMITS.autoSyncInterval.default,
        onSaveDelaySec: SETTINGS_LIMITS.onSaveDelay.default,
        onModifyDelaySec: SETTINGS_LIMITS.onModifyDelay.default,
        onLayoutChangeDelaySec: SETTINGS_LIMITS.onLayoutChangeDelay.default,
    },
    mobileTriggers: {
        enableStartupSync: true,
        autoSyncIntervalSec: SETTINGS_LIMITS.autoSyncInterval.default,
        onSaveDelaySec: SETTINGS_LIMITS.onSaveDelay.default,
        onModifyDelaySec: SETTINGS_LIMITS.onModifyDelay.default,
        onLayoutChangeDelaySec: SETTINGS_LIMITS.onLayoutChangeDelay.default,
    },
    enableAutoSyncInInterval: true,
    concurrency: SETTINGS_LIMITS.concurrency.default,
    notificationLevel: "standard",
    conflictResolutionStrategy: "smart-merge",
    isDeveloperMode: false,
    enableLogging: false,
    startupDelaySec: SETTINGS_LIMITS.startupDelay.default,
    cloudRootFolder: "ObsidianVaultSync",
    exclusionPatterns: ".git\n.svn\n.hg\n.bzr",

    // Sync Scope Defaults
    syncAppearance: true,
    syncCommunityPlugins: true,
    syncCoreConfig: true,
    syncImagesAndMedia: true,
    syncDotfiles: false,
    syncPluginSettings: true,
    syncFlexibleData: true,
    syncDeviceLogs: false,
    syncWorkspace: false,

    encryptionSecret: "",
    hasCompletedFirstSync: false,
    e2eeEnabled: false,
};
