import { App, Modal } from "obsidian";
import { t } from "../i18n";
import type { VerifyDifference, VerifyReport } from "../sync-manager/sync-verify";
import { formatDateTime } from "./format-time";

/** Most paths listed per kind (the count says how many there are) */
const MAX_LISTED = 50;

const KIND_ORDER: VerifyDifference[] = ["local-changed", "cloud-changed", "differs", "local-only", "cloud-only"];
const KIND_LABEL: Record<VerifyDifference, string> = {
    "local-changed": "verifyLocalChanged",
    "cloud-changed": "verifyCloudChanged",
    differs: "verifyDiffers",
    "local-only": "verifyLocalOnly",
    "cloud-only": "verifyCloudOnly",
};

export interface VerifyActions {
    run: () => Promise<VerifyReport>;
    isSyncing: () => boolean;
    syncNow: () => void;
}

/**
 * Read-only sync check: compares this device with the cloud and lists what
 * differs. Changes nothing; "Sync now" is the user's choice.
 */
export class SyncVerifyModal extends Modal {
    constructor(
        app: App,
        private readonly actions: VerifyActions,
    ) {
        super(app);
        this.modalEl.addClass("vault-sync-verify-modal");
    }

    onOpen(): void {
        this.setTitle(t("verifyTitle"));
        void this.check();
    }

    private async check(): Promise<void> {
        const el = this.contentEl;
        el.empty();
        if (this.actions.isSyncing()) {
            el.createEl("p", { text: t("verifyBusy") });
            return;
        }
        el.createEl("p", { cls: "vault-sync-verify-status", text: t("verifyRunning") });
        let report: VerifyReport;
        try {
            report = await this.actions.run();
        } catch (e) {
            el.empty();
            el.createEl("p", { text: t("verifyFailed") });
            el.createEl("p", { cls: "setting-item-description", text: String(e) });
            return;
        }
        this.render(report);
    }

    private render(report: VerifyReport): void {
        const el = this.contentEl;
        el.empty();
        const clean = report.differences.length === 0 && report.pending === 0;
        el.createEl("p", {
            text: clean
                ? t("verifyClean").replace("{0}", String(report.matching))
                : t("verifySummary")
                      .replace("{0}", String(report.matching))
                      .replace("{1}", String(report.differences.length)),
        });
        if (report.pending > 0) {
            el.createEl("p", { cls: "setting-item-description", text: t("verifyPending").replace("{0}", String(report.pending)) });
        }
        for (const kind of KIND_ORDER) {
            const paths = report.differences.filter((d) => d.kind === kind).map((d) => d.path);
            if (paths.length === 0) continue;
            const details = el.createEl("details", { cls: "vault-sync-verify-group" });
            details.createEl("summary", { text: `${t(KIND_LABEL[kind])} (${paths.length})` });
            const list = details.createEl("ul");
            for (const p of paths.slice(0, MAX_LISTED)) list.createEl("li", { text: p });
            if (paths.length > MAX_LISTED) {
                list.createEl("li", { text: t("verifyMore").replace("{0}", String(paths.length - MAX_LISTED)) });
            }
        }
        el.createEl("p", {
            cls: "setting-item-description",
            text: t("verifyCheckedAt").replace("{0}", formatDateTime(report.checkedAt)),
        });
        const row = el.createDiv({ cls: "modal-button-container" });
        row.createEl("button", { text: t("verifyAgain") }).addEventListener("click", () => void this.check());
        if (!clean) {
            row.createEl("button", { cls: "mod-cta", text: t("statusSyncNow") }).addEventListener("click", () => {
                this.close();
                this.actions.syncNow();
            });
        }
    }

    onClose(): void {
        this.contentEl.empty();
    }
}
