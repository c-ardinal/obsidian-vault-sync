import { CloudAdapter, CloudFile } from "../types/adapter";
import { PLUGIN_DIR } from "../sync-manager/file-utils";
import { RemoteDeletionService } from "../sync-manager/remote-deletion";

const VAULT_LOCK_SUBPATH = "data/remote/vault-lock.vault";

/** Cloud path of the vault-lock (inside this plugin's folder). */
export function vaultLockPath(): string {
    return PLUGIN_DIR + VAULT_LOCK_SUBPATH;
}

export const MIGRATION_LOCK_FILENAME = "migration.lock";
/** A migration lock older than this is a leftover of an abandoned conversion. */
export const MIGRATION_LOCK_STALE_MS = 24 * 3600 * 1000;

export interface MigrationLock {
    id: string;
    deviceId: string;
    timestamp: number;
}

/**
 * The device that may convert, of all that left a lock: the earliest lock wins,
 * the device id decides between equal times. Every device computes this from
 * the same list, so all agree. Locks older than MIGRATION_LOCK_STALE_MS do not count.
 */
export function converterAmong(locks: MigrationLock[], now: number): MigrationLock | null {
    const live = locks.filter((l) => l.timestamp > now - MIGRATION_LOCK_STALE_MS);
    live.sort((a, b) => a.timestamp - b.timestamp || (a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0));
    return live[0] ?? null;
}

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
     * Where this device keeps a copy of the vault-lock. The lock exists once, in
     * the vault folder; a folder that is deleted or renamed by hand takes it
     * along, and the devices would rebuild the vault without it: nothing in the
     * rebuilt folder could be opened after the next start. With the copy, the
     * first device that finds the folder replaced puts the lock back.
     */
    copy: { load(): Promise<string | null>; save(blob: string): Promise<void> } | null = null;

    private async keepCopy(blob: string): Promise<void> {
        try {
            await this.copy?.save(blob);
        } catch {
            // The copy is a reserve; the next read or write of the lock saves it again
        }
    }

    /**
     * The vault folder was replaced and this device works in a converted vault:
     * put the lock back when the new folder has none.
     * "lost": no lock there and no copy here (nothing may be uploaded then).
     */
    async restoreLockFileIfMissing(): Promise<"present" | "restored" | "lost"> {
        if (await this.checkForLockFile()) return "present";
        const blob = (await this.copy?.load()) ?? null;
        if (!blob) return "lost";
        await this.uploadLockFile(blob);
        return "restored";
    }

    private async findLockFile(): Promise<CloudFile | null> {
        return await this.baseAdapter.getFileMetadata(vaultLockPath());
    }

    async checkForLockFile(): Promise<boolean> {
        return (await this.findLockFile()) !== null;
    }

    async downloadLockFile(): Promise<string> {
        const meta = await this.findLockFile();
        if (!meta) throw new Error("vault-lock.vault not found.");
        const content = await this.baseAdapter.downloadFile(meta.id);
        const blob = new TextDecoder().decode(content);
        await this.keepCopy(blob);
        return blob;
    }

    async uploadLockFileToAdapter(adapter: CloudAdapter, blob: string): Promise<void> {
        const content = new TextEncoder().encode(blob).buffer;
        const existing = await adapter.getFileMetadata(vaultLockPath());
        await adapter.uploadFile(vaultLockPath(), content, Date.now(), existing?.id);
        await this.keepCopy(blob);
    }

    async uploadLockFile(blob: string): Promise<void> {
        await this.uploadLockFileToAdapter(this.baseAdapter, blob);
    }

    /**
     * Always a new cloud file, never an update of a lock found there: two devices
     * that start at the same moment each leave their own lock, and both can see
     * afterwards that there are two (see listMigrationLocks).
     */
    async createMigrationLock(deviceId: string): Promise<MigrationLock> {
        const timestamp = Date.now();
        const content = new TextEncoder().encode(JSON.stringify({ deviceId, timestamp })).buffer;
        const file = await this.baseAdapter.uploadFile(MIGRATION_LOCK_FILENAME, content, timestamp, undefined, {
            createOnly: true,
        });
        return { id: file.id, deviceId, timestamp };
    }

    /** Every migration lock in the vault folder */
    async listMigrationLocks(): Promise<MigrationLock[]> {
        const files = (await this.baseAdapter.listFiles()).filter(
            (f) => f.kind === "file" && f.path === MIGRATION_LOCK_FILENAME,
        );
        const locks: MigrationLock[] = [];
        for (const f of files) {
            try {
                const lock = JSON.parse(new TextDecoder().decode(await this.baseAdapter.downloadFile(f.id))) as {
                    deviceId?: unknown;
                    timestamp?: unknown;
                };
                if (typeof lock.deviceId === "string" && typeof lock.timestamp === "number") {
                    locks.push({ id: f.id, deviceId: lock.deviceId, timestamp: lock.timestamp });
                }
            } catch {
                // Gone meanwhile, or not a lock this build can read
            }
        }
        return locks;
    }

    /** Remove one lock file by its cloud id (the lock of this device, among several) */
    async removeMigrationLockById(id: string): Promise<void> {
        await this.deletion.remove(this.baseAdapter, { id, path: MIGRATION_LOCK_FILENAME, kind: "file" }, "maintenance");
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
        // The vault folder itself (and its siblings) lie next to the vault, not in it
        await this.baseAdapter.moveFile(id, newName, null, "outside");
    }
}
