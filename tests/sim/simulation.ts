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
import { createSimCryptoEngine } from "./sim-crypto";
import { MassChangeGuard } from "../../src/sync-manager/mass-change-guard";

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
    /** Probability that an action kills the app on a device and starts it again */
    restartRate?: number;
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
    /** Run every device with end-to-end encryption (random IV per upload) */
    e2ee?: boolean;
    /**
     * Devices run the real Google Drive adapter against a Drive-like server (folders
     * as items with ids, a folder rename is one change) instead of the path-keyed store
     */
    driveServer?: boolean;
    /** The cloud reports a non-MD5 content hash (OneDrive / Dropbox style) */
    foreignHash?: boolean;
    /** Per-device setting overrides (device i gets entry i % length), applied over `settings` */
    deviceSettings?: Partial<SyncManagerSettings>[];
    /** Disjoint profile: devices also delete notes and whole folders */
    deletes?: boolean;
    /** Devices also rename whole folders (notes inside keep their content) */
    folderRenames?: boolean;
    /** Users change settings during the run */
    settingChanges?: SettingChangeConfig;
    /** "Ask before deleting many files" is on; the user sometimes holds the deletions */
    massDelete?: { files: number; percent: number; declineRate: number };
}

export interface SettingChangeConfig {
    /** Probability that an action is a settings change */
    rate: number;
    /** Settings that may change and the values they take */
    options: { key: keyof SyncManagerSettings; values: unknown[] }[];
    /**
     * Settings travel to the other devices (synced settings file): a change made
     * on one device is uploaded with its next sync and applied on each other
     * device at the end of the first sync that follows. Off = each device keeps
     * its own settings (settings file not synced).
     */
    shared: boolean;
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
    maxQuiesceRounds: 8,
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
    | { t: number; dev: string; kind: "offline" | "online" }
    | { t: number; dev: string; kind: "restart" }
    | { t: number; dev: string; kind: "setting"; key: keyof SyncManagerSettings; value: unknown }
    | { t: number; dev: string; kind: "deleteFolder"; folder: string }
    | { t: number; dev: string; kind: "renameFolder"; from: string; to: string };

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
        // Only consumes randomness when enabled, so other scenarios keep their plans
        if (cfg.restartRate && rng.chance(cfg.restartRate)) {
            plan.push({ t, dev, kind: "restart" });
            continue;
        }
        if (cfg.settingChanges && rng.chance(cfg.settingChanges.rate)) {
            const opt = rng.pick(cfg.settingChanges.options);
            plan.push({ t, dev, kind: "setting", key: opt.key, value: rng.pick(opt.values) });
            continue;
        }

        const weights: Record<string, number> =
            cfg.profile === "disjoint"
                ? { create: 3, edit: 9, rename: 1, sync: 7, editBinary: cfg.binaryRate ? 2 : 0 }
                : { create: 3, edit: 8, rename: 2, delete: 2, sync: 7, editBinary: cfg.binaryRate ? 2 : 0 };
        if (cfg.deletes && cfg.profile === "disjoint") {
            weights.delete = 1;
            weights.deleteFolder = 0.25;
        }
        if (cfg.folderRenames) weights.renameFolder = 0.5;
        const kind = rng.weighted<string>(weights);

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
            case "deleteFolder":
                plan.push({ t, dev, kind: "deleteFolder", folder: rng.pick(["notes/sub", "archive", "assets"]) });
                break;
            case "editBinary":
                plan.push({ t, dev, kind: "editBinary", pick: rng.next(), version: i });
                break;
            case "renameFolder": {
                // Back and forth between two names, so notes created later land in
                // both the old and the new folder name
                const pair = rng.pick([
                    ["notes/sub", "notes/moved"],
                    ["archive", "Archive 2"],
                    ["assets", "media/assets"],
                ]);
                const [from, to] = rng.chance(0.5) ? pair : [pair[1], pair[0]];
                plan.push({ t, dev, kind: "renameFolder", from, to });
                break;
            }
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

    const cloud = new SimCloud({ drive: cfg.driveServer });
    if (cfg.foreignHash) cloud.store.useForeignHash();
    cloud.onCall = (c) => {
        if (c.outcome !== "ok" || MUTATING_METHODS.has(c.method)) {
            log(c.device, `CLOUD ${c.method}(${c.arg}) ${c.outcome}`);
        }
    };
    let network: NetworkProfile = cfg.network;
    const devNames = deviceNames(cfg.devices);
    const worldRng = new Rng(cfg.seed).fork(3);

    const cryptoEngine = cfg.e2ee ? createSimCryptoEngine(new Rng(cfg.seed).fork(11)) : undefined;
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
            settings: {
                ...(cfg.settings ?? {}),
                ...(cfg.deviceSettings?.length
                    ? cfg.deviceSettings[devNames.indexOf(name) % cfg.deviceSettings.length]
                    : {}),
            },
            cryptoEngine,
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

    // "Ask before deleting many files": the user holds the deletions now and then
    // while the chaos lasts, and lets them run once things calm down.
    let chaosPhase = true;
    if (cfg.massDelete) {
        const md = cfg.massDelete;
        const askRng = new Rng(cfg.seed).fork(13);
        for (const dev of devices.values()) {
            dev.onBoot = (d) => {
                d.sm.planGuard = new MassChangeGuard(
                    () => ({ massDeleteConfirmFiles: md.files, massDeleteConfirmPercent: md.percent }),
                    () => d.sm.syncedFileCount(),
                    async (plan, summary, kinds) => {
                        const ok = !chaosPhase || !askRng.chance(md.declineRate);
                        const what = [kinds.deletes ? "delete" : "", kinds.overwrites ? "overwrite" : ""].filter(Boolean).join("+");
                        log(
                            d.name,
                            `USER mass-${what} prompt (${plan.step}, ${summary.remoteFilesDeleted + summary.localFilesDeleted} deleted, ${summary.remoteFilesOverwritten} overwritten): ${ok ? "run" : "hold"}`,
                        );
                        return ok;
                    },
                    () => d.sm.currentTrigger === "manual-sync" || d.sm.currentTrigger === "full-scan",
                );
            };
            dev.onBoot(dev);
        }
    }

    // ── Settings changes and the synced settings file ──
    type SharedChange = { key: keyof SyncManagerSettings; value: unknown; from: string; published: boolean; seq: number };
    const sharedChanges: SharedChange[] = [];
    /** Every conflict strategy any device used at some point */
    const strategiesUsed = new Set<string>(
        [...devices.values()].map((d) => (d.settings as SyncManagerSettings).conflictResolutionStrategy),
    );
    const appliedSeq = new Map<string, Set<number>>(devNames.map((n) => [n, new Set<number>()]));
    let changeSeq = 0;
    /** fids each device held when a settings change took effect on it */
    /** fid -> "kept outside the scope" (true) or "synced" (false), as last seen at a change */
    const heldAtChange = new Map<string, Map<string, boolean>>(devNames.map((n) => [n, new Map<string, boolean>()]));
    const fidsHeld = (d: SimDevice) => {
        const out = new Set<string>();
        for (const c of Object.values(d.userFiles())) {
            fidsOf(c).forEach((f) => out.add(f));
            const b = binaryMarker(c);
            if (b) out.add(b.fid);
        }
        return out;
    };
    const markIgnored = (d: SimDevice) => {
        for (const [p, c] of Object.entries(d.userFiles())) {
            if (!ignoredOn(d, p)) continue;
            fidsOf(c).forEach((f) => everIgnored.add(f));
            const b = binaryMarker(c);
            if (b) everIgnored.add(b.fid);
        }
    };
    const applySetting = async (d: SimDevice, key: keyof SyncManagerSettings, value: unknown, local: boolean) => {
        for (const [p, c] of Object.entries(d.userFiles()))
            for (const f of fidsIn(c)) heldAtChange.get(d.name)!.set(f, ignoredOn(d, p));
        markIgnored(d);
        const settings = d.settings as unknown as Record<string, unknown>;
        const before = settings[key];
        if (before === value) return;
        settings[key] = value;
        if (key === "conflictResolutionStrategy") strategiesUsed.add(String(value));
        markIgnored(d);
        for (const [f, paths] of movedTo) if ([...paths].some((p) => ignoredOn(d, p))) movedPastSomeScope.add(f);
        log(d.name, `${local ? "USER" : "SETTINGS-SYNC"} setting ${String(key)}: ${JSON.stringify(before)} -> ${JSON.stringify(value)}`);
        if (key === "desktopExclusionPatterns") {
            // Both the settings tab and the settings reload apply the device list at once
            await d.sm.applyDeviceScopeChange(typeof before === "string" ? before : "");
        } else if (local) {
            // The settings tab asks for a full cleanup after scope settings change
            d.sm.triggerFullCleanup();
        }
    };
    if (cfg.settingChanges?.shared) {
        for (const dev of devices.values()) {
            dev.afterSync = async (d) => {
                // Own changes went up with this sync (the settings file is synced)
                for (const c of sharedChanges) if (c.from === d.name) c.published = true;
                // Settings that arrived with this sync are applied at its end
                for (const c of sharedChanges) {
                    if (appliedSeq.get(d.name)!.has(c.seq) || c.from === d.name || !c.published) continue;
                    appliedSeq.get(d.name)!.add(c.seq);
                    await applySetting(d, c.key, c.value, false);
                }
            };
        }
    }

    // Oracle state
    const expected: Record<string, Record<string, string>> = {}; // fid -> dev -> value
    const expectedBinary: Record<string, string> = {}; // fid -> last version written
    const deletedFids = new Set<string>();
    /** Deleted on one device only: the file was left out there (not synced) */
    const localDeleted = new Map<string, Set<string>>(devNames.map((n) => [n, new Set<string>()]));
    /** Notes that were outside some device's sync scope at some point */
    const everIgnored = new Set<string>();
    /** Edits whose expected outcome is "kept somewhere", not "in the cloud file" */
    const looseEdits: { dev: string; fid: string; line: string; value: string }[] = [];
    /** Binary versions written where the file was left out (fid -> device -> version) */
    const looseBinary = new Map<string, Map<string, string>>();
    /** Device that wrote expectedBinary; a later version it wrote while left out supersedes it there */
    const expectedBinaryBy: Record<string, string> = {};
    const binarySupersededOutside = new Set<string>();
    /** Device that made the expected edit of each line (fid -> line -> device) */
    const expectedBy: Record<string, Record<string, string>> = {};
    /** The edit was made on a device that later deleted its copy while left out there:
     *  if it had not been uploaded yet, it is gone with that copy, as the user chose */
    const goneWithLocalCopy = (fid: string, by: string | undefined) =>
        !!by && everIgnored.has(fid) && localDeleted.get(by)!.has(fid);
    const ignoredOn = (d: SimDevice, path: string) => d.sm.shouldIgnore(path);
    /** Notes a device moved to where it does not sync (gone for the others) -> that device */
    const movedOutOfScope = new Map<string, string>();
    /** Notes moved (at some point) to where some device does not sync: that device may
     *  have kept its edited copy (edit beats deletion), a second file by design */
    const movedPastSomeScope = new Set<string>();
    /** Paths each note was moved to (fid -> paths), for movedPastSomeScope on later scope changes */
    const movedTo = new Map<string, Set<string>>();
    const fidsIn = (c: string) => {
        const b = binaryMarker(c);
        return [...fidsOf(c), ...(b ? [b.fid] : [])];
    };
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
            case "restart":
                log(a.dev, "KILL + RESTART (in-memory state lost)");
                await dev.restart();
                dev.startSync("startup-sync", true);
                return;
            case "setting":
                await applySetting(dev, a.key, a.value, true);
                if (cfg.settingChanges?.shared) {
                    sharedChanges.push({ key: a.key, value: a.value, from: a.dev, published: false, seq: ++changeSeq });
                }
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
                    if (ignoredOn(dev, a.path)) everIgnored.add(a.fid);
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
                // The latest edit of a line decides what is expected of it
                if (applied && ignoredOn(dev, path)) {
                    everIgnored.add(fid);
                    if (expected[fid]) delete expected[fid][a.line];
                    looseEdits.push({ dev: a.dev, fid, line: a.line, value: a.value });
                } else if (applied && cfg.profile === "disjoint") {
                    (expected[fid] ??= {})[a.line] = a.value;
                    (expectedBy[fid] ??= {})[a.line] = a.dev;
                    for (let i = looseEdits.length - 1; i >= 0; i--)
                        if (looseEdits[i].fid === fid && looseEdits[i].line === a.line) looseEdits.splice(i, 1);
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
                if (applied && ignoredOn(dev, path)) {
                    // Left out here: reaches the cloud only if the file is synced again
                    // here before this device deletes it
                    everIgnored.add(fid);
                    if (!looseBinary.has(fid)) looseBinary.set(fid, new Map());
                    looseBinary.get(fid)!.set(a.dev, String(a.version));
                    // Its earlier version (maybe never uploaded before the file was left
                    // out here) now exists nowhere: replaced on the only device that had it
                    if (expectedBinaryBy[fid] === a.dev) binarySupersededOutside.add(fid);
                } else if (applied && cfg.profile === "disjoint") {
                    expectedBinary[fid] = String(a.version);
                    expectedBinaryBy[fid] = a.dev;
                    binarySupersededOutside.delete(fid);
                    looseBinary.delete(fid);
                }
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
                // A file may hold several notes (merged collision) or be a binary
                const content = dev.read(path) ?? "";
                const bin = binaryMarker(content);
                const fids = [...fidsOf(content), ...(bin ? [bin.fid] : [])];
                const localOnly = ignoredOn(dev, path);
                applied = await dev.userDelete(path);
                if (applied) fids.forEach((f) => (localOnly ? localDeleted.get(a.dev)!.add(f) : deletedFids.add(f)));
                log(a.dev, `USER delete ${path} (${fids.join(",") || "?"})${localOnly ? " [left out here]" : ""}`);
                break;
            }
            case "deleteFolder": {
                const inside = Object.entries(dev.userFiles()).filter(([p]) => p.startsWith(a.folder + "/"));
                if (!inside.length) {
                    applied = false;
                    break;
                }
                for (const [p, c] of inside) {
                    const bin = binaryMarker(c);
                    const fids = [...fidsOf(c), ...(bin ? [bin.fid] : [])];
                    fids.forEach((f) => (ignoredOn(dev, p) ? localDeleted.get(a.dev)!.add(f) : deletedFids.add(f)));
                }
                await dev.ops.rmdir(a.folder, true);
                log(a.dev, `USER delete folder ${a.folder} (${inside.length} files)`);
                break;
            }
            case "renameFolder": {
                const inside = Object.entries(dev.userFiles()).filter(([p]) => p.startsWith(a.from + "/"));
                if (!inside.length) {
                    applied = false;
                    break;
                }
                applied = await dev.userRenameFolder(a.from, a.to);
                if (applied) {
                    for (const [p, c] of inside) {
                        const bin = binaryMarker(c);
                        const ids = [...fidsIn(c), ...(bin ? [bin.fid] : [])];
                        const to = a.to + p.slice(a.from.length);
                        if (ignoredOn(dev, p) || ignoredOn(dev, to)) ids.forEach((f) => everIgnored.add(f));
                        if ([...devices.values()].some((d) => ignoredOn(d, to)))
                            ids.forEach((f) => movedPastSomeScope.add(f));
                        ids.forEach((f) => (movedTo.get(f) ?? movedTo.set(f, new Set()).get(f)!).add(to));
                    }
                }
                log(a.dev, `USER rename folder ${a.from} -> ${a.to} (${inside.length} files)${applied ? "" : " [skipped]"}`);
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
                const movedOut = !ignoredOn(dev, from) && ignoredOn(dev, a.to);
                const ids = fidsIn(dev.read(from) ?? "");
                applied = await dev.userRename(from, a.to);
                if (applied && (movedOut || ignoredOn(dev, from))) ids.forEach((f) => everIgnored.add(f));
                // Moved out of what this device syncs: deleted for the other devices
                if (applied && movedOut) ids.forEach((f) => movedOutOfScope.set(f, a.dev));
                if (applied && [...devices.values()].some((d) => ignoredOn(d, a.to)))
                    ids.forEach((f) => movedPastSomeScope.add(f));
                if (applied) ids.forEach((f) => (movedTo.get(f) ?? movedTo.set(f, new Set()).get(f)!).add(a.to));
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
        chaosPhase = false;
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
                    const settingsBefore = JSON.stringify(d.settings);
                    const r = await drive(d.startSync("manual-sync"), 15 * 60_000);
                    if (r !== "ok") {
                        fail("HANG", `${d.name} sync in round ${round} never finished (${r})`);
                        break;
                    }
                    // Large files move in the background after the sync returns
                    const rt = await drive(d.transfersSettled(), 15 * 60_000);
                    if (rt !== "ok") {
                        fail("HANG", `${d.name} background transfers in round ${round} never settled (${rt})`);
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
                    // Settings that arrived with this sync are acted on by the next one
                    if (JSON.stringify(d.settings) !== settingsBefore) changed = true;
                    // Uploading the shared index owed from before the heal is catching up,
                    // not an idle sync: measure the idle cost in the next round.
                    if (calls.some((c) => c.outcome === "ok" && c.method === "uploadFile" && c.arg.endsWith("/sync-index.json"))) {
                        changed = true;
                    }
                    // Listing the folders a change page reported (Drive: have their notes
                    // moved with them?) is catching up as well. A sync that lists folders
                    // every time never gets quiet and fails as NO_CONVERGE.
                    if (calls.some((c) => c.outcome === "ok" && c.method === "listFiles")) changed = true;
                    // Still holding work back (a missing file waits a few seconds for a
                    // late rename event): not quiet yet.
                    if ((d.describe() as { dirtyPaths: string[] }).dirtyPaths.length > 0) changed = true;
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
                if (s.pendingTransfers.length)
                    fail("NOT_IDLE", `${d.name} still has background transfers: ${s.pendingTransfers.join(", ")}`);
            }
        }

        const cloudFiles = await cloud.snapshot(
            isInternalPath,
            cryptoEngine
                ? (b) => (cryptoEngine.isChunkedFormat(b) ? cryptoEngine.decryptChunked(b) : cryptoEngine.decryptFromBlob(b))
                : undefined,
        );
        stats.cloudFiles = Object.keys(cloudFiles).length;
        for (const d of devices.values()) {
            // Conflict copies are local-only by design (shouldNotBeOnRemote), so they
            // are not a divergence. FALSE_CONFLICT / DATA_LOSS still look at them.
            // macOS hands names back decomposed (NFD): "café" in the cloud is the same
            // file as "cafe\u0301" on disk, so compare names in NFC there.
            // On a case-insensitive disk, "projects/" and "Projects/" are one folder:
            // when the cloud holds both spellings (made on Linux), the device files
            // them all under the one it has. Folder spelling is not a divergence
            // there; file names still must match exactly.
            const foldDirs = d.fs === "windows" || d.fs === "macos";
            const nfc = (p: string) => {
                const q = d.fs === "macos" ? p.normalize("NFC") : p;
                if (!foldDirs) return q;
                const slash = q.lastIndexOf("/");
                return slash < 0 ? q : q.slice(0, slash).toLowerCase() + q.slice(slash);
            };
            // Files outside this device's sync scope (exclusions, content toggles,
            // device-only lists) are compared by the scope checks below instead.
            const local = Object.fromEntries(
                Object.entries(d.userFiles())
                    .filter(([p]) => !CONFLICT_RE.test(p) && !ignoredOn(d, p))
                    .map(([p, c]) => [nfc(p), c]),
            );
            const cloudView: Record<string, string> = {};
            for (const [p, c] of Object.entries(cloudFiles)) {
                if (ignoredOn(d, p)) continue;
                const k = nfc(p);
                if (k in cloudView) fail("DIVERGED", `${d.name} cannot hold both cloud files ${p} and ${k}`);
                cloudView[k] = c;
            }
            const diff = diffMaps(cloudView, local);
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

        // Every file (cloud and devices, conflict copies included) per note id
        const holdersOf = new Map<string, string[]>();
        const addHolder = (where: string, c: string) => {
            const ids = [...fidsOf(c)];
            const bin = binaryMarker(c);
            if (bin) ids.push(bin.fid);
            for (const f of ids) holdersOf.set(f, [...(holdersOf.get(f) ?? []), c]);
        };
        for (const c of Object.values(cloudFiles)) addHolder("cloud", c);
        for (const d of devices.values()) for (const c of Object.values(d.userFiles())) addHolder(d.name, c);
        const keptSomewhere = (fid: string, label: string, value: string) =>
            (holdersOf.get(fid) ?? []).some((c) => new RegExp(`^${label}: ${value}$`, "m").test(c));

        const pathsAnywhere = new Map<string, string[]>(byFid);
        for (const dev of devices.values()) {
            for (const [p, c] of Object.entries(dev.userFiles())) {
                for (const fid of fidsOf(c)) pathsAnywhere.set(fid, [...(pathsAnywhere.get(fid) ?? []), p]);
            }
        }
        // A device that held a note when its settings changed still holds it at the
        // end (anywhere, in any name), unless a user deleted it. Catches settings
        // that make one device remove another device's files, and exclusions that
        // drop the local copy they promise to keep.
        for (const d of devices.values()) {
            const now = fidsHeld(d);
            for (const [fid, keptOutside] of heldAtChange.get(d.name)!) {
                if (deletedFids.has(fid) || localDeleted.get(d.name)!.has(fid)) continue;
                // A synced note moved to where this device does not sync (still in the
                // cloud there, or only on the device that moved it: a move not pushed
                // before that device left the new place out takes the note out of the sync)
                if (!keptOutside && (pathsAnywhere.get(fid) ?? []).some((p) => ignoredOn(d, p))) continue;
                const mover = movedOutOfScope.get(fid);
                if (mover && mover !== d.name) continue;
                // Moved by another device to a place it left out only afterwards, before
                // the move was pushed, and deleted there: taken out of the sync by that
                // device (its upload of the old name, landing late, is removed as stray)
                const leftBehind =
                    (movedTo.get(fid)?.size ?? 0) > 0 &&
                    [...devices.values()].some((o) => o !== d && localDeleted.get(o.name)!.has(fid));
                if (leftBehind && everIgnored.has(fid) && !now.has(fid)) continue;
                // Moved by another device to a place it left out afterwards, before the
                // move was pushed: taken out of the sync there (as a move straight into
                // a folder left out), its copy kept under the new name on that device
                const takenOutByMover = [...devices.values()].some(
                    (o) =>
                        o !== d &&
                        Object.entries(o.userFiles()).some(
                            ([p, c]) => (fidsOf(c).includes(fid) || binaryMarker(c)?.fid === fid) && ignoredOn(o, p) && !!movedTo.get(fid)?.has(p),
                        ),
                );
                if (takenOutByMover && !now.has(fid)) continue;
                if (!now.has(fid))
                    fail("SCOPE_LOSS", `${d.name} lost note ${fid} after a settings change (nobody deleted it)`);
            }
        }

        const strategies = strategiesUsed;
        for (const d of devices.values()) strategies.add((d.settings as SyncManagerSettings).conflictResolutionStrategy);
        // force-local / force-remote drop the other side's edits by design
        const editsMayBeDropped = strategies.has("force-local") || strategies.has("force-remote");
        const forks = strategies.has("always-fork");
        const allDeleted = (fids: string[]) => fids.length > 0 && fids.every((f) => deletedFids.has(f));

        if (cfg.profile === "disjoint") {
            // Conflict copies: none for non-overlapping edits. Allowed when the user
            // asked for forks, for a note deleted on one device while edited on
            // another, and for a note that was outside some device's scope (its
            // copy there went its own way).
            const unexpected = conflictCopies.filter((p) => {
                if (forks) return false;
                const c =
                    cloudFiles[p] ??
                    [...devices.values()].map((d) => d.read(p)).find((x) => x !== null) ??
                    "";
                const ids = fidsIn(c);
                return !(allDeleted(ids) || ids.some((f) => deletedFids.has(f) || everIgnored.has(f)));
            });
            if (unexpected.length)
                fail("FALSE_CONFLICT", `conflict copies for non-overlapping edits: ${unexpected.join(", ")}`);
            for (const fid of createdFids) {
                if (deletedFids.has(fid)) continue;
                const paths = (byFid.get(fid) ?? []).filter((p) => !CONFLICT_RE.test(p));
                if (paths.length === 0) {
                    // Outside some device's scope: may legitimately live only there
                    // (or nowhere, when that device deleted its own copy)
                    if (everIgnored.has(fid) && holdersOf.has(fid)) continue;
                    if (everIgnored.has(fid) && [...localDeleted.values()].some((s) => s.has(fid))) continue;
                    fail("DATA_LOSS", `note ${fid} vanished (never deleted)`);
                }
                // A copy kept outside one device's scope and moved back in comes back as a
                // new file (the cloud copy may have changed meanwhile): two files, by design.
                // Same when a note was moved to where another device does not sync while
                // that device had edits: edit beats deletion there, so it comes back.
                const outOfSomeScope = paths.some((p) => [...devices.values()].some((d) => ignoredOn(d, p)));
                if (paths.length > 1 && !everIgnored.has(fid) && !outOfSomeScope && !movedPastSomeScope.has(fid))
                    fail("DUPLICATE", `note ${fid} exists as ${paths.join(", ")}`);
                if (paths.length !== 1) continue;
                const content = cloudFiles[paths[0]];
                if (fid in expectedBinary) {
                    const got = binaryMarker(content)?.version;
                    const loose = [...(looseBinary.get(fid) ?? [])].some(
                        ([dev, v]) => v === got && !localDeleted.get(dev)!.has(fid),
                    );
                    if (
                        got !== expectedBinary[fid] &&
                        !editsMayBeDropped &&
                        !loose &&
                        !binarySupersededOutside.has(fid) &&
                        !goneWithLocalCopy(fid, expectedBinaryBy[fid])
                    ) {
                        const kept = (holdersOf.get(fid) ?? []).some(
                            (c) => binaryMarker(c)?.version === expectedBinary[fid],
                        );
                        if (!(kept && (everIgnored.has(fid) || forks)))
                            fail("LOST_UPDATE", `${paths[0]}: binary is v${got}, expected v${expectedBinary[fid]}`);
                    }
                    continue;
                }
                if (!editsMayBeDropped) {
                    const strict = !forks && !everIgnored.has(fid);
                    for (const [label, value] of Object.entries(expected[fid] ?? {})) {
                        if (goneWithLocalCopy(fid, expectedBy[fid]?.[label])) continue;
                        const inMain = new RegExp(`^${label}: ${value}$`, "m").test(content);
                        if (strict ? !inMain : !inMain && !keptSomewhere(fid, label, value))
                            fail("LOST_UPDATE", `${paths[0]}: edit "${label}: ${value}" missing`);
                    }
                }
                for (const label of devNames) {
                    const n = (content.match(new RegExp(`^${label}: `, "gm")) ?? []).length;
                    if (n !== 1) fail("LOST_UPDATE", `${paths[0]}: line "${label}:" appears ${n} times (bad merge)`);
                }
            }
            // Edits made where the note was outside the scope: kept somewhere
            if (!editsMayBeDropped) {
                const last = new Map<string, (typeof looseEdits)[number]>();
                for (const e of looseEdits) last.set(`${e.dev}|${e.fid}|${e.line}`, e);
                for (const e of last.values()) {
                    if (deletedFids.has(e.fid) || localDeleted.get(e.dev)!.has(e.fid)) continue;
                    // A later edit of the same line elsewhere may have replaced it
                    if (expected[e.fid]?.[e.line] !== undefined && expected[e.fid][e.line] !== e.value) continue;
                    if (!keptSomewhere(e.fid, e.line, e.value))
                        fail("LOST_UPDATE", `edit "${e.line}: ${e.value}" of ${e.fid} made on ${e.dev} (outside its scope) is gone`);
                }
            }
        } else {
            // Notes that survive only in a device's local conflict copy are not lost,
            // but they are invisible to every other device: count them.
            const inLocalCopies = new Set<string>();
            for (const d of devices.values())
                for (const [p, c] of Object.entries(d.userFiles())) {
                    if (!CONFLICT_RE.test(p)) continue;
                    fidsOf(c).forEach((f) => inLocalCopies.add(f));
                    const b = binaryMarker(c);
                    if (b) inLocalCopies.add(b.fid);
                }
            let onlyLocal = 0;
            for (const fid of createdFids) {
                if (deletedFids.has(fid) || byFid.has(fid)) continue;
                if (inLocalCopies.has(fid)) {
                    onlyLocal++;
                    continue;
                }
                if (everIgnored.has(fid) && holdersOf.has(fid)) continue;
                fail("DATA_LOSS", `note ${fid} vanished although nobody deleted it`);
            }
            (stats as any).notesOnlyInLocalConflictCopy = onlyLocal;
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
        // Line endings / BOM only: the engine treats these as the same text (a Windows
        // device keeps its CRLF copy when another device's merge wrote LF)
        else if (a[k] !== b[k] && sameText(a[k], b[k]) === false) out.push(`content of ${k}`);
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

function sameText(x: string, y: string): boolean {
    const norm = (t: string) => t.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
    return norm(x) === norm(y);
}
