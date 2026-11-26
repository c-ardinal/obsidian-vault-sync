#!/usr/bin/env node
/**
 * Puts the add-on package this checkout approves into .addon-pkg/.
 *
 * The package is built from the add-on's source at the commit named in
 * src/addons/approved-addons.ts (`source`), then checked against the hashes
 * pinned there. Nothing is taken from the add-on's releases, so the checks do
 * not depend on which release is the latest, or on whether one exists yet.
 *
 * A package already in .addon-pkg/ that matches the pinned hashes is kept (the
 * CI cache), so the build only runs when the pin changes.
 *
 * Output: .addon-pkg/<id>.zip and .addon-pkg/<installAs>; on GitHub Actions also
 * ADDON_ZIP and ADDON_ENGINE_JS for the later steps.
 *
 * Env:
 *   ADDON_SOURCE_URL  where to fetch the source from (a URL or a local clone)
 *                     instead of https://github.com/<source.repo>.git
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PIN_FILE = "src/addons/approved-addons.ts";
const OUT = path.join(ROOT, ".addon-pkg");

function fail(message) {
    console.error(`[add-on] ${message}`);
    process.exit(1);
}

/** Reads the one pinned add-on from approved-addons.ts (plain text, no TypeScript loader). */
function readPin() {
    const text = fs.readFileSync(path.join(ROOT, PIN_FILE), "utf8");
    const one = (name, re) => {
        const found = [...text.matchAll(re)];
        if (found.length !== 1) fail(`${PIN_FILE}: expected one ${name}, found ${found.length}`);
        return found[0][1];
    };
    const files = {};
    for (const m of one("files block", /\n\s*files: \{([^}]*)\}/g).matchAll(/"([^"]+)":\s*"([0-9a-f]{64})"/g)) {
        files[m[1]] = m[2];
    }
    if (Object.keys(files).length === 0) fail(`${PIN_FILE}: no pinned file hashes`);
    return {
        id: one("id", /\n\s*id: "([^"]+)"/g),
        installAs: one("installAs", /\n\s*installAs: "([^"]+)"/g),
        repo: one("source.repo", /\n\s*repo: "([\w.-]+\/[\w.-]+)"/g),
        commit: one("source.commit", /\n\s*commit: "([0-9a-f]{40})"/g),
        files,
    };
}

/** The pinned files a package gets wrong, as readable lines; empty when it matches. */
function mismatches(zipPath, pin) {
    let entries;
    try {
        entries = unzipSync(fs.readFileSync(zipPath));
    } catch (e) {
        return [`${path.basename(zipPath)} cannot be read: ${e.message}`];
    }
    const lines = [];
    for (const [name, expected] of Object.entries(pin.files)) {
        const actual = entries[name] ? crypto.createHash("sha256").update(entries[name]).digest("hex") : "missing";
        if (actual !== expected) lines.push(`${name}: pinned ${expected}, built ${actual}`);
    }
    return lines;
}

function run(cmd, args, cwd) {
    execFileSync(cmd, args, { cwd, stdio: ["ignore", process.stderr, process.stderr] });
}

function build(pin, zipPath) {
    const url = process.env.ADDON_SOURCE_URL || `https://github.com/${pin.repo}.git`;
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "approved-addon-"));
    try {
        console.error(`[add-on] building ${pin.repo}@${pin.commit}`);
        run("git", ["init", "-q"], work);
        run("git", ["fetch", "-q", "--depth", "1", url, pin.commit], work);
        run("git", ["checkout", "-q", "FETCH_HEAD"], work);
        run("npm", ["ci", "--no-audit", "--no-fund"], work);
        run("npm", ["run", "build"], work);
        fs.mkdirSync(OUT, { recursive: true });
        fs.copyFileSync(path.join(work, "dist", `${pin.id}.zip`), zipPath);
    } finally {
        fs.rmSync(work, { recursive: true, force: true });
    }
}

const pin = readPin();
const zipPath = path.join(OUT, `${pin.id}.zip`);
const entryPath = path.join(OUT, pin.installAs);

if (fs.existsSync(zipPath) && mismatches(zipPath, pin).length === 0) {
    console.error(`[add-on] kept ${path.relative(ROOT, zipPath)} (matches the pinned hashes)`);
} else {
    build(pin, zipPath);
    const wrong = mismatches(zipPath, pin);
    if (wrong.length > 0) {
        fail(
            `the package built from ${pin.repo}@${pin.commit} is not the one pinned in ${PIN_FILE}:\n` +
                wrong.map((l) => `  ${l}`).join("\n") +
                `\nUpdate source.commit and the file hashes there together.`,
        );
    }
}
fs.writeFileSync(entryPath, unzipSync(fs.readFileSync(zipPath))[pin.installAs]);

if (process.env.GITHUB_ENV) {
    fs.appendFileSync(process.env.GITHUB_ENV, `ADDON_ZIP=${zipPath}\nADDON_ENGINE_JS=${entryPath}\n`);
}
console.log(zipPath);
