import type { GoogleAuthService } from "./auth-service";

/**
 * HTTP client for Google Drive API requests.
 *
 * Handles authenticated fetch with retry logic, exponential backoff,
 * offline detection, and token refresh on 401 responses.
 */
export class GoogleDriveHttpClient {
    static readonly ONLINE_TIMEOUT_MS = 60_000;

    constructor(private auth: GoogleAuthService) {}

    private async log(msg: string, level: string = "debug") {
        console.log(`VaultSync: [${level.toUpperCase()}] ${msg}`);
        if (this.auth.logger) this.auth.logger(msg, level);
    }

    async fetchWithAuth(
        url: string,
        options: RequestInit = {},
        retryCount: number = 0,
    ): Promise<Response> {
        if (!this.auth.accessToken) throw new Error("Not authenticated");

        // Proactive token refresh: refresh 5 minutes before expiry
        const REFRESH_BUFFER_MS = 5 * 60 * 1000;
        if (
            this.auth.tokenExpiresAt > 0 &&
            Date.now() > this.auth.tokenExpiresAt - REFRESH_BUFFER_MS &&
            this.auth.refreshToken &&
            retryCount === 0
        ) {
            try {
                await this.log("Proactive token refresh (expiring soon)...", "system");
                await this.auth.refreshTokens();
            } catch {
                // If proactive refresh fails, proceed with current token — it may still be valid
            }
        }

        const headers = new Headers(options.headers || {});
        headers.set("Authorization", `Bearer ${this.auth.accessToken}`);

        try {
            const response = await fetch(url, { ...options, headers });

            // SEC-004: Limit retries
            const MAX_RETRIES = 3;

            // Handle 401 Unauthorized (Refresh Token)
            if (response.status === 401 && this.auth.refreshToken && retryCount < 2) {
                try {
                    await this.auth.refreshTokens();
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

    async waitForOnline(): Promise<void> {
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
            }, GoogleDriveHttpClient.ONLINE_TIMEOUT_MS);
        });
    }

    /** Parse JSON safely. Throws a clear error on malformed responses (CDN/WAF HTML pages, truncated body). */
    async safeJsonParse(response: Response, context: string): Promise<any> {
        const text = await response.text();
        try {
            return JSON.parse(text);
        } catch {
            throw new Error(`Invalid JSON from ${context}: ${text.slice(0, 200)}`);
        }
    }

    // SEC-005: Common escaping helper
    escapeQueryValue(value: string): string {
        return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    }
}
