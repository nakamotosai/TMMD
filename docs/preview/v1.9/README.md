# v1.9 视觉核对材料

这三张是 **CDP 透明截屏 + 壁纸合成**，不是 DWM 实拍：

1. 用 `Page.captureScreenshot({ omitBackground: true })` 取窗口页面（保留 alpha）；
2. 把 Windows 自带壁纸（深色 `img19_1920x1200.jpg` / 浅色 `img0.jpg`）cover-crop 到同尺寸，`GaussianBlur(28)` 模拟亚克力模糊；
3. `Image.alpha_composite(壁纸, 窗口)` 合成。

用途：在只有一块屏的机器上核对正文纸面、铬层、正文列宽与边缘渐隐的层次。
**限制**：真实 Mica/Acrylic 的模糊与着色由 DWM 绘制，色相和模糊半径会与这里不同；这组图只能证明布局与 alpha 分层，不替代副屏实拍。

| 文件 | 状态 |
|---|---|
| `dark-top.png` | 深色 / 40% 浓度 / 滚动在顶部(仅底部渐隐) |
| `dark-scrolled.png` | 深色 / 滚到 320px(顶部与底部同时渐隐) |
| `light-top.png` | 浅色 / 40% 浓度 / 顶部 |
| `local-release-live.png` | **本地 release 版真窗口**(`PrintWindow` + PER_MONITOR_AWARE_V2):真实配置、真实窗口尺寸 2489×1496 物理(1245×748 CSS @2x)、打开 README.md。透明部分在截图里合成到黑底,所以底色比屏幕上更实 |

复现:启动隔离 debug 实例(`C:\Users\sai\.omp\data\tmmd-verify\run-tmmd-cdp.ps1`),注入同一份样例 Markdown,`syncReaderFade()` 后截图。
本地真窗口复现:`C:\Users\sai\.omp\data\tmmd-verify\show-tmmd.ps1`(在真实桌面启动 release 版),再用 `capture-tmmd-window.ps1` 截图。
**注意**:`capture-tmmd-window.ps1` 必须先在进程里声明 per-monitor DPI 感知,否则 2x 屏上 `GetWindowRect`/`PrintWindow` 会拿到虚拟化坐标,截出内容错位右移的假象(不是应用的问题)。
