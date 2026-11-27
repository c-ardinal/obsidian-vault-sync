import { CloudAdapter, VaultFolderSwapError } from "../types/adapter";
import { remoteDeletionOf } from "../sync-manager/remote-deletion";
import { ICryptoEngine } from "../encryption/interfaces";
import { converterAmong, MIGRATION_LOCK_FILENAME, MIGRATION_LOCK_STALE_MS, VaultLockService } from "./vault-lock-service";
import type { LocalFileIndex } from "../sync-manager/types";
import { EncryptedAdapter } from "../encryption/encrypted-adapter";
import {
    getLocalFiles,
    shouldIgnore,
    isManagedSeparately,
    isAlwaysForbiddenOnRemote,
    runParallel,
    hashContent,
    ensureLocalFolder,
} from "../sync-manager/file-utils";
import { freeConflictCopyPath } from "../sync-manager/conflict-resolution";
import { markDeleted, saveIndex, saveLocalIndex } from "../sync-manager/state";
import { SyncContext } from "../sync-manager/context";
import { listDevices } from "../sync-manager/device-registry";
import { conversionBaseOf, parseConversionBase, restoreKnownVaultRoot } from "../sync-manager/vault-folder";
import { deletedVersionKnown, markIndexUploadOwed, refreshDeletionMarks, relistForOthersAdd } from "../sync-manager/sync-helpers";
import { REMOTE_FILES } from "../sync-manager/remote-layout";

interface MigrationProgress {
    current: number;
    total: number;
    fileName: string;
}

/**
 * How long the old folder is kept after the swap. A sync another device started
 * before the migration lock appeared can still push into the old folder after
 * the catch-up read it; such a cycle ends well within this time, and later
 * cycles stop at the migration lock that stays in the old folder.
 */
export const BACKUP_CLEANUP_GRACE_MS = 60 * 60 * 1000;

/** The old folder kept after a conversion, and what the catch-up read from it */
export interface PendingBackupCleanup {
    backupName: string;
    backupId: string;
    /** Not before this time (ms) */
    notBefore: number;
    /** Cloud hash of each file of the old folder when the catch-up read it */
    scan: Record<string, string>;
    /**
     * Plaintext hash of the version of each file the catch-up left here: a local
     * file still at it was not changed on this device since.
     */
    base: Record<string, string>;
    /** Cloud id of each file of the old folder when the catch-up read it */
    ids?: Record<string, string>;
    /** The converted vault's file of each path at the swap: cloud id and hash */
    converted?: Record<string, { id: string; hash: string }>;
}

export class MigrationService {
    private pendingLockBlob: string | null = null;
    /**
     * Cloud hash of every file as this device last synced it, taken before the
     * conversion rewrites the index: a vault file whose cloud hash differs at
     * the end was changed by another device (see catchUpOtherDevices).
     */
    private syncedHashes = new Map<string, string | undefined>();
    /** Paths with local edits not yet pushed when the conversion started */
    private dirtyAtStart = new Set<string>();
    /**
     * Plaintext hash of every file as this device last synced it. A file counts
     * as untouched here only when its converted copy is still that version: an
     * edit made after the conversion started, but before the file was read,
     * is in the converted copy and must not be replaced by another device's.
     */
    private syncedPlainHashes = new Map<string, string | undefined>();
    /** What the catch-up read from the old folder (see finishBackupCleanup) */
    private scan: Record<string, string> = {};
    private scanBase: Record<string, string> = {};
    private scanIds: Record<string, string> = {};
    /**
     * The index of the converted vault, built file by file during the run and
     * put in place of the device's indexes only once the folders are swapped.
     * Until then the device's own indexes describe the old folder: a run that
     * fails, is given up or dies with the app leaves them as they were.
     */
    private conv: LocalFileIndex = {};
    /**
     * Files of the vault this device leaves out by its own settings (they sync
     * between the other devices): converted from cloud to cloud, never held
     * here. Part of the converted vault's shared index, not of this device's own.
     */
    private carried: LocalFileIndex = {};
    /** Cloud ids of the migration lock(s) this run created */
    private ownLockIds: string[] = [];
    /** The vault folder as it was when this run started */
    private startRootId: string | null = null;
    /** undefined until read from disk */
    private pendingCleanup: PendingBackupCleanup | null | undefined = undefined;
    private cleanupRunning = false;
    /** The folders were looked at since the app started (see recoverInterruptedSwap) */
    private swapChecked = false;
    public isMigrating = false;
    public currentProgress: MigrationProgress | null = null;

    constructor(
        private baseAdapter: CloudAdapter,
        private lockService: VaultLockService,
        private ctx: SyncContext,
    ) {
        this.guardVaultFolderCreation();
    }

    private get engine(): ICryptoEngine {
        if (!this.ctx.cryptoEngine) {
            throw new Error("E2EE Engine not loaded.");
        }
        return this.ctx.cryptoEngine;
    }

    /**
     * Start the migration process.
     * 1. Create migration.lock
     * 2. Prepare temporary encrypted adapter.
     */
    async startMigration(password: string): Promise<CloudAdapter> {
        if (this.ctx.syncState !== "IDLE") {
            throw new Error(
                `Cannot start migration: Sync engine is in ${this.ctx.syncState} state.`,
            );
        }
        if (await this.lockService.checkForLockFile()) {
            throw new Error("Vault is already encrypted (vault-lock.vault exists).");
        }

        const existingLock = await this.lockService.getMigrationLock();
        if (existingLock && existingLock.deviceId !== this.ctx.deviceId) {
            // Check if it's very old (24 hours for large vaults)
            const dayAgo = Date.now() - MIGRATION_LOCK_STALE_MS;
            if (existingLock.timestamp > dayAgo) {
                throw new Error(
                    `Another device (${existingLock.deviceId}) is migrating this vault. ` +
                        `Migration lock will expire in ${Math.ceil((existingLock.timestamp + 24 * 3600 * 1000 - Date.now()) / 3600000)} hours.`,
                );
            }
            await this.ctx.log(
                `[Migration] Overriding stale migration lock from device ${existingLock.deviceId} (older than 24 hours)`,
                "warn",
            );
        }

        this.ownLockIds.push((await this.lockService.createMigrationLock(this.ctx.deviceId)).id);
        // The cloud cannot create "only if absent": another device may have left
        // its lock at the same moment. Both read the locks back, and all but one
        // give up before anything is converted.
        const rival = await this.rivalConverter();
        if (rival) {
            await this.removeOwnLocks();
            throw new Error(`Another device (${rival}) is migrating this vault.`);
        }
        this.startRootId = await this.lockService.getFolderId(this.baseAdapter.vaultName);
        this.conv = {};
        this.carried = {};
        this.syncedHashes = new Map(Object.entries(this.ctx.index).map(([p, e]) => [p, e.hash]));
        this.dirtyAtStart = new Set(this.ctx.dirtyPaths?.keys() ?? []);
        this.syncedPlainHashes = new Map(
            Object.entries(this.ctx.localIndex).map(([p, e]) => [p, e.plainHash]),
        );

        this.ctx.syncState = "MIGRATING";
        this.isMigrating = true;

        // initializeNewVault generates the master key
        this.pendingLockBlob = await this.engine.initializeNewVault(password);

        const tempAdapter = this.baseAdapter.cloneWithNewVaultName(this.tempName);

        tempAdapter.setLogger((msg: string) => console.debug(`[Migration] ${msg}`));
        if (tempAdapter.initialize) {
            await tempAdapter.initialize();
        }

        return new EncryptedAdapter(tempAdapter, this.engine, 0);
    }

    /**
     * A conversion swaps the folders with two renames, and no folder has the
     * vault's name in between. A device that looked for the vault folder then
     * would create an empty one, and the converted folder could not take the
     * name any more. The converted folder waiting next to the place tells: no
     * vault folder is created while one is there. (One older than the lock's
     * life is what an abandoned run left.)
     */
    private guardVaultFolderCreation(): void {
        const prefix = `${this.baseAdapter.vaultName}-Temp-Encrypted-`;
        this.baseAdapter.beforeVaultRootCreate = async (siblings) => {
            const fresh = Date.now() - MIGRATION_LOCK_STALE_MS;
            if (siblings.some((f) => f.name.startsWith(prefix) && f.modifiedTime > fresh)) throw new VaultFolderSwapError();
        };
    }

    /**
     * One temporary folder per device: two devices that got past each other's
     * lock must never write files of two different keys into one folder.
     */
    private get tempName(): string {
        return `${this.baseAdapter.vaultName}-Temp-Encrypted-${this.ctx.deviceId}`;
    }

    /** The other device that converts this vault and goes first, if any */
    private async rivalConverter(): Promise<string | null> {
        const first = converterAmong(await this.lockService.listMigrationLocks(), Date.now());
        return first && first.deviceId !== this.ctx.deviceId ? first.deviceId : null;
    }

    private async removeOwnLocks(): Promise<void> {
        for (const id of this.ownLockIds.splice(0)) {
            try {
                await this.lockService.removeMigrationLockById(id);
            } catch (e) {
                await this.ctx.log(`[Migration] Could not remove the migration lock: ${String(e)}`, "warn");
            }
        }
    }

    /**
     * Give this run up: its temporary folder and its lock go, the device's
     * indexes were never touched. The vault folder is left alone.
     */
    private async abandon(): Promise<void> {
        const tempId = await this.lockService.getFolderId(this.tempName);
        if (tempId) {
            await remoteDeletionOf(this.ctx).remove(
                this.baseAdapter,
                { id: tempId, path: this.tempName, kind: "folder" },
                "maintenance",
            );
        }
        await this.removeOwnLocks();
        this.conv = {};
        this.ctx.syncState = "IDLE";
        this.pendingLockBlob = null;
        this.isMigrating = false;
        this.currentProgress = null;
    }

    /**
     * Run the bulk upload of encrypted files.
     */
    async runMigration(
        tempEncryptedAdapter: CloudAdapter,
        onProgress: (p: MigrationProgress) => void,
    ): Promise<void> {
        const files = await getLocalFiles(this.ctx);
        const filteredFiles = files.filter((f) => !shouldIgnore(this.ctx, f.path));
        const total = filteredFiles.length;
        const verificationSamples: Array<{
            path: string;
            originalContent: ArrayBuffer;
            fileId: string;
        }> = [];
        let current = 0;
        const concurrency = this.ctx.settings.concurrency || 5;

        const tasks = filteredFiles.map((file) => async () => {
            const p = { current: ++current, total, fileName: file.path };
            this.currentProgress = p;
            onProgress(p);

            const content = await this.ctx.vault.readBinary(file.path);

            const result = await this.uploadConverted(tempEncryptedAdapter, file.path, content, file.mtime);

            // Collect samples for integrity verification (up to 5, distributed)
            if (verificationSamples.length < 5 && current % Math.ceil(total / 5) === 0) {
                verificationSamples.push({
                    path: file.path,
                    originalContent: content,
                    fileId: result.id,
                });
            }
        });

        await runParallel(tasks, concurrency);

        await this.ctx.log("[Migration] Verifying encryption integrity...", "info");
        for (const sample of verificationSamples) {
            try {
                const downloadedContent = await tempEncryptedAdapter.downloadFile(sample.fileId);

                const downloadedArray = new Uint8Array(downloadedContent);
                const originalArray = new Uint8Array(sample.originalContent);

                if (downloadedArray.length !== originalArray.length) {
                    throw new Error(
                        `Integrity check failed for ${sample.path}: Size mismatch ` +
                            `(original: ${originalArray.length}, downloaded: ${downloadedArray.length})`,
                    );
                }

                for (let i = 0; i < originalArray.length; i++) {
                    if (originalArray[i] !== downloadedArray[i]) {
                        throw new Error(
                            `Integrity check failed for ${sample.path}: Content mismatch at byte ${i}`,
                        );
                    }
                }

                await this.ctx.log(`[Migration] Verified integrity: ${sample.path}`, "debug");
            } catch (e) {
                await this.ctx.log(`[Migration] Integrity verification failed: ${String(e)}`, "error");
                throw new Error(
                    `Migration aborted: Encryption/decryption integrity check failed. ${String(e)}`,
                );
            }
        }
        await this.ctx.log("[Migration] All integrity checks passed", "info");
    }

    /**
     * Upload one file into the converted vault and record it in the index of the
     * converted vault (this.conv): the new (encrypted) cloud hash, so the first
     * sync after the conversion sees no change, and the plaintext hash for change
     * detection.
     */
    private async uploadConverted(
        tempEncryptedAdapter: CloudAdapter,
        path: string,
        content: ArrayBuffer,
        mtime: number,
        existingFileId?: string,
    ): Promise<{ id: string; hash?: string; size: number }> {
        const result = existingFileId
            ? await tempEncryptedAdapter.uploadFile(path, content, mtime, existingFileId)
            : await tempEncryptedAdapter.uploadFile(path, content, mtime);
        const plainHash = await hashContent(content);
        const entry = this.conv[path] || this.ctx.localIndex[path] || { path, size: content.byteLength, mtime };
        this.conv[path] = {
            ...entry,
            hash: result.hash,
            plainHash,
            ancestorHash: result.hash, // Current version is now remote version
            size: result.size,
            mtime,
            fileId: result.id,
        };
        return result;
    }

    /** In the vault, but left out of sync on this device by its own settings */
    private leftOutHereOnly(path: string): boolean {
        return !isManagedSeparately(path) && !isAlwaysForbiddenOnRemote(path);
    }

    /** Convert a file this device does not hold: cloud to cloud, nothing is written here */
    private async carryOver(
        target: CloudAdapter,
        path: string,
        content: ArrayBuffer,
        mtime: number,
        existingFileId?: string,
    ): Promise<LocalFileIndex[string]> {
        const result = existingFileId
            ? await target.uploadFile(path, content, mtime, existingFileId)
            : await target.uploadFile(path, content, mtime);
        return {
            fileId: result.id,
            hash: result.hash,
            plainHash: await hashContent(content),
            ancestorHash: result.hash,
            size: result.size,
            mtime,
        } as LocalFileIndex[string];
    }

    /** Plaintext hash of the local file, or null when there is none */
    private async localHash(path: string): Promise<string | null> {
        if (!(await this.ctx.vault.exists(path))) return null;
        return hashContent(await this.ctx.vault.readBinary(path));
    }

    /**
     * Bring in what other devices pushed to the vault that this device has not:
     * edits and deletions made before the conversion and not pulled yet, and
     * everything other devices pushed while it ran (devices that started a sync
     * before the migration lock existed, or run an older version that ignores
     * it). All of it sits in the old folder, which is not synced after the swap.
     *
     * A file this device had not touched takes the other device's version (or is
     * deleted with it), here and in the converted vault. When this device changed
     * it too, the other device's version is kept as a conflict copy next to it,
     * and a deletion gives way to the edit made here.
     */
    private async catchUpOtherDevices(tempEncryptedAdapter: CloudAdapter): Promise<void> {
        const remoteFiles = await this.baseAdapter.listFiles();
        this.scan = {};
        this.scanBase = {};
        this.scanIds = {};
        const seen = new Set<string>();
        for (const f of remoteFiles) {
            if (f.kind !== "file" || f.path === MIGRATION_LOCK_FILENAME) continue;
            if (shouldIgnore(this.ctx, f.path)) {
                if (!this.leftOutHereOnly(f.path)) continue;
                // Nothing of it is here: without this, the vault would lose it with
                // the old folder unless a device that holds it sends it again
                seen.add(f.path);
                this.scan[f.path] = f.hash ?? "";
                this.scanIds[f.path] = f.id;
                const content = await this.baseAdapter.downloadFile(f.id);
                this.carried[f.path] = await this.carryOver(tempEncryptedAdapter, f.path, content, f.mtime);
                this.scanBase[f.path] = this.carried[f.path].plainHash as string;
                continue;
            }
            seen.add(f.path);
            this.scan[f.path] = f.hash ?? "";
            this.scanIds[f.path] = f.id;
            const synced = this.syncedHashes.get(f.path);
            const syncedPlain = this.syncedPlainHashes.get(f.path);
            if (f.hash && synced && f.hash === synced) {
                if (syncedPlain !== undefined) this.scanBase[f.path] = syncedPlain;
                continue;
            }

            const content = await this.baseAdapter.downloadFile(f.id);
            const remotePlain = await hashContent(content);
            this.scanBase[f.path] = remotePlain;
            const converted = this.conv[f.path];
            if (converted?.plainHash === remotePlain) continue; // same content as converted

            const localNow = await this.localHash(f.path);
            if (localNow === remotePlain) continue;
            let untouched = localNow === null ? !converted : this.untouchedSinceStart(f.path, localNow);

            if (untouched) {
                // Check again right before replacing it: the note may have been
                // saved here while the checks above were waiting on the disk
                await ensureLocalFolder(this.ctx, f.path);
                if ((await this.localHash(f.path)) !== localNow) untouched = false;
            }
            let target = f.path;
            let existingFileId: string | undefined = converted?.fileId;
            if (!untouched) {
                target = await freeConflictCopyPath((p) => this.ctx.vault.exists(p), f.path);
                existingFileId = undefined;
                await ensureLocalFolder(this.ctx, target);
            }
            await this.ctx.vault.writeBinary(target, content);
            await this.uploadConverted(tempEncryptedAdapter, target, content, Date.now(), existingFileId);
            await this.ctx.log(
                untouched
                    ? `[Migration] Took another device's version of ${f.path}.`
                    : `[Migration] ${f.path} was changed here and on another device: kept theirs as ${target}.`,
                "info",
            );
        }

        // Deleted on another device: synced here, gone from the old folder
        for (const path of this.syncedHashes.keys()) {
            if (seen.has(path) || path === MIGRATION_LOCK_FILENAME || shouldIgnore(this.ctx, path)) continue;
            const converted = this.conv[path];
            const localNow = await this.localHash(path);
            if (localNow !== null) {
                if (!this.untouchedSinceStart(path, localNow)) continue; // the edit here wins
                if ((await this.localHash(path)) !== localNow) continue;
                await this.removeLocal(path);
            }
            if (converted?.fileId) {
                await remoteDeletionOf(this.ctx).remove(
                    tempEncryptedAdapter,
                    { id: converted.fileId, path, kind: "file" },
                    "maintenance",
                );
            }
            delete this.conv[path];
            await this.ctx.log(`[Migration] ${path} was deleted on another device: deleted it here too.`, "info");
        }
    }

    /**
     * Delete a local file: to the system trash when it is a vault file, directly
     * when only the adapter sees it (files under the config folder)
     */
    private async removeLocal(path: string): Promise<void> {
        const file = this.ctx.vault.getAbstractFileByPath(path);
        if (file) await this.ctx.vault.trashFile(file, true);
        else await this.ctx.vault.remove(path);
    }

    /**
     * The local file and its converted copy are both still the version this
     * device last synced: an edit made after the conversion started, but before
     * the file was read, is in the converted copy and must win.
     */
    private untouchedSinceStart(path: string, localNow: string): boolean {
        const syncedPlain = this.syncedPlainHashes.get(path);
        return (
            !this.dirtyAtStart.has(path) &&
            syncedPlain !== undefined &&
            this.conv[path]?.plainHash === syncedPlain &&
            localNow === syncedPlain
        );
    }

    private get cleanupRecordPath(): string {
        return `${this.ctx.pluginDir}/data/local/migration-backup.json`;
    }

    private async loadPendingCleanup(): Promise<PendingBackupCleanup | null> {
        if (this.pendingCleanup === undefined) {
            try {
                this.pendingCleanup = (await this.ctx.vault.exists(this.cleanupRecordPath))
                    ? (JSON.parse(await this.ctx.vault.read(this.cleanupRecordPath)) as PendingBackupCleanup)
                    : null;
            } catch {
                this.pendingCleanup = null;
            }
        }
        return this.pendingCleanup;
    }

    private async savePendingCleanup(rec: PendingBackupCleanup | null): Promise<void> {
        this.pendingCleanup = rec;
        if (rec) {
            await ensureLocalFolder(this.ctx, this.cleanupRecordPath);
            await this.ctx.vault.write(this.cleanupRecordPath, JSON.stringify(rec));
        } else if (await this.ctx.vault.exists(this.cleanupRecordPath)) {
            await this.ctx.vault.remove(this.cleanupRecordPath);
        }
    }

    /**
     * The app stopped while this device was swapping the folders. The record of
     * the old folder is written right before the swap, so it tells how far the
     * swap got; called before the first sync after a start, before anything
     * looks the vault folder up (a vault folder that is missing would be made
     * anew, empty).
     * - nothing renamed yet: the run is given up (temporary folder and lock go)
     * - the old folder renamed away, the new one not yet in place: the swap is
     *   completed (everything was uploaded before it began)
     * - both renamed: nothing to do. This device's indexes still describe the
     *   old folder, and its next sync follows the conversion like any device.
     */
    async recoverInterruptedSwap(): Promise<void> {
        if (this.swapChecked || this.isMigrating) return;
        const rec = await this.loadPendingCleanup();
        if (!rec) {
            this.swapChecked = true;
            return;
        }
        const vaultName = this.baseAdapter.vaultName;
        const appRootId = await this.baseAdapter.getAppRootId();
        const primaryId = await this.lockService.getFolderId(vaultName, appRootId);
        if (primaryId === rec.backupId) {
            await this.ctx.log("[Migration] The conversion stopped before the folders were swapped: giving it up.", "warn");
            await this.savePendingCleanup(null);
            await this.cancelMigration();
        } else if (!primaryId) {
            const backupId = await this.lockService.getFolderId(rec.backupName, appRootId);
            const tempId = await this.lockService.getFolderId(this.tempName, appRootId);
            if (backupId === rec.backupId && tempId) {
                await this.lockService.renameFolder(tempId, vaultName);
                await this.ctx.log("[Migration] Completed the folder swap an earlier run had begun.", "warn");
            } else if (backupId === rec.backupId) {
                await this.lockService.renameFolder(backupId, vaultName);
                await this.savePendingCleanup(null);
                await this.ctx.log("[Migration] Restored the vault folder an earlier run had renamed.", "warn");
            }
            this.baseAdapter.reset();
        }
        this.swapChecked = true;
    }

    /**
     * Once the grace time after a conversion has passed: bring in what other
     * devices pushed into the old folder after the catch-up read it, then delete
     * the old folder. Called before a sync; the files it changes here are marked
     * so that this sync takes them to the converted vault (merging with whatever
     * reached it meanwhile, as for any local edit).
     */
    async finishBackupCleanup(): Promise<void> {
        if (this.cleanupRunning || this.isMigrating || this.ctx.syncState !== "IDLE") return;
        const rec = await this.loadPendingCleanup();
        if (!rec || Date.now() < rec.notBefore) return;
        this.cleanupRunning = true;
        try {
            const appRootId = await this.baseAdapter.getAppRootId();
            const folderId = await this.lockService.getFolderId(rec.backupName, appRootId);
            if (folderId !== rec.backupId) {
                // Removed (or replaced) by hand: nothing left to bring in
                await this.savePendingCleanup(null);
                return;
            }
            const backup = this.baseAdapter.cloneWithNewVaultName(rec.backupName);
            if (backup.initialize) await backup.initialize();
            const files = await backup.listFiles();
            const scannedAt = new Map(Object.entries(rec.ids ?? {}).map(([p, id]) => [id, p]));
            const movedTo = new Map(files.filter((f) => f.kind === "file").map((f) => [f.id, f.path]));
            // What was deleted in the converted vault since the swap, as of now: a
            // late version its own device has carried over meanwhile may be among it
            await refreshDeletionMarks(this.ctx);
            const seen = new Set<string>();
            for (const f of files) {
                if (f.kind !== "file" || f.path === MIGRATION_LOCK_FILENAME) continue;
                if (shouldIgnore(this.ctx, f.path)) {
                    if (this.leftOutHereOnly(f.path) && !(f.hash && rec.scan[f.path] === f.hash)) {
                        await this.carryLateLeftOut(backup, f, rec);
                    }
                    continue;
                }
                seen.add(f.path);
                if (f.hash && rec.scan[f.path] === f.hash) continue;
                // Renamed late, content as converted: the rename is completed below
                // (the content is in the vault under the old name)
                const was = scannedAt.get(f.id);
                if (was !== undefined && was !== f.path && f.hash && rec.scan[was] === f.hash) continue;
                const content = await backup.downloadFile(f.id);
                const remotePlain = await hashContent(content);
                const localNow = await this.localHash(f.path);
                if (localNow === remotePlain) continue;
                if (deletedVersionKnown(this.ctx, f.path, remotePlain)) {
                    await this.ctx.log(
                        `[Migration] ${f.path} in the old folder is a version deleted in the vault since: not taken.`,
                        "info",
                    );
                    continue;
                }
                const base = rec.base[f.path];
                let untouched = base === undefined ? localNow === null : localNow === base;
                if (untouched) {
                    // Check again right before replacing it: the note may have been
                    // saved here while the checks above were waiting on the disk
                    await ensureLocalFolder(this.ctx, f.path);
                    if ((await this.localHash(f.path)) !== localNow) untouched = false;
                }
                const target = untouched
                    ? f.path
                    : await freeConflictCopyPath((p) => this.ctx.vault.exists(p), f.path);
                if (!untouched) await ensureLocalFolder(this.ctx, target);
                await this.ctx.vault.writeBinary(target, content);
                this.ctx.dirtyPaths.set(target, Date.now());
                // Taken: a retry after a later failure must not take it again
                rec.scan[f.path] = f.hash ?? "";
                if (untouched) rec.base[f.path] = remotePlain;
                await this.savePendingCleanup(rec);
                await this.ctx.log(
                    untouched
                        ? `[Migration] Took another device's late version of ${f.path} from the old folder.`
                        : `[Migration] ${f.path} was changed here and late on another device: kept theirs as ${target}.`,
                    "info",
                );
            }
            for (const path of Object.keys(rec.scan)) {
                // Left out of sync since (scope changed): not a deletion
                if (seen.has(path) || shouldIgnore(this.ctx, path)) continue;
                const localNow = await this.localHash(path);
                if (localNow === null || localNow !== rec.base[path]) continue; // the edit here wins
                // A deletion made before the swap is carried out on the file the
                // conversion made, and on nothing that took its place since
                const conv = rec.converted?.[path];
                if (!conv) continue;
                const cur = await this.ctx.adapter.getFileMetadataById(conv.id, path);
                if (!cur || cur.path !== path || cur.hash?.toLowerCase() !== conv.hash.toLowerCase()) continue;
                // Renamed late: only once the note is in the vault under its new name
                const oldId = rec.ids?.[path];
                const newPath = oldId ? movedTo.get(oldId) : undefined;
                if (newPath !== undefined && !(await this.ctx.adapter.getFileMetadata(newPath))) continue;
                if ((await this.localHash(path)) !== localNow) continue;
                await this.removeLocal(path);
                markDeleted(this.ctx, path);
                delete rec.scan[path];
                await this.savePendingCleanup(rec);
                await this.ctx.log(`[Migration] ${path} was deleted late on another device: deleted it here too.`, "info");
            }
            // Everything pushed into the old folder late is here now: the devices that
            // follow from now on need not look into it (and it is about to go)
            await this.markConversionCleaned();
            await remoteDeletionOf(this.ctx).remove(
                this.baseAdapter,
                { id: rec.backupId, path: rec.backupName, kind: "folder" },
                "maintenance",
            );
            await this.ctx.log(`[Migration] Deleted backup folder: ${rec.backupName}`, "info");
            await this.savePendingCleanup(null);
            await this.ctx.notify("noticeBackupDeleted");
        } catch (e) {
            await this.ctx.log(`[Migration] Backup folder cleanup failed (retried later): ${String(e)}`, "warn");
        } finally {
            this.cleanupRunning = false;
        }
    }

    /**
     * A file this device leaves out, pushed into the old folder late: taken over
     * from cloud to cloud when the vault still holds what the conversion made
     * of it (or nothing under this name). Otherwise the vault moved on, and the
     * device that pushed it settles the two versions when it follows.
     */
    private async carryLateLeftOut(
        backup: CloudAdapter,
        f: { id: string; path: string; mtime: number },
        rec: PendingBackupCleanup,
    ): Promise<void> {
        const conv = rec.converted?.[f.path];
        if (conv) {
            const cur = await this.ctx.adapter.getFileMetadataById(conv.id, f.path);
            if (!cur || cur.path !== f.path || cur.hash?.toLowerCase() !== conv.hash.toLowerCase()) return;
        } else if (await this.ctx.adapter.getFileMetadata(f.path)) return;
        const content = await backup.downloadFile(f.id);
        if (deletedVersionKnown(this.ctx, f.path, await hashContent(content))) return;
        // (this device's own index never lists a file it leaves out: the shared
        // index is told through the list kept for that)
        relistForOthersAdd(this.ctx, f.path, await this.carryOver(this.ctx.adapter, f.path, content, f.mtime, conv?.id));
        markIndexUploadOwed(this.ctx);
        await this.ctx.log(`[Migration] Brought ${f.path} (left out on this device) over from the old folder.`, "info");
    }

    private async markConversionCleaned(): Promise<void> {
        const path = `${this.ctx.pluginDir}/${REMOTE_FILES.conversionBase}`;
        const meta = await this.ctx.adapter.getFileMetadata(path);
        if (!meta) return;
        const base = parseConversionBase(new TextDecoder().decode(await this.ctx.adapter.downloadFile(meta.id)));
        if (base.cleaned) return;
        await this.ctx.adapter.uploadFile(
            path,
            new TextEncoder().encode(JSON.stringify({ ...base, cleaned: true })).buffer,
            Date.now(),
            meta.id,
        );
    }

    /**
     * Finalize: Rename folders and upload vault-lock.vault.
     * Implements atomic folder swap with recovery capabilities.
     */
    async finalizeMigration(tempEncryptedAdapter: CloudAdapter): Promise<void> {
        if (!this.pendingLockBlob) {
            throw new Error("Missing lock data. Start migration correctly first.");
        }
        const lockBlob = this.pendingLockBlob;

        const vaultName = this.baseAdapter.vaultName;
        const tempName = this.tempName;

        const appRootId = await this.baseAdapter.getAppRootId();

        const originalId = await this.lockService.getFolderId(vaultName, appRootId);
        const tempId = await this.lockService.getFolderId(tempName, appRootId);

        if (!tempId) throw new Error("Temporary encrypted folder not found.");
        await this.assertStillTheConverter(originalId);

        // Last, so that it also covers what other devices pushed during the upload
        await this.catchUpOtherDevices(tempEncryptedAdapter);

        await this.ctx.log(
            `[Migration] Finalizing swap. Original: ${originalId}, Temp: ${tempId}`,
            "info",
        );

        // 3. Upload vault-lock.vault AND remote-index.json to the TEMP folder BEFORE swapping
        // This ensures the new vault is valid as soon as it takes the primary name.
        const tempBaseAdapter = tempEncryptedAdapter.getBaseAdapter?.() ?? tempEncryptedAdapter;
        await this.lockService.uploadLockFileToAdapter(tempBaseAdapter, lockBlob);

        // Also save the current index state (as encrypted) to the temp folder
        const indexContent = new TextEncoder().encode(
            JSON.stringify({ index: { ...this.carried, ...this.conv } }),
        ).buffer;
        await tempEncryptedAdapter.uploadFile(this.ctx.pluginDataPath, indexContent, Date.now());
        // What the converted vault holds at the swap: a device that follows later
        // tells by it a note deleted here afterwards from one that never arrived
        const soleDevice = await this.isSoleDevice();
        await tempEncryptedAdapter.uploadFile(
            `${this.ctx.pluginDir}/${REMOTE_FILES.conversionBase}`,
            new TextEncoder().encode(JSON.stringify(
                    conversionBaseOf({ ...this.carried, ...this.conv }, this.scan, this.scanIds, this.scanBase, soleDevice),
                ),).buffer,
            Date.now(),
        );

        let backupKept = false;

        // Atomic folder swap with recovery
        const backupName = `${vaultName}-Backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;

        // On disk before the swap: an app that dies right after it still knows of
        // the old folder at its next start
        if (originalId) {
            try {
                await this.savePendingCleanup({
                    backupName,
                    backupId: originalId,
                    notBefore: soleDevice ? Date.now() : Date.now() + BACKUP_CLEANUP_GRACE_MS,
                    scan: this.scan,
                    base: this.scanBase,
                    ids: this.scanIds,
                    converted: Object.fromEntries(
                        Object.entries({ ...this.carried, ...this.conv })
                            .filter(([, e]) => e.fileId && e.hash)
                            .map(([p, e]) => [p, { id: e.fileId as string, hash: e.hash as string }]),
                    ),
                });
            } catch (e) {
                await this.ctx.log(`[Migration] Could not record the backup folder for cleanup: ${String(e)}`, "warn");
            }
        }

        // The last look before the point of no return: the catch-up above can take
        // long, and another device may have converted the vault meanwhile
        try {
            await this.assertStillTheConverter(originalId);
        } catch (e) {
            await this.savePendingCleanup(null).catch(() => {});
            throw e;
        }

        try {
            if (originalId) {
                await this.lockService.renameFolder(originalId, backupName);
                await this.ctx.log(`[Migration] Renamed original to ${backupName}`, "info");
            }

            // Critical step — failure triggers recovery below
            await this.lockService.renameFolder(tempId, vaultName);
            await this.ctx.log(`[Migration] Renamed temp to ${vaultName}`, "info");
        } catch (error) {
            await this.ctx.log(
                `[Migration] Folder swap failed: ${String(error)}. Attempting recovery...`,
                "error",
            );

            await this.savePendingCleanup(null).catch(() => {});
            const currentPrimaryId = await this.lockService.getFolderId(vaultName, appRootId);
            const backupId = await this.lockService.getFolderId(backupName, appRootId);

            if (!currentPrimaryId && backupId && originalId) {
                try {
                    await this.lockService.renameFolder(backupId, vaultName);
                    await this.ctx.log(
                        "[Migration] Recovery successful - restored original vault",
                        "info",
                    );
                } catch (recoveryError) {
                    await this.ctx.log(`[Migration] Recovery failed: ${String(recoveryError)}`, "error");
                }
            }
            throw error; // Re-throw to signal migration failure
        }

        // No other device syncs this vault: nothing can still be pushed into the
        // old folder, so it is deleted at once. Otherwise it is deleted later
        // (finishBackupCleanup): a sync another device started before the
        // migration lock existed may still push into it.
        if (originalId) {
            let deleted = false;
            if (soleDevice) {
                try {
                    await remoteDeletionOf(this.ctx).remove(
                        this.baseAdapter,
                        { id: originalId, path: backupName, kind: "folder" },
                        "maintenance",
                    );
                    deleted = true;
                    await this.ctx.log(`[Migration] Deleted backup folder: ${backupName}`, "info");
                } catch (e) {
                    await this.ctx.log(
                        `[Migration] Backup folder could not be deleted now (retried at the next sync): ${String(e)}`,
                        "warn",
                    );
                }
            }
            if (deleted) await this.savePendingCleanup(null).catch(() => {});
            else backupKept = !soleDevice;
        }

        // The device's indexes describe the converted vault from here on
        this.ctx.localIndex = structuredClone(this.conv);
        this.ctx.index = structuredClone({ ...this.carried, ...this.conv });
        this.conv = {};
        this.carried = {};

        // 6. Reset adapter caches to force re-discovery of the new vaultRootId
        // This is CRITICAL to prevent syncing into the Backup folder (which has the old ID)
        this.baseAdapter.reset();
        restoreKnownVaultRoot(this.ctx, tempId);

        await saveLocalIndex(this.ctx);
        await saveIndex(this.ctx);

        // (the lock itself stays in the old folder, which is the backup now)
        this.ownLockIds = [];
        this.swapChecked = true;
        this.ctx.startPageToken = null; // Force fresh token acquisition
        this.pendingLockBlob = null;
        this.ctx.syncState = "IDLE";
        this.isMigrating = false;
        this.currentProgress = null;
        // Otherwise the folder left on the cloud looks like a failed deletion
        if (backupKept) await this.ctx.notify("noticeBackupKept");
    }

    /**
     * True when the device records on the cloud show no device but this one.
     * Every device writes its record at the first sync of a session, so a device
     * that could still be pushing has one. Unknown (records unreadable) counts
     * as "others exist".
     */
    private async isSoleDevice(): Promise<boolean> {
        try {
            const records = await listDevices({
                adapter: this.baseAdapter,
                vault: this.ctx.vault,
                pluginDir: this.ctx.pluginDir,
                deviceId: this.ctx.deviceId,
                log: this.ctx.log,
            });
            // No record at all tells nothing: only this device's own record, alone, does
            return records.length > 0 && records.every((r) => r.id === this.ctx.deviceId);
        } catch (e) {
            await this.ctx.log(`[Migration] Device records could not be read: ${String(e)}`, "warn");
            return false;
        }
    }

    /**
     * Before the folders are swapped: this device is still the one that converts,
     * and the vault folder is the one it started with, not converted by another
     * device meanwhile. Otherwise the run is given up and this throws.
     */
    private async assertStillTheConverter(originalId: string | null): Promise<void> {
        let reason: string | null = null;
        if (originalId !== this.startRootId) reason = "the vault folder was replaced";
        else if (await this.lockService.checkForLockFile()) reason = "the vault was converted on another device";
        else {
            const rival = await this.rivalConverter();
            if (rival) reason = `another device (${rival}) is migrating this vault`;
        }
        if (!reason) return;
        await this.ctx.log(`[Migration] Giving up: ${reason}.`, "warn");
        await this.abandon();
        throw new Error(`Migration stopped: ${reason}.`);
    }

    async cancelMigration(): Promise<void> {
        // Locks an earlier run of this device left behind (the app was closed)
        for (const lock of await this.lockService.listMigrationLocks()) {
            if (lock.deviceId === this.ctx.deviceId && !this.ownLockIds.includes(lock.id)) this.ownLockIds.push(lock.id);
        }
        await this.abandon();
    }

    async checkForInterruptedMigration(): Promise<boolean> {
        try {
            const vaultName = this.baseAdapter.vaultName;
            const tempName = this.tempName;
            const appRootId = await this.baseAdapter.getAppRootId();

            // Check for half-state: backup exists, temp exists, but primary missing
            const primaryId = await this.lockService.getFolderId(vaultName, appRootId);
            const tempId = await this.lockService.getFolderId(tempName, appRootId);

            const backupPattern = `${vaultName}-Backup-`;
            const allFolders = await this.baseAdapter.listFiles();
            const backupFolder = allFolders.find(
                (f) => f.kind === "folder" && f.path.startsWith(backupPattern),
            );

            if (!primaryId && backupFolder && tempId) {
                await this.ctx.log(
                    "[Migration] Detected incomplete migration - primary folder missing. Attempting auto-recovery...",
                    "warn",
                );
                try {
                    await this.lockService.renameFolder(tempId, vaultName);
                    await this.ctx.log(
                        "[Migration] Auto-recovery successful - completed migration",
                        "info",
                    );
                    return false; // Migration is now complete
                } catch (e) {
                    await this.ctx.log(`[Migration] Auto-recovery failed: ${String(e)}`, "error");
                    // Fall through to check temp folder existence
                }
            }

            return !!tempId;
        } catch {
            return false;
        }
    }
}
