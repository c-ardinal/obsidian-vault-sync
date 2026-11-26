/**
 * @file トークン更新とサインアウト／再サインインの競合
 *
 * @description
 * 更新要求の応答待ちの間にサインアウト・再サインインが発生した場合、
 * 旧更新の結果でトークンが復活・混在しないことを、Promise の解決順を固定して検証する。
 *
 * @pass_criteria
 * - サインアウト後に旧更新が完了しても accessToken は null のまま、onTokenRefresh は不発
 * - 再サインイン後に旧更新が完了しても新しいトークンを保持
 * - 再サインイン後に旧更新が invalid_grant でも新しいトークンを消去しない
 * - サインアウト後に開始した更新の単一実行（共有 promise）を旧更新の終了処理が解除しない
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { webcrypto } from "node:crypto";
import { requestUrl } from "obsidian";
import { GoogleAuthService } from "../../../src/cloud-adapters/google-drive/auth-service";
import { windowStub } from "../../setup-window";

(globalThis as any).window = windowStub({
    crypto: { getRandomValues: (a: Uint8Array) => webcrypto.getRandomValues(a as any), subtle: webcrypto.subtle },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    navigator: { onLine: true },
    open: vi.fn(),
});

function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe.each(["client-credentials", "default"] as const)("token refresh races (%s)", (method) => {
    let auth: GoogleAuthService;
    /** Pending token-endpoint answers, in call order */
    let pending: Array<ReturnType<typeof deferred<{ status: number; body: unknown }>>>;

    beforeEach(() => {
        vi.clearAllMocks();
        pending = [];
        auth = new GoogleAuthService("cid", "secret");
        auth.setAuthConfig(method);
        auth.setTokens("old-at", "old-rt", Date.now() + 3600_000);
        const next = () => {
            const d = deferred<{ status: number; body: unknown }>();
            pending.push(d);
            return d.promise;
        };
        (requestUrl as any).mockReset().mockImplementation(async (req: { url: string }) => {
            if (req.url.includes("revoke")) return { status: 200, text: "{}" };
            const { status, body } = await next();
            return { status, text: JSON.stringify(body) };
        });
    });

    it("sign-out while a refresh is in flight stays signed out", async () => {
        const onTokenRefresh = vi.fn();
        auth.onTokenRefresh = onTokenRefresh;
        const refresh = auth.refreshTokens();
        await flush();
        await auth.logout();
        pending[0].resolve({ status: 200, body: { access_token: "late-at", expires_in: 3600 } });
        await refresh;
        expect(auth.accessToken).toBeNull();
        expect(auth.refreshToken).toBeNull();
        expect(auth.isAuthenticated()).toBe(false);
        expect(onTokenRefresh).not.toHaveBeenCalled();
    });

    it("signing in again while an old refresh is in flight keeps the new tokens", async () => {
        const onTokenRefresh = vi.fn();
        auth.onTokenRefresh = onTokenRefresh;
        const refresh = auth.refreshTokens();
        await flush();
        await auth.logout();
        auth.setTokens("new-at", "new-rt", Date.now() + 3600_000);
        pending[0].resolve({ status: 200, body: { access_token: "late-at", expires_in: 3600 } });
        await refresh;
        expect(auth.getTokens()).toMatchObject({ accessToken: "new-at", refreshToken: "new-rt" });
        expect(onTokenRefresh).not.toHaveBeenCalled();
    });

    it("an old refresh failing with invalid_grant does not clear a new sign-in", async () => {
        const onAuthFailure = vi.fn();
        auth.onAuthFailure = onAuthFailure;
        const refresh = auth.refreshTokens().catch((e) => e);
        await flush();
        auth.setTokens("new-at", "new-rt", Date.now() + 3600_000);
        pending[0].resolve({ status: 400, body: { error: "invalid_grant" } });
        await refresh;
        expect(auth.getTokens()).toMatchObject({ accessToken: "new-at", refreshToken: "new-rt" });
        expect(onAuthFailure).not.toHaveBeenCalled();
    });

    it("an old refresh finishing does not break single-flight of a newer refresh", async () => {
        const first = auth.refreshTokens();
        await flush();
        await auth.logout();
        auth.setTokens("new-at", "new-rt", Date.now() + 3600_000);
        const second = auth.refreshTokens();
        await flush();
        pending[0].resolve({ status: 200, body: { access_token: "late-at", expires_in: 3600 } });
        await first;
        // The newer refresh is still running: a third caller must share it
        expect(auth.refreshTokens()).toBe(second);
        pending[1].resolve({ status: 200, body: { access_token: "fresh-at", expires_in: 3600 } });
        await second;
        expect(pending).toHaveLength(2);
        expect(auth.accessToken).toBe("fresh-at");
        expect(auth.refreshToken).toBe("new-rt");
    });

    it("saving the same tokens again does not drop a refresh result", async () => {
        const refresh = auth.refreshTokens();
        await flush();
        auth.setTokens("old-at", "old-rt");
        pending[0].resolve({ status: 200, body: { access_token: "fresh-at", expires_in: 3600 } });
        await refresh;
        expect(auth.accessToken).toBe("fresh-at");
    });
});
