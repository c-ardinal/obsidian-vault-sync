/**
 * Cloud-independent error kinds. Adapters throw CloudError with one of these, and
 * the sync decides by kind only, never by a provider's status codes or wording.
 */
export type CloudErrorKind =
    /** The file or folder does not exist (or no longer does) */
    | "not-found"
    /** Name already taken, or the item changed since it was read (a failed precondition) */
    | "conflict"
    /** The provider asked to slow down, and retrying did not help in time */
    | "rate-limited"
    /** Signed out, or the sign-in can no longer be refreshed */
    | "auth-expired"
    /** The cloud storage is full */
    | "quota-exceeded"
    /** No connection to the provider (offline, DNS, timeout) */
    | "network"
    /** The provider failed (server error); a later attempt may succeed */
    | "transient"
    /** The request itself is not accepted; retrying will not help */
    | "permanent";

export class CloudError extends Error {
    constructor(
        message: string,
        readonly kind: CloudErrorKind,
        /** Provider status code, when the error came from an HTTP response */
        readonly status?: number,
    ) {
        super(message);
        this.name = "CloudError";
    }
}

/** Kind for an HTTP error response of a typical REST storage API. */
export function kindFromHttpStatus(status: number, message = ""): CloudErrorKind {
    if (status === 401) return "auth-expired";
    if (status === 404 || status === 410) return "not-found";
    if (status === 409 || status === 412) return "conflict";
    if (status === 429) return "rate-limited";
    if (status === 507) return "quota-exceeded";
    if (status === 403) {
        if (/quota|storage.*(full|exceeded)/i.test(message)) return "quota-exceeded";
        if (/rate ?limit/i.test(message)) return "rate-limited";
        return "permanent";
    }
    if (status >= 500) return "transient";
    return "permanent";
}

function isCloudError(e: unknown): e is { kind: CloudErrorKind } {
    return (
        !!e &&
        typeof e === "object" &&
        (e as { name?: unknown }).name === "CloudError" &&
        typeof (e as { kind?: unknown }).kind === "string"
    );
}

/**
 * Kind of any error a cloud call may throw. Errors that are not CloudError (thrown
 * by older code paths, wrappers or test doubles) are classified by their status
 * and wording as before, so every caller sees the same answer.
 */
export function cloudErrorKind(e: unknown): CloudErrorKind {
    if (isCloudError(e)) return e.kind;
    if (!e || typeof e !== "object") {
        return /network error|failed to fetch/i.test(String(e)) ? "network" : "permanent";
    }
    const err = e as { status?: unknown; message?: unknown };
    const msg = typeof err.message === "string" ? err.message : "";
    if (typeof err.status === "number") return kindFromHttpStatus(err.status, msg);
    if (/^Folder not found|File not found|API Error 404|API Error 410/.test(msg)) {
        return "not-found";
    }
    if (/not authenticated|authentication failed|token revoked/i.test(msg)) return "auth-expired";
    if (/network error|failed to fetch|unreachable/i.test(msg)) return "network";
    return "permanent";
}

/** True when the item is missing on the cloud. */
export function isCloudNotFound(e: unknown): boolean {
    return cloudErrorKind(e) === "not-found";
}
