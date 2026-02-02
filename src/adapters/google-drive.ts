import { CloudAdapter, CloudChanges, CloudFile } from "../types/adapter";
import { generateCodeChallenge, generateCodeVerifier } from "../auth/pkce";
import { Platform } from "obsidian";

const DEFAULT_ROOT_FOLDER = "ObsidianVaultSync";

export class GoogleDriveAdapter implements CloudAdapter {
    name = "Google Drive";

    private appRootId: string | null = null;
    private vaultRootId: string | null = null;
    private folderCache: Map<string, string> = new Map();
    private initPromise: Promise<string> | null = null;
    private resolveCache: Map<string, Promise<string>> = new Map();
    private cloudRootFolder: string = DEFAULT_ROOT_FOLDER;

    constructor(
        private _clientId: string,
        private _clientSecret: string,
        private vaultName: string,
        cloudRootFolder?: string,
    ) {
        this.cloudRootFolder = this.validateRootFolder(cloudRootFolder);
    }

    get clientId(): string {
        return this._clientId;
    }

    get clientSecret(): string {
        return this._clientSecret;
    }

    setCredentials(clientId: string, clientSecret: string) {
        this._clientId = clientId;
        this._clientSecret = clientSecret;
        // reset caches or re-auth might be needed if credentials change significantly,
        // but for now just updating state is enough as Auth flow will use new values.
    }

    private validateRootFolder(folder: string | undefined): string {
        if (!folder || folder.trim() === "") return DEFAULT_ROOT_FOLDER;
        // Disallow slashes, special chars, too long names
        const sanitized = folder.trim();
        if (sanitized.startsWith("/") || sanitized.includes("\\") || sanitized.length > 255) {
            return DEFAULT_ROOT_FOLDER;
        }
        // Disallow illegal characters for folder names
        if (/[<>:"|?*]/.test(sanitized)) {
            return DEFAULT_ROOT_FOLDER;
        }
        return sanitized;
    }

    private logger: ((msg: string) => void) | null = null;
    setLogger(logger: (msg: string) => void) {
        this.logger = logger;
    }

    private async log(msg: string) {
        console.log(`VaultSync: ${msg}`);
        if (this.logger) this.logger(msg);
    }

    updateConfig(
        clientId: string,
        clientSecret: string,
        vaultName?: string,
        cloudRootFolder?: string,
    ) {
        this._clientId = clientId;
        this._clientSecret = clientSecret;
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

    private accessToken: string | null = null;
    private refreshToken: string | null = null;
    private codeVerifier: string | null = null;
    private currentAuthState: string | null = null;

    isAuthenticated(): boolean {
        return !!this.accessToken;
    }

    getTokens(): { accessToken: string | null; refreshToken: string | null } {
        return {
            accessToken: this.accessToken,
            refreshToken: this.refreshToken,
        };
    }

    setTokens(accessToken: string | null, refreshToken: string | null) {
        this.accessToken = accessToken;
        this.refreshToken = refreshToken;
    }

    getAuthStatus(): string {
        if (this.accessToken) return "Authenticated";
        if (this.refreshToken) return "Token available (Requires refresh)";
        return "Not authenticated";
    }

    private getRedirectUri(): string {
        // Use loopback even on mobile to satisfy Google's "Desktop App" / "Web App" validation.
        // On mobile, Obsidian doesn't run a server, so the browser will fail to redirect,
        // but the user can then manually copy the code from the address bar.
        return "http://localhost:42813";
    }

    async getAuthUrl(): Promise<string> {
        this.codeVerifier = await generateCodeVerifier();
        const challenge = await generateCodeChallenge(this.codeVerifier);
        this.currentAuthState = Math.random().toString(36).substring(2);

        const params = new URLSearchParams({
            client_id: this.clientId,
            redirect_uri: this.getRedirectUri(),
            response_type: "code",
            scope: "https://www.googleapis.com/auth/drive",
            code_challenge: challenge,
            code_challenge_method: "S256",
            state: this.currentAuthState,
            access_type: "offline",
            prompt: "consent",
        });

        return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
    }

    async login(): Promise<void> {
        const authUrl = await this.getAuthUrl();
        window.open(authUrl);

        if (!Platform.isMobile) {
            const { startReceiverServer } = await import("../auth/receiver");
            try {
                const code = await startReceiverServer(42813, this.currentAuthState!);
                await this.exchangeCodeForToken(code);
            } catch (e) {
                console.error("Auth failed", e);
                throw e;
            }
        }
    }

    async exchangeCodeForToken(code: string): Promise<void> {
        const body = new URLSearchParams({
            client_id: this.clientId,
            client_secret: this.clientSecret,
            code: code,
            code_verifier: this.codeVerifier!,
            grant_type: "authorization_code",
            redirect_uri: this.getRedirectUri(),
        });

        const response = await fetch("https://oauth2.googleapis.com/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: body.toString(),
        });

        const data = await response.json();
        if (data.error) throw new Error(data.error_description || data.error);

        this.accessToken = data.access_token;
        this.refreshToken = data.refresh_token;
        // In a real app, save these to secure storage
    }

    async handleCallback(url: string | URL): Promise<void> {
        const urlObj = typeof url === "string" ? new URL(url) : url;
        const code = urlObj.searchParams.get("code");
        const state = urlObj.searchParams.get("state");

        if (state !== this.currentAuthState) throw new Error("Invalid state");
        if (code) await this.exchangeCodeForToken(code);
    }

    async logout(): Promise<void> {
        // TODO: Implement logout
    }
    private async fetchWithAuth(url: string, options: RequestInit = {}): Promise<Response> {
        if (!this.accessToken) throw new Error("Not authenticated");

        const headers = new Headers(options.headers || {});
        headers.set("Authorization", `Bearer ${this.accessToken}`);

        const response = await fetch(url, { ...options, headers });

        if (response.status === 401 && this.refreshToken) {
            await this.refreshTokens();
            return this.fetchWithAuth(url, options);
        }

        if (!response.ok) {
            let body = "";
            try {
                body = await response.text();
            } catch (e) {
                body = "Could not read error body";
            }
            throw new Error(`API Error ${response.status}: ${body}`);
        }

        return response;
    }

    private async refreshTokens() {
        const body = new URLSearchParams({
            client_id: this.clientId,
            client_secret: this.clientSecret,
            refresh_token: this.refreshToken!,
            grant_type: "refresh_token",
        });

        const response = await fetch("https://oauth2.googleapis.com/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: body.toString(),
        });

        const data = await response.json();
        this.accessToken = data.access_token;
        if (data.refresh_token) this.refreshToken = data.refresh_token;
    }

    private async ensureRootFolders(): Promise<string> {
        if (this.initPromise) {
            return this.initPromise;
        }

        this.initPromise = (async (): Promise<string> => {
            if (this.vaultRootId) {
                return this.vaultRootId;
            }

            await this.log("=== ROOT DISCOVERY STARTED ===");

            // 1. Ensure app root folder exists
            if (!this.appRootId) {
                const query = `name = '${this.cloudRootFolder}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
                const response = await this.fetchWithAuth(
                    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name,parents)`,
                );
                const data: any = await response.json();

                if (data.files && data.files.length > 0) {
                    this.appRootId = data.files[0].id;
                    await this.log(
                        `Found app root(s): ${data.files.length}. Using: ${this.appRootId}`,
                    );
                } else {
                    this.appRootId = await this.createFolder(this.cloudRootFolder);
                    await this.log(`Created fresh app root: ${this.appRootId}`);
                }
            }

            // Ensure appRootId is not null
            if (!this.appRootId) throw new Error("Failed to resolve App Root ID");

            // 2. Ensure vault root "ObsidianVaultSync/<VaultName>" exists
            const escapedVaultName = this.vaultName.replace(/'/g, "\\'");
            const query = `name = '${escapedVaultName}' and '${this.appRootId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
            const response = await this.fetchWithAuth(
                `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name,modifiedTime)`,
            );
            const data: any = await response.json();

            await this.log(
                `Vault folder search for "${this.vaultName}" returned ${data.files?.length || 0} items`,
            );

            if (data.files && data.files.length > 0) {
                if (data.files.length > 1) {
                    await this.log(
                        `WARNING! Multiple Vault folders detected in app root: ${data.files.map((f: any) => f.id).join(", ")}`,
                    );
                    data.files.sort(
                        (a: any, b: any) =>
                            new Date(b.modifiedTime).getTime() - new Date(a.modifiedTime).getTime(),
                    );
                }
                this.vaultRootId = data.files[0].id;
                await this.log(`Picking vault root from app root: ${this.vaultRootId}`);
            } else {
                await this.log("Vault folder not found in app root. Performing GLOBAL search...");
                const globalQuery = `name = '${escapedVaultName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
                const globalResp = await this.fetchWithAuth(
                    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(globalQuery)}&fields=files(id,name,parents,modifiedTime)`,
                );
                const globalData: any = await globalResp.json();

                if (globalData.files && globalData.files.length > 0) {
                    await this.log(
                        `Global search found ${globalData.files.length} possible vaults.`,
                    );
                    globalData.files.sort(
                        (a: any, b: any) =>
                            new Date(b.modifiedTime).getTime() - new Date(a.modifiedTime).getTime(),
                    );
                    const bestMatch = globalData.files[0];
                    this.vaultRootId = bestMatch.id;
                    await this.log(
                        `Adopting global vault: ${this.vaultRootId} (Parent ID: ${bestMatch.parents?.join(", ")})`,
                    );

                    try {
                        const currentParent = bestMatch.parents?.[0];
                        if (currentParent && currentParent !== this.appRootId) {
                            await this.log(
                                `Consolidating: Moving manually uploaded vault to ObsidianVaultSync...`,
                            );
                            await this.fetchWithAuth(
                                `https://www.googleapis.com/drive/v3/files/${this.vaultRootId}?addParents=${this.appRootId}&removeParents=${currentParent}`,
                                {
                                    method: "PATCH",
                                },
                            );
                        }
                    } catch (e) {
                        await this.log(`Failed to move vault to app root (ignoring): ${e}`);
                    }
                } else {
                    await this.log(
                        "No existing vault found anywhere. Creating new vault folder in app root...",
                    );
                    this.vaultRootId = await this.createFolder(this.vaultName, this.appRootId!);
                    await this.log(`Created new vault root: ${this.vaultRootId}`);
                }
            }

            if (!this.vaultRootId) throw new Error("Failed to resolve Vault Root ID");
            return this.vaultRootId;
        })();

        return this.initPromise!;
    }

    private async resolveParentId(path: string): Promise<string> {
        const rootId = await this.ensureRootFolders();
        const parts = path.split("/").filter((p) => p);
        if (parts.length <= 1) return rootId;

        const folderPath = parts.slice(0, -1).join("/");
        if (this.resolveCache.has(folderPath)) {
            return this.resolveCache.get(folderPath)!;
        }

        const promise = (async () => {
            let currentParentId = rootId;
            const folderPathParts = parts.slice(0, -1);
            let pathAccumulator = "";

            for (const part of folderPathParts) {
                pathAccumulator += (pathAccumulator ? "/" : "") + part;
                if (this.folderCache.has(pathAccumulator)) {
                    currentParentId = this.folderCache.get(pathAccumulator)!;
                    continue;
                }

                const query = `name = '${part}' and '${currentParentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
                const response = await this.fetchWithAuth(
                    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}`,
                );
                const data = await response.json();

                if (data.files && data.files.length > 0) {
                    currentParentId = data.files[0].id;
                } else {
                    currentParentId = await this.createFolder(part, currentParentId);
                }
                this.folderCache.set(pathAccumulator, currentParentId);
            }
            return currentParentId;
        })();

        this.resolveCache.set(folderPath, promise);
        return promise;
    }

    async getFileMetadata(path: string): Promise<CloudFile | null> {
        const parentId = await this.resolveParentId(path);
        const name = path.split("/").pop();
        const query = `name = '${name}' and '${parentId}' in parents and trashed = false`;
        const response = await this.fetchWithAuth(
            `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name,mimeType,modifiedTime,size,md5Checksum)`,
        );
        const data = await response.json();

        if (data.files && data.files.length > 0) {
            const file = data.files[0];
            return {
                id: file.id,
                path: path,
                mtime: new Date(file.modifiedTime).getTime(),
                size: parseInt(file.size || "0"),
                kind: file.mimeType === "application/vnd.google-apps.folder" ? "folder" : "file",
                hash: file.md5Checksum,
            };
        }
        return null;
    }

    async downloadFile(fileId: string): Promise<ArrayBuffer> {
        const response = await this.fetchWithAuth(
            `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
        );
        return await response.arrayBuffer();
    }

    async uploadFile(path: string, content: ArrayBuffer, mtime: number): Promise<CloudFile> {
        const parentId = await this.resolveParentId(path);
        const name = path.split("/").pop();
        const metadata: any = {
            name: name,
            modifiedTime: new Date(mtime).toISOString(),
        };

        const existing = await this.getFileMetadata(path);

        let url =
            "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,md5Checksum,size";
        let method = "POST";

        if (existing) {
            url = `https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=multipart&fields=id,md5Checksum,size`;
            method = "PATCH";
        } else {
            metadata.parents = [parentId];
        }

        const boundary = "-------314159265358979323846";
        const header = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`;
        const footer = `\r\n--${boundary}--`;

        const encoder = new TextEncoder();
        const headerArray = encoder.encode(header);
        const footerArray = encoder.encode(footer);

        const bodyArray = new Uint8Array(
            headerArray.byteLength + content.byteLength + footerArray.byteLength,
        );
        bodyArray.set(headerArray, 0);
        bodyArray.set(new Uint8Array(content), headerArray.byteLength);
        bodyArray.set(footerArray, headerArray.byteLength + content.byteLength);

        const response = await this.fetchWithAuth(url, {
            method: method,
            headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
            body: bodyArray,
        });

        const data = await response.json();
        return {
            id: data.id,
            path: path,
            mtime: mtime,
            size: parseInt(data.size || String(content.byteLength)),
            kind: "file",
            hash: data.md5Checksum,
        };
    }

    async deleteFile(fileId: string): Promise<void> {
        await this.fetchWithAuth(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
            method: "DELETE",
        });
    }

    async createFolder(name: string, parentId?: string): Promise<string> {
        const metadata: any = {
            name: name,
            mimeType: "application/vnd.google-apps.folder",
        };
        if (parentId) metadata.parents = [parentId];

        const response = await this.fetchWithAuth("https://www.googleapis.com/drive/v3/files", {
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

        const FOLDER_CONCURRENCY = 5;

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
                                const query = `name = '${part.replace(/'/g, "\\'")}' and '${currentParentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
                                const response = await this.fetchWithAuth(
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
                            }
                        }
                    }),
                );
            }
        }
    }

    async fileExistsById(fileId: string): Promise<boolean> {
        try {
            const response = await this.fetchWithAuth(
                `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,trashed`,
            );
            const data = await response.json();
            return data.id && !data.trashed;
        } catch (e) {
            return false;
        }
    }

    async getStartPageToken(): Promise<string> {
        const response = await this.fetchWithAuth(
            "https://www.googleapis.com/drive/v3/changes/startPageToken",
        );
        const data = await response.json();
        return data.startPageToken;
    }

    async getChanges(pageToken: string): Promise<CloudChanges> {
        const response = await this.fetchWithAuth(
            `https://www.googleapis.com/drive/v3/changes?pageToken=${pageToken}&fields=*`,
        );
        const data = await response.json();

        return {
            newStartPageToken: data.newStartPageToken,
            changes: await Promise.all(
                data.changes.map(async (c: any) => {
                    let fullPath = c.file ? c.file.name : "";
                    if (c.file && !c.removed && c.file.parents) {
                        try {
                            fullPath = await this.resolveFullPath(c.file.id);
                        } catch (e) {
                            console.warn(`Failed to resolve path for ${c.fileId}:`, e);
                            // If resolution fails (e.g. moved out of vault), treat as removed or ignore
                            return { fileId: c.fileId, removed: true };
                        }
                    }

                    return {
                        fileId: c.fileId,
                        removed: c.removed,
                        file: c.file
                            ? {
                                  id: c.file.id,
                                  path: fullPath,
                                  mtime: new Date(c.file.modifiedTime).getTime(),
                                  size: parseInt(c.file.size || "0"),
                                  kind:
                                      c.file.mimeType === "application/vnd.google-apps.folder"
                                          ? "folder"
                                          : "file",
                                  hash: c.file.md5Checksum,
                              }
                            : undefined,
                    };
                }),
            ),
        };
    }

    private async resolveFullPath(fileId: string): Promise<string> {
        let currentId = fileId;
        const pathParts: string[] = [];

        await this.ensureRootFolders();
        if (!this.vaultRootId) throw new Error("Vault root not initialized");

        while (true) {
            if (currentId === this.vaultRootId) break;

            const response = await this.fetchWithAuth(
                `https://www.googleapis.com/drive/v3/files/${currentId}?fields=id,name,parents`,
            );
            const file = await response.json();

            if (!file.id) throw new Error(`File not found: ${currentId}`);

            // Don't add the file itself if we are looking up its parents,
            // but for the first iteration (the file itself), we need its name.
            if (currentId === fileId) {
                pathParts.unshift(file.name);
            } else {
                pathParts.unshift(file.name);
            }

            if (!file.parents || file.parents.length === 0) {
                // Reached root or outside of vault without hitting vaultRootId
                throw new Error("File is outside the vault folder");
            }

            // Move up to parent
            currentId = file.parents[0];

            // Optimization: If parent is vault root, stop here
            if (currentId === this.vaultRootId) {
                break;
            }
        }

        return pathParts.join("/");
    }

    async listFiles(folderId?: string): Promise<CloudFile[]> {
        // Clear cached vaultRootId to force fresh lookup (fixes stale pointer bug)
        this.vaultRootId = null;
        this.initPromise = null;

        await this.ensureRootFolders();
        const rootId = folderId || this.vaultRootId;
        console.log(`VaultSync: listFiles starting with rootId: ${rootId}`);
        if (!rootId) throw new Error("Vault root not initialized");

        const files: CloudFile[] = [];

        const walk = async (currentFolderId: string, currentPathPrefix: string) => {
            let pageToken: string | undefined = undefined;
            do {
                const query = `'${currentFolderId}' in parents and trashed = false`;
                const url =
                    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=nextPageToken,files(id,name,mimeType,modifiedTime,size,md5Checksum)&pageSize=1000` +
                    (pageToken ? `&pageToken=${pageToken}` : "");

                console.log(
                    `VaultSync: listFiles querying folder ${currentFolderId}, prefix: "${currentPathPrefix}"`,
                );
                const response = await this.fetchWithAuth(url);
                const data: any = await response.json();
                console.log(`VaultSync: listFiles query returned ${data.files?.length || 0} items`);
                pageToken = data.nextPageToken;

                if (data.files) {
                    for (const file of data.files) {
                        const isFolder = file.mimeType === "application/vnd.google-apps.folder";
                        const relativePath = currentPathPrefix
                            ? `${currentPathPrefix}/${file.name}`
                            : file.name;

                        files.push({
                            id: file.id,
                            path: relativePath,
                            mtime: new Date(file.modifiedTime).getTime(),
                            size: parseInt(file.size || "0"),
                            kind: isFolder ? "folder" : "file",
                            hash: file.md5Checksum,
                        });

                        if (isFolder) {
                            await walk(file.id, relativePath);
                        }
                    }
                }
            } while (pageToken);
        };

        await walk(rootId, "");
        return files;
    }
}
