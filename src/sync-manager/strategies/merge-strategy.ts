import type { SyncContext } from "../context";

/**
 * Parameters passed to a merge strategy.
 */
export interface MergeParams {
    ctx: SyncContext;
    path: string;
    localContent: string;
    remoteContent: string;
    baseHash: string;
}

/**
 * Strategy interface for conflict resolution during sync.
 *
 * Each implementation decides how to reconcile divergent local and remote
 * file content.  Returning `null` signals that the strategy could not
 * produce a merged result and the caller should treat the file as an
 * unresolved conflict (e.g. create a fork copy).
 */
export interface IMergeStrategy {
    merge(params: MergeParams): Promise<ArrayBuffer | null>;
}
