import type { CloudAdapter } from "../types/adapter";
import type { IVaultOperations } from "../types/vault-operations";
import type { LogLevel } from "./logger";
import { REMOTE_DEVICE_DIR } from "./remote-layout";
import { removeRemote, type RemoteDeletionService } from "./remote-deletion";

/**
 * Which devices sync this vault, and what each of them changed.
 *
 * Every device keeps one record file on the cloud, written only by itself, so
 * no two devices ever write the same file:
 *
 *   <plugin folder>/data/remote/devices/<device id>.json
 *
 * It holds the device's name, platform, last sync time and its recent changes
 * (notes it created, edited, renamed or deleted, and conflicts it kept a copy
 * for), newest first. The record goes through the same adapter as the vault's
 * files. After a sync it is written when the sync changed something, or when
 * the last write is older than PUBLISH_INTERVAL_MS (so "last sync" stays
 * current without a write per sync).
 *
 * The device's name is local (data/local/device.json, never synced): each
 * device names itself.
 */

/** Folder of the record files, relative to the plugin folder */
export const DEVICE_DIR = REMOTE_DEVICE_DIR;
const LOCAL_DEVICE_FILE = "data/local/device.json";
const RECORD_FORMAT_VERSION = 1;
/** Changes kept per device */
export const MAX_ACTIVITY = 300;
const PUBLISH_INTERVAL_MS = 6 * 60 * 60 * 1000;

export type ActivityOp = "create" | "edit" | "delete" | "rename" | "conflict";

export interface ActivityEntry {
    /** Time of the change (ms) */
    t: number;
    op: ActivityOp;
    path: string;
    /** Previous path of a rename */
    from?: string;
}

export interface DeviceRecord {
    formatVersion: number;
    id: string;
    name: string;
    platform: string;
    lastSyncAt: number;
    /** Newest first */
    activity: ActivityEntry[];
}

export interface DeviceCtx {
    adapter: CloudAdapter;
    vault: Pick<IVaultOperations, "exists" | "read" | "write" | "mkdir">;
    pluginDir: string;
    deviceId: string;
    /** Platform label and default name of this device (set by the plugin) */
    deviceInfo?: { platform: string; defaultName: string };
    log: (message: string, level?: LogLevel) => Promise<void>;
    remoteDeletion?: RemoteDeletionService;
}

interface DeviceState {
    pending: ActivityEntry[];
    /** This device's record as last written (or read) */
    own: DeviceRecord | null;
    ownFileId: string | null;
    loaded: boolean;
    lastPublish: number;
    name: string | null;
}

const states = new WeakMap<object, DeviceState>();

function stateOf(ctx: object): DeviceState {
    let s = states.get(ctx);
    if (!s) {
        s = { pending: [], own: null, ownFileId: null, loaded: false, lastPublish: 0, name: null };
        states.set(ctx, s);
    }
    return s;
}

export function deviceRecordPath(ctx: Pick<DeviceCtx, "pluginDir">, deviceId: string): string {
    return `${ctx.pluginDir}/${DEVICE_DIR}/${deviceId}.json`;
}

/** The config folder (parent of the plugins folder): its files are settings, not notes */
function isSettingsPath(ctx: Pick<DeviceCtx, "pluginDir">, path: string): boolean {
    const i = ctx.pluginDir.lastIndexOf("/plugins/");
    const configDir = i > 0 ? ctx.pluginDir.slice(0, i) : ctx.pluginDir;
    return path.startsWith(configDir + "/");
}

/** Note a change this device made to the cloud (cheap; written after the sync) */
export function recordActivity(ctx: DeviceCtx, op: ActivityOp, path: string, from?: string, now = Date.now()): void {
    if (isSettingsPath(ctx, path)) return;
    const entry: ActivityEntry = { t: now, op, path };
    if (from !== undefined) entry.from = from;
    const pending = stateOf(ctx).pending;
    pending.push(entry);
    if (pending.length > MAX_ACTIVITY) pending.splice(0, pending.length - MAX_ACTIVITY);
}

/** This device's name: the one the user gave, else the default */
export async function getDeviceName(ctx: DeviceCtx): Promise<string> {
    const s = stateOf(ctx);
    if (s.name !== null) return s.name || defaultName(ctx);
    s.name = "";
    try {
        const path = `${ctx.pluginDir}/${LOCAL_DEVICE_FILE}`;
        if (await ctx.vault.exists(path)) {
            const parsed = JSON.parse(await ctx.vault.read(path)) as { name?: unknown };
            if (typeof parsed.name === "string") s.name = parsed.name.trim();
        }
    } catch {
        // unreadable: the default name is used
    }
    return s.name || defaultName(ctx);
}

function defaultName(ctx: DeviceCtx): string {
    const base = ctx.deviceInfo?.defaultName || "Device";
    return ctx.deviceId ? `${base} (${ctx.deviceId.slice(0, 4)})` : base;
}

/** Rename this device. An empty name returns to the default. Written to the cloud at the next sync. */
export async function setDeviceName(ctx: DeviceCtx, name: string): Promise<void> {
    const s = stateOf(ctx);
    s.name = name.trim();
    const dir = `${ctx.pluginDir}/data/local`;
    if (!(await ctx.vault.exists(dir))) await ctx.vault.mkdir(dir);
    await ctx.vault.write(`${ctx.pluginDir}/${LOCAL_DEVICE_FILE}`, JSON.stringify({ name: s.name }));
    s.lastPublish = 0;
}

function parseRecord(text: string): DeviceRecord | null {
    try {
        const r = JSON.parse(text) as Partial<DeviceRecord>;
        if (typeof r.id !== "string" || !r.id) return null;
        return {
            formatVersion: typeof r.formatVersion === "number" ? r.formatVersion : 0,
            id: r.id,
            name: typeof r.name === "string" ? r.name : r.id,
            platform: typeof r.platform === "string" ? r.platform : "",
            lastSyncAt: typeof r.lastSyncAt === "number" ? r.lastSyncAt : 0,
            activity: Array.isArray(r.activity)
                ? r.activity.filter(
                      (a): a is ActivityEntry =>
                          !!a && typeof a.t === "number" && typeof a.op === "string" && typeof a.path === "string",
                  )
                : [],
        };
    } catch {
        return null;
    }
}

async function loadOwn(ctx: DeviceCtx, s: DeviceState): Promise<void> {
    if (s.loaded) return;
    const meta = await ctx.adapter.getFileMetadata(deviceRecordPath(ctx, ctx.deviceId));
    if (meta?.id) {
        s.ownFileId = meta.id;
        const text = new TextDecoder().decode(await ctx.adapter.downloadFile(meta.id));
        s.own = parseRecord(text);
    }
    s.loaded = true;
}

/**
 * After a sync: write this device's record when the sync changed something
 * or the last write is old. Failures are logged; the changes stay pending.
 */
export async function publishDeviceRecordIfDue(ctx: DeviceCtx, now = Date.now()): Promise<boolean> {
    if (!ctx.deviceId) return false;
    const s = stateOf(ctx);
    if (s.pending.length === 0 && now - s.lastPublish < PUBLISH_INTERVAL_MS) return false;
    const taken = s.pending.length;
    try {
        await loadOwn(ctx, s);
        const fresh = [...s.pending].reverse();
        const record: DeviceRecord = {
            formatVersion: RECORD_FORMAT_VERSION,
            id: ctx.deviceId,
            name: await getDeviceName(ctx),
            platform: ctx.deviceInfo?.platform ?? "",
            lastSyncAt: now,
            activity: [...fresh, ...(s.own?.activity ?? [])].slice(0, MAX_ACTIVITY),
        };
        const data = new TextEncoder().encode(JSON.stringify(record)).buffer;
        const path = deviceRecordPath(ctx, ctx.deviceId);
        let uploaded;
        try {
            uploaded = await ctx.adapter.uploadFile(path, data, now, s.ownFileId ?? undefined);
        } catch (e) {
            if (!s.ownFileId) throw e;
            // The record was removed meanwhile (another device forgot this one): write it anew
            s.ownFileId = null;
            uploaded = await ctx.adapter.uploadFile(path, data, now);
        }
        s.ownFileId = uploaded.id;
        s.own = record;
        s.pending.splice(0, taken);
        s.lastPublish = now;
        return true;
    } catch (e) {
        await ctx.log(`[Devices] Could not write this device's record: ${String(e)}`, "debug");
        return false;
    }
}

/** Records of all devices on the cloud, latest sync first */
export async function listDevices(ctx: DeviceCtx): Promise<DeviceRecord[]> {
    const dirPath = `${ctx.pluginDir}/${DEVICE_DIR}`;
    const dir = await ctx.adapter.getFileMetadata(dirPath);
    // Without a folder entry (clouds that keep no folders), look through the whole listing
    const files =
        dir?.kind === "folder" && dir.id
            ? (await ctx.adapter.listFiles(dir.id)).filter((f) => !f.path.includes("/"))
            : (await ctx.adapter.listFiles()).filter((f) => f.path.startsWith(dirPath + "/"));
    const records: DeviceRecord[] = [];
    for (const f of files) {
        if (f.kind !== "file" || !f.path.endsWith(".json")) continue;
        try {
            const r = parseRecord(new TextDecoder().decode(await ctx.adapter.downloadFile(f.id)));
            if (r) records.push(r);
        } catch (e) {
            await ctx.log(`[Devices] Could not read ${f.path}: ${String(e)}`, "debug");
        }
    }
    // This device's unwritten changes count too
    const s = stateOf(ctx);
    const own = records.find((r) => r.id === ctx.deviceId);
    if (own && s.pending.length > 0) own.activity = [...[...s.pending].reverse(), ...own.activity];
    return records.sort((a, b) => b.lastSyncAt - a.lastSyncAt);
}

/** One change with the device that made it */
export interface DeviceActivity extends ActivityEntry {
    deviceId: string;
    deviceName: string;
}

/** The changes of all devices, newest first */
export function mergeActivity(records: DeviceRecord[]): DeviceActivity[] {
    const all: DeviceActivity[] = [];
    for (const r of records) {
        for (const a of r.activity) all.push({ ...a, deviceId: r.id, deviceName: r.name });
    }
    return all.sort((a, b) => b.t - a.t);
}

/**
 * Forget another device: its record is removed from the cloud. It comes back
 * when that device syncs again. This device cannot be forgotten.
 */
export async function forgetDevice(ctx: DeviceCtx, deviceId: string): Promise<void> {
    if (deviceId === ctx.deviceId) throw new Error("This device cannot be removed from the list.");
    const meta = await ctx.adapter.getFileMetadata(deviceRecordPath(ctx, deviceId));
    if (meta?.id) await removeRemote(ctx, { id: meta.id, path: meta.path, kind: "file" }, "maintenance");
}
