/**
 * @file xhrRequest: the fetch()-shaped request over XMLHttpRequest used for Drive
 *
 * @pass_criteria
 * - method, headers and body reach XMLHttpRequest; the answer becomes a Response
 * - non-2xx answers (308 Resume Incomplete) resolve with their status and headers
 * - a network failure rejects with a TypeError, like fetch()
 * - an abort signal (before or during the request) rejects with an AbortError
 * - onHeaders runs once when the headers arrive, before the body
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { xhrRequest } from "../../../src/cloud-adapters/google-drive/xhr-request";

class FakeXhr {
    static HEADERS_RECEIVED = 2;
    static last: FakeXhr | null = null;
    method = "";
    url = "";
    responseType = "";
    readyState = 0;
    status = 0;
    statusText = "";
    response: ArrayBuffer | null = null;
    headers: Record<string, string> = {};
    sent: unknown = undefined;
    aborted = false;
    rawHeaders = "";
    onreadystatechange: (() => void) | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    ontimeout: (() => void) | null = null;
    onabort: (() => void) | null = null;
    constructor() {
        FakeXhr.last = this;
    }
    open(method: string, url: string) {
        this.method = method;
        this.url = url;
        this.readyState = 1;
    }
    setRequestHeader(name: string, value: string) {
        this.headers[name] = value;
    }
    send(body: unknown) {
        this.sent = body;
    }
    getAllResponseHeaders() {
        return this.rawHeaders;
    }
    abort() {
        this.aborted = true;
        this.onabort?.();
    }
    // --- test side ---
    answer(status: number, body: string | null, rawHeaders = "", onBeforeBody?: () => void) {
        this.status = status;
        this.statusText = "x";
        this.rawHeaders = rawHeaders;
        this.readyState = 2;
        this.onreadystatechange?.();
        onBeforeBody?.();
        this.readyState = 4;
        this.onreadystatechange?.();
        this.response = body === null ? null : (new TextEncoder().encode(body).buffer as ArrayBuffer);
        this.onload?.();
    }
    fail() {
        this.readyState = 4;
        this.onreadystatechange?.();
        this.onerror?.();
    }
}

beforeEach(() => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
});
afterEach(() => {
    vi.unstubAllGlobals();
    FakeXhr.last = null;
});

describe("xhrRequest", () => {
    it("sends method, headers and body, and resolves with a Response", async () => {
        const body = new Uint8Array([1, 2, 3]);
        const p = xhrRequest("https://example.test/upload", {
            method: "PUT",
            headers: { Authorization: "Bearer t", "Content-Type": "application/octet-stream" },
            body,
        });
        const x = FakeXhr.last!;
        expect(x.method).toBe("PUT");
        expect(x.url).toBe("https://example.test/upload");
        expect(x.responseType).toBe("arraybuffer");
        expect(x.headers).toEqual({ authorization: "Bearer t", "content-type": "application/octet-stream" });
        expect(x.sent).toBe(body);
        x.answer(200, '{"id":"f1"}', "content-type: application/json\r\nx-a: 1\r\n");
        const res = await p;
        expect(res.ok).toBe(true);
        expect(res.headers.get("x-a")).toBe("1");
        expect(await res.json()).toEqual({ id: "f1" });
    });

    it("defaults to GET with no body", async () => {
        const p = xhrRequest("https://example.test/a");
        const x = FakeXhr.last!;
        expect(x.method).toBe("GET");
        expect(x.sent).toBeNull();
        x.answer(200, "ok");
        expect(await (await p).text()).toBe("ok");
    });

    it("resolves a 308 Resume Incomplete with its Range header", async () => {
        const p = xhrRequest("https://example.test/s", { method: "PUT" });
        FakeXhr.last!.answer(308, "", "range: bytes=0-99\r\n");
        const res = await p;
        expect(res.status).toBe(308);
        expect(res.ok).toBe(false);
        expect(res.headers.get("Range")).toBe("bytes=0-99");
    });

    it("gives no body for a 204", async () => {
        const p = xhrRequest("https://example.test/d", { method: "DELETE" });
        FakeXhr.last!.answer(204, null);
        const res = await p;
        expect(res.status).toBe(204);
        expect(await res.text()).toBe("");
    });

    it("rejects a network failure with a TypeError, like fetch()", async () => {
        const p = xhrRequest("https://example.test/a");
        FakeXhr.last!.fail();
        await expect(p).rejects.toBeInstanceOf(TypeError);
    });

    it("aborts the request when the signal fires", async () => {
        const c = new AbortController();
        const p = xhrRequest("https://example.test/a", { signal: c.signal });
        c.abort();
        await expect(p).rejects.toMatchObject({ name: "AbortError" });
        expect(FakeXhr.last!.aborted).toBe(true);
    });

    it("does not start when the signal has already fired", async () => {
        const c = new AbortController();
        c.abort();
        await expect(xhrRequest("https://example.test/a", { signal: c.signal })).rejects.toMatchObject({
            name: "AbortError",
        });
        expect(FakeXhr.last).toBeNull();
    });

    it("calls onHeaders once, before the body arrives", async () => {
        const onHeaders = vi.fn();
        const p = xhrRequest("https://example.test/a", {}, { onHeaders });
        let calledBeforeBody = false;
        FakeXhr.last!.answer(200, "x", "", () => (calledBeforeBody = onHeaders.mock.calls.length === 1));
        await p;
        expect(calledBeforeBody).toBe(true);
        expect(onHeaders).toHaveBeenCalledTimes(1);
    });
});
