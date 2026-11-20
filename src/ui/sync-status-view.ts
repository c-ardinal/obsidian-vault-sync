/**
 * Sync status display.
 *
 * Desktop: a status bar item (state, count, time left) that opens a detail panel.
 * Mobile: a thin progress line under the header and a small pill with the count;
 * tapping the pill opens the same details in a bottom sheet.
 *
 * Everything is driven by SyncProgressTracker snapshots.
 */
import { Platform, moment } from "obsidian";
import type VaultSync from "../main";
import { t } from "../i18n";
import type { SyncProgressSnapshot } from "../sync-manager/sync-progress";
import { TransferStatusModal } from "./transfer-status-modal";

type DisplayState = "syncing" | "scanning" | "synced" | "error" | "offline" | "auth" | "never";

/** Triggers the user started or waits on: their syncs always show on mobile. */
const LOUD_TRIGGERS = new Set(["manual-sync", "initial-sync", "startup-sync", "full-scan"]);
/** Mobile: how long a finished result stays on screen */
const MOBILE_RESULT_MS = 4000;
const MOBILE_ERROR_MS = 8000;
/** Mobile: quiet syncs with nothing to transfer never show; others after this delay */
const MOBILE_SHOW_DELAY_MS = 400;

export function displayState(s: SyncProgressSnapshot, signedIn: boolean): DisplayState {
    if (s.active) return s.phase === "scanning" && s.pull.total + s.push.total === 0 ? "scanning" : "syncing";
    if (!signedIn) return "auth";
    if (!s.last) return "never";
    if (s.last.outcome === "ok") return "synced";
    return s.last.outcome;
}

function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatDuration(sec: number): string {
    if (sec < 60) return t("statusSeconds").replace("{0}", String(Math.max(1, Math.round(sec))));
    return t("statusMinutes").replace("{0}", String(Math.round(sec / 60)));
}

function formatClock(ms: number): string {
    // Obsidian sets moment's locale to the app language.
    return moment(ms).format("LT");
}

function formatAgo(ms: number): string {
    const min = Math.floor((Date.now() - ms) / 60000);
    if (min < 1) return t("statusJustNow");
    if (min < 60) return t("statusMinutesAgo").replace("{0}", String(min));
    return formatClock(ms);
}

function triggerLabel(trigger: string | null): string {
    const key = `statusTrigger_${trigger ?? ""}`;
    const label = t(key);
    return label === key ? t("statusTrigger_default") : label;
}

function percent(s: SyncProgressSnapshot): number {
    return Math.round((s.fraction ?? 0) * 100);
}

/** Short one-line text: status bar on desktop, pill on mobile. */
export function shortText(s: SyncProgressSnapshot, state: DisplayState, withEta: boolean): string {
    switch (state) {
        case "syncing": {
            const total = s.pull.total + s.push.total;
            if (total === 0) return t("statusSyncing");
            let text = `${t("statusSyncing")} ${s.pull.done + s.push.done}/${total}`;
            if (withEta && s.etaSec !== null) text += ` · ${t("statusAbout")}${formatDuration(s.etaSec)}`;
            return text;
        }
        case "scanning":
            return `${t("statusScanning")} ${percent(s)}%`;
        case "synced":
            return `${t("statusSynced")} · ${formatAgo(s.last!.finishedAt)}`;
        case "error":
            return t("statusFailed");
        case "offline":
            return t("statusOffline");
        case "auth":
            return t("statusAuth");
        case "never":
            return t("statusNever");
    }
}

export class SyncStatusView {
    private statusBarEl: HTMLElement | null = null;
    private statusRingEl: HTMLElement | null = null;
    private statusTextEl: HTMLElement | null = null;
    private popoverEl: HTMLElement | null = null;
    private sheetEl: HTMLElement | null = null;
    private mobileLineEl: HTMLElement | null = null;
    private mobilePillEl: HTMLElement | null = null;
    private unsubscribe: (() => void) | null = null;
    private clockTimer: number | null = null;
    private mobileHideTimer: number | null = null;
    private mobileShowTimer: number | null = null;
    private snap: SyncProgressSnapshot | null = null;
    private readonly onDocPointerDown = (e: PointerEvent) => {
        const target = e.target as Node | null;
        if (!target) return;
        if (this.popoverEl?.contains(target) || this.statusBarEl?.contains(target)) return;
        this.closeDetails();
    };
    private readonly onDocKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape") this.closeDetails();
    };

    constructor(private plugin: VaultSync) {}

    get mounted(): boolean {
        return this.unsubscribe !== null;
    }

    mount(): void {
        if (this.mounted) return;
        if (Platform.isMobile) this.mountMobile();
        else this.mountDesktop();
        this.unsubscribe = this.plugin.syncManager.progress.subscribe((s) => this.update(s));
        // Keep "3 min ago" current.
        this.clockTimer = window.setInterval(() => {
            if (this.snap) this.update(this.snap);
        }, 30_000);
    }

    unmount(): void {
        this.unsubscribe?.();
        this.unsubscribe = null;
        if (this.clockTimer !== null) window.clearInterval(this.clockTimer);
        this.clockTimer = null;
        this.clearMobileTimers();
        this.closeDetails();
        this.statusBarEl?.remove();
        this.mobileLineEl?.remove();
        this.mobilePillEl?.remove();
        this.statusBarEl = this.statusRingEl = this.statusTextEl = null;
        this.mobileLineEl = this.mobilePillEl = null;
    }

    /** Open the details (command palette / tests). */
    openDetails(): void {
        if (!this.mounted) return;
        if (Platform.isMobile) this.openSheet();
        else this.openPopover();
    }

    closeDetails(): void {
        if (this.popoverEl) {
            this.popoverEl.remove();
            this.popoverEl = null;
            activeDocument.removeEventListener("pointerdown", this.onDocPointerDown, true);
            this.statusBarEl?.setAttribute("aria-expanded", "false");
        }
        if (this.sheetEl) {
            this.sheetEl.remove();
            this.sheetEl = null;
        }
        activeDocument.removeEventListener("keydown", this.onDocKeyDown, true);
    }

    // --- desktop ---

    private mountDesktop(): void {
        const el = this.plugin.addStatusBarItem();
        el.addClass("vault-sync-status-item", "mod-clickable");
        el.setAttribute("role", "button");
        el.setAttribute("tabindex", "0");
        el.setAttribute("aria-label", t("statusOpenDetails"));
        el.setAttribute("aria-expanded", "false");
        this.statusRingEl = el.createSpan({ cls: "vault-sync-status-ring" });
        this.statusTextEl = el.createSpan({ cls: "vault-sync-status-text" });
        el.addEventListener("click", () => (this.popoverEl ? this.closeDetails() : this.openPopover()));
        el.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                if (this.popoverEl) this.closeDetails();
                else this.openPopover();
            }
        });
        this.statusBarEl = el;
    }

    private openPopover(): void {
        if (this.popoverEl) return;
        this.popoverEl = activeDocument.body.createDiv({
            cls: "vault-sync-status-panel vault-sync-status-popover",
            attr: { role: "dialog", "aria-label": t("statusPanelTitle") },
        });
        this.statusBarEl?.setAttribute("aria-expanded", "true");
        activeDocument.addEventListener("pointerdown", this.onDocPointerDown, true);
        activeDocument.addEventListener("keydown", this.onDocKeyDown, true);
        if (this.snap) this.renderPanel(this.popoverEl, this.snap);
    }

    // --- mobile ---

    private mountMobile(): void {
        const body = activeDocument.body;
        this.mobileLineEl = body.createDiv({ cls: "vault-sync-status-line" });
        this.mobileLineEl.createDiv({ cls: "vault-sync-status-line-fill" });
        this.mobilePillEl = body.createDiv({
            cls: "vault-sync-status-pill",
            attr: { role: "button", tabindex: "0", "aria-label": t("statusOpenDetails") },
        });
        this.mobilePillEl.createSpan({ cls: "vault-sync-status-ring" });
        this.mobilePillEl.createSpan({ cls: "vault-sync-status-text" });
        this.mobilePillEl.addEventListener("click", () => this.openSheet());
    }

    private openSheet(): void {
        if (this.sheetEl) return;
        const root = activeDocument.body.createDiv({ cls: "vault-sync-status-sheet-root" });
        const backdrop = root.createDiv({ cls: "vault-sync-status-sheet-backdrop" });
        backdrop.addEventListener("click", () => this.closeDetails());
        const sheet = root.createDiv({
            cls: "vault-sync-status-panel vault-sync-status-sheet",
            attr: { role: "dialog", "aria-label": t("statusPanelTitle") },
        });
        sheet.createDiv({ cls: "vault-sync-status-sheet-grab" });
        sheet.createDiv({ cls: "vault-sync-status-sheet-body" });
        this.sheetEl = root;
        activeDocument.addEventListener("keydown", this.onDocKeyDown, true);
        if (this.snap) this.renderPanel(sheet.querySelector(".vault-sync-status-sheet-body")!, this.snap);
    }

    private clearMobileTimers(): void {
        if (this.mobileHideTimer !== null) window.clearTimeout(this.mobileHideTimer);
        if (this.mobileShowTimer !== null) window.clearTimeout(this.mobileShowTimer);
        this.mobileHideTimer = this.mobileShowTimer = null;
    }

    private setMobileVisible(visible: boolean): void {
        this.mobilePillEl?.toggleClass("is-visible", visible);
        this.mobileLineEl?.toggleClass("is-visible", visible && !!this.snap?.active);
    }

    private updateMobile(s: SyncProgressSnapshot, state: DisplayState, prev: SyncProgressSnapshot | null): void {
        const pill = this.mobilePillEl;
        const line = this.mobileLineEl;
        if (!pill || !line) return;
        pill.dataset.state = state;
        pill.querySelector<HTMLElement>(".vault-sync-status-text")!.setText(shortText(s, state, false));
        pill.querySelector<HTMLElement>(".vault-sync-status-ring")!.style.setProperty("--vs-p", String(percent(s)));
        line.querySelector<HTMLElement>(".vault-sync-status-line-fill")!.style.width = `${percent(s)}%`;

        const hasWork = s.pull.total + s.push.total > 0 || s.scan.total > 0;
        if (s.active) {
            if (this.mobileHideTimer !== null) {
                window.clearTimeout(this.mobileHideTimer);
                this.mobileHideTimer = null;
            }
            const loud = LOUD_TRIGGERS.has(s.trigger ?? "");
            if (pill.hasClass("is-visible")) {
                this.setMobileVisible(true);
            } else if ((loud || hasWork) && this.mobileShowTimer === null) {
                this.mobileShowTimer = window.setTimeout(() => {
                    this.mobileShowTimer = null;
                    if (this.snap?.active) this.setMobileVisible(true);
                }, MOBILE_SHOW_DELAY_MS);
            }
            return;
        }
        // Just finished: show the result briefly if the sync was visible or failed.
        if (prev?.active) {
            if (this.mobileShowTimer !== null) {
                window.clearTimeout(this.mobileShowTimer);
                this.mobileShowTimer = null;
            }
            const failed = state === "error" || state === "offline" || state === "auth";
            const wasVisible = pill.hasClass("is-visible");
            if (wasVisible || failed) {
                this.setMobileVisible(true);
                line.removeClass("is-visible");
                this.mobileHideTimer = window.setTimeout(
                    () => {
                        this.mobileHideTimer = null;
                        if (!this.snap?.active) this.setMobileVisible(false);
                    },
                    failed ? MOBILE_ERROR_MS : MOBILE_RESULT_MS,
                );
            }
        }
    }

    // --- shared ---

    private update(s: SyncProgressSnapshot): void {
        const prev = this.snap;
        this.snap = s;
        const state = displayState(s, this.plugin.isAdapterAuthenticated());
        if (this.statusBarEl && this.statusTextEl && this.statusRingEl) {
            this.statusBarEl.dataset.state = state;
            this.statusTextEl.setText(shortText(s, state, true));
            this.statusRingEl.style.setProperty("--vs-p", String(state === "synced" ? 100 : percent(s)));
        }
        this.updateMobile(s, state, prev);
        if (this.popoverEl) this.renderPanel(this.popoverEl, s);
        const sheetBody = this.sheetEl?.querySelector<HTMLElement>(".vault-sync-status-sheet-body");
        if (sheetBody) this.renderPanel(sheetBody, s);
    }

    private renderPanel(el: HTMLElement, s: SyncProgressSnapshot): void {
        const state = displayState(s, this.plugin.isAdapterAuthenticated());
        const sm = this.plugin.syncManager;
        el.empty();
        el.dataset.state = state;

        // Title row: state + what started it / when it ended
        const head = el.createDiv({ cls: "vault-sync-status-head" });
        head.createSpan({ cls: "vault-sync-status-title", text: this.titleFor(state) });
        let sub = "";
        if (s.active && s.startedAt) {
            sub = `${triggerLabel(s.trigger)} · ${t("statusStartedAt").replace("{0}", formatClock(s.startedAt))}`;
        } else if (s.last) {
            sub = t("statusLastSync")
                .replace("{0}", formatClock(s.last.finishedAt))
                .replace("{1}", formatDuration(s.last.durationMs / 1000));
        }
        if (sub) head.createSpan({ cls: "vault-sync-status-sub", text: sub });

        // Steps: check -> (scan) -> download -> upload -> done
        const steps = el.createDiv({ cls: "vault-sync-status-steps" });
        const order: Array<{ id: string; label: string }> = [
            { id: "checking", label: t("statusStepCheck") },
            ...(s.phase === "scanning" || s.scan.total > 0 ? [{ id: "scanning", label: t("statusStepScan") }] : []),
            { id: "pulling", label: t("statusStepPull") },
            { id: "pushing", label: t("statusStepPush") },
            { id: "done", label: t("statusStepDone") },
        ];
        const currentIdx = s.active
            ? order.findIndex((o) => o.id === s.phase)
            : state === "synced"
              ? order.length
              : -1;
        order.forEach((o, i) => {
            const step = steps.createDiv({ cls: "vault-sync-status-step" });
            if (currentIdx >= 0 && i < currentIdx) step.addClass("is-done");
            if (i === currentIdx) step.addClass("is-current");
            step.createDiv({ cls: "vault-sync-status-step-bar" });
            step.createSpan({ text: o.label });
        });
        steps.style.setProperty("--vs-steps", String(order.length));

        // Overall bar
        const total = s.pull.total + s.push.total;
        // Failed cycles that never got to transfer anything show no bar.
        const showOverall = s.active || total > 0 || state === "synced";
        const overall = el.createDiv({ cls: "vault-sync-status-overall" });
        const row = overall.createDiv({ cls: "vault-sync-status-overall-row" });
        if (showOverall) {
            row.createEl("b", { text: s.fraction === null && s.active ? "—" : `${percent(s)}%` });
        }
        const counts =
            s.phase === "scanning" && total === 0
                ? t("statusScanCount").replace("{0}", String(s.scan.done)).replace("{1}", String(s.scan.total))
                : total > 0
                  ? `${t("statusFiles").replace("{0}", String(s.pull.done + s.push.done)).replace("{1}", String(total))}` +
                    (s.pull.bytesTotal + s.push.bytesTotal > 0
                        ? ` · ${formatBytes(s.pull.bytesDone + s.push.bytesDone)} / ${formatBytes(s.pull.bytesTotal + s.push.bytesTotal)}`
                        : "")
                  : s.active
                    ? t("statusCheckingRemote")
                    : "";
        if (counts) row.createSpan({ cls: "vault-sync-status-muted", text: counts });
        if (showOverall) {
            const bar = overall.createDiv({ cls: "vault-sync-status-bar" });
            bar.createDiv({ cls: "vault-sync-status-bar-fill" }).style.width = `${percent(s)}%`;
        }
        if (!showOverall && !counts) overall.remove();

        // Per direction
        if (total > 0 || s.conflicts > 0 || state === "synced") {
            const kv = el.createDiv({ cls: "vault-sync-status-kv" });
            const dir = (label: string, d: { done: number; total: number }) => {
                kv.createSpan({ cls: "vault-sync-status-muted", text: label });
                const mini = kv.createDiv({ cls: "vault-sync-status-mini" });
                mini.createDiv({ cls: "vault-sync-status-bar-fill" }).style.width =
                    `${d.total > 0 ? Math.round((d.done / d.total) * 100) : 0}%`;
                kv.createSpan({ cls: "vault-sync-status-num", text: `${d.done} / ${d.total}` });
            };
            dir(t("statusPull"), s.pull);
            dir(t("statusPush"), s.push);
            const conflicts = s.active ? s.conflicts : (s.last?.conflicts ?? 0);
            if (conflicts > 0) {
                kv.createSpan({ cls: "vault-sync-status-warn", text: t("statusConflicts") });
                kv.createDiv();
                kv.createSpan({ cls: "vault-sync-status-num vault-sync-status-warn", text: String(conflicts) });
            }
        }

        // Current file
        if (s.active && s.current.length > 0) {
            const cur = s.current[0];
            const box = el.createDiv({ cls: "vault-sync-status-now" });
            box.createSpan({
                cls: "vault-sync-status-muted",
                text: cur.direction === "pull" ? t("statusDownloading") : t("statusUploading"),
            });
            box.createSpan({ cls: "vault-sync-status-file", text: cur.path });
            const meta: string[] = [];
            if (cur.size > 0) meta.push(formatBytes(cur.size));
            if (s.bytesPerSec) meta.push(`${formatBytes(s.bytesPerSec)}/s`);
            if (s.current.length > 1) meta.push(t("statusParallel").replace("{0}", String(s.current.length)));
            if (meta.length) box.createSpan({ cls: "vault-sync-status-muted", text: meta.join(" · ") });
        }

        // Failure detail
        if (!s.active && (state === "error" || state === "offline" || state === "auth")) {
            const msg =
                state === "auth"
                    ? t("statusAuthHint")
                    : state === "offline"
                      ? t("statusOfflineHint")
                      : (s.last?.message ?? t("statusFailedHint"));
            el.createDiv({ cls: "vault-sync-status-error", text: msg });
        }

        // Footer: time left / pending, actions
        const foot = el.createDiv({ cls: "vault-sync-status-foot" });
        let note = "";
        if (s.active && s.etaSec !== null) note = `${t("statusEta")} ${t("statusAbout")}${formatDuration(s.etaSec)}`;
        else if (!s.active && sm.pendingChangeCount > 0)
            note = t("statusPending").replace("{0}", String(sm.pendingChangeCount));
        const background = sm.getActiveTransfers().filter((x) => !x.id.startsWith("inline-")).length;
        if (background > 0) note += `${note ? " · " : ""}${t("statusBackground").replace("{0}", String(background))}`;
        foot.createSpan({ cls: "vault-sync-status-muted", text: note });

        const btns = foot.createDiv({ cls: "vault-sync-status-btns" });
        if (!s.active && state === "error") {
            // A failure the user cannot fix by signing in or going online: offer a report
            const report = btns.createEl("button", { text: t("statusReport") });
            report.addEventListener("click", () => {
                this.closeDetails();
                this.plugin.openDiagnostics(`Sync failed: ${(s.last?.message ?? "").slice(0, 120)}`);
            });
        }
        const details = btns.createEl("button", { text: t("statusTransferDetails") });
        details.addEventListener("click", () => {
            this.closeDetails();
            new TransferStatusModal(this.plugin.app, sm).open();
        });
        if (!s.active) {
            const action = btns.createEl("button", { cls: "mod-cta" });
            if (state === "auth") {
                action.setText(t("statusOpenSettings"));
                action.addEventListener("click", () => {
                    this.closeDetails();
                    this.plugin.openSettingsTab();
                });
            } else {
                action.setText(state === "error" || state === "offline" ? t("statusRetry") : t("statusSyncNow"));
                action.addEventListener("click", () => {
                    void this.plugin.runManualSync();
                });
            }
        }
    }

    private titleFor(state: DisplayState): string {
        switch (state) {
            case "syncing":
                return t("statusSyncing");
            case "scanning":
                return t("statusScanning");
            case "synced":
                return t("statusSynced");
            case "error":
                return t("statusFailed");
            case "offline":
                return t("statusOffline");
            case "auth":
                return t("statusAuth");
            case "never":
                return t("statusNever");
        }
    }
}
