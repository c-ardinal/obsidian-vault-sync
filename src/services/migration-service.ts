import { CloudAdapter } from "../types/adapter";
import { remoteDeletionOf } from "../sync-manager/remote-deletion";
import { ICryptoEngine } from "../encryption/interfaces";
import { MIGRATION_LOCK_FILENAME, MIGRATION_LOCK_STALE_MS, VaultLockService } from "./vault-lock-service";
import { EncryptedAdapter } from "../encryption/encrypted-adapter";
import {
    getLocalFiles,
    shouldIgnore,
    runParallel,
    hashContent,
    ensureLocalFolder,
} from "../sync-manager/file-utils";
import { freeConflictCopyPath } from "../sync-manager/conflict-resolution";
import { markDeleted, saveIndex, saveLocalIndex } from "../sync-manager/state";
import { SyncContext } from "../sync-manager/context";

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
    /** undefined until read from disk */
    private pendingCleanup: PendingBackupCleanup | null | undefined = undefined;
    private cleanupRunning = false;
    public isMigrating = false;
    public currentProgress: MigrationProgress | null = null;

    constructor(
        private baseAdapter: CloudAdapter,
        private lockService: VaultLockService,
        private ctx: SyncContext,
    ) {}

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

        await this.lockService.createMigrationLock(this.ctx.deviceId);
        this.syncedHashes = new Map(Object.entries(this.ctx.index).map(([p, e]) => [p, e.hash]));
        this.dirtyAtStart = new Set(this.ctx.dirtyPaths?.keys() ?? []);
        this.syncedPlainHashes = new Map(
            Object.entries(this.ctx.localIndex).map(([p, e]) => [p, e.plainHash]),
        );

        this.ctx.syncState = "MIGRATING";
        this.isMigrating = true;

        // initializeNewVault generates the master key
        this.pendingLockBlob = await this.engine.initializeNewVault(password);

        const tempAdapter = this.baseAdapter.cloneWithNewVaultName(
            `${this.baseAdapter.vaultName}-Temp-Encrypted`,
        );

        tempAdapter.setLogger((msg: string) => console.debug(`[Migration] ${msg}`));
        if (tempAdapter.initialize) {
            await tempAdapter.initialize();
        }

        return new EncryptedAdapter(tempAdapter, this.engine, 0);
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
     * Upload one file into the converted vault and record it in both indexes.
     * The local index gets the new (encrypted) cloud hash, so the first sync after
     * the conversion sees no change, and the plaintext hash for change detection.
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
        const entry = this.ctx.localIndex[path] || { path, size: content.byteLength, mtime };
        this.ctx.localIndex[path] = {
            ...entry,
            hash: result.hash,
            plainHash,
            ancestorHash: result.hash, // Current version is now remote version
            size: result.size,
            mtime,
            fileId: result.id,
        };
        this.ctx.index[path] = { ...this.ctx.localIndex[path] };
        return result;
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
        const seen = new Set<string>();
        for (const f of remoteFiles) {
            if (f.kind !== "file" || f.path === MIGRATION_LOCK_FILENAME) continue;
            if (shouldIgnore(this.ctx, f.path)) continue;
            seen.add(f.path);
            this.scan[f.path] = f.hash ?? "";
            const synced = this.syncedHashes.get(f.path);
            const syncedPlain = this.syncedPlainHashes.get(f.path);
            if (f.hash && synced && f.hash === synced) {
                if (syncedPlain !== undefined) this.scanBase[f.path] = syncedPlain;
                continue;
            }

            const content = await this.baseAdapter.downloadFile(f.id);
            const remotePlain = await hashContent(content);
            this.scanBase[f.path] = remotePlain;
            const converted = this.ctx.localIndex[f.path];
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
            const converted = this.ctx.localIndex[path];
            const localNow = await this.localHash(path);
            if (localNow !== null) {
                if (!this.untouchedSinceStart(path, localNow)) continue; // the edit here wins
                if ((await this.localHash(path)) !== localNow) continue;
                const file = this.ctx.vault.getAbstractFileByPath(path);
                if (file) await this.ctx.vault.trashFile(file, true);
            }
            if (converted?.fileId) {
                await remoteDeletionOf(this.ctx).remove(
                    tempEncryptedAdapter,
                    { id: converted.fileId, path, kind: "file" },
                    "maintenance",
                );
            }
            delete this.ctx.localIndex[path];
            delete this.ctx.index[path];
            await this.ctx.log(`[Migration] ${path} was deleted on another device: deleted it here too.`, "info");
        }
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
            this.ctx.localIndex[path]?.plainHash === syncedPlain &&
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
            const seen = new Set<string>();
            for (const f of files) {
                if (f.kind !== "file" || f.path === MIGRATION_LOCK_FILENAME) continue;
                if (shouldIgnore(this.ctx, f.path)) continue;
                seen.add(f.path);
                if (f.hash && rec.scan[f.path] === f.hash) continue;
                const content = await backup.downloadFile(f.id);
                const remotePlain = await hashContent(content);
                const localNow = await this.localHash(f.path);
                if (localNow === remotePlain) continue;
                const base = rec.base[f.path];
                const untouched = base === undefined ? localNow === null : localNow === base;
                const target = untouched
                    ? f.path
                    : await freeConflictCopyPath((p) => this.ctx.vault.exists(p), f.path);
                await ensureLocalFolder(this.ctx, target);
                await this.ctx.vault.writeBinary(target, content);
                this.ctx.dirtyPaths.set(target, Date.now());
                await this.ctx.log(
                    untouched
                        ? `[Migration] Took another device's late version of ${f.path} from the old folder.`
                        : `[Migration] ${f.path} was changed here and late on another device: kept theirs as ${target}.`,
                    "info",
                );
            }
            for (const path of Object.keys(rec.scan)) {
                if (seen.has(path)) continue;
                const localNow = await this.localHash(path);
                if (localNow === null || localNow !== rec.base[path]) continue; // the edit here wins
                const file = this.ctx.vault.getAbstractFileByPath(path);
                if (file) await this.ctx.vault.trashFile(file, true);
                markDeleted(this.ctx, path);
                await this.ctx.log(`[Migration] ${path} was deleted late on another device: deleted it here too.`, "info");
            }
            await remoteDeletionOf(this.ctx).remove(
                this.baseAdapter,
                { id: rec.backupId, path: rec.backupName, kind: "folder" },
                "maintenance",
            );
            await this.ctx.log(`[Migration] Deleted backup folder: ${rec.backupName}`, "info");
            await this.savePendingCleanup(null);
        } catch (e) {
            await this.ctx.log(`[Migration] Backup folder cleanup failed (retried later): ${String(e)}`, "warn");
        } finally {
            this.cleanupRunning = false;
        }
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
        const tempName = `${vaultName}-Temp-Encrypted`;

        const appRootId = await this.baseAdapter.getAppRootId();

        const originalId = await this.lockService.getFolderId(vaultName, appRootId);
        const tempId = await this.lockService.getFolderId(tempName, appRootId);

        if (!tempId) throw new Error("Temporary encrypted folder not found.");

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
            JSON.stringify({ index: this.ctx.index }),
        ).buffer;
        await tempEncryptedAdapter.uploadFile(this.ctx.pluginDataPath, indexContent, Date.now());

        // Atomic folder swap with recovery
        const backupName = `${vaultName}-Backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;

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

        // The old folder is deleted later (finishBackupCleanup): a sync another
        // device started before the migration lock existed may still push into it
        if (originalId) {
            try {
                await this.savePendingCleanup({
                    backupName,
                    backupId: originalId,
                    notBefore: Date.now() + BACKUP_CLEANUP_GRACE_MS,
                    scan: this.scan,
                    base: this.scanBase,
                });
            } catch (e) {
                await this.ctx.log(`[Migration] Could not record the backup folder for cleanup: ${String(e)}`, "warn");
            }
        }

        // 6. Reset adapter caches to force re-discovery of the new vaultRootId
        // This is CRITICAL to prevent syncing into the Backup folder (which has the old ID)
        this.baseAdapter.reset();

        await saveLocalIndex(this.ctx);
        await saveIndex(this.ctx);

        await this.lockService.removeMigrationLock();
        this.ctx.startPageToken = null; // Force fresh token acquisition
        this.pendingLockBlob = null;
        this.ctx.syncState = "IDLE";
        this.isMigrating = false;
        this.currentProgress = null;
    }

    async cancelMigration(): Promise<void> {
        const tempName = `${this.baseAdapter.vaultName}-Temp-Encrypted`;
        const tempId = await this.lockService.getFolderId(tempName);
        if (tempId) {
            await remoteDeletionOf(this.ctx).remove(
                this.baseAdapter,
                { id: tempId, path: tempName, kind: "folder" },
                "maintenance",
            );
        }
        await this.lockService.removeMigrationLock();
        this.ctx.syncState = "IDLE";
        this.pendingLockBlob = null;
        this.isMigrating = false;
        this.currentProgress = null;
    }

    async checkForInterruptedMigration(): Promise<boolean> {
        try {
            const vaultName = this.baseAdapter.vaultName;
            const tempName = `${vaultName}-Temp-Encrypted`;
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
