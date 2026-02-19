/**
 * Dev-only screenshot helpers.
 *
 * Opens UI modals (HistoryModal, TransferStatusModal) with injected mock data
 * so developers can capture screenshots without a live Google Drive connection.
 * Only available when isDeveloperMode is enabled in settings.
 */

import { App, Notice, setIcon } from "obsidian";
import type { SyncManager } from "../sync-manager";
import type { FileRevision } from "../types/adapter";
import type { TransferItem, TransferRecord } from "../sync-manager/transfer-types";
import { TransferPriority } from "../sync-manager/transfer-types";
import { HistoryModal } from "./history-modal";
import { TransferStatusModal } from "./transfer-status-modal";
import { PromptModal } from "./prompt-modal";

// ---------------------------------------------------------------------------
// Mock Data: History Modal
// ---------------------------------------------------------------------------

const now = Date.now();

const DEMO_REVISIONS: FileRevision[] = [
    {
        id: "rev_5",
        modifiedTime: now - 1000 * 60 * 30, // 30 min ago
        size: 4521,
        author: "Desktop (Windows)",
        hash: "a1b2c3d4e5f67890",
        keepForever: false,
    },
    {
        id: "rev_4",
        modifiedTime: now - 1000 * 60 * 60 * 2, // 2 hours ago
        size: 4102,
        author: "Mobile (iOS)",
        hash: "b2c3d4e5f6789012",
        keepForever: false,
    },
    {
        id: "rev_3",
        modifiedTime: now - 1000 * 60 * 60 * 24, // 1 day ago
        size: 3850,
        author: "Desktop (Windows)",
        hash: "c3d4e5f678901234",
        keepForever: true,
    },
    {
        id: "rev_2",
        modifiedTime: now - 1000 * 60 * 60 * 24 * 3, // 3 days ago
        size: 2190,
        author: "Desktop (macOS)",
        hash: "d4e5f67890123456",
        keepForever: false,
    },
    {
        id: "rev_1",
        modifiedTime: now - 1000 * 60 * 60 * 24 * 7, // 7 days ago
        size: 1024,
        author: "Mobile (Android)",
        hash: "e5f6789012345678",
        keepForever: false,
    },
];

const DEMO_LOCAL_CONTENT = `# Meeting Notes

## Project Status Update

- Completed API integration
- Fixed critical bug in sync engine
- Updated documentation
- Added E2EE support

### Next Steps

1. Performance testing
2. Code review
3. Deploy to staging
4. Write release notes

### Notes

The sync engine now handles 3-way merge correctly.
All edge cases have been covered with comprehensive tests.
`;

const DEMO_REVISION_CONTENTS: Record<string, string> = {
    rev_5: `# Meeting Notes

## Project Status Update

- Completed API integration
- Fixed critical bug in sync engine
- Updated documentation

### Next Steps

1. Performance testing
2. Code review
3. Deploy to staging

### Notes

The sync engine now handles 3-way merge correctly.
All edge cases have been covered.
`,
    rev_4: `# Meeting Notes

## Project Status Update

- Completed API integration
- Fixed critical bug in sync engine

### Next Steps

1. Performance testing
2. Code review
3. Deploy to staging

### Notes

Need to update documentation for the new merge logic.
`,
    rev_3: `# Meeting Notes

## Project Status Update

- Completed API integration

### Next Steps

1. Fix sync engine bug
2. Performance testing
3. Code review

### Notes

Discovered a bug in the 3-way merge. Investigating.
`,
    rev_2: `# Meeting Notes

## Project Status

- Working on API integration

### Next Steps

1. Complete API integration
2. Testing
`,
    rev_1: `# Meeting Notes

## Initial Draft

Project kickoff meeting.
`,
};

// ---------------------------------------------------------------------------
// Mock Data: Transfer Status Modal
// ---------------------------------------------------------------------------

const DEMO_ACTIVE_TRANSFERS: TransferItem[] = [
    {
        id: "tr_active_1",
        direction: "push",
        path: "Notes/Meeting Notes.md",
        size: 4521,
        priority: TransferPriority.HIGH,
        status: "active",
        retryCount: 0,
        createdAt: now - 5000,
        startedAt: now - 3000,
    },
    {
        id: "tr_active_2",
        direction: "pull",
        path: "Attachments/screenshot-2026-02.png",
        size: 1_258_000,
        priority: TransferPriority.NORMAL,
        status: "pending",
        retryCount: 0,
        createdAt: now - 2000,
    },
    {
        id: "tr_active_3",
        direction: "push",
        path: "Journal/2026-02-20.md",
        size: 2048,
        priority: TransferPriority.NORMAL,
        status: "pending",
        retryCount: 0,
        createdAt: now - 1000,
    },
];

const DEMO_TRANSFER_HISTORY: TransferRecord[] = [
    {
        id: "tr_h1",
        direction: "push",
        path: "Notes/Architecture.md",
        size: 8900,
        status: "completed",
        startedAt: now - 1000 * 60 * 10,
        completedAt: now - 1000 * 60 * 9,
        transferMode: "inline",
    },
    {
        id: "tr_h2",
        direction: "pull",
        path: "Notes/API Design.md",
        size: 5200,
        status: "completed",
        startedAt: now - 1000 * 60 * 10,
        completedAt: now - 1000 * 60 * 9,
        transferMode: "inline",
    },
    {
        id: "tr_h3",
        direction: "push",
        path: "Attachments/diagram.svg",
        size: 34_500,
        status: "failed",
        startedAt: now - 1000 * 60 * 15,
        completedAt: now - 1000 * 60 * 14,
        error: "Network timeout after 30s",
        transferMode: "background",
    },
    {
        id: "tr_h4",
        direction: "pull",
        path: ".obsidian/plugins/vault-sync/data.json",
        size: 1200,
        status: "completed",
        startedAt: now - 1000 * 60 * 30,
        completedAt: now - 1000 * 60 * 29,
        transferMode: "inline",
    },
    {
        id: "tr_h5",
        direction: "push",
        path: "Journal/2026-02-19.md",
        size: 3100,
        status: "cancelled",
        startedAt: now - 1000 * 60 * 60,
        completedAt: now - 1000 * 60 * 59,
        transferMode: "background",
    },
    {
        id: "tr_h6",
        direction: "pull",
        path: "Templates/Daily Note.md",
        size: 780,
        status: "completed",
        startedAt: now - 1000 * 60 * 60 * 2,
        completedAt: now - 1000 * 60 * 60 * 2 + 500,
        transferMode: "inline",
    },
    {
        id: "tr_h7",
        direction: "push",
        path: "Notes/Research/Paper Notes.md",
        size: 12_400,
        status: "completed",
        startedAt: now - 1000 * 60 * 60 * 25,
        completedAt: now - 1000 * 60 * 60 * 25 + 2000,
        transferMode: "background",
    },
    {
        id: "tr_h8",
        direction: "pull",
        path: "Attachments/photo.jpg",
        size: 2_450_000,
        status: "completed",
        startedAt: now - 1000 * 60 * 60 * 25,
        completedAt: now - 1000 * 60 * 60 * 25 + 5000,
        transferMode: "background",
    },
];

// ---------------------------------------------------------------------------
// Proxy Factories
// ---------------------------------------------------------------------------

function createHistoryProxy(real: SyncManager): SyncManager {
    return new Proxy(real, {
        get(target, prop) {
            switch (prop) {
                case "listRevisions":
                    return async () => [...DEMO_REVISIONS];
                case "getRevisionContent":
                    return async (_path: string, revId: string) => {
                        const text = DEMO_REVISION_CONTENTS[revId] ?? "";
                        return new TextEncoder().encode(text).buffer;
                    };
                case "setRevisionKeepForever":
                case "restoreRevision":
                case "deleteRevision":
                    return async () => {};
                case "notify":
                    return async () => {};
                default:
                    return (target as any)[prop];
            }
        },
        set() {
            return true; // silently ignore writes (e.g. currentTrigger)
        },
    }) as SyncManager;
}

function createTransferProxy(real: SyncManager): SyncManager {
    return new Proxy(real, {
        get(target, prop) {
            switch (prop) {
                case "getActiveTransfers":
                    return () => [...DEMO_ACTIVE_TRANSFERS];
                case "getTransferHistory":
                    return () => [...DEMO_TRANSFER_HISTORY];
                default:
                    return (target as any)[prop];
            }
        },
    }) as SyncManager;
}

function createAppProxyForHistory(real: App): App {
    return new Proxy(real, {
        get(target, prop) {
            if (prop === "vault") {
                return new Proxy(target.vault, {
                    get(vt, vp) {
                        if (vp === "read") {
                            return async () => DEMO_LOCAL_CONTENT;
                        }
                        return (vt as any)[vp];
                    },
                });
            }
            return (target as any)[prop];
        },
    }) as App;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Opens a HistoryModal populated with demo revision data.
 * No Google Drive connection required.
 */
export function openDemoHistoryModal(app: App, syncManager: SyncManager): void {
    const mockApp = createAppProxyForHistory(app);
    const mockSM = createHistoryProxy(syncManager);
    const mockFile = {
        name: "Meeting Notes.md",
        path: "__dev-demo__/Meeting Notes.md",
        extension: "md",
        basename: "Meeting Notes",
        stat: { ctime: now, mtime: now, size: DEMO_LOCAL_CONTENT.length },
        vault: app.vault,
        parent: null,
    };
    new HistoryModal(mockApp, mockSM, mockFile as any).open();
}

/**
 * Opens a TransferStatusModal populated with demo transfer data.
 * No Google Drive connection required.
 */
export function openDemoTransferStatusModal(app: App, syncManager: SyncManager): void {
    const mockSM = createTransferProxy(syncManager);
    new TransferStatusModal(app, mockSM).open();
}

/**
 * Fires a sequence of representative notifications with staggered timing.
 * Useful for capturing a screenshot showing multiple notification types.
 */
export function showDemoNotifications(syncManager: SyncManager): void {
    const t = syncManager.t.bind(syncManager);

    const messages: { text: string; delayMs: number }[] = [
        { text: t("noticeSyncing"), delayMs: 0 },
        { text: `${t("noticeFilePulled")}: Notes/Architecture.md`, delayMs: 600 },
        { text: `${t("noticeFilePushed")}: Journal/2026-02-20.md`, delayMs: 1200 },
        { text: `${t("noticeMergingFile").replace("{0}", "Meeting Notes.md")}`, delayMs: 1800 },
        { text: `${t("noticeMergeSuccess").replace("{0}", "Meeting Notes.md")}`, delayMs: 2400 },
        { text: t("noticeVaultUpToDate"), delayMs: 3000 },
    ];

    for (const { text, delayMs } of messages) {
        setTimeout(() => new Notice(text, 8000), delayMs);
    }
}

/**
 * Triggers the ribbon sync icon spinning animation for a set duration.
 * The icon spins and then reverts — no actual sync is performed.
 */
export function startDemoSyncAnimation(
    ribbonEl: HTMLElement | null,
    fabEl: HTMLElement | null,
    durationMs: number = 5000,
): void {
    const targets: { el: HTMLElement; originalIcon: string }[] = [];

    if (ribbonEl) {
        targets.push({ el: ribbonEl, originalIcon: "sync" });
    }
    if (fabEl) {
        targets.push({ el: fabEl, originalIcon: "sync" });
    }

    if (targets.length === 0) return;

    for (const t of targets) {
        setIcon(t.el, "sync");
        t.el.addClass("vault-sync-spinning");
        if (t.el.classList.contains("vault-sync-mobile-fab")) {
            t.el.addClass("is-active");
        }
    }

    setTimeout(() => {
        for (const t of targets) {
            t.el.removeClass("vault-sync-spinning");
            if (t.el.classList.contains("vault-sync-mobile-fab")) {
                t.el.removeClass("is-active");
            }
            setIcon(t.el, t.originalIcon);
        }
    }, durationMs);
}

/**
 * Opens a PromptModal with demo "Restore As" content.
 */
export function openDemoPromptModal(app: App, syncManager: SyncManager): void {
    const t = syncManager.t.bind(syncManager);
    new PromptModal(
        app,
        t("historyRestoreAsTitle"),
        "Notes/Meeting Notes_restored.md",
        () => {}, // no-op on submit
        async (val) => {
            if (!val) return null;
            // Simulate a validation error for paths containing "existing"
            if (val.includes("existing")) {
                return t("historyRestoreAsErrorExists");
            }
            return null;
        },
    ).open();
}
