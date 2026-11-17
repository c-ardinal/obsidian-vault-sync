import { App, Modal, Setting } from "obsidian";
import { t } from "../i18n";
import { ENGINE_FILE_NAME, ENGINE_RELEASE_URL } from "../encryption/engine-loader";
import type { EngineInstallResult } from "../encryption/engine-loader";

/**
 * Guides the user through installing the E2EE engine without touching the
 * hidden .obsidian folder:
 *   1. open the release page and download e2ee-engine.js themselves,
 *   2. confirm they install encryption software of their own will,
 *   3. pick the downloaded file; the plugin verifies and saves it.
 *
 * Vault-Sync never downloads the engine. That keeps E2EE an explicit opt-in
 * by the user and stays within Obsidian's policy against plugins installing
 * their own dependencies.
 */
export class EngineInstallModal extends Modal {
    private consents = [false, false];
    private pickButton: HTMLButtonElement | null = null;
    private statusEl: HTMLElement | null = null;
    private busy = false;

    constructor(
        app: App,
        private install: (content: string) => Promise<EngineInstallResult>,
        private onInstalled: () => void,
        /** True when the vault is already encrypted from another device. */
        private vaultIsEncrypted = false,
    ) {
        super(app);
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.addClass("vault-sync-engine-install");
        contentEl.createEl("h2", { text: t("engineInstallTitle") });
        if (this.vaultIsEncrypted) {
            contentEl.createEl("p", {
                text: t("engineInstallNeededForVault"),
                cls: "vault-sync-engine-install-notice",
            });
        }
        contentEl.createEl("p", { text: t("engineInstallIntro") });

        // Step 1: download
        contentEl.createEl("h3", { text: t("engineInstallStep1") });
        new Setting(contentEl)
            .setDesc(t("engineInstallStep1Desc").replace("{file}", ENGINE_FILE_NAME))
            .addButton((btn) =>
                btn.setButtonText(t("engineInstallOpenReleases")).onClick(() => {
                    window.open(ENGINE_RELEASE_URL);
                }),
            );

        // Step 2: consent
        contentEl.createEl("h3", { text: t("engineInstallStep2") });
        this.addConsent(contentEl, 0, t("engineInstallConsentResponsibility"));
        this.addConsent(contentEl, 1, t("engineInstallConsentLaw"));

        // Step 3: pick the file
        contentEl.createEl("h3", { text: t("engineInstallStep3") });
        const fileInput = contentEl.createEl("input", {
            type: "file",
            attr: { accept: ".js,application/javascript,text/javascript,*/*" },
        });
        fileInput.style.display = "none";
        fileInput.addEventListener("change", async () => {
            const file = fileInput.files?.[0];
            fileInput.value = "";
            if (file) await this.handleFile(file);
        });

        new Setting(contentEl)
            .setDesc(t("engineInstallStep3Desc").replace("{file}", ENGINE_FILE_NAME))
            .addButton((btn) => {
                this.pickButton = btn.buttonEl;
                btn.setButtonText(t("engineInstallPickFile"))
                    .setCta()
                    .onClick(() => fileInput.click());
            });

        this.statusEl = contentEl.createDiv({ cls: "vault-sync-engine-install-status" });
        this.refreshPickButton();
    }

    onClose(): void {
        this.contentEl.empty();
    }

    private addConsent(containerEl: HTMLElement, index: number, label: string): void {
        new Setting(containerEl).setDesc(label).addToggle((toggle) =>
            toggle.setValue(false).onChange((value) => {
                this.consents[index] = value;
                this.refreshPickButton();
            }),
        );
    }

    private refreshPickButton(): void {
        if (!this.pickButton) return;
        this.pickButton.disabled = this.busy || !this.consents.every(Boolean);
    }

    private setStatus(text: string, isError: boolean): void {
        if (!this.statusEl) return;
        this.statusEl.setText(text);
        this.statusEl.toggleClass("mod-error", isError);
    }

    private async handleFile(file: File): Promise<void> {
        if (!this.consents.every(Boolean)) return;
        this.busy = true;
        this.refreshPickButton();
        this.setStatus(t("engineInstallVerifying"), false);
        try {
            const result = await this.install(await file.text());
            if (result.ok) {
                this.setStatus(t("engineInstallSuccess"), false);
                window.setTimeout(() => {
                    this.close();
                    this.onInstalled();
                }, 1200);
                return;
            }
            const key =
                result.reason === "hash-mismatch"
                    ? "engineInstallErrorHash"
                    : result.reason === "write-failed"
                      ? "engineInstallErrorWrite"
                      : "engineInstallErrorInvalid";
            this.setStatus(t(key), true);
        } catch (e) {
            console.error("Vault-Sync: engine install failed", e);
            this.setStatus(t("engineInstallErrorInvalid"), true);
        } finally {
            this.busy = false;
            this.refreshPickButton();
        }
    }
}
