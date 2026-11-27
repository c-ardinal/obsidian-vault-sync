/**
 * main.ts sets the plugin and config folders from Obsidian on load; the tests
 * use the default config folder name and the plugin's ID.
 */
import { setPluginDir } from "../src/sync-manager/file-utils";

setPluginDir(`.obsidian/plugins/cardinal-vault-syncer`, ".obsidian");
