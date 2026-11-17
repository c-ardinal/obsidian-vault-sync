import * as obsidianModule from "obsidian";
import { normalizePath } from "obsidian";
import { ICryptoEngine } from "./interfaces";
import { toHex } from "../utils/format";
import type { IVaultOperations } from "../types/vault-operations";

// SHA-256 hash of the approved e2ee-engine.js file.
// Update via: npm run hash (in Vault-Sync-E2EE-Engine repo)
export const APPROVED_ENGINE_HASH: string =
    "e2b6e3758b768d4dbc2fe896e5830c3cec5bf8d8fd786992f35737661190fa06";

/** File name of the engine inside the plugin folder. */
export const ENGINE_FILE_NAME = "e2ee-engine.js";

/** Where users download the engine themselves (opened from the install dialog). */
export const ENGINE_RELEASE_URL =
    "https://github.com/c-ardinal/obsidian-vault-sync-e2ee-engine/releases/latest";

/**
 * Compute SHA-256 hash of content
 */
async function computeSHA256(content: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(content);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    return toHex(new Uint8Array(hashBuffer));
}

/**
 * Loads the external E2EE engine if available in the plugin directory.
 * Validates the engine hash and interface before loading.
 */
export async function loadExternalCryptoEngine(
    vault: IVaultOperations,
    pluginPath: string,
    onNotify?: (key: string) => Promise<void>,
): Promise<ICryptoEngine | null> {
    // 1. Resolve Path candidates
    // On some platforms, leading dots or different separators can be tricky
    const variations = [
        normalizePath(`${pluginPath}/${ENGINE_FILE_NAME}`),
        normalizePath(pluginPath + "/" + ENGINE_FILE_NAME),
        `${pluginPath}/${ENGINE_FILE_NAME}`.replace(/^\.\//, ""),
    ];

    // Remove duplicates
    const uniquePaths = [...new Set(variations)];
    console.log(
        `Vault-Sync: Attempting to load E2EE engine. Candidates: ${JSON.stringify(uniquePaths)}`,
    );

    let content: string | null = null;
    let successfulPath: string | null = null;

    for (const enginePath of uniquePaths) {
        try {
            if (await vault.exists(enginePath)) {
                content = await vault.read(enginePath);
                successfulPath = enginePath;
                break;
            }
        } catch (e) {
            // Ignore error for this specific path candidate
        }
    }

    if (!content) {
        console.log("Vault-Sync: E2EE engine file not found at any candidate paths.");
        return null;
    }

    console.log(`Vault-Sync: Loading engine from [${successfulPath}]...`);
    return evaluateEngine(content, onNotify);
}

/**
 * Verifies the engine source against APPROVED_ENGINE_HASH, runs it, and checks
 * that it implements every required method. Returns null on any failure.
 */
export async function evaluateEngine(
    content: string,
    onNotify?: (key: string) => Promise<void>,
): Promise<ICryptoEngine | null> {
    try {
        // Verify engine hash for security (skip in development mode)
        if (APPROVED_ENGINE_HASH !== "CHANGE_THIS_TO_ACTUAL_HASH_BEFORE_RELEASE") {
            const actualHash = await computeSHA256(content);
            if (actualHash !== APPROVED_ENGINE_HASH) {
                console.error(
                    `Vault-Sync: E2EE engine hash mismatch! Expected: ${APPROVED_ENGINE_HASH}, Got: ${actualHash}`,
                );
                if (onNotify) await onNotify("noticeEngineVerifyFailed");
                return null;
            }
        } else {
            const actualHash = await computeSHA256(content);
            console.warn("Vault-Sync: E2EE engine hash verification skipped (development mode)");
            console.warn(`Vault-Sync: Engine SHA-256: ${actualHash}`);
        }

        // Dynamic execution of the engine script as CommonJS
        const engineModule = { exports: {} as any };
        const execute = new Function("module", "exports", "require", content);

        const customRequire = (name: string) => {
            if (name === "obsidian") return obsidianModule;
            const globalRequire = (window as any).require;
            if (globalRequire) return globalRequire(name);
            console.warn(`Vault-Sync: Engine required '${name}' but no require available.`);
            return undefined;
        };

        execute(engineModule, engineModule.exports, customRequire);
        const engine = engineModule.exports.default || engineModule.exports;

        // Validate all required methods exist
        const requiredMethods = [
            "initializeNewVault",
            "unlockVault",
            "isUnlocked",
            "encrypt",
            "decrypt",
            "encryptToBlob",
            "decryptFromBlob",
            "getOptimalChunkSize",
            "isChunkedFormat",
            "encryptChunked",
            "decryptChunked",
            "calculateChunkedSize",
            "buildChunkedHeader",
            "encryptChunks",
            "showSetupModal",
            "showUnlockModal",
            "getSettingsSections",
        ];

        const missingMethods = requiredMethods.filter(
            (method) => typeof engine?.[method] !== "function",
        );

        if (missingMethods.length > 0) {
            console.error(
                `Vault-Sync: E2EE engine missing required methods: ${missingMethods.join(", ")}`,
            );
            return null;
        }

        console.log("Vault-Sync: External E2EE engine fully verified.");
        return engine;
    } catch (e) {
        console.error("Vault-Sync: Engine execution failed", e);
        return null;
    }
}

export type EngineInstallResult =
    | { ok: true; engine: ICryptoEngine }
    | { ok: false; reason: "hash-mismatch" | "invalid" | "write-failed" };

/**
 * Installs an engine file the user picked themselves.
 *
 * The file is only written to the plugin folder after it matches
 * APPROVED_ENGINE_HASH and loads correctly, so a wrong or tampered file never
 * lands on disk. Nothing is downloaded here: the user downloads the engine on
 * their own and chooses to install it, which keeps E2EE an explicit opt-in.
 */
export async function installEngineFromContent(
    vault: IVaultOperations,
    pluginPath: string,
    content: string,
): Promise<EngineInstallResult> {
    if (APPROVED_ENGINE_HASH !== "CHANGE_THIS_TO_ACTUAL_HASH_BEFORE_RELEASE") {
        const actualHash = await computeSHA256(content);
        if (actualHash !== APPROVED_ENGINE_HASH) {
            console.error(
                `Vault-Sync: Picked engine file hash mismatch. Expected: ${APPROVED_ENGINE_HASH}, Got: ${actualHash}`,
            );
            return { ok: false, reason: "hash-mismatch" };
        }
    }

    const engine = await evaluateEngine(content);
    if (!engine) return { ok: false, reason: "invalid" };

    try {
        await vault.write(normalizePath(`${pluginPath}/${ENGINE_FILE_NAME}`), content);
    } catch (e) {
        console.error("Vault-Sync: Failed to save the engine file", e);
        return { ok: false, reason: "write-failed" };
    }
    return { ok: true, engine };
}
