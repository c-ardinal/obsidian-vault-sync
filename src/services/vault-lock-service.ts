import { CloudAdapter, CloudFile } from "../types/adapter";
import { LEGACY_PLUGIN_DIR, PLUGIN_DIR } from "../sync-manager/file-utils";
import { RemoteDeletionService } from "../sync-manager/remote-deletion";

const VAULT_LOCK_SUBPATH = "data/remote/vault-lock.vault";

/** Cloud path of the vault-lock (inside this plugin's folder). */
export function vaultLockPath(): string {
    return PLUGIN_DIR + VAULT_LOCK_SUBPATH;
}

/** Where devices still on the old plugin ID keep the vault-lock, if that differs. */
function legacyVaultLockPath(): string | null {
    return LEGACY_PLUGIN_DIR ? LEGACY_PLUGIN_DIR + VAULT_LOCK_SUBPATH : null;
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
     * The vault-lock to use: the one at this plugin's path or the one at the old
     * plugin ID's path, whichever is newer (a device not yet updated may have changed
     * the password). Missing a lock would make this device treat an add-on vault as a
     * plain one, so both places are checked.
     */
    private async findLockFile(): Promise<CloudFile | null> {
        const current = await this.baseAdapter.getFileMetadata(vaultLockPath());
        const legacyPath = legacyVaultLockPath();
        const legacy = legacyPath ? await this.baseAdapter.getFileMetadata(legacyPath) : null;
        if (current && legacy) return legacy.mtime > current.mtime ? legacy : current;
        return current ?? legacy;
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
        // Devices still on the old plugin ID read the lock from the old path: keep it
        // there too, so they never miss that the vault uses the add-on.
        const paths = [vaultLockPath(), legacyVaultLockPath()].filter(
            (p): p is string => p !== null,
        );
        for (const path of paths) {
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
