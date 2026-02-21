import type { TFile, TAbstractFile } from "obsidian";

/**
 * Facade for local vault file-system operations.
 *
 * Combines the low-level adapter API (`app.vault.adapter.*`) and the
 * high-level vault API (`app.vault.*`) behind a single interface so that
 * consumers never reach through `app.vault.adapter` (LoD compliance).
 */
export interface IVaultOperations {
    // ── Low-level (was app.vault.adapter.*) ──────────────────────────
    exists(path: string): Promise<boolean>;
    stat(path: string): Promise<{ type?: string; ctime: number; mtime: number; size: number } | null>;
    read(path: string): Promise<string>;
    readBinary(path: string): Promise<ArrayBuffer>;
    write(path: string, data: string): Promise<void>;
    writeBinary(path: string, data: ArrayBuffer): Promise<void>;
    list(path: string): Promise<{ files: string[]; folders: string[] }>;
    mkdir(path: string): Promise<void>;
    rmdir(path: string, recursive: boolean): Promise<void>;
    rename(oldPath: string, newPath: string): Promise<void>;
    remove(path: string): Promise<void>;

    // ── High-level (was app.vault.*) ─────────────────────────────────
    getFiles(): TFile[];
    getAbstractFileByPath(path: string): TAbstractFile | null;
    createFolder(path: string): Promise<void>;
    createBinary(path: string, data: ArrayBuffer): Promise<void>;
    modifyBinary(file: TFile, data: ArrayBuffer): Promise<void>;
    readFile(file: TFile): Promise<string>;
    renameFile(file: TAbstractFile, newPath: string): Promise<void>;
    trashFile(file: TAbstractFile, system: boolean): Promise<void>;
    getVaultName(): string;

    // ── Optional platform-specific ───────────────────────────────────
    /** Desktop-only: absolute path to the vault root. */
    getBasePath?(): string | null;
}
