# tools/verify — 不打扰用户的验证工作流

这目录里三件套(外带一把尺),是 2026-10-25 那一串"把用户主屏弹爆"事故后固化下来的正确姿势。

| 脚本 | 作用 |
|---|---|
| `launch-on-secondary.ps1` | 起一个**看不见**的实例:窗口出生就在副屏、不进任务栏、不抢前台;同时隔离 config 与 WebView2 profile |
| `capture-secondary.ps1` | 抓副屏**真实合成像素**(含 DWM 材料),可顺带出亮度/对比/高频统计 |
| `contrast-bands.py` | **量尺**:按横条算"窗内最亮壁纸带"的中位/最坏对比度(遮蔽掉不透明配图);CHANGELOG 里的对比度数字由它产出 |
| `code-style-shots.mjs` | 出"行内代码画法"对照截图:五档(旧版/荧光笔/下划线/无痕/薄底)各截一张页面真截图,`--backdrop <png>` 时把壁纸底贴进页面 → 截出来就是真合成 |
| `halo-strength.mjs` | 文字晕**强度分档**取样:同一段正文只改 `--halo-k`,出 RGBA 页面层截图(配套 Python 合成 + 量"字外 1–3px 环被压暗多少") |
| `code-style-preview.py` | 把上面那批截图拼成一张带标签的对照图(拍板用);`--backdrop-out` 可只导出"无文字边缘取样 + 拉伸模糊"的壁纸底 |
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

# 2) 启动器已自动喂一篇文档(仓库 README)——隔离 profile 起在"全新安装"空态,而跑道里有些
#    步骤假定屏上有正文;没有这篇它们会**卡住**(不是失败,是阻塞)。刻意要测空态时加 -NoSeed。
#    手动补喂(排障用):
node tools/verify/probe.mjs --port=9225 "(async()=>{await openExternal('F:\\projects\\tmmd\\README.md');await new Promise(r=>setTimeout(r,1500));return 'tabs='+S.tabs.length})()"

# 3) 跑自动化跑道(顺序即依赖:每条自己收尾,别乱序)
node e2e/r12d-full.mjs     --port=9225     # 81 条全量回归
node e2e/r12e-editor.mjs   --port=9225     # 25 条编辑链
node e2e/r12f-v18.mjs      --port=9225     # 61 条 v1.8(含 i18n 覆盖度/大文件/帧率/文字晕+拖动条/内容板)
node e2e/r12g-visual24.mjs --port=9225     # 24 条视觉检查表

# 4) 排障:一行读运行态(不弹窗、不改文件)
node tools/verify/probe.mjs --port=9225 "S.cur && S.cur.abs"
node tools/verify/probe.mjs --port=9225 "JSON.stringify({editing:S.editing, tabs:S.tabs.length})"

# 5) 需要看图时抓一张(含统计)
powershell -File tools/verify/capture-secondary.ps1 -Out $env:TEMP\shot.png -Stats

# 5b) 量对比度(两档浓度各抓一张,再相减遮蔽掉文档里的不透明配图):
#     先 probe 拿到 .markdown-body 的 rect 与 --fg,乘 dpr 换成副屏本地物理像素 → --band
#     (窗口物理原点看 %TEMP%\tmmd-verify-cfg\window.json;或按 launcher 打印的坐标)
node tools/verify/probe.mjs --port=9225 "(()=>{const r=document.querySelector('.markdown-body').getBoundingClientRect();return {dpr:devicePixelRatio,rect:[r.x,r.y,r.width,r.height],fg:getComputedStyle(document.documentElement).getPropertyValue('--fg').trim()}})()"
node tools/verify/probe.mjs --port=9225 "(async()=>{S.glass.conc=70;applyGlass();await applyGlassMaterial(true);return 'ok'})()"
powershell -File tools/verify/capture-secondary.ps1 -Out $env:TEMP\c70.png
python tools/verify/contrast-bands.py --png $env:TEMP\c40.png --mask-png $env:TEMP\c70.png \
    --band 921,211,920,1346 --fg "#e8e6e3"

# 6) 收尾
powershell -File tools/verify/stopall.ps1
```

## 隔离边界(别省)

启动器会设三个环境变量,把"测试实例"和"你的实例"彻底分开:

| 变量 | 作用 |
|---|---|
| `TMMD_CONFIG_DIR` | 覆盖配置目录(roots.json / window.json / update_state.json / updates/)→ 自动化**绝不碰**用户真实文库与窗口记忆 |
| `WEBVIEW2_USER_DATA_FOLDER` | 覆盖 WebView2 用户目录(localStorage / 标签恢复 / 缓存)→ 不继承用户真实标签;**每次启动清空**,跑道从"全新安装"起跑(默认值因此可断言) |
| `TMMD_TEST_NOACTIVATE=1` | `SW_SHOWNOACTIVATE` + `WS_EX_TOOLWINDOW`:不抢前台、不进任务栏 |

> 少了后两个之前踩过:测试实例一启动就把用户真实标签(`F:\knowledge\...`)恢复出来,用户看到"有人开了我的文件"。

## 启动器/收尾脚本的闸(2026-10-25 补,都是踩过才加的)

| 闸 | 触发 | 为什么 |
|---|---|---|
| 端口已有 CDP 就报错 | `Invoke-WebRequest http://127.0.0.1:<port>/json` 通 | 双实例共用一个隔离 profile 时,喂文档/探针会打到旧实例上,结论全是假的 |
| 有任意 `tmmd.exe` 存活就报错 | 应用注册了 `tauri-plugin-single-instance` | 单实例:第二次启动只把 argv 转给在跑的那个然后**直接退出**,窗口永不出现,启动器会干等到超时(实测 4 条核验全变成"launch failed") |
| 清空隔离 profile 失败就报错 | wipe 后目录仍存在 | 静默继续会让"全新安装默认值"的断言失去意义 |
| 自动喂一篇文档 | 默认行为,`-NoSeed` 关 | 隔离 profile 是空态,而跑道隐含"屏上有正文";不喂会**卡死**(不是失败) |

> 装了正式版又在跑时,起验证实例前先:`powershell -File tools/verify/stopall.ps1 -IncludeInstalled`
> (默认**不**碰装好的那台,`-IncludeInstalled` 才连它一起收掉 —— 这是单实例应用的刚需。)
>
> 更新通道核验:`python tools/verify/update-manifest-check.py`(真起实例、真读清单,含 BOM/篡改/真链路四例);
> 它依赖启动器的 `-UpdateEndpoint` 测试缝。

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

## 出"行内代码画法"对照图(拍板用,2026-10-25 加)

```powershell
# 1) 先起可见性可控的隔离实例(隐藏桌面或副屏都行),拿到端口
# 2) 壁纸底:从用户截图里**无文字边缘**取一条,拉伸 + 高斯模糊(近似 DWM acrylic)
python tools/verify/code-style-preview.py --shots x --wallpaper <用户截图.png> --out x `
    --backdrop-out $env:TEMP\backdrop.png --backdrop-size 1502x803
# 3) 五档真截图(注意参数用 `=` 形式);--backdrop 会把底贴成页面背景 → 截图即真合成
node tools/verify/code-style-shots.mjs --port=9237 --out=$env:TEMP\code-shots --backdrop=$env:TEMP\backdrop.png
# 4) 拼成一张对照图
python tools/verify/code-style-preview.py --shots $env:TEMP\code-shots --wallpaper <用户截图.png> --out docs/preview/code-styles.png
```

两个实测坑:1`--port/--out/--backdrop` 只认 `--k=v`(空格形式会被当默认值,静默跑错目录);
2隐藏桌面上合成器有节流,注入背景后**要先空截一帧**(脚本里已做)否则前一两张会缺那层底。

## 出"正文内容板画法"对照图(拍板用,2026-10-25 加)

内容板 = 表格底 / 行内码芯片 / 代码块底。这一档换方案时(`--surface-plate-strong` → `--well`),
只凭 computed 值会骗人:`rgba` 明明带暖意,合成到壁纸上还是灰 —— **必须先合成再判**。

```powershell
# 1) 隔离实例 + CDP 端口(同上一节)
# 2) 壁纸底要从用户截图**无文字边缘**取一条(脚本自己拉伸 + 高斯模糊)
# 3) 一次出多档 + 主题矩阵(computed 板色 / 合成后彩度 / 字对板对比)
node tools/verify/surface-schemes.mjs --port=9243 --doc=<沙箱.md> --out=$env:TEMP\tmmd-lab\shots
#    → 每档一张 RGBA 页面层截图 + metrics.json(clip/几何/dpr);脚本里 SCHEMES 是候选画法清单
# 4) 用 PIL 把 RGBA 截图 alpha_composite 到壁纸底上 → 对照图(这一步是"真合成")
```

三个实测坑:`clip` 取的是**CSS 像素**,截图是 `CSS × devicePixelRatio`(225% 屏上差 2.25 倍,取样会全错位);
`captureBeyondViewport:false` 只能截到**可视区**,表格在折叠线以下时截出来是空的(脚本先把 pre 顶推到 y≈60);
`SCHEMES` 里插入新档时别用 Python f-string —— `${...}` 会原样落进 JS(踩过一次)。

## 量"文字晕该多淡"(2026-10-25 加)

晕是**局部对比**(亮背景上字要靠它才读得清),但太重会显脏 —— 两侧都要量,只凭眼睛调会来回摆。

```powershell
node tools/verify/halo-strength.mjs --port=9243 --doc=<md> --out=%TEMP%\tmmd-halo\shots
#   → k0 / k0p35 / k0p55 / k0p7 / k1 五张 RGBA 截图 + meta.json(含 clip 与每档 computed text-shadow)
# 合成 + 指标(PIL):
#   ① 字形掩膜:拿 k=0 那一档的**亮度**切(暗底上字 ~235 / 底 ~35),再腐蚀=字心、膨胀 7 减字形=紧邻环
#   ② 指标:紧邻环的平均压暗 ΔL(相对 k=0)= "晕有多重";同档的 环被压暗 / 全强度被压暗 = "拿到几成收益"
#   ★ 别用 alpha 通道切字形:页面层整幅都被 body 玻璃画过,alpha 到处都是 1(2026-10-25 踩过,数字全错)
```

实测(亮底合成样本,紧邻环平均压暗):0%/0.35/0.55/0.7/1.0 → 0 / 1.62 / **2.34(默认)** / 2.76 / 3.55 ΔL，
即 55% 拿到 66% 的收益。合成脚本同上一节;`--halo-k` 要**连 token 定义一起注入**（装机版里的 --text-halo 是写死 alpha 的字面量,只塞变量不生效）。
