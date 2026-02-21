import { CloudAdapter, CloudFile } from "../types/adapter";
import { PLUGIN_DIR } from "../sync-manager/file-utils";

export const VAULT_LOCK_PATH = PLUGIN_DIR + "data/remote/vault-lock.vault";
export const MIGRATION_LOCK_FILENAME = "migration.lock";

/**
 * Service for managing the vault-lock.vault and migration locks.
 * Always targets the UNENCRYPTED base adapter.
 *
 * vault-lock.vault is an opaque encrypted blob (outer AES-GCM layer).
 * The engine handles encryption/decryption internally.
 */
export class VaultLockService {
    constructor(private baseAdapter: CloudAdapter) {}

    async checkForLockFile(): Promise<boolean> {
        return (await this.baseAdapter.getFileMetadata(VAULT_LOCK_PATH)) !== null;
    }

    async downloadLockFile(): Promise<string> {
        const meta = await this.baseAdapter.getFileMetadata(VAULT_LOCK_PATH);
        if (!meta) throw new Error("vault-lock.vault not found.");
        const content = await this.baseAdapter.downloadFile(meta.id);
        return new TextDecoder().decode(content);
    }

    async uploadLockFileToAdapter(adapter: CloudAdapter, blob: string): Promise<void> {
        const content = new TextEncoder().encode(blob).buffer;
        const existing = await adapter.getFileMetadata(VAULT_LOCK_PATH);
        await adapter.uploadFile(VAULT_LOCK_PATH, content, Date.now(), existing?.id);
    }

    async uploadLockFile(blob: string): Promise<void> {
        await this.uploadLockFileToAdapter(this.baseAdapter, blob);
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
        if (!this.baseAdapter.getFolderIdByName) {
            throw new Error("Adapter does not support folder search by name");
        }
        return this.baseAdapter.getFolderIdByName(name, parentId);
    }

    async renameFolder(id: string, newName: string): Promise<void> {
        await this.baseAdapter.moveFile(id, newName, null);
    }
}
