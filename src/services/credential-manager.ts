import type { GoogleDriveAdapter } from "../cloud-adapters/google-drive";
import type { SecureStorage } from "./secure-storage";
import type { SyncManager } from "../sync-manager";

interface CredentialManagerDeps {
    adapter: GoogleDriveAdapter;
    getSecureStorage: () => SecureStorage;
    getSyncManager: () => SyncManager;
    getVaultName: () => string;
    getCloudRootFolder: () => string;
}

/**
 * Manages OAuth credentials, token persistence, adapter authentication
 * facades, and protocol handler callback logic.
 *
 * Extracted from the main Vault-Sync plugin class to separate
 * credential management from plugin lifecycle orchestration.
 */
export class CredentialManager {
    constructor(private deps: CredentialManagerDeps) {}

    /**
     * Wire up adapter callbacks for auth failure (credential cleanup)
     * and token refresh (persist new tokens to SecretStorage).
     */
    setupAdapterCallbacks(): void {
        const { adapter, getSecureStorage } = this.deps;

        adapter.onAuthFailure = async () => {
            console.log("Vault-Sync: Auth failed (token expired/revoked). Clearing credentials.");
            await getSecureStorage().clearCredentials();
            adapter.setTokens(null, null);
        };

        adapter.onTokenRefresh = async () => {
            const tokens = adapter.getTokens();
            if (tokens.accessToken && tokens.refreshToken) {
                await getSecureStorage().saveCredentials({
                    clientId: adapter.clientId,
                    clientSecret: adapter.clientSecret,
                    accessToken: tokens.accessToken,
                    refreshToken: tokens.refreshToken,
                    tokenExpiresAt: tokens.tokenExpiresAt,
                });
            }
        };
    }

    /**
     * Handle the OAuth protocol callback (vault-sync-auth).
     * Supports both proxy mode (direct tokens) and client-credentials mode (code exchange).
     */
    async handleAuthCallback(params: Record<string, string>): Promise<void> {
        const { adapter } = this.deps;
        const syncManager = this.deps.getSyncManager();

        if (params.state && !adapter.verifyState(params.state)) {
            await syncManager.notify("noticeAuthFailed", "Invalid state");
            return;
        }

        if (params.access_token && params.refresh_token) {
            try {
                const expiresIn = params.expires_in ? parseInt(params.expires_in, 10) : 3600;
                const tokenExpiresAt = Date.now() + expiresIn * 1000;

                adapter.setTokens(params.access_token, params.refresh_token, tokenExpiresAt);
                await this.saveCredentials(
                    adapter.clientId,
                    adapter.clientSecret,
                    params.access_token,
                    params.refresh_token,
                    tokenExpiresAt,
                );
                await syncManager.notify("noticeAuthSuccess");
                window.localStorage.removeItem("vault-sync-state");
                syncManager.requestSmartSync("manual-sync").catch(() => {});
            } catch (e: any) {
                await syncManager.notify("noticeAuthFailed", e.message);
                console.error("Vault-Sync: Auth failed via proxy protocol handler", e);
            }
        } else if (params.code) {
            try {
                await adapter.exchangeCodeForToken(params.code);
                const tokens = adapter.getTokens();
                await this.saveCredentials(
                    adapter.clientId,
                    adapter.clientSecret,
                    tokens.accessToken,
                    tokens.refreshToken,
                    tokens.tokenExpiresAt,
                );
                await syncManager.notify("noticeAuthSuccess");
                window.localStorage.removeItem("vault-sync-verifier");
                window.localStorage.removeItem("vault-sync-state");
                syncManager.requestSmartSync("manual-sync").catch(() => {});
            } catch (e: any) {
                await syncManager.notify("noticeAuthFailed", e.message);
                console.error("Vault-Sync: Auth failed via protocol handler", e);
            }
        } else if (params.error) {
            await syncManager.notify("noticeAuthFailed", params.error);
        }
    }

    async saveCredentials(
        clientId: string,
        clientSecret: string,
        accessToken: string | null,
        refreshToken: string | null,
        tokenExpiresAt?: number,
    ): Promise<void> {
        const { adapter, getSecureStorage, getVaultName, getCloudRootFolder } = this.deps;
        adapter.setCredentials(clientId, clientSecret);
        adapter.setTokens(accessToken, refreshToken, tokenExpiresAt);
        await getSecureStorage().saveCredentials({
            clientId,
            clientSecret,
            accessToken,
            refreshToken,
            tokenExpiresAt: tokenExpiresAt || 0,
        });
        adapter.updateConfig(clientId, clientSecret, getVaultName(), getCloudRootFolder());
    }

    // === Adapter Facade ===

    setAuthConfig(
        method: "default" | "custom-proxy" | "client-credentials",
        proxyUrl: string,
    ): void {
        this.deps.adapter.setAuthConfig(method, proxyUrl);
    }

    getClientId(): string {
        return this.deps.adapter.clientId;
    }

    getClientSecret(): string {
        return this.deps.adapter.clientSecret;
    }

    isAdapterAuthenticated(): boolean {
        return this.deps.adapter.isAuthenticated();
    }

    async adapterLogin(): Promise<void> {
        await this.deps.adapter.login();
    }

    async updateClientCredential(field: "clientId" | "clientSecret", value: string): Promise<void> {
        const { adapter, getVaultName, getCloudRootFolder } = this.deps;
        const clientId = field === "clientId" ? value : adapter.clientId;
        const clientSecret = field === "clientSecret" ? value : adapter.clientSecret;
        const tokens = adapter.getTokens();
        adapter.updateConfig(clientId, clientSecret, getVaultName(), getCloudRootFolder());
        await this.saveCredentials(clientId, clientSecret, tokens.accessToken, tokens.refreshToken);
    }
}
