import fs from "fs";
import crypto from "crypto";

const manifestPath = "./manifest.json";

try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

    // Generate timestamp YYYYMMDDHHmmssSSS
    const now = new Date();
    const timestamp =
        now.getFullYear().toString() +
        (now.getMonth() + 1).toString().padStart(2, "0") +
        now.getDate().toString().padStart(2, "0") +
        now.getHours().toString().padStart(2, "0") +
        now.getMinutes().toString().padStart(2, "0") +
        now.getSeconds().toString().padStart(2, "0") +
        now.getMilliseconds().toString().padStart(3, "0");

    // Hash the timestamp (SHA-256, first 8 chars)
    const hash = crypto.createHash("sha256").update(timestamp).digest("hex").substring(0, 8);

    // Get base version (remove previous build metadata or prerelease tags if any)
    // We assume the version follows SemVer-ish or just simple dots.
    // We split by + or - to get the root version.
    const baseVersion = manifest.version.split("_")[0].split("-")[0];

    // Append hash as build metadata (using + per SemVer)
    manifest.version = `${baseVersion}_${hash}`;

    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 4) + "\n");
    console.log(
        `[Build] Updated manifest.json version: ${manifest.version} (Hash source: ${timestamp})`,
    );
} catch (err) {
    console.error("[Build] Failed to update manifest version:", err);
    process.exit(1);
}
