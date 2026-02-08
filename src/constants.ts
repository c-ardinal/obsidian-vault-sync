import { VaultSyncSettings } from "./types/settings";

export const SETTINGS_LIMITS = {
    autoSyncInterval: { min: 1, max: 86400, default: 1800, disabled: -1 },
    onSaveDelay: { min: 0, max: 60, default: 0, disabled: -1 },
    onModifyDelay: { min: 0, max: 60, default: 5, disabled: -1 },
    onLayoutChangeDelay: { min: 0, max: 60, default: 0, disabled: -1 },
    concurrency: { min: 1, max: 10, default: 5, disabled: -1 },
    startupDelay: { min: 0, max: 600, default: 10 },
} as const;

export const DEFAULT_SETTINGS: VaultSyncSettings = {
    enableStartupSync: true,
    enableAutoSyncInInterval: true,
    autoSyncIntervalSec: SETTINGS_LIMITS.autoSyncInterval.default,
    onSaveDelaySec: SETTINGS_LIMITS.onSaveDelay.default,
    onModifyDelaySec: SETTINGS_LIMITS.onModifyDelay.default,
    onLayoutChangeDelaySec: SETTINGS_LIMITS.onLayoutChangeDelay.default,
    concurrency: SETTINGS_LIMITS.concurrency.default,
    notificationLevel: "standard",
    conflictResolutionStrategy: "smart-merge",
    isDeveloperMode: false,
    enableLogging: false,
    startupDelaySec: SETTINGS_LIMITS.startupDelay.default,
    cloudRootFolder: "ObsidianVaultSync",
    exclusionPatterns: ".git\n.svn\n.hg\n.bzr",
    encryptionSecret: "",
    hasCompletedFirstSync: false,
};
