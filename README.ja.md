<div align="center">

**🌐 作者 [Sai](https://saaaai.com) · 個人サイト [saaaai.com](https://saaaai.com)** — AI ワークフローとオープンソース

**[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md)**

</div>

# TMMD

![TMMD hero — Windows 向け透明ローカルファースト Markdown リーダー](assets/readme/hero.svg)

Windows 向けの透明ローカルファースト Markdown リーダー。Tauri 2（Rust + WebView2）で構築。高速・プライベート・完全オフライン —— あなたのノートがマシンの外に出ることはありません。

## 機能

- **マルチルートライブラリ** — 複数のローカルフォルダをドキュメントルートとして登録。サイドバーのファイルツリー(ディレクトリアウトライン付き)で各ライブラリを閲覧
- **ローカルファースト&プライベート** — パスケージ(path-cage)付きの純粋なファイルシステムアクセス。クラウドなし・テレメトリなし・アカウントなし
- **完全な Markdown レンダリング** — [marked](https://github.com/markedjs/marked) による GitHub フレーバー Markdown、[KaTeX](https://github.com/KaTeX/KaTeX) による数式、[highlight.js](https://github.com/highlightjs/highlight.js) によるコードハイライト、依存ゼロの**脚注**
- **読書の快適さ** — リーディングマップ(章ごとの路線図)、アウトラインのスクロール同期、ファイルごとの位置記憶、文書内検索(Ctrl+F)、**ライブラリ全文検索(関連度順 + ファイル別グルーピング)**、集中モード、没入モード、行幅 / 行高 / 本文フォントの調整
- **行儀のよいエディタ** — その場編集とアトミック書き込み(CRLF/BOM 保持)、外部変更の競合検出(上書き / キャンセル)、外部変更の監視、終了ガード(保存 / 保存しない / キャンセル)、新規 · 名前を付けて保存 · 名前変更 · ごみ箱へ削除、Tab と複数行インデント、Ctrl+H 検索置換、タブごとの Undo スタック、**タイプライタスクロール**(カーソルを画面の上三分之一に固定)
- **透過ウィンドウ** — フレームレスなアクリル / Mica ガラス、3 段階の雰囲気 + 色味ピッカー + 可読性の下限。Windows の透明効果オフやハイコントラスト時は自動で不透明へフォールバック
- **ウィンドウとトレイの作法** — ジオメトリを**モニタごとに物理ピクセルで記憶**、前回のモニタで開き、**子プロセスがコンソールウィンドウを一切点滅させない**、トレイアイコン(表示 / 非表示 / 終了。終了も未保存ガードを通る)
- **書き出し** — メディアを `data:` で内包した自己完結 HTML、および**PDF 直接書き出し**(ヘッドレス Chromium、追加依存ゼロ。Chromium が無い環境では可読なエラーを出し、黙って失敗しない)
- **タブと履歴** — ブラウザ風タブ + セッション復元、最近使ったファイル、ファイル単位のお気に入り
- **テーマ** — ライト/ダーク切替、3 パレット(charcoal / paper / gruvbox)、**UI は 中文 / English / 日本語**
- **自前アップデータ** — アプリ内で確認 → ダウンロード → SHA-256 検証 → サイレントインストール(サードパーティの更新フレームワークなし)。マニフェスト URL とダウンロード URL は本リポジトリの release アセットに固定
- **ネイティブインストーラ** — Tauri が生成する NSIS + MSI バンドル

## スクリーンショット

<img src="assets/readme/screenshot.png" alt="TMMD スクリーンショット" width="100%">

上の hero は実際の見た目をすでにプレビューしています —— サイドバーのファイルツリー、紙面風リーダーページ、コードブロックをアプリ自身のカラーパレットで描画。フルウィンドウのスクリーンショットは後ほど追加予定です。

## 必要環境

- Windows 10/11（WebView2 ランタイム。現代の Windows ではデフォルトでインストール済み）
- [Rust](https://rustup.rs/)（stable ツールチェーン）
- [Node.js](https://nodejs.org/) 18+

## ソースからのビルド

```powershell
npm install
npm run dev       # ホットリロード付き開発ビルド
npm run build     # リリースビルド → NSIS/MSI インストーラが src-tauri/target/release/bundle/ に生成
```

別途フロントエンドのビルド手順は不要：フロントエンドは `ui-reader/` にあり、そのまま埋め込まれます。

## アーキテクチャ

フロントエンド（`ui-reader/`）は素の HTML/CSS/JS によるシングルページ。Rust バックエンド（`src-tauri/`）は小さく能力が制限された IPC サーフェスを公開しています：

| コマンド | 説明 |
|---|---|
| `desktop_info` | アプリのバージョン / プラットフォーム情報 |
| `pick_folder` | ライブラリルートフォルダを選択 |
| `list_md_tree` | ルート配下の `.md` ファイルを一覧表示（名前 + mtime でソート） |
| `read_text` | ファイルを読み取り（パスケージで強制） |
| `load_roots` / `save_roots` | 登録済みライブラリルートを永続化（アプリ設定ディレクトリの `roots.json`） |
| `open_in_terminal` | 登録済みルートで外部ターミナルを起動 |

### セキュリティモデル

- **パスケージ**：すべてのファイル読み取りでルートを正規化し、ルートから外へ逃げるパスを拒否
- **最小特権**：IPC 権限は `src-tauri/capabilities/default.json` で宣言。WebView にネットワークアクセス権限はありません
- **シェルを埋め込まない**：ターミナルは独立した OS プロセスとして起動。WebView は PTY を保持しません

## サードパーティ表記

同梱のフロントエンドライブラリについては [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) を参照してください。

## ライセンス

[MIT](LICENSE) © 2026 nakamotosai

## ステータス・進捗（進捗管理ファイル · 2026-08-08 追記）

> 追跡ルール：`skill://sai-long-project` + `skill://sai-closeout`；詳細は `docs/CHANGELOG.md`；プロジェクト台帳 vps `~/project-portfolio/projects.md`。

- **ステータス**:アクティブ(v1.7.0 完結 2026-10-24 — 競合ギャップ分析のロードマップを全実装:タイポグラフィ/レイヤー/モーション刷新、素材三択(透過/Acrylic/Mica)+システム連動フォールバック、文書内検索、ライブラリ全文検索、脚注、コードコピーと行番号、集中/没入モード、HTML 書き出し+印刷、ウィンドウ位置記憶、UI 言語 zh/en/ja)
- **根拠**:`docs/2026-10-24-竞品与差距分析.md` · 変更履歴:`docs/CHANGELOG.md`
- **未解決残差**:1初画面の黒 2全面ガラス W0→W4(Mica ベース + Acrylic クローム) 3画像のインライン書き出し 4ライブラリ検索の並び替え/正規表現 5自動更新
- **ミラー**:GitHub(SSOT)+ Gitea(セルフホスト)双端同 HEAD(`git ls-remote` で核証)

---

ミラー：[GitHub](https://github.com/nakamotosai/TMMD) · Gitea（セルフホスト）
