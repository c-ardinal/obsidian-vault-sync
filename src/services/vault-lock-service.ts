import { CloudAdapter, CloudFile } from "../types/adapter";
import { LEGACY_PLUGIN_DIRS, PLUGIN_DIR } from "../sync-manager/file-utils";
import { RemoteDeletionService } from "../sync-manager/remote-deletion";

const VAULT_LOCK_SUBPATH = "data/remote/vault-lock.vault";

/** Cloud path of the vault-lock (inside this plugin's folder). */
export function vaultLockPath(): string {
    return PLUGIN_DIR + VAULT_LOCK_SUBPATH;
}

/** Where devices still on an earlier plugin ID keep the vault-lock. */
function legacyVaultLockPaths(): string[] {
    return LEGACY_PLUGIN_DIRS.map((dir) => dir + VAULT_LOCK_SUBPATH);
}
export const MIGRATION_LOCK_FILENAME = "migration.lock";
/** A migration lock older than this is a leftover of an abandoned conversion. */
export const MIGRATION_LOCK_STALE_MS = 24 * 3600 * 1000;

/**
 * Service for managing the vault-lock.vault and migration locks.
 * Always targets the UNENCRYPTED base adapter.
 *
 * vault-lock.vault is an opaque encrypted blob (outer AES-GCM layer).
 * The engine handles encryption/decryption internally.
 */
export class VaultLockService {
    constructor(
        private baseAdapter: CloudAdapter,
        private deletion: RemoteDeletionService = new RemoteDeletionService(),
    ) {}

    /**
     * The vault-lock to use: the one at this plugin's path or one at an earlier
     * plugin ID's path, whichever is newest (a device not yet updated may have changed
     * the password). Missing a lock would make this device treat an add-on vault as a
     * plain one, so every place is checked.
     */
    private async findLockFile(): Promise<CloudFile | null> {
        // This plugin's own lock first: it wins a tie.
        let newest: CloudFile | null = null;
        for (const path of [vaultLockPath(), ...legacyVaultLockPaths()]) {
            const found = await this.baseAdapter.getFileMetadata(path);
            if (found && (!newest || found.mtime > newest.mtime)) newest = found;
        }
        return newest;
    }

    async checkForLockFile(): Promise<boolean> {
        return (await this.findLockFile()) !== null;
    }

    async downloadLockFile(): Promise<string> {
        const meta = await this.findLockFile();
        if (!meta) throw new Error("vault-lock.vault not found.");
        const content = await this.baseAdapter.downloadFile(meta.id);
        return new TextDecoder().decode(content);
    }

    async uploadLockFileToAdapter(adapter: CloudAdapter, blob: string): Promise<void> {
        const content = new TextEncoder().encode(blob).buffer;
        // Devices still on an earlier plugin ID read the lock from their own path: keep
        // it there too, so they never miss that the vault uses the add-on.
        for (const path of [vaultLockPath(), ...legacyVaultLockPaths()]) {
            const existing = await adapter.getFileMetadata(path);
            await adapter.uploadFile(path, content.slice(0), Date.now(), existing?.id);
        }
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
            return JSON.parse(new TextDecoder().decode(content)) as {
                deviceId: string;
                timestamp: number;
            };
        } catch {
            return null;
        }
    }

    async removeMigrationLock(): Promise<void> {
        const meta = await this.baseAdapter.getFileMetadata(MIGRATION_LOCK_FILENAME);
        if (meta) {
            await this.deletion.remove(
                this.baseAdapter,
                { id: meta.id, path: MIGRATION_LOCK_FILENAME, kind: "file" },
                "maintenance",
            );
        }
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
