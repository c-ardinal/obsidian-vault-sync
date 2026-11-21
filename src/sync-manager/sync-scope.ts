/**
 * The scope settings (which files this device leaves out, see isDeviceExcluded)
 * the indexes were last reconciled with. Saved in the local index, so a change
 * made just before the app was closed is still noticed by the next sync.
 */
import { CtxState } from "./context-state";
import { isDeviceExcluded, scopeSnapshot } from "./file-utils";
import type { SyncContext } from "./context";
import type { LocalFileIndex } from "./types";

const applied = new CtxState<Record<string, unknown>>(
    "appliedSyncScope",
    "Scope settings (exclusions, content toggles) the indexes were last reconciled with",
);

export function restoreAppliedScope(ctx: object, saved: unknown): void {
    if (saved && typeof saved === "object") applied.set(ctx, saved as Record<string, unknown>);
    else applied.delete(ctx);
}

/** What saveLocalIndex stores (undefined until the first sync reconciled) */
export function appliedScopeOf(ctx: object): Record<string, unknown> | undefined {
    return applied.get(ctx);
}

/**
 * The scope settings now, and the ones last reconciled with when they differ
 * (null when unchanged or never recorded; the current ones are then recorded).
 */
export function takeScopeChange(
    ctx: object,
    settings: object,
): { previous: Record<string, unknown>; current: Record<string, unknown> } | null {
    const current = scopeSnapshot(settings as Record<string, unknown>);
    const previous = applied.get(ctx);
    applied.set(ctx, current);
    if (!previous || JSON.stringify(previous) === JSON.stringify(current)) return null;
    return { previous, current };
}

const skipped = new CtxState<Map<string, LocalFileIndex[string]>>(
    "skippedOutOfScope",
    "Cloud files skipped as left out under scope settings not reconciled yet",
);

/**
 * A cloud file skipped as left out here. When it is left out only by settings
 * changed after the last reconcile, it is remembered: if the settings are
 * changed back before the next sync, that sync sees no scope change, and the
 * skipped change would otherwise never be pulled.
 */
export function noteSkippedOutOfScope(
    ctx: Pick<SyncContext, "settings">,
    path: string,
    entry: LocalFileIndex[string],
): void {
    const scope = applied.get(ctx);
    if (!scope || !entry?.fileId) return;
    if (isDeviceExcluded({ settings: { ...ctx.settings, ...scope } as SyncContext["settings"] }, path)) return;
    let m = skipped.get(ctx);
    if (!m) skipped.set(ctx, (m = new Map()));
    m.set(path, entry);
}

/** The files noted above (and forgets them) */
export function takeSkippedOutOfScope(ctx: object): Map<string, LocalFileIndex[string]> {
    const m = skipped.get(ctx) ?? new Map<string, LocalFileIndex[string]>();
    skipped.delete(ctx);
    return m;
}

const unsettled = new CtxState<boolean>(
    "scopeChangedDuringSync",
    "Scope settings differed from the reconciled ones when a sync ended",
);

/**
 * Called when a sync ends. Settings changed while it ran (the files then left
 * out were skipped by its scan and push) and changed back before the next sync
 * look unchanged to that sync: this remembers that they were not.
 */
export function noteScopeAtSyncEnd(ctx: object, settings: object): void {
    const scope = applied.get(ctx);
    if (!scope) return;
    if (JSON.stringify(scope) !== JSON.stringify(scopeSnapshot(settings as Record<string, unknown>))) unsettled.set(ctx, true);
}

export function takeScopeUnsettled(ctx: object): boolean {
    const v = unsettled.get(ctx) ?? false;
    unsettled.delete(ctx);
    return v;
}
