/**
 * Line-based three-way merge (diff3). Used when the patch-based merge cannot keep
 * every edit: it never moves or drops lines that neither side touched, which the
 * fuzzy patch matching occasionally did when both sides added lines near the same
 * spot.
 *
 * Regions changed on only one side take that side. Regions where both sides only
 * added lines (no base line in between) keep both additions, remote first. Any
 * other overlap is a real conflict: returns null.
 */

/** Above this many base x side lines the LCS table gets too big; give up. */
const MAX_CELLS = 4_000_000;

/** For each base line, the index of the matching line in `other` (LCS), or -1. */
function matchLines(base: string[], other: string[]): Int32Array | null {
    const n = base.length;
    const m = other.length;
    if ((n + 1) * (m + 1) > MAX_CELLS) return null;
    const w = m + 1;
    const dp = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            dp[i * w + j] =
                base[i] === other[j]
                    ? dp[(i + 1) * w + j + 1] + 1
                    : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
        }
    }
    const match = new Int32Array(n).fill(-1);
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (base[i] === other[j]) {
            match[i] = j;
            i++;
            j++;
        } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
            i++;
        } else {
            j++;
        }
    }
    return match;
}

function same(a: string[], b: string[]): boolean {
    return a.length === b.length && a.every((v, i) => v === b[i]);
}

export function mergeLines3(base: string, local: string, remote: string): string | null {
    const b = base.split("\n");
    const l = local.split("\n");
    const r = remote.split("\n");
    const ml = matchLines(b, l);
    const mr = matchLines(b, r);
    if (!ml || !mr) return null;

    const out: string[] = [];
    let i = 0;
    let li = 0;
    let ri = 0;
    for (;;) {
        let k = i;
        while (k < b.length && (ml[k] < 0 || mr[k] < 0)) k++;
        const lk = k < b.length ? ml[k] : l.length;
        const rk = k < b.length ? mr[k] : r.length;
        const B = b.slice(i, k);
        const L = l.slice(li, lk);
        const R = r.slice(ri, rk);
        if (same(L, B)) out.push(...R);
        else if (same(R, B) || same(L, R)) out.push(...L);
        else if (B.length === 0) out.push(...R, ...L);
        else return null;
        if (k >= b.length) break;
        out.push(b[k]);
        i = k + 1;
        li = lk + 1;
        ri = rk + 1;
    }
    return out.join("\n");
}
