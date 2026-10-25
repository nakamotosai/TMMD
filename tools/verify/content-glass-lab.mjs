// content-glass-lab.mjs — 「正文内容板(代码块)」玻璃画法候选对照:把**真壁纸近似底注入页面**再截图,
// 于是每张 PNG 就是"页面层真合成"的结果(不是拿透明图去贴),直接能跟用户实拍对着看。
//
// 用法(先起隔离调试实例,GUI 别在用户桌面上):
//   node tools/verify/content-glass-lab.mjs --port=9244 --doc="C:\...\x.md" \
//        --backdrop=%TEMP%\tmmd-glass-lab\backdrop.png --out=%TEMP%\tmmd-glass-lab\shots
// 只读:只动隔离实例(注入 <style> + 一个壁纸 div),不开用户配置、不改用户文档。

import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';

const args = process.argv.slice(2);
const arg = (k, d) => (args.find((a) => a.startsWith(`--${k}=`)) || `--${k}=${d}`).split('=').slice(1).join('=');
const port = arg('port', '9244');
const OUT = arg('out', `${process.env.TEMP}\\tmmd-glass-lab\\shots`);
const DOC = arg('doc', '');
const BACKDROP = arg('backdrop', '');
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
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pending.delete(id); resolve({ timeout: true }); }, ms);
    pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function val(expr, ms = 20000) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, ms);
  if (r.timeout) throw new Error(`evaluate timeout: ${String(expr).slice(0, 110)}`);
  if (r.result?.exceptionDetails) throw new Error(`JS EXCEPTION: ${JSON.stringify(r.result.exceptionDetails).slice(0, 300)}`);
  return r.result?.result?.value;
}

/* ─── 候选画法 ────────────────────────────────────────────────────────────────
 * 只碰正文内容板(pre / 行内码板 / 发丝线),不动 UI 控件那 20 多处 --surface-plate。
 * 全部按 calc(var(--glass) * k) 跟着浓度滑条走(与旧 --well-deep 同一口径,便于横向比)。 */
const HAIR = 'color-mix(in srgb, var(--ink) 20%, transparent)';
const SCHEMES = [
  ['00_default', '改后(安装包默认,不注入任何 CSS)', ''],

  ['01_old_warm', '旧 v1.8.9 暖板(字面值复刻 rgb(87,58,42)@.38)', `
.markdown-body pre { background: rgba(87, 58, 42, .38); border: 1px solid rgba(104, 74, 55, .75); }`],

  ['01_frost', 'F1 霜片:ink 抬升 + 中性发丝 + 顶高光', `
.markdown-body pre { background: color-mix(in srgb, var(--ink) calc(var(--glass) * .25), transparent);
  border: 1px solid ${HAIR}; box-shadow: inset 0 1px 0 color-mix(in srgb, var(--ink) 10%, transparent); }`],

  ['02_frost_accent', 'F2 F1 + 2px 强调左条(45%)', `
.markdown-body pre { background: color-mix(in srgb, var(--ink) calc(var(--glass) * .25), transparent);
  border: 1px solid ${HAIR}; border-left: 2px solid color-mix(in srgb, var(--accent) 45%, transparent);
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--ink) 10%, transparent); }`],

  ['03_sink', 'F3 玻璃槽:压暗 45% + 中性发丝', `
.markdown-body pre { background: color-mix(in srgb, #000 calc(var(--glass) * .45), transparent);
  border: 1px solid ${HAIR}; box-shadow: inset 0 1px 0 rgba(255, 255, 255, .06); }`],

  ['04_sheen', 'F4 玻璃片:上亮下暗渐变 + 发丝', `
.markdown-body pre { background: linear-gradient(180deg,
    color-mix(in srgb, var(--ink) calc(var(--glass) * .34), transparent),
    color-mix(in srgb, var(--ink) calc(var(--glass) * .12), transparent));
  border: 1px solid ${HAIR}; }`],

  ['05_sink_soft', 'F5 浅槽:压暗 26% + 发丝(暗底壁纸更稳)', `
.markdown-body pre { background: color-mix(in srgb, #000 calc(var(--glass) * .26), transparent);
  border: 1px solid color-mix(in srgb, var(--ink) 16%, transparent);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .05); }`],
];

/* ─── 壁纸底注入 + 打开文档 ─────────────────────────────────────────────────── */
const b64 = BACKDROP ? readFileSync(BACKDROP).toString('base64') : '';
const winPath = (p) => p.replace(/\//g, '\\');
await val(`(() => { try { leaveEdit(); } catch (e) {} S.theme = 'dark'; S.palette = 'gruvbox'; S.glass = ${GLASS}; S.glass.on = true;
  S.codeStyle = 'plate'; S.textOpa = 1; try { applySettings(); applyEnhance(); applyGlass(false); } catch (e) {} showPanel(null);
  let bd = document.getElementById('__labBackdrop');
  if (!bd) { bd = document.createElement('div'); bd.id = '__labBackdrop';
    bd.style.cssText = 'position:fixed;inset:0;z-index:-1;pointer-events:none;background-size:cover;background-position:50% 50%';
    document.body.appendChild(bd); }
  ${b64 ? `bd.style.backgroundImage = 'url(data:image/png;base64,${b64})';` : ''}
  return { glass: getComputedStyle(document.documentElement).getPropertyValue('--glass').trim() };
})()`);
console.log(`-- 打开沙箱文档 ${DOC} (glass=${GLASS}, backdrop=${BACKDROP ? 'injected' : 'none'})`);
const opened = await val(`(async () => {
  await invoke('open_path', { path: ${JSON.stringify(winPath(DOC))} });
  await openTab({ abs: ${JSON.stringify(winPath(DOC))}, kind: 'ext' });
  // 大文档是**渐进渲染**的:.markdown-body 会被整块替换 —— 等到 pre 连续两次高度一致才算稳定,
  // 中途不取几何(否则拿到 null 或拿到已被替换掉的旧节点)。
  let pre = null, prevH = -1, stable = 0, tries = 0;
  for (; tries < 60; tries++) {
    await new Promise((r) => setTimeout(r, 250));
    pre = document.querySelector('.markdown-body pre');
    if (!pre) { stable = 0; continue; }
    const hh = pre.getBoundingClientRect().height;
    if (hh > 0 && Math.abs(hh - prevH) < 1) { if (++stable >= 2) break; } else stable = 0;
    prevH = hh;
  }
  if (!pre) return { fail: 'no .markdown-body pre after ' + tries + ' tries' };
  const sc = document.getElementById('reader');
  const h = pre.previousElementSibling || pre;
  const abs = (el) => el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
  sc.scrollTop = Math.max(0, abs(h) - 40);       // 抬头把上一级标题也框进来(用户实拍里有标题)
  await new Promise((r) => setTimeout(r, 400));
  const pr = pre.getBoundingClientRect(), hr = h.getBoundingClientRect();
  return { tries, x: Math.round(hr.left) - 24, y: Math.max(0, Math.round(hr.top) - 14),
    w: Math.min(1240, Math.round(pr.width) + 48), h: Math.min(820, innerHeight - Math.max(0, Math.round(hr.top) - 14) - 8),
    preY: Math.round(pr.top), preH: Math.round(pr.height), glass: getComputedStyle(document.documentElement).getPropertyValue('--glass').trim() };
})()`, 40000);
if (opened?.fail) { console.error(opened.fail); process.exit(3); }
console.log(`-- 框选 x=${opened.x} y=${opened.y} ${opened.w}x${opened.h} (pre.y=${opened.preY} 高=${opened.preH} glass=${opened.glass})`);
const CLIP = { x: Math.max(0, opened.x), y: Math.max(0, opened.y), width: opened.w, height: opened.h, scale: 1 };

{ // 隐藏桌面合成器会节流:先空截一帧丢掉,再逐档截
  await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, clip: { x: 0, y: 0, width: 32, height: 32, scale: 1 } }, 30000);
}

const rows = [];
for (const [file, label, css] of SCHEMES) {
  await val(`(() => {
    document.getElementById('__labScheme')?.remove();
    const s = document.createElement('style'); s.id = '__labScheme'; s.textContent = ${JSON.stringify(css)};
    document.head.appendChild(s);
    return 1;
  })()`);
  await new Promise((r) => setTimeout(r, 300));
  const m = await val(`(() => { const pre = document.querySelector('.markdown-body pre');
    return { bg: getComputedStyle(pre).backgroundColor, border: pre.style.borderLeftColor, rowBox: (() => { const r = pre.getBoundingClientRect(); return { top: Math.round(r.top), left: Math.round(r.left), h: Math.round(r.height) }; })() }; })()`);
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, clip: CLIP }, 30000);
  if (!shot.result?.data) { console.error(`capture failed for ${file}: ${JSON.stringify(shot).slice(0, 180)}`); process.exit(1); }
  writeFileSync(`${OUT}\\${file}.png`, Buffer.from(shot.result.data, 'base64'));
  rows.push({ file, label, ...m });
  console.log(`  ${file.padEnd(18)} 底=${m.bg}  pre 顶=${m.rowBox.top}`);
}
writeFileSync(`${OUT}\\meta.json`, JSON.stringify({ clip: CLIP, geo: opened, dpr: await val('devicePixelRatio'), rows }, null, 1), 'utf8');

/* 顶栏对齐对照:改后(安装包默认) vs 旧 v1.8.10(auto 边距挂在 .brand 上 → 空余吞在品牌字左边)。
 * 布局类的改动没有 token 可注入,只能拿 !important 反推旧规则 —— 只在本脚本的隔离实例里生效。 */
const TOPBAR = { x: 0, y: 0, width: 1502, height: 44, scale: 1 };
const topRows = [];
for (const [file, label, css] of [
  ['90_topbar_after', '改后:工具栏贴品牌字靠右', ''],
  ['91_topbar_before', '旧 v1.8.10:空余吞在品牌字左边', '#actions { margin-left: 0 !important } #brandName { margin-left: auto !important }'],
]) {
  await val(`(() => {
    document.getElementById('__labScheme')?.remove();
    const s = document.createElement('style'); s.id = '__labScheme'; s.textContent = ${JSON.stringify(css)};
    document.head.appendChild(s); return 1;
  })()`);
  await new Promise((r) => setTimeout(r, 300));
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, clip: TOPBAR }, 30000);
  if (shot.result?.data) {
    writeFileSync(`${OUT}\\${file}.png`, Buffer.from(shot.result.data, 'base64'));
    const g = await val(`(() => { const b = (e) => { const r = e.getBoundingClientRect(); return Math.round(r.left) + '-' + Math.round(r.right); };
      return b(document.getElementById('tabBar')) + ' | ' + b(document.getElementById('actions')) + ' | ' + b(document.getElementById('brandName')); })()`);
    topRows.push({ file, label, boxes: g });
    console.log(`  ${file.padEnd(18)} ${label}  标签栏|工具栏|品牌 = ${g}`);
  }
}
writeFileSync(`${OUT}\\topbar.json`, JSON.stringify(topRows, null, 1), 'utf8');
await val(`(() => { document.getElementById('__labScheme')?.remove(); return 1; })()`);
console.log(`== ${SCHEMES.length} 张(注入壁纸底的真合成)→ ${OUT} ==`);
ws.close();
process.exit(0);
