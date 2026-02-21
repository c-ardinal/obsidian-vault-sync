import { CloudAdapter, CloudChanges, CloudFile } from "../types/adapter";
import { generateCodeChallenge, generateCodeVerifier } from "../auth/pkce";
import {
    DEFAULT_SETTINGS,
    SETTINGS_LIMITS,
    OAUTH_REDIRECT_URI,
    AUTH_PROXY_BASE_URL,
} from "../constants";
import { toHex } from "../utils/format";
import { basename } from "../utils/path";
import { Platform, requestUrl } from "obsidian";

export type AuthMethod = "default" | "custom-proxy" | "client-credentials";

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
    private cloudRootFolder: string = DEFAULT_SETTINGS.cloudRootFolder;

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
        if (!folder || folder.trim() === "") return DEFAULT_SETTINGS.cloudRootFolder;
        // Disallow slashes, special chars, too long names
        const sanitized = folder.trim();
        if (sanitized.startsWith("/") || sanitized.includes("\\") || sanitized.length > 255) {
            return DEFAULT_SETTINGS.cloudRootFolder;
        }
        // Disallow illegal characters for folder names
        if (/[<>:"|?*]/.test(sanitized)) {
            return DEFAULT_SETTINGS.cloudRootFolder;
        }
        return sanitized;
    }

    private logger: ((msg: string, level?: string) => void) | null = null;
    setLogger(logger: (msg: string, level?: string) => void) {
        this.logger = logger;
    }

    // Callback for fatal auth errors (e.g. invalid grant)
    public onAuthFailure: (() => void) | null = null;
    // Callback after successful token refresh (to persist new tokens)
    public onTokenRefresh: (() => void) | null = null;

    private async log(msg: string, level: string = "debug") {
        console.log(`VaultSync: [${level.toUpperCase()}] ${msg}`);
        if (this.logger) this.logger(msg, level);
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
    private tokenExpiresAt: number = 0; // epoch ms
    private refreshPromise: Promise<void> | null = null;
    private codeVerifier: string | null = null;
    private currentAuthState: string | null = null;

    private authMethod: AuthMethod = "default";
    private proxyUrl: string = "";

    setAuthConfig(method: AuthMethod, proxyUrl?: string) {
        this.authMethod = method;
        if (proxyUrl && method === "custom-proxy") {
            try {
                const parsed = new URL(proxyUrl);
                if (parsed.protocol !== "https:") {
                    throw new Error("Custom proxy URL must use HTTPS");
                }
                this.proxyUrl = proxyUrl;
            } catch {
                this.proxyUrl = "";
            }
        } else {
            this.proxyUrl = "";
        }
    }

    private getProxyBaseUrl(): string | null {
        switch (this.authMethod) {
            case "default":
                return AUTH_PROXY_BASE_URL;
            case "custom-proxy":
                return this.proxyUrl.replace(/\/+$/, ""); // trim trailing slashes
            case "client-credentials":
                return null;
        }
    }

    isAuthenticated(): boolean {
        return !!this.accessToken;
    }

    getTokens(): {
        accessToken: string | null;
        refreshToken: string | null;
        tokenExpiresAt: number;
    } {
        return {
            accessToken: this.accessToken,
            refreshToken: this.refreshToken,
            tokenExpiresAt: this.tokenExpiresAt,
        };
    }

    setTokens(accessToken: string | null, refreshToken: string | null, tokenExpiresAt?: number) {
        const hadToken = !!this.accessToken;
        this.accessToken = accessToken;
        this.refreshToken = refreshToken;
        if (tokenExpiresAt !== undefined) this.tokenExpiresAt = tokenExpiresAt;
        // Clear cached initPromise when auth state changes so ensureRootFolders
        // re-runs with the new credentials instead of returning a stale rejection.
        if (!hadToken && accessToken) {
            this.initPromise = null;
        }
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

    async getAppRootId(): Promise<string> {
        await this.ensureRootFolders();
        if (!this.appRootId) throw new Error("App root not found");
        return this.appRootId;
    }

    reset() {
        this.appRootId = null;
        this.vaultRootId = null;
        this.initPromise = null;
        this.folderCache.clear();
        this.resolveCache.clear();
        this.idToPathCache.clear();
        this.resolvePathCache.clear();
        this.outsideFolderIds.clear();
    }

    /**
     * Clone this adapter with a new vault name.
     * Used for migration to create temporary adapters.
     */
    cloneWithNewVaultName(newVaultName: string): CloudAdapter {
        const cloned = new GoogleDriveAdapter(
            this._clientId,
            this._clientSecret,
            newVaultName,
            this.cloudRootFolder,
        );
        cloned.setTokens(this.accessToken, this.refreshToken, this.tokenExpiresAt);
        if (this.log) {
            cloned.setLogger(this.log);
        }
        return cloned;
    }

    getBaseAdapter(): CloudAdapter {
        return this;
    }

    async getFolderIdByName(name: string, parentId?: string): Promise<string | null> {
        const safeName = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        let query = `name = '${safeName}' and trashed = false and mimeType = 'application/vnd.google-apps.folder'`;
        if (parentId) {
            const safeParentId = parentId.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
            query += ` and '${safeParentId}' in parents`;
        }
        const resp = await this.fetchWithAuth(
            `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name)`,
        );
        const data = await resp.json();
        return data.files?.[0]?.id || null;
    }

    private getRedirectUri(): string {
        // Unified callback endpoint on Cloudflare Pages
        // Handles both proxy mode (server-side token exchange) and
        // client-credentials mode (code passthrough to obsidian://)
        return OAUTH_REDIRECT_URI;
    }

    async getAuthUrl(): Promise<string> {
        // SEC-003: Secure Random State
        const array = new Uint8Array(32);
        window.crypto.getRandomValues(array);
        const randomState = toHex(array);

        const proxyBase = this.getProxyBaseUrl();
        if (proxyBase) {
            // Proxy mode: state prefix "p:" signals server-side token exchange
            this.currentAuthState = `p:${randomState}`;
            window.localStorage.setItem("vault-sync-state", this.currentAuthState);
            const params = new URLSearchParams({ state: this.currentAuthState });
            return `${proxyBase}/api/auth/login?${params.toString()}`;
        }

        // Client-credentials mode: state prefix "d:" signals code passthrough
        this.currentAuthState = `d:${randomState}`;
        window.localStorage.setItem("vault-sync-state", this.currentAuthState);
        this.codeVerifier = await generateCodeVerifier();
        const challenge = await generateCodeChallenge(this.codeVerifier);
        window.localStorage.setItem("vault-sync-verifier", this.codeVerifier);

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

    verifyState(state: string): boolean {
        const savedState = this.currentAuthState || window.localStorage.getItem("vault-sync-state");
        if (!savedState) return false;
        return state === savedState;
    }

    async login(): Promise<void> {
        const authUrl = await this.getAuthUrl();
        // Just open the URL. The callback will be handled via obsidian:// protocol handler
        // which triggers the exchangeCodeForToken flow in the main plugin class.
        window.open(authUrl);
    }

    async exchangeCodeForToken(code: string): Promise<void> {
        if (!this.codeVerifier) {
            this.codeVerifier = window.localStorage.getItem("vault-sync-verifier");
        }
        if (!this.codeVerifier) {
            throw new Error("Code verifier missing. Did you start the login flow?");
        }

        const body = new URLSearchParams({
            client_id: this.clientId,
            client_secret: this.clientSecret,
            code: code,
            code_verifier: this.codeVerifier!,
            grant_type: "authorization_code",
            redirect_uri: this.getRedirectUri(),
        });

        let response: Response;
        try {
            response = await fetch("https://oauth2.googleapis.com/token", {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: body.toString(),
            });
        } catch (e) {
            throw new Error(
                `Authentication failed: could not reach Google servers. Check your network connection.`,
            );
        }

        const data = await this.safeJsonParse(response, "token exchange");
        if (data.error) throw new Error(data.error_description || data.error);

        this.accessToken = data.access_token;
        this.refreshToken = data.refresh_token;
        if (data.expires_in) this.tokenExpiresAt = Date.now() + data.expires_in * 1000;
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

        // Proactive token refresh: refresh 5 minutes before expiry
        const REFRESH_BUFFER_MS = 5 * 60 * 1000;
        if (
            this.tokenExpiresAt > 0 &&
            Date.now() > this.tokenExpiresAt - REFRESH_BUFFER_MS &&
            this.refreshToken &&
            retryCount === 0
        ) {
            try {
                await this.log("Proactive token refresh (expiring soon)...", "system");
                await this.refreshTokens();
            } catch {
                // If proactive refresh fails, proceed with current token — it may still be valid
            }
        }

        const headers = new Headers(options.headers || {});
        headers.set("Authorization", `Bearer ${this.accessToken}`);

        try {
            const response = await fetch(url, { ...options, headers });

            // SEC-004: Limit retries
            const MAX_RETRIES = 3;

            // Handle 401 Unauthorized (Refresh Token)
            if (response.status === 401 && this.refreshToken && retryCount < 2) {
                try {
                    await this.refreshTokens();
                } catch {
                    // Token refresh failed (e.g. proxy unreachable) — don't retry with stale token
                    throw new Error("Authentication failed: unable to refresh access token");
                }
                return this.fetchWithAuth(url, options, retryCount + 1);
            }

            // Handle 429 (Too Many Requests) and 5xx (Server Errors) with Exponential Backoff
            if ((response.status === 429 || response.status >= 500) && retryCount < MAX_RETRIES) {
                // Check connectivity
                if (!window.navigator.onLine) {
                    await this.log("Network offline. Waiting for connection...", "warn");
                    await this.waitForOnline();
                }

                const backoffDelay = Math.pow(2, retryCount) * 1000 + Math.random() * 500;
                await this.log(
                    `API Error ${response.status}. Retrying in ${Math.round(backoffDelay)}ms (Attempt ${retryCount + 1}/${MAX_RETRIES})...`,
                    "warn",
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
                    await this.log(
                        "Network offline during fetch. Waiting for connection...",
                        "warn",
                    );
                    await this.waitForOnline();
                }

                const backoffDelay = Math.pow(2, retryCount) * 2000;
                await this.log(`Network error. Retrying in ${backoffDelay}ms...`, "warn");
                await new Promise((resolve) => setTimeout(resolve, backoffDelay));
                return this.fetchWithAuth(url, options, retryCount + 1);
            }
            throw e;
        }
    }

    static readonly ONLINE_TIMEOUT_MS = 60_000;

    private async waitForOnline(): Promise<void> {
        if (window.navigator.onLine) return;
        return new Promise((resolve) => {
            const cleanup = () => {
                window.removeEventListener("online", done);
                window.removeEventListener("focus", done);
                clearInterval(interval);
                clearTimeout(timeout);
            };
            const done = () => {
                cleanup();
                resolve();
            };
            window.addEventListener("online", done);
            window.addEventListener("focus", done);
            const interval = setInterval(() => {
                if (window.navigator.onLine) done();
            }, 5000);
            const timeout = setTimeout(() => {
                this.log("waitForOnline timed out after 60s — resuming retry loop", "warn");
                done();
            }, GoogleDriveAdapter.ONLINE_TIMEOUT_MS);
        });
    }

    // SEC-005: Common escaping helper
    private escapeQueryValue(value: string): string {
        return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    }

    /** Parse JSON safely. Throws a clear error on malformed responses (CDN/WAF HTML pages, truncated body). */
    private async safeJsonParse(response: Response, context: string): Promise<any> {
        const text = await response.text();
        try {
            return JSON.parse(text);
        } catch {
            throw new Error(`Invalid JSON from ${context}: ${text.slice(0, 200)}`);
        }
    }

    private refreshTokens(): Promise<void> {
        if (this.refreshPromise) return this.refreshPromise;
        this.refreshPromise = (async () => {
            try {
                const proxyBase = this.getProxyBaseUrl();
                if (proxyBase) {
                    await this.refreshTokensViaProxy(proxyBase);
                } else {
                    await this.refreshTokensDirect();
                }
            } finally {
                this.refreshPromise = null;
            }
        })();
        return this.refreshPromise;
    }

    private async refreshTokensViaProxy(proxyBase: string) {
        await this.log(
            `Refreshing tokens via proxy... RT present: ${!!this.refreshToken}`,
            "system",
        );

        // Use Obsidian's requestUrl instead of fetch to bypass CORS restrictions.
        // fetch to the proxy origin is blocked by browser CORS policy, while
        // requestUrl operates at the native level and is not subject to CORS.
        let status: number;
        let text: string;
        try {
            const result = await requestUrl({
                url: `${proxyBase}/api/auth/refresh`,
                method: "POST",
                contentType: "application/json",
                body: JSON.stringify({ refresh_token: this.refreshToken }),
                throw: false,
            });
            status = result.status;
            text = result.text;
        } catch (e) {
            await this.log(
                `Proxy refresh network error: ${e instanceof Error ? e.message : String(e)}`,
                "error",
            );
            // Don't clear tokens on network errors — the current access token
            // may still be valid. Only confirmed auth errors (invalid_grant)
            // should trigger credential clearing.
            throw new Error("Token refresh failed: proxy unreachable");
        }

        let data: any;
        try {
            data = JSON.parse(text);
        } catch {
            throw new Error(`Invalid JSON from proxy refresh: ${text.slice(0, 200)}`);
        }

        if (status < 200 || status >= 300) {
            const err = data.error_description || data.error || JSON.stringify(data);
            console.error(`VaultSync: Proxy refresh failure (${status}): ${err}`);
            if (data.error === "invalid_grant" || data.error === "unauthorized_client") {
                this.accessToken = null;
                this.refreshToken = null;
                if (this.onAuthFailure) this.onAuthFailure();
                throw new Error(`Token revoked: ${err}`);
            }
            // Non-fatal proxy error (e.g. 500) — don't clear tokens, don't throw.
            // Caller will proceed with the current (possibly still valid) token.
            return;
        }

        if (!data.access_token) {
            await this.log("Proxy returned 200 but no access_token in response", "error");
            throw new Error("Token refresh failed: invalid proxy response");
        }

        this.accessToken = data.access_token;
        if (data.refresh_token) this.refreshToken = data.refresh_token;
        if (data.expires_in) this.tokenExpiresAt = Date.now() + data.expires_in * 1000;
        await this.log("Token refresh via proxy successful.", "system");
        if (this.onTokenRefresh) this.onTokenRefresh();
    }

    private async refreshTokensDirect() {
        await this.log(
            `Refreshing tokens... ClientID present: ${!!this.clientId}, Secret present: ${!!this.clientSecret}, RT present: ${!!this.refreshToken}`,
            "system",
        );

        const body = new URLSearchParams({
            client_id: this.clientId,
            client_secret: this.clientSecret,
            refresh_token: this.refreshToken!,
            grant_type: "refresh_token",
        });

        let response: Response;
        try {
            response = await fetch("https://oauth2.googleapis.com/token", {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: body.toString(),
            });
        } catch (e) {
            await this.log(
                `Direct refresh network error: ${e instanceof Error ? e.message : String(e)}`,
                "error",
            );
            // Don't clear tokens on network errors — the current access token
            // may still be valid. Only confirmed auth errors (invalid_grant)
            // should trigger credential clearing.
            throw new Error("Token refresh failed: Google OAuth unreachable");
        }

        const data = await this.safeJsonParse(response, "direct refresh");

        if (!response.ok) {
            const err = data.error_description || data.error || JSON.stringify(data);
            console.error(`VaultSync: Refresh failed (${response.status}): ${err}`);
            if (data.error === "invalid_grant" || data.error === "unauthorized_client") {
                this.accessToken = null;
                this.refreshToken = null;
                if (this.onAuthFailure) this.onAuthFailure();
                throw new Error(`Token revoked: ${err}`);
            }
            // Non-fatal error (e.g. 500) — don't clear tokens, don't throw.
            return;
        }

        this.accessToken = data.access_token;
        if (data.refresh_token) this.refreshToken = data.refresh_token;
        if (data.expires_in) this.tokenExpiresAt = Date.now() + data.expires_in * 1000;
        await this.log("Token refresh successful.", "system");
        if (this.onTokenRefresh) this.onTokenRefresh();
    }

    private async ensureRootFolders(): Promise<string> {
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
                const escapedVaultName = this.escapeQueryValue(this.vaultName);
                const query = `name = '${escapedVaultName}' and '${this.appRootId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
                const response = await this.fetchWithAuth(
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
                    const globalResp = await this.fetchWithAuth(
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
                                await this.fetchWithAuth(
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
            const name = basename(path);
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
        const name = basename(path);
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

    /**
     * Upload using Google Drive's resumable upload protocol.
     * Delegates to initiateResumableSession + uploadChunk.
     */
    async uploadFileResumable(
        path: string,
        content: ArrayBuffer,
        mtime: number,
        existingFileId?: string,
    ): Promise<CloudFile> {
        const sessionUri = await this.initiateResumableSession(
            path,
            content.byteLength,
            mtime,
            existingFileId,
        );
        return (await this.uploadChunk(sessionUri, content, 0, content.byteLength, path, mtime))!;
    }

    /**
     * Initiate a resumable upload session.
     * Returns a session URI for subsequent uploadChunk() calls.
     */
    async initiateResumableSession(
        path: string,
        totalSize: number,
        mtime: number,
        existingFileId?: string,
    ): Promise<string> {
        const name = basename(path);
        const metadata: any = {
            name: name,
            modifiedTime: new Date(mtime).toISOString(),
        };

        let activeFileId = existingFileId;
        if (!activeFileId) {
            const existing = await this.getFileMetadata(path);
            if (existing) activeFileId = existing.id;
        }

        let initUrl: string;
        let method: string;

        if (activeFileId) {
            initUrl = `https://www.googleapis.com/upload/drive/v3/files/${activeFileId}?uploadType=resumable&fields=id,md5Checksum,size`;
            method = "PATCH";
        } else {
            const parentId = await this.resolveParentId(path, true);
            metadata.parents = [parentId];
            initUrl = `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,md5Checksum,size`;
            method = "POST";
        }

        const initResponse = await this.fetchWithAuth(initUrl, {
            method,
            headers: {
                "Content-Type": "application/json; charset=UTF-8",
                "X-Upload-Content-Type": "application/octet-stream",
                "X-Upload-Content-Length": String(totalSize),
            },
            body: JSON.stringify(metadata),
        });

        const sessionUri = initResponse.headers.get("Location");
        if (!sessionUri) {
            throw new Error("Resumable upload: no session URI returned");
        }
        return sessionUri;
    }

    /**
     * Upload a chunk to a resumable session using Content-Range.
     * Returns null for intermediate chunks (HTTP 308), CloudFile on final chunk.
     */
    async uploadChunk(
        sessionUri: string,
        chunk: ArrayBuffer,
        offset: number,
        totalSize: number,
        path: string,
        mtime: number,
    ): Promise<CloudFile | null> {
        const end = offset + chunk.byteLength - 1;
        const uploadResponse = await this.fetchWithAuth(sessionUri, {
            method: "PUT",
            headers: {
                "Content-Type": "application/octet-stream",
                "Content-Length": String(chunk.byteLength),
                "Content-Range": `bytes ${offset}-${end}/${totalSize}`,
            },
            body: chunk,
        });

        if (uploadResponse.status === 308) return null; // Resume Incomplete

        const data = await uploadResponse.json();
        const result: CloudFile = {
            id: data.id,
            path: path,
            mtime: mtime,
            size: parseInt(data.size || String(totalSize)),
            kind: "file",
            hash: data.md5Checksum,
        };

        this.idToPathCache.set(result.id, result.path);
        this.resolvePathCache.set(result.id, result.path);

        return result;
    }

    async deleteFile(fileId: string): Promise<void> {
        await this.fetchWithAuth(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
            method: "DELETE",
        });
    }

    async moveFile(
        fileId: string,
        newName: string,
        newParentPath: string | null,
    ): Promise<CloudFile> {
        // 1. 現在のファイルの親フォルダを取得
        const currentMeta = await this.fetchWithAuth(
            `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,parents,modifiedTime,size,md5Checksum`,
        );
        const currentFile = await currentMeta.json();
        const oldParentId = currentFile.parents?.[0];

        // 2. 新しい親フォルダの ID を解決（パスが変わる場合のみ）
        // newParentPath: null = 親を変更しない, "" = ルートへ移動, "folder/sub" = サブフォルダへ移動
        let newParentId: string | null = null;
        if (newParentPath !== null) {
            // resolveParentId は "/__dummy__" でルートフォルダ ID を返す（parts.length <= 1）
            newParentId = await this.resolveParentId(
                (newParentPath ? newParentPath + "/" : "") + "__dummy__",
                true,
            );
        }

        // 3. PATCH リクエストを構築
        const queryParams: string[] = [`fields=id,name,mimeType,modifiedTime,size,md5Checksum`];
        if (newParentId && oldParentId && newParentId !== oldParentId) {
            queryParams.push(`addParents=${newParentId}`);
            queryParams.push(`removeParents=${oldParentId}`);
        }

        const metadata: any = { name: newName };
        const url = `https://www.googleapis.com/drive/v3/files/${fileId}?${queryParams.join("&")}`;
        const response = await this.fetchWithAuth(url, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(metadata),
        });

        const data = await response.json();

        // 4. 新しいパスを構築
        const parentPath = newParentPath !== null ? newParentPath : "";
        const fullPath = parentPath ? `${parentPath}/${newName}` : newName;

        const result: CloudFile = {
            id: data.id,
            path: fullPath,
            mtime: new Date(data.modifiedTime).getTime(),
            size: parseInt(data.size || "0"),
            kind: data.mimeType === "application/vnd.google-apps.folder" ? "folder" : "file",
            hash: data.md5Checksum,
        };

        // 5. キャッシュ更新
        this.idToPathCache.set(result.id, result.path);
        this.resolvePathCache.set(result.id, result.path);

        return result;
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
