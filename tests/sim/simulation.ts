/**
 * Multi-device sync simulation.
 *
 * Runs N devices, each with the REAL SyncManager and its own in-memory vault,
 * against one shared mock cloud. A seeded random plan of user operations and
 * sync triggers is executed on a virtual clock (vitest fake timers), with
 * network latency / transient failures / offline periods / delayed vault
 * events injected. Afterwards the network is healed and every device syncs
 * until quiet, and invariants are checked:
 *
 *   - HANG          a sync never settles (deadlock or livelock)
 *   - NO_CONVERGE   devices keep changing things after many rounds (ping-pong)
 *   - DIVERGED      devices / cloud end up with different files
 *   - NOT_IDLE      an idle sync still uploads, or leaves dirty / pending state
 *   - SLOW_IDLE     an idle sync makes more API calls than the budget
 *   - SYNC_ERROR    a sync throws although the network is healthy
 *   - FALSE_CONFLICT a conflict copy was created for non-overlapping edits
 *   - LOST_UPDATE   a user's edit disappeared
 *   - DUPLICATE     one logical note ended up in several files
 *   - DATA_LOSS     a note that nobody deleted is gone everywhere
 *
 * Every run is fully determined by (config, seed). On failure a JSON report
 * and a human-readable timeline are written to SIM_REPORT_DIR.
 */
import { vi } from "vitest";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import type { SyncManagerSettings } from "../../src/sync-manager";
import { Rng } from "./rng";
import { SimCloud, MUTATING_METHODS, PERFECT_NETWORK, type NetworkProfile } from "./sim-cloud";
import { SimDevice, isInternalPath } from "./sim-device";
import type { FsPersonality } from "./sim-vault";

// ───────────────────────── Config ─────────────────────────

export type Profile =
    /** Devices only edit their own line of each note and only rename their own notes.
     *  A correct engine must merge everything without conflicts or lost edits. */
    | "disjoint"
    /** Anything goes: same-line edits, deletes, renames, path collisions. Only
     *  termination / convergence / no-silent-data-loss are checked. */
    | "chaos";

export interface SimConfig {
    name: string;
    seed: number;
    profile: Profile;
    devices: number;
    actions: number;
    /** Mean virtual ms between plan actions */
    meanGapMs: number;
    network: NetworkProfile;
    /** Probability that an action toggles a device offline/online */
    offlineRate: number;
    maxEventDelayMs: number;
    maxClockSkewMs: number;
    /** Max API calls an idle (nothing changed) sync may make per device */
    idleCallBudget: number;
    maxQuiesceRounds: number;
    /** File-system flavour per device (cycled). Default: all linux */
    fs?: FsPersonality[];
    /** Devices with "windows" fs write CRLF + BOM text, like many Windows editors */
    windowsLineEndings?: boolean;
    /** Fraction of created files that are binary (png-like bytes, never mergeable) */
    binaryRate?: number;
    settings?: Partial<SyncManagerSettings>;
}

export const DEFAULT_CONFIG: Omit<SimConfig, "name" | "seed"> = {
    profile: "disjoint",
    devices: 3,
    actions: 40,
    meanGapMs: 1500,
    network: { minLatencyMs: 5, maxLatencyMs: 400, failureRate: 0, lostResponseRate: 0 },
    offlineRate: 0,
    maxEventDelayMs: 300,
    maxClockSkewMs: 0,
    idleCallBudget: 12,
    maxQuiesceRounds: 5,
};

// ───────────────────────── Plan ─────────────────────────

export type Action =
    | { t: number; dev: string; kind: "join" }
    | { t: number; dev: string; kind: "create"; fid: string; path: string; binary?: boolean }
    | { t: number; dev: string; kind: "editBinary"; pick: number; version: number }
    | { t: number; dev: string; kind: "edit"; pick: number; line: string; value: string }
    | { t: number; dev: string; kind: "delete"; pick: number }
    | { t: number; dev: string; kind: "rename"; pick: number; to: string }
    | { t: number; dev: string; kind: "sync"; scan: boolean }
    | { t: number; dev: string; kind: "offline" | "online" };

const EPOCH = Date.UTC(2026, 0, 1, 0, 0, 0);

export function deviceNames(n: number): string[] {
    return Array.from({ length: n }, (_, i) => String.fromCharCode(65 + i));
}

export function generatePlan(cfg: SimConfig): Action[] {
    const rng = new Rng(cfg.seed).fork(1);
    const devs = deviceNames(cfg.devices);
    const plan: Action[] = [];
    const joinAt: Record<string, number> = {};
    const horizon = cfg.actions * cfg.meanGapMs;

    devs.forEach((d, i) => {
        joinAt[d] = i === 0 ? 0 : rng.int(0, Math.floor(horizon * 0.3));
        plan.push({ t: joinAt[d], dev: d, kind: "join" });
    });

    let t = 1;
    let fileNo = 0;
    const createdBy: Record<string, number> = {};
    const offline = new Set<string>();

    for (let i = 0; i < cfg.actions; i++) {
        t += rng.int(1, cfg.meanGapMs * 2);
        const ready = devs.filter((d) => joinAt[d] < t);
        const dev = rng.pick(ready);

        if (cfg.offlineRate > 0 && rng.chance(cfg.offlineRate)) {
            const wasOffline = offline.has(dev);
            wasOffline ? offline.delete(dev) : offline.add(dev);
            plan.push({ t, dev, kind: wasOffline ? "online" : "offline" });
            continue;
        }

        const kind = rng.weighted<string>(
            cfg.profile === "disjoint"
                ? { create: 3, edit: 9, rename: 1, sync: 7, editBinary: cfg.binaryRate ? 2 : 0 }
                : { create: 3, edit: 8, rename: 2, delete: 2, sync: 7, editBinary: cfg.binaryRate ? 2 : 0 },
        );

        switch (kind) {
            case "create": {
                const fid = `f${++fileNo}`;
                const n = (createdBy[dev] = (createdBy[dev] ?? 0) + 1);
                let path: string;
                if (cfg.binaryRate && rng.chance(cfg.binaryRate)) {
                    path =
                        cfg.profile === "disjoint"
                            ? `assets/${dev}-${n}.png`
                            : `assets/${rng.pick(["image", "Image", "photo"])}.png`;
                    plan.push({ t, dev, kind: "create", fid, path, binary: true });
                    break;
                }
                if (cfg.profile === "disjoint") {
                    path = rng.chance(0.3) ? `notes/sub/${dev}-${n}.md` : `notes/${dev}-${n}.md`;
                } else {
                    // Small shared namespace so devices collide on paths, including names
                    // that only differ by case or Unicode normalization (NFC vs NFD).
                    path = `${rng.pick(["", "inbox/", "projects/", "Projects/"])}${rng.pick([
                        "todo",
                        "Todo",
                        "idea",
                        "log",
                        "caf\u00e9",
                        "cafe\u0301",
                    ])}.md`;
                }
                plan.push({ t, dev, kind: "create", fid, path });
                break;
            }
            case "edit": {
                const line =
                    cfg.profile === "disjoint" ? dev : rng.chance(0.5) ? rng.pick(devs) : "+";
                plan.push({ t, dev, kind: "edit", pick: rng.next(), line, value: `${dev}${i}` });
                break;
            }
            case "delete":
                plan.push({ t, dev, kind: "delete", pick: rng.next() });
                break;
            case "editBinary":
                plan.push({ t, dev, kind: "editBinary", pick: rng.next(), version: i });
                break;
            case "rename": {
                const to =
                    cfg.profile === "disjoint"
                        ? `${rng.pick(["notes", "archive", "notes/sub"])}/${dev}-r${i}.md`
                        : `${rng.pick(["", "archive/", "inbox/"])}${rng.pick(["todo", "renamed", "idea"])}.md`;
                plan.push({ t, dev, kind: "rename", pick: rng.next(), to });
                break;
            }
            case "sync":
                plan.push({ t, dev, kind: "sync", scan: rng.chance(0.15) });
                break;
        }
    }
    // Everyone comes back online before the end of the chaotic phase
    for (const d of offline) plan.push({ t: t + 1, dev: d, kind: "online" });
    return plan.sort((a, b) => a.t - b.t);
}

// ───────────────────────── Note content model ─────────────────────────

function initialContent(fid: string, devs: string[], windowsStyle: boolean): string {
    const lines = [`# id:${fid}`, ""];
    for (const d of devs) {
        lines.push(`<!-- section ${d} -->`, `${d}: init`, "");
    }
    return windowsStyle ? "\uFEFF" + lines.join("\r\n") : lines.join("\n");
}

/** Binary payload: PNG signature (contains CR/LF/0x1A), a version marker, then noisy bytes incl. NUL */
function binaryContent(fid: string, version: number, seed: number): ArrayBuffer {
    const rng = new Rng(seed * 7919 + version);
    const head = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    const marker = Array.from(new TextEncoder().encode(`BINID:${fid}:v${version};`));
    const noise = Array.from({ length: 96 }, () => rng.int(0, 255));
    return new Uint8Array([...head, ...marker, 0x00, 0xff, 0x0d, 0x0a, ...noise]).buffer;
}

function binaryMarker(content: string): { fid: string; version: string } | null {
    const m = /BINID:(f\d+):v(\d+);/.exec(content);
    return m ? { fid: m[1], version: m[2] } : null;
}

function setLine(content: string, label: string, value: string): string {
    if (label === "+") return content + `\n+ ${value}`;
    const re = new RegExp(`^${label}: .*$`, "m");
    if (re.test(content)) return content.replace(re, `${label}: ${value}`);
    return content + `\n${label}: ${value}`;
}

function fidOf(content: string): string | null {
    const m = /^\uFEFF?# id:(\S+)/m.exec(content);
    return m ? m[1] : null;
}

/** All note ids in a file (a merge of two colliding notes may contain several) */
function fidsOf(content: string): string[] {
    return [...content.matchAll(/^\uFEFF?# id:(\S+)/gm)].map((m) => m[1]);
}

const CONFLICT_RE = /\(Conflict [^)]*\)/;

// ───────────────────────── Result ─────────────────────────

export interface Failure {
    kind: string;
    message: string;
}

export interface SimResult {
    config: SimConfig;
    ok: boolean;
    failures: Failure[];
    plan: Action[];
    stats: Record<string, unknown>;
    timeline: string[];
    reportPath?: string;
}

// ───────────────────────── Clock driver ─────────────────────────

const DEADLOCK_REAL_MS = 3000;
const realTick = () => new Promise<void>((r) => setImmediate(r));

/**
 * Run the virtual clock until `p` settles. Returns "deadlock" if nothing is
 * scheduled any more but the promise is still pending, "timeout" if virtual
 * time exceeded `capMs` (livelock / endless retries).
 */
export async function drive(p: Promise<unknown>, capMs: number): Promise<"ok" | "deadlock" | "timeout"> {
    let done = false;
    p.then(
        () => (done = true),
        () => (done = true),
    );
    const start = Date.now();
    // Native async work (e.g. CompressionStream) completes in REAL time, so a
    // deadlock is only declared after no virtual timers exist for a while.
    let idleSince: number | null = null;
    while (!done) {
        await realTick();
        if (done) break;
        if (vi.getTimerCount() === 0) {
            idleSince ??= performance.now();
            if (performance.now() - idleSince > DEADLOCK_REAL_MS) return "deadlock";
            await new Promise((r) => setImmediate(r));
            continue;
        }
        idleSince = null;
        await vi.advanceTimersToNextTimerAsync();
        if (Date.now() - start > capMs) return "timeout";
    }
    return "ok";
}

export async function advance(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
    await realTick();
}

// ───────────────────────── Runner ─────────────────────────

export async function runSimulation(cfg: SimConfig, planOverride?: Action[]): Promise<SimResult> {
    const plan = planOverride ?? generatePlan(cfg);
    const failures: Failure[] = [];
    const timeline: string[] = [];
    const fail = (kind: string, message: string) => {
        failures.push({ kind, message });
        log("SIM", `FAIL ${kind}: ${message}`);
    };
    const log = (dev: string, msg: string) => {
        timeline.push(`${String(Date.now() - EPOCH).padStart(8)}ms [${dev}] ${msg}`);
    };

    vi.useFakeTimers({
        toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
        now: EPOCH,
    });
    const engineRng = new Rng(cfg.seed).fork(2);
    const randomSpy = vi.spyOn(Math, "random").mockImplementation(() => engineRng.next());

    const cloud = new SimCloud();
    cloud.onCall = (c) => {
        if (c.outcome !== "ok" || MUTATING_METHODS.has(c.method)) {
            log(c.device, `CLOUD ${c.method}(${c.arg}) ${c.outcome}`);
        }
    };
    let network: NetworkProfile = cfg.network;
    const devNames = deviceNames(cfg.devices);
    const worldRng = new Rng(cfg.seed).fork(3);

    const devices = new Map<string, SimDevice>();
    for (const name of devNames) {
        const skew =
            cfg.maxClockSkewMs > 0 ? worldRng.int(-cfg.maxClockSkewMs, cfg.maxClockSkewMs) : 0;
        const devRng = worldRng.fork(name.charCodeAt(0));
        const dev: SimDevice = new SimDevice({
            name,
            rng: devRng,
            maxEventDelayMs: cfg.maxEventDelayMs,
            clockSkewMs: skew,
            fs: cfg.fs?.length ? cfg.fs[devNames.indexOf(name) % cfg.fs.length] : "linux",
            settings: cfg.settings,
            log,
            cloudView: (d) =>
                cloud.createDeviceView(
                    name,
                    devRng.fork(7),
                    () => network,
                    () => d.online,
                ),
        });
        devices.set(name, dev);
    }

    // Oracle state
    const expected: Record<string, Record<string, string>> = {}; // fid -> dev -> value
    const expectedBinary: Record<string, string> = {}; // fid -> last version written
    const deletedFids = new Set<string>();
    const createdFids = new Set<string>();
    const opStats = { applied: 0, skipped: 0 };

    const candidates = (dev: SimDevice, filter: (p: string, c: string) => boolean) =>
        Object.entries(dev.userFiles())
            .filter(([p, c]) => !CONFLICT_RE.test(p) && filter(p, c))
            .map(([p]) => p);

    const exec = async (a: Action): Promise<void> => {
        const dev = devices.get(a.dev)!;
        if (a.kind !== "join" && !dev.joined) return;
        let applied = true;
        switch (a.kind) {
            case "join":
                await dev.init();
                dev.joined = true;
                log(a.dev, "JOIN");
                dev.startSync("initial-sync", true);
                return;
            case "offline":
                dev.online = false;
                log(a.dev, "OFFLINE");
                return;
            case "online":
                dev.online = true;
                log(a.dev, "ONLINE");
                return;
            case "sync":
                log(a.dev, `SYNC requested${a.scan ? " (scan)" : ""}`);
                dev.startSync(a.scan ? "startup-sync" : "timer-sync", a.scan);
                return;
            case "create":
                applied = await dev.userCreate(
                    a.path,
                    a.binary
                        ? binaryContent(a.fid, 0, cfg.seed)
                        : initialContent(a.fid, devNames, !!cfg.windowsLineEndings && dev.fs === "windows"),
                );
                if (applied) {
                    createdFids.add(a.fid);
                    if (a.binary) expectedBinary[a.fid] = "0";
                }
                log(a.dev, `USER create ${a.path} (${a.fid})${applied ? "" : " [skipped]"}`);
                break;
            case "edit": {
                const list = candidates(dev, (_, c) => fidOf(c) !== null);
                if (!list.length) {
                    applied = false;
                    break;
                }
                const path = list[Math.floor(a.pick * list.length)];
                const before = dev.read(path)!;
                applied = await dev.userEdit(path, setLine(before, a.line, a.value));
                const fid = fidOf(before)!;
                if (applied && cfg.profile === "disjoint") {
                    (expected[fid] ??= {})[a.line] = a.value;
                }
                log(a.dev, `USER edit ${path} ${a.line}=${a.value}`);
                break;
            }
            case "editBinary": {
                const list = candidates(
                    dev,
                    (p, c) =>
                        binaryMarker(c) !== null &&
                        (cfg.profile !== "disjoint" || p.split("/").pop()!.startsWith(`${a.dev}-`)),
                );
                if (!list.length) {
                    applied = false;
                    break;
                }
                const path = list[Math.floor(a.pick * list.length)];
                const fid = binaryMarker(dev.read(path)!)!.fid;
                applied = await dev.userEdit(path, binaryContent(fid, a.version, cfg.seed));
                if (applied && cfg.profile === "disjoint") expectedBinary[fid] = String(a.version);
                log(a.dev, `USER edit-binary ${path} v${a.version}`);
                break;
            }
            case "delete": {
                const list = candidates(dev, () => true);
                if (!list.length) {
                    applied = false;
                    break;
                }
                const path = list[Math.floor(a.pick * list.length)];
                const fid = fidOf(dev.read(path) ?? "");
                applied = await dev.userDelete(path);
                if (applied && fid) deletedFids.add(fid);
                log(a.dev, `USER delete ${path} (${fid})`);
                break;
            }
            case "rename": {
                const list = candidates(dev, (p) =>
                    cfg.profile === "disjoint" ? p.split("/").pop()!.startsWith(`${a.dev}-`) : true,
                );
                if (!list.length) {
                    applied = false;
                    break;
                }
                const from = list[Math.floor(a.pick * list.length)];
                applied = await dev.userRename(from, a.to);
                log(a.dev, `USER rename ${from} -> ${a.to}${applied ? "" : " [skipped]"}`);
                break;
            }
        }
        applied ? opStats.applied++ : opStats.skipped++;
    };

    const stats: Record<string, unknown> = { ops: opStats };
    try {
        // ── Phase 1: chaotic concurrent activity ──
        const lastT = plan.length ? plan[plan.length - 1].t : 0;
        const userOps: Promise<void>[] = [];
        let remaining = plan.length;
        let allDispatched!: () => void;
        const dispatched = new Promise<void>((r) => (allDispatched = r));
        if (remaining === 0) allDispatched();
        for (const a of plan) {
            setTimeout(() => {
                userOps.push(
                    exec(a).catch((e) => {
                        log(a.dev, `ACTION-ERROR ${a.kind}: ${e}`);
                    }),
                );
                if (--remaining === 0) allDispatched();
            }, a.t);
        }
        const r1 = await drive(
            dispatched.then(() => Promise.all(userOps)),
            lastT + 10 * 60_000,
        );
        if (r1 !== "ok") fail("HANG", `plan execution did not finish (${r1})`);

        // ── Phase 2: heal the network and let in-flight syncs finish ──
        log("SIM", "=== QUIESCE: network healed ===");
        network = PERFECT_NETWORK;
        for (const d of devices.values()) {
            d.online = true;
            if (!d.joined) {
                await d.init();
                d.joined = true;
            }
        }
        const inflight = [...devices.values()].flatMap((d) => d.inflightSyncs());
        const r2 = await drive(Promise.all(inflight), 15 * 60_000);
        if (r2 !== "ok") {
            const stuck = [...devices.values()]
                .filter((d) => d.inflightSyncs().length > 0)
                .map((d) => `${d.name}(state=${d.ctx.syncState})`);
            fail("HANG", `in-flight sync never settled (${r2}): ${stuck.join(", ")}`);
        }
        await advance(cfg.maxEventDelayMs + 1);

        // ── Phase 3: sync rounds until quiet ──
        const errorsBefore = new Map([...devices.values()].map((d) => [d.name, d.syncErrors.length]));
        let quiet = false;
        let round = 0;
        const idleCalls: Record<string, number> = {};
        if (failures.length === 0) {
            for (round = 1; round <= cfg.maxQuiesceRounds; round++) {
                log("SIM", `=== ROUND ${round} ===`);
                let changed = false;
                for (const d of devices.values()) {
                    const callsBefore = cloud.calls.length;
                    const filesBefore = JSON.stringify(d.userFiles());
                    const r = await drive(d.startSync("manual-sync"), 15 * 60_000);
                    if (r !== "ok") {
                        fail("HANG", `${d.name} sync in round ${round} never finished (${r})`);
                        break;
                    }
                    await advance(cfg.maxEventDelayMs + 1);
                    const calls = cloud.calls.slice(callsBefore);
                    idleCalls[d.name] = calls.length;
                    const mutated = calls.filter(
                        (c) => c.outcome === "ok" && MUTATING_METHODS.has(c.method) && !isEngineBookkeeping(c.arg),
                    );
                    if (mutated.length > 0 || JSON.stringify(d.userFiles()) !== filesBefore) {
                        changed = true;
                    }
                }
                if (failures.length) break;
                if (!changed) {
                    quiet = true;
                    break;
                }
            }
            if (!quiet && failures.length === 0) {
                fail(
                    "NO_CONVERGE",
                    `devices still changing files after ${cfg.maxQuiesceRounds} healthy sync rounds (sync ping-pong)`,
                );
            }
        }
        stats.quiesceRounds = round;
        stats.idleCallsPerDevice = idleCalls;
        stats.apiCalls = cloud.calls.length;
        stats.syncErrorsDuringChaos = Object.fromEntries(
            [...errorsBefore.entries()].map(([k, v]) => [k, v]),
        );

        // ── Invariants ──
        for (const d of devices.values()) {
            const newErrors = d.syncErrors.slice(errorsBefore.get(d.name) ?? 0);
            if (newErrors.length)
                fail("SYNC_ERROR", `${d.name} failed on a healthy network: ${newErrors[0]}`);
        }

        if (quiet) {
            for (const [name, n] of Object.entries(idleCalls)) {
                if (n > cfg.idleCallBudget)
                    fail("SLOW_IDLE", `${name} made ${n} API calls for a no-op sync (budget ${cfg.idleCallBudget})`);
            }
            for (const d of devices.values()) {
                const s = d.describe() as any;
                if (s.dirtyPaths.length)
                    fail("NOT_IDLE", `${d.name} still has dirty paths after convergence: ${s.dirtyPaths.join(", ")}`);
                if (s.pendingConflicts.length)
                    fail("NOT_IDLE", `${d.name} still has pendingConflict: ${s.pendingConflicts.join(", ")}`);
            }
        }

        const cloudFiles = await cloud.snapshot(isInternalPath);
        stats.cloudFiles = Object.keys(cloudFiles).length;
        for (const d of devices.values()) {
            const local = d.userFiles();
            const diff = diffMaps(cloudFiles, local);
            if (diff.length) fail("DIVERGED", `${d.name} differs from cloud: ${diff.slice(0, 5).join("; ")}`);
        }

        // Content oracles (evaluated on the cloud = agreed final state)
        const byFid = new Map<string, string[]>();
        for (const [p, c] of Object.entries(cloudFiles)) {
            const ids = [...fidsOf(c)];
            const bin = binaryMarker(c);
            if (bin) ids.push(bin.fid);
            for (const fid of ids) byFid.set(fid, [...(byFid.get(fid) ?? []), p]);
        }
        // Conflict copies anywhere (cloud or any device: some are never uploaded)
        const conflictCopies = [
            ...new Set([
                ...Object.keys(cloudFiles),
                ...[...devices.values()].flatMap((d) => Object.keys(d.userFiles()).map((p) => `${p}`)),
            ]),
        ].filter((p) => CONFLICT_RE.test(p));
        stats.conflictCopies = conflictCopies.length;

        if (cfg.profile === "disjoint") {
            if (conflictCopies.length)
                fail("FALSE_CONFLICT", `conflict copies for non-overlapping edits: ${conflictCopies.join(", ")}`);
            for (const fid of createdFids) {
                const paths = (byFid.get(fid) ?? []).filter((p) => !CONFLICT_RE.test(p));
                if (paths.length === 0) fail("DATA_LOSS", `note ${fid} vanished (never deleted)`);
                if (paths.length > 1) fail("DUPLICATE", `note ${fid} exists as ${paths.join(", ")}`);
                if (paths.length !== 1) continue;
                const content = cloudFiles[paths[0]];
                if (fid in expectedBinary) {
                    const got = binaryMarker(content)?.version;
                    if (got !== expectedBinary[fid])
                        fail("LOST_UPDATE", `${paths[0]}: binary is v${got}, expected v${expectedBinary[fid]}`);
                    continue;
                }
                for (const [label, value] of Object.entries(expected[fid] ?? {})) {
                    if (!new RegExp(`^${label}: ${value}$`, "m").test(content))
                        fail("LOST_UPDATE", `${paths[0]}: edit "${label}: ${value}" missing`);
                }
                for (const label of devNames) {
                    const n = (content.match(new RegExp(`^${label}: `, "gm")) ?? []).length;
                    if (n !== 1) fail("LOST_UPDATE", `${paths[0]}: line "${label}:" appears ${n} times (bad merge)`);
                }
            }
        } else {
            for (const fid of createdFids) {
                if (deletedFids.has(fid)) continue;
                if (!byFid.has(fid)) fail("DATA_LOSS", `note ${fid} vanished although nobody deleted it`);
            }
        }

        return await finish();
    } finally {
        for (const d of devices.values()) d.dispose();
        randomSpy.mockRestore();
        vi.useRealTimers();
    }

    async function finish(): Promise<SimResult> {
        const result: SimResult = {
            config: cfg,
            ok: failures.length === 0,
            failures: dedupe(failures),
            plan,
            stats,
            timeline,
        };
        if (!result.ok) result.reportPath = writeReport(result, devices, await cloud.snapshot(() => false));
        return result;
    }
}

/** Uploads of the engine's own index/communication files are not user changes */
function isEngineBookkeeping(arg: string): boolean {
    return isInternalPath(arg);
}

function diffMaps(a: Record<string, string>, b: Record<string, string>): string[] {
    const out: string[] = [];
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (!(k in a)) out.push(`extra local ${k}`);
        else if (!(k in b)) out.push(`missing local ${k}`);
        else if (a[k] !== b[k]) out.push(`content of ${k}`);
    }
    return out;
}

function dedupe(fs: Failure[]): Failure[] {
    const seen = new Set<string>();
    return fs.filter((f) => {
        const k = `${f.kind}|${f.message}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    });
}

// ───────────────────────── Reporting ─────────────────────────

export function reportDir(): string {
    return process.env.SIM_REPORT_DIR || join(process.cwd(), "test-results", "sim");
}

function writeReport(
    result: SimResult,
    devices: Map<string, SimDevice>,
    cloudFiles: Record<string, string>,
): string {
    const dir = reportDir();
    mkdirSync(dir, { recursive: true });
    const base = join(dir, `${result.config.name}-seed${result.config.seed}`);
    const json = {
        replay: replayCommand(result.config),
        config: result.config,
        failures: result.failures,
        stats: result.stats,
        plan: result.plan,
        devices: Object.fromEntries([...devices.values()].map((d) => [d.name, d.describe()])),
        cloud: cloudFiles,
    };
    writeFileSync(`${base}.json`, JSON.stringify(json, null, 2));
    writeFileSync(
        `${base}.log`,
        [
            `# ${result.config.name} seed=${result.config.seed}`,
            `# replay: ${replayCommand(result.config)}`,
            ...result.failures.map((f) => `# FAIL ${f.kind}: ${f.message}`),
            "",
            ...result.timeline,
        ].join("\n"),
    );
    return `${base}.log`;
}

export function replayCommand(cfg: SimConfig): string {
    return `SIM_SEED=${cfg.seed} SIM_SCENARIO=${cfg.name} npm run test:sim -- tests/sim/multi-device.sim.test.ts`;
}

export function formatFailure(result: SimResult): string {
    return [
        `Simulation "${result.config.name}" seed=${result.config.seed} failed:`,
        ...result.failures.map((f) => `  - ${f.kind}: ${f.message}`),
        `  replay: ${replayCommand(result.config)}`,
        result.reportPath ? `  report: ${result.reportPath}` : "",
        "  last timeline lines:",
        ...result.timeline.slice(-25).map((l) => `    ${l}`),
    ].join("\n");
}

// ───────────────────────── Minimizer ─────────────────────────

/**
 * Greedy delta-debugging: drop chunks of the plan while the same failure kind
 * still reproduces. Returns the smallest plan found.
 */
export async function minimizePlan(cfg: SimConfig, plan: Action[], kind: string, budget = 200): Promise<Action[]> {
    const reproduces = async (p: Action[]) => {
        const r = await runSimulation({ ...cfg, name: `${cfg.name}-min` }, p);
        return r.failures.some((f) => f.kind === kind);
    };
    let current = plan;
    let chunk = Math.max(1, Math.floor(current.length / 2));
    let runs = 0;
    while (chunk >= 1 && runs < budget) {
        let removed = false;
        for (let i = 0; i < current.length && runs < budget; ) {
            const candidate = current.filter((a, j) => (j < i || j >= i + chunk) || a.kind === "join");
            if (candidate.length === current.length) {
                i += chunk;
                continue;
            }
            runs++;
            if (await reproduces(candidate)) {
                current = candidate;
                removed = true;
            } else {
                i += chunk;
            }
        }
        if (!removed) chunk = Math.floor(chunk / 2);
    }
    return current;
}
