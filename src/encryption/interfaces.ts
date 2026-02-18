// Minimal types copied from settings-schema to avoid circular dependency
export interface SettingItem {
    key: string;
    type: "toggle" | "text" | "number" | "dropdown" | "textarea";
    label: string;
    desc?: string;
    getDesc?: (settings: any, plugin: any) => string;
    placeholder?: string;
    options?: Record<string, string>;
    unit?: string;
    limits?: any;
    onChange?: (value: any, plugin: any) => Promise<void>;
    isHidden?: (settings: any) => boolean;
}

export interface SettingSection {
    id: string;
    title: string;
    description?: string;
    items: SettingItem[];
    isHidden?: (settings: any) => boolean;
}

export interface ICryptoEngine {
    initializeNewVault(password: string): Promise<string>;
    unlockVault(encryptedBlob: string, password: string): Promise<void>;
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

    // Chunked encryption (VSC2)
    /** Check whether data starts with the VSC2 chunked format magic header. */
    isChunkedFormat(data: ArrayBuffer): boolean;
    /** Encrypt data into VSC2 chunked format. */
    encryptChunked(data: ArrayBuffer): Promise<ArrayBuffer>;
    /** Decrypt VSC2 chunked-format data back to plaintext. */
    decryptChunked(data: ArrayBuffer): Promise<ArrayBuffer>;
    /** Calculate the total encrypted size for a given plaintext size in VSC2 format. */
    calculateChunkedSize(plaintextSize: number): number;
    /** Build the VSC2 header for a given plaintext size. */
    buildChunkedHeader(plaintextSize: number): Uint8Array;
    /** Encrypt data as a stream of chunks for use with resumable uploads. */
    encryptChunks(data: ArrayBuffer): AsyncGenerator<{
        iv: Uint8Array;
        ciphertext: ArrayBuffer;
        index: number;
        totalChunks: number;
    }>;

    // Recovery
    exportRecoveryCode?(): Promise<string>;
    recoverFromCode?(recoveryCode: string, newPassword: string): Promise<string>;
    getKeyFingerprint?(): Promise<string>;

    // UI Injection
    showSetupModal(plugin: any): void;
    showUnlockModal(plugin: any): void;
    showPasswordChangeModal?(plugin: any): void;
    showRecoveryExportModal?(plugin: any): void;
    showRecoveryImportModal?(plugin: any): void;
    getSettingsSections(plugin: any): SettingSection[];
}
