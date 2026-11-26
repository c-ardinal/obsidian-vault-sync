import type { FileRevision } from "../types/adapter";
import type { TrashedFile } from "./remote-trash";
import { trashDayOf } from "./remote-trash";

/**
 * Bring a folder (or the whole vault) back to how it was at a past time,
 * from the cloud's file history and the cloud trash.
 *
 * Planning only reads. For each synced file in the folder:
 * - the newest revision at or before the time is "restore" (or "unchanged"
 *   when it is the current one);
 * - a file whose history starts after the time is "created-after" only when
 *   the cloud says it was created after the time. The cloud drops old
 *   revisions, so the oldest one left does not tell when a file was made;
 * - a file without readable history, or whose history from that time is
 *   gone, is "no-history" (left alone).
 * A file in the cloud trash, deleted on or after the time's day, with no
 * file at its path now, is "recreate" (with its content when deleted).
 *
 * Applying writes the chosen contents into the vault as ordinary edits, so
 * the next sync uploads them as new versions: the present versions stay in
 * the history and the restore itself can be undone the same way. Files
 * created after the time are removed only when asked, through the caller.
 *
 * Limits: a cloud keeps revisions for a while only (Google Drive: about 30
 * days or 100 versions, except versions kept for good), and the trash knows
 * the day of a deletion, not the hour.
 */

export type RestoreAction = "restore" | "unchanged" | "created-after" | "no-history" | "recreate";

export interface RestoreEntry {
    path: string;
    action: RestoreAction;
    fileId?: string;
    /** "restore": the revision to bring back */
    revision?: FileRevision;
    /** "recreate": the copy in the trash */
    trashed?: TrashedFile;
}

export interface RestorePlan {
    time: number;
    folder: string;
    entries: RestoreEntry[];
}

/** What planning reads */
export interface RestoreSource {
    /** Synced files (path and cloud id) */
    files(): { path: string; fileId: string }[];
    listRevisions(path: string, fileId: string): Promise<FileRevision[]>;
    /** When the cloud file was created (absent or undefined: not known) */
    createdTime?(path: string, fileId: string): Promise<number | undefined>;
    listTrash(): Promise<TrashedFile[]>;
    /** A file is at this path in the vault now */
    exists(path: string): boolean;
    /** Paths never restored (settings, the plugin's own files) */
    excluded(path: string): boolean;
}

/** What applying uses */
export interface RestoreTarget {
    revisionContent(path: string, revisionId: string, fileId?: string): Promise<ArrayBuffer>;
    trashContent(file: TrashedFile): Promise<ArrayBuffer>;
    write(path: string, data: ArrayBuffer): Promise<void>;
    /** Remove a file created after the time (only when asked) */
    remove(path: string): Promise<void>;
}

export interface PlanOptions {
    concurrency?: number;
    onProgress?: (done: number, total: number) => void;
    signal?: { aborted: boolean };
}

/** A folder path as typed ("", "/", "Notes/", " Notes ") -> "" or "Notes" */
export function normalizeFolder(folder: string): string {
    return folder.trim().replace(/^\/+|\/+$/g, "");
}

export function inFolder(path: string, folder: string): boolean {
    return folder === "" || path === folder || path.startsWith(folder + "/");
}

/** The revision a file had at `time`, from its history */
export function revisionAt(
    revisions: FileRevision[],
    time: number,
): { action: "restore" | "unchanged" | "created-after"; revision?: FileRevision } {
    if (revisions.length === 0) return { action: "created-after" };
    const sorted = [...revisions].sort((a, b) => a.modifiedTime - b.modifiedTime);
    let at: FileRevision | undefined;
    for (const r of sorted) {
        if (r.modifiedTime <= time) at = r;
        else break;
    }
    if (!at) return { action: "created-after" };
    return at.id === sorted[sorted.length - 1].id ? { action: "unchanged", revision: at } : { action: "restore", revision: at };
}

export async function planRestore(
    source: RestoreSource,
    folderInput: string,
    time: number,
    options: PlanOptions = {},
): Promise<RestorePlan> {
    const folder = normalizeFolder(folderInput);
    const files = source.files().filter((f) => inFolder(f.path, folder) && !source.excluded(f.path));
    const entries: RestoreEntry[] = [];
    let done = 0;
    options.onProgress?.(0, files.length);

    let next = 0;
    const worker = async () => {
        while (next < files.length && !options.signal?.aborted) {
            const f = files[next++];
            let entry: RestoreEntry;
            try {
                const at = revisionAt(await source.listRevisions(f.path, f.fileId), time);
                if (at.action === "created-after") {
                    // Old revisions expire: only the creation time proves the file is newer
                    const created = await source.createdTime?.(f.path, f.fileId);
                    entry =
                        created !== undefined && created > time
                            ? { path: f.path, fileId: f.fileId, action: "created-after" }
                            : { path: f.path, fileId: f.fileId, action: "no-history" };
                } else {
                    entry = { path: f.path, fileId: f.fileId, ...at };
                }
            } catch {
                entry = { path: f.path, fileId: f.fileId, action: "no-history" };
            }
            entries.push(entry);
            options.onProgress?.(++done, files.length);
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, options.concurrency ?? 4) }, worker));
    if (options.signal?.aborted) throw new Error("Cancelled");

    // Deleted since then: the trash copy nearest after the time, when the path is free now
    const fromDay = trashDayOf(time);
    const seen = new Set(entries.map((e) => e.path));
    const trashed = (await source.listTrash())
        .filter((t) => t.day >= fromDay && inFolder(t.originalPath, folder) && !source.excluded(t.originalPath))
        .sort((a, b) => a.day.localeCompare(b.day));
    for (const t of trashed) {
        if (seen.has(t.originalPath) || source.exists(t.originalPath)) continue;
        seen.add(t.originalPath);
        entries.push({ path: t.originalPath, action: "recreate", trashed: t });
    }

    entries.sort((a, b) => a.path.localeCompare(b.path));
    return { time, folder, entries };
}

export interface RestoreResult {
    restored: number;
    recreated: number;
    removed: number;
    failed: string[];
}

export async function applyRestore(
    target: RestoreTarget,
    plan: RestorePlan,
    options: { removeCreatedAfter: boolean; onProgress?: (done: number, total: number) => void },
): Promise<RestoreResult> {
    const result: RestoreResult = { restored: 0, recreated: 0, removed: 0, failed: [] };
    const work = plan.entries.filter(
        (e) =>
            e.action === "restore" ||
            e.action === "recreate" ||
            (e.action === "created-after" && options.removeCreatedAfter),
    );
    let done = 0;
    for (const e of work) {
        try {
            if (e.action === "restore" && e.revision) {
                await target.write(e.path, await target.revisionContent(e.path, e.revision.id, e.fileId));
                result.restored++;
            } else if (e.action === "recreate" && e.trashed) {
                await target.write(e.path, await target.trashContent(e.trashed));
                result.recreated++;
            } else if (e.action === "created-after") {
                await target.remove(e.path);
                result.removed++;
            }
        } catch {
            result.failed.push(e.path);
        }
        options.onProgress?.(++done, work.length);
    }
    return result;
}

/** Entries per action */
export function countByAction(plan: RestorePlan): Record<RestoreAction, number> {
    const counts: Record<RestoreAction, number> = {
        restore: 0,
        unchanged: 0,
        "created-after": 0,
        "no-history": 0,
        recreate: 0,
    };
    for (const e of plan.entries) counts[e.action]++;
    return counts;
}
