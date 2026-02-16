# VaultSync (Obsidian Cloud Sync)

[ [🇺🇸 English](README.md) | [🇯🇵 日本語](README_ja.md) ]

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub Release](https://img.shields.io/github/v/release/c-ardinal/obsidian-vault-sync?label=Release&logo=github)](https://github.com/c-ardinal/obsidian-vault-sync/releases)
[![CI Status](https://img.shields.io/github/actions/workflow/status/c-ardinal/obsidian-vault-sync/test.yml?branch=main&label=CI&logo=github-actions)](https://github.com/c-ardinal/obsidian-vault-sync/actions/workflows/test.yml)
[![Platform: Windows | MacOS | Linux](https://img.shields.io/badge/Platform-Windows%20%7C%20MacOS%20%7C%20Linux-lightgrey)](#)

Obsidian向けの高速・インテリジェントなクラウドストレージ同期プラグインです。  
Google Driveを活用し、PCとモバイルデバイス（iOS/Android）間での強固なデータ一貫性と高速な同期体験を提供します。

---

## ⚙️ 動作環境

- **Obsidian**: v0.15.0 以上
- **Google アカウント**: Google Drive API を利用するために必要
- **ネットワーク**: インネット接続環境（同期実行時）

---

## ✨ 主な特徴

- **インテリジェント同期 (Index Shortcut)**: クラウド上のマスターインデックスを共有。変更がない場合は全走査をスキップし、バッテリーと通信量を節約します。
- **高速差分検知 (MD5 Adoption)**: インデックスが未作成の状態でも、ファイルのMD5ハッシュを計算して照合。一致すれば無駄なダウンロードを行わず即座に採用します。
- **スマート・マージ (3-way Merge)**: 複数デバイスで同時に編集された場合、共通の祖先（Ancestor）を基に可能な限り自動マージを行います。競合時はロック制御（communication.json）により安全に保護されます。
- **履歴・差分表示 (Revision History)**: Google Drive上のファイルリビジョンを取得し、ローカルとの差分表示や過去バージョンの復元が可能です。
- **モバイル最適化**: 基盤に `fetch` APIを採用し、デスクトップ/モバイルの両方で動作。編集停止時や保存時の自動同期、レイアウト変更トリガー（タブ切り替え時）を搭載。
- **詳細な同期設定**: `.obsidian` 内の設定、プラグイン、外観、ホットキーなどを個別に同期するか選択可能。キャッシュや一時ファイルは自動で除外されます。
- **安全な認証 & 保存**: PKCEを用いたOAuth2認証。認証情報は設定ファイルから分離され、OS標準のセキュアなストレージ（Keychain/Credential Manager）を活用して安全に保存されます。
- **エンドツーエンド暗号化 (E2EE)**: [E2EE Engine](https://github.com/c-ardinal/obsidian-vault-sync-e2ee-engine) を導入することで、Vault データをクライアント側で暗号化できます。アップロード前に暗号化、ダウンロード後に復号され、クラウド上に平文が残ることはありません。

---

## 📖 使い方

### 同期の実行

- **リボンアイコン**: 画面左側のツールバーにある同期アイコンをクリックすると、スマート同期が開始されます。
- **コマンドパレット**: `Ctrl+P` (または `Cmd+P`) を押し、`VaultSync: Sync with Cloud` を選択します。
- **自動同期**: 設定により、ファイル保存時や編集の停止時、一定時間ごとに自動で同期が行われます。

### 履歴と復元

- **ファイル履歴**: ファイルを右クリックし、「クラウドの変更履歴を表示 (VaultSync)」を選択すると、Google Drive上の過去リビジョンとの比較が可能です。
- **高機能diffビューア**: Unified/左右分割表示の切り替え、行内差分のハイライト、差分箇所へのジャンプ機能（ループ対応）、表示コンテキスト行数の動的調整など、開発者ツール級の強力な比較機能を提供します。
- **フルスキャン**: 整合性に不安がある場合、コマンドパレットから `VaultSync: Audit & Fix Consistency (Full Scan)` を実行して強制的に同期状態をチェックできます。

---

## 🔧 同期エンジンの仕様

- **Conflict Resolution**: 3-way Mergeによる自動解決に加え、「スマートマージ」「ローカル優先」「クラウド優先」「常にフォーク」の戦略を選択可能です。自動解決できない場合はローカルファイルを `(Conflict YYYY-MM-DDTHH-mm-ss)` として退避します。
- **Selective Sync**: `.obsidian/` 内のファイル（プラグイン、テーマ、ホットキー等）をカテゴリ別に同期制御可能です。`workspace.json` や `cache/` など、デバイス固有のデータは自動的に除外されます。
- **Device Communication**: `communication.json` を通じてデバイス間でのマージロック制御を行い、同時に同じファイルを編集した際の上書きを防止します。
- **Atomic Updates**: 各ファイル転送完了ごとに個別のインデックスエントリを更新。インデックスはGzip圧縮され、効率的に同期されます。

---

## 🔒 プライバシーとセキュリティ

- **直接通信**: 本プラグインは外部のサードパーティサーバーを経由せず、直接 Google Drive API と通信します。
- **認証保護**: クライアントIDやトークン、暗号化シークレットなどの機密情報は、ObsidianのSecret Storage APIを介して、OS標準のセキュアストレージ（Keychain/Credential Manager）に直接保管されます。これにより、Vault内に機密情報を含むファイルが残ることを最小限に抑えます。なお、Secret Storageが利用できない環境や古いOSでは、自動的にデバイス固有の秘密鍵（AES-GCM）で暗号化されたローカルファイル保存へとフォールバックし、安全性を維持します。
- **データの所在**: 同期されたデータは、ユーザ自身の Google Drive 領域（指定したルートフォルダ）のみに保存されます。
- **※重要**: デフォルトでは、同期されるデータ（Markdownファイル等）は Google Drive へ**平文（暗号化なし）でアップロードされます**。Google Drive 自体のセキュリティモデル（HTTPS 転送、サーバー側暗号化）で保護されますが、サーバー側でデータを読み取ることが可能です。エンドツーエンド暗号化が必要な場合は、[VaultSync E2EE Engine](https://github.com/c-ardinal/obsidian-vault-sync-e2ee-engine) を導入してください。詳細は下記セクションをご覧ください。

---

## 🔐 エンドツーエンド暗号化 (E2EE)

VaultSync は、別途公開されているオープンソースの暗号化エンジンを通じて、オプションでエンドツーエンド暗号化に対応しています。

E2EE を有効にすると:

- すべてのファイルが **アップロード前にデバイス上で AES-256-GCM により暗号化** されます
- ダウンロード後は **ローカルで復号** され、クラウド側が平文を見ることはありません
- `vault-lock.vault` ファイルがマスターキーを保護します（パスワードから PBKDF2 で導出）
- スマート同期機能（3-way マージ、競合検出）は暗号化データでもシームレスに動作します
- パスワードを OS レベルのセキュアストレージに保存し、自動ロック解除も可能です

### セットアップ

1. [リリースページ](https://github.com/c-ardinal/obsidian-vault-sync-e2ee-engine/releases) から E2EE Engine をダウンロード
2. `e2ee-engine.js` をプラグインディレクトリに配置: `.obsidian/plugins/obsidian-vault-sync/`
3. Obsidian を再起動 — セットアップウィザードがパスワード作成と Vault 移行をガイドします

詳細、ビルド手順、暗号化仕様については **[VaultSync E2EE Engine リポジトリ](https://github.com/c-ardinal/obsidian-vault-sync-e2ee-engine)** をご覧ください。

---

## 🚀 セットアップ手順

本プラグインを利用するにあたり、Google Cloud Project を作成して **自分専用の Client ID / Client Secret** を取得する必要があります。
取得は無料です。

### 1. Google Cloud Project の作成

1. [Google Cloud Console](https://console.cloud.google.com/) にアクセスします。
2. 新しいプロジェクトを作成します。
3. 「APIとサービス」 > 「ライブラリ」から **Google Drive API** を検索し、「有効にする」を押します。

### 2. OAuth 同意画面の設定

1. **OAuth 同意画面の作成**:
    1. 「APIとサービス」 > 「OAuth 同意画面」 > 「概要」から「開始」を押します。
    2. アプリ情報を入力して下さい。User Type は「外部」を選択してください。
    3. 全て記入したら「作成」を押します。
2. **スコープの追加**: 1. 「データアクセス」から「スコープを追加または削除」を選択します。2. `.../auth/drive.file` （このアプリで使用する Google ドライブ上の特定のファイルのみの参照、編集、作成、削除）にチェックを入れます。3. 「更新」を押します。4. 画面下部の「Save」を押します。
3. ~~**認証期間の永続化**: ※テスト状態のままだと7日ごとに再認証が必要になります~~
    1. ~~「対象」から「アプリを公開」を押します。~~
    2. ~~「確認」を押します。~~
       ※正しい手続きを踏まずにアプリを公開すると、Googleから警告を受ける可能性があるため手順見直し中。

### 3. 認証情報 (Client ID / Secret) の作成

1. 「APIとサービス」 > 「認証情報」 > 「認証情報を作成」 > 「OAuth クライアント ID」を選択します。
2. アプリケーションの種類として **「ウェブ アプリケーション」** を選択します。
3. 「承認済みのリダイレクト URI」から「URIを追加」を押します。
4. `https://c-ardinal.github.io/obsidian-vault-sync/callback/` と入力します。
    - これは認証完了後にObsidianへ戻るための中継ページです。
      あなたのブラウザ上でのみ処理を行い、外部にデータを送信することは有りません。
    - ご自身で用意したサーバを指定しても問題ありません。
5. 「作成」を押します。
6. 生成された **クライアント ID** と **クライアント シークレット** をコピーします。
    - **重要**: クライアントシークレットは機密情報です。他人には絶対に教えないでください。

### 4. プラグインへの反映

1. Obsidian の設定 > 「VaultSync」を開きます。
2. IDとシークレットを入力し、「ログイン」ボタンを押します。
3. ブラウザが起動し、ログイン画面が表示されます。
4. ログインに成功すると自動的にObsidianへ戻ります。認証成功を知らせる通知が表示されれば完了です。
    - 自動的にObsidianに戻らない場合は、ブラウザ画面に表示される「Open Obsidian」ボタンを押して下さい。
    - ボタンを押しても戻らない場合は手動でObsidianアプリに切り替えてください。

---

## 🛠 開発とビルド

開発環境で実行、またはソースからビルドする場合：

### ビルド

```bash
npm run build
```

ビルド結果は `dist/obsidian-vault-sync/` ディレクトリ配下に以下の形式で出力されます。  
配布時はこのフォルダの中身をプラグインフォルダへコピーしてください。

- `main.js`
- `manifest.json`
- `styles.css`

---

## ⚠️ 免責事項

本プラグインはデータの同期を自動化しますが、
ネットワークエラーや予期せぬ競合によりデータが損失するリスクを完全に排除するものではありません。
**本プラグインの使用によって生じたいかなる損害（データ消失、Vaultの破壊など）についても、作者は一切の責任を負いません。**
重要なデータについては、本プラグインの導入前に必ずバックアップを取得し、
その後も定期的なバックアップを継続してください。

---

## ❓ よくある質問 (FAQ)

**Q: 同期アイコンが回転したまま止まらない。**  
A: 大量のファイルを同期しているか、ネットワークが不安定な可能性があります。  
通知メッセージを詳細にするか、設定画面からログ出力を有効にして詳細を確認してください。

**Q: 特定のフォルダ・ファイルを同期したくない。**  
A: 設定の「除外ファイル/フォルダ」に、globパターンで除外したいフォルダやファイル名を追加してください。
例えば`secret/**`と設定すると、`secret`フォルダおよびこのフォルダ配下のファイルが同期されなくなります。

**Q: モバイル版で認証後にアプリに戻りません。**  
A: ブラウザのセキュリティ設定により自動で戻れない場合があります。  
認証完了画面が表示されたら、手動でObsidianアプリに切り替えてください。  
それでも認証が完了しない場合は、設定画面の「手動認証モード」を試してください。

## ライセンス

MIT License
