/**
 * Dates and times on the plugin's screens. Obsidian sets moment's locale to the
 * app language, so every screen shows one format per language (not the OS one).
 */
import { moment } from "obsidian";

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
