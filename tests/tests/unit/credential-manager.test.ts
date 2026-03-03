/**
 * @file CredentialManager ユニットテスト
 *
 * @description
 * CredentialManager のOAuth認証フロー（コールバック、トークン永続化、
 * アダプタファサード、クレデンシャル更新）をモック依存で検証する。
 *
 * @pass_criteria
 * - setupAdapterCallbacks: onAuthFailure→クリア, onTokenRefresh→保存
 * - handleAuthCallback: proxy tokens→保存+sync, code exchange→保存+sync, error→通知, invalid state→拒否
 * - saveCredentials: adapter設定+SecureStorage保存
 * - facade methods: setAuthConfig/getClientId/getClientSecret/isAdapterAuthenticated/adapterLogin
 * - updateClientCredential: clientId/clientSecret個別更新
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { CredentialManager } from "../../../src/services/credential-manager";

function createMockDeps() {
    const adapter = {
        clientId: "test-client-id",
        clientSecret: "test-secret",
        onAuthFailure: null as any,
        onTokenRefresh: null as any,
        setTokens: vi.fn(),
        getTokens: vi.fn().mockReturnValue({
            accessToken: "access-1",
            refreshToken: "refresh-1",
            tokenExpiresAt: Date.now() + 3600000,
        }),
        setCredentials: vi.fn(),
        isAuthenticated: vi.fn().mockReturnValue(true),
        login: vi.fn().mockResolvedValue(undefined),
        verifyState: vi.fn().mockReturnValue(true),
        exchangeCodeForToken: vi.fn().mockResolvedValue(undefined),
        setAuthConfig: vi.fn(),
        updateConfig: vi.fn(),
    };

    const secureStorage = {
        saveCredentials: vi.fn().mockResolvedValue(undefined),
        clearCredentials: vi.fn().mockResolvedValue(undefined),
    };

    const syncManager = {
        notify: vi.fn().mockResolvedValue(undefined),
        requestSmartSync: vi.fn().mockResolvedValue(undefined),
    };

    const deps = {
        adapter,
        getSecureStorage: () => secureStorage,
        getSyncManager: () => syncManager,
        getVaultName: () => "TestVault",
        getCloudRootFolder: () => "MyRoot",
    };

    return { adapter, secureStorage, syncManager, deps };
}

// Mock window.localStorage
const localStorageMock: Record<string, string> = {};
(globalThis as any).window = {
    localStorage: {
        getItem: (key: string) => localStorageMock[key] || null,
        setItem: (key: string, value: string) => { localStorageMock[key] = value; },
        removeItem: (key: string) => { delete localStorageMock[key]; },
    },
};

describe("CredentialManager", () => {
    let adapter: ReturnType<typeof createMockDeps>["adapter"];
    let secureStorage: ReturnType<typeof createMockDeps>["secureStorage"];
    let syncManager: ReturnType<typeof createMockDeps>["syncManager"];
    let manager: CredentialManager;

    beforeEach(() => {
        const mocks = createMockDeps();
        adapter = mocks.adapter;
        secureStorage = mocks.secureStorage;
        syncManager = mocks.syncManager;
        manager = new CredentialManager(mocks.deps as any);
    });

    describe("setupAdapterCallbacks", () => {
        it("should set onAuthFailure callback that clears credentials", async () => {
            manager.setupAdapterCallbacks();
            expect(adapter.onAuthFailure).toBeDefined();

            await adapter.onAuthFailure();
            expect(secureStorage.clearCredentials).toHaveBeenCalled();
            expect(adapter.setTokens).toHaveBeenCalledWith(null, null);
        });

        it("should set onTokenRefresh callback that saves tokens", async () => {
            manager.setupAdapterCallbacks();
            expect(adapter.onTokenRefresh).toBeDefined();

            await adapter.onTokenRefresh();
            expect(secureStorage.saveCredentials).toHaveBeenCalledWith(
                expect.objectContaining({
                    clientId: "test-client-id",
                    clientSecret: "test-secret",
                    accessToken: "access-1",
                    refreshToken: "refresh-1",
                })
            );
        });

        it("should not save credentials when tokens are missing", async () => {
            adapter.getTokens.mockReturnValue({
                accessToken: null,
                refreshToken: null,
                tokenExpiresAt: 0,
            });

            manager.setupAdapterCallbacks();
            await adapter.onTokenRefresh();
            expect(secureStorage.saveCredentials).not.toHaveBeenCalled();
        });
    });

    describe("handleAuthCallback", () => {
        it("should reject invalid state", async () => {
            adapter.verifyState.mockReturnValue(false);
            await manager.handleAuthCallback({ state: "bad-state" });
            expect(syncManager.notify).toHaveBeenCalledWith("noticeAuthFailed", "Invalid state");
        });

        it("should handle proxy mode (direct tokens)", async () => {
            await manager.handleAuthCallback({
                access_token: "proxy-access",
                refresh_token: "proxy-refresh",
                expires_in: "7200",
            });

            expect(adapter.setTokens).toHaveBeenCalledWith(
                "proxy-access", "proxy-refresh", expect.any(Number)
            );
            expect(secureStorage.saveCredentials).toHaveBeenCalled();
            expect(syncManager.notify).toHaveBeenCalledWith("noticeAuthSuccess");
            expect(syncManager.requestSmartSync).toHaveBeenCalledWith("manual-sync");
        });

        it("should default expires_in to 3600 when not provided", async () => {
            const before = Date.now();
            await manager.handleAuthCallback({
                access_token: "a",
                refresh_token: "r",
            });
            const after = Date.now();

            const tokenCall = adapter.setTokens.mock.calls[0];
            const expiresAt = tokenCall[2] as number;
            // Should be roughly now + 3600s
            expect(expiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000);
            expect(expiresAt).toBeLessThanOrEqual(after + 3600 * 1000);
        });

        it("should handle code exchange mode", async () => {
            await manager.handleAuthCallback({ code: "auth-code-123" });

            expect(adapter.exchangeCodeForToken).toHaveBeenCalledWith("auth-code-123");
            expect(secureStorage.saveCredentials).toHaveBeenCalled();
            expect(syncManager.notify).toHaveBeenCalledWith("noticeAuthSuccess");
        });

        it("should handle auth error", async () => {
            await manager.handleAuthCallback({ error: "access_denied" });
            expect(syncManager.notify).toHaveBeenCalledWith("noticeAuthFailed", "access_denied");
        });

        it("should notify on proxy token failure", async () => {
            adapter.setTokens.mockImplementation(() => { throw new Error("token error"); });

            await manager.handleAuthCallback({
                access_token: "bad",
                refresh_token: "bad",
            });
            expect(syncManager.notify).toHaveBeenCalledWith("noticeAuthFailed", "token error");
        });

        it("should notify on code exchange failure", async () => {
            adapter.exchangeCodeForToken.mockRejectedValue(new Error("exchange failed"));

            await manager.handleAuthCallback({ code: "bad-code" });
            expect(syncManager.notify).toHaveBeenCalledWith("noticeAuthFailed", "exchange failed");
        });
    });

    describe("saveCredentials", () => {
        it("should update adapter and persist to secure storage", async () => {
            await manager.saveCredentials("cid", "csecret", "at", "rt", 999999);

            expect(adapter.setCredentials).toHaveBeenCalledWith("cid", "csecret");
            expect(adapter.setTokens).toHaveBeenCalledWith("at", "rt", 999999);
            expect(secureStorage.saveCredentials).toHaveBeenCalledWith({
                clientId: "cid",
                clientSecret: "csecret",
                accessToken: "at",
                refreshToken: "rt",
                tokenExpiresAt: 999999,
            });
            expect(adapter.updateConfig).toHaveBeenCalledWith("cid", "csecret", "TestVault", "MyRoot");
        });

        it("should default tokenExpiresAt to 0 when not provided", async () => {
            await manager.saveCredentials("cid", "csecret", "at", "rt");

            expect(secureStorage.saveCredentials).toHaveBeenCalledWith(
                expect.objectContaining({ tokenExpiresAt: 0 })
            );
        });
    });

    describe("facade methods", () => {
        it("setAuthConfig should delegate to adapter", () => {
            manager.setAuthConfig("client-credentials", "https://proxy.test");
            expect(adapter.setAuthConfig).toHaveBeenCalledWith("client-credentials", "https://proxy.test");
        });

        it("getClientId should return adapter clientId", () => {
            expect(manager.getClientId()).toBe("test-client-id");
        });

        it("getClientSecret should return adapter clientSecret", () => {
            expect(manager.getClientSecret()).toBe("test-secret");
        });

        it("isAdapterAuthenticated should delegate to adapter", () => {
            expect(manager.isAdapterAuthenticated()).toBe(true);
            adapter.isAuthenticated.mockReturnValue(false);
            expect(manager.isAdapterAuthenticated()).toBe(false);
        });

        it("adapterLogin should delegate to adapter", async () => {
            await manager.adapterLogin();
            expect(adapter.login).toHaveBeenCalled();
        });
    });

    describe("updateClientCredential", () => {
        it("should update clientId while preserving clientSecret", async () => {
            await manager.updateClientCredential("clientId", "new-client-id");
            expect(adapter.updateConfig).toHaveBeenCalledWith(
                "new-client-id", "test-secret", "TestVault", "MyRoot"
            );
        });

        it("should update clientSecret while preserving clientId", async () => {
            await manager.updateClientCredential("clientSecret", "new-secret");
            expect(adapter.updateConfig).toHaveBeenCalledWith(
                "test-client-id", "new-secret", "TestVault", "MyRoot"
            );
        });

        it("should save credentials after update", async () => {
            await manager.updateClientCredential("clientId", "new-id");
            expect(secureStorage.saveCredentials).toHaveBeenCalled();
        });
    });
});
