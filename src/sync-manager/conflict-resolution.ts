import { diff_match_patch } from "diff-match-patch";

/**
 * Resolving a conflict copy by hand.
 *
 * When both sides edited a note and the automatic merge failed, the sync keeps
 * the cloud version under the note's path and this device's version as a
 * local-only copy "name (Conflict 2026-11-20T08-00-00).ext". The copy is never
 * synced, so it stays until the user resolves it: per differing part, take this
 * device's lines, the cloud's lines, or both; the result replaces the note
 * (and syncs as an ordinary edit), and the copy goes to the vault's trash.
 */

const COPY_RE = /^(.*) \(Conflict (\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})\)(\.[^./]+)?$/;

/** The note a conflict copy belongs to, or null when the path is no copy */
export function parseConflictCopyPath(path: string): { originalPath: string; stamp: string } | null {
    const m = COPY_RE.exec(path);
    if (!m) return null;
    return { originalPath: `${m[1]}${m[3] ?? ""}`, stamp: m[2] };
}

/**
 * A free name for a conflict copy of `path`: "<name> (Conflict <time>).<ext>",
 * a second later while that name is taken. Two copies made in the same second
 * (a pull's and an overwrite repair's) used to get one name, and the second
 * write replaced the version the first one held.
 */
export async function freeConflictCopyPath(exists: (path: string) => Promise<boolean>, path: string): Promise<string> {
    const slash = path.lastIndexOf("/");
    const dot = path.lastIndexOf(".");
    const [stem, ext] = dot > slash + 1 ? [path.slice(0, dot), path.slice(dot)] : [path, ""];
    for (let n = 0; ; n++) {
        const stamp = new Date(Date.now() + n * 1000).toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const candidate = `${stem} (Conflict ${stamp})${ext}`;
        if (n >= 60 || !(await exists(candidate))) return candidate;
    }
}

export function isConflictCopyPath(path: string): boolean {
    return COPY_RE.test(path);
}

/** Conflict copies among `paths`, newest first */
export function findConflictCopies(paths: string[]): { path: string; originalPath: string; stamp: string }[] {
    const found: { path: string; originalPath: string; stamp: string }[] = [];
    for (const path of paths) {
        const parsed = parseConflictCopyPath(path);
        if (parsed) found.push({ path, ...parsed });
    }
    return found.sort((a, b) => b.stamp.localeCompare(a.stamp) || a.path.localeCompare(b.path));
}

/** A run of lines both versions share, or a part where they differ */
export type ConflictChunk =
    | { kind: "same"; lines: string[] }
    | { kind: "differ"; local: string[]; remote: string[] };

export type ChunkChoice = "local" | "remote" | "both";

function splitLines(text: string): string[] {
    if (text === "") return [];
    const lines = text.split("\n");
    // "a\nb\n" is two lines, each ending in a newline
    const out = lines.map((l, i) => (i < lines.length - 1 ? l + "\n" : l));
    if (out[out.length - 1] === "") out.pop();
    return out;
}

/** Line-based comparison of this device's version with the cloud's */
export function buildConflictChunks(local: string, remote: string): ConflictChunk[] {
    const dmp = new diff_match_patch();
    const { chars1, chars2, lineArray } = dmp.diff_linesToChars_(local, remote);
    const diffs = dmp.diff_main(chars1, chars2, false);
    dmp.diff_charsToLines_(diffs, lineArray);

    const chunks: ConflictChunk[] = [];
    let open: { kind: "differ"; local: string[]; remote: string[] } | null = null;
    for (const [op, text] of diffs) {
        const lines = splitLines(text);
        if (lines.length === 0) continue;
        if (op === 0) {
            open = null;
            const last = chunks[chunks.length - 1];
            if (last?.kind === "same") last.lines.push(...lines);
            else chunks.push({ kind: "same", lines });
            continue;
        }
        if (!open) {
            open = { kind: "differ", local: [], remote: [] };
            chunks.push(open);
        }
        (op === -1 ? open.local : open.remote).push(...lines);
    }
    return chunks;
}

function joinLines(parts: string[][]): string {
    let out = "";
    for (const lines of parts) {
        for (const line of lines) {
            // A part that ends without a newline (end of file) gets one before more text follows
            if (out !== "" && !out.endsWith("\n")) out += "\n";
            out += line;
        }
    }
    return out;
}

/**
 * The text that results from the choices, one per differing chunk (in order).
 * A missing choice takes the cloud's lines, the version the note has now.
 */
export function composeConflictResult(chunks: ConflictChunk[], choices: ChunkChoice[]): string {
    const parts: string[][] = [];
    let d = 0;
    for (const chunk of chunks) {
        if (chunk.kind === "same") {
            parts.push(chunk.lines);
            continue;
        }
        const choice = choices[d++] ?? "remote";
        if (choice === "local" || choice === "both") parts.push(chunk.local);
        if (choice === "remote" || choice === "both") parts.push(chunk.remote);
    }
    return joinLines(parts);
}

/** UTF-8 text, or null when the bytes are not text */
export function decodeText(data: ArrayBuffer): string | null {
    try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
        return text.includes("\u0000") ? null : text;
    } catch {
        return null;
    }
}

/** The vault operations resolving needs */
export interface ConflictVault {
    exists(path: string): Promise<boolean>;
    readBinary(path: string): Promise<ArrayBuffer>;
    /** Write the note (creating it, and its folder, when missing) */
    writeNote(path: string, data: ArrayBuffer): Promise<void>;
    /** Move the copy to the vault's trash */
    trash(path: string): Promise<void>;
}

/**
 * Finish a conflict: write `result` to the note (null = keep the note as it is)
 * and move the copy to the trash. Returns the note's path.
 */
export async function resolveConflictCopy(
    vault: ConflictVault,
    copyPath: string,
    result: ArrayBuffer | null,
): Promise<string> {
    const parsed = parseConflictCopyPath(copyPath);
    if (!parsed) throw new Error(`Not a conflict copy: ${copyPath}`);
    if (result) await vault.writeNote(parsed.originalPath, result);
    await vault.trash(copyPath);
    return parsed.originalPath;
}
