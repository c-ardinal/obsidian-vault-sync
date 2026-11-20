import { App, Modal, Notice, Setting } from "obsidian";
import { t } from "../i18n";
import type { CloudAdapter } from "../types/adapter";
import {
    deleteFromTrash,
    listTrash,
    restoreFromTrash,
    type TrashedFile,
} from "../sync-manager/remote-trash";

const fill = (text: string, key: string, value: string | number) => text.replace(`{${key}}`, String(value));

function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Lists the files kept in the cloud trash, with restore and delete-for-good per file. */
export class RemoteTrashModal extends Modal {
    constructor(
        app: App,
        private readonly adapter: CloudAdapter,
        /** Days files are kept; 0 or less = keeping is off */
        private readonly retentionDays: number,
    ) {
        super(app);
    }

    onOpen(): void {
        this.setTitle(t("remoteTrashTitle"));
        void this.render();
    }

    onClose(): void {
        this.contentEl.empty();
    }

    private async render(): Promise<void> {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl("p", {
            text:
                this.retentionDays > 0
                    ? fill(t("remoteTrashIntro"), "n", this.retentionDays)
                    : t("remoteTrashIntroOff"),
            cls: "setting-item-description",
        });
        const status = contentEl.createEl("p", { text: t("remoteTrashLoading") });

        let files: TrashedFile[];
        try {
            files = await listTrash(this.adapter);
        } catch {
            status.setText(t("remoteTrashFailed"));
            return;
        }
        if (files.length === 0) {
            status.setText(t("remoteTrashEmpty"));
            return;
        }
        status.remove();

        const list = contentEl.createDiv({ cls: "vault-sync-remote-trash-list" });
        for (const file of files) this.renderRow(list, file);
    }

    private renderRow(parent: HTMLElement, file: TrashedFile): void {
        const row = new Setting(parent)
            .setName(file.originalPath)
            .setDesc(`${fill(t("remoteTrashDeletedOn"), "day", file.day)} · ${formatSize(file.size)}`);
        row.addButton((btn) =>
            btn.setButtonText(t("remoteTrashRestore")).onClick(async () => {
                btn.setDisabled(true);
                try {
                    const path = await restoreFromTrash(this.adapter, file);
                    new Notice(fill(t("noticeRemoteTrashRestored"), "path", path));
                    row.settingEl.remove();
                } catch {
                    new Notice(t("noticeRemoteTrashActionFailed"));
                    btn.setDisabled(false);
                }
            }),
        );
        let armed = false;
        row.addButton((btn) =>
            btn
                .setButtonText(t("remoteTrashDelete"))
                .setWarning()
                .onClick(async () => {
                    if (!armed) {
                        armed = true;
                        btn.setButtonText(t("remoteTrashDeleteConfirm"));
                        return;
                    }
                    btn.setDisabled(true);
                    try {
                        await deleteFromTrash(this.adapter, file);
                        row.settingEl.remove();
                    } catch {
                        new Notice(t("noticeRemoteTrashActionFailed"));
                        btn.setDisabled(false);
                    }
                }),
        );
    }
}
