import { vi } from "vitest";

export const Notice = vi.fn(function (message: string, _timeout?: number) {
    return { message };
});

export class TAbstractFile {
    path: string = "";
    name: string = "";
    parent: TFolder | null = null;
}

export class TFile extends TAbstractFile {
    stat = { mtime: 0, ctime: 0, size: 0 };
    basename: string = "";
    extension: string = "";
}

export class TFolder extends TAbstractFile {
    children: TAbstractFile[] = [];
    isRoot(): boolean {
        return this.path === "/";
    }
}

export class Platform {
    static isDesktop = true;
    static isMobile = false;
    static isDesktopApp = true;
}

export class App {
    vault: any;
}

export function normalizePath(path: string): string {
    // Simple mock implementation
    // 1. Replace backslashes with forward slashes
    let res = path.replace(/\\/g, "/");

    // 2. Remove duplicate slashes
    res = res.replace(/\/+/g, "/");

    // 3. Remove leading slash (Obsidian paths are relative to vault root)
    if (res.startsWith("/")) res = res.substring(1);

    // 4. Remove trailing slash (except if root, but empty string is root here)
    if (res.endsWith("/") && res.length > 1) res = res.substring(0, res.length - 1);

    return res;
}
