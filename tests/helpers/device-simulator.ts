import { SyncManager, type LocalFileIndex, type SyncManagerSettings } from "../../src/sync-manager";
import { MockApp } from "./mock-vault-adapter";
import { MockCloudAdapter } from "./mock-cloud-adapter";
import { md5 } from "../../src/utils/md5";

const PLUGIN_DIR = ".obsidian/plugins/obsidian-vault-sync";
const SYNC_INDEX_PATH = `${PLUGIN_DIR}/sync-index.json`;
const LOCAL_INDEX_PATH = `${PLUGIN_DIR}/local-index.json`;

const DEFAULT_SETTINGS: SyncManagerSettings = {
    concurrency: 1,
    showDetailedNotifications: false,
    enableLogging: false,
    exclusionPatterns: "",
};

/**
 * Simulates a single device with its own local filesystem
 * and a shared cloud adapter.
 */
export class DeviceSimulator {
    readonly app: MockApp;
    readonly syncManager: SyncManager;
    readonly deviceId: string;
    readonly logs: string[] = [];

    private sm: any; // For accessing private members

    constructor(
        public readonly name: string,
        readonly cloud: MockCloudAdapter,
        deviceId?: string,
    ) {
        this.app = new MockApp();
        this.deviceId = deviceId || `dev_${name}`;

        this.syncManager = new SyncManager(
            this.app as any,
            cloud,
            SYNC_INDEX_PATH,
            { ...DEFAULT_SETTINGS },
            PLUGIN_DIR,
            (key: string) => key, // identity translation
        );

        this.sm = this.syncManager as any;

        // Set device ID
        this.sm.deviceId = this.deviceId;

        // Set up activity callbacks (no-op)
        this.sm.onActivityStart = () => {};
        this.sm.onActivityEnd = () => {};

        // Override log to capture
        this.sm.log = async (msg: string) => {
            this.logs.push(`[${this.name}] ${msg}`);
        };
    }

    // ─── State Setup ───

    /**
     * Initialize both devices to a known synchronized state for a file.
     * Simulates: file exists on cloud and locally, indices are in sync.
     */
    setupSyncedFile(path: string, content: string, fileId: string): void {
        const buf = new TextEncoder().encode(content).buffer as ArrayBuffer;
        const hash = md5(buf);

        // Set up local file
        this.app.vaultAdapter.setFile(path, content);

        // Set up index entries
        const entry = {
            fileId,
            mtime: Date.now(),
            size: buf.byteLength,
            hash,
            lastAction: "pull" as const,
            ancestorHash: hash,
        };
        this.sm.index[path] = { ...entry };
        this.sm.localIndex[path] = { ...entry };
    }

    // ─── File Operations ───

    /**
     * Simulate a local file edit (user typing in Obsidian).
     */
    editFile(path: string, newContent: string): void {
        this.app.vaultAdapter.setFile(path, newContent);
        this.sm.dirtyPaths.add(path);
    }

    /**
     * Get local file content.
     */
    getLocalContent(path: string): string | null {
        return this.app.vaultAdapter.getContent(path);
    }

    /**
     * List all local files.
     */
    listLocalFiles(): string[] {
        return this.app.vaultAdapter.listAllFiles();
    }

    // ─── Sync Operations ───

    /**
     * Push a specific dirty file to cloud.
     * Simulates the core of smartPush without the full orchestration.
     * Returns true if pushed successfully, false if conflict detected.
     */
    async pushFile(
        path: string,
        isSilent = true,
    ): Promise<{ pushed: boolean; conflictDetected: boolean }> {
        const exists = await this.app.vaultAdapter.exists(path);
        if (!exists) return { pushed: false, conflictDetected: false };

        const content = await this.app.vaultAdapter.readBinary(path);
        const currentHash = md5(content);
        const localIndexEntry = this.sm.localIndex[path];

        // Hash match check (no actual change)
        if (
            localIndexEntry?.hash &&
            localIndexEntry.hash.toLowerCase() === currentHash &&
            localIndexEntry.lastAction !== "merge"
        ) {
            this.sm.dirtyPaths.delete(path);
            return { pushed: false, conflictDetected: false };
        }

        // Pre-upload conflict check (optimistic locking)
        const remoteMeta = await this.cloud.getFileMetadata(path);
        if (remoteMeta) {
            const lastKnownHash = this.sm.localIndex[path]?.hash;
            const remoteHash = remoteMeta.hash;

            if (
                remoteHash &&
                (!lastKnownHash || lastKnownHash.toLowerCase() !== remoteHash.toLowerCase())
            ) {
                if (this.sm.localIndex[path]?.lastAction === "merge") {
                    // Allow push of merged file
                    this.logs.push(`[${this.name}] Allowing push of merged file: ${path}`);
                } else {
                    // CONFLICT: Remote changed since our last sync
                    this.logs.push(`[${this.name}] PUSH CONFLICT: Remote changed for ${path}`);

                    // Deadlock breaking: immediate pull/merge
                    await this.sm.pullFileSafely(remoteMeta, isSilent, "Push Conflict");
                    return { pushed: false, conflictDetected: true };
                }
            }
        }

        // Upload
        const stat = await this.app.vaultAdapter.stat(path);
        const uploaded = await this.cloud.uploadFile(path, content, stat?.mtime || Date.now());

        // Update indices (same logic as smartPush)
        const previousAncestor = this.sm.localIndex[path]?.ancestorHash;
        const entry = {
            fileId: uploaded.id,
            mtime: stat?.mtime || Date.now(),
            size: uploaded.size,
            hash: uploaded.hash,
            lastAction: "push" as const,
            ancestorHash: previousAncestor || uploaded.hash,
        };
        this.sm.index[path] = entry;
        this.sm.localIndex[path] = { ...entry };
        this.sm.dirtyPaths.delete(path);

        return { pushed: true, conflictDetected: false };
    }

    /**
     * Force-push a file to cloud WITHOUT pre-upload conflict detection.
     * Simulates Google Drive's eventual consistency: the device pushes
     * without seeing the other device's recent push.
     */
    async forcePush(path: string): Promise<void> {
        const content = await this.app.vaultAdapter.readBinary(path);
        const stat = await this.app.vaultAdapter.stat(path);
        const uploaded = await this.cloud.uploadFile(path, content, stat?.mtime || Date.now());

        const previousAncestor = this.sm.localIndex[path]?.ancestorHash;
        const entry = {
            fileId: uploaded.id,
            mtime: stat?.mtime || Date.now(),
            size: uploaded.size,
            hash: uploaded.hash,
            lastAction: "push" as const,
            ancestorHash: previousAncestor || uploaded.hash,
        };
        this.sm.index[path] = entry;
        this.sm.localIndex[path] = { ...entry };
        this.sm.dirtyPaths.delete(path);

        this.logs.push(
            `[${this.name}] [Force Push] Pushed: ${path} (hash=${uploaded.hash?.substring(0, 8)})`,
        );
    }

    /**
     * Pull a specific file from cloud (conflict detection and auto-merge).
     * Calls pullFileSafely directly — bypasses Changes API pre-check.
     */
    async pullFile(path: string, isSilent = true): Promise<boolean> {
        const remoteMeta = await this.cloud.getFileMetadata(path);
        if (!remoteMeta) return false;
        return await this.sm.pullFileSafely(remoteMeta, isSilent, "Pull");
    }

    /**
     * Simulate a full sync pull cycle via Changes API.
     * Reproduces the real smartPull flow INCLUDING the pre-check at lines 1546-1563
     * that confirms sync when the device's own push comes back via Changes API.
     *
     * Note: The hash match path sets lastAction="pull" (sync confirmed, by design)
     * but does NOT update ancestorHash — this can cause ancestorHash staleness
     * over multiple push cycles (see Bug #3 test).
     */
    async syncPull(
        path: string,
        isSilent = true,
    ): Promise<"skipped_hash_match" | "pulled" | "no_change" | "no_remote"> {
        const remoteMeta = await this.cloud.getFileMetadata(path);
        if (!remoteMeta) return "no_remote";

        // ── Changes API pre-check (sync-manager.ts:1546-1563) ──
        // This runs BEFORE pullFileSafely. Confirms sync when own push comes back.
        const localEntry = this.sm.index[path];
        if (
            localEntry?.hash &&
            remoteMeta.hash &&
            localEntry.hash.toLowerCase() === remoteMeta.hash.toLowerCase()
        ) {
            // "Update lastAction to 'pull' to indicate sync is confirmed"
            // This clears 'push' state so future remote updates won't trigger Safety Guard
            if (
                this.sm.localIndex[path]?.lastAction === "push" ||
                this.sm.localIndex[path]?.lastAction === "merge"
            ) {
                this.sm.localIndex[path].lastAction = "pull";
                this.sm.localIndex[path].ancestorHash = remoteMeta.hash;
                this.sm.index[path].ancestorHash = remoteMeta.hash;
                this.logs.push(
                    `[${this.name}] [Smart Pull] Hash match pre-check: lastAction reset to "pull" for ${path}`,
                );
            }
            this.logs.push(`[${this.name}] [Smart Pull] Skipping (hash match): ${path}`);
            return "skipped_hash_match";
        }

        // ── No pre-check match → call pullFileSafely ──
        const success = await this.sm.pullFileSafely(remoteMeta, isSilent, "Changes API");
        return success ? "pulled" : "no_change";
    }

    // ─── State Inspection ───

    /**
     * Get the shared (cloud) index entry for a path.
     */
    getIndex(path: string): LocalFileIndex[string] | undefined {
        return this.sm.index[path];
    }

    /**
     * Get the local index entry for a path.
     */
    getLocalIndex(path: string): LocalFileIndex[string] | undefined {
        return this.sm.localIndex[path];
    }

    /**
     * Get dirty paths.
     */
    getDirtyPaths(): Set<string> {
        return this.sm.dirtyPaths;
    }

    /**
     * Format state snapshot for a path (useful for assertions and debugging).
     */
    describeState(path: string): {
        localContent: string | null;
        index: { hash: string; lastAction: string; ancestorHash: string } | null;
        localIndex: {
            hash: string;
            lastAction: string;
            ancestorHash: string;
            pendingConflict?: boolean;
        } | null;
        isDirty: boolean;
    } {
        const idx = this.sm.index[path];
        const lidx = this.sm.localIndex[path];
        return {
            localContent: this.app.vaultAdapter.getContent(path),
            index: idx
                ? {
                      hash: idx.hash?.substring(0, 8) || "none",
                      lastAction: idx.lastAction || "none",
                      ancestorHash: idx.ancestorHash?.substring(0, 8) || "none",
                  }
                : null,
            localIndex: lidx
                ? {
                      hash: lidx.hash?.substring(0, 8) || "none",
                      lastAction: lidx.lastAction || "none",
                      ancestorHash: lidx.ancestorHash?.substring(0, 8) || "none",
                      pendingConflict: lidx.pendingConflict,
                  }
                : null,
            isDirty: this.sm.dirtyPaths.has(path),
        };
    }

    /**
     * Print state for debugging.
     */
    printState(path: string): void {
        const state = this.describeState(path);
        console.log(`\n=== ${this.name} state for ${path} ===`);
        console.log(`  Local content: ${state.localContent?.replace(/\n/g, "\\n")}`);
        console.log(`  Index:      ${JSON.stringify(state.index)}`);
        console.log(`  LocalIndex: ${JSON.stringify(state.localIndex)}`);
        console.log(`  isDirty: ${state.isDirty}`);
    }

    /**
     * Print all captured logs.
     */
    printLogs(): void {
        console.log(`\n--- ${this.name} Logs ---`);
        for (const log of this.logs) {
            console.log(log);
        }
    }

    /**
     * Clear logs.
     */
    clearLogs(): void {
        this.logs.length = 0;
    }
}

/**
 * Helper to compute MD5 hash of a string.
 */
export function hashOf(content: string): string {
    return md5(new TextEncoder().encode(content).buffer as ArrayBuffer);
}
