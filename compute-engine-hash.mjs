import fs from "fs";
import crypto from "crypto";

const enginePath = process.argv[2] || "./dist/obsidian-vault-sync/e2ee-engine.js";

try {
    if (!fs.existsSync(enginePath)) {
        console.error(`[E2EE] Engine file not found: ${enginePath}`);
        console.error("Usage: node compute-engine-hash.mjs [path-to-e2ee-engine.js]");
        process.exit(1);
    }

    const content = fs.readFileSync(enginePath, "utf8");
    const hash = crypto.createHash("sha256").update(content, "utf8").digest("hex");

    console.log(`[E2EE] Engine file: ${enginePath}`);
    console.log(`[E2EE] SHA-256 hash: ${hash}`);
    console.log("");
    console.log("To apply, update src/encryption/engine-loader.ts:");
    console.log(`  const APPROVED_ENGINE_HASH = "${hash}";`);
} catch (err) {
    console.error("[E2EE] Failed to compute hash:", err);
    process.exit(1);
}
