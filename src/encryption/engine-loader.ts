import * as obsidianModule from "obsidian";
import { normalizePath } from "obsidian";
import { ICryptoEngine } from "./interfaces";
import { APPROVED_ADDONS } from "../addons/approved-addons";
import { toHex } from "../utils/format";
import type { IVaultOperations } from "../types/vault-operations";

// SHA-256 hash of the approved engine file, pinned in the add-on registry.
// Update via the add-on's `npm run build` output (src/addons/approved-addons.ts).
export const APPROVED_ENGINE_HASH: string = (() => {
    const addon = APPROVED_ADDONS.find((a) => a.kind === "crypto-engine")!;
    return addon.files[addon.installAs];
})();

/** Entry-file hashes of earlier approved releases (outdated, not tampered). */
const RETIRED_ENGINE_HASHES: ReadonlySet<string> = new Set(
    APPROVED_ADDONS.find((a) => a.kind === "crypto-engine")?.retiredEntryHashes ?? [],
);

/** File name of the engine inside the plugin folder. */
export const ENGINE_FILE_NAME = "e2ee-engine.js";

/**
 * Compute SHA-256 hash of content
 */
async function computeSHA256(content: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(content);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    return toHex(new Uint8Array(hashBuffer));
}

type CommonJsFactory = (
    module: unknown,
    exports: unknown,
    require: (name: string) => unknown,
) => void;

/**
 * Turns a CommonJS script into a function of (module, exports, require) by
 * importing it as an ES module from a data: URL. The source is the add-on file
 * whose SHA-256 the caller has already checked against the approved hash.
 * A data: URL rather than a blob: URL because both Obsidian and Node (tests)
 * can import it.
 */
async function importCommonJsModule(source: string): Promise<CommonJsFactory> {
    const wrapped = `export default function (module, exports, require) {\n${source}\n}\n`;
    const url = `data:text/javascript;charset=utf-8,${encodeURIComponent(wrapped)}`;
    // eslint-disable-next-line no-unsanitized/method -- the module is the add-on file the caller verified against APPROVED_ENGINE_HASH
    const mod = (await import(url)) as { default: CommonJsFactory };
    return mod.default;
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
    console.debug(
        `Vault Syncer: Attempting to load E2EE engine. Candidates: ${JSON.stringify(uniquePaths)}`,
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
        } catch {
            // Ignore error for this specific path candidate
        }
    }

    if (!content) {
        console.debug("Vault Syncer: E2EE engine file not found at any candidate paths.");
        return null;
    }

    console.debug(`Vault Syncer: Loading engine from [${successfulPath}]...`);
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
                    `Vault Syncer: E2EE engine hash mismatch! Expected: ${APPROVED_ENGINE_HASH}, Got: ${actualHash}`,
                );
                if (onNotify) {
                    await onNotify(
                        RETIRED_ENGINE_HASHES.has(actualHash)
                            ? "noticeAddonUpdateRequired"
                            : "noticeEngineVerifyFailed",
                    );
                }
                return null;
            }
        } else {
            const actualHash = await computeSHA256(content);
            console.warn("Vault Syncer: E2EE engine hash verification skipped (development mode)");
            console.warn(`Vault Syncer: Engine SHA-256: ${actualHash}`);
        }

        // Run the engine script (CommonJS) as a module: wrapped in an ES module
        // whose default export takes module / exports / require.
        const engineModule: { exports: { default?: unknown } } = { exports: {} };
        const execute = await importCommonJsModule(content);

        const customRequire = (name: string): unknown => {
            if (name === "obsidian") return obsidianModule;
            const globalRequire = (window as unknown as { require?: (name: string) => unknown })
                .require;
            if (globalRequire) return globalRequire(name);
            console.warn(`Vault Syncer: Engine required '${name}' but no require available.`);
            return undefined;
        };

        execute(engineModule, engineModule.exports, customRequire);
        const engine = (engineModule.exports.default || engineModule.exports) as
            | Record<string, unknown>
            | undefined;

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
                `Vault Syncer: E2EE engine missing required methods: ${missingMethods.join(", ")}`,
            );
            return null;
        }

        console.debug("Vault Syncer: External E2EE engine fully verified.");
        return engine as unknown as ICryptoEngine;
    } catch (e) {
        console.error("Vault Syncer: Engine execution failed", e);
        return null;
    }
}

/**
 * Removes the installed engine file. The caller must also detach the engine
 * from the sync manager.
 */
export async function removeInstalledEngine(
    vault: IVaultOperations,
    pluginPath: string,
): Promise<void> {
    const path = normalizePath(`${pluginPath}/${ENGINE_FILE_NAME}`);
    if (await vault.exists(path)) await vault.remove(path);
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
                `Vault Syncer: Picked engine file hash mismatch. Expected: ${APPROVED_ENGINE_HASH}, Got: ${actualHash}`,
            );
            return { ok: false, reason: "hash-mismatch" };
        }
    }

    const engine = await evaluateEngine(content);
    if (!engine) return { ok: false, reason: "invalid" };

    try {
        await vault.write(normalizePath(`${pluginPath}/${ENGINE_FILE_NAME}`), content);
    } catch (e) {
        console.error("Vault Syncer: Failed to save the engine file", e);
        return { ok: false, reason: "write-failed" };
    }
    return { ok: true, engine };
}
