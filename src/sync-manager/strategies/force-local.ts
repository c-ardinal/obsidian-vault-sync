import type { IMergeStrategy, MergeParams } from "./merge-strategy";

export class ForceLocalStrategy implements IMergeStrategy {
    async merge({ ctx, localContent }: MergeParams): Promise<ArrayBuffer> {
        await ctx.log(`[Merge] Strategy is 'Force Local'. Overwriting remote changes.`, "info");
        return new TextEncoder().encode(localContent).buffer;
    }
}
