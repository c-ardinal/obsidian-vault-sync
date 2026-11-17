/**
 * Add-ons Vault-Sync is willing to install.
 *
 * An add-on is distributed separately as a zip package (see addon-package.ts).
 * Vault-Sync never downloads it: the user downloads the package and picks it.
 * Every file in the package is pinned by SHA-256 here, so a package is only
 * accepted if it is byte-for-byte the reviewed release. Updating an add-on
 * (code, version or terms) therefore needs a matching Vault-Sync release:
 * copy the hashes printed by the add-on's `npm run build`.
 *
 * Display text for an add-on (name, description, terms) lives inside its
 * package, not here.
 */
export interface ApprovedAddon {
    /** Must equal `id` in the package's addon.json. */
    id: string;
    /** How Vault-Sync activates the entry file. */
    kind: "crypto-engine";
    /** Where the entry file is saved, relative to the plugin folder. */
    installAs: string;
    /** Page where users download the package themselves. */
    downloadUrl: string;
    /** SHA-256 (hex) of every file the package must contain, by file name. */
    files: Record<string, string>;
}

export const APPROVED_ADDONS: ApprovedAddon[] = [
    {
        id: "vault-sync-e2ee-engine",
        kind: "crypto-engine",
        installAs: "e2ee-engine.js",
        downloadUrl: "https://github.com/c-ardinal/obsidian-vault-sync-e2ee-engine/releases/latest",
        files: {
            "addon.json": "d2821788664657982ca9bc99a0b743238c5f4687003517071fcfd210c86866c4",
            "e2ee-engine.js": "e2b6e3758b768d4dbc2fe896e5830c3cec5bf8d8fd786992f35737661190fa06",
            "TERMS.md": "4b8eb81c12094b937a2899718d646f8e0bdd75e060ea391030d5e622fadfb48f",
            "TERMS_ja.md": "bc19f75e5cc41907b0e23246fb2ba4f337074a13a745ebcb629197013bd73956",
        },
    },
];
