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
    /**
     * SHA-256 of the entry file from earlier approved releases. Such a file is
     * still refused, but the user is told to update instead of being warned
     * about a failed check. When you pin a new release, move the old entry
     * hash here.
     */
    retiredEntryHashes?: string[];
}

export const APPROVED_ADDONS: ApprovedAddon[] = [
    {
        id: "vault-sync-e2ee-engine",
        kind: "crypto-engine",
        installAs: "e2ee-engine.js",
        downloadUrl: "https://github.com/c-ardinal/obsidian-vault-sync-e2ee-engine/releases/latest",
        files: {
            "addon.json": "bfc59e3b451dcedb5973d1f4c9ed437fdba0784637daf3448b83fa5201f5d706",
            "e2ee-engine.js": "9b0c2d618892f80921261b774f9fd88de0c26df9ed17ea82a4225d7429aca83d",
            "TERMS.md": "12b4525dd2a3dcde2758470c53f74cd8d65ff71c74ffd8a2351ee039191ecf14",
            "TERMS_ja.md": "ba7a50d0d9e4ee0c0a3696683c33dc8a4f316a39ba51909a87f20e1528114f36",
        },
        retiredEntryHashes: [
            // 0.18.0
            "115c3307aee64b9c903495dbc6187864c7ef7ff3d5565f5c8ba803bc0382f588",
            // 0.17.1
            "9874a1b6356ec367715b233868cf3f294bd9eb4168fba19a63ae7715022a461e",
            // 0.17.0
            "fc3525012589fee6fca63fe06219b6baddcfdc6bb83a0c35b2dc9af7d285e23c",
            // 0.16.0
            "e2b6e3758b768d4dbc2fe896e5830c3cec5bf8d8fd786992f35737661190fa06",
            // earlier releases
            "0d24c256338beeb31c9aad1dd674bc4559e12caa5f2ba31f85896b5cfe107310",
            "ab485f5f80f1b0e8226b9d59ab571463b97e7a326b36eed2b68fc904093fc71b",
            "b4744eb21b7a33e879acb9b26b2db62894911fc869a892c4961912aebb6e083c",
            "b59efbdf2574d545ff359e3598c157969d1ea57e4be3c0138645f3388f0a7cd0",
            "c08b6d879f5a729dc7eefbdb7425d545b2526332c29ae82d3e86e1ef08f71b32",
            "ceb308f41e3660254de0a678059b41ca877fee457a244e13a214bd6305c2b965",
            "e8bea90180efdbc5f109510c3ce4f64cbcbcf459375ab20bd669ee63b68dd1f8",
            "f62d9a9d2f82ffa1672c091fdf1d82fc171dca2c532491ce2e8b8322c6bed815",
        ],
    },
];
