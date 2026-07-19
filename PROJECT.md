# PROJECT · Sai Workbench（原 Sai MD Reader 桌面）

| 字段 | 内容 |
|---|---|
| 分型 | code |
| 根路径 | `C:\Users\sai\MD阅读器\MD阅读器tauri` |
| 放置理由 | **用户当轮点名绝对路径优先**；与 `MD阅读器本体` 同树并列 |
| 状态 | active |
| 当前里程碑 | **M4 = 2.0 Workstation MVP**（外部终端 + Claude）；1.0 阅读器能力保留 |
| 更新 | 2026-07-19 |

## 目标（一句话）

个人 **vibe coding 一站式工作台**：左侧多根 MD 库 + 在**当前库根**打开系统终端 / 启动 **Claude Code CLI**；本机优先，不为公网做远程 shell。

## 非目标（不做）

- MD 默认上云 / 任意用户 URL 远程盘
- **同 WebView 内嵌 xterm+pty**（与 MD 渲染共 capability = RCE 面）— 真内嵌须独立窗+独立 capability（F110）
- 公网任意人可用的远程 shell 产品
- Electron 重壳、插件市场、图谱/第二大脑
- 用 `C:\Users\sai\claude\…` 当生产根

## 版本线

| 版本 | 内容 | 状态 |
|---|---|---|
| **1.0** | 本机 FS 读库 + path cage + 侧栏/够新 | **已交付**（阅读器基座） |
| **1.1** | SSH 固定根只读 vps-jp/us | **延后**（工作台 MVP 后） |
| **2.0 MVP** | 当前库一键**外部**终端 + 可选启动 `claude`；cwd=已登记库根 | **进行中 · F100** |
| **2.1+** | 可选：独立窗口内嵌终端（B 架构）；不与 MD 面合权 | 规划 · F110 |

## 架构（安全）

| 通道 | 能力 | 隔离 |
|---|---|---|
| 读库 | pick/list/read/roots · path-cage | 主 WebView |
| 终端 | `open_in_terminal` 仅 spawn **外部** wt/PowerShell | 不在 WebView 内持 PTY；cwd 必须已在 roots.json |

## 命令

| 用途 | 命令 |
|---|---|
| 安装 | `npm install`（PATH 含 cargo） |
| 同步 UI | `npm run sync-ui` |
| 开发 | `npm run dev` |
| 检查 | `cd src-tauri; cargo check` |
| 构建 | `npm run build` |
| 冒烟 2.0 | 打开库 → 点「终端」→ 系统终端 cwd=库根；点「Claude」→ 同窗启动 claude |

## 链接

- feature_list：`./feature_list.json`
- progress：`./progress.md`
- milestones：`./milestones.md`
- 本体 UI：`C:\Users\sai\MD阅读器\MD阅读器本体`
- SPECS：`F:\知识库\SPECS\md-reader-tauri-desktop-20260719\`
- Gitea origin：`ssh://git@vps-jp-gitea/sai/sai-md-reader.git`
- GitHub github：`https://github.com/nakamotosai/sai-md-reader.git`
- portfolio 建议下一句：`Sai Workbench · MD阅读器tauri · 2.0 MVP 外部终端+Claude · active`
