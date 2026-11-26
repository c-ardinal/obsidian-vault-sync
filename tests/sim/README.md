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
- `non-md5-hash`: クラウドが MD5 以外のハッシュ値（OneDrive の quickXorHash、Dropbox の content hash 相当）を返す。ローカル内容との比較は plainHash のみで実行。対応前は 10 シード中 6 件で誤競合と編集消失が発生
- `large-files`: 大容量ファイルの閾値を約 100 バイトに設定し、添付や肥大化したノートをバックグラウンド転送（分割アップロード・遅延ダウンロード）で処理する。通信は不安定
- `e2ee-large-files`: E2EE と大容量ファイルのバックグラウンド転送（分割暗号化）の併用
- `restart`: 同期中・バックグラウンド転送中・未送信の編集が存在する状態など、ランダムな時点でアプリを強制終了して再起動する。再起動後は保存済みの状態のみで起動時同期（Vault スキャン付き）を実行し、完全に復旧可能であることを検査。終了済み世代の処理は、以降のファイル操作・クラウド操作で例外となる。以前の未解決ケース（seed 135, 143, 258, 278）は修正済みで、known-bugs.test.ts に回帰テストとして登録

## 設定組み合わせ検証（`settings-matrix.sim.test.ts`）

上記シナリオは設定が固定のため、設定項目の組み合わせに起因する不具合は検出できません。
`settings-matrix.ts` に利用者向け設定の 15 因子（競合解決方針、除外パターン、画像・メディア同期、PC 限定除外、設定ファイル同期の有無、
削除と大量削除確認、大容量ファイル転送、E2EE／非 MD5 クラウド、並列数、クラウド側ゴミ箱、バージョンの自動保持、同期頻度、通信品質、OS 混在、アプリ再起動）を定義し、
全因子の全水準の対（ペア）を最低 1 回網羅する組み合わせ（ペアワイズ、24 通り）を決定的に生成します。

- 端末単位の設定差異（`deviceSettings`）、実行中の設定変更（`setting` 操作）、設定ファイル経由の他端末への伝播（次回同期の終了時に適用）を再現
- 大量削除・上書き確認は実装と同一の `MassChangeGuard` を使用し、混乱期間中は一定確率で利用者が保留を選択
- 追加の不変条件 `SCOPE_LOSS`: 設定変更時に端末が保持していたノートが、削除操作なしで最終状態から消失
- 同期対象外の状態での編集は「クラウド・端末・競合コピーのいずれかに現存」を検査。force-local／force-remote は仕様上の編集破棄のため行単位の検査を省略

```bash
npm run test:sim -- tests/sim/settings-matrix.sim.test.ts                  # 24 通り × 5 シード
SIM_SEEDS=100 npm run test:sim -- tests/sim/settings-matrix.sim.test.ts    # シード数を増加
SIM_MATRIX=single ...      # 基準設定＋1 因子のみ変更（失敗原因の因子特定用、30 通り）
SIM_COMBO=combo-07 SIM_SEED=12 ...   # 単一ケースの再現
SIM_MATRIX_LIST=1 ...      # 組み合わせ一覧を表示
```

検出済みの失敗は、組み合わせ番号ではなく設定水準とシードで固定しています（因子を追加すると番号が変動するため）。

- `PINNED`: 修正済みの失敗。毎回の実行で再発の有無を検査
- 以前の未解決事例 3 件も修正済みで、`PINNED` に登録しています
  - 削除と他端末のアップロードが通信遅延の範囲内で競合した場合の編集消失: 削除端末が削除直前に確認したバージョンを「削除記録」として共有インデックスに付記し、アップロード側の端末は自端末のバージョンと異なる場合に編集を再送信
  - 送信応答の喪失に起因する不要ファイルを他端末が編集済みの場合の重複: アプリ終了中に名称変更されたノートを内容で特定し、不要ファイルを削除せず新名称へ移動
  - force-local 端末による旧内容での上書きを過去の通知と誤認する不一致: 該当時のみクラウドの現行バージョンを照会して判定
- 共有インデックスの付記情報: `deleted`（削除記録）と `merges`（各バージョンの統合元のバージョン）。後者はバージョンを置換された端末が統合済みの場合に上書き修復の競合コピーを抑止するためのもので、旧バージョンの項目を記録する端末の書込後も保持されます

並列実行の例（4 プロセス、シード範囲を分割）:

```bash
for i in 0 1 2 3; do SIM_SEEDS=25 SIM_SEED_BASE=$((1+i*25)) SIM_REPORT_DIR=out/$i \
  npm run test:sim -- tests/sim/settings-matrix.sim.test.ts & done; wait
```

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
- E2EE と大容量ファイルのバックグラウンド転送の組合せは `e2ee-large-files` シナリオで検査します（分割暗号化形式 VSC2 も復号して比較）。
