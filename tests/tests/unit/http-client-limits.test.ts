/**
 * @file GoogleDriveHttpClient: request concurrency limit and rate-limit retries
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { GoogleDriveHttpClient } from "../../../src/cloud-adapters/google-drive/http-client";

function makeClient() {
    const auth = {
        accessToken: "token",
        refreshToken: null,
        tokenExpiresAt: 0,
        logger: null,
        refreshTokens: vi.fn(),
    };
    return new GoogleDriveHttpClient(auth as any);
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), { status, headers });
}

describe("GoogleDriveHttpClient limits", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("keeps at most MAX_IN_FLIGHT requests in flight", async () => {
        let inFlight = 0;
        let peak = 0;
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => {
                inFlight++;
                peak = Math.max(peak, inFlight);
                await new Promise((r) => setTimeout(r, 5));
                inFlight--;
                return jsonResponse(200, { ok: true });
            }),
        );
        const client = makeClient();
        const results = await Promise.all(
            Array.from({ length: 30 }, (_, i) => client.fetchWithAuth(`https://example.test/${i}`)),
        );
        expect(results).toHaveLength(30);
        expect(peak).toBe(GoogleDriveHttpClient.MAX_IN_FLIGHT);
    });

    it("retries a 403 rateLimitExceeded, honouring Retry-After", async () => {
        vi.stubGlobal("window", { navigator: { onLine: true } });
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(
                jsonResponse(
                    403,
                    { error: { errors: [{ reason: "userRateLimitExceeded" }], message: "Rate Limit Exceeded" } },
                    { "Retry-After": "0" },
                ),
            )
            .mockResolvedValueOnce(jsonResponse(200, { id: "ok" }));
        vi.stubGlobal("fetch", fetchMock);
        const res = await makeClient().fetchWithAuth("https://example.test/x");
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(await res.json()).toEqual({ id: "ok" });
    });

    it("does not retry a 403 that is not a rate limit", async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValue(jsonResponse(403, { error: { message: "The user does not have sufficient permissions" } }));
        vi.stubGlobal("fetch", fetchMock);
        await expect(makeClient().fetchWithAuth("https://example.test/x")).rejects.toThrow(
            "sufficient permissions",
        );
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
