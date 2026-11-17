import { normalizePath } from "obsidian";
import type { DataAdapter } from "obsidian";
import { LEGACY_PLUGIN_ID } from "../sync-manager/file-utils";

/**
 * The plugin was renamed from `obsidian-vault-sync` to its community-directory ID
 * (IDs may not contain "obsidian"), so Obsidian installs it into a new folder.
 * This carries a device's state over from the old folder, once.
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
}

export function legacyPluginDir(configDir: string): string {
    return normalizePath(`${configDir}/plugins/${LEGACY_PLUGIN_ID}`);
}

/**
 * Copies settings (data.json), sync state (data/) and installed add-ons from the
 * old plugin folder into `pluginDir`, when the old folder has them and `pluginDir`
 * has no sync state yet. Files that already exist in `pluginDir` are never
 * overwritten, and the old folder is left as it is. Returns null when there was
 * nothing to do.
 */
export async function migrateLegacyPluginData(
    adapter: DataAdapter,
    configDir: string,
    pluginDir: string,
): Promise<LegacyMigrationResult | null> {
    const from = legacyPluginDir(configDir);
    const to = normalizePath(pluginDir);
    if (from === to) return null;
    if (!(await adapter.exists(from))) return null;
    if (await adapter.exists(`${to}/${LOCAL_INDEX}`)) return null;
    const hasState =
        (await adapter.exists(`${from}/data`)) || (await adapter.exists(`${from}/data.json`));
    if (!hasState) return null;

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
    return { copied };
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
 * Whether the old copy of the plugin (old ID) is installed and enabled. Both
 * copies syncing the same vault at once would fight over it.
 */
export function isLegacyCopyEnabled(app: unknown): boolean {
    const registry = (app as { plugins?: PluginRegistry }).plugins;
    if (!registry) return false;
    return (
        !!registry.enabledPlugins?.has(LEGACY_PLUGIN_ID) && !!registry.manifests?.[LEGACY_PLUGIN_ID]
    );
}
