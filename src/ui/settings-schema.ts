import { VaultSyncSettings } from "../types/settings";
import { SETTINGS_LIMITS } from "../constants";
import { t } from "../i18n";
import VaultSync from "../main";

export type SettingType = "toggle" | "text" | "number" | "dropdown" | "textarea";

export interface SettingItem {
    key: keyof VaultSyncSettings;
    type: SettingType;
    label: string;
    desc?: string;
    placeholder?: string;
    options?: Record<string, string>; // For dropdown: value -> label
    // Number type specific
    limits?: {
        min: number;
        max: number;
        default: number;
        disabled?: number;
    };
    // Custom behaviors
    onChange?: (value: any, plugin: VaultSync) => Promise<void>;
    isHidden?: (settings: VaultSyncSettings) => boolean;
}

export interface SettingSection {
    id: string;
    title: string;
    description?: string;
    items: SettingItem[];
    isHidden?: (settings: VaultSyncSettings) => boolean;
}

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
            id: "triggers",
            title: t("settingTriggerSection"),
            items: [
                {
                    key: "enableStartupSync",
                    type: "toggle",
                    label: t("settingStartupSync"),
                    desc: t("settingStartupSyncDesc"),
                },
                {
                    key: "autoSyncIntervalSec",
                    type: "number",
                    label: t("settingAutoSyncInterval"),
                    desc:
                        t("settingAutoSyncIntervalDesc") +
                        `\n(Min: ${SETTINGS_LIMITS.autoSyncInterval.min}, Max: ${SETTINGS_LIMITS.autoSyncInterval.max}, Default: ${SETTINGS_LIMITS.autoSyncInterval.default}, Disabled: ${SETTINGS_LIMITS.autoSyncInterval.disabled})`,
                    limits: SETTINGS_LIMITS.autoSyncInterval,
                    onChange: async (val, p) => {
                        p.settings.enableAutoSyncInInterval =
                            val !== SETTINGS_LIMITS.autoSyncInterval.disabled;
                        await p.saveSettings();
                        p.setupAutoSyncInterval();
                    },
                },
                {
                    key: "onSaveDelaySec",
                    type: "number",
                    label: t("settingTriggerSave"),
                    desc:
                        t("settingTriggerSaveDesc") +
                        `\n(Min: ${SETTINGS_LIMITS.onSaveDelay.min}, Max: ${SETTINGS_LIMITS.onSaveDelay.max}, Default: ${SETTINGS_LIMITS.onSaveDelay.default}, Disabled: ${SETTINGS_LIMITS.onSaveDelay.disabled})`,
                    limits: SETTINGS_LIMITS.onSaveDelay,
                },
                {
                    key: "onModifyDelaySec",
                    type: "number",
                    label: t("settingModify"),
                    desc:
                        t("settingModifyDesc") +
                        `\n(Min: ${SETTINGS_LIMITS.onModifyDelay.min}, Max: ${SETTINGS_LIMITS.onModifyDelay.max}, Default: ${SETTINGS_LIMITS.onModifyDelay.default}, Disabled: ${SETTINGS_LIMITS.onModifyDelay.disabled})`,
                    limits: SETTINGS_LIMITS.onModifyDelay,
                },
                {
                    key: "onLayoutChangeDelaySec",
                    type: "number",
                    label: t("settingTriggerLayout"),
                    desc:
                        t("settingTriggerLayoutDesc") +
                        `\n(Min: ${SETTINGS_LIMITS.onLayoutChangeDelay.min}, Max: ${SETTINGS_LIMITS.onLayoutChangeDelay.max}, Default: ${SETTINGS_LIMITS.onLayoutChangeDelay.default}, Disabled: ${SETTINGS_LIMITS.onLayoutChangeDelay.disabled})`,
                    limits: SETTINGS_LIMITS.onLayoutChangeDelay,
                },
            ],
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
                        p.settings.cloudRootFolder = sanitized;
                        await p.saveSettings();
                        p.adapter.updateConfig(
                            p.adapter.clientId,
                            p.adapter.clientSecret,
                            p.app.vault.getName(),
                            p.settings.cloudRootFolder,
                        );
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
            id: "developer",
            title: t("settingDevSection"),
            isHidden: (s) => !s.isDeveloperMode,
            items: [
                {
                    key: "enableLogging",
                    type: "toggle",
                    label: t("settingEnableLogging"),
                    desc: t("settingEnableLoggingDesc"),
                },
                {
                    key: "startupDelaySec",
                    type: "number",
                    label: t("settingStartupDelay"),
                    desc:
                        t("settingStartupDelayDesc") +
                        `\n(Min: ${SETTINGS_LIMITS.startupDelay.min}, Max: ${SETTINGS_LIMITS.startupDelay.max}, Default: ${SETTINGS_LIMITS.startupDelay.default})`,
                    limits: SETTINGS_LIMITS.startupDelay,
                },
            ],
        },
    ];
};
