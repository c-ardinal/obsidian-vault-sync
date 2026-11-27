import type { OAuthMethod } from "./oauth-adapter";

export const DATA_LOCAL_DIR = "data/local";
export const DATA_REMOTE_DIR = "data/remote";
export const DATA_FLEXIBLE_DIR = "data/flexible";

export interface TriggerSettings {
    enableStartupSync: boolean;
    autoSyncIntervalSec: number;
    onSaveDelaySec: number;
    onModifyDelaySec: number;
    onLayoutChangeDelaySec: number;
}

export interface VaultSyncerSettings {
    // Sync Triggers Strategy
    triggerConfigStrategy: "unified" | "per-platform";
    unifiedTriggers: TriggerSettings;
    desktopTriggers: TriggerSettings;
    mobileTriggers: TriggerSettings;

    // Internal hidden state (updated based on interval)
    enableAutoSyncInInterval: boolean;

    // Performance
    concurrency: number; // Max Concurrent Uploads
    /** Size threshold (MB) for background transfer. Files larger than this are transferred
     *  asynchronously outside the sync cycle. Set to 0 to disable (all files inline). Default: 5 */
    largeFileThresholdMB: number;
    /** Delay (seconds) between consecutive background transfer items. 0 = no throttling. */
    bgTransferIntervalSec: number;
    /** Large (background) transfers wait while on a mobile network (Android, PC) */
    deferLargeOnCellular: boolean;
    /** Large (background) transfers wait while the battery is low and not charging (Android, PC) */
    deferLargeOnLowBattery: boolean;
    /** Ask before one sync deletes this many files or more (-1 = never ask by count) */
    massDeleteConfirmFiles: number;
    /** Ask before one sync deletes this share (%) of the synced files or more (-1 = off) */
    massDeleteConfirmPercent: number;
    /** Days a file deleted from the cloud stays in the cloud trash (-1 = removed at once) */
    remoteTrashRetentionDays: number;
    /** Keep one version of each note for good per this many days (-1 = off) */
    autoKeepRevisionDays: number;
    /** Also keep versions of attachments (images, PDFs, ...), not only notes */
    autoKeepAttachmentRevisions: boolean;

    notificationLevel: "verbose" | "standard" | "error";
    /** Status bar / mobile progress display of the running sync. Progress notices are
     *  folded into it unless the notification level is verbose. */
    showSyncStatus: boolean;
    /** Small marks in the file explorer: not sent yet, conflict copy */
    showFileExplorerMarks: boolean;
    /** Text size (px) of the history diff view, per device type */
    diffFontSizeDesktop: number;
    diffFontSizeMobile: number;

    // Conflict Resolution
    conflictResolutionStrategy: "smart-merge" | "force-local" | "force-remote" | "always-fork";

    // Developer (Hidden by default)
    isDeveloperMode: boolean;
    enableLogging: boolean;
    startupDelaySec: number;

    cloudRootFolder: string;

    // Exclusion
    exclusionPatterns: string;
    /**
     * Patterns PCs / mobile devices leave out (synced, like the PC / mobile
     * trigger settings). Unlike exclusionPatterns, matching files stay in the
     * cloud for the other kind of device: devices of this kind just neither
     * download, upload nor delete them.
     */
    /** Files larger than this (MB) are left out on PCs (-1 = no limit) */
    desktopMaxFileSizeMB: number;
    /** Files larger than this (MB) are left out on mobile devices (-1 = no limit) */
    mobileMaxFileSizeMB: number;
    desktopExclusionPatterns: string;
    mobileExclusionPatterns: string;

    // Sync Scope Options
    syncAppearance: boolean; // .obsidian/themes, snippets, etc.
    syncCommunityPlugins: boolean; // .obsidian/plugins (excluding this plugin)
    syncCoreConfig: boolean; // .obsidian/app.json, hotkeys.json, etc.
    syncImagesAndMedia: boolean; // Images, Audio, Video, PDF
    syncDotfiles: boolean; // .git, .trash, etc. (Default: false)
    syncPluginSettings: boolean; // data/flexible/open-data.json (renamed from this plugin's data.json)

    // New Flexible Sync Options
    syncFlexibleData: boolean; // data/flexible/*
    syncDeviceLogs: boolean; // logs/{deviceId}/*
    syncWorkspace: boolean; // workspace.json, workspace-mobile.json
    /** The .obsidian categories above: the same on every device, or set per kind of device */
    obsidianScopeStrategy: "unified" | "per-platform";
    desktopObsidianScope: ObsidianScope;
    mobileObsidianScope: ObsidianScope;

    // Authentication
    authMethod: OAuthMethod;
    customProxyUrl: string;

    // Security
    encryptionSecret: string;
    e2eeEnabled: boolean;
    e2eeAutoUnlock: boolean; // Store password for auto-unlock (opt-in with warning)
    /** Add-ons the user installed, with the exact terms they agreed to. Keyed by add-on id. */
    addonAgreements?: Record<
        string,
        { name: string; version: string; termsHash: string; agreedAt: string }
    >;
    // Internal State
    hasCompletedFirstSync: boolean;
    /** Shape version of these settings (see services/settings-migration.ts). Absent = 0. */
    settingsVersion?: number;
}

/** The .obsidian categories that can be set per kind of device (PC or mobile) */
export const OBSIDIAN_SCOPE_KEYS = ["syncCoreConfig", "syncCommunityPlugins", "syncAppearance", "syncWorkspace"] as const;
export type ObsidianScopeKey = (typeof OBSIDIAN_SCOPE_KEYS)[number];
export type ObsidianScope = Record<ObsidianScopeKey, boolean>;
