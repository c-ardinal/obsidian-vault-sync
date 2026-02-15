import * as obsidianModule from "obsidian";
import { App, Notice, normalizePath } from "obsidian";
import { ICryptoEngine } from "./interfaces";

// SHA-256 hash of the approved e2ee-engine.js file
// This must be updated when the engine is updated
const APPROVED_ENGINE_HASH = "CHANGE_THIS_TO_ACTUAL_HASH_BEFORE_RELEASE";

/**
 * Compute SHA-256 hash of content
 */
async function computeSHA256(content: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(content);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Loads the external E2EE engine if available in the plugin directory.
 * Validates the engine hash and interface before loading.
 */
export async function loadExternalCryptoEngine(
    app: App,
    pluginPath: string,
): Promise<ICryptoEngine | null> {
    // 1. Resolve Path candidates
    // On some platforms, leading dots or different separators can be tricky
    const variations = [
        normalizePath(`${pluginPath}/e2ee-engine.js`),
        normalizePath(pluginPath + "/e2ee-engine.js"),
        `${pluginPath}/e2ee-engine.js`.replace(/^\.\//, ""),
    ];

    // Remove duplicates
    const uniquePaths = [...new Set(variations)];
    console.log(
        `VaultSync: Attempting to load E2EE engine. Candidates: ${JSON.stringify(uniquePaths)}`,
    );

    let content: string | null = null;
    let successfulPath: string | null = null;

    for (const enginePath of uniquePaths) {
        try {
            if (await app.vault.adapter.exists(enginePath)) {
                content = await app.vault.adapter.read(enginePath);
                successfulPath = enginePath;
                break;
            }
        } catch (e) {
            // Ignore error for this specific path candidate
        }
    }

    if (!content) {
        console.log("VaultSync: E2EE engine file not found at any candidate paths.");
        return null;
    }

    try {
        console.log(`VaultSync: Loading engine from [${successfulPath}]...`);

        // Verify engine hash for security (skip in development mode)
        if (APPROVED_ENGINE_HASH !== "CHANGE_THIS_TO_ACTUAL_HASH_BEFORE_RELEASE") {
            const actualHash = await computeSHA256(content);
            if (actualHash !== APPROVED_ENGINE_HASH) {
                console.error(`VaultSync: E2EE engine hash mismatch! Expected: ${APPROVED_ENGINE_HASH}, Got: ${actualHash}`);
                new Notice("E2EE engine verification failed. Please reinstall the plugin.", 10000);
                return null;
            }
        } else {
            console.warn("VaultSync: E2EE engine hash verification skipped (development mode)");
        }

        // Dynamic execution of the engine script as CommonJS
        const engineModule = { exports: {} as any };
        const execute = new Function("module", "exports", "require", content);

        const customRequire = (name: string) => {
            if (name === "obsidian") return obsidianModule;
            const globalRequire = (window as any).require;
            if (globalRequire) return globalRequire(name);
            console.warn(`VaultSync: Engine required '${name}' but no require available.`);
            return undefined;
        };

        execute(engineModule, engineModule.exports, customRequire);
        const engine = engineModule.exports.default || engineModule.exports;

        // Validate all required methods exist
        const requiredMethods = [
            'initializeNewVault', 'unlockVault', 'isUnlocked',
            'encrypt', 'decrypt', 'showSetupModal',
            'showUnlockModal', 'getSettingsSections'
        ];

        const missingMethods = requiredMethods.filter(method =>
            typeof engine?.[method] !== 'function'
        );

        if (missingMethods.length > 0) {
            console.error(`VaultSync: E2EE engine missing required methods: ${missingMethods.join(', ')}`);
            return null;
        }

        console.log("VaultSync: External E2EE engine fully verified.");
        return engine;
    } catch (e) {
        console.error("VaultSync: Engine execution failed", e);
        return null;
    }
}
