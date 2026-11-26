import type { CloudAdapter, StorageQuota } from "../types/adapter";
import type { LogLevel } from "./logger";
import { CtxState } from "./context-state";

/**
 * Cloud storage check: once a day after a sync, one small request reads the
 * account's used / total storage. Near full (WARN_RATIO), the user is told
 * once a week: a full account stops every upload, and kept versions and the
 * deleted-files folder fill it without anyone noticing.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
export const STORAGE_CHECK_INTERVAL_MS = DAY_MS;
export const STORAGE_WARN_INTERVAL_MS = 7 * DAY_MS;
export const STORAGE_WARN_RATIO = 0.9;
const STORAGE_FILE = "data/local/storage-check.json";

interface StorageState {
    quota?: StorageQuota;
    checkedAt: number;
    warnedAt: number;
}

interface StorageCtx {
    adapter: CloudAdapter;
    log: (message: string, level?: LogLevel) => Promise<void>;
    notify: (key: string, suffix?: string) => Promise<void>;
    index: Record<string, { size?: number }>;
    pluginDir?: string;
    vault?: {
        exists(path: string): Promise<boolean>;
        read(path: string): Promise<string>;
        write(path: string, data: string): Promise<void>;
        mkdir(path: string): Promise<void>;
    };
}

const storageState = new CtxState<StorageState>("storageCheck", "Last cloud storage reading and warning time");

async function stateOf(ctx: StorageCtx): Promise<StorageState> {
    const cached = storageState.get(ctx);
    if (cached) return cached;
    let s: StorageState = { checkedAt: 0, warnedAt: 0 };
    if (ctx.vault && ctx.pluginDir) {
        try {
            const path = `${ctx.pluginDir}/${STORAGE_FILE}`;
            if (await ctx.vault.exists(path)) {
                const p = JSON.parse(await ctx.vault.read(path)) as Partial<StorageState>;
                s = {
                    quota: p.quota && typeof p.quota.usage === "number" ? p.quota : undefined,
                    checkedAt: typeof p.checkedAt === "number" ? p.checkedAt : 0,
                    warnedAt: typeof p.warnedAt === "number" ? p.warnedAt : 0,
                };
            }
        } catch {
            /* start fresh */
        }
    }
    storageState.set(ctx, s);
    return s;
}

async function save(ctx: StorageCtx, s: StorageState): Promise<void> {
    if (!ctx.vault || !ctx.pluginDir) return;
    try {
        const dir = `${ctx.pluginDir}/data/local`;
        if (!(await ctx.vault.exists(dir))) await ctx.vault.mkdir(dir);
        await ctx.vault.write(`${ctx.pluginDir}/${STORAGE_FILE}`, JSON.stringify(s));
    } catch {
        /* the next check writes it again */
    }
}

/** Share of the account in use (0..1), or null when unlimited or unknown */
export function usageRatio(q: StorageQuota | undefined): number | null {
    if (!q || !q.limit || q.limit <= 0) return null;
    return q.usage / q.limit;
}

/** Read the account's storage now (the settings page's refresh button). Null if unsupported or failed. */
export async function refreshStorage(ctx: StorageCtx, now = Date.now()): Promise<StorageQuota | null> {
    if (!ctx.adapter.getStorageQuota) return null;
    const s = await stateOf(ctx);
    try {
        s.quota = await ctx.adapter.getStorageQuota();
        s.checkedAt = now;
        await save(ctx, s);
        return s.quota;
    } catch (e) {
        await ctx.log(`[Storage] Could not read the cloud storage: ${String(e)}`, "debug");
        return null;
    }
}

/** After a sync: read the storage at most once a day; warn when nearly full (once a week). */
export async function checkStorageIfDue(ctx: StorageCtx, now = Date.now()): Promise<void> {
    if (!ctx.adapter.getStorageQuota) return;
    const s = await stateOf(ctx);
    if (now - s.checkedAt < STORAGE_CHECK_INTERVAL_MS) return;
    const quota = await refreshStorage(ctx, now);
    const ratio = usageRatio(quota ?? undefined);
    if (ratio === null || ratio < STORAGE_WARN_RATIO) return;
    if (now - s.warnedAt < STORAGE_WARN_INTERVAL_MS) return;
    s.warnedAt = now;
    await save(ctx, s);
    await ctx.log(`[Storage] Cloud storage ${Math.round(ratio * 100)}% used.`, "warn");
    await ctx.notify("noticeStorageAlmostFull", `${Math.round(ratio * 100)}%`);
}

export interface StorageSummary {
    quota?: StorageQuota;
    checkedAt: number;
    /** Size of this vault's synced files in the cloud (from the sync index) */
    vaultBytes: number;
}

/** What the settings page shows (no request) */
export async function storageSummary(ctx: StorageCtx): Promise<StorageSummary> {
    const s = await stateOf(ctx);
    let vaultBytes = 0;
    for (const e of Object.values(ctx.index)) vaultBytes += e?.size ?? 0;
    return { quota: s.quota, checkedAt: s.checkedAt, vaultBytes };
}

/** Same as storageSummary, without reading the stored file (settings page drawing) */
export function storageSummaryNow(ctx: StorageCtx): StorageSummary | null {
    const s = storageState.get(ctx);
    if (!s) return null;
    let vaultBytes = 0;
    for (const e of Object.values(ctx.index)) vaultBytes += e?.size ?? 0;
    return { quota: s.quota, checkedAt: s.checkedAt, vaultBytes };
}
