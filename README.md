# Sai MD Reader · 桌面（Tauri）

本地优先 Markdown 阅读器桌面壳。**生产根（用户点名）**：`C:\Users\sai\MD阅读器\MD阅读器tauri`  
前端 UI 源在本体树，构建后同步进本仓 `ui-dist/`。

| 项 | 值 |
|---|---|
| 产品 | Sai MD Reader |
| 包名 | `sai-md-reader` |
| identifier | `com.saaaai.mdreader` |
| **版本线** | **1.0** 本机读盘（当前）· **1.1** SSH 固定根（vps-jp / vps-us）· **1.2+** 外挂系统终端（不做内嵌 shell） |
| 本体 UI | `C:\Users\sai\MD阅读器\MD阅读器本体` |
| 公网壳 | https://md.saaaai.com/（空壳+PWA，不存你的 MD） |
| 旧路径 | `C:\Users\sai\sai-md-reader-desktop`（仅跳转，勿当 SSOT） |

## 版本（产品）

| 版本 | 范围 | 状态 |
|---|---|---|
| **1.0** | 本机多根库、path cage、mtime/排序、够新轮询、无浏览器 FS 再授权 | **当前** |
| **1.1** | 只读 SSH 固定远程根（仅 vps-jp / vps-us allowlist，非任意 URL） | 规划 |
| **1.2+** | 「在此库打开 Windows Terminal」外挂；**不做**应用内 xterm/pty | 可选 |
| 永不默认 | MD 上云、任意用户 URL 远程盘、同窗完整终端/IDE 化 | — |

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

Capabilities：`src-tauri/capabilities/default.json`  
**1.0 无** pty / shell / exec 类 IPC。

## 安全要点

- 路径囚笼：canonicalize(root)+join(rel) 不得逃逸
- 渲染层不能自由扫盘；只经登记根 + ACL 命令
- 密钥不进仓；远程只 1.1 固定主机、只读根
