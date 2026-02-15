# E2EE 実装計画書 (マスターキー・ラッピング方式)

本書は `obsidian-vault-sync` におけるエンドツーエンド暗号化 (E2EE) の実装計画をまとめたものです。
設計は **「マスターキー・ラッピング方式」** に基づいており、中央認証サーバーを必要とせず、高いセキュリティと利便性（複数デバイス同期）を両立させることを目的としています。

## 参考資料

- [Web Crypto API (MDN)](https://developer.mozilla.org/ja/docs/Web/API/Web_Crypto_API)
- [PBKDF2 (MDN)](https://developer.mozilla.org/ja/docs/Web/API/SubtleCrypto/deriveKey#pbkdf2)
- [AES-GCM (MDN)](https://developer.mozilla.org/ja/docs/Web/API/SubtleCrypto/encrypt#aes-gcm)
- 既存ロジック: `src/adapters/google-drive.ts`

## Phase 0: ユースケース定義 (Use Cases)

**前提**: ユーザーのデータ損失リスクを最小化するため、既存環境からの移行は「Side-by-Side (並行稼働)」方式を採用する。

### ケース1: 初回セットアップ (Fresh Setup / Join)

プラグイン導入後、初めて同期設定を行う場合。

1.  **リモートチェック**:
    - Google Drive 上に既に Vault データが存在するか確認。
2.  **分岐フロー**:
    - **パターンA (データなし/新規)**:
        - セットアップウィザードで「E2EEを有効にするか？」を問う。
        - **有効**: パスワード設定 -> `vault-lock.json` 生成 -> 暗号化同期開始。
            - _UX_: `vault-lock.json` 生成完了までモーダルで待機。
        - **無効**: 通常同期開始。
    - **パターンB (既存の暗号化 Vault を発見)**:
        - **パスワード入力必須**: 解除できるまで同期不可。
        - 解除成功 -> マスターキーをメモリに保持 -> 暗号化同期 (ダウンロード) 開始。
    - **パターンC (既存の非暗号化 Vault を発見)**:
        - 通常同期 (非暗号化) を開始。
        - 同期完了後、設定画面で「暗号化への移行」を推奨可能とする。

### ケース2: 途中からの E2EE 有効化 (Migration)

既存の非暗号化同期環境から、E2EE 環境へ移行する場合。

1.  **事前チェック**:
    - ローカルの変更が全て同期済み (Clean) であることを確認。未同期ファイルがある場合は先に同期させる。
2.  **メンテナンスロック**:
    - クラウド上に `migration.lock` ファイルを作成。他デバイスはこのファイルを見ると同期を一時停止し、「暗号化移行中につき待機しています」と表示する。
3.  **Side-by-Side アップロード**:
    - クラウド上に新ルートフォルダ (例: `[VaultName]-Encrypted`) を作成。
    - ローカルファイルを暗号化しながら新フォルダへアップロード。
    - _UX_: 進捗バー付きモーダルを表示。「暗号化移行中... (34/100 files)」。
        - **中断・再開**: プロセスが中断された場合、次回起動時に「再開」か「破棄 (移行キャンセル)」を選択可能にする。移行済みファイルはハッシュ比較でスキップする。
    - _注意_: この間、ローカルでのファイル編集は推奨しない (Read-only モード的な扱い)。
    - **Android対応**: 移行中の重複表示を避けるため、旧フォルダ内に `.nomedia` を自動生成する。
4.  **スイッチオーバー (切り替え)**:
    - 全ファイルのアップロード完了後、整合性をチェック。
    - `vault-lock.json` を新フォルダに生成。
    - 旧フォルダ (非暗号化) を `[VaultName]-Backup` にリネーム。
    - 新フォルダ `[VaultName]-Encrypted` を正とみなすよう設定更新。
    - `migration.lock` を削除。
5.  **完了**:
    - 通常運用 (E2EE) 開始。

### ケース3: 運用中の同期

既に E2EE が有効な状態での日々の同期。

- **起動時**:
    - Obsidian 起動 -> `vault-lock.json` 検知 -> パスワード入力モーダル表示。
    - 入力成功まで同期は開始されない。
- **同期中**:
    - 暗号化/復号化処理が入るため、通常より時間がかかる旨をユーザーに周知 (初回のみツールチップ等)。
    - **ロック**: 同期処理中 (特にコンフリクト解消や大量ファイルの送受信時) は、データ整合性を保つため Vault 操作をロックまたは警告を表示する。
- **競合解決**:
    - **3-way Merge**: 暗号化された状態での直接マージは不可能なため、**「一度ローカルにダウンロードして復号してから」** 3-way Merge エンジンに渡し、結果を再暗号化してアップロードする。
        - 注意: この処理はメモリ負荷が高いため、大きなファイルでは慎重にハンドリングする。
    - **ハッシュ整合性**: AES-GCM の特性（同じ平文でも IV が変わると暗号文が変わる）に対応するため、`index.json` で `plainHash` (平文) と `remoteHash` (クラウド上の暗号文) を 2 重管理し、不要な再アップロードを防止する。

---

## Phase 1: 暗号化基盤 (Cryptography Foundation)

**ゴール**: `window.crypto.subtle` を使用して、核となる暗号化プリミティブを実装する。

### 実装タスク

1.  **`src/encryption/crypto-primitives.ts` の作成**:
    - `generateMasterKey()`: `CryptoKey` (AES-GCM, 256bit) を生成して返す。
    - `deriveKey(password, salt)`: パスワードとソルトから `PBKDF2` (SHA-256, 10万回以上の反復) で `CryptoKey` を導出する。
    - `encryptData(key, data)`: `window.crypto.subtle.encrypt({ name: "AES-GCM", iv: ... }, key, data)` を使用。戻り値は `{ iv, ciphertext }`。IV は **12 bytes** を遵守する。
    - `decryptData(key, data, iv)`: `window.crypto.subtle.decrypt(...)` を使用して復号する。復号前に **IV (12 bytes) + Auth Tag (16 bytes)** の最小長チェックを行う。
        - 認証エラー (Tag mismatch) 時は、パスワード間違いかファイル破損かを判別してログ出力する。
    - `exportKey/importKey`: 鍵の保存 (JWK) やバイナリ変換のためのヘルパー関数。

2.  **`src/encryption/key-manager.ts` の作成**:
    - `MasterKeyManager` クラスを実装し、メモリ上でのみ `CryptoKey` を保持する (private field)。
    - `initializeNewVault(password)`:
        - ランダムな `salt` (16 bytes) を生成。
        - パスワード + `salt` から「ラッピングキー (WK)」を導出。
        - 「マスターキー (MK)」を生成。
        - MK を WK で暗号化 -> `encryptedMasterKey`。
        - 戻り値: `{ salt, encryptedMasterKey }` (これを "Lock" と呼ぶ)。
    - `unlockVault(lockData, password)`:
        - パスワード + `lockData.salt` から WK を導出。
        - `lockData.encryptedMasterKey` を WK で復号。
        - 取得した MK をメモリに保持する。

### 検証チェックリスト

- [ ] 単体テスト: `encrypt(data)` した結果を `decrypt(result)` して元に戻るか確認。
- [ ] 検証: `deriveKey` が異なるソルトに対して異なる鍵を生成すること。
- [ ] 検証: `unlockVault` に間違ったパスワードを渡すとエラーになること。

### アンチパターン (やってはいけないこと)

- **禁止**: `Math.random()` の使用。必ず `window.crypto.getRandomValues()` を使うこと。
- **禁止**: ECBモードの使用。必ず AES-GCM を使うこと。
- **禁止**: マスターキーやパスワードをログ出力すること。

## Phase 2: アダプター統合 ("The Crypto Layer")

**ゴール**: 同期プロセスに対して透過的に暗号化層を組み込む。

### 実装タスク

3.  **`src/adapters/encrypted-adapter.ts` の作成**:
    - `CloudAdapter` インターフェースを実装 (Proxy パターン)。
    - コンストラクタで `baseAdapter: CloudAdapter` と `keyManager: MasterKeyManager` を受け取る。
    - **`uploadFile`**:
        - IV (12 bytes) を生成。
        - `content` を暗号化 -> `ciphertext`。
        - IV を ciphertext の先頭に付与 (例: `iv + ciphertext`)。
        - `baseAdapter.uploadFile(..., encryptedContent, ...)` を呼び出す。
    - **`downloadFile`**:
        - `baseAdapter.downloadFile(...)` -> `encryptedContent`。
        - 先頭 12 bytes から IV を抽出。
        - 残りのデータを復号。
        - `plaintext` を返す。
    - **パススルー**: `getFileMetadata`, `deleteFile`, `createFolder` 等はそのまま baseAdapter へ流す。

4.  **`SyncManager` の更新**:
    - 設定に基づき、`GoogleDriveAdapter` と `EncryptedAdapter` を切り替えるロジックを追加。
    - この切り替えは、Vault のロック解除後に行われる。

### 検証チェックリスト

- [ ] 統合テスト: 暗号化ONでアップロードを実行。
- [ ] Google Drive確認: ファイルの中身が判読不能 (ランダムなバイト列) になっていること。
- [ ] 統合テスト: ファイルをダウンロード。中身が元のデータと一致すること。
- [ ] 検証: `md5` チェックが機能すること (暗号化されたコンテンツ同士のハッシュ比較になる)。

### アンチパターン

- **禁止**: 暗号化 _後_ に圧縮すること。圧縮は必ず暗号化の _前_ に行う (圧縮効果がなくなるため)。
- **注意**: ファイル名の暗号化はまだ行わない (Phase 5)。

## Phase 3: ロックファイル管理と移行 ("The Handshake & Migration")

**ゴール**: E2EEの状態定義となる `vault-lock.json` の管理と、安全な移行プロセスを実装する。

### 実装タスク

5.  **`src/services/vault-lock-service.ts` の実装**:
    - `checkForLockFile()`: リモートのルートに `vault-lock.json` があるか確認。
    - `itemExists(path)`: 指定パスの存在確認 (移行用)。
    - `createMainFolder(name)`: 新しいルートフォルダを作成 (移行用)。

6.  **移行ロジック (`MigrationService`) の実装**:
    - `startMigration()`: `migration.lock` 作成 -> 新フォルダ作成。
    - `processMigration(progressCallback)`: 全ファイルを読み込み -> 暗号化 -> 新フォルダへアップロード。
    - `finalizeMigration()`: `vault-lock.json` 作成 -> 旧フォルダのリネーム -> 新フォルダへの切り替え -> `migration.lock` 削除。
    - `cancelMigration()`: `migration.lock` と新フォルダ (作業中) を削除して元に戻す。

7.  **`vault-lock.json` の保護**:
    - `SyncOrchestration` が `vault-lock.json` や `migration.lock` を通常の同期対象として扱わない (除外リストに追加) ようにする。

### 検証チェックリスト

- [ ] テスト: `migration.lock` がある状態で他クライアントが同期を停止すること。
- [ ] テスト: `processMigration` が中断・再開可能であること (既存ファイルのスキップロジック等)。
- [ ] 検証: 移行完了後、旧フォルダがバックアップとして残っていること。

## Phase 4: UI & セットアップフロー

**ゴール**: ユーザーが暗号化・ロック解除を行えるようにする。

### 実装タスク

8.  **コマンドパレット統合 (動的コマンド表示)**:
    - **未有効時**: 「E2EE: Vaultの暗号化を開始する」を表示。
    - **有効かつロック時**: 「E2EE: Vaultの暗号化を解除する」を表示。
    - ※ `checkCallback` を使用し、現在の状態に応じて必要なアクションのみが提示されるように実装。
9.  **設定画面 (`src/settings.ts`)**:
    - 「セキュリティ (E2EE)」セクションを追加。
    - ステータス表示: 現在の暗号化状態を表示し、設定・解除はコマンドパレットへ誘導する。

10. **セットアップウィザード & モーダル (`src/ui/encryption-modal.ts`)**:
    - **初回セットアップ / 移行開始フロー**:
        - 警告: 「パスワードを紛失するとデータは復旧できません」「移行中は同期が停止します」。
        - 入力: `パスワード` + `確認用パスワード`。
        - アクション (新規): `keyManager.initializeNewVault` -> `lockService.uploadLockFile`。
        - アクション (移行): `keyManager.initializeNewVault` -> `migrationService.startMigration`。
    - **移行進捗モーダル**:
        - プログレスバー表示 (例: "Encrypting & Uploading: 15/200")。
        - 「中断 (次回再開)」ボタン。
    - **ロック解除フロー**:
        - 入力: `パスワード`。
        - アクション: `lockService.downloadLockFile` -> `keyManager.unlockVault`。

### 検証チェックリスト

- [ ] 手動テスト: 新規Vaultでパスワード "password123" を設定して暗号化を有効化。
- [ ] 手動テスト: プラグインをリロード。「ロック中」になることを確認。
- [ ] 手動テスト: "password123" でロック解除。成功すること。
- [ ] 手動テスト: "wrongpass" でロック解除。失敗すること。

## Phase 5: 今後の対応アイテム (Future Roadmap)

### 1. パスワード変更機能

- **メリット**: Master Key Wrapping 方式の最大の利点。
- **仕組み**: データを再暗号化することなく、マスターキーを「新しいパスワード」で包み直して `vault-lock.json` を更新するだけで完了する。

### 2. リカバリーコード (Rescue Kit)

- **背景**: E2EE の最大の敵はパスワードの紛失（データが永久に失われる）。
- **仕組み**: マスターキーそのものを Base64 文字列（Rescue Kit）として表示し、ユーザーに印刷・物理保存を促す。パスワードを忘れてもこのコードがあれば復旧可能とする。

### 3. ファイル名・構造の難読化

- **背景**: ファイルの中身は隠せても、ファイル名から機密情報が漏洩するリスクがある。
- **重要度**: コンテンツ暗号化の安定化を優先し、v2.0 以降で対応。
- **リスク**: `dir-map.json` が単一障害点となり、競合解決が非常に困難になる。

### 4. セキュリティ強化

- **パスワード強度計**: `zxcvbn` 等を利用して、セットアップ時に脆弱なパスワードを警告する UI。
- **大容量ファイル対応**: `SubtleCrypto` のメモリ制限を回避するため、数GBのファイルをチャンク単位で暗号化するストリーミング実装。
