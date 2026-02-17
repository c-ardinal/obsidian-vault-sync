import { md5 } from "../utils/md5";
import type { CloudFile } from "../types/adapter";
import type { SyncContext } from "./context";
import { hashContent } from "./file-utils";
import { pullFileSafely } from "./merge";
import { saveIndex } from "./state";
import { compress } from "./file-utils";
import type {
    TransferItem,
    TransferRecord,
    TransferCallbacks,
} from "./transfer-types";
import { TransferPriority } from "./transfer-types";

const MAX_HISTORY = 500;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 5000;
const RETRY_MAX_DELAY_MS = 60000;
const HISTORY_FLUSH_BATCH = 10;
const LOG_RETENTION_DAYS = 7;

export class BackgroundTransferQueue {
    private queue: TransferItem[] = [];
    private history: TransferRecord[] = [];
    private isProcessing = false;
    private isPaused = false;
    private callbacks: TransferCallbacks = {};
    private ctx: SyncContext | null = null;
    private onlineHandler: (() => void) | null = null;
    private unflushedRecords: TransferRecord[] = [];
    /** Tracks inline (sync-cycle) transfers that are currently in progress */
    private inlineActive = new Map<string, TransferItem>();

    /** Bind to SyncContext after construction (needed because SyncManager creates queue before context is available) */
    setContext(ctx: SyncContext): void {
        this.ctx = ctx;
        this.registerOnlineListener();
        // Note: loadHistory is NOT called here because logFolder is not yet set to the
        // correct device-specific path. Call loadHistoryFromDisk() after loadLocalIndex().
    }

    /** Load transfer history from disk. Must be called after logFolder is set (after loadLocalIndex). */
    async loadHistoryFromDisk(): Promise<void> {
        if (!this.ctx) return;
        try {
            await this.loadHistory(this.ctx);
        } catch (e) {
            this.ctx.log(`[Background Transfer] Failed to load history: ${e}`, "error");
        }
        // Best-effort rotation of old log files
        this.rotateOldLogs(this.ctx).catch(() => {});
    }

    /** Listen for browser/Electron 'online' event to auto-resume when connectivity returns */
    private registerOnlineListener(): void {
        if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
            this.onlineHandler = () => {
                if (this.hasPendingItems() && !this.isPaused) {
                    this.startProcessing();
                }
            };
            window.addEventListener("online", this.onlineHandler);
        }
    }

    /** Clean up event listener and flush remaining history (call on plugin unload) */
    destroy(): void {
        if (this.onlineHandler && typeof window !== "undefined") {
            window.removeEventListener("online", this.onlineHandler);
            this.onlineHandler = null;
        }
        this.cancelAll();
        // Best-effort flush of remaining history
        this.flushHistory().catch(() => {});
    }

    // === Queue operations ===

    enqueue(item: TransferItem): void {
        // Replace existing item for the same path (avoid duplicates)
        const existingIdx = this.queue.findIndex(
            (q) => q.path === item.path && q.direction === item.direction,
        );
        if (existingIdx >= 0) {
            this.queue[existingIdx] = item;
        } else {
            this.queue.push(item);
        }
        // Sort by priority (ascending = higher priority first)
        this.queue.sort((a, b) => a.priority - b.priority);
        this.callbacks.onQueueChange?.(this.getPendingTransfers());
    }

    pause(): void {
        this.isPaused = true;
    }

    resume(): void {
        this.isPaused = false;
        if (this.queue.some((q) => q.status === "pending") && !this.isProcessing) {
            this.startProcessing();
        }
    }

    cancel(path: string): void {
        const item = this.queue.find((q) => q.path === path);
        if (item && item.status === "pending") {
            item.status = "cancelled";
            item.completedAt = Date.now();
            this.addToHistory({
                id: item.id,
                direction: item.direction,
                path: item.path,
                size: item.size,
                status: "cancelled",
                startedAt: item.startedAt ?? item.createdAt,
                completedAt: Date.now(),
                transferMode: "background",
            });
            this.queue = this.queue.filter((q) => q !== item);
            this.callbacks.onQueueChange?.(this.getPendingTransfers());
        }
    }

    cancelAll(): void {
        for (const item of this.queue) {
            if (item.status === "pending") {
                item.status = "cancelled";
                item.completedAt = Date.now();
            }
        }
        this.queue = [];
        this.callbacks.onQueueChange?.([]);
    }

    // === Status queries (for UI) ===

    /** Get items that are pending or actively transferring (includes inline transfers) */
    getPendingTransfers(): TransferItem[] {
        const bgItems = this.queue.filter(
            (q) => q.status === "pending" || q.status === "active",
        );
        return [...Array.from(this.inlineActive.values()), ...bgItems];
    }

    /** Get completed/failed transfer records */
    getHistory(): TransferRecord[] {
        return [...this.history];
    }

    /** Whether the queue has items waiting to be processed */
    hasPendingItems(): boolean {
        return this.queue.some((q) => q.status === "pending");
    }

    // === Callbacks (for UI) ===

    setCallbacks(callbacks: TransferCallbacks): void {
        this.callbacks = callbacks;
    }

    // === Inline transfer tracking ===

    /** Mark an inline (sync-cycle) transfer as actively in progress (for UI display) */
    markInlineStart(path: string, direction: "push" | "pull", size: number): void {
        const item: TransferItem = {
            id: `inline-${direction}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            direction,
            path,
            size,
            priority: TransferPriority.NORMAL,
            status: "active",
            retryCount: 0,
            createdAt: Date.now(),
            startedAt: Date.now(),
        };
        this.inlineActive.set(path, item);
        this.callbacks.onQueueChange?.(this.getPendingTransfers());
    }

    /** Clear an inline transfer from the active tracking (call after completion or failure) */
    markInlineEnd(path: string): void {
        this.inlineActive.delete(path);
        this.callbacks.onQueueChange?.(this.getPendingTransfers());
    }

    /** Record a transfer that happened inline (within the sync cycle) for history tracking */
    recordInlineTransfer(record: TransferRecord): void {
        this.addToHistory(record);
    }

    // === Processing loop ===

    private startProcessing(): void {
        if (this.isProcessing || this.isPaused || !this.ctx) return;
        // Fire-and-forget — processLoop manages its own lifecycle
        this.processLoop(this.ctx).catch((e) => {
            this.ctx?.log(`[Background Transfer] Process loop error: ${e}`, "error");
        });
    }

    private async processLoop(ctx: SyncContext): Promise<void> {
        if (this.isProcessing) return;
        this.isProcessing = true;

        try {
            while (true) {
                if (this.isPaused) break;
                if (ctx.e2eeLocked) break;

                // Check network connectivity (available in Electron/browser environments)
                // Use strict === false to avoid false positives when navigator.onLine is undefined (e.g. Node.js)
                if (typeof navigator !== "undefined" && navigator.onLine === false) {
                    await ctx.log("[Background Transfer] Offline, pausing queue.", "warn");
                    break;
                }

                const next = this.queue.find((q) => q.status === "pending");
                if (!next) break;

                next.status = "active";
                next.startedAt = Date.now();
                this.callbacks.onTransferStart?.(next);
                ctx.startActivity();

                try {
                    if (next.direction === "push") {
                        await this.executePush(ctx, next);
                    } else {
                        await this.executePull(ctx, next);
                    }
                } catch (e) {
                    const errorMsg = String(e);
                    next.error = errorMsg;
                    next.retryCount++;

                    if (next.retryCount >= MAX_RETRIES) {
                        next.status = "failed";
                        next.completedAt = Date.now();
                        const record: TransferRecord = {
                            id: next.id,
                            direction: next.direction,
                            path: next.path,
                            size: next.size,
                            status: "failed",
                            startedAt: next.startedAt!,
                            completedAt: Date.now(),
                            error: errorMsg,
                            transferMode: "background",
                        };
                        this.addToHistory(record);
                        this.callbacks.onTransferFailed?.(record);
                        // Remove from queue
                        this.queue = this.queue.filter((q) => q !== next);

                        await ctx.log(
                            `[Background Transfer] Failed after ${MAX_RETRIES} retries: ${next.path} - ${errorMsg}`,
                            "error",
                        );
                    } else {
                        // Reset to pending for retry
                        next.status = "pending";
                        const delay = Math.min(
                            RETRY_BASE_DELAY_MS * Math.pow(2, next.retryCount - 1),
                            RETRY_MAX_DELAY_MS,
                        );
                        await ctx.log(
                            `[Background Transfer] Retry ${next.retryCount}/${MAX_RETRIES} for ${next.path} in ${delay}ms`,
                            "warn",
                        );
                        await new Promise((r) => setTimeout(r, delay));
                    }
                }

                ctx.endActivity();

                // Throttle: wait between consecutive background transfers
                const throttleMs = (ctx.settings.bgTransferIntervalSec ?? 0) * 1000;
                if (throttleMs > 0 && this.queue.some((q) => q.status === "pending")) {
                    await new Promise((r) => setTimeout(r, throttleMs));
                }
            }
        } finally {
            this.isProcessing = false;
        }
    }

    // === Push execution ===

    private async executePush(ctx: SyncContext, item: TransferItem): Promise<void> {
        // Staleness check: verify file hasn't changed since enqueue
        const currentStat = await ctx.app.vault.adapter.stat(item.path);
        if (!currentStat) {
            // File was deleted — remove from queue, leave in dirtyPaths for next cycle
            await ctx.log(
                `[Background Transfer] File deleted since enqueue: ${item.path}`,
                "warn",
            );
            this.completeItem(item, "cancelled");
            return;
        }

        if (currentStat.mtime !== item.mtime) {
            // File was modified — re-read and check hash
            const freshContent = await ctx.app.vault.adapter.readBinary(item.path);
            const freshHash = md5(freshContent);
            if (freshHash !== item.snapshotHash) {
                // Content changed — discard queued content, let next sync cycle handle it
                await ctx.log(
                    `[Background Transfer] File modified since enqueue, re-marking dirty: ${item.path}`,
                    "warn",
                );
                ctx.dirtyPaths.add(item.path);
                // Clean up pendingTransfer
                if (ctx.localIndex[item.path]?.pendingTransfer) {
                    delete ctx.localIndex[item.path].pendingTransfer;
                }
                this.completeItem(item, "cancelled");
                return;
            }
            // Hash matches despite mtime change — proceed with fresh content
            item.content = freshContent;
            item.mtime = currentStat.mtime;
        }

        // Conflict re-check: verify remote hasn't changed since enqueue
        let remoteMeta: CloudFile | null = null;
        const fileId = ctx.index[item.path]?.fileId;
        try {
            if (fileId) {
                remoteMeta = await ctx.adapter.getFileMetadataById(fileId, item.path);
            } else {
                remoteMeta = await ctx.adapter.getFileMetadata(item.path);
            }
        } catch {
            // Not found — new file, proceed
        }

        if (remoteMeta) {
            const lastKnownHash = ctx.localIndex[item.path]?.hash;
            const remoteHash = remoteMeta.hash;
            if (
                remoteHash &&
                (!lastKnownHash || lastKnownHash.toLowerCase() !== remoteHash.toLowerCase())
            ) {
                // Remote changed — conflict. Abort and re-mark dirty for next sync cycle
                await ctx.log(
                    `[Background Transfer] Remote conflict detected for ${item.path}, deferring to sync cycle`,
                    "warn",
                );
                ctx.dirtyPaths.add(item.path);
                if (ctx.localIndex[item.path]?.pendingTransfer) {
                    delete ctx.localIndex[item.path].pendingTransfer;
                }
                this.completeItem(item, "cancelled");
                return;
            }
        }

        // Execute upload (prefer resumable for large files)
        const targetFileId = remoteMeta?.id || ctx.index[item.path]?.fileId;
        let uploaded: CloudFile;
        if (ctx.adapter.uploadFileResumable) {
            uploaded = await ctx.adapter.uploadFileResumable(
                item.path,
                item.content!,
                item.mtime!,
                targetFileId,
            );
        } else {
            uploaded = await ctx.adapter.uploadFile(
                item.path,
                item.content!,
                item.mtime!,
                targetFileId,
            );
        }

        // Calculate plainHash for E2EE
        const plainHash = await hashContent(item.content!);

        // Update indices
        const previousAncestorHash = ctx.localIndex[item.path]?.ancestorHash;
        const entry = {
            fileId: uploaded.id,
            mtime: item.mtime!,
            size: uploaded.size,
            hash: uploaded.hash,
            plainHash,
            lastAction: "push" as const,
            ancestorHash: previousAncestorHash || uploaded.hash,
        };
        ctx.index[item.path] = entry;
        ctx.localIndex[item.path] = { ...entry };

        // Clear pendingTransfer and dirtyPaths
        ctx.dirtyPaths.delete(item.path);

        // Upload updated index
        await this.uploadIndex(ctx);

        ctx.logger.markActionTaken();

        await ctx.log(
            `[Background Transfer] Pushed: ${item.path} (${(item.size / 1024 / 1024).toFixed(1)}MB)`,
            "notice",
        );
        await ctx.notify("noticeFilePushed", item.path.split("/").pop());

        // Record completion
        const record: TransferRecord = {
            id: item.id,
            direction: "push",
            path: item.path,
            size: item.size,
            status: "completed",
            startedAt: item.startedAt!,
            completedAt: Date.now(),
            transferMode: "background",
        };
        this.addToHistory(record);
        this.callbacks.onTransferComplete?.(record);
        // Remove from queue
        this.queue = this.queue.filter((q) => q !== item);
        this.callbacks.onQueueChange?.(this.getPendingTransfers());

        // Free the content buffer
        item.content = undefined;
    }

    // === Pull execution ===

    private async executePull(ctx: SyncContext, item: TransferItem): Promise<void> {
        // Check if local file was modified (conflict scenario)
        if (ctx.dirtyPaths.has(item.path)) {
            // Local modification detected — defer to sync cycle for merge
            await ctx.log(
                `[Background Transfer] Local modification detected for ${item.path}, deferring to sync cycle`,
                "warn",
            );
            if (ctx.localIndex[item.path]?.pendingTransfer) {
                delete ctx.localIndex[item.path].pendingTransfer;
            }
            this.completeItem(item, "cancelled");
            return;
        }

        // Execute pull via existing pullFileSafely
        const success = await pullFileSafely(ctx, {
            path: item.path,
            fileId: item.fileId,
            id: item.fileId,
            hash: item.remoteHash,
        }, "Background Transfer");

        if (success) {
            // Clear pendingTransfer
            if (ctx.localIndex[item.path]?.pendingTransfer) {
                delete ctx.localIndex[item.path].pendingTransfer;
            }

            const record: TransferRecord = {
                id: item.id,
                direction: "pull",
                path: item.path,
                size: item.size,
                status: "completed",
                startedAt: item.startedAt!,
                completedAt: Date.now(),
                transferMode: "background",
            };
            this.addToHistory(record);
            this.callbacks.onTransferComplete?.(record);
            this.queue = this.queue.filter((q) => q !== item);
            this.callbacks.onQueueChange?.(this.getPendingTransfers());

            await ctx.log(
                `[Background Transfer] Pulled: ${item.path} (${(item.size / 1024 / 1024).toFixed(1)}MB)`,
                "notice",
            );
        } else {
            throw new Error(`pullFileSafely returned false for ${item.path}`);
        }
    }

    // === Helpers ===

    private completeItem(item: TransferItem, status: "completed" | "cancelled"): void {
        item.status = status;
        item.completedAt = Date.now();
        if (status === "cancelled") {
            const record: TransferRecord = {
                id: item.id,
                direction: item.direction,
                path: item.path,
                size: item.size,
                status: "cancelled",
                startedAt: item.startedAt ?? item.createdAt,
                completedAt: Date.now(),
                transferMode: "background",
            };
            this.addToHistory(record);
        }
        this.queue = this.queue.filter((q) => q !== item);
        this.callbacks.onQueueChange?.(this.getPendingTransfers());
        item.content = undefined;
    }

    private addToHistory(record: TransferRecord): void {
        this.history.push(record);
        // Ring buffer: keep only the last MAX_HISTORY records
        if (this.history.length > MAX_HISTORY) {
            this.history = this.history.slice(-MAX_HISTORY);
        }
        // Buffer for JSONL flush
        this.unflushedRecords.push(record);
        if (this.unflushedRecords.length >= HISTORY_FLUSH_BATCH) {
            this.flushHistory().catch(() => {});
        }
    }

    // === History Persistence (JSONL) ===

    /** Get the path to the current day's transfer log file */
    private getTransfersLogPath(ctx: SyncContext): string {
        const now = new Date();
        const y = now.getFullYear();
        const m = String(now.getMonth() + 1).padStart(2, "0");
        const d = String(now.getDate()).padStart(2, "0");
        return `${ctx.logFolder}/transfers-${y}-${m}-${d}.jsonl`;
    }

    /** Load history from disk on startup */
    private async loadHistory(ctx: SyncContext): Promise<void> {
        try {
            const logPath = this.getTransfersLogPath(ctx);
            const exists = await ctx.app.vault.adapter.exists(logPath);
            if (!exists) {
    
                return;
            }
            const content = await ctx.app.vault.adapter.read(logPath);
            const lines = content.split("\n").filter((l) => l.trim());
            for (const line of lines) {
                try {
                    const record = JSON.parse(line) as TransferRecord;
                    this.history.push(record);
                } catch {
                    // Skip malformed lines
                }
            }
            // Trim to MAX_HISTORY
            if (this.history.length > MAX_HISTORY) {
                this.history = this.history.slice(-MAX_HISTORY);
            }

        } catch {
            // File doesn't exist or is unreadable — start with empty history

        }
    }

    /** Flush buffered records to JSONL file */
    async flushHistory(): Promise<void> {
        if (this.unflushedRecords.length === 0 || !this.ctx) return;
        const ctx = this.ctx;
        const records = this.unflushedRecords.splice(0);
        try {
            const logPath = this.getTransfersLogPath(ctx);

            // Ensure log folder exists
            if (!(await ctx.app.vault.adapter.exists(ctx.logFolder))) {
                // Use recursive folder creation by writing to a dummy path
                const parts = ctx.logFolder.split("/");
                let current = "";
                for (const part of parts) {
                    current = current ? `${current}/${part}` : part;
                    if (!(await ctx.app.vault.adapter.exists(current))) {
                        await ctx.app.vault.adapter.mkdir(current);
                    }
                }
            }

            const lines = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
            const existing = await ctx.app.vault.adapter.read(logPath).catch(() => "");
            await ctx.app.vault.adapter.write(logPath, existing + lines);
        } catch (e) {
            // Re-add failed records for next attempt
            this.unflushedRecords.unshift(...records);
        }
    }

    /** Delete transfer log files older than LOG_RETENTION_DAYS */
    private async rotateOldLogs(ctx: SyncContext): Promise<void> {
        try {
            const folderExists = await ctx.app.vault.adapter.exists(ctx.logFolder);
            if (!folderExists) return;

            const listing = await ctx.app.vault.adapter.list(ctx.logFolder);
            const cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;

            for (const fileName of listing.files) {
                // Match transfers-YYYY-MM-DD.jsonl pattern
                const match = fileName.match(/^transfers-(\d{4})-(\d{2})-(\d{2})\.jsonl$/);
                if (!match) continue;

                const fileDate = new Date(
                    parseInt(match[1]),
                    parseInt(match[2]) - 1,
                    parseInt(match[3]),
                );
                if (fileDate.getTime() < cutoff) {
                    const fullPath = `${ctx.logFolder}/${fileName}`;
                    await ctx.app.vault.adapter.remove(fullPath);
                    await ctx.log(
                        `[Background Transfer] Rotated old log: ${fileName}`,
                        "debug",
                    );
                }
            }
        } catch (e) {
            // Non-critical — log and continue
            await ctx.log(`[Background Transfer] Log rotation error: ${e}`, "warn");
        }
    }

    /** Upload the sync-index.json after a background transfer completes */
    private async uploadIndex(ctx: SyncContext): Promise<void> {
        try {
            await saveIndex(ctx);
            const indexContent = await ctx.app.vault.adapter.readBinary(ctx.pluginDataPath);
            const compressedIndex = await compress(indexContent);
            const uploadedIndex = await ctx.adapter.uploadFile(
                ctx.pluginDataPath,
                compressedIndex,
                Date.now(),
            );
            ctx.index[ctx.pluginDataPath] = {
                fileId: uploadedIndex.id,
                mtime: Date.now(),
                size: uploadedIndex.size,
                hash: uploadedIndex.hash,
            };
            await saveIndex(ctx);
        } catch (e) {
            await ctx.log(`[Background Transfer] Failed to upload index: ${e}`, "error");
        }
    }
}
