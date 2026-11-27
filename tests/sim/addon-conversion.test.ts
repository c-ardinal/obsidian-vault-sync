/**
 * A vault converted for the add-on on one device while another device keeps
 * running, on the real Google Drive adapter.
 *
 * The conversion re-uploads every file into a new folder, renames the old
 * folder away and gives the new one the vault's name. Drive addresses folders by
 * id: a device that resolved the vault folder before the swap keeps that id and
 * goes on working in the OLD folder unless it looks the folder up again. The
 * conversion tests so far played the other device as plain cloud writes, so
 * nothing ran a second SyncManager through the swap.
 *
 * Every device runs the real SyncManager, MigrationService, GoogleDriveAdapter
 * and path resolver against FakeDriveServer. The engine stands in for the
 * add-on: it can be locked, and decrypting bytes it did not produce fails.
 *
 * @pass_criteria
 * - the running device notices the conversion at its next sync, without restart,
 *   and stops syncing until it is unlocked
 * - nothing it does before the unlock reaches the converted vault as plain bytes
 * - after the unlock both devices sync without a decryption error, every file of
 *   the converted vault decrypts, and edits made on either device reach the other
 * - an edit made on the running device before it noticed the conversion is kept
 * - an edit made in the converted vault meanwhile reaches the running device
 *   without a conflict copy when the note was untouched there; a note edited on
 *   both sides keeps both edits
 * - no file is renamed to "name (2)", in the cloud or on a device
 * - a note deleted in the converted vault meanwhile comes back (never lost)
 * - the same holds when the running device is restarted instead
 * - a note pushed into the old folder too late to be converted reaches the
 *   converted vault once (by its device or by the cleanup of the old folder),
 *   and stays deleted when it was deleted there, whichever way it arrived
 * - a note renamed before its device followed is renamed in the vault, not copied
 * - of two devices that start a conversion, one gives up before the folders are
 *   swapped and follows the other's conversion
 * - a converting device closed at any step leaves a vault every device can sync
 *   with: the run is given up, or its folder swap completed, at the next start;
 *   no device creates an empty vault folder while the vault's name is free
 * - files the converting device leaves out by its settings are converted too
 * - a vault folder renamed or deleted by hand is rebuilt, with the vault-lock
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { SimDevice } from "./sim-device";
import { Rng } from "./rng";
import { drive } from "./simulation";
import { FakeDriveServer, driveAdapterOnFakeServer } from "../helpers/fake-drive-server";
import { createMockEngine, MOCK_TAG_SIZE } from "../helpers/mock-crypto-engine";
import { DecryptionError } from "../../src/encryption/errors";
import type { CloudAdapter } from "../../src/types/adapter";
import type { ICryptoEngine } from "../../src/encryption/interfaces";

const PASSWORD = "pw";

/** Lockable engine; its ciphertext carries a marker, anything else fails to decrypt */
function lockableEngine(): ICryptoEngine & { unlocked: boolean } {
    const engine = createMockEngine({
        async initializeNewVault() {
            engine.unlocked = true;
            return "LOCK";
        },
        async unlockVault(_blob: string, password: string) {
            if (password !== PASSWORD) throw new Error("Invalid password");
            engine.unlocked = true;
        },
        isUnlocked: () => engine.unlocked,
        async encrypt(data: ArrayBuffer) {
            if (!engine.unlocked) throw new Error("Locked");
            const plain = new Uint8Array(data);
            const ct = new Uint8Array(plain.byteLength + MOCK_TAG_SIZE);
            ct.set(plain, 0);
            ct.fill(0xdd, plain.byteLength);
            return { ciphertext: ct.buffer, iv: new Uint8Array(12).fill(0xbb) };
        },
        async decrypt(ciphertext: ArrayBuffer, iv: Uint8Array) {
            if (!engine.unlocked) throw new Error("Locked");
            const ct = new Uint8Array(ciphertext);
            const n = ct.byteLength - MOCK_TAG_SIZE;
            const ok = n >= 0 && iv.every((b) => b === 0xbb) && ct.subarray(n).every((b) => b === 0xdd);
            if (!ok) throw new DecryptionError("Decryption failed", "authentication");
            return ct.slice(0, n).buffer;
        },
    }) as ICryptoEngine & { unlocked: boolean };
    engine.unlocked = false;
    return engine;
}

interface DriveItem { id: string; name: string; parents: string[]; mimeType: string; content?: Uint8Array; trashed?: boolean }

async function setup() {
    vi.useFakeTimers({
        toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
        now: Date.UTC(2026, 0, 1),
    });
    const rng = new Rng(47);
    vi.spyOn(Math, "random").mockImplementation(() => rng.next());
    const server = new FakeDriveServer();
    const logs: string[] = [];
    /** Notice keys per device, in order */
    const notices: Record<string, string[]> = {};
    /** How often the plugin was told to ask the user (install the add-on / password) */
    const prompts: Record<string, number> = {};
    const make = async (name: string, addonInstalled = true) => {
        const engine = lockableEngine();
        const state = { installed: addonInstalled };
        const dev: SimDevice = new SimDevice({
            name,
            fs: "linux",
            rng: rng.fork(name.charCodeAt(0)),
            maxEventDelayMs: 0,
            clockSkewMs: 0,
            log: (d: string, m: string) => {
                logs.push(`[${d}] ${m}`);
                if (process.env.SIMLOG) console.log(`[${d}] ${m}`);
            },
            // A restarted app resolves the vault folder anew
            cloudView: () => driveAdapterOnFakeServer(server).adapter as unknown as CloudAdapter,
        });
        notices[name] = [];
        prompts[name] = 0;
        const wire = (d: SimDevice) => {
            // The add-on (when installed) is loaded, but the vault is not converted yet
            d.sm.cryptoEngine = state.installed ? engine : null;
            const notify = d.sm.notify.bind(d.sm);
            d.sm.notify = async (key: string, ...rest: []) => {
                notices[name].push(key);
                return notify(key, ...rest);
            };
            d.sm.onVaultAccessRequired = async () => void prompts[name]++;
        };
        dev.onBoot = wire;
        wire(dev);
        await dev.init();
        /** The user installs the add-on from the dialog the plugin opened */
        const install = () => {
            state.installed = true;
            dev.sm.cryptoEngine = engine;
        };
        return { dev, engine, install };
    };
    const sync = async (dev: SimDevice, scan = false, trigger: "manual-sync" | "timer-sync" = "manual-sync") => {
        await vi.advanceTimersByTimeAsync(50);
        expect(await drive(dev.startSync(trigger, scan), 600_000)).toBe("ok");
        expect(await drive(dev.transfersSettled(), 600_000)).toBe("ok");
    };
    const items = () =>
        [...(server as unknown as { items: Map<string, DriveItem> }).items.values()].filter((i) => !i.trashed);
    const pathOf = (it: DriveItem): string => {
        const parent = items().find((x) => x.id === it.parents[0]);
        return parent ? `${pathOf(parent)}/${it.name}` : it.name;
    };
    /** User files of the folder that carries the vault's name now: path -> stored bytes */
    const vaultFiles = (): Record<string, Uint8Array> => {
        const out: Record<string, Uint8Array> = {};
        for (const it of items()) {
            if (it.mimeType.endsWith("folder")) continue;
            const p = pathOf(it);
            if (!p.startsWith("ContractRoot/ContractVault/")) continue;
            const rel = p.slice("ContractRoot/ContractVault/".length);
            // The lock files are plain by design; everything else is stored encrypted
            if (rel.endsWith("/vault-lock.vault") || rel === "migration.lock") continue;
            out[rel] = it.content ?? new Uint8Array();
        }
        return out;
    };
    const folderNames = () =>
        items().filter((i) => i.mimeType.endsWith("folder") && pathOf(i).split("/").length === 2).map((i) => i.name);
    /** Convert the vault on `dev` the way the add-on's setup dialog does */
    const convert = async (dev: SimDevice) => {
        const svc = dev.sm.migrationService;
        const temp = await svc.startMigration(PASSWORD);
        await svc.runMigration(temp, () => {});
        await svc.finalizeMigration(temp);
        dev.settings.e2eeEnabled = true;
    };
    /** Delete a cloud item the way another client does (shows up in the change feed) */
    const remove = async (id: string) => {
        await driveAdapterOnFakeServer(server).adapter.deleteFile(id);
    };
    return { server, make, sync, vaultFiles, folderNames, convert, logs, notices, prompts, items, pathOf, remove };
}

/** Stored bytes of a converted file: the plain text followed by the engine's marker */
const decryptable = (b: Uint8Array) =>
    b.byteLength >= 12 + MOCK_TAG_SIZE && b.subarray(0, 12).every((x) => x === 0xbb) && b.subarray(-MOCK_TAG_SIZE).every((x) => x === 0xdd);

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("vault converted while another device runs (Drive)", () => {
    /**
     * What the running device finds of the old folder at its next sync:
     * - lock: the migration lock is still in it (the usual case)
     * - no-lock: the lock is gone (only the change feed shows the swap)
     * - deleted: the old folder was deleted already
     */
    const cases: Array<{ restartA: boolean; old: "lock" | "no-lock" | "deleted"; addon: boolean }> = [
        { restartA: false, old: "lock", addon: true },
        { restartA: false, old: "no-lock", addon: true },
        { restartA: false, old: "deleted", addon: true },
        { restartA: true, old: "lock", addon: true },
        { restartA: true, old: "deleted", addon: true },
        { restartA: false, old: "lock", addon: false },
        { restartA: false, old: "no-lock", addon: false },
        { restartA: false, old: "deleted", addon: false },
        { restartA: true, old: "lock", addon: false },
    ];
    for (const { restartA, old, addon } of cases) {
        const title = `the other device ${restartA ? "restarts" : "keeps running"} (add-on ${addon ? "installed" : "missing"}), old folder: ${old}`;
        it(title, async () => {
            const t = await setup();
            const a = await t.make("A", addon);
            const b = await t.make("B");
            await a.dev.userCreate("one.md", "one\n");
            await a.dev.userCreate("dir/two.md", "two\n");
            await a.dev.userCreate("both.md", "both\n");
            await a.dev.userCreate("gone.md", "gone\n");
            await t.sync(a.dev);
            await t.sync(b.dev);
            await t.sync(a.dev);
            expect(b.dev.userFiles()).toEqual({ "one.md": "one\n", "dir/two.md": "two\n", "both.md": "both\n", "gone.md": "gone\n" });

            await t.convert(b.dev);
            for (const [p, bytes] of Object.entries(t.vaultFiles())) expect(decryptable(bytes), p).toBe(true);

            // B goes on working in the converted vault before A follows
            await b.dev.userEdit("dir/two.md", "two\nedited on B\n");
            await b.dev.userEdit("both.md", "both\nB's line\n");
            await b.dev.userDelete("gone.md");
            await t.sync(b.dev);

            const backup = t.items().find((i) => i.name.includes("-Backup-"))!;
            expect(backup, "the old folder is kept while another device syncs the vault").toBeTruthy();
            if (old === "no-lock") {
                const lock = t.items().find((i) => i.name === "migration.lock" && i.parents[0] === backup.id)!;
                await t.remove(lock.id);
            }
            if (old === "deleted") await t.remove(backup.id);

            // A edits a note before it knows of the conversion, then syncs
            await a.dev.userEdit("one.md", "one\nedited on A\n");
            await a.dev.userEdit("both.md", "both\nA's line\n");
            await a.dev.userCreate("late.md", "late\n");
            if (restartA) await a.dev.restart();
            t.notices.A.length = 0;
            await t.sync(a.dev);
            expect(a.dev.settings.e2eeEnabled, "A noticed the conversion").toBe(true);
            expect(a.dev.syncErrors, "following the conversion is not a sync error").toEqual([]);
            // The very sync that finds the conversion stops, says why and asks the user
            // (a sync that learns of it from the change feed has announced its start already)
            expect(t.notices.A.filter((k) => k !== "noticeSyncing")).toEqual([addon ? "noticeE2EEAutoEnabled" : "noticeAddonRequired"]);
            expect(t.prompts.A, "asked to install the add-on / enter the password, once").toBe(1);
            // Locked: nothing of A may reach the converted vault
            await t.sync(a.dev);
            expect(t.prompts.A).toBe(1);
            expect(t.notices.A.at(-1)).toBe(addon ? "noticeVaultLocked" : "noticeAddonRequired");
            for (const [p, bytes] of Object.entries(t.vaultFiles())) expect(decryptable(bytes), `before unlock: ${p}`).toBe(true);

            if (!addon) a.install();
            await a.engine.unlockVault("LOCK", PASSWORD);
            for (let i = 0; i < 3; i++) {
                await t.sync(a.dev);
                await t.sync(b.dev);
            }
            await b.dev.userCreate("three.md", "three\n");
            await a.dev.userCreate("four.md", "four\n");
            for (let i = 0; i < 3; i++) {
                await t.sync(b.dev);
                await t.sync(a.dev);
            }
            await t.sync(a.dev, true);
            await t.sync(b.dev, true);

            const failures = t.logs.filter((l) => /decrypt|DecryptionError/i.test(l));
            expect(failures, "no decryption failure on any device").toEqual([]);
            expect(a.dev.syncErrors).toEqual([]);
            expect(b.dev.syncErrors).toEqual([]);
            for (const [p, bytes] of Object.entries(t.vaultFiles())) expect(decryptable(bytes), `after: ${p}`).toBe(true);
            // Conflict copies stay on the device that made them
            const synced = (f: Record<string, string>) =>
                Object.fromEntries(Object.entries(f).filter(([p]) => !p.includes("(Conflict ")));
            const fa = a.dev.userFiles();
            const fb = b.dev.userFiles();
            expect(synced(fa)).toEqual(synced(fb));
            expect(fa["one.md"]).toBe("one\nedited on A\n");
            expect(fa["dir/two.md"], "A was untouched: B's edit arrives without a conflict copy").toBe("two\nedited on B\n");
            expect(fa["three.md"]).toBe("three\n");
            expect(fa["four.md"]).toBe("four\n");
            // Edited on both sides: both lines survive (merged, or one side as a conflict copy)
            const bothTexts = Object.entries({ ...fa, ...fb }).filter(([p]) => p.startsWith("both")).map(([, c]) => c).join("|");
            expect(bothTexts).toContain("A's line");
            expect(bothTexts).toContain("B's line");
            expect(Object.keys(fa).filter((p) => / \(\d+\)\./.test(p)), 'no "(2)" duplicates').toEqual([]);
            expect(Object.keys({ ...fa, ...fb }).filter((p) => !p.startsWith("both")).sort()).toEqual(
                ["dir/two.md", "four.md", "late.md", "one.md", "three.md"],
            );
// Deleted in the converted vault before A followed: the converted vault
            // held it in the version A knows, so it is a deletion, not a new note of A
            expect(fa["gone.md"], "a note deleted in the converted vault does not come back").toBeUndefined();
            expect(Object.keys(t.vaultFiles())).not.toContain("gone.md");
            // Created on A before it knew of the conversion: never part of the
            // converted vault, so it is uploaded, not taken for a deleted note
            expect(fb["late.md"]).toBe("late\n");
        });
    }

    // The quiet triggers skip the lock check while the change feed is empty: the
    // swap must show in the feed, or a device nobody touches would never follow.
    for (const old of ["lock", "deleted"] as const) {
        it(`a timer sync with nothing to do notices the conversion (old folder: ${old})`, async () => {
            const t = await setup();
            const a = await t.make("A");
            const b = await t.make("B");
            await a.dev.userCreate("one.md", "one\n");
            await t.sync(a.dev);
            await t.sync(b.dev);
            await t.sync(a.dev);
            // A's lock check found no lock: from now on its quiet cycles skip it
            await t.sync(a.dev, false, "timer-sync");
            expect(a.dev.settings.e2eeEnabled).toBe(false);

            await t.convert(b.dev);
            if (old === "deleted") await t.remove(t.items().find((i) => i.name.includes("-Backup-"))!.id);
            t.notices.A.length = 0;
            await t.sync(a.dev, false, "timer-sync");

            expect(a.dev.settings.e2eeEnabled, "A noticed the conversion").toBe(true);
            expect(t.notices.A.filter((k) => k !== "noticeSyncing")).toEqual(["noticeE2EEAutoEnabled"]);
            expect(t.prompts.A).toBe(1);
            expect(a.dev.syncErrors).toEqual([]);
            for (const [p, bytes] of Object.entries(t.vaultFiles())) expect(decryptable(bytes), p).toBe(true);
        });
    }

    for (const old of ["lock", "deleted"] as const) {
        it(`a note deleted in the converted vault but edited here meanwhile is kept (old folder: ${old})`, async () => {
            const t = await setup();
            const a = await t.make("A");
            const b = await t.make("B");
            await a.dev.userCreate("gone.md", "gone\n");
            await a.dev.userCreate("stay.md", "stay\n");
            await t.sync(a.dev);
            await t.sync(b.dev);
            await t.sync(a.dev);
            await t.convert(b.dev);
            await b.dev.userDelete("gone.md");
            await t.sync(b.dev);
            if (old === "deleted") await t.remove(t.items().find((i) => i.name.includes("-Backup-"))!.id);

            await a.dev.userEdit("gone.md", "gone\nedited on A after B deleted it\n");
            await t.sync(a.dev);
            await a.engine.unlockVault("LOCK", PASSWORD);
            for (let i = 0; i < 3; i++) {
                await t.sync(a.dev);
                await t.sync(b.dev);
            }

            // The edit wins over the deletion, as between any two devices
            expect(a.dev.userFiles()["gone.md"]).toBe("gone\nedited on A after B deleted it\n");
            expect(b.dev.userFiles()).toEqual(a.dev.userFiles());
            expect(a.dev.syncErrors).toEqual([]);
            expect(b.dev.syncErrors).toEqual([]);
            for (const [p, bytes] of Object.entries(t.vaultFiles())) expect(decryptable(bytes), p).toBe(true);
        });
    }

    it("the password is changed on another device while this one runs unlocked", async () => {
        const t = await setup();
        const a = await t.make("A");
        const b = await t.make("B");
        await a.dev.userCreate("one.md", "one\n");
        await t.sync(a.dev);
        await t.sync(b.dev);
        await t.convert(b.dev);
        await t.sync(a.dev);
        await a.engine.unlockVault("LOCK", PASSWORD);
        await t.sync(a.dev);
        await t.sync(b.dev);
        t.notices.A.length = 0;
        const prompts = t.prompts.A;

        // The lock file is replaced (new password, same key), then B goes on working
        await b.dev.sm.vaultLockService.uploadLockFile("LOCK-2");
        await b.dev.userEdit("one.md", "one\nafter the change\n");
        await t.sync(b.dev);
        await a.dev.userCreate("two.md", "two\n");
        for (let i = 0; i < 2; i++) {
            await t.sync(a.dev);
            await t.sync(b.dev);
        }

        // The key in memory still fits: A keeps syncing, and is not asked again
        expect(t.prompts.A).toBe(prompts);
        expect(t.notices.A.filter((k) => /Locked|AddonRequired|AutoEnabled|Failed/.test(k))).toEqual([]);
        expect(a.dev.syncErrors).toEqual([]);
        expect(a.dev.userFiles()).toEqual({ "one.md": "one\nafter the change\n", "two.md": "two\n" });
        expect(b.dev.userFiles()).toEqual(a.dev.userFiles());
        expect(await b.dev.sm.vaultLockService.downloadLockFile()).toBe("LOCK-2");
        for (const [p, bytes] of Object.entries(t.vaultFiles())) expect(decryptable(bytes), p).toBe(true);
    });

    /**
     * Four devices, each in another state when the vault is converted:
     * B converts, A runs with the add-on, D runs without the add-on, C is closed
     * (it holds edits made offline) and comes back later.
     */
    for (const old of ["kept", "deleted"] as const) {
        it(`four devices in different states follow one conversion (old folder ${old} when the closed device returns)`, async () => {
            const t = await setup();
            const a = await t.make("A");
            const b = await t.make("B");
            const c = await t.make("C");
            const d = await t.make("D", false);
            const all = [a, b, c, d];
            const round = async (devs = all, times = 3) => {
                for (let i = 0; i < times; i++) for (const x of devs) await t.sync(x.dev);
            };
            const encrypted = (when: string) => {
                for (const [p, bytes] of Object.entries(t.vaultFiles())) expect(decryptable(bytes), `${when}: ${p}`).toBe(true);
            };

            await a.dev.userCreate("one.md", "one\n");
            await a.dev.userCreate("dir/two.md", "two\n");
            await a.dev.userCreate("both.md", "both\n");
            await a.dev.userCreate("gone.md", "gone\n");
            await a.dev.userCreate("ren.md", "ren\n");
            await round();
            for (const x of all) expect(Object.keys(x.dev.userFiles()).sort(), x.dev.name).toEqual(["both.md", "dir/two.md", "gone.md", "one.md", "ren.md"]);

            // C is closed from here on; it edits offline
            await c.dev.userEdit("dir/two.md", "two\nedited on C offline\n");
            await c.dev.userCreate("c-offline.md", "made on C offline\n");

            await t.convert(b.dev);
            await b.dev.userEdit("both.md", "both\nB's line\n");
            await b.dev.userDelete("gone.md");
            await b.dev.userRename("ren.md", "renamed.md");
            await t.sync(b.dev);
            encrypted("after the conversion");

            // The two running devices: both stop at their next sync and ask the user
            await a.dev.userEdit("one.md", "one\nedited on A\n");
            await d.dev.userCreate("d.md", "made on D\n");
            t.notices.A.length = 0;
            t.notices.D.length = 0;
            await t.sync(a.dev);
            await t.sync(d.dev);
            expect(t.notices.A.filter((k) => k !== "noticeSyncing")).toEqual(["noticeE2EEAutoEnabled"]);
            expect(t.notices.D.filter((k) => k !== "noticeSyncing")).toEqual(["noticeAddonRequired"]);
            expect([t.prompts.A, t.prompts.D]).toEqual([1, 1]);
            await round([a, d], 2);
            encrypted("while A and D are locked");
            expect(Object.keys(t.vaultFiles())).not.toContain("d.md");

            // A is unlocked first; D still waits for its add-on
            await a.engine.unlockVault("LOCK", PASSWORD);
            await round([a, b, d], 2);
            encrypted("A unlocked, D without add-on");
            expect(b.dev.userFiles()["one.md"]).toBe("one\nedited on A\n");
            expect(d.dev.userFiles()["both.md"], "D takes nothing from the converted vault yet").toBe("both\n");

            // The password is changed while D and C have not followed yet
            await a.dev.sm.vaultLockService.uploadLockFile("LOCK-2");

            // C comes back (the app starts), maybe after the old folder is gone
            if (old === "deleted") await t.remove(t.items().find((i) => i.name.includes("-Backup-"))!.id);
            await c.dev.restart();
            t.notices.C.length = 0;
            await t.sync(c.dev);
            expect(t.notices.C.filter((k) => k !== "noticeSyncing")).toEqual(["noticeE2EEAutoEnabled"]);
            encrypted("C back, locked");
            await c.engine.unlockVault("LOCK-2", PASSWORD);
            d.install();
            await d.engine.unlockVault("LOCK-2", PASSWORD);
            await round();

            // One device is locked again (app restarted without a saved password)
            a.engine.unlocked = false;
            await a.dev.restart();
            await a.dev.userCreate("while-locked.md", "made on A while locked\n");
            t.notices.A.length = 0;
            await t.sync(a.dev);
            expect(t.notices.A).toContain("noticeVaultLocked");
            expect(Object.keys(t.vaultFiles())).not.toContain("while-locked.md");
            await a.engine.unlockVault("LOCK-2", PASSWORD);

            await b.dev.userRename("renamed.md", "dir/renamed-again.md");
            await d.dev.userDelete("c-offline.md");
            await round();
            for (const x of all) await t.sync(x.dev, true);
            await round(all, 2);

            const failures = t.logs.filter((l) => /decrypt|DecryptionError/i.test(l));
            expect(failures, "no decryption failure on any device").toEqual([]);
            for (const x of all) expect(x.dev.syncErrors, x.dev.name).toEqual([]);
            encrypted("at the end");
            const synced = (f: Record<string, string>) =>
                Object.fromEntries(Object.entries(f).filter(([p]) => !p.includes("(Conflict ")));
            const fa = synced(a.dev.userFiles());
            for (const x of [b, c, d]) expect(synced(x.dev.userFiles()), x.dev.name).toEqual(fa);
            expect(fa).toEqual({
                "one.md": "one\nedited on A\n",
                "dir/two.md": "two\nedited on C offline\n",
                "both.md": "both\nB's line\n",
                "dir/renamed-again.md": "ren\n",
                "d.md": "made on D\n",
                "while-locked.md": "made on A while locked\n",
            });
            expect(Object.keys(t.vaultFiles()).filter((p) => / \(\d+\)\./.test(p)), 'no "(2)" files on the cloud').toEqual([]);
        });
    }

    /**
     * A sync another device started before the migration lock existed pushes a
     * new note into the old folder after the converting device has read it. Its
     * own device carries the note over when it follows; the converting device
     * finds it in the old folder once more when it cleans that folder up.
     */
    describe("a note pushed into the old folder too late to be converted", () => {
        const HOUR = 60 * 60 * 1000;
        /**
         * A's sync checked the locks before B created the migration lock and is
         * still sending when B is about to swap the folders: what A changed
         * (by default a new note and an edit) reaches the old folder only.
         */
        async function latePush(change?: (a: SimDevice) => Promise<void>) {
            const t = await setup();
            const a = await t.make("A");
            const b = await t.make("B");
            const c = await t.make("C");
            const all = [a, b, c];
            const round = async (times = 3) => {
                for (let i = 0; i < times; i++) for (const x of all) await t.sync(x.dev);
            };
            await a.dev.userCreate("one.md", "one\n");
            await a.dev.userCreate("two.md", "two\n");
            await round(2);
            if (change) await change(a.dev);
            else {
                await a.dev.userCreate("late.md", "late\n");
                await a.dev.userEdit("one.md", "one\nlate edit on A\n");
            }
            const lock = b.dev.sm.vaultLockService;
            const rename = lock.renameFolder.bind(lock);
            let pushed = false;
            lock.renameFolder = async (id: string, name: string) => {
                if (!pushed) {
                    pushed = true;
                    const aLock = a.dev.sm.vaultLockService;
                    const check = aLock.getMigrationLock.bind(aLock);
                    aLock.getMigrationLock = async () => null;
                    await t.sync(a.dev);
                    aLock.getMigrationLock = check;
                }
                return rename(id, name);
            };
            await t.convert(b.dev);
            expect(Object.keys(t.vaultFiles())).not.toContain("late.md");
            const follow = async (x: (typeof all)[number]) => {
                await t.sync(x.dev);
                await x.engine.unlockVault("LOCK", PASSWORD);
                await t.sync(x.dev);
            };
            /** The grace time is over: B's next sync cleans the old folder up */
            const cleanUp = async () => {
                vi.setSystemTime(Date.now() + 2 * HOUR);
                await t.sync(b.dev);
                expect(t.folderNames().filter((n) => n.includes("-Backup-")), "the old folder is gone").toEqual([]);
                await round();
            };
            const everywhere = () => ({ ...a.dev.userFiles(), ...b.dev.userFiles(), ...c.dev.userFiles() });
            const noErrors = () => {
                for (const x of all) expect(x.dev.syncErrors, x.dev.name).toEqual([]);
                for (const [p, bytes] of Object.entries(t.vaultFiles())) expect(decryptable(bytes), p).toBe(true);
            };
            return { t, a, b, c, round, follow, cleanUp, everywhere, noErrors };
        }

        it("is taken from the old folder when its device never comes back", async () => {
            const s = await latePush();
            await s.follow(s.c);
            await s.cleanUp();
            expect(s.b.dev.userFiles()["late.md"]).toBe("late\n");
            expect(s.c.dev.userFiles()["late.md"]).toBe("late\n");
            expect(decryptable(s.t.vaultFiles()["late.md"])).toBe(true);
        });

        it("stays deleted when it was carried over and deleted in the vault before the cleanup", async () => {
            const s = await latePush();
            await s.follow(s.a);
            await s.follow(s.c);
            await s.round();
            expect(s.c.dev.userFiles()["late.md"], "A carried its note over").toBe("late\n");
            await s.c.dev.userDelete("late.md");
            await s.round();
            expect(Object.keys(s.everywhere())).not.toContain("late.md");
            await s.cleanUp();
            expect(Object.keys(s.everywhere()).sort(), "the deleted note does not come back").toEqual(["one.md", "two.md"]);
            expect(Object.keys(s.t.vaultFiles()).filter((p) => !p.startsWith(".obsidian/")).sort()).toEqual(["one.md", "two.md"]);
            expect(s.b.dev.userFiles()["one.md"]).toBe("one\nlate edit on A\n");
            s.noErrors();
        });

        it("stays deleted when its device was closed between following and sending it again", async () => {
            const s = await latePush(async (a) => a.userCreate("late.md", "late\n"));
            await s.t.sync(s.a.dev);
            await s.a.engine.unlockVault("LOCK", PASSWORD);
            // A follows the conversion, and the app is closed before anything is sent
            const push = s.a.dev.sm.smartPush.bind(s.a.dev.sm);
            s.a.dev.sm.smartPush = async () => {
                throw new Error("app closed");
            };
            await s.a.dev.startSync("manual-sync", false).catch(() => {});
            await vi.advanceTimersByTimeAsync(1000);
            s.a.dev.sm.smartPush = push;
            s.a.dev.syncErrors.length = 0;
            expect(Object.keys(s.t.vaultFiles())).not.toContain("late.md");
            // Meanwhile the cleanup carries the note over, and it is deleted on C
            await s.follow(s.c);
            vi.setSystemTime(Date.now() + 2 * HOUR);
            for (let i = 0; i < 2; i++) for (const x of [s.b, s.c]) await s.t.sync(x.dev);
            expect(s.c.dev.userFiles()["late.md"], "the cleanup carried the note over").toBe("late\n");
            await s.c.dev.userDelete("late.md");
            for (let i = 0; i < 2; i++) for (const x of [s.c, s.b]) await s.t.sync(x.dev);
            // A is opened again
            await s.a.dev.restart();
            await s.a.engine.unlockVault("LOCK", PASSWORD);
            await s.round();
            expect(Object.keys(s.everywhere()).sort(), "the deleted note does not come back").toEqual(["one.md", "two.md"]);
            expect(Object.keys(s.t.vaultFiles()).filter((p) => !p.startsWith(".obsidian/")).sort()).toEqual(["one.md", "two.md"]);
            s.noErrors();
        });

        it("a late edit stays deleted when it was carried over and deleted while its device was closed", async () => {
            const s = await latePush(async (a) => a.userEdit("one.md", "one\nlate edit on A\n"));
            await s.t.sync(s.a.dev);
            await s.a.engine.unlockVault("LOCK", PASSWORD);
            const push = s.a.dev.sm.smartPush.bind(s.a.dev.sm);
            s.a.dev.sm.smartPush = async () => {
                throw new Error("app closed");
            };
            await s.a.dev.startSync("manual-sync", false).catch(() => {});
            await vi.advanceTimersByTimeAsync(1000);
            s.a.dev.sm.smartPush = push;
            s.a.dev.syncErrors.length = 0;
            await s.follow(s.c);
            vi.setSystemTime(Date.now() + 2 * HOUR);
            for (let i = 0; i < 2; i++) for (const x of [s.b, s.c]) await s.t.sync(x.dev);
            expect(s.c.dev.userFiles()["one.md"], "the cleanup carried the edit over").toBe("one\nlate edit on A\n");
            await s.c.dev.userDelete("one.md");
            for (let i = 0; i < 2; i++) for (const x of [s.c, s.b]) await s.t.sync(x.dev);
            await s.a.dev.restart();
            await s.a.engine.unlockVault("LOCK", PASSWORD);
            await s.round();
            expect(Object.keys(s.everywhere()).sort(), "the deleted note does not come back").toEqual(["two.md"]);
            s.noErrors();
        });

        it("an edit made here is still kept when another version of the note was deleted", async () => {
            const s = await latePush();
            for (const x of [s.a, s.c]) await s.follow(x);
            await s.round();
            await s.a.dev.userEdit("two.md", "two\nedited on A\n");
            await s.c.dev.userDelete("two.md");
            await s.t.sync(s.c.dev);
            await s.round();
            expect(s.everywhere()["two.md"], "deleted in the older version only").toBe("two\nedited on A\n");
            s.noErrors();
        });

        it("is sent again after such a stop when nobody deleted it", async () => {
            const s = await latePush(async (a) => a.userCreate("late.md", "late\n"));
            await s.t.sync(s.a.dev);
            await s.a.engine.unlockVault("LOCK", PASSWORD);
            const push = s.a.dev.sm.smartPush.bind(s.a.dev.sm);
            s.a.dev.sm.smartPush = async () => {
                throw new Error("app closed");
            };
            await s.a.dev.startSync("manual-sync", false).catch(() => {});
            await vi.advanceTimersByTimeAsync(1000);
            s.a.dev.sm.smartPush = push;
            s.a.dev.syncErrors.length = 0;
            await s.a.dev.restart();
            await s.a.engine.unlockVault("LOCK", PASSWORD);
            await s.follow(s.c);
            await s.round();
            expect(s.c.dev.userFiles()["late.md"]).toBe("late\n");
            expect(s.b.dev.userFiles()["late.md"]).toBe("late\n");
            s.noErrors();
        });

        it("stays deleted when the converting device never held it", async () => {
            const s = await latePush();
            await s.follow(s.a);
            await s.follow(s.c);
            // B does not sync between the upload and the deletion
            await s.c.dev.userDelete("late.md");
            await s.t.sync(s.c.dev);
            await s.cleanUp();
            expect(Object.keys(s.everywhere()).sort()).toEqual(["one.md", "two.md"]);
            s.noErrors();
        });

        it("stays deleted when its device follows only after the cleanup and the deletion", async () => {
            const s = await latePush();
            await s.follow(s.c);
            // The cleanup brings A's late note into the vault; then it is deleted there
            vi.setSystemTime(Date.now() + 2 * HOUR);
            for (let i = 0; i < 2; i++) for (const x of [s.b, s.c]) await s.t.sync(x.dev);
            expect(s.c.dev.userFiles()["late.md"]).toBe("late\n");
            await s.c.dev.userDelete("late.md");
            for (let i = 0; i < 2; i++) for (const x of [s.c, s.b]) await s.t.sync(x.dev);
            await s.follow(s.a);
            await s.round();
            expect(Object.keys(s.everywhere()).sort()).toEqual(["one.md", "two.md"]);
            s.noErrors();
        });

        it("stays deleted when its device deleted it before following the conversion", async () => {
            const s = await latePush();
            await s.a.dev.userDelete("late.md");
            await s.follow(s.a);
            await s.follow(s.c);
            await s.round();
            await s.cleanUp();
            expect(Object.keys(s.everywhere()).sort()).toEqual(["one.md", "two.md"]);
            s.noErrors();
        });

        it("a late edit of a converted note stays on its device and reaches the others without the cleanup", async () => {
            const s = await latePush();
            expect(new TextDecoder().decode(s.t.vaultFiles()["one.md"])).not.toContain("late edit on A");
            await s.follow(s.a);
            expect(s.a.dev.userFiles()["one.md"], "A's own edit is not replaced by the older converted version").toBe("one\nlate edit on A\n");
            await s.follow(s.c);
            await s.round();
            for (const x of [s.a, s.b, s.c]) expect(x.dev.userFiles()["one.md"], x.dev.name).toBe("one\nlate edit on A\n");
            await s.cleanUp();
            expect(Object.keys(s.everywhere()).sort(), "no conflict copy").toEqual(["late.md", "one.md", "two.md"]);
            s.noErrors();
        });

        it("a late edit and an edit made in the converted vault before its device followed are both kept", async () => {
            const s = await latePush();
            await s.follow(s.c);
            await s.c.dev.userEdit("one.md", "one\nedited on C in the converted vault\n");
            await s.t.sync(s.c.dev);
            await s.follow(s.a);
            await s.round();
            await s.cleanUp();
            const texts = Object.entries(s.everywhere()).filter(([p]) => p.startsWith("one")).map(([, c]) => c).join("|");
            expect(texts).toContain("late edit on A");
            expect(texts).toContain("edited on C in the converted vault");
            for (const x of [s.a, s.b, s.c]) expect(x.dev.userFiles()["one.md"], x.dev.name).toBe(s.a.dev.userFiles()["one.md"]);
            s.noErrors();
        });

        it("a late edit is kept as a copy when the old folder was removed by hand before its device followed", async () => {
            const s = await latePush();
            await s.t.remove(s.t.items().find((i) => i.name.includes("-Backup-"))!.id);
            await s.follow(s.a);
            const onA = s.a.dev.userFiles();
            expect(onA["one.md"], "the vault's version, as nobody can tell which one is newer").toBe("one\n");
            const copies = Object.entries(onA).filter(([p]) => p.startsWith("one (Conflict "));
            expect(copies.map(([, c]) => c), "the content A held is not lost").toEqual(["one\nlate edit on A\n"]);
            expect(onA["late.md"]).toBe("late\n");
            s.noErrors();
        });

        const lateDelete = (dev: SimDevice) => dev.userDelete("two.md").then(() => {});
        const lateRename = (dev: SimDevice) => dev.userRename("two.md", "dir/moved.md").then(() => {});

        it("a late deletion is carried over by its device at once", async () => {
            const s = await latePush(lateDelete);
            expect(Object.keys(s.t.vaultFiles()), "converted although A had deleted it").toContain("two.md");
            await s.follow(s.a);
            expect(Object.keys(s.a.dev.userFiles())).toEqual(["one.md"]);
            await s.follow(s.c);
            await s.round();
            expect(Object.keys(s.everywhere())).toEqual(["one.md"]);
            await s.cleanUp();
            expect(Object.keys(s.everywhere())).toEqual(["one.md"]);
            s.noErrors();
        });

        it("a late deletion is carried over after a restart of its device, too", async () => {
            const s = await latePush(lateDelete);
            await s.a.dev.restart();
            await s.follow(s.a);
            await s.follow(s.c);
            await s.round();
            expect(Object.keys(s.everywhere())).toEqual(["one.md"]);
            s.noErrors();
        });

        it("a late deletion whose device never comes back is carried out by the cleanup", async () => {
            const s = await latePush(lateDelete);
            await s.follow(s.c);
            expect(s.c.dev.userFiles()["two.md"]).toBe("two\n");
            await s.cleanUp();
            expect(Object.keys({ ...s.b.dev.userFiles(), ...s.c.dev.userFiles() })).toEqual(["one.md"]);
        });

        it("a late deletion does not touch a note edited in the vault since", async () => {
            const s = await latePush(lateDelete);
            await s.follow(s.c);
            await s.c.dev.userEdit("two.md", "two\nedited on C after the conversion\n");
            await s.t.sync(s.c.dev);
            await s.follow(s.a);
            await s.round();
            await s.cleanUp();
            for (const x of [s.a, s.b, s.c]) expect(x.dev.userFiles()["two.md"], x.dev.name).toBe("two\nedited on C after the conversion\n");
            s.noErrors();
        });

        it("a late rename ends as a rename, not as a copy", async () => {
            const s = await latePush(lateRename);
            await s.follow(s.a);
            await s.follow(s.c);
            await s.round();
            await s.cleanUp();
            for (const x of [s.a, s.b, s.c]) expect(x.dev.userFiles(), x.dev.name).toEqual({ "one.md": "one\n", "dir/moved.md": "two\n" });
            s.noErrors();
        });

        it("a late rename whose device never comes back leaves the note under its old name", async () => {
            const s = await latePush(lateRename);
            await s.follow(s.c);
            await s.cleanUp();
            for (const x of [s.b, s.c]) expect(x.dev.userFiles(), x.dev.name).toEqual({ "one.md": "one\n", "two.md": "two\n" });
        });

        it("a note kept under its old name after a late rename is not deleted by the cleanup", async () => {
            const s = await latePush(lateRename);
            await s.follow(s.a);
            await s.follow(s.c);
            await s.round();
            // The user finds the note under both names and removes the new one
            const files = s.c.dev.userFiles();
            if (files["two.md"] !== undefined && files["dir/moved.md"] !== undefined) {
                await s.c.dev.userDelete("dir/moved.md");
                await s.round();
            }
            await s.cleanUp();
            expect(Object.values(s.everywhere()), "the note's content is somewhere").toContain("two\n");
            s.noErrors();
        });

        it("keeps an edit made to it in the vault before the cleanup", async () => {
            const s = await latePush();
            await s.follow(s.a);
            await s.follow(s.c);
            await s.round();
            await s.c.dev.userEdit("late.md", "late\nedited on C\n");
            await s.round();
            await s.cleanUp();
            for (const x of [s.a, s.b, s.c]) expect(x.dev.userFiles()["late.md"], x.dev.name).toBe("late\nedited on C\n");
            s.noErrors();
        });
    });

    /**
     * A device that was behind when the vault was converted: the note it pushed
     * last was edited on another device before the conversion. The conversion
     * never read this device's version either, but here the vault's is the newer.
     */
    for (const old of ["kept", "cleaned up"] as const) {
        it(`a device that was behind takes the converted version without a copy (old folder ${old})`, async () => {
            const t = await setup();
            const a = await t.make("A");
            const b = await t.make("B");
            await a.dev.userCreate("one.md", "one\n");
            await t.sync(a.dev);
            await t.sync(b.dev);
            await b.dev.userEdit("one.md", "one\nedited on B before the conversion\n");
            await t.sync(b.dev);
            await t.convert(b.dev);
            if (old === "cleaned up") {
                vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
                await t.sync(b.dev);
                expect(t.folderNames().filter((n) => n.includes("-Backup-"))).toEqual([]);
            }
            await t.sync(a.dev);
            await a.engine.unlockVault("LOCK", PASSWORD);
            for (let i = 0; i < 2; i++) for (const x of [a, b]) await t.sync(x.dev);
            expect(a.dev.userFiles()).toEqual({ "one.md": "one\nedited on B before the conversion\n" });
            expect(b.dev.userFiles()).toEqual(a.dev.userFiles());
            expect(a.dev.syncErrors).toEqual([]);
        });
    }

    /** Renames made on a device before it follows the conversion */
    describe("a note renamed here before this device followed the conversion", () => {
        async function renamed(edit: "none" | "here" | "there") {
            const t = await setup();
            const a = await t.make("A");
            const b = await t.make("B");
            await a.dev.userCreate("one.md", "one\n");
            await a.dev.userCreate("keep.md", "keep\n");
            for (let i = 0; i < 2; i++) for (const x of [a, b]) await t.sync(x.dev);
            await t.convert(b.dev);
            if (edit === "there") {
                await b.dev.userEdit("one.md", "one\nedited on B\n");
                await t.sync(b.dev);
            }
            await a.dev.userRename("one.md", "dir/moved.md");
            if (edit === "here") await a.dev.userEdit("dir/moved.md", "one\nedited on A\n");
            await t.sync(a.dev);
            await a.engine.unlockVault("LOCK", PASSWORD);
            for (let i = 0; i < 3; i++) for (const x of [a, b]) await t.sync(x.dev);
            for (const x of [a, b]) await t.sync(x.dev, true);
            for (let i = 0; i < 2; i++) for (const x of [a, b]) await t.sync(x.dev);
            expect(a.dev.syncErrors).toEqual([]);
            expect(b.dev.syncErrors).toEqual([]);
            for (const [p, bytes] of Object.entries(t.vaultFiles())) expect(decryptable(bytes), p).toBe(true);
            expect(b.dev.userFiles()).toEqual(a.dev.userFiles());
            return a.dev.userFiles();
        }

        it("is renamed in the converted vault, not copied", async () => {
            expect(await renamed("none")).toEqual({ "dir/moved.md": "one\n", "keep.md": "keep\n" });
        });

        it("keeps the edit made here with the rename", async () => {
            expect(await renamed("here")).toEqual({ "dir/moved.md": "one\nedited on A\n", "keep.md": "keep\n" });
        });

        it("keeps the edit made in the converted vault meanwhile", async () => {
            expect(await renamed("there")).toEqual({ "dir/moved.md": "one\nedited on B\n", "keep.md": "keep\n" });
        });
    });

    /** Two devices start to convert the same vault */
    describe("two devices start the conversion at the same time", () => {
        async function twoConverters() {
            const t = await setup();
            const a = await t.make("A");
            const b = await t.make("B");
            await a.dev.userCreate("one.md", "one\n");
            await a.dev.userCreate("dir/two.md", "two\n");
            for (let i = 0; i < 2; i++) for (const x of [a, b]) await t.sync(x.dev);
            const start = async (x: typeof a, seesOthers: boolean) => {
                const lock = x.dev.sm.vaultLockService;
                const list = lock.listMigrationLocks.bind(lock);
                // The cloud's listing can lag: the other device's lock is not in it yet
                const get = lock.getMigrationLock.bind(lock);
                if (!seesOthers) {
                    lock.listMigrationLocks = async () => (await list()).filter((l) => l.deviceId === x.dev.sm.deviceId);
                    lock.getMigrationLock = async () => null;
                }
                try {
                    return await x.dev.sm.migrationService.startMigration(PASSWORD);
                } finally {
                    lock.listMigrationLocks = list;
                    lock.getMigrationLock = get;
                }
            };
            const finish = async (x: typeof a, temp: CloudAdapter) => {
                await x.dev.sm.migrationService.runMigration(temp, () => {});
                await x.dev.sm.migrationService.finalizeMigration(temp);
                x.dev.settings.e2eeEnabled = true;
            };
            const settle = async (winner: typeof a, loser: typeof a) => {
                expect(loser.dev.sm.syncState).toBe("IDLE");
                expect(loser.dev.sm.migrationService.isMigrating).toBe(false);
                expect(t.folderNames().filter((n) => n.includes("Temp-Encrypted")), "no temporary folder left").toEqual([]);
                expect(t.folderNames().filter((n) => n === "ContractVault")).toHaveLength(1);
                expect(t.folderNames().filter((n) => n.includes("-Backup-"))).toHaveLength(1);
                // The device that gave up follows the conversion like any other device
                await t.sync(loser.dev);
                expect(loser.dev.settings.e2eeEnabled).toBe(true);
                await loser.engine.unlockVault("LOCK", PASSWORD);
                await loser.dev.userCreate("after.md", "after\n");
                for (let i = 0; i < 3; i++) for (const x of [loser, winner]) await t.sync(x.dev);
                expect(winner.dev.userFiles()).toEqual({ "one.md": "one\n", "dir/two.md": "two\n", "after.md": "after\n" });
                expect(loser.dev.userFiles()).toEqual(winner.dev.userFiles());
                expect(winner.dev.syncErrors).toEqual([]);
                expect(loser.dev.syncErrors).toEqual([]);
                for (const [p, bytes] of Object.entries(t.vaultFiles())) expect(decryptable(bytes), p).toBe(true);
                expect(Object.keys(t.vaultFiles()).filter((p) => / \(\d+\)\./.test(p))).toEqual([]);
            };
            return { t, a, b, start, finish, settle };
        }

        it("the second device is refused when it sees the first one's lock", async () => {
            const s = await twoConverters();
            const tempA = (await s.start(s.a, true)) as CloudAdapter;
            await vi.advanceTimersByTimeAsync(10);
            await expect(s.start(s.b, true)).rejects.toThrow(/Another device/);
            expect(s.b.dev.sm.syncState).toBe("IDLE");
            await s.finish(s.a, tempA);
            await s.settle(s.a, s.b);
        });

        it("the device with the later lock gives up before the swap when it finishes first", async () => {
            const s = await twoConverters();
            const tempA = (await s.start(s.a, true)) as CloudAdapter;
            await vi.advanceTimersByTimeAsync(10);
            const tempB = (await s.start(s.b, false)) as CloudAdapter;
            await expect(s.finish(s.b, tempB)).rejects.toThrow(/Migration stopped/);
            await s.finish(s.a, tempA);
            await s.settle(s.a, s.b);
        });

        it("the device with the later lock gives up when the other one has swapped already", async () => {
            const s = await twoConverters();
            const tempA = (await s.start(s.a, true)) as CloudAdapter;
            await vi.advanceTimersByTimeAsync(10);
            const tempB = (await s.start(s.b, false)) as CloudAdapter;
            await s.finish(s.a, tempA);
            await expect(s.finish(s.b, tempB)).rejects.toThrow(/Migration stopped/);
            await s.settle(s.a, s.b);
        });

        it("the device with the earlier lock goes on although the other one never saw its lock", async () => {
            const s = await twoConverters();
            const tempA = (await s.start(s.a, true)) as CloudAdapter;
            await vi.advanceTimersByTimeAsync(10);
            const tempB = (await s.start(s.b, false)) as CloudAdapter;
            // Both upload; each into its own temporary folder
            await s.a.dev.sm.migrationService.runMigration(tempA, () => {});
            await s.b.dev.sm.migrationService.runMigration(tempB, () => {});
            await expect(s.b.dev.sm.migrationService.finalizeMigration(tempB)).rejects.toThrow(/Migration stopped/);
            await s.a.dev.sm.migrationService.finalizeMigration(tempA);
            s.a.dev.settings.e2eeEnabled = true;
            await s.settle(s.a, s.b);
        });
    });

    /** The app of the converting device stops during the conversion */
    describe("the converting device is closed during the conversion", () => {
        const HOUR = 60 * 60 * 1000;
        type Stage = "upload" | "before-swap" | "between-renames" | "after-swap";
        async function killed(stage: Stage, other: "runs" | "restarts" | "away" = "runs") {
            const t = await setup();
            const a = await t.make("A");
            const b = await t.make("B");
            await a.dev.userCreate("one.md", "one\n");
            await a.dev.userCreate("dir/two.md", "two\n");
            for (let i = 0; i < 2; i++) for (const x of [a, b]) await t.sync(x.dev);

            const svc = b.dev.sm.migrationService;
            const temp = (await svc.startMigration(PASSWORD)) as CloudAdapter;
            await svc.runMigration(temp, () => {});
            if (stage !== "upload") {
                // The app dies inside a step: that step never returns
                const never = new Promise<never>(() => {});
                const lock = b.dev.sm.vaultLockService;
                const rename = lock.renameFolder.bind(lock);
                let renames = 0;
                let reached!: () => void;
                const dead = new Promise<void>((r) => (reached = r));
                lock.renameFolder = async (id: string, name: string) => {
                    renames++;
                    if ((stage === "before-swap" && renames === 1) || (stage === "between-renames" && renames === 2)) {
                        reached();
                        return never;
                    }
                    return rename(id, name);
                };
                if (stage === "after-swap") {
                    b.dev.sm.baseAdapter.reset = () => {
                        reached();
                        throw new Error("app closed");
                    };
                }
                void svc.finalizeMigration(temp).catch(() => {});
                expect(await drive(dead, 600_000)).toBe("ok");
            }
            // The other device works on meanwhile
            await a.dev.userEdit("one.md", "one\nedited on A meanwhile\n");
            t.notices.A.length = 0;
            if (other === "restarts") await a.dev.restart();
            if (other !== "away") await t.sync(a.dev);
            expect(t.folderNames().filter((n) => n === "ContractVault").length, "no second vault folder").toBeLessThan(2);
            await b.dev.restart();
            return { t, a, b };
        }
        const finishTogether = async (s: Awaited<ReturnType<typeof killed>>, converted: boolean) => {
            const { t, a, b } = s;
            await t.sync(b.dev);
            if (converted) {
                expect(b.dev.settings.e2eeEnabled, "B follows its own conversion").toBe(true);
                await b.engine.unlockVault("LOCK", PASSWORD);
                await t.sync(a.dev);
                await a.engine.unlockVault("LOCK", PASSWORD);
            } else {
                expect(t.folderNames().filter((n) => n !== "ContractVault" && !n.startsWith(".vault-syncer-trash")), "nothing of the run is left").toEqual([]);
                expect(t.items().filter((i) => i.name === "migration.lock")).toEqual([]);
            }
            await b.dev.userCreate("after.md", "after\n");
            for (let i = 0; i < 3; i++) for (const x of [a, b]) await t.sync(x.dev);
            for (const x of [a, b]) await t.sync(x.dev, true);
            const want = { "one.md": "one\nedited on A meanwhile\n", "dir/two.md": "two\n", "after.md": "after\n" };
            expect(a.dev.userFiles()).toEqual(want);
            expect(b.dev.userFiles()).toEqual(want);
            expect(a.dev.syncErrors).toEqual([]);
            expect(b.dev.syncErrors).toEqual([]);
            expect(t.folderNames().filter((n) => n === "ContractVault")).toHaveLength(1);
            expect(t.folderNames().filter((n) => n.includes("Temp-Encrypted"))).toEqual([]);
            expect(Object.keys(t.vaultFiles()).filter((p) => / \(\d+\)\./.test(p))).toEqual([]);
            if (converted) {
                for (const [p, bytes] of Object.entries(t.vaultFiles())) expect(decryptable(bytes), p).toBe(true);
                vi.setSystemTime(Date.now() + 2 * HOUR);
                for (let i = 0; i < 2; i++) for (const x of [b, a]) await t.sync(x.dev);
                expect(t.folderNames().filter((n) => n.includes("-Backup-")), "the old folder is cleaned up").toEqual([]);
                expect(a.dev.userFiles()).toEqual(want);
                expect(b.dev.userFiles()).toEqual(want);
            } else {
                // The vault is as it was, and can be converted afterwards
                await t.convert(b.dev);
                await t.sync(a.dev);
                await a.engine.unlockVault("LOCK", PASSWORD);
                for (let i = 0; i < 2; i++) for (const x of [a, b]) await t.sync(x.dev);
                expect(a.dev.userFiles()).toEqual(want);
                for (const [p, bytes] of Object.entries(t.vaultFiles())) expect(decryptable(bytes), p).toBe(true);
            }
        };

        it("during the upload: the other device waits, the run is given up at the next start", async () => {
            const s = await killed("upload");
            expect(s.t.notices.A).toContain("noticeVaultConverting");
            await finishTogether(s, false);
        });

        it("right before the folders are swapped: the run is given up at the next start", async () => {
            const s = await killed("before-swap");
            await finishTogether(s, false);
        });

        it("between the two renames: the swap is completed at the next start", async () => {
            const s = await killed("between-renames");
            await finishTogether(s, true);
        });

        for (const other of ["restarts", "away"] as const) {
            it(`between the two renames, the other device ${other}: no empty vault folder takes the name`, async () => {
                const s = await killed("between-renames", other);
                if (other === "restarts") expect(s.t.notices.A).toContain("noticeVaultConverting");
                await finishTogether(s, true);
            });
        }

        it("between the two renames: a device new to the vault waits, too", async () => {
            const s = await killed("between-renames", "away");
            // (B is restarted, but has not synced yet: the vault's name is still free)
            const c = await s.t.make("C");
            await s.t.sync(c.dev);
            expect(s.t.notices.C).toContain("noticeVaultConverting");
            expect(s.t.folderNames().filter((n) => n === "ContractVault")).toEqual([]);
            await finishTogether(s, true);
            await s.t.sync(c.dev);
            await c.engine.unlockVault("LOCK", PASSWORD);
            for (let i = 0; i < 2; i++) await s.t.sync(c.dev);
            expect(c.dev.userFiles()).toEqual(s.a.dev.userFiles());
        });

        it("right after the swap: the converting device follows its own conversion", async () => {
            const s = await killed("after-swap");
            await finishTogether(s, true);
        });
    });

    /** Someone renames or deletes the vault's folder on the cloud by hand */
    describe("the vault folder is renamed or deleted by hand on the cloud", () => {
        for (const converted of [false, true]) {
            for (const change of ["renamed", "deleted"] as const) {
                for (const restartB of [false, true]) {
                    const title = `${converted ? "converted" : "plain"} vault, folder ${change}, the second device ${restartB ? "restarts" : "keeps running"}`;
                    it(title, async () => {
                        const t = await setup();
                        const a = await t.make("A");
                        const b = await t.make("B");
                        await a.dev.userCreate("one.md", "one\n");
                        await a.dev.userCreate("dir/two.md", "two\n");
                        for (let i = 0; i < 2; i++) for (const x of [a, b]) await t.sync(x.dev);
                        if (converted) {
                            await t.convert(b.dev);
                            await t.sync(a.dev);
                            // (the unlock dialog reads the vault-lock from the cloud)
                            await a.engine.unlockVault(await a.dev.sm.vaultLockService.downloadLockFile(), PASSWORD);
                            for (let i = 0; i < 2; i++) for (const x of [a, b]) await t.sync(x.dev);
                            // The old folder is checked and deleted
                            vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
                            for (let i = 0; i < 2; i++) for (const x of [b, a]) await t.sync(x.dev);
                        }
                        const folder = t.items().find((i) => i.name === "ContractVault" && i.mimeType.endsWith("folder"))!;
                        const other = driveAdapterOnFakeServer(t.server).adapter;
                        if (change === "renamed") await other.moveFile(folder.id, "Kept by hand", null, "outside");
                        else await t.remove(folder.id);

                        await a.dev.userEdit("one.md", "one\nedited on A\n");
                        await b.dev.userCreate("new.md", "new on B\n");
                        if (restartB) await b.dev.restart();
                        if (restartB && converted) await b.engine.unlockVault("LOCK", PASSWORD);
                        for (let i = 0; i < 4; i++) for (const x of [a, b]) await t.sync(x.dev);
                        for (const x of [a, b]) await t.sync(x.dev, true);
                        for (let i = 0; i < 2; i++) for (const x of [a, b]) await t.sync(x.dev);

                        const want = { "one.md": "one\nedited on A\n", "dir/two.md": "two\n", "new.md": "new on B\n" };
                        expect(a.dev.userFiles()).toEqual(want);
                        expect(b.dev.userFiles()).toEqual(want);
                        expect(a.dev.syncErrors).toEqual([]);
                        expect(b.dev.syncErrors).toEqual([]);
                        expect(t.folderNames().filter((n) => n === "ContractVault")).toHaveLength(1);
                        // Everything is in the folder that carries the vault's name
                        expect(Object.keys(t.vaultFiles()).filter((p) => !p.startsWith(".obsidian/")).sort()).toEqual(Object.keys(want).sort());
                        if (converted) {
                            for (const [p, bytes] of Object.entries(t.vaultFiles())) expect(decryptable(bytes), p).toBe(true);
                            const lock = t.items().filter((i) => t.pathOf(i).startsWith("ContractRoot/ContractVault/") && i.name === "vault-lock.vault");
                            expect(lock, "the rebuilt folder says that it is converted").toHaveLength(1);
                        }
                    });
                }
            }
        }
    });

    /** The converting device leaves some files out of its own sync */
    describe("files the converting device leaves out by its own settings", () => {
        it("a late edit of such a file is brought over by the cleanup when its device never comes back", async () => {
            const t = await setup();
            const a = await t.make("A");
            const b = await t.make("B");
            b.dev.settings.exclusionPatterns = "private/**";
            await a.dev.userCreate("one.md", "one\n");
            await a.dev.userCreate("private/secret.md", "secret\n");
            for (let i = 0; i < 2; i++) for (const x of [a, b]) await t.sync(x.dev);
            await a.dev.userEdit("private/secret.md", "secret\nlate edit on A\n");
            await a.dev.userCreate("private/new.md", "new\n");
            const lock = b.dev.sm.vaultLockService;
            const rename = lock.renameFolder.bind(lock);
            let pushed = false;
            lock.renameFolder = async (id: string, name: string) => {
                if (!pushed) {
                    pushed = true;
                    const aLock = a.dev.sm.vaultLockService;
                    const check = aLock.getMigrationLock.bind(aLock);
                    aLock.getMigrationLock = async () => null;
                    await t.sync(a.dev);
                    aLock.getMigrationLock = check;
                }
                return rename(id, name);
            };
            await t.convert(b.dev);
            vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
            for (let i = 0; i < 2; i++) await t.sync(b.dev);
            expect(t.folderNames().filter((n) => n.includes("-Backup-"))).toEqual([]);
            const c = await t.make("C");
            await t.sync(c.dev);
            await c.engine.unlockVault("LOCK", PASSWORD);
            for (let i = 0; i < 3; i++) for (const x of [c, b]) await t.sync(x.dev);
            expect(c.dev.userFiles()).toEqual({
                "one.md": "one\n",
                "private/secret.md": "secret\nlate edit on A\n",
                "private/new.md": "new\n",
            });
            expect(Object.keys(b.dev.userFiles())).toEqual(["one.md"]);
            expect(b.dev.syncErrors).toEqual([]);
            expect(c.dev.syncErrors).toEqual([]);
            for (const [p, bytes] of Object.entries(t.vaultFiles())) expect(decryptable(bytes), p).toBe(true);
        });

        for (const holder of ["stays", "never comes back"] as const) {
            it(`are in the converted vault all the same (the device that holds them ${holder})`, async () => {
                const t = await setup();
                const a = await t.make("A");
                const b = await t.make("B");
                b.dev.settings.exclusionPatterns = "private/**";
                await a.dev.userCreate("one.md", "one\n");
                await a.dev.userCreate("private/secret.md", "secret\n");
                for (let i = 0; i < 2; i++) for (const x of [a, b]) await t.sync(x.dev);
                expect(Object.keys(b.dev.userFiles())).toEqual(["one.md"]);

                await t.convert(b.dev);
                expect(decryptable(t.vaultFiles()["private/secret.md"]), "converted without being held here").toBe(true);
                expect(Object.keys(b.dev.userFiles()), "still left out on the converting device").toEqual(["one.md"]);
                await t.sync(b.dev);
                if (holder === "stays") {
                    await t.sync(a.dev);
                    await a.engine.unlockVault("LOCK", PASSWORD);
                    for (let i = 0; i < 2; i++) for (const x of [a, b]) await t.sync(x.dev);
                    expect(a.dev.userFiles()).toEqual({ "one.md": "one\n", "private/secret.md": "secret\n" });
                    expect(a.dev.syncErrors).toEqual([]);
                }
                // The old folder is checked and deleted
                vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
                for (let i = 0; i < 2; i++) await t.sync(b.dev);
                expect(t.folderNames().filter((n) => n.includes("-Backup-"))).toEqual([]);
                // A device new to the vault gets everything
                const c = await t.make("C");
                await t.sync(c.dev);
                await c.engine.unlockVault("LOCK", PASSWORD);
                for (let i = 0; i < 3; i++) for (const x of [c, b]) await t.sync(x.dev);
                expect(c.dev.userFiles()).toEqual({ "one.md": "one\n", "private/secret.md": "secret\n" });
                expect(Object.keys(b.dev.userFiles())).toEqual(["one.md"]);
                expect(b.dev.syncErrors).toEqual([]);
                expect(c.dev.syncErrors).toEqual([]);
                expect(Object.keys(t.vaultFiles()).filter((p) => / \(\d+\)\./.test(p))).toEqual([]);
                for (const [p, bytes] of Object.entries(t.vaultFiles())) expect(decryptable(bytes), p).toBe(true);
            });
        }
    });
});
