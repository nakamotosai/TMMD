# PROJECT · Sai MD Reader（桌面 Tauri）

| 字段 | 内容 |
|---|---|
| 分型 | code |
| 根路径 | `C:\Users\sai\MD阅读器\MD阅读器tauri` |
| 放置理由 | **用户当轮点名绝对路径优先**（multi-root §判定顺序 1）；与 `MD阅读器本体` 同树并列，非 `C:\Users\sai\claude` 临时区 |
| 状态 | active |
| 当前里程碑 | **M1 = 产品 1.0 本机阅读器**（已交付代码）；下一里程碑 **M2 = 1.1 SSH 固定根** |
| 更新 | 2026-07-19 |

## 目标（一句话）

轻量本机优先的 Markdown 多根阅读器（桌面免浏览器再授权）；后续用固定 VPS 根扩展只读远程，不做成云笔记/IDE。

## 非目标（不做）

- MD 默认上云 / 任意用户 URL 远程盘
- 1.0 / 1.1 内嵌完整终端（xterm+pty）或 shell IPC
- Electron 重壳、插件市场、图谱/第二大脑
- 用 `C:\Users\sai\claude\…` 当生产根

## 版本线

| 版本 | 内容 | 状态 |
|---|---|---|
| **1.0** | 本机 FS IPC + path cage + UI 同步本体 + 侧栏滚动保持 + mtime/文件优先排序 + 够新 poll | **当前（代码已齐；手测 UAT 用户侧）** |
| **1.1** | SSH/固定根只读挂载 **vps-jp + vps-us**（allowlist）；无交互 shell | 规划 · 未开工 |
| **1.2+** | 可选：外挂「在此库打开系统终端」；内嵌终端默认不做 | 延后 |

## 命令

| 用途 | 命令 |
|---|---|
| 安装 | `npm install`（PATH 含 cargo） |
| 同步 UI | `npm run sync-ui` |
| 开发 | `npm run dev` |
| 检查 | `cd src-tauri; cargo check` |
| 构建 | `npm run build` |
| 冒烟 | 启动 exe → 选库 → 打开 md → 侧栏滚动不回顶 → 外部改 md 后刷新/等待 poll 见新内容 |

## 风险 / 约束

- 中文路径：`frontendDist` 用相对 `../ui-dist`；本体与桌面根均在 `MD阅读器\` 下，cargo 中文路径需本机验证
- 安全：path cage；1.1 仅固定主机只读；禁止任意远程 URL
- 双仓：桌面壳本根 + 本体 UI 根；改 UI 在本体 → sync-ui

## 链接

- feature_list：`./feature_list.json`
- progress：`./progress.md`
- milestones：`./milestones.md`
- 本体 UI：`C:\Users\sai\MD阅读器\MD阅读器本体`
- SPECS：`F:\知识库\SPECS\md-reader-tauri-desktop-20260719\`
- 公网：https://md.saaaai.com/
- Gitea origin（private）：`ssh://git@vps-jp-gitea/sai/sai-md-reader.git`
- GitHub github（private）：`https://github.com/nakamotosai/sai-md-reader.git`
- 双远端脚本：`~/.claude/skills/long-project/scripts/ensure-dual-remotes.ps1`
- portfolio 建议下一句：`Sai MD Reader 桌面 · 根 C:\Users\sai\MD阅读器\MD阅读器tauri · 1.0 本机 / 1.1 SSH 规划 · active`
