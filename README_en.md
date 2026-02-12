# VaultSync (Obsidian Cloud Sync)

[日本語 (Japanese)](./README.md) / [English](./README_en.md)

A high-speed, intelligent cloud storage sync plugin for Obsidian.  
Leveraging Google Drive, it provides robust data consistency and a fast synchronization experience across PC and mobile devices (iOS/Android).

---

## ✨ Key Features

- **Intelligent Sync (Index Shortcut)**: Shares a master index on the cloud. Skips the full scan if no changes are detected, saving battery and data usage.
- **Fast Difference Detection (MD5 Adoption)**: Even without an existing index, it matches file MD5 hashes. If they match, the local file is adopted instantly without a redundant download.
- **Smart Merge (3-way Merge)**: When multiple devices edit a file simultaneously, it performs an automatic merge based on a common ancestor. During conflicts, it is safely protected by lock control (`communication.json`).
- **Revision History & Diff View**: Retrieves file revisions from Google Drive, allowing for diff visualization against the local version and restoration of past versions.
- **Mobile Optimized**: Built on the `fetch` API to run on both desktop and mobile. Features include auto-sync on edit-stop or save, and layout change triggers (e.g., when switching tabs).
- **Granular Sync Settings**: Selectively sync settings, plugins, themes, and hotkeys within `.obsidian`. Cache and temporary files are automatically excluded.
- **Secure Authentication & Storage**: OAuth2 authentication using PKCE. Credentials are separated from the main settings and saved using system-standard secure storage (Keychain/Credential Manager).

---

## ⚙️ Requirements

- **Obsidian**: v0.15.0 or higher
- **Google Account**: Required to access the Google Drive API
- **Network**: Internet connection (required during sync)

---

## 🚀 Setup Instructions

To use this plugin, you must create a Google Cloud Project and obtain your own **Client ID / Client Secret**.

### 1. Create a Google Cloud Project

1. Access the [Google Cloud Console](https://console.cloud.google.com/).
2. Create a new project.
3. Search for **Google Drive API** in "APIs & Services" > "Library" and click "Enable".

### 2. Configure OAuth Consent Screen

1. Go to "APIs & Services" > "OAuth Consent Screen" > "Summary" and click "Get Started" (or "Configure").
2. Enter the required app information. Select "External" for User Type.
3. Once completed, click "Create".
4. **Add Scopes**: Add `.../auth/drive` (See, edit, create, and delete all your Google Drive files).
    - _Note: This is required for global Vault discovery and folder cleanup._
5. **Add Test Users**: Under "Test users", click "Add users" and enter your own Google email address.

### 3. Create Credentials (Client ID / Secret)

1. Go to "APIs & Services" > "Credentials" > "Create Credentials" > "OAuth 2.0 Client ID".
2. Select **"Desktop App"** as the Application type.
    - _Note: This type is recommended for both PC and mobile use._
3. Copy the generated **Client ID** and **Client Secret**.

### 4. Apply to Plugin

1. Open Obsidian Settings > "VaultSync".
2. Enter the Client ID and Client Secret, then click the "Authorize" button.
3. **Completing Authentication**:
    - **PC**: A browser will open, and authentication will complete automatically.
    - **Mobile**:
        1. After authenticating in the browser, you will see a "Site cannot be reached (localhost)" error page.
        2. **Copy the entire URL** of that error page.
        3. Return to Obsidian, paste the URL into the "Manual Auth" (or "Paste Code") field in the settings, and click "Verify and Login".

---

## 📖 Usage

### Running Synchronization

- **Ribbon Icon**: Click the sync icon in the left toolbar to start a Smart Sync.
- **Command Palette**: Press `Ctrl+P` (or `Cmd+P`) and search for `VaultSync: Sync with Cloud`.
- **Auto-Sync**: Depending on your settings, sync will trigger on file save, when you stop editing, or at fixed intervals.

### History and Restoration

- **File History**: Right-click a file and select "View History in Cloud (VaultSync)" to see diffs against past revisions.
- **Advanced Diff Viewer**: Provides powerful comparison tools including Unified/Split view toggle, inline character-level highlighting, jump navigation between changes (with looping), and adjustable context lines.
- **Full Scan**: If you are concerned about consistency, run `VaultSync: Audit & Fix Consistency (Full Scan)` from the command palette to perform a forced sync check.

---

## 🔒 Privacy and Security

- **Direct Communication**: This plugin communicates directly with the Google Drive API without going through any third-party servers.
- **Auth Protection**: Sensitive information such as Client IDs, tokens, and encryption secrets are stored directly in the OS-standard secure storage (Keychain/Credential Manager) via Obsidian's Secret Storage API. This minimizes the presence of sensitive files within the Vault. In environments where Secret Storage is unavailable, the plugin automatically falls back to local file storage encrypted with a device-specific key (AES-GCM) to maintain high security.
- **Data Location**: Your synced data is stored exclusively in your own Google Drive storage (in the root folder you specify).
- **Important**: Note data (Markdown files, etc.) is uploaded to Google Drive in **plain text (without encryption)**. While protected by Google Drive's security model (HTTPS transfer, server-side encryption), this plugin does NOT provide End-to-End Encryption (E2EE). Please be cautious when handling highly sensitive information.

---

## 🔧 Sync Engine Specifications

- **Conflict Resolution**: In addition to 3-way Merge, you can choose from "Smart Merge", "Force Local", "Force Remote", or "Always Fork" strategies. If a conflict cannot be resolved automatically, the local file is backed up as `(Conflict YYYY-MM-DDTHH-mm-ss)`.
- **Selective Sync**: You can control the synchronization of files within `.obsidian/` (plugins, themes, hotkeys, etc.) by category. Device-specific data like `workspace.json` and `cache/` are automatically excluded.
- **Device Communication**: Performs merge lock control between devices via `communication.json` to prevent overwriting when the same file is edited simultaneously.
- **Atomic Updates**: Updates individual index entries upon each file transfer. The index is Gzip-compressed for efficient synchronization.

---

## 🛠 Development and Build

For running in a development environment or building from source:

### Build

```bash
npm run build
```

The build results are output to the `dist/obsidian-vault-sync/` directory as follows. When distributing, copy the contents of this folder to your plugins directory.

- `main.js`
- `manifest.json`
- `styles.css`

---

## ❓ FAQ

**Q: The sync icon keeps spinning and doesn't stop.**  
A: You might be performing an initial sync with many files, or your network might be unstable. Check the notification messages or enable logging in the settings for details.

**Q: I get an error page when accessing "localhost" after authenticating on mobile.**  
A: This is expected mobile browser behavior. Copy the entire URL of that error page and paste it into the "Manual Auth" field in Obsidian's settings.

**Q: I want to exclude specific folders or files from syncing.**  
A: Add glob patterns (e.g., `secret/**`) to the "Exclusion patterns" in the settings.

---

## ⚠️ Disclaimer

While this plugin automates synchronization, it does not completely eliminate the risk of data loss due to network errors or unforeseen conflicts.
**The author shall not be held liable for any damages (including data loss or corruption of the Vault) arising from the use of this plugin.**
Please ensure you have a full backup before installing this plugin and continue to maintain regular backups thereafter.

---

## License

MIT License
