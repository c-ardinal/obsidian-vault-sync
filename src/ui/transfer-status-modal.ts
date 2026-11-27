/**
 * Transfer status screen.
 *
 * 1. Sync summary: the current (or last) sync cycle from SyncProgressTracker.
 * 2. Queue: files transferring now and waiting (inline and background).
 * 3. History: filterable, grouped by day and into batches (usually one sync cycle).
 *
 * Kept close to Obsidian's own lists: plain rows, one-colour icons, colour only
 * for failures, no cards or badges.
 */
import { App, DropdownComponent, Modal, setIcon } from "obsidian";
import { formatMoment } from "./format-time";
import { SyncManager } from "../sync-manager";
import type { TransferItem, TransferRecord } from "../sync-manager/transfer-types";
import type { SyncProgressSnapshot } from "../sync-manager/sync-progress";
import { TRANSFER_MAX_RETRIES } from "../sync-manager/constants";
import { basename, dirname } from "../utils/path";
import { formatBytes, formatClock, renderSyncPanel } from "./sync-status-view";
import { quietCycleFilter } from "./progress-math";
import {
    groupHistory,
    type HistoryBatch,
    type HistoryFilter,
} from "./transfer-history-groups";

/** Queue rows shown before "N more" */
const QUEUE_VISIBLE = 8;
/** Lists are refreshed this often (only when their data changed) */
const REFRESH_MS = 1000;


/** Buttons on the transfer screen's status panel */
export interface TransferModalActions {
    onSyncNow: () => void;
    onOpenSettings: () => void;
    onReport?: (title: string) => void;
    onResolveConflicts?: () => void;
}

export class TransferStatusModal extends Modal {
    private refreshTimer: number | null = null;
    private unsubscribe: (() => void) | null = null;
    private summaryEl: HTMLElement | null = null;
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
        private actions?: TransferModalActions,
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
        this.summaryEl = root.createDiv({ cls: "vault-sync-status-panel vault-sync-xfer-summary" });
        this.queueEl = root.createDiv({ cls: "vault-sync-xfer-section mod-queue" });
        this.historyEl = root.createDiv({ cls: "vault-sync-xfer-section mod-history" });

        const progress = this.syncManager.progress;
        if (progress) {
            const shown = quietCycleFilter();
            this.unsubscribe = progress.subscribe((s) => this.renderSummary(shown(s)));
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

    /** Top: the same sync status panel as the status bar popover. */
    private renderSummary(s: SyncProgressSnapshot): void {
        const el = this.summaryEl;
        if (!el) return;
        const actions = this.actions;
        renderSyncPanel(el, s, {
            syncManager: this.syncManager,
            signedIn: this.isSignedIn(),
            onSyncNow: actions ? () => actions.onSyncNow() : undefined,
            onOpenSettings: actions
                ? () => {
                      this.close();
                      actions.onOpenSettings();
                  }
                : undefined,
            onReport: actions?.onReport
                ? (title) => {
                      this.close();
                      actions.onReport?.(title);
                  }
                : undefined,
            onResolveConflicts: actions?.onResolveConflicts
                ? () => {
                      this.close();
                      actions.onResolveConflicts?.();
                  }
                : undefined,
        });
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
            this.renderHistory(history);
        }
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
            title.createSpan({ cls: "vault-sync-xfer-muted", text: ` ${active.length}` });
        }
        // Only background transfers can be cancelled (inline ones belong to the running sync).
        if (active.some((i) => !i.id.startsWith("inline-"))) {
            const cancel = header.createEl("button", { text: t("transferCancelAll") });
            cancel.addEventListener("click", () => {
                this.syncManager.cancelAllTransfers();
                this.refreshLists(true);
            });
        }

        // A fixed-height area that scrolls by itself: the history below never moves.
        const body = el.createDiv({ cls: "vault-sync-xfer-queue-body" });
        if (active.length === 0) {
            body.createDiv({ cls: "vault-sync-xfer-empty", text: t("transferNoActive") });
            return;
        }
        const deferred = this.syncManager.getTransferDeferReason?.();
        if (deferred) {
            body.createDiv({
                cls: "vault-sync-xfer-muted vault-sync-xfer-deferred",
                text: t(deferred === "cellular" ? "transferDeferredCellular" : "transferDeferredLowBattery"),
            });
        }
        // Transferring first, then waiting in queue order.
        const sorted = [...active].sort(
            (a, b) => Number(b.status === "active") - Number(a.status === "active"),
        );
        const list = body.createDiv({ cls: "vault-sync-xfer-list" });
        for (const item of sorted.slice(0, QUEUE_VISIBLE)) this.renderQueueRow(list, item);
        if (sorted.length > QUEUE_VISIBLE) {
            body.createDiv({
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
    }

    private renderHistory(history: TransferRecord[]): void {
        const el = this.historyEl;
        if (!el) return;
        const t = this.t;
        const savedTop = el.querySelector(".vault-sync-xfer-history-body")?.scrollTop ?? 0;
        el.empty();

        const header = el.createDiv({ cls: "vault-sync-xfer-section-head" });
        header.createDiv({ cls: "vault-sync-xfer-section-title", text: t("transferHistorySection") });

        // Filter (Obsidian's own dropdown)
        const failedCount = history.filter((r) => r.status === "failed").length;
        const filter = new DropdownComponent(header)
            .addOption("all", `${t("transferFilterAll")} (${history.length})`)
            .addOption("pull", t("transferFilterPull"))
            .addOption("push", t("transferFilterPush"))
            .addOption("failed", `${t("transferFilterFailed")} (${failedCount})`)
            .setValue(this.filter)
            .onChange((v) => {
                this.filter = v as HistoryFilter;
                this.historySig = "";
                this.refreshLists(false);
            });
        filter.selectEl.addClass("vault-sync-xfer-filter");
        filter.selectEl.setAttribute("aria-label", t("transferHistorySection"));

        // The only part of the screen that scrolls
        const body = el.createDiv({ cls: "vault-sync-xfer-history-body" });
        const days = groupHistory(history, this.filter, Date.now());
        if (days.length === 0) {
            body.createDiv({
                cls: "vault-sync-xfer-empty",
                text: history.length === 0 ? t("transferNoHistory") : t("transferNoMatch"),
            });
            return;
        }
        let first = true;
        for (const day of days) {
            const dayEl = body.createDiv({ cls: "vault-sync-xfer-day" });
            dayEl.createDiv({
                cls: "vault-sync-xfer-day-label",
                text:
                    day.kind === "today"
                        ? t("transferToday")
                        : day.kind === "yesterday"
                          ? t("transferYesterday")
                          : formatMoment(day.dayStart, "LL"),
            });
            for (const batch of day.batches) {
                this.renderBatch(dayEl, batch, first);
                first = false;
            }
        }
        if (savedTop) body.scrollTop = savedTop;
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
        const parts: string[] = [];
        if (batch.pulls > 0) parts.push(`${t("transferFilterPull")} ${batch.pulls}`);
        if (batch.pushes > 0) parts.push(`${t("transferFilterPush")} ${batch.pushes}`);
        counts.createSpan({ text: parts.join(" · ") });
        if (batch.failed > 0) {
            counts.createSpan({
                cls: "mod-failed",
                text: ` · ${t("transferBatchFailed").replace("{0}", String(batch.failed))}`,
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
                    cls: `vault-sync-xfer-result is-${r.status}`,
                    text: r.status === "failed" ? t("transferFailed") : t("transferCancelled"),
                });
            }
            meta.createSpan({
                cls: "vault-sync-xfer-time",
                text: formatMoment(r.completedAt, "LTS"),
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
