import { MasterKeyManager } from "../../e2ee-engine/src/encryption/key-manager";
import { ICryptoEngine } from "./interfaces";

/**
 * Methods the sync code calls on the engine. Checked at startup so that a
 * mismatched engine revision fails loudly instead of halfway through a sync.
 */
export const REQUIRED_ENGINE_METHODS = [
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
] as const;

/** Returns the names of required methods the engine does not implement. */
export function findMissingEngineMethods(engine: unknown): string[] {
    const candidate = engine as Record<string, unknown> | null | undefined;
    return REQUIRED_ENGINE_METHODS.filter((m) => typeof candidate?.[m] !== "function");
}

/**
 * Creates the E2EE engine.
 *
 * The engine (c-ardinal/obsidian-vault-sync-e2ee-engine) is bundled into
 * main.js from the `e2ee-engine` git submodule, pinned to a reviewed commit.
 * Users no longer copy an `e2ee-engine.js` file into the plugin folder, and
 * nothing is downloaded or evaluated at runtime. Creating the engine does not
 * turn encryption on: that still needs the "start encryption" command, or an
 * existing remote vault-lock file.
 */
export function createCryptoEngine(
    factory: () => unknown = () => new MasterKeyManager(),
): ICryptoEngine | null {
    try {
        const engine = factory();
        const missing = findMissingEngineMethods(engine);
        if (missing.length > 0) {
            console.error(
                `Vault-Sync: E2EE engine missing required methods: ${missing.join(", ")}`,
            );
            return null;
        }
        return engine as ICryptoEngine;
    } catch (e) {
        console.error("Vault-Sync: E2EE engine initialization failed", e);
        return null;
    }
}
