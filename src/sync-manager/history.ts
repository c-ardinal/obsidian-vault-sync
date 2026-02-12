import { TFile } from "obsidian";
import type { FileRevision } from "../types/adapter";
import type { SyncContext } from "./context";

export function supportsHistory(ctx: SyncContext): boolean {
    return ctx.adapter.supportsHistory ?? false;
}

export async function listRevisions(ctx: SyncContext, path: string): Promise<FileRevision[]> {
    if (!ctx.adapter.supportsHistory || !ctx.adapter.listRevisions) {
        throw new Error(
            ctx.t("historyNotSupported") || "Cloud adapter does not support history.",
        );
    }
    return await ctx.adapter.listRevisions(path);
}

export async function getRevisionContent(ctx: SyncContext, path: string, revisionId: string): Promise<ArrayBuffer> {
    if (!ctx.adapter.supportsHistory || !ctx.adapter.getRevisionContent) {
        throw new Error(
            ctx.t("historyNotSupported") || "Cloud adapter does not support history.",
        );
    }

    const cached = await ctx.revisionCache.get(path, revisionId);
    if (cached) {
        return cached;
    }

    const content = await ctx.adapter.getRevisionContent(path, revisionId);
    await ctx.revisionCache.set(path, revisionId, content);
    return content;
}

export async function setRevisionKeepForever(
    ctx: SyncContext,
    path: string,
    revisionId: string,
    keepForever: boolean,
): Promise<void> {
    if (!ctx.adapter.supportsHistory || !ctx.adapter.setRevisionKeepForever) {
        throw new Error(
            ctx.t("historyNotSupported") || "Cloud adapter does not support history.",
        );
    }
    await ctx.adapter.setRevisionKeepForever(path, revisionId, keepForever);
    await ctx.log(`[History] Set keepForever=${keepForever} for ${path} (rev: ${revisionId})`);
}

export async function deleteRevision(ctx: SyncContext, path: string, revisionId: string): Promise<void> {
    if (!ctx.adapter.supportsHistory || !ctx.adapter.deleteRevision) {
        throw new Error(
            ctx.t("historyNotSupported") || "Cloud adapter does not support history.",
        );
    }
    await ctx.adapter.deleteRevision(path, revisionId);
    await ctx.log(`[History] Deleted revision ${revisionId} for ${path}`);
}

export async function restoreRevision(
    ctx: SyncContext,
    path: string,
    revision: FileRevision,
): Promise<void> {
    await ctx.log(`[History] Starting rollback for ${path} to revision ${revision.id}`);
    try {
        const content = await getRevisionContent(ctx, path, revision.id);

        const file = ctx.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) {
            await ctx.app.vault.modifyBinary(file, content);
        } else {
            await ctx.app.vault.createBinary(path, content);
        }

        const timestamp = new Date().toISOString();
        await ctx.log(
            `[History] Rollback executed: File=${path}, Revision=${revision.id}, Time=${timestamp}`,
        );

        await ctx.notify("noticeFileRestored");
    } catch (e) {
        await ctx.log(`[History] Rollback failed: ${e}`);
        throw e;
    }
}
