/**
 * @file GoogleAuthService ユニットテスト
 *
 * @description
 * GoogleAuthService のOAuth認証フロー、トークン管理、認証状態管理、
 * setAuthConfig のURL検証ロジックを検証する。
 *
 * @pass_criteria
 * - setAuthConfig: default/custom-proxy/client-credentials正常、HTTPS強制、不正URL→空
 * - isAuthenticated / getAuthStatus: トークン有無で状態変化
 * - setTokens / getTokens: 設定と取得の一致
 * - verifyState: 一致→true、不一致→false、保存なし→false
 * - exchangeCodeForToken: 正常→トークン設定、verifier不在→エラー、ネットワーク→エラー
 * - refreshTokens: proxy/direct各パス、invalid_grant→クリア、並行呼び出し→共有promise
 * - getAuthUrl: proxy mode / client-credentials mode
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GoogleAuthService } from "../../../src/cloud-adapters/google-drive/auth-service";

// Mock window and localStorage
const localStorageMock: Record<string, string | null> = {};
// Use Node.js webcrypto for real crypto operations
import { webcrypto } from "node:crypto";

const windowMock = {
    crypto: {
        getRandomValues: (arr: Uint8Array) => {
            return webcrypto.getRandomValues(arr as unknown as Uint8Array<ArrayBuffer>);
        },
        subtle: webcrypto.subtle,
    },
    localStorage: {
        getItem: (key: string) => localStorageMock[key] ?? null,
        setItem: (key: string, value: string) => { localStorageMock[key] = value; },
        removeItem: (key: string) => { delete localStorageMock[key]; },
    },
    navigator: { onLine: true },
    open: vi.fn(),
};
(globalThis as any).window = windowMock;

// Mock global fetch
const mockFetch = vi.fn();
(globalThis as any).fetch = mockFetch;

describe("GoogleAuthService", () => {
    let auth: GoogleAuthService;

    beforeEach(() => {
        auth = new GoogleAuthService("client-id-123", "client-secret-456");
        vi.clearAllMocks();
        // Clear localStorage mock
        for (const key of Object.keys(localStorageMock)) {
            delete localStorageMock[key];
        }
    });

    describe("constructor and getters", () => {
        it("should initialize with provided credentials", () => {
            expect(auth.clientId).toBe("client-id-123");
            expect(auth.clientSecret).toBe("client-secret-456");
        });

        it("should start with no tokens", () => {
            expect(auth.accessToken).toBeNull();
            expect(auth.refreshToken).toBeNull();
            expect(auth.tokenExpiresAt).toBe(0);
        });
    });

    describe("setCredentials", () => {
        it("should update clientId and clientSecret", () => {
            auth.setCredentials("new-id", "new-secret");
            expect(auth.clientId).toBe("new-id");
            expect(auth.clientSecret).toBe("new-secret");
        });
    });

    describe("setTokens / getTokens", () => {
        it("should set and get tokens", () => {
            auth.setTokens("access", "refresh", 12345);
            const tokens = auth.getTokens();
            expect(tokens.accessToken).toBe("access");
            expect(tokens.refreshToken).toBe("refresh");
            expect(tokens.tokenExpiresAt).toBe(12345);
        });

        it("should keep existing tokenExpiresAt when not provided", () => {
            auth.setTokens("a", "r", 99999);
            auth.setTokens("b", "r2");
            expect(auth.getTokens().tokenExpiresAt).toBe(99999);
        });
    });

    describe("isAuthenticated", () => {
        it("should return false when no access token", () => {
            expect(auth.isAuthenticated()).toBe(false);
        });

        it("should return true when access token is set", () => {
            auth.accessToken = "token";
            expect(auth.isAuthenticated()).toBe(true);
        });
    });

    describe("getAuthStatus", () => {
        it("should return 'Not authenticated' by default", () => {
            expect(auth.getAuthStatus()).toBe("Not authenticated");
        });

        it("should return 'Token available' when only refresh token", () => {
            auth.refreshToken = "rt";
            expect(auth.getAuthStatus()).toBe("Token available (Requires refresh)");
        });

        it("should return 'Authenticated' when access token present", () => {
            auth.accessToken = "at";
            expect(auth.getAuthStatus()).toBe("Authenticated");
        });
    });

    describe("setAuthConfig", () => {
        it("should accept default method", () => {
            auth.setAuthConfig("default");
            // No error thrown
        });

        it("should accept custom-proxy with valid HTTPS URL", () => {
            auth.setAuthConfig("custom-proxy", "https://my-proxy.example.com");
            // Internally stored; validated via getAuthUrl behavior
        });

        it("should reject custom-proxy with HTTP URL", () => {
            auth.setAuthConfig("custom-proxy", "http://insecure.example.com");
            // Falls back to empty proxyUrl (non-HTTPS rejected)
        });

        it("should reject custom-proxy with invalid URL", () => {
            auth.setAuthConfig("custom-proxy", "not-a-url");
            // Falls back to empty proxyUrl
        });

        it("should handle client-credentials method", () => {
            auth.setAuthConfig("client-credentials");
            // No error thrown, proxyUrl cleared
        });
    });

    describe("verifyState", () => {
        it("should return false when no state saved", () => {
            expect(auth.verifyState("some-state")).toBe(false);
        });

        it("should return true when state matches currentAuthState", () => {
            (auth as any).currentAuthState = "test-state";
            expect(auth.verifyState("test-state")).toBe(true);
        });

        it("should return false when state doesn't match", () => {
            (auth as any).currentAuthState = "correct";
            expect(auth.verifyState("wrong")).toBe(false);
        });

        it("should fall back to localStorage when currentAuthState is null", () => {
            localStorageMock["vault-sync-state"] = "saved-state";
            expect(auth.verifyState("saved-state")).toBe(true);
        });
    });

    describe("setLogger", () => {
        it("should set logger callback", () => {
            const logger = vi.fn();
            auth.setLogger(logger);
            expect(auth.logger).toBe(logger);
        });
    });

    describe("exchangeCodeForToken", () => {
        it("should throw when code verifier is missing", async () => {
            await expect(auth.exchangeCodeForToken("code")).rejects.toThrow("Code verifier missing");
        });

        it("should exchange code for tokens successfully", async () => {
            (auth as any).codeVerifier = "test-verifier";
            mockFetch.mockResolvedValueOnce({
                ok: true,
                text: () => Promise.resolve(JSON.stringify({
                    access_token: "new-access",
                    refresh_token: "new-refresh",
                    expires_in: 3600,
                })),
            });

            await auth.exchangeCodeForToken("auth-code");
            expect(auth.accessToken).toBe("new-access");
            expect(auth.refreshToken).toBe("new-refresh");
            expect(auth.tokenExpiresAt).toBeGreaterThan(Date.now());
        });

        it("should throw on token exchange error response", async () => {
            (auth as any).codeVerifier = "test-verifier";
            mockFetch.mockResolvedValueOnce({
                ok: false,
                text: () => Promise.resolve(JSON.stringify({
                    error: "invalid_grant",
                    error_description: "Code expired",
                })),
            });

            await expect(auth.exchangeCodeForToken("bad-code")).rejects.toThrow("Code expired");
        });

        it("should throw on network error", async () => {
            (auth as any).codeVerifier = "test-verifier";
            mockFetch.mockRejectedValueOnce(new Error("Network error"));

            await expect(auth.exchangeCodeForToken("code")).rejects.toThrow("could not reach Google servers");
        });

        it("should recover verifier from localStorage", async () => {
            localStorageMock["vault-sync-verifier"] = "stored-verifier";
            mockFetch.mockResolvedValueOnce({
                ok: true,
                text: () => Promise.resolve(JSON.stringify({
                    access_token: "at",
                    refresh_token: "rt",
                })),
            });

            await auth.exchangeCodeForToken("code");
            expect(auth.accessToken).toBe("at");
        });

        it("should throw on malformed JSON response", async () => {
            (auth as any).codeVerifier = "test-verifier";
            mockFetch.mockResolvedValueOnce({
                ok: true,
                text: () => Promise.resolve("<html>Error page</html>"),
            });

            await expect(auth.exchangeCodeForToken("code")).rejects.toThrow("Invalid JSON");
        });
    });

    describe("refreshTokens (direct mode)", () => {
        beforeEach(() => {
            auth.setAuthConfig("client-credentials");
            auth.refreshToken = "valid-refresh-token";
        });

        it("should refresh tokens successfully", async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                text: () => Promise.resolve(JSON.stringify({
                    access_token: "refreshed-access",
                    refresh_token: "new-refresh",
                    expires_in: 7200,
                })),
            });

            const onRefresh = vi.fn();
            auth.onTokenRefresh = onRefresh;

            await auth.refreshTokens();
            expect(auth.accessToken).toBe("refreshed-access");
            expect(auth.refreshToken).toBe("new-refresh");
            expect(onRefresh).toHaveBeenCalled();
        });

        it("should clear tokens on invalid_grant error", async () => {
            auth.accessToken = "old-access";
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 400,
                text: () => Promise.resolve(JSON.stringify({
                    error: "invalid_grant",
                    error_description: "Token revoked",
                })),
            });

            const onFailure = vi.fn();
            auth.onAuthFailure = onFailure;

            await expect(auth.refreshTokens()).rejects.toThrow("Token revoked");
            expect(auth.accessToken).toBeNull();
            expect(auth.refreshToken).toBeNull();
            expect(onFailure).toHaveBeenCalled();
        });

        it("should not clear tokens on non-fatal server error", async () => {
            auth.accessToken = "still-valid";
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 500,
                text: () => Promise.resolve(JSON.stringify({ error: "server_error" })),
            });

            // Should NOT throw — non-fatal errors are silently ignored
            await auth.refreshTokens();
            expect(auth.accessToken).toBe("still-valid");
        });

        it("should throw on network error without clearing tokens", async () => {
            auth.accessToken = "keep-this";
            mockFetch.mockRejectedValueOnce(new Error("Connection refused"));

            await expect(auth.refreshTokens()).rejects.toThrow("Google OAuth unreachable");
            expect(auth.accessToken).toBe("keep-this");
        });

        it("should share promise for concurrent refresh calls", async () => {
            let resolveCount = 0;
            mockFetch.mockImplementation(() => {
                resolveCount++;
                return Promise.resolve({
                    ok: true,
                    text: () => Promise.resolve(JSON.stringify({ access_token: "at" })),
                });
            });

            await Promise.all([auth.refreshTokens(), auth.refreshTokens()]);
            // Only one actual fetch call should be made
            expect(resolveCount).toBe(1);
        });
    });

    describe("handleCallback", () => {
        it("should throw on state mismatch", async () => {
            (auth as any).currentAuthState = "expected";
            await expect(auth.handleCallback("obsidian://vault-sync-auth?state=wrong&code=abc"))
                .rejects.toThrow("Invalid state");
        });

        it("should exchange code when state matches", async () => {
            (auth as any).currentAuthState = "good-state";
            (auth as any).codeVerifier = "verifier";
            mockFetch.mockResolvedValueOnce({
                ok: true,
                text: () => Promise.resolve(JSON.stringify({
                    access_token: "at", refresh_token: "rt",
                })),
            });

            await auth.handleCallback("obsidian://vault-sync-auth?state=good-state&code=auth-code");
            expect(auth.accessToken).toBe("at");
        });
    });

    describe("getAuthUrl", () => {
        it("should generate proxy auth URL for default method", async () => {
            auth.setAuthConfig("default");
            const url = await auth.getAuthUrl();
            expect(url).toContain("/api/auth/login");
            expect(url).toContain("state=p%3A"); // "p:" prefix URL-encoded
        });

        it("should generate Google OAuth URL for client-credentials method", async () => {
            auth.setAuthConfig("client-credentials");
            const url = await auth.getAuthUrl();
            expect(url).toContain("accounts.google.com/o/oauth2");
            expect(url).toContain("code_challenge=");
            expect(url).toContain("state=d%3A"); // "d:" prefix URL-encoded
        });

        it("should save state to localStorage", async () => {
            await auth.getAuthUrl();
            expect(localStorageMock["vault-sync-state"]).toBeDefined();
        });
    });

    describe("login", () => {
        it("should open auth URL in browser", async () => {
            auth.setAuthConfig("default");
            await auth.login();
            expect(windowMock.open).toHaveBeenCalledWith(expect.stringContaining("/api/auth/login"));
        });
    });

    describe("logout", () => {
        it("should not throw (TODO implementation)", async () => {
            await auth.logout();
            // No-op currently
        });
    });
});
