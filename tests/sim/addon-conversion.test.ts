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
                ["dir/two.md", "four.md", "gone.md", "one.md", "three.md"],
            );
            // Deleted in the converted vault before A followed. A cannot tell that from a
            // note it pushed into the old folder too late to be converted, so the note
            // is kept (it comes back) rather than deleted on a guess.
            expect(fa["gone.md"]).toBe("gone\n");
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
});
