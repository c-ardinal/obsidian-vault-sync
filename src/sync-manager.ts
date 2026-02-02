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

export class SyncManager {
    private index: LocalFileIndex = {};
    private startPageToken: string | null = null;
    private isSyncing = false;
    private logFolder: string;

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
                    await this.adapter.ensureFoldersExist(sortedFolders, (current, total, name) => {
                        if (this.settings.showDetailedNotifications) {
                            new Notice(`${this.t("folderCreated")}: ${name}`);
                        }
                    });
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
                            const content = await this.app.vault.adapter.readBinary(localFile.path);
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
            }

            await this.saveIndex();

            // 3. Final Step: Upload Index
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
                await this.log(`  Master index uploaded to cloud. Hash: ${uploadedIndex.hash}`);
                // CRITICAL: Save again to persist self-referential metadata
                await this.saveIndex();
            } catch (e) {
                await this.log(`  Failed to upload master index: ${e}`);
            }

            await this.log("--- PUSH COMPLETED ---");
            if (currentOp > 0) new Notice(this.t("pushCompleted"));
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
                            const localFile = this.app.vault.getAbstractFileByPath(cloudFile.path);
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
            }

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
}
