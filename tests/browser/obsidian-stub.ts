/** The parts of "obsidian" the Drive adapter imports, for the browser bundle of these tests */
export function requestUrl(): never {
    throw new Error("requestUrl is not available in the browser transport test");
}
export function normalizePath(p: string): string {
    return p;
}
