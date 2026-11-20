import { removeRemote } from "./remote-deletion";
import { cloudHashMatches, contentFingerprint } from "./content-fingerprint";
import { formatSize } from "../utils/format";
import { basename, dirname } from "../utils/path";
import type { CloudFile } from "../types/adapter";
import type { SyncContext } from "./context";
import { hashContent } from "./file-utils";
import { pullFileSafely } from "./merge";
import { reconcileVanishedAfterUpload } from "./sync-push";
import { saveIndex, saveLocalIndex, takeUnsyncedRename } from "./state";
import { compress } from "./file-utils";
import {
    buildRemoteIndexPayload,
    checkIndexOverwrite,
    clearIndexUploadOwed,
    handBackToSyncCycle,
    markIndexUploadOwed,
    forgetAttemptedUpload,
    isAttemptedUpload,
    peekAttemptedUpload,
    recordAttemptedUpload,
    releasePendingPull,
    settlePendingPull,
    pendingPullsOf,
} from "./sync-helpers";
import type {
    TransferItem,
    TransferRecord,
    TransferCallbacks,
} from "./transfer-types";
import { TransferPriority } from "./transfer-types";
import {
    TRANSFER_MAX_HISTORY,
    TRANSFER_MAX_RETRIES,
    TRANSFER_RETRY_BASE_DELAY_MS,
    TRANSFER_RETRY_MAX_DELAY_MS,
    TRANSFER_HISTORY_FLUSH_BATCH,
    TRANSFER_LOG_RETENTION_DAYS,
} from "./constants";
import { storesTransformedContent } from "./content-identity";

export class BackgroundTransferQueue {
    private queue: TransferItem[] = [];
    private history: TransferRecord[] = [];
    private isProcessing = false;
    private isPaused = false;
    /** The transfer the process loop is executing right now */
    private activeTransfer: Promise<void> | null = null;
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
            void this.ctx.log(`[Background Transfer] Failed to load history: ${String(e)}`, "error");
        }
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
        this.flushHistory().catch(() => {});
    }

    // === Queue operations ===

    enqueue(item: TransferItem): void {
        const existingIdx = this.queue.findIndex(
            (q) => q.path === item.path && q.direction === item.direction,
        );
        if (existingIdx >= 0) {
            this.queue[existingIdx] = item;
        } else {
            this.queue.push(item);
        }
        this.queue.sort((a, b) => a.priority - b.priority);
        this.callbacks.onQueueChange?.(this.getPendingTransfers());
    }

    pause(): void {
        this.isPaused = true;
    }

    /**
     * Pause and wait until the transfer in progress (if any) has finished. A sync
     * cycle must not run alongside a background transfer: the transfer rewrites
     * the index entry of its file in the middle of the cycle, and the cycle then
     * took a just-uploaded file for one "removed from remote but modified
     * locally" (a false conflict copy), or similar.
     */
    async pauseAndSettle(): Promise<void> {
        this.pause();
        if (this.activeTransfer) await this.activeTransfer.catch(() => {});
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
        this.ctx?.progress?.fileStarted(direction, path, size);
        this.callbacks.onQueueChange?.(this.getPendingTransfers());
    }

    /** Clear an inline transfer from the active tracking (call after completion or failure) */
    markInlineEnd(path: string): void {
        const item = this.inlineActive.get(path);
        this.inlineActive.delete(path);
        if (item) this.ctx?.progress?.fileFinished(item.direction, path);
        this.callbacks.onQueueChange?.(this.getPendingTransfers());
    }

    /** Record a transfer that happened inline (within the sync cycle) for history tracking */
    recordInlineTransfer(record: TransferRecord): void {
        this.addToHistory(record);
    }

    // === Processing loop ===

    private startProcessing(): void {
        if (this.isProcessing || this.isPaused || !this.ctx) return;
        this.processLoop(this.ctx).catch((e) => {
            void this.ctx?.log(`[Background Transfer] Process loop error: ${String(e)}`, "error");
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
                    this.activeTransfer =
                        next.direction === "push"
                            ? this.executePush(ctx, next)
                            : this.executePull(ctx, next);
                    await this.activeTransfer;
                } catch (e) {
                    const errorMsg = String(e);
                    next.error = errorMsg;
                    next.retryCount++;

                    if (next.retryCount >= TRANSFER_MAX_RETRIES) {
                        next.status = "failed";
                        next.completedAt = Date.now();
                        const record: TransferRecord = {
                            id: next.id,
                            direction: next.direction,
                            path: next.path,
                            size: next.size,
                            status: "failed",
                            startedAt: next.startedAt,
                            completedAt: Date.now(),
                            error: errorMsg,
                            transferMode: "background",
                        };
                        this.addToHistory(record);
                        this.callbacks.onTransferFailed?.(record);
                        this.queue = this.queue.filter((q) => q !== next);
                        // A pull owed by a Changes API change: retried inline by later syncs
                        if (next.direction === "pull") releasePendingPull(ctx, next.fileId);

                        await ctx.log(
                            `[Background Transfer] Failed after ${TRANSFER_MAX_RETRIES} retries: ${next.path} - ${errorMsg}`,
                            "error",
                        );
                    } else {
                        next.status = "pending";
                        const delay = Math.min(
                            TRANSFER_RETRY_BASE_DELAY_MS * Math.pow(2, next.retryCount - 1),
                            TRANSFER_RETRY_MAX_DELAY_MS,
                        );
                        await ctx.log(
                            `[Background Transfer] Retry ${next.retryCount}/${TRANSFER_MAX_RETRIES} for ${next.path} in ${delay}ms`,
                            "warn",
                        );
                        await new Promise((r) => setTimeout(r, delay));
                    }
                }

                this.activeTransfer = null;
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

    /**
     * An earlier attempt of this upload "failed" but reached the cloud, and the file was
     * renamed or deleted before the retry. The cloud copy under the old name was tracked
     * by nobody: every device saw it as a stray file (or never saw it at all). Move it to
     * the new name, or delete it if the file is gone.
     */
    private async settleOrphanedUpload(ctx: SyncContext, path: string): Promise<void> {
        if (!peekAttemptedUpload(ctx, path) || ctx.index[path]) return;
        try {
            const meta = await ctx.adapter.getFileMetadata(path);
            if (!meta || !isAttemptedUpload(ctx, path, meta.hash)) return;
            const now = takeUnsyncedRename(ctx, path);
            if (now && !ctx.index[now] && (await ctx.vault.exists(now))) {
                await ctx.adapter.moveFile(meta.id, basename(now), dirname(now) || null);
                const hash = meta.hash!.toLowerCase();
                const entry = {
                    fileId: meta.id,
                    mtime: meta.mtime ?? Date.now(),
                    size: meta.size,
                    hash,
                    lastAction: "push" as const,
                    ancestorHash: hash,
                };
                ctx.index[now] = { ...entry };
                ctx.localIndex[now] = { ...entry };
                ctx.dirtyPaths.set(now, ctx.dirtyPaths.get(now) ?? Date.now());
                await ctx.log(`[Background Transfer] Moved our earlier upload of ${path} to ${now}.`, "info");
            } else {
                await removeRemote(ctx, { id: meta.id, path, kind: "file" }, "superseded-upload");
                await ctx.log(`[Background Transfer] Removed our earlier upload of deleted ${path}.`, "info");
            }
            forgetAttemptedUpload(ctx, path);
            await saveIndex(ctx);
        } catch (e) {
            await ctx.log(`[Background Transfer] Could not settle earlier upload of ${path}: ${String(e)}`, "warn");
        }
    }

    private async executePush(ctx: SyncContext, item: TransferItem): Promise<void> {
        // Capture dirty timestamp before any async work so we can detect
        // if markDirty() was called again during our async operations
        const dirtyAt = ctx.dirtyPaths.get(item.path);

        // Staleness check: verify file hasn't changed since enqueue
        const currentStat = await ctx.vault.stat(item.path);
        if (!currentStat) {
            await ctx.log(
                `[Background Transfer] File deleted since enqueue: ${item.path}`,
                "warn",
            );
            await this.settleOrphanedUpload(ctx, item.path);
            this.completeItem(item, "cancelled");
            return;
        }

        if (currentStat.mtime !== item.mtime) {
            const freshContent = await ctx.vault.readBinary(item.path);
            const freshHash = contentFingerprint(freshContent);
            if (freshHash !== item.snapshotHash) {
                await ctx.log(
                    `[Background Transfer] File modified since enqueue, re-marking dirty: ${item.path}`,
                    "warn",
                );
                ctx.dirtyPaths.set(item.path, Date.now());
                if (ctx.localIndex[item.path]?.pendingTransfer) {
                    delete ctx.localIndex[item.path].pendingTransfer;
                }
                this.completeItem(item, "cancelled");
                return;
            }
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
        } catch (e) {
            // Uploading without the conflict check could overwrite another
            // device's edit. Defer to the next sync cycle instead.
            await ctx.log(
                `[Background Transfer] Remote check failed for ${item.path}, deferring: ${String(e)}`,
                "warn",
            );
            ctx.dirtyPaths.set(item.path, Date.now());
            if (ctx.localIndex[item.path]?.pendingTransfer) {
                delete ctx.localIndex[item.path].pendingTransfer;
            }
            this.completeItem(item, "cancelled");
            return;
        }

        if (remoteMeta) {
            const lastKnownHash = ctx.localIndex[item.path]?.hash;
            const remoteHash = remoteMeta.hash;
            if (
                remoteHash &&
                (!lastKnownHash || lastKnownHash.toLowerCase() !== remoteHash.toLowerCase()) &&
                !storesTransformedContent(ctx) &&
                cloudHashMatches(ctx.adapter, remoteHash, contentFingerprint(item.content!))
            ) {
                // The cloud already has exactly this content: our own earlier upload whose
                // result was never recorded (the app was closed while it was in flight).
                // Treating it as a conflict deferred the file to the sync cycle, which
                // deferred it back here, forever.
                const entry = {
                    fileId: remoteMeta.id,
                    mtime: item.mtime,
                    size: remoteMeta.size,
                    hash: remoteHash.toLowerCase(),
                    plainHash: await hashContent(item.content!),
                    lastAction: "push" as const,
                    ancestorHash: remoteHash.toLowerCase(),
                };
                ctx.index[item.path] = entry;
                ctx.localIndex[item.path] = { ...entry };
                forgetAttemptedUpload(ctx, item.path);
                if (ctx.dirtyPaths.get(item.path) === dirtyAt) ctx.dirtyPaths.delete(item.path);
                await ctx.log(
                    `[Background Transfer] ${item.path} is already in the cloud (our own earlier upload).`,
                    "info",
                );
                await this.uploadIndex(ctx);
                this.completeItem(item, "completed");
                return;
            }
            if (
                remoteHash &&
                (!lastKnownHash || lastKnownHash.toLowerCase() !== remoteHash.toLowerCase())
            ) {
                await ctx.log(
                    `[Background Transfer] Remote conflict detected for ${item.path}, deferring to sync cycle`,
                    "warn",
                );
                ctx.dirtyPaths.set(item.path, Date.now());
                handBackToSyncCycle(ctx, item.path);
                if (ctx.localIndex[item.path]?.pendingTransfer) {
                    delete ctx.localIndex[item.path].pendingTransfer;
                }
                this.completeItem(item, "cancelled");
                return;
            }
        }

        const targetFileId = remoteMeta?.id || ctx.index[item.path]?.fileId;
        // Write-ahead record (as for inline uploads): if the app is closed while this
        // upload is in flight, the next start recognises the cloud version as ours.
        recordAttemptedUpload(ctx, item.path, contentFingerprint(item.content!));
        await saveLocalIndex(ctx, true);
        let uploaded: CloudFile;
        if (ctx.adapter.uploadFileResumable) {
            uploaded = await ctx.adapter.uploadFileResumable(
                item.path,
                item.content!,
                item.mtime,
                targetFileId,
            );
        } else {
            uploaded = await ctx.adapter.uploadFile(
                item.path,
                item.content!,
                item.mtime,
                targetFileId,
            );
        }

        forgetAttemptedUpload(ctx, item.path);
        const plainHash = await hashContent(item.content!);

        const previousAncestorHash = ctx.localIndex[item.path]?.ancestorHash;
        const entry = {
            fileId: uploaded.id,
            mtime: item.mtime,
            size: uploaded.size,
            hash: uploaded.hash,
            plainHash,
            lastAction: "push" as const,
            ancestorHash: previousAncestorHash || uploaded.hash,
        };
        if (await reconcileVanishedAfterUpload(ctx, item.path, item.content!, entry)) {
            // Renamed or deleted while uploading: the upload was re-homed (as for
            // inline pushes). Registering the old path made both names exist on
            // every device.
        } else {
            ctx.index[item.path] = entry;
            ctx.localIndex[item.path] = { ...entry };

            // Only remove from dirty if the file wasn't re-dirtied during upload.
            if (ctx.dirtyPaths.get(item.path) === dirtyAt) {
                ctx.dirtyPaths.delete(item.path);
            }
        }

        await this.uploadIndex(ctx);

        ctx.logger.markActionTaken();

        await ctx.log(
            `[Background Transfer] Pushed: ${item.path} (${formatSize(item.size)})`,
            "notice",
        );
        await ctx.notify("noticeFilePushed", basename(item.path));

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
        this.queue = this.queue.filter((q) => q !== item);
        this.callbacks.onQueueChange?.(this.getPendingTransfers());

        item.content = undefined;
    }

    // === Pull execution ===

    private async executePull(ctx: SyncContext, item: TransferItem): Promise<void> {
        if (ctx.dirtyPaths.has(item.path)) {
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

        // The queue can hold an item for a long time (retries, offline). If the file
        // was renamed or deleted on the cloud meanwhile, downloading it now wrote it
        // back under its old name next to the renamed copy. The rename/delete arrives
        // as a change of its own, so just drop the stale item.
        if (item.fileId) {
            const meta = await ctx.adapter.getFileMetadataById(item.fileId, item.path);
            const holder = Object.entries(ctx.index).find(([, e]) => e.fileId === item.fileId)?.[0];
            if (!meta || meta.path !== item.path || (holder !== undefined && holder !== item.path)) {
                await ctx.log(
                    `[Background Transfer] ${item.path} was ${meta ? `renamed to ${meta.path}` : "removed"} on the cloud since it was queued. Skipping.`,
                    "info",
                );
                if (ctx.localIndex[item.path]?.pendingTransfer) {
                    delete ctx.localIndex[item.path].pendingTransfer;
                }
                this.completeItem(item, "cancelled");
                // (after completeItem, which settles the pending pull of this id)
                // Not here under any name: the rename may predate our Changes token
                // (first sync from an index written before it), so no change will
                // bring it. Pull it under its current name.
                if (
                    meta &&
                    meta.path !== item.path &&
                    (holder === undefined || holder === item.path) &&
                    !(await ctx.vault.exists(item.path))
                ) {
                    // A placeholder entry under the old name (never downloaded) goes too
                    if (holder === item.path) {
                        delete ctx.index[item.path];
                        delete ctx.localIndex[item.path];
                    }
                    pendingPullsOf(ctx).set(item.fileId, {
                        file: { id: item.fileId, path: meta.path, hash: meta.hash, size: meta.size ?? 0, mtime: meta.mtime },
                        attempts: 0,
                    });
                    await ctx.log(`[Background Transfer] Pulling ${meta.path} under its current name next sync.`, "info");
                }
                return;
            }
        }

        const success = await pullFileSafely(ctx, {
            path: item.path,
            fileId: item.fileId,
            id: item.fileId,
            hash: item.remoteHash,
        }, "Background Transfer");

        if (success) {
            if (ctx.localIndex[item.path]?.pendingTransfer) {
                delete ctx.localIndex[item.path].pendingTransfer;
            }
            settlePendingPull(ctx, item.fileId);
            // Persist now (both indexes): if the app is killed before the next sync
            // writes them, the downloaded file looked like a new local file and a
            // later remote rename of it was not recognised, leaving a stray copy.
            await saveIndex(ctx);

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
                `[Background Transfer] Pulled: ${item.path} (${formatSize(item.size)})`,
                "notice",
            );
        } else {
            throw new Error(`pullFileSafely returned false for ${item.path}`);
        }
    }

    // === Helpers ===

    private completeItem(item: TransferItem, status: "completed" | "cancelled"): void {
        // A cancelled pull is handled by the sync cycle (local edit) or by its own
        // change (renamed / removed on the cloud): nothing is owed any more.
        if (item.direction === "pull" && this.ctx) settlePendingPull(this.ctx, item.fileId);
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
        if (this.history.length > TRANSFER_MAX_HISTORY) {
            this.history = this.history.slice(-TRANSFER_MAX_HISTORY);
        }
        this.unflushedRecords.push(record);
        if (this.unflushedRecords.length >= TRANSFER_HISTORY_FLUSH_BATCH) {
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

    /** Load history from all log files within retention period */
    private async loadHistory(ctx: SyncContext): Promise<void> {
        try {
            const folderExists = await ctx.vault.exists(ctx.logFolder);
            if (!folderExists) return;

            const listing = await ctx.vault.list(ctx.logFolder);
            const cutoff = Date.now() - TRANSFER_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;

            // Collect valid log files within retention period, sorted by date ascending
            // Note: vault.adapter.list() returns full paths in real Obsidian,
            // so we match the filename portion at the end of the path.
            const logFiles: string[] = [];
            for (const filePath of listing.files) {
                const match = filePath.match(/(?:^|[/\\])transfers-(\d{4})-(\d{2})-(\d{2})\.jsonl$/);
                if (!match) continue;
                const fileDate = new Date(
                    parseInt(match[1]),
                    parseInt(match[2]) - 1,
                    parseInt(match[3]),
                );
                if (fileDate.getTime() >= cutoff) {
                    logFiles.push(filePath);
                }
            }
            logFiles.sort();

            for (const filePath of logFiles) {
                // filePath may be full path or just filename depending on vault implementation
                const fullPath = filePath.includes("/") ? filePath : `${ctx.logFolder}/${filePath}`;
                try {
                    const content = await ctx.vault.read(fullPath);
                    const lines = content.split("\n").filter((l) => l.trim());
                    for (const line of lines) {
                        try {
                            const record = JSON.parse(line) as TransferRecord;
                            this.history.push(record);
                        } catch {
                            // Skip malformed lines
                        }
                    }
                } catch {
                    // Skip unreadable files
                }
            }

            if (this.history.length > TRANSFER_MAX_HISTORY) {
                this.history = this.history.slice(-TRANSFER_MAX_HISTORY);
            }
        } catch {
            // Folder doesn't exist or is unreadable — start with empty history
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
            if (!(await ctx.vault.exists(ctx.logFolder))) {
                // Use recursive folder creation by writing to a dummy path
                const parts = ctx.logFolder.split("/");
                let current = "";
                for (const part of parts) {
                    current = current ? `${current}/${part}` : part;
                    if (!(await ctx.vault.exists(current))) {
                        await ctx.vault.mkdir(current);
                    }
                }
            }

            const lines = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
            const existing = await ctx.vault.read(logPath).catch(() => "");
            await ctx.vault.write(logPath, existing + lines);
        } catch {
            this.unflushedRecords.unshift(...records);
        }
    }

    /** Delete transfer log files older than TRANSFER_LOG_RETENTION_DAYS */
    private async rotateOldLogs(ctx: SyncContext): Promise<void> {
        try {
            const folderExists = await ctx.vault.exists(ctx.logFolder);
            if (!folderExists) return;

            const listing = await ctx.vault.list(ctx.logFolder);
            const cutoff = Date.now() - TRANSFER_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;

            for (const filePath of listing.files) {
                // Match transfers-YYYY-MM-DD.jsonl pattern (filePath may be full or relative)
                const match = filePath.match(/(?:^|[/\\])transfers-(\d{4})-(\d{2})-(\d{2})\.jsonl$/);
                if (!match) continue;

                const fileDate = new Date(
                    parseInt(match[1]),
                    parseInt(match[2]) - 1,
                    parseInt(match[3]),
                );
                if (fileDate.getTime() < cutoff) {
                    const fullPath = filePath.includes("/") ? filePath : `${ctx.logFolder}/${filePath}`;
                    await ctx.vault.remove(fullPath);
                    await ctx.log(
                        `[Background Transfer] Rotated old log: ${filePath}`,
                        "debug",
                    );
                }
            }
        } catch (e) {
            await ctx.log(`[Background Transfer] Log rotation error: ${String(e)}`, "warn");
        }
    }

    /** Upload the sync-index.json after a background transfer completes */
    private async uploadIndex(ctx: SyncContext): Promise<void> {
        try {
            await saveIndex(ctx);
            const indexContent = await buildRemoteIndexPayload(ctx);
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
            clearIndexUploadOwed(ctx);
            await checkIndexOverwrite(ctx, uploadedIndex);
            await saveIndex(ctx);
        } catch (e) {
            markIndexUploadOwed(ctx);
            await saveIndex(ctx).catch(() => {});
            await ctx.log(`[Background Transfer] Failed to upload index (retried next sync): ${String(e)}`, "error");
        }
    }
}
