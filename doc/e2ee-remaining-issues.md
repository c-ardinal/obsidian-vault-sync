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

### 失敗しているテスト（要修正）

現在、以下のテストが失敗しています：
- conflict-resolution.test.ts
- icon-behavior.test.ts
- move-logic.test.ts
- notification-matrix.test.ts
- merge-algorithm.test.ts
- yaml-scenarios.test.ts

これらは主にE2EE機能追加による既存ロジックの変更が原因です。

## セキュリティ上の推奨事項

### 1. エンジンハッシュの更新プロセス

現在、`APPROVED_ENGINE_HASH`は開発用のダミー値です。リリース前に：
1. 正式なe2ee-engine.jsのSHA-256ハッシュを計算
2. engine-loader.tsのAPPROVED_ENGINE_HASHを更新
3. エンジン更新時の手順をドキュメント化

### 2. パスワード強度の検証

将来的な改善として：
- zxcvbn等のパスワード強度チェックライブラリの導入
- 弱いパスワードに対する警告UI

### 3. ストリーミング暗号化

大容量ファイル対応として：
- Web Streams APIを使用したチャンク単位の暗号化
- メモリ使用量の削減

## パフォーマンス最適化

### 1. 暗号化のバッチ処理

移行時の大量ファイル処理で：
- 並列暗号化の実装（Worker使用）
- プログレッシブアップロード

### 2. キャッシュ戦略

- 復号化済みコンテンツの一時キャッシュ
- plainHashのインデックス化

## 今後の機能拡張

### Phase 5（e2ee-plan.md参照）

1. **パスワード変更機能**: マスターキー再ラッピング
2. **リカバリーコード**: マスターキーのBase64エクスポート
3. **ファイル名暗号化**: dir-map.jsonによる難読化
4. **マルチマスターキー**: デバイス固有鍵の導入