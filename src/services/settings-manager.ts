import type { IVaultOperations } from "../types/vault-operations";
import type { GoogleDriveAdapter } from "../cloud-adapters/google-drive";
import { SecureStorage } from "./secure-storage";
import { DEFAULT_SETTINGS } from "../constants";
import {
    DATA_LOCAL_DIR,
    DATA_REMOTE_DIR,
    DATA_FLEXIBLE_DIR,
    type VaultSyncSettings,
} from "../types/settings";
import { toHex } from "../utils/format";

interface SettingsManagerDeps {
    vaultOps: IVaultOperations;
    manifestDir: string;
    adapter: GoogleDriveAdapter;
    appSecretStorage: any;
}

/**
 * Manages loading and saving VaultSync settings from split JSON files
 * (open-data.json / local-data.json), encryption secret initialization,
 * and credential loading from secure storage.
 *
 * Extracted from the main VaultSync plugin class to separate
 * settings persistence from plugin lifecycle orchestration.
 */
export class SettingsManager {
    settings!: VaultSyncSettings;
    secureStorage!: SecureStorage;

    constructor(private deps: SettingsManagerDeps) {}

    async loadSettings(): Promise<void> {
        const { vaultOps, manifestDir, adapter, appSecretStorage } = this.deps;
        let loadedSettings: Partial<VaultSyncSettings> = {};

        const openDataPath = `${manifestDir}/${DATA_FLEXIBLE_DIR}/open-data.json`;
        const localDataPath = `${manifestDir}/${DATA_LOCAL_DIR}/local-data.json`;

        if (await vaultOps.exists(openDataPath)) {
            try {
                const openData = JSON.parse(await vaultOps.read(openDataPath));
                loadedSettings = { ...loadedSettings, ...openData };
            } catch (e) {
                console.error("VaultSync: Failed to load open-data.json", e);
            }
        }

        if (await vaultOps.exists(localDataPath)) {
            try {
                const localData = JSON.parse(await vaultOps.read(localDataPath));
                loadedSettings = { ...loadedSettings, ...localData };
            } catch (e) {
                console.error("VaultSync: Failed to load local-data.json", e);
            }
        }

        this.settings = Object.assign({}, DEFAULT_SETTINGS, loadedSettings);

        // SEC-010: Initialize SecureStorage early to use its Keychain methods
        this.secureStorage = new SecureStorage(
            vaultOps,
            manifestDir,
            this.settings.encryptionSecret || "temp-key",
            appSecretStorage,
        );

        // SEC-011: Prioritize encryptionSecret from Keychain
        if (appSecretStorage) {
            const keychainSecret = await this.secureStorage.getExtraSecret("encryption-secret");
            if (keychainSecret) {
                this.settings.encryptionSecret = keychainSecret;
                this.secureStorage.setMasterSecret(keychainSecret);
            }
        }

        // SEC-001: Ensure encryption secret exists (if not found in file or Keychain)
        if (!this.settings.encryptionSecret) {
            const array = new Uint8Array(32);
            window.crypto.getRandomValues(array);
            const newSecret = toHex(array);
            this.settings.encryptionSecret = newSecret;
            this.secureStorage.setMasterSecret(newSecret);

            if (appSecretStorage) {
                await this.secureStorage.setExtraSecret("encryption-secret", newSecret);
            }
            await this.saveSettings();
        }

        const credentials = await this.secureStorage.loadCredentials();

        if (credentials) {
            adapter.setCredentials(credentials.clientId || "", credentials.clientSecret || "");
            adapter.setTokens(
                credentials.accessToken || null,
                credentials.refreshToken || null,
                credentials.tokenExpiresAt || 0,
            );
            adapter.updateConfig(
                credentials.clientId || "",
                credentials.clientSecret || "",
                vaultOps.getVaultName(),
                this.settings.cloudRootFolder,
            );

            // Backward compatibility: existing users with clientId/clientSecret
            // should default to client-credentials mode if authMethod is not explicitly set
            if (
                !loadedSettings.authMethod &&
                credentials.clientId &&
                credentials.clientSecret
            ) {
                this.settings.authMethod = "client-credentials";
            }
        }

        adapter.setAuthConfig(
            this.settings.authMethod,
            this.settings.customProxyUrl,
        );
    }

    async saveSettings(): Promise<void> {
        const { vaultOps, manifestDir, appSecretStorage } = this.deps;

        const flexibleDir = `${manifestDir}/${DATA_FLEXIBLE_DIR}`;
        const localDir = `${manifestDir}/${DATA_LOCAL_DIR}`;
        const remoteDir = `${manifestDir}/${DATA_REMOTE_DIR}`;

        if (!(await vaultOps.exists(flexibleDir))) {
            await vaultOps.createFolder(flexibleDir).catch(() => {});
        }
        if (!(await vaultOps.exists(localDir))) {
            await vaultOps.createFolder(localDir).catch(() => {});
        }
        if (!(await vaultOps.exists(remoteDir))) {
            await vaultOps.createFolder(remoteDir).catch(() => {});
        }

        const localKeys = ["encryptionSecret", "hasCompletedFirstSync"];
        const localData: Record<string, unknown> = {};
        const openData: Record<string, unknown> = {};
        const settingsRecord = this.settings as unknown as Record<string, unknown>;

        for (const key in this.settings) {
            if (Object.prototype.hasOwnProperty.call(this.settings, key)) {
                if (localKeys.includes(key)) {
                    // SEC-012: Do not save encryptionSecret to file if Keychain is active
                    if (key === "encryptionSecret" && appSecretStorage) {
                        continue;
                    }
                    localData[key] = settingsRecord[key];
                } else {
                    openData[key] = settingsRecord[key];
                }
            }
        }

        const openDataPath = `${flexibleDir}/open-data.json`;
        const localDataPath = `${localDir}/local-data.json`;

        await vaultOps.write(openDataPath, JSON.stringify(openData, null, 2));
        await vaultOps.write(localDataPath, JSON.stringify(localData, null, 2));
    }
}
