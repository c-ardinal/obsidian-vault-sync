// === Background Transfer Queue Types ===

/** Priority levels for background transfer queue items */
export enum TransferPriority {
    /** Merge results (safety valve — should normally be handled inline) */
    CRITICAL = 0,
    /** Recently edited files (user is actively working) */
    HIGH = 1,
    /** Standard sync items */
    NORMAL = 2,
    /** Large files detected during full scan */
    LOW = 3,
}

/** A queued background transfer item (in-flight or pending) */
export interface TransferItem {
    id: string;
    direction: "push" | "pull";
    path: string;
    fileId?: string;
    size: number;
    priority: TransferPriority;
    status: "pending" | "active" | "completed" | "failed" | "cancelled";
    retryCount: number;
    createdAt: number;
    startedAt?: number;
    completedAt?: number;
    /** Push: plaintext content buffered at enqueue time */
    content?: ArrayBuffer;
    mtime?: number;
    /** Pull: remote file hash for conflict checking */
    remoteHash?: string;
    /** Hash of content at enqueue time (for staleness detection) */
    snapshotHash?: string;
    /** Error message if transfer failed */
    error?: string;
}

/** Completed/failed transfer record persisted for history UI */
export interface TransferRecord {
    id: string;
    direction: "push" | "pull";
    path: string;
    size: number;
    status: "completed" | "failed" | "cancelled";
    startedAt: number;
    completedAt: number;
    error?: string;
    /** Whether this was processed inline (within sync cycle) or in background queue */
    transferMode: "inline" | "background";
}

/** Callbacks for UI integration (mirrors setActivityCallbacks pattern) */
export interface TransferCallbacks {
    onTransferStart?: (item: TransferItem) => void;
    onTransferComplete?: (record: TransferRecord) => void;
    onTransferFailed?: (record: TransferRecord) => void;
    onQueueChange?: (queue: TransferItem[]) => void;
}
