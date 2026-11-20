/**
 * Settings search: which settings match what the user typed.
 *
 * A query is split at spaces; a setting matches when every word appears in
 * its own texts (name, description) or in the texts of the place it is in
 * (page, section, subheader). Case, full-width / half-width forms and
 * accents are ignored.
 */

/** Text in one comparable form */
export function normalizeForSearch(text: string): string {
    return text
        .normalize("NFKC")
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .normalize("NFC");
}

/** The words of a query (empty: nothing to search) */
export function queryWords(query: string): string[] {
    return normalizeForSearch(query)
        .split(/\s+/)
        .filter((w) => w !== "");
}

/** Every word appears somewhere in the texts */
export function matchesWords(words: string[], texts: (string | undefined)[]): boolean {
    if (words.length === 0) return false;
    const hay = normalizeForSearch(texts.filter((s) => s).join("\n"));
    return words.every((w) => hay.includes(w));
}
