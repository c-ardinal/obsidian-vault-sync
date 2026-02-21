import type { App, TFile, TAbstractFile } from "obsidian";
import type { IVaultOperations } from "../types/vault-operations";

/**
 * Production implementation of {@link IVaultOperations} that delegates
 * every call to the Obsidian `App` instance.
 */
export class ObsidianVaultOperations implements IVaultOperations {
    constructor(private app: App) {}

    // ── Low-level (delegates to app.vault.adapter) ───────────────────

    exists(path: string): Promise<boolean> {
        return this.app.vault.adapter.exists(path);
    }

    stat(path: string): Promise<{ ctime: number; mtime: number; size: number } | null> {
        return this.app.vault.adapter.stat(path) as Promise<{
            ctime: number;
            mtime: number;
            size: number;
        } | null>;
    }

    read(path: string): Promise<string> {
        return this.app.vault.adapter.read(path);
    }

    readBinary(path: string): Promise<ArrayBuffer> {
        return this.app.vault.adapter.readBinary(path);
    }

    write(path: string, data: string): Promise<void> {
        return this.app.vault.adapter.write(path, data);
    }

    writeBinary(path: string, data: ArrayBuffer): Promise<void> {
        return this.app.vault.adapter.writeBinary(path, data);
    }

    list(path: string): Promise<{ files: string[]; folders: string[] }> {
        return this.app.vault.adapter.list(path);
    }

    mkdir(path: string): Promise<void> {
        return this.app.vault.adapter.mkdir(path);
    }

    rmdir(path: string, recursive: boolean): Promise<void> {
        return this.app.vault.adapter.rmdir(path, recursive);
    }

    rename(oldPath: string, newPath: string): Promise<void> {
        return this.app.vault.adapter.rename(oldPath, newPath);
    }

    remove(path: string): Promise<void> {
        return this.app.vault.adapter.remove(path);
    }

    // ── High-level (delegates to app.vault) ──────────────────────────

    getFiles(): TFile[] {
        return this.app.vault.getFiles();
    }

    getAbstractFileByPath(path: string): TAbstractFile | null {
        return this.app.vault.getAbstractFileByPath(path);
    }

    async createFolder(path: string): Promise<void> {
        await this.app.vault.createFolder(path);
    }

    async createBinary(path: string, data: ArrayBuffer): Promise<void> {
        await this.app.vault.createBinary(path, data);
    }

    modifyBinary(file: TFile, data: ArrayBuffer): Promise<void> {
        return this.app.vault.modifyBinary(file, data);
    }

    readFile(file: TFile): Promise<string> {
        return this.app.vault.read(file);
    }

    renameFile(file: TAbstractFile, newPath: string): Promise<void> {
        return this.app.vault.rename(file, newPath);
    }

    trashFile(file: TAbstractFile, system: boolean): Promise<void> {
        return this.app.vault.trash(file, system);
    }

    getVaultName(): string {
        return this.app.vault.getName();
    }

    // ── Optional platform-specific ───────────────────────────────────

    getBasePath(): string | null {
        const adapter = this.app.vault.adapter as any;
        return typeof adapter.getBasePath === "function" ? adapter.getBasePath() : null;
    }
}
