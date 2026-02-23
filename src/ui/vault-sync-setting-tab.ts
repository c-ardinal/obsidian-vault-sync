import { App, PluginSettingTab, Setting, setIcon } from "obsidian";
import type VaultSync from "../main";
import { t } from "../i18n";
import { getSettingsSections } from "./settings-schema";
import { ExclusionPatternModal } from "./exclusion-modal";

const OPENED_GROUPS_KEY = "vault-sync:opened-groups";

export class VaultSyncSettingTab extends PluginSettingTab {
    plugin: VaultSync;
    /** Stores keys of groups the user has explicitly opened. All groups default to collapsed. */
    private openedGroups: Set<string>;

    constructor(app: App, plugin: VaultSync) {
        super(app, plugin);
        this.plugin = plugin;
        this.openedGroups = this.loadOpenedGroups();
    }

    private loadOpenedGroups(): Set<string> {
        try {
            const stored = window.localStorage.getItem(OPENED_GROUPS_KEY);
            if (stored) return new Set(JSON.parse(stored));
        } catch {
            /* ignore */
        }
        return new Set();
    }

    private saveOpenedGroups(): void {
        try {
            window.localStorage.setItem(OPENED_GROUPS_KEY, JSON.stringify([...this.openedGroups]));
        } catch {
            /* ignore */
        }
    }

    display(): void {
        const { containerEl } = this;
        const scrollPos = containerEl.scrollTop;
        containerEl.empty();
        containerEl.addClass("vault-sync-settings-container");

        containerEl.createEl("h2", { text: t("settingSettingsTitle") });

        // 1. Authentication (Manually handled due to complex UI)
        containerEl.createEl("h3", { text: t("settingAuthSection") });

        const authGroupKey = "auth:_subheader_account";
        const authCollapsed = !this.openedGroups.has(authGroupKey);

        const authGroup = containerEl.createDiv({ cls: "vault-sync-subheader-group" });
        const authHeader = authGroup.createDiv({ cls: "vault-sync-subheader-label" });
        const authChevron = authHeader.createSpan({ cls: "vault-sync-subheader-chevron" });
        setIcon(authChevron, authCollapsed ? "chevron-right" : "chevron-down");
        authHeader.createSpan({
            cls: "vault-sync-subheader-text",
            text: t("settingSubheaderAccount"),
        });

        const authBody = authGroup.createDiv({ cls: "vault-sync-subheader-body" });
        if (authCollapsed) {
            authBody.style.display = "none";
        }

        authHeader.addEventListener("click", () => {
            if (this.openedGroups.has(authGroupKey)) {
                this.openedGroups.delete(authGroupKey);
            } else {
                this.openedGroups.add(authGroupKey);
            }
            this.saveOpenedGroups();
            this.display();
        });

        // Auth Method dropdown
        new Setting(authBody)
            .setName(t("settingAuthMethod"))
            .setDesc(t("settingAuthMethodDesc"))
            .addDropdown((dropdown) => {
                dropdown
                    .addOption("default", t("settingAuthMethodDefault"))
                    .addOption("custom-proxy", t("settingAuthMethodCustomProxy"))
                    .addOption("client-credentials", t("settingAuthMethodClientCredentials"))
                    .setValue(this.plugin.settings.authMethod)
                    .onChange(async (value) => {
                        this.plugin.settings.authMethod = value as
                            | "default"
                            | "custom-proxy"
                            | "client-credentials";
                        this.plugin.setAuthConfig(
                            this.plugin.settings.authMethod,
                            this.plugin.settings.customProxyUrl,
                        );
                        await this.plugin.saveSettings();
                        this.display(); // Re-render to show/hide fields
                    });
            });

        const authMethod = this.plugin.settings.authMethod;

        // Custom Proxy URL (only for custom-proxy mode)
        if (authMethod === "custom-proxy") {
            new Setting(authBody)
                .setName(t("settingCustomProxyUrl"))
                .setDesc(t("settingCustomProxyUrlDesc"))
                .addText((text) =>
                    text
                        .setPlaceholder("https://your-proxy.example.com")
                        .setValue(this.plugin.settings.customProxyUrl)
                        .onChange(async (value) => {
                            this.plugin.settings.customProxyUrl = value;
                            this.plugin.setAuthConfig(this.plugin.settings.authMethod, value);
                            await this.plugin.saveSettings();
                        }),
                );
        }

        // Client ID / Secret (only for client-credentials mode)
        if (authMethod === "client-credentials") {
            new Setting(authBody)
                .setName(t("settingClientId"))
                .setDesc(t("settingClientIdDesc"))
                .addText((text) =>
                    text.setValue(this.plugin.getClientId()).onChange(async (value) => {
                        await this.plugin.updateClientCredential("clientId", value);
                    }),
                );

            new Setting(authBody)
                .setName(t("settingClientSecret"))
                .setDesc(t("settingClientSecretDesc"))
                .addText((text) =>
                    text.setValue(this.plugin.getClientSecret()).onChange(async (value) => {
                        await this.plugin.updateClientCredential("clientSecret", value);
                    }),
                );
        }

        // Login button (always shown)
        new Setting(authBody)
            .setName(t("settingLogin"))
            .setDesc(t("settingLoginDesc"))
            .addButton((button) =>
                button
                    .setButtonText(
                        this.plugin.isAdapterAuthenticated()
                            ? t("settingRelogin")
                            : t("settingLogin"),
                    )
                    .setCta()
                    .onClick(async () => {
                        await this.plugin.adapterLogin();
                    }),
            );

        // Render Schema-based Settings
        const sections = getSettingsSections(this.plugin);
        for (const section of sections) {
            const isHidden = section.isHidden
                ? section.isHidden(this.plugin.settings, this.plugin)
                : false;
            if (isHidden) {
                continue;
            }

            containerEl.createEl("h3", { text: section.title });
            if (section.description) {
                containerEl.createEl("p", {
                    text: section.description,
                    cls: "setting-item-description",
                });
            }

            let groupEl: HTMLElement | null = null;
            let groupBody: HTMLElement | null = null;
            let groupCollapsed = false;
            for (const item of section.items) {
                if (item.isHidden && item.isHidden(this.plugin.settings, this.plugin)) continue;

                // When a subheader is encountered, create a new group wrapper
                if (item.type === "subheader") {
                    const groupKey = `${section.id}:${item.key}`;
                    groupCollapsed = !this.openedGroups.has(groupKey);

                    groupEl = containerEl.createDiv({ cls: "vault-sync-subheader-group" });
                    const headerEl = groupEl.createDiv({ cls: "vault-sync-subheader-label" });
                    const chevron = headerEl.createSpan({ cls: "vault-sync-subheader-chevron" });
                    setIcon(chevron, groupCollapsed ? "chevron-right" : "chevron-down");
                    headerEl.createSpan({ cls: "vault-sync-subheader-text", text: item.label });

                    groupBody = groupEl.createDiv({ cls: "vault-sync-subheader-body" });
                    if (groupCollapsed) {
                        groupBody.style.display = "none";
                    }

                    headerEl.addEventListener("click", () => {
                        if (this.openedGroups.has(groupKey)) {
                            this.openedGroups.delete(groupKey);
                        } else {
                            this.openedGroups.add(groupKey);
                        }
                        this.saveOpenedGroups();
                        this.display();
                    });
                    continue;
                }

                const targetEl = groupBody || containerEl;

                const description = item.getDesc
                    ? item.getDesc(this.plugin.settings, this.plugin)
                    : item.desc || "";

                const setting = new Setting(targetEl).setName(item.label).setDesc(description);

                switch (item.type) {
                    case "toggle":
                        setting.addToggle((toggle) =>
                            toggle
                                .setValue(this.getSettingValue(item.key) as boolean)
                                .onChange(async (val) => {
                                    this.setSettingValue(item.key, val);
                                    await this.plugin.saveSettings();
                                    if (item.onChange) await item.onChange(val, this.plugin);
                                }),
                        );
                        break;
                    case "text":
                        setting.addText((text) => {
                            text.setValue(String(this.getSettingValue(item.key) || ""))
                                .setPlaceholder(item.placeholder || "")
                                .onChange(async (val) => {
                                    if (item.onChange) {
                                        await item.onChange(val, this.plugin);
                                    } else {
                                        this.setSettingValue(item.key, val);
                                        await this.plugin.saveSettings();
                                    }
                                });
                        });
                        break;
                    case "textarea":
                        if (item.key === "exclusionPatterns") {
                            // Render as a button that opens a modal
                            const patternCount = String(this.getSettingValue(item.key) || "")
                                .split("\n")
                                .filter((l: string) => l.trim()).length;
                            const summary =
                                patternCount > 0
                                    ? `${patternCount} ${t("settingExclusionPatternCount")}`
                                    : t("settingExclusionPatternNone");
                            setting.setDesc(summary);
                            setting.addButton((btn) => {
                                btn.setButtonText(t("settingExclusionConfigure")).onClick(() => {
                                    const modal = new ExclusionPatternModal(this.app, this.plugin);
                                    modal.onClose = () => {
                                        if (item.onChange)
                                            item.onChange(
                                                this.getSettingValue(item.key),
                                                this.plugin,
                                            );
                                        this.display();
                                    };
                                    modal.open();
                                });
                            });
                        } else {
                            setting.addTextArea((text) => {
                                text.setValue(String(this.getSettingValue(item.key) || ""))
                                    .setPlaceholder(item.placeholder || "")
                                    .onChange(async (val) => {
                                        this.setSettingValue(item.key, val);
                                        await this.plugin.saveSettings();
                                        if (item.onChange) await item.onChange(val, this.plugin);
                                    });
                            });
                        }
                        break;
                    case "dropdown":
                        setting.addDropdown((dropdown) => {
                            if (item.options) {
                                for (const [k, v] of Object.entries(item.options)) {
                                    dropdown.addOption(k, v);
                                }
                            }
                            dropdown
                                .setValue(String(this.getSettingValue(item.key)))
                                .onChange(async (val) => {
                                    this.setSettingValue(item.key, val);
                                    await this.plugin.saveSettings();
                                    if (item.onChange) await item.onChange(val, this.plugin);
                                });
                        });
                        break;
                    case "number": {
                        setting.settingEl.addClass("vault-sync-number-setting");
                        const numCol = setting.controlEl.createDiv({
                            cls: "vault-sync-number-column",
                        });
                        setting.addText((text) => {
                            text.setValue(String(this.getSettingValue(item.key)))
                                .setPlaceholder(item.limits ? String(item.limits.default) : "")
                                .onChange(async (val) => {
                                    const numVal = this.validateNumber(
                                        val,
                                        item.limits?.min ?? -Infinity,
                                        item.limits?.max ?? Infinity,
                                        item.limits?.default ?? 0,
                                        item.limits?.disabled,
                                    );
                                    this.setSettingValue(item.key, numVal);
                                    await this.plugin.saveSettings();
                                    if (item.onChange) await item.onChange(numVal, this.plugin);
                                });

                            this.addUnitAddon(text.inputEl, item.unit);
                            const el =
                                text.inputEl.closest(".vault-sync-number-wrapper") || text.inputEl;
                            numCol.appendChild(el);
                        });
                        if (item.limits) {
                            this.addLimitsHint(numCol, item.limits);
                        }
                        break;
                    }
                    case "toggle-number": {
                        const currentVal = this.getSettingValue(item.key) as number;
                        const disabledVal = item.limits?.disabled ?? -1;
                        const isEnabled = currentVal !== disabledVal;

                        setting.settingEl.addClass("vault-sync-toggle-number-setting");

                        setting.addToggle((toggle) => {
                            toggle.setValue(isEnabled).onChange(async (val) => {
                                const newVal = val ? (item.limits?.default ?? 0) : disabledVal;
                                this.setSettingValue(item.key, newVal);
                                await this.plugin.saveSettings();
                                if (item.onChange) await item.onChange(newVal, this.plugin);
                                this.display();
                            });
                        });

                        if (isEnabled) {
                            const numCol = setting.controlEl.createDiv({
                                cls: "vault-sync-number-column",
                            });
                            setting.addText((text) => {
                                text.setValue(String(currentVal))
                                    .setPlaceholder(item.limits ? String(item.limits.default) : "")
                                    .onChange(async (val) => {
                                        const numVal = this.validateNumber(
                                            val,
                                            item.limits?.min ?? -Infinity,
                                            item.limits?.max ?? Infinity,
                                            item.limits?.default ?? 0,
                                        );
                                        this.setSettingValue(item.key, numVal);
                                        await this.plugin.saveSettings();
                                        if (item.onChange) await item.onChange(numVal, this.plugin);
                                    });

                                this.addUnitAddon(text.inputEl, item.unit);
                                const el =
                                    text.inputEl.closest(".vault-sync-number-wrapper") ||
                                    text.inputEl;
                                numCol.appendChild(el);
                            });
                            if (item.limits) {
                                this.addLimitsHint(numCol, item.limits);
                            }
                        }
                        break;
                    }
                    // subheader is handled above with continue, never reaches switch
                    case "info":
                        setting.settingEl.addClass("vault-sync-info-setting");
                        setting.controlEl.createSpan({
                            cls: "vault-sync-info-status",
                            text: description,
                        });
                        setting.setDesc(""); // Clear description since we moved it to the control area
                        break;
                }
            }
        }

        // Restore scroll position
        containerEl.scrollTop = scrollPos;
    }

    private addUnitAddon(inputEl: HTMLInputElement, unit?: string): void {
        if (!unit) return;
        inputEl.addClass("vault-sync-number-input-with-unit");
        const wrapper = document.createElement("div");
        wrapper.addClass("vault-sync-number-wrapper");
        inputEl.parentNode?.insertBefore(wrapper, inputEl);
        wrapper.appendChild(inputEl);
        wrapper.createDiv({ cls: "vault-sync-unit-addon", text: unit });
    }

    private addLimitsHint(
        controlEl: HTMLElement,
        limits: { min: number; max: number; default: number },
    ): void {
        controlEl.createDiv({
            cls: "vault-sync-number-hint",
            text: `${limits.min} ~ ${limits.max} (default: ${limits.default})`,
        });
    }

    private validateNumber(
        value: string,
        min: number,
        max: number,
        defaultValue: number,
        disabledValue?: number,
    ): number {
        const num = Number(value);
        if (isNaN(num)) return defaultValue;
        if (disabledValue !== undefined && num === disabledValue) return num;
        if (num < min || num > max) return defaultValue;
        return num;
    }

    private getSettingValue(key: string): unknown {
        const record = this.plugin.settings as unknown as Record<string, unknown>;
        if (key.includes(".")) {
            return key
                .split(".")
                .reduce<unknown>((o, i) => (o as Record<string, unknown>)?.[i], record);
        }
        return record[key];
    }

    private setSettingValue(key: string, value: unknown): void {
        const record = this.plugin.settings as unknown as Record<string, unknown>;
        if (key.includes(".")) {
            const parts = key.split(".");
            const last = parts.pop()!;
            const target = parts.reduce<Record<string, unknown>>(
                (o, i) => o[i] as Record<string, unknown>,
                record,
            );
            target[last] = value;
        } else {
            record[key] = value;
        }
    }
}
