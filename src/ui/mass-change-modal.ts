import { App, Modal, Setting } from "obsidian";
import { t } from "../i18n";
import type { PlanSummary, PlannedChange, SyncPlan } from "../sync-manager/sync-plan";
import { deletedFileCount, isCountedOverwrite, type MassChangeAsk } from "../sync-manager/mass-change-guard";

/** Paths listed per kind before the rest is summarized as "…and N more" */
const MAX_LISTED = 50;

const fill = (text: string, n: number) => text.replace("{n}", String(n));

/**
 * Shown when one sync would delete or overwrite more files than the thresholds
 * allow. Resolves true to run the changes, false to hold them.
 */
export class MassChangeModal extends Modal {
    private confirmed = false;
    private resolve: ((ok: boolean) => void) | null = null;

    constructor(
        app: App,
        private readonly plan: SyncPlan,
        private readonly summary: PlanSummary,
        private readonly kinds: MassChangeAsk,
    ) {
        super(app);
    }

    ask(): Promise<boolean> {
        return new Promise((resolve) => {
            this.resolve = resolve;
            this.open();
        });
    }

    onOpen(): void {
        const { contentEl } = this;
        const { deletes, overwrites } = this.kinds;
        this.setTitle(t(deletes && overwrites ? "massChangeTitle" : deletes ? "massDeleteTitle" : "massOverwriteTitle"));

        if (deletes) {
            contentEl.createEl("p", {
                text: fill(
                    t(this.plan.step === "push" ? "massDeleteBodyPush" : "massDeleteBodyPull"),
                    deletedFileCount(this.summary),
                ),
            });
            this.list(
                this.plan.changes.filter((c) => c.action === "delete-remote" || c.action === "delete-local"),
                (c) =>
                    c.kind === "folder" ? `${c.path}/ (${fill(t("massDeleteFolderFiles"), c.contains?.length ?? 0)})` : c.path,
            );
        }
        if (overwrites) {
            const changes = this.plan.changes.filter(isCountedOverwrite);
            contentEl.createEl("p", { text: fill(t("massOverwriteBody"), changes.length) });
            this.list(changes, (c) => c.path);
        }

        const notes = [deletes ? t("massDeleteHoldNote") : null, overwrites ? t("massOverwriteHoldNote") : null];
        for (const note of notes) {
            if (note) contentEl.createEl("p", { text: note, cls: "setting-item-description" });
        }

        new Setting(contentEl)
            .addButton((btn) =>
                btn
                    .setButtonText(t("massDeleteHold"))
                    .setCta()
                    .onClick(() => this.close()),
            )
            .addButton((btn) =>
                btn
                    .setButtonText(t(overwrites ? "massChangeRun" : "massDeleteRun"))
                    .setWarning()
                    .onClick(() => {
                        this.confirmed = true;
                        this.close();
                    }),
            );
    }

    private list(changes: PlannedChange[], label: (c: PlannedChange) => string): void {
        const ul = this.contentEl.createEl("ul", { cls: "vault-sync-mass-delete-list" });
        for (const c of changes.slice(0, MAX_LISTED)) ul.createEl("li", { text: label(c) });
        if (changes.length > MAX_LISTED) {
            ul.createEl("li", { text: fill(t("massDeleteMore"), changes.length - MAX_LISTED) });
        }
    }

    onClose(): void {
        this.contentEl.empty();
        this.resolve?.(this.confirmed);
        this.resolve = null;
    }
}
