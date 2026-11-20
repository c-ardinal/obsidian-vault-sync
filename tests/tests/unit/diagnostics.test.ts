import { describe, it, expect } from "vitest";
import { formatDiagnostics, logTail, settingsLines, type DiagnosticsSnapshot } from "../../../src/sync-manager/diagnostics";

const snapshot = (settings: Record<string, unknown>): DiagnosticsSnapshot => ({
    pluginVersion: "1.2.3",
    obsidianVersion: "1.15.1",
    platform: "Android",
    language: "ja",
    cloud: "Google Drive",
    signedIn: true,
    addOns: [],
    addOnActive: false,
    syncState: "IDLE",
    syncedFiles: 42,
    pendingChanges: 1,
    backgroundTransfers: 0,
    firstSyncDone: true,
    internalState: { deviceRecord: "6 field(s)" },
    settings,
});

describe("diagnostics", () => {
    it("keeps numbers, booleans and choice values, and hides private settings", () => {
        const lines = settingsLines({
            concurrency: 5,
            enableLogging: true,
            notificationLevel: "standard",
            cloudRootFolder: "My Secret Folder",
            customProxyUrl: "",
            exclusionPatterns: "# comment\nprivate/**\n\n*.tmp",
            encryptionSecret: "hunter2",
            e2eeEnabled: true,
            addonAgreements: { x: { name: "X", version: "1", termsHash: "abc", agreedAt: "now" } },
            unknownText: "free text",
            unifiedTriggers: { autoSyncIntervalSec: 60, enableStartupSync: false },
        });
        expect(lines).toEqual([
            "cloudRootFolder: (set)",
            "concurrency: 5",
            "customProxyUrl: (empty)",
            "enableLogging: true",
            "exclusionPatterns: 2 pattern(s)",
            "notificationLevel: standard",
            "unifiedTriggers.autoSyncIntervalSec: 60",
            "unifiedTriggers.enableStartupSync: false",
        ]);
        const text = lines.join("\n");
        for (const secret of ["hunter2", "My Secret Folder", "private/**", "free text", "abc", "e2ee"]) {
            expect(text).not.toContain(secret);
        }
    });

    it("takes the last lines of a log", () => {
        expect(logTail("a\nb\n\nc\nd\n", 3)).toEqual(["b", "c", "d"]);
        expect(logTail("", 3)).toEqual([]);
    });

    it("formats the whole text, with the log only when asked", () => {
        const now = new Date("2026-11-20T00:00:00Z");
        const without = formatDiagnostics(snapshot({ concurrency: 5 }), null, now);
        expect(without).toContain("Plugin: 1.2.3");
        expect(without).toContain("Cloud: Google Drive (signed in)");
        expect(without).toContain("Synced files: 42");
        expect(without).toContain("Internal state: deviceRecord=6 field(s)");
        expect(without).toContain("concurrency: 5");
        expect(without).not.toContain("### Log");

        const withLog = formatDiagnostics(snapshot({}), ["line 1", "line 2"], now);
        expect(withLog).toContain("### Log (last 2 line(s))\n```\nline 1\nline 2\n```");
    });
});
