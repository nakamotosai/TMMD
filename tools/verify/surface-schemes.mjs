// surface-schemes.mjs — 「正文里的内容板」画法候选对照(给人工拍板用)。
//
// 背景:用户在玻璃模式下看到表格头/行内码/代码块都是**中性灰块**(实测 sRGB 44,43,41 → 彩度 C=3,
// 壁纸引导的底色也是 C=1),在照片壁纸上就是"压了一块灰"。本脚本在同一篇文档、同一窗口、同一浓度下
// 依次切候选画法,出**页面层真合成截图**(壁纸底注入页面,截图不透明),并同时算出每档的
// 板色 sRGB / 彩度 C / 色相 / 字对板对比度 —— 结论要么有像素要么有数字,不靠形容词。
//
// 用法(先起隔离调试实例,GUI 别在用户桌面上):
//   node tools/verify/surface-schemes.mjs --port=9243 --doc=%TEMP%\tmmd-lab\sandbox.md \
//        --backdrop=%TEMP%\tmmd-lab\backdrop.png --out=%TEMP%\tmmd-lab\shots
// 只读:只动隔离实例(改 localStorage 测试档 + 注入 <style>),不写用户目录、不改文档。

import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';

const args = process.argv.slice(2);
const arg = (k, d) => (args.find((a) => a.startsWith(`--${k}=`)) || `--${k}=${d}`).split('=').slice(1).join('=');
const port = arg('port', '9225');
const OUT = arg('out', `${process.env.TEMP}\\tmmd-lab\\shots`);
const DOC = arg('doc', '');
const GLASS = Number(arg('glass', 40));

mkdirSync(OUT, { recursive: true });
let targets;
try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); }
catch (e) { console.error(`CDP unreachable on :${port} (${e.message})`); process.exit(2); }
const page = targets.find((t) => t.type === 'page');
if (!page || !/tauri\.localhost/.test(page.url)) { console.error('不含 tauri.localhost 的页面目标 —— 拒绝驱动(防撞上用户浏览器)'); process.exit(2); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws connect failed')); });
let seq = 0;
const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
function send(method, params, ms = 20000) {
  const id = ++seq;
  return new Promise((res) => {
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); res({ __timeout: true }); } }, ms);
  });
}
async function val(expr, ms = 20000) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, ms);
  if (r.__timeout) throw new Error('evaluate timeout');
  if (r.result?.exceptionDetails) throw new Error('JS EXCEPTION: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 300));
  return r.result?.result?.value;
}

/* ─── 候选画法 ────────────────────────────────────────────────────────────────
 * 全部只碰「正文内容表面」(--code-plate / 表格线 / pre 底),不动 UI 控件那 20 多处 --surface-plate,
 * 也不改用户拍板的 --glass 浓度(板色一律按 calc(var(--glass) * k) 跟着滑条走)。 */

// 共用:去掉表格的整格灰网格,只留横向发丝线(表头一条稍亮)
const TABLE_HAIRLINE = `
.markdown-body table { border-collapse: collapse; }
.markdown-body th { background: none; border: 0; border-bottom: 1px solid var(--lab-hair-strong); }
.markdown-body td { border: 0; border-top: 1px solid var(--lab-hair); }`;

const SCHEMES = [
  ['01_current', '现行:中性灰板 + 整格网格', ''],

  ['02_warm_well', '暖阱:板混 16% 强调色 + 发丝线', `
:root {
  --lab-warm: color-mix(in oklab, var(--bg3) 84%, var(--accent) 16%);
  --lab-deep: color-mix(in oklab, var(--code-bg) 84%, var(--accent) 16%);
  --lab-hair: color-mix(in srgb, var(--border) 65%, transparent);
  --lab-hair-strong: color-mix(in oklab, var(--accent) 22%, var(--border));
  --code-plate: color-mix(in srgb, var(--lab-warm) calc(var(--glass) * .5), transparent);
}
.markdown-body pre { background: color-mix(in srgb, var(--lab-deep) calc(var(--glass) * .95), transparent);
  border: 1px solid var(--lab-hair-strong); }
${TABLE_HAIRLINE}`],

  ['03_deep_well', '深暖阱:板比周围更暗(凹进去)+ 发丝线', `
:root {
  --lab-well: color-mix(in oklab, #120f0c 86%, var(--accent) 14%);
  --lab-hair: color-mix(in srgb, var(--border) 60%, transparent);
  --lab-hair-strong: color-mix(in oklab, var(--accent) 26%, var(--border));
  --code-plate: color-mix(in srgb, var(--lab-well) calc(var(--glass) * .8), transparent);
}
.markdown-body pre { background: color-mix(in srgb, var(--lab-well) calc(var(--glass) * .92), transparent);
  border: 1px solid var(--lab-hair-strong); }
${TABLE_HAIRLINE}`],

  ['04_no_fill', '零填充:全去掉板,只留强调线与发丝线', `
:root {
  --lab-hair: color-mix(in srgb, var(--border) 55%, transparent);
  --lab-hair-strong: color-mix(in oklab, var(--accent) 30%, var(--border));
}
body.code-plate .markdown-body code { background-color: transparent; padding: 0 2px;
  background-image: linear-gradient(to top, color-mix(in oklab, var(--accent) 30%, transparent) 0 42%, transparent 42%); }
.markdown-body pre { background: none; border: 0; border-left: 3px solid color-mix(in oklab, var(--accent) 55%, transparent);
  border-radius: 0; padding: 8px 14px; }
${TABLE_HAIRLINE}`],

  ['05_warm_paper', '暖纸:板是极淡的米白(玻璃上贴纸)', `
:root {
  --lab-paper: color-mix(in oklab, var(--fg) 94%, var(--accent) 6%);
  --lab-hair: color-mix(in srgb, var(--fg) 10%, transparent);
  --lab-hair-strong: color-mix(in srgb, var(--fg) 18%, transparent);
  --code-plate: color-mix(in srgb, var(--lab-paper) calc(var(--glass) * .16), transparent);
}
.markdown-body pre { background: color-mix(in srgb, var(--lab-paper) calc(var(--glass) * .14), transparent);
  border: 1px solid var(--lab-hair-strong); }
.markdown-body th { background: none; border: 0; border-bottom: 1px solid var(--lab-hair-strong); }
.markdown-body td { border: 0; border-top: 1px solid var(--lab-hair); }`],

  ['06_deep_block_wash_inline', '深阱块 + 行内码改荧光笔(不再有芯片感)+ 发丝线', `
:root {
  --lab-well: color-mix(in oklab, #120f0c 86%, var(--accent) 14%);
  --lab-hair: color-mix(in srgb, var(--border) 60%, transparent);
  --lab-hair-strong: color-mix(in oklab, var(--accent) 26%, var(--border));
}
body.code-plate .markdown-body code { background-color: transparent; padding: 0 2px;
  background-image: linear-gradient(to top, color-mix(in oklab, var(--accent) 30%, transparent) 0 42%, transparent 42%); }
.markdown-body pre { background: color-mix(in srgb, var(--lab-well) calc(var(--glass) * .92), transparent);
  border: 1px solid var(--lab-hair-strong); }
${TABLE_HAIRLINE}`],
  ['07_final_v188', '定稿 v1.8.8:暖阱 + 发丝线(与 app.css 一致)', `
:root {
  --well: color-mix(in oklab, var(--bg2) 74%, var(--accent) 26%);
  --well-deep: color-mix(in oklab, var(--bg) 72%, var(--accent) 28%);
  --rule: color-mix(in srgb, var(--border) 70%, transparent);
  --rule-strong: color-mix(in oklab, var(--accent) 24%, var(--border));
  --code-plate: color-mix(in srgb, var(--well) calc(var(--glass) * .9), transparent);
}
.markdown-body pre { background: color-mix(in srgb, var(--well-deep) calc(var(--glass) * .95), transparent); border: 1px solid var(--rule-strong); }
.markdown-body code:hover { background-color: color-mix(in srgb, var(--well) calc(var(--glass) * .55), transparent); }
.markdown-body table { border-collapse: collapse; }
.markdown-body th, .markdown-body td { border: 0; padding: 7px 12px; }
.markdown-body th { background: none; border-bottom: 1px solid var(--rule-strong); font-weight: 600; }
.markdown-body td { border-top: 1px solid var(--rule); }
.markdown-body tbody tr:first-child td { border-top: 0; }
`],
];

/* ─── 打开沙箱文档 ─────────────────────────────────────────────────────────── */
const winPath = (p) => p.replace(/\//g, '\\');
await val(`(() => { try { leaveEdit(); } catch (e) {} S.theme = 'dark'; S.palette = 'gruvbox'; S.glass = ${GLASS}; S.codeStyle = 'plate'; S.textOpa = 1;
  try { applySettings(); applyEnhance(); } catch (e) {} showPanel(null); return 1; })()`);
console.log(`-- 打开沙箱文档 ${DOC} (glass=${GLASS} codeStyle=plate)`);
const opened = await val(`(async () => {
  await invoke('open_path', { path: ${JSON.stringify(winPath(DOC))} });
  await openTab({ abs: ${JSON.stringify(winPath(DOC))}, kind: 'ext' });
  await new Promise((r) => setTimeout(r, 1000));
  const sc = document.querySelector('#reader');
  sc.scrollTo(0, 0);
  await new Promise((r) => setTimeout(r, 200));
  const pre = document.querySelector('.markdown-body pre');
  const tb = document.querySelector('.markdown-body table');
  // 视口只有 ~700 CSS 高:把 pre 顶推到 y≈60,表格才会落进可视区(否则截图下缘是空的)
  const abs = (el) => el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
  sc.scrollTop = Math.max(0, abs(pre) - 60);
  await new Promise((r) => setTimeout(r, 250));
  const p = pre.getBoundingClientRect(), t = tb.getBoundingClientRect();
  return { preY: Math.round(p.top), tableY: Math.round(t.top), x: Math.round(t.left), w: Math.round(t.width),
    vh: innerHeight, codes: document.querySelectorAll('.markdown-body code').length, body: document.body.className };
})()`, 25000);
console.log(`-- 正文:pre.y=${opened.preY} table.y=${opened.tableY} x=${opened.x} w=${opened.w} 行内码 ${opened.codes} 个`);

// 页面层留真 alpha(不能用透明底 override 之外的魔法:WebView2 默认会给回一层灰)
await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
{ // 隐藏桌面上的合成器会被节流:先空截一帧丢掉
  await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, clip: { x: 0, y: 0, width: 32, height: 32, scale: 1 } }, 30000);
}

// 取样口径:pre 与表格都在同一帧里(沙箱文档里代码块紧贴表格上方)
const CLIP = { x: Math.max(0, opened.x - 40), y: Math.max(0, opened.preY - 16), width: Math.min(1220, opened.w + 80),
  height: Math.min(760, opened.tableY - opened.preY + 210, opened.vh - Math.max(0, opened.preY - 16)) };

const MEASURE = `(() => {
  const toSrgb = (c) => { const cv = document.createElement('canvas').getContext('2d'); cv.fillStyle = c; cv.fillRect(0, 0, 1, 1); const d = cv.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3]]; };
  const lum = (p) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(p[0]) + 0.7152 * f(p[1]) + 0.0722 * f(p[2]); };
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return Math.round(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)) * 100) / 100; };
  const pick = (sel, prop = 'backgroundColor') => { const e = document.querySelector(sel); return e ? getComputedStyle(e)[prop] : null; };
  const info = (name, bgStr, fgStr) => {
    const bg = toSrgb(bgStr), fg = toSrgb(fgStr);
    return { name, bg: bg.slice(0, 3), alpha: Math.round((bg[3] / 255) * 100) / 100, C: Math.max(...bg.slice(0, 3)) - Math.min(...bg.slice(0, 3)),
      L: Math.round((bg[0] + bg[1] + bg[2]) / 3), contrast: ratio(fg, bg) };
  };
  const cls = getComputedStyle(document.body).color;
  return JSON.stringify({
    fg: toSrgb(cls).slice(0, 3),
    plate: info('行内码板', pick('.markdown-body code'), cls),
    pre: info('代码块底', pick('.markdown-body pre'), cls),
    th: info('表头底', pick('.markdown-body th'), cls),
    td: info('表体底', pick('.markdown-body td'), cls),
    tableBorder: pick('.markdown-body td', 'borderTopColor'),
  });
})()`;

const measure = async () => JSON.parse(await val(MEASURE));
const rows = [];
for (const [file, label, css] of SCHEMES) {
  await val(`(() => {
    document.getElementById('__labScheme')?.remove();
    ${css ? `const s = document.createElement('style'); s.id = '__labScheme'; s.textContent = ${JSON.stringify(css)}; document.head.appendChild(s);` : ''}
    return 1;
  })()`);
  await new Promise((r) => setTimeout(r, 260));
  const m = await measure();
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, clip: { ...CLIP, scale: 1 } }, 30000);
  if (!shot.result?.data) { console.error(`capture failed for ${file}: ${JSON.stringify(shot).slice(0, 180)}`); process.exit(1); }
  writeFileSync(`${OUT}\\${file}.png`, Buffer.from(shot.result.data, 'base64'));
  rows.push({ file, label, ...m });
  console.log(`  ${file.padEnd(26)} 行内码板 rgb(${m.plate.bg}) C=${m.plate.C} α=${m.plate.alpha} 对比 ${m.plate.contrast}:1 | 代码块 rgb(${m.pre.bg}) C=${m.pre.C} | 表头 rgb(${m.th.bg}) C=${m.th.C}`);
}


/* ─── 主题矩阵:同一套新 token 在四个配色下的取值,以及"合成到壁纸上"之后的彩度与字对比 ───
 * 只看 computed 值会骗人:旧 --code-plate 的 rgba 明明带暖意,合成到壁纸上还是灰 —— 那正是失败的真因,
 * 所以这里必须**先合成再判**(backdrop 取用户截图那条壁纸 31,32,31;另加一块亮底 205,205,200 看最坏情况)。 */
console.log('-- 主题矩阵(合成后口径;亮底=最坏情况)');
const comp = (c, a, bd) => c.map((v, i) => Math.round(a * v + (1 - a) * bd[i]));
const conv = (p) => (p.length === 3 ? p.concat(1) : p);
const lum = (p) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(p[0]) + 0.7152 * f(p[1]) + 0.0722 * f(p[2]); };
const cr = (a, b) => Math.round(((Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05)) * 100) / 100;
for (const [theme, palette] of [['dark', 'gruvbox'], ['dark', 'charcoal'], ['light', 'gruvbox'], ['light', 'paper']]) {
  await val(`(() => { S.theme = ${JSON.stringify(theme)}; S.palette = ${JSON.stringify(palette)}; S.glass = ${GLASS}; applySettings(); showPanel(null); return 1; })()`);
  await new Promise((r) => setTimeout(r, 180));
  const m = await measure();
  const fg = m.fg;
  const line = ['plate', 'pre'].map((k) => {
    const [c, a] = [m[k].bg, m[k].alpha];
    const d = comp(c, a, [31, 32, 31]), b = comp(c, a, [205, 205, 200]);
    return `${k} rgb(${c})α${a} → 暗底 C${Math.max(...d) - Math.min(...d)} ${cr(fg, d)}:1 / 亮底 C${Math.max(...b) - Math.min(...b)} ${cr(fg, b)}:1`;
  }).join('  |  ');
  console.log(`  ${(theme + '/' + palette).padEnd(16)} ${line}`);
}
await val(`(() => { S.theme = 'dark'; S.palette = 'gruvbox'; applySettings(); return 1; })()`);

writeFileSync(`${OUT}\\metrics.json`, JSON.stringify({ clip: CLIP, geo: opened, dpr: await val('devicePixelRatio'), rows }, null, 1), 'utf8');
await val(`(() => { document.getElementById('__labScheme')?.remove(); document.getElementById('__labBackdrop')?.remove(); return 1; })()`);
console.log(`== ${SCHEMES.length} 张(真合成)→ ${OUT} ==`);
ws.close();
process.exit(0);
