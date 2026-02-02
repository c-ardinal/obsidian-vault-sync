import { App } from "obsidian";

const IV_LENGTH = 12;
const SALT_LENGTH = 16;
const ALGORITHM = "AES-GCM";

export class SecureStorage {
    private keyCache: Map<string, CryptoKey> = new Map(); // Cache keys by salt
    private filePath: string;
    private legacyFilePath = ".sync-state";

    constructor(
        private app: App,
        pluginDir: string,
        private secret: string,
    ) {
        this.filePath = `${pluginDir}/.sync-state`;
    }

    private async getKey(salt: Uint8Array): Promise<CryptoKey> {
        const saltHex = Array.from(salt, (b) => b.toString(16).padStart(2, "0")).join("");
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
        const buffer = new Uint8Array(SALT_LENGTH + IV_LENGTH + encryptedContent.byteLength);
        buffer.set(salt, 0);
        buffer.set(iv, SALT_LENGTH);
        buffer.set(new Uint8Array(encryptedContent), SALT_LENGTH + IV_LENGTH);

        // Write as binary
        await this.app.vault.adapter.writeBinary(this.filePath, buffer.buffer);
    }

    async loadCredentials(): Promise<Record<string, any> | null> {
        // MIGRATION: Check if legacy file exists in root and move it
        if (await this.app.vault.adapter.exists(this.legacyFilePath)) {
            try {
                const legacyContent = await this.app.vault.adapter.readBinary(this.legacyFilePath);
                await this.app.vault.adapter.writeBinary(this.filePath, legacyContent);
                await this.app.vault.adapter.remove(this.legacyFilePath);
                console.log("SecureStorage: Migrated credentials from root to plugin folder.");
            } catch (e) {
                console.error("SecureStorage: Migration failed", e);
            }
        }

        if (!(await this.app.vault.adapter.exists(this.filePath))) {
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
            return JSON.parse(decoded);
        } catch (e) {
            console.error("SecureStorage: Failed to decrypt. Key changed or file corrupted.", e);
            return null;
        }
    }

    async clearCredentials(): Promise<void> {
        if (await this.app.vault.adapter.exists(this.filePath)) {
            await this.app.vault.adapter.remove(this.filePath);
        }
    }
}
