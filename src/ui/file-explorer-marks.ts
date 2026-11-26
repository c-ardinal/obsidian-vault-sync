import { debounce, type App, type EventRef } from "obsidian";
import { isConflictCopyPath } from "../sync-manager/conflict-resolution";

/** What the marks need from the plugin */
export interface FileMarksSource {
    /** Files changed here and not sent yet */
    pendingPaths(): string[];
    /** Called on every sync progress change; returns the unsubscribe */
    subscribe(cb: () => void): () => void;
}

const PENDING = "vault-sync-mark-pending";
const CONFLICT = "vault-sync-mark-conflict";

/** The file explorer's rows (internal API, guarded: nothing is marked if it changes) */
interface ExplorerView {
    fileItems?: Record<string, { selfEl?: HTMLElement }>;
}

/**
 * Optional small marks in the file explorer: a dot on files changed here and
 * not sent yet, another on conflict copies. Off by default. Nothing is sent
 * or asked for: the marks follow the sync's own state.
 */
export class FileExplorerMarks {
    private marked = new Set<HTMLElement>();
    private refs: EventRef[] = [];
    private unsubscribe: (() => void) | null = null;
    private readonly refreshSoon = debounce(() => this.refresh(), 300, true);

    constructor(
        private readonly app: App,
        private readonly source: FileMarksSource,
    ) {}

    get enabled(): boolean {
        return this.unsubscribe !== null;
    }

    enable(): void {
        if (this.enabled) return;
        this.unsubscribe = this.source.subscribe(() => this.refreshSoon());
        const v = this.app.vault;
        for (const ev of ["modify", "create", "delete", "rename"] as const) {
            this.refs.push(v.on(ev as "modify", () => this.refreshSoon()));
        }
        this.refs.push(this.app.workspace.on("layout-change", () => this.refreshSoon()));
        this.refresh();
    }

    disable(): void {
        this.unsubscribe?.();
        this.unsubscribe = null;
        for (const r of this.refs) this.app.vault.offref(r);
        this.refs = [];
        this.clear();
    }

    private clear(): void {
        for (const el of this.marked) el.removeClasses([PENDING, CONFLICT]);
        this.marked.clear();
    }

    refresh(): void {
        this.clear();
        if (!this.enabled) return;
        const pending = new Set(this.source.pendingPaths());
        for (const leaf of this.app.workspace.getLeavesOfType("file-explorer")) {
            const items = (leaf.view as unknown as ExplorerView).fileItems;
            if (!items || typeof items !== "object") continue;
            for (const [path, item] of Object.entries(items)) {
                const el = item?.selfEl;
                if (!el) continue;
                const cls = isConflictCopyPath(path) ? CONFLICT : pending.has(path) ? PENDING : null;
                if (!cls) continue;
                el.addClass(cls);
                this.marked.add(el);
            }
        }
    }
}
