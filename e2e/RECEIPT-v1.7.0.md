# v1.7.0 实跑回执(2026-10-24)

- 基线:HEAD `94f29cd` + v1.7 未提交改动(`ui-reader/*`、`src-tauri/src/lib.rs`、`tauri.conf.json`、`permissions/md-fs.toml`)
- 实例:`F:\projects\tmmd\src-tauri\target\debug\tmmd.exe`(带 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223`)
- 命令:`node e2e/r12d-full.mjs --port=9223`
- 结果:**81/81 通过,失败 0**(A01–A67 原始回归 + V01–V14 v1.7 新能力)

## v1.7 新增断言(V01–V14)

| ID | 断言 |
|---|---|
| V01 | 预览页可开(含代码块与脚注的临时文件) |
| V02 | 脚注渲染:`sup.fn-ref` 角标 + `section.footnotes` 脚注区 |
| V03 | 代码块:复制按钮 + 行号列(两行代码 → 两个 `.code-line`) |
| V04 | 行号可关(`body.no-code-ln` → `.ln` display:none) |
| V05 | 文内查找:打开 + 命中计数 `1/n` |
| V06 | 文内查找:当前命中加 `.now`,索引前移 |
| V07 | 文内查找:关闭后高亮清空、查找条隐藏 |
| V08 | 库搜索:侧栏搜索视图与输入框就绪 |
| V09 | 排版:行宽/行高写入 `--measure` / `--line-h` |
| V10 | 排版:正文字体可切等宽(`body.body-mono`) |
| V11 | 材质下拉含 none/acrylic/mica 三选 |
| V12 | 文字整体透明度下限 70% |
| V13 | i18n 切英文再切回中文(静态界面文案随之切换) |
| V14 | 专注模式 / 无干扰模式开关生效 |

## 期间同步更新的既有断言(均为 UI 变更导致,非放水)

| ID | 原预期 | 现预期 | 原因 |
|---|---|---|---|
| A15 | 直接量精简档宽度 | 先 `applySideCollapsed(false)` | 窄窗自动折栏会让宽度恒 0,测的是精简档不是折叠态 |
| A25 | `12/6` | `26/7` | 设置页卡片化:12 行 6 区 → 26 行 7 区 |
| A62/A64 | 影子 `innerWidth=687` | `600` | 折栏阈值 780→640(旧值让小屏每次开机都折栏) |

## 已知未覆盖

- 窗口几何(`window.json` 写入/越界回落)与 `fs-changed` 自动重载没有断言:需要真实改窗尺寸/外部改文件,现有 CDP 跑道不驱动这两件事。
- 导出 HTML / 打印:`export_file` + `open_any` 只在代码层核对,未跑端到端(会真的拉起浏览器)。
