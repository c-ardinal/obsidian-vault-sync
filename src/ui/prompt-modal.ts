import { App, Modal, Setting, TextComponent, ButtonComponent } from "obsidian";

export class PromptModal extends Modal {
    private result: string | null = null;
    private onSubmit: (result: string | null) => void | Promise<void>;
    private errorEl: HTMLElement | null = null;
    private okBtn: ButtonComponent | null = null;

    constructor(
        app: App,
        private title: string,
        private defaultValue: string,
        onSubmit: (result: string | null) => void | Promise<void>,
        private validator?: (value: string) => Promise<string | null>,
    ) {
        super(app);
        this.onSubmit = onSubmit;
    }

    onOpen() {
        const { contentEl } = this;
        this.setTitle(this.title);

        const inputSetting = new Setting(contentEl).setName("Path");
        let textComp: TextComponent | null = null;

        inputSetting.addText((text) => {
            textComp = text;
            text.setValue(this.defaultValue);
            text.inputEl.addClass("vault-syncer-prompt-input");

            text.onChange(async (val) => {
                await this.validate(val);
            });
        });

        this.errorEl = contentEl.createDiv({ cls: "vault-syncer-prompt-error" });

        new Setting(contentEl)
            .addButton((btn) => {
                this.okBtn = btn;
                btn.setButtonText("OK")
                    .setCta()
                    .onClick(() => {
                        this.result = textComp!.getValue();
                        this.close();
                    });
            })
            .addButton((btn) =>
                btn.setButtonText("Cancel").onClick(() => {
                    this.close();
                }),
            );

        textComp!.inputEl.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && this.okBtn && !this.okBtn.buttonEl.disabled) {
                this.result = textComp!.getValue();
                this.close();
            }
        });

        window.setTimeout(() => {
            textComp!.inputEl.focus();
            textComp!.inputEl.select();
            void this.validate(this.defaultValue);
        }, 50);
    }

    private async validate(val: string) {
        if (!this.validator) return;
        const error = await this.validator(val);
        if (error) {
            this.errorEl?.setText(error);
            this.okBtn?.setDisabled(true);
        } else {
            this.errorEl?.setText("");
            this.okBtn?.setDisabled(false);
        }
    }

    onClose() {
        void this.onSubmit(this.result);
        this.contentEl.empty();
    }
}
