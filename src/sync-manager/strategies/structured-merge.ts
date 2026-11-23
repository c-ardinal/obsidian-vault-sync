import { parseYaml, stringifyYaml } from "obsidian";

/**
 * Three-way merge of structured files: Canvas (.canvas), JSON (.json) and
 * Obsidian Bases (.base, YAML).
 *
 * A line merge does not know the structure: two devices that each add a card
 * to the same canvas both append a line in the same place (a conflict), and a
 * clean line merge of JSON can still leave a broken file (a lost comma), which
 * breaks Obsidian's own settings under .obsidian/. Here the data is merged as
 * data: object keys one by one, Canvas cards and arrows by their id, lists of
 * names (community-plugins.json) as sets. Only the same value changed two
 * ways is a conflict.
 */

export type StructuredKind = "json" | "yaml";

/** Files merged as data (and checked to stay readable after any merge) */
export function structuredKindOf(path: string): StructuredKind | null {
    const lower = path.toLowerCase();
    if (lower.endsWith(".canvas") || lower.endsWith(".json")) return "json";
    if (lower.endsWith(".base")) return "yaml";
    return null;
}

/** Text files the pull merges (line by line, or as data when structured) */
export function isPullMergeable(path: string): boolean {
    const lower = path.toLowerCase();
    return lower.endsWith(".md") || lower.endsWith(".txt") || structuredKindOf(lower) !== null;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
/** Absent value (key or item not there) */
const ABSENT = Symbol("absent");
type Slot = Json | typeof ABSENT;

class MergeConflict extends Error {}

function isObject(v: Slot): v is { [key: string]: Json } {
    return v !== null && v !== ABSENT && typeof v === "object" && !Array.isArray(v);
}

function same(a: Slot, b: Slot): boolean {
    if (a === b) return true;
    if (a === ABSENT || b === ABSENT) return false;
    if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) {
        const bArr = b as Json[];
        return a.length === bArr.length && a.every((x, i) => same(x, bArr[i]));
    }
    const ao = a;
    const bo = b as { [key: string]: Json };
    const ak = Object.keys(ao);
    if (ak.length !== Object.keys(bo).length) return false;
    return ak.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && same(ao[k], bo[k]));
}

/** Keys of local first (its order), then the keys only remote has (its order) */
function unionKeys(...lists: string[][]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const list of lists) {
        for (const k of list) {
            if (!seen.has(k)) {
                seen.add(k);
                out.push(k);
            }
        }
    }
    return out;
}

function mergeObjects(
    base: { [key: string]: Json } | undefined,
    local: { [key: string]: Json },
    remote: { [key: string]: Json },
): { [key: string]: Json } {
    const out: { [key: string]: Json } = {};
    const has = (o: { [key: string]: Json } | undefined, k: string) =>
        !!o && Object.prototype.hasOwnProperty.call(o, k);
    for (const k of unionKeys(Object.keys(local), Object.keys(remote), Object.keys(base ?? {}))) {
        const v = mergeSlot(has(base, k) ? base![k] : ABSENT, has(local, k) ? local[k] : ABSENT, has(remote, k) ? remote[k] : ABSENT);
        if (v !== ABSENT) out[k] = v;
    }
    return out;
}

const isPrimitiveList = (a: Json[]) =>
    a.every((x) => typeof x === "string" || typeof x === "number") && new Set(a).size === a.length;

const idOf = (x: Json): string | null =>
    isObject(x) && typeof x.id === "string" && x.id.length > 0 ? x.id : null;

const isIdList = (a: Json[]) => {
    const ids = a.map(idOf);
    return ids.every((id) => id !== null) && new Set(ids).size === ids.length;
};

/** A list of names (community-plugins.json, tags): merged as a set, local order first */
function mergePrimitiveLists(base: Json[], local: Json[], remote: Json[]): Json[] {
    const baseSet = new Set(base);
    const localSet = new Set(local);
    const remoteSet = new Set(remote);
    const removed = new Set([...baseSet].filter((x) => !localSet.has(x) || !remoteSet.has(x)));
    const out = local.filter((x) => !removed.has(x));
    for (const x of remote) if (!localSet.has(x) && !baseSet.has(x)) out.push(x);
    return out;
}

/** Items with an id (Canvas cards and arrows): merged one by one, local order first */
function mergeIdLists(base: Json[], local: Json[], remote: Json[]): Json[] {
    const byId = (a: Json[]) => new Map(a.map((x) => [idOf(x)!, x] as const));
    const b = byId(base);
    const l = byId(local);
    const r = byId(remote);
    const order = unionKeys([...l.keys()], [...r.keys()], [...b.keys()]);
    const out: Json[] = [];
    for (const id of order) {
        const v = mergeSlot(b.has(id) ? b.get(id)! : ABSENT, l.has(id) ? l.get(id)! : ABSENT, r.has(id) ? r.get(id)! : ABSENT);
        if (v !== ABSENT) out.push(v);
    }
    return out;
}

function mergeSlot(base: Slot, local: Slot, remote: Slot): Slot {
    if (same(local, remote)) return local;
    if (same(base, local)) return remote;
    if (same(base, remote)) return local;
    // Both changed it, differently
    if (isObject(local) && isObject(remote)) {
        return mergeObjects(isObject(base) ? base : undefined, local, remote);
    }
    if (Array.isArray(local) && Array.isArray(remote)) {
        const b = Array.isArray(base) ? base : [];
        if (isIdList(b) && isIdList(local) && isIdList(remote) && (local.length > 0 || remote.length > 0)) {
            return mergeIdLists(b, local, remote);
        }
        if (isPrimitiveList(b) && isPrimitiveList(local) && isPrimitiveList(remote)) {
            return mergePrimitiveLists(b, local, remote);
        }
    }
    // The same value set two ways, or deleted on one side and changed on the other
    throw new MergeConflict();
}

/**
 * Merge three parsed values. Returns the merged value, or null when the same
 * value was changed two ways. An absent base (undefined) is an empty start.
 */
export function mergeData(base: Json | undefined, local: Json, remote: Json): Json | null {
    try {
        const v = mergeSlot(base === undefined ? ABSENT : base, local, remote);
        return v === ABSENT ? null : v;
    } catch (e) {
        if (e instanceof MergeConflict) return null;
        throw e;
    }
}

function parseJson(text: string): Json | undefined {
    try {
        return JSON.parse(text.replace(/^\uFEFF/, "")) as Json;
    } catch {
        return undefined;
    }
}

/** Indent the file uses: tabs (Canvas), N spaces (settings), or none (one line) */
function indentOf(text: string): string | number {
    const m = /\n([ \t]+)\S/.exec(text);
    if (!m) return 0;
    return m[1].startsWith("\t") ? "\t" : m[1].length;
}

/**
 * Merge JSON text (Canvas or .json). Null when a side cannot be read or the
 * same value was changed two ways. The result keeps local's layout.
 */
export function mergeJsonText(base: string, local: string, remote: string): string | null {
    const l = parseJson(local);
    const r = parseJson(remote);
    if (l === undefined || r === undefined) return null;
    const b = base.trim() === "" ? undefined : parseJson(base);
    if (base.trim() !== "" && b === undefined) return null;
    const merged = mergeData(b, l, r);
    if (merged === null) return null;
    const indent = indentOf(local);
    const out = JSON.stringify(merged, null, indent === 0 ? undefined : indent);
    return local.endsWith("\n") ? out + "\n" : out;
}

/** The text is readable as its kind (JSON, YAML) */
export function isValidStructured(kind: StructuredKind, text: string): boolean {
    if (kind === "json") return parseJson(text) !== undefined;
    try {
        parseYaml(text);
        return true;
    } catch {
        return false;
    }
}

function parseYamlSafe(text: string): Json | undefined {
    try {
        const v = parseYaml(text) as Json | undefined;
        return v === undefined ? null : v;
    } catch {
        return undefined;
    }
}

/**
 * Merge YAML text (Bases) as data. Used when the line merge could not merge it
 * or left it unreadable; comments and layout follow Obsidian's own writer.
 */
export function mergeYamlText(base: string, local: string, remote: string): string | null {
    const l = parseYamlSafe(local);
    const r = parseYamlSafe(remote);
    if (l === undefined || r === undefined) return null;
    const b = base.trim() === "" ? undefined : parseYamlSafe(base);
    if (base.trim() !== "" && b === undefined) return null;
    const merged = mergeData(b, l, r);
    if (merged === null) return null;
    return stringifyYaml(merged);
}
