import { App, Modal, Notice, Platform, Setting } from "obsidian";
import { t } from "../i18n";
import { issueUrl } from "../sync-manager/diagnostics";

/** What the screen needs: the text, with or without the log */
export type DiagnosticsBuilder = (includeLog: boolean) => Promise<string>;

/**
 * Diagnostic info for a support request: shown first, then copied, or sent
 * to the new-issue page of the plugin's repository with the text filled in.
 */
export class DiagnosticsModal extends Modal {
    private includeLog = true;
    private textEl: HTMLTextAreaElement | null = null;

    constructor(
        app: App,
        private readonly build: DiagnosticsBuilder,
        /** Issue title to suggest (e.g. the error); empty: the user writes one */
        private readonly issueTitle = "",
    ) {
        super(app);
        this.modalEl.addClass("vault-sync-diagnostics-modal");
    }

    onOpen(): void {
        const { contentEl } = this;
        this.setTitle(t("diagnosticsTitle"));
        contentEl.createEl("p", { cls: "vault-sync-diagnostics-note", text: t("diagnosticsIntro") });

        new Setting(contentEl)
            .setName(t("diagnosticsIncludeLog"))
            .setDesc(t("diagnosticsIncludeLogDesc"))
            .addToggle((toggle) =>
                toggle.setValue(this.includeLog).onChange((v) => {
                    this.includeLog = v;
                    void this.refresh();
                }),
            );

        this.textEl = contentEl.createDiv().createEl("textarea", { cls: "vault-sync-diagnostics-text" });
        this.textEl.readOnly = true;
        this.textEl.spellcheck = false;
        this.textEl.rows = Platform.isPhone ? 10 : 16;
        this.textEl.setAttr("aria-label", t("diagnosticsTitle"));

        contentEl.createEl("p", { cls: "vault-sync-diagnostics-note", text: t("diagnosticsReportDesc") });

        const row = contentEl.createDiv({ cls: "modal-button-container" });
        row.createEl("button", { text: t("diagnosticsCopy") }).addEventListener("click", () => void this.copy());
        row.createEl("button", { cls: "mod-cta", text: t("diagnosticsReport") }).addEventListener(
            "click",
            () => void this.report(),
        );

        void this.refresh();
    }

    private async refresh(): Promise<void> {
        if (!this.textEl) return;
        this.textEl.value = t("remoteTrashLoading");
        try {
            this.textEl.value = await this.build(this.includeLog);
        } catch (e) {
            this.textEl.value = String(e);
        }
    }

    private async copy(): Promise<void> {
        const text = this.textEl?.value ?? "";
        try {
            await navigator.clipboard.writeText(text);
            new Notice(t("diagnosticsCopied"));
        } catch {
            // Clipboard refused (some mobile views): select the text for a manual copy
            this.textEl?.focus();
            this.textEl?.select();
            new Notice(t("diagnosticsCopyFailed"));
        }
    }

    /** Open the new-issue page with the text; the whole text goes to the clipboard when the link must be shortened */
    private async report(): Promise<void> {
        const text = this.textEl?.value ?? "";
        const { url, shortened } = issueUrl(this.issueTitle, text, t("diagnosticsReportShortenedNote"));
        if (shortened) {
            try {
                await navigator.clipboard.writeText(text);
                new Notice(t("diagnosticsReportShortened"), 10000);
            } catch {
                new Notice(t("diagnosticsReportShortenedNoClipboard"), 10000);
            }
        }
        window.open(url);
    }

    onClose(): void {
        this.contentEl.empty();
        this.textEl = null;
    }
}
