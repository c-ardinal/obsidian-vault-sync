/**
 * A fetch()-shaped request over XMLHttpRequest.
 *
 * Drive transfers need what Obsidian's requestUrl lacks: aborting a request
 * (time limits) and reading non-2xx answers such as 308 Resume Incomplete as
 * normal responses. XMLHttpRequest has both, and gives the same CORS behavior
 * and errors as fetch(), so the callers keep working on a Response.
 */

/** Statuses whose Response must have no body */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

export interface XhrRequestOptions {
    /** Called once when the response headers have arrived (before the body) */
    onHeaders?: () => void;
    /** Called whenever more of the response body has arrived */
    onProgress?: () => void;
}

function parseHeaders(raw: string): Headers {
    const headers = new Headers();
    for (const line of raw.trim().split(/[\r\n]+/)) {
        const i = line.indexOf(":");
        if (i <= 0) continue;
        try {
            headers.append(line.slice(0, i).trim(), line.slice(i + 1).trim());
        } catch {
            // a header name the Headers class rejects: leave it out
        }
    }
    return headers;
}

function abortError(): DOMException {
    return new DOMException("The operation was aborted.", "AbortError");
}

export function xhrRequest(
    url: string,
    init: RequestInit = {},
    options: XhrRequestOptions = {},
): Promise<Response> {
    return new Promise<Response>((resolve, reject) => {
        const signal = init.signal;
        if (signal?.aborted) {
            reject(abortError());
            return;
        }
        const xhr = new XMLHttpRequest();
        xhr.open(init.method ?? "GET", url);
        xhr.responseType = "arraybuffer";
        new Headers(init.headers).forEach((value, name) => xhr.setRequestHeader(name, value));

        let headersSeen = false;
        const onAbort = () => xhr.abort();
        const done = () => signal?.removeEventListener("abort", onAbort);

        xhr.onreadystatechange = () => {
            if (!headersSeen && xhr.readyState >= XMLHttpRequest.HEADERS_RECEIVED && xhr.status !== 0) {
                headersSeen = true;
                options.onHeaders?.();
            }
        };
        xhr.onprogress = () => options.onProgress?.();
        xhr.onload = () => {
            done();
            const status = xhr.status;
            const body = NULL_BODY_STATUSES.has(status) ? null : (xhr.response as ArrayBuffer | null);
            resolve(
                new Response(body, {
                    status,
                    statusText: xhr.statusText,
                    headers: parseHeaders(xhr.getAllResponseHeaders()),
                }),
            );
        };
        // fetch() rejects with a TypeError on every network-level failure; so does this
        xhr.onerror = () => {
            done();
            reject(new TypeError("Network request failed"));
        };
        xhr.ontimeout = xhr.onerror;
        xhr.onabort = () => {
            done();
            reject(abortError());
        };
        signal?.addEventListener("abort", onAbort);
        xhr.send((init.body ?? null) as XMLHttpRequestBodyInit | null);
    });
}
