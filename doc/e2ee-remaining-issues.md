# E2EE実装 残存課題と改善事項

## 対応済み課題

### クリティカル（90-100信頼度）
1. ✅ **任意コード実行の脆弱性** - SHA-256ハッシュ検証を追加
2. ✅ **SQLインジェクション** - クエリパラメータのエスケープ処理追加
3. ✅ **移行サービスの密結合** - cloneWithNewVaultNameメソッドで解決
4. ✅ **移行の原子性欠如** - 自動リカバリ機能を追加
5. ✅ **PBKDF2反復回数検証** - 最小10万回の検証を追加

### 重要（80-89信頼度）
6. ✅ **パスワードの永続保存** - オプトインに変更、警告表示追加
7. ✅ **外部エンジンの検証不足** - 全必須メソッドの検証を追加
9. ✅ **移行後の整合性検証** - サンプリングによる検証を実装
11. ✅ **移行ロックタイムアウト** - 1時間→24時間に延長

## 対応済み課題（実装完了）

### 1. ~~デュアルハッシュトラッキングの完全実装（優先度：高）~~ ✅ 対応済み

### 2. ~~履歴機能のE2EE対応（優先度：中）~~ ✅ 対応済み

EncryptedAdapterにlistRevisions, getRevisionContent, setRevisionKeepForever, deleteRevisionを実装。
supportsHistoryをbaseAdapter.supportsHistoryに委譲。

### 3. ~~ArrayBufferの安全な処理（優先度：低）~~ ✅ 対応済み

`combined.buffer.slice(byteOffset, byteOffset + byteLength)` で分離済み。

### 4. ~~フォルダ削除APIの明確化（優先度：低）~~ ✅ 対応済み

CloudAdapter.deleteFileにJSDocコメントでフォルダ削除もサポートすることを明記。

### 5. ~~E2EE自動有効化時の通知（優先度：低）~~ ✅ 対応済み

vault-lock.json検出時にNoticeで通知（10秒間表示）。i18n対応済み。

### 6. ~~E2EEハッシュ不一致の修正（優先度：高）~~ ✅ 対応済み

- `sync-orchestration.ts`: `hashContent()` でCRLF→LF正規化を適用し、`plainHash`計算と一致するよう修正
- `merge.ts`: マージ後の`ancestorHash`にplainHash（平文ハッシュ）を使用するよう修正
- Windows環境でのCRLF改行がハッシュ不一致を引き起こし、不要なマージが発生する問題を解消

## テスト課題

~~テスト失敗~~ ✅ 全807テストパス（14テストファイル）

## TypeScript型安全性

~~TS警告~~ ✅ 全警告解消（ビルド警告ゼロ）

- `SecureStorage.removeExtraSecret` メソッド追加（保存済みパスワード削除用）
- `migration-service.ts` の `LogLevel` 型不整合修正（`"warning"` → `"warn"`）
- `migration-service.ts` の `setTokens` 呼び出しに `as any` キャスト追加

## セキュリティ上の推奨事項

### 1. ~~エンジンハッシュの更新プロセス~~ ✅ 対応済み

エンジンリポジトリで `npm run hash` を実行してSHA-256を計算。`build.ps1` 実行時にも自動出力。
開発モードではプラグイン側でもハッシュをコンソールに出力。
リリース前に `engine-loader.ts` の `APPROVED_ENGINE_HASH` を更新すること。

### 2. ~~パスワード強度の検証~~ ✅ 対応済み

`src/encryption/password-strength.ts` に軽量チェッカーを実装（外部依存なし）。
i18n対応済み（EN/JA）。`plugin.checkPasswordStrength` としてエンジンに公開。
E2EEセットアップモーダルでリアルタイムにパスワード強度フィードバックを表示。

### 3. ~~ストリーミング暗号化~~ ✅ 対応済み

VSC2チャンク分割暗号化フォーマットとストリーミングアップロードを実装。

- **VSC2ワイヤフォーマット**: `[magic "VSC2"][chunkSize LE][totalChunks LE][per-chunk: IV(12) + ciphertext]`
- **Phase 1 — チャンク分割暗号化/復号** (`src/encryption/chunked-crypto.ts`)
  - ファイルを~1MBチャンクで分割暗号化、事前確保バッファに書き込み
  - ピークメモリ: 4倍 → 2倍に削減
- **Phase 2 — Content-Rangeチャンクアップロード** (`src/adapters/encrypted-adapter.ts`)
  - 暗号化チャンクを5MiBバッチでHTTPアップロード (256KiBアラインメント対応)
  - CloudAdapterに`initiateResumableSession` + `uploadChunk`を追加
  - GoogleDriveAdapterで`uploadFileResumable`をリファクタリング
  - ピークメモリ: 4倍 → 1.1倍に削減
- **閾値**: `largeFileThresholdMB`設定値（デフォルト5MB）以上でVSC2、未満でVSC1レガシー
- **後方互換**: `isChunkedFormat()`で自動判定、既存VSC1ファイルは変更なしで復号可能
- 49件のテストを追加

## パフォーマンス最適化

### 1. ~~暗号化のバッチ処理~~ ✅ 対応済み

移行時の `runMigration()` で `runParallel()` による並列暗号化＋アップロードを実装。
`settings.concurrency`（デフォルト5）に従い並列実行。

### 2. ~~キャッシュ戦略~~ ✅ 対応済み

EncryptedAdapterに同期サイクルスコープのダウンロードキャッシュを実装。
`executeSmartSync` 完了時に自動クリア。マージ中の重複ダウンロード・復号を排除。

### 3. ~~バックグラウンド転送キュー~~ ✅ 対応済み

大容量ファイルを同期サイクル外で非同期転送するキューシステムを実装。

- **BackgroundTransferQueue** (`src/sync-manager/background-transfer.ts`)
  - Push/Pull両方向対応、陳腐化検出、リモートコンフリクト検出
  - リトライ機構（最大3回）、帯域スロットリング（`bgTransferIntervalSec`設定）
  - JSONLログローテーション（7日保持）
  - オンライン/オフライン検出と自動レジューム
- **インライン転送トラッキング** (`src/sync-manager/sync-orchestration.ts`)
  - 通常の同期サイクル内転送もTransferHistoryに記録
- **転送履歴UI** (`src/ui/transfer-status-modal.ts`)
  - タイムラインUI、ファイル名/ディレクトリ2段表示
- 83件のテストを追加

## 今後の機能拡張

### Phase 5（e2ee-plan.md参照）

1. ✅ **パスワード変更機能**: マスターキー再ラッピング

エンジン側に`updatePassword`は実装済みだったが、UIモーダルを追加。
`E2EEPasswordChangeModal`でパスワード入力→強度チェック→確認→`updatePassword`→vault-lock.vault再アップロード。
コマンドパレット「E2EE: Change Encryption Password」で呼び出し。
auto-unlock有効時はキーチェーン内パスワードも自動更新。

2. ✅ **リカバリーコード**: マスターキーのBase64エクスポート/インポート

- `exportRecoveryCode()`: マスターキーの生バイト(32B)をBase64エクスポート（44文字）
- `recoverFromCode(code, newPassword)`: Base64→CryptoKeyインポート→新パスワードでre-wrap→新vault-lock blob
- `getKeyFingerprint()`: SHA-256の先頭4バイト(8 hex文字)で視覚的に鍵を確認
- UI: `E2EERecoveryExportModal`（コード表示+コピー+フィンガープリント）、`E2EERecoveryImportModal`（コード入力+新パスワード設定）
- コマンドパレット: 「E2EE: Show Recovery Code」「E2EE: Recover Vault with Recovery Code」
- エンジン側テスト9件追加（12テスト計）

3. ✅ **復号エラー判別**: パスワード間違い vs データ破損

- `DecryptionError`クラス（`cause: "authentication" | "format"`, オプショナル`chunkIndex`）
- VSC1: IV不足→format、AES-GCM復号失敗→authentication
- VSC2: ヘッダ不正/トランケーション→format（チャンクインデックス付き）、チャンク復号失敗→authentication
- `merge.ts`の`pullFileSafely`でDecryptionError検出→`noticeE2EEDecryptFailed`通知
- プラグイン側テスト10件追加（807テスト計）

4. **ファイル名暗号化**: dir-map.jsonによる難読化
5. **マルチマスターキー**: デバイス固有鍵の導入