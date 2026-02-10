import { CloudAdapter, CloudChanges, CloudFile } from "../types/adapter";
import { generateCodeChallenge, generateCodeVerifier } from "../auth/pkce";
import { Platform } from "obsidian";

const DEFAULT_ROOT_FOLDER = "ObsidianVaultSync";

export class GoogleDriveAdapter implements CloudAdapter {
    name = "Google Drive";

    // Feature flags - Google Drive supports both
    readonly supportsChangesAPI = true;
    readonly supportsHash = true; // MD5 checksum

    private appRootId: string | null = null;
    private vaultRootId: string | null = null;
    private folderCache: Map<string, string> = new Map();
    private initPromise: Promise<string> | null = null;
    private resolveCache: Map<string, Promise<string>> = new Map();
    private idToPathCache: Map<string, string> = new Map(); // ID -> fullPath
    private resolvePathCache: Map<string, string> = new Map(); // ID -> fullPath (built during resolution)
    private outsideFolderIds: Set<string> = new Set(); // IDs confirmed to be outside vaultRootId
    private cloudRootFolder: string = DEFAULT_ROOT_FOLDER;

    constructor(
        private _clientId: string,
        private _clientSecret: string,
        public vaultName: string,
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

    get rootFolder(): string {
        return this.cloudRootFolder;
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

    // Callback for fatal auth errors (e.g. invalid grant)
    public onAuthFailure: (() => void) | null = null;

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

    /**
     * Initialize the adapter (ensure root folders exist)
     * Call this at the start of sync to avoid delays later
     */
    async initialize(): Promise<void> {
        await this.ensureRootFolders();
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

        // SEC-003: Secure Random State
        const array = new Uint8Array(32);
        window.crypto.getRandomValues(array);
        this.currentAuthState = Array.from(array, (b) => b.toString(16).padStart(2, "0")).join("");

        const params = new URLSearchParams({
            client_id: this.clientId,
            redirect_uri: this.getRedirectUri(),
            response_type: "code",
            scope: "https://www.googleapis.com/auth/drive.file",
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
    private async fetchWithAuth(
        url: string,
        options: RequestInit = {},
        retryCount: number = 0,
    ): Promise<Response> {
        if (!this.accessToken) throw new Error("Not authenticated");

        const headers = new Headers(options.headers || {});
        headers.set("Authorization", `Bearer ${this.accessToken}`);

        try {
            const response = await fetch(url, { ...options, headers });

            // SEC-004: Limit retries
            const MAX_RETRIES = 3;

            // Handle 401 Unauthorized (Refresh Token)
            if (response.status === 401 && this.refreshToken && retryCount < 2) {
                await this.refreshTokens();
                return this.fetchWithAuth(url, options, retryCount + 1);
            }

            // Handle 429 (Too Many Requests) and 5xx (Server Errors) with Exponential Backoff
            if ((response.status === 429 || response.status >= 500) && retryCount < MAX_RETRIES) {
                // Check connectivity
                if (!window.navigator.onLine) {
                    await this.log("Network offline. Waiting for connection...");
                    await this.waitForOnline();
                }

                const backoffDelay = Math.pow(2, retryCount) * 1000 + Math.random() * 500;
                await this.log(
                    `API Error ${response.status}. Retrying in ${Math.round(backoffDelay)}ms (Attempt ${retryCount + 1}/${MAX_RETRIES})...`,
                );
                await new Promise((resolve) => setTimeout(resolve, backoffDelay));
                return this.fetchWithAuth(url, options, retryCount + 1);
            }

            if (!response.ok) {
                let errorMsg = `API Error ${response.status}`;
                try {
                    const text = await response.text();
                    try {
                        const json = JSON.parse(text);
                        if (json.error && json.error.message) {
                            errorMsg = json.error.message;
                        } else {
                            errorMsg = text;
                        }
                    } catch {
                        errorMsg = text;
                    }
                } catch (e) {
                    errorMsg = "Could not read error body";
                }

                // SEC-007: Sanitize error messages (logging)
                console.error(`VaultSync: API Error ${response.status}: ${errorMsg}`);

                // Throw the actual error message so callers can handle specific cases
                throw new Error(errorMsg);
            }

            return response;
        } catch (e) {
            // Handle network timeouts / offline status
            const isNetworkError = e instanceof TypeError && e.message === "Failed to fetch";
            if (isNetworkError && retryCount < 3) {
                if (!window.navigator.onLine) {
                    await this.log("Network offline during fetch. Waiting for connection...");
                    await this.waitForOnline();
                }

                const backoffDelay = Math.pow(2, retryCount) * 2000;
                await this.log(`Network error. Retrying in ${backoffDelay}ms...`);
                await new Promise((resolve) => setTimeout(resolve, backoffDelay));
                return this.fetchWithAuth(url, options, retryCount + 1);
            }
            throw e;
        }
    }

    private async waitForOnline(): Promise<void> {
        if (window.navigator.onLine) return;
        return new Promise((resolve) => {
            const onOnline = () => {
                window.removeEventListener("online", onOnline);
                window.removeEventListener("focus", onOnline);
                resolve();
            };
            window.addEventListener("online", onOnline);
            window.addEventListener("focus", onOnline);
            // Fallback: Check every 5 seconds just in case (for mobile webview quirks)
            const interval = setInterval(() => {
                if (window.navigator.onLine) {
                    window.removeEventListener("online", onOnline);
                    window.removeEventListener("focus", onOnline);
                    clearInterval(interval);
                    resolve();
                }
            }, 5000);
        });
    }

    // SEC-005: Common escaping helper
    private escapeQueryValue(value: string): string {
        return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    }

    private async refreshTokens() {
        await this.log(
            `Refreshing tokens... ClientID present: ${!!this.clientId}, Secret present: ${!!this.clientSecret}, RT present: ${!!this.refreshToken}`,
        );

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

        if (!response.ok) {
            const err = data.error_description || data.error || JSON.stringify(data);
            console.error(`VaultSync: Refresh failed (${response.status}): ${err}`);
            // If invalid_grant, specific handling might be needed (logout), but for now just logging.
            // Invalidating token to prevent infinite loops of 401s if callers rely on token presence
            if (data.error === "invalid_grant" || data.error === "unauthorized_client") {
                this.accessToken = null;
                this.refreshToken = null;
                // Notify main plugin to clear persisted credentials
                if (this.onAuthFailure) this.onAuthFailure();
            }
            return;
        }

        this.accessToken = data.access_token;
        if (data.refresh_token) this.refreshToken = data.refresh_token;
        await this.log("Token refresh successful.");
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
                const query = `name = '${this.escapeQueryValue(
                    this.cloudRootFolder,
                )}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
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
            const escapedVaultName = this.escapeQueryValue(this.vaultName);
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

    private async resolveParentId(path: string, create: boolean = true): Promise<string> {
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

                const query = `name = '${this.escapeQueryValue(
                    part,
                )}' and '${currentParentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
                const response = await this.fetchWithAuth(
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

    async getFileMetadata(path: string): Promise<CloudFile | null> {
        try {
            const parentId = await this.resolveParentId(path, false);
            const name = path.split("/").pop();
            const query = `name = '${this.escapeQueryValue(
                name || "",
            )}' and '${parentId}' in parents and trashed = false`;
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
                    kind:
                        file.mimeType === "application/vnd.google-apps.folder" ? "folder" : "file",
                    hash: file.md5Checksum,
                };
            }
            return null;
        } catch (e) {
            // If parent resolution fails, file definitely doesn't exist
            return null;
        }
    }

    async getFileMetadataById(fileId: string, knownPath?: string): Promise<CloudFile | null> {
        try {
            // Direct ID lookup provides stronger consistency than query search
            const response = await this.fetchWithAuth(
                `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,mimeType,modifiedTime,size,md5Checksum,trashed`,
            );
            const file = await response.json();

            // Handle deleted/trashed files as null
            if (!file.id || file.trashed) return null;

            return {
                id: file.id,
                path: knownPath || file.name, // Partial path (name only) if knownPath not provided, but sufficient for hash check
                mtime: new Date(file.modifiedTime).getTime(),
                size: parseInt(file.size || "0"),
                kind: file.mimeType === "application/vnd.google-apps.folder" ? "folder" : "file",
                hash: file.md5Checksum,
            };
        } catch (e) {
            // 404 or other errors -> treat as not found
            return null;
        }
    }

    async downloadFile(fileId: string): Promise<ArrayBuffer> {
        const response = await this.fetchWithAuth(
            `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
        );
        return await response.arrayBuffer();
    }

    async uploadFile(
        path: string,
        content: ArrayBuffer,
        mtime: number,
        existingFileId?: string,
    ): Promise<CloudFile> {
        const name = path.split("/").pop();
        const metadata: any = {
            name: name,
            modifiedTime: new Date(mtime).toISOString(),
        };

        let activeFileId = existingFileId;
        if (!activeFileId) {
            // Only perform path-based lookup if ID is not provided
            const existing = await this.getFileMetadata(path);
            if (existing) activeFileId = existing.id;
        }

        let url =
            "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,md5Checksum,size";
        let method = "POST";

        if (activeFileId) {
            // PATCH: skip resolveParentId if we already have the file ID
            url = `https://www.googleapis.com/upload/drive/v3/files/${activeFileId}?uploadType=multipart&fields=id,md5Checksum,size`;
            method = "PATCH";
        } else {
            // NEW FILE: resolve parent ID
            const parentId = await this.resolveParentId(path, true);
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
        const result: CloudFile = {
            id: data.id,
            path: path,
            mtime: mtime,
            size: parseInt(data.size || String(content.byteLength)),
            kind: "file",
            hash: data.md5Checksum,
        };

        // CACHE for immediate identity check
        this.idToPathCache.set(result.id, result.path);
        // Also feed resolvePathCache to prevent redundant lookups if other tools use it
        this.resolvePathCache.set(result.id, result.path);

        return result;
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
                                const query = `name = '${this.escapeQueryValue(
                                    part,
                                )}' and '${currentParentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
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
        // Optimized fields request:
        // - nextPageToken, newStartPageToken: for pagination/continuation
        // - changes: the actual list
        //   - fileId, removed: core change info
        //   - file(...): file metadata needed for SyncManager (id, name, mimeType, parents, trashed, etc.)
        const fields =
            "nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,mimeType,modifiedTime,size,md5Checksum,parents,trashed))";
        const response = await this.fetchWithAuth(
            `https://www.googleapis.com/drive/v3/changes?pageToken=${pageToken}&pageSize=1000&fields=${fields}`,
        );
        const data = await response.json();

        return {
            nextPageToken: data.nextPageToken,
            newStartPageToken: data.newStartPageToken,
            changes: await Promise.all(
                (data.changes || []).map(async (c: any) => {
                    let fullPath = c.file ? c.file.name : "";
                    if (c.file && !c.removed && c.file.parents && c.file.parents.length > 0) {
                        try {
                            // Resolve Parent Path + Append Current Name
                            // (Avoids stale cache from resolveFullPath(fileId) if file was renamed)
                            const parentPath = await this.resolveFullPath(c.file.parents[0]);
                            fullPath = parentPath ? `${parentPath}/${c.file.name}` : c.file.name;
                        } catch (e) {
                            console.warn(`Failed to resolve parent path for ${c.fileId}:`, e);
                            // If resolution fails (e.g. moved out of vault), treat as removed or ignore
                            return { fileId: c.fileId, removed: true };
                        }
                    } else if (c.file && !c.removed) {
                        // No parents? Probably shouldn't happen for files in vault, but just in case
                        // If it's the vault root itself, maybe? But changes are usually children.
                        // Treat as removed if we can't place it.
                        return { fileId: c.fileId, removed: true };
                    }

                    // Treat trashed files as removed
                    const isRemoved = c.removed || (c.file && c.file.trashed);

                    return {
                        fileId: c.fileId,
                        removed: isRemoved,
                        file:
                            c.file && !isRemoved
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
                const response = await this.fetchWithAuth(
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

    async listFiles(folderId?: string): Promise<CloudFile[]> {
        // Clear cached vaultRootId to force fresh lookup (fixes stale pointer bug)
        this.vaultRootId = null;
        this.initPromise = null;

        // QA-003: Memory Leak Fix - Clear caches at start of valid sync session
        this.folderCache.clear();
        this.resolveCache.clear();

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

    // =========================================================================================
    // History & Revisions Support
    // =========================================================================================

    readonly supportsHistory = true;

    private validatePath(path: string) {
        // Prevent path traversal and enforce valid chars
        // Vault paths are relative, so starting with / is technically invalid but often normalized.
        // We mainly check for ".." components.
        if (path.includes("..") || path.includes("\\") || /[<>:"|?*]/.test(path)) {
            throw new Error(`Invalid path: ${path}`);
        }
    }

    async listRevisions(path: string): Promise<import("../types/adapter").FileRevision[]> {
        this.validatePath(path);
        const meta = await this.getFileMetadata(path);
        if (!meta) throw new Error(`File not found: ${path}`);

        const response = await this.fetchWithAuth(
            `https://www.googleapis.com/drive/v3/files/${meta.id}/revisions?fields=revisions(id,modifiedTime,size,lastModifyingUser,keepForever,md5Checksum)`,
        );
        const data = await response.json();

        return (data.revisions || []).map((rev: any) => ({
            id: rev.id,
            modifiedTime: new Date(rev.modifiedTime).getTime(),
            size: parseInt(rev.size || "0"),
            author: rev.lastModifyingUser?.displayName,
            keepForever: rev.keepForever,
            hash: rev.md5Checksum,
        }));
    }

    async getRevisionContent(path: string, revisionId: string): Promise<ArrayBuffer> {
        this.validatePath(path);
        // We need fileId first
        const meta = await this.getFileMetadata(path);
        if (!meta) throw new Error(`File not found: ${path}`);

        // 1. Get revision metadata for hash verification (if available in list)
        // Or get it from the get call if header allows?
        // Revisions.get supports fields.
        const metaResponse = await this.fetchWithAuth(
            `https://www.googleapis.com/drive/v3/files/${meta.id}/revisions/${revisionId}?fields=md5Checksum`,
        );
        const metaData = await metaResponse.json();
        const expectedHash = metaData.md5Checksum;

        // 2. Download content
        const response = await this.fetchWithAuth(
            `https://www.googleapis.com/drive/v3/files/${meta.id}/revisions/${revisionId}?alt=media`,
        );
        const buffer = await response.arrayBuffer();

        // 3. Security Integrity Check
        if (expectedHash) {
            // Need MD5 impl. Assuming md5 is imported or available.
            // Since we need to import it, we should do that at top of file.
            // For now, let's assume util usage or implement minimal check if md5 util not imported.
            // WAIT - I need to import md5 at the top of the file!
            // I will add the import in a separate tool call if needed or use dynamic import?
            // Dynamic import for utility is cleaner to avoid messing with top imports in this chunk replace.

            const { md5 } = await import("../utils/md5");
            const actualHash = md5(buffer);
            if (actualHash.toLowerCase() !== expectedHash.toLowerCase()) {
                throw new Error(
                    `[Security] Integrity check failed! Expected ${expectedHash}, got ${actualHash}. Possible data corruption or tampering.`,
                );
            }
        }

        return buffer;
    }

    async setRevisionKeepForever(
        path: string,
        revisionId: string,
        keepForever: boolean,
    ): Promise<void> {
        this.validatePath(path);
        const meta = await this.getFileMetadata(path);
        if (!meta) throw new Error(`File not found: ${path}`);

        await this.fetchWithAuth(
            `https://www.googleapis.com/drive/v3/files/${meta.id}/revisions/${revisionId}`,
            {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ keepForever: keepForever }),
            },
        );
    }

    async deleteRevision(path: string, revisionId: string): Promise<void> {
        this.validatePath(path);
        const meta = await this.getFileMetadata(path);
        if (!meta) throw new Error(`File not found: ${path}`);

        await this.fetchWithAuth(
            `https://www.googleapis.com/drive/v3/files/${meta.id}/revisions/${revisionId}`,
            { method: "DELETE" },
        );
    }
}
