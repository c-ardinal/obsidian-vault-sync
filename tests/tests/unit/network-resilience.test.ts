import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GoogleDriveAdapter } from "../../../src/adapters/google-drive";

// ── Test Helpers (DRY) ──────────────────────────────────────────────

/** Build a mock Response whose body is parsed via text() then JSON.parse() by safeJsonParse. */
function mockResponse(body: any, status = 200, headers: Record<string, string> = {}): Response {
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: new Headers(headers),
        json: () => Promise.resolve(typeof body === "string" ? JSON.parse(body) : body),
        text: () => Promise.resolve(text),
        arrayBuffer: () => Promise.resolve(new TextEncoder().encode(text).buffer),
        clone: function () { return mockResponse(body, status, headers); },
    } as unknown as Response;
}

/** A response whose text() returns non-JSON (simulates CDN/WAF HTML error pages). */
function htmlResponse(html: string, status = 200): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: new Headers(),
        text: () => Promise.resolve(html),
        json: () => { throw new SyntaxError("Unexpected token <"); },
        arrayBuffer: () => Promise.resolve(new TextEncoder().encode(html).buffer),
        clone: function () { return htmlResponse(html, status); },
    } as unknown as Response;
}

/** Token payload Google / proxy returns on successful refresh. */
const VALID_TOKEN_RESPONSE = {
    access_token: "new-access-token",
    refresh_token: "new-refresh-token",
    expires_in: 3600,
};

/** Google Drive API successful response for getStartPageToken. */
const PAGE_TOKEN_RESPONSE = { startPageToken: "42" };

/** Create a pre-authenticated adapter. */
function createAdapter(mode: "default" | "client-credentials" = "default"): GoogleDriveAdapter {
    const adapter = new GoogleDriveAdapter("cid", "csec", "test-vault");
    adapter.setTokens("valid-token", "valid-refresh-token", Date.now() + 3600_000);
    adapter.setAuthConfig(mode);
    adapter.setLogger(() => {}); // silence logs
    return adapter;
}

/**
 * Dispatch fetch calls by URL pattern in order.
 * Each rule is consumed once; unmatched calls throw.
 */
type FetchRule = { match: string | RegExp; respond: Response | (() => never) };

function sequentialFetch(rules: FetchRule[]): ReturnType<typeof vi.fn> {
    let idx = 0;
    return vi.fn().mockImplementation((url: string) => {
        while (idx < rules.length) {
            const rule = rules[idx];
            idx++;
            const pattern = typeof rule.match === "string" ? new RegExp(rule.match) : rule.match;
            if (pattern.test(url)) {
                if (typeof rule.respond === "function") return (rule.respond as () => never)();
                return Promise.resolve(rule.respond);
            }
        }
        throw new Error(`Unexpected fetch to ${url} (rule index ${idx})`);
    });
}

function networkError(): () => never {
    return () => { throw new TypeError("Failed to fetch"); };
}

/** Minimal window stub for Node.js test environment. */
function createMockWindow(online = true) {
    return {
        navigator: { onLine: online },
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        localStorage: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
        crypto: globalThis.crypto,
        open: vi.fn(),
    };
}

// ── Tests ──────────────────────────────────────────────────────────

describe("Network Resilience", () => {
    let adapter: GoogleDriveAdapter;
    let mockWindow: ReturnType<typeof createMockWindow>;

    beforeEach(() => {
        adapter = createAdapter();
        mockWindow = createMockWindow(true);
        vi.stubGlobal("window", mockWindow);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    // ================================================================
    // OK Scenarios — verified existing behavior
    // ================================================================

    describe("OK-1: 401 → proxy refresh → retry succeeds", () => {
        it("should refresh token via proxy and retry the API call", async () => {
            vi.stubGlobal("fetch", sequentialFetch([
                { match: /googleapis.*startPageToken/, respond: mockResponse({ error: { message: "Invalid Credentials" } }, 401) },
                { match: /api\/auth\/refresh/, respond: mockResponse(VALID_TOKEN_RESPONSE) },
                { match: /googleapis.*startPageToken/, respond: mockResponse(PAGE_TOKEN_RESPONSE) },
            ]));

            const token = await adapter.getStartPageToken();
            expect(token).toBe("42");
        });
    });

    describe("OK-2: 401 → direct refresh → retry succeeds", () => {
        it("should refresh token directly and retry the API call", async () => {
            const a = createAdapter("client-credentials");
            vi.stubGlobal("fetch", sequentialFetch([
                { match: /googleapis.*startPageToken/, respond: mockResponse({ error: { message: "Invalid Credentials" } }, 401) },
                { match: /oauth2\.googleapis\.com\/token/, respond: mockResponse(VALID_TOKEN_RESPONSE) },
                { match: /googleapis.*startPageToken/, respond: mockResponse(PAGE_TOKEN_RESPONSE) },
            ]));

            const token = await a.getStartPageToken();
            expect(token).toBe("42");
        });
    });

    describe("OK-3: 5xx → exponential backoff → retry succeeds", () => {
        it("should retry on 500 and succeed", async () => {
            vi.stubGlobal("fetch", sequentialFetch([
                { match: /googleapis/, respond: mockResponse({ error: { message: "Internal" } }, 500) },
                { match: /googleapis/, respond: mockResponse(PAGE_TOKEN_RESPONSE) },
            ]));

            const token = await adapter.getStartPageToken();
            expect(token).toBe("42");
        });
    });

    describe("OK-4: 429 → backoff → retry succeeds", () => {
        it("should retry on 429 and succeed", async () => {
            vi.stubGlobal("fetch", sequentialFetch([
                { match: /googleapis/, respond: mockResponse({ error: { message: "Rate limit" } }, 429) },
                { match: /googleapis/, respond: mockResponse(PAGE_TOKEN_RESPONSE) },
            ]));

            const token = await adapter.getStartPageToken();
            expect(token).toBe("42");
        });
    });

    describe("OK-5: network error (TypeError) → retry succeeds", () => {
        it("should retry on temporary network error", async () => {
            vi.stubGlobal("fetch", sequentialFetch([
                { match: /googleapis/, respond: networkError() },
                { match: /googleapis/, respond: mockResponse(PAGE_TOKEN_RESPONSE) },
            ]));

            const token = await adapter.getStartPageToken();
            expect(token).toBe("42");
        });
    });

    describe("OK-6: 403 → no retry, immediate error", () => {
        it("should not retry 403 and throw immediately", async () => {
            vi.stubGlobal("fetch", sequentialFetch([
                { match: /googleapis/, respond: mockResponse({ error: { message: "Forbidden" } }, 403) },
            ]));

            await expect(adapter.getStartPageToken()).rejects.toThrow("Forbidden");
            expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
        });
    });

    describe("OK-7: invalid_grant → onAuthFailure called", () => {
        it("should call onAuthFailure and clear tokens on invalid_grant from proxy", async () => {
            const onFail = vi.fn();
            adapter.onAuthFailure = onFail;

            vi.stubGlobal("fetch", sequentialFetch([
                { match: /googleapis.*startPageToken/, respond: mockResponse({}, 401) },
                { match: /api\/auth\/refresh/, respond: mockResponse({ error: "invalid_grant" }, 400) },
            ]));

            // invalid_grant now throws, caught by 401 handler → "Authentication failed"
            await expect(adapter.getStartPageToken()).rejects.toThrow("Authentication failed");
            expect(onFail).toHaveBeenCalledTimes(1);
            expect(adapter.getTokens().accessToken).toBeNull();
            expect(adapter.getTokens().refreshToken).toBeNull();
        });
    });

    // ================================================================
    // F1: waitForOnline timeout
    // ================================================================

    describe("F1: waitForOnline times out after 60s", () => {
        it("should resolve after timeout even if still offline", async () => {
            vi.useFakeTimers();
            mockWindow.navigator.onLine = false;
            vi.stubGlobal("window", mockWindow);

            let callCount = 0;
            vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
                callCount++;
                // First calls fail with network error; last one succeeds
                if (callCount <= 3) throw new TypeError("Failed to fetch");
                return Promise.resolve(mockResponse(PAGE_TOKEN_RESPONSE));
            }));

            const promise = adapter.getStartPageToken();

            // Advance past timeout (60s) + backoff delays for each retry
            // Retry 0: waitForOnline(60s) + backoff(2s) → 62s
            // Retry 1: waitForOnline(60s) + backoff(4s) → 126s
            // Retry 2: waitForOnline(60s) + backoff(8s) → 194s
            // Retry 3: final attempt succeeds
            await vi.advanceTimersByTimeAsync(250_000);

            const token = await promise;
            expect(token).toBe("42");
            expect(callCount).toBeGreaterThanOrEqual(2);

            vi.useRealTimers();
        });

        it("should use the configured timeout constant", () => {
            expect(GoogleDriveAdapter.ONLINE_TIMEOUT_MS).toBe(60_000);
        });
    });

    // ================================================================
    // F2: refreshTokensDirect network error preserves tokens
    // ================================================================

    describe("F2: refreshTokensDirect network error does NOT clear auth", () => {
        it("should NOT call onAuthFailure when Google OAuth is unreachable (network error ≠ invalid token)", async () => {
            const a = createAdapter("client-credentials");
            const onFail = vi.fn();
            a.onAuthFailure = onFail;

            vi.stubGlobal("fetch", sequentialFetch([
                { match: /googleapis.*startPageToken/, respond: mockResponse({}, 401) },
                { match: /oauth2\.googleapis\.com\/token/, respond: networkError() },
            ]));

            await expect(a.getStartPageToken()).rejects.toThrow("Authentication failed");
            expect(onFail).not.toHaveBeenCalled();
        });
    });

    // ================================================================
    // F3: Malformed JSON response handling
    // ================================================================

    describe("F3: malformed JSON response → clear error, not SyntaxError", () => {
        it("should fail gracefully when proxy refresh returns HTML (not SyntaxError crash)", async () => {
            vi.stubGlobal("fetch", sequentialFetch([
                { match: /googleapis.*startPageToken/, respond: mockResponse({}, 401) },
                { match: /api\/auth\/refresh/, respond: htmlResponse("<html>Cloudflare Error</html>") },
            ]));

            // safeJsonParse throws "Invalid JSON from proxy refresh:..." but
            // the 401 handler wraps it as "Authentication failed:..."
            const err = adapter.getStartPageToken();
            await expect(err).rejects.toThrow("Authentication failed");
            // Crucially: NOT a raw SyntaxError
            await expect(err).rejects.not.toBeInstanceOf(SyntaxError);
        });

        it("should fail gracefully when direct refresh returns garbage", async () => {
            const a = createAdapter("client-credentials");

            vi.stubGlobal("fetch", sequentialFetch([
                { match: /googleapis.*startPageToken/, respond: mockResponse({}, 401) },
                { match: /oauth2\.googleapis\.com\/token/, respond: htmlResponse("{{not json}}") },
            ]));

            const err = a.getStartPageToken();
            await expect(err).rejects.toThrow("Authentication failed");
            await expect(err).rejects.not.toBeInstanceOf(SyntaxError);
        });

        it("should throw clear error when exchangeCodeForToken gets invalid JSON", async () => {
            const a = createAdapter("client-credentials");
            (a as any).codeVerifier = "test-verifier";

            vi.stubGlobal("fetch", sequentialFetch([
                { match: /oauth2\.googleapis\.com\/token/, respond: htmlResponse("<html>Error</html>") },
            ]));

            // No 401 wrapper here — safeJsonParse error propagates directly
            await expect(a.exchangeCodeForToken("test-code")).rejects.toThrow(
                /Invalid JSON from token exchange/,
            );
        });
    });

    // ================================================================
    // F4: Proxy returns 200 without access_token
    // ================================================================

    describe("F4: proxy 200 without access_token → error", () => {
        it("should throw when proxy returns 200 but no access_token field", async () => {
            vi.stubGlobal("fetch", sequentialFetch([
                { match: /googleapis.*startPageToken/, respond: mockResponse({}, 401) },
                { match: /api\/auth\/refresh/, respond: mockResponse({ token_type: "Bearer" }) },
            ]));

            await expect(adapter.getStartPageToken()).rejects.toThrow("Authentication failed");
        });

        it("should throw when proxy returns 200 with access_token: null", async () => {
            vi.stubGlobal("fetch", sequentialFetch([
                { match: /googleapis.*startPageToken/, respond: mockResponse({}, 401) },
                { match: /api\/auth\/refresh/, respond: mockResponse({ access_token: null }) },
            ]));

            await expect(adapter.getStartPageToken()).rejects.toThrow("Authentication failed");
        });
    });

    // ================================================================
    // F5: exchangeCodeForToken network error
    // ================================================================

    describe("F5: exchangeCodeForToken network error → user-friendly message", () => {
        it("should throw a clear message when Google is unreachable during initial auth", async () => {
            const a = createAdapter("client-credentials");
            (a as any).codeVerifier = "test-verifier";

            vi.stubGlobal("fetch", sequentialFetch([
                { match: /oauth2\.googleapis\.com\/token/, respond: networkError() },
            ]));

            await expect(a.exchangeCodeForToken("test-code")).rejects.toThrow(
                "could not reach Google servers",
            );
        });
    });

    // ================================================================
    // F7: Proactive refresh deduplication
    // ================================================================

    describe("F7: concurrent refreshTokens calls are deduplicated", () => {
        it("should only call the proxy refresh endpoint once for concurrent requests", async () => {
            // Token is expired → triggers proactive refresh
            adapter.setTokens("old-token", "valid-refresh-token", Date.now() - 1000);

            let refreshCallCount = 0;
            vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
                if (/api\/auth\/refresh/.test(url)) {
                    refreshCallCount++;
                    return Promise.resolve(mockResponse(VALID_TOKEN_RESPONSE));
                }
                if (/googleapis.*startPageToken/.test(url)) {
                    return Promise.resolve(mockResponse(PAGE_TOKEN_RESPONSE));
                }
                if (/googleapis.*drive\/v3\/files/.test(url)) {
                    return Promise.resolve(mockResponse({ files: [] }));
                }
                throw new Error(`Unexpected: ${url}`);
            }));

            const [token1, token2] = await Promise.all([
                adapter.getStartPageToken(),
                adapter.getStartPageToken(),
            ]);

            expect(token1).toBe("42");
            expect(token2).toBe("42");
            expect(refreshCallCount).toBe(1);
        });
    });

    // ================================================================
    // Additional edge cases
    // ================================================================

    describe("Edge: proactive refresh failure does not block API call", () => {
        it("should proceed with existing token if proactive refresh fails", async () => {
            // Token is "expiring soon" (within 5 min) but technically still valid
            adapter.setTokens("still-valid-token", "valid-refresh-token", Date.now() + 60_000);

            vi.stubGlobal("fetch", sequentialFetch([
                { match: /api\/auth\/refresh/, respond: networkError() },
                { match: /googleapis.*startPageToken/, respond: mockResponse(PAGE_TOKEN_RESPONSE) },
            ]));

            const token = await adapter.getStartPageToken();
            expect(token).toBe("42");
        });
    });

    describe("Edge: onTokenRefresh is called on successful refresh", () => {
        it("should call onTokenRefresh after proxy refresh", async () => {
            const onRefresh = vi.fn();
            adapter.onTokenRefresh = onRefresh;

            vi.stubGlobal("fetch", sequentialFetch([
                { match: /googleapis.*startPageToken/, respond: mockResponse({}, 401) },
                { match: /api\/auth\/refresh/, respond: mockResponse(VALID_TOKEN_RESPONSE) },
                { match: /googleapis.*startPageToken/, respond: mockResponse(PAGE_TOKEN_RESPONSE) },
            ]));

            await adapter.getStartPageToken();
            expect(onRefresh).toHaveBeenCalledTimes(1);
        });

        it("should call onTokenRefresh after direct refresh", async () => {
            const a = createAdapter("client-credentials");
            const onRefresh = vi.fn();
            a.onTokenRefresh = onRefresh;

            vi.stubGlobal("fetch", sequentialFetch([
                { match: /googleapis.*startPageToken/, respond: mockResponse({}, 401) },
                { match: /oauth2\.googleapis\.com\/token/, respond: mockResponse(VALID_TOKEN_RESPONSE) },
                { match: /googleapis.*startPageToken/, respond: mockResponse(PAGE_TOKEN_RESPONSE) },
            ]));

            await a.getStartPageToken();
            expect(onRefresh).toHaveBeenCalledTimes(1);
        });
    });

    describe("Edge: tokenExpiresAt is set after refresh", () => {
        it("should update tokenExpiresAt from expires_in on proxy refresh", async () => {
            vi.stubGlobal("fetch", sequentialFetch([
                { match: /googleapis.*startPageToken/, respond: mockResponse({}, 401) },
                { match: /api\/auth\/refresh/, respond: mockResponse(VALID_TOKEN_RESPONSE) },
                { match: /googleapis.*startPageToken/, respond: mockResponse(PAGE_TOKEN_RESPONSE) },
            ]));

            const before = Date.now();
            await adapter.getStartPageToken();
            const tokens = adapter.getTokens();

            expect(tokens.tokenExpiresAt).toBeGreaterThan(before);
            expect(tokens.tokenExpiresAt).toBeLessThanOrEqual(before + 3600_000 + 1000);
        });
    });

    describe("Edge: 3+ consecutive network errors exhausts retries", () => {
        it("should throw after MAX_RETRIES network errors", async () => {
            vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
                throw new TypeError("Failed to fetch");
            }));

            await expect(adapter.getStartPageToken()).rejects.toThrow("Failed to fetch");
            // 1 original + 3 retries = 4 calls
            expect(vi.mocked(fetch)).toHaveBeenCalledTimes(4);
        });
    });
});
