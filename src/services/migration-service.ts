import { App, TFile } from "obsidian";
import { CloudAdapter } from "../types/adapter";
import { ICryptoEngine } from "../encryption/interfaces";
import { VaultLockService } from "./vault-lock-service";
import { EncryptedAdapter } from "../adapters/encrypted-adapter";
import { getLocalFiles, shouldIgnore } from "../sync-manager/file-utils";
import { SyncContext } from "../sync-manager/context";

export interface MigrationProgress {
    current: number;
    total: number;
    fileName: string;
}

export class MigrationService {
    private pendingVaultLockData: import("../encryption/interfaces").VaultLockData | null = null;
    public isMigrating = false;
    public currentProgress: MigrationProgress | null = null;

    constructor(
        private app: App,
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
        // 0. Pre-checks
        if (this.ctx.syncState !== "IDLE") {
            throw new Error(
                `Cannot start migration: Sync engine is in ${this.ctx.syncState} state.`,
            );
        }
        if (await this.lockService.checkForLockFile()) {
            throw new Error("Vault is already encrypted (vault-lock.json exists).");
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
            // Log warning when overriding stale lock
            await this.ctx.log(
                `[Migration] Overriding stale migration lock from device ${existingLock.deviceId} (older than 24 hours)`,
                "warning"
            );
        }

        // 1. Create Lock
        await this.lockService.createMigrationLock(this.ctx.deviceId);

        // 2. Set State to block other syncs
        this.ctx.syncState = "MIGRATING";
        this.isMigrating = true;

        // 3. Initialize Engine (GENERATE MASTER KEY)
        this.pendingVaultLockData = await this.engine.initializeNewVault(password);

        // 4. Prepare Temp Adapter
        let tempAdapter: CloudAdapter;
        if (this.baseAdapter.cloneWithNewVaultName) {
            // Use the clean clone method if available
            tempAdapter = this.baseAdapter.cloneWithNewVaultName(
                `${this.baseAdapter.vaultName}-Temp-Encrypted`
            );
        } else {
            // Fallback to the old way for backward compatibility
            // This should be removed once all adapters implement cloneWithNewVaultName
            const GDriveAdapterClass = this.baseAdapter.constructor as any;
            tempAdapter = new GDriveAdapterClass(
                (this.baseAdapter as any)._clientId,
                (this.baseAdapter as any)._clientSecret,
                `${this.baseAdapter.vaultName}-Temp-Encrypted`,
                (this.baseAdapter as any).cloudRootFolder,
            );
            tempAdapter.setTokens(
                (this.baseAdapter as any).accessToken,
                (this.baseAdapter as any).refreshToken,
            );
        }

        tempAdapter.setLogger((msg: string) => console.log(`[Migration] ${msg}`));
        if (tempAdapter.initialize) {
            await tempAdapter.initialize();
        }

        // Wrap with Encryption using the current engine
        return new EncryptedAdapter(tempAdapter, this.engine);
    }

    /**
     * Run the bulk upload of encrypted files.
     */
    async runMigration(
        tempEncryptedAdapter: CloudAdapter,
        onProgress: (p: MigrationProgress) => void,
    ): Promise<void> {
        // 1. Get all local files
        const files = await getLocalFiles(this.ctx);
        const total = files.length;
        const verificationSamples: Array<{ path: string; originalContent: ArrayBuffer; fileId: string }> = [];
        let current = 0;

        for (const file of files) {
            if (shouldIgnore(this.ctx, file.path)) {
                current++;
                continue;
            }

            const p = { current, total, fileName: file.path };
            this.currentProgress = p;
            onProgress(p);

            // Read unencrypted local file
            const content = await this.app.vault.adapter.readBinary(file.path);

            // Upload via EncryptedAdapter (handles encryption + IV via engine)
            const result = await tempEncryptedAdapter.uploadFile(file.path, content, file.mtime);

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
                ancestorHash: result.hash, // Current version is now remote version
                size: result.size,
                mtime: file.mtime,
                fileId: result.id, // Fixed: use fileId not id
                id: undefined, // Remove erroneous property if it exists from prev
            } as any;
            // Also update remote index cache
            this.ctx.index[file.path] = { ...this.ctx.localIndex[file.path] };

            // Collect samples for integrity verification (up to 5 files, distributed across migration)
            if (verificationSamples.length < 5 && current % Math.ceil(total / 5) === 0) {
                verificationSamples.push({
                    path: file.path,
                    originalContent: content,
                    fileId: result.id,
                });
            }

            current++;
        }

        // 3. Verify integrity of encrypted uploads
        await this.ctx.log("[Migration] Verifying encryption integrity...", "info");
        for (const sample of verificationSamples) {
            try {
                const downloadedContent = await tempEncryptedAdapter.downloadFile(sample.fileId);

                // Compare with original
                const downloadedArray = new Uint8Array(downloadedContent);
                const originalArray = new Uint8Array(sample.originalContent);

                if (downloadedArray.length !== originalArray.length) {
                    throw new Error(
                        `Integrity check failed for ${sample.path}: Size mismatch ` +
                        `(original: ${originalArray.length}, downloaded: ${downloadedArray.length})`
                    );
                }

                // Byte-by-byte comparison
                for (let i = 0; i < originalArray.length; i++) {
                    if (originalArray[i] !== downloadedArray[i]) {
                        throw new Error(
                            `Integrity check failed for ${sample.path}: Content mismatch at byte ${i}`
                        );
                    }
                }

                await this.ctx.log(`[Migration] Verified integrity: ${sample.path}`, "debug");
            } catch (e) {
                await this.ctx.log(`[Migration] Integrity verification failed: ${e}`, "error");
                throw new Error(`Migration aborted: Encryption/decryption integrity check failed. ${e}`);
            }
        }
        await this.ctx.log("[Migration] All integrity checks passed", "info");
    }

    /**
     * Finalize: Rename folders and upload vault-lock.json.
     * Implements atomic folder swap with recovery capabilities.
     */
    async finalizeMigration(tempEncryptedAdapter: CloudAdapter): Promise<void> {
        if (!this.pendingVaultLockData) {
            throw new Error("Missing lock data. Start migration correctly first.");
        }
        // 1. Get lock data
        const lockData = this.pendingVaultLockData;

        // 2. Resolve IDs
        const vaultName = this.baseAdapter.vaultName;
        const tempName = `${vaultName}-Temp-Encrypted`;

        const appRootId = (this.baseAdapter as any).getAppRootId
            ? await (this.baseAdapter as any).getAppRootId()
            : null;

        const originalId = await this.lockService.getFolderId(vaultName, appRootId);
        const tempId = await this.lockService.getFolderId(tempName, appRootId);

        if (!tempId) throw new Error("Temporary encrypted folder not found.");

        await this.ctx.log(
            `[Migration] Finalizing swap. Original: ${originalId}, Temp: ${tempId}`,
            "info",
        );

        // 3. Upload vault-lock.json AND remote-index.json to the TEMP folder BEFORE swapping
        // This ensures the new vault is valid as soon as it takes the primary name.
        const tempBaseAdapter = (tempEncryptedAdapter as any).baseAdapter;
        await this.lockService.uploadLockFileToAdapter(tempBaseAdapter, lockData);

        // Also save the current index state (as encrypted) to the temp folder
        const indexContent = new TextEncoder().encode(
            JSON.stringify({ index: this.ctx.index }),
        ).buffer;
        await tempEncryptedAdapter.uploadFile(this.ctx.pluginDataPath, indexContent, Date.now());

        // 4. Final Swap - Atomic operation with recovery
        const backupName = `${vaultName}-Backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;

        try {
            // Step 1: Rename original to backup (if it exists)
            if (originalId) {
                await this.lockService.renameFolder(originalId, backupName);
                await this.ctx.log(`[Migration] Renamed original to ${backupName}`, "info");
            }

            // Step 2: Rename temp to primary
            // This is the critical step - if it fails, we need recovery
            await this.lockService.renameFolder(tempId, vaultName);
            await this.ctx.log(`[Migration] Renamed temp to ${vaultName}`, "info");
        } catch (error) {
            // Recovery attempt: If temp rename failed, try to restore original
            await this.ctx.log(`[Migration] Folder swap failed: ${error}. Attempting recovery...`, "error");

            // Check current state
            const currentPrimaryId = await this.lockService.getFolderId(vaultName, appRootId);
            const backupId = await this.lockService.getFolderId(backupName, appRootId);

            if (!currentPrimaryId && backupId && originalId) {
                // Primary is missing but backup exists - restore it
                try {
                    await this.lockService.renameFolder(backupId, vaultName);
                    await this.ctx.log("[Migration] Recovery successful - restored original vault", "info");
                } catch (recoveryError) {
                    await this.ctx.log(`[Migration] Recovery failed: ${recoveryError}`, "error");
                }
            }
            throw error; // Re-throw to signal migration failure
        }

        // 5. Reset adapter caches to force re-discovery of the new vaultRootId
        // This is CRITICAL to prevent syncing into the Backup folder (which has the old ID)
        if ((this.baseAdapter as any).reset) {
            (this.baseAdapter as any).reset();
        }

        // 6. Persistence: Save the updated indexes to local disk
        // Since ctx is a SyncContext, we cast to avoid TS issues if it's missing helper methods
        const manager = this.ctx as any;
        if (manager.saveLocalIndex) await manager.saveLocalIndex();
        if (manager.saveIndex) await manager.saveIndex();

        // 7. Cleanup
        await this.lockService.removeMigrationLock();
        this.ctx.startPageToken = undefined as any; // Force fresh token acquisition (use any to satisfy strict null checks if type is limited)
        this.pendingVaultLockData = null;
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
        this.pendingVaultLockData = null;
        this.isMigrating = false;
        this.currentProgress = null;
    }

    async checkForInterruptedMigration(): Promise<boolean> {
        try {
            const vaultName = this.baseAdapter.vaultName;
            const tempName = `${vaultName}-Temp-Encrypted`;
            const appRootId = (this.baseAdapter as any).getAppRootId
                ? await (this.baseAdapter as any).getAppRootId()
                : null;

            // Check for half-state: backup exists, temp exists, but primary missing
            const primaryId = await this.lockService.getFolderId(vaultName, appRootId);
            const tempId = await this.lockService.getFolderId(tempName, appRootId);

            // Find any backup folders (they have timestamp suffix)
            const backupPattern = `${vaultName}-Backup-`;
            const allFolders = await this.baseAdapter.listFiles();
            const backupFolder = allFolders.find(f =>
                f.kind === 'folder' && f.path.startsWith(backupPattern)
            );

            // Recovery scenario: Primary missing, but backup and temp both exist
            if (!primaryId && backupFolder && tempId) {
                await this.ctx.log(
                    "[Migration] Detected incomplete migration - primary folder missing. Attempting auto-recovery...",
                    "warning"
                );
                try {
                    // Complete the migration by renaming temp to primary
                    await this.lockService.renameFolder(tempId, vaultName);
                    await this.ctx.log("[Migration] Auto-recovery successful - completed migration", "info");
                    return false; // Migration is now complete
                } catch (e) {
                    await this.ctx.log(`[Migration] Auto-recovery failed: ${e}`, "error");
                    // Fall through to check temp folder existence
                }
            }

            // Check if there's a temp folder indicating interrupted migration
            return !!tempId;
        } catch (e) {
            return false;
        }
    }
}
