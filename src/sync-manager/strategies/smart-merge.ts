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
import { isValidStructured, mergeJsonText, mergeYamlText, structuredKindOf } from "./structured-merge";

/** How many versions before the base the merge may look back (see below). */
const MERGE_OLDER_BASE_ATTEMPTS = 3;

const nonEmptyLines = (t: string) =>
    normalizeLineEndings(t)
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);

/** The non-empty lines `side` added relative to `base` that `merged` does not have. */
function droppedAddedLines(merged: string, side: string, base: string): string[] {
    const baseSet = new Set(nonEmptyLines(base));
    const mergedSet = new Set(nonEmptyLines(merged));
    return nonEmptyLines(side).filter((l) => !baseSet.has(l) && !mergedSet.has(l));
}

/** Every non-empty line `side` added relative to `base` is in `merged`. */
function keepsAddedLines(merged: string, side: string, base: string): boolean {
    return droppedAddedLines(merged, side, base).length === 0;
}

export class SmartMergeStrategy implements IMergeStrategy {
    async merge({
        ctx,
        path,
        localContent: localContentStr,
        remoteContent: remoteContentStr,
        baseHash,
        fileId,
        knownRevisions,
        baseContent,
    }: MergeParams): Promise<ArrayBuffer | null> {
        await ctx.log(`[Merge] Attempting 3-way merge for ${path}...`, "info");
        await ctx.log(`[Merge] Looking for base revision with hash: ${baseHash}`, "debug");

        const hasBase = (list: { hash?: string }[] | undefined) =>
            !!list?.some((r) => r.hash && r.hash.toLowerCase() === baseHash.toLowerCase());
        const revisions = hasBase(knownRevisions)
            ? knownRevisions!
            : await listRevisions(ctx, path, fileId);
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

        const kind = structuredKindOf(path);
        /**
         * Canvas and JSON merge as data first. Anything a line merge gives for a
         * structured file must still be readable, or it is a conflict copy rather
         * than a broken file (Obsidian's settings under .obsidian/ included).
         */
        const mergeFrom = async (baseContentStr: string): Promise<string | null> => {
            if (kind === "json") {
                const asData = mergeJsonText(
                    normalizeLineEndings(baseContentStr),
                    normalizeLineEndings(localContentStr),
                    normalizeLineEndings(remoteContentStr),
                );
                if (asData !== null) {
                    await ctx.log(`[Merge] SUCCESS: Merged ${path} as data.`, "info");
                    return asData;
                }
            }
            const asText = await mergeTextFrom(baseContentStr);
            if (!kind) return asText;
            if (asText !== null && isValidStructured(kind, asText)) return asText;
            if (asText !== null) await ctx.log(`[Merge] Line merge left ${path} unreadable: not used.`, "warn");
            if (kind === "yaml") {
                const asYaml = mergeYamlText(
                    normalizeLineEndings(baseContentStr),
                    normalizeLineEndings(localContentStr),
                    normalizeLineEndings(remoteContentStr),
                );
                if (asYaml !== null) {
                    await ctx.log(`[Merge] SUCCESS: Merged ${path} as data.`, "info");
                    return asYaml;
                }
            }
            return null;
        };

        const mergeTextFrom = async (baseContentStr: string): Promise<string | null> => {
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
            // A hunk of the other device that found no place is skipped by the atomic
            // recovery below: its new lines must not vanish without a conflict copy.
            const remoteAddedLines = getUniqueLines(remoteNorm, baseNorm);
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
                for (const line of remoteAddedLines) {
                    if (!merged.has(line)) return `Remote line was lost: "${line.substring(0, 40)}..."`;
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
                    return mergedText;
                }
            }

            const lineMerged = mergeLines3(baseNorm, localNorm, remoteNorm);
            if (lineMerged !== null) {
                const lost = findLostLine(lineMerged);
                if (!lost) {
                    await ctx.log(`[Merge] SUCCESS: Auto-merged ${path} line by line.`, "info");
                    return lineMerged;
                }
                await ctx.log(`[Merge] Line merge rejected: ${lost}`, "warn");
            }
            return null;
        };

        if (baseContent !== undefined) {
            const direct = await mergeFrom(baseContent);
            return direct === null ? null : new TextEncoder().encode(direct).buffer;
        }
        const baseBuffer = await getRevisionContent(ctx, path, baseRev.id, fileId);
        const primaryBase = new TextDecoder().decode(baseBuffer);
        const merged = await mergeFrom(primaryBase);
        if (merged !== null) return new TextEncoder().encode(merged).buffer;

        // The cloud has no compare-and-set: a version uploaded at the same moment as
        // ours (from the version BEFORE ours) replaces ours without containing it,
        // until the uploader repairs it. Its lines then look like it undid our edit,
        // and the merge from our version fails. Both sides derive from an earlier
        // version: merge from the nearest one that keeps every line of both sides.
        const baseIdx = revisions.indexOf(baseRev);
        const older = revisions
            .slice(Math.max(0, baseIdx - MERGE_OLDER_BASE_ATTEMPTS), baseIdx)
            .reverse()
            .filter((r) => r.hash && r.hash.toLowerCase() !== baseHash.toLowerCase());
        const readRev = async (r: (typeof revisions)[number]) =>
            new TextDecoder().decode(await getRevisionContent(ctx, path, r.id, fileId));
        let seenLater: Set<string> | null = null;
        /**
         * A line of ours the result drops is fine only when the other side had it in a
         * version after our base (it saw the line and changed it): a line it never had
         * was simply overwritten, and dropping it loses our edit.
         */
        const baseLines = new Set(nonEmptyLines(primaryBase));
        const remoteLines = new Set(nonEmptyLines(remoteContentStr));
        const localSeq = nonEmptyLines(localContentStr);
        const acceptable = async (result: string, from: string): Promise<boolean> => {
            if (!keepsAddedLines(result, remoteContentStr, from)) return false;
            const dropped = droppedAddedLines(result, localContentStr, primaryBase);
            if (dropped.length === 0) return true;
            // Replaced by a line the other side wrote itself (not in our base): it edited
            // that line. Replaced by a line our base already had: our line was only
            // overwritten by an older copy, and dropping it would lose it.
            const resultSeq = nonEmptyLines(result);
            if (
                resultSeq.length === localSeq.length &&
                dropped.every((l) => {
                    const at = resultSeq[localSeq.indexOf(l)];
                    return !!at && remoteLines.has(at) && !baseLines.has(at);
                })
            ) {
                return true;
            }
            if (!seenLater) {
                seenLater = new Set<string>();
                const later = revisions.slice(baseIdx + 1, revisions.length - 1).slice(-MERGE_OLDER_BASE_ATTEMPTS);
                for (const r of later) nonEmptyLines(await readRev(r)).forEach((l) => seenLater!.add(l));
            }
            const seen = seenLater;
            return dropped.every((l) => seen.has(l));
        };
        for (const rev of older) {
            await ctx.log(`[Merge] Retrying from the older version ${rev.hash?.substring(0, 8)}...`, "debug");
            const olderBase = await readRev(rev);
            const candidates = [olderBase];
            // Our version may be the repair of an overwrite (ours merged with the version
            // it replaced) whose upload has not happened yet: no single cloud version is
            // its base, but the merge of the two is.
            const idx = revisions.indexOf(rev);
            if (idx > 0) {
                const common = normalizeLineEndings(await readRev(revisions[idx - 1]));
                const repaired = mergeLines3(common, normalizeLineEndings(primaryBase), normalizeLineEndings(olderBase));
                if (repaired !== null) candidates.push(repaired);
            }
            for (const candidate of candidates) {
                const fromOlder = await mergeFrom(candidate);
                if (fromOlder !== null && (await acceptable(fromOlder, candidate))) {
                    await ctx.log(`[Merge] SUCCESS: Auto-merged ${path} from the older version ${rev.hash?.substring(0, 8)}.`, "info");
                    return new TextEncoder().encode(fromOlder).buffer;
                }
            }
        }

        await ctx.log(
            `[Merge] FAIL: All Patch_Margin attempts failed for ${path}. (Safety Fallback)`,
            "warn",
        );
        return null;
    }
}
