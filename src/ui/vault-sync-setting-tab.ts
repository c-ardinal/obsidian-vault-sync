import { App, PluginSettingTab, SearchComponent, Setting, setIcon } from "obsidian";
import type VaultSync from "../main";
import { t } from "../i18n";
import { getSettingsSections, SettingItem, SettingSection } from "./settings-schema";
import { ExclusionPatternModal } from "./exclusion-modal";
import { ConfirmModal } from "./confirm-modal";
import { matchesWords, queryWords } from "./settings-search";

/** Old accordion state; no longer used, removed on load. */
const LEGACY_CLOSED_GROUPS_KEY = "vault-sync:closed-groups";

type PageId =
    | "root"
    | "account"
    | "triggers"
    | "scope"
    | "behavior"
    | "protection"
    | "transfer"
    | "display"
    | "addons"
    | "advanced";

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
        id: "behavior",
        icon: "git-merge",
        titleKey: "settingBehaviorSection",
        descKey: "settingCategoryBehaviorDesc",
        sectionIds: ["sync_behavior"],
    },
    {
        id: "protection",
        icon: "shield-check",
        titleKey: "settingProtectionSection",
        descKey: "settingCategoryProtectionDesc",
        sectionIds: ["data_protection"],
    },
    {
        id: "transfer",
        icon: "gauge",
        titleKey: "settingTransferSection",
        descKey: "settingCategoryTransferDesc",
        sectionIds: ["transfer"],
    },
    {
        id: "display",
        icon: "monitor",
        titleKey: "settingDisplaySection",
        descKey: "settingCategoryDisplayDesc",
        sectionIds: ["display"],
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

/** Settings of the account page (drawn by hand, not from the schema), for search: name and description keys */
const ACCOUNT_SEARCH_KEYS: [string, string][] = [
    ["settingAuthMethod", "settingAuthMethodDesc"],
    ["settingCustomProxyUrl", "settingCustomProxyUrlDesc"],
    ["settingClientId", "settingClientIdDesc"],
    ["settingClientSecret", "settingClientSecretDesc"],
    ["settingLogin", "settingLoginDesc"],
    ["settingLogout", "settingLogoutDesc"],
];

export class VaultSyncSettingTab extends PluginSettingTab {
    plugin: VaultSync;
    /** Page currently shown. Kept across re-renders, reset when the tab is hidden. */
    private page: PageId = "root";
    /** Text in the search box of the top page. Kept across re-renders, cleared when the tab is hidden. */
    private query = "";

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
        this.query = "";
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
        const searchEl = el.createDiv({ cls: "vault-sync-settings-search" });
        const list = el.createDiv({ cls: "vault-sync-settings-nav" });
        const results = el.createDiv({ cls: "vault-sync-settings-search-results" });
        const search = new SearchComponent(searchEl);
        search
            .setPlaceholder(t("settingSearchPlaceholder"))
            .setValue(this.query)
            .onChange((value) => {
                this.query = value;
                this.renderSearchResults(list, results);
            });
        search.inputEl.setAttr("aria-label", t("settingSearchPlaceholder"));
        this.renderSearchResults(list, results);

        for (const category of CATEGORIES) {
            const row = this.renderNavRow(list, t(category.titleKey), this.getCategoryDesc(category), category.id);
            row.addClass("vault-sync-settings-nav-item");
            const iconEl = createDiv({ cls: ["setting-item-icon", "vault-sync-settings-nav-icon"] });
            setIcon(iconEl, category.icon);
            row.prepend(iconEl);
        }
    }

    /** A row that opens a page (click, Enter or Space) */
    private renderNavRow(el: HTMLElement, name: string, desc: string, page: PageId): HTMLElement {
        const setting = new Setting(el).setName(name).setDesc(desc);
        const row = setting.settingEl;
        // mod-navigable: Obsidian keeps these rows horizontal on narrow screens
        row.addClass("mod-navigable", "vault-sync-settings-nav-row");
        row.setAttr("role", "button");
        row.setAttr("tabindex", "0");
        const chevron = setting.controlEl.createDiv({ cls: "vault-sync-settings-nav-chevron" });
        setIcon(chevron, "chevron-right");
        row.addEventListener("click", () => this.navigate(page));
        row.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                this.navigate(page);
            }
        });
        return row;
    }

    /**
     * Settings that match the search box, grouped by page and section, shown
     * with their own controls. The page list is hidden while a search is shown.
     */
    private renderSearchResults(list: HTMLElement, results: HTMLElement): void {
        results.empty();
        const words = queryWords(this.query);
        list.toggle(words.length === 0);
        if (words.length === 0) return;

        const all = getSettingsSections(this.plugin);
        let found = 0;
        for (const category of CATEGORIES) {
            const pageTitle = t(category.titleKey);
            if (category.id === "account") {
                const hits = ACCOUNT_SEARCH_KEYS.filter(([name, desc]) =>
                    matchesWords(words, [pageTitle, t(name), t(desc)]),
                );
                if (hits.length === 0) continue;
                found += hits.length;
                const group = this.renderResultGroup(results, category, pageTitle);
                for (const [name, desc] of hits) {
                    // Drawn by hand on its page (fields depend on each other): a link there
                    this.renderNavRow(group, t(name), t(desc), category.id);
                }
                continue;
            }
            const sections =
                category.id === "addons"
                    ? all.filter((sec) => !MAPPED_SECTION_IDS.has(sec.id))
                    : category.sectionIds
                          .map((id) => all.find((sec) => sec.id === id))
                          .filter((sec): sec is SettingSection => !!sec);
            for (const section of sections) {
                if (section.isHidden?.(this.plugin.settings, this.plugin)) continue;
                const hits: SettingItem[] = [];
                let subheader = "";
                for (const item of section.items) {
                    if (item.isHidden?.(this.plugin.settings, this.plugin)) continue;
                    if (item.type === "subheader") {
                        subheader = item.label;
                        continue;
                    }
                    const desc = item.getDesc ? item.getDesc(this.plugin.settings, this.plugin) : item.desc;
                    if (matchesWords(words, [pageTitle, section.title, subheader, item.label, desc])) {
                        hits.push(item);
                    }
                }
                if (hits.length === 0) continue;
                found += hits.length;
                const label = section.title === pageTitle ? pageTitle : `${pageTitle} › ${section.title}`;
                const group = this.renderResultGroup(results, category, label);
                for (const item of hits) this.renderItem(group, item);
            }
        }
        if (found === 0) {
            results.createEl("p", { cls: "vault-sync-settings-search-none", text: t("settingSearchNone") });
        }
    }

    /** Heading of a group of search results (opens its page) and the group's body */
    private renderResultGroup(results: HTMLElement, category: SettingsCategory, label: string): HTMLElement {
        const groupEl = results.createDiv({ cls: "vault-sync-subheader-group" });
        const head = groupEl.createDiv({ cls: "vault-sync-subheader-label vault-sync-settings-search-group" });
        const link = head.createEl("a", { cls: "vault-sync-subheader-text", text: label, href: "#" });
        link.addEventListener("click", (e) => {
            e.preventDefault();
            this.navigate(category.id);
        });
        return groupEl.createDiv({ cls: "vault-sync-subheader-body" });
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
            cls: ["clickable-icon", "vault-sync-settings-back"],
            attr: { "aria-label": t("settingNavBackAria") },
        });
        setIcon(back.createSpan({ cls: "vault-sync-settings-back-icon" }), "chevron-left");
        back.createSpan({ text: t("settingNavBack") });
        back.addEventListener("click", () => this.navigate("root"));

        // Obsidian indents setting headings to the card text; the class below aligns
        // the page title with the back button and the card edges instead.
        new Setting(header)
            .setName(t(category.titleKey))
            .setHeading()
            .settingEl.addClass("vault-sync-settings-page-title");
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
                if (
                    item.key === "exclusionPatterns" ||
                    item.key === "desktopExclusionPatterns" ||
                    item.key === "mobileExclusionPatterns"
                ) {
                    const listKey = item.key;
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
                            const before = String((this.getSettingValue(listKey) as string | undefined) || "");
                            const modal = new ExclusionPatternModal(this.app, this.plugin, listKey);
                            modal.onClose = () => {
                                const after = String((this.getSettingValue(listKey) as string | undefined) || "");
                                if (item.onChange && after !== before) void item.onChange(before, this.plugin);
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
                this.addNumberInput(setting, numCol, item, item.limits?.disabled);
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
                    this.addNumberInput(setting, numCol, item);
                }
                break;
            }
            case "slider": {
                // Obsidian's slider shows its own value next to it.
                const limits = item.limits ?? { min: 0, max: 100, default: 0 };
                setting.addSlider((slider) =>
                    slider
                        .setLimits(limits.min, limits.max, 1)
                        .setValue(Number(this.getSettingValue(item.key) ?? limits.default))
                        .setDynamicTooltip()
                        .onChange(async (val) => {
                            this.setSettingValue(item.key, val);
                            this.updateDiffPreviews();
                            await this.plugin.saveSettings();
                            if (item.onChange) await item.onChange(val, this.plugin);
                        }),
                );
                break;
            }
            case "diff-preview":
                setting.settingEl.addClass("vault-sync-diff-preview-setting");
                this.renderDiffPreview(setting.settingEl);
                break;
            // subheader is handled in renderSection, never reaches here
            case "button":
                setting.addButton((btn) =>
                    btn.setButtonText(item.buttonText ?? item.label).onClick(() => item.onClick?.(this.plugin)),
                );
                break;
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

    /** Sample diff in the history view's own styles, one pane per device type. */
    private renderDiffPreview(el: HTMLElement): void {
        const panes = el.createDiv({ cls: "vault-sync-diff-preview" });
        const devices: Array<{ id: "desktop" | "mobile"; label: string }> = [
            { id: "desktop", label: t("settingDiffPreviewDesktop") },
            { id: "mobile", label: t("settingDiffPreviewMobile") },
        ];
        for (const d of devices) {
            const pane = panes.createDiv({
                cls: `vault-sync-diff-preview-pane mod-${d.id}`,
                attr: { "data-device": d.id },
            });
            pane.createDiv({ cls: "vault-sync-diff-preview-label", text: d.label });
            const table = pane.createDiv({ cls: "diff-table" });
            const row = (
                op: "" | "added" | "removed" | "modified",
                l: number | "",
                r: number | "",
                segs: Array<[text: string, op?: "added" | "removed"]>,
            ) => {
                const rowEl = table.createDiv({ cls: "diff-row diff-row-unified" });
                if (op) rowEl.addClass(`diff-op-${op}`);
                const cell = rowEl.createDiv({ cls: "diff-cell" });
                cell.createDiv({ cls: "diff-ln", text: String(l) });
                cell.createDiv({ cls: "diff-ln", text: String(r) });
                const cn = cell.createDiv({ cls: "diff-cn" });
                for (const [text, segOp] of segs) {
                    const s = cn.createSpan({ text });
                    if (segOp) s.addClass(`diff-${segOp}-inline`);
                }
            };
            row("", 1, 1, [[t("diffPreviewLine1")]]);
            row("removed", 2, "", [[t("diffPreviewLine2")]]);
            row("added", "", 2, [[t("diffPreviewLine3")]]);
            row("modified", 3, 3, [
                [t("diffPreviewLine4a")],
                [t("diffPreviewLine4b"), "removed"],
                [t("diffPreviewLine4c"), "added"],
            ]);
        }
        this.updateDiffPreviews();
    }

    private updateDiffPreviews(): void {
        const s = this.plugin.settings;
        this.containerEl
            .querySelectorAll<HTMLElement>(".vault-sync-diff-preview-pane")
            .forEach((pane) => {
                const px =
                    pane.dataset.device === "mobile" ? s.diffFontSizeMobile : s.diffFontSizeDesktop;
                pane.style.setProperty("--vault-sync-diff-font-size", `${px}px`);
            });
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
    ): HTMLElement {
        return controlEl.createDiv({
            cls: "vault-sync-number-hint",
            text: t("settingDefaultHint")
                .replace("{0}", String(limits.min))
                .replace("{1}", String(limits.max))
                .replace("{2}", String(limits.default)),
        });
    }

    /**
     * Number field: checked and saved when committed (blur / Enter), not per
     * keystroke. A value out of range is moved to the nearest limit, shown in the
     * field, and the range hint is highlighted for a moment.
     */
    private addNumberInput(setting: Setting, numCol: HTMLElement, item: SettingItem, disabledValue?: number): void {
        let hintEl: HTMLElement | null = null;
        setting.addText((text) => {
            const current = () => String(this.getSettingValue(item.key));
            text.setValue(current()).setPlaceholder(item.limits ? String(item.limits.default) : "");
            text.inputEl.inputMode = "numeric";
            let busy = false;
            const commit = async () => {
                if (busy) return;
                const raw = text.getValue().trim();
                const prev = Number(this.getSettingValue(item.key));
                const { value, adjusted } = this.normalizeNumber(raw, prev, item.limits, disabledValue);
                text.setValue(String(value));
                if (adjusted && hintEl) {
                    hintEl.addClass("is-error");
                    window.setTimeout(() => hintEl?.removeClass("is-error"), 2500);
                }
                if (value === prev) return;
                busy = true;
                try {
                    this.setSettingValue(item.key, value);
                    await this.plugin.saveSettings();
                    if (item.onChange) await item.onChange(value, this.plugin);
                } finally {
                    busy = false;
                }
            };
            text.inputEl.addEventListener("change", () => void commit());
            text.inputEl.addEventListener("keydown", (e) => {
                if (e.key === "Enter") text.inputEl.blur();
            });

            this.addUnitAddon(text.inputEl, item.unit);
            const el = text.inputEl.closest(".vault-sync-number-wrapper") || text.inputEl;
            numCol.appendChild(el);
        });
        if (item.limits) hintEl = this.addLimitsHint(numCol, item.limits);
    }

    /**
     * Entered text to a stored number: empty or not a number keeps the previous
     * value, out of range moves to the nearest limit. `adjusted` tells the caller
     * to point at the allowed range.
     */
    private normalizeNumber(
        raw: string,
        prev: number,
        limits: SettingItem["limits"],
        disabledValue?: number,
    ): { value: number; adjusted: boolean } {
        const num = Number(raw);
        if (raw === "" || !Number.isFinite(num)) return { value: prev, adjusted: raw !== "" };
        if (!limits) return { value: num, adjusted: false };
        if (disabledValue !== undefined && num === disabledValue) return { value: num, adjusted: false };
        const clamped = Math.min(limits.max, Math.max(limits.min, num));
        return { value: clamped, adjusted: clamped !== num };
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
