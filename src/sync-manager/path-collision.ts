import type { SyncContext } from "./context";
import { basename, dirname } from "../utils/path";
import { CtxState } from "./context-state";

/** What this module reads from the sync context */
export type PathCollisionCtx = Pick<
    SyncContext,
    | "dirtyPaths"
    | "index"
    | "localIndex"
    | "vault"
>;

/**
 * Paths that differ only in letter case or Unicode normalization (NFC "é" vs
 * NFD "e" + accent) are different files in the cloud, but the SAME file on
 * Windows (case-insensitive) and macOS (case- and normalization-insensitive).
 * Syncing both onto such a device makes one overwrite or delete the other.
 *
 * Policy: the cloud must never hold two such names. The file that arrives
 * second is renamed to "name (2).ext" (in the cloud too, so every device
 * agrees on one name per file).
 */
export function pathKey(path: string): string {
    return path.normalize("NFC").toLowerCase();
}

/**
 * Another synced file (different file id) whose path collides with `path`.
 * Folder-only differences count too: "Projects/a.md" vs "projects/a.md".
 */
export function findPathCollision(
    ctx: PathCollisionCtx,
    path: string,
    fileId?: string,
): string | null {
    const key = pathKey(path);
    for (const [other, entry] of Object.entries(ctx.index)) {
        if (other === path || pathKey(other) !== key) continue;
        if (fileId && entry.fileId === fileId) continue;
        return other;
    }
    // Pulls run in parallel: a clashing file being downloaded right now is not
    // in the index yet, but it will land on the same local file.
    const claim = inFlight(ctx).get(key);
    if (claim && claim.path !== path && (!fileId || claim.fileId !== fileId)) return claim.path;
    return null;
}

/**
 * Mark `path` as being pulled (file `fileId`) until the returned release is called,
 * so a parallel pull of a colliding name sees it. Returns null when another file
 * already holds the name (the caller must rename instead).
 */
export function claimPullPath(ctx: PathCollisionCtx, path: string, fileId: string): (() => void) | null {
    const key = pathKey(path);
    const m = inFlight(ctx);
    const cur = m.get(key);
    if (cur && cur.fileId !== fileId) return null;
    const claim = { path, fileId };
    m.set(key, claim);
    return () => {
        if (m.get(key) === claim) m.delete(key);
    };
}

const pulls = new CtxState<Map<string, { path: string; fileId: string }>>("pullsInFlight", "Pulls running now, by folded path");
function inFlight(ctx: PathCollisionCtx): Map<string, { path: string; fileId: string }> {
    let m = pulls.get(ctx);
    if (!m) pulls.set(ctx, (m = new Map<string, { path: string; fileId: string }>()));
    return m;
}

/** First "name (n).ext" next to `path` whose key is free in the index and locally. */
export async function freeCollisionPath(ctx: PathCollisionCtx, path: string): Promise<string> {
    const dir = dirname(path);
    const name = basename(path);
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    const used = new Set([
        ...Object.keys(ctx.index).map(pathKey),
        ...[...ctx.dirtyPaths.keys()].map(pathKey),
        ...reservedKeys(ctx),
        ...inFlight(ctx).keys(),
    ]);
    for (let n = 2; n < 1000; n++) {
        const candidate = `${dir ? dir + "/" : ""}${stem} (${n})${ext}`;
        if (used.has(pathKey(candidate))) continue;
        if (await ctx.vault.exists(candidate)) continue;
        // Two clashing notes renamed in the same pass must not land on one name
        reservedKeys(ctx).add(pathKey(candidate));
        return candidate;
    }
    return `${dir ? dir + "/" : ""}${stem} (${Date.now()})${ext}`;
}

const reserved = new CtxState<Set<string>>("reservedPaths", "Paths reserved for files being renamed apart");
function reservedKeys(ctx: PathCollisionCtx): Set<string> {
    let r = reserved.get(ctx);
    if (!r) reserved.set(ctx, (r = new Set()));
    return r;
}

/** Move a file's index / local-index entries and dirty mark to its new path. */
export function moveIndexEntry(ctx: PathCollisionCtx, from: string, to: string): void {
    if (ctx.index[from]) {
        ctx.index[to] = { ...ctx.index[from] };
        delete ctx.index[from];
    }
    if (ctx.localIndex[from]) {
        ctx.localIndex[to] = { ...ctx.localIndex[from] };
        delete ctx.localIndex[from];
    }
    if (ctx.dirtyPaths.has(from)) {
        ctx.dirtyPaths.delete(from);
        ctx.dirtyPaths.set(to, Date.now());
    }
}
