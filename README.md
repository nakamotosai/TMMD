# Sai Workbench · 桌面（Tauri）

个人 vibe coding 工作台：多根 MD 库 + **当前库**系统终端 / Claude Code。  
**生产根**：`C:\Users\sai\MD阅读器\MD阅读器tauri`  
前端 UI：`MD阅读器本体` → `npm run sync-ui` → `ui-dist/`。

| 项 | 值 |
|---|---|
| 产品 | Sai Workbench（基座仍为 MD Reader 1.0） |
| 包名 | `sai-md-reader` |
| identifier | `com.saaaai.mdreader` |
| **版本线** | **1.0** 读库 · **2.0 MVP** 外部终端+Claude · **2.1** 独立窗内嵌（可选）· **1.1 SSH** 延后 |
| 本体 UI | `C:\Users\sai\MD阅读器\MD阅读器本体` |
| 公网壳 | https://md.saaaai.com/（仍是空壳阅读器，不存 MD） |
| 旧路径 | `C:\Users\sai\sai-md-reader-desktop`（MOVED） |

## 版本（产品）

| 版本 | 范围 | 状态 |
|---|---|---|
| **1.0** | 本机多根库、path cage、够新 | **基座已齐** |
| **2.0 MVP** | 侧栏「终端」「Claude」→ 外部 wt/PowerShell，cwd=已登记库根 | **当前** |
| **2.1** | 独立窗口 xterm+pty（与 MD 面隔离） | 规划 |
| **1.1** | SSH 固定根只读 | **延后** |
| 禁止 | 同 WebView 内嵌 shell；任意 URL 远程盘；MD 上云 | — |

长项目真相：`PROJECT.md` · `feature_list.json` · `progress.md`

## 依赖

- Rust / cargo（`C:\Users\sai\.cargo\bin`）
- Node.js + npm
- Python 3（`build_pages.py`）
- WebView2（Windows）

## 命令

```powershell
cd "C:\Users\sai\MD阅读器\MD阅读器tauri"
$env:Path = "C:\Users\sai\.cargo\bin;" + $env:Path

npm install
npm run sync-ui    # 本体 build_pages → 本仓 ui-dist
npm run dev        # tauri dev（先 sync-ui）
npm run build      # tauri build
```

## IPC（Rust → 前端 `invoke`）

| 命令 | 参数 | 返回 |
|---|---|---|
| `desktop_info` | — | `{ isDesktop, version, platform }` |
| `pick_folder` | — | `Option<{ path, name }>` |
| `list_md_tree` | `root` | `{ rootName, tree, flat }` · mtime · 文件优先排序 |
| `read_text` | `root`, `rel` | UTF-8 · path cage |
| `load_roots` / `save_roots` | roots | app 配置 `roots.json` |
| `open_in_terminal` | `root`, `runClaude` | 外部终端 cwd=**已登记**库根；可选启动 `claude` |

Capabilities：`src-tauri/capabilities/default.json`  
**2.0 有** `open_in_terminal`（外挂进程）；**仍无** 应用内 PTY。

## 安全要点

- 读库 path-cage：canonicalize(root)+join(rel) 不得逃逸
- 终端：只允许已登记库根作 cwd；shell 本身全权（Claude 可改任意路径——不假装 cage 限制 shell）
- MD 渲染面**不**持 PTY；密钥不进仓
