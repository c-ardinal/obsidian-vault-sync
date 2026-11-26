/**
 * @file Resumable uploads and network failure handling against a fake Drive server
 *
 * The real GoogleDriveHttpClient runs against a stubbed global fetch that
 * implements the Drive resumable-upload protocol (308 Resume Incomplete with a
 * Range header, status queries with "Content-Range: bytes * /total"), so the
 * HTTP status handling is exercised end to end. Earlier tests replaced
 * fetchWithAuth itself, which hid that a 308 was treated as an error.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { createHash } from "crypto";
import { GoogleDriveAdapter } from "../../../src/cloud-adapters/google-drive/index";
import { GoogleDriveHttpClient } from "../../../src/cloud-adapters/google-drive/http-client";
import { windowStub } from "../../setup-window";

const SESSION = "https://upload.example.test/session/1";

interface FakeServer {
    received: Uint8Array;
    receivedBytes: number;
    /** Requests that carried a body (data PUTs) */
    puts: Array<{ range: string; size: number }>;
    statusQueries: number;
    /** Drop the connection after accepting this many bytes of the next PUT */
    dropNextPutAfter: number | null;
    /** Fail the next status query with a network error */
    failNextStatusQuery: boolean;
}

function makeServer(total: number): FakeServer {
    return {
        received: new Uint8Array(total),
        receivedBytes: 0,
        puts: [],
        statusQueries: 0,
        dropNextPutAfter: null,
        failNextStatusQuery: false,
    };
}

function finalResponse(server: FakeServer): Response {
    const md5 = createHash("md5").update(server.received.subarray(0, server.receivedBytes)).digest("hex");
    return new Response(JSON.stringify({ id: "file-1", md5Checksum: md5, size: String(server.receivedBytes) }), {
        status: 200,
    });
}

function incomplete(server: FakeServer): Response {
    const headers = server.receivedBytes > 0 ? { Range: `bytes=0-${server.receivedBytes - 1}` } : undefined;
    return new Response(null, { status: 308, headers });
}

function installFakeDrive(server: FakeServer, total: number) {
    const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
        const headers = new Headers(init.headers);
        if (url.includes("uploadType=resumable")) {
            return new Response("{}", { status: 200, headers: { Location: SESSION } });
        }
        if (url !== SESSION) throw new Error(`unexpected url ${url}`);
        const range = headers.get("Content-Range") ?? "";
        if (range.startsWith("bytes */")) {
            server.statusQueries++;
            if (server.failNextStatusQuery) {
                server.failNextStatusQuery = false;
                throw new TypeError("Load failed"); // WebKit wording
            }
            return server.receivedBytes === total ? finalResponse(server) : incomplete(server);
        }
        const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(range)!;
        const start = Number(m[1]);
        const body = new Uint8Array(init.body as ArrayBuffer);
        server.puts.push({ range, size: body.byteLength });
        if (start !== server.receivedBytes) {
            return new Response(JSON.stringify({ error: { message: "range mismatch" } }), { status: 400 });
        }
        if (server.dropNextPutAfter !== null) {
            const keep = Math.min(server.dropNextPutAfter, body.byteLength);
            server.received.set(body.subarray(0, keep), start);
            server.receivedBytes += keep;
            server.dropNextPutAfter = null;
            throw new TypeError("Failed to fetch");
        }
        server.received.set(body, start);
        server.receivedBytes += body.byteLength;
        return server.receivedBytes === total ? finalResponse(server) : incomplete(server);
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
}

function makeAdapter() {
    const adapter = new GoogleDriveAdapter("id", "secret", "Vault", "Root");
    adapter.auth.accessToken = "token";
    adapter.auth.tokenExpiresAt = Date.now() + 3600_000;
    const pr = (adapter as any).pathResolver;
    pr.resolveParentId = vi.fn().mockResolvedValue("parent");
    pr.cacheIdToPath = vi.fn();
    vi.spyOn(adapter, "getFileMetadata").mockResolvedValue(null);
    return adapter;
}

function payload(size: number): ArrayBuffer {
    const b = new Uint8Array(size);
    for (let i = 0; i < size; i++) b[i] = (i * 2654435761) >>> 24;
    return b.buffer;
}

describe("Resumable upload (fake Drive server)", () => {
    beforeEach(() => {
        vi.stubGlobal("window", windowStub({ navigator: { onLine: true }, addEventListener() {}, removeEventListener() {} }));
        vi.spyOn(GoogleDriveAdapter, "RESUMABLE_CHUNK_BYTES", "get").mockReturnValue(256 * 1024);
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    async function run<T>(p: Promise<T>): Promise<T> {
        let done = false;
        p.finally(() => (done = true)).catch(() => {});
        while (!done) await vi.advanceTimersByTimeAsync(1000);
        return p;
    }

    it("uploads a multi-chunk file: 308 Resume Incomplete is not an error", async () => {
        const total = 256 * 1024 * 3 + 1000;
        const server = makeServer(total);
        installFakeDrive(server, total);
        const content = payload(total);

        const result = await run(makeAdapter().uploadFileResumable("big.bin", content, Date.now()));

        expect(server.puts.length).toBe(4);
        expect(result.hash).toBe(createHash("md5").update(new Uint8Array(content)).digest("hex"));
        expect(result.size).toBe(total);
    });

    it("resumes from what the server has after the connection drops mid-chunk", async () => {
        const total = 256 * 1024 * 2;
        const server = makeServer(total);
        installFakeDrive(server, total);
        const content = payload(total);
        server.dropNextPutAfter = 1000; // first chunk: only 1000 bytes arrive

        const result = await run(makeAdapter().uploadFileResumable("big.bin", content, Date.now()));

        expect(server.statusQueries).toBe(1);
        // first PUT (dropped), the rest of chunk 1 from byte 1000, then chunk 2
        expect(server.puts.map((p) => p.range)).toEqual([
            `bytes 0-262143/${total}`,
            `bytes 1000-262143/${total}`,
            `bytes 262144-524287/${total}`,
        ]);
        expect(result.hash).toBe(createHash("md5").update(new Uint8Array(content)).digest("hex"));
    });

    it("does not re-send a chunk the server received although the response was lost", async () => {
        const total = 256 * 1024 * 2;
        const server = makeServer(total);
        installFakeDrive(server, total);
        server.dropNextPutAfter = 256 * 1024; // whole chunk arrives, answer lost

        await run(makeAdapter().uploadFileResumable("big.bin", payload(total), Date.now()));

        expect(server.puts.map((p) => p.range)).toEqual([
            `bytes 0-262143/${total}`,
            `bytes 262144-524287/${total}`,
        ]);
    });

    it("finishes when the last chunk arrived but its answer was lost", async () => {
        const total = 1000;
        const server = makeServer(total);
        installFakeDrive(server, total);
        server.dropNextPutAfter = 1000;

        const result = await run(makeAdapter().uploadFileResumable("small.bin", payload(total), Date.now()));
        expect(result.id).toBe("file-1");
        expect(server.puts.length).toBe(1);
    });

    it("keeps resuming when a status query itself fails", async () => {
        const total = 256 * 1024 * 2;
        const server = makeServer(total);
        installFakeDrive(server, total);
        server.dropNextPutAfter = 5000;
        server.failNextStatusQuery = true;

        const result = await run(makeAdapter().uploadFileResumable("big.bin", payload(total), Date.now()));
        expect(result.size).toBe(total);
    });

    it("gives up after MAX_CHUNK_RESUMES network failures", async () => {
        const total = 256 * 1024;
        const server = makeServer(total);
        const fetchMock = installFakeDrive(server, total);
        fetchMock.mockImplementation(async (url: string) => {
            if (url.includes("uploadType=resumable")) {
                return new Response("{}", { status: 200, headers: { Location: SESSION } });
            }
            throw new TypeError("Failed to fetch");
        });

        await expect(run(makeAdapter().uploadFileResumable("big.bin", payload(total), Date.now()))).rejects.toThrow(
            /network error/i,
        );
    });
});

describe("GoogleDriveHttpClient network failures", () => {
    function makeClient() {
        const auth = { accessToken: "t", refreshToken: null, tokenExpiresAt: 0, logger: null, refreshTokens: vi.fn() };
        return new GoogleDriveHttpClient(auth as any);
    }

    beforeEach(() => {
        vi.stubGlobal("window", windowStub({ navigator: { onLine: true }, addEventListener() {}, removeEventListener() {} }));
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it.each(["Failed to fetch", "Load failed", "NetworkError when attempting to fetch resource."])(
        "retries the engine-specific network error %j",
        async (message) => {
            const fetchMock = vi
                .fn()
                .mockRejectedValueOnce(new TypeError(message))
                .mockResolvedValueOnce(new Response("{}", { status: 200 }));
            vi.stubGlobal("fetch", fetchMock);
            const p = makeClient().fetchWithAuth("https://example.test/x");
            await vi.advanceTimersByTimeAsync(10_000);
            await expect(p).resolves.toBeInstanceOf(Response);
            expect(fetchMock).toHaveBeenCalledTimes(2);
        },
    );

    it("reports an exhausted network failure as 'Network error' on every platform", async () => {
        vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Load failed")));
        const p = makeClient().fetchWithAuth("https://example.test/x");
        const assertion = expect(p).rejects.toThrow(/^Network error: Load failed$/);
        await vi.advanceTimersByTimeAsync(60_000);
        await assertion;
    });

    it("aborts a request that never answers instead of hanging the sync", async () => {
        const fetchMock = vi.fn(
            (_url: string, init: RequestInit) =>
                new Promise<Response>((_, reject) => {
                    init.signal?.addEventListener("abort", () =>
                        reject(new DOMException("The operation was aborted.", "AbortError")),
                    );
                }),
        );
        vi.stubGlobal("fetch", fetchMock);
        const p = makeClient().fetchWithAuth("https://example.test/hang");
        const assertion = expect(p).rejects.toThrow(/timed out/);
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        await assertion;
        expect(fetchMock).toHaveBeenCalledTimes(4); // first try + 3 retries
    });

    it("aborts an answer whose body stops coming after the headers, then retries", async () => {
        const original = GoogleDriveHttpClient.transport;
        let calls = 0;
        GoogleDriveHttpClient.transport = (_url, init, options) => {
            calls++;
            if (calls > 1) return Promise.resolve(new Response("ok", { status: 200 }));
            return new Promise<Response>((_, reject) => {
                init.signal?.addEventListener("abort", () =>
                    reject(new DOMException("The operation was aborted.", "AbortError")),
                );
                options.onHeaders?.();
                // Some bytes keep coming for a while (each restarts the idle limit) ...
                for (let i = 1; i <= 3; i++) {
                    setTimeout(() => options.onProgress?.(), i * (GoogleDriveHttpClient.BODY_IDLE_MS - 1_000));
                }
                // ... then nothing more
            });
        };
        try {
            const p = makeClient().fetchWithAuth("https://example.test/stall");
            await vi.advanceTimersByTimeAsync(3 * GoogleDriveHttpClient.BODY_IDLE_MS);
            expect(calls).toBe(1); // still receiving: not cut off
            await vi.advanceTimersByTimeAsync(2 * GoogleDriveHttpClient.BODY_IDLE_MS);
            await expect(p).resolves.toBeInstanceOf(Response);
            expect(calls).toBe(2);
        } finally {
            GoogleDriveHttpClient.transport = original;
        }
    });

    it("gives uploads extra time in proportion to their size", () => {
        const base = GoogleDriveHttpClient.timeoutFor({});
        const tenMb = GoogleDriveHttpClient.timeoutFor({ body: new Uint8Array(10 * 1024 * 1024) });
        expect(base).toBe(GoogleDriveHttpClient.REQUEST_TIMEOUT_MS);
        expect(tenMb - base).toBe(Math.ceil(((10 * 1024 * 1024) / GoogleDriveHttpClient.MIN_UPLOAD_BYTES_PER_SEC) * 1000));
    });

    it("does not re-send a request when the caller handles network errors itself", async () => {
        const fetchMock = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
        vi.stubGlobal("fetch", fetchMock);
        await expect(
            makeClient().fetchWithAuth("https://example.test/x", {}, 0, { retryNetworkErrors: false }),
        ).rejects.toThrow(/Network error/);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
