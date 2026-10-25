# tools/verify — 不打扰用户的验证工作流

这目录里三件套,是 2026-10-25 那一串"把用户主屏弹爆"事故后固化下来的正确姿势。

| 脚本 | 作用 |
|---|---|
| `launch-on-secondary.ps1` | 起一个**看不见**的实例:窗口出生就在副屏、不进任务栏、不抢前台 |
| `capture-secondary.ps1` | 抓副屏**真实合成像素**(含 DWM 材料),可顺带出亮度/对比/高频统计 |
| `stopall.ps1` | 收尾:按命令行指纹杀净本流程起的进程 + 清临时脚本 |

## 一分钟跑法

```powershell
# 1) 起实例(先确认副屏已连上;没有副屏会直接报错,不会退化成"用主屏")
powershell -File tools/verify/launch-on-secondary.ps1 -Exe F:\projects\tmmd\src-tauri\target\debug\tmmd.exe -Port 9225

# 验收输出必须满足(否则别继续,先查原因):
#   FIRST visible real window: <副屏坐标>      ← 出生就在副屏
#   touchedPrimaryScreen=False                ← 全程没碰主屏
#   onSecondary=True
#   exStyle=... (含 0x80 = WS_EX_TOOLWINDOW)   ← 不进任务栏

# 2) 跑自动化跑道(顺序即依赖:每条自己收尾,别乱序)
node e2e/r12d-full.mjs     --port=9225     # 81 条全量回归
node e2e/r12e-editor.mjs   --port=9225     # 25 条编辑链
node e2e/r12f-v18.mjs      --port=9225     # 45 条 v1.8(含 i18n 覆盖度/大文件/帧率)
node e2e/r12g-visual24.mjs --port=9225     # 24 条视觉检查表

# 3) 排障:一行读运行态(不弹窗、不改文件)
node tools/verify/probe.mjs --port=9225 "S.cur && S.cur.abs"
node tools/verify/probe.mjs --port=9225 "JSON.stringify({editing:S.editing, tabs:S.tabs.length})"

# 4) 需要看图时抓一张(含统计)
powershell -File tools/verify/capture-secondary.ps1 -Out $env:TEMP\shot.png -Stats

# 5) 收尾
powershell -File tools/verify/stopall.ps1
```

## 隔离边界(别省)

启动器会设三个环境变量,把"测试实例"和"你的实例"彻底分开:

| 变量 | 作用 |
|---|---|
| `TMMD_CONFIG_DIR` | 覆盖配置目录(roots.json / window.json / update_state.json / updates/)→ 自动化**绝不碰**用户真实文库与窗口记忆 |
| `WEBVIEW2_USER_DATA_FOLDER` | 覆盖 WebView2 用户目录(localStorage / 标签恢复 / 缓存)→ 不会继承用户真实标签 |
| `TMMD_TEST_NOACTIVATE=1` | `SW_SHOWNOACTIVATE` + `WS_EX_TOOLWINDOW`:不抢前台、不进任务栏 |

> 少了后两个之前踩过:测试实例一启动就把用户真实标签(`F:\knowledge\...`)恢复出来,用户看到"有人开了我的文件"。

## 为什么窗口"出生就在副屏"

应用侧配合:`window.json` v2 存**物理像素**,启动时按坐标找到那块显示器并用它的工作区校验,**先摆好位置才 `show()`**(窗口以 `visible:false` 创建)。所以只要给副屏的 v2 几何,窗口第一帧就在副屏,不存在"先主屏闪一下再搬走"。

自动化专用环境变量 `TMMD_TEST_NOACTIVATE=1`:用 `SW_SHOWNOACTIVATE` 显示 + 打 `WS_EX_TOOLWINDOW`(摘掉任务栏按钮、不激活)。

## 硬规矩(违反就会被用户当场骂停)

1. **PS 脚本一律 ASCII**。Windows PowerShell 按 ANSI(本机 GBK)解码 `.ps1`,文件里写中文会串码并**吃掉换行**,报出莫名其妙的编译错。
2. **一次只发一条命令,每条尽量短(<40s)**。并发或长命令会走"临时 shell"/后台作业,那会在用户桌面上真弹一个可见终端。
3. **不要在自动化里起会弹 UI 的东西**(`cmd.exe`、安装器、系统对话框)。失败路径必须落**日志文件**,不能落对话框 —— 假安装包那次就是 `cmd.exe` 启动失败弹了系统错误框。
4. **测试脚本必须有沙箱护栏**:只允许在 tmp 沙箱文件上输入/保存(`e2e/r12e-editor.mjs` 的 `guardSandbox()`)。此前没护栏,把仓库 `README.md` 写成了一行。
5. **改过 `ui-reader/*` 必须先 `cargo build`** —— 前端是编译期嵌进二进制的,不重建跑的是旧 UI。
6. 收尾**必须**跑 `stopall.ps1`,并确认两条计数都是 0。

## 相关文档

- `docs/2026-10-25-验证清单.md`:当前哪些功能**还没跑过**、各自怎么验、更新器真装演练的安全步骤。
- `docs/CHANGELOG.md`:版本变更与"已完成/未验证"的明确标注。
