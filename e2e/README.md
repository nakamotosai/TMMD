# e2e · R12d 67 断言可复现脚本

R12d（F318）发版前全量验收的 CDP 断言跑道。目标：让“67 全绿”任何人可重跑。

## 原文还原 / 按 how 补写（必须先读）

- 分身会话 `ses_f5129617cffedaVeqTVugDajH6` 的 transcript 经 `session_read`
 （`include_transcript=true`，首尾分段）＋`session_search（cdp-eval）`实测：
  只返回工具名摘要（`[tool: bash/write/read/…]`），**未暴露任何脚本原文**，
  故原文还原率为 **0 行**。
- 本目录 `r12d-full.mjs` 的 67 断言**全部为“按 how 补写”**：依据
  `feature_list.json` F315–F318 的 `how` 字段＋R12d 收口报告＋`progress.md`
  “R12d 第四轮”一节的初判修正留痕（T04a/T08/T12c/T14/T30d/T31d/T22）逐条重建。
- 与分身当时执行手法的差异：分身是多轮 `scripts/cdp-eval.mjs` 单表达式调用
  序列（`scripts/` 全仓 ignored，不入库）；本脚本把同一 WS 直连手法收进单个
  runner，一次跑完、独立计分。断言语义对齐 F318 how，逐表达式写法可能不同。

## 前置（调试实例怎么起）

1. 构建并部署绿版（R12d 基线 exe 5554688B，哈希 C9D998…B825），直拷
   `C:\Users\sai\MD阅读器\TMMD\TMMD.exe`，`Get-FileHash` 对账一致。
2. 关掉普通实例（防单实例转发吃掉调试参数），再起调试实例：
   `pwsh -File scripts/debug-launch.ps1`（开 WebView2 CDP `:9223`）。
3. 确认 `http://127.0.0.1:9223/json` 有 `type=page` target。
4. 脚本开头只做连通性检查；**不通则 exit 2，不自动起实例**。

## 跑法

```powershell
node e2e/r12d-full.mjs            # 默认 --port=9223
node e2e/r12d-full.mjs --port=9223 --timeout=10000
```

- 每断言 `try/catch` 独立计分：`ok   A01 …` / `FAIL A05 … :: 原因`。
- 末尾打印 `通过数/总数＋失败清单`；有失败则 exit 1。
- 安全：17 键 `sr_*` 快照（tabs/recent/侧栏宽/主题/玻璃值等），`finally` 写回
  并 `location.reload()`；主题/draft 切换当场恢复；测试 md 建在 `os.tmpdir`
 （`r12d-<pid>-*.md`），用完即删。

## 67 断言分组表

| 组 | 断言号 | 数量 | 覆盖要点 |
|---|---|---|---|
| 顶栏 | A01–A07 | 7 | btnSide 存在/首位/非溢出/双切初值→翻转→恢复/品牌靠右（≈10px)/顶高 38 |
| 抽屉 | A08–A10 | 3 | 触发态淡底 alpha 0.16＋radius 7px/5 抽屉互斥/Esc 关 |
| 侧栏 | A11–A15 | 5 | 上下分/下半拖 180→240 落盘/宽拖 260→300/钳位 480/精简 190 恢复 |
| 空态 | A16–A17 | 2 | 打开文件夹/打开文件双按钮存在可点 |
| 设置整屏 | A18–A30 | 13 | 单例双向/Esc 全关/全宽＋顶 38/导航 208/搜索头 74/过滤藏→清空还原 12 行 6 区/`visibility:hidden` 藏底文/面板不透明/Esc 恢复/无宽滑条/sr_side_w=260 |
| 玻璃 | A31–A41 | 11 | 氛围弱 6/中 12/强 30（落盘干净）/真总开关零 toast/底色预览只进内存/取消回滚/应用提交复位 #26282e/字号 code 1.6·demo 2.1·read/旧存档前迁 |
| 标签 | A42–A47 | 6 | 三开/同路聚焦/切换/关中回退/Ctrl+W/Ctrl+Tab |
| 编辑 | A48–A52 | 5 | 非编辑 kbd 藏＋undo 禁/脏＋undo 可用/undo 值回滚/draft 切页恢复/黄项注记 |
| 拖入 | A53–A54 | 2 | DOM 合成 drop 不可达属预期/真链路 openExternal 同路（T20 同路） |
| 最近 | A55–A56 | 2 | 条目可读/只取十（≤10 行） |
| 树 | A57–A58 | 2 | 行渲染/右键打开·收藏菜单 |
| 主题 | A59 | 1 | dark（当前主题）往返，当场恢复 |
| 关联 | A60–A61 | 2 | `get_md_default` 实读 MarkText 语义/点击开系统页指引无错 |
| 窄窗 | A62–A64 | 3 | 687 自折/手动锁不误报/回宽 987 自展（纯自动回路＋恢复 toast 语义） |
| 溢出 | A65 | 1 | 窄窗 settings/玻璃搬进 #docMore（非隐藏语义，T30d 修正） |
| 引导 | A66–A67 | 2 | 引导 toast 原文可读/`sr_tb_guide_seen` 一次性 |
| 合计 | A01–A67 | 67 | 全绿 exit 0，否则 exit 1 |

初判修正留痕（断言侧，非代码，均已编入）：T04a 色值按 srgb/0.16 容差解析；
T08 按 resizer 真实坐标语义；T12c 选 `.setpage-search`；T14 藏底文语义为
`visibility:hidden`（CSS 设计如此）；T30d 溢出是搬进 `#docMore` 非隐藏；
T31d 手动展清 auto 旗故无恢复 toast（纯自动回路另测）；T22 DOM 合成 drop
不可达，真链路＝Tauri 原生 drop→openExternal。

## 已知黄项（非阻塞，只报不修）

- `editDirty` 脏标：undo 回滚到原文后 `S.editDirty` 仍 true（`doUndo` 不重算脏标，
  R12 前即有）。后果仅关页多一次 confirm，零丢数。A52 为注记型断言（恒过，
  仅记录现状）；**修完可删此注**（把 A52 改为严格断言 `editDirty===false`）。

## R12d 基线

- 构建哈希 C9D998…B825（与 R12c 同值＝源码零改动实证），exe 5554688B，
  部署 `C:\Users\sai\MD阅读器\TMMD\TMMD.exe` 双哈希一致。
- 三处版本 1.5.0 未动；CDP 67 全绿 0 失败；证据图
  `F:\archive\2026-09-17-tmmd-r12d-round4\`（repo 外，不过 git）。
- 本脚本与 `scripts/` 无关：`scripts/` 全仓 ignored，保持不入库。
