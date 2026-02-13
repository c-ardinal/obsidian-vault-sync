import { SyncTrigger } from "./notification-matrix";

export type LogLevel = "system" | "error" | "warn" | "notice" | "info" | "debug";

export interface LogEntry {
    timestamp: Date;
    level: LogLevel;
    message: string;
}

export interface LoggerOptions {
    onWrite: (line: string, date: Date) => Promise<void>;
    enableLogging: boolean;
    isDeveloperMode: boolean;
}

/**
 * Handles level-based logging with buffering and conditional flushing.
 * Separates logging concerns from sync domain logic.
 */
export class SyncLogger {
    private buffer: LogEntry[] = [];
    private inCycle = false;
    private currentTrigger: SyncTrigger | null = null;
    private actionTaken = false;
    private noticeShown = false;
    private errorOccurred = false;
    private criticalLogged = false;

    constructor(private options: LoggerOptions) {}

    /** Update options (e.g. when settings change) */
    public setOptions(options: Partial<LoggerOptions>) {
        this.options = { ...this.options, ...options };
    }

    /** Start a new sync cycle (e.g. one Smart Sync or Full Scan) */
    public startCycle(trigger: SyncTrigger) {
        this.inCycle = true;
        this.currentTrigger = trigger;
        this.actionTaken = false;
        this.noticeShown = false;
        this.errorOccurred = false;
        this.criticalLogged = false;
        this.buffer = [];
    }

    /** Mark that a meaningful action (upload, download, delete, move) occurred in this cycle */
    public markActionTaken() {
        this.actionTaken = true;
    }

    /** Mark that a UI notification was shown to the user in this cycle */
    public markNoticeShown() {
        this.noticeShown = true;
    }

    /** End the current sync cycle and decide whether to flush or discard the buffer */
    public async endCycle() {
        if (!this.inCycle) return;

        // Determination logic based on Spec: [ログ出力仕様](doc/spec/logging.md)
        const isAlwaysFlush = this.isAlwaysFlushTrigger(this.currentTrigger);
        const shouldFlushAtAll =
            this.options.isDeveloperMode ||
            this.actionTaken ||
            this.noticeShown ||
            this.errorOccurred ||
            this.criticalLogged ||
            isAlwaysFlush;

        if (shouldFlushAtAll && this.buffer.length > 0) {
            // Filter buffer based on level:
            // - Manual/Startup/Initial OR Error OR Dev Mode -> Show everything (Debug included)
            // - Normal Success (Action/Notice) -> Show Info only, discard Debug
            const includeDebug = this.options.isDeveloperMode || this.errorOccurred;
            await this.flushBuffer(includeDebug);
        }

        this.inCycle = false;
        this.currentTrigger = null;
        this.buffer = [];
    }

    private isAlwaysFlushTrigger(trigger: SyncTrigger | null): boolean {
        return (
            trigger === "initial-sync" || trigger === "startup-sync" || trigger === "manual-sync"
        );
    }

    // === Logging Methods ===

    public async system(message: string) {
        await this.log("system", message);
    }

    public async error(message: string) {
        this.errorOccurred = true;
        await this.log("error", message);
    }

    public async warn(message: string) {
        this.errorOccurred = true; // Warnings also count as "something happened"
        await this.log("warn", message);
    }

    public async notice(message: string) {
        await this.log("notice", message);
    }

    public async info(message: string) {
        await this.log("info", message);
    }

    public async debug(message: string) {
        await this.log("debug", message);
    }

    /** Main logging internal implementation */
    public async log(level: LogLevel, message: string) {
        const entry: LogEntry = {
            timestamp: new Date(),
            level,
            message,
        };

        if (level === "system" || level === "error" || level === "warn" || level === "notice") {
            this.criticalLogged = true;
        }

        // 1. Console Output (Always)
        console.log(`VaultSync: [${level.toUpperCase()}] ${message}`);

        // 2. Developer Mode: Always immediate output
        if (this.options.isDeveloperMode) {
            await this.writeEntry(entry);
            return;
        }

        // 3. During Sync Cycle: Buffer all levels (System/Error/Warn/Info/Debug)
        // to ensure logs for the cycle are contiguous and follow Pattern A/B filtering.
        if (this.inCycle) {
            this.buffer.push(entry);
        } else {
            // Outside of cycle (e.g. startup grace period logs, [Trigger] logs),
            // write immediately for relevant levels. Debug is discarded outside of cycle.
            if (level !== "debug") {
                await this.writeEntry(entry);
            }
        }
    }

    private async flushBuffer(includeDebug: boolean) {
        for (const entry of this.buffer) {
            if (!includeDebug && entry.level === "debug") continue;
            await this.writeEntry(entry);
        }
        this.buffer = [];
    }

    private async writeEntry(entry: LogEntry) {
        const isCritical =
            entry.level === "system" ||
            entry.level === "error" ||
            entry.level === "warn" ||
            entry.level === "notice";
        const allowed = this.options.isDeveloperMode || this.options.enableLogging || isCritical;
        if (!allowed) return;

        // Use ja-JP locale for consistent formatting as requested
        const timestampStr = entry.timestamp.toLocaleString("ja-JP", {
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        });

        // Format: [timestamp] [LEVEL] message
        const levelTag = ` [${entry.level.toUpperCase()}]`;
        const line = `[${timestampStr}]${levelTag} ${entry.message}\n`;

        try {
            await this.options.onWrite(line, entry.timestamp);
        } catch (e) {
            console.error("VaultSync: Failed to write log entry", e);
        }
    }
}
