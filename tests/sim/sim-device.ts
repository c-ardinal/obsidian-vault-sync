import { TFile, type TAbstractFile } from "obsidian";
import { SyncManager, type SyncManagerSettings, type SyncTrigger } from "../../src/sync-manager";
import { RevisionCache } from "../../src/services/revision-cache";
import { BackgroundTransferQueue } from "../../src/sync-manager/background-transfer";
import type { INotificationService } from "../../src/services/notification-service";
import type { CloudAdapter } from "../../src/types/adapter";
import { MockApp, MockVaultAdapter, MockVaultOperations } from "../helpers/mock-vault-adapter";
import type { Rng } from "./rng";
import { PersonalityVaultAdapter, RealFsVaultAdapter, type FsPersonality } from "./sim-vault";

export const PLUGIN_DIR = ".obsidian/plugins/obsidian-vault-sync";
export const SYNC_INDEX_PATH = `${PLUGIN_DIR}/data/remote/sync-index.json`;
export const LOCAL_INDEX_PATH = `${PLUGIN_DIR}/data/local/local-index.json`;

export const SIM_SETTINGS: SyncManagerSettings = {
    concurrency: 2,
    notificationLevel: "standard",
    conflictResolutionStrategy: "smart-merge",
    enableLogging: false,
    isDeveloperMode: false,
    exclusionPatterns: "",
    largeFileThresholdMB: 0,
    bgTransferIntervalSec: 0,
    syncAppearance: true,
    syncCommunityPlugins: true,
    syncCoreConfig: true,
    syncImagesAndMedia: true,
    syncDotfiles: false,
    syncPluginSettings: true,
    syncFlexibleData: true,
    syncDeviceLogs: false,
    syncWorkspace: false,
    hasCompletedFirstSync: false,
    e2eeEnabled: false,
};

/** Paths that are plugin/Obsidian internals, not user content */
export function isInternalPath(path: string): boolean {
    return path.startsWith(".obsidian/") || path === ".obsidian";
}

/**
 * In-memory vault whose file mtimes follow the device's own (possibly skewed) clock.
 */
class SkewedVaultAdapter extends MockVaultAdapter {
    constructor(private skewMs: () => number) {
        super();
    }
    override async writeBinary(path: string, content: ArrayBuffer): Promise<void> {
        (this as any).files.set(path, { content: content.slice(0), mtime: Date.now() + this.skewMs() });
    }
}

type VaultEvent =
    | { type: "create" | "modify"; path: string; isFolder: boolean }
    | { type: "delete"; path: string; isFolder: boolean }
    | { type: "rename"; path: string; oldPath: string; isFolder: boolean };

/**
 * Vault operations that, like Obsidian, emit create/modify/delete/rename
 * events for EVERY write — including the ones the sync engine performs while
 * pulling. Events are delivered after a (seeded) random delay, mimicking the
 * file watcher; this is how "sync loops" caused by our own writes show up.
 */
class EventedVaultOperations extends MockVaultOperations {
    constructor(
        adapter: MockVaultAdapter,
        vault: any,
        private readonly emit: (ev: VaultEvent) => void,
        private readonly va: MockVaultAdapter,
    ) {
        super(adapter, vault);
    }

    private async isFolder(path: string): Promise<boolean> {
        const st = await this.va.stat(path);
        return st?.type === "folder";
    }

    override async write(path: string, data: string) {
        const existed = await this.va.exists(path);
        await super.write(path, data);
        this.emit({ type: existed ? "modify" : "create", path, isFolder: false });
    }
    override async writeBinary(path: string, data: ArrayBuffer) {
        const existed = await this.va.exists(path);
        await super.writeBinary(path, data);
        this.emit({ type: existed ? "modify" : "create", path, isFolder: false });
    }
    override async createBinary(path: string, data: ArrayBuffer) {
        await super.createBinary(path, data);
        this.emit({ type: "create", path, isFolder: false });
    }
    override async modifyBinary(file: TFile, data: ArrayBuffer) {
        await super.modifyBinary(file, data);
        this.emit({ type: "modify", path: file.path, isFolder: false });
    }
    override async mkdir(path: string) {
        const existed = await this.va.exists(path);
        await super.mkdir(path);
        if (!existed) this.emit({ type: "create", path, isFolder: true });
    }
    override async createFolder(path: string) {
        const existed = await this.va.exists(path);
        await super.createFolder(path);
        if (!existed) this.emit({ type: "create", path, isFolder: true });
    }
    override async remove(path: string) {
        const folder = await this.isFolder(path);
        const existed = await this.va.exists(path);
        await super.remove(path);
        if (existed) this.emit({ type: "delete", path, isFolder: folder });
    }
    override async rmdir(path: string, recursive: boolean) {
        const existed = await this.va.exists(path);
        await super.rmdir(path, recursive);
        if (existed) this.emit({ type: "delete", path, isFolder: true });
    }
    override async rename(oldPath: string, newPath: string) {
        const folder = await this.isFolder(oldPath);
        await super.rename(oldPath, newPath);
        this.emit({ type: "rename", path: newPath, oldPath, isFolder: folder });
    }
    override async renameFile(file: TAbstractFile, newPath: string) {
        const oldPath = file.path;
        const folder = await this.isFolder(oldPath);
        await super.renameFile(file, newPath);
        this.emit({ type: "rename", path: newPath, oldPath, isFolder: folder });
    }
    override async trashFile(file: TAbstractFile, system: boolean) {
        const path = file.path;
        const folder = await this.isFolder(path);
        await super.trashFile(file, system);
        this.emit({ type: "delete", path, isFolder: folder });
    }
}

export interface DeviceOptions {
    name: string;
    cloudView: (device: SimDevice) => CloudAdapter;
    rng: Rng;
    /** Max delay before a vault event reaches the plugin (virtual ms) */
    maxEventDelayMs: number;
    /** Offset added to this device's file mtimes (virtual ms) */
    clockSkewMs: number;
    settings?: Partial<SyncManagerSettings>;
    /** File-system semantics of this device (default: linux) */
    fs?: FsPersonality;
    /** Shared timeline sink */
    log: (device: string, msg: string) => void;
}

/**
 * One simulated device running the REAL SyncManager against its own vault.
 */
export class SimDevice {
    readonly name: string;
    readonly fs: FsPersonality;
    readonly app: MockApp;
    readonly vaultAdapter: MockVaultAdapter;
    readonly ops: EventedVaultOperations;
    readonly sm: SyncManager;
    readonly ctx: any;
    online = true;
    joined = false;
    /** Errors thrown out of requestSmartSync */
    readonly syncErrors: string[] = [];
    syncsStarted = 0;
    syncsFinished = 0;
    private inflight = new Set<Promise<void>>();
    private pendingEvents = 0;

    constructor(private readonly opts: DeviceOptions) {
        this.name = opts.name;
        this.app = new MockApp();
        // Replace the default adapter with a clock-skewed one of the requested OS flavour
        const now = () => Date.now() + opts.clockSkewMs;
        this.fs = opts.fs ?? "linux";
        this.vaultAdapter =
            this.fs === "real-fs"
                ? new RealFsVaultAdapter(opts.name, now)
                : this.fs === "linux"
                  ? new SkewedVaultAdapter(() => opts.clockSkewMs)
                  : new PersonalityVaultAdapter(this.fs, now);
        (this.app as any)._adapter = this.vaultAdapter;
        (this.app.vault as any).adapter = this.vaultAdapter;

        this.ops = new EventedVaultOperations(
            this.vaultAdapter,
            this.app.vault,
            (ev) => this.scheduleEvent(ev),
            this.vaultAdapter,
        );

        const notifier: INotificationService = { show: () => {} };
        const settings = { ...SIM_SETTINGS, ...(opts.settings ?? {}) };
        this.sm = new SyncManager(
            this.ops,
            opts.cloudView(this),
            SYNC_INDEX_PATH,
            settings,
            PLUGIN_DIR,
            (key: string) => key,
            notifier,
            new RevisionCache(this.ops, PLUGIN_DIR),
            new BackgroundTransferQueue(),
        );
        this.ctx = this.sm as any;
        this.ctx.log = async (msg: string, level = "info") => {
            opts.log(this.name, `${level.toUpperCase()} ${msg}`);
        };
    }

    /** Emulates plugin startup: deterministic device id + index load. */
    async init(): Promise<void> {
        await this.vaultAdapter.mkdir(".obsidian");
        await this.vaultAdapter.write(
            LOCAL_INDEX_PATH,
            JSON.stringify({ index: {}, deviceId: `dev_${this.name}` }),
        );
        await this.sm.loadLocalIndex();
        await this.sm.loadIndex();
    }

    // ─── Vault events (TriggerManager equivalent) ───

    private scheduleEvent(ev: VaultEvent): void {
        if (isInternalPath(ev.path)) return; // Obsidian doesn't emit vault events for config dir
        const delay = this.opts.maxEventDelayMs > 0 ? this.opts.rng.int(0, this.opts.maxEventDelayMs) : 0;
        this.pendingEvents++;
        setTimeout(() => {
            this.pendingEvents--;
            this.deliverEvent(ev);
        }, delay);
    }

    private deliverEvent(ev: VaultEvent): void {
        this.opts.log(this.name, `EVENT ${ev.type}${ev.isFolder ? "(folder)" : ""} ${"oldPath" in ev ? ev.oldPath + " -> " : ""}${ev.path}`);
        switch (ev.type) {
            case "create":
                if (this.sm.shouldIgnore(ev.path)) return;
                this.sm.markDirty(ev.path);
                return;
            case "modify":
                if (ev.isFolder || this.sm.shouldIgnore(ev.path)) return;
                this.sm.markDirty(ev.path);
                return;
            case "delete":
                if (ev.isFolder) this.sm.markFolderDeleted(ev.path);
                else this.sm.markDeleted(ev.path);
                return;
            case "rename":
                if (ev.isFolder) this.sm.markFolderRenamed(ev.oldPath, ev.path);
                else this.sm.markRenamed(ev.oldPath, ev.path);
                return;
        }
    }

    hasPendingEvents(): boolean {
        return this.pendingEvents > 0;
    }

    // ─── User operations ───

    private async ensureParent(path: string): Promise<void> {
        const parts = path.split("/");
        let cur = "";
        for (const p of parts.slice(0, -1)) {
            cur = cur ? `${cur}/${p}` : p;
            if (!(await this.vaultAdapter.exists(cur))) await this.ops.createFolder(cur);
        }
    }

    async userCreate(path: string, content: string | ArrayBuffer): Promise<boolean> {
        if (await this.vaultAdapter.exists(path)) return false;
        await this.ensureParent(path);
        await this.ops.createBinary(path, typeof content === "string" ? enc(content) : content);
        return true;
    }

    async userEdit(path: string, content: string | ArrayBuffer): Promise<boolean> {
        if (!this.vaultAdapter.hasFile(path)) return false;
        const file = this.ops.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) return false;
        await this.ops.modifyBinary(file, typeof content === "string" ? enc(content) : content);
        return true;
    }

    async readBytes(path: string): Promise<Uint8Array | null> {
        if (!this.vaultAdapter.hasFile(path)) return null;
        return new Uint8Array(await this.vaultAdapter.readBinary(path));
    }

    dispose(): void {
        if (this.vaultAdapter instanceof RealFsVaultAdapter) this.vaultAdapter.dispose();
    }

    async userDelete(path: string): Promise<boolean> {
        const file = this.ops.getAbstractFileByPath(path);
        if (!file) return false;
        await this.ops.trashFile(file, true);
        return true;
    }

    async userRename(oldPath: string, newPath: string): Promise<boolean> {
        const file = this.ops.getAbstractFileByPath(oldPath);
        if (!file || (await this.vaultAdapter.exists(newPath))) return false;
        await this.ensureParent(newPath);
        await this.ops.renameFile(file, newPath);
        return true;
    }

    read(path: string): string | null {
        return this.vaultAdapter.getContent(path);
    }

    /** User-visible files (excludes .obsidian/) */
    userFiles(): Record<string, string> {
        const out: Record<string, string> = {};
        for (const p of this.vaultAdapter.listAllFiles().sort()) {
            if (isInternalPath(p)) continue;
            out[p] = this.vaultAdapter.getContent(p) ?? "";
        }
        return out;
    }

    // ─── Sync ───

    /** Fire-and-forget sync (like a trigger). Errors are recorded, not thrown. */
    startSync(trigger: SyncTrigger = "timer-sync", scanVault = false): Promise<void> {
        this.syncsStarted++;
        const p = this.sm
            .requestSmartSync(trigger, scanVault)
            .catch((e) => {
                const msg = e instanceof Error ? e.message : String(e);
                this.syncErrors.push(msg);
                this.opts.log(this.name, `SYNC-ERROR ${msg}`);
            })
            .finally(() => {
                this.syncsFinished++;
                this.inflight.delete(p);
            });
        this.inflight.add(p);
        return p;
    }

    inflightSyncs(): Promise<void>[] {
        return [...this.inflight];
    }

    describe(): Record<string, unknown> {
        return {
            name: this.name,
            fs: this.fs,
            online: this.online,
            joined: this.joined,
            syncState: this.ctx.syncState,
            dirtyPaths: [...this.ctx.dirtyPaths.keys()],
            pendingConflicts: Object.entries(this.ctx.localIndex)
                .filter(([, e]: any) => e.pendingConflict)
                .map(([p]) => p),
            files: this.userFiles(),
            index: this.ctx.index,
            localIndex: this.ctx.localIndex,
            syncErrors: this.syncErrors,
        };
    }
}

function enc(s: string): ArrayBuffer {
    return new TextEncoder().encode(s).buffer as ArrayBuffer;
}
