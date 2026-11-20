/**
 * Diagnostic info for a support request: versions, settings and sync state,
 * with an optional tail of the log. Built as plain text for the user to read
 * and paste.
 *
 * Nothing secret goes in: settings are copied by an allow rule (numbers,
 * booleans and known choice values), free text settings only say whether
 * they are set, and credentials, add-on secrets and the vault name are left
 * out. The log tail can hold file names, which the screen says.
 */

/** Log lines kept at most */
export const MAX_LOG_LINES = 200;

/** String settings whose value is one of a few fixed choices (safe to show) */
const CHOICE_SETTINGS = new Set([
    "triggerConfigStrategy",
    "notificationLevel",
    "conflictResolutionStrategy",
    "authMethod",
]);

/** Free text settings: only whether they are set */
const TEXT_SETTINGS = new Set(["cloudRootFolder", "customProxyUrl"]);

/** Never shown, not even as set / not set */
const HIDDEN = /secret|token|password|credential|e2ee|encrypt|agreement/i;

export interface DiagnosticsSnapshot {
    pluginVersion: string;
    obsidianVersion: string;
    platform: string;
    language: string;
    cloud: string;
    signedIn: boolean;
    /** Add-ons installed: "name version" */
    addOns: string[];
    addOnActive: boolean;
    syncState: string;
    syncedFiles: number;
    pendingChanges: number;
    backgroundTransfers: number;
    firstSyncDone: boolean;
    /** describeCtxState() of the sync */
    internalState: Record<string, string>;
    settings: Record<string, unknown>;
}

/** Settings as "key: value" lines, without anything private */
export function settingsLines(settings: Record<string, unknown>, prefix = ""): string[] {
    const lines: string[] = [];
    for (const key of Object.keys(settings).sort()) {
        if (HIDDEN.test(key)) continue;
        const value = settings[key];
        const name = prefix + key;
        if (typeof value === "number" || typeof value === "boolean") {
            lines.push(`${name}: ${value}`);
        } else if (typeof value === "string") {
            if (CHOICE_SETTINGS.has(key)) lines.push(`${name}: ${value}`);
            else if (TEXT_SETTINGS.has(key)) lines.push(`${name}: ${value.trim() ? "(set)" : "(empty)"}`);
            else if (key === "exclusionPatterns") {
                const n = value.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#")).length;
                lines.push(`${name}: ${n} pattern(s)`);
            }
        } else if (value && typeof value === "object" && !Array.isArray(value)) {
            lines.push(...settingsLines(value as Record<string, unknown>, `${name}.`));
        }
    }
    return lines;
}

/** The last lines of a log text */
export function logTail(text: string, max = MAX_LOG_LINES): string[] {
    const lines = text.split("\n").filter((l) => l.trim() !== "");
    return lines.slice(Math.max(0, lines.length - max));
}

/** The whole text */
export function formatDiagnostics(s: DiagnosticsSnapshot, log: string[] | null, now = new Date()): string {
    const out: string[] = [];
    out.push("## Vault Sync diagnostics", `Created: ${now.toISOString()}`, "");
    out.push("### Environment");
    out.push(`Plugin: ${s.pluginVersion}`);
    out.push(`Obsidian: ${s.obsidianVersion}`);
    out.push(`Platform: ${s.platform || "-"}`);
    out.push(`Language: ${s.language}`);
    out.push(`Cloud: ${s.cloud} (${s.signedIn ? "signed in" : "not signed in"})`);
    out.push(`Add-ons: ${s.addOns.length > 0 ? s.addOns.join(", ") : "none"}${s.addOnActive ? " (active)" : ""}`);
    out.push("");
    out.push("### Sync");
    out.push(`State: ${s.syncState}`);
    out.push(`First sync done: ${s.firstSyncDone}`);
    out.push(`Synced files: ${s.syncedFiles}`);
    out.push(`Local changes waiting: ${s.pendingChanges}`);
    out.push(`Background transfers: ${s.backgroundTransfers}`);
    const internal = Object.entries(s.internalState);
    out.push(`Internal state: ${internal.length > 0 ? internal.map(([k, v]) => `${k}=${v}`).join(", ") : "none"}`);
    out.push("");
    out.push("### Settings");
    out.push(...settingsLines(s.settings));
    if (log) {
        out.push("", `### Log (last ${log.length} line(s))`, "```", ...log, "```");
    }
    return out.join("\n") + "\n";
}
