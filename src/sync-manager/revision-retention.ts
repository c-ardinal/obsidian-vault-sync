import { capabilitiesOf, type CloudAdapter } from "../types/adapter";
import type { LogLevel } from "./logger";

/**
 * Keeps one version of each note per interval for good.
 *
 * Clouds with version history prune old versions on their own (Google Drive
 * keeps a version 30 days or for the last 100 versions unless it is marked
 * "keep forever"). After a sync, the notes it uploaded get their newest version
 * marked keep-forever when no version of that note was marked within the
 * interval. Only Markdown notes: they are small, and other files (images,
 * PDFs) would cost storage for every kept version.
 *
 * A note with many kept versions is left alone (Drive refuses more than 200
 * per file), so a manual "keep forever" in the history screen stays possible.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** Stop marking a note's versions once it has this many kept versions */
const MAX_KEPT_PER_FILE = 150;

interface RetentionCtx {
    adapter: CloudAdapter;
    settings: { autoKeepRevisionDays?: number };
    log: (message: string, level?: LogLevel) => Promise<void>;
}

const uploaded = new WeakMap<object, Map<string, string>>();
const checkedAt = new WeakMap<object, Map<string, number>>();

function mapOf<V>(store: WeakMap<object, Map<string, V>>, ctx: object): Map<string, V> {
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

/** Record a note this sync uploaded (cheap; the work happens after the sync) */
export function noteUploadedForRetention(ctx: RetentionCtx, path: string, fileId: string): void {
    if (!path.toLowerCase().endsWith(".md") || !applies(ctx)) return;
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
    let marked = 0;
    for (const [path, fileId] of batch) {
        const last = checked.get(path);
        if (last !== undefined && now - last < interval) continue;
        try {
            const revisions = await ctx.adapter.listRevisions!(path, fileId);
            checked.set(path, now);
            if (revisions.length === 0) continue;
            const kept = revisions.filter((r) => r.keepForever);
            if (kept.length >= MAX_KEPT_PER_FILE) continue;
            if (kept.some((r) => now - r.modifiedTime < interval)) continue;
            const newest = revisions.reduce((a, b) => (b.modifiedTime > a.modifiedTime ? b : a));
            if (newest.keepForever) continue;
            await ctx.adapter.setRevisionKeepForever!(path, newest.id, true);
            marked++;
        } catch (e) {
            await ctx.log(`[Revisions] Could not keep a version of ${path}: ${String(e)}`, "debug");
        }
    }
    if (marked > 0) await ctx.log(`[Revisions] Kept ${marked} note version(s) for good.`, "info");
    return marked;
}
