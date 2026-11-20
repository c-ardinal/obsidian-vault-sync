/**
 * Names that one operating system accepts and another does not, on the real
 * SyncManager with emulated file systems (Linux, macOS, Windows).
 *
 * Known trouble spots for Obsidian sync plugins:
 * - characters Windows/Android refuse (< > : " | ? * \) in names made on macOS/Linux/iOS
 * - Windows device names (CON, AUX, NUL, COM1, LPT1 ...) and names ending in "." or " "
 * - letter case only differences (Note.md / note.md) and NFC/NFD (café)
 * - ".." inside a name (not a path segment)
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { SimCloud } from "./sim-cloud";
import { SimDevice, isInternalPath } from "./sim-device";
import { Rng } from "./rng";
import { drive } from "./simulation";
import type { FsPersonality } from "./sim-vault";

const NET = { minLatencyMs: 1, maxLatencyMs: 5, failureRate: 0, lostResponseRate: 0 };

async function setup() {
    vi.useFakeTimers({
        toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
        now: Date.UTC(2026, 0, 1),
    });
    const rng = new Rng(23);
    vi.spyOn(Math, "random").mockImplementation(() => rng.next());
    const cloud = new SimCloud();
    const logs: string[] = [];
    const make = async (name: string, fs: FsPersonality) => {
        const devRng = rng.fork(name.charCodeAt(0));
        const dev: SimDevice = new SimDevice({
            name,
            fs,
            rng: devRng,
            maxEventDelayMs: 0,
            clockSkewMs: 0,
            log: (dev: string, line: string) => logs.push(`[${dev}] ${line}`),
            cloudView: (d) => cloud.createDeviceView(name, devRng.fork(7), () => NET, () => d.online),
        });
        await dev.init();
        return dev;
    };
    const sync = async (dev: SimDevice) => {
        expect(await drive(dev.startSync("manual-sync", true), 600_000)).toBe("ok");
        expect(await drive(dev.transfersSettled(), 600_000)).toBe("ok");
    };
    const cloudFiles = () => cloud.snapshot(isInternalPath);
    return { make, sync, cloudFiles, logs };
}

describe("names that differ between operating systems", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it("merges edits of a note whose name has characters Windows refuses", async () => {
        const { make, sync, cloudFiles } = await setup();
        const mac = await make("A", "macos");
        const linux = await make("B", "linux");
        const name = 'Q&A: why? "draft" <v1|v2>.md';
        await mac.userCreate(name, "a\nb\nc\n");
        await sync(mac);
        await sync(linux);
        expect(linux.read(name)).toBe("a\nb\nc\n");

        await mac.userEdit(name, "a (mac)\nb\nc\n");
        await linux.userEdit(name, "a\nb\nc (linux)\n");
        await sync(mac);
        await sync(linux);
        await sync(mac);

        const merged = "a (mac)\nb\nc (linux)\n";
        expect((await cloudFiles())[name]).toBe(merged);
        expect(mac.read(name)).toBe(merged);
        expect(linux.read(name)).toBe(merged);
        expect(Object.keys(mac.userFiles()).filter((p) => p.includes("Conflict"))).toEqual([]);
    });

    it("merges edits of a note with '..' inside its name", async () => {
        const { make, sync, cloudFiles } = await setup();
        const a = await make("A", "linux");
        const b = await make("B", "windows");
        const name = "notes/v1..v2 plan.md";
        await a.userCreate(name, "a\nb\nc\n");
        await sync(a);
        await sync(b);
        await a.userEdit(name, "a (A)\nb\nc\n");
        await b.userEdit(name, "a\nb\nc (B)\n");
        await sync(a);
        await sync(b);
        await sync(a);
        expect((await cloudFiles())[name]).toBe("a (A)\nb\nc (B)\n");
        expect(Object.keys(b.userFiles()).filter((p) => p.includes("Conflict"))).toEqual([]);
    });

    it.each([
        ["characters", "Why? 2026-01-01 10:00.md"],
        ["a device name", "inbox/con.md"],
        ["a device name with another extension", "aux.txt"],
        ["a trailing dot", "folder./note.md"],
        ["a trailing space", "Draft /note.md"],
    ])("never deletes a note whose name Windows cannot store (%s)", async (_label, name) => {
        const { make, sync, cloudFiles, logs } = await setup();
        const mac = await make("A", "macos");
        const win = await make("B", "windows");
        await mac.userCreate(name, "keep me");
        await mac.userCreate("plain.md", "plain");
        await sync(mac);

        // The Windows device cannot write it. It must still receive the rest,
        // and neither delete the note in the cloud nor fail every sync.
        await sync(win);
        await sync(win);
        await sync(mac);
        await sync(win);

        const cloud = await cloudFiles();
        const stored = Object.keys(cloud).find((p) => p.normalize("NFC") === name.normalize("NFC"));
        expect(stored, "note still in the cloud").toBeDefined();
        expect(cloud[stored!]).toBe("keep me");
        expect(win.read("plain.md")).toBe("plain");
        expect(Object.values(mac.userFiles())).toContain("keep me");

        // Edited on the Mac afterwards: still syncs between the devices that can hold it
        await mac.userEdit(Object.keys(mac.userFiles()).find((p) => mac.read(p) === "keep me")!, "edited");
        await sync(mac);
        await sync(win);
        await sync(mac);
        expect(Object.values(await cloudFiles())).toContain("edited");
        expect(win.describe().dirtyPaths).toEqual([]);
        // Told once why the note is missing there, no error on every sync, no download tries
        const onWin = logs.filter((l) => l.startsWith("[B]"));
        expect(onWin.filter((l) => l.includes("cannot store a file under this name"))).toHaveLength(1);
        expect(onWin.filter((l) => l.includes("ERROR") && l.includes(stored!))).toEqual([]);
    });

    it("keeps a note on Windows when another device renames it to a name Windows refuses, and back", async () => {
        const { make, sync, cloudFiles } = await setup();
        const mac = await make("A", "macos");
        const win = await make("B", "windows");
        await mac.userCreate("plan.md", "v1");
        await sync(mac);
        await sync(win);

        await mac.userRename("plan.md", "plan: draft?.md");
        await sync(mac);
        await sync(win);
        await sync(win);
        await sync(mac);
        // The cloud keeps the Mac's name: Windows must not undo the rename or delete it
        expect(await cloudFiles()).toEqual({ "plan: draft?.md": "v1" });
        expect(mac.userFiles()).toEqual({ "plan: draft?.md": "v1" });
        expect(win.describe().dirtyPaths).toEqual([]);

        await mac.userEdit("plan: draft?.md", "v2");
        await mac.userRename("plan: draft?.md", "plan - final.md");
        await sync(mac);
        await sync(win);
        await sync(win);
        expect(await cloudFiles()).toEqual({ "plan - final.md": "v2" });
        expect(win.userFiles()).toEqual({ "plan - final.md": "v2" });
    });

    it("keeps both notes when Linux has names that differ only in letter case", async () => {
        const { make, sync, cloudFiles } = await setup();
        const linux = await make("A", "linux");
        const win = await make("B", "windows");
        const mac = await make("C", "macos");
        await linux.userCreate("Todo.md", "upper");
        await linux.userCreate("todo.md", "lower");
        await sync(linux);
        await sync(win);
        await sync(mac);
        await sync(linux);
        await sync(win);
        await sync(mac);

        const cloud = await cloudFiles();
        expect(Object.values(cloud).sort()).toEqual(["lower", "upper"]);
        expect(Object.values(win.userFiles()).sort()).toEqual(["lower", "upper"]);
        expect(Object.values(mac.userFiles()).sort()).toEqual(["lower", "upper"]);
        expect(Object.values(linux.userFiles()).sort()).toEqual(["lower", "upper"]);
    });

    it("follows a letter-case-only rename on every system", async () => {
        const { make, sync, cloudFiles } = await setup();
        const win = await make("A", "windows");
        const linux = await make("B", "linux");
        const mac = await make("C", "macos");
        await win.userCreate("notes/todo.md", "x");
        await sync(win);
        await sync(linux);
        await sync(mac);
        await win.userRename("notes/todo.md", "notes/Todo.md");
        await sync(win);
        await sync(linux);
        await sync(mac);

        expect(Object.keys(await cloudFiles())).toEqual(["notes/Todo.md"]);
        expect(Object.keys(linux.userFiles())).toEqual(["notes/Todo.md"]);
        expect(Object.keys(mac.userFiles())).toEqual(["notes/Todo.md"]);
        expect(Object.keys(win.userFiles())).toEqual(["notes/Todo.md"]);
    });

    it("follows a letter-case-only folder rename made on Windows", async () => {
        const { make, sync, cloudFiles } = await setup();
        const win = await make("A", "windows");
        const linux = await make("B", "linux");
        const mac = await make("C", "macos");
        await win.userCreate("Notes/a.md", "a");
        await win.userCreate("Notes/sub/b.md", "b");
        await sync(win);
        await sync(linux);
        await sync(mac);
        expect(await win.userRenameFolder("Notes", "notes")).toBe(true);
        await sync(win);
        await sync(linux);
        await sync(mac);
        await sync(win);

        const expected = ["notes/a.md", "notes/sub/b.md"];
        expect(Object.keys(await cloudFiles()).sort(), "cloud").toEqual(expected);
        expect(Object.keys(linux.userFiles()).sort(), "Linux").toEqual(expected);
        expect(Object.keys(mac.userFiles()).sort(), "macOS").toEqual(expected);
        expect(Object.keys(win.userFiles()).sort(), "Windows").toEqual(expected);
    });

    it("syncs a note made on macOS (NFD name) once, under one name, to Linux and Windows", async () => {
        const { make, sync, cloudFiles } = await setup();
        const mac = await make("A", "macos");
        const linux = await make("B", "linux");
        const win = await make("C", "windows");
        await mac.userCreate("Résumé/café.md", "x");
        await sync(mac);
        await sync(linux);
        await sync(win);
        await linux.userEdit(Object.keys(linux.userFiles())[0], "y");
        await sync(linux);
        await sync(mac);
        await sync(win);

        const cloud = await cloudFiles();
        expect(Object.keys(cloud)).toHaveLength(1);
        expect(Object.values(cloud)).toEqual(["y"]);
        for (const d of [mac, linux, win]) expect(Object.values(d.userFiles())).toEqual(["y"]);
    });
});
