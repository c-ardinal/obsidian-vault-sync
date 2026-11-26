import type { OAuthMethod } from "../../types/oauth-adapter";
import { generateCodeChallenge, generateCodeVerifier } from "./pkce";
import { OAUTH_REDIRECT_URI, AUTH_PROXY_BASE_URL } from "../../constants";
import { toHex } from "../../utils/format";
import { requestUrl } from "obsidian";

/** OAuth token endpoint response (success or error body). */
interface TokenResponse {
    access_token: string;
    refresh_token: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
}

export type AuthMethod = OAuthMethod;

export class GoogleAuthService {
    /** Exposed for HttpClient to attach Authorization header. */
    accessToken: string | null = null;
    refreshToken: string | null = null;
    tokenExpiresAt: number = 0; // epoch ms
    private refreshPromise: Promise<void> | null = null;
    /**
     * Bumped whenever the signed-in session ends or changes (sign-out, a new
     * sign-in, other tokens set). A refresh started under an older generation
     * drops its result: a refresh still in flight at sign-out used to put the
     * access token back (the plugin showed as signed in again), and one in
     * flight across a new sign-in mixed the old account's access token with the
     * new refresh token and saved the pair.
     */
    private generation = 0;
    private codeVerifier: string | null = null;
    private currentAuthState: string | null = null;

    private authMethod: AuthMethod = "default";
    private proxyUrl: string = "";

    private _clientId: string;
    private _clientSecret: string;

    // Callback for fatal auth errors (e.g. invalid grant)
    public onAuthFailure: (() => void | Promise<void>) | null = null;
    // Callback after successful token refresh (to persist new tokens)
    public onTokenRefresh: (() => void | Promise<void>) | null = null;

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
        console.debug(`Vault Syncer: [${level.toUpperCase()}] ${msg}`);
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

    getAuthConfig(): { method: AuthMethod; proxyUrl: string } {
        return { method: this.authMethod, proxyUrl: this.proxyUrl };
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
        // Same refresh token (e.g. credentials saved again): the session is the same
        if (refreshToken !== this.refreshToken) this.generation++;
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
            code_verifier: this.codeVerifier,
            grant_type: "authorization_code",
            redirect_uri: this.getRedirectUri(),
        });

        let text: string;
        try {
            text = (await this.postTokenEndpoint(body)).text;
        } catch {
            throw new Error(
                `Authentication failed: could not reach Google servers. Check your network connection.`,
            );
        }

        const data = this.safeJsonParse(text, "token exchange");
        if (data.error) throw new Error(data.error_description || data.error);

        this.generation++;
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

    /**
     * Forget the tokens and ask Google to revoke them. Revoking the refresh token
     * also revokes its access tokens. Revocation is best effort: the tokens are
     * dropped locally even when it fails (e.g. offline).
     */
    async logout(): Promise<void> {
        const token = this.refreshToken || this.accessToken;
        this.generation++;
        this.accessToken = null;
        this.refreshToken = null;
        this.tokenExpiresAt = 0;
        this.refreshPromise = null;
        if (!token) return;
        try {
            const res = await requestUrl({
                url: "https://oauth2.googleapis.com/revoke",
                method: "POST",
                contentType: "application/x-www-form-urlencoded",
                body: `token=${encodeURIComponent(token)}`,
                throw: false,
            });
            if (res.status >= 400) {
                await this.log(`Token revoke returned ${res.status}`, "warn");
            }
        } catch (e) {
            await this.log(`Token revoke failed: ${String(e)}`, "warn");
        }
    }

    /** Parse JSON safely. Throws a clear error on malformed responses (CDN/WAF HTML pages, truncated body). */
    /**
     * POST to Google's token endpoint. requestUrl (not fetch) so that HTTP errors
     * come back as a status instead of an exception, like the proxy refresh.
     */
    private async postTokenEndpoint(body: URLSearchParams): Promise<{ status: number; text: string }> {
        const res = await requestUrl({
            url: "https://oauth2.googleapis.com/token",
            method: "POST",
            contentType: "application/x-www-form-urlencoded",
            body: body.toString(),
            throw: false,
        });
        return { status: res.status, text: res.text };
    }

    private safeJsonParse(text: string, context: string): TokenResponse {
        try {
            return JSON.parse(text) as TokenResponse;
        } catch {
            throw new Error(`Invalid JSON from ${context}: ${text.slice(0, 200)}`);
        }
    }

    refreshTokens(): Promise<void> {
        if (this.refreshPromise) return this.refreshPromise;
        const generation = this.generation;
        const proxyBase = this.getProxyBaseUrl();
        const promise: Promise<void> = (
            proxyBase
                ? this.refreshTokensViaProxy(proxyBase, generation)
                : this.refreshTokensDirect(generation)
        ).finally(() => {
            // A refresh started after sign-out owns the slot now; leave it
            if (this.refreshPromise === promise) this.refreshPromise = null;
        });
        this.refreshPromise = promise;
        return promise;
    }

    /** True when the session this refresh was started for has ended (sign-out or another sign-in). */
    private async superseded(generation: number): Promise<boolean> {
        if (generation === this.generation) return false;
        await this.log("Token refresh result dropped: signed out or signed in again meanwhile.", "system");
        return true;
    }

    private async refreshTokensViaProxy(proxyBase: string, generation: number) {
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

        if (await this.superseded(generation)) return;

        let data: TokenResponse;
        try {
            data = JSON.parse(text) as TokenResponse;
        } catch {
            throw new Error(`Invalid JSON from proxy refresh: ${text.slice(0, 200)}`);
        }

        if (status < 200 || status >= 300) {
            const err = data.error_description || data.error || JSON.stringify(data);
            console.error(`Vault Syncer: Proxy refresh failure (${status}): ${err}`);
            if (data.error === "invalid_grant" || data.error === "unauthorized_client") {
                this.accessToken = null;
                this.refreshToken = null;
                if (this.onAuthFailure) void this.onAuthFailure();
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
        if (this.onTokenRefresh) void this.onTokenRefresh();
    }

    private async refreshTokensDirect(generation: number) {
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

        let response: { status: number; text: string };
        try {
            response = await this.postTokenEndpoint(body);
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

        const data = this.safeJsonParse(response.text, "direct refresh");
        if (await this.superseded(generation)) return;

        if (response.status < 200 || response.status >= 300) {
            const err = data.error_description || data.error || JSON.stringify(data);
            console.error(`Vault Syncer: Refresh failed (${response.status}): ${err}`);
            if (data.error === "invalid_grant" || data.error === "unauthorized_client") {
                this.accessToken = null;
                this.refreshToken = null;
                if (this.onAuthFailure) void this.onAuthFailure();
                throw new Error(`Token revoked: ${err}`);
            }
            // Non-fatal error (e.g. 500) — don't clear tokens, don't throw.
            return;
        }

        this.accessToken = data.access_token;
        if (data.refresh_token) this.refreshToken = data.refresh_token;
        if (data.expires_in) this.tokenExpiresAt = Date.now() + data.expires_in * 1000;
        await this.log("Token refresh successful.", "system");
        if (this.onTokenRefresh) void this.onTokenRefresh();
    }
}
