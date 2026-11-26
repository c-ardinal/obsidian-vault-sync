import type { CloudAdapter } from "../types/adapter";

/**
 * Why a file or folder is removed from the cloud. Every remote removal names one,
 * so that how it is removed (today: always at once) and which removals a later
 * step covers (moving to a trash, asking before many removals, a deletion log)
 * are decided in this one place instead of at each call site.
 */
export type RemoteDeletionReason =
    /** A file the user deleted on this device */
    | "user-file"
    /** A folder the user deleted on this device */
    | "user-folder"
    /** Files or folders the sync scope no longer allows on the cloud */
    | "excluded-cleanup"
    /** Internal folders and files that must never be on the cloud */
    | "system-cleanup"
    /** Our own earlier upload of a file that was deleted before the upload finished */
    | "superseded-upload"
    /** Plugin-managed files and folders (locks, migration work folders) */
    | "maintenance";

export interface RemoteDeletionTarget {
    /** Cloud file id */
    id: string;
    /** Vault path (or cloud name for items outside the vault), for logs and records */
    path: string;
    kind?: "file" | "folder";
}

export interface RemoteDeletionRecord extends RemoteDeletionTarget {
    reason: RemoteDeletionReason;
    /** Unix time (ms) of the removal */
    at: number;
}

/** How a removal is carried out. Swapped as a whole, e.g. for a trash-based one. */
export interface RemoteDeletionStrategy {
    remove(
        adapter: CloudAdapter,
        target: RemoteDeletionTarget,
        reason: RemoteDeletionReason,
    ): Promise<void>;
}

/** Removes at once through the adapter (the behaviour of every version so far). */
export const immediateRemoteDeletion: RemoteDeletionStrategy = {
    remove: (adapter, target) => adapter.deleteFile(target.id),
};

export type RemoteDeletionListener = (record: RemoteDeletionRecord) => void;

/**
 * The single way to remove something from the cloud. The adapter is passed per
 * call because the sync's adapter changes while the plugin runs (an add-on can
 * wrap it), and services outside the sync use the base adapter.
 */
export class RemoteDeletionService {
    private readonly listeners = new Set<RemoteDeletionListener>();

    constructor(
        private strategy: RemoteDeletionStrategy = immediateRemoteDeletion,
        private readonly now: () => number = () => Date.now(),
    ) {}

    setStrategy(strategy: RemoteDeletionStrategy): void {
        this.strategy = strategy;
    }

    async remove(
        adapter: CloudAdapter,
        target: RemoteDeletionTarget,
        reason: RemoteDeletionReason,
    ): Promise<void> {
        await this.strategy.remove(adapter, target, reason);
        const record: RemoteDeletionRecord = { ...target, reason, at: this.now() };
        for (const listener of this.listeners) {
            try {
                listener(record);
            } catch (e) {
                // A listener (log, UI) must never turn a done removal into a failure.
                console.error("Vault Syncer: remote deletion listener failed", e);
            }
        }
    }

    /** Called after each successful removal. Returns a function that unsubscribes. */
    onRemoved(listener: RemoteDeletionListener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
}

/** Used when a context carries no service of its own (test contexts). */
const fallbackService = new RemoteDeletionService();

/** The deletion service of a sync context. */
export function remoteDeletionOf(ctx: { remoteDeletion?: RemoteDeletionService }): RemoteDeletionService {
    return ctx.remoteDeletion ?? fallbackService;
}

/** Remove a file or folder from the cloud through the sync's current adapter. */
export function removeRemote(
    ctx: { adapter: CloudAdapter; remoteDeletion?: RemoteDeletionService },
    target: RemoteDeletionTarget,
    reason: RemoteDeletionReason,
): Promise<void> {
    return remoteDeletionOf(ctx).remove(ctx.adapter, target, reason);
}
