import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { CtxFlag, CtxState, ctxStateCatalog, describeCtxState } from "../../../src/sync-manager/context-state";
// Load every sync module so all of its state is declared
import "../../../src/sync-manager";

describe("per-context state", () => {
    it("lists every piece of state with a description", () => {
        const catalog = ctxStateCatalog();
        expect(catalog.length).toBeGreaterThanOrEqual(21);
        for (const entry of catalog) expect(entry.about.length).toBeGreaterThan(10);
        expect(catalog.map((e) => e.name)).toContain("indexJournal");
    });

    it("describes what a context carries", () => {
        const counts = new CtxState<Map<string, number>>("test.counts", "Test state: counts per key");
        const flag = new CtxFlag("test.flag", "Test state: a yes/no mark");
        const ctx = {};
        expect(describeCtxState(ctx)).toEqual({});
        counts.set(ctx, new Map([["a", 1], ["b", 2]]));
        flag.add(ctx);
        expect(describeCtxState(ctx)).toMatchObject({ "test.counts": "2 item(s)", "test.flag": "true" });
        expect(describeCtxState({})).toEqual({});
    });

    it("refuses a name declared twice", () => {
        new CtxState<number>("test.twice", "Test state declared twice");
        expect(() => new CtxState<number>("test.twice", "Test state declared twice")).toThrow();
    });

    it("sync modules declare their state here instead of keeping their own WeakMap", () => {
        const dir = join("src", "sync-manager");
        // remote-trash.ts caches a trash adapter per cloud adapter (not per context)
        const allowed = new Set(["context-state.ts", "remote-trash.ts"]);
        const offenders = readdirSync(dir)
            .filter((f) => f.endsWith(".ts") && !allowed.has(f))
            .filter((f) => /new Weak(Map|Set)\b/.test(readFileSync(join(dir, f), "utf8")));
        expect(offenders).toEqual([]);
    });
});
