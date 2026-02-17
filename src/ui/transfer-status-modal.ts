import { App, Modal, setIcon } from "obsidian";
import { SyncManager } from "../sync-manager";
import type { TransferItem, TransferRecord } from "../sync-manager/transfer-types";

export class TransferStatusModal extends Modal {
    private refreshTimer: number | null = null;

    constructor(
        app: App,
        private syncManager: SyncManager,
    ) {
        super(app);
    }

    onOpen() {
        const { modalEl } = this;
        modalEl.addClass("mod-transfer-status-modal");
        this.render();

        // Auto-refresh every 2 seconds while open
        this.refreshTimer = window.setInterval(() => this.render(), 2000);
    }

    onClose() {
        if (this.refreshTimer !== null) {
            window.clearInterval(this.refreshTimer);
            this.refreshTimer = null;
        }
        this.contentEl.empty();
    }

    private render() {
        const { contentEl } = this;
        contentEl.empty();

        const t = this.syncManager.t;

        // Header
        const headerRow = contentEl.createDiv({ cls: "vault-sync-header-row" });
        headerRow.createEl("h2", { text: t("transferTitle") });
        const closeBtn = headerRow.createEl("button", {
            cls: "vault-sync-close-btn",
            attr: { "aria-label": "Close" },
        });
        setIcon(closeBtn, "x");
        closeBtn.addEventListener("click", () => this.close());

        const container = contentEl.createDiv({ cls: "vault-sync-transfer-container" });

        // === Active Transfers Section ===
        const activeSection = container.createDiv({ cls: "vault-sync-transfer-section" });
        const activeHeader = activeSection.createDiv({ cls: "vault-sync-transfer-section-header" });
        activeHeader.createEl("h3", { text: t("transferActiveSection") });

        const active = this.syncManager.getActiveTransfers();

        if (active.length === 0) {
            activeSection.createDiv({
                cls: "vault-sync-transfer-empty",
                text: t("transferNoActive"),
            });
        } else {
            // Cancel All button
            const cancelBtn = activeHeader.createEl("button", {
                cls: "vault-sync-transfer-cancel-all",
                text: t("transferCancelAll"),
            });
            cancelBtn.addEventListener("click", () => {
                (this.syncManager as any).backgroundTransferQueue?.cancelAll();
                this.render();
            });

            const activeList = activeSection.createDiv({ cls: "vault-sync-transfer-list" });
            for (const item of active) {
                this.renderActiveItem(activeList, item, t);
            }
        }

        // === History Section ===
        const historySection = container.createDiv({ cls: "vault-sync-transfer-section" });
        historySection
            .createDiv({ cls: "vault-sync-transfer-section-header" })
            .createEl("h3", { text: t("transferHistorySection") });

        const history = this.syncManager.getTransferHistory(100);

        if (history.length === 0) {
            historySection.createDiv({
                cls: "vault-sync-transfer-empty",
                text: t("transferNoHistory"),
            });
        } else {
            const timeline = historySection.createDiv({ cls: "vault-sync-transfer-timeline" });
            // Group by date, newest date first
            const sorted = [...history].sort((a, b) => b.completedAt - a.completedAt);
            let lastDateStr = "";
            let itemsContainer: HTMLElement | null = null;
            for (const record of sorted) {
                const dateStr = new Date(record.completedAt).toLocaleDateString();
                if (dateStr !== lastDateStr) {
                    const dateGroup = timeline.createDiv({ cls: "vault-sync-transfer-date-group" });
                    dateGroup.createDiv({
                        cls: "vault-sync-revision-date-header",
                        text: dateStr,
                    });
                    itemsContainer = dateGroup.createDiv({
                        cls: "vault-sync-transfer-timeline-items",
                    });
                    lastDateStr = dateStr;
                }
                this.renderHistoryItem(itemsContainer!, record, t);
            }
        }
    }

    private renderActiveItem(
        container: HTMLElement,
        item: TransferItem,
        t: (key: string) => string,
    ) {
        const row = container.createDiv({
            cls: "vault-sync-transfer-row vault-sync-transfer-active",
        });

        // Direction icon (vertically centered)
        const dirCls = item.direction === "push" ? "vault-sync-transfer-icon-push" : "vault-sync-transfer-icon-pull";
        const iconEl = row.createDiv({ cls: `vault-sync-transfer-icon ${dirCls}` });
        setIcon(iconEl, item.direction === "push" ? "upload" : "download");

        // Content (same 2-row structure as history items)
        const content = row.createDiv({ cls: "vault-sync-transfer-card-content" });
        const row1 = content.createDiv({ cls: "vault-sync-transfer-row1" });
        row1.createSpan({
            cls: "vault-sync-transfer-direction",
            text: item.direction === "push" ? t("transferPush") : t("transferPull"),
        });
        row1.createSpan({
            cls: "vault-sync-transfer-size",
            text: this.formatSize(item.size),
        });

        const row2 = content.createDiv({ cls: "vault-sync-transfer-row2" });
        const lastSlash = item.path.lastIndexOf("/");
        const fileName = lastSlash >= 0 ? item.path.slice(lastSlash + 1) : item.path;
        const dirPath = lastSlash >= 0 ? item.path.slice(0, lastSlash) : "";
        row2.createDiv({ cls: "vault-sync-transfer-filename", text: fileName });
        if (dirPath) {
            row2.createDiv({ cls: "vault-sync-transfer-dirpath", text: dirPath });
        }

        // Status (spinner for active, text for pending)
        const statusEl = row.createDiv({ cls: "vault-sync-transfer-status" });
        if (item.status === "active") {
            const spinner = statusEl.createDiv({ cls: "vault-sync-transfer-spinner" });
            spinner.createDiv({ cls: "vault-sync-spinner" });
            statusEl.createSpan({ text: t("transferActive") });
        } else {
            statusEl.createSpan({ text: t("transferPending") });
        }
    }

    private renderHistoryItem(
        container: HTMLElement,
        record: TransferRecord,
        t: (key: string) => string,
    ) {
        const statusClass =
            record.status === "completed"
                ? "vault-sync-transfer-success"
                : record.status === "failed"
                  ? "vault-sync-transfer-error"
                  : "vault-sync-transfer-cancelled";

        const item = container.createDiv({
            cls: `vault-sync-transfer-timeline-item ${statusClass}`,
        });

        // Timeline dot
        item.createDiv({ cls: "vault-sync-transfer-timeline-dot" });

        // Card: [icon] [content rows] [status]  — all vertically centered
        const card = item.createDiv({ cls: "vault-sync-transfer-timeline-card" });

        // Icon (vertically centered across both rows)
        const dirCls = record.direction === "push" ? "vault-sync-transfer-icon-push" : "vault-sync-transfer-icon-pull";
        const iconEl = card.createDiv({ cls: `vault-sync-transfer-icon ${dirCls}` });
        setIcon(iconEl, record.direction === "push" ? "upload" : "download");

        // Content rows
        const content = card.createDiv({ cls: "vault-sync-transfer-card-content" });
        const row1 = content.createDiv({ cls: "vault-sync-transfer-row1" });
        row1.createSpan({
            cls: "vault-sync-transfer-time",
            text: this.formatTime(record.completedAt),
        });
        row1.createSpan({
            cls: "vault-sync-transfer-size",
            text: this.formatSize(record.size),
        });
        const row2 = content.createDiv({ cls: "vault-sync-transfer-row2" });
        const lastSlash = record.path.lastIndexOf("/");
        const fileName = lastSlash >= 0 ? record.path.slice(lastSlash + 1) : record.path;
        const dirPath = lastSlash >= 0 ? record.path.slice(0, lastSlash) : "";
        row2.createDiv({ cls: "vault-sync-transfer-filename", text: fileName });
        if (dirPath) {
            row2.createDiv({ cls: "vault-sync-transfer-dirpath", text: dirPath });
        }

        // Error message
        if (record.error) {
            content.createDiv({
                cls: "vault-sync-transfer-error-msg",
                text: record.error,
            });
        }

        // Status badge (vertically centered)
        const statusText =
            record.status === "completed"
                ? t("transferCompleted")
                : record.status === "failed"
                  ? t("transferFailed")
                  : t("transferCancelled");
        card.createSpan({
            cls: "vault-sync-transfer-status-badge",
            text: statusText,
        });
    }

    private formatSize(bytes: number): string {
        if (bytes < 1024) return `${bytes}B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
        return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
    }

    private formatTime(timestamp: number): string {
        const d = new Date(timestamp);
        const h = String(d.getHours()).padStart(2, "0");
        const m = String(d.getMinutes()).padStart(2, "0");
        const s = String(d.getSeconds()).padStart(2, "0");
        return `${h}:${m}:${s}`;
    }
}
