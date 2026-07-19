# progress · Sai MD Reader（桌面）

> 最新在上。每会话收工 append 一节。

## 2026-07-19 · promote + 迁移 long-kit

- **done**：
  - 工程从 `C:\Users\sai\sai-md-reader-desktop` robocopy 到用户点名根 `C:\Users\sai\MD阅读器\MD阅读器tauri`（排除 target/node_modules）
  - 写入 long-kit：`PROJECT.md` / `feature_list.json` / `progress.md` / `milestones.md`
  - 版本写死：**1.0=本机阅读器（当前）**；**1.1=SSH 固定根 vps-jp/us**；终端 = magi **VETO 内嵌**，最早 1.2 外挂系统终端
  - `scripts/sync-ui.ps1` Dest 改新根；README 版本线与命令路径更新
  - 旧根写 `MOVED.md` 跳转
- **feature_id**：F005（进行中→本会话收口）、F006（双远端）
- **passes 变更**：F001–F004 保持 true（T0/t0.1 已有核验）；F005/F006 本会话核验后翻 true
- **next**（唯一）：**F010 规划前的用户手测 1.0**（选知识库、侧栏滚动、外部改 md 够新）；下一开发会话再开 **F010 = 1.1 SSH 只读固定根**（勿塞终端）
- **blockers**：用户侧 UAT 未书面确认；中文路径下完整 `cargo build` 以本机会话结果为准
- **终端结论（magi 2026-07-19）**：1.0/1.1 **禁止**内嵌终端标签；需要便利 → 1.2+ 外挂 Windows Terminal；与「简单阅读器」+ path-cage 安全模型冲突
- **portfolio 建议下一句**（不代写台账）：`Sai MD Reader 桌面 · C:\Users\sai\MD阅读器\MD阅读器tauri · 1.0 本机 / 1.1 SSH · active`
- **放置**：用户点名路径优先，非 F 盘默认；非 claude 临时区

## 2026-07-19 · 此前（旧根）T0 / t0.1

- **done**：Tauri 2 IPC、桌面桥、侧栏滚动+mtime 排序修复；debug exe ~13MB；SPECS task Phase 0–4 代码项
- **feature_id**：F001–F004
- **next（当时）**：迁移 + long-project（本会话已执行）
