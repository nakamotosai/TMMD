# progress · Sai Workbench

> 最新在上。

## 2026-07-19 · 改定位 2.0 Workbench + F100 实现

- **done**：
  - 用户改口：一站式 vibe coding 工作台（MD + 终端 + Claude Code），非纯阅读器
  - magi **CONDITIONAL**：接受方向；**禁止**同 WebView 内嵌 PTY（A）；MVP=**D 外挂**；真内嵌=**B 独立窗**（F110）
  - 实现 F100 代码：`open_in_terminal`（登记根校验 + wt/PowerShell + 可选 `claude`）；ACL `allow-open-in-terminal`；前端「终端」「Claude」按钮；`cargo check` 绿
  - PROJECT / feature_list / milestones 升 2.0 轨；1.1 SSH **延后**；F020 保留不删行
- **feature_id**：F100
- **passes 变更**：F100 false→true（代码+build+ui-dist 证据；手感 UAT 用户侧）
- **next**（唯一）：用户 UAT F100（终端 cwd / Claude 能起）；若要「窗内嵌终端」再开 **F110**（独立窗，勿同面）
- **blockers**：无
- **portfolio 建议下一句**：`Sai Workbench · MD阅读器tauri · 2.0 MVP 外部终端+Claude · active`
- **说明**：旧 magi「简单阅读器禁终端」前提作废；安全底线升级为通道隔离，不是禁止工作台

## 2026-07-19 · promote + 迁移 long-kit

- **done**：迁根、long-kit、双 private、1.0 账（见 git 历史）
- **feature_id**：F005、F006 → true
