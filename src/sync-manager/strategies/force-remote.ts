import type { IMergeStrategy, MergeParams } from "./merge-strategy";

export class ForceRemoteStrategy implements IMergeStrategy {
    async merge({ ctx, remoteContent }: MergeParams): Promise<ArrayBuffer> {
        await ctx.log(`[Merge] Strategy is 'Force Remote'. Overwriting local changes.`, "info");
        return new TextEncoder().encode(remoteContent).buffer;
    }
}
