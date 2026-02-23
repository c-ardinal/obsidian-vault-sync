// Barrel re-export for backward compatibility.

export { computeLocalHash, downloadRemoteIndex, getThresholdBytes,
         generateTransferId, markPendingTransfer } from "./sync-helpers";
export { scanObsidianChanges, scanVaultChanges } from "./sync-scan";
export { smartPull, pullViaChangesAPI } from "./sync-pull";
export { smartPush } from "./sync-push";
export { requestSmartSync, executeSmartSync, requestBackgroundScan,
         isProgressStale, executeFullScan } from "./sync-coordinator";
