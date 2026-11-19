#!/usr/bin/env node
/**
 * Download and unpack the official Obsidian desktop app (Linux x64 AppImage)
 * for the real-app UI checks in e2e/obsidian/run.mjs.
 *
 *   OBSIDIAN_VERSION   version to fetch (default: latestVersion of desktop-releases.json)
 *   OBSIDIAN_CACHE_DIR where to unpack (default: .obsidian-cache/)
 *
 * Prints the path of the unpacked executable on the last line of stdout.
 * Linux only: the AppImage is unpacked with --appimage-extract (no FUSE needed).
 */
import { execFileSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, chmodSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const RELEASES_JSON =
    "https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/desktop-releases.json";

async function resolveVersion() {
    if (process.env.OBSIDIAN_VERSION) return process.env.OBSIDIAN_VERSION.replace(/^v/, "");
    const res = await fetch(RELEASES_JSON);
    if (!res.ok) throw new Error(`desktop-releases.json: HTTP ${res.status}`);
    const json = await res.json();
    return json.latestVersion;
}

async function download(url, dest) {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

async function main() {
    if (process.platform !== "linux") {
        throw new Error("setup-obsidian.mjs supports Linux only (CI runs on ubuntu-latest).");
    }
    const version = await resolveVersion();
    const cacheDir = resolve(process.env.OBSIDIAN_CACHE_DIR || ".obsidian-cache");
    const appDir = join(cacheDir, `obsidian-${version}`);
    const exe = join(appDir, "obsidian");

    if (!existsSync(exe)) {
        mkdirSync(cacheDir, { recursive: true });
        const appImage = join(cacheDir, `Obsidian-${version}.AppImage`);
        const url = `https://github.com/obsidianmd/obsidian-releases/releases/download/v${version}/Obsidian-${version}.AppImage`;
        console.error(`Downloading ${url}`);
        await download(url, appImage);
        chmodSync(appImage, 0o755);
        console.error("Unpacking AppImage");
        rmSync(join(cacheDir, "squashfs-root"), { recursive: true, force: true });
        execFileSync(appImage, ["--appimage-extract"], { cwd: cacheDir, stdio: "ignore" });
        rmSync(appDir, { recursive: true, force: true });
        execFileSync("mv", [join(cacheDir, "squashfs-root"), appDir]);
        rmSync(appImage, { force: true });
    }
    console.error(`Obsidian ${version} ready`);
    console.log(exe);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
