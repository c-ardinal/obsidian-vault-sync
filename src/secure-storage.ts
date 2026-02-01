import { App, Platform } from "obsidian";

const IV_LENGTH = 12;
const SALT_LENGTH = 16;
const ALGORITHM = "AES-GCM";

export class SecureStorage {
    private key: CryptoKey | null = null;
    private filePath: string;
    private legacyFilePath = ".sync-state";

    constructor(
        private app: App,
        pluginDir: string,
    ) {
        this.filePath = `${pluginDir}/.sync-state`;
    }

    private async getKey(): Promise<CryptoKey> {
        if (this.key) return this.key;

        // Use a fixed salt (derived from app ID or similar constant if possible,
        // but for now we'll use a hardcoded salt to ensure persistence across reloads)
        // In a real scenario, we might want to store the salt alongside the data,
        // but to keep the file purely binary and obscure, we'll use a fixed app-specific salt.
        const enc = new TextEncoder();
        const rawKey = enc.encode("obsidian-vault-sync-secure-key-v1");

        const importedKey = await window.crypto.subtle.importKey("raw", rawKey, "PBKDF2", false, [
            "deriveKey",
        ]);

        this.key = await window.crypto.subtle.deriveKey(
            {
                name: "PBKDF2",
                salt: enc.encode("salty-obsidian-vault-sync"), // Fixed salt
                iterations: 100000,
                hash: "SHA-256",
            },
            importedKey,
            { name: "AES-GCM", length: 256 },
            false,
            ["encrypt", "decrypt"],
        );

        return this.key;
    }

    async saveCredentials(data: Record<string, any>): Promise<void> {
        const key = await this.getKey();
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

        // Concatenate IV + Encrypted Data
        const buffer = new Uint8Array(iv.byteLength + encryptedContent.byteLength);
        buffer.set(iv, 0);
        buffer.set(new Uint8Array(encryptedContent), iv.byteLength);

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

            if (data.byteLength < IV_LENGTH) {
                console.error("SecureStorage: Data too short");
                return null;
            }

            const iv = data.slice(0, IV_LENGTH);
            const encryptedContent = data.slice(IV_LENGTH);
            const key = await this.getKey();

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
            console.error("SecureStorage: Failed to decrypt or load credentials", e);
            return null;
        }
    }

    async clearCredentials(): Promise<void> {
        if (await this.app.vault.adapter.exists(this.filePath)) {
            await this.app.vault.adapter.remove(this.filePath);
        }
    }
}
