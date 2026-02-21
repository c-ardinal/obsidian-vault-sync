import { Platform, Notice } from "obsidian";
import { VaultSyncSettings } from "../types/settings";
import { SETTINGS_LIMITS } from "../constants";
import { t } from "../i18n";
import VaultSync from "../main";

export type SettingType = "toggle" | "text" | "number" | "dropdown" | "textarea" | "info";

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
    onChange?: (value: any, plugin: VaultSync) => Promise<void>;
    isHidden?: (settings: VaultSyncSettings, plugin: VaultSync) => boolean;
    getDesc?: (settings: VaultSyncSettings, plugin: VaultSync) => string;
}

export interface SettingSection {
    id: string;
    title: string;
    description?: string;
    items: SettingItem[];
    isHidden?: (settings: VaultSyncSettings, plugin: VaultSync) => boolean;
}

const getTriggerItems = (prefix: string): SettingItem[] => [
    {
        key: `${prefix}.enableStartupSync`,
        type: "toggle",
        label: t("settingStartupSync"),
        desc: t("settingStartupSyncDesc"),
    },
    {
        key: `${prefix}.autoSyncIntervalSec`,
        type: "number",
        label: t("settingAutoSyncInterval"),
        desc:
            t("settingAutoSyncIntervalDesc") +
            `\n(Min: ${SETTINGS_LIMITS.autoSyncInterval.min}, Max: ${SETTINGS_LIMITS.autoSyncInterval.max}, Default: ${SETTINGS_LIMITS.autoSyncInterval.default}, Disabled: ${SETTINGS_LIMITS.autoSyncInterval.disabled})`,
        limits: SETTINGS_LIMITS.autoSyncInterval,
        unit: "SEC",
        onChange: async (val, p) => {
            p.settings.enableAutoSyncInInterval = val !== SETTINGS_LIMITS.autoSyncInterval.disabled;
            await p.saveSettings();
            p.setupAutoSyncInterval();
        },
    },
    {
        key: `${prefix}.onSaveDelaySec`,
        type: "number",
        label: t("settingTriggerSave"),
        desc:
            t("settingTriggerSaveDesc") +
            `\n(Min: ${SETTINGS_LIMITS.onSaveDelay.min}, Max: ${SETTINGS_LIMITS.onSaveDelay.max}, Default: ${SETTINGS_LIMITS.onSaveDelay.default}, Disabled: ${SETTINGS_LIMITS.onSaveDelay.disabled})`,
        limits: SETTINGS_LIMITS.onSaveDelay,
        unit: "SEC",
    },
    {
        key: `${prefix}.onModifyDelaySec`,
        type: "number",
        label: t("settingModify"),
        desc:
            t("settingModifyDesc") +
            `\n(Min: ${SETTINGS_LIMITS.onModifyDelay.min}, Max: ${SETTINGS_LIMITS.onModifyDelay.max}, Default: ${SETTINGS_LIMITS.onModifyDelay.default}, Disabled: ${SETTINGS_LIMITS.onModifyDelay.disabled})`,
        limits: SETTINGS_LIMITS.onModifyDelay,
        unit: "SEC",
    },
    {
        key: `${prefix}.onLayoutChangeDelaySec`,
        type: "number",
        label: t("settingTriggerLayout"),
        desc:
            t("settingTriggerLayoutDesc") +
            `\n(Min: ${SETTINGS_LIMITS.onLayoutChangeDelay.min}, Max: ${SETTINGS_LIMITS.onLayoutChangeDelay.max}, Default: ${SETTINGS_LIMITS.onLayoutChangeDelay.default}, Disabled: ${SETTINGS_LIMITS.onLayoutChangeDelay.disabled})`,
        limits: SETTINGS_LIMITS.onLayoutChangeDelay,
        unit: "SEC",
    },
];

export const getSettingsSections = (plugin: VaultSync): SettingSection[] => {
    return [
        {
            id: "performance",
            title: t("settingPerfSection"),
            items: [
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
                    key: "concurrency",
                    type: "number",
                    label: t("settingConcurrency"),
                    desc:
                        t("settingConcurrencyDesc") +
                        `\n(Min: ${SETTINGS_LIMITS.concurrency.min}, Max: ${SETTINGS_LIMITS.concurrency.max}, Default: ${SETTINGS_LIMITS.concurrency.default})`,
                    limits: SETTINGS_LIMITS.concurrency,
                },

                {
                    key: "largeFileThresholdMB",
                    type: "number",
                    label: t("settingLargeFileThreshold"),
                    desc:
                        t("settingLargeFileThresholdDesc") +
                        `\n(Min: ${SETTINGS_LIMITS.largeFileThresholdMB.min}, Max: ${SETTINGS_LIMITS.largeFileThresholdMB.max}, Default: ${SETTINGS_LIMITS.largeFileThresholdMB.default})`,
                    limits: SETTINGS_LIMITS.largeFileThresholdMB,
                    unit: "MB",
                },
                {
                    key: "bgTransferIntervalSec",
                    type: "number",
                    label: t("settingBgTransferInterval"),
                    desc:
                        t("settingBgTransferIntervalDesc") +
                        `\n(Min: ${SETTINGS_LIMITS.bgTransferIntervalSec.min}, Max: ${SETTINGS_LIMITS.bgTransferIntervalSec.max}, Default: ${SETTINGS_LIMITS.bgTransferIntervalSec.default})`,
                    limits: SETTINGS_LIMITS.bgTransferIntervalSec,
                    unit: "SEC",
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
            ],
        },
        {
            id: "trigger_strategy",
            title: t("settingTriggerSection"),
            items: [
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
                {
                    key: "cloudRootFolder",
                    type: "text",
                    label: t("settingCloudRootFolder"),
                    desc: t("settingCloudRootFolderDesc"),
                    placeholder: "ObsidianVaultSync",
                    onChange: async (val, p) => {
                        // Sanitize
                        const sanitized = val.trim();
                        if (
                            !sanitized ||
                            sanitized.startsWith("/") ||
                            sanitized.includes("\\") ||
                            sanitized.length > 255 ||
                            /[<>:\"|?*]/.test(sanitized)
                        ) {
                            // Invalid input - revert to default if empty, or just ignore
                            if (!sanitized) {
                                p.settings.cloudRootFolder = "ObsidianVaultSync";
                                await p.saveSettings();
                            }
                            return;
                        }
                        // Warn user if changing from existing folder
                        const oldFolder = p.settings.cloudRootFolder;
                        if (sanitized !== oldFolder && oldFolder) {
                            if (!confirm(p.t("settingCloudRootFolderWarning"))) {
                                return;
                            }
                        }
                        p.settings.cloudRootFolder = sanitized;
                        await p.saveSettings();
                        p.adapter.updateConfig(
                            p.adapter.clientId,
                            p.adapter.clientSecret,
                            p.app.vault.getName(),
                            p.settings.cloudRootFolder,
                        );
                        p.syncManager.triggerFullCleanup();
                    },
                },
                {
                    key: "syncCoreConfig",
                    type: "toggle",
                    label: t("settingSyncCoreConfig"),
                    desc: t("settingSyncCoreConfigDesc"),
                    onChange: async (_val, p) => p.syncManager.triggerFullCleanup(),
                },
                {
                    key: "syncAppearance",
                    type: "toggle",
                    label: t("settingSyncAppearance"),
                    desc: t("settingSyncAppearanceDesc"),
                    onChange: async (_val, p) => p.syncManager.triggerFullCleanup(),
                },
                {
                    key: "syncWorkspace",
                    type: "toggle",
                    label: t("settingSyncWorkspace"),
                    desc: t("settingSyncWorkspaceDesc"),
                    onChange: async (_val, p) => p.syncManager.triggerFullCleanup(),
                },
                {
                    key: "syncCommunityPlugins",
                    type: "toggle",
                    label: t("settingSyncCommunityPlugins"),
                    desc: t("settingSyncCommunityPluginsDesc"),
                    onChange: async (_val, p) => p.syncManager.triggerFullCleanup(),
                },
                {
                    key: "syncImagesAndMedia",
                    type: "toggle",
                    label: t("settingSyncImagesAndMedia"),
                    desc: t("settingSyncImagesAndMediaDesc"),
                    onChange: async (_val, p) => p.syncManager.triggerFullCleanup(),
                },
                {
                    key: "syncDotfiles",
                    type: "toggle",
                    label: t("settingSyncDotfiles"),
                    desc: t("settingSyncDotfilesDesc"),
                    onChange: async (_val, p) => p.syncManager.triggerFullCleanup(),
                },
                {
                    key: "syncPluginSettings",
                    type: "toggle",
                    label: t("settingSyncPluginSettings"),
                    desc: t("settingSyncPluginSettingsDesc"),
                    onChange: async (_val, p) => p.syncManager.triggerFullCleanup(),
                },
                {
                    key: "exclusionPatterns",
                    type: "textarea",
                    label: t("settingExclusionPatterns"),
                    desc: t("settingExclusionPatternsDesc"),
                    placeholder: "*.tmp\ntemp/**\n.git/**",
                    onChange: async (_val, p) => p.syncManager.triggerFullCleanup(),
                },
            ],
        },
        {
            id: "advanced",
            title: t("settingAdvancedSection"),
            items: [
                {
                    key: "enableLogging",
                    type: "toggle",
                    label: t("settingEnableLogging"),
                    desc: t("settingEnableLoggingDesc"),
                    onChange: async (_val, p) => {
                        p.syncManager.updateLoggerOptions();
                    },
                },
            ],
        },
        {
            id: "developer",
            title: t("settingDevSection"),
            isHidden: (s: VaultSyncSettings) => !s.isDeveloperMode,
            items: [
                {
                    key: "startupDelaySec",
                    type: "number",
                    label: t("settingStartupDelay"),
                    desc:
                        t("settingStartupDelayDesc") +
                        `\n(Min: ${SETTINGS_LIMITS.startupDelay.min}, Max: ${SETTINGS_LIMITS.startupDelay.max}, Default: ${SETTINGS_LIMITS.startupDelay.default})`,
                    limits: SETTINGS_LIMITS.startupDelay,
                    unit: "SEC",
                },
            ],
        },
        // Add E2EE auto-unlock setting if E2EE is enabled
        ...(plugin.settings.e2eeEnabled
            ? [
                  {
                      id: "e2ee-autounlock",
                      title: t("settingSecuritySection"),
                      items: [
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
        ...(plugin.syncManager.cryptoEngine?.getSettingsSections(plugin) || []),
    ];
};
