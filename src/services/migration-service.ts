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
            // Check if it's very old (e.g. 1 hour)
            const hourAgo = Date.now() - 3600 * 1000;
            if (existingLock.timestamp > hourAgo) {
                throw new Error(
                    `Another device (${existingLock.deviceId}) is migrating this vault.`,
                );
            }
        }

        // 1. Create Lock
        await this.lockService.createMigrationLock(this.ctx.deviceId);

        // 2. Set State to block other syncs
        this.ctx.syncState = "MIGRATING";
        this.isMigrating = true;

        // 3. Initialize Engine (GENERATE MASTER KEY)
        this.pendingVaultLockData = await this.engine.initializeNewVault(password);

        // 4. Prepare Temp Adapter
        const GDriveAdapterClass = this.baseAdapter.constructor as any;
        const tempAdapter = new GDriveAdapterClass(
            (this.baseAdapter as any)._clientId,
            (this.baseAdapter as any)._clientSecret,
            `${this.baseAdapter.vaultName}-Temp-Encrypted`,
            (this.baseAdapter as any).cloudRootFolder,
        );
        tempAdapter.setTokens(
            (this.baseAdapter as any).accessToken,
            (this.baseAdapter as any).refreshToken,
        );
        tempAdapter.setLogger((msg: string) => console.log(`[Migration] ${msg}`));

        await tempAdapter.initialize();

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

            current++;
        }
    }

    /**
     * Finalize: Rename folders and upload vault-lock.json.
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

        // 4. Final Swap
        const backupName = `${vaultName}-Backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;

        if (originalId) {
            await this.lockService.renameFolder(originalId, backupName);
        }

        await this.lockService.renameFolder(tempId, vaultName);

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
            const tempName = `${this.baseAdapter.vaultName}-Temp-Encrypted`;
            const appRootId = (this.baseAdapter as any).getAppRootId
                ? await (this.baseAdapter as any).getAppRootId()
                : null;
            const tempId = await this.lockService.getFolderId(tempName, appRootId);
            return !!tempId;
        } catch (e) {
            return false;
        }
    }
}
