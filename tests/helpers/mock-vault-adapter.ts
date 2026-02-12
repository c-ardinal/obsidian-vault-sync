import { TFile, TAbstractFile } from "obsidian";

/**
 * In-memory file system that mimics Obsidian's vault adapter.
 * Each device gets its own instance.
 */
export class MockVaultAdapter {
    /** path -> { content, mtime } */
    private files = new Map<string, { content: ArrayBuffer; mtime: number }>();
    /** path set for folders */
    private folders = new Set<string>();

    async exists(path: string): Promise<boolean> {
        return this.files.has(path) || this.folders.has(path);
    }

    async readBinary(path: string): Promise<ArrayBuffer> {
        const entry = this.files.get(path);
        if (!entry) throw new Error(`File not found: ${path}`);
        // Return a copy to avoid shared-reference issues
        return entry.content.slice(0);
    }

    async read(path: string): Promise<string> {
        const buf = await this.readBinary(path);
        return new TextDecoder().decode(buf);
    }

    async writeBinary(path: string, content: ArrayBuffer): Promise<void> {
        this.files.set(path, { content: content.slice(0), mtime: Date.now() });
    }

    async write(path: string, content: string): Promise<void> {
        const buf = new TextEncoder().encode(content).buffer as ArrayBuffer;
        await this.writeBinary(path, buf);
    }

    async stat(path: string): Promise<{ mtime: number; size: number; ctime: number } | null> {
        const entry = this.files.get(path);
        if (!entry) return null;
        return { mtime: entry.mtime, size: entry.content.byteLength, ctime: entry.mtime };
    }

    async rename(from: string, to: string): Promise<void> {
        const entry = this.files.get(from);
        if (!entry) throw new Error(`File not found for rename: ${from}`);
        this.files.set(to, entry);
        this.files.delete(from);
    }

    async mkdir(path: string): Promise<void> {
        this.folders.add(path);
    }

    async remove(path: string): Promise<void> {
        this.files.delete(path);
        this.folders.delete(path);
    }

    // --- Helper for tests ---
    setFile(path: string, content: string, mtime?: number): void {
        const buf = new TextEncoder().encode(content).buffer as ArrayBuffer;
        this.files.set(path, { content: buf, mtime: mtime || Date.now() });
    }

    getContent(path: string): string | null {
        const entry = this.files.get(path);
        if (!entry) return null;
        return new TextDecoder().decode(entry.content);
    }

    hasFile(path: string): boolean {
        return this.files.has(path);
    }

    listAllFiles(): string[] {
        return Array.from(this.files.keys());
    }
}

/**
 * Mock for Obsidian's Vault object.
 * Wraps MockVaultAdapter and provides TFile-based operations.
 */
export class MockVault {
    adapter: MockVaultAdapter;
    private tfiles = new Map<string, TFile>();

    constructor(vaultAdapter: MockVaultAdapter) {
        this.adapter = vaultAdapter;
    }

    getAbstractFileByPath(path: string): TAbstractFile | null {
        if (this.tfiles.has(path)) return this.tfiles.get(path)!;
        // Auto-create if file exists in adapter
        if (this.adapter.hasFile(path)) {
            const tf = new TFile();
            tf.path = path;
            tf.name = path.split("/").pop() || path;
            tf.basename = tf.name.replace(/\.[^.]+$/, "");
            tf.extension = tf.name.split(".").pop() || "";
            this.tfiles.set(path, tf);
            return tf;
        }
        return null;
    }

    async rename(file: TAbstractFile, newPath: string): Promise<void> {
        await this.adapter.rename(file.path, newPath);
        this.tfiles.delete(file.path);
        file.path = newPath;
        file.name = newPath.split("/").pop() || newPath;
        this.tfiles.set(newPath, file as TFile);
    }

    async modifyBinary(file: TFile, content: ArrayBuffer): Promise<void> {
        await this.adapter.writeBinary(file.path, content);
    }

    async trash(file: TFile, system: boolean): Promise<void> {
        await this.adapter.remove(file.path);
    }

    async createBinary(path: string, content: ArrayBuffer): Promise<void> {
        await this.adapter.writeBinary(path, content);
    }

    async createFolder(path: string): Promise<void> {
        await this.adapter.mkdir(path);
    }

    getFiles(): TFile[] {
        const files: TFile[] = [];
        for (const path of this.adapter.listAllFiles()) {
            const tf = this.getAbstractFileByPath(path);
            if (tf instanceof TFile) {
                files.push(tf);
            }
        }
        return files;
    }

    getName(): string {
        return "mock-vault";
    }
}

/**
 * Mock Obsidian App that provides a vault.
 */
export class MockApp {
    vault: MockVault;
    secretStorage: {
        secrets: Map<string, string>;
        getSecret(id: string): string | null;
        setSecret(id: string, secret: string): void;
        listSecrets(): string[];
    };
    private _adapter: MockVaultAdapter;

    constructor() {
        this._adapter = new MockVaultAdapter();
        this.vault = new MockVault(this._adapter);
        const secrets = new Map<string, string>();
        this.secretStorage = {
            secrets,
            getSecret(id: string) {
                return secrets.get(id) || null;
            },
            setSecret(id: string, secret: string) {
                secrets.set(id, secret);
            },
            listSecrets() {
                return Array.from(secrets.keys());
            },
        };
    }

    get vaultAdapter(): MockVaultAdapter {
        return this._adapter;
    }
}
