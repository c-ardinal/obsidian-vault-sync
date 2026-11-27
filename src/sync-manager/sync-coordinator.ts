import { capabilitiesOf } from "../types/adapter";
import { cloudHashMatches, contentFingerprint } from "./content-fingerprint";
import type { SyncContext } from "./context";
import type { SyncState } from "./types";
import { ALWAYS_SHOW_ACTIVITY, TRIGGER_PRIORITY } from "./notification-matrix";
import { ensureLocalFolder, getLocalFiles, shouldIgnore } from "./file-utils";
import { freeConflictCopyPath } from "./conflict-resolution";
import { markDeleted, saveIndex, saveLocalIndex, beginSyncCycle, endSyncCycle } from "./state";
import {
    followVaultFolder,
    isVaultFolderRestart,
    NO_CONVERSION_BASE,
    knownVaultRootOf,
    parseConversionBase,
    rememberResent,
    resentDeletedSince,
    VaultConvertedError,
} from "./vault-folder";
import { REMOTE_FILES } from "./remote-layout";
import { hashContent } from "./file-utils";
import { deletedVersionKnown, downloadRemoteIndex, markIndexUploadOwed, noteDeletionMark } from "./sync-helpers";
import {
    SYNC_POST_PUSH_PULL_MAX_RETRIES,
    SCAN_FULL_SCAN_CHUNK_SIZE,
} from "./constants";
import { retryOverwriteRepairs } from "./overwrite-recovery";
import { holdsNewFiles } from "./sync-scan";
import { purgeTrashIfDue } from "./remote-trash";
import { prepareFirstSync } from "./first-sync";
import { keepRevisionsIfDue } from "./revision-retention";
import { checkStorageIfDue } from "./storage-check";
import { publishDeviceRecordIfDue } from "./device-registry";
import { migratePlainHashes } from "./plain-hash-migration";
import { reconcileScopeChange } from "./sync-pull";
import { noteScopeAtSyncEnd } from "./sync-scope";
import { CtxFlag } from "./context-state";


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
 * Sync managers that completed a vault scan since they were created. Edits made
 * while the app was closed, and those a killed app had not pushed yet (the dirty
 * list lives in memory), are only found by a scan. Only the startup sync asks for
 * one; when it fails (offline at launch, a network error, the E2EE check) or
 * startup sync is disabled, the first sync that gets through scans instead.
 */
const scanDone = new CtxFlag("vaultScanDone", "A sync with a full vault scan went through since the plugin started");

/**
 * Execute Smart Sync logic
 * - Pull: Check remote changes via sync-index.json hash comparison (or Changes API)
 * - Push: Upload dirty files
 */
export async function executeSmartSync(ctx: SyncContext, scanVault: boolean): Promise<void> {
    const scanRequested = scanVault;
    if (!scanDone.has(ctx)) scanVault = true;
    ctx.logger.startCycle(ctx.currentTrigger);
    if (ALWAYS_SHOW_ACTIVITY.has(ctx.currentTrigger)) {
        ctx.startActivity();
    }
    await ctx.backgroundTransferQueue.pauseAndSettle();
    beginSyncCycle(ctx);
    ctx.progress?.begin(ctx.currentTrigger);
    try {
        await ctx.log("=== SMART SYNC START ===", "info");
        await ctx.notify("noticeSyncing");

        for (const path of [...ctx.recentlyDeletedFromRemote]) {
            const exists = await ctx.vault.exists(path);
            if (!exists) {
                ctx.recentlyDeletedFromRemote.delete(path);
            }
        }

        if (ctx.adapter.initialize) {
            await ctx.adapter.initialize();
        }

        // Before anything else reads the indexes: they may describe a vault
        // folder another device has replaced meanwhile
        const knownRoot = knownVaultRootOf(ctx);
        const folderReplaced = await followVaultFolder(
            ctx,
            async () => {
                const meta = await ctx.adapter.getFileMetadata(ctx.pluginDataPath);
                return meta ? await downloadRemoteIndex(ctx, meta.id) : {};
            },
            async () => {
                // The new folder is a converted vault this device has not unlocked:
                // its files cannot be read as they are. The sync stops here, and the
                // check before the next sync finds the vault-lock and asks for it.
                if (!ctx.e2eeEnabled && (await ctx.vaultLockService?.checkForLockFile())) {
                    throw new VaultConvertedError();
                }
                // A converted vault whose folder was deleted or renamed by hand is
                // rebuilt by the devices; the lock went with the old folder
                if (ctx.e2eeEnabled && ctx.vaultLockService?.restoreLockFileIfMissing) {
                    const lock = await ctx.vaultLockService.restoreLockFileIfMissing();
                    if (lock === "restored") {
                        await ctx.log("[Vault Folder] The new folder had no vault-lock: restored it from this device's copy.", "warn");
                    } else if (lock === "lost") {
                        throw new Error(
                            "The cloud vault folder was replaced by one without a vault-lock, and this device holds no copy of it. Nothing is uploaded: open the add-on's settings on a device that was unlocked before.",
                        );
                    }
                }
            },
            async () => {
                const meta = await ctx.adapter.getFileMetadata(`${ctx.pluginDir}/${REMOTE_FILES.conversionBase}`);
                if (!meta) return NO_CONVERSION_BASE;
                return parseConversionBase(new TextDecoder().decode(await ctx.adapter.downloadFile(meta.id)));
            },
            async (path) => {
                if (!(await ctx.vault.exists(path))) return undefined;
                return hashContent(await ctx.vault.readBinary(path));
            },
            async (fileId) => {
                if (!ctx.adapter.getContentHashById) return null;
                return ctx.adapter.getContentHashById(fileId);
            },
            async (result) => {
                for (const note of result.deletedHere) {
                    // The device that cleans up the old folder reads the marks first
                    noteDeletionMark(ctx, note.fileId, note.hash, { path: note.path, plain: note.plain });
                    markIndexUploadOwed(ctx);
                }
                for (const path of result.lateHere) ctx.dirtyPaths.set(path, Date.now());
                for (const note of result.resent) rememberResent(ctx, note.path, note.plain);
                for (const path of result.deletedLate) markDeleted(ctx, path);
                for (const path of result.unsure) {
                    const copy = await freeConflictCopyPath((p) => ctx.vault.exists(p), path);
                    await ensureLocalFolder(ctx, copy);
                    await ctx.vault.writeBinary(copy, await ctx.vault.readBinary(path));
                    ctx.dirtyPaths.set(copy, Date.now());
                    await ctx.log(
                        `[Vault Folder] ${path}: the version here was not converted and the vault holds another one. Kept the content here as ${copy}.`,
                        "warn",
                    );
                }
            },
            (path, plain) => deletedVersionKnown(ctx, path, plain),
        );
        if (folderReplaced) {
            await saveIndex(ctx);
            scanVault = true;
        }
        if (folderReplaced || knownVaultRootOf(ctx) !== knownRoot) await saveLocalIndex(ctx, true);

        if ((await migratePlainHashes(ctx)) > 0) await saveIndex(ctx);

        if (!(await prepareFirstSync(ctx))) {
            await ctx.log("[First Sync] Held by the user. Automatic syncs wait for a manual sync.", "info");
            await ctx.notify("noticeFirstSyncDeferred");
            ctx.progress?.finish("ok");
            return;
        }

        // Files kept here while left out sync again: only a vault scan finds them
        if (await reconcileScopeChange(ctx)) scanVault = true;
        // A sync setting was changed in the settings tab (maybe back and forth before
        // this sync): edits made while a file was left out had no effect, find them.
        if (ctx.forceCleanupNextSync) scanVault = true;

        // Call via ctx so vi.spyOn on SyncManager instance methods works in tests
        const pulled = await ctx.smartPull();

        if (scanRequested) {
            await ctx.notify("noticeScanningLocalFiles");
        }
        // New files a scan held back (a rename event might still explain them) are
        // only looked at again by a scan: without one they were never uploaded.
        if (holdsNewFiles(ctx)) scanVault = true;
        // Followed into a replaced vault folder lately: a note to be sent again may
        // have been carried over and deleted there meanwhile (the pull above read
        // the vault's deletion marks)
        const deletedSince = await resentDeletedSince(
            ctx,
            async (path) => ((await ctx.vault.exists(path)) ? hashContent(await ctx.vault.readBinary(path)) : undefined),
            (path, plain) => deletedVersionKnown(ctx, path, plain),
        );
        for (const path of deletedSince) {
            const file = ctx.vault.getAbstractFileByPath(path);
            if (file) await ctx.vault.trashFile(file, true);
            delete ctx.localIndex[path];
            ctx.dirtyPaths.delete(path);
            await ctx.log(`[Vault Folder] ${path} was deleted in the vault in the version held here: deleted here, not sent again.`, "info");
        }
        const pushed = await ctx.smartPush(scanVault);
        if (scanVault) scanDone.add(ctx);

        // Every transfer of the cycle is through; what follows confirms and tidies up.
        ctx.progress?.setPhase("finishing");
        if (pushed) {
            await postPushPull(ctx);
        }
        await retryOverwriteRepairs(ctx);
        await purgeTrashIfDue(ctx);
        await keepRevisionsIfDue(ctx);
        await checkStorageIfDue(ctx);
        await publishDeviceRecordIfDue(ctx);

        if (!pulled && !pushed) {
            await ctx.notify("noticeVaultUpToDate");
        }

        if (ctx.settingsUpdated) {
            await ctx.log("[Smart Sync] Remote settings update detected. Reloading...", "info");
            await ctx.onSettingsUpdated();
            ctx.settingsUpdated = false;
        }

        await ctx.log("=== SMART SYNC COMPLETED ===", "info");
        ctx.progress?.finish("ok");
    } catch (e) {
        if (isVaultFolderRestart(e)) {
            // Not a failure: the caller starts over with the new vault folder
            await ctx.log(`Smart Sync stopped: ${e instanceof Error ? e.message : String(e)}`, "system");
            ctx.progress?.finish("ok");
            throw e;
        }
        await ctx.log(`Smart Sync failed: ${String(e)}`, "error");
        const notice = syncErrorNotice(e);
        ctx.progress?.finish(
            notice.key === "noticeSyncFailedNetwork"
                ? "offline"
                : notice.key === "noticeSyncFailedAuth"
                  ? "auth"
                  : "error",
            notice.suffix,
        );
        if (notice.suffix === undefined) await ctx.notify(notice.key);
        else await ctx.notify(notice.key, notice.suffix);
        throw e;
    } finally {
        noteScopeAtSyncEnd(ctx, ctx.settings);
        await endSyncCycle(ctx);
        ctx.adapter.clearDownloadCache?.();
        await ctx.logger.endCycle();
        ctx.endActivity();
        ctx.backgroundTransferQueue.resume();
        ctx.backgroundTransferQueue.flushHistory().catch(() => {});
    }
}


/** Pick the user-facing notice for a failed sync. */
export function syncErrorNotice(e: unknown): { key: string; suffix?: string } {
    const msg = e instanceof Error ? e.message : String(e);
    const msgLower = msg.toLowerCase();
    if (
        msgLower.includes("not authenticated") ||
        msgLower.includes("authentication failed") ||
        msgLower.includes("token revoked")
    ) {
        return { key: "noticeSyncFailedAuth" };
    }
    if (
        msgLower.includes("network error") ||
        msgLower.includes("failed to fetch") ||
        msgLower.includes("unreachable") ||
        (typeof navigator !== "undefined" && navigator.onLine === false)
    ) {
        return { key: "noticeSyncFailedNetwork" };
    }
    return { key: "noticeSyncFailed", suffix: msg.slice(0, 80) };
}

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
            if (capabilitiesOf(ctx.adapter).changeFeed) {
                await ctx.pullViaChangesAPI(true);
            } else {
                await ctx.smartPull();
            }
            await ctx.log("[Post-Push Pull] Confirmation pull completed.", "debug");
            return;
        } catch (e) {
            await ctx.log(
                `[Post-Push Pull] Attempt ${attempt + 1}/${maxRetries + 1} failed: ${String(e)}`,
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
    ctx.progress?.begin("full-scan", "scanning");
    ctx.currentSyncPromise = executeFullScan(ctx);

    try {
        await ctx.currentSyncPromise;
        // An interrupted scan hands over to the smart sync that interrupted it.
        if (!ctx.isInterrupted) ctx.progress?.finish("ok");
    } catch (e) {
        ctx.progress?.finish("error", String(e).slice(0, 80));
        throw e;
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

        if (!ctx.fullScanProgress) {
            await ctx.log("[Full Scan] Fetching file lists...", "debug");
            const localFiles = await getLocalFiles(ctx);
            const remoteFiles = await ctx.adapter.listFiles();

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

        // Process remote files in chunks
        while (ctx.fullScanProgress.currentIndex < remoteFiles.length) {
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
                        const localHash = contentFingerprint(content);
                        if (cloudHashMatches(ctx.adapter, remoteFile.hash, localHash)) {
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
            ctx.progress?.scanProgress(ctx.fullScanProgress.currentIndex, remoteFiles.length);

            // Yield to allow interrupt check
            await new Promise((resolve) => window.setTimeout(resolve, 0));
        }

        await ctx.log("=== BACKGROUND FULL SCAN COMPLETED ===", "info");
        ctx.fullScanProgress = null;
        await saveIndex(ctx);
    } catch (e) {
        await ctx.log(`[Full Scan] Error: ${String(e)}`, "error");
        ctx.fullScanProgress = null;
    } finally {
        await ctx.logger.endCycle();
    }
}
