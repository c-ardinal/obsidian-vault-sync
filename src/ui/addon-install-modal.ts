import { App, Component, MarkdownRenderer, Modal, Setting } from "obsidian";
import { currentLanguage, t } from "../i18n";
import { APPROVED_ADDONS } from "../addons/approved-addons";
import {
    pickLocalized,
    readAddonPackage,
    type AddonPackage,
    type AddonPackageError,
} from "../addons/addon-package";

export type AddonInstallOutcome = { ok: true } | { ok: false; errorKey: string };

const PACKAGE_ERROR_KEYS: Record<AddonPackageError, string> = {
    "too-large": "addonErrorNotPackage",
    "not-zip": "addonErrorNotPackage",
    "no-manifest": "addonErrorNotPackage",
    "unknown-addon": "addonErrorUnknown",
    "hash-mismatch": "addonErrorHash",
};

/**
 * Installs an add-on from a package (.zip) the user downloaded themselves:
 *   1. open the download page,
 *   2. pick the package; Vault-Sync verifies every file against its pinned hash,
 *   3. read the add-on's own terms of use (shipped in the package) and agree,
 *   4. install.
 *
 * Vault-Sync never downloads add-ons, and all add-on specific wording (name,
 * description, terms) comes from the package.
 */
export class AddonInstallModal extends Modal {
    private statusEl: HTMLElement | null = null;
    private reviewEl: HTMLElement | null = null;
    private pickButton: HTMLButtonElement | null = null;
    private renderer = new Component();

    constructor(
        app: App,
        private install: (pkg: AddonPackage) => Promise<AddonInstallOutcome>,
        private onInstalled: () => void,
        /** True when this vault already uses an add-on missing on this device. */
        private requiredByVault = false,
    ) {
        super(app);
    }

    onOpen(): void {
        const { contentEl } = this;
        this.renderer.load();
        contentEl.addClass("vault-sync-addon-install");
        contentEl.createEl("h2", { text: t("addonInstallTitle") });
        if (this.requiredByVault) {
            contentEl.createEl("p", {
                text: t("addonRequiredByVault"),
                cls: "vault-sync-addon-install-notice",
            });
        }
        contentEl.createEl("p", { text: t("addonInstallIntro") });

        // Step 1: download
        contentEl.createEl("h3", { text: t("addonStepDownload") });
        const download = new Setting(contentEl).setDesc(t("addonStepDownloadDesc"));
        APPROVED_ADDONS.forEach((addon, i) => {
            const label =
                APPROVED_ADDONS.length > 1
                    ? `${t("addonOpenDownloadPage")} (${i + 1})`
                    : t("addonOpenDownloadPage");
            download.addButton((btn) =>
                btn.setButtonText(label).onClick(() => window.open(addon.downloadUrl)),
            );
        });

        // Step 2: choose the package
        contentEl.createEl("h3", { text: t("addonStepChoose") });
        const fileInput = contentEl.createEl("input", {
            type: "file",
            attr: { accept: ".zip,application/zip,application/x-zip-compressed,*/*" },
        });
        fileInput.hide();
        fileInput.addEventListener("change", () => {
            const file = fileInput.files?.[0];
            fileInput.value = "";
            if (file) void this.handleFile(file);
        });
        new Setting(contentEl).setDesc(t("addonStepChooseDesc")).addButton((btn) => {
            this.pickButton = btn.buttonEl;
            btn.setButtonText(t("addonChooseFile"))
                .setCta()
                .onClick(() => fileInput.click());
        });

        this.statusEl = contentEl.createDiv({ cls: "vault-sync-addon-install-status" });
        this.reviewEl = contentEl.createDiv();
    }

    onClose(): void {
        this.renderer.unload();
        this.contentEl.empty();
    }

    private setStatus(text: string, isError: boolean): void {
        if (!this.statusEl) return;
        this.statusEl.setText(text);
        this.statusEl.toggleClass("mod-error", isError);
    }

    private async handleFile(file: File): Promise<void> {
        this.reviewEl?.empty();
        this.setStatus(t("addonVerifying"), false);
        try {
            const result = await readAddonPackage(new Uint8Array(await file.arrayBuffer()));
            if (!result.ok) {
                this.setStatus(t(PACKAGE_ERROR_KEYS[result.reason]), true);
                return;
            }
            this.setStatus("", false);
            await this.showTerms(result.pkg);
        } catch (e) {
            console.error("Vault-Sync: reading add-on package failed", e);
            this.setStatus(t("addonErrorNotPackage"), true);
        }
    }

    /** Step 3: the add-on's own terms, then agreement and install. */
    private async showTerms(pkg: AddonPackage): Promise<void> {
        const el = this.reviewEl!;
        const lang = currentLanguage();

        el.createEl("h3", { text: t("addonStepTerms") });
        el.createEl("p", {
            text: `${pkg.manifest.name} ${pkg.manifest.version}`,
            cls: "vault-sync-addon-install-name",
        });
        const description = pickLocalized(pkg.manifest.description, lang);
        if (description) el.createEl("p", { text: description });

        const termsEl = el.createDiv({ cls: "vault-sync-addon-terms markdown-rendered" });
        await MarkdownRenderer.render(
            this.app,
            pickLocalized(pkg.terms, lang),
            termsEl,
            "",
            this.renderer,
        );

        let agreed = false;
        let installButton: HTMLButtonElement | null = null;
        new Setting(el).setName(t("addonAgreeTerms")).addToggle((toggle) =>
            toggle.setValue(false).onChange((value) => {
                agreed = value;
                if (installButton) installButton.disabled = !agreed;
            }),
        );
        new Setting(el).addButton((btn) => {
            installButton = btn.buttonEl;
            installButton.disabled = true;
            btn.setButtonText(t("addonInstallButton"))
                .setCta()
                .onClick(async () => {
                    if (!agreed || !installButton) return;
                    installButton.disabled = true;
                    if (this.pickButton) this.pickButton.disabled = true;
                    this.setStatus(t("addonInstalling"), false);
                    const outcome = await this.install(pkg);
                    if (outcome.ok) {
                        this.setStatus(t("addonInstallSuccess"), false);
                        window.setTimeout(() => {
                            this.close();
                            this.onInstalled();
                        }, 1200);
                        return;
                    }
                    this.setStatus(t(outcome.errorKey), true);
                    installButton.disabled = false;
                    if (this.pickButton) this.pickButton.disabled = false;
                });
        });
    }
}
