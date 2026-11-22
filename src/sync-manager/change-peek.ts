import { capabilitiesOf, type CloudChanges } from "../types/adapter";
import type { SyncContext } from "./context";
import { CtxState } from "./context-state";
import { pendingPullsOf, type SyncHelpersCtx } from "./sync-helpers";

/**
 * One look at the change feed, shared by the checks at the start of a sync.
 *
 * A sync that finds nothing new used to read the vault-lock, the merge locks
 * (communication.json, two calls) and the change feed: four cloud calls every
 * few seconds while the app is open. All of those files live in the synced
 * cloud folder, so a change to any of them shows up in the change feed. When
 * the feed is empty and nothing local waits, the first page alone answers
 * "nothing to do", and the other reads are skipped.
 *
 * The page is read once and handed to the pull, so an active sync costs no
 * extra call either.
 */

interface PeekedPage {
    /** The token the page was read from */
    token: string;
    page: CloudChanges;
    at: number;
}

const peeked = new CtxState<PeekedPage>(
    "changePeek",
    "First change-feed page read before the sync, handed to the pull",
);

/**
 * A page older than this is read again. An old empty page is still correct
 * (changes after it stay after its token), it only shows them one sync later.
 */
const PEEK_MAX_AGE_MS = 60_000;

export type ChangePeekCtx = Pick<
    SyncContext,
    "adapter" | "startPageToken" | "index" | "localIndex" | "dirtyPaths" | "forceCleanupNextSync"
> &
    SyncHelpersCtx;

/** True when the page holds no change and no further page */
export function isEmptyChangePage(page: CloudChanges): boolean {
    return page.changes.length === 0 && !page.nextPageToken;
}

/**
 * The first change-feed page from the stored token, read at most once per
 * sync. Null when the feed cannot be used yet (no feed, no token, empty index:
 * the pull then falls back to its full checks).
 */
export async function peekChanges(ctx: ChangePeekCtx): Promise<CloudChanges | null> {
    const token = ctx.startPageToken;
    if (!token || !capabilitiesOf(ctx.adapter).changeFeed || !ctx.adapter.getChanges) return null;
    if (Object.keys(ctx.index).length === 0) return null;
    const cached = peeked.get(ctx);
    if (cached && cached.token === token && Date.now() - cached.at < PEEK_MAX_AGE_MS) {
        return cached.page;
    }
    const page = await ctx.adapter.getChanges(token);
    peeked.set(ctx, { token, page, at: Date.now() });
    return page;
}

/** The peeked page for this token, removed so the next sync reads afresh */
export function takePeekedChanges(ctx: object, token: string): CloudChanges | undefined {
    const cached = peeked.get(ctx);
    peeked.delete(ctx);
    if (!cached || cached.token !== token || Date.now() - cached.at >= PEEK_MAX_AGE_MS) return undefined;
    return cached.page;
}

/**
 * Something on this device waits for the sync: an edit to upload, a pull to
 * retry, a file held by another device's merge, a requested cleanup. Then the
 * sync runs its full checks whatever the feed says.
 */
export function hasLocalSyncWork(ctx: ChangePeekCtx): boolean {
    if (ctx.dirtyPaths.size > 0 || ctx.forceCleanupNextSync) return true;
    if (pendingPullsOf(ctx).size > 0) return true;
    return Object.values(ctx.localIndex).some((e) => e.pendingConflict);
}

/**
 * True when the change feed shows nothing new and nothing waits locally: the
 * reads that only matter when something changed can be skipped.
 */
export async function isQuietCycle(ctx: ChangePeekCtx): Promise<boolean> {
    if (hasLocalSyncWork(ctx)) return false;
    const page = await peekChanges(ctx);
    return page !== null && isEmptyChangePage(page);
}
