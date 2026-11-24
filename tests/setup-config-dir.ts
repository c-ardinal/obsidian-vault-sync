/**
 * main.ts sets the plugin and config folders from Obsidian on load; the tests
 * use the default config folder name and the plugin's pre-release ID.
 */
import { LEGACY_PLUGIN_ID, setPluginDir } from "../src/sync-manager/file-utils";

setPluginDir(`.obsidian/plugins/${LEGACY_PLUGIN_ID}`, ".obsidian");
