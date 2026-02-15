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

## 未対応課題（要実装）

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

## テスト課題

~~テスト失敗~~ ✅ 全613テストパス（11テストファイル）

## セキュリティ上の推奨事項

### 1. ~~エンジンハッシュの更新プロセス~~ ✅ 対応済み

`npm run e2ee:hash` で SHA-256 を計算可能。開発モードではハッシュをコンソールに出力。
リリース前に `engine-loader.ts` の `APPROVED_ENGINE_HASH` を更新すること。

### 2. ~~パスワード強度の検証~~ ✅ 対応済み

`src/encryption/password-strength.ts` に軽量チェッカーを実装（外部依存なし）。
i18n対応済み（EN/JA）。外部エンジンが `checkPasswordStrength()` を利用可能。

### 3. ストリーミング暗号化

大容量ファイル対応として（将来改善）：
- Web Streams APIを使用したチャンク単位の暗号化
- メモリ使用量の削減

## パフォーマンス最適化

### 1. ~~暗号化のバッチ処理~~ ✅ 対応済み

移行時の `runMigration()` で `runParallel()` による並列暗号化＋アップロードを実装。
`settings.concurrency`（デフォルト5）に従い並列実行。

### 2. ~~キャッシュ戦略~~ ✅ 対応済み

EncryptedAdapterに同期サイクルスコープのダウンロードキャッシュを実装。
`executeSmartSync` 完了時に自動クリア。マージ中の重複ダウンロード・復号を排除。

## 今後の機能拡張

### Phase 5（e2ee-plan.md参照）

1. **パスワード変更機能**: マスターキー再ラッピング
2. **リカバリーコード**: マスターキーのBase64エクスポート
3. **ファイル名暗号化**: dir-map.jsonによる難読化
4. **マルチマスターキー**: デバイス固有鍵の導入