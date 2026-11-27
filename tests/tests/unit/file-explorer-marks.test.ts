/**
 * @file ファイル一覧の同期状態表示の試験
 *
 * @pass_criteria
 * - 未送信ファイルと競合コピーのみに印を付与すること
 * - 状態変化時に印を更新し、無効化時に全印を除去すること
 */
import { describe, it, expect } from "vitest";
import { FileExplorerMarks } from "../../../src/ui/file-explorer-marks";

class El {
    classes = new Set<string>();
    addClass(c: string) {
        this.classes.add(c);
    }
    removeClasses(cs: string[]) {
        cs.forEach((c) => this.classes.delete(c));
    }
}

function setup(paths: string[]) {
    const els = Object.fromEntries(paths.map((p) => [p, new El()]));
    const fileItems = Object.fromEntries(paths.map((p) => [p, { selfEl: els[p] }]));
    const handlers: Array<() => void> = [];
    const app = {
        vault: { on: (_e: string, cb: () => void) => (handlers.push(cb), {}), offref: () => {} },
        workspace: {
            on: (_e: string, cb: () => void) => (handlers.push(cb), {}),
            getLeavesOfType: () => [{ view: { fileItems } }],
        },
    };
    let pending: string[] = [];
    let listener: (() => void) | null = null;
    const marks = new FileExplorerMarks(app as any, {
        pendingPaths: () => pending,
        subscribe: (cb) => {
            listener = cb;
            return () => (listener = null);
        },
    });
    return { marks, els, setPending: (p: string[]) => (pending = p), fire: () => listener?.(), handlers };
}

describe("file explorer marks", () => {
    it("marks files not sent yet and conflict copies only", () => {
        const s = setup(["a.md", "b.md", "a (Conflict 2026-01-01T00-00-00).md", "folder"]);
        s.setPending(["a.md"]);
        s.marks.enable();
        expect([...s.els["a.md"].classes]).toEqual(["vault-syncer-mark-pending"]);
        expect(s.els["b.md"].classes.size).toBe(0);
        const conflict = Object.keys(s.els).find((p) => p.includes("Conflict"))!;
        expect([...s.els[conflict].classes]).toEqual(["vault-syncer-mark-conflict"]);
        expect(s.els["folder"].classes.size).toBe(0);
    });

    it("follows the sync's state and clears everything when turned off", () => {
        const s = setup(["a.md", "b.md"]);
        s.setPending(["a.md"]);
        s.marks.enable();
        s.setPending(["b.md"]);
        s.fire();
        expect(s.els["a.md"].classes.size).toBe(0);
        expect(s.els["b.md"].classes.has("vault-syncer-mark-pending")).toBe(true);
        s.marks.disable();
        expect(s.els["b.md"].classes.size).toBe(0);
        expect(s.marks.enabled).toBe(false);
    });
});
