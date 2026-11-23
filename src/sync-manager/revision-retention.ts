import { capabilitiesOf, type CloudAdapter } from "../types/adapter";
import type { LogLevel } from "./logger";
import { CtxState } from "./context-state";

/**
 * Keeps one version of each note per interval for good.
 *
 * Clouds with version history prune old versions on their own (Google Drive
 * keeps a version 30 days or for the last 100 versions unless it is marked
 * "keep forever"). After a sync, the notes it uploaded get their newest version
 * marked keep-forever when no version of that note was marked within the
 * interval. Markdown notes by default: they are small. Attachments (images,
 * PDFs) only when the user opts in, since every kept version costs storage.
 *
 * Drive refuses more than 200 kept versions per file. Once a note has
 * MAX_KEPT_PER_FILE, the versions this device kept on its own are thinned
 * (daily for the last month, weekly for the last year, monthly before), so
 * new versions keep being kept and old ones stop costing storage. Versions the
 * user kept by hand in the history screen are never released: only the ones
 * recorded in data/local/auto-kept-revisions.json are.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** Stop marking a note's versions once it has this many kept versions */
const MAX_KEPT_PER_FILE = 150;
/** Thinning stops once a note is this far under the limit */
const THIN_TARGET = MAX_KEPT_PER_FILE - 20;
/** Most versions released in one run (spreads the one-time catch-up over days) */
const MAX_RELEASES_PER_RUN = 60;
const AUTO_KEPT_FILE = "data/local/auto-kept-revisions.json";

interface RetentionCtx {
    adapter: CloudAdapter;
    settings: { autoKeepRevisionDays?: number; autoKeepAttachmentRevisions?: boolean };
    log: (message: string, level?: LogLevel) => Promise<void>;
    /** Where the record of auto-kept versions is stored (absent: kept in memory) */
    pluginDir?: string;
    vault?: {
        exists(path: string): Promise<boolean>;
        read(path: string): Promise<string>;
        write(path: string, data: string): Promise<void>;
        mkdir(path: string): Promise<void>;
    };
}

/** Version ids this device kept on its own, per cloud file id */
type AutoKeptRecord = Record<string, string[]>;
const autoKept = new CtxState<AutoKeptRecord>("retentionAutoKept", "Versions this device marked keep-forever on its own (may be thinned)");

async function loadAutoKept(ctx: RetentionCtx): Promise<AutoKeptRecord> {
    const cached = autoKept.get(ctx);
    if (cached) return cached;
    let rec: AutoKeptRecord = {};
    if (ctx.vault && ctx.pluginDir) {
        try {
            const path = `${ctx.pluginDir}/${AUTO_KEPT_FILE}`;
            if (await ctx.vault.exists(path)) {
                const parsed = JSON.parse(await ctx.vault.read(path)) as unknown;
                if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
                        if (Array.isArray(v)) rec[k] = v.filter((x): x is string => typeof x === "string");
                    }
                }
            }
        } catch {
            rec = {};
        }
    }
    autoKept.set(ctx, rec);
    return rec;
}

async function saveAutoKept(ctx: RetentionCtx): Promise<void> {
    const rec = autoKept.get(ctx);
    if (!rec || !ctx.vault || !ctx.pluginDir) return;
    try {
        const dir = `${ctx.pluginDir}/data/local`;
        if (!(await ctx.vault.exists(dir))) await ctx.vault.mkdir(dir);
        await ctx.vault.write(`${ctx.pluginDir}/${AUTO_KEPT_FILE}`, JSON.stringify(rec));
    } catch (e) {
        await ctx.log(`[Revisions] Could not save the auto-kept record: ${String(e)}`, "debug");
    }
}

/** The user set keep-forever on this version by hand: it is theirs, never thinned */
export async function forgetAutoKept(ctx: RetentionCtx, revisionId: string): Promise<void> {
    const rec = await loadAutoKept(ctx);
    let changed = false;
    for (const [fileId, ids] of Object.entries(rec)) {
        if (ids.includes(revisionId)) {
            rec[fileId] = ids.filter((id) => id !== revisionId);
            if (rec[fileId].length === 0) delete rec[fileId];
            changed = true;
        }
    }
    if (changed) await saveAutoKept(ctx);
}

const WEEK_MS = 7 * DAY_MS;

/** Bucket a kept version falls in: its day (last 30 days), week (last year), or month */
function thinningBucket(modifiedTime: number, now: number): string {
    const age = now - modifiedTime;
    if (age <= 30 * DAY_MS) return `d${Math.floor(modifiedTime / DAY_MS)}`;
    if (age <= 365 * DAY_MS) return `w${Math.floor(modifiedTime / WEEK_MS)}`;
    const d = new Date(modifiedTime);
    return `m${d.getUTCFullYear()}-${d.getUTCMonth()}`;
}

/**
 * Versions to release: the auto-kept ones that share their bucket with a newer
 * kept version (any kept version, the user's included, covers its bucket).
 * Oldest first, until the note is THIN_TARGET kept versions or fewer.
 */
export function versionsToThin(
    kept: { id: string; modifiedTime: number }[],
    autoIds: ReadonlySet<string>,
    now: number,
): string[] {
    const newestFirst = kept.slice().sort((a, b) => b.modifiedTime - a.modifiedTime);
    const seen = new Set<string>();
    const spare: { id: string; modifiedTime: number }[] = [];
    for (const r of newestFirst) {
        const bucket = thinningBucket(r.modifiedTime, now);
        if (seen.has(bucket) && autoIds.has(r.id)) spare.push(r);
        seen.add(bucket);
    }
    const excess = kept.length - THIN_TARGET;
    if (excess <= 0) return [];
    return spare
        .sort((a, b) => a.modifiedTime - b.modifiedTime)
        .slice(0, excess)
        .map((r) => r.id);
}

const uploaded = new CtxState<Map<string, string>>("retentionUploaded", "Notes uploaded this sync, waiting for the keep-forever check");
const checkedAt = new CtxState<Map<string, number>>("retentionCheckedAt", "When each note's versions were last checked for keep-forever");

function mapOf<V>(store: CtxState<Map<string, V>>, ctx: object): Map<string, V> {
    let m = store.get(ctx);
    if (!m) store.set(ctx, (m = new Map<string, V>()));
    return m;
}

function intervalMs(ctx: RetentionCtx): number {
    const days = ctx.settings.autoKeepRevisionDays ?? -1;
    return days > 0 ? days * DAY_MS : 0;
}

function applies(ctx: RetentionCtx): boolean {
    return (
        intervalMs(ctx) > 0 &&
        capabilitiesOf(ctx.adapter).revisions &&
        !!ctx.adapter.listRevisions &&
        !!ctx.adapter.setRevisionKeepForever
    );
}

/**
 * Files whose versions are kept: Markdown notes, and with the opt-in the other
 * files of the vault. Never settings or plugin files (anything under a dot folder).
 */
export function keepsVersionsOf(ctx: RetentionCtx, path: string): boolean {
    if (path.toLowerCase().endsWith(".md")) return true;
    return !!ctx.settings.autoKeepAttachmentRevisions && !path.split("/").some((seg) => seg.startsWith("."));
}

/** Record a file this sync uploaded (cheap; the work happens after the sync) */
export function noteUploadedForRetention(ctx: RetentionCtx, path: string, fileId: string): void {
    if (!keepsVersionsOf(ctx, path) || !applies(ctx)) return;
    mapOf(uploaded, ctx).set(path, fileId);
}

/**
 * After a sync: mark the newest version of each uploaded note keep-forever
 * when none was marked within the interval. Each note is looked at most once
 * per interval while the plugin runs. Failures are logged and skipped.
 * Returns the number of versions marked.
 */
export async function keepRevisionsIfDue(ctx: RetentionCtx, now = Date.now()): Promise<number> {
    const pending = uploaded.get(ctx);
    if (!pending || pending.size === 0) return 0;
    const batch = [...pending];
    pending.clear();
    if (!applies(ctx)) return 0;
    const interval = intervalMs(ctx);
    const checked = mapOf(checkedAt, ctx);
    const rec = await loadAutoKept(ctx);
    let recChanged = false;
    let releases = 0;
    let marked = 0;
    for (const [path, fileId] of batch) {
        const last = checked.get(path);
        if (last !== undefined && now - last < interval) continue;
        try {
            const revisions = await ctx.adapter.listRevisions!(path, fileId);
            checked.set(path, now);
            if (revisions.length === 0) continue;
            let kept = revisions.filter((r) => r.keepForever);
            if (rec[fileId]) {
                // Released or gone meanwhile (by hand, or Drive pruned it): not ours to track
                const keptIds = new Set(kept.map((r) => r.id));
                const still = rec[fileId].filter((id) => keptIds.has(id));
                if (still.length !== rec[fileId].length) {
                    if (still.length) rec[fileId] = still;
                    else delete rec[fileId];
                    recChanged = true;
                }
            }
            if (kept.length >= MAX_KEPT_PER_FILE) {
                const thin = versionsToThin(kept, new Set(rec[fileId] ?? []), now).slice(
                    0,
                    Math.max(0, MAX_RELEASES_PER_RUN - releases),
                );
                for (const id of thin) {
                    await ctx.adapter.setRevisionKeepForever!(path, id, false);
                    releases++;
                    rec[fileId] = (rec[fileId] ?? []).filter((x) => x !== id);
                    recChanged = true;
                }
                if (thin.length) {
                    const gone = new Set(thin);
                    kept = kept.filter((r) => !gone.has(r.id));
                    await ctx.log(`[Revisions] Thinned ${thin.length} kept version(s) of ${path}.`, "info");
                }
                if (kept.length >= MAX_KEPT_PER_FILE) continue;
            }
            if (kept.some((r) => now - r.modifiedTime < interval)) continue;
            const newest = revisions.reduce((a, b) => (b.modifiedTime > a.modifiedTime ? b : a));
            if (newest.keepForever) continue;
            await ctx.adapter.setRevisionKeepForever!(path, newest.id, true);
            rec[fileId] = [...(rec[fileId] ?? []), newest.id];
            recChanged = true;
            marked++;
        } catch (e) {
            await ctx.log(`[Revisions] Could not keep a version of ${path}: ${String(e)}`, "debug");
        }
    }
    if (recChanged) await saveAutoKept(ctx);
    if (marked > 0) await ctx.log(`[Revisions] Kept ${marked} note version(s) for good.`, "info");
    return marked;
}
