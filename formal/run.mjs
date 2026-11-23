#!/usr/bin/env node
/**
 * Model-check every TLA+ model in formal/tla with TLC.
 *
 * Each model has one configuration of the current code, which must pass, and
 * configurations of earlier code or rejected designs, which must break the
 * named property. A model that stops finding a known bug has lost its teeth,
 * so both directions count.
 *
 * Usage: node formal/run.mjs [name-filter]
 * Needs Java 11+. Downloads the pinned tla2tools.jar into formal/.cache.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TLA_VERSION = "v1.7.4";
const JAR_URL = `https://github.com/tlaplus/tlaplus/releases/download/${TLA_VERSION}/tla2tools.jar`;
const JAR_SHA256 = "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88";

/** expect: "pass", or the properties of which one must be violated */
const RUNS = [
    { spec: "Auth", cfg: "Auth", expect: "pass" },
    { spec: "Auth", cfg: "AuthLegacy", expect: ["SignedOutStaysOut", "NoMixedTokens"] },
    { spec: "Migration", cfg: "Migration", expect: "pass" },
    { spec: "Migration", cfg: "MigrationPR43", expect: ["NoResurrection", "NoLostEdit"] },
    { spec: "Migration", cfg: "MigrationLegacy", expect: ["NoLostEdit", "NoResurrection"] },
    { spec: "CloudRetry", cfg: "CloudRetry", expect: "pass" },
    { spec: "CloudRetry", cfg: "CloudRetryBlind", expect: ["NoDuplicate"] },
    { spec: "CloudRetry", cfg: "CloudRetryName", expect: ["OwnResult"] },
    { spec: "SyncProtocol", cfg: "SyncProtocol", expect: "pass" },
    { spec: "SyncProtocol", cfg: "SyncProtocolNoLock", expect: "pass" },
    { spec: "SyncProtocol", cfg: "SyncProtocolNoCheck", expect: ["NoLostEdit"] },
    { spec: "SyncProtocol", cfg: "SyncProtocolLock", expect: ["LockExclusive"] },
];

const here = dirname(fileURLToPath(import.meta.url));
const tlaDir = join(here, "tla");

async function jar() {
    const path = join(here, ".cache", `tla2tools-${TLA_VERSION}.jar`);
    if (!existsSync(path)) {
        mkdirSync(dirname(path), { recursive: true });
        const res = await fetch(JAR_URL);
        if (!res.ok) throw new Error(`Download of ${JAR_URL} failed: ${res.status}`);
        writeFileSync(path, Buffer.from(await res.arrayBuffer()));
    }
    const sha = createHash("sha256").update(readFileSync(path)).digest("hex");
    if (sha !== JAR_SHA256) {
        rmSync(path);
        throw new Error(`tla2tools.jar checksum mismatch (${sha})`);
    }
    return path;
}

function check(jarPath, run) {
    const meta = mkdtempSync(join(tmpdir(), "tlc-"));
    const started = Date.now();
    const r = spawnSync(
        "java",
        ["-XX:+UseParallelGC", "-cp", jarPath, "tlc2.TLC", "-workers", "auto", "-deadlock",
            "-metadir", meta, "-config", `${run.cfg}.cfg`, `${run.spec}.tla`],
        { cwd: tlaDir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    rmSync(meta, { recursive: true, force: true });
    // Trace files TLC writes next to the spec on a violation
    for (const f of readdirSync(tlaDir)) if (f.includes("_TTrace_")) rmSync(join(tlaDir, f));
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    const states = [...out.matchAll(/([\d,]+) distinct states found/g)].pop()?.[1] ?? "?";
    const violated = /(?:Invariant|Temporal property) (\w+) (?:is|was) violated/.exec(out)?.[1];
    const passed = out.includes("Model checking completed. No error has been found.");
    let ok;
    let what;
    if (run.expect === "pass") {
        ok = passed;
        what = passed ? `no error, ${states} states` : violated ? `${violated} violated` : "TLC failed";
    } else {
        ok = !!violated && run.expect.includes(violated);
        what = violated ? `${violated} violated (expected)` : passed ? "no error, but a violation was expected" : "TLC failed";
    }
    console.log(`${ok ? "ok  " : "FAIL"} ${run.cfg.padEnd(22)} ${what} (${secs}s)`);
    if (!ok) console.log(out);
    return ok;
}

const filter = process.argv[2];
const jarPath = await jar();
let failed = 0;
for (const run of RUNS) {
    if (filter && !run.cfg.includes(filter)) continue;
    if (!check(jarPath, run)) failed++;
}
if (failed) {
    console.error(`${failed} model check(s) did not give the expected result.`);
    process.exit(1);
}
