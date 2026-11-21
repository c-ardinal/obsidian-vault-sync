/**
 * The scope settings (which files this device leaves out, see isDeviceExcluded)
 * the indexes were last reconciled with. Saved in the local index, so a change
 * made just before the app was closed is still noticed by the next sync.
 */
import { CtxState } from "./context-state";
import { scopeSnapshot } from "./file-utils";

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
