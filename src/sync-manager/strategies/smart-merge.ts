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
import { mergeLines3 } from "./diff3";

export class SmartMergeStrategy implements IMergeStrategy {
    async merge({
        ctx,
        path,
        localContent: localContentStr,
        remoteContent: remoteContentStr,
        baseHash,
        fileId,
    }: MergeParams): Promise<ArrayBuffer | null> {
        await ctx.log(`[Merge] Attempting 3-way merge for ${path}...`, "info");
        await ctx.log(`[Merge] Looking for base revision with hash: ${baseHash}`, "debug");

        const revisions = await listRevisions(ctx, path, fileId);
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

        const baseBuffer = await getRevisionContent(ctx, path, baseRev.id, fileId);
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
        const countLines = (t: string) => {
            const m = new Map<string, number>();
            for (const raw of t.split("\n")) {
                const l = raw.trim();
                if (l.length > 0) m.set(l, (m.get(l) ?? 0) + 1);
            }
            return m;
        };
        // Lines neither side removed must survive the merge too: the fuzzy patch
        // matching could put a hunk in the wrong place and drop them. A base line that
        // local kept cL times and remote cR times (of cB) is still wanted cL + cR - cB times.
        const baseCounts = countLines(baseNorm);
        const localCounts = countLines(localNorm);
        const remoteCounts = countLines(remoteNorm);
        const keptLines: [string, number][] = [];
        for (const [line, cB] of baseCounts) {
            const need = (localCounts.get(line) ?? 0) + (remoteCounts.get(line) ?? 0) - cB;
            if (need > 0) keptLines.push([line, need]);
        }
        const findLostLine = (mergedText: string): string | null => {
            const merged = countLines(mergedText);
            for (const line of localAddedLines) {
                if (!merged.has(line)) return `Local line was lost: "${line.substring(0, 40)}..."`;
            }
            for (const [line, need] of keptLines) {
                if ((merged.get(line) ?? 0) < need) return `Unchanged line was lost: "${line.substring(0, 40)}..."`;
            }
            return null;
        };

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

            const lost = findLostLine(mergedText);
            const validationFailed = lost !== null;
            if (lost) {
                await ctx.log(`[Merge] VALIDATION FAILED (margin=${margin}): ${lost}`, "warn");
            }

            if (!validationFailed) {
                await ctx.log(`[Merge] SUCCESS: Auto-merged ${path} with Patch_Margin=${margin}`, "info");
                return new TextEncoder().encode(mergedText).buffer;
            }
        }

        const lineMerged = mergeLines3(baseNorm, localNorm, remoteNorm);
        if (lineMerged !== null) {
            const lost = findLostLine(lineMerged);
            if (!lost) {
                await ctx.log(`[Merge] SUCCESS: Auto-merged ${path} line by line.`, "info");
                return new TextEncoder().encode(lineMerged).buffer;
            }
            await ctx.log(`[Merge] Line merge rejected: ${lost}`, "warn");
        }

        await ctx.log(
            `[Merge] FAIL: All Patch_Margin attempts failed for ${path}. (Safety Fallback)`,
            "warn",
        );
        return null;
    }
}
