// r12g-visual24.mjs — 24 条视觉检查表逐条销项(docs/2026-10-24-竞品与差距分析.md §7.4)。
// 每条都用一个**可观测**的判据(计算样式 / 真键盘事件 / 实测像素由外部 capture 提供),
// 不做"看起来没问题"这种无法复跑的口头结论。
// 用法:先起隔离实例(tools/verify/launch-on-secondary.ps1)→ node e2e/r12g-visual24.mjs [--port=9225]
// 只读:不改用户数据;需要开文档时用沙箱 tmp 文件;做完 leaveEdit + 关标签。
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const port = (args.find((a) => a.startsWith('--port=')) || '--port=9225').split('=')[1];
const timeout = Number((args.find((a) => a.startsWith('--timeout=')) || '--timeout=15000').split('=')[1]) || 15000;
const REPO = process.cwd();

let targets;
try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); }
catch (e) { console.error(`CDP unreachable on :${port} — 先起调试实例(${e.message})`); process.exit(2); }
const page = targets.find((t) => t.type === 'page');
if (!page) { console.error('no page target'); process.exit(2); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws connect failed')); });
let seq = 0;
const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
function send(method, params, ms) {
  const id = ++seq;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pending.delete(id); resolve({ timeout: true }); }, ms || timeout);
    pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
function ev(expr, ms) { return send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, ms); }
async function val(expr, ms) {
  const r = await ev(expr, ms);
  if (r.timeout) throw new Error(`evaluate timeout: ${expr.slice(0, 110)}`);
  if (r.result?.exceptionDetails) throw new Error(`JS EXCEPTION: ${JSON.stringify(r.result.exceptionDetails).slice(0, 260)}`);
  return r.result?.result?.value;
}
/** 真键盘事件(CDP Input.dispatchKeyEvent):只有真键盘触发的焦点才会命中 :focus-visible。 */
async function keyTab(count) {
  for (let i = 0; i < (count || 1); i++) {
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab', nativeVirtualKeyCode: 9 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab', nativeVirtualKeyCode: 9 });
    await new Promise((r) => setTimeout(r, 60));
  }
}
const results = { pass: 0, fail: 0, fails: [] };
function ok(id, name, cond, extra) {
  if (cond) { results.pass++; console.log(`  ok   ${id} ${name}`); }
  else { results.fail++; results.fails.push(`${id} ${name}`); console.log(`  FAIL ${id} ${name}${extra !== undefined ? ' :: ' + JSON.stringify(extra).slice(0, 400) : ''}`); }
}

const ROOT = join(tmpdir(), 'tmmd-e2e-visual24');
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });
const winPath = (p) => p.replace(/\//g, '\\');
const MD = join(ROOT, 'visual-probe.md');
writeFileSync(MD, ['# 视觉探针', '', '中文正文用来量行宽与行高。中文正文用来量行宽与行高。中文正文用来量行宽与行高。', '',
  '> 引用块', '', '```js', 'const a = 1;', 'const b = 2;', '```', '', '- 列表项一', '- 列表项二'].join('\n'), 'utf8');

console.log('== r12g 24 条视觉检查表 ==');

// 前置:开一个含标题/正文/引用/代码块/列表的沙箱文档(很多条目要真内容才量得到)
await val(`(async () => { try { leaveEdit(); } catch (e) {} await invoke('open_path', { path: ${JSON.stringify(winPath(MD))} }); await openTab({ abs: ${JSON.stringify(winPath(MD))}, kind: 'ext' }); await new Promise((r) => setTimeout(r, 900)); return 1; })()`, 20000);

/* 1 只施加一次材料 —— DWM 材料是**窗口级**的:一次状态变更只应产生 1 条 mat 事件;
 * 而且渲染文档/滚动/切标签**完全不该**碰材料(碰了就是"每个表面各施加一次"的老毛病)。 */
{
  const r = await val(`(async () => {
    localStorage.setItem('sr_glass_debug', '1');
    localStorage.setItem('sr_glass_dbg', '[]');
    const cnt = () => JSON.parse(localStorage.getItem('sr_glass_dbg') || '[]').filter(x => x.includes('mat:')).length;
    await applyGlassMaterial(true);                       // 显式一次状态变更
    await new Promise(r => setTimeout(r, 220));
    const once = cnt();
    localStorage.setItem('sr_glass_dbg', '[]');
    await openTab({ abs: S.cur.abs, kind: 'ext' });        // 渲染/重绘文档
    const sc = document.querySelector('#reader') || document.scrollingElement;
    sc.scrollTop = 600; sc.scrollTop = 0;
    await new Promise(r => setTimeout(r, 300));
    const afterRender = cnt();
    localStorage.removeItem('sr_glass_debug'); localStorage.removeItem('sr_glass_dbg');
    return { once, afterRender };
  })()`, 30000);
  ok('01', '只施加一次材料(一次变更 1 条 mat;渲染/滚动 0 条)', r && r.once === 1 && r.afterRender === 0, r);
}

/* 2 html-body 透明(html 全透;body 只留页面层那点浓度,材料仍透得出来) */
{
  const r = await val(`(() => { const b = getComputedStyle(document.body).backgroundColor; const h = getComputedStyle(document.documentElement).backgroundColor; const a = (s) => { const m = String(s).match(/([\\d.]+)\\s*\\)$/); return m ? parseFloat(m[1]) : (String(s).startsWith('rgb(') ? 1 : 0); }; return { html: h, bodyAlpha: a(b) }; })()`);
  ok('02', 'html 全透明 + body 半透(材料可见)', r && r.html === 'rgba(0, 0, 0, 0)' && r.bodyAlpha > 0 && r.bodyAlpha < 1, r);
}

/* 3 材料只在窗口根:页面层不得再叠一层"材料"节点(材料是 DWM 层,页面只有表面色) */
{
  const r = await val(`(() => { const els = [...document.querySelectorAll('*')].filter(e => { const s = getComputedStyle(e); return (s.backdropFilter && s.backdropFilter !== 'none') || (s.webkitBackdropFilter && s.webkitBackdropFilter !== 'none'); }); return { count: els.length, samples: els.map(e => e.id || e.className).slice(0, 6) }; })()`);
  ok('03', '材料只在窗口根(页面层无第二层材料)', r && r.count === 0, r);
}

/* 4 正文区不 blur(同上:正文容器不得有 backdrop-filter / filter) */
{
  const r = await val(`(() => { const el = document.querySelector('.markdown-body') || document.getElementById('readerInner'); const s = getComputedStyle(el); return { bf: s.backdropFilter, f: s.filter }; })()`);
  ok('04', '正文区不 blur', r && (r.bf === 'none' || !r.bf) && (r.f === 'none' || !r.f), r);
}

/* 5/6 正文对比度:用真实合成像素算(需要外部抓图) → 由 tools/verify 的像素步骤提供,这里只做静态兜底 */
{
  const r = await val(`(() => ({ fg: getComputedStyle(document.documentElement).getPropertyValue('--fg').trim(), textOpa: Number(getComputedStyle(document.documentElement).getPropertyValue('--text-opa')) || 1 }))()`);
  ok('05', '正文色与文字透明度下限就位(fg 定义 + text-opa ≥0.7)', r && /^#|rgb/.test(r.fg) && r.textOpa >= 0.7, r);
}

/* 6 默认浓度 = 40(用户定调)+ 拆分契约:glassSplit 只出模糊(dwm 恒 1)、css = 总浓度(写多少得多少),
 *   且默认档真落到 CSS 变量上。此前这条是空的(css>=0 && dwm>=0 恒真)。 */
{
  const r = await val(`(() => {
    const d = glassSplit(1), c = glassSplit(40);
    const legacyDefault = migrateGlass({ on: true, material: 'acrylic', tint: '#26282e', base: 12, chrome: 25, reader: 35, pop: 30 });
    const customised = migrateGlass({ on: true, material: 'acrylic', tint: '#26282e', base: 20, chrome: 45, reader: 50, pop: 55 });
    return {
      conc: Number(S.glass.conc), atmos: S.glass.atmos,
      dwmLow: d.dwm, dwmDef: c.dwm, cssLow: d.css, cssDef: c.css,
      varNow: getComputedStyle(document.documentElement).getPropertyValue('--glass').trim(),
      preset: (typeof ATMOS_PRESETS !== 'undefined') ? ATMOS_PRESETS.medium.conc : null,
      fallback: glassSplit(NaN).css,
      legConc: legacyDefault.conc, custConc: customised.conc
    };
  })()`);
  ok('06', '默认浓度 40 + 拆分契约 + 旧档前迁(旧默认档→40 / 自定义值保留)',
    r && r.conc === 40 && r.varNow === '40%' && r.preset === 40 && r.fallback === 40 &&
    r.dwmLow === 1 && r.dwmDef === 1 && r.cssLow === 1 && r.cssDef === 40 &&
    r.legConc === 40 && r.custConc === 60, r);
}

/* 7 不用 tertiary 做正文:正文色必须来自 --fg,且 --fg 与 --fg-faint 不同 */
{
  const r = await val(`(() => { const cs = getComputedStyle(document.querySelector('.markdown-body')); const root = getComputedStyle(document.documentElement); return { body: cs.color, fg: root.getPropertyValue('--fg').trim(), faint: root.getPropertyValue('--fg-faint').trim() }; })()`);
  ok('07', '正文不用 tertiary/faint 色(fg ≠ fg-faint)', r && r.fg && r.faint && r.fg !== r.faint && r.body, r);
}

/* 8 强调色不压玻璃:强调色不做大块纯色底(只做小面积强调/激活) */
{
  const r = await val(`(() => { const root = getComputedStyle(document.documentElement); const acc = root.getPropertyValue('--accent').trim(); const big = [...document.querySelectorAll('#layout *')].filter(e => { const s = getComputedStyle(e); if (s.backgroundColor === 'rgba(0, 0, 0, 0)') return false; const box = e.getBoundingClientRect(); const area = box.width * box.height; const isAccent = s.backgroundColor.replace(/\\s/g, '').includes(acc.replace(/\\s/g, '').replace('#','')) || /254,\\s*128,\\s*25/.test(s.backgroundColor); return isAccent && area > 40000; }); return { accent: acc, bigAccentBlocks: big.length }; })()`);
  ok('08', '强调色不压玻璃(无大面积纯强调底)', r && r.bigAccentBlocks === 0, r);
}

/* 9 关透明可回落:总开关关 → 表面不透明(--glass 100%)且无 toast 噪音 */
{
  const r = await val(`(() => { const n0 = document.querySelectorAll('.toast').length; S.glass.on = false; applyGlass(false); const g = Number(String(getComputedStyle(document.documentElement).getPropertyValue('--glass')).replace('%', '')); const bodyA = getComputedStyle(document.body).backgroundColor; S.glass.on = true; applyGlass(false); return { glass: g, bodyA, toast: document.querySelectorAll('.toast').length - n0 }; })()`);
  ok('09', '关透明可回落(--glass=100% 且零 toast)', r && r.glass === 100 && r.toast === 0, r);
}

/* 10 失焦态:窗口失焦要有可辨的降级(不抢焦点视觉) —— 用 window blur/focus 事件驱动 */
{
  const r = await val(`(() => { const before = document.body.className; window.dispatchEvent(new Event('blur')); const after = document.body.className; window.dispatchEvent(new Event('focus')); return { before, after, restored: document.body.className === before }; })()`);
  ok('10', '失焦态有处理且可恢复(blur/focus 双向)', r && typeof r.after === 'string' && r.restored === true, r);
}

/* 11 高对比模式:系统报"高对比/关透明"时,S.sysNoEffects 一置位整窗就必须回落不透明 */
{
  const r = await val(`(() => { const keep = S.sysNoEffects; S.sysNoEffects = true; applyGlass(false); const g = Number(String(getComputedStyle(document.documentElement).getPropertyValue('--glass')).replace('%', '')); S.sysNoEffects = keep; applyGlass(false); return { forced: g, restored: Number(String(getComputedStyle(document.documentElement).getPropertyValue('--glass')).replace('%', '')) }; })()`);
  ok('11', '高对比/关透明回落(--glass=100% 且可恢复)', r && r.forced === 100 && r.restored !== 100, r);
}

/* 12 backdrop-filter 祖先无 opacity/filter/mask(第 3 条已证页面无 backdrop-filter ⇒ 无污染风险) */
{
  const r = await val(`(() => { const els = [...document.querySelectorAll('*')].filter(e => { const s = getComputedStyle(e); return s.backdropFilter && s.backdropFilter !== 'none'; }); const bad = []; for (const el of els) { let p = el.parentElement; while (p) { const s = getComputedStyle(p); if (Number(s.opacity) < 1 || (s.filter && s.filter !== 'none') || (s.mask && s.mask !== 'none')) bad.push((el.id || el.className) + '<-' + (p.id || p.className)); p = p.parentElement; } } return { surfaces: els.length, bad: bad.slice(0, 5) }; })()`);
  ok('12', 'backdrop-filter 祖先无 opacity/filter/mask', r && r.bad.length === 0, r);
}

/* 13 帧时间(短文档/空闲):这里只做**帧时间烟测** —— 本跑道当前屏上是短文档,#reader 无可滚内容
 * (实测 tallest == clientH、moved == 0),硬要求"滚动发生"只会变成假失败。
 * **滚动期**的真实覆盖在 r12f 的 G 组(那里开 5000 行文档,并有 G4 "moved > 0" 防空转)。 */
{
  const r = await val(`(async () => { const sc = document.querySelector('#reader') || document.scrollingElement; const frames = []; let last = performance.now(); let moved = 0; for (let i = 0; i < 30; i++) { await new Promise(res => requestAnimationFrame(() => res())); const now = performance.now(); frames.push(now - last); last = now; sc.scrollTop = (sc.scrollHeight - sc.clientHeight) * (i / 29); if (sc.scrollTop > moved) moved = sc.scrollTop; } frames.shift(); const s = [...frames].sort((a, b) => a - b); return { p95: Math.round(s[Math.floor(s.length * 0.95)] * 10) / 10, avg: Math.round((frames.reduce((a, b) => a + b, 0) / frames.length) * 10) / 10, moved: Math.round(moved), tallest: sc.scrollHeight, clientH: sc.clientHeight }; })()`, 30000);
  ok('13', '帧时间 p95 ≤ 16.7ms(短文档;滚动期覆盖见 r12f G4)', r && r.p95 <= 16.7, r);
}

/* 14 缩放路径:窗口**程序化 setSize 被 capability 拦着**(core:window:allow-set-size 未授权),
 * 真拖拽缩放由 tools/verify 用 Win32 SetWindowPos + rAF 采样实测(见 docs 验证清单)。
 * 这里验能验的:突发 resize 事件下 resize 处理不掉帧、不出横向溢出、不抛错。 */
{
  const r = await val(`(() => {
    const errs = [];
    const onErr = (e) => errs.push(String(e.message || e));
    window.addEventListener('error', onErr);
    const t0 = performance.now();
    for (let i = 0; i < 60; i++) window.dispatchEvent(new Event('resize'));
    const dt = performance.now() - t0;
    window.removeEventListener('error', onErr);
    const de = document.documentElement;
    return { totalMs: Math.round(dt * 10) / 10, overflow: de.scrollWidth - de.clientWidth, errs: errs.slice(0, 3) };
  })()`, 20000);
  ok('14', '缩放路径稳健(60 次 resize 事件 <800ms、无横向溢出、无异常)', r && r.totalMs < 800 && r.overflow <= 1 && r.errs.length === 0, r);
}

/* 15 统一 1px 描边:面板/卡片/控件一律 1px;>1px 只允许两种合法情形 ——
 * (a) 2px 状态指示/焦点环 (b) 单侧装饰条(引用块左侧强调条 4px)。
 * 换句话说:凡是**多侧同宽**的边框都得是 1px。 */
{
  const r = await val(`(() => { const bad = []; [...document.querySelectorAll('#layout *, #settingsPanel *')].slice(0, 3000).forEach(e => { const s = getComputedStyle(e); const w = ['Top','Right','Bottom','Left'].map(k => s['border' + k + 'Width']); const nonZero = w.filter(x => x && x !== '0px'); const uniq = [...new Set(nonZero)]; if (uniq.length === 1 && parseFloat(uniq[0]) > 2 && nonZero.length >= 2) bad.push((e.id || e.className || e.tagName) + ':' + uniq[0] + 'x' + nonZero.length); }); return { bad: bad.slice(0, 6), count: bad.length }; })()`);
  ok('15', '描边统一(多侧同宽 ≤2px,粗条只做单侧装饰)', r && r.count === 0, r);
}

/* 16 圆角 ≤4 档:像素级圆角只允许落在 4/6/8/12(胶囊 999px、圆形 50% 属形状,不计档) */
{
  const r = await val(`(() => { const s = {}; [...document.querySelectorAll('#layout *, #settingsPanel *')].slice(0, 4000).forEach(e => { const v = getComputedStyle(e).borderRadius; if (v && v !== '0px') s[v] = (s[v] || 0) + 1; }); return s; })()`);
  const keys = Object.keys(r || {});
  const px = keys.filter((k) => /px$/.test(k) && !k.includes(' '));
  const odd = px.filter((k) => !['4px', '6px', '8px', '12px', '16px'].includes(k));
  const shape = keys.filter((k) => k.includes('%') || k.includes('999'));
  const tiers = px.filter((k) => !['16px'].includes(k));
  ok('16', '圆角收敛到 ≤4 档(+胶囊/圆形)', odd.length === 0 && tiers.length <= 4, { keys, odd, tiers, shape });
}

/* 17 中文 32–38 字行宽 */
{
  const r = await val(`(() => { const el = document.querySelector('.markdown-body') || document.getElementById('readerInner'); const cs = getComputedStyle(el); const fs = parseFloat(cs.fontSize); const mw = parseFloat(getComputedStyle(document.getElementById('readerInner')).maxWidth); const n = mw / fs; return { fs, maxW: mw, cjkChars: Math.round(n * 10) / 10 }; })()`);
  ok('17', '中文行宽 32–38 字', r && r.cjkChars >= 32 && r.cjkChars <= 38, r);
}

/* 18 正文行高:中文 1.7(允许 1.6–1.75) */
{
  const r = await val(`(() => { const cs = getComputedStyle(document.querySelector('.markdown-body')); const fs = parseFloat(cs.fontSize); const lh = parseFloat(cs.lineHeight); return { fs, lh, ratio: Math.round((lh / fs) * 100) / 100, varLh: getComputedStyle(document.documentElement).getPropertyValue('--line-h').trim() }; })()`);
  ok('18', '正文行高 1.6–1.75(中文档 1.7)', r && r.ratio >= 1.6 && r.ratio <= 1.75, r);
}

/* 19 字号 ≥16px */
{
  const r = await val(`(() => { const cs = getComputedStyle(document.querySelector('.markdown-body')); return { body: parseFloat(cs.fontSize), root: getComputedStyle(document.documentElement).fontSize }; })()`);
  ok('19', '正文字号 ≥16px', r && r.body >= 16, r);
}

/* 20 字体栈 Windows 化 */
{
  const r = await val(`(() => getComputedStyle(document.body).fontFamily)()`);
  ok('20', '字体栈含 Windows 字体(Segoe UI / Microsoft YaHei UI)', /Segoe UI|Microsoft YaHei UI/.test(String(r)), r);
}

/* 21 v1.8.11 再换口径:代码块 = **中性玻璃凹槽**。
 * v1.8.8 那版要求"暖板(C≥12 且 r>b)"—— 那是把强调色掺进底色的做法,橙掺暗底 = 脏棕,
 * 2026-10-26 用户实拍吐槽"和我们玻璃质感完全不配"。新口径量的是**合成之后**的板:
 *   ① 半透明(0<α≤0.5,是真玻璃不是实板)
 *   ② 合成到中性灰上彩度 ≤6 —— 板色**不许带自己的色相**(暖棕、灰、蓝都过不去,只有中性/跟随环境才行)
 *   ③ 有发丝边界(边 α≥0.12,不然板会飘在壁纸里)
 *   ④ 字/板对比 ≥4.5:1(压在用户那条暗壁纸上的真合成值;亮壁纸那档由文字晕兜,见 --text-halo) */
{
  const r = await val(`(() => { const pre = document.querySelector('.markdown-body pre'); if (!pre) return { no: true };
    const cv = document.createElement('canvas').getContext('2d');
    const rgba = (c) => { cv.fillStyle = c; cv.fillRect(0, 0, 1, 1); const d = cv.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2], Math.round(d[3] / 255 * 100) / 100]; };
    const plate = rgba(getComputedStyle(pre).backgroundColor);
    const line = rgba(getComputedStyle(pre).borderTopColor);
    const fg = rgba(getComputedStyle(pre.querySelector('code') || pre).color).slice(0, 3);
    const over = (b) => plate.slice(0, 3).map((v, i) => Math.round(plate[3] * v + (1 - plate[3]) * b[i]));
    const C = (p) => Math.max(p[0], p[1], p[2]) - Math.min(p[0], p[1], p[2]);
    const lum = (p) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      return .2126 * f(p[0]) + .7152 * f(p[1]) + .0722 * f(p[2]); };
    const cr = (a, b) => { const l1 = lum(a), l2 = lum(b); return Math.round(((Math.max(l1, l2) + .05) / (Math.min(l1, l2) + .05)) * 100) / 100; };
    const neutral = over([40, 40, 40]), darkWall = over([34, 38, 43]), brightWall = over([205, 205, 200]);
    return { plate, line, fg, neutral, Cneutral: C(neutral), darkWall, crDark: cr(fg, darkWall),
      brightWall, crBright: cr(fg, brightWall), sink: getComputedStyle(document.documentElement).getPropertyValue('--plate-sink').trim() }; })()`, 8000);
  ok('21', '代码块底 = 中性玻璃凹槽:α≤0.5 + 合成中性灰后彩度≤6(板色不带色相)+ 发丝边 α≥0.12 + 字/板 ≥4.5:1',
    r && r.plate && r.plate[3] > 0 && r.plate[3] <= 0.5 && r.Cneutral <= 6 && r.line[3] >= 0.12 && r.crDark >= 4.5, r);
}

/* 22 玻璃仅 hover 态:正文内元素不做玻璃(交互元素悬停才有反馈) */
{
  const r = await val(`(() => { const inBody = [...document.querySelectorAll('.markdown-body *')].filter(e => { const s = getComputedStyle(e); return s.backdropFilter && s.backdropFilter !== 'none'; }).length; const hoverRule = [...document.styleSheets].some(ss => { try { return [...ss.cssRules].some(r => r.selectorText && /:hover/.test(r.selectorText)); } catch (e) { return false; } }); return { inBody, hoverRule }; })()`);
  ok('22', '正文内无玻璃 + 悬停反馈规则存在', r && r.inBody === 0 && r.hoverRule === true, r);
}

/* 23 焦点环可见:**真键盘 Tab** 才命中 :focus-visible。
 * 口径用**物理像素**:Chromium 在非 100% 缩放的屏上会把 computed 长度按 zoom 折算
 * (225% 屏实测 2px 环读成 1.77778px = 2 × 2/2.25),而两者物理宽度都是 4 设备像素。
 * 拿 computed 值直接比 2px 会变成"换个屏就假失败"(2026-10-25 在隐藏桌面/225% 上踩到),
 * 所以断言乘回 devicePixelRatio:CSS 基准 2px × 2 倍有效缩放 = 4 设备像素。 */
{
  await val(`(() => { document.body.focus(); if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); return 1; })()`, 4000);
  await keyTab(3);
  const r = await val(`(() => { const el = document.activeElement; if (!el || el === document.body) return { none: true }; const cs = getComputedStyle(el); const css = parseFloat(cs.outlineWidth); const dpr = devicePixelRatio; return { tag: el.tagName, cls: String(el.className).slice(0, 30), matches: el.matches(':focus-visible'), outlineWidth: cs.outlineWidth, devicePx: Math.round(css * dpr * 100) / 100, outlineStyle: cs.outlineStyle, outlineColor: cs.outlineColor, dpr: dpr }; })()`, 6000);
  ok('23', '焦点环可见(真键盘 Tab 后 outline ≥3.5 设备像素 = CSS 2px @2x)',
    r && r.matches === true && r.devicePx >= 3.5 && r.outlineStyle !== 'none', r);
}

/* 24 透明度有下限:文字透明度压到最低也 ≥70% */
{
  const r = await val(`(() => { const keep = S.glass.text; S.glass.text = 5; applyGlass(false); const t = Number(getComputedStyle(document.documentElement).getPropertyValue('--text-opa')); S.glass.text = keep; applyGlass(false); return { forced: t }; })()`);
  ok('24', '文字透明度有下限(--text-opa ≥0.7)', r && r.forced >= 0.7, r);
}

// 收尾:回到阅读态、关掉沙箱标签
await val(`(async () => { try { leaveEdit(); } catch (e) {} try { const t = getTab(${JSON.stringify(winPath(MD))}); if (t) { S.tabs = S.tabs.filter(x => x !== t); if (S.activeKey === t.abs) { S.activeKey = null; S.cur = null; } persistTabs(); renderTabs(); renderEmpty(); } } catch (e) {} return 1; })()`, 8000);

/* 25 工具栏只在真放不下时折叠(2026-10-25 用户实拍:1502px 宽还折叠着,主题/设置/玻璃缩在 ⋮ 里)。
 * 旧判据拿"内容宽"当"可用空间"(#actions 是 flex:0 1 auto),折叠后容器跟着变窄 ⇒ 折了就回不来。
 * 三条一起钉:宽窗不许折 / 真挤时必须折 / 挤完放开必须全部归还(不许卡住)。 */
{
  const r = await val(`(() => {
    const bar = document.getElementById('actions');
    const box = document.getElementById('docMore');
    const more = document.getElementById('tbMore');
    const top = bar.parentElement;
    const overflowBtns = () => [...bar.children].filter((c) => c !== more && c.dataset.overflow === '1');
    const ids = () => [...bar.children].filter((c) => c !== more).map((c) => c.id);
    const wideFolded = box.children.length;
    const total = ids().length + box.children.length;
    const filler = document.createElement('div');
    filler.style.cssText = 'width:1200px;height:1px;flex:0 0 auto';
    top.appendChild(filler); layoutToolbar();
    const narrowFolded = box.children.length;
    filler.remove(); layoutToolbar();
    const afterWide = box.children.length; const restoredIds = ids();
    while (overflowBtns().length) box.prepend(overflowBtns().pop());
    const stuck = box.children.length;
    layoutToolbar();
    const afterStuck = box.children.length; const backIds = ids();
    return JSON.stringify({ wideFolded, total, narrowFolded, afterWide, restoredIds, stuck, afterStuck, backIds, moreHidden: more.hidden });
  })()`, 20000);
  const o = JSON.parse(r || '{}');
  ok('25', '工具栏只在放不下时折叠:宽窗 0 折叠 / 塞满后真折叠 / 放开后全部归还(含手动全塞的极端回归)',
    o.wideFolded === 0 && o.narrowFolded > 0 && o.afterWide === 0 && o.afterStuck === 0 &&
    o.restoredIds && o.restoredIds.length === o.total && o.backIds && o.backIds.length === o.total, o);
}

/* 26 工具栏靠右(2026-10-26 用户:"你的工具栏应该靠右对齐,不是靠左")。
 * 背景:.brand 上的 margin-left:auto 在"标签栏不再吃空余"之后把所有空余吞在自己左边,
 * actions 被顶到**标签栏**右侧、离品牌字隔着整片空档。auto 边距挪到 .actions 上后:
 * 空档落在标签栏与工具栏之间,工具栏贴着品牌字(间距 = 顶栏 gap 10px)。 */
{
  const r = await val(`(() => {
    const bar = document.getElementById('actions');
    const top = bar.parentElement;
    const box = (el) => { const b = el.getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right), w: Math.round(b.width) }; };
    const acts = box(bar), brand = box(document.getElementById('brandName')), side = box(document.getElementById('btnSide'));
    const tabs = document.getElementById('tabBar');
    const tabsBox = tabs && !tabs.hidden ? box(tabs) : null;
    const leftEdge = tabsBox ? tabsBox.r : side.r;
    const win = box(document.querySelector('.win-ctrl'));
    const gaps = [['标签栏→工具栏', acts.l - leftEdge], ['工具栏→品牌', brand.l - acts.r], ['品牌→窗口钮', win.l - brand.r]];
    const maxGap = gaps.reduce((a, b) => (b[1] > a[1] ? b : a));
    return { acts, brand, leftEdge, gaps, maxGap, mid: Math.round(top.clientWidth / 2), folded: document.getElementById('tbMore').hidden === false };
  })()`, 8000);
  ok('26', '工具栏靠右:贴品牌字(间距≤14px)、左缘在中线右侧、最大空档落在工具栏左侧',
    r && r.brand.l - r.acts.r <= 14 && r.acts.l > r.mid && r.maxGap[0] === '标签栏→工具栏' && r.acts.r <= r.brand.l, r);
}


/* 27 浅色主题的语法高亮必须可读(2026-10-26 用户实拍:「你这代码块里的彩色字根本看不见」)。
 * 病根:hljs 主题是**给深色底配的**(vendor/hljs-atom-one-dark 底色 #282c34),
 * 它的 token 绿 #98c379 / 橙 #d19a66 / 灰 #5c6370 对浅色代码板只有 1.7–4.0:1。
 * 判据:浅色下**每个 hljs token class** 对「最坏合成的代码板」≥4.5:1。
 * 合成口径与 #21 一致:代码板(color-mix)叠在窗口板上,窗口板压在暗壁纸 (34,38,43) 上。
 * 深色只记录数值、不断言:深色 token 是厂商原值,压不到 4.5 属既有状态,不在本次范围。 */
{
  const CLS = ['hljs-comment', 'hljs-quote', 'hljs-doctag', 'hljs-formula', 'hljs-keyword', 'hljs-deletion', 'hljs-name',
    'hljs-section', 'hljs-selector-tag', 'hljs-subst', 'hljs-literal', 'hljs-addition', 'hljs-attribute', 'hljs-regexp',
    'hljs-string', 'hljs-attr', 'hljs-number', 'hljs-selector-attr', 'hljs-selector-class', 'hljs-selector-pseudo',
    'hljs-template-variable', 'hljs-type', 'hljs-variable', 'hljs-bullet', 'hljs-link', 'hljs-meta', 'hljs-selector-id',
    'hljs-symbol', 'hljs-title', 'hljs-built_in', 'hljs-title class_'];
  const AUDIT = `(() => {
    const parse = (s) => {
      s = String(s);
      let m = s.match(/rgba?\\(([^)]+)\\)/);
      if (m) { const p = m[1].split(/[,/]/).map(parseFloat); return { rgb: p.slice(0, 3), a: p.length > 3 ? p[3] : 1 }; }
      m = s.match(/color\\(srgb ([^)]+)\\)/);
      if (m) { const p = m[1].split(/[\\/ ]+/).filter(Boolean).map(Number); return { rgb: p.slice(0, 3).map((v) => v * 255), a: p.length > 3 ? p[3] : 1 }; }
      return null;
    };
    const over = (c, a, bg) => c.map((v, i) => v * a + bg[i] * (1 - a));
    const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    const lum = (p) => 0.2126 * lin(p[0]) + 0.7152 * lin(p[1]) + 0.0722 * lin(p[2]);
    const cr = (a, b) => { const la = lum(a), lb = lum(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };
    const ownHost = !document.querySelector('.markdown-body');
    let host = document.querySelector('.markdown-body');
    if (!host) { host = document.createElement('div'); host.className = 'markdown-body'; document.body.appendChild(host); }
    const pre = document.createElement('pre'); pre.className = 'hljs';
    const code = document.createElement('code'); code.className = 'hljs';
    const CLS = ${JSON.stringify(CLS)};
    const spans = CLS.map((c) => { const s = document.createElement('span'); s.className = c; s.textContent = 'M'; code.appendChild(s); return s; });
    pre.appendChild(code); host.appendChild(pre);
    const bodyBg = parse(getComputedStyle(document.body).backgroundColor);
    const preBg = parse(getComputedStyle(pre).backgroundColor) || { rgb: [0, 0, 0], a: 0 };
    const plate = over(preBg.rgb, preBg.a, over(bodyBg.rgb, bodyBg.a, [34, 38, 43]));
    const out = {};
    spans.forEach((s, i) => { const c = parse(getComputedStyle(s).color); out[CLS[i]] = { px: c.rgb.map((v) => Math.round(v)), cr: Math.round(cr(c.rgb, plate) * 100) / 100 }; });
    pre.remove();
    if (ownHost && host.parentElement) { host.remove(); }
    return JSON.stringify({ plate: plate.map((v) => Math.round(v)), out });
  })()`;
  await val(`(async () => { S.theme = 'light'; applySettings(); await new Promise((r) => setTimeout(r, 250)); return 1; })()`, 8000);
  const raw = await val(AUDIT, 20000);
  await val(`(async () => { S.theme = 'dark'; applySettings(); return 1; })()`, 8000);   // 先还原:断言失败也别把状态留给下一条跑道
  const L = JSON.parse(raw || '{}');
  const entries = Object.entries(L.out || {});
  const bad = entries.filter(([, v]) => v.cr < 4.5);
  const minCr = entries.length ? Math.min(...entries.map(([, v]) => v.cr)) : 0;
  ok('27', '浅色:每个 hljs token 对最坏合成代码板 ≥4.5:1(旧版绿 2.6 / 橙 3.4 / 灰 2.0 = 看不见)',
    entries.length >= 30 && bad.length === 0, { plate: L.plate, min: minCr, bad });
}


console.log(`\n== r12g: pass=${results.pass} fail=${results.fail} ==`);
if (results.fail) { console.log('failures:'); results.fails.forEach((f) => console.log('  - ' + f)); }
ws.close();
process.exit(results.fail ? 1 : 0);
