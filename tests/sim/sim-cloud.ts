import type { CloudAdapter } from "../../src/types/adapter";
import { MockCloudAdapter } from "../helpers/mock-cloud-adapter";
import type { Rng } from "./rng";

/** Methods that represent a network round-trip (latency + faults apply) */
const NETWORK_METHODS = new Set([
    "initialize",
    "getFileMetadata",
    "getFileMetadataById",
    "downloadFile",
    "uploadFile",
    "deleteFile",
    "moveFile",
    "createFolder",
    "ensureFoldersExist",
    "fileExistsById",
    "initiateResumableSession",
    "uploadChunk",
    "getStartPageToken",
    "getChanges",
    "listFiles",
    "getAppRootId",
    "getFolderIdByName",
    "listRevisions",
    "getRevisionContent",
    "setRevisionKeepForever",
    "deleteRevision",
]);

/** Calls that change remote state (used to detect sync ping-pong) */
export const MUTATING_METHODS = new Set([
    "uploadFile",
    "deleteFile",
    "moveFile",
    "uploadChunk",
]);

export interface NetworkProfile {
    /** One-way latency range in virtual ms (applied before and after the server op) */
    minLatencyMs: number;
    maxLatencyMs: number;
    /** Probability that a call fails with a transient network error */
    failureRate: number;
    /**
     * Probability that a failing call fails AFTER the server applied it
     * (response lost) instead of before. This is the nasty case: the device
     * thinks the upload failed but the cloud already has the new content.
     */
    lostResponseRate: number;
}

export const PERFECT_NETWORK: NetworkProfile = {
    minLatencyMs: 0,
    maxLatencyMs: 0,
    failureRate: 0,
    lostResponseRate: 0,
};

export interface CallRecord {
    t: number;
    device: string;
    method: string;
    arg: string;
    outcome: "ok" | "fail-before" | "fail-after" | "offline";
}

export class SimNetworkError extends Error {
    constructor(method: string, phase: string) {
        super(`Network error (simulated ${phase}) in ${method}`);
        this.name = "SimNetworkError";
    }
}

/**
 * The single shared "Google Drive" all simulated devices talk to,
 * plus a per-device view that injects latency / faults and records calls.
 */
export class SimCloud {
    readonly store = new MockCloudAdapter();
    readonly calls: CallRecord[] = [];
    /** Optional sink so callers can stream records (e.g. into a timeline) */
    onCall: ((rec: CallRecord) => void) | null = null;

    constructor() {
        // Like Google Drive: one entry per file with its current state (see MockCloudAdapter)
        this.store.changesLatestStateOnly = true;
    }

    createDeviceView(
        device: string,
        rng: Rng,
        getProfile: () => NetworkProfile,
        isOnline: () => boolean,
    ): CloudAdapter {
        const store = this.store;
        const calls = this.calls;
        const sim = this;
        let deviceLogger: (msg: string, level?: string) => void = () => {};

        const sleep = (ms: number) =>
            ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve();

        const record = (method: string, args: unknown[], outcome: CallRecord["outcome"]) => {
            const rec: CallRecord = {
                t: Date.now(),
                device,
                method,
                arg: describeArg(args),
                outcome,
            };
            calls.push(rec);
            sim.onCall?.(rec);
        };

        const handler: ProxyHandler<MockCloudAdapter> = {
            get(target, prop, receiver) {
                if (prop === "setLogger") {
                    return (logger: (msg: string, level?: string) => void) => {
                        deviceLogger = logger;
                    };
                }
                if (prop === "cloneWithNewVaultName") {
                    return () => proxy;
                }
                const value = Reflect.get(target, prop, receiver);
                if (typeof value !== "function" || typeof prop !== "string") return value;
                if (!NETWORK_METHODS.has(prop)) return value.bind(target);

                return async (...args: unknown[]) => {
                    const profile = getProfile();
                    const latency = () => rng.int(profile.minLatencyMs, profile.maxLatencyMs);

                    if (!isOnline()) {
                        record(prop, args, "offline");
                        await sleep(latency());
                        throw new SimNetworkError(prop, "offline");
                    }

                    const fails = rng.chance(profile.failureRate);
                    const failAfter = fails && rng.chance(profile.lostResponseRate);

                    await sleep(latency());
                    if (fails && !failAfter) {
                        record(prop, args, "fail-before");
                        throw new SimNetworkError(prop, "request lost");
                    }
                    // The server applies the operation atomically at this instant.
                    const result = await (value as (...a: unknown[]) => unknown).apply(
                        target,
                        args,
                    );
                    record(prop, args, failAfter ? "fail-after" : "ok");
                    await sleep(latency());
                    if (failAfter) {
                        deviceLogger(`[Sim] response lost for ${prop}`, "debug");
                        throw new SimNetworkError(prop, "response lost");
                    }
                    return result;
                };
            },
        };
        const proxy = new Proxy(store, handler) as unknown as CloudAdapter;
        return proxy;
    }

    /** Snapshot of user-visible files on the cloud (excludes plugin internals) */
    async snapshot(
        isInternal: (path: string) => boolean,
        decode?: (bytes: ArrayBuffer) => Promise<ArrayBuffer>,
    ): Promise<Record<string, string>> {
        const out: Record<string, string> = {};
        for (const f of await this.store.listFiles()) {
            if (isInternal(f.path)) continue;
            if (decode) {
                const raw = this.store.getCloudBytes(f.path);
                const plain = raw ? await decode(raw.slice().buffer) : new ArrayBuffer(0);
                out[f.path] = new TextDecoder().decode(plain);
            } else {
                out[f.path] = this.store.getCloudContent(f.path) ?? "";
            }
        }
        return out;
    }
}

function describeArg(args: unknown[]): string {
    const first = args[0];
    if (typeof first === "string") return first;
    if (first == null) return "";
    return String(first).slice(0, 60);
}
