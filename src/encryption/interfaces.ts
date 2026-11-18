import type { App } from "obsidian";

// Minimal types copied from settings-schema to avoid circular dependency
export interface SettingItem {
    key: string;
    type: "toggle" | "text" | "number" | "dropdown" | "textarea" | "info";
    label: string;
    desc?: string;
    getDesc?: (settings: unknown, plugin: unknown) => string;
    placeholder?: string;
    options?: Record<string, string>;
    unit?: string;
    limits?: { min: number; max: number; default: number; disabled?: number };
    onChange?: (value: unknown, plugin: unknown) => Promise<void>;
    isHidden?: (settings: unknown) => boolean;
}

export interface SettingSection {
    id: string;
    title: string;
    description?: string;
    items: SettingItem[];
    isHidden?: (settings: unknown) => boolean;
}

export interface MigrationProgress {
    current: number;
    total: number;
    fileName: string;
}

export interface E2EEPluginContext {
    /** Obsidian App (for Modal constructor) */
    app: App;

    /** i18n translation */
    t(key: string): string;

    /** Password strength checker (optional, provided by plugin) */
    checkPasswordStrength?(password: string): {
        strength: string;
        feedback: string[];
    };

    /** Plugin settings (mutable reference to actual settings object) */
    settings: {
        e2eeEnabled: boolean;
        e2eeAutoUnlock: boolean;
    };
    saveSettings(): Promise<void>;
    refreshSettingsUI?(): void;

    /** Crypto engine reference */
    cryptoEngine: ICryptoEngine;

    /** Flattened services (eliminates syncManager.xxx.yyy chains) */
    vaultLockService: {
        downloadLockFile(): Promise<string>;
        uploadLockFile(blob: string): Promise<void>;
    };
    secureStorage: {
        setExtraSecret(key: string, value: string): Promise<void>;
        removeExtraSecret(key: string): Promise<void>;
    } | null;
    migrationService: {
        isMigrating: boolean;
        currentProgress: MigrationProgress | null;
        startMigration(hashedPassword: string): Promise<unknown>;
        runMigration(
            adapter: unknown,
            onProgress: (p: MigrationProgress) => void,
        ): Promise<void>;
        finalizeMigration(adapter: unknown): Promise<void>;
        checkForInterruptedMigration(): Promise<boolean>;
        cancelMigration(): Promise<void>;
    };

    /** Notification + logging (flattened from syncManager) */
    notify(key: string): Promise<void>;
    log(message: string, level: "system" | "error" | "warn" | "notice" | "info" | "debug"): Promise<void>;

    /** Set sync trigger type */
    setCurrentTrigger(trigger: string): void;
}

export interface ICryptoEngine {
    initializeNewVault(password: string): Promise<string>;
    unlockVault(encryptedBlob: string, password: string): Promise<void>;
    /**
     * True after unlocking an old (v1) lock file, whose unsalted outer key allows
     * fast offline password guessing. Re-save it with updatePassword(samePassword).
     */
    needsLockMigration?(): boolean;
    updatePassword?(password: string): Promise<string>;
    isUnlocked(): boolean;

    encrypt(data: ArrayBuffer): Promise<{ ciphertext: ArrayBuffer; iv: Uint8Array }>;
    decrypt(ciphertext: ArrayBuffer, iv: Uint8Array): Promise<ArrayBuffer>;

    /** Cipher metadata for AES-256-GCM. */
    readonly ivSize: number;
    readonly tagSize: number;

    /** Encrypt data and return the wire-format blob: [IV][ciphertext] (VSC1). */
    encryptToBlob(data: ArrayBuffer): Promise<ArrayBuffer>;
    /** Decrypt a wire-format blob: splits [IV][ciphertext] and decrypts. */
    decryptFromBlob(blob: ArrayBuffer): Promise<ArrayBuffer>;
    /** Return the optimal plaintext chunk size so encrypted chunks align to 256 KiB boundaries. */
    getOptimalChunkSize(): number;

    // Chunked encryption (large files)
    /** Check whether data starts with a chunked-format magic header. */
    isChunkedFormat(data: ArrayBuffer): boolean;
    /** Encrypt data into the chunked format. */
    encryptChunked(data: ArrayBuffer): Promise<ArrayBuffer>;
    /** Decrypt chunked-format data back to plaintext. */
    decryptChunked(data: ArrayBuffer): Promise<ArrayBuffer>;
    /** Calculate the total encrypted size for a given plaintext size in the chunked format. */
    calculateChunkedSize(plaintextSize: number): number;
    /** Build the chunked-format header for a given plaintext size. */
    buildChunkedHeader(plaintextSize: number): Uint8Array;
    /**
     * Encrypt data as a stream of chunks for use with resumable uploads.
     * `header` is the one from buildChunkedHeader that is written in front of the
     * chunks: newer engines bind every chunk to it (and to its position), so the
     * same header must be passed here. Older engines ignore it.
     */
    encryptChunks(
        data: ArrayBuffer,
        header?: Uint8Array,
    ): AsyncGenerator<{
        iv: Uint8Array;
        ciphertext: ArrayBuffer;
        index: number;
        totalChunks: number;
        header?: Uint8Array;
    }>;

    // Recovery
    exportRecoveryCode?(): Promise<string>;
    recoverFromCode?(recoveryCode: string, newPassword: string): Promise<string>;
    getKeyFingerprint?(): Promise<string>;

    // UI Injection
    showSetupModal(ctx: E2EEPluginContext): void;
    showUnlockModal(ctx: E2EEPluginContext): void;
    showPasswordChangeModal?(ctx: E2EEPluginContext): void;
    showRecoveryExportModal?(ctx: E2EEPluginContext): void;
    showRecoveryImportModal?(ctx: E2EEPluginContext): void;
    getSettingsSections(ctx: E2EEPluginContext): SettingSection[];
    /**
     * Display text of the add-on for a UI language ("en", "ja", ...). Vault-Sync's
     * own dictionary carries no add-on specific wording.
     */
    getStrings?(lang: string): Record<string, string>;
}
