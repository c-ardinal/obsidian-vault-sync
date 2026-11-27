/**
 * main.ts sets the plugin and config folders from Obsidian on load; the tests
 * use the default config folder name and the plugin's first ID.
 */
import { PLUGIN_IDS, setPluginDir } from "../src/sync-manager/file-utils";

setPluginDir(`.obsidian/plugins/${PLUGIN_IDS[0]}`, ".obsidian");
