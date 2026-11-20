/**
 * Transfer status screen.
 *
 * 1. Sync summary: the current (or last) sync cycle from SyncProgressTracker.
 * 2. Totals for the last 24 hours.
 * 3. Queue: files transferring now and waiting (inline and background).
 * 4. History: filterable, grouped by day and into batches (usually one sync cycle).
 */
import { App, Modal, moment, setIcon } from "obsidian";
import { SyncManager } from "../sync-manager";
import type { TransferItem, TransferRecord } from "../sync-manager/transfer-types";
import type { SyncProgressSnapshot } from "../sync-manager/sync-progress";
import { TRANSFER_MAX_RETRIES } from "../sync-manager/constants";
import { basename, dirname } from "../utils/path";
import {
    displayState,
    formatBytes,
    formatClock,
    formatDuration,
    percent,
    triggerLabel,
    type DisplayState,
} from "./sync-status-view";
import {
    groupHistory,
    transferStats,
    type HistoryBatch,
    type HistoryFilter,
} from "./transfer-history-groups";

/** Queue rows shown before "N more" */
const QUEUE_VISIBLE = 8;
/** Lists are refreshed this often (only when their data changed) */
const REFRESH_MS = 1000;

const STATE_TITLE: Record<DisplayState, string> = {
    syncing: "statusSyncing",
    scanning: "statusScanning",
    synced: "statusSynced",
    error: "statusFailed",
    offline: "statusOffline",
    auth: "statusAuth",
    never: "statusNever",
};

export class TransferStatusModal extends Modal {
    private refreshTimer: number | null = null;
    private unsubscribe: (() => void) | null = null;
    private summaryEl: HTMLElement | null = null;
    private statsEl: HTMLElement | null = null;
    private queueEl: HTMLElement | null = null;
    private historyEl: HTMLElement | null = null;
    private filter: HistoryFilter = "all";
    /** Batches the user opened or closed (otherwise: newest and failed ones are open) */
    private batchOpen = new Map<string, boolean>();
    private queueSig = "";
    private historySig = "";

    constructor(
        app: App,
        private syncManager: SyncManager,
    ) {
        super(app);
    }

    private get t(): (key: string) => string {
        return this.syncManager.t;
    }

    onOpen() {
        this.modalEl.addClass("mod-transfer-status-modal");
        // Title goes in Obsidian's own modal header, next to its close button.
        this.setTitle(this.t("transferTitle"));

        const root = this.contentEl.createDiv({ cls: "vault-sync-transfer-container" });
        this.summaryEl = root.createDiv({ cls: "vault-sync-xfer-summary" });
        this.statsEl = root.createDiv({ cls: "vault-sync-xfer-stats" });
        this.queueEl = root.createDiv({ cls: "vault-sync-xfer-section mod-queue" });
        this.historyEl = root.createDiv({ cls: "vault-sync-xfer-section mod-history" });

        const progress = this.syncManager.progress;
        if (progress) {
            this.unsubscribe = progress.subscribe((s) => this.renderSummary(s));
        } else {
            this.summaryEl.remove();
            this.summaryEl = null;
        }
        this.refreshLists(true);
        this.refreshTimer = window.setInterval(() => this.refreshLists(false), REFRESH_MS);
    }

    onClose() {
        if (this.refreshTimer !== null) window.clearInterval(this.refreshTimer);
        this.refreshTimer = null;
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.contentEl.empty();
    }

    // --- summary ---

    private isSignedIn(): boolean {
        try {
            return this.syncManager.adapter.isAuthenticated();
        } catch {
            return false;
        }
    }

    private renderSummary(s: SyncProgressSnapshot): void {
        const el = this.summaryEl;
        if (!el) return;
        const t = this.t;
        const state = displayState(s, this.isSignedIn());
        el.empty();
        el.dataset.state = state;

        const head = el.createDiv({ cls: "vault-sync-xfer-summary-head" });
        head.createSpan({ cls: "vault-sync-status-ring" }).style.setProperty(
            "--vs-p",
            String(state === "synced" ? 100 : percent(s)),
        );
        head.createSpan({ cls: "vault-sync-xfer-summary-title", text: t(STATE_TITLE[state]) });
        let sub = "";
        if (s.active && s.startedAt) {
            sub = `${triggerLabel(s.trigger)} · ${t("statusStartedAt").replace("{0}", formatClock(s.startedAt))}`;
        } else if (s.last) {
            sub = t("statusLastSync")
                .replace("{0}", formatClock(s.last.finishedAt))
                .replace("{1}", formatDuration(s.last.durationMs / 1000));
        }
        if (sub) head.createSpan({ cls: "vault-sync-xfer-muted", text: sub });

        const total = s.pull.total + s.push.total;
        if (s.active || total > 0 || state === "synced") {
            const bar = el.createDiv({ cls: "vault-sync-status-bar" });
            bar.createDiv({ cls: "vault-sync-status-bar-fill" }).style.width = `${percent(s)}%`;
        }

        // Counts on the left, time left / speed on the right
        const line = el.createDiv({ cls: "vault-sync-xfer-summary-line" });
        let counts = "";
        if (s.phase === "scanning" && total === 0) {
            counts = t("statusScanCount")
                .replace("{0}", String(s.scan.done))
                .replace("{1}", String(s.scan.total));
        } else if (total > 0) {
            counts = t("statusFiles")
                .replace("{0}", String(s.pull.done + s.push.done))
                .replace("{1}", String(total));
            const bytes = s.pull.bytesTotal + s.push.bytesTotal;
            if (bytes > 0) {
                counts += ` · ${formatBytes(s.pull.bytesDone + s.push.bytesDone)} / ${formatBytes(bytes)}`;
            }
        } else if (s.active) {
            counts = t("statusCheckingRemote");
        }
        line.createSpan({ text: counts });
        const right: string[] = [];
        if (s.active && s.etaSec !== null) {
            right.push(`${t("statusEta")} ${t("statusAbout")}${formatDuration(s.etaSec)}`);
        }
        if (s.active && s.bytesPerSec) right.push(`${formatBytes(s.bytesPerSec)}/s`);
        if (right.length) line.createSpan({ cls: "vault-sync-xfer-muted", text: right.join(" · ") });

        // Chips: per direction, conflicts, local changes waiting, failure reason
        const chips = el.createDiv({ cls: "vault-sync-xfer-chips" });
        const chip = (text: string, cls = "") =>
            chips.createSpan({ cls: `vault-sync-xfer-chip ${cls}`.trim(), text });
        if (total > 0) {
            chip(`${t("statusPull")} ${s.pull.done}/${s.pull.total}`, "mod-pull");
            chip(`${t("statusPush")} ${s.push.done}/${s.push.total}`, "mod-push");
        }
        const conflicts = s.active ? s.conflicts : (s.last?.conflicts ?? 0);
        if (conflicts > 0) chip(`${t("statusConflicts")} ${conflicts}`, "mod-warn");
        const pending = this.syncManager.pendingChangeCount ?? 0;
        if (!s.active && pending > 0) chip(t("statusPending").replace("{0}", String(pending)));
        if (!chips.hasChildNodes()) chips.remove();

        if (!s.active && (state === "error" || state === "offline" || state === "auth")) {
            const msg =
                state === "auth"
                    ? t("statusAuthHint")
                    : state === "offline"
                      ? t("statusOfflineHint")
                      : (s.last?.message ?? t("statusFailedHint"));
            el.createDiv({ cls: "vault-sync-status-error", text: msg });
        }
    }

    // --- lists ---

    private refreshLists(force: boolean): void {
        const active = this.syncManager.getActiveTransfers();
        const history = this.syncManager.getTransferHistory();
        const queueSig = active.map((i) => `${i.id}:${i.status}:${i.retryCount}`).join("|");
        const last = history[history.length - 1];
        // The day labels change at midnight; include the date in the signature.
        const historySig = `${history.length}:${last?.id ?? ""}:${this.filter}:${new Date().toDateString()}`;
        if (force || queueSig !== this.queueSig) {
            this.queueSig = queueSig;
            this.renderQueue(active);
        }
        if (force || historySig !== this.historySig) {
            this.historySig = historySig;
            this.renderStats(history);
            this.renderHistory(history);
        }
    }

    private renderStats(history: TransferRecord[]): void {
        const el = this.statsEl;
        if (!el) return;
        const t = this.t;
        const s = transferStats(history, Date.now());
        el.empty();
        el.createDiv({ cls: "vault-sync-xfer-section-title", text: t("transferStatsTitle") });
        const tiles = el.createDiv({ cls: "vault-sync-xfer-tiles" });
        const tile = (label: string, count: number, sub: string, cls: string) => {
            const tl = tiles.createDiv({ cls: `vault-sync-xfer-tile ${cls}` });
            tl.createDiv({ cls: "vault-sync-xfer-muted", text: label });
            tl.createDiv({
                cls: "vault-sync-xfer-tile-num",
                text: t("transferStatCount").replace("{0}", String(count)),
            });
            tl.createDiv({ cls: "vault-sync-xfer-muted", text: sub });
        };
        tile(t("statusPull"), s.pulls, formatBytes(s.pullBytes), "mod-pull");
        tile(t("statusPush"), s.pushes, formatBytes(s.pushBytes), "mod-push");
        tile(t("transferFilterFailed"), s.failed, "", s.failed > 0 ? "mod-failed" : "");
    }

    private renderQueue(active: TransferItem[]): void {
        const el = this.queueEl;
        if (!el) return;
        const t = this.t;
        el.empty();
        const header = el.createDiv({ cls: "vault-sync-xfer-section-head" });
        const title = header.createDiv({ cls: "vault-sync-xfer-section-title" });
        title.createSpan({ text: t("transferQueueTitle") });
        if (active.length > 0) {
            title.createSpan({ cls: "vault-sync-xfer-count", text: String(active.length) });
        }
        // Only background transfers can be cancelled (inline ones belong to the running sync).
        if (active.some((i) => !i.id.startsWith("inline-"))) {
            const cancel = header.createEl("button", {
                cls: "vault-sync-xfer-small-btn",
                text: t("transferCancelAll"),
            });
            cancel.addEventListener("click", () => {
                this.syncManager.cancelAllTransfers();
                this.refreshLists(true);
            });
        }

        if (active.length === 0) {
            el.createDiv({ cls: "vault-sync-xfer-empty", text: t("transferNoActive") });
            return;
        }
        // Transferring first, then waiting in queue order.
        const sorted = [...active].sort(
            (a, b) => Number(b.status === "active") - Number(a.status === "active"),
        );
        const list = el.createDiv({ cls: "vault-sync-xfer-list" });
        for (const item of sorted.slice(0, QUEUE_VISIBLE)) this.renderQueueRow(list, item);
        if (sorted.length > QUEUE_VISIBLE) {
            el.createDiv({
                cls: "vault-sync-xfer-more",
                text: t("transferMore").replace("{0}", String(sorted.length - QUEUE_VISIBLE)),
            });
        }
    }

    private renderQueueRow(list: HTMLElement, item: TransferItem): void {
        const t = this.t;
        const row = list.createDiv({
            cls: `vault-sync-xfer-row mod-${item.direction} ${item.status === "active" ? "is-active" : "is-waiting"}`,
        });
        this.dirIcon(row, item.direction);
        this.fileCell(row, item.path);
        const meta = row.createDiv({ cls: "vault-sync-xfer-meta" });
        meta.createSpan({ cls: "vault-sync-xfer-size", text: formatBytes(item.size) });
        const status = meta.createSpan({ cls: "vault-sync-xfer-state" });
        if (item.status === "active") {
            status.createSpan({ cls: "vault-sync-spinner" });
            status.createSpan({ text: t("transferActive") });
        } else if (item.retryCount > 0) {
            status.addClass("mod-warn");
            status.setText(
                t("transferRetrying")
                    .replace("{0}", String(item.retryCount))
                    .replace("{1}", String(TRANSFER_MAX_RETRIES)),
            );
        } else {
            status.setText(t("transferPending"));
        }
        if (!item.id.startsWith("inline-")) {
            meta.createSpan({ cls: "vault-sync-xfer-tag", text: t("transferBackground") });
        }
    }

    private renderHistory(history: TransferRecord[]): void {
        const el = this.historyEl;
        if (!el) return;
        const t = this.t;
        const scroller = el.closest(".vault-sync-transfer-container");
        const savedTop = scroller?.scrollTop ?? 0;
        el.empty();

        const header = el.createDiv({ cls: "vault-sync-xfer-section-head" });
        header.createDiv({ cls: "vault-sync-xfer-section-title", text: t("transferHistorySection") });

        // Filter
        const failedCount = history.filter((r) => r.status === "failed").length;
        const filters = el.createDiv({
            cls: "vault-sync-xfer-filters",
            attr: { role: "radiogroup", "aria-label": t("transferHistorySection") },
        });
        const options: Array<{ id: HistoryFilter; label: string; count?: number }> = [
            { id: "all", label: t("transferFilterAll"), count: history.length },
            { id: "pull", label: t("transferFilterPull") },
            { id: "push", label: t("transferFilterPush") },
            { id: "failed", label: t("transferFilterFailed"), count: failedCount },
        ];
        for (const o of options) {
            const b = filters.createEl("button", {
                cls: `vault-sync-xfer-filter${o.id === "failed" && failedCount > 0 ? " mod-failed" : ""}`,
                attr: { role: "radio", "aria-checked": String(this.filter === o.id) },
            });
            if (this.filter === o.id) b.addClass("is-active");
            b.createSpan({ text: o.label });
            if (o.count !== undefined && o.count > 0) {
                b.createSpan({ cls: "vault-sync-xfer-filter-count", text: String(o.count) });
            }
            b.addEventListener("click", () => {
                if (this.filter === o.id) return;
                this.filter = o.id;
                this.historySig = "";
                this.refreshLists(false);
            });
        }

        const days = groupHistory(history, this.filter, Date.now());
        if (days.length === 0) {
            el.createDiv({
                cls: "vault-sync-xfer-empty",
                text: history.length === 0 ? t("transferNoHistory") : t("transferNoMatch"),
            });
            return;
        }
        let first = true;
        for (const day of days) {
            const dayEl = el.createDiv({ cls: "vault-sync-xfer-day" });
            dayEl.createDiv({
                cls: "vault-sync-xfer-day-label",
                text:
                    day.kind === "today"
                        ? t("transferToday")
                        : day.kind === "yesterday"
                          ? t("transferYesterday")
                          : moment(day.dayStart).format("LL"),
            });
            for (const batch of day.batches) {
                this.renderBatch(dayEl, batch, first);
                first = false;
            }
        }
        if (scroller && savedTop) scroller.scrollTop = savedTop;
    }

    private renderBatch(parent: HTMLElement, batch: HistoryBatch, newest: boolean): void {
        const t = this.t;
        const open = this.batchOpen.get(batch.key) ?? (newest || batch.failed > 0);
        const box = parent.createDiv({ cls: "vault-sync-xfer-batch" });
        if (open) box.addClass("is-open");
        if (batch.failed > 0) box.addClass("has-failed");

        const head = box.createEl("button", {
            cls: "vault-sync-xfer-batch-head",
            attr: { "aria-expanded": String(open) },
        });
        setIcon(head.createSpan({ cls: "vault-sync-xfer-chevron" }), "chevron-right");
        const time =
            batch.end - batch.start >= 60_000
                ? `${formatClock(batch.start)}–${formatClock(batch.end)}`
                : formatClock(batch.end);
        head.createSpan({ cls: "vault-sync-xfer-batch-time", text: time });
        const counts = head.createSpan({ cls: "vault-sync-xfer-batch-counts" });
        if (batch.pulls > 0) {
            counts.createSpan({ cls: "mod-pull", text: `↓ ${batch.pulls}` });
        }
        if (batch.pushes > 0) {
            counts.createSpan({ cls: "mod-push", text: `↑ ${batch.pushes}` });
        }
        if (batch.failed > 0) {
            counts.createSpan({
                cls: "mod-failed",
                text: t("transferBatchFailed").replace("{0}", String(batch.failed)),
            });
        }
        if (batch.bytes > 0) {
            head.createSpan({ cls: "vault-sync-xfer-size", text: formatBytes(batch.bytes) });
        }
        head.addEventListener("click", () => {
            const next = !box.hasClass("is-open");
            this.batchOpen.set(batch.key, next);
            box.toggleClass("is-open", next);
            head.setAttribute("aria-expanded", String(next));
            if (next && !box.querySelector(".vault-sync-xfer-list")) this.renderBatchRows(box, batch);
        });
        if (open) this.renderBatchRows(box, batch);
    }

    private renderBatchRows(box: HTMLElement, batch: HistoryBatch): void {
        const t = this.t;
        const list = box.createDiv({ cls: "vault-sync-xfer-list" });
        for (const r of batch.records) {
            const row = list.createDiv({ cls: `vault-sync-xfer-row mod-${r.direction} is-${r.status}` });
            this.dirIcon(row, r.direction);
            const file = this.fileCell(row, r.path);
            if (r.error) file.createDiv({ cls: "vault-sync-xfer-error", text: r.error });
            const meta = row.createDiv({ cls: "vault-sync-xfer-meta" });
            meta.createSpan({ cls: "vault-sync-xfer-size", text: formatBytes(r.size) });
            if (r.status !== "completed") {
                meta.createSpan({
                    cls: `vault-sync-xfer-badge is-${r.status}`,
                    text: r.status === "failed" ? t("transferFailed") : t("transferCancelled"),
                });
            }
            meta.createSpan({
                cls: "vault-sync-xfer-time",
                text: moment(r.completedAt).format("LTS"),
            });
        }
    }

    // --- cells ---

    private dirIcon(row: HTMLElement, direction: "push" | "pull"): void {
        const icon = row.createDiv({
            cls: "vault-sync-xfer-icon",
            attr: {
                "aria-label": direction === "push" ? this.t("transferPush") : this.t("transferPull"),
            },
        });
        setIcon(icon, direction === "push" ? "arrow-up" : "arrow-down");
    }

    private fileCell(row: HTMLElement, path: string): HTMLElement {
        const cell = row.createDiv({ cls: "vault-sync-xfer-file", attr: { title: path } });
        const line = cell.createDiv({ cls: "vault-sync-xfer-file-line" });
        line.createSpan({ cls: "vault-sync-xfer-name", text: basename(path) });
        const dir = dirname(path);
        if (dir) line.createSpan({ cls: "vault-sync-xfer-dir", text: dir });
        return cell;
    }
}
