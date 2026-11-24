import type { SyncContext } from "./context";
import {
    listFilesRecursive,
    isManagedSeparately,
    shouldNotBeOnRemote,
    shouldIgnore,
    isDeviceExcluded,
} from "./file-utils";
import { computeLocalHash } from "./sync-helpers";
import { hasDeleteIntent, markRenamed, MISSING_EVENT_GRACE_MS, takeEventsDuringSync } from "./state";
import { CtxState } from "./context-state";
import { entryIdentityHash, localIdentityHash } from "./content-identity";
import type { FileUtilsCtx } from "./file-utils";
import type { StateCtx } from "./state";
import type { SyncHelpersCtx } from "./sync-helpers";
import { configDir, inConfigDir } from "../utils/config-dir";

/** What this module reads from the sync context */
export type ScanCtx = Pick<
    SyncContext,
    | "dirtyPaths"
    | "e2eeEnabled"
    | "index"
    | "localIndex"
    | "log"
    | "pluginDataPath"
    | "recentlyDeletedFromRemote"
    | "syncingPaths"
    | "vault"
> & Partial<Pick<SyncContext, "adapter">> & FileUtilsCtx & StateCtx & SyncHelpersCtx;

/**
 * Edits the vault reported while the engine held the path (markDirty set them
 * aside). Most are the echo of our own write; a file whose content differs from
 * what the index says we synced was edited by the user and is pushed.
 */
export async function recheckEventsDuringSync(ctx: ScanCtx): Promise<void> {
    for (const path of takeEventsDuringSync(ctx)) {
        if (ctx.dirtyPaths.has(path) || shouldIgnore(ctx, path)) continue;
        try {
            if (!(await ctx.vault.exists(path))) continue; // deletions come as their own event
            const entry = ctx.localIndex[path];
            let edited = !entry;
            if (entry) {
                const content = await ctx.vault.readBinary(path);
                const { localHash, compareHash } = await computeLocalHash(ctx, content, entry);
                edited = !compareHash || localHash !== compareHash.toLowerCase();
            }
            if (edited) {
                ctx.dirtyPaths.set(path, Date.now());
                await ctx.log(`[Dirty] Edited while being synced: ${path}`, "info");
            }
        } catch {
            ctx.dirtyPaths.set(path, Date.now());
        }
    }
}

/**
 * Scan the config folder (Vault#configDir) for changes
 * Vault events don't fire for files there, so we need to scan manually
 */
export async function scanObsidianChanges(ctx: ScanCtx): Promise<void> {
    try {
        const obsidianFiles = await listFilesRecursive(ctx, configDir());

        for (const filePath of obsidianFiles) {
            if (shouldIgnore(ctx, filePath)) continue;
            if (ctx.syncingPaths.has(filePath)) continue;

            const stat = await ctx.vault.stat(filePath);
            if (!stat) continue;

            const indexEntry = ctx.localIndex[filePath];

            if (!indexEntry) {
                // Skip if this file was recently deleted from remote
                // (prevents re-upload when local deletion failed)
                if (ctx.recentlyDeletedFromRemote.has(filePath)) {
                    await ctx.log(
                        `[Obsidian Scan] Skipped (recently deleted from remote): ${filePath}`,
                        "debug",
                    );
                    continue;
                }
                ctx.dirtyPaths.set(filePath, Date.now());
                await ctx.log(`[Obsidian Scan] New: ${filePath}`, "debug");
                continue;
            }

            if (stat.mtime > indexEntry.mtime) {
                try {
                    const content = await ctx.vault.readBinary(filePath);
                    const { localHash, compareHash } = await computeLocalHash(ctx, content, indexEntry);
                    if (compareHash && localHash !== compareHash.toLowerCase()) {
                        ctx.dirtyPaths.set(filePath, Date.now());
                        await ctx.log(
                            `[Obsidian Scan] Modified (hash mismatch vs localIndex): ${filePath}`,
                            "debug",
                        );
                    } else if (!indexEntry.hash) {
                        ctx.dirtyPaths.set(filePath, Date.now());
                        await ctx.log(
                            `[Obsidian Scan] Modified (no prev hash in localIndex): ${filePath}`,
                            "debug",
                        );
                    } else {
                        ctx.localIndex[filePath].mtime = stat.mtime;
                        if (ctx.index[filePath]) {
                            ctx.index[filePath].mtime = stat.mtime;
                        }
                    }
                } catch {
                    ctx.dirtyPaths.set(filePath, Date.now());
                }
            }
        }

        const currentObsidianFiles = new Set(obsidianFiles);
        for (const path of Object.keys(ctx.localIndex)) {
            if (!inConfigDir(path)) continue;
            if (path === ctx.pluginDataPath) continue;
            if (isManagedSeparately(path)) continue;
            if (isDeviceExcluded(ctx, path)) continue;

            const isIgnored = shouldNotBeOnRemote(ctx, path);
            const isMissing = !currentObsidianFiles.has(path);

            if (isMissing || isIgnored) {
                if (ctx.index[path]) {
                    ctx.dirtyPaths.set(path, Date.now());
                    await ctx.log(
                        `[Obsidian Scan] Marked for remote deletion (${isMissing ? "missing" : "ignored"}): ${path}`,
                        "debug",
                    );
                } else {
                    delete ctx.localIndex[path];
                    ctx.dirtyPaths.delete(path);
                }
            }
        }
    } catch (e) {
        await ctx.log(`[Obsidian Scan] Error: ${String(e)}`, "error");
    }
}

/**
 * Scan all vault files for changes (missing events while app was closed)
 * This is O(N) but fast because it uses Obsidian's cached file metadata
 */
export async function scanVaultChanges(ctx: ScanCtx): Promise<void> {
    try {
        await ctx.log("[Vault Scan] Starting full vault scan...", "debug");
        const start = Date.now();

        const files = ctx.vault.getFiles();
        const currentPaths = new Set<string>();
        const newPaths: string[] = [];
        const missingPaths: string[] = [];
        // New files no vault event told us about (only this scan found them)
        const unreported = new Set<string>();

        for (const file of files) {
            if (shouldIgnore(ctx, file.path)) continue;

            currentPaths.add(file.path);

            if (inConfigDir(file.path)) continue;

            const indexEntry = ctx.localIndex[file.path];

            if (!indexEntry) {
                // Skip if this file was recently deleted from remote
                // (prevents re-upload when local deletion failed)
                if (ctx.recentlyDeletedFromRemote.has(file.path)) {
                    await ctx.log(
                        `[Vault Scan] Skipped (recently deleted from remote): ${file.path}`,
                        "debug",
                    );
                    continue;
                }
                if (!ctx.dirtyPaths.has(file.path)) unreported.add(file.path);
                ctx.dirtyPaths.set(file.path, Date.now());
                newPaths.push(file.path);
                await ctx.log(`[Vault Scan] New: ${file.path}`, "debug");
            } else if (file.stat.mtime > indexEntry.mtime) {
                try {
                    const content = await ctx.vault.readBinary(file.path);
                    const { localHash, compareHash } = await computeLocalHash(ctx, content, indexEntry);
                    if (compareHash && localHash !== compareHash.toLowerCase()) {
                        ctx.dirtyPaths.set(file.path, Date.now());
                        await ctx.log(
                            `[Vault Scan] Modified (hash mismatch vs localIndex): ${file.path}`,
                            "debug",
                        );
                    } else if (!compareHash) {
                        ctx.dirtyPaths.set(file.path, Date.now());
                        await ctx.log(
                            `[Vault Scan] Modified (no prev hash in localIndex): ${file.path}`,
                            "debug",
                        );
                    } else {
                        ctx.localIndex[file.path].mtime = file.stat.mtime;
                        if (ctx.index[file.path]) {
                            ctx.index[file.path].mtime = file.stat.mtime;
                        }
                    }
                } catch (e) {
                    await ctx.log(`[Vault Scan] Hash check failed for ${file.path}: ${String(e)}`, "warn");
                }
            }
        }

        for (const path of Object.keys(ctx.localIndex)) {
            if (inConfigDir(path)) continue;
            if (path === ctx.pluginDataPath) continue;
            if (isManagedSeparately(path)) continue;
            if (isDeviceExcluded(ctx, path)) continue;

            const isIgnored = shouldNotBeOnRemote(ctx, path);
            const isMissing = !currentPaths.has(path);

            if (isMissing || isIgnored) {
                if (ctx.index[path]) {
                    if (isMissing && !isIgnored) missingPaths.push(path);
                    ctx.dirtyPaths.set(path, Date.now());
                    await ctx.log(
                        `[Vault Scan] Marked for remote deletion (${isMissing ? "missing" : "ignored"}): ${path}`,
                        "debug",
                    );
                } else {
                    delete ctx.localIndex[path];
                    ctx.dirtyPaths.delete(path);
                }
            }
        }

        // A rename or move recorded in the index but not pushed yet (pendingMove /
        // forcePush). Its dirty mark only lived in memory, so after the app was killed
        // nothing pushed it: the other devices kept the old name forever.
        for (const [path, entry] of Object.entries(ctx.index)) {
            if (!(entry.pendingMove || entry.forcePush)) continue;
            if (path === ctx.pluginDataPath || ctx.dirtyPaths.has(path)) continue;
            if (!currentPaths.has(path)) continue;
            ctx.dirtyPaths.set(path, Date.now());
            await ctx.log(`[Vault Scan] Unpushed ${entry.pendingMove ? "move" : "change"}: ${path}`, "debug");
        }
        // A merge result written locally but not pushed yet: the local file already
        // matches the local index, so the scan saw nothing to do and the other device's
        // half of the merge never reached the cloud.
        for (const [path, entry] of Object.entries(ctx.localIndex)) {
            if (entry.lastAction !== "merge") continue;
            if (path === ctx.pluginDataPath || ctx.dirtyPaths.has(path)) continue;
            if (!currentPaths.has(path)) continue;
            ctx.dirtyPaths.set(path, Date.now());
            await ctx.log(`[Vault Scan] Unpushed merge: ${path}`, "debug");
        }

        await pairRenames(ctx, missingPaths, newPaths);
        await holdUnexplainedNewFiles(ctx, missingPaths, newPaths, unreported);

        await ctx.log(`[Vault Scan] Completed in ${Date.now() - start}ms`, "debug");
    } catch (e) {
        await ctx.log(`[Vault Scan] Error: ${String(e)}`, "error");
    }
}

const unexplainedNew = new CtxState<Map<string, number>>(
    "unexplainedNewFiles",
    "New files found by a scan while a synced file is missing without an event (first seen at)",
);

const missingSince = new CtxState<Map<string, number>>(
    "missingWithoutEvent",
    "Synced notes a scan found missing with no delete event (first seen at)",
);

/** Whether a scan held back new files that a later scan must look at again */
export function holdsNewFiles(ctx: object): boolean {
    return (unexplainedNew.get(ctx)?.size ?? 0) > 0;
}

/**
 * A synced file is missing and a file no event reported appeared, with different
 * content (edited, then renamed): most likely one rename whose vault event is still
 * on its way. Uploading the new name as a new file before the event arrived left the
 * note twice in the cloud. Wait for the event (the missing file waits too, see
 * confirmMissingForDeletion); without one the new file is uploaded after a while.
 */
async function holdUnexplainedNewFiles(
    ctx: ScanCtx,
    missing: string[],
    added: string[],
    unreported: Set<string>,
): Promise<void> {
    let held = unexplainedNew.get(ctx);
    const stillMissing: string[] = [];
    for (const p of missing) {
        if (!ctx.localIndex[p] || hasDeleteIntent(ctx, p)) continue;
        // Not listed under this spelling but present under another one (macOS/Windows
        // fold letter case and Unicode form): not a rename whose event is on its way.
        // Counted as one, every new note waited behind it on each scan.
        if ((ctx.caseInsensitiveFs || ctx.unicodeInsensitiveFs) && (await ctx.vault.exists(p))) continue;
        stillMissing.push(p);
    }
    if (stillMissing.length === 0) {
        held?.clear();
        missingSince.get(ctx)?.clear();
        return;
    }
    if (!held) unexplainedNew.set(ctx, (held = new Map<string, number>()));
    // Gone, or no longer new (its event arrived): nothing to wait for
    for (const p of [...held.keys()]) if (!added.includes(p)) held.delete(p);
    const now = Date.now();
    const expired: string[] = [];
    for (const path of added) {
        // A note edited after a rename whose event was lost has an event (the edit):
        // it waits as well, or it was uploaded as a new note before the pairing below.
        if (ctx.localIndex[path] || (!unreported.has(path) && !isNote(path))) continue;
        const since = held.get(path) ?? now;
        if (now - since >= MISSING_EVENT_GRACE_MS) {
            held.delete(path);
            expired.push(path);
            continue;
        }
        held.set(path, since);
        ctx.dirtyPaths.delete(path);
        await ctx.log(`[Vault Scan] ${path} may be a renamed file (its event not here yet). Waiting before uploading it.`, "debug");
    }
    // A note edited after a rename whose event was lost has events of its own (edits),
    // so it is not held above; once the missing note has waited out the grace period,
    // it is a candidate too.
    let since = missingSince.get(ctx);
    if (!since) missingSince.set(ctx, (since = new Map<string, number>()));
    for (const p of [...since.keys()]) if (!stillMissing.includes(p)) since.delete(p);
    for (const p of stillMissing) if (!since.has(p)) since.set(p, now);
    const waited = stillMissing.filter((p) => now - since.get(p)! >= MISSING_EVENT_GRACE_MS);
    const edited = added.filter((p) => !unreported.has(p) && !ctx.localIndex[p]);
    if (waited.length === stillMissing.length) {
        await pairLoneRename(ctx, stillMissing, [...new Set([...expired, ...edited])]);
    }
}

/**
 * No event came for either file (the app was killed right after a rename, and the
 * note was edited before that): one synced note is gone and an unexplained note
 * appeared that holds most of its lines. Taken as a delete plus a new note, edits
 * other devices made under the old name brought it back, and the note existed
 * twice. As a rename, those edits are merged into it instead. Only with exactly one
 * missing note and one clear match, checked against the synced version in the
 * cloud (one download, only in this rare case; unreachable: left as it was).
 */
async function pairLoneRename(ctx: ScanCtx, missing: string[], expired: string[]): Promise<void> {
    if (missing.length !== 1 || expired.length === 0) return;
    const [oldPath] = missing;
    const entry = ctx.index[oldPath];
    if (!entry?.fileId || !isNote(oldPath) || !ctx.adapter?.downloadFile) return;
    const candidates = expired.filter((p) => !ctx.localIndex[p] && isNote(p));
    if (candidates.length === 0) return;
    let oldLines: string[];
    try {
        oldLines = noteLines(await ctx.adapter.downloadFile(entry.fileId));
    } catch {
        return;
    }
    if (oldLines.length === 0) return;
    // The first line (usually the title heading) tells notes made from one template
    // apart, where the body lines match equally well
    const title = oldLines[0] === "---" ? null : oldLines[0];
    let best: string | null = null;
    let bestScore = 0;
    let tie = false;
    for (const newPath of candidates) {
        let lines: string[];
        try {
            lines = noteLines(await ctx.vault.readBinary(newPath));
        } catch {
            continue;
        }
        // Another heading: another note made from the same template (daily notes share
        // most lines). Pairing them merged two notes into one; missing a real rename
        // only leaves a second copy.
        if (title?.startsWith("#") && lines[0]?.startsWith("#") && lines[0] !== title) continue;
        const newLines = new Set(lines);
        const overlap = oldLines.filter((l) => newLines.has(l)).length / oldLines.length;
        if (overlap < 0.5) continue;
        const score = overlap + (title !== null && lines[0] === title ? 1 : 0);
        if (score > bestScore) {
            best = newPath;
            bestScore = score;
            tie = false;
        } else if (score === bestScore) tie = true;
    }
    if (!best || tie) return;
    markRenamed(ctx, oldPath, best);
    await ctx.log(`[Vault Scan] ${oldPath} -> ${best} is taken as a rename (no event for either file, same lines).`, "debug");
}

function noteLines(content: ArrayBuffer): string[] {
    return new TextDecoder()
        .decode(content)
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
}

function isNote(path: string): boolean {
    return path.toLowerCase().endsWith(".md");
}

/**
 * A synced file gone from its path plus a new file with exactly its content: a
 * rename whose vault event has not arrived (yet). Uploading the new path as a new
 * file and deleting the old one left two cloud files for one note when the event
 * came after all, and edits other devices made under the old name stayed there.
 * Treat it as the rename it is.
 */
async function pairRenames(ctx: ScanCtx, missing: string[], added: string[]): Promise<void> {
    if (missing.length === 0 || added.length === 0) return;
    const byHash = new Map<string, string>();
    for (const path of added) {
        try {
            const content = await ctx.vault.readBinary(path);
            const localHash = await localIdentityHash(ctx, content);
            if (!byHash.has(localHash)) byHash.set(localHash, path);
        } catch {
            // unreadable: leave it as a new file
        }
    }
    for (const oldPath of missing) {
        const entry = ctx.localIndex[oldPath];
        const known = entryIdentityHash(ctx, entry)?.toLowerCase();
        const newPath = known ? byHash.get(known) : undefined;
        if (!newPath || ctx.localIndex[newPath]) continue;
        byHash.delete(known!);
        markRenamed(ctx, oldPath, newPath);
        await ctx.log(`[Vault Scan] ${oldPath} -> ${newPath} is a rename (same content).`, "debug");
    }
}
