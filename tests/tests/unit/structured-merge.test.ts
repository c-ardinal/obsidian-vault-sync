/**
 * @file 構造認識マージ（Canvas・JSON・Bases）の試験
 *
 * @pass_criteria
 * - Canvas: 両端末の別カード追加・別属性変更を統合、同一属性の別変更は競合
 * - JSON: キー単位の統合、名前一覧の集合統合、結果は常に構文正当
 * - Bases: 行マージ結果の構文検証、データ統合への移行
 * - SmartMergeStrategy 経由で同期本体から利用されること
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as historyModule from "../../../src/sync-manager/history";
import {
    isPullMergeable,
    mergeData,
    mergeJsonText,
    mergeYamlText,
    structuredKindOf,
} from "../../../src/sync-manager/strategies/structured-merge";
import { SmartMergeStrategy } from "../../../src/sync-manager/strategies/smart-merge";

vi.mock("../../../src/sync-manager/history", async () => {
    const actual = await vi.importActual<typeof historyModule>("../../../src/sync-manager/history");
    return { ...actual, listRevisions: vi.fn(), getRevisionContent: vi.fn() };
});

const canvas = (nodes: object[], edges: object[] = []) => JSON.stringify({ nodes, edges }, null, "\t");
const card = (id: string, text: string, x = 0) => ({ id, type: "text", text, x, y: 0, width: 250, height: 60 });

describe("structured merge", () => {
    it("knows which files are merged as data", () => {
        expect(structuredKindOf("a/b.canvas")).toBe("json");
        expect(structuredKindOf(".obsidian/app.json")).toBe("json");
        expect(structuredKindOf("views/tasks.base")).toBe("yaml");
        expect(structuredKindOf("note.md")).toBeNull();
        expect(isPullMergeable("x.canvas")).toBe(true);
        expect(isPullMergeable("x.base")).toBe(true);
        expect(isPullMergeable("x.md")).toBe(true);
        expect(isPullMergeable("x.png")).toBe(false);
    });

    describe("Canvas", () => {
        const base = canvas([card("a", "A")]);

        it("keeps the cards both devices added", () => {
            const local = canvas([card("a", "A"), card("b", "B")]);
            const remote = canvas([card("a", "A"), card("c", "C")]);
            const out = JSON.parse(mergeJsonText(base, local, remote)!);
            expect(out.nodes.map((n: { id: string }) => n.id)).toEqual(["a", "b", "c"]);
        });

        it("merges different changes to the same card", () => {
            const local = canvas([card("a", "A2")]);
            const remote = canvas([card("a", "A", 300)]);
            const out = JSON.parse(mergeJsonText(base, local, remote)!);
            expect(out.nodes[0]).toMatchObject({ text: "A2", x: 300 });
        });

        it("takes a card removed on one side and untouched on the other out", () => {
            const local = canvas([card("a", "A"), card("b", "B")]);
            const baseAB = local;
            const remote = canvas([card("b", "B")], [{ id: "e1", fromNode: "b", toNode: "b" }]);
            const out = JSON.parse(mergeJsonText(baseAB, local, remote)!);
            expect(out.nodes.map((n: { id: string }) => n.id)).toEqual(["b"]);
            expect(out.edges).toHaveLength(1);
        });

        it("is a conflict when the same text was changed two ways", () => {
            expect(mergeJsonText(base, canvas([card("a", "X")]), canvas([card("a", "Y")]))).toBeNull();
        });

        it("is a conflict when one side removed a card the other changed", () => {
            expect(mergeJsonText(base, canvas([]), canvas([card("a", "A2")]))).toBeNull();
        });

        it("keeps the tab layout Obsidian writes", () => {
            const out = mergeJsonText(base, canvas([card("a", "A"), card("b", "B")]), canvas([card("a", "A"), card("c", "C")]))!;
            expect(out).toContain('\n\t"nodes"');
        });
    });

    describe("JSON", () => {
        it("merges different keys of Obsidian's settings and keeps 2-space layout", () => {
            const base = JSON.stringify({ a: 1, b: 1 }, null, 2) + "\n";
            const local = JSON.stringify({ a: 2, b: 1 }, null, 2) + "\n";
            const remote = JSON.stringify({ a: 1, b: 1, c: true }, null, 2) + "\n";
            const out = mergeJsonText(base, local, remote)!;
            expect(JSON.parse(out)).toEqual({ a: 2, b: 1, c: true });
            expect(out).toBe(JSON.stringify({ a: 2, b: 1, c: true }, null, 2) + "\n");
        });

        it("merges the enabled plugin list as a set", () => {
            const out = mergeJsonText('["x","y"]', '["x","y","p"]', '["y","q"]')!;
            expect(JSON.parse(out)).toEqual(["y", "p", "q"]);
        });

        it("number lists are not sets: a coordinate changed two ways is a conflict", () => {
            expect(mergeJsonText('{"position":[0,1]}', '{"position":[2,1]}', '{"position":[3,1]}')).toBeNull();
        });

        it("cannot read a side: no result (never a broken file)", () => {
            expect(mergeJsonText("{}", "{", "{}")).toBeNull();
        });

        it("no base (a copy kept apart): keys only one side has are merged", () => {
            expect(mergeData(undefined, { a: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 });
            expect(mergeData(undefined, { a: 1 }, { a: 2 })).toBeNull();
        });
    });

    describe("Bases (YAML)", () => {
        it("merges different keys as data", () => {
            const base = "filters:\n  and: []\nviews:\n  - type: table\n    name: A\n";
            const local = "filters:\n  and:\n    - file.hasTag(\"x\")\nviews:\n  - type: table\n    name: A\n";
            const remote = "filters:\n  and: []\nviews:\n  - type: table\n    name: A\nformulas:\n  f: \"1\"\n";
            const out = mergeYamlText(base, local, remote)!;
            expect(out).toContain("file.hasTag");
            expect(out).toContain("formulas");
        });
    });

    describe("through the sync's merge strategy", () => {
        const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
        const ctx = { log: vi.fn().mockResolvedValue(undefined) } as any;
        beforeEach(() => {
            vi.mocked(historyModule.listRevisions).mockResolvedValue([
                { id: "r1", hash: "base", modifiedTime: 1, size: 1 },
            ] as any);
        });

        it("merges two canvases that each got a card", async () => {
            const base = canvas([card("a", "A")]);
            vi.mocked(historyModule.getRevisionContent).mockResolvedValue(enc(base));
            const out = await new SmartMergeStrategy().merge({
                ctx,
                path: "board.canvas",
                localContent: canvas([card("a", "A"), card("b", "B")]),
                remoteContent: canvas([card("a", "A"), card("c", "C")]),
                baseHash: "base",
            });
            const merged = JSON.parse(new TextDecoder().decode(out!));
            expect(merged.nodes).toHaveLength(3);
        });

        it("never writes broken JSON: a conflict instead", async () => {
            const base = '{\n  "a": 1\n}';
            vi.mocked(historyModule.getRevisionContent).mockResolvedValue(enc(base));
            const out = await new SmartMergeStrategy().merge({
                ctx,
                path: ".obsidian/app.json",
                localContent: '{\n  "a": 2\n}',
                remoteContent: '{\n  "a": 3\n}',
                baseHash: "base",
            });
            expect(out).toBeNull();
        });
    });
});
