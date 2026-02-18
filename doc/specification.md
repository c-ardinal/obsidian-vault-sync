# VaultSync - 仕様書

**Version**: 2.3
**Last Updated**: 2026-02-19

Obsidian向けクラウドストレージ同期プラグイン。ローカルのObsidian VaultとGoogle Drive上のフォルダを同期し、全プラットフォームでのデータ一貫性を保つ。

---

## 1. アーキテクチャ概要

### 1.1 コンポーネント構成

```
┌─────────────────────────────────────────────────────────┐
│                    main.ts (Plugin)                      │
│  イベント監視・UIコンポーネント・設定管理                │
└────────────────────────┬────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────┐
│                  SyncManager                             │
│  同期オーケストレーション・スケジューリング・状態管理     │
│  Smart Sync / Background Full Scan / 割り込み制御        │
│  3-way マージ / 競合解決 / 分散ロック                    │
└────────────────────────┬────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────┐
│             CloudAdapter Interface (抽象層)               │
│  ┌──────────────┐  ┌───────────────────┐                 │
│  │ GoogleDrive  │  │ EncryptedAdapter  │  (E2EE Proxy)   │
│  │ (実装済み)   │  │ (VSC1/VSC2自動判定)│                 │
│  └──────────────┘  └───────────────────┘                 │
│  ┌──────────┐  ┌──────────┐                              │
│  │ Dropbox  │  │ OneDrive │  ... (将来)                  │
│  └──────────┘  └──────────┘                              │
└─────────────────────────────────────────────────────────┘
```

### 1.2 主要モジュール

| モジュール                  | ファイル                              | 役割                                                                                           |
| :-------------------------- | :------------------------------------ | :--------------------------------------------------------------------------------------------- |
| **SyncManager**             | `sync-manager/`                       | 同期のオーケストレーション。Index管理、差分検知、Pull/Push分岐、3-wayマージ、分散ロック        |
| **CloudAdapter**            | `types/adapter.ts`                    | クラウドストレージ抽象化インターフェース                                                       |
| **GoogleDriveAdapter**      | `adapters/google-drive.ts`            | Google Drive REST API実装。`fetch` APIベースでモバイル互換                                     |
| **EncryptedAdapter**        | `adapters/encrypted-adapter.ts`       | CloudAdapterのプロキシ。E2EE有効時に暗号化/復号を透過的に挿入。VSC1/VSC2自動判定              |
| **SecureStorage**           | `secure-storage.ts`                   | 認証情報の保存。Obsidian Secret Storage (Keychain) を優先し、未対応環境では暗号化バイナリで保存 |
| **VaultLockService**        | `services/vault-lock-service.ts`      | vault-lock.vault と migration.lock の管理。常に非暗号化アダプタ経由                            |
| **ChunkedCrypto**           | E2EE Engine (`chunked-crypto.ts`)     | VSC2チャンク分割暗号化/復号。大容量ファイルのピークメモリ削減（E2EE Engineリポジトリに配置）   |
| **ICryptoEngine**           | `encryption/interfaces.ts`            | E2EEエンジンの抽象インターフェース（暗号化/復号/リカバリー/UI注入）                            |
| **DecryptionError**         | `encryption/errors.ts`                | 復号エラーの分類（authentication / format）                                                     |
| **BackgroundTransferQueue** | `sync-manager/background-transfer.ts` | 大容量ファイルの非同期Push/Pull。リトライ・陳腐化検出・JSONL履歴                               |
| **RevisionCache**           | `revision-cache.ts`                   | 履歴コンテンツのセッション内キャッシュ                                                         |
| **HistoryModal**            | `ui/history-modal.ts`                 | 履歴確認・Diff表示・ロールバックUI                                                             |
| **TransferStatusModal**     | `ui/transfer-status-modal.ts`         | 転送ステータス・履歴のタイムラインUI                                                           |
| **SyncLogger**              | `sync-manager/logger.ts`              | レベルベースログ管理。バッファリング・条件付きフラッシュ・開発者モード即時出力                  |
| **NotificationMatrix**      | `sync-manager/notification-matrix.ts` | 通知表示制御。トリガー×通知レベルのマトリックスで表示/非表示を決定                             |
| **i18n**                    | `i18n.ts`                             | 多言語対応 (ja/en)                                                                             |

### 1.3 データ構造

#### Google Drive上のフォルダ構造

```
ObsidianVaultSync/           ← App Root (設定で変更可)
  └── <VaultName>/           ← Vault Root
       ├── notes             ← ユーザーファイル群
       └── .obsidian/        ← Obsidian 設定ファイル群 (選択同期)
            └──plugins
                 └── obsidian-vault-sync/ ← 本プラグイン配置フォルダ
```

- **Global Discovery**: `VaultName` と一致するフォルダをGoogle Drive内からグローバルに検索。見つかった場合は App Root 配下へ自動的に移動（Adoption）して統合する。

#### ローカルデータ

| ファイル                         | 場所                 | 用途                                                                       |
| :------------------------------- | :------------------- | :------------------------------------------------------------------------- |
| `sync-index.json`                | プラグインフォルダ内 | クラウド共有インデックス（ファイルハッシュ・mtime・ancestorHash等）        |
| `local-index.json`              | `data/local/`        | デバイス専用インデックス（前回同期時点のリビジョン記録。同期対象外）       |
| `.sync-state`                    | `data/local/`        | 暗号化認証情報（Keychain未対応時のフォールバック。移行後は自動削除される） |
| `open-data.json/local-data.json` | プラグインフォルダ内 | プラグイン設定                                                             |

---

## 2. 詳細仕様（分冊）

各機能の詳細仕様は以下のドキュメントに分冊されている。

| ドキュメント                                | 内容                                                                 |
| :------------------------------------------ | :------------------------------------------------------------------- |
| [同期エンジン仕様](spec/sync-engine.md)     | Smart Sync / Full Scan / Index管理 / 割り込み制御 / 同期トリガー     |
| [競合解決仕様](spec/conflict-resolution.md) | 3-wayマージ / 楽観的ロック / 分散ロック / ancestorHashライフサイクル |
| [設定仕様](spec/settings.md)                | 全設定項目 / 同期スコープ / 除外パターン                             |
| [履歴機能仕様](spec/history.md)             | リビジョン管理 / Diff表示 / ロールバック                             |
| [ログ出力仕様](spec/logging.md)             | ログレベル / バッファリング / 軽量化ロジック                         |

## 3. テスト仕様（分冊）

| ドキュメント                                                 | 内容                                                        |
| :----------------------------------------------------------- | :---------------------------------------------------------- |
| [マージアルゴリズムテスト仕様](test-spec/merge-algorithm.md) | 3-wayマージの112テストケース / DMPパラメータ / 合否判定基準 |
| [同期シナリオテスト仕様](test-spec/sync-scenarios.md)        | 基本動作 / 競合検知 / 割り込み / 複数端末テスト             |

---

## 4. 対応プラットフォーム

- Windows / Mac / Linux / iOS / Android（全Obsidianプラットフォーム）

## 5. セキュリティ

- **認証スコープ**: Google Drive API `auth/drive`（グローバル検索・フォルダ移動のため）
- **認証情報保存**: Obsidian Secret Storage API (Keychain) を優先使用。未対応環境では `.sync-state`（AES-GCM暗号化バイナリ）に保存し、機密性を確保。
- **通信**: HTTPS のみ
- **楽観的ロック**: Push時にリモートハッシュを検証し、競合を検知
- **パストラバーサル防止**: 履歴API呼び出し時のパス検証
- **整合性検証**: ダウンロード時のMD5ハッシュ照合

## 6. エンドツーエンド暗号化 (E2EE)

オプション機能。外部E2EEエンジン (`e2ee-engine.js`) を配置することで有効化。設計は**マスターキー・ラッピング方式**に基づき、中央認証サーバーを必要とせず、高いセキュリティと利便性（複数デバイス同期）を両立する。

### 6.1 ユースケース

#### ケース1: 初回セットアップ (Fresh Setup / Join)

プラグイン導入後、初めて同期設定を行う場合。

1. **リモートチェック**: Google Drive 上に既に Vault データが存在するか確認。
2. **分岐フロー**:
   - **パターンA (データなし/新規)**: セットアップウィザードで E2EE 有効化を問う。有効時はパスワード設定 → `vault-lock.vault` 生成 → 暗号化同期開始。
   - **パターンB (既存の暗号化 Vault を発見)**: パスワード入力必須。解除できるまで同期不可。解除成功後にマスターキーをメモリに保持し、暗号化同期を開始。
   - **パターンC (既存の非暗号化 Vault を発見)**: 通常同期を開始。同期完了後、設定画面で暗号化への移行を推奨可能。

#### ケース2: 途中からの E2EE 有効化 (Migration)

既存の非暗号化同期環境から E2EE 環境へ移行する場合。Side-by-Side（並行稼働）方式を採用。

1. **事前チェック**: ローカルの変更が全て同期済み (Clean) であることを確認。
2. **メンテナンスロック**: `migration.lock` を作成。他デバイスは同期を一時停止。
3. **Side-by-Side アップロード**: 新ルートフォルダへ暗号化しながらアップロード。進捗表示・中断/再開対応。
4. **スイッチオーバー**: 全ファイルアップロード完了後に整合性チェック → `vault-lock.vault` 生成 → 旧フォルダをバックアップにリネーム → 新フォルダへ切り替え → `migration.lock` 削除。

#### ケース3: 運用中の同期

- **起動時**: `vault-lock.vault` 検知 → パスワード入力モーダル表示。入力成功まで同期不可。
- **同期中**: 暗号化/復号処理のため通常より時間がかかる。大量ファイル送受信時はデータ整合性のためロック制御。
- **競合解決**: 暗号化状態での直接マージは不可。ダウンロード → 復号 → 3-way Merge → 再暗号化 → アップロード。`index.json` で `plainHash`（平文）と `remoteHash`（暗号文）を2重管理し、不要な再アップロードを防止。

### 6.2 暗号化基盤

#### アルゴリズム

- **暗号化**: AES-256-GCM (Web Crypto API)
- **鍵導出**: PBKDF2-SHA256、600,000 イテレーション
- **IV**: 12 バイト（`window.crypto.getRandomValues()` で生成）
- **禁止事項**: `Math.random()` の使用、ECBモードの使用、マスターキー/パスワードのログ出力

#### ファイル暗号化フォーマット

| フォーマット | 対象 | ワイヤーフォーマット | 備考 |
|:-----------|:-----|:-------------------|:-----|
| **VSC1** | 小ファイル (`< largeFileThresholdMB`) | `[IV(12B)][ciphertext]` | 単一AES-GCM暗号化 |
| **VSC2** | 大ファイル (`≥ largeFileThresholdMB`) | `[magic "VSC2"][chunkSize LE][totalChunks LE][per-chunk: IV(12B) + ciphertext]` | チャンク分割暗号化。ピークメモリを4倍→1.1倍に削減 |

復号時は `isChunkedFormat()` により VSC2/VSC1 を自動判定。

#### 復号エラー判別

`DecryptionError` クラスで原因を分類:
- `authentication`: パスワード間違い（GCM認証タグ不一致）
- `format`: データ破損（マジックバイト不正、チャンク数不整合など）
- VSC2の場合、`chunkIndex` で問題のチャンク位置を特定可能

#### 鍵管理 (MasterKeyManager)

| 操作 | 説明 |
|:-----|:-----|
| **初期化** (`initializeNewVault`) | ランダム salt (16B) 生成 → パスワード+salt から PBKDF2 でラッピングキー導出 → マスターキー (AES-256) 生成 → ラッピングキーで暗号化 → vault-lock.vault アップロード |
| **ロック解除** (`unlockVault`) | vault-lock.vault ダウンロード → パスワード+salt → PBKDF2 → ラッピングキー → マスターキー復号 → メモリに保持 |
| **パスワード変更** (`updatePassword`) | 新パスワードでマスターキーを再ラッピング。データ再暗号化不要。auto-unlock有効時はキーチェーン内パスワードも更新 |
| **リカバリーコード** (`exportRecoveryCode`) | マスターキーの生バイト (32B) を Base64 文字列 (44文字) としてエクスポート |
| **リカバリー復元** (`recoverFromCode`) | リカバリーコード → raw key import → 新パスワードで再ラッピング → vault-lock.vault 更新 |
| **フィンガープリント** (`getKeyFingerprint`) | マスターキーの SHA-256 先頭4バイト (8 hex文字) で鍵の視覚的確認 |

### 6.3 アダプター統合 (EncryptedAdapter)

`CloudAdapter` インターフェースを実装するプロキシパターン。`baseAdapter` (GoogleDriveAdapter) をラップし、暗号化/復号を透過的に挿入。

- **`uploadFile`**: IV生成 → 暗号化 → `baseAdapter.uploadFile` 呼び出し
- **`downloadFile`**: `baseAdapter.downloadFile` → 復号 → 平文返却
- **`uploadFileResumable`**: `largeFileThresholdMB` 以上のファイルで VSC2 チャンク分割暗号化 → Content-Range チャンクアップロード
- **パススルー**: `getFileMetadata`, `deleteFile`, `createFolder` 等は baseAdapter へそのまま転送

### 6.4 ロックファイル管理 (VaultLockService)

- `vault-lock.vault` と `migration.lock` はE2EEの状態定義ファイル
- 常に非暗号化アダプタ経由（baseAdapter）で読み書き
- 通常の同期対象からは除外
- `uploadLockFile()`: パスワード変更・リカバリー時の vault-lock.vault 更新

### 6.5 移行サービス (MigrationService)

| メソッド | 説明 |
|:--------|:-----|
| `startMigration` | `migration.lock` 作成 → 新フォルダ作成 |
| `processMigration` | 全ファイル読込 → 暗号化 → 新フォルダへアップロード（進捗コールバック対応） |
| `finalizeMigration` | `vault-lock.vault` 作成 → 旧フォルダリネーム → 新フォルダへ切り替え → `migration.lock` 削除 |
| `cancelMigration` | `migration.lock` と作業中フォルダを削除して元に戻す |

中断時は次回起動時に「再開」か「破棄（移行キャンセル）」を選択可能。移行済みファイルはハッシュ比較でスキップ。

### 6.6 UI & セットアップフロー

- **コマンドパレット**: `checkCallback` を使用し、E2EE状態に応じた動的コマンド表示
  - 未有効時: 「E2EE: Vaultの暗号化を開始する」
  - 有効かつロック時: 「E2EE: Vaultの暗号化を解除する」
  - ロック解除済み: 「パスワード変更」「リカバリーコード表示」
  - E2EE有効 (ロック状態不問): 「リカバリーコードで復元」
- **設定画面**: 「セキュリティ (E2EE)」セクション。ステータス表示・コマンドパレットへの誘導
- **セットアップウィザード**: 警告表示 → パスワード入力（ASCII限定、8文字以上）→ 強度チェック → 確認 → 暗号化開始
- **ロック解除モーダル**: パスワード入力 → vault-lock.vault ダウンロード → ロック解除
- **パスワード変更モーダル**: 新パスワード入力 → 強度チェック → `updatePassword` → vault-lock.vault アップロード
- **リカバリーコード表示モーダル**: 警告バナー → Base64リカバリーコード表示（読み取り専用）→ フィンガープリント表示 → クリップボードコピー
- **リカバリー復元モーダル**: リカバリーコード入力 → 新パスワード入力 → `recoverFromCode` → vault-lock.vault アップロード

### 6.7 E2EEエンジン検証

- エンジンファイルの SHA-256 ハッシュを `APPROVED_ENGINE_HASH` と照合
- 必須メソッド (`encrypt`, `decrypt`, `isUnlocked` 等) の存在を検証
- 検証失敗時は `noticeEngineVerifyFailed` 通知を表示し、エンジンを読み込まない

## 7. 国際化 (i18n)

- Obsidianの言語設定（`window.localStorage.getItem("language")`）に連動
- 対応言語: 日本語 (ja) / 英語 (en, デフォルト)

---

## 8. 今後の対応アイテム

### 8.1 E2EE: ファイル名・構造の難読化

- **背景**: ファイルの中身は暗号化されるが、ファイル名から機密情報が漏洩するリスクがある
- **方式**: `dir-map.json` によるファイル名マッピング
- **リスク**: `dir-map.json` が単一障害点となり、競合解決が非常に困難になる
- **優先度**: コンテンツ暗号化の安定化を優先し、将来バージョンで対応

### 8.2 E2EE: マルチマスターキー

- **背景**: 現在は全デバイスが同一マスターキーを共有。デバイス固有鍵を導入することで、特定デバイスの鍵失効が可能になる
- **優先度**: 現時点ではリカバリーコード機能で十分な運用が可能。将来バージョンで検討

### 8.3 マージアルゴリズム拡張

詳細は [競合解決仕様 §8](spec/conflict-resolution.md) を参照。

1. **Intra-line Character Merge**: 同一行内の異なるオフセットへの変更を文字レベルで救済
2. **Structural Table Merge**: Markdownテーブルのカラム操作を意味論的に統合
3. **Block Move Tracking**: 章や段落の「移動」を検知し、移動先に編集を適用

### 8.4 クラウドストレージ対応拡張

詳細は [同期エンジン仕様 §12](spec/sync-engine.md) を参照。

| クラウド     | Changes API                 | Hash比較     | 履歴   | 備考     |
| :----------- | :-------------------------- | :----------- | :----- | :------- |
| Dropbox      | 対応 (list_folder/continue) | content_hash | 対応   | -        |
| OneDrive     | 対応 (delta API)            | quickXorHash | 対応   | -        |
| S3           | 非対応                      | ETag         | 非対応 | 基本のみ |
| WebDAV       | 非対応                      | 非対応       | 非対応 | 基本のみ |
