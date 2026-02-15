export interface VaultLockData {
    salt: string;
    encryptedMasterKey: string;
    iv: string;
    algo: string;
    pbkdf2Iterations?: number; // Number of PBKDF2 iterations used for key derivation
    version?: number; // Version of the lock file format for future compatibility
}

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
    initializeNewVault(password: string): Promise<VaultLockData>;
    unlockVault(lockData: VaultLockData, password: string): Promise<void>;
    updatePassword?(password: string): Promise<VaultLockData>;
    isUnlocked(): boolean;

    encrypt(data: ArrayBuffer): Promise<{ ciphertext: ArrayBuffer; iv: Uint8Array }>;
    decrypt(ciphertext: ArrayBuffer, iv: Uint8Array): Promise<ArrayBuffer>;

    // UI Injection
    showSetupModal(plugin: any): void;
    showUnlockModal(plugin: any): void;
    getSettingsSections(plugin: any): SettingSection[];
}
