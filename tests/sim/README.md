# 複数端末同期シミュレーション (tests/sim)

実機で複数端末を手で操作しなくても、「同期が終わらない」「遅い」「競合していないのに競合する」「編集が消える」といった
**複数端末でしか起きない不具合**を CI で見つけるためのテスト基盤です。

## 何をしているか

- 本物の `SyncManager` を N 台ぶん起動し、それぞれ独立した Vault を持たせて、1 つの共有モッククラウド（Google Drive 相当）に接続します。
- シード値から決まるランダムな操作列（作成・編集・削除・リネーム・バイナリ更新・同期・オフライン化）を、**仮想時計**の上で同時並行に実行します。
- 注入できる現実の揺らぎ:
  - 通信遅延（リクエスト／レスポンスそれぞれ）、一時的なネットワークエラー、**レスポンスだけ失われる**失敗（サーバー側は反映済み）
  - 端末のオフライン化
  - Obsidian のファイルイベント（create/modify/delete/rename）の遅延配送。同期エンジン自身の書き込みでもイベントが飛ぶ点まで再現
  - 端末ごとの時計ずれ（ファイル mtime）
  - OS ごとのファイル名の扱い: `windows`（大小文字を区別しない）、`macos`（大小文字＋Unicode NFC/NFD を区別しない）、`linux`、`real-fs`（CI ランナーの実ファイルシステム）
  - CRLF + BOM のテキスト（Windows 端末）、PNG 風バイナリ（CR/LF/NUL を含む）
- 最後にネットワークを正常化して全端末を同期させ、次の不変条件を検査します。

| 種別 | 意味 |
|---|---|
| `HANG` | 同期が終わらない（デッドロック／無限リトライ） |
| `NO_CONVERGE` | 正常なネットワークで何ラウンド同期しても変化が止まらない（ピンポン） |
| `DIVERGED` | 端末間・クラウドでファイル内容が一致しない |
| `NOT_IDLE` | 収束後も dirty / pendingConflict が残る（毎回再同期される） |
| `SLOW_IDLE` | 何も変わっていない同期で API 呼び出しが予算を超える |
| `SYNC_ERROR` | 正常なネットワークで同期が例外を投げる |
| `FALSE_CONFLICT` | 重ならない編集なのに競合コピーができた |
| `LOST_UPDATE` | ユーザーの編集が最終状態から消えた／マージで行が重複した |
| `DUPLICATE` | 1 つのノートが複数ファイルに分裂した |
| `DATA_LOSS` | 誰も削除していないノートが全端末から消えた |

## シナリオ

`multi-device.sim.test.ts` の `SCENARIOS`:

- `clean-network` / `clean-network-instant-events`: 正常なネットワーク。各端末はノートの「自分の行」だけを編集（＝正しいエンジンなら必ず競合なしでマージできる）
- `flaky-network`: モバイル回線想定（遅延・失敗・オフライン・時計ずれ）
- `cross-os`: Linux + Windows + macOS 端末を 1 つの Vault で混在、CRLF/BOM、バイナリ添付
- `chaos`: 同じ行の編集・削除・リネーム・大文字小文字／NFD 衝突なんでもあり（終了・収束・データ消失のみ検査）
- `real-fs`: 実ファイルシステム上で実行。CI の OS マトリクスで NTFS / APFS / ext4 の違いを検出
- `large-files`: 大容量ファイルのしきい値を約 100 バイトにして、添付や大きくなったノートをバックグラウンド転送（分割アップロード・後回しのダウンロード）に回す。通信は不安定
- `restart`: 同期中・バックグラウンド転送中・未送信の編集がある状態など、ランダムな瞬間にアプリを強制終了して再起動する。再起動後は保存済みの状態だけで起動時同期（Vault スキャン付き）を行い、すべて復旧できることを検査。終了した世代の処理は以後のファイル操作・クラウド操作で例外になる。未解決の既知ケース: seed 135, 143, 258, 278（100〜299 の範囲）

## 使い方

```bash
npm run test:sim                                   # 全シナリオ × 10 シード + 既知バグ + ハーネス自己テスト
SIM_SEEDS=200 npm run test:sim                     # シードを増やす
SIM_SEED=13 SIM_SCENARIO=cross-os npm run test:sim -- tests/sim/multi-device.sim.test.ts   # 1 件を再現
SIM_SEED=13 SIM_SCENARIO=cross-os SIM_MINIMIZE=1 npm run test:sim -- tests/sim/multi-device.sim.test.ts
#   ↑ 失敗する操作列を自動で縮める（SIM_MINIMIZE_KIND=FALSE_CONFLICT で対象の失敗種別を指定）
```

同じシードは**どのマシン・どの OS でも同じ結果**になります（仮想時計、乱数の固定、gzip の同期化による）。

失敗すると `test-results/sim/` に次が出力されます（CI では Artifact としてダウンロード可能、Job Summary に一覧と再現コマンド）。

- `<scenario>-seed<N>.log` … 全端末のログ・ユーザー操作・ファイルイベント・クラウド呼び出しを時刻順に並べたタイムライン
- `<scenario>-seed<N>.json` … 設定、操作列、各端末の最終状態（ファイル・index・localIndex・dirty）、クラウドの最終状態
- `*.min-plan.json` … 最小化した操作列（`SIM_MINIMIZE=1` のとき）

## 性能ベンチマーク（`perf.test.ts`）

ランダムではない固定の作業（新規 60 ノート＋画像 6 枚の push → 2 台目の初回同期 → 30 件の編集 → 15 件を両端末で別の行を編集して自動マージ → アイドル同期）を、
1 回の API 呼び出しに往復 200ms かかる回線で実行し、フェーズごとの**待ち時間（仮想時間）と API 呼び出し回数（メソッド別）**を
`test-results/sim/perf.txt` / `perf.json` に出力します。全端末が収束し競合コピーがないこと、呼び出し回数が予算内であることも検査します。

```bash
npm run test:sim -- tests/sim/perf.test.ts && cat test-results/sim/perf.txt
```

## 見つけたバグを固定する

`known-bugs.test.ts` に、最小化した操作列を**決定的な再現テスト**として置いています。
各テストは「バグがまだ再現すること」を確認し、直ると「no longer reproduces」で失敗します。
そのときはケースを `FIXED_REGRESSIONS` に移すと、以後は「再発しないこと」のテストになります。

## CI

- PR（`.github/workflows/test.yml` の `simulation` ジョブ, ubuntu/macOS/Windows）:
  既知バグ再現テストとハーネス自己テストは必須、ランダムシミュレーション（10 シード/シナリオ）は既知バグ修正までは非ブロッキング。
  リポジトリ変数 `SIM_STRICT=true` でブロッキングにできます。
- 毎晩（`.github/workflows/sim-nightly.yml`）: 3 OS × 200 シード/シナリオ、毎晩違うシード。手動実行でシード数・シナリオ・最小化を指定可能。

## 限界

- クラウドは `MockCloudAdapter`（インメモリ）。Changes API は Google Drive と同じく「ファイルごとに最新の状態を 1 件だけ返す」形式です（`changesLatestStateOnly`）。ページングは `changesPageSize` で指定でき、性能ベンチでは 25 件/ページにしています。同名ファイルの重複作成・Changes API の遅延・レート制限はまだ模していません。
- 時計ずれはファイル mtime のみ。エンジン内部の `Date.now()`（マージロックの期限など）は全端末で共通です。
- E2EE と大容量ファイルのバックグラウンド転送は未対象です。
