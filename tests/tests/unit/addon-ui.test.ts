import { describe, it, expect, vi } from "vitest";
import { AddonUiRegistry, type AddonAction, type AddonUiContributions } from "../../../src/addons/addon-ui";

const action = (id: string, extra: Partial<AddonAction> = {}): AddonAction => ({
    id,
    label: `Label ${id}`,
    run: () => {},
    ...extra,
});

describe("AddonUiRegistry", () => {
    it("registers pages and actions and finds them by id", () => {
        const reg = new AddonUiRegistry();
        const problems = reg.set("addon-a", "Add-on A", {
            pages: [{ id: "main", title: "Main", getSections: () => [] }],
            actions: [action("do-it")],
        });
        expect(problems).toEqual([]);
        expect(reg.findPage("addon-a", "main")?.title).toBe("Main");
        expect(reg.findAction("do-it")?.addon.id).toBe("addon-a");
        expect(reg.commandActions().map((a) => a.id)).toEqual(["do-it"]);
    });

    it("leaves out parts with a bad shape, reserved ids and duplicates", () => {
        const reg = new AddonUiRegistry(new Set(["sync-vault"]));
        reg.set("addon-a", "A", { actions: [action("shared")] });
        const problems = reg.set("addon-b", "B", {
            actions: [
                action("sync-vault"),
                action("shared"),
                action("Bad Id"),
                { id: "no-run", label: "x" } as unknown as AddonAction,
                action("ok"),
            ],
            pages: [
                { id: "p", title: "P", getSections: () => [] },
                { id: "p", title: "P again", getSections: () => [] },
                { id: "q", title: "", getSections: () => [] },
            ],
        });
        expect(problems).toHaveLength(6);
        expect(reg.get("addon-b")?.actions.map((a) => a.id)).toEqual(["ok"]);
        expect(reg.get("addon-b")?.pages.map((p) => p.id)).toEqual(["p"]);
        // The first add-on keeps its action
        expect(reg.findAction("shared")?.addon.id).toBe("addon-a");
    });

    it("accepts a missing or malformed contributions object", () => {
        const reg = new AddonUiRegistry();
        expect(reg.set("a", "A", null)).toEqual([]);
        expect(reg.set("b", "B", { pages: "x" } as unknown as AddonUiContributions)).toEqual([]);
        expect(reg.list().map((a) => a.id)).toEqual(["a", "b"]);
    });

    it("replaces and removes an add-on", () => {
        const reg = new AddonUiRegistry();
        reg.set("a", "A", { actions: [action("one")] });
        // Re-registering the same add-on may reuse its own ids
        expect(reg.set("a", "A", { actions: [action("one"), action("two")] })).toEqual([]);
        expect(reg.get("a")?.actions).toHaveLength(2);
        reg.remove("a");
        expect(reg.findAction("one")).toBeUndefined();
        expect(reg.list()).toEqual([]);
    });

    it("keeps actions with command: false off the command list", () => {
        const reg = new AddonUiRegistry();
        reg.set("a", "A", { actions: [action("palette"), action("page-only", { command: false })] });
        expect(reg.commandActions().map((a) => a.id)).toEqual(["palette"]);
    });

    it("runs only available actions and contains add-on errors", async () => {
        const reg = new AddonUiRegistry();
        const run = vi.fn();
        let available = false;
        const errors = vi.spyOn(console, "error").mockImplementation(() => {});
        reg.set("a", "A", {
            actions: [
                action("gated", { isAvailable: () => available, run }),
                action("throws", { run: () => Promise.reject(new Error("boom")) }),
                action("bad-check", {
                    isAvailable: () => {
                        throw new Error("check");
                    },
                }),
            ],
            pages: [
                {
                    id: "broken",
                    title: "Broken",
                    getSections: () => {
                        throw new Error("page");
                    },
                },
            ],
        });
        expect(await reg.run("gated")).toBe(false);
        expect(run).not.toHaveBeenCalled();
        available = true;
        expect(await reg.run("gated")).toBe(true);
        expect(run).toHaveBeenCalledOnce();
        expect(await reg.run("throws")).toBe(false);
        expect(await reg.run("unknown")).toBe(false);
        expect(reg.isAvailable(reg.findAction("bad-check")!.action)).toBe(false);
        expect(reg.sectionsOf(reg.findPage("a", "broken")!)).toEqual([]);
        errors.mockRestore();
    });
});

describe("reserved command ids", () => {
    it("BUILTIN_COMMAND_IDS lists every command Vault-Sync registers itself", async () => {
        const { readFileSync } = await import("node:fs");
        const src = readFileSync(new URL("../../../src/main.ts", import.meta.url), "utf8");
        const registered = [...src.matchAll(/this\.addCommand\(\{\s*id: "([^"]+)"/g)].map((m) => m[1]);
        const block = src.slice(src.indexOf("const BUILTIN_COMMAND_IDS"), src.indexOf("]);", src.indexOf("const BUILTIN_COMMAND_IDS")));
        const reserved = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
        expect(registered.length).toBeGreaterThan(5);
        expect(new Set(reserved)).toEqual(new Set(registered));
    });
});
