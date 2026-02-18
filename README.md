# VaultSync (Obsidian Cloud Sync)

[ [🇺🇸 English](README.md) | [🇯🇵 日本語](README_ja.md) ]

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub Release](https://img.shields.io/github/v/release/c-ardinal/obsidian-vault-sync?label=Release&logo=github)](https://github.com/c-ardinal/obsidian-vault-sync/releases)
[![CI Status](https://img.shields.io/github/actions/workflow/status/c-ardinal/obsidian-vault-sync/test.yml?branch=main&label=CI&logo=github-actions)](https://github.com/c-ardinal/obsidian-vault-sync/actions/workflows/test.yml)
[![Platform: Windows | MacOS | Linux](https://img.shields.io/badge/Platform-Windows%20%7C%20MacOS%20%7C%20Linux-lightgrey)](#)

A high-speed, intelligent cloud storage sync plugin for Obsidian.  
Leveraging Google Drive, it provides robust data consistency and a fast synchronization experience across PC and mobile devices (iOS/Android).

---

## ⚙️ Requirements

- **Obsidian**: v0.15.0 or higher
- **Google Account**: Required to access the Google Drive API
- **Network**: Internet connection (required during sync)

---

## ✨ Key Features

- **Intelligent Sync (Index Shortcut)**: Shares a master index on the cloud. Skips the full scan if no changes are detected, saving battery and data usage.
- **Fast Difference Detection (MD5 Adoption)**: Even without an existing index, it matches file MD5 hashes. If they match, the local file is adopted instantly without a redundant download.
- **Smart Merge (3-way Merge)**: When multiple devices edit a file simultaneously, it performs an automatic merge based on a common ancestor. During conflicts, it is safely protected by lock control (`communication.json`).
- **Revision History & Diff Viewer**: Retrieves file revisions from Google Drive, allowing for diff visualization against the local version and restoration of past versions.
- **Mobile Optimized**: Built on the `fetch` API to run on both desktop and mobile. Features include auto-sync on edit-stop or save, and layout change triggers (e.g., when switching tabs).
- **Granular Sync Settings**: Selectively sync settings, plugins, themes, and hotkeys within `.obsidian`. Cache and temporary files are automatically excluded.
- **Secure Authentication & Storage**: OAuth2 authentication using PKCE. Credentials are separated from the main settings and saved using system-standard secure storage (Keychain/Credential Manager).
- **End-to-End Encryption (E2EE)**: Optional client-side encryption for your vault data. When enabled with the [E2EE Engine](https://github.com/c-ardinal/obsidian-vault-sync-e2ee-engine), all files are encrypted locally before upload and decrypted after download — your cloud provider never sees plaintext content.

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

## 🔧 Sync Engine Specifications

- **Conflict Resolution**: In addition to 3-way Merge, you can choose from "Smart Merge", "Force Local", "Force Remote", or "Always Fork" strategies. If a conflict cannot be resolved automatically, the local file is backed up as `(Conflict YYYY-MM-DDTHH-mm-ss)`.
- **Selective Sync**: You can control the synchronization of files within `.obsidian/` (plugins, themes, hotkeys, etc.) by category. Device-specific data like `workspace.json` and `cache/` are automatically excluded.
- **Device Communication**: Performs merge lock control between devices via `communication.json` to prevent overwriting when the same file is edited simultaneously.
- **Atomic Updates**: Updates individual index entries upon each file transfer. The index is Gzip-compressed for efficient synchronization.

---

## 🔒 Privacy and Security

- **Direct Communication**: This plugin communicates directly with the Google Drive API without going through any third-party servers.
- **Auth Protection**: Sensitive information such as Client IDs, tokens, and encryption secrets are stored directly in the OS-standard secure storage (Keychain/Credential Manager) via Obsidian's Secret Storage API. This minimizes the presence of sensitive files within the Vault. In environments where Secret Storage is unavailable, the plugin automatically falls back to local file storage encrypted with a device-specific key (AES-GCM) to maintain high security.
- **Data Location**: Your synced data is stored exclusively in your own Google Drive storage (in the root folder you specify).
- **Important**: By default, synced data (Markdown files, etc.) is uploaded to Google Drive in **plain text (without encryption)**. While protected by Google Drive's security model (HTTPS transfer, server-side encryption), the data is readable on the server side. If you require End-to-End Encryption, please install the [VaultSync E2EE Engine](https://github.com/c-ardinal/obsidian-vault-sync-e2ee-engine) — see the section below for details.

---

## 🔐 End-to-End Encryption (E2EE)

VaultSync supports optional End-to-End Encryption through a separate, open-source encryption engine.

When E2EE is enabled:

- All files are **encrypted on your device before upload** using AES-256-GCM
- Files are **decrypted locally after download** — your cloud provider never sees plaintext
- A `vault-lock.vault` file protects the master key (derived via PBKDF2 from your password)
- Smart sync features (3-way merge, conflict detection) work seamlessly with encrypted data
- Password can be optionally stored in OS-level secure storage for auto-unlock
- Enables password changes without re-encrypting data
- Exports the master key as a Base64 string, enabling **recovery code generation** for password loss recovery
- Reduces peak memory for files above the configurable threshold with **streaming encryption for large files**

### Setup

For details, available commands, build instructions, and the encryption specification, see the **[VaultSync E2EE Engine repository](https://github.com/c-ardinal/obsidian-vault-sync-e2ee-engine)**.

---

## 🚀 Setup Instructions

To use this plugin, you must create a Google Cloud Project and obtain your own **Client ID / Client Secret**. Obtaining it is free.

### 1. Create a Google Cloud Project

1. Access the [Google Cloud Console](https://console.cloud.google.com/).
2. Create a new project.
3. Search for **Google Drive API** in "APIs & Services" > "Library" and click "Enable".

### 2. Configure OAuth Consent Screen

1. **Create OAuth Consent Screen**:
    1. Go to "APIs & Services" > "OAuth Consent Screen" > "Summary" and click "Get Started" (or "Configure").
    2. Enter the required app information. Select "External" for User Type.
    3. Once completed, click "Create".
2. **Add Scopes**: 1. Under "Data access", select "Add or remove scopes". 2. Check `.../auth/drive.file` (See, edit, create, and delete only the specific Google Drive files you use with this app). 3. Click "Update". 4. Click "Save" at the bottom.
3. ~~**Auth Period Persistence**: ※ If left in "Testing" state, re-authentication is required every 7 days.~~
    1. ~~Go to "Summary" and click "Publish App".~~
    2. ~~Click "Confirm".~~  
       ※ Publishing the app without following proper procedures may trigger a warning from Google. These instructions are currently under review.

### 3. Create Credentials (Client ID / Secret)

1. Go to "APIs & Services" > "Credentials" > "Create Credentials" > "OAuth Client ID".
2. Select **"Web Application"** as the Application type.
3. Under "Authorized redirect URIs", click "Add URI".
4. Enter `https://c-ardinal.github.io/obsidian-vault-sync/callback/`.
    - This is a relay page used to return to Obsidian after authentication. The process happens entirely within your browser, and no data is sent to external servers.
    - You may also use your own self-hosted redirect URI if preferred.
5. Click "Create".
6. Copy the generated **Client ID** and **Client Secret**.
    - **Important**: The Client Secret is confidential. Never share it with others.

### 4. Apply to Plugin

1. Open Obsidian Settings > "VaultSync".
2. Enter the Client ID and Client Secret, then click the "Login" button.
3. A browser will open, and the Google login screen will appear.
4. After successful login, you will be automatically redirected back to Obsidian. Completion is confirmed when the success notification appears.
    - If you are not automatically redirected, please click the "Open Obsidian" button on the browser screen.
    - If it still doesn't return, please manually switch back to the Obsidian app.

---

## 🛠 Development and Build

For running in a development environment or building from source:

### Build

```bash
npm run build
```

The build results are output to the `dist/obsidian-vault-sync/` directory as follows.  
When distributing, copy the contents of this folder to your plugins directory.

- `main.js`
- `manifest.json`
- `styles.css`

---

## ⚠️ Disclaimer

While this plugin automates synchronization, it does not completely eliminate the risk of data loss due to network errors or unforeseen conflicts.
**The author shall not be held liable for any damages (including data loss or corruption of the Vault) arising from the use of this plugin.**
Please ensure you have a full backup before installing this plugin and continue to maintain regular backups thereafter.

---

## ❓ FAQ

**Q: The sync icon keeps spinning and doesn't stop.**  
A: You might be performing an initial sync with many files, or your network might be unstable.  
Check the notification messages or enable logging in the settings for details.

**Q: I want to exclude specific folders or files from syncing.**  
A: Add glob patterns to the "Exclusion patterns" in the settings.  
For example, adding `secret/**` will exclude the `secret` folder and all files within it from synchronization.

**Q: On the mobile version, I'm not redirected back to the app after authentication.**  
A: Browser security settings may prevent automatic redirection.  
Once the authentication completion screen appears, please manually switch back to the Obsidian app.  
If authentication still doesn't complete, please try the "Manual Auth Mode" in the settings.

## License

MIT License
