// === Merge Engine ===

/** Maximum file size (bytes) for inline download during pull/merge. Files larger than this are skipped. */
export const MERGE_MAX_INLINE_DOWNLOAD_BYTES = 100 * 1024 * 1024; // 100 MB

/** diff-match-patch: threshold for fuzzy matching (0.0 = exact, 1.0 = very loose) */
export const MERGE_DMP_MATCH_THRESHOLD = 0.5;

/** diff-match-patch: how far from expected location to search for a match (characters) */
export const MERGE_DMP_MATCH_DISTANCE = 250;

/** diff-match-patch: threshold for deleting vs keeping unmatched patch content */
export const MERGE_DMP_PATCH_DELETE_THRESHOLD = 0.5;

/** Patch_Margin values tried in order during 3-way merge (broader → narrower context) */
export const MERGE_PATCH_MARGINS = [4, 2, 1] as const;

// === Merge Lock ===

/** Maximum retry attempts when acquiring a merge lock under contention */
export const LOCK_MAX_ATTEMPTS = 3;

/** Time-to-live (ms) for a merge lock before it is considered expired */
export const LOCK_TTL_MS = 60_000;

/** Minimum jitter delay (ms) before retrying a contended lock */
export const LOCK_JITTER_MIN_MS = 200;

/** Random jitter range (ms) added to the minimum delay on lock retry */
export const LOCK_JITTER_RANGE_MS = 600;

// === Background Transfer ===

/** Maximum number of transfer history records retained in memory and on disk */
export const TRANSFER_MAX_HISTORY = 500;

/** Maximum retry attempts for a failed background transfer */
export const TRANSFER_MAX_RETRIES = 3;

/** Base delay (ms) for exponential back-off between transfer retries */
export const TRANSFER_RETRY_BASE_DELAY_MS = 5_000;

/** Maximum delay cap (ms) for exponential back-off */
export const TRANSFER_RETRY_MAX_DELAY_MS = 60_000;

/** Number of transfer records batched before flushing to disk */
export const TRANSFER_HISTORY_FLUSH_BATCH = 10;

/** Days to retain transfer log files before pruning */
export const TRANSFER_LOG_RETENTION_DAYS = 7;

// === Sync Orchestration ===

/** Maximum retries for post-push confirmation pull */
export const SYNC_POST_PUSH_PULL_MAX_RETRIES = 2;

/** Minimum remote index file size (bytes) below which an empty parse is considered valid */
export const INTEGRITY_MIN_INDEX_SIZE_BYTES = 200;

/** Minimum local file count that triggers safety halt when remote index is empty */
export const INTEGRITY_MIN_LOCAL_FILE_COUNT = 20;

// === Full Scan ===

/** Number of files processed per chunk during a resumable full scan */
export const SCAN_FULL_SCAN_CHUNK_SIZE = 10;

/** Maximum age (ms) of a full scan progress snapshot before it is discarded */
export const SCAN_FULL_SCAN_MAX_AGE_MS = 5 * 60 * 1000;
