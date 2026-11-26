/**
 * Sync performance benchmark on top of the multi-device simulator.
 *
 * Runs a fixed (non-random) workload on 2 devices with a constant network
 * round-trip, and measures for each phase:
 *   - virtual wall time of the sync (what the user waits for)
 *   - number of cloud API calls, per method
 * and checks that the devices converge without conflict copies.
 *
 *   npm run test:sim -- tests/sim/perf.test.ts      # prints the table
 */
import { vi } from "vitest";
import { Rng } from "./rng";
import { SimCloud, type NetworkProfile } from "./sim-cloud";
import { SimDevice, isInternalPath } from "./sim-device";
import { advance, drive } from "./simulation";
import type { SyncManagerSettings } from "../../src/sync-manager";

export interface PerfOptions {
    /** Notes created on device A in the bulk phase */
    notes: number;
    /** Binary attachments created on device A in the bulk phase */
    binaries: number;
    /** Notes edited on A only, then pulled by B */
    edits: number;
    /** Notes edited on BOTH devices (different lines) -> auto-merge */
    merges: number;
    /** One-way latency per API call (virtual ms) */
    latencyMs: number;
    /** Drive Changes API page size */
    changesPageSize: number;
    settings?: Partial<SyncManagerSettings>;
}

export const DEFAULT_PERF: PerfOptions = {
    notes: 60,
    binaries: 6,
    edits: 30,
    merges: 15,
    latencyMs: 100,
    changesPageSize: 25,
    settings: { concurrency: 5 },
};

export interface PerfPhase {
    name: string;
    virtualMs: number;
    calls: number;
    byMethod: Record<string, number>;
}

export interface PerfResult {
    phases: PerfPhase[];
    problems: string[];
}

/** The note created alone in the "1 new note" phase */
const SINGLE_NEW_NOTE = "notes/f0/single-new.md";
const EPOCH = Date.UTC(2026, 0, 1, 0, 0, 0);
const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

function note(i: number): string {
    return [`# note ${i}`, "", "A: init", "", "B: init", "", "body text ".repeat(40)].join("\n");
}

function binary(i: number, v: number): ArrayBuffer {
    const rng = new Rng(i * 31 + v);
    const head = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    return new Uint8Array([...head, v, ...Array.from({ length: 4096 }, () => rng.int(0, 255))]).buffer;
}

const setLine = (c: string, label: string, value: string) =>
    c.replace(new RegExp(`^${label}: .*$`, "m"), `${label}: ${value}`);

export async function runPerf(opts: PerfOptions = DEFAULT_PERF): Promise<PerfResult> {
    vi.useFakeTimers({
        toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
        now: EPOCH,
    });
    const engineRng = new Rng(1).fork(2);
    const randomSpy = vi.spyOn(Math, "random").mockImplementation(() => engineRng.next());
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const phases: PerfPhase[] = [];
    const problems: string[] = [];
    const devices: SimDevice[] = [];

    try {
        const cloud = new SimCloud();
        cloud.store.changesPageSize = opts.changesPageSize;
        const network: NetworkProfile = {
            minLatencyMs: opts.latencyMs,
            maxLatencyMs: opts.latencyMs,
            failureRate: 0,
            lostResponseRate: 0,
        };
        const timeline: string[] = [];
        const mk = (name: string) => {
            const rng = new Rng(7).fork(name.charCodeAt(0));
            const d: SimDevice = new SimDevice({
                name,
                rng,
                maxEventDelayMs: 0,
                clockSkewMs: 0,
                settings: opts.settings,
                log: (dev, msg) => timeline.push(`${Date.now() - EPOCH}ms [${dev}] ${msg}`),
                cloudView: (dev) =>
                    cloud.createDeviceView(name, rng.fork(7), () => network, () => dev.online),
            });
            devices.push(d);
            return d;
        };

        const measure = async (name: string, fn: () => Promise<unknown>) => {
            const before = cloud.calls.length;
            const t0 = Date.now();
            const r = await drive(fn(), 60 * 60_000);
            if (r !== "ok") problems.push(`${name}: ${r}`);
            const virtualMs = Date.now() - t0;
            await advance(1);
            const calls = cloud.calls.slice(before);
            const byMethod: Record<string, number> = {};
            for (const c of calls) byMethod[c.method] = (byMethod[c.method] ?? 0) + 1;
            phases.push({ name, virtualMs, calls: calls.length, byMethod });
        };
        const sync = (d: SimDevice, scan = false) => d.startSync(scan ? "initial-sync" : "manual-sync", scan);

        const A = mk("A");
        const B = mk("B");
        await A.init();
        A.joined = true;
        await drive(sync(A, true), 60_000);

        // ── Bulk create on A ──
        const paths: string[] = [];
        for (let i = 0; i < opts.notes; i++) {
            const p = `notes/f${i % 4}/n${i}.md`;
            paths.push(p);
            await A.userCreate(p, note(i));
        }
        for (let i = 0; i < opts.binaries; i++) await A.userCreate(`assets/img${i}.png`, binary(i, 0));
        await advance(1);
        await measure("A: push new files", () => sync(A));

        // ── B joins: initial full pull ──
        await B.init();
        B.joined = true;
        await measure("B: initial sync (pull all)", () => sync(B, true));

        // ── A edits, B pulls via Changes API ──
        for (let i = 0; i < opts.edits; i++) {
            const p = paths[i];
            await A.userEdit(p, setLine(A.read(p)!, "A", `edit-${i}`));
        }
        await advance(1);
        await measure("A: push edits", () => sync(A));
        await measure("B: pull edits", () => sync(B));

        // ── Both edit the same notes (different lines) -> auto-merge on B ──
        const mergePaths = paths.slice(opts.edits, opts.edits + opts.merges);
        for (const p of mergePaths) {
            await A.userEdit(p, setLine(A.read(p)!, "A", "merge-A"));
            await B.userEdit(p, setLine(B.read(p)!, "B", "merge-B"));
        }
        await advance(1);
        await measure("A: push (before merge)", () => sync(A));
        await measure("B: auto-merge + push", () => sync(B));
        await measure("A: pull merged", () => sync(A));

        // ── One note at a time: what a day of writing looks like ──
        // The fixed cost of a sync shows here (locks, index, device record), not in the bulk phases.
        for (let k = 0; k < 2; k++) {
            const p = paths[opts.edits + opts.merges];
            await A.userEdit(p, setLine(A.read(p)!, "A", `single-${k}`));
            await advance(1);
            await measure(`A: push 1 edit #${k + 1}`, () => sync(A));
            await measure(`B: pull 1 edit #${k + 1}`, () => sync(B));
        }
        await A.userCreate(SINGLE_NEW_NOTE, note(opts.notes));
        await advance(1);
        await measure("A: push 1 new note", () => sync(A));
        await measure("B: pull 1 new note", () => sync(B));

        // ── Idle ──
        await measure("A: idle", () => sync(A));
        await measure("B: idle", () => sync(B));
        // What the app does while open: the timer, with nothing new anywhere
        await measure("A: idle timer", () => A.startSync("timer-sync", false));
        await measure("B: idle timer", () => B.startSync("timer-sync", false));

        // ── Correctness ──
        const user = (d: SimDevice) =>
            Object.fromEntries(Object.entries(d.userFiles()).filter(([p]) => !isInternalPath(p)));
        const fa = user(A);
        const fb = user(B);
        const cloudFiles = await cloud.snapshot(isInternalPath);
        for (const [label, files] of [
            ["A", fa],
            ["B", fb],
        ] as const) {
            const conflicts = Object.keys(files).filter((p) => p.includes("(Conflict"));
            if (conflicts.length) problems.push(`${label} has conflict copies: ${conflicts.join(", ")}`);
            for (const p of new Set([...Object.keys(files), ...Object.keys(cloudFiles)])) {
                if (files[p] !== cloudFiles[p]) problems.push(`${label} differs from cloud at ${p}`);
            }
            if (Object.keys(files).length !== opts.notes + opts.binaries + 1)
                problems.push(`${label} has ${Object.keys(files).length} files`);
        }
        for (const p of mergePaths) {
            const c = cloudFiles[p] ?? "";
            if (!c.includes("A: merge-A") || !c.includes("B: merge-B")) problems.push(`merge lost an edit in ${p}`);
        }
        for (let i = 0; i < opts.edits; i++) {
            if (!(cloudFiles[paths[i]] ?? "").includes(`A: edit-${i}`)) problems.push(`edit lost in ${paths[i]}`);
        }
        for (const d of devices) {
            if (d.syncErrors.length) problems.push(`${d.name} sync errors: ${d.syncErrors[0]}`);
            if (d.ctx.dirtyPaths.size) problems.push(`${d.name} still dirty: ${[...d.ctx.dirtyPaths.keys()].join(",")}`);
        }
        if (problems.length && process.env.PERF_TIMELINE) process.stdout.write(timeline.join("\n") + "\n");
        return { phases, problems };
    } finally {
        for (const d of devices) d.dispose();
        randomSpy.mockRestore();
        logSpy.mockRestore();
        debugSpy.mockRestore();
        vi.useRealTimers();
    }
}

export function formatPerf(r: PerfResult): string {
    const rows = r.phases.map((p) => {
        const top = Object.entries(p.byMethod)
            .sort((a, b) => b[1] - a[1])
            .map(([m, n]) => `${m}×${n}`)
            .join(" ");
        return `${p.name.padEnd(28)} ${(p.virtualMs / 1000).toFixed(1).padStart(7)}s ${String(p.calls).padStart(5)} calls  ${top}`;
    });
    const total = r.phases.reduce((s, p) => s + p.calls, 0);
    const time = r.phases.reduce((s, p) => s + p.virtualMs, 0);
    return [...rows, `${"TOTAL".padEnd(28)} ${(time / 1000).toFixed(1).padStart(7)}s ${String(total).padStart(5)} calls`].join("\n");
}
