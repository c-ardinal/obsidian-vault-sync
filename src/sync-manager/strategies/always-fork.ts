import type { IMergeStrategy, MergeParams } from "./merge-strategy";

export class AlwaysForkStrategy implements IMergeStrategy {
    async merge({ ctx }: MergeParams): Promise<null> {
        await ctx.log(`[Merge] Strategy is 'Always Fork'. Skipping auto-merge.`, "info");
        return null;
    }
}
