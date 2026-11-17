#!/usr/bin/env node
// Summarize multi-device simulation reports (test-results/sim/*.json) as Markdown.
// Usage: node tests/sim/summarize.mjs [reportDir] >> "$GITHUB_STEP_SUMMARY"
import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";

const dir = process.argv[2] || process.env.SIM_REPORT_DIR || "test-results/sim";
const title = process.env.SIM_SUMMARY_TITLE || "Multi-device sync simulation";
const files = existsSync(dir)
    ? readdirSync(dir).filter((f) => f.endsWith(".json") && !f.includes("min-plan") && !f.startsWith("known-"))
    : [];

const out = [`### ${title}`, ""];
if (files.length === 0) {
    out.push("✅ No failing seeds.");
    console.log(out.join("\n"));
    process.exit(0);
}

const rows = [];
const kinds = {};
for (const f of files.sort()) {
    const r = JSON.parse(readFileSync(join(dir, f), "utf8"));
    const ks = [...new Set(r.failures.map((x) => x.kind))];
    ks.forEach((k) => (kinds[k] = (kinds[k] || 0) + 1));
    rows.push(
        `| ${r.config.name} | ${r.config.seed} | ${ks.join(", ")} | ${r.failures[0].message.replace(/\|/g, "\\|").slice(0, 140)} | \`${r.replay}\` |`,
    );
}
out.push(`❌ ${files.length} failing run(s). Download the **sim-reports** artifact for full timelines (\`*.log\`) and state dumps (\`*.json\`).`, "");
out.push("| Failure kind | Runs |", "|---|---|");
for (const [k, n] of Object.entries(kinds).sort((a, b) => b[1] - a[1])) out.push(`| ${k} | ${n} |`);
out.push("", "| Scenario | Seed | Kinds | First failure | Replay locally |", "|---|---|---|---|---|");
out.push(...rows.slice(0, 50));
if (rows.length > 50) out.push(`| … | | | ${rows.length - 50} more | |`);
console.log(out.join("\n"));
