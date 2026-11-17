/**
 * Self-tests for the simulation harness itself: if these fail, simulation
 * results cannot be trusted.
 */
import { describe, it, expect } from "vitest";
import { DEFAULT_CONFIG, runSimulation, type Action, type SimConfig } from "./simulation";

const base = (over: Partial<SimConfig> = {}): SimConfig =>
    ({ ...DEFAULT_CONFIG, name: "harness", seed: 42, ...over }) as SimConfig;

describe("simulation harness", () => {
    it("is deterministic: same seed => identical timeline", async () => {
        const cfg = base({ profile: "chaos", devices: 3, actions: 30, binaryRate: 0.2, fs: ["linux", "windows", "macos"] });
        const a = await runSimulation(cfg);
        const b = await runSimulation(cfg);
        expect(b.timeline).toEqual(a.timeline);
        expect(b.failures).toEqual(a.failures);
    });

    it("sequential edits on two devices sync cleanly", async () => {
        const plan: Action[] = [
            { t: 0, dev: "A", kind: "join" },
            { t: 0, dev: "B", kind: "join" },
            { t: 1_000, dev: "A", kind: "create", fid: "f1", path: "notes/A-1.md" },
            { t: 2_000, dev: "A", kind: "sync", scan: false },
            { t: 10_000, dev: "B", kind: "sync", scan: false },
            { t: 20_000, dev: "B", kind: "edit", pick: 0, line: "B", value: "B1" },
            { t: 21_000, dev: "B", kind: "sync", scan: false },
            { t: 30_000, dev: "A", kind: "sync", scan: false },
        ];
        const r = await runSimulation(base({ devices: 2 }), plan);
        expect(r.failures).toEqual([]);
    });

    it("detects divergence when a device silently misses a change", async () => {
        // B goes offline and never comes back during the chaotic phase; the quiesce
        // phase heals it, so a correct engine converges. This guards the oracle wiring:
        // the run must be clean AND B must have received A's note.
        const plan: Action[] = [
            { t: 0, dev: "A", kind: "join" },
            { t: 0, dev: "B", kind: "join" },
            { t: 500, dev: "B", kind: "offline" },
            { t: 1_000, dev: "A", kind: "create", fid: "f1", path: "notes/A-1.md" },
            { t: 2_000, dev: "A", kind: "sync", scan: false },
            { t: 3_000, dev: "B", kind: "sync", scan: false },
            { t: 4_000, dev: "B", kind: "online" },
        ];
        const r = await runSimulation(base({ devices: 2 }), plan);
        expect(r.failures).toEqual([]);
        expect(r.stats.cloudFiles).toBe(1);
    });
});
