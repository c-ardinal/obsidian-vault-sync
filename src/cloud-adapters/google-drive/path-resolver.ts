import type { GoogleDriveHttpClient } from "./http-client";

/**
 * Manages Google Drive folder resolution, path caching, and root folder discovery.
 *
 * Extracted from GoogleDriveAdapter to separate path/folder concerns
 * from file CRUD operations.
 */
export class DrivePathResolver {
    appRootId: string | null = null;
    vaultRootId: string | null = null;

    private folderCache: Map<string, string> = new Map();
    private initPromise: Promise<string> | null = null;
    private resolveCache: Map<string, Promise<string>> = new Map();
    private idToPathCache: Map<string, string> = new Map();
    private resolvePathCache: Map<string, string> = new Map();
    private outsideFolderIds: Set<string> = new Set();
    private cloudRootFolder: string;

    private logger: ((msg: string, level?: string) => void) | null = null;

    constructor(
        private http: GoogleDriveHttpClient,
        public vaultName: string,
        cloudRootFolder: string,
    ) {
        this.cloudRootFolder = this.validateRootFolder(cloudRootFolder);
    }

    setLogger(logger: (msg: string, level?: string) => void) {
        this.logger = logger;
    }

    private async log(msg: string, level: string = "debug") {
        console.log(`VaultSync: [${level.toUpperCase()}] ${msg}`);
        if (this.logger) this.logger(msg, level);
    }

    private validateRootFolder(folder: string | undefined): string {
        if (!folder || folder.trim() === "") return "ObsidianVaultSync";
        const sanitized = folder.trim();
        if (sanitized.startsWith("/") || sanitized.includes("\\") || sanitized.length > 255) {
            return "ObsidianVaultSync";
        }
        if (/[<>:"|?*]/.test(sanitized)) {
            return "ObsidianVaultSync";
        }
        return sanitized;
    }

    get rootFolder(): string {
        return this.cloudRootFolder;
    }

    async initialize(): Promise<void> {
        await this.ensureRootFolders();
    }

    async getAppRootId(): Promise<string> {
        await this.ensureRootFolders();
        if (!this.appRootId) throw new Error("App root not found");
        return this.appRootId;
    }

    reset(): void {
        this.appRootId = null;
        this.vaultRootId = null;
        this.initPromise = null;
        this.folderCache.clear();
        this.resolveCache.clear();
        this.idToPathCache.clear();
        this.resolvePathCache.clear();
        this.outsideFolderIds.clear();
    }

    updateConfig(vaultName?: string, cloudRootFolder?: string): void {
        const newRoot = this.validateRootFolder(cloudRootFolder);
        if (vaultName && vaultName !== this.vaultName) {
            this.vaultName = vaultName;
            this.appRootId = null;
            this.vaultRootId = null;
            this.folderCache.clear();
        }
        if (newRoot !== this.cloudRootFolder) {
            this.cloudRootFolder = newRoot;
            this.appRootId = null;
            this.vaultRootId = null;
            this.folderCache.clear();
            this.initPromise = null;
        }
    }

    /** Update caches after file upload/move operations. */
    cacheIdToPath(id: string, path: string): void {
        this.idToPathCache.set(id, path);
        this.resolvePathCache.set(id, path);
    }

    async ensureRootFolders(): Promise<string> {
        if (this.initPromise) {
            return this.initPromise;
        }

        this.initPromise = (async (): Promise<string> => {
            try {
                if (this.vaultRootId) {
                    return this.vaultRootId;
                }

                await this.log("=== ROOT DISCOVERY STARTED ===", "info");

                // 1. Ensure app root folder exists
                if (!this.appRootId) {
                    const query = `name = '${this.http.escapeQueryValue(
                        this.cloudRootFolder,
                    )}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
                    const response = await this.http.fetchWithAuth(
                        `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name,parents)`,
                    );
                    const data: any = await response.json();

                    if (data.files && data.files.length > 0) {
                        this.appRootId = data.files[0].id;
                        await this.log(
                            `Found app root(s): ${data.files.length}. Using: ${this.appRootId}`,
                            "system",
                        );
                    } else {
                        this.appRootId = await this.createFolder(this.cloudRootFolder);
                        await this.log(`Created fresh app root: ${this.appRootId}`, "system");
                    }
                }

                // Ensure appRootId is not null
                if (!this.appRootId) throw new Error("Failed to resolve App Root ID");

                // 2. Ensure vault root "ObsidianVaultSync/<VaultName>" exists
                const escapedVaultName = this.http.escapeQueryValue(this.vaultName);
                const query = `name = '${escapedVaultName}' and '${this.appRootId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
                const response = await this.http.fetchWithAuth(
                    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name,modifiedTime)`,
                );
                const data: any = await response.json();

                await this.log(
                    `Vault folder search for "${this.vaultName}" returned ${data.files?.length || 0} items`,
                    "system",
                );

                if (data.files && data.files.length > 0) {
                    if (data.files.length > 1) {
                        await this.log(
                            `WARNING! Multiple Vault folders detected in app root: ${data.files.map((f: any) => f.id).join(", ")}`,
                            "warn",
                        );
                        data.files.sort(
                            (a: any, b: any) =>
                                new Date(b.modifiedTime).getTime() -
                                new Date(a.modifiedTime).getTime(),
                        );
                    }
                    this.vaultRootId = data.files[0].id;
                    await this.log(
                        `Picking vault root from app root: ${this.vaultRootId}`,
                        "system",
                    );
                } else {
                    await this.log(
                        "Vault folder not found in app root. Performing GLOBAL search...",
                        "info",
                    );
                    const globalQuery = `name = '${escapedVaultName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
                    const globalResp = await this.http.fetchWithAuth(
                        `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(globalQuery)}&fields=files(id,name,parents,modifiedTime)`,
                    );
                    const globalData: any = await globalResp.json();

                    if (globalData.files && globalData.files.length > 0) {
                        await this.log(
                            `Global search found ${globalData.files.length} possible vaults.`,
                            "system",
                        );
                        globalData.files.sort(
                            (a: any, b: any) =>
                                new Date(b.modifiedTime).getTime() -
                                new Date(a.modifiedTime).getTime(),
                        );
                        const bestMatch = globalData.files[0];
                        this.vaultRootId = bestMatch.id;
                        await this.log(
                            `Adopting global vault: ${this.vaultRootId} (Parent ID: ${bestMatch.parents?.join(", ")})`,
                            "system",
                        );

                        try {
                            const currentParent = bestMatch.parents?.[0];
                            if (currentParent && currentParent !== this.appRootId) {
                                await this.log(
                                    `Consolidating: Moving manually uploaded vault to ObsidianVaultSync...`,
                                    "system",
                                );
                                await this.http.fetchWithAuth(
                                    `https://www.googleapis.com/drive/v3/files/${this.vaultRootId}?addParents=${this.appRootId}&removeParents=${currentParent}`,
                                    {
                                        method: "PATCH",
                                    },
                                );
                            }
                        } catch (e) {
                            await this.log(
                                `Failed to move vault to app root (ignoring): ${e}`,
                                "warn",
                            );
                        }
                    } else {
                        await this.log(
                            "No existing vault found anywhere. Creating new vault folder in app root...",
                            "info",
                        );
                        this.vaultRootId = await this.createFolder(this.vaultName, this.appRootId!);
                        await this.log(`Created new vault root: ${this.vaultRootId}`, "system");
                    }
                }

                if (!this.vaultRootId) throw new Error("Failed to resolve Vault Root ID");
                return this.vaultRootId;
            } catch (e) {
                // Clear cached promise so the next call retries instead of
                // returning the same stale rejection forever.
                this.initPromise = null;
                throw e;
            }
        })();

        return this.initPromise!;
    }

    async resolveParentId(path: string, create: boolean = true): Promise<string> {
        const rootId = await this.ensureRootFolders();
        const parts = path.split("/").filter((p) => p);
        if (parts.length <= 1) return rootId;

        const folderPath = parts.slice(0, -1).join("/");

        // Check resolveCache first
        const existingPromise = this.resolveCache.get(folderPath);
        if (existingPromise) {
            try {
                return await existingPromise;
            } catch (e) {
                // If the cached promise was rejected (e.g. not found with create=false),
                // and we now want to create, we should proceed to try again.
                if (!create) throw e;
                this.resolveCache.delete(folderPath);
            }
        }

        const promise = (async () => {
            let currentParentId = rootId;
            const folderPathParts = parts.slice(0, -1);
            let pathAccumulator = "";

            for (const part of folderPathParts) {
                pathAccumulator += (pathAccumulator ? "/" : "") + part;

                // Also check folderCache within the loop
                if (this.folderCache.has(pathAccumulator)) {
                    currentParentId = this.folderCache.get(pathAccumulator)!;
                    continue;
                }

                const query = `name = '${this.http.escapeQueryValue(
                    part,
                )}' and '${currentParentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
                const response = await this.http.fetchWithAuth(
                    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}`,
                );
                const data = await response.json();

                if (data.files && data.files.length > 0) {
                    currentParentId = data.files[0].id;
                } else if (create) {
                    currentParentId = await this.createFolder(part, currentParentId);
                } else {
                    throw new Error(`Folder not found: ${pathAccumulator}`);
                }
                this.folderCache.set(pathAccumulator, currentParentId);

                // If this is a sub-path, we can cache its resolution as well
                if (pathAccumulator !== folderPath && !this.resolveCache.has(pathAccumulator)) {
                    this.resolveCache.set(pathAccumulator, Promise.resolve(currentParentId));
                }
            }
            return currentParentId;
        })();

        // Only cache if we are creating or if it succeeded.
        // To prevent "spoiling" the cache with a rejection when create=false,
        // we wrap it to catch errors and cleanup.
        this.resolveCache.set(folderPath, promise);

        try {
            return await promise;
        } catch (e) {
            // Cleanup cache on failure so next attempt (possibly with create=true) can retry
            if (this.resolveCache.get(folderPath) === promise) {
                this.resolveCache.delete(folderPath);
            }
            throw e;
        }
    }

    async resolveFullPath(fileId: string): Promise<string> {
        // Quick lookup for recently uploaded files or previously resolved ones
        const cachedPath = this.idToPathCache.get(fileId) || this.resolvePathCache.get(fileId);
        if (cachedPath) return cachedPath;

        let currentId = fileId;
        const pathParts: string[] = [];
        const encounteredIds: string[] = [];

        await this.ensureRootFolders();
        if (!this.vaultRootId) throw new Error("Vault root not initialized");

        while (true) {
            if (currentId === this.vaultRootId) break;

            // Check if we already know this ID is OUTSIDE the vault
            if (this.outsideFolderIds.has(currentId)) {
                encounteredIds.forEach((id) => this.outsideFolderIds.add(id));
                throw new Error("File is outside the vault root (cached)");
            }

            // Check if we already know the path for this intermediate folder
            const folderPath = this.resolvePathCache.get(currentId);
            if (folderPath) {
                pathParts.unshift(folderPath);
                break;
            }

            try {
                const response = await this.http.fetchWithAuth(
                    `https://www.googleapis.com/drive/v3/files/${currentId}?fields=id,name,parents`,
                );
                const file = await response.json();

                if (!file.id) throw new Error(`File not found: ${currentId}`);

                encounteredIds.push(currentId);
                pathParts.unshift(file.name);

                if (!file.parents || file.parents.length === 0) {
                    // Reached the root of Drive without hitting vaultRootId
                    // This means the file is OUTSIDE the vault.
                    encounteredIds.forEach((id) => this.outsideFolderIds.add(id));
                    throw new Error("File is outside the vault root");
                }
                currentId = file.parents[0];
            } catch (error: any) {
                // If it's a 403/404 or our own "outside" error, abort resolution
                // SyncManager will catch this at the getChanges level and mark as removed/ignored.
                if (
                    error.message?.includes("outside") ||
                    error.message?.includes("404") ||
                    error.message?.includes("403")
                ) {
                    encounteredIds.forEach((id) => this.outsideFolderIds.add(id));
                }
                throw error;
            }
        }

        const fullPath = pathParts.join("/");
        this.resolvePathCache.set(fileId, fullPath);
        return fullPath;
    }

    async createFolder(name: string, parentId?: string): Promise<string> {
        const metadata: any = {
            name: name,
            mimeType: "application/vnd.google-apps.folder",
        };
        if (parentId) metadata.parents = [parentId];

        const response = await this.http.fetchWithAuth("https://www.googleapis.com/drive/v3/files", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(metadata),
        });

        const data = await response.json();
        return data.id;
    }

    async ensureFoldersExist(
        folderPaths: string[],
        onProgress?: (current: number, total: number, name: string) => void,
    ): Promise<void> {
        // First ensure root folders exist
        await this.ensureRootFolders();

        // Deduplicate and group paths by depth
        const uniquePaths = Array.from(new Set(folderPaths));
        const depthMap = new Map<number, string[]>();

        for (const path of uniquePaths) {
            const depth = path.split("/").filter((p) => p).length;
            if (!depthMap.has(depth)) depthMap.set(depth, []);
            depthMap.get(depth)!.push(path);
        }

        // Sort depths and process each level
        const depths = Array.from(depthMap.keys()).sort((a, b) => a - b);
        const total = uniquePaths.length;
        let current = 0;

        const FOLDER_CONCURRENCY = 10;

        for (const depth of depths) {
            const foldersAtDepth = depthMap.get(depth)!;

            // Process folders at this depth in parallel (up to FOLDER_CONCURRENCY)
            for (let i = 0; i < foldersAtDepth.length; i += FOLDER_CONCURRENCY) {
                const chunk = foldersAtDepth.slice(i, i + FOLDER_CONCURRENCY);

                await Promise.all(
                    chunk.map(async (folderPath) => {
                        current++;
                        if (onProgress) onProgress(current, total, folderPath);

                        const parts = folderPath.split("/").filter((p) => p);
                        let currentParentId = this.vaultRootId!;
                        let pathAccumulator = "";

                        for (const part of parts) {
                            pathAccumulator += (pathAccumulator ? "/" : "") + part;

                            if (this.folderCache.has(pathAccumulator)) {
                                currentParentId = this.folderCache.get(pathAccumulator)!;
                            } else {
                                // Double check on remote to avoid duplicates
                                const query = `name = '${this.http.escapeQueryValue(
                                    part,
                                )}' and '${currentParentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
                                const response = await this.http.fetchWithAuth(
                                    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name)`,
                                );
                                const data = await response.json();

                                if (data.files && data.files.length > 0) {
                                    currentParentId = data.files[0].id;
                                    console.log(
                                        `VaultSync: Found existing folder: ${pathAccumulator} (id=${currentParentId})`,
                                    );
                                } else {
                                    currentParentId = await this.createFolder(
                                        part,
                                        currentParentId,
                                    );
                                    console.log(
                                        `VaultSync: Created new folder: ${pathAccumulator} (id=${currentParentId})`,
                                    );
                                }
                                this.folderCache.set(pathAccumulator, currentParentId);
                                // Also populate resolveCache for intermediate paths
                                if (!this.resolveCache.has(pathAccumulator)) {
                                    this.resolveCache.set(
                                        pathAccumulator,
                                        Promise.resolve(currentParentId),
                                    );
                                }
                            }
                        }
                    }),
                );
            }
        }
    }

    /** Clear folder and resolve caches. Called at start of listFiles for fresh state. */
    clearFolderCaches(): void {
        this.vaultRootId = null;
        this.initPromise = null;
        this.folderCache.clear();
        this.resolveCache.clear();
    }

    /** Get folder ID by name, optionally within a parent. */
    async getFolderIdByName(name: string, parentId?: string): Promise<string | null> {
        const safeName = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        let query = `name = '${safeName}' and trashed = false and mimeType = 'application/vnd.google-apps.folder'`;
        if (parentId) {
            const safeParentId = parentId.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
            query += ` and '${safeParentId}' in parents`;
        }
        const resp = await this.http.fetchWithAuth(
            `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name)`,
        );
        const data = await resp.json();
        return data.files?.[0]?.id || null;
    }
}
