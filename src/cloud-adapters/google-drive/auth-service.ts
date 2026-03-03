import { generateCodeChallenge, generateCodeVerifier } from "./pkce";
import { OAUTH_REDIRECT_URI, AUTH_PROXY_BASE_URL } from "../../constants";
import { toHex } from "../../utils/format";
import { Platform, requestUrl } from "obsidian";

export type AuthMethod = "default" | "custom-proxy" | "client-credentials";

export class GoogleAuthService {
    /** Exposed for HttpClient to attach Authorization header. */
    accessToken: string | null = null;
    refreshToken: string | null = null;
    tokenExpiresAt: number = 0; // epoch ms
    private refreshPromise: Promise<void> | null = null;
    private codeVerifier: string | null = null;
    private currentAuthState: string | null = null;

    private authMethod: AuthMethod = "default";
    private proxyUrl: string = "";

    private _clientId: string;
    private _clientSecret: string;

    // Callback for fatal auth errors (e.g. invalid grant)
    public onAuthFailure: (() => void) | null = null;
    // Callback after successful token refresh (to persist new tokens)
    public onTokenRefresh: (() => void) | null = null;

    /** Exposed for HttpClient logging. */
    logger: ((msg: string, level?: string) => void) | null = null;

    constructor(clientId: string, clientSecret: string) {
        this._clientId = clientId;
        this._clientSecret = clientSecret;
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

    setLogger(logger: (msg: string, level?: string) => void) {
        this.logger = logger;
    }

    private async log(msg: string, level: string = "debug") {
        console.log(`Vault-Sync: [${level.toUpperCase()}] ${msg}`);
        if (this.logger) this.logger(msg, level);
    }

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
        this.accessToken = accessToken;
        this.refreshToken = refreshToken;
        if (tokenExpiresAt !== undefined) this.tokenExpiresAt = tokenExpiresAt;
    }

    getAuthStatus(): string {
        if (this.accessToken) return "Authenticated";
        if (this.refreshToken) return "Token available (Requires refresh)";
        return "Not authenticated";
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

    /** Parse JSON safely. Throws a clear error on malformed responses (CDN/WAF HTML pages, truncated body). */
    private async safeJsonParse(response: Response, context: string): Promise<any> {
        const text = await response.text();
        try {
            return JSON.parse(text);
        } catch {
            throw new Error(`Invalid JSON from ${context}: ${text.slice(0, 200)}`);
        }
    }

    refreshTokens(): Promise<void> {
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
            console.error(`Vault-Sync: Proxy refresh failure (${status}): ${err}`);
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
            console.error(`Vault-Sync: Refresh failed (${response.status}): ${err}`);
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
}
