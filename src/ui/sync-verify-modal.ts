import { App, Modal } from "obsidian";
import { t } from "../i18n";
import type { VerifyDifference, VerifyProgress, VerifyReport } from "../sync-manager/sync-verify";
import { verifyEstimate } from "./progress-math";
import { formatDateTime } from "./format-time";
import { formatDuration } from "./sync-status-view";

/** Time taken so far, to the second: "42s", "1 min 5s" */
function formatElapsed(sec: number): string {
    const whole = Math.floor(sec);
    const seconds = t("statusSeconds").replace("{0}", String(whole % 60));
    return whole < 60 ? seconds : `${t("statusMinutes").replace("{0}", String(Math.floor(whole / 60)))} ${seconds}`;
}

/** The progress display is redrawn at most this often */
const PROGRESS_REDRAW_MS = 150;

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
    run: (onProgress: (p: VerifyProgress) => void) => Promise<VerifyReport>;
    isSyncing: () => boolean;
    /** false: not logged in (the check needs the cloud) */
    isSignedIn: () => boolean | undefined;
    syncNow: () => void;
}

/**
 * Read-only sync check: compares this device with the cloud and lists what
 * differs. Changes nothing; "Sync now" is the user's choice.
 */
export class SyncVerifyModal extends Modal {
    private listingClock: number | null = null;

    constructor(
        app: App,
        private readonly actions: VerifyActions,
    ) {
        super(app);
        this.modalEl.addClass("vault-syncer-verify-modal");
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
        el.createEl("p", { cls: "vault-syncer-verify-status", text: t("verifyRunning") });
        // Bar, then one line: the count on the left, the time left on the right
        const fill = el
            .createDiv({ cls: "vault-syncer-status-bar vault-syncer-verify-bar" })
            .createDiv({ cls: "vault-syncer-status-bar-fill" });
        const line = el.createDiv({ cls: "vault-syncer-verify-progress" });
        const countEl = line.createSpan({ text: t("verifyListing") });
        const etaEl = line.createSpan();
        // The cloud listing has no known length: a moving mark and the time it has taken
        // show that it runs. The comparison that follows has a measure and fills the bar.
        const listingStart = Date.now();
        const showElapsed = () =>
            etaEl.setText(t("verifyElapsed").replace("{0}", formatElapsed((Date.now() - listingStart) / 1000)));
        fill.addClass("is-indeterminate");
        showElapsed();
        this.stopListingClock();
        this.listingClock = window.setInterval(showElapsed, 1000);
        let compareStart: number | null = null;
        let lastDraw = 0;
        const onProgress = (p: VerifyProgress) => {
            if (p.stage === "listing") return;
            const now = Date.now();
            if (compareStart === null) {
                compareStart = now;
                this.stopListingClock();
                fill.removeClass("is-indeterminate");
            }
            const last = p.done >= p.total;
            if (!last && now - lastDraw < PROGRESS_REDRAW_MS) return;
            lastDraw = now;
            const { fraction, etaSec } = verifyEstimate(p, now - compareStart);
            fill.style.width = `${Math.round((fraction ?? 0) * 100)}%`;
            countEl.setText(t("verifyProgress").replace("{0}", String(p.done)).replace("{1}", String(p.total)));
            etaEl.setText(etaSec === null ? "" : `${t("statusEta")} ${t("statusAbout")}${formatDuration(etaSec)}`);
        };
        let report: VerifyReport;
        try {
            report = await this.actions.run(onProgress);
        } catch (e) {
            this.stopListingClock();
            el.empty();
            if (this.actions.isSignedIn() === false) {
                el.createEl("p", { text: t("verifySignInRequired") });
                return;
            }
            el.createEl("p", { text: t("verifyFailed") });
            el.createEl("p", { cls: "setting-item-description", text: String(e) });
            return;
        }
        this.stopListingClock();
        this.render(report);
    }

    private stopListingClock(): void {
        if (this.listingClock !== null) window.clearInterval(this.listingClock);
        this.listingClock = null;
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
            const details = el.createEl("details", { cls: "vault-syncer-verify-group" });
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
        this.stopListingClock();
        this.contentEl.empty();
    }
}
