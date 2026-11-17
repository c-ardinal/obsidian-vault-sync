import type { GoogleAuthService } from "./auth-service";

export interface FetchExtras {
    /** Non-2xx statuses that are a normal answer for this request (e.g. 308 Resume Incomplete) */
    okStatuses?: number[];
    /**
     * false: throw network errors at once instead of re-sending the request. For
     * resumable-upload chunks, whose caller asks the server what arrived and
     * sends only the rest.
     */
    retryNetworkErrors?: boolean;
}

/**
 * HTTP client for Google Drive API requests.
 *
 * Handles authenticated fetch with retry logic, exponential backoff,
 * offline detection, and token refresh on 401 responses.
 */
export class GoogleDriveHttpClient {
    static readonly ONLINE_TIMEOUT_MS = 60_000;
    /**
     * Max requests in flight at once for this client. Sync runs uploads,
     * downloads and path resolution in parallel; this keeps the combined
     * burst within Drive's per-user rate limits.
     */
    static readonly MAX_IN_FLIGHT = 8;
    /** Upper bound for a server-requested Retry-After wait */
    static readonly MAX_RETRY_AFTER_MS = 30_000;
    /**
     * Time allowed until the response headers arrive. Without a limit, a connection
     * that silently died (a phone switching networks, a laptop waking from sleep)
     * kept the sync "running" forever, and every later sync queued behind it.
     */
    static readonly REQUEST_TIMEOUT_MS = 90_000;
    /** Extra time per byte sent: an upload over a slow link must not time out */
    static readonly MIN_UPLOAD_BYTES_PER_SEC = 16 * 1024;

    private inFlight = 0;
    private waiters: Array<() => void> = [];

    constructor(private auth: GoogleAuthService) {}

    private async acquireSlot(): Promise<void> {
        if (this.inFlight < GoogleDriveHttpClient.MAX_IN_FLIGHT) {
            this.inFlight++;
            return;
        }
        await new Promise<void>((resolve) => this.waiters.push(resolve));
    }

    private releaseSlot(): void {
        const next = this.waiters.shift();
        if (next) {
            next(); // hand the slot over directly
        } else {
            this.inFlight--;
        }
    }

    private static bodySize(body: RequestInit["body"]): number {
        if (!body) return 0;
        if (typeof body === "string") return body.length;
        if (body instanceof ArrayBuffer) return body.byteLength;
        if (ArrayBuffer.isView(body)) return body.byteLength;
        return 0;
    }

    /** Time limit for one request: base + the time to send its body at a slow rate */
    static timeoutFor(init: RequestInit): number {
        const bytes = GoogleDriveHttpClient.bodySize(init.body);
        return (
            GoogleDriveHttpClient.REQUEST_TIMEOUT_MS +
            Math.ceil((bytes / GoogleDriveHttpClient.MIN_UPLOAD_BYTES_PER_SEC) * 1000)
        );
    }

    /**
     * fetch() bounded by MAX_IN_FLIGHT (the slot is NOT held during retry back-off)
     * and by a time limit until the response arrives (see REQUEST_TIMEOUT_MS).
     */
    private async limitedFetch(url: string, init: RequestInit): Promise<Response> {
        await this.acquireSlot();
        const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
        let timedOut = false;
        const timer =
            controller && !init.signal
                ? setTimeout(() => {
                      timedOut = true;
                      controller.abort();
                  }, GoogleDriveHttpClient.timeoutFor(init))
                : null;
        try {
            return await fetch(url, controller && !init.signal ? { ...init, signal: controller.signal } : init);
        } catch (e) {
            if (timedOut) throw new TypeError("Network error: request timed out");
            throw e;
        } finally {
            if (timer) clearTimeout(timer);
            this.releaseSlot();
        }
    }

    /**
     * fetch() rejects with a TypeError for every network-level failure, but the
     * message differs per engine: "Failed to fetch" (Chromium: desktop, Android),
     * "Load failed" (WebKit: iOS / iPadOS), "NetworkError when attempting to fetch
     * resource." (Firefox). Matching only the Chromium text meant iOS never retried.
     */
    static isNetworkError(e: unknown): boolean {
        return e instanceof TypeError;
    }

    /** Drive reports per-user rate limiting as 403 with reason (user)RateLimitExceeded */
    private async isRateLimit403(response: Response): Promise<boolean> {
        if (response.status !== 403) return false;
        try {
            const text = await response.clone().text();
            return /rateLimitExceeded|userRateLimitExceeded|sharingRateLimitExceeded/.test(text);
        } catch {
            return false;
        }
    }

    private retryDelayMs(response: Response, retryCount: number): number {
        const header = response.headers?.get?.("Retry-After");
        if (header) {
            const secs = Number(header);
            if (Number.isFinite(secs) && secs >= 0) {
                return Math.min(secs * 1000, GoogleDriveHttpClient.MAX_RETRY_AFTER_MS);
            }
        }
        return Math.pow(2, retryCount) * 1000 + Math.random() * 500;
    }

    private async log(msg: string, level: string = "debug") {
        console.debug(`Vault-Sync: [${level.toUpperCase()}] ${msg}`);
        if (this.auth.logger) this.auth.logger(msg, level);
    }

    async fetchWithAuth(
        url: string,
        options: RequestInit = {},
        retryCount: number = 0,
        extra: FetchExtras = {},
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
            const response = await this.limitedFetch(url, { ...options, headers });

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
                return this.fetchWithAuth(url, options, retryCount + 1, extra);
            }

            // Handle 429 (Too Many Requests), 403 rate limits and 5xx (Server Errors) with Exponential Backoff
            if (
                (response.status === 429 ||
                    response.status >= 500 ||
                    (await this.isRateLimit403(response))) &&
                retryCount < MAX_RETRIES
            ) {
                // Check connectivity
                if (!window.navigator.onLine) {
                    await this.log("Network offline. Waiting for connection...", "warn");
                    await this.waitForOnline();
                }

                const backoffDelay = this.retryDelayMs(response, retryCount);
                await this.log(
                    `API Error ${response.status}. Retrying in ${Math.round(backoffDelay)}ms (Attempt ${retryCount + 1}/${MAX_RETRIES})...`,
                    "warn",
                );
                await new Promise((resolve) => setTimeout(resolve, backoffDelay));
                return this.fetchWithAuth(url, options, retryCount + 1, extra);
            }

            if (!response.ok && !extra.okStatuses?.includes(response.status)) {
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
                console.error(`Vault-Sync: API Error ${response.status}: ${errorMsg}`);

                // Throw the actual error message so callers can handle specific cases.
                // The HTTP status is kept on the error so callers can tell "not found /
                // no access" apart from transient failures.
                const err = new Error(errorMsg) as Error & { status?: number };
                err.status = response.status;
                throw err;
            }

            return response;
        } catch (e) {
            // Handle network timeouts / offline status
            const isNetworkError = GoogleDriveHttpClient.isNetworkError(e);
            if (isNetworkError && retryCount < 3 && extra.retryNetworkErrors !== false) {
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
                return this.fetchWithAuth(url, options, retryCount + 1, extra);
            }
            if (isNetworkError) {
                // Same wording on every platform, so the user sees the "network" notice
                const msg = (e as Error).message;
                throw new TypeError(/network error/i.test(msg) ? msg : `Network error: ${msg}`);
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
