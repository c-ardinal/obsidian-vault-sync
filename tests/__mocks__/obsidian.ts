// Minimal Obsidian API mocks for testing SyncManager

export class Notice {
    constructor(public message: string, _timeout?: number) {}
}

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
