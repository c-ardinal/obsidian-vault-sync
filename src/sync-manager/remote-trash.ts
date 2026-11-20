import type { CloudAdapter, CloudFile } from "../types/adapter";
import type {
    RemoteDeletionReason,
    RemoteDeletionStrategy,
    RemoteDeletionTarget,
} from "./remote-deletion";
import { immediateRemoteDeletion } from "./remote-deletion";
import { cloudErrorKind } from "../cloud-adapters/cloud-error";

/**
 * A plugin-managed trash on the cloud.
 *
 * Before a file the user deleted is removed, a copy of it is made in a folder
 * next to the vault folder (the same place a migration keeps its temporary
 * vault). Inside it, a folder per UTC day holds the copies under their
 * original vault path:
 *
 *   <app root>/.vault-sync-trash_<vault>/2026-11-20/Notes/a.md
 *
 * Why a copy plus the usual removal, not a move: the removal itself stays what
 * every build already understands. A moved file keeps its id, and a device that
 * has not seen the deletion yet writes to it by that id: the write would land
 * in the trash without an error and the edit would vanish from the vault. A
 * removed id fails such a write, and the sync uploads the file anew, as it
 * always did. The copy is made on the cloud side (nothing is downloaded); its
 * revision history is not copied.
 *
 * A folder deletion copies the synced files inside it, then removes the folder.
 * When the cloud cannot copy (no copy support, storage full), the removal goes
 * ahead without a copy rather than leaving the deletion stuck.
 */

const TRASH_ROOT_PREFIX = ".vault-sync-trash_";

/** Reasons whose removals keep a copy in the trash. Cleanups and plugin files do not. */
const TRASHED_REASONS: ReadonlySet<RemoteDeletionReason> = new Set(["user-file", "user-folder"]);

/** Name of the trash folder of a vault (next to the vault folder on the cloud) */
export function trashRootName(vaultName: string): string {
    return `${TRASH_ROOT_PREFIX}${vaultName}`;
}

function baseOf(adapter: CloudAdapter): CloudAdapter {
    return adapter.getBaseAdapter?.() ?? adapter;
}

const trashAdapters = new WeakMap<CloudAdapter, CloudAdapter>();

/**
 * An adapter rooted at the trash folder of `adapter`'s vault (same sign-in).
 * Null when the cloud cannot copy, or the adapter cannot address another
 * folder (its clone is itself).
 */
export function trashAdapterOf(adapter: CloudAdapter): CloudAdapter | null {
    const base = baseOf(adapter);
    if (!base.copyFile) return null;
    let trash = trashAdapters.get(base);
    if (!trash || trash.vaultName !== trashRootName(base.vaultName)) {
        trash = base.cloneWithNewVaultName(trashRootName(base.vaultName));
        trashAdapters.set(base, trash);
    }
    return trash === base || !trash.copyFile ? null : trash;
}

/** UTC day folder name of a time (YYYY-MM-DD) */
export function trashDayOf(time: number): string {
    return new Date(time).toISOString().slice(0, 10);
}

function splitPath(path: string): { dir: string; name: string } {
    const i = path.lastIndexOf("/");
    return i < 0 ? { dir: "", name: path } : { dir: path.slice(0, i), name: path.slice(i + 1) };
}

function joinPath(...parts: string[]): string {
    return parts.filter((p) => p !== "").join("/");
}

/** A copy that cannot be made by trying again: remove without one */
function copyImpossible(e: unknown): boolean {
    const kind = cloudErrorKind(e);
    return kind === "quota-exceeded" || kind === "permanent" || kind === "not-found";
}

/** Keeps a copy of user deletions in the trash; everything else is removed as before. */
export class TrashRemoteDeletion implements RemoteDeletionStrategy {
    constructor(
        /** Days a trashed file is kept; 0 or less = no trash */
        private readonly retentionDays: () => number,
        private readonly now: () => number = () => Date.now(),
    ) {}

    async remove(adapter: CloudAdapter, target: RemoteDeletionTarget, reason: RemoteDeletionReason): Promise<void> {
        const trash = this.retentionDays() > 0 && TRASHED_REASONS.has(reason) ? trashAdapterOf(adapter) : null;
        if (trash) {
            const base = baseOf(adapter);
            const day = trashDayOf(this.now());
            try {
                if (target.kind === "folder") {
                    for (const child of await base.listFiles(target.id)) {
                        if (child.kind !== "file") continue;
                        await copyInto(trash, child.id, joinPath(day, target.path, child.path));
                    }
                } else {
                    await copyInto(trash, target.id, joinPath(day, target.path));
                }
            } catch (e) {
                if (!copyImpossible(e)) throw e;
            }
        }
        await immediateRemoteDeletion.remove(adapter, target, reason);
    }
}

async function copyInto(trash: CloudAdapter, fileId: string, trashPath: string): Promise<void> {
    const { dir, name } = splitPath(trashPath);
    await trash.copyFile!(fileId, name, dir);
}

/** One file in the trash */
export interface TrashedFile {
    /** Cloud file id of the copy in the trash */
    id: string;
    /** Vault path it had */
    originalPath: string;
    /** UTC day it was deleted (YYYY-MM-DD) */
    day: string;
    size: number;
    mtime: number;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Files in the trash of `adapter`'s vault, newest day first */
export async function listTrash(adapter: CloudAdapter): Promise<TrashedFile[]> {
    const trash = trashAdapterOf(adapter);
    if (!trash) return [];
    let items: CloudFile[];
    try {
        items = await trash.listFiles();
    } catch {
        return [];
    }
    const files: TrashedFile[] = [];
    for (const f of items) {
        if (f.kind !== "file") continue;
        const slash = f.path.indexOf("/");
        if (slash < 0) continue;
        const day = f.path.slice(0, slash);
        if (!DAY_RE.test(day)) continue;
        files.push({ id: f.id, originalPath: f.path.slice(slash + 1), day, size: f.size, mtime: f.mtime });
    }
    return files.sort((a, b) => b.day.localeCompare(a.day) || a.originalPath.localeCompare(b.originalPath));
}

/**
 * Move a trashed file back into the vault. When its path is taken, it comes
 * back as "name (restored YYYY-MM-DD).ext". Returns the vault path it got.
 */
export async function restoreFromTrash(adapter: CloudAdapter, file: TrashedFile): Promise<string> {
    const base = baseOf(adapter);
    let path = file.originalPath;
    if (await base.getFileMetadata(path).catch(() => null)) {
        const { dir, name } = splitPath(path);
        const dot = name.lastIndexOf(".");
        const stem = dot > 0 ? name.slice(0, dot) : name;
        const ext = dot > 0 ? name.slice(dot) : "";
        path = joinPath(dir, `${stem} (restored ${file.day})${ext}`);
    }
    const { dir, name } = splitPath(path);
    await base.ensureFoldersExist(dir ? [dir] : []);
    await base.moveFile(file.id, name, dir);
    return path;
}

/** Remove a trashed file for good */
export async function deleteFromTrash(adapter: CloudAdapter, file: TrashedFile): Promise<void> {
    await baseOf(adapter).deleteFile(file.id);
}

/**
 * Remove the day folders older than the retention period, for good.
 * Returns the number of day folders removed.
 */
export async function purgeTrash(adapter: CloudAdapter, retentionDays: number, now: number): Promise<number> {
    const trash = trashAdapterOf(adapter);
    if (retentionDays <= 0 || !trash) return 0;
    let items: CloudFile[];
    try {
        items = await trash.listFiles();
    } catch {
        return 0;
    }
    const oldest = trashDayOf(now - retentionDays * 24 * 60 * 60 * 1000);
    let removed = 0;
    for (const f of items) {
        if (f.kind !== "folder" || f.path.includes("/") || !DAY_RE.test(f.path)) continue;
        if (f.path >= oldest) continue;
        await trash.deleteFile(f.id);
        removed++;
    }
    return removed;
}

const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const lastPurge = new WeakMap<object, number>();

/**
 * Purge the trash at most once a day per running plugin (the first sync after
 * start, then daily). Failures are logged and retried at the next sync.
 */
export async function purgeTrashIfDue(ctx: {
    adapter: CloudAdapter;
    settings: { remoteTrashRetentionDays?: number };
    log: (message: string, level?: "debug" | "info" | "warn" | "error") => Promise<void>;
}): Promise<void> {
    const retention = ctx.settings.remoteTrashRetentionDays ?? -1;
    if (retention <= 0) return;
    const now = Date.now();
    const last = lastPurge.get(ctx);
    if (last !== undefined && now - last < PURGE_INTERVAL_MS) return;
    try {
        const removed = await purgeTrash(ctx.adapter, retention, now);
        lastPurge.set(ctx, now);
        if (removed > 0) {
            await ctx.log(`[Trash] Removed ${removed} day folder(s) older than ${retention} day(s).`, "info");
        }
    } catch (e) {
        await ctx.log(`[Trash] Purge failed: ${String(e)}`, "warn");
    }
}
