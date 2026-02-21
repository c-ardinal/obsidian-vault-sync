import { App, PluginSettingTab, Setting } from "obsidian";
import type VaultSync from "../main";
import { t } from "../i18n";
import { getSettingsSections } from "./settings-schema";

export class VaultSyncSettingTab extends PluginSettingTab {
    plugin: VaultSync;

    constructor(app: App, plugin: VaultSync) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        const scrollPos = containerEl.scrollTop;
        containerEl.empty();
        containerEl.addClass("vault-sync-settings-container");

        containerEl.createEl("h2", { text: t("settingSettingsTitle") });

        // 1. Authentication (Manually handled due to complex UI)
        containerEl.createEl("h3", { text: t("settingAuthSection") });

        // Auth Method dropdown
        new Setting(containerEl)
            .setName(t("settingAuthMethod"))
            .setDesc(t("settingAuthMethodDesc"))
            .addDropdown((dropdown) => {
                dropdown
                    .addOption("default", t("settingAuthMethodDefault"))
                    .addOption("custom-proxy", t("settingAuthMethodCustomProxy"))
                    .addOption("client-credentials", t("settingAuthMethodClientCredentials"))
                    .setValue(this.plugin.settings.authMethod)
                    .onChange(async (value) => {
                        this.plugin.settings.authMethod = value as "default" | "custom-proxy" | "client-credentials";
                        this.plugin.adapter.setAuthConfig(
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
            new Setting(containerEl)
                .setName(t("settingCustomProxyUrl"))
                .setDesc(t("settingCustomProxyUrlDesc"))
                .addText((text) =>
                    text
                        .setPlaceholder("https://your-proxy.example.com")
                        .setValue(this.plugin.settings.customProxyUrl)
                        .onChange(async (value) => {
                            this.plugin.settings.customProxyUrl = value;
                            this.plugin.adapter.setAuthConfig(
                                this.plugin.settings.authMethod,
                                value,
                            );
                            await this.plugin.saveSettings();
                        }),
                );
        }

        // Client ID / Secret (only for client-credentials mode)
        if (authMethod === "client-credentials") {
            new Setting(containerEl)
                .setName(t("settingClientId"))
                .setDesc(t("settingClientIdDesc"))
                .addText((text) =>
                    text.setValue(this.plugin.adapter.clientId).onChange(async (value) => {
                        this.plugin.adapter.updateConfig(
                            value,
                            this.plugin.adapter.clientSecret,
                            this.plugin.vaultOps.getVaultName(),
                            this.plugin.settings.cloudRootFolder,
                        );
                        await this.plugin.saveCredentials(
                            value,
                            this.plugin.adapter.clientSecret,
                            this.plugin.adapter.getTokens().accessToken,
                            this.plugin.adapter.getTokens().refreshToken,
                        );
                    }),
                );

            new Setting(containerEl)
                .setName(t("settingClientSecret"))
                .setDesc(t("settingClientSecretDesc"))
                .addText((text) =>
                    text.setValue(this.plugin.adapter.clientSecret).onChange(async (value) => {
                        this.plugin.adapter.updateConfig(
                            this.plugin.adapter.clientId,
                            value,
                            this.plugin.vaultOps.getVaultName(),
                            this.plugin.settings.cloudRootFolder,
                        );
                        await this.plugin.saveCredentials(
                            this.plugin.adapter.clientId,
                            value,
                            this.plugin.adapter.getTokens().accessToken,
                            this.plugin.adapter.getTokens().refreshToken,
                        );
                    }),
                );
        }

        // Login button (always shown)
        new Setting(containerEl)
            .setName(t("settingLogin"))
            .setDesc(t("settingLoginDesc"))
            .addButton((button) =>
                button
                    .setButtonText(
                        this.plugin.adapter.isAuthenticated()
                            ? t("settingRelogin")
                            : t("settingLogin"),
                    )
                    .setCta()
                    .onClick(async () => {
                        await this.plugin.adapter.login();
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

            for (const item of section.items) {
                if (item.isHidden && item.isHidden(this.plugin.settings, this.plugin)) continue;

                const description = item.getDesc
                    ? item.getDesc(this.plugin.settings, this.plugin)
                    : item.desc || "";

                const setting = new Setting(containerEl).setName(item.label).setDesc(description);

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
                        setting.addTextArea((text) => {
                            text.setValue(String(this.getSettingValue(item.key) || ""))
                                .setPlaceholder(item.placeholder || "")
                                .onChange(async (val) => {
                                    this.setSettingValue(item.key, val);
                                    await this.plugin.saveSettings();
                                    if (item.onChange) await item.onChange(val, this.plugin);
                                });
                            if (item.key === "exclusionPatterns") {
                                text.inputEl.addClass("vault-sync-exclusion-textarea");
                                text.inputEl.rows = 10;
                                // Glob pattern validation warning
                                const warningEl = setting.settingEl.createDiv({ cls: "setting-item-description" });
                                warningEl.style.cssText = "color:var(--text-error);font-size:0.85em;display:none;";
                                const validatePatterns = () => {
                                    const lines = text.inputEl.value.split("\n").filter((l: string) => l.trim());
                                    const hasInvalid = lines.some((l: string) => {
                                        const openBracket = (l.match(/\[/g) || []).length;
                                        const closeBracket = (l.match(/\]/g) || []).length;
                                        if (openBracket !== closeBracket) return true;
                                        const openBrace = (l.match(/\{/g) || []).length;
                                        const closeBrace = (l.match(/\}/g) || []).length;
                                        return openBrace !== closeBrace;
                                    });
                                    warningEl.setText(this.plugin.t("settingExclusionPatternsInvalid"));
                                    warningEl.style.display = hasInvalid ? "" : "none";
                                };
                                text.inputEl.addEventListener("input", validatePatterns);
                            }
                        });
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
                    case "number":
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

                            if (item.unit) {
                                const inputEl = text.inputEl;
                                inputEl.addClass("vault-sync-number-input-with-unit");

                                const wrapper = document.createElement("div");
                                wrapper.addClass("vault-sync-number-wrapper");
                                inputEl.parentNode?.insertBefore(wrapper, inputEl);
                                wrapper.appendChild(inputEl);

                                wrapper.createDiv({
                                    cls: "vault-sync-unit-addon",
                                    text: item.unit,
                                });
                            }
                        });
                        break;
                    case "info":
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
            return key.split(".").reduce<unknown>((o, i) => (o as Record<string, unknown>)?.[i], record);
        }
        return record[key];
    }

    private setSettingValue(key: string, value: unknown): void {
        const record = this.plugin.settings as unknown as Record<string, unknown>;
        if (key.includes(".")) {
            const parts = key.split(".");
            const last = parts.pop()!;
            const target = parts.reduce<Record<string, unknown>>((o, i) => o[i] as Record<string, unknown>, record);
            target[last] = value;
        } else {
            record[key] = value;
        }
    }
}
