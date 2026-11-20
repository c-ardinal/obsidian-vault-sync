import { App, Modal, Notice, Platform, Setting } from "obsidian";
import { t } from "../i18n";

/** What the screen needs: the text, with or without the log */
export type DiagnosticsBuilder = (includeLog: boolean) => Promise<string>;

/** Diagnostic info for a support request: shown first, then copied */
export class DiagnosticsModal extends Modal {
    private includeLog = true;
    private textEl: HTMLTextAreaElement | null = null;

    constructor(
        app: App,
        private readonly build: DiagnosticsBuilder,
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

        const row = contentEl.createDiv({ cls: "modal-button-container" });
        const copy = row.createEl("button", { cls: "mod-cta", text: t("diagnosticsCopy") });
        copy.addEventListener("click", () => void this.copy());

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

    onClose(): void {
        this.contentEl.empty();
        this.textEl = null;
    }
}
