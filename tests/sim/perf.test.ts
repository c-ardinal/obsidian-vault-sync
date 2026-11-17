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

        // Regression budgets (measured: ~520 calls in total, ~113 for the merge phase).
        // Before the optimisation these were ~900 and ~340.
        const total = r.phases.reduce((n, p) => n + p.calls, 0);
        const merge = r.phases.find((p) => p.name.startsWith("B: auto-merge"))!;
        expect(total).toBeLessThanOrEqual(600);
        expect(merge.calls).toBeLessThanOrEqual(150);
        for (const p of r.phases.filter((p) => p.name.includes("idle"))) {
            expect(p.calls).toBeLessThanOrEqual(8);
        }
    });
});
