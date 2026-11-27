/**
 * @file Plugin ID changes (obsidian-vault-sync → cardinal-vault-sync → cardinal-vault-syncer)
 *
 * @description
 * Community-directory IDs may not contain "obsidian", and the plugin was later
 * renamed Vault Syncer: each time it moved to a new folder. Checks that:
 * - setPluginDir follows the manifest's folder and the vault's config folder
 * - the folders of earlier IDs are left alone by the sync loop while devices are mixed
 * - the vault-lock is found at any of the paths (newest wins) and written to all
 * - a device's settings, sync state and add-ons are copied once from the folder of
 *   the most recent earlier ID, without overwriting anything and without copying
 *   the old plugin's own files
 * - an old copy is detected only when it is installed and enabled
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import {
    PLUGIN_DIR,
    LEGACY_PLUGIN_DIRS,
    isManagedSeparately,
    setPluginDir,
} from "../../../src/sync-manager/file-utils";
import { VaultLockService, vaultLockPath } from "../../../src/services/vault-lock-service";
import {
    enabledLegacyCopyId,
    migrateLegacyPluginData,
} from "../../../src/services/legacy-plugin-migration";
import type { CloudAdapter, CloudFile } from "../../../src/types/adapter";

const OLD = ".obsidian/plugins/obsidian-vault-sync";
const MID = ".obsidian/plugins/cardinal-vault-sync";
const NEW = ".obsidian/plugins/cardinal-vault-syncer";
const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
const dec = (b: ArrayBuffer) => new TextDecoder().decode(b);

afterEach(() => setPluginDir(OLD, ".obsidian")); // back to the test default

describe("setPluginDir", () => {
    it("uses the manifest folder and marks the folders of earlier IDs as legacy", () => {
        setPluginDir(NEW, ".obsidian");
        expect(PLUGIN_DIR).toBe(`${NEW}/`);
        expect(LEGACY_PLUGIN_DIRS).toEqual([`${OLD}/`, `${MID}/`]);
    });

    it("follows a custom config folder", () => {
        setPluginDir(".config/plugins/cardinal-vault-syncer", ".config");
        expect(PLUGIN_DIR).toBe(".config/plugins/cardinal-vault-syncer/");
        expect(LEGACY_PLUGIN_DIRS).toEqual([
            ".config/plugins/obsidian-vault-sync/",
            ".config/plugins/cardinal-vault-sync/",
        ]);
        expect(
            isManagedSeparately(".config/plugins/cardinal-vault-syncer/data/remote/sync-index.json"),
        ).toBe(true);
    });

    it("has no legacy folder when still installed under the first ID", () => {
        setPluginDir(OLD, ".obsidian");
        expect(LEGACY_PLUGIN_DIRS).toEqual([]);
        expect(isManagedSeparately(`${OLD}/main.js`)).toBe(false);
    });

    it("an install under an earlier ID only counts the IDs before its own", () => {
        setPluginDir(MID, ".obsidian");
        expect(LEGACY_PLUGIN_DIRS).toEqual([`${OLD}/`]);
        expect(isManagedSeparately(`${NEW}/main.js`)).toBe(false);
    });

    it("a folder with a name of its own counts every earlier ID", () => {
        setPluginDir(".obsidian/plugins/my-build", ".obsidian");
        expect(LEGACY_PLUGIN_DIRS).toEqual([`${OLD}/`, `${MID}/`]);
    });

    it("the sync loop leaves the old folders alone, and still syncs the new one as before", () => {
        setPluginDir(NEW, ".obsidian");
        expect(isManagedSeparately(`${OLD}/data/remote/sync-index.json`)).toBe(true);
        expect(isManagedSeparately(`${OLD}/main.js`)).toBe(true);
        expect(isManagedSeparately(`${MID}/data/remote/sync-index.json`)).toBe(true);
        expect(isManagedSeparately(`${MID}/main.js`)).toBe(true);
        expect(isManagedSeparately(`${NEW}/data/remote/sync-index.json`)).toBe(true);
        expect(isManagedSeparately(`${NEW}/data/remote/vault-lock.vault`)).toBe(true);
        expect(isManagedSeparately(`${NEW}/main.js`)).toBe(false);
        expect(isManagedSeparately("notes/a.md")).toBe(false);
    });
});

function cloud(): CloudAdapter & {
    files: Map<string, { id: string; content: ArrayBuffer; mtime: number }>;
} {
    const files = new Map<string, { id: string; content: ArrayBuffer; mtime: number }>();
    let n = 0;
    return {
        files,
        getFileMetadata: async (path: string) => {
            const f = files.get(path);
            return f
                ? ({
                      id: f.id,
                      path,
                      mtime: f.mtime,
                      size: f.content.byteLength,
                      kind: "file",
                  } as CloudFile)
                : null;
        },
        downloadFile: async (id: string) => {
            for (const f of files.values()) if (f.id === id) return f.content.slice(0);
            throw new Error("not found");
        },
        uploadFile: async (path: string, content: ArrayBuffer, mtime: number, id?: string) => {
            const fileId = id ?? `f${++n}`;
            files.set(path, { id: fileId, content, mtime });
            return { id: fileId, path, mtime, size: content.byteLength, kind: "file" } as CloudFile;
        },
    } as unknown as CloudAdapter & {
        files: Map<string, { id: string; content: ArrayBuffer; mtime: number }>;
    };
}

describe("vault-lock across the ID changes", () => {
    const OLD_LOCK = `${OLD}/data/remote/vault-lock.vault`;
    const MID_LOCK = `${MID}/data/remote/vault-lock.vault`;
    const NEW_LOCK = `${NEW}/data/remote/vault-lock.vault`;

    it("finds a lock written by a device still on the old ID", async () => {
        setPluginDir(NEW, ".obsidian");
        const c = cloud();
        c.files.set(OLD_LOCK, { id: "old", content: enc("old-blob"), mtime: 1 });
        const svc = new VaultLockService(c);
        expect(await svc.checkForLockFile()).toBe(true);
        expect(await svc.downloadLockFile()).toBe("old-blob");
    });

    it("finds a lock written by a device on the ID before this one", async () => {
        setPluginDir(NEW, ".obsidian");
        const c = cloud();
        c.files.set(OLD_LOCK, { id: "old", content: enc("old-blob"), mtime: 1 });
        c.files.set(MID_LOCK, { id: "mid", content: enc("mid-blob"), mtime: 5 });
        expect(await new VaultLockService(c).downloadLockFile()).toBe("mid-blob");
    });

    it("uses the newer lock when both exist", async () => {
        setPluginDir(NEW, ".obsidian");
        const c = cloud();
        c.files.set(NEW_LOCK, { id: "n", content: enc("new-blob"), mtime: 10 });
        c.files.set(OLD_LOCK, { id: "o", content: enc("changed-on-old-device"), mtime: 20 });
        expect(await new VaultLockService(c).downloadLockFile()).toBe("changed-on-old-device");
        c.files.set(NEW_LOCK, { id: "n", content: enc("new-blob"), mtime: 30 });
        expect(await new VaultLockService(c).downloadLockFile()).toBe("new-blob");
    });

    it("writes the lock to every path, so old devices see it too", async () => {
        setPluginDir(NEW, ".obsidian");
        const c = cloud();
        await new VaultLockService(c).uploadLockFile("blob");
        expect(vaultLockPath()).toBe(NEW_LOCK);
        expect(dec(c.files.get(NEW_LOCK)!.content)).toBe("blob");
        expect(dec(c.files.get(MID_LOCK)!.content)).toBe("blob");
        expect(dec(c.files.get(OLD_LOCK)!.content)).toBe("blob");
    });

    it("writes only one lock when the ID did not change", async () => {
        setPluginDir(OLD, ".obsidian");
        const c = cloud();
        await new VaultLockService(c).uploadLockFile("blob");
        expect([...c.files.keys()]).toEqual([OLD_LOCK]);
    });
});

function localDisk(initial: Record<string, string>) {
    const files = new Map(Object.entries(initial).map(([k, v]) => [k, enc(v)]));
    const folders = new Set<string>();
    const addParents = (p: string) => {
        const parts = p.split("/");
        for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join("/"));
    };
    for (const p of files.keys()) addParents(p);
    const adapter = {
        exists: async (p: string) => files.has(p) || folders.has(p),
        list: async (dir: string) => {
            const direct = (p: string) =>
                p.startsWith(dir + "/") && !p.slice(dir.length + 1).includes("/");
            return {
                files: [...files.keys()].filter(direct),
                folders: [...folders].filter(direct),
            };
        },
        readBinary: async (p: string) => files.get(p)!.slice(0),
        writeBinary: async (p: string, d: ArrayBuffer) => {
            files.set(p, d);
            addParents(p);
        },
        mkdir: async (p: string) => {
            folders.add(p);
            addParents(p);
        },
    };
    return { files, adapter: adapter as any };
}

describe("migrateLegacyPluginData", () => {
    beforeEach(() => setPluginDir(NEW, ".obsidian"));

    const oldInstall = {
        [`${OLD}/main.js`]: "old code",
        [`${OLD}/manifest.json`]: "{}",
        [`${OLD}/styles.css`]: "",
        [`${OLD}/e2ee-engine.js`]: "engine",
        [`${OLD}/data/local/local-index.json`]: "local index",
        [`${OLD}/data/local/.sync-state`]: "creds",
        [`${OLD}/data/remote/sync-index.json`]: "remote index",
        [`${OLD}/data/flexible/open-data.json`]: "settings",
        [`${OLD}/logs/dev/2026-11-17.log`]: "log",
        [`${OLD}/cache/x`]: "cache",
        [`${NEW}/main.js`]: "new code",
        [`${NEW}/manifest.json`]: "{}",
    };

    it("copies settings, sync state and add-ons, but not the old plugin's files, logs or cache", async () => {
        const { files, adapter } = localDisk(oldInstall);
        const result = await migrateLegacyPluginData(adapter, NEW);
        expect(result).toEqual({ copied: 5, fromId: "obsidian-vault-sync" });
        expect(dec(files.get(`${NEW}/main.js`)!)).toBe("new code");
        expect(dec(files.get(`${NEW}/e2ee-engine.js`)!)).toBe("engine");
        expect(dec(files.get(`${NEW}/data/local/local-index.json`)!)).toBe("local index");
        expect(dec(files.get(`${NEW}/data/local/.sync-state`)!)).toBe("creds");
        expect(dec(files.get(`${NEW}/data/remote/sync-index.json`)!)).toBe("remote index");
        expect(dec(files.get(`${NEW}/data/flexible/open-data.json`)!)).toBe("settings");
        expect(files.has(`${NEW}/logs/dev/2026-11-17.log`)).toBe(false);
        expect(files.has(`${NEW}/cache/x`)).toBe(false);
        expect(files.has(`${OLD}/data/local/local-index.json`)).toBe(true); // old folder untouched
    });

    it("runs once: not again when the new folder already has sync state", async () => {
        const { adapter } = localDisk(oldInstall);
        await migrateLegacyPluginData(adapter, NEW);
        expect(await migrateLegacyPluginData(adapter, NEW)).toBeNull();
    });

    it("never overwrites a file the new folder already has", async () => {
        const { files, adapter } = localDisk({
            ...oldInstall,
            [`${NEW}/data/flexible/open-data.json`]: "new settings",
        });
        await migrateLegacyPluginData(adapter, NEW);
        expect(dec(files.get(`${NEW}/data/flexible/open-data.json`)!)).toBe("new settings");
    });

    it("does nothing without an old folder, or when the ID did not change", async () => {
        const fresh = localDisk({ [`${NEW}/main.js`]: "new code" });
        expect(await migrateLegacyPluginData(fresh.adapter, NEW)).toBeNull();
        const same = localDisk(oldInstall);
        setPluginDir(OLD, ".obsidian");
        expect(await migrateLegacyPluginData(same.adapter, OLD)).toBeNull();
    });

    it("takes the state of the most recent earlier ID when two old folders hold state", async () => {
        const { files, adapter } = localDisk({
            ...oldInstall,
            [`${MID}/main.js`]: "previous code",
            [`${MID}/data/local/local-index.json`]: "newer local index",
            [`${MID}/data/flexible/open-data.json`]: "newer settings",
        });
        const result = await migrateLegacyPluginData(adapter, NEW);
        expect(result).toEqual({ copied: 2, fromId: "cardinal-vault-sync" });
        expect(dec(files.get(`${NEW}/data/local/local-index.json`)!)).toBe("newer local index");
        expect(dec(files.get(`${NEW}/data/flexible/open-data.json`)!)).toBe("newer settings");
        expect(dec(files.get(`${NEW}/main.js`)!)).toBe("new code");
        // Nothing of the older folder is mixed in
        expect(files.has(`${NEW}/data/local/.sync-state`)).toBe(false);
    });

    it("skips an earlier folder without state (the plugin files alone) for an older one with state", async () => {
        const { adapter } = localDisk({ ...oldInstall, [`${MID}/main.js`]: "previous code" });
        expect((await migrateLegacyPluginData(adapter, NEW))?.fromId).toBe("obsidian-vault-sync");
    });
});

describe("enabledLegacyCopyId", () => {
    beforeEach(() => setPluginDir(NEW, ".obsidian"));

    const app = (enabled: string[], installed: string[]) => ({
        plugins: {
            enabledPlugins: new Set(enabled),
            manifests: Object.fromEntries(installed.map((id) => [id, {}])),
        },
    });

    it("names an old copy only when it is installed and enabled", () => {
        expect(enabledLegacyCopyId(app(["obsidian-vault-sync"], ["obsidian-vault-sync"]))).toBe("obsidian-vault-sync");
        expect(enabledLegacyCopyId(app(["cardinal-vault-sync"], ["cardinal-vault-sync"]))).toBe("cardinal-vault-sync");
        expect(enabledLegacyCopyId(app([], ["cardinal-vault-sync"]))).toBeNull();
        // listed as enabled (e.g. a synced community-plugins.json) but not installed
        expect(enabledLegacyCopyId(app(["cardinal-vault-sync"], []))).toBeNull();
        expect(enabledLegacyCopyId({})).toBeNull();
    });

    it("does not count this copy itself", () => {
        expect(enabledLegacyCopyId(app(["cardinal-vault-syncer"], ["cardinal-vault-syncer"]))).toBeNull();
    });
});
