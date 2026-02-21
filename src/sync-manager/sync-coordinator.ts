import { md5 } from "../utils/md5";
import type { SyncContext } from "./context";
import type { SyncState } from "./types";
import { ALWAYS_SHOW_ACTIVITY, TRIGGER_PRIORITY } from "./notification-matrix";
import { getLocalFiles, shouldIgnore } from "./file-utils";
import { saveIndex } from "./state";
import {
    SYNC_POST_PUSH_PULL_MAX_RETRIES,
    SCAN_FULL_SCAN_CHUNK_SIZE,
} from "./constants";
import { smartPull, pullViaChangesAPI } from "./sync-pull";
import { smartPush } from "./sync-push";

// ==========================================================================
// Smart Sync Entry Points
// ==========================================================================

/**
 * Request Smart Sync - high priority, interrupts full scan
 * This is the main entry point for user-triggered syncs.
 * Trigger is read from ctx.currentTrigger (set by caller before invoking).
 * @param scanVault If true, perform a full vault scan for changes (O(N)) - useful for startup
 */
export async function requestSmartSync(
    ctx: SyncContext,
    scanVault: boolean = false,
): Promise<void> {
    // If already smart syncing, mark that we need another pass after and wait.
    if (ctx.syncState === "SMART_SYNCING" || ctx.syncState === "MIGRATING") {
        if (ctx.syncState === "SMART_SYNCING") {
            ctx.syncRequestedWhileSyncing = true;
            if (!ctx.nextSyncParams) {
                ctx.nextSyncParams = { trigger: ctx.currentTrigger, scanVault };
            } else {
                // Merge requirements: pick the "loudest" trigger (highest priority).
                // If any request wants a full scan, the next pass should scan.
                const incoming = TRIGGER_PRIORITY[ctx.currentTrigger] ?? 0;
                const queued = TRIGGER_PRIORITY[ctx.nextSyncParams.trigger] ?? 0;
                if (incoming > queued) {
                    ctx.nextSyncParams.trigger = ctx.currentTrigger;
                }
                ctx.nextSyncParams.scanVault = ctx.nextSyncParams.scanVault || scanVault;
            }
        }

        if (ctx.currentSyncPromise) {
            await ctx.currentSyncPromise;
        }
        return;
    }

    // Interrupt running full scan
    if (ctx.syncState === "FULL_SCANNING") {
        await ctx.log("[Smart Sync] Interrupting full scan...", "debug");
        ctx.isInterrupted = true;
        // Wait for full scan to pause
        if (ctx.currentSyncPromise) {
            await ctx.currentSyncPromise;
        }

        // RACE CONDITION FIX:
        // After waiting, another request might have woken up first and started syncing.
        // Re-check state to ensure we don't run parallel syncs.
        if ((ctx.syncState as SyncState) === "SMART_SYNCING") {
            if (ctx.currentSyncPromise) {
                await ctx.currentSyncPromise;
            }
            return;
        }
    }

    let currentScanVault = scanVault;

    // Execute smart sync with re-queueing support
    do {
        ctx.syncRequestedWhileSyncing = false;
        ctx.syncState = "SMART_SYNCING";
        ctx.currentSyncPromise = executeSmartSync(ctx, currentScanVault);

        try {
            await ctx.currentSyncPromise;
        } finally {
            ctx.syncState = "IDLE";
            ctx.currentSyncPromise = null;
        }

        // If another request came in, prepare parameters for the next pass
        if (ctx.syncRequestedWhileSyncing && ctx.nextSyncParams) {
            ctx.currentTrigger = ctx.nextSyncParams.trigger;
            currentScanVault = ctx.nextSyncParams.scanVault;
            ctx.nextSyncParams = null;
        }
    } while (ctx.syncRequestedWhileSyncing);
}

/**
 * Execute Smart Sync logic
 * - Pull: Check remote changes via sync-index.json hash comparison (or Changes API)
 * - Push: Upload dirty files
 */
export async function executeSmartSync(ctx: SyncContext, scanVault: boolean): Promise<void> {
    ctx.logger.startCycle(ctx.currentTrigger);
    if (ALWAYS_SHOW_ACTIVITY.has(ctx.currentTrigger)) {
        ctx.startActivity();
    }
    // Pause background transfers during sync cycle to avoid race conditions
    ctx.backgroundTransferQueue.pause();
    try {
        await ctx.log("=== SMART SYNC START ===", "info");
        await ctx.notify("noticeSyncing");

        // Clean up recentlyDeletedFromRemote: remove entries for files that no longer exist locally
        // (they were successfully deleted, so we don't need to track them anymore)
        for (const path of [...ctx.recentlyDeletedFromRemote]) {
            const exists = await ctx.vault.exists(path);
            if (!exists) {
                ctx.recentlyDeletedFromRemote.delete(path);
            }
        }

        // Pre-warm adapter (ensure root folders exist) to avoid delay in push phase
        if (ctx.adapter.initialize) {
            await ctx.adapter.initialize();
        }

        // === PULL PHASE ===
        // Call via ctx so vi.spyOn on SyncManager instance methods works in tests
        const pulled = await ctx.smartPull();

        // === PUSH PHASE ===
        if (scanVault) {
            await ctx.notify("noticeScanningLocalFiles");
        }
        const pushed = await ctx.smartPush(scanVault);

        // === POST-PUSH PULL PHASE ===
        // After pushing, immediately pull again to detect conflicts from other devices
        // and confirm sync state (ancestorHash update).
        if (pushed) {
            await postPushPull(ctx);
        }

        if (!pulled && !pushed) {
            await ctx.notify("noticeVaultUpToDate");
        }

        if (ctx.settingsUpdated) {
            await ctx.log("[Smart Sync] Remote settings update detected. Reloading...", "info");
            await ctx.onSettingsUpdated();
            ctx.settingsUpdated = false;
        }

        await ctx.log("=== SMART SYNC COMPLETED ===", "info");
    } catch (e) {
        await ctx.log(`Smart Sync failed: ${e}`, "error");
        // Classify error and notify user
        const msg = e instanceof Error ? e.message : String(e);
        const msgLower = msg.toLowerCase();
        if (msgLower.includes("not authenticated") || msgLower.includes("authentication failed") || msgLower.includes("token revoked")) {
            await ctx.notify("noticeSyncFailedAuth");
        } else if (msgLower.includes("network error") || msgLower.includes("failed to fetch") || msgLower.includes("unreachable")) {
            await ctx.notify("noticeSyncFailedNetwork");
        } else {
            await ctx.notify("noticeSyncFailed", msg.slice(0, 80));
        }
        throw e;
    } finally {
        // Clear decryption cache between sync cycles to free memory
        ctx.adapter.clearDownloadCache?.();
        await ctx.logger.endCycle();
        ctx.endActivity();
        // Resume background transfers after sync cycle completes
        ctx.backgroundTransferQueue.resume();
        // Flush any buffered transfer history records to disk
        ctx.backgroundTransferQueue.flushHistory().catch(() => {});
    }
}

// ==========================================================================
// Post-Push Pull (with retry)
// ==========================================================================

/**
 * Execute a pull after push to immediately detect conflicts and confirm sync state.
 * Uses the same logic as the first pull (smartPull or pullViaChangesAPI).
 * Retries on failure since the push already succeeded - this is confirmation only.
 */
async function postPushPull(ctx: SyncContext, maxRetries: number = SYNC_POST_PUSH_PULL_MAX_RETRIES): Promise<void> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            await ctx.log(
                `[Post-Push Pull] Starting confirmation pull (attempt ${attempt + 1}/${maxRetries + 1})...`,
                "debug",
            );
            if (attempt === 0 && !ctx.settings.hasCompletedFirstSync) {
                await ctx.notify("noticeInitialSyncConfirmation");
            }
            if (ctx.adapter.supportsChangesAPI) {
                await ctx.pullViaChangesAPI(true);
            } else {
                await ctx.smartPull();
            }
            await ctx.log("[Post-Push Pull] Confirmation pull completed.", "debug");
            return;
        } catch (e) {
            await ctx.log(
                `[Post-Push Pull] Attempt ${attempt + 1}/${maxRetries + 1} failed: ${e}`,
                "warn",
            );
            if (attempt === maxRetries) {
                await ctx.log(
                    "[Post-Push Pull] All retries exhausted. Skipping confirmation pull.",
                    "warn",
                );
            }
        }
    }
}


// ==========================================================================
// Background Full Scan
// ==========================================================================

/**
 * Request Background Full Scan - low priority, can be interrupted
 * @param resume If true, try to resume from previous progress
 */
export async function requestBackgroundScan(
    ctx: SyncContext,
    resume: boolean = false,
): Promise<void> {
    // Don't start if already syncing
    if (ctx.syncState !== "IDLE") {
        await ctx.log("[Full Scan] Skipped - sync already in progress", "debug");
        return;
    }

    // Check if we should resume or start fresh
    if (!resume || !ctx.fullScanProgress || isProgressStale(ctx)) {
        ctx.fullScanProgress = null;
    }

    ctx.syncState = "FULL_SCANNING";
    ctx.isInterrupted = false;
    ctx.currentSyncPromise = executeFullScan(ctx);

    try {
        await ctx.currentSyncPromise;
    } finally {
        if (ctx.syncState === "FULL_SCANNING") {
            ctx.syncState = "IDLE";
        }
        ctx.currentSyncPromise = null;
    }
}

/**
 * Check if stored progress is too old
 */
export function isProgressStale(ctx: SyncContext): boolean {
    if (!ctx.fullScanProgress) return true;
    return Date.now() - ctx.fullScanProgress.startedAt > ctx.FULL_SCAN_MAX_AGE_MS;
}

/**
 * Execute Full Scan with interrupt support
 */
export async function executeFullScan(ctx: SyncContext): Promise<void> {
    ctx.logger.startCycle(ctx.currentTrigger);
    try {
        await ctx.log("=== BACKGROUND FULL SCAN START ===", "info");

        // Initialize or resume progress
        if (!ctx.fullScanProgress) {
            await ctx.log("[Full Scan] Fetching file lists...", "debug");
            const localFiles = await getLocalFiles(ctx);
            const remoteFiles = await ctx.adapter.listFiles();

            // Check for interrupt after heavy listing operation
            if (ctx.isInterrupted) {
                ctx.syncState = "PAUSED"; // Or IDLE handled by finally/caller logic?
                // Actually requestSmartSync handles the state transition after this promise resolves.
                // But we should stop here.
                return;
            }

            ctx.fullScanProgress = {
                currentIndex: 0,
                totalFiles: remoteFiles.length,
                localFiles: localFiles.map((f) => ({
                    path: f.path,
                    mtime: f.mtime,
                    size: f.size,
                })),
                remoteFiles: remoteFiles.map((f) => ({
                    id: f.id,
                    path: f.path,
                    mtime: f.mtime,
                    size: f.size,
                    hash: f.hash,
                })),
                startedAt: Date.now(),
            };
        } else {
            await ctx.log(
                `[Full Scan] Resuming from index ${ctx.fullScanProgress.currentIndex}/${ctx.fullScanProgress.totalFiles}`,
                "debug",
            );
        }

        const { localFiles, remoteFiles } = ctx.fullScanProgress;
        const localPathsMap = new Map(localFiles.map((f) => [f.path, f]));
        // Process in chunks to allow interruption

        // Process remote files in chunks
        while (ctx.fullScanProgress.currentIndex < remoteFiles.length) {
            // Check for interrupt
            if (ctx.isInterrupted) {
                await ctx.log(
                    `[Full Scan] Interrupted at index ${ctx.fullScanProgress.currentIndex}`,
                    "debug",
                );
                ctx.syncState = "PAUSED";
                return;
            }

            const chunk = remoteFiles.slice(
                ctx.fullScanProgress.currentIndex,
                ctx.fullScanProgress.currentIndex + SCAN_FULL_SCAN_CHUNK_SIZE,
            );

            for (const remoteFile of chunk) {
                if (remoteFile.path === ctx.pluginDataPath) continue;
                if (shouldIgnore(ctx, remoteFile.path)) continue;

                const localFile = localPathsMap.get(remoteFile.path);
                const indexEntry = ctx.index[remoteFile.path];

                // Check for discrepancies
                if (!localFile && indexEntry) {
                    // File exists in index but not locally - might have been deleted
                    await ctx.log(
                        `[Full Scan] Discrepancy: ${remoteFile.path} in index but not local`,
                        "debug",
                    );
                } else if (localFile && !indexEntry && remoteFile.hash) {
                    // File exists locally but not in index - check if it matches remote
                    try {
                        const content = await ctx.vault.readBinary(remoteFile.path);
                        const localHash = md5(content);
                        if (localHash === remoteFile.hash.toLowerCase()) {
                            // Adopt into index - treat as "pull" since we're accepting remote state
                            ctx.index[remoteFile.path] = {
                                fileId: remoteFile.id,
                                mtime: localFile.mtime,
                                size: localFile.size,
                                hash: remoteFile.hash,
                                lastAction: "pull",
                                ancestorHash: remoteFile.hash, // Set ancestor for future merges
                            };
                            await ctx.log(`[Full Scan] Adopted: ${remoteFile.path}`, "debug");
                        }
                    } catch {
                        // Ignore hash calculation errors
                    }
                }
            }

            ctx.fullScanProgress.currentIndex += chunk.length;

            // Yield to allow interrupt check
            await new Promise((resolve) => setTimeout(resolve, 0));
        }

        // Scan completed
        await ctx.log("=== BACKGROUND FULL SCAN COMPLETED ===", "info");
        ctx.fullScanProgress = null;
        await saveIndex(ctx);
    } catch (e) {
        await ctx.log(`[Full Scan] Error: ${e}`, "error");
        ctx.fullScanProgress = null;
    } finally {
        await ctx.logger.endCycle();
    }
}
