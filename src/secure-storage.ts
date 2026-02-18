import { App, Platform, normalizePath } from "obsidian";
import { toHex } from "./utils/format";

const IV_LENGTH = 12;
const SALT_LENGTH = 16;
const ALGORITHM = "AES-GCM";

export class SecureStorage {
    private keyCache: Map<string, CryptoKey> = new Map(); // Cache keys by salt
    private filePath: string;
    private legacyFilePath = ".sync-state";

    private vaultHash: string;
    private secretId: string;

    constructor(
        private app: App,
        pluginDir: string,
        private secret: string,
    ) {
        this.filePath = normalizePath(`${pluginDir}/data/local/.sync-state`);

        // Generate a stable, alphanumeric ID based on vault name hash
        const name = this.app.vault.getName();
        let hash = 0;
        for (let i = 0; i < name.length; i++) {
            const char = name.charCodeAt(i);
            hash = (hash << 5) - hash + char;
            hash |= 0; // Convert to 32bit integer
        }
        const vaultHash = Math.abs(hash).toString(36);
        this.vaultHash = vaultHash;
        this.secretId = `vault-sync-creds-${vaultHash}`;
    }

    /**
     * Update the master secret used for file-based encryption
     */
    public setMasterSecret(secret: string) {
        this.secret = secret;
        this.keyCache.clear();
    }

    private getSecretIdFor(type: string): string {
        return `vault-sync-${type}-${this.vaultHash}`;
    }

    /**
     * Store an arbitrary secret in Keychain (if available)
     */
    async setExtraSecret(type: string, value: string): Promise<void> {
        if (this.app.secretStorage) {
            const id = this.getSecretIdFor(type);
            this.app.secretStorage.setSecret(id, value);
        }
    }

    /**
     * Remove an arbitrary secret from Keychain (if available)
     */
    async removeExtraSecret(type: string): Promise<void> {
        if (this.app.secretStorage) {
            const id = this.getSecretIdFor(type);
            this.app.secretStorage.setSecret(id, "");
        }
    }

    /**
     * Retrieve an arbitrary secret from Keychain (if available)
     */
    async getExtraSecret(type: string): Promise<string | null> {
        if (this.app.secretStorage) {
            const id = this.getSecretIdFor(type);
            const secret = this.app.secretStorage.getSecret(id);
            if (secret && secret.trim().length > 0) {
                return secret;
            }
        }
        return null;
    }

    private async cleanupFiles() {
        const paths = [this.filePath, this.legacyFilePath];
        for (const path of paths) {
            try {
                if (await this.app.vault.adapter.exists(path)) {
                    await this.app.vault.adapter.remove(path);
                    console.log(`[SecureStorage] Deleted redundant credential file: ${path}`);
                }
            } catch (e) {
                console.warn(`[SecureStorage] Failed to delete ${path}:`, e);
            }
        }
    }

    private async ensureDir(path: string) {
        const normalized = normalizePath(path);
        const parts = normalized.split("/");
        const dir = parts.slice(0, -1).join("/");

        // Check full parent directory first
        if (await this.app.vault.adapter.exists(dir)) return;

        console.log(`[SecureStorage] Creating directory structure for: ${dir}`);

        let currentPath = "";
        for (const part of parts.slice(0, -1)) {
            currentPath = currentPath === "" ? part : `${currentPath}/${part}`;
            const exists = await this.app.vault.adapter.exists(currentPath);
            if (!exists) {
                try {
                    await this.app.vault.createFolder(currentPath);
                    console.log(`[SecureStorage] Created folder: ${currentPath}`);
                } catch (e) {
                    // Ignore error if folder already exists (race condition)
                    // But log others
                    console.debug(`[SecureStorage] Note: Create folder ${currentPath} result:`, e);
                }
            }
        }
    }

    private hideFile(relativePath: string) {
        // Dot-files are automatically hidden on Linux/Android/Mac.
        // However, we apply system attributes where possible for extra safety.
        if (!Platform.isDesktop) return;

        const adapter = this.app.vault.adapter as any;
        if (adapter.getBasePath) {
            const basePath = adapter.getBasePath();

            // Dynamic import to avoid bundling issues on mobile
            // Use try-catch to prevent crashes if module resolution fails
            try {
                // @ts-ignore
                const cp = require("child_process");
                // SEC-006: Use spawn instead of exec to prevent command injection
                if (process.platform === "win32") {
                    // Windows: attrib +h
                    const fullPath = `${basePath}/${relativePath}`.replace(/\//g, "\\");
                    const child = cp.spawn("attrib", ["+h", fullPath]);
                    child.on("error", (err: any) => {
                        console.error("VaultSync: Failed to hide .sync-state on Windows", err);
                    });
                } else if (process.platform === "darwin") {
                    // MacOS: chflags hidden (adds redundancy to dot-prefix)
                    const fullPath = `${basePath}/${relativePath}`;
                    const child = cp.spawn("chflags", ["hidden", fullPath]);
                    child.on("error", (err: any) => {
                        console.error("VaultSync: Failed to hide .sync-state on Mac", err);
                    });
                }
            } catch (e) {
                console.warn(
                    "VaultSync: Optional file hiding failed (child_process not available)",
                    e,
                );
            }
        }
    }

    private async getKey(salt: Uint8Array): Promise<CryptoKey> {
        const saltHex = toHex(salt);
        if (this.keyCache.has(saltHex)) return this.keyCache.get(saltHex)!;

        const enc = new TextEncoder();
        const rawKey = enc.encode(this.secret);

        const importedKey = await window.crypto.subtle.importKey("raw", rawKey, "PBKDF2", false, [
            "deriveKey",
        ]);

        const key = await window.crypto.subtle.deriveKey(
            {
                name: "PBKDF2",
                salt: salt as any,
                iterations: 100000,
                hash: "SHA-256",
            },
            importedKey,
            { name: "AES-GCM", length: 256 },
            false,
            ["encrypt", "decrypt"],
        );

        this.keyCache.set(saltHex, key);
        return key;
    }

    async saveCredentials(data: Record<string, any>): Promise<void> {
        // 1. Save to Obsidian Secret Storage (Keychain) if available
        let secretStorageSuccess = false;
        if (this.app.secretStorage) {
            try {
                const id = this.secretId;
                this.app.secretStorage.setSecret(id, JSON.stringify(data));
                console.log(`[SecureStorage] Saved credentials to SecretStorage: ${id}`);
                secretStorageSuccess = true;

                // SEC-008: Once we have Keychain, we should no longer keep any local files
                await this.cleanupFiles();
            } catch (e) {
                console.warn(
                    "[SecureStorage] Failed to save to SecretStorage, falling back to file",
                    e,
                );
            }
        }

        // 2. Save to file (Legacy/Fallback) - ONLY if SecretStorage is not available or failed
        if (!secretStorageSuccess) {
            console.log(`[SecureStorage] Saving credentials to ${this.filePath} (fallback)`);
            try {
                const salt = window.crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
                const key = await this.getKey(salt);
                const encoded = new TextEncoder().encode(JSON.stringify(data));
                const iv = window.crypto.getRandomValues(new Uint8Array(IV_LENGTH));

                const encryptedContent = await window.crypto.subtle.encrypt(
                    {
                        name: ALGORITHM,
                        iv: iv,
                    },
                    key,
                    encoded,
                );

                // Format: [SALT (16)] + [IV (12)] + [Encrypted Content]
                const buffer = new Uint8Array(
                    SALT_LENGTH + IV_LENGTH + encryptedContent.byteLength,
                );
                buffer.set(salt, 0);
                buffer.set(iv, SALT_LENGTH);
                buffer.set(new Uint8Array(encryptedContent), SALT_LENGTH + IV_LENGTH);

                // Write as binary
                await this.ensureDir(this.filePath);

                const exists = await this.app.vault.adapter.exists(this.filePath);
                await this.app.vault.adapter.writeBinary(this.filePath, buffer.buffer);
                console.log(`[SecureStorage] Successfully wrote to ${this.filePath}`);

                if (!exists) {
                    this.hideFile(this.filePath);
                }
            } catch (e) {
                console.error(`[SecureStorage] Failed to save credentials to file:`, e);
                throw e;
            }
        }
    }

    async loadCredentials(): Promise<Record<string, any> | null> {
        // 1. Try Obsidian Secret Storage (Keychain) first
        if (this.app.secretStorage) {
            try {
                const id = this.secretId;
                const secret = this.app.secretStorage.getSecret(id);
                if (secret && secret.trim().length > 0) {
                    console.log(`[SecureStorage] Loaded credentials from SecretStorage: ${id}`);

                    // SEC-009: Even if loaded from Keychain, lingering files might exist.
                    // Clean them up now to satisfy the "migration complete -> delete" rule.
                    await this.cleanupFiles();

                    return JSON.parse(secret);
                }
            } catch (e) {
                console.warn("[SecureStorage] Failed to load from SecretStorage", e);
            }
        }

        // 2. Fallback to file storage
        // MIGRATION: Check if legacy file exists in root and move it
        if (await this.app.vault.adapter.exists(this.legacyFilePath)) {
            try {
                console.log(
                    `[SecureStorage] Migrating legacy credentials from ${this.legacyFilePath} to ${this.filePath}`,
                );
                await this.ensureDir(this.filePath);
                const legacyContent = await this.app.vault.adapter.readBinary(this.legacyFilePath);
                await this.app.vault.adapter.writeBinary(this.filePath, legacyContent);
                await this.app.vault.adapter.remove(this.legacyFilePath);
                console.log("SecureStorage: Migrated credentials from root to plugin folder.");
            } catch (e) {
                console.error("SecureStorage: Migration failed", e);
            }
        }

        if (!(await this.app.vault.adapter.exists(this.filePath))) {
            console.log(`[SecureStorage] No credentials file found at ${this.filePath}`);
            return null;
        }

        try {
            const buffer = await this.app.vault.adapter.readBinary(this.filePath);
            const data = new Uint8Array(buffer);

            // Minimum length check (Salt + IV)
            if (data.byteLength < SALT_LENGTH + IV_LENGTH) {
                console.error("SecureStorage: Data too short");
                return null;
            }

            const salt = data.slice(0, SALT_LENGTH);
            const iv = data.slice(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
            const encryptedContent = data.slice(SALT_LENGTH + IV_LENGTH);

            const key = await this.getKey(salt);

            const decrypted = await window.crypto.subtle.decrypt(
                {
                    name: ALGORITHM,
                    iv: iv,
                },
                key,
                encryptedContent,
            );

            const decoded = new TextDecoder().decode(decrypted);
            console.log(`[SecureStorage] Successfully loaded credentials from file.`);

            const creds = JSON.parse(decoded);

            // MIGRATION: If secretStorage is available but empty, migrate the file content there
            if (this.app.secretStorage && creds) {
                try {
                    const id = this.secretId;
                    this.app.secretStorage.setSecret(id, decoded);
                    console.log(
                        `[SecureStorage] Migrated file credentials to SecretStorage: ${id}. Deleting local files.`,
                    );
                    // SEC-007: Delete all local credential files after successful migration to Keychain
                    await this.cleanupFiles();
                } catch (e) {
                    console.warn("[SecureStorage] Failed to migrate to SecretStorage", e);
                }
            }

            return creds;
        } catch (e) {
            console.error(
                "SecureStorage: Failed to decrypt file. Key changed or file corrupted.",
                e,
            );
            return null;
        }
    }

    async clearCredentials(): Promise<void> {
        // Clear from Secret Storage
        if (this.app.secretStorage) {
            try {
                const id = this.secretId;
                // setSecret(id, "") or similar? Some APIs have deleteSecret.
                // Obsidian setSecret(id, "") works. Wait, some use null?
                // The .d.ts says setSecret(id: string, secret: string): void;
                // I'll set it to empty string or see if there's a removal method.
                // The .d.ts didn't show a removal method in my view.
                // I'll check if I can use listSecrets or if there's more.
                // Since I can't see a delete method, I'll set to empty.
                this.app.secretStorage.setSecret(id, "");
                console.log(`[SecureStorage] Cleared credentials from SecretStorage.`);
            } catch (e) {
                console.warn("[SecureStorage] Failed to clear SecretStorage", e);
            }
        }

        // Clear from file
        await this.cleanupFiles();
        console.log(`[SecureStorage] Cleared credentials from local files.`);
    }
}
