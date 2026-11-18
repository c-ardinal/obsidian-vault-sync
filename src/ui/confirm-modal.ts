import { App, Modal, Setting } from "obsidian";
import { t } from "../i18n";

/** Yes/no dialog that resolves to true only when the user presses the confirm button. */
export class ConfirmModal extends Modal {
    private confirmed = false;
    private resolve: ((ok: boolean) => void) | null = null;

    constructor(
        app: App,
        private message: string,
        private confirmLabel: string = t("confirmOk"),
        private danger = false,
    ) {
        super(app);
    }

    /** Open the dialog and wait for the answer. */
    ask(): Promise<boolean> {
        return new Promise((resolve) => {
            this.resolve = resolve;
            this.open();
        });
    }

    onOpen(): void {
        const { contentEl } = this;
        for (const line of this.message.split("\n")) {
            contentEl.createEl("p", { text: line });
        }
        new Setting(contentEl)
            .addButton((btn) => {
                btn.setButtonText(this.confirmLabel).onClick(() => {
                    this.confirmed = true;
                    this.close();
                });
                if (this.danger) btn.setWarning();
                else btn.setCta();
            })
            .addButton((btn) => btn.setButtonText(t("confirmCancel")).onClick(() => this.close()));
    }

    onClose(): void {
        this.contentEl.empty();
        this.resolve?.(this.confirmed);
        this.resolve = null;
    }
}
