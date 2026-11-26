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
    "obsidianScopeStrategy",
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
    /** Reason of the last failed sync, if the last one failed */
    lastError?: string;
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
            else if (key === "exclusionPatterns" || key === "desktopExclusionPatterns" || key === "mobileExclusionPatterns") {
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
    out.push("## Vault Syncer diagnostics", `Created: ${now.toISOString()}`, "");
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
    if (s.lastError) out.push(`Last error: ${s.lastError}`);
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

/** New-issue page of the plugin's repository */
export const ISSUE_URL = "https://github.com/c-ardinal/obsidian-vault-sync/issues/new";
/** Longest link GitHub opens reliably (about 8 KB; kept below it) */
export const MAX_ISSUE_URL = 7500;

/** The issue text: a part for the user to write, then the diagnostic info */
export function issueBody(diagnostics: string, note = ""): string {
    return [
        "### What happened",
        "<!-- What did you do, what did you expect, and what happened instead? -->",
        "",
        "",
        "### Diagnostics",
        "<details><summary>Diagnostic info</summary>",
        "",
        diagnostics.trimEnd(),
        "",
        "</details>",
        ...(note ? ["", note] : []),
        "",
    ].join("\n");
}

function issueLink(title: string, body: string): string {
    return `${ISSUE_URL}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}

/** The text with only the last `keep` lines of its log block */
export function keepLastLogLines(text: string, keep: number): string {
    const lines = text.split("\n");
    const head = lines.findIndex((l) => l.startsWith("### Log"));
    if (head < 0 || lines[head + 1] !== "```") return text;
    const end = lines.indexOf("```", head + 2);
    if (end < 0) return text;
    const log = lines.slice(head + 2, end);
    const kept = keep > 0 ? log.slice(-keep) : [];
    return [
        ...lines.slice(0, head),
        `### Log (last ${kept.length} line(s))`,
        "```",
        ...kept,
        ...lines.slice(end),
    ].join("\n");
}

/**
 * A link to the new-issue page with title and text filled in. When the
 * whole text does not fit in a link, the oldest log lines are left out and
 * `shortened` is true (the caller copies the whole text for pasting).
 */
export function issueUrl(
    title: string,
    diagnostics: string,
    shortenedNote: string,
    max = MAX_ISSUE_URL,
): { url: string; shortened: boolean } {
    const full = issueLink(title, issueBody(diagnostics));
    if (full.length <= max) return { url: full, shortened: false };
    const logLines = (() => {
        const m = /### Log \(last (\d+) line/.exec(diagnostics);
        return m ? Number(m[1]) : 0;
    })();
    // Most log lines that still fit (binary search)
    let lo = 0;
    let hi = logLines;
    const fits = (n: number) => issueLink(title, issueBody(keepLastLogLines(diagnostics, n), shortenedNote)).length <= max;
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (fits(mid)) lo = mid;
        else hi = mid - 1;
    }
    let body = issueBody(keepLastLogLines(diagnostics, lo), shortenedNote);
    // Still too long without any log: cut the text itself
    while (issueLink(title, body).length > max && body.length > 0) {
        body = body.slice(0, Math.floor(body.length * 0.9));
    }
    return { url: issueLink(title, body), shortened: true };
}
