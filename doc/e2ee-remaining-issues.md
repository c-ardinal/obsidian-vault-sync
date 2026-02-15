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

### 1. デュアルハッシュトラッキングの完全実装（優先度：高）

**問題**: AES-GCMの特性により、同一平文でもIVが異なると暗号文が変わるため、現在の単一ハッシュでは偽の変更検知が発生する

**必要な実装**:
- sync-orchestrationでアップロード時にplainHashを計算・保存
- 変更検知時にplainHashを比較（暗号化されたhashではなく）
- マージ時のancestorHashもplainHashベースに変更

**実装箇所**:
- `src/sync-manager/sync-orchestration.ts`: pushFile関数でplainHash計算
- `src/sync-manager/merge.ts`: plainHashベースの比較ロジック

### 2. 履歴機能のE2EE対応（優先度：中）

**問題**: EncryptedAdapterがsupportsHistory=falseに固定されており、E2EE有効時に履歴機能が使えない

**解決案**:
- リビジョンダウンロード時に復号化処理を追加
- EncryptedAdapterにlistRevisions, getRevisionContentメソッドを実装
- supportsHistoryをbaseAdapter.supportsHistoryに委譲

### 3. ArrayBufferの安全な処理（優先度：低）

**問題**: combined.bufferが共有ArrayBufferを返す可能性

**解決案**:
```typescript
const isolated = combined.buffer.slice(
    combined.byteOffset,
    combined.byteOffset + combined.byteLength
);
```

### 4. フォルダ削除APIの明確化（優先度：低）

**問題**: deleteFileメソッドでフォルダIDを削除する動作が不明確

**解決案**:
- CloudAdapterインターフェースにdeleteFolderメソッドを追加
- またはdeleteFileのドキュメントでフォルダ削除もサポートすることを明記

### 5. E2EE自動有効化時の通知（優先度：低）

**問題**: リモートにvault-lock.jsonがある場合、無言でE2EEが有効化される

**解決案**:
- Noticeで「このVaultは他デバイスで暗号化されています」と通知
- vault-lock.jsonの構造検証を追加

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