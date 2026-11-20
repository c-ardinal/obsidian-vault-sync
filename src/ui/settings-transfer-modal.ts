import { App, Modal, Notice, Setting } from "obsidian";
import qrcode from "qrcode-generator";
import type VaultSync from "../main";
import { t } from "../i18n";
import { DEFAULT_SETTINGS } from "../constants";
import {
    applyFlatSettings,
    dataFromLink,
    decodeSettingsTransfer,
    encodeSettingsTransfer,
    flattenSettings,
    settingsTransferLink,
} from "../services/settings-transfer";
import { getSettingsSections } from "./settings-schema";

interface SettingInfo {
    label: string;
    limits?: { min: number; max: number; disabled?: number };
}

/** Setting names as the settings screen shows them, by key ("section › name" for repeated names) */
function settingInfo(plugin: VaultSync): Map<string, SettingInfo> {
    const items = getSettingsSections(plugin).flatMap((s) => s.items.map((item) => ({ section: s.title, item })));
    const count = new Map<string, number>();
    for (const { item } of items) count.set(item.label, (count.get(item.label) ?? 0) + 1);
    const out = new Map<string, SettingInfo>();
    for (const { section, item } of items) {
        if (item.key.startsWith("_")) continue;
        const label = (count.get(item.label) ?? 0) > 1 ? `${section} › ${item.label}` : item.label;
        out.set(item.key, { label, limits: item.limits });
    }
    return out;
}

function showValue(value: unknown): string {
    if (typeof value === "boolean") return value ? t("transferOn") : t("transferOff");
    const text = String(value);
    return text.includes("\n") ? `${text.split("\n").filter((l) => l.trim()).length} ${t("transferLines")}` : text;
}

/** This device's settings as a QR code (and a link) for another device */
export class SettingsExportModal extends Modal {
    constructor(
        app: App,
        private readonly plugin: VaultSync,
    ) {
        super(app);
        this.modalEl.addClass("vault-sync-transfer-modal");
    }

    onOpen(): void {
        const { contentEl } = this;
        this.setTitle(t("transferExportTitle"));
        const data = encodeSettingsTransfer(this.plugin.settings, DEFAULT_SETTINGS);
        const link = settingsTransferLink(data);
        const changed = Object.keys(decodeSettingsTransfer(data, DEFAULT_SETTINGS)).length;

        contentEl.createEl("p", { cls: "vault-sync-transfer-note", text: t("transferExportIntro") });

        const qr = qrcode(0, "L");
        qr.addData(link, "Byte");
        qr.make();
        const box = contentEl.createDiv({ cls: "vault-sync-transfer-qr" });
        // The generator's own SVG markup (paths only), parsed instead of set as HTML
        const svg = new DOMParser().parseFromString(qr.createSvgTag({ margin: 4, scalable: true }), "image/svg+xml");
        box.appendChild(activeDocument.importNode(svg.documentElement, true));
        box.setAttr("aria-label", t("transferExportTitle"));
        box.dataset.link = link;

        contentEl.createEl("p", {
            cls: "vault-sync-transfer-note",
            text: t("transferExportCount").replace("{n}", String(changed)),
        });
        contentEl.createEl("p", { cls: "vault-sync-transfer-note", text: t("transferExportExcluded") });

        const row = contentEl.createDiv({ cls: "modal-button-container" });
        row.createEl("button", { text: t("transferCopyLink") }).addEventListener("click", () => {
            navigator.clipboard.writeText(link).then(
                () => new Notice(t("transferLinkCopied")),
                () => new Notice(t("transferLinkCopyFailed")),
            );
        });
    }

    onClose(): void {
        this.contentEl.empty();
    }
}

/**
 * Take settings from a link: shows what changes, then applies on approval.
 * Opened by the link itself (QR code), or empty to paste a link.
 */
export class SettingsImportModal extends Modal {
    constructor(
        app: App,
        private readonly plugin: VaultSync,
        private readonly data: string | null,
    ) {
        super(app);
        this.modalEl.addClass("vault-sync-transfer-modal");
    }

    onOpen(): void {
        this.setTitle(t("transferImportTitle"));
        if (this.data) this.renderChanges(this.data);
        else this.renderPaste();
    }

    onClose(): void {
        this.contentEl.empty();
    }

    private renderPaste(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl("p", { cls: "vault-sync-transfer-note", text: t("transferImportPaste") });
        let value = "";
        new Setting(contentEl).setName(t("transferImportLink")).addText((text) => {
            text.setPlaceholder("obsidian://…").onChange((v) => (value = v));
            text.inputEl.addClass("vault-sync-transfer-input");
        });
        const row = contentEl.createDiv({ cls: "modal-button-container" });
        row.createEl("button", { cls: "mod-cta", text: t("transferImportRead") }).addEventListener("click", () => {
            const data = dataFromLink(value);
            if (!data) {
                new Notice(t("transferImportInvalid"));
                return;
            }
            this.renderChanges(data);
        });
    }

    private renderChanges(data: string): void {
        const { contentEl } = this;
        contentEl.empty();
        let incoming: Record<string, string | number | boolean>;
        try {
            incoming = decodeSettingsTransfer(data, DEFAULT_SETTINGS);
        } catch {
            contentEl.createEl("p", { cls: "mod-warning", text: t("transferImportInvalid") });
            return;
        }

        const info = settingInfo(this.plugin);
        const current = flattenSettings(this.plugin.settings);
        const changes = Object.entries(incoming).filter(([key, value]) => {
            if (current[key] === value) return false;
            const limits = info.get(key)?.limits;
            if (limits && typeof value === "number" && value !== limits.disabled) {
                return value >= limits.min && value <= limits.max;
            }
            return true;
        });

        if (changes.length === 0) {
            contentEl.createEl("p", { text: t("transferImportSame") });
            return;
        }
        contentEl.createEl("p", {
            cls: "vault-sync-transfer-note",
            text: t("transferImportIntro").replace("{n}", String(changes.length)),
        });
        const list = contentEl.createDiv({ cls: "vault-sync-transfer-list" });
        for (const [key, value] of changes) {
            const rowEl = list.createDiv({ cls: "vault-sync-transfer-row" });
            rowEl.createDiv({ cls: "vault-sync-transfer-name", text: info.get(key)?.label ?? key });
            rowEl.createDiv({
                cls: "vault-sync-transfer-value",
                text: `${showValue(current[key])} → ${showValue(value)}`,
            });
        }
        if (changes.some(([key]) => key === "cloudRootFolder") && this.plugin.settings.hasCompletedFirstSync) {
            contentEl.createEl("p", { cls: "mod-warning", text: t("transferImportFolderWarning") });
        }

        const row = contentEl.createDiv({ cls: "modal-button-container" });
        row.createEl("button", { cls: "mod-cta", text: t("transferImportApply") }).addEventListener("click", () => {
            void this.apply(Object.fromEntries(changes));
        });
        row.createEl("button", { text: t("confirmCancel") }).addEventListener("click", () => this.close());
    }

    private async apply(values: Record<string, string | number | boolean>): Promise<void> {
        const p = this.plugin;
        const folderBefore = p.settings.cloudRootFolder;
        applyFlatSettings(p.settings, values);
        await p.saveSettings();
        p.updateLoggerOptions();
        p.setupAutoSyncInterval();
        p.refreshSyncStatusView();
        if (p.settings.cloudRootFolder !== folderBefore) p.updateAdapterCloudRoot();
        // Scope and exclusion settings decide which files sync: look over all of them next time
        p.triggerFullCleanup();
        p.refreshSettingsTab();
        new Notice(t("transferImportDone").replace("{n}", String(Object.keys(values).length)));
        this.close();
    }
}
