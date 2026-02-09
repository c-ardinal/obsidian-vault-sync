# 設定仕様

**親ドキュメント**: [仕様書](../specification.md)

---

## 1. 設定一覧

### 1.1 同期トリガー

| 設定キー                   | 型      | デフォルト | 範囲    | 説明                           |
| :------------------------- | :------ | :--------- | :------ | :----------------------------- |
| `enableStartupSync`        | boolean | `true`     | -       | 起動時に自動同期               |
| `enableAutoSyncInInterval` | boolean | `true`     | -       | 定期的な自動同期               |
| `autoSyncIntervalSec`      | number  | `1800`     | 1-86400 | 自動同期間隔（秒）             |
| `onSaveDelaySec`           | number  | `0`        | 0-60    | Ctrl+S保存後の遅延（秒）       |
| `onModifyDelaySec`         | number  | `5`        | 0-60    | ファイル編集後のDebounce（秒） |
| `onLayoutChangeDelaySec`   | number  | `0`        | 0-60    | ファイル切替後の遅延（秒）     |

### 1.2 パフォーマンス

| 設定キー      | 型     | デフォルト | 範囲 | 説明                            |
| :------------ | :----- | :--------- | :--- | :------------------------------ |
| `concurrency` | number | `5`        | 1-10 | 並列アップロード/ダウンロード数 |

### 1.3 通知

| 設定キー            | 型   | デフォルト   | 説明                                                                 |
| :------------------ | :--- | :----------- | :------------------------------------------------------------------- |
| `notificationLevel` | enum | `"standard"` | `"verbose"`: 全通知 / `"standard"`: 重要のみ / `"error"`: エラーのみ |

### 1.4 競合解決

| 設定キー                     | 型   | デフォルト      | 説明                                                                   |
| :--------------------------- | :--- | :-------------- | :--------------------------------------------------------------------- |
| `conflictResolutionStrategy` | enum | `"smart-merge"` | `"smart-merge"` / `"force-local"` / `"force-remote"` / `"always-fork"` |

### 1.5 同期スコープ

| 設定キー               | 型      | デフォルト | 対象                                            |
| :--------------------- | :------ | :--------- | :---------------------------------------------- |
| `syncAppearance`       | boolean | `true`     | `.obsidian/themes/`, `snippets/`                |
| `syncCommunityPlugins` | boolean | `true`     | `.obsidian/plugins/`（本プラグイン除く）        |
| `syncCoreConfig`       | boolean | `true`     | `app.json`, `hotkeys.json`, `core-plugins.json` |
| `syncImagesAndMedia`   | boolean | `true`     | 画像・動画・音声・PDF等                         |
| `syncDotfiles`         | boolean | `false`    | `.git` 等のドットファイル（`.obsidian`除く）    |
| `syncPluginSettings`   | boolean | `true`     | `data/flexible/open-data.json`                  |
| `syncFlexibleData`     | boolean | `true`     | `data/flexible/*`                               |
| `syncDeviceLogs`       | boolean | `false`    | `logs/{deviceId}/*`                             |
| `syncWorkspace`        | boolean | `false`    | `workspace.json`, `workspace-mobile.json`       |

### 1.6 セキュリティ

| 設定キー           | 型     | デフォルト | 説明               |
| :----------------- | :----- | :--------- | :----------------- |
| `encryptionSecret` | string | `""`       | 暗号化シークレット |

### 1.7 クラウド設定

| 設定キー          | 型     | デフォルト            | 説明                             |
| :---------------- | :----- | :-------------------- | :------------------------------- |
| `cloudRootFolder` | string | `"ObsidianVaultSync"` | Google Drive上のルートフォルダ名 |

### 1.8 除外パターン

| 設定キー            | 型     | デフォルト              | 説明                                               |
| :------------------ | :----- | :---------------------- | :------------------------------------------------- |
| `exclusionPatterns` | string | `.git\n.svn\n.hg\n.bzr` | 改行区切りのglobパターン。ユーザーが任意に追加可能 |

### 1.9 開発者設定

| 設定キー          | 型      | デフォルト | 説明                            |
| :---------------- | :------ | :--------- | :------------------------------ |
| `isDeveloperMode` | boolean | `false`    | 開発者モード表示切替            |
| `enableLogging`   | boolean | `false`    | 詳細ログ出力                    |
| `startupDelaySec` | number  | `0`        | 起動同期の猶予期間（秒、0-600） |

### 1.10 内部状態

| 設定キー                | 型      | デフォルト | 説明               |
| :---------------------- | :------ | :--------- | :----------------- |
| `hasCompletedFirstSync` | boolean | `false`    | 初回同期完了フラグ |

## 2. 設計判断

### 2.1 認証情報の同期

認証情報（`.sync-state`）の同期はセキュリティリスクのため**対応しない**。各デバイスで個別に認証を行う設計とする。`.sync-state` は `data/local/` に配置し、常に同期対象外とする。

### 2.2 本プラグインの同期除外

`syncCommunityPlugins` が ON の場合でも、本プラグイン自体（`obsidian-vault-sync/`）のバイナリやランタイムデータは同期対象外とする。プラグイン設定のみ `data/flexible/open-data.json` を通じて同期可能。

## 3. データディレクトリ構造

プラグインフォルダ内のデータ配置規則。

```
.obsidian/plugins/obsidian-vault-sync/
  ├── data.json              ← プラグイン設定
  ├── data/
  │   ├── local/             ← 同期対象外（デバイス固有）
  │   │   └── .sync-state    ← 暗号化認証情報
  │   ├── remote/            ← 同期対象
  │   └── flexible/          ← 同期対象（設定による）
  │       └── open-data.json
  └── logs/                  ← ログ（設定による同期）
```

## 4. 強制除外ルール

以下のファイルは設定に関わらず常に同期対象外。

| カテゴリ                 | 対象                                                   |
| :----------------------- | :----------------------------------------------------- |
| プラグイン内部           | `data/local/`, `logs/`, `cache/`                       |
| システムファイル         | `.DS_Store`, `Thumbs.db`, `_VaultSync_Orphans/`        |
| Obsidian一時ファイル     | `indexedDB/`, `backups/`, `.trash/`                    |
| ルート直下ドットファイル | `.git` 等（`.obsidian` は除く、`syncDotfiles` で制御） |
