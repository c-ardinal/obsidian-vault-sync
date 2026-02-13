# 実装プラン: ログ出力の軽量化と関心の分離

ログファイルの肥大化を抑制し、メンテナンス性を向上させるため、ログ管理機能を独立したモジュールへ抽出し、レベルベースのバッファリング出力を実装します。

## 1. 新規コンポーネントの作成

### 1.1 `src/sync-manager/logger.ts` (SyncLogger)

- **役割**: ログレベルの管理、メモリバッファリング、条件付きファイル出力（フラッシュ）の実行。
- **インターフェース**:
    - `system(msg)`, `error(msg)`, `warn(msg)`, `info(msg)`, `debug(msg)`
    - `startCycle(trigger)`: サイクルの開始。
    - `markActionTaken()`: ファイル転送などのアクションが発生したことを記録。
    - `markNoticeShown()`: 通知が表示されたことを記録。
    - `endCycle(settings)`: フラッシュ判定とバッファクリア。

## 2. 既存コードの修正

### 2.1 `src/sync-manager/context.ts` (SyncContext)

- `SyncContext` インターフェースに `logger: SyncLogger` を追加。
- 従来の `log(msg: string)` メソッドは互換性のために残すか、段階的に移行を検討（一旦 `info` レベルへ委譲）。

### 2.2 `src/sync-manager/sync-manager.ts` (SyncManager)

- `SyncLogger` をインスタンス化し、`SyncContext` を通じて各モジュールへ配布。
- 既存の `log` メソッドの実体を `SyncLogger` へ移動し、レベルに応じた判定ロジックを実装。
- `notify` メソッド内で表示が行われた際に `logger.markNoticeShown()` を呼び出す。

### 2.3 `src/sync-manager/sync-orchestration.ts` (SyncOrchestration)

- `executeSmartSync`, `executeFullScan` のループの前後でサイクルの開始/終了を呼び出す。
- ファイルアップロード/ダウンロード/削除/リネームが成功した箇所で `ctx.logger.markActionTaken()` を呼び出す。

### 2.4 各モジュールのログレベル見直し

- `merge.ts`, `state.ts`, `history.ts` 等で使用されている `ctx.log` を適切なレベル（主に `info` または `debug`）に置き換え。

## 3. テスト計画

### 3.1 単体テスト (`tests/tests/unit/logger.test.ts`)

- 各レベルのログが正しくバッファリングされることの検証。
- フラッシュ条件（アクションあり、エラーあり、通知あり）が正しく機能することの検証。
- 開発者モード ON の時に常にフラッシュされることの検証。
- 特定トリガー（Manual等）で常にフラッシュされることの検証。

### 3.2 統合テスト

- 実際の同期サイクル（変更なし）を実行し、ログファイルが更新されないことを手動または自動テストで確認。

## 4. 完了定義

- [ ] 変更なしの定期同期でログファイルが増加しない。
- [ ] ファイル変更時には従来通り（またはノイズの少ない）ログが残る。
- [ ] 起動ログやトリガーログが常に残っている。
- [ ] 開発者モードでは全ログが出力される。
- [ ] 全ての新規・既存テストがパスする。
