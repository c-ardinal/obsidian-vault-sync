import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { DEFAULT_PERF, formatPerf, runPerf } from "./perf";
import { reportDir } from "./simulation";

describe("sync performance benchmark", () => {
    it("converges and reports per-phase time / API calls", async () => {
        const r = await runPerf(DEFAULT_PERF);
        const table = formatPerf(r);
        const dir = reportDir();
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "perf.txt"), table + "\n" + r.problems.join("\n") + "\n");
        writeFileSync(join(dir, "perf.json"), JSON.stringify(r, null, 2));
        expect(r.problems).toEqual([]);

        // Regression budgets (measured: ~685 calls in total, ~155 for the merge phase).
        // Before the optimisation these were ~900 and ~340. Since then the overwrite guard
        // (one listRevisions after each update of an existing note) added ~75 calls, the
        // second by-name lookup right before creating a new note (it catches another
        // device creating the same name meanwhile) ~65, and
        // pulling past empty Changes pages (which the benchmark had silently skipped,
        // leaving B without A's edits) added ~40.
        const single = (p: { name: string }) => /: (push|pull) 1 /.test(p.name);
        const total = r.phases.filter((p) => !single(p)).reduce((n, p) => n + p.calls, 0);
        const merge = r.phases.find((p) => p.name.startsWith("B: auto-merge"))!;
        expect(total).toBeLessThanOrEqual(720);
        expect(merge.calls).toBeLessThanOrEqual(170);
        // Nothing new: the two locks and the change feed. This device's own record,
        // written after its last push, must not cost a read of the merge locks or the index.
        for (const p of r.phases.filter((p) => p.name.includes("idle"))) {
            expect(p.calls).toBeLessThanOrEqual(4);
        }
        // One changed note: the fixed cost of a sync. Measured 18-19 calls / 3.2-3.4 s to push and
        // 9 calls / 1.6 s to pull (0.18.2: 15 / 3.0 s and 8 / 1.6 s; before the device
        // record stopped causing extra reads: 20 / 4.0 s and 9 / 1.8 s).
        for (const p of r.phases.filter((p) => p.name.startsWith("A: push 1 "))) {
            expect(p.calls).toBeLessThanOrEqual(19);
            expect(p.virtualMs).toBeLessThanOrEqual(3500);
        }
        for (const p of r.phases.filter((p) => p.name.startsWith("B: pull 1 "))) {
            expect(p.calls).toBeLessThanOrEqual(9);
            expect(p.virtualMs).toBeLessThanOrEqual(1700);
        }
        // A timer sync with nothing new reads only the change feed
        for (const p of r.phases.filter((p) => p.name.endsWith("idle timer"))) {
            expect(p.byMethod).toEqual({ getChanges: 1 });
        }
    });
});
