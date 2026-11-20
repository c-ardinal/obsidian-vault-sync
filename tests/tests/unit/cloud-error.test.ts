import { describe, it, expect } from "vitest";
import {
    CloudError,
    cloudErrorKind,
    isCloudNotFound,
    kindFromHttpStatus,
} from "../../../src/cloud-adapters/cloud-error";

describe("kindFromHttpStatus", () => {
    it.each([
        [401, "", "auth-expired"],
        [404, "", "not-found"],
        [410, "", "not-found"],
        [409, "", "conflict"],
        [412, "", "conflict"],
        [429, "", "rate-limited"],
        [507, "", "quota-exceeded"],
        [403, "The user's Drive storage quota has been exceeded.", "quota-exceeded"],
        [403, "User Rate Limit Exceeded", "rate-limited"],
        [403, "The user does not have sufficient permissions", "permanent"],
        [500, "", "transient"],
        [503, "", "transient"],
        [400, "", "permanent"],
    ])("%i %s -> %s", (status, msg, kind) => {
        expect(kindFromHttpStatus(status, msg)).toBe(kind);
    });
});

describe("cloudErrorKind", () => {
    it("uses the kind of a CloudError", () => {
        expect(cloudErrorKind(new CloudError("x", "conflict", 409))).toBe("conflict");
        expect(cloudErrorKind(new CloudError("API Error 404", "transient"))).toBe("transient");
    });

    it("classifies plain errors with a status by the status", () => {
        const e = Object.assign(new Error("gone"), { status: 404 });
        expect(cloudErrorKind(e)).toBe("not-found");
    });

    it("classifies plain errors by their wording as before", () => {
        expect(cloudErrorKind(new Error("Folder not found: a/b"))).toBe("not-found");
        expect(cloudErrorKind(new Error("File not found: abc"))).toBe("not-found");
        expect(cloudErrorKind(new Error("API Error 404"))).toBe("not-found");
        expect(cloudErrorKind(new Error("Not authenticated"))).toBe("auth-expired");
        expect(cloudErrorKind(new TypeError("Network error: offline"))).toBe("network");
        expect(cloudErrorKind(new TypeError("Failed to fetch"))).toBe("network");
        expect(cloudErrorKind(new Error("something else"))).toBe("permanent");
        expect(cloudErrorKind("network error")).toBe("network");
        expect(cloudErrorKind(null)).toBe("permanent");
    });

    it("isCloudNotFound matches not-found only", () => {
        expect(isCloudNotFound(new CloudError("x", "not-found"))).toBe(true);
        expect(isCloudNotFound(new CloudError("x", "rate-limited", 429))).toBe(false);
        expect(isCloudNotFound(Object.assign(new Error("x"), { status: 500 }))).toBe(false);
    });

    it("keeps message and status for callers that read them", () => {
        const e = new CloudError("API Error 404", "not-found", 404);
        expect(e).toBeInstanceOf(Error);
        expect(e.message).toBe("API Error 404");
        expect(e.status).toBe(404);
        expect(e.name).toBe("CloudError");
    });
});
