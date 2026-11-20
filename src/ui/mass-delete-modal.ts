import { App, Modal, Setting } from "obsidian";
import { t } from "../i18n";
import type { PlanSummary, SyncPlan } from "../sync-manager/sync-plan";
import { deletedFileCount } from "../sync-manager/mass-change-guard";

/** Paths listed before the rest is summarized as "…and N more" */
const MAX_LISTED = 50;

const fill = (text: string, n: number) => text.replace("{n}", String(n));

/**
 * Shown when one sync would delete more files than the thresholds allow.
 * Resolves true to run the deletions, false to hold them.
 */
export class MassDeleteModal extends Modal {
    private confirmed = false;
    private resolve: ((ok: boolean) => void) | null = null;

    constructor(
        app: App,
        private readonly plan: SyncPlan,
        private readonly summary: PlanSummary,
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
        this.setTitle(t("massDeleteTitle"));
        const n = deletedFileCount(this.summary);
        contentEl.createEl("p", {
            text: fill(t(this.plan.step === "push" ? "massDeleteBodyPush" : "massDeleteBodyPull"), n),
        });

        const deletions = this.plan.changes.filter(
            (c) => c.action === "delete-remote" || c.action === "delete-local",
        );
        const list = contentEl.createEl("ul", { cls: "vault-sync-mass-delete-list" });
        for (const c of deletions.slice(0, MAX_LISTED)) {
            const label =
                c.kind === "folder"
                    ? `${c.path}/ (${fill(t("massDeleteFolderFiles"), c.contains?.length ?? 0)})`
                    : c.path;
            list.createEl("li", { text: label });
        }
        if (deletions.length > MAX_LISTED) {
            list.createEl("li", { text: fill(t("massDeleteMore"), deletions.length - MAX_LISTED) });
        }

        contentEl.createEl("p", { text: t("massDeleteHoldNote"), cls: "setting-item-description" });

        new Setting(contentEl)
            .addButton((btn) =>
                btn
                    .setButtonText(t("massDeleteHold"))
                    .setCta()
                    .onClick(() => this.close()),
            )
            .addButton((btn) =>
                btn
                    .setButtonText(t("massDeleteRun"))
                    .setWarning()
                    .onClick(() => {
                        this.confirmed = true;
                        this.close();
                    }),
            );
    }

    onClose(): void {
        this.contentEl.empty();
        this.resolve?.(this.confirmed);
        this.resolve = null;
    }
}
