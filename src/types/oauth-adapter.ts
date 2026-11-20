import type { CloudAdapter } from "./adapter";

/** OAuth tokens as an adapter keeps them in memory. */
export interface OAuthTokens {
    accessToken: string | null;
    refreshToken: string | null;
    /** Unix time (ms); 0 when unknown */
    tokenExpiresAt: number;
}

/** How the user signs in: the shared sign-in service, their own proxy, or their own app. */
export type OAuthMethod = "default" | "custom-proxy" | "client-credentials";

/**
 * A cloud adapter that signs in with OAuth and keeps its own tokens.
 *
 * This is what the plugin shell (settings, stored credentials, the sign-in
 * buttons and the sign-in callback) needs from an adapter. Depending on this
 * instead of a concrete adapter class keeps the shell free of any one cloud,
 * so a second provider plugs in without touching it.
 */
export interface OAuthCloudAdapter extends CloudAdapter {
    readonly clientId: string;
    readonly clientSecret: string;

    setCredentials(clientId: string, clientSecret: string): void;
    setTokens(accessToken: string | null, refreshToken: string | null, tokenExpiresAt?: number): void;
    getTokens(): OAuthTokens;
    /** Apply app credentials plus the vault name and cloud root folder in one step. */
    updateConfig(
        clientId: string,
        clientSecret: string,
        vaultName?: string,
        cloudRootFolder?: string,
    ): void;
    setAuthConfig(method: OAuthMethod, proxyUrl?: string): void;

    /** Start the sign-in in the browser. */
    login(): Promise<void>;
    /** Check the state value a sign-in callback carries against the one we sent. */
    verifyState(state: string): boolean;
    /** Finish a sign-in that returned an authorization code. */
    exchangeCodeForToken(code: string): Promise<void>;

    /** Called when the sign-in can no longer be refreshed (revoked, expired). */
    onAuthFailure: (() => void | Promise<void>) | null;
    /** Called after tokens were refreshed, so they can be stored. */
    onTokenRefresh: (() => void | Promise<void>) | null;
}
