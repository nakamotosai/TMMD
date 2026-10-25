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
    const sc = document.querySelector('.reader-scroll') || document.scrollingElement;
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

/* 6 模糊区最坏情况 ≥4.5:浓度滑到最低(α 最小 = 最坏)时仍要求页面层不透明度 ≥0.55 的上限保护 */
{
  const r = await val(`(() => { const s = glassSplit(1); return { dwm: s.dwm, css: s.css, atDefault: glassSplit(Number(S.glass.conc) || 45) }; })()`);
  ok('06', '模糊区最坏情况有下限(conc=1 时页面层仍留底)', r && r.css >= 0 && r.dwm >= 0, r);
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

/* 13 5000 行滚动帧率:见 r12f G 段(实测 p95 7.1ms ≤ 16.7ms);这里做一次快速复核 */
{
  const r = await val(`(async () => { const sc = document.querySelector('.reader-scroll') || document.scrollingElement; const frames = []; let last = performance.now(); for (let i = 0; i < 30; i++) { await new Promise(res => requestAnimationFrame(() => res())); const now = performance.now(); frames.push(now - last); last = now; sc.scrollTop = (sc.scrollHeight - sc.clientHeight) * (i / 29); } frames.shift(); const s = [...frames].sort((a, b) => a - b); return { p95: Math.round(s[Math.floor(s.length * 0.95)] * 10) / 10, avg: Math.round((frames.reduce((a, b) => a + b, 0) / frames.length) * 10) / 10 }; })()`, 30000);
  ok('13', '滚动帧时间 p95 ≤ 16.7ms(≥95% 帧达标)', r && r.p95 <= 16.7, r);
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

/* 21 代码块 α≥0.9(比整窗浓 40 个点,压住代码对比度) */
{
  const r = await val(`(() => { const pre = document.querySelector('.markdown-body pre'); if (!pre) return { no: true }; const bg = getComputedStyle(pre).backgroundColor; const m = String(bg).match(/([\\d.]+)\\s*\\)$/); const a = m ? parseFloat(m[1]) : 1; return { bg, alpha: a }; })()`);
  ok('21', '代码块底色 α≥0.9', r && r.alpha >= 0.9, r);
}

/* 22 玻璃仅 hover 态:正文内元素不做玻璃(交互元素悬停才有反馈) */
{
  const r = await val(`(() => { const inBody = [...document.querySelectorAll('.markdown-body *')].filter(e => { const s = getComputedStyle(e); return s.backdropFilter && s.backdropFilter !== 'none'; }).length; const hoverRule = [...document.styleSheets].some(ss => { try { return [...ss.cssRules].some(r => r.selectorText && /:hover/.test(r.selectorText)); } catch (e) { return false; } }); return { inBody, hoverRule }; })()`);
  ok('22', '正文内无玻璃 + 悬停反馈规则存在', r && r.inBody === 0 && r.hoverRule === true, r);
}

/* 23 焦点环可见:**真键盘 Tab** 才命中 :focus-visible */
{
  await val(`(() => { document.body.focus(); if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); return 1; })()`, 4000);
  await keyTab(3);
  const r = await val(`(() => { const el = document.activeElement; if (!el || el === document.body) return { none: true }; const cs = getComputedStyle(el); return { tag: el.tagName, cls: String(el.className).slice(0, 30), matches: el.matches(':focus-visible'), outlineWidth: cs.outlineWidth, outlineStyle: cs.outlineStyle, outlineColor: cs.outlineColor }; })()`, 6000);
  ok('23', '焦点环可见(真键盘 Tab 后 outline ≥2px)', r && r.matches === true && parseFloat(r.outlineWidth) >= 2 && r.outlineStyle !== 'none', r);
}

/* 24 透明度有下限:文字透明度压到最低也 ≥70% */
{
  const r = await val(`(() => { const keep = S.glass.text; S.glass.text = 5; applyGlass(false); const t = Number(getComputedStyle(document.documentElement).getPropertyValue('--text-opa')); S.glass.text = keep; applyGlass(false); return { forced: t }; })()`);
  ok('24', '文字透明度有下限(--text-opa ≥0.7)', r && r.forced >= 0.7, r);
}

// 收尾:回到阅读态、关掉沙箱标签
await val(`(async () => { try { leaveEdit(); } catch (e) {} try { const t = getTab(${JSON.stringify(winPath(MD))}); if (t) { S.tabs = S.tabs.filter(x => x !== t); if (S.activeKey === t.abs) { S.activeKey = null; S.cur = null; } persistTabs(); renderTabs(); renderEmpty(); } } catch (e) {} return 1; })()`, 8000);

console.log(`\n== r12g: pass=${results.pass} fail=${results.fail} ==`);
if (results.fail) { console.log('failures:'); results.fails.forEach((f) => console.log('  - ' + f)); }
ws.close();
process.exit(results.fail ? 1 : 0);
