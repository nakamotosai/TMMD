<div align="center">

**🌐 作者 [Sai](https://saaaai.com) · 個人サイト [saaaai.com](https://saaaai.com)** — AI ワークフローとオープンソース

**[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md)**

</div>

# Sai Reader

![Sai Reader hero — Windows 向けローカルファースト Markdown リーダー](assets/readme/hero.svg)

Windows 向けのローカルファースト Markdown リーダー。Tauri 2（Rust + WebView2）で構築。高速・プライベート・完全オフライン —— あなたのノートがマシンの外に出ることはありません。

## 機能

- **マルチルートライブラリ** — 複数のローカルフォルダをドキュメントルートとして登録。サイドバーのファイルツリー（ディレクトリアウトライン付き）で各ライブラリを閲覧
- **ローカルファースト＆プライベート** — パスケージ（path-cage）付きの純粋なファイルシステムアクセス。クラウドなし・テレメトリなし・アカウントなし
- **完全な Markdown レンダリング** — [marked](https://github.com/markedjs/marked) による GitHub フレーバー Markdown、[KaTeX](https://github.com/KaTeX/KaTeX) による数式、[highlight.js](https://github.com/highlightjs/highlight.js) によるコードハイライト
- **内蔵エディタ** — 任意のドキュメントをその場で編集し、ディスクに保存
- **テーマ** — ライト/ダークテーマ切替、アクセントカラーのカスタマイズ
- **ターミナルで開く** — アクティブなライブラリルートで外部ターミナルを起動
- **ネイティブインストーラ** — Tauri が生成する NSIS + MSI バンドル

## スクリーンショット

<img src="assets/readme/screenshot.png" alt="Sai Reader スクリーンショット" width="100%">

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

> 追跡ルール：`skill://sai-long-project` + `skill://sai-closeout`；詳細は `progress.md`；プロジェクト台帳 vps `~/project-portfolio/projects.md`。

- **ステータス**：一時完了（2026-08-06 一時収口）
- **最新**：v1.2.1 リリース済み（ドラッグ・パフォーマンス修正・GH Release・トップページOSS欄掲載・レビュアー 8/8）
- **未解決残差**：①初画面の黒/編集の食い込み ②バージョン番号 ③透明度 ④背景色 go ⑤ツールバー二方式 ⑥上書き＋版番号自動発行
- **唯一 next**：ユーザーフィードバック後に残差レビュー
- **ミラー**：GitHub（SSOT）+ Gitea（セルフホスト）同 HEAD `d3a9705`

---

ミラー：[GitHub](https://github.com/nakamotosai/sai-md-reader) · Gitea（セルフホスト）
