/**
 * Sync progress model for the status display (status bar, panel, mobile sheet).
 *
 * The sync code reports what it is about to transfer (plan) and each file as it
 * starts and finishes; this class turns that into a snapshot with counts, bytes,
 * throughput and an estimated time left. It has no Obsidian dependency so it can
 * be unit-tested with an injected clock.
 */

/** "finishing": the work after the last upload (confirming the result, housekeeping) */
export type SyncPhase = "idle" | "checking" | "scanning" | "pulling" | "pushing" | "finishing";
export type SyncOutcome = "ok" | "error" | "offline" | "auth";
export type TransferDirection = "pull" | "push";

export interface DirectionProgress {
    /** Files planned for transfer in this cycle */
    total: number;
    /** Files finished (successfully or not) */
    done: number;
    bytesTotal: number;
    bytesDone: number;
}

export interface SyncCycleResult {
    outcome: SyncOutcome;
    finishedAt: number;
    durationMs: number;
    pulled: number;
    pushed: number;
    conflicts: number;
    /** Short reason for a failed cycle (already localized by the caller) */
    message?: string;
}

export interface SyncProgressSnapshot {
    active: boolean;
    phase: SyncPhase;
    trigger: string | null;
    startedAt: number | null;
    pull: DirectionProgress;
    push: DirectionProgress;
    /** Full scan: files checked / files to check (0/0 when not scanning) */
    scan: { done: number; total: number };
    conflicts: number;
    /** Files transferring right now (most recent first) */
    current: Array<{ path: string; direction: TransferDirection; size: number }>;
    /**
     * The file whose transfer started last in this cycle. Kept after it finished:
     * a small file is through before the display is drawn again, and the one-line
     * display names it all the same. Null before the cycle's first transfer.
     */
    recent: { path: string; direction: TransferDirection } | null;
    /** Bytes per second over the last few seconds; null until measurable */
    bytesPerSec: number | null;
    /** Estimated seconds left; null when unknown or not worth showing */
    etaSec: number | null;
    /** 0..1 over files and bytes of the cycle (1 after a successful one); null before anything is planned */
    fraction: number | null;
    last: SyncCycleResult | null;
}

type Listener = (snapshot: SyncProgressSnapshot) => void;

const PHASE_ORDER: Record<SyncPhase, number> = {
    idle: 0,
    checking: 1,
    scanning: 2,
    pulling: 3,
    pushing: 4,
    finishing: 5,
};

/** Throughput is measured over this window */
const RATE_WINDOW_MS = 8000;
/** No estimate before the cycle has run this long (early rates are noise) */
const ETA_MIN_ELAPSED_MS = 3000;
/** Listener notifications are coalesced to at most one per interval */
const EMIT_INTERVAL_MS = 250;

const emptyDirection = (): DirectionProgress => ({
    total: 0,
    done: 0,
    bytesTotal: 0,
    bytesDone: 0,
});

export class SyncProgressTracker {
    private listeners = new Set<Listener>();
    private active = false;
    private phase: SyncPhase = "idle";
    private trigger: string | null = null;
    private startedAt: number | null = null;
    private pull = emptyDirection();
    private push = emptyDirection();
    private scan = { done: 0, total: 0 };
    private conflicts = 0;
    /** path -> planned size, per direction (a path is counted once per cycle) */
    private planned: Record<TransferDirection, Map<string, number>> = {
        pull: new Map(),
        push: new Map(),
    };
    private running = new Map<string, { path: string; direction: TransferDirection; size: number }>();
    private finished: Record<TransferDirection, Set<string>> = { pull: new Set(), push: new Set() };
    private recent: { path: string; direction: TransferDirection } | null = null;
    /** (time, cumulative bytes done) samples for the throughput window */
    private samples: Array<{ t: number; bytes: number }> = [];
    private last: SyncCycleResult | null = null;
    private emitTimer: number | null = null;

    constructor(private now: () => number = () => Date.now()) {}

    subscribe(listener: Listener): () => void {
        this.listeners.add(listener);
        try {
            listener(this.snapshot());
        } catch {
            /* a broken view must not break sync */
        }
        return () => this.listeners.delete(listener);
    }

    get isActive(): boolean {
        return this.active;
    }

    /** A sync cycle starts. A begin while another cycle runs keeps that cycle. */
    begin(trigger: string, phase: SyncPhase = "checking"): void {
        // A smart sync that interrupts a background full scan takes over the display.
        if (this.active && this.trigger !== "full-scan") return;
        this.active = true;
        this.trigger = trigger;
        this.startedAt = this.now();
        this.phase = phase;
        this.pull = emptyDirection();
        this.push = emptyDirection();
        this.scan = { done: 0, total: 0 };
        this.conflicts = 0;
        this.planned = { pull: new Map(), push: new Map() };
        this.finished = { pull: new Set(), push: new Set() };
        this.running.clear();
        this.recent = null;
        this.samples = [{ t: this.startedAt, bytes: 0 }];
        this.emit(true);
    }

    /** Phases only move forward within a cycle (the confirmation pull after an upload stays "finishing"). */
    setPhase(phase: SyncPhase): void {
        if (!this.active) return;
        if (PHASE_ORDER[phase] <= PHASE_ORDER[this.phase]) return;
        this.phase = phase;
        this.emit();
    }

    /** Files the cycle is about to transfer. Additive: the Changes API plans page by page. */
    plan(direction: TransferDirection, items: Array<{ path: string; size?: number }>): void {
        if (!this.active || items.length === 0) return;
        const map = this.planned[direction];
        const d = this[direction];
        for (const item of items) {
            if (map.has(item.path)) continue;
            const size = Math.max(0, item.size ?? 0);
            map.set(item.path, size);
            d.total++;
            d.bytesTotal += size;
        }
        this.setPhase(direction === "pull" ? "pulling" : "pushing");
        this.emit();
    }

    fileStarted(direction: TransferDirection, path: string, size = 0): void {
        if (!this.active) return;
        // Unplanned transfers (e.g. a conflict re-pull) still count.
        if (!this.planned[direction].has(path)) this.plan(direction, [{ path, size }]);
        const planned = this.planned[direction].get(path) ?? 0;
        this.running.set(`${direction}:${path}`, { path, direction, size: Math.max(planned, size) });
        this.recent = { path, direction };
        this.setPhase(direction === "pull" ? "pulling" : "pushing");
        this.emit();
    }

    fileFinished(direction: TransferDirection, path: string): void {
        if (!this.active) return;
        const key = `${direction}:${path}`;
        this.running.delete(key);
        if (this.finished[direction].has(path)) return;
        this.finished[direction].add(path);
        const d = this[direction];
        d.done = Math.min(d.total, d.done + 1);
        d.bytesDone = Math.min(d.bytesTotal, d.bytesDone + (this.planned[direction].get(path) ?? 0));
        this.samples.push({ t: this.now(), bytes: this.pull.bytesDone + this.push.bytesDone });
        this.trimSamples();
        this.emit();
    }

    scanProgress(done: number, total: number): void {
        if (!this.active) return;
        this.scan = { done: Math.min(done, total), total };
        this.setPhase("scanning");
        this.emit();
    }

    noteConflict(): void {
        if (!this.active) return;
        this.conflicts++;
        this.emit();
    }

    /** The cycle ended. `message` is shown for failures. */
    finish(outcome: SyncOutcome, message?: string): void {
        if (!this.active) return;
        const t = this.now();
        this.last = {
            outcome,
            finishedAt: t,
            durationMs: t - (this.startedAt ?? t),
            pulled: this.pull.done,
            pushed: this.push.done,
            conflicts: this.conflicts,
            message,
        };
        this.active = false;
        this.phase = "idle";
        this.running.clear();
        this.emit(true);
    }

    snapshot(): SyncProgressSnapshot {
        return {
            active: this.active,
            phase: this.phase,
            trigger: this.trigger,
            startedAt: this.startedAt,
            pull: { ...this.pull },
            push: { ...this.push },
            scan: { ...this.scan },
            conflicts: this.conflicts,
            current: [...this.running.values()].reverse(),
            recent: this.recent,
            bytesPerSec: this.active ? this.rate() : null,
            etaSec: this.active ? this.eta() : null,
            fraction: this.fraction(),
            last: this.last,
        };
    }

    dispose(): void {
        if (this.emitTimer !== null) window.clearTimeout(this.emitTimer);
        this.emitTimer = null;
        this.listeners.clear();
    }

    // --- internals ---

    private fraction(): number | null {
        if (!this.active) {
            // A successful cycle is complete; a failed one shows how far it got.
            if (!this.last) return null;
            if (this.last.outcome === "ok") return 1;
        }
        if (this.phase === "scanning" && this.scan.total > 0 && this.pull.total + this.push.total === 0) {
            return this.scan.done / this.scan.total;
        }
        const files = this.pull.total + this.push.total;
        if (files === 0) return this.active ? null : 0;
        const filesDone = this.pull.done + this.push.done;
        const bytes = this.pull.bytesTotal + this.push.bytesTotal;
        // Mix files and bytes: many small notes and one big attachment both move the bar.
        const byFiles = filesDone / files;
        if (bytes === 0) return byFiles;
        const byBytes = (this.pull.bytesDone + this.push.bytesDone) / bytes;
        return (byFiles + byBytes) / 2;
    }

    private trimSamples(): void {
        const cutoff = this.now() - RATE_WINDOW_MS;
        // Keep one sample at or before the window start as the baseline.
        while (this.samples.length > 2 && this.samples[1].t <= cutoff) this.samples.shift();
    }

    private rate(): number | null {
        this.trimSamples();
        if (this.samples.length < 2) return null;
        const first = this.samples[0];
        const t = this.now();
        const bytes = this.pull.bytesDone + this.push.bytesDone;
        const dt = (t - first.t) / 1000;
        if (dt <= 0.5) return null;
        return Math.max(0, (bytes - first.bytes) / dt);
    }

    private eta(): number | null {
        if (this.startedAt === null || this.now() - this.startedAt < ETA_MIN_ELAPSED_MS) return null;
        const filesLeft = this.pull.total - this.pull.done + (this.push.total - this.push.done);
        if (filesLeft <= 0) return null;
        const bytesLeft =
            this.pull.bytesTotal - this.pull.bytesDone + (this.push.bytesTotal - this.push.bytesDone);
        const rate = this.rate();
        if (bytesLeft > 0 && rate && rate > 0) return Math.ceil(bytesLeft / rate);
        // No byte sizes known: fall back to files per second over the whole cycle.
        const filesDone = this.pull.done + this.push.done;
        if (filesDone === 0) return null;
        const perFile = (this.now() - this.startedAt) / 1000 / filesDone;
        return Math.ceil(filesLeft * perFile);
    }

    private emit(immediate = false): void {
        if (immediate) {
            if (this.emitTimer !== null) window.clearTimeout(this.emitTimer);
            this.emitTimer = null;
            this.flush();
            return;
        }
        if (this.emitTimer !== null) return;
        this.emitTimer = window.setTimeout(() => {
            this.emitTimer = null;
            this.flush();
        }, EMIT_INTERVAL_MS);
    }

    private flush(): void {
        if (this.listeners.size === 0) return;
        const snap = this.snapshot();
        for (const l of this.listeners) {
            try {
                l(snap);
            } catch {
                /* a broken view must not break sync */
            }
        }
    }
}
