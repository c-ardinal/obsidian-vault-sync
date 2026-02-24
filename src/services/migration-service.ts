import { TFile } from "obsidian";
import { CloudAdapter } from "../types/adapter";
import { ICryptoEngine } from "../encryption/interfaces";
import { VaultLockService } from "./vault-lock-service";
import { EncryptedAdapter } from "../encryption/encrypted-adapter";
import { getLocalFiles, shouldIgnore, runParallel, hashContent } from "../sync-manager/file-utils";
import { saveIndex, saveLocalIndex } from "../sync-manager/state";
import { SyncContext } from "../sync-manager/context";

interface MigrationProgress {
    current: number;
    total: number;
    fileName: string;
}

export class MigrationService {
    private pendingLockBlob: string | null = null;
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
            const dayAgo = Date.now() - 24 * 3600 * 1000;
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

        this.ctx.syncState = "MIGRATING";
        this.isMigrating = true;

        // initializeNewVault generates the master key
        this.pendingLockBlob = await this.engine.initializeNewVault(password);

        const tempAdapter = this.baseAdapter.cloneWithNewVaultName(
            `${this.baseAdapter.vaultName}-Temp-Encrypted`,
        );

        tempAdapter.setLogger((msg: string) => console.log(`[Migration] ${msg}`));
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

            const result = await tempEncryptedAdapter.uploadFile(file.path, content, file.mtime);

            // Compute plaintext hash BEFORE encryption for E2EE change detection
            const plainHash = await hashContent(content);

            // CRITICAL: Update local index with new ENCRYPTED remote hash
            // This prevents "conflict" or "download required" spikes after migration.
            const entry = this.ctx.localIndex[file.path] || {
                path: file.path,
                size: file.size,
                mtime: file.mtime,
            };
            this.ctx.localIndex[file.path] = {
                ...entry,
                hash: result.hash,
                plainHash: plainHash,
                ancestorHash: result.hash, // Current version is now remote version
                size: result.size,
                mtime: file.mtime,
                fileId: result.id,
            };
            this.ctx.index[file.path] = { ...this.ctx.localIndex[file.path] };

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
                await this.ctx.log(`[Migration] Integrity verification failed: ${e}`, "error");
                throw new Error(
                    `Migration aborted: Encryption/decryption integrity check failed. ${e}`,
                );
            }
        }
        await this.ctx.log("[Migration] All integrity checks passed", "info");
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
                `[Migration] Folder swap failed: ${error}. Attempting recovery...`,
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
                    await this.ctx.log(`[Migration] Recovery failed: ${recoveryError}`, "error");
                }
            }
            throw error; // Re-throw to signal migration failure
        }

        if (originalId) {
            try {
                await this.baseAdapter.deleteFile(originalId);
                await this.ctx.log(`[Migration] Deleted backup folder: ${backupName}`, "info");
            } catch (e) {
                await this.ctx.log(`[Migration] Failed to delete backup folder: ${e}`, "warn");
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
            await this.baseAdapter.deleteFile(tempId);
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
                    await this.ctx.log(`[Migration] Auto-recovery failed: ${e}`, "error");
                    // Fall through to check temp folder existence
                }
            }

            return !!tempId;
        } catch (e) {
            return false;
        }
    }
}
