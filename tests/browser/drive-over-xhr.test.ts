/**
 * @file The Drive adapter over XMLHttpRequest in real browser engines (Chromium, WebKit)
 *
 * The unit tests swap the transport for fetch() (Node has no XMLHttpRequest), so
 * the request path the plugin really uses was only checked against a fake XHR.
 * Here the shipped adapter, HTTP client and xhrRequest run in Chromium (desktop,
 * Android) and WebKit (the engine of iOS / iPadOS) and talk to
 * a local HTTP server on another origin, so the browser applies CORS the way it
 * does for googleapis.com from the Obsidian app. The server answers like Drive
 * (FakeDriveServer) and can break requests on purpose.
 *
 * @pass_criteria
 * - multipart upload / download / metadata / delete keep every byte (0x00-0xFF)
 * - resumable upload in several chunks: 308 is a normal answer, Location and
 *   Range are read across origins when the server exposes them
 * - without Access-Control-Expose-Headers the session URI cannot be read: the
 *   upload fails with a clear error instead of hanging (what to look for on Drive)
 * - a connection reset is a TypeError, retried, and the upload lands once
 * - a create whose answer is lost lands once (WebKit; Chromium: known issue)
 * - no answer before the time limit: aborted and reported as a time-out
 * - a chunk whose connection drops is resumed from the bytes Drive confirmed
 * - a body that stops after the headers and a few KB: aborted after BODY_IDLE_MS
 *   without a byte, and retried (before, the sync waited on it forever)
 *
 * Needs the browsers: npx playwright-core install --with-deps chromium webkit
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Browser, Page } from "playwright-core";
import { BROWSER_ENGINES, bundleForBrowser, launchEngine } from "./browsers";
import { FakeDriveServer } from "../helpers/fake-drive-server";

type Fault =
    | { kind: "reset"; match: RegExp; times: number }
    | { kind: "delay-headers"; match: RegExp; times: number; ms: number }
    | { kind: "stall-body"; match: RegExp; times: number }
    | { kind: "reset-after-body"; match: RegExp; times: number };

const CORS_ALLOW_HEADERS = [
    "Authorization",
    "Content-Type",
    "Content-Range",
    "X-Upload-Content-Type",
    "X-Upload-Content-Length",
].join(", ");

let drive: FakeDriveServer;
let exposeHeaders = true;
let fault: Fault | null = null;
const seen: string[] = [];
const sockets = new Set<import("node:net").Socket>();

function takeFault(key: string): Fault | null {
    if (!fault || !fault.match.test(key) || fault.times <= 0) return null;
    fault.times--;
    return fault;
}

async function readBody(req: http.IncomingMessage): Promise<Uint8Array> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return new Uint8Array(Buffer.concat(chunks));
}

const api = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
        if (!res.headersSent) res.writeHead(500, { "Access-Control-Allow-Origin": "*" });
        res.end(String(e));
    });
});

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const cors: Record<string, string> = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE",
        "Access-Control-Allow-Headers": CORS_ALLOW_HEADERS,
        ...(exposeHeaders ? { "Access-Control-Expose-Headers": "Location, Range" } : {}),
    };
    if (req.method === "OPTIONS") {
        res.writeHead(204, cors).end();
        return;
    }
    const m = /^\/__host\/([^/]+)(\/.*)$/.exec(req.url ?? "");
    if (!m) {
        res.writeHead(404, cors).end();
        return;
    }
    const url = `https://${m[1]}${m[2]}`;
    const key = `${req.method} ${m[2]}`;
    seen.push(key);
    const body = await readBody(req);
    const f = takeFault(key);
    if (f?.kind === "reset") {
        req.socket.destroy();
        return;
    }
    if (f?.kind === "delay-headers") await new Promise((r) => setTimeout(r, f.ms));
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    const answer = await drive.fetch(url, {
        method: req.method,
        headers,
        body: body.byteLength ? (body as unknown as BodyInit) : undefined,
    });
    if (f?.kind === "reset-after-body") {
        // Drive took the bytes, the answer is lost on the way back
        req.socket.destroy();
        return;
    }
    const out: Record<string, string> = { ...cors };
    answer.headers.forEach((v, k) => (out[k] = v));
    const bytes = new Uint8Array(await answer.arrayBuffer());
    if (f?.kind === "stall-body") {
        out["content-type"] = "application/octet-stream";
        out["content-length"] = String(bytes.byteLength);
        res.writeHead(answer.status, out);
        res.write(bytes.slice(0, 8 * 1024));
        return; // the rest never comes
    }
    res.writeHead(answer.status, out).end(bytes);
}
api.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
});

let pageServer: http.Server;
let pageUrl = "";
let apiOrigin = "";

async function listen(server: http.Server): Promise<number> {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return (server.address() as AddressInfo).port;
}

beforeAll(async () => {
    const script = await bundleForBrowser();
    pageServer = http.createServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/html" }).end(
            `<!doctype html><meta charset="utf-8"><script>${script.replace(/<\/script/g, "<\\/script")}</script>`,
        );
    });
    pageUrl = `http://127.0.0.1:${await listen(pageServer)}/`;
    // localhost vs 127.0.0.1: another origin, so every request is a CORS request
    apiOrigin = `http://localhost:${await listen(api)}`;
}, 60_000);

afterAll(async () => {
    for (const s of sockets) s.destroy();
    await new Promise((r) => api.close(r));
    await new Promise((r) => pageServer.close(r));
});

/** All 256 byte values, a few times over */
const BYTES = Array.from({ length: 1024 }, (_, i) => i % 256);

for (const engine of BROWSER_ENGINES) {
    describe(`Drive adapter over XMLHttpRequest in ${engine} (cross-origin)`, () => {
        let browser: Browser | null = null;
        let page: Page;
        let launchError = "";

        beforeAll(async () => {
            try {
                browser = await launchEngine(engine);
            } catch (e) {
                launchError = String(e);
                return;
            }
            page = await browser.newPage();
            await page.goto(pageUrl);
        }, 60_000);

        afterAll(async () => {
            await browser?.close();
        });

        beforeEach(async () => {
            if (!browser)
                throw new Error(`${engine} did not start (npx playwright-core install ${engine}): ${launchError}`);
            drive = new FakeDriveServer();
            exposeHeaders = true;
            fault = null;
            seen.length = 0;
            await page.evaluate((origin) => {
                const w = window as unknown as Record<string, unknown> & {
                    driveTest: any;
                };
                w.adapter = w.driveTest.makeAdapter(origin);
                const C = w.driveTest.GoogleDriveHttpClient;
                C.REQUEST_TIMEOUT_MS = 90_000;
            }, apiOrigin);
        });

        it("multipart upload, download, metadata and delete keep every byte", async () => {
            const r = await page.evaluate(async (bytes) => {
                const a = (window as any).adapter;
                const up = await a.uploadFile("notes/bin.dat", new Uint8Array(bytes).buffer, Date.UTC(2026, 0, 1));
                const down = new Uint8Array(await a.downloadFile(up.id));
                const meta = await a.getFileMetadata("notes/bin.dat");
                await a.deleteFile(up.id);
                const after = await a.getFileMetadata("notes/bin.dat");
                return {
                    path: up.path,
                    same: down.length === bytes.length && down.every((b, i) => b === bytes[i]),
                    metaId: meta?.id === up.id,
                    after,
                };
            }, BYTES);
            expect(r).toEqual({
                path: "notes/bin.dat",
                same: true,
                metaId: true,
                after: null,
            });
        });

        it("resumable upload in several chunks: 308 is a normal answer, Location and Range are readable", async () => {
            const r = await page.evaluate(async () => {
                const w = window as any;
                const a = w.adapter;
                const size = 600_000;
                const data = new Uint8Array(size).map((_, i) => (i * 31) % 256);
                const session = await a.initiateResumableSession("big/file.bin", size, Date.UTC(2026, 0, 1));
                const first = await a.uploadChunk(session, data.slice(0, 262_144).buffer, 0, size, "big/file.bin", 0);
                const status = await a.queryResumableStatus(session, size, "big/file.bin", 0);
                const second = await a.uploadChunk(
                    session,
                    data.slice(262_144).buffer,
                    262_144,
                    size,
                    "big/file.bin",
                    0,
                );
                const down = new Uint8Array(await a.downloadFile(second.id));
                return {
                    first,
                    received: status.received,
                    size: second.size,
                    same: down.length === size && down.every((b: number, i: number) => b === data[i]),
                };
            });
            expect(r).toEqual({
                first: null,
                received: 262_144,
                size: 600_000,
                same: true,
            });
            expect(seen.filter((s) => s.startsWith("PUT")).length).toBe(3);
        });

        it("without exposed headers the session URI cannot be read: a clear error, not a hang", async () => {
            exposeHeaders = false;
            const r = await page.evaluate(async () => {
                const a = (window as any).adapter;
                try {
                    await a.initiateResumableSession("big/x.bin", 10, 0);
                    return "no error";
                } catch (e) {
                    return String((e as Error).message);
                }
            });
            expect(r).toMatch(/no session URI/);
        });

        it("a connection reset is a network error: retried, and the file lands once", async () => {
            fault = {
                kind: "reset",
                match: /^POST \/upload\/drive\/v3\/files/,
                times: 1,
            };
            const r = await page.evaluate(async () => {
                const a = (window as any).adapter;
                const up = await a.uploadFile("notes/a.md", new TextEncoder().encode("hello").buffer, 0);
                const list = await a.listFiles();
                return {
                    id: !!up.id,
                    copies: list.filter((f: any) => f.path === "notes/a.md").length,
                };
            });
            expect(r).toEqual({ id: true, copies: 1 });
            expect(seen.filter((s) => s.startsWith("POST /upload/drive/v3/files")).length).toBe(2);
        });

        // Known issue in Chromium (desktop, Android): when a reused connection drops
        // after Drive took a create, Chromium sends the same request again on its own
        // and the page sees only the second answer, so the marker look-up never runs
        // and Drive ends with two copies. WebKit reports the error; the look-up finds
        // the first copy.
        (engine === "chromium" ? it.fails : it)(
            "a create whose answer is lost lands once (found again by its marker)",
            async () => {
                fault = { kind: "reset-after-body", match: /^POST \/upload\/drive\/v3\/files/, times: 1 };
                const r = await page.evaluate(async () => {
                    const a = (window as any).adapter;
                    const up = await a.uploadFile("notes/lost.md", new TextEncoder().encode("hello").buffer, 0);
                    const list = await a.listFiles();
                    return { id: !!up.id, copies: list.filter((f: any) => f.path === "notes/lost.md").length };
                });
                expect(r).toEqual({ id: true, copies: 1 });
            },
            30_000,
        );

        it("no answer before the time limit: aborted and reported as a time-out", async () => {
            fault = {
                kind: "delay-headers",
                match: /^GET \/drive\/v3\/files\/[^/?]+$/,
                times: 1,
                ms: 3_000,
            };
            const r = await page.evaluate(async () => {
                const w = window as any;
                const C = w.driveTest.GoogleDriveHttpClient;
                C.REQUEST_TIMEOUT_MS = 300;
                const started = Date.now();
                try {
                    await w.adapter.http.fetchWithAuth("https://www.googleapis.com/drive/v3/files/nope", {}, 0, {
                        retryNetworkErrors: false,
                    });
                    return { error: "none", ms: Date.now() - started };
                } catch (e) {
                    return {
                        error: `${(e as Error).name}: ${(e as Error).message}`,
                        ms: Date.now() - started,
                    };
                }
            });
            expect(r.error).toMatch(/timed out/);
            expect(r.ms).toBeLessThan(2_500);
        });

        it("a chunk whose answer is lost is resumed from the bytes Drive confirmed", async () => {
            fault = {
                kind: "reset-after-body",
                match: /^PUT \/upload-session\//,
                times: 1,
            };
            const r = await page.evaluate(async () => {
                try {
                    const a = (window as any).adapter;
                    a.constructor.RESUMABLE_CHUNK_BYTES = 262_144;
                    const size = 600_000;
                    const data = new Uint8Array(size).map((_, i) => (i * 7) % 256);
                    const up = await a.uploadFileResumable("big/resume.bin", data.buffer, 0);
                    const down = new Uint8Array(await a.downloadFile(up.id));
                    return {
                        size: up.size,
                        same: down.length === size && down.every((b: number, i: number) => b === data[i]),
                    };
                } catch (e) {
                    return { error: String(e) };
                }
            });
            expect(r).toEqual({ size: 600_000, same: true });
        }, 30_000);

        it("a body that stops after the headers and a few KB: aborted after BODY_IDLE_MS, then retried", async () => {
            // Chromium hands the headers to the page only with the first bytes of the body,
            // so the stall comes after 8 KB here: then the header time limit is already over.
            const id = await page.evaluate(async () => {
                const a = (window as any).adapter;
                const data = new Uint8Array(64 * 1024).map((_, i) => i % 251);
                return (await a.uploadFile("notes/s.bin", data.buffer, 0)).id;
            });
            fault = { kind: "stall-body", match: /alt=media/, times: 1 };
            const r = await page.evaluate(async (fileId) => {
                const w = window as any;
                w.driveTest.GoogleDriveHttpClient.BODY_IDLE_MS = 400;
                const started = Date.now();
                const outcome = await Promise.race([
                    w.adapter.downloadFile(fileId).then(
                        (b: ArrayBuffer) => `finished ${b.byteLength}`,
                        (e: Error) => `error: ${e.message}`,
                    ),
                    new Promise((res) => setTimeout(() => res("still waiting after 8 s"), 8_000)),
                ]);
                w.driveTest.GoogleDriveHttpClient.BODY_IDLE_MS = 60_000;
                return { outcome, ms: Date.now() - started };
            }, id);
            expect(r.outcome).toBe(`finished ${64 * 1024}`);
            expect(seen.filter((x) => x.includes("alt=media")).length).toBe(2);
        }, 20_000);
    });
}
