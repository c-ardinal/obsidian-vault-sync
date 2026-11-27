import { normalizePath } from "obsidian";
import type { DataAdapter } from "obsidian";
import { LEGACY_PLUGIN_DIRS } from "../sync-manager/file-utils";

/**
 * The plugin's ID has changed (see PLUGIN_IDS), and Obsidian installs each ID into
 * a folder of its own. This carries a device's state over from the folder of an
 * earlier ID, once.
 */

/** Files of the old install that belong to the old copy of the plugin itself. */
const PLUGIN_FILES = new Set(["main.js", "manifest.json", "styles.css"]);
/** Folders not worth copying: logs and the revision cache are rebuilt as needed. */
const SKIPPED_DIRS = new Set(["logs", "cache"]);

/** Marker that the device has sync state in a plugin folder. */
const LOCAL_INDEX = "data/local/local-index.json";

export interface LegacyMigrationResult {
    /** Number of files copied from the old folder. */
    copied: number;
    /** The plugin ID the state was carried over from. */
    fromId: string;
}

const idOf = (dir: string) => dir.replace(/\/$/, "").split("/").pop() ?? dir;

/**
 * Copies settings (data.json), sync state (data/) and installed add-ons from the
 * folder of an earlier plugin ID into `pluginDir`, when `pluginDir` has no sync
 * state yet. Of the earlier folders that hold state, the one of the newest ID is
 * used (a device moves from ID to ID in order, so that one is the most recent).
 * Files that already exist in `pluginDir` are never overwritten, and the old
 * folder is left as it is. Returns null when there was nothing to do.
 */
export async function migrateLegacyPluginData(
    adapter: DataAdapter,
    pluginDir: string,
): Promise<LegacyMigrationResult | null> {
    const to = normalizePath(pluginDir);
    if (await adapter.exists(`${to}/${LOCAL_INDEX}`)) return null;
    let from: string | null = null;
    for (const dir of [...LEGACY_PLUGIN_DIRS].reverse()) {
        const candidate = dir.replace(/\/$/, "");
        if (candidate === to || !(await adapter.exists(candidate))) continue;
        if ((await adapter.exists(`${candidate}/data`)) || (await adapter.exists(`${candidate}/data.json`))) {
            from = candidate;
            break;
        }
    }
    if (from === null) return null;

    let copied = 0;
    const copyDir = async (dir: string, top: boolean): Promise<void> => {
        const listing = await adapter.list(dir);
        for (const file of listing.files) {
            const name = file.substring(file.lastIndexOf("/") + 1);
            if (top && PLUGIN_FILES.has(name)) continue;
            const target = to + file.substring(from.length);
            if (await adapter.exists(target)) continue;
            await ensureFolder(adapter, target.substring(0, target.lastIndexOf("/")));
            await adapter.writeBinary(target, await adapter.readBinary(file));
            copied++;
        }
        for (const sub of listing.folders) {
            const name = sub.substring(sub.lastIndexOf("/") + 1);
            if (top && SKIPPED_DIRS.has(name)) continue;
            await copyDir(sub, false);
        }
    };
    await copyDir(from, true);
    return { copied, fromId: idOf(from) };
}

async function ensureFolder(adapter: DataAdapter, dir: string): Promise<void> {
    const parts = dir.split("/");
    let path = "";
    for (const part of parts) {
        path = path ? `${path}/${part}` : part;
        if (!(await adapter.exists(path))) {
            try {
                await adapter.mkdir(path);
            } catch {
                // created concurrently
            }
        }
    }
}

/** Minimal view of Obsidian's (internal) plugin registry. */
interface PluginRegistry {
    enabledPlugins?: Set<string>;
    manifests?: Record<string, unknown>;
}

/**
 * The ID of an old copy of the plugin (an earlier ID) that is installed and
 * enabled, or null. Both copies syncing the same vault at once would fight over it.
 */
export function enabledLegacyCopyId(app: unknown): string | null {
    const registry = (app as { plugins?: PluginRegistry }).plugins;
    if (!registry) return null;
    for (const id of LEGACY_PLUGIN_DIRS.map(idOf).reverse()) {
        if (registry.enabledPlugins?.has(id) && registry.manifests?.[id]) return id;
    }
    return null;
}
