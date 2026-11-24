/**
 * Dates and times on the plugin's screens. Obsidian sets moment's locale to the
 * app language, so every screen shows one format per language (not the OS one).
 */
import { moment as obsidianMoment } from "obsidian";

/**
 * Obsidian's bundled moment. obsidian.d.ts types it as the module namespace, which
 * TypeScript 6 (esModuleInterop on by default) no longer treats as callable.
 */
const moment = obsidianMoment as unknown as (input: number) => { format(format: string): string };

/** `ms` in a moment format (e.g. "LL", "LTS"), in the app language. */
export function formatMoment(ms: number, format: string): string {
    return moment(ms).format(format);
}

/** Day, e.g. "November 22, 2026" / "2026年11月22日" */
export function formatDay(ms: number): string {
    return moment(ms).format("LL");
}

/** Time of day with seconds, e.g. "4:42:23 PM" / "16:42:23" */
export function formatTimeOfDay(ms: number): string {
    return moment(ms).format("LTS");
}

/** Date and time, e.g. "11/22/2026 4:42 PM" / "2026/11/22 16:42" */
export function formatDateTime(ms: number): string {
    if (ms <= 0) return "-";
    return moment(ms).format("L LT");
}
