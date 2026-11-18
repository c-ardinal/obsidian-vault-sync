# 複数端末同期シミュレーション (tests/sim)

実機で複数端末を手動操作せずに、「同期が終了しない」「低速」「非競合なのに競合扱い」「編集内容の消失」といった
**複数端末環境限定の不具合**を CI で検出するためのテスト基盤です。

## 概要

- 実際の `SyncManager` を N 台分起動し、各台に独立した Vault を用意し、単一の共有モッククラウド（Google Drive 相当）に接続します。
- シード値で確定するランダムな操作列（作成・編集・削除・リネーム・バイナリ更新・同期・オフライン化）を、**仮想時計**上で同時並行に実行します。
- 注入可能な現実的変動:
  - 通信遅延（リクエスト／レスポンス個別）、一時的なネットワークエラー、**レスポンスのみ消失する**失敗（サーバー側は反映済み）
  - 端末のオフライン化
  - Obsidian のファイルイベント（create/modify/delete/rename）の遅延配送。同期エンジン自体の書込でもイベントが発火する点まで再現
  - 端末単位の時計誤差（ファイル mtime）
  - OS 単位のファイル名処理: `windows`（大小文字を区別しない）、`macos`（大小文字＋Unicode NFC/NFD を区別しない）、`linux`、`real-fs`（CI ランナーの実ファイルシステム）
  - CRLF + BOM のテキスト（Windows 端末）、PNG 風バイナリ（CR/LF/NUL を包含）
- 最終段階でネットワークを正常化して全端末を同期させ、以下の不変条件を検査します。

| 種別 | 意味 |
|---|---|
| `HANG` | 同期が終了しない（デッドロック／無限リトライ） |
| `NO_CONVERGE` | 正常なネットワークで何ラウンド同期しても変化が停止しない（ピンポン） |
| `DIVERGED` | 端末間・クラウドでファイル内容が一致しない |
| `NOT_IDLE` | 収束後も dirty / pendingConflict が残存する（毎回再同期される） |
| `SLOW_IDLE` | 無変更の同期で API 呼出回数が予算を超過する |
| `SYNC_ERROR` | 正常なネットワークで同期が例外を送出する |
| `FALSE_CONFLICT` | 非重複の編集なのに競合コピーが発生した |
| `LOST_UPDATE` | ユーザーの編集が最終状態から消失した／マージで行が重複した |
| `DUPLICATE` | 単一のノートが複数ファイルに分裂した |
| `DATA_LOSS` | 未削除のノートが全端末から消失した |

## シナリオ

`multi-device.sim.test.ts` の `SCENARIOS`:

- `clean-network` / `clean-network-instant-events`: 正常なネットワーク。各端末はノートの「自端末担当の行」のみを編集（＝正常なエンジンなら必ず競合なしでマージ可能）
- `flaky-network`: モバイル回線想定（遅延・失敗・オフライン・時計ずれ）
- `cross-os`: Linux + Windows + macOS 端末を単一の Vault で混在、CRLF/BOM、バイナリ添付
- `chaos`: 同一行の編集・削除・リネーム・大文字小文字／NFD 衝突など全操作を許容（終了・収束・データ消失のみ検査）
- `real-fs`: 実ファイルシステム上で実行。CI の OS マトリクスで NTFS / APFS / ext4 の差異を検出
- `large-files`: 大容量ファイルの閾値を約 100 バイトに設定し、添付や肥大化したノートをバックグラウンド転送（分割アップロード・遅延ダウンロード）で処理する。通信は不安定
- `restart`: 同期中・バックグラウンド転送中・未送信の編集が存在する状態など、ランダムな時点でアプリを強制終了して再起動する。再起動後は保存済みの状態のみで起動時同期（Vault スキャン付き）を実行し、完全に復旧可能であることを検査。終了済み世代の処理は、以降のファイル操作・クラウド操作で例外となる。以前の未解決ケース（seed 135, 143, 258, 278）は修正済みで、known-bugs.test.ts に回帰テストとして登録

## 使用方法

```bash
npm run test:sim                                   # 全シナリオ × 10 シード + 既知バグ + ハーネス自己テスト
SIM_SEEDS=200 npm run test:sim                     # シード数を増加
SIM_SEED=13 SIM_SCENARIO=cross-os npm run test:sim -- tests/sim/multi-device.sim.test.ts   # 単一ケースを再現
SIM_SEED=13 SIM_SCENARIO=cross-os SIM_MINIMIZE=1 npm run test:sim -- tests/sim/multi-device.sim.test.ts
#   ↑ 失敗する操作列を自動で最小化（SIM_MINIMIZE_KIND=FALSE_CONFLICT で対象の失敗種別を指定）
```

同一シードは**任意のマシン・OS で同一の結果**になります（仮想時計、乱数の固定、gzip の同期化による）。

失敗時は `test-results/sim/` に以下を出力します（CI では Artifact としてダウンロード可能、Job Summary に一覧と再現コマンドを表示）。

- `<scenario>-seed<N>.log` … 全端末のログ・ユーザー操作・ファイルイベント・クラウド呼出を時刻順に整列したタイムライン
- `<scenario>-seed<N>.json` … 設定、操作列、各端末の最終状態（ファイル・index・localIndex・dirty）、クラウドの最終状態
- `*.min-plan.json` … 最小化した操作列（`SIM_MINIMIZE=1` 指定時）

## 性能ベンチマーク（`perf.test.ts`）

非ランダムの固定作業（新規 60 ノート＋画像 6 枚の push → 2 台目の初回同期 → 30 件の編集 → 15 件を両端末で別行を編集して自動マージ → アイドル同期）を、
API 呼出 1 回の往復に 200ms を要する回線で実行し、フェーズ単位の**待機時間（仮想時間）と API 呼出回数（メソッド別）**を
`test-results/sim/perf.txt` / `perf.json` に出力します。全端末の収束と競合コピーの不在、呼出回数が予算内であることも検査します。

```bash
npm run test:sim -- tests/sim/perf.test.ts && cat test-results/sim/perf.txt
```

## 検出済みバグの固定

`known-bugs.test.ts` に、最小化した操作列を**決定的な再現テスト**として配置しています。
各テストは「バグが現在も再現すること」を確認し、修正されると「no longer reproduces」で失敗します。
その際はケースを `FIXED_REGRESSIONS` に移動すると、以降は「再発しないこと」のテストになります。

## CI

- PR（`.github/workflows/test.yml` の `simulation` ジョブ, ubuntu/macOS/Windows）:
  既知バグ再現テストとハーネス自己テストは必須、ランダムシミュレーション（10 シード/シナリオ）は既知バグ修正までは非ブロッキング。
  リポジトリ変数 `SIM_STRICT=true` でブロッキングに変更可能です。
- 毎晩（`.github/workflows/sim-nightly.yml`）: 3 OS × 200 シード/シナリオ、毎晩異なるシード。手動実行でシード数・シナリオ・最小化を指定可能。

## 制約

- クラウドは `MockCloudAdapter`（インメモリ）。Changes API は Google Drive と同様に「ファイル単位で最新状態を 1 件のみ返却する」形式です（`changesLatestStateOnly`）。ページングは `changesPageSize` で指定可能で、性能ベンチでは 25 件/ページに設定しています。同名ファイルの重複作成・Changes API の遅延・レート制限は未再現です。
- 時計誤差はファイル mtime のみ。エンジン内部の `Date.now()`（マージロックの期限など）は全端末で共通です。
- E2EE と大容量ファイルのバックグラウンド転送は未対象です。
