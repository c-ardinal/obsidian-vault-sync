import { App, Modal, Notice, Setting, TFile } from "obsidian";
import { formatDateTime } from "./format-time";
import { t } from "../i18n";
import type { RestoreAction, RestorePlan, RestoreResult } from "../sync-manager/point-in-time";
import { countByAction } from "../sync-manager/point-in-time";

/** What the screen needs from the sync */
export interface PointInTimeSource {
    readonly supportsHistory: boolean;
    planPointInTimeRestore(
        folder: string,
        time: number,
        options: { onProgress?: (done: number, total: number) => void; signal?: { aborted: boolean } },
    ): Promise<RestorePlan>;
    applyPointInTimeRestore(
        plan: RestorePlan,
        options: {
            removeCreatedAfter: boolean;
            remove: (path: string) => Promise<void>;
            onProgress?: (done: number, total: number) => void;
        },
    ): Promise<RestoreResult>;
}

/** Entries listed in the preview, at most */
const LIST_LIMIT = 300;

const ACTION_LABELS: Record<RestoreAction, string> = {
    restore: "pitActionRestore",
    recreate: "pitActionRecreate",
    "created-after": "pitActionCreatedAfter",
    unchanged: "pitActionUnchanged",
    "no-history": "pitActionNoHistory",
};

const fill = (text: string, values: Record<string, string | number>) =>
    text.replace(/\{(\w+)\}/g, (m, k: string) => (k in values ? String(values[k]) : m));

/** "YYYY-MM-DDTHH:mm" in local time, for <input type="datetime-local"> */
function toLocalInput(ms: number): string {
    const d = new Date(ms);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** A folder (or the whole vault) back to a past time: choose, check, then restore */
export class PointInTimeModal extends Modal {
    private folder: string;
    private time = Date.now() - 24 * 60 * 60 * 1000;
    private removeCreatedAfter = false;
    private signal = { aborted: false };

    constructor(
        app: App,
        private readonly source: PointInTimeSource,
        folder = "",
    ) {
        super(app);
        this.folder = folder;
        this.modalEl.addClass("vault-sync-pit-modal");
    }

    onOpen(): void {
        this.setTitle(t("pitTitle"));
        this.renderForm();
    }

    onClose(): void {
        this.signal.aborted = true;
        this.contentEl.empty();
    }

    private renderForm(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl("p", { cls: "vault-sync-pit-note", text: t("pitIntro") });

        new Setting(contentEl)
            .setName(t("pitFolder"))
            .setDesc(t("pitFolderDesc"))
            .addText((text) => {
                text.setPlaceholder(t("pitFolderPlaceholder"))
                    .setValue(this.folder)
                    .onChange((v) => (this.folder = v));
                text.inputEl.addClass("vault-sync-pit-folder");
            });

        new Setting(contentEl).setName(t("pitTime")).addText((text) => {
            text.inputEl.type = "datetime-local";
            text.inputEl.addClass("vault-sync-pit-time");
            text.setValue(toLocalInput(this.time)).onChange((v) => {
                const ms = new Date(v).getTime();
                if (Number.isFinite(ms)) this.time = ms;
            });
        });

        new Setting(contentEl)
            .setName(t("pitRemoveCreated"))
            .setDesc(t("pitRemoveCreatedDesc"))
            .addToggle((toggle) => toggle.setValue(this.removeCreatedAfter).onChange((v) => (this.removeCreatedAfter = v)));

        contentEl.createEl("p", { cls: "vault-sync-pit-note", text: t("pitLimits") });

        const row = contentEl.createDiv({ cls: "modal-button-container" });
        row.createEl("button", { cls: "mod-cta", text: t("pitCheck") }).addEventListener("click", () => {
            if (this.time > Date.now()) {
                new Notice(t("pitFuture"));
                return;
            }
            void this.check();
        });
    }

    private async check(): Promise<void> {
        const { contentEl } = this;
        contentEl.empty();
        this.signal = { aborted: false };
        const status = contentEl.createEl("p", { cls: "vault-sync-pit-progress", text: t("remoteTrashLoading") });
        const row = contentEl.createDiv({ cls: "modal-button-container" });
        row.createEl("button", { text: t("confirmCancel") }).addEventListener("click", () => {
            this.signal.aborted = true;
            this.renderForm();
        });
        try {
            const plan = await this.source.planPointInTimeRestore(this.folder, this.time, {
                signal: this.signal,
                onProgress: (done, total) => status.setText(fill(t("pitChecking"), { done, total })),
            });
            if (!this.signal.aborted) this.renderPlan(plan);
        } catch (e) {
            if (this.signal.aborted) return;
            contentEl.empty();
            contentEl.createEl("p", { cls: "mod-warning", text: `${t("pitFailed")}: ${String(e)}` });
        }
    }

    private renderPlan(plan: RestorePlan): void {
        const { contentEl } = this;
        contentEl.empty();
        const counts = countByAction(plan);
        const when = formatDateTime(plan.time);
        contentEl.createEl("p", {
            cls: "vault-sync-pit-note",
            text: fill(t("pitPlanIntro"), { folder: plan.folder || t("pitWholeVault"), time: when }),
        });

        const summary = contentEl.createDiv({ cls: "vault-sync-pit-summary" });
        const line = (action: RestoreAction, extra = "") => {
            const el = summary.createDiv({ cls: `vault-sync-pit-count mod-${action}` });
            el.createSpan({ text: t(ACTION_LABELS[action]) });
            el.createSpan({ cls: "vault-sync-pit-count-n", text: `${counts[action]}${extra}` });
        };
        line("restore");
        line("recreate");
        line("created-after", this.removeCreatedAfter ? "" : ` ${t("pitKept")}`);
        line("unchanged");
        if (counts["no-history"] > 0) line("no-history");

        const shown = plan.entries.filter((e) => e.action !== "unchanged");
        if (shown.length > 0) {
            const list = contentEl.createDiv({ cls: "vault-sync-pit-list" });
            for (const e of shown.slice(0, LIST_LIMIT)) {
                const rowEl = list.createDiv({ cls: "vault-sync-pit-row" });
                rowEl.createSpan({ cls: `vault-sync-pit-tag mod-${e.action}`, text: t(ACTION_LABELS[e.action]) });
                rowEl.createSpan({ cls: "vault-sync-pit-path", text: e.path });
            }
            if (shown.length > LIST_LIMIT) {
                list.createDiv({ cls: "vault-sync-pit-note", text: fill(t("pitMore"), { n: shown.length - LIST_LIMIT }) });
            }
        }

        const work = counts.restore + counts.recreate + (this.removeCreatedAfter ? counts["created-after"] : 0);
        if (work === 0) contentEl.createEl("p", { text: t("pitNothing") });
        const row = contentEl.createDiv({ cls: "modal-button-container" });
        row.createEl("button", { text: t("pitBack") }).addEventListener("click", () => this.renderForm());
        if (work === 0) return;
        row.createEl("button", { cls: "mod-cta", text: fill(t("pitApply"), { n: work }) }).addEventListener(
            "click",
            () => void this.apply(plan),
        );
    }

    private async apply(plan: RestorePlan): Promise<void> {
        const { contentEl } = this;
        contentEl.empty();
        const status = contentEl.createEl("p", { cls: "vault-sync-pit-progress", text: t("remoteTrashLoading") });
        const result = await this.source.applyPointInTimeRestore(plan, {
            removeCreatedAfter: this.removeCreatedAfter,
            remove: async (path) => {
                const file = this.app.vault.getAbstractFileByPath(path);
                if (file instanceof TFile) await this.app.fileManager.trashFile(file);
            },
            onProgress: (done, total) => status.setText(fill(t("pitApplying"), { done, total })),
        });
        const text = fill(t("pitDone"), {
            restored: result.restored,
            recreated: result.recreated,
            removed: result.removed,
        });
        new Notice(result.failed.length > 0 ? `${text}\n${fill(t("pitSomeFailed"), { n: result.failed.length })}` : text);
        this.close();
    }
}
