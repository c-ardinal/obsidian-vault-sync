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
        const total = r.phases.reduce((n, p) => n + p.calls, 0);
        const merge = r.phases.find((p) => p.name.startsWith("B: auto-merge"))!;
        expect(total).toBeLessThanOrEqual(720);
        expect(merge.calls).toBeLessThanOrEqual(170);
        for (const p of r.phases.filter((p) => p.name.includes("idle"))) {
            expect(p.calls).toBeLessThanOrEqual(8);
        }
    });
});
