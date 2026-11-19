import { App, PluginSettingTab, Setting, setIcon } from "obsidian";
import type VaultSync from "../main";
import { t } from "../i18n";
import { getSettingsSections, SettingItem, SettingSection } from "./settings-schema";
import { ExclusionPatternModal } from "./exclusion-modal";
import { ConfirmModal } from "./confirm-modal";

/** Old accordion state; no longer used, removed on load. */
const LEGACY_CLOSED_GROUPS_KEY = "vault-sync:closed-groups";

type PageId = "root" | "account" | "triggers" | "scope" | "performance" | "addons" | "advanced";

interface SettingsCategory {
    id: Exclude<PageId, "root">;
    icon: string;
    titleKey: string;
    descKey: string;
    /** Schema section ids shown on this page. */
    sectionIds: string[];
}

/**
 * Top-level categories, in display order. Schema sections that no category
 * lists (add-on supplied sections) are shown on the add-on page.
 */
const CATEGORIES: SettingsCategory[] = [
    {
        id: "account",
        icon: "user-round",
        titleKey: "settingAuthSection",
        descKey: "settingCategoryAccountDesc",
        sectionIds: [],
    },
    {
        id: "triggers",
        icon: "zap",
        titleKey: "settingTriggerSection",
        descKey: "settingCategoryTriggersDesc",
        sectionIds: ["trigger_strategy", "triggers_unified", "triggers_desktop", "triggers_mobile"],
    },
    {
        id: "scope",
        icon: "folder-sync",
        titleKey: "settingSyncScopeSection",
        descKey: "settingCategoryScopeDesc",
        sectionIds: ["sync_scope"],
    },
    {
        id: "performance",
        icon: "gauge",
        titleKey: "settingPerfSection",
        descKey: "settingCategoryPerformanceDesc",
        sectionIds: ["performance"],
    },
    {
        id: "addons",
        icon: "puzzle",
        titleKey: "addonSectionTitle",
        descKey: "settingCategoryAddonsDesc",
        sectionIds: [],
    },
    {
        id: "advanced",
        icon: "sliders-horizontal",
        titleKey: "settingAdvancedSection",
        descKey: "settingCategoryAdvancedDesc",
        sectionIds: ["advanced", "developer"],
    },
];

const MAPPED_SECTION_IDS = new Set(CATEGORIES.flatMap((c) => c.sectionIds));

export class VaultSyncSettingTab extends PluginSettingTab {
    plugin: VaultSync;
    /** Page currently shown. Kept across re-renders, reset when the tab is hidden. */
    private page: PageId = "root";

    constructor(app: App, plugin: VaultSync) {
        super(app, plugin);
        this.plugin = plugin;
        try {
            window.localStorage.removeItem(LEGACY_CLOSED_GROUPS_KEY);
        } catch {
            /* ignore */
        }
    }

    hide(): void {
        this.page = "root";
        super.hide();
    }

    /** Switch page and scroll to its top. */
    private navigate(page: PageId): void {
        this.page = page;
        this.display();
        this.containerEl.scrollTop = 0;
    }

    display(): void {
        const { containerEl } = this;
        const scrollPos = containerEl.scrollTop;
        containerEl.empty();
        containerEl.addClass("vault-sync-settings-container");

        const category = CATEGORIES.find((c) => c.id === this.page);
        if (!category) {
            this.page = "root";
            this.renderRoot(containerEl);
        } else {
            this.renderPageHeader(containerEl, category);
            const body = containerEl.createDiv({ cls: "vault-sync-settings-page" });
            this.renderCategory(body, category);
        }

        // Restore scroll position (re-render within the same page)
        containerEl.scrollTop = scrollPos;
    }

    private renderRoot(el: HTMLElement): void {
        const list = el.createDiv({ cls: "vault-sync-settings-nav" });
        for (const category of CATEGORIES) {
            const setting = new Setting(list)
                .setName(t(category.titleKey))
                .setDesc(this.getCategoryDesc(category));
            const row = setting.settingEl;
            row.addClass("vault-sync-settings-nav-item");
            row.setAttr("role", "button");
            row.setAttr("tabindex", "0");

            const iconEl = createDiv({ cls: "vault-sync-settings-nav-icon" });
            setIcon(iconEl, category.icon);
            row.prepend(iconEl);

            const chevron = setting.controlEl.createDiv({ cls: "vault-sync-settings-nav-chevron" });
            setIcon(chevron, "chevron-right");

            row.addEventListener("click", () => this.navigate(category.id));
            row.addEventListener("keydown", (e) => {
                if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    this.navigate(category.id);
                }
            });
        }
    }

    private getCategoryDesc(category: SettingsCategory): string {
        const desc = t(category.descKey);
        if (category.id === "account") {
            const status = this.plugin.isAdapterAuthenticated()
                ? t("settingCategoryAccountSignedIn")
                : t("settingCategoryAccountSignedOut");
            return `${status} / ${desc}`;
        }
        return desc;
    }

    private renderPageHeader(el: HTMLElement, category: SettingsCategory): void {
        const header = el.createDiv({ cls: "vault-sync-settings-page-header" });
        const back = header.createEl("button", {
            cls: "vault-sync-settings-back",
            attr: { "aria-label": t("settingNavBackAria") },
        });
        setIcon(back.createSpan({ cls: "vault-sync-settings-back-icon" }), "chevron-left");
        back.createSpan({ text: t("settingNavBack") });
        back.addEventListener("click", () => this.navigate("root"));

        new Setting(el).setName(t(category.titleKey)).setHeading();
    }

    private renderCategory(el: HTMLElement, category: SettingsCategory): void {
        if (category.id === "account") {
            this.renderAccount(el);
            return;
        }

        const all = getSettingsSections(this.plugin);
        const sections =
            category.id === "addons"
                ? all.filter((s) => !MAPPED_SECTION_IDS.has(s.id))
                : category.sectionIds
                      .map((id) => all.find((s) => s.id === id))
                      .filter((s): s is SettingSection => !!s);

        if (category.id === "addons") this.renderAddonManagement(el);

        const pageTitle = t(category.titleKey);
        for (const section of sections) {
            if (section.isHidden?.(this.plugin.settings, this.plugin)) continue;
            this.renderSection(el, section, section.title !== pageTitle);
        }
    }

    private renderAccount(el: HTMLElement): void {
        // Auth Method dropdown
        new Setting(el)
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
            new Setting(el)
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
            new Setting(el)
                .setName(t("settingClientId"))
                .setDesc(t("settingClientIdDesc"))
                .addText((text) =>
                    text.setValue(this.plugin.getClientId()).onChange(async (value) => {
                        await this.plugin.updateClientCredential("clientId", value);
                    }),
                );

            new Setting(el)
                .setName(t("settingClientSecret"))
                .setDesc(t("settingClientSecretDesc"))
                .addText((text) =>
                    {
                        text.inputEl.type = "password";
                        text.inputEl.autocomplete = "off";
                        text.setValue(this.plugin.getClientSecret()).onChange(async (value) => {
                            await this.plugin.updateClientCredential("clientSecret", value);
                        });
                    },
                );
        }

        // Login button (always shown)
        new Setting(el)
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

        // Logout (only while signed in)
        if (this.plugin.isAdapterAuthenticated()) {
            new Setting(el)
                .setName(t("settingLogout"))
                .setDesc(t("settingLogoutDesc"))
                .addButton((button) =>
                    button
                        .setButtonText(t("settingLogout"))
                        .setWarning()
                        .onClick(async () => {
                            const ok = await new ConfirmModal(
                                this.app,
                                t("settingLogoutConfirm"),
                                t("settingLogout"),
                                true,
                            ).ask();
                            if (ok && (await this.plugin.adapterLogout())) this.display();
                        }),
                );
        }
    }

    private renderSection(el: HTMLElement, section: SettingSection, showTitle: boolean): void {
        if (showTitle) {
            el.createDiv({ cls: "vault-sync-settings-section-title", text: section.title });
        }
        if (section.description) {
            el.createEl("p", { text: section.description, cls: "setting-item-description" });
        }

        let groupBody: HTMLElement | null = null;
        for (const item of section.items) {
            if (item.isHidden?.(this.plugin.settings, this.plugin)) continue;

            // A subheader starts a new group (static, no collapsing)
            if (item.type === "subheader") {
                const groupEl = el.createDiv({ cls: "vault-sync-subheader-group" });
                groupEl.createDiv({ cls: "vault-sync-subheader-label" }).createSpan({
                    cls: "vault-sync-subheader-text",
                    text: item.label,
                });
                groupBody = groupEl.createDiv({ cls: "vault-sync-subheader-body" });
                continue;
            }

            this.renderItem(groupBody || el, item);
        }
    }

    private renderItem(targetEl: HTMLElement, item: SettingItem): void {

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
                    const current = () =>
                        String((this.getSettingValue(item.key) as string | undefined) || "");
                    text.setValue(current()).setPlaceholder(item.placeholder || "");
                    if (item.commitOnBlur && item.onChange) {
                        const onChange = item.onChange;
                        let busy = false;
                        const commit = async () => {
                            if (busy || text.getValue() === current()) return;
                            busy = true;
                            try {
                                await onChange(text.getValue(), this.plugin);
                            } finally {
                                // Show what was actually saved (reverts rejected input)
                                text.setValue(current());
                                busy = false;
                            }
                        };
                        text.inputEl.addEventListener("change", () => void commit());
                        text.inputEl.addEventListener("keydown", (e) => {
                            if (e.key === "Enter") text.inputEl.blur();
                        });
                        return;
                    }
                    text.onChange(async (val) => {
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
                    const patternCount = String((this.getSettingValue(item.key) as string | undefined) || "")
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
                                    void item.onChange(
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
                        text.setValue(String((this.getSettingValue(item.key) as string | undefined) || ""))
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
                            // Other sections may depend on this value (e.g. trigger mode)
                            this.display();
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
            // subheader is handled in renderSection, never reaches here
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

    private renderAddonManagement(el: HTMLElement): void {
        // Add-ons are separate, opt-in downloads with their own terms.
        const agreements = this.plugin.settings.addonAgreements ?? {};
        const names = Object.values(agreements).map((a) => `${a.name} ${a.version}`);
        if (this.plugin.syncManager.cryptoEngine) {
            new Setting(el)
                .setName(t("addonStatusInstalled"))
                .setDesc(names.length > 0 ? names.join(", ") : t("addonStatusInstalledManually"))
                .addButton((btn) =>
                    btn.setButtonText(t("addonReinstall")).onClick(() => {
                        this.plugin.openAddonInstallModal();
                    }),
                )
                .addButton((btn) =>
                    btn
                        .setButtonText(t("addonRemove"))
                        .setWarning()
                        .onClick(async () => {
                            const ok = await new ConfirmModal(
                                this.app,
                                t("addonRemoveConfirm"),
                                t("addonRemove"),
                                true,
                            ).ask();
                            if (ok) await this.plugin.removeAddon();
                        }),
                );
        } else if (names.length > 0) {
            // Installed before, but this version of Vault-Sync no longer accepts it
            new Setting(el)
                .setName(t("addonStatusUpdateRequired"))
                .setDesc(`${names.join(", ")}\n${t("addonStatusUpdateRequiredDesc")}`)
                .addButton((btn) =>
                    btn
                        .setButtonText(t("addonUpdateOpen"))
                        .setCta()
                        .onClick(() => {
                            this.plugin.openAddonInstallModal();
                        }),
                );
        } else {
            new Setting(el)
                .setName(t("addonStatusNone"))
                .setDesc(t("addonStatusNoneDesc"))
                .addButton((btn) =>
                    btn.setButtonText(t("addonInstallOpen")).onClick(() => {
                        this.plugin.openAddonInstallModal();
                    }),
                );
        }
    }

    private addUnitAddon(inputEl: HTMLInputElement, unit?: string): void {
        if (!unit) return;
        inputEl.addClass("vault-sync-number-input-with-unit");
        const wrapper = createDiv({ cls: "vault-sync-number-wrapper" });
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
            text: t("settingDefaultHint")
                .replace("{0}", String(limits.min))
                .replace("{1}", String(limits.max))
                .replace("{2}", String(limits.default)),
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
