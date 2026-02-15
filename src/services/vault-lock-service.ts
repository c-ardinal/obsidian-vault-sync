import { CloudAdapter, CloudFile } from "../types/adapter";
import { VaultLockData } from "../encryption/interfaces";

export const VAULT_LOCK_FILENAME = "vault-lock.json";
export const MIGRATION_LOCK_FILENAME = "migration.lock";
export const MIN_PBKDF2_ITERATIONS = 100000; // Minimum iterations for PBKDF2 as per e2ee-plan.md

/**
 * Service for managing the vault-lock.json and migration locks.
 * Always targets the UNENCRYPTED base adapter.
 */
export class VaultLockService {
    constructor(private baseAdapter: CloudAdapter) {}

    async checkForLockFile(): Promise<boolean> {
        return (await this.baseAdapter.getFileMetadata(VAULT_LOCK_FILENAME)) !== null;
    }

    async downloadLockFile(): Promise<VaultLockData> {
        const meta = await this.baseAdapter.getFileMetadata(VAULT_LOCK_FILENAME);
        if (!meta) throw new Error("vault-lock.json not found.");
        const content = await this.baseAdapter.downloadFile(meta.id);
        const lockData: VaultLockData = JSON.parse(new TextDecoder().decode(content));

        // Validate PBKDF2 iterations if specified
        if (lockData.pbkdf2Iterations !== undefined && lockData.pbkdf2Iterations < MIN_PBKDF2_ITERATIONS) {
            console.warn(
                `[E2EE] Warning: vault-lock.json uses only ${lockData.pbkdf2Iterations} PBKDF2 iterations. ` +
                `Minimum recommended is ${MIN_PBKDF2_ITERATIONS}. Consider re-encrypting with stronger settings.`
            );
        }

        return lockData;
    }

    async uploadLockFileToAdapter(adapter: CloudAdapter, lockData: VaultLockData): Promise<void> {
        const content = new TextEncoder().encode(JSON.stringify(lockData, null, 2)).buffer;
        // Check if file exists on target adapter to update it instead of creating duplicate
        const existing = await adapter.getFileMetadata(VAULT_LOCK_FILENAME);
        await adapter.uploadFile(VAULT_LOCK_FILENAME, content, Date.now(), existing?.id);
    }

    async createMigrationLock(deviceId: string): Promise<void> {
        const content = new TextEncoder().encode(
            JSON.stringify({ deviceId, timestamp: Date.now() }),
        ).buffer;
        await this.baseAdapter.uploadFile(MIGRATION_LOCK_FILENAME, content, Date.now());
    }

    async getMigrationLock(): Promise<{ deviceId: string; timestamp: number } | null> {
        const meta = await this.baseAdapter.getFileMetadata(MIGRATION_LOCK_FILENAME);
        if (!meta) return null;
        try {
            const content = await this.baseAdapter.downloadFile(meta.id);
            return JSON.parse(new TextDecoder().decode(content));
        } catch (e) {
            return null;
        }
    }

    async removeMigrationLock(): Promise<void> {
        const meta = await this.baseAdapter.getFileMetadata(MIGRATION_LOCK_FILENAME);
        if (meta) await this.baseAdapter.deleteFile(meta.id);
    }

    async getFolderId(name: string, parentId?: string): Promise<string | null> {
        // We use listFiles to find a folder by name if we are at app root
        // But baseAdapter.getFileMetadata("") might NOT be app root, it's vault root.
        // This is where abstraction gets tricky.
        // For GoogleDrive, we can use the fetchWithAuth directly if we cast.

        // Escape single quotes to prevent query injection
        const safeName = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        let query = `name = '${safeName}' and trashed = false and mimeType = 'application/vnd.google-apps.folder'`;
        if (parentId) {
            const safeParentId = parentId.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
            query += ` and '${safeParentId}' in parents`;
        }
        const resp = await (this.baseAdapter as any).fetchWithAuth(
            `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name)`,
        );
        const data = await resp.json();
        return data.files?.[0]?.id || null;
    }

    async renameFolder(id: string, newName: string): Promise<void> {
        await this.baseAdapter.moveFile(id, newName, null);
    }
}
