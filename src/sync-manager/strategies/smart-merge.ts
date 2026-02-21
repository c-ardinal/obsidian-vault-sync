import { diff_match_patch } from "diff-match-patch";
import { normalizeLineEndings } from "../file-utils";
import { listRevisions, getRevisionContent } from "../history";
import { linesToChars3 } from "../diff-utils";
import {
    MERGE_DMP_MATCH_THRESHOLD,
    MERGE_DMP_MATCH_DISTANCE,
    MERGE_DMP_PATCH_DELETE_THRESHOLD,
    MERGE_PATCH_MARGINS,
} from "../constants";
import type { IMergeStrategy, MergeParams } from "./merge-strategy";

export class SmartMergeStrategy implements IMergeStrategy {
    async merge({
        ctx,
        path,
        localContent: localContentStr,
        remoteContent: remoteContentStr,
        baseHash,
    }: MergeParams): Promise<ArrayBuffer | null> {
        await ctx.log(`[Merge] Attempting 3-way merge for ${path}...`, "info");
        await ctx.log(`[Merge] Looking for base revision with hash: ${baseHash}`, "debug");

        const revisions = await listRevisions(ctx, path);
        await ctx.log(
            `[Merge] Found ${revisions.length} revisions: ${revisions.map((r) => r.hash?.substring(0, 8) || "no-hash").join(", ")}`,
            "debug",
        );

        const baseRev = revisions
            .slice()
            .reverse()
            .find((r) => r.hash && r.hash.toLowerCase() === baseHash.toLowerCase());

        if (!baseRev) {
            await ctx.log(`[Merge] No base revision found matching hash ${baseHash}.`, "warn");
            await ctx.log(
                `[Merge] Available hashes: ${revisions.map((r) => r.hash || "null").join(", ")}`,
                "debug",
            );
            return null;
        }

        await ctx.log(`[Merge] Found base revision: ${baseRev.id} (hash: ${baseRev.hash})`, "debug");

        const baseBuffer = await getRevisionContent(ctx, path, baseRev.id);
        const baseContentStr = new TextDecoder().decode(baseBuffer);

        const baseNorm = normalizeLineEndings(baseContentStr);
        const localNorm = normalizeLineEndings(localContentStr);
        const remoteNorm = normalizeLineEndings(remoteContentStr);

        await ctx.log(
            `[Merge] Content lengths (raw/norm) - Base: ${baseContentStr.length}/${baseNorm.length}, Local: ${localContentStr.length}/${localNorm.length}, Remote: ${remoteContentStr.length}/${remoteNorm.length}`,
            "debug",
        );

        await ctx.log(`[Merge DEBUG] Base Content:\n---\n${baseNorm}\n---`, "debug");
        await ctx.log(`[Merge DEBUG] Local Content:\n---\n${localNorm}\n---`, "debug");
        await ctx.log(`[Merge DEBUG] Remote Content:\n---\n${remoteNorm}\n---`, "debug");

        const dmp = new diff_match_patch();
        dmp.Match_Threshold = MERGE_DMP_MATCH_THRESHOLD;
        dmp.Match_Distance = MERGE_DMP_MATCH_DISTANCE;
        dmp.Patch_DeleteThreshold = MERGE_DMP_PATCH_DELETE_THRESHOLD;

        const {
            chars1: charsBase,
            chars2: charsLocal,
            chars3: charsRemote,
            lineArray,
        } = linesToChars3(baseNorm, localNorm, remoteNorm);

        const diffs = dmp.diff_main(charsBase, charsRemote, false);

        const getUniqueLines = (text: string, base: string) => {
            const lines = text
                .split("\n")
                .map((l) => l.trim())
                .filter((l) => l.length > 0);
            const baseLines = new Set(
                base
                    .split("\n")
                    .map((l) => l.trim())
                    .filter((l) => l.length > 0),
            );
            return lines.filter((l) => !baseLines.has(l));
        };
        const localAddedLines = getUniqueLines(localNorm, baseNorm);

        for (const margin of MERGE_PATCH_MARGINS) {
            await ctx.log(`[Merge] Attempting merge with Patch_Margin=${margin}...`, "debug");
            dmp.Patch_Margin = margin;

            const patches = dmp.patch_make(charsBase, diffs);

            let [mergedChars, successResults] = dmp.patch_apply(patches, charsLocal);

            const allSuccess = successResults.every((s: boolean) => s);
            if (!allSuccess) {
                await ctx.log(
                    `[Merge] Bulk apply failed (margin=${margin}). Attempting atomic recovery...`,
                    "warn",
                );
                let currentMerged = charsLocal;
                for (let i = 0; i < patches.length; i++) {
                    const [res, success] = dmp.patch_apply([patches[i]], currentMerged);
                    if (success[0]) {
                        currentMerged = res;
                    }
                }
                mergedChars = currentMerged;
            }

            let mergedText = "";
            let decodeError = false;
            for (let i = 0; i < mergedChars.length; i++) {
                const idx = mergedChars.charCodeAt(i);
                if (idx < lineArray.length) {
                    mergedText += lineArray[idx];
                } else {
                    await ctx.log(
                        `[Merge] Encoding error during decode (idx=${idx}, margin=${margin})`,
                        "warn",
                    );
                    decodeError = true;
                    break;
                }
            }
            if (decodeError) continue;

            await ctx.log(
                `[Merge DEBUG] Merged Content (margin=${margin}):\n---\n${mergedText}\n---`,
                "debug",
            );

            let validationFailed = false;
            if (localAddedLines.length > 0) {
                const mergedLines = new Set(
                    mergedText
                        .split("\n")
                        .map((l) => l.trim())
                        .filter((l) => l.length > 0),
                );
                for (const line of localAddedLines) {
                    if (!mergedLines.has(line)) {
                        await ctx.log(
                            `[Merge] VALIDATION FAILED (margin=${margin}): Local line was lost: "${line.substring(0, 40)}..."`,
                            "warn",
                        );
                        validationFailed = true;
                        break;
                    }
                }
            }

            if (!validationFailed) {
                await ctx.log(`[Merge] SUCCESS: Auto-merged ${path} with Patch_Margin=${margin}`, "info");
                return new TextEncoder().encode(mergedText).buffer;
            }
        }

        await ctx.log(
            `[Merge] FAIL: All Patch_Margin attempts failed for ${path}. (Safety Fallback)`,
            "warn",
        );
        return null;
    }
}
