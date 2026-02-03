import { CloudAdapter } from "./types/adapter";
import { App, TFile, TFolder, TAbstractFile, Notice } from "obsidian";
import { matchWildcard } from "./utils/wildcard";
import { md5 } from "./utils/md5";

export interface SyncManagerSettings {
    concurrency: number;
    showDetailedNotifications: boolean;
    enableLogging: boolean;
    exclusionPatterns: string;
}

export interface LocalFileIndex {
    [path: string]: {
        fileId: string;
        mtime: number;
        size: number;
        hash?: string;
    };
}

// === Hybrid Sync Types ===

/** Sync engine states for preemption control */
export type SyncState = "IDLE" | "SMART_SYNCING" | "FULL_SCANNING" | "PAUSED";

/** Progress state for resumable full scan */
export interface FullScanProgress {
    /** Current index in the file list being processed */
    currentIndex: number;
    /** Total files to process */
    totalFiles: number;
    /** Cached local file list (for resume) */
    localFiles: Array<{ path: string; mtime: number; size: number }>;
    /** Cached remote file list (for resume) */
    remoteFiles: Array<{ id: string; path: string; mtime: number; size: number; hash?: string }>;
    /** Timestamp when the scan started (for staleness check) */
    startedAt: number;
}

export class SyncManager {
    private index: LocalFileIndex = {};
    private startPageToken: string | null = null;
    private isSyncing = false;
    private logFolder: string;

    // === Hybrid Sync State ===
    /** Current sync state for preemption control */
    private syncState: SyncState = "IDLE";
    /** Dirty paths that need to be pushed (modified locally) */
    private dirtyPaths: Set<string> = new Set();
    /** Paths currently being synced (to prevent re-marking as dirty) */
    private syncingPaths: Set<string> = new Set();
    /** Flag to interrupt running full scan */
    private isInterrupted = false;
    /** Progress for resumable full scan */
    private fullScanProgress: FullScanProgress | null = null;
    /** Promise for current running sync operation (for awaiting) */
    private currentSyncPromise: Promise<void> | null = null;
    /** Maximum age for full scan progress before reset (5 minutes) */
    private readonly FULL_SCAN_MAX_AGE_MS = 5 * 60 * 1000;

    private onActivityStart: () => void = () => {};
    private onActivityEnd: () => void = () => {};

    constructor(
        private app: App,
        private adapter: CloudAdapter,
        private pluginDataPath: string,

        private settings: SyncManagerSettings,
        private pluginDir: string,
        private t: (key: string) => string,
    ) {
        this.logFolder = `${this.pluginDir}/logs`;
        this.adapter.setLogger((msg) => this.log(msg));
    }

    public setActivityCallbacks(onStart: () => void, onEnd: () => void) {
        this.onActivityStart = onStart;
        this.onActivityEnd = onEnd;
    }

    async log(message: string) {
        const now = new Date();
        // Use local timezone for timestamp
        const timestamp = now.toLocaleString("ja-JP", {
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        });
        const line = `[${timestamp}] ${message}\n`;
        console.log(`VaultSync: ${message}`);

        if (!this.settings.enableLogging) return;

        try {
            // Use local timezone for file name
            const year = now.getFullYear();
            const month = String(now.getMonth() + 1).padStart(2, "0");
            const day = String(now.getDate()).padStart(2, "0");
            const today = `${year}-${month}-${day}`;
            const logPath = `${this.logFolder}/${today}.log`;

            // Ensure log folder exists (use adapter for recursive mkdir)
            if (!(await this.app.vault.adapter.exists(this.logFolder))) {
                await this.ensureLocalFolder(this.logFolder + "/dummy.txt"); // Simple trick for recursive
            }

            const existingContent = await this.app.vault.adapter.read(logPath).catch(() => "");
            await this.app.vault.adapter.write(logPath, existingContent + line);
        } catch (e) {
            console.error("Failed to write to log file:", e);
        }
    }

    private async ensureLocalFolder(filePath: string) {
        const parts = filePath.split("/");
        if (parts.length <= 1) return;

        const folderPath = parts.slice(0, -1).join("/");
        if (await this.app.vault.adapter.exists(folderPath)) return;

        // Iterate and create each segment if needed
        let currentPath = "";
        for (const part of parts.slice(0, -1)) {
            currentPath += (currentPath ? "/" : "") + part;
            if (!(await this.app.vault.adapter.exists(currentPath))) {
                try {
                    await this.app.vault.createFolder(currentPath);
                } catch (e) {
                    // Ignore race conditions
                    console.debug("VaultSync: Race condition in mkdir ignored", e);
                }
            }
        }
    }

    async loadIndex() {
        try {
            const data = await this.app.vault.adapter.read(this.pluginDataPath);
            const parsed = JSON.parse(data);
            this.index = parsed.index || {};
            this.startPageToken = parsed.startPageToken || null;
        } catch (e) {
            this.index = {};
            this.startPageToken = null;
        }
    }

    async saveIndex() {
        const data = JSON.stringify({
            index: this.index,
            startPageToken: this.startPageToken,
        });
        await this.app.vault.adapter.write(this.pluginDataPath, data);
    }

    async resetIndex() {
        this.index = {};
        this.startPageToken = null;
        await this.saveIndex();
    }

    private async runParallel<T>(
        tasks: (() => Promise<T>)[],
        concurrency: number = this.settings.concurrency,
    ): Promise<T[]> {
        const results: T[] = [];
        const queue = [...tasks];
        const workers = Array(Math.min(concurrency, queue.length))
            .fill(null)
            .map(async () => {
                while (queue.length > 0) {
                    const task = queue.shift();
                    if (task) {
                        results.push(await task());
                    }
                }
            });
        await Promise.all(workers);
        return results;
    }

    private async listFilesRecursive(path: string): Promise<string[]> {
        const result: string[] = [];
        const listed = await this.app.vault.adapter.list(path);

        for (const file of listed.files) {
            result.push(file);
        }

        for (const folder of listed.folders) {
            const subFiles = await this.listFilesRecursive(folder);
            result.push(...subFiles);
        }

        return result;
    }

    private async getLocalFiles() {
        // Standard vault files
        const standardFiles = this.app.vault.getFiles().map((f) => ({
            path: f.path,
            mtime: f.stat.mtime,
            size: f.stat.size,
            name: f.name,
        }));

        // Hidden .obsidian files
        const obsidianFiles: { path: string; mtime: number; size: number; name: string }[] = [];
        try {
            const files = await this.listFilesRecursive(".obsidian");
            for (const path of files) {
                const stat = await this.app.vault.adapter.stat(path);
                if (stat) {
                    obsidianFiles.push({
                        path,
                        mtime: stat.mtime,
                        size: stat.size,
                        name: path.split("/").pop() || "",
                    });
                }
            }
        } catch (e) {
            await this.log(`  Failed to list .obsidian: ${e}`);
        }

        return [...standardFiles, ...obsidianFiles];
    }

    async sync(isSilent: boolean = true) {
        if (this.isSyncing) return;
        this.isSyncing = true;

        try {
            await this.log("=== AUTO-SYNC (INDEX RECONCILIATION) STARTED ===");
            if (!isSilent) new Notice(this.t("syncing"));

            if (!isSilent) new Notice(this.t("fetchingRemoteList"));
            const remoteFiles = await this.adapter.listFiles();
            const remoteIndexFile = remoteFiles.find((f) => f.path === this.pluginDataPath);
            const localIndexEntry = this.index[this.pluginDataPath];

            if (!isSilent) new Notice(this.t("reconcilingChanges"));

            const remoteHash = remoteIndexFile?.hash;
            const localHash = localIndexEntry?.hash;

            await this.log(
                `  Local index state for ${this.pluginDataPath}: ${localIndexEntry ? JSON.stringify(localIndexEntry) : "MISSING"}`,
            );

            if (remoteIndexFile && remoteHash !== localHash) {
                await this.log(
                    `  Cloud index differs (${remoteHash} vs ${localHash}). Prioritizing PULL.`,
                );
                // Use the already fetched remoteFiles to save an API call
                await this.internalPull(isSilent, remoteFiles);
            } else {
                await this.log(`  Cloud index matches or missing. Proceeding with PUSH.`);
                await this.internalPush(isSilent, remoteFiles);
            }
        } finally {
            this.isSyncing = false;
        }
    }

    async push(isSilent: boolean = false) {
        if (this.isSyncing) {
            if (!isSilent) new Notice(this.t("syncInProgress"));
            return;
        }
        this.isSyncing = true;
        try {
            await this.internalPush(isSilent);
        } finally {
            this.isSyncing = false;
        }
    }

    private async internalPush(isSilent: boolean = false, preFetchedRemoteFiles?: any[]) {
        try {
            await this.log("--- PUSH START ---");
            if (!isSilent) new Notice(`⬆️ ${this.t("syncing")}`);

            if (!isSilent) new Notice(this.t("scanningLocalFiles"));
            const localFiles = await this.getLocalFiles();

            if (!isSilent) new Notice(this.t("fetchingRemoteList"));
            const remoteFiles = preFetchedRemoteFiles || (await this.adapter.listFiles());
            const remotePathsMap = new Map(remoteFiles.map((f: any) => [f.path, f]));

            if (!isSilent) new Notice(this.t("reconcilingChanges"));

            // 0. Pre-calculate work
            const uploadQueue: any[] = [];
            const MTIME_GRACE_MS = 2000; // 2s grace for filesystem precision issues

            for (const localFile of localFiles) {
                if (this.shouldIgnore(localFile.path)) continue;
                const remoteFile = remotePathsMap.get(localFile.path);
                const indexEntry = this.index[localFile.path];

                let reason = "";
                if (!remoteFile) {
                    reason = "New file (not on remote)";
                } else if (!indexEntry) {
                    // Try to adopt remote file if hash matches
                    if (remoteFile && remoteFile.hash) {
                        try {
                            const content = await this.app.vault.adapter.readBinary(localFile.path);
                            const localHash = md5(content);
                            if (localHash === remoteFile.hash.toLowerCase()) {
                                await this.log(
                                    `  [Push Check] ${localFile.path} -> Adoption: Local matches remote hash. Skipping upload.`,
                                );
                                this.index[localFile.path] = {
                                    fileId: remoteFile.id,
                                    mtime: localFile.mtime,
                                    size: localFile.size,
                                    hash: remoteFile.hash,
                                };
                                continue;
                            }
                        } catch (e) {
                            /* ignore */
                        }
                    }
                    reason = "Missing local index (need to re-upload)";
                } else {
                    // indexEntry exists - check if content actually changed
                    // First: if size differs, it's definitely modified
                    // But skip size check if either size is 0 (indicates incomplete cache/index on Android)
                    if (
                        localFile.size !== indexEntry.size &&
                        localFile.size !== 0 &&
                        indexEntry.size !== 0
                    ) {
                        reason = `Size changed (${localFile.size} vs ${indexEntry.size})`;
                    } else if (indexEntry.hash) {
                        // Size is same, compare hash (most reliable check for Android mtime issues)
                        try {
                            const content = await this.app.vault.adapter.readBinary(localFile.path);
                            const localHash = md5(content);
                            if (localHash === indexEntry.hash.toLowerCase()) {
                                // Hash matches - content is identical, skip upload
                                // Update mtime in index if changed to prevent future false positives
                                if (localFile.mtime !== indexEntry.mtime) {
                                    await this.log(
                                        `  [Push Check] ${localFile.path} -> Smart Skip: Hash matches, updating mtime in index.`,
                                    );
                                    this.index[localFile.path].mtime = localFile.mtime;
                                }
                                continue;
                            } else {
                                reason = `Content modified (hash mismatch)`;
                            }
                        } catch (e) {
                            // Hash calculation failed, fall back to mtime check
                            if (localFile.mtime > indexEntry.mtime + MTIME_GRACE_MS) {
                                reason = `Modified locally (mtime, hash calc failed)`;
                            }
                        }
                    } else {
                        // No hash in index (e.g., Google Docs), fall back to mtime check
                        if (localFile.mtime > indexEntry.mtime + MTIME_GRACE_MS) {
                            reason = `Modified locally (${localFile.mtime} > ${indexEntry.mtime})`;
                        }
                    }
                }

                if (reason) {
                    await this.log(`  [Push Check] ${localFile.path} -> ${reason}`);
                    uploadQueue.push(localFile);
                }
            }

            const localPaths = new Set(localFiles.map((f) => f.path));
            const deleteQueue: any[] = [];
            for (const remoteFile of remoteFiles) {
                if (remoteFile.path === this.pluginDataPath) continue; // NEVER trash the master index!

                // Delete remote file/folder if it matches exclusion patterns (clean up previously synced)
                if (this.shouldIgnore(remoteFile.path)) {
                    deleteQueue.push(remoteFile);
                    // Also clean from index
                    if (this.index[remoteFile.path]) {
                        delete this.index[remoteFile.path];
                    }
                    continue;
                }

                // Skip folders for normal deletion logic (only delete files that don't exist locally)
                if (remoteFile.kind === "folder") continue;

                // Delete remote file if it doesn't exist locally
                if (!localPaths.has(remoteFile.path)) {
                    deleteQueue.push(remoteFile);
                }
            }

            const totalOps = uploadQueue.length + deleteQueue.length;
            let currentOp = 0;

            if (totalOps === 0) {
                await this.log("  No changes to push.");
                if (!isSilent) new Notice(this.t("nothingToPush"));
            } else {
                this.onActivityStart();
                try {
                    // Always show changes detected, even in silent mode
                    new Notice(`🔍 ${totalOps} ${this.t("changesToPush")}`);

                    // 1. Ensure folders exist on remote using proper hierarchy
                    const foldersToCreate = new Set<string>();
                    for (const file of uploadQueue) {
                        const parts = file.path.split("/");
                        for (let i = 1; i < parts.length; i++) {
                            foldersToCreate.add(parts.slice(0, i).join("/"));
                        }
                    }
                    const sortedFolders = Array.from(foldersToCreate)
                        .filter((folder) => !remotePathsMap.has(folder))
                        .sort((a, b) => a.length - b.length);

                    if (sortedFolders.length > 0) {
                        await this.log(`  Creating ${sortedFolders.length} folders on remote...`);
                        await this.adapter.ensureFoldersExist(
                            sortedFolders,
                            (current, total, name) => {
                                if (this.settings.showDetailedNotifications) {
                                    new Notice(`${this.t("folderCreated")}: ${name}`);
                                }
                            },
                        );
                        // Update map
                        for (const folder of sortedFolders) {
                            remotePathsMap.set(folder, { path: folder, kind: "folder" } as any);
                        }
                    }

                    // 2. Parallel Uploads & Deletions
                    const tasks: (() => Promise<void>)[] = [];

                    // Upload tasks
                    for (const localFile of uploadQueue) {
                        tasks.push(async () => {
                            try {
                                const content = await this.app.vault.adapter.readBinary(
                                    localFile.path,
                                );
                                const uploaded = await this.adapter.uploadFile(
                                    localFile.path,
                                    content,
                                    localFile.mtime,
                                );
                                this.index[localFile.path] = {
                                    fileId: uploaded.id,
                                    mtime: localFile.mtime,
                                    size: uploaded.size,
                                    hash: uploaded.hash,
                                };
                                currentOp++;
                                await this.log(
                                    `  [${currentOp}/${totalOps}] Pushed: ${localFile.path}`,
                                );
                                // Respect verbosity setting
                                if (this.settings.showDetailedNotifications) {
                                    new Notice(
                                        `[${currentOp}/${totalOps}] ${this.t("filePushed")}: ${localFile.name}`,
                                    );
                                }
                            } catch (e) {
                                await this.log(`  Push FAILED: ${localFile.path} - ${e}`);
                            }
                        });
                    }

                    // Delete tasks
                    for (const remoteFile of deleteQueue) {
                        tasks.push(async () => {
                            try {
                                await this.adapter.deleteFile(remoteFile.id);
                                delete this.index[remoteFile.path];
                                currentOp++;
                                await this.log(
                                    `  [${currentOp}/${totalOps}] Trashed remote: ${remoteFile.path}`,
                                );
                                // Respect verbosity setting
                                if (this.settings.showDetailedNotifications) {
                                    new Notice(
                                        `[${currentOp}/${totalOps}] ${this.t("fileTrashed")}: ${remoteFile.path.split("/").pop()}`,
                                    );
                                }
                            } catch (e) {
                                await this.log(`  Remote Trash FAILED: ${remoteFile.path} - ${e}`);
                            }
                        });
                    }

                    await this.runParallel(tasks);

                    await this.saveIndex();

                    // 3. Final Step: Upload Index
                    try {
                        const indexContent = await this.app.vault.adapter.readBinary(
                            this.pluginDataPath,
                        );
                        const uploadedIndex = await this.adapter.uploadFile(
                            this.pluginDataPath,
                            indexContent,
                            Date.now(),
                        );
                        this.index[this.pluginDataPath] = {
                            fileId: uploadedIndex.id,
                            mtime: Date.now(),
                            size: uploadedIndex.size,
                            hash: uploadedIndex.hash,
                        };
                        await this.log(
                            `  Master index uploaded to cloud. Hash: ${uploadedIndex.hash}`,
                        );
                        // CRITICAL: Save again to persist self-referential metadata
                        await this.saveIndex();
                    } catch (e) {
                        await this.log(`  Failed to upload master index: ${e}`);
                    }

                    await this.log("--- PUSH COMPLETED ---");
                    if (currentOp > 0) new Notice(this.t("pushCompleted"));
                } finally {
                    this.onActivityEnd();
                }
            }
        } catch (e) {
            await this.log(`Push execution failed: ${e}`);
        }
    }

    async pull(isSilent: boolean = false) {
        if (this.isSyncing) {
            if (!isSilent) new Notice(this.t("syncInProgress"));
            return;
        }
        this.isSyncing = true;
        try {
            await this.internalPull(isSilent);
        } finally {
            this.isSyncing = false;
        }
    }

    private async internalPull(isSilent: boolean = false, preFetchedRemoteFiles?: any[]) {
        try {
            await this.log("--- PULL START ---");
            if (!isSilent) new Notice(`⬇️ ${this.t("syncing")}`);

            if (!isSilent) new Notice(this.t("fetchingRemoteList"));
            const remoteFiles = preFetchedRemoteFiles || (await this.adapter.listFiles());
            const remoteFilesMap = new Map(remoteFiles.map((f) => [f.path, f]));
            await this.log(`Remote file list: ${remoteFiles.length} items found.`);

            // 0. Update index metadata for the index file itself if it's in the list
            const cloudIndexFile = remoteFiles.find((f) => f.path === this.pluginDataPath);
            if (cloudIndexFile) {
                const localIndexEntry = this.index[this.pluginDataPath];
                // SHORTCUT: If index hash matches, and we are not forcing a full scan, we can skip!
                if (
                    !preFetchedRemoteFiles && // Only optimize if we are doing a standard pull
                    localIndexEntry &&
                    cloudIndexFile.hash &&
                    localIndexEntry.hash === cloudIndexFile.hash
                ) {
                    await this.log(
                        "  Remote Index hash matches local. No changes detected from other clients.",
                    );
                    if (!isSilent) new Notice(this.t("vaultUpToDate"));

                    // Update index metadata just in case (e.g. mtime change but hash same)
                    this.index[this.pluginDataPath] = {
                        fileId: cloudIndexFile.id,
                        mtime: cloudIndexFile.mtime,
                        size: cloudIndexFile.size,
                        hash: cloudIndexFile.hash,
                    };
                    await this.saveIndex();
                    return;
                }

                this.index[this.pluginDataPath] = {
                    fileId: cloudIndexFile.id,
                    mtime: cloudIndexFile.mtime,
                    size: cloudIndexFile.size,
                    hash: cloudIndexFile.hash,
                };
            }

            // 1. Download master index
            await this.log("  Downloading master (remote) index for reconciliation...");
            let masterIndex: LocalFileIndex = {};
            if (cloudIndexFile) {
                try {
                    const indexContent = await this.adapter.downloadFile(cloudIndexFile.id);
                    const parsed = JSON.parse(new TextDecoder().decode(indexContent));
                    masterIndex = parsed.index || {};
                    await this.log(
                        `  Master index loaded: ${Object.keys(masterIndex).length} entries.`,
                    );
                } catch (e) {
                    await this.log(
                        `  Failed to load master index: ${e}. Proceeding with standard pull.`,
                    );
                }
            }

            if (!isSilent) new Notice(this.t("scanningLocalFiles"));
            const localFiles = await this.getLocalFiles();
            const localFileMap = new Map(localFiles.map((f) => [f.path, f]));
            const remotePaths = new Set(remoteFiles.map((f) => f.path));

            if (!isSilent) new Notice(this.t("reconcilingChanges"));

            // 0.5 Pre-calculate work
            const downloadQueue: any[] = [];
            for (const cloudFile of remoteFiles) {
                if (cloudFile.kind === "folder") continue;
                if (cloudFile.path === this.pluginDataPath) continue;

                const localFile = localFileMap.get(cloudFile.path);
                if (!localFile) {
                    await this.log(`  [Diff] New remote file: ${cloudFile.path}`);
                    downloadQueue.push(cloudFile);
                } else {
                    const localIndexEntry = this.index[cloudFile.path];
                    const masterIndexEntry = masterIndex[cloudFile.path];
                    const isSyncedInMaster =
                        masterIndexEntry && cloudFile.hash === masterIndexEntry.hash;

                    // CASE 1: Local file exists, but index is missing (e.g. first sync or lost index)
                    // We must verify content before assuming it's the same, to avoid data corruption.
                    if (localFile && (!localIndexEntry || !localIndexEntry.hash)) {
                        try {
                            // Optimize: If sizes differ, don't bother hashing
                            if (localFile.size !== cloudFile.size) {
                                if (!localIndexEntry) {
                                    await this.log(
                                        `  [Diff] Local file exists but size differs (L: ${localFile.size}, R: ${cloudFile.size}). Downloading remote.`,
                                    );
                                    downloadQueue.push(cloudFile);
                                    continue;
                                }
                            } else {
                                const content = await this.app.vault.adapter.readBinary(
                                    cloudFile.path,
                                );
                                const localHash = md5(content);

                                // Force lowercase
                                const remoteHash = cloudFile.hash
                                    ? cloudFile.hash.toLowerCase()
                                    : "";

                                if (remoteHash && localHash === remoteHash) {
                                    if (!localIndexEntry) {
                                        await this.log(
                                            `  [Diff] Local file matches remote hash (${localHash}). Adopting into index.`,
                                        );
                                    }
                                    const stat = await this.app.vault.adapter.stat(cloudFile.path);
                                    this.index[cloudFile.path] = {
                                        fileId: cloudFile.id,
                                        mtime: stat ? stat.mtime : cloudFile.mtime,
                                        size: stat?.size || localFile.size || cloudFile.size,
                                        hash: cloudFile.hash,
                                    };
                                    continue; // Skip download
                                } else {
                                    if (!localIndexEntry) {
                                        await this.log(
                                            `  [Diff] Local file hash mismatch (L: ${localHash}, R: ${
                                                remoteHash || "undefined"
                                            }). Downloading remote.`,
                                        );
                                    }
                                }
                            }
                        } catch (e) {
                            await this.log(
                                `  [Diff] Failed to calculate local hash for ${cloudFile.path}: ${e}`,
                            );
                        }
                    }

                    // Check content modification (Hash is truth)
                    const isContentIdentical =
                        localIndexEntry && cloudFile.hash === localIndexEntry.hash;

                    if (isContentIdentical) {
                        // Content matches, but maybe mtime/size differs?
                        // Just update index to match remote state to prevent future false positives
                        if (
                            cloudFile.mtime !== localIndexEntry.mtime ||
                            cloudFile.size !== localIndexEntry.size
                        ) {
                            await this.log(
                                `  [Diff] Metadata mismatch but hash match: ${cloudFile.path} (Remote: ${cloudFile.mtime}, Local: ${localIndexEntry.mtime}) - Updating Index`,
                            );
                            this.index[cloudFile.path] = {
                                fileId: cloudFile.id,
                                mtime: cloudFile.mtime,
                                size: cloudFile.size || localFile.size || localIndexEntry.size,
                                hash: cloudFile.hash,
                            };
                        }
                        continue;
                    }

                    const isModifiedOnCloud =
                        cloudFile.hash !== localIndexEntry?.hash ||
                        cloudFile.size !== localIndexEntry?.size ||
                        cloudFile.mtime !== localIndexEntry?.mtime;

                    if (isModifiedOnCloud) {
                        if (!localIndexEntry && isSyncedInMaster) {
                            await this.log(
                                `  [Diff] Skipping ${cloudFile.path} (Synced in master, empty local index)`,
                            );
                            continue;
                        }
                        await this.log(
                            `  [Diff] Modified remote: ${cloudFile.path} (RHash: ${cloudFile.hash}, LHash: ${localIndexEntry?.hash})`,
                        );
                        downloadQueue.push(cloudFile);
                    }
                }
            }

            const orphanQueue: any[] = [];
            for (const localFile of localFiles) {
                if (this.shouldIgnore(localFile.path)) continue;
                if (!remotePaths.has(localFile.path)) {
                    if (this.index[localFile.path]) {
                        orphanQueue.push(localFile);
                    }
                }
            }

            const totalOps = downloadQueue.length + orphanQueue.length;
            let currentOp = 0;

            if (totalOps === 0) {
                await this.log("  No changes to pull.");
                if (!isSilent) new Notice(this.t("nothingToPull"));
            } else {
                this.onActivityStart();
                try {
                    if (!isSilent) new Notice(`🔍 ${totalOps} ${this.t("changesToPull")}`);
                    // 1. Folders first (Parallel Batch)
                    const foldersToCreate = new Set<string>();
                    for (const cloudFile of remoteFiles) {
                        if (cloudFile.kind === "folder") {
                            foldersToCreate.add(cloudFile.path);
                        }
                    }
                    const sortedFolders = Array.from(foldersToCreate).sort(
                        (a, b) => a.length - b.length,
                    );
                    const folderTasks: (() => Promise<void>)[] = [];
                    for (const folderPath of sortedFolders) {
                        if (!this.app.vault.getAbstractFileByPath(folderPath)) {
                            folderTasks.push(async () => {
                                try {
                                    await this.app.vault.createFolder(folderPath);
                                    await this.log(`  Batch created local folder: ${folderPath}`);
                                    if (!isSilent)
                                        new Notice(`${this.t("folderCreated")}: ${folderPath}`);
                                } catch (e) {}
                            });
                        }
                    }
                    if (folderTasks.length > 0) {
                        await this.runParallel(folderTasks);
                    }

                    // 2. Parallel Downloads & Deletions
                    const tasks: (() => Promise<void>)[] = [];

                    // Download tasks
                    for (const cloudFile of downloadQueue) {
                        tasks.push(async () => {
                            try {
                                // Mark as syncing to prevent dirty marking from modify event
                                this.syncingPaths.add(cloudFile.path);

                                const localFile = this.app.vault.getAbstractFileByPath(
                                    cloudFile.path,
                                );
                                const localIndexEntry = this.index[cloudFile.path];

                                if (
                                    localFile instanceof TFile &&
                                    localFile.stat.mtime > (localIndexEntry?.mtime || 0)
                                ) {
                                    await this.log(`  Conflict: ${cloudFile.path}. Renaming.`);
                                    const newName = `${localFile.basename} (Conflict ${new Date().toISOString().split("T")[0]}).${localFile.extension}`;
                                    await this.app.vault.rename(localFile, newName);
                                }

                                const content = await this.adapter.downloadFile(cloudFile.id);
                                await this.app.vault.adapter.writeBinary(cloudFile.path, content);

                                // Get actual local mtime/size after write to prevent false modification detection
                                const stat = await this.app.vault.adapter.stat(cloudFile.path);

                                this.index[cloudFile.path] = {
                                    fileId: cloudFile.id,
                                    mtime: stat ? stat.mtime : cloudFile.mtime,
                                    size: stat?.size || content.byteLength || cloudFile.size,
                                    hash: cloudFile.hash,
                                };
                                currentOp++;
                                await this.log(
                                    `  [${currentOp}/${totalOps}] Pulled: ${cloudFile.path} (Local mtime: ${stat?.mtime})`,
                                );
                                if (this.settings.showDetailedNotifications)
                                    new Notice(
                                        `[${currentOp}/${totalOps}] ${this.t("filePulled")}: ${cloudFile.path.split("/").pop()}`,
                                    );
                            } catch (e) {
                                await this.log(`  Pull FAILED: ${cloudFile.path} - ${e}`);
                            } finally {
                                this.syncingPaths.delete(cloudFile.path);
                            }
                        });
                    }

                    // Deletion tasks
                    for (const localFile of orphanQueue) {
                        tasks.push(async () => {
                            try {
                                await this.app.vault.trash(localFile, true);
                                delete this.index[localFile.path];
                                currentOp++;
                                await this.log(
                                    `  [${currentOp}/${totalOps}] Removed: ${localFile.path}`,
                                );
                                if (this.settings.showDetailedNotifications)
                                    new Notice(
                                        `[${currentOp}/${totalOps}] ${this.t("fileRemoved")}: ${localFile.name}`,
                                    );
                            } catch (e) {
                                await this.log(`  Delete FAILED: ${localFile.path} - ${e}`);
                            }
                        });
                    }

                    await this.runParallel(tasks, 5);

                    // 3. Metadata updates (Post-processing)
                    for (const cloudFile of remoteFiles) {
                        if (cloudFile.kind === "folder") continue;
                        if (cloudFile.path === this.pluginDataPath) continue;
                        const localFile = this.app.vault.getAbstractFileByPath(cloudFile.path);
                        const localIndexEntry = this.index[cloudFile.path];
                        const masterIndexEntry = masterIndex[cloudFile.path];
                        if (
                            localFile instanceof TFile &&
                            !localIndexEntry &&
                            masterIndexEntry &&
                            cloudFile.hash === masterIndexEntry.hash
                        ) {
                            const stat = await this.app.vault.adapter.stat(cloudFile.path);
                            this.index[cloudFile.path] = {
                                fileId: cloudFile.id,
                                mtime: stat ? stat.mtime : cloudFile.mtime,
                                size: stat?.size || localFile.stat.size || cloudFile.size,
                                hash: cloudFile.hash,
                            };
                        }
                    }

                    await this.saveIndex();
                    await this.log("--- PULL COMPLETED ---");
                    if (!isSilent || currentOp > 0) new Notice(this.t("pullCompleted"));
                } finally {
                    this.onActivityEnd();
                }
            }
        } catch (e) {
            await this.log(`Pull execution failed: ${e}`);
        }
    }

    public shouldIgnore(path: string): boolean {
        // User-defined exclusion patterns (check first)
        if (this.settings.exclusionPatterns) {
            const patterns = this.settings.exclusionPatterns
                .split("\n")
                .map((p) => p.trim())
                .filter((p) => p);
            for (const pattern of patterns) {
                if (matchWildcard(pattern, path)) {
                    return true;
                }
            }
        }

        // Core ignored prefixes
        const ignorePrefixes = ["_VaultSync_Debug.log", "_VaultSync_Orphans/"];
        if (ignorePrefixes.some((p) => path.startsWith(p))) return true;

        // Selective .obsidian sync
        if (path.startsWith(".obsidian/")) {
            const obsidianExclusions = [
                "workspace.json",
                "workspace-mobile.json",
                "cache/",
                "indexedDB/",
                "backups/",
                "obsidian-vault-sync/sync-index.json", // Don't sync the index ITSELF as a normal file to avoid recursive loops?
                // Actually, we WANT to sync it, but maybe manually or via specialized logic.
                // For now, let's allow the index but ignore transient UI state.
            ];

            // Re-allow specific critical files and plugins
            const isExcluded = obsidianExclusions.some(
                (e) => path.includes("/" + e) || path.endsWith("/" + e),
            );
            if (isExcluded) return true;

            return false; // Sync everything else in .obsidian
        }

        // Ignore hidden files (except .obsidian folder and its contents)
        if (path.startsWith(".") && path !== ".obsidian" && !path.startsWith(".obsidian/"))
            return true;

        return false;
    }

    private async cleanupOrphans() {
        await this.log("=== ORPHAN CLEANUP STARTED ===");
        new Notice(this.t("scanningOrphans"));
        const remoteFiles = await this.adapter.listFiles();
        const remotePaths = new Set(remoteFiles.map((f) => f.path));
        const localFiles = this.app.vault.getFiles();
        const orphanFolderName = "_VaultSync_Orphans";

        await this.log(`listFiles() returned ${remoteFiles.length} items for orphan check`);

        // Safety check: If remote returned nothing or very little, something is wrong
        if (remoteFiles.length === 0) {
            await this.log("ERROR: Remote file list is empty. Aborting orphan cleanup.");
            console.warn("VaultSync: listFiles returned 0 files. Skipping orphan cleanup.");
            new Notice(this.t("errRemoteEmpty"));
            return;
        }

        // Debug: Log first few paths for comparison
        await this.log("Remote paths sample: " + Array.from(remotePaths).slice(0, 5).join(", "));
        await this.log(
            "Local paths sample: " +
                localFiles
                    .slice(0, 5)
                    .map((f) => f.path)
                    .join(", "),
        );

        // Count potential orphans first (dry run)
        let potentialOrphanCount = 0;
        const orphanCandidates: { file: (typeof localFiles)[0]; reason: string }[] = [];

        for (const localFile of localFiles) {
            // Skip system files and the orphan folder itself
            if (
                localFile.path.startsWith(orphanFolderName) ||
                localFile.path.startsWith(".") ||
                localFile.path.includes("/.obsidian/")
            ) {
                continue;
            }

            if (!remotePaths.has(localFile.path)) {
                const indexEntry = this.index[localFile.path];
                if (indexEntry) {
                    potentialOrphanCount++;
                    orphanCandidates.push({
                        file: localFile,
                        reason: "in index but not on remote",
                    });
                }
            }
        }

        // Safety check: If more than 50% of local files would be orphaned, abort
        const nonSystemLocalFiles = localFiles.filter(
            (f) =>
                !f.path.startsWith(orphanFolderName) &&
                !f.path.startsWith(".") &&
                !f.path.includes("/.obsidian/"),
        );
        const orphanRatio = potentialOrphanCount / nonSystemLocalFiles.length;

        if (orphanRatio > 0.5 && potentialOrphanCount > 10) {
            console.error(
                `VaultSync: Orphan ratio ${(orphanRatio * 100).toFixed(1)}% is too high. ` +
                    `${potentialOrphanCount}/${nonSystemLocalFiles.length} files would be moved. Aborting.`,
            );
            new Notice(this.t("errOrphanAborted"));
            console.log("VaultSync Debug: Orphan candidates:", orphanCandidates.slice(0, 10));
            return;
        }

        // Proceed with cleanup
        let orphanCount = 0;
        for (const candidate of orphanCandidates) {
            const localFile = candidate.file;
            const orphanPath = `${orphanFolderName}/${localFile.path}`;
            try {
                await this.ensureLocalFolder(orphanPath);
                await this.app.vault.rename(localFile, orphanPath);
                delete this.index[localFile.path];
                orphanCount++;
                if (orphanCount <= 3) {
                    new Notice(`${this.t("orphanMoved")}: ${localFile.path}`);
                }
            } catch (e) {
                console.error(`Failed to move orphan ${localFile.path}:`, e);
            }
        }

        if (orphanCount > 3) {
            new Notice(`🧹 ... ${orphanCount - 3} ${this.t("orphansMore")}`);
        }
        if (orphanCount > 0) {
            await this.saveIndex();
            new Notice(`✅ ${orphanCount} ${this.t("orphansDone")} ${orphanFolderName}/`);
        }
    }

    // ==========================================================================
    // Hybrid Sync Implementation (Smart Sync + Interruptible Background Scan)
    // ==========================================================================

    /**
     * Mark a file as dirty (modified locally, needs push)
     * Called from main.ts on file modify/create events
     */
    markDirty(path: string) {
        if (!this.shouldIgnore(path) && !this.syncingPaths.has(path)) {
            this.dirtyPaths.add(path);
            this.log(`[Dirty] Marked: ${path}`);
        }
    }

    /**
     * Scan .obsidian directory for changes
     * Vault events don't fire for .obsidian files, so we need to scan manually
     */
    private async scanObsidianChanges(): Promise<void> {
        try {
            const obsidianFiles = await this.listFilesRecursive(".obsidian");

            for (const filePath of obsidianFiles) {
                if (this.shouldIgnore(filePath)) continue;
                if (this.syncingPaths.has(filePath)) continue;

                const stat = await this.app.vault.adapter.stat(filePath);
                if (!stat) continue;

                const indexEntry = this.index[filePath];

                // New file (not in index)
                if (!indexEntry) {
                    this.dirtyPaths.add(filePath);
                    await this.log(`[Obsidian Scan] New: ${filePath}`);
                    continue;
                }

                // Check if modified (mtime changed)
                if (stat.mtime > indexEntry.mtime) {
                    // Verify with hash if available
                    if (indexEntry.hash) {
                        try {
                            const content = await this.app.vault.adapter.readBinary(filePath);
                            const localHash = md5(content);
                            if (localHash !== indexEntry.hash.toLowerCase()) {
                                this.dirtyPaths.add(filePath);
                                await this.log(`[Obsidian Scan] Modified: ${filePath}`);
                            } else {
                                // Hash matches, just update mtime in index
                                this.index[filePath].mtime = stat.mtime;
                            }
                        } catch {
                            // Hash calc failed, mark as dirty to be safe
                            this.dirtyPaths.add(filePath);
                        }
                    } else {
                        // No hash, rely on mtime
                        this.dirtyPaths.add(filePath);
                        await this.log(`[Obsidian Scan] Modified (mtime): ${filePath}`);
                    }
                }
            }
        } catch (e) {
            await this.log(`[Obsidian Scan] Error: ${e}`);
        }
    }

    /**
     * Mark a file as deleted locally (needs remote deletion)
     * Called from main.ts on file delete events
     */
    markDeleted(path: string) {
        // Keep in dirtyPaths so smartPush can detect and delete from remote
        // (smartPush checks if file exists, and if not + in index, adds to deleteQueue)
        if (!this.shouldIgnore(path) && this.index[path]) {
            this.dirtyPaths.add(path);
            this.log(`[Dirty] Marked for deletion: ${path}`);
        }
    }

    /**
     * Mark all files in a folder as deleted locally
     * Called from main.ts on folder delete events
     */
    markFolderDeleted(folderPath: string) {
        const prefix = folderPath + "/";
        for (const path of Object.keys(this.index)) {
            if (path.startsWith(prefix) && !this.shouldIgnore(path)) {
                this.dirtyPaths.add(path);
                this.log(`[Dirty] Marked for deletion (folder): ${path}`);
            }
        }
    }

    /**
     * Mark a file as renamed (handles both regular renames and "create then rename" cases)
     * Called from main.ts on file rename events
     */
    markRenamed(oldPath: string, newPath: string) {
        // Case 1: oldPath is in dirtyPaths but NOT in index
        // This means the file was created and renamed before being synced
        // We should just remove oldPath from dirtyPaths (no remote deletion needed)
        if (this.dirtyPaths.has(oldPath) && !this.index[oldPath]) {
            this.dirtyPaths.delete(oldPath);
            this.log(`[Dirty] Removed (renamed before sync): ${oldPath}`);
        } else {
            // Case 2: Normal rename - file was already synced
            // Mark old path for deletion from remote
            this.markDeleted(oldPath);
        }

        // Always mark new path as dirty (for upload)
        if (!this.shouldIgnore(newPath) && !this.syncingPaths.has(newPath)) {
            this.dirtyPaths.add(newPath);
            this.log(`[Dirty] Marked (renamed): ${newPath}`);
        }
    }

    /**
     * Mark all files in a renamed folder for update
     * Called from main.ts on folder rename events
     */
    markFolderRenamed(oldFolderPath: string, newFolderPath: string) {
        const oldPrefix = oldFolderPath + "/";
        const newPrefix = newFolderPath + "/";

        for (const oldPath of Object.keys(this.index)) {
            if (oldPath.startsWith(oldPrefix)) {
                // Mark old path for deletion
                this.dirtyPaths.add(oldPath);
                this.log(`[Dirty] Marked for deletion (folder rename): ${oldPath}`);

                // Mark new path for upload
                const newPath = newPrefix + oldPath.slice(oldPrefix.length);
                if (!this.shouldIgnore(newPath)) {
                    this.dirtyPaths.add(newPath);
                    this.log(`[Dirty] Marked for upload (folder rename): ${newPath}`);
                }
            }
        }
    }

    /**
     * Get current sync state
     */
    getSyncState(): SyncState {
        return this.syncState;
    }

    /**
     * Check if there are pending dirty files
     */
    hasDirtyFiles(): boolean {
        return this.dirtyPaths.size > 0;
    }

    /**
     * Request Smart Sync - high priority, interrupts full scan
     * This is the main entry point for user-triggered syncs
     */
    async requestSmartSync(isSilent: boolean = true): Promise<void> {
        // If already smart syncing, just wait for it
        if (this.syncState === "SMART_SYNCING") {
            if (this.currentSyncPromise) {
                await this.currentSyncPromise;
            }
            return;
        }

        // Interrupt running full scan
        if (this.syncState === "FULL_SCANNING") {
            await this.log("[Smart Sync] Interrupting full scan...");
            this.isInterrupted = true;
            // Wait for full scan to pause
            if (this.currentSyncPromise) {
                await this.currentSyncPromise;
            }
        }

        // Execute smart sync
        this.syncState = "SMART_SYNCING";
        this.currentSyncPromise = this.executeSmartSync(isSilent);

        try {
            await this.currentSyncPromise;
        } finally {
            this.syncState = "IDLE";
            this.currentSyncPromise = null;
        }
    }

    /**
     * Execute Smart Sync logic
     * - Pull: Check remote changes via sync-index.json hash comparison (or Changes API)
     * - Push: Upload dirty files
     */
    private async executeSmartSync(isSilent: boolean): Promise<void> {
        try {
            await this.log("=== SMART SYNC START ===");
            if (!isSilent) new Notice(`⚡ ${this.t("syncing")}`);

            // Pre-warm adapter (ensure root folders exist) to avoid delay in push phase
            if (this.adapter.initialize) {
                await this.adapter.initialize();
            }

            // === PULL PHASE ===
            await this.smartPull(isSilent);

            // === PUSH PHASE ===
            await this.smartPush(isSilent);

            await this.log("=== SMART SYNC COMPLETED ===");
        } catch (e) {
            await this.log(`Smart Sync failed: ${e}`);
            throw e;
        }
    }

    /**
     * Smart Pull - O(1) check for remote changes using sync-index.json hash
     */
    private async smartPull(isSilent: boolean): Promise<void> {
        await this.log("[Smart Pull] Checking for remote changes...");

        // Check if adapter supports Changes API for faster detection
        if (this.adapter.supportsChangesAPI && this.startPageToken) {
            await this.log("[Smart Pull] Using Changes API (fast path)");
            await this.pullViaChangesAPI(isSilent);
            return;
        }

        // Core path: sync-index.json hash comparison
        await this.log("[Smart Pull] Using sync-index.json hash comparison (core path)");

        // Get remote index metadata (O(1) operation)
        const remoteIndexMeta = await this.adapter.getFileMetadata(this.pluginDataPath);

        if (!remoteIndexMeta) {
            await this.log("[Smart Pull] No remote index found. Skipping pull.");
            return;
        }

        // Compare hashes - use stored hash (from last push) instead of calculating
        // because local file includes self-reference which differs from uploaded content
        const localIndexHash = this.index[this.pluginDataPath]?.hash?.toLowerCase() || "";
        const remoteIndexHash = remoteIndexMeta.hash?.toLowerCase() || "";

        if (localIndexHash && remoteIndexHash && localIndexHash === remoteIndexHash) {
            await this.log("[Smart Pull] Index hash matches. No remote changes detected.");
            if (!isSilent) new Notice(this.t("vaultUpToDate"));
            return;
        }

        // Hashes differ - download remote index and compare
        await this.log(
            `[Smart Pull] Index hash differs (local: ${localIndexHash}, remote: ${remoteIndexHash}). Fetching remote index...`,
        );

        const remoteIndexContent = await this.adapter.downloadFile(remoteIndexMeta.id);
        const remoteIndexData = JSON.parse(new TextDecoder().decode(remoteIndexContent));
        const remoteIndex: LocalFileIndex = remoteIndexData.index || {};

        // Compare indexes to find changes
        const toDownload: Array<{ path: string; fileId: string; hash?: string }> = [];
        const toDeleteLocal: string[] = [];

        // Find files to download (new or modified on remote)
        for (const [path, remoteEntry] of Object.entries(remoteIndex)) {
            if (path === this.pluginDataPath) continue;
            if (this.shouldIgnore(path)) continue;

            const localEntry = this.index[path];

            if (!localEntry) {
                // New file on remote
                toDownload.push({ path, fileId: remoteEntry.fileId, hash: remoteEntry.hash });
            } else if (
                remoteEntry.hash &&
                localEntry.hash &&
                remoteEntry.hash.toLowerCase() !== localEntry.hash.toLowerCase()
            ) {
                // Modified on remote (hash differs)
                toDownload.push({ path, fileId: remoteEntry.fileId, hash: remoteEntry.hash });
            }
        }

        // Find files to delete locally (removed on remote)
        for (const path of Object.keys(this.index)) {
            if (path === this.pluginDataPath) continue;
            if (this.shouldIgnore(path)) continue;

            if (!remoteIndex[path]) {
                toDeleteLocal.push(path);
            }
        }

        await this.log(
            `[Smart Pull] Changes: ${toDownload.length} to download, ${toDeleteLocal.length} to delete`,
        );

        if (toDownload.length === 0 && toDeleteLocal.length === 0) {
            await this.log("[Smart Pull] No file changes detected.");
            // Update index metadata
            this.index[this.pluginDataPath] = {
                fileId: remoteIndexMeta.id,
                mtime: remoteIndexMeta.mtime,
                size: remoteIndexMeta.size,
                hash: remoteIndexMeta.hash,
            };
            await this.saveIndex();
            return;
        }

        // Download changed files
        const tasks: (() => Promise<void>)[] = [];
        let completed = 0;
        const total = toDownload.length + toDeleteLocal.length;

        for (const item of toDownload) {
            tasks.push(async () => {
                try {
                    // Mark as syncing to prevent dirty marking from modify event
                    this.syncingPaths.add(item.path);

                    // Ensure parent folder exists
                    await this.ensureLocalFolder(item.path);

                    const content = await this.adapter.downloadFile(item.fileId);
                    await this.app.vault.adapter.writeBinary(item.path, content);

                    const stat = await this.app.vault.adapter.stat(item.path);
                    this.index[item.path] = {
                        fileId: item.fileId,
                        mtime: stat?.mtime || Date.now(),
                        size: stat?.size || content.byteLength,
                        hash: item.hash,
                    };

                    completed++;
                    await this.log(`[Smart Pull] [${completed}/${total}] Downloaded: ${item.path}`);
                    if (this.settings.showDetailedNotifications) {
                        new Notice(`⬇️ ${item.path.split("/").pop()}`);
                    }
                } catch (e) {
                    await this.log(`[Smart Pull] Download failed: ${item.path} - ${e}`);
                } finally {
                    this.syncingPaths.delete(item.path);
                }
            });
        }

        // Delete local files that were removed on remote
        for (const path of toDeleteLocal) {
            tasks.push(async () => {
                try {
                    const file = this.app.vault.getAbstractFileByPath(path);
                    if (file) {
                        await this.app.vault.trash(file, true);
                    }
                    delete this.index[path];

                    completed++;
                    await this.log(`[Smart Pull] [${completed}/${total}] Deleted locally: ${path}`);
                    if (this.settings.showDetailedNotifications) {
                        new Notice(`🗑️ ${path.split("/").pop()}`);
                    }
                } catch (e) {
                    await this.log(`[Smart Pull] Delete failed: ${path} - ${e}`);
                }
            });
        }

        if (tasks.length > 0) {
            this.onActivityStart();
            try {
                await this.runParallel(tasks);
            } finally {
                this.onActivityEnd();
            }
        }

        // Update index with remote index metadata
        this.index[this.pluginDataPath] = {
            fileId: remoteIndexMeta.id,
            mtime: remoteIndexMeta.mtime,
            size: remoteIndexMeta.size,
            hash: remoteIndexMeta.hash,
        };
        await this.saveIndex();

        if (!isSilent && total > 0) {
            new Notice(`⬇️ ${this.t("pullCompleted")} (${total} files)`);
        }
    }

    /**
     * Pull via Changes API (for adapters that support it)
     */
    private async pullViaChangesAPI(isSilent: boolean): Promise<void> {
        if (!this.startPageToken) {
            this.startPageToken = await this.adapter.getStartPageToken();
            await this.saveIndex();
        }

        const changes = await this.adapter.getChanges(this.startPageToken);

        if (changes.changes.length === 0) {
            await this.log("[Smart Pull] No changes from Changes API");
            if (changes.newStartPageToken) {
                this.startPageToken = changes.newStartPageToken;
                await this.saveIndex();
            }
            return;
        }

        await this.log(`[Smart Pull] Changes API returned ${changes.changes.length} changes`);

        const tasks: (() => Promise<void>)[] = [];
        let completed = 0;

        for (const change of changes.changes) {
            if (change.removed) {
                // File was deleted on remote
                const pathToDelete = Object.entries(this.index).find(
                    ([, entry]) => entry.fileId === change.fileId,
                )?.[0];

                if (pathToDelete && pathToDelete !== this.pluginDataPath) {
                    tasks.push(async () => {
                        try {
                            const file = this.app.vault.getAbstractFileByPath(pathToDelete);
                            if (file) {
                                await this.app.vault.trash(file, true);
                            }
                            delete this.index[pathToDelete];
                            completed++;
                            await this.log(`[Smart Pull] Deleted: ${pathToDelete}`);
                        } catch (e) {
                            await this.log(`[Smart Pull] Delete failed: ${pathToDelete} - ${e}`);
                        }
                    });
                }
            } else if (change.file && change.file.kind === "file") {
                // File was added or modified
                const cloudFile = change.file;
                if (cloudFile.path === this.pluginDataPath) continue;
                if (this.shouldIgnore(cloudFile.path)) continue;

                // Skip if local index hash matches (already synced by this client)
                const localEntry = this.index[cloudFile.path];
                if (
                    localEntry?.hash &&
                    cloudFile.hash &&
                    localEntry.hash.toLowerCase() === cloudFile.hash.toLowerCase()
                ) {
                    await this.log(`[Smart Pull] Skipping (hash match): ${cloudFile.path}`);
                    continue;
                }

                tasks.push(async () => {
                    try {
                        // Mark as syncing to prevent dirty marking from modify event
                        this.syncingPaths.add(cloudFile.path);

                        await this.ensureLocalFolder(cloudFile.path);
                        const content = await this.adapter.downloadFile(cloudFile.id);
                        await this.app.vault.adapter.writeBinary(cloudFile.path, content);

                        const stat = await this.app.vault.adapter.stat(cloudFile.path);
                        this.index[cloudFile.path] = {
                            fileId: cloudFile.id,
                            mtime: stat?.mtime || cloudFile.mtime,
                            size: stat?.size || cloudFile.size,
                            hash: cloudFile.hash,
                        };

                        completed++;
                        await this.log(`[Smart Pull] Downloaded: ${cloudFile.path}`);
                    } catch (e) {
                        await this.log(`[Smart Pull] Download failed: ${cloudFile.path} - ${e}`);
                    } finally {
                        this.syncingPaths.delete(cloudFile.path);
                    }
                });
            }
        }

        if (tasks.length > 0) {
            this.onActivityStart();
            try {
                await this.runParallel(tasks);
            } finally {
                this.onActivityEnd();
            }
        }

        if (changes.newStartPageToken) {
            this.startPageToken = changes.newStartPageToken;
        }
        await this.saveIndex();

        if (!isSilent && tasks.length > 0) {
            new Notice(`⬇️ ${this.t("pullCompleted")} (${tasks.length} changes)`);
        }
    }

    /**
     * Smart Push - upload only dirty files
     * O(1) when no dirty files, O(dirty count + .obsidian scan) otherwise
     */
    private async smartPush(isSilent: boolean): Promise<void> {
        // Scan .obsidian files for changes (vault events don't fire for these)
        await this.scanObsidianChanges();

        if (this.dirtyPaths.size === 0) {
            await this.log("[Smart Push] No dirty files to push. Skipping.");
            return;
        }

        await this.log(`[Smart Push] Pushing ${this.dirtyPaths.size} dirty files...`);

        // Prepare upload queue from dirty paths
        const uploadQueue: Array<{ path: string; mtime: number; size: number }> = [];
        const deleteQueue: string[] = [];

        for (const path of this.dirtyPaths) {
            if (this.shouldIgnore(path)) continue;

            const exists = await this.app.vault.adapter.exists(path);
            if (exists) {
                const stat = await this.app.vault.adapter.stat(path);
                if (stat) {
                    uploadQueue.push({ path, mtime: stat.mtime, size: stat.size });
                }
            } else {
                // File was deleted locally
                if (this.index[path]) {
                    deleteQueue.push(path);
                }
            }
        }

        const totalOps = uploadQueue.length + deleteQueue.length;
        if (totalOps === 0) {
            await this.log("[Smart Push] No changes after filtering.");
            return;
        }

        this.onActivityStart();
        try {
            // Ensure folders exist on remote
            // OPTIMIZATION: Removed listFiles() call here. We just pass the folders we need.
            // The adapter's ensureFoldersExist is smart enough to check existence efficiently (O(depth) vs O(total_files))
            const foldersToCreate = new Set<string>();
            for (const file of uploadQueue) {
                const parts = file.path.split("/");
                for (let i = 1; i < parts.length; i++) {
                    foldersToCreate.add(parts.slice(0, i).join("/"));
                }
            }

            if (foldersToCreate.size > 0) {
                const sortedFolders = Array.from(foldersToCreate).sort(
                    (a, b) => a.length - b.length,
                );
                await this.adapter.ensureFoldersExist(sortedFolders);
            }

            // Execute uploads and deletions
            const tasks: (() => Promise<void>)[] = [];
            let completed = 0;

            for (const file of uploadQueue) {
                tasks.push(async () => {
                    try {
                        const content = await this.app.vault.adapter.readBinary(file.path);
                        const uploaded = await this.adapter.uploadFile(
                            file.path,
                            content,
                            file.mtime,
                        );

                        this.index[file.path] = {
                            fileId: uploaded.id,
                            mtime: file.mtime,
                            size: uploaded.size,
                            hash: uploaded.hash,
                        };

                        completed++;
                        await this.log(
                            `[Smart Push] [${completed}/${totalOps}] Pushed: ${file.path}`,
                        );
                        if (this.settings.showDetailedNotifications) {
                            new Notice(`⬆️ ${file.path.split("/").pop()}`);
                        }
                    } catch (e) {
                        await this.log(`[Smart Push] Upload failed: ${file.path} - ${e}`);
                    }
                });
            }

            for (const path of deleteQueue) {
                tasks.push(async () => {
                    try {
                        const entry = this.index[path];
                        if (entry) {
                            await this.adapter.deleteFile(entry.fileId);
                            delete this.index[path];

                            completed++;
                            await this.log(
                                `[Smart Push] [${completed}/${totalOps}] Deleted remote: ${path}`,
                            );
                        }
                    } catch (e) {
                        await this.log(`[Smart Push] Delete failed: ${path} - ${e}`);
                    }
                });
            }

            await this.runParallel(tasks);

            // Clear dirty paths
            this.dirtyPaths.clear();

            // Upload updated index
            await this.saveIndex();
            try {
                const indexContent = await this.app.vault.adapter.readBinary(this.pluginDataPath);
                const uploadedIndex = await this.adapter.uploadFile(
                    this.pluginDataPath,
                    indexContent,
                    Date.now(),
                );
                this.index[this.pluginDataPath] = {
                    fileId: uploadedIndex.id,
                    mtime: Date.now(),
                    size: uploadedIndex.size,
                    hash: uploadedIndex.hash,
                };
                await this.saveIndex();
                await this.log(`[Smart Push] Index uploaded. Hash: ${uploadedIndex.hash}`);
            } catch (e) {
                await this.log(`[Smart Push] Failed to upload index: ${e}`);
            }

            if (!isSilent && totalOps > 0) {
                new Notice(`⬆️ ${this.t("pushCompleted")} (${totalOps} files)`);
            }
        } finally {
            this.onActivityEnd();
        }
    }

    /**
     * Request Background Full Scan - low priority, can be interrupted
     * @param resume If true, try to resume from previous progress
     */
    async requestBackgroundScan(resume: boolean = false): Promise<void> {
        // Don't start if already syncing
        if (this.syncState !== "IDLE") {
            await this.log("[Full Scan] Skipped - sync already in progress");
            return;
        }

        // Check if we should resume or start fresh
        if (!resume || !this.fullScanProgress || this.isProgressStale()) {
            this.fullScanProgress = null;
        }

        this.syncState = "FULL_SCANNING";
        this.isInterrupted = false;
        this.currentSyncPromise = this.executeFullScan();

        try {
            await this.currentSyncPromise;
        } finally {
            if (this.syncState === "FULL_SCANNING") {
                this.syncState = "IDLE";
            }
            this.currentSyncPromise = null;
        }
    }

    /**
     * Check if stored progress is too old
     */
    private isProgressStale(): boolean {
        if (!this.fullScanProgress) return true;
        return Date.now() - this.fullScanProgress.startedAt > this.FULL_SCAN_MAX_AGE_MS;
    }

    /**
     * Execute Full Scan with interrupt support
     */
    private async executeFullScan(): Promise<void> {
        try {
            await this.log("=== BACKGROUND FULL SCAN START ===");

            // Initialize or resume progress
            if (!this.fullScanProgress) {
                await this.log("[Full Scan] Fetching file lists...");
                const localFiles = await this.getLocalFiles();
                const remoteFiles = await this.adapter.listFiles();

                this.fullScanProgress = {
                    currentIndex: 0,
                    totalFiles: remoteFiles.length,
                    localFiles: localFiles.map((f) => ({
                        path: f.path,
                        mtime: f.mtime,
                        size: f.size,
                    })),
                    remoteFiles: remoteFiles.map((f) => ({
                        id: f.id,
                        path: f.path,
                        mtime: f.mtime,
                        size: f.size,
                        hash: f.hash,
                    })),
                    startedAt: Date.now(),
                };
            } else {
                await this.log(
                    `[Full Scan] Resuming from index ${this.fullScanProgress.currentIndex}/${this.fullScanProgress.totalFiles}`,
                );
            }

            const { localFiles, remoteFiles } = this.fullScanProgress;
            const localPathsMap = new Map(localFiles.map((f) => [f.path, f]));
            const CHUNK_SIZE = 10; // Process in chunks to allow interruption

            // Process remote files in chunks
            while (this.fullScanProgress.currentIndex < remoteFiles.length) {
                // Check for interrupt
                if (this.isInterrupted) {
                    await this.log(
                        `[Full Scan] Interrupted at index ${this.fullScanProgress.currentIndex}`,
                    );
                    this.syncState = "PAUSED";
                    return;
                }

                const chunk = remoteFiles.slice(
                    this.fullScanProgress.currentIndex,
                    this.fullScanProgress.currentIndex + CHUNK_SIZE,
                );

                for (const remoteFile of chunk) {
                    if (remoteFile.path === this.pluginDataPath) continue;
                    if (this.shouldIgnore(remoteFile.path)) continue;

                    const localFile = localPathsMap.get(remoteFile.path);
                    const indexEntry = this.index[remoteFile.path];

                    // Check for discrepancies
                    if (!localFile && indexEntry) {
                        // File exists in index but not locally - might have been deleted
                        await this.log(
                            `[Full Scan] Discrepancy: ${remoteFile.path} in index but not local`,
                        );
                    } else if (localFile && !indexEntry && remoteFile.hash) {
                        // File exists locally but not in index - check if it matches remote
                        try {
                            const content = await this.app.vault.adapter.readBinary(
                                remoteFile.path,
                            );
                            const localHash = md5(content);
                            if (localHash === remoteFile.hash.toLowerCase()) {
                                // Adopt into index
                                this.index[remoteFile.path] = {
                                    fileId: remoteFile.id,
                                    mtime: localFile.mtime,
                                    size: localFile.size,
                                    hash: remoteFile.hash,
                                };
                                await this.log(`[Full Scan] Adopted: ${remoteFile.path}`);
                            }
                        } catch {
                            // Ignore hash calculation errors
                        }
                    }
                }

                this.fullScanProgress.currentIndex += chunk.length;

                // Yield to allow interrupt check
                await new Promise((resolve) => setTimeout(resolve, 0));
            }

            // Scan completed
            await this.log("=== BACKGROUND FULL SCAN COMPLETED ===");
            this.fullScanProgress = null;
            await this.saveIndex();
        } catch (e) {
            await this.log(`[Full Scan] Error: ${e}`);
            this.fullScanProgress = null;
        }
    }
}
