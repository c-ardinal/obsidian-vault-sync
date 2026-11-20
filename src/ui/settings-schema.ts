import { Notice, Platform } from "obsidian";
import { ConfirmModal } from "./confirm-modal";
import { isValidCloudRootFolder } from "../utils/cloud-root";
import { VaultSyncSettings } from "../types/settings";
import { SETTINGS_LIMITS } from "../constants";
import { t } from "../i18n";
import VaultSync from "../main";

export type SettingType = "toggle" | "text" | "number" | "toggle-number" | "dropdown" | "textarea" | "info" | "subheader" | "button";

export interface SettingItem {
    key: string; // Changed from keyof VaultSyncSettings to support nested paths
    type: SettingType;
    label: string;
    desc?: string;
    placeholder?: string;
    options?: Record<string, string>; // For dropdown: value -> label
    unit?: string;
    // Number type specific
    limits?: {
        min: number;
        max: number;
        default: number;
        disabled?: number;
    };
    // Custom behaviors
    onChange?: (value: unknown, plugin: VaultSync) => Promise<void>;
    /** Text only: run onChange when the field is committed (blur / Enter), then show the saved value. */
    commitOnBlur?: boolean;
    isHidden?: (settings: VaultSyncSettings, plugin: VaultSync) => boolean;
    getDesc?: (settings: VaultSyncSettings, plugin: VaultSync) => string;
    /** Button only: its text and what it does */
    buttonText?: string;
    onClick?: (plugin: VaultSync) => void;
}

export interface SettingSection {
    id: string;
    title: string;
    description?: string;
    items: SettingItem[];
    isHidden?: (settings: VaultSyncSettings, plugin: VaultSync) => boolean;
}

const DEFAULT_CLOUD_ROOT = "ObsidianVaultSync";

const getTriggerItems = (prefix: string): SettingItem[] => [
    // ── Startup ──
    {
        key: "_subheader_startup",
        type: "subheader",
        label: t("settingSubheaderStartup"),
    },
    {
        key: `${prefix}.enableStartupSync`,
        type: "toggle",
        label: t("settingStartupSync"),
        desc: t("settingStartupSyncDesc"),
    },
    {
        key: `${prefix}.autoSyncIntervalSec`,
        type: "toggle-number",
        label: t("settingAutoSyncInterval"),
        desc: t("settingAutoSyncIntervalDesc"),
        limits: SETTINGS_LIMITS.autoSyncInterval,
        unit: t("unitSec"),
        onChange: async (val, p) => {
            p.settings.enableAutoSyncInInterval = val !== SETTINGS_LIMITS.autoSyncInterval.disabled;
            await p.saveSettings();
            p.setupAutoSyncInterval();
        },
    },
    // ── Event Triggers ──
    {
        key: "_subheader_event_triggers",
        type: "subheader",
        label: t("settingSubheaderEventTriggers"),
    },
    {
        key: `${prefix}.onSaveDelaySec`,
        type: "toggle-number",
        label: t("settingTriggerSave"),
        desc: t("settingTriggerSaveDesc"),
        limits: SETTINGS_LIMITS.onSaveDelay,
        unit: t("unitSec"),
    },
    {
        key: `${prefix}.onModifyDelaySec`,
        type: "toggle-number",
        label: t("settingModify"),
        desc: t("settingModifyDesc"),
        limits: SETTINGS_LIMITS.onModifyDelay,
        unit: t("unitSec"),
    },
    {
        key: `${prefix}.onLayoutChangeDelaySec`,
        type: "toggle-number",
        label: t("settingTriggerLayout"),
        desc: t("settingTriggerLayoutDesc"),
        limits: SETTINGS_LIMITS.onLayoutChangeDelay,
        unit: t("unitSec"),
    },
];

export const getSettingsSections = (plugin: VaultSync): SettingSection[] => {
    return [
        {
            id: "performance",
            title: t("settingPerfSection"),
            items: [
                // ── Sync Behavior ──
                {
                    key: "_subheader_sync_behavior",
                    type: "subheader",
                    label: t("settingSubheaderSyncBehavior"),
                },
                {
                    key: "conflictResolutionStrategy",
                    type: "dropdown",
                    label: t("settingConflictStrategy"),
                    desc: t("settingConflictStrategyDesc"),
                    options: {
                        "smart-merge": t("settingConflictStrategySmart"),
                        "always-fork": t("settingConflictStrategyFork"),
                        "force-local": t("settingConflictStrategyLocal"),
                        "force-remote": t("settingConflictStrategyRemote"),
                    },
                },
                {
                    key: "notificationLevel",
                    type: "dropdown",
                    label: t("settingNotificationLevel"),
                    desc: t("settingNotificationLevelDesc"),
                    options: {
                        verbose: t("settingNotificationLevelVerbose"),
                        standard: t("settingNotificationLevelStandard"),
                        error: t("settingNotificationLevelError"),
                    },
                },
                {
                    key: "showSyncStatus",
                    type: "toggle",
                    label: t("settingShowSyncStatus"),
                    desc: t("settingShowSyncStatusDesc"),
                    onChange: async (_val, p) => {
                        p.refreshSyncStatusView();
                    },
                },
                // ── Deletion Safety ──
                {
                    key: "_subheader_deletion_safety",
                    type: "subheader",
                    label: t("settingSubheaderDeletionSafety"),
                },
                {
                    key: "massDeleteConfirmFiles",
                    type: "toggle-number",
                    label: t("settingMassDeleteFiles"),
                    desc: t("settingMassDeleteFilesDesc"),
                    limits: SETTINGS_LIMITS.massDeleteConfirmFiles,
                    unit: t("unitFiles"),
                },
                {
                    key: "massDeleteConfirmPercent",
                    type: "toggle-number",
                    label: t("settingMassDeletePercent"),
                    desc: t("settingMassDeletePercentDesc"),
                    limits: SETTINGS_LIMITS.massDeleteConfirmPercent,
                    unit: t("unitPercent"),
                },
                {
                    key: "remoteTrashRetentionDays",
                    type: "toggle-number",
                    label: t("settingRemoteTrash"),
                    desc: t("settingRemoteTrashDesc"),
                    limits: SETTINGS_LIMITS.remoteTrashRetentionDays,
                    unit: t("unitDays"),
                },
                {
                    key: "autoKeepRevisionDays",
                    type: "toggle-number",
                    label: t("settingAutoKeepRevisions"),
                    desc: t("settingAutoKeepRevisionsDesc"),
                    limits: SETTINGS_LIMITS.autoKeepRevisionDays,
                    unit: t("unitDays"),
                },
                {
                    key: "_open_remote_trash",
                    type: "button",
                    label: t("settingOpenRemoteTrash"),
                    desc: t("settingOpenRemoteTrashDesc"),
                    buttonText: t("settingOpenRemoteTrashButton"),
                    onClick: (p) => p.openRemoteTrash(),
                },
                // ── Performance Tuning ──
                {
                    key: "_subheader_performance",
                    type: "subheader",
                    label: t("settingSubheaderPerformance"),
                },
                {
                    key: "concurrency",
                    type: "number",
                    label: t("settingConcurrency"),
                    desc: t("settingConcurrencyDesc"),
                    limits: SETTINGS_LIMITS.concurrency,
                    unit: t("unitFiles"),
                },
                {
                    key: "largeFileThresholdMB",
                    type: "number",
                    label: t("settingLargeFileThreshold"),
                    desc: t("settingLargeFileThresholdDesc"),
                    limits: SETTINGS_LIMITS.largeFileThresholdMB,
                    unit: t("unitMB"),
                },
                {
                    key: "bgTransferIntervalSec",
                    type: "number",
                    label: t("settingBgTransferInterval"),
                    desc: t("settingBgTransferIntervalDesc"),
                    limits: SETTINGS_LIMITS.bgTransferIntervalSec,
                    unit: t("unitSec"),
                },
            ],
        },
        {
            id: "trigger_strategy",
            title: t("settingTriggerSection"),
            items: [
                {
                    key: "_subheader_trigger_mode",
                    type: "subheader",
                    label: t("settingSubheaderTriggerMode"),
                },
                {
                    key: "triggerConfigStrategy",
                    type: "dropdown",
                    label: t("settingTriggerStrategy") || "Sync Trigger Strategy", // Fallback if i18n missing
                    desc:
                        t("settingTriggerStrategyDesc") ||
                        "Choose how sync triggers are configured across devices.",
                    options: {
                        unified:
                            t("settingTriggerStrategyUnified") || "Unified (Same for all devices)",
                        "per-platform":
                            t("settingTriggerStrategyPerPlatform") ||
                            "Per Platform (PC/Mobile separately)",
                    },
                    onChange: async (_val, p) => {
                        await p.saveSettings();
                        p.setupAutoSyncInterval();
                    },
                },
            ],
        },
        {
            id: "triggers_unified",
            title: t("settingTriggerSectionUnified") || "Sync Triggers",
            isHidden: (s: VaultSyncSettings) => s.triggerConfigStrategy !== "unified",
            items: getTriggerItems("unifiedTriggers"),
        },
        {
            id: "triggers_desktop",
            title: t("settingTriggerSectionDesktop") || "Desktop Sync Triggers",
            isHidden: (s: VaultSyncSettings) =>
                s.triggerConfigStrategy !== "per-platform" || Platform.isMobile,
            items: getTriggerItems("desktopTriggers"),
        },
        {
            id: "triggers_mobile",
            title: t("settingTriggerSectionMobile") || "Mobile Sync Triggers",
            isHidden: (s: VaultSyncSettings) =>
                s.triggerConfigStrategy !== "per-platform" || !Platform.isMobile,
            items: getTriggerItems("mobileTriggers"),
        },
        {
            id: "sync_scope",
            title: t("settingSyncScopeSection"),
            items: [
                // ── Cloud Storage ──
                {
                    key: "_subheader_cloud_storage",
                    type: "subheader",
                    label: t("settingSubheaderCloudStorage"),
                },
                {
                    key: "cloudRootFolder",
                    type: "text",
                    label: t("settingCloudRootFolder"),
                    desc: t("settingCloudRootFolderDesc"),
                    placeholder: "ObsidianVaultSync",
                    // Validate and confirm only once the field is committed (blur / Enter),
                    // never per keystroke: a half-typed name must not be saved.
                    commitOnBlur: true,
                    onChange: async (val, p) => {
                        const sanitized = String(val).trim();
                        const oldFolder = p.settings.cloudRootFolder;
                        if (sanitized === oldFolder) return;
                        if (!sanitized) {
                            // Empty means "back to default"
                            if (oldFolder === DEFAULT_CLOUD_ROOT) return;
                        } else if (!isValidCloudRootFolder(sanitized)) {
                            new Notice(t("settingCloudRootFolderInvalid"));
                            return;
                        }
                        const next = sanitized || DEFAULT_CLOUD_ROOT;
                        if (oldFolder) {
                            const ok = await new ConfirmModal(
                                p.app,
                                t("settingCloudRootFolderWarning"),
                                t("settingCloudRootFolderChange"),
                                true,
                            ).ask();
                            if (!ok) return;
                        }
                        p.settings.cloudRootFolder = next;
                        await p.saveSettings();
                        p.updateAdapterCloudRoot();
                        p.triggerFullCleanup();
                    },
                },
                // ── Obsidian Settings ──
                {
                    key: "_subheader_obsidian",
                    type: "subheader",
                    label: t("settingSubheaderObsidian"),
                },
                {
                    key: "syncCoreConfig",
                    type: "toggle",
                    label: t("settingSyncCoreConfig"),
                    desc: t("settingSyncCoreConfigDesc"),
                    onChange: async (_val, p) => p.triggerFullCleanup(),
                },
                {
                    key: "syncCommunityPlugins",
                    type: "toggle",
                    label: t("settingSyncCommunityPlugins"),
                    desc: t("settingSyncCommunityPluginsDesc"),
                    onChange: async (_val, p) => p.triggerFullCleanup(),
                },
                {
                    key: "syncPluginSettings",
                    type: "toggle",
                    label: t("settingSyncPluginSettings"),
                    desc: t("settingSyncPluginSettingsDesc"),
                    onChange: async (_val, p) => p.triggerFullCleanup(),
                },
                // ── Appearance & Layout ──
                {
                    key: "_subheader_appearance",
                    type: "subheader",
                    label: t("settingSubheaderAppearance"),
                },
                {
                    key: "syncAppearance",
                    type: "toggle",
                    label: t("settingSyncAppearance"),
                    desc: t("settingSyncAppearanceDesc"),
                    onChange: async (_val, p) => p.triggerFullCleanup(),
                },
                {
                    key: "syncWorkspace",
                    type: "toggle",
                    label: t("settingSyncWorkspace"),
                    desc: t("settingSyncWorkspaceDesc"),
                    onChange: async (_val, p) => p.triggerFullCleanup(),
                },
                // ── Content ──
                {
                    key: "_subheader_content",
                    type: "subheader",
                    label: t("settingSubheaderContent"),
                },
                {
                    key: "syncImagesAndMedia",
                    type: "toggle",
                    label: t("settingSyncImagesAndMedia"),
                    desc: t("settingSyncImagesAndMediaDesc"),
                    onChange: async (_val, p) => p.triggerFullCleanup(),
                },
                {
                    key: "syncDotfiles",
                    type: "toggle",
                    label: t("settingSyncDotfiles"),
                    desc: t("settingSyncDotfilesDesc"),
                    onChange: async (_val, p) => p.triggerFullCleanup(),
                },
                {
                    key: "syncFlexibleData",
                    type: "toggle",
                    label: t("settingSyncFlexibleData"),
                    desc: t("settingSyncFlexibleDataDesc"),
                    onChange: async (_val, p) => p.triggerFullCleanup(),
                },
                {
                    key: "syncDeviceLogs",
                    type: "toggle",
                    label: t("settingSyncDeviceLogs"),
                    desc: t("settingSyncDeviceLogsDesc"),
                    onChange: async (_val, p) => p.triggerFullCleanup(),
                },
                // ── Exclusions ──
                {
                    key: "_subheader_exclusion",
                    type: "subheader",
                    label: t("settingSubheaderExclusion"),
                },
                {
                    key: "exclusionPatterns",
                    type: "textarea",
                    label: t("settingExclusionPatterns"),
                    desc: t("settingExclusionPatternsDesc"),
                    placeholder: "*.tmp\ntemp/**\n.git/**",
                    onChange: async (_val, p) => p.triggerFullCleanup(),
                },
            ],
        },
        {
            id: "advanced",
            title: t("settingAdvancedSection"),
            items: [
                // ── Logging ──
                {
                    key: "_subheader_logging",
                    type: "subheader",
                    label: t("settingSubheaderLogging"),
                },
                {
                    key: "enableLogging",
                    type: "toggle",
                    label: t("settingEnableLogging"),
                    desc: t("settingEnableLoggingDesc"),
                    onChange: async (_val, p) => {
                        p.updateLoggerOptions();
                    },
                },
            ],
        },
        {
            id: "developer",
            title: t("settingDevSection"),
            isHidden: (s: VaultSyncSettings) => !s.isDeveloperMode,
            items: [
                // ── Debug ──
                {
                    key: "_subheader_debug",
                    type: "subheader",
                    label: t("settingSubheaderDebug"),
                },
                {
                    key: "startupDelaySec",
                    type: "number",
                    label: t("settingStartupDelay"),
                    desc: t("settingStartupDelayDesc"),
                    limits: SETTINGS_LIMITS.startupDelay,
                    unit: t("unitSec"),
                },
            ],
        },
        // Auto-unlock setting, only once the add-on is installed (it owns this feature)
        ...(plugin.settings.e2eeEnabled && plugin.syncManager.cryptoEngine
            ? [
                  {
                      id: "e2ee-autounlock",
                      title: t("settingSecuritySection"),
                      items: [
                          {
                              key: "_subheader_security",
                              type: "subheader" as const,
                              label: t("settingSubheaderSecurity"),
                          },
                          {
                              key: "e2eeAutoUnlock",
                              type: "toggle" as const,
                              label: t("settingE2EEAutoUnlock"),
                              desc: t("settingE2EEAutoUnlockDesc"),
                          },
                      ],
                  },
              ]
            : []),
        ...plugin.getE2EESettingsSections(),
    ];
};
