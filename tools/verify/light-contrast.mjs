// tools/verify/light-contrast.mjs — 浅色主题在**真玻璃**上的取证(2026-10-26 v1.8.13)
//
// 背景:浅色主题的对比度不能只在"实色纸"上算。窗口是透明玻璃,压的是一张照片壁纸,
// 所以要看的是 **板色 × 壁纸** 的真合成。这里做三件事:
//   1. 通过 CDP 把实例切到浅色(或注入旧值做 before),抓**带 alpha** 的页面截图;
//   2. 取每个可见文字块的 computed color / rect / 实际字形像素;
//   3. 把截图交给 tools/verify/light-contrast.py 合到真壁纸上算对比度(那片脚本量像素,这里只搬数据)。
//
// 用法(先起调试实例,见 tools/verify/README.md):
//   node tools/verify/light-contrast.mjs --port=9225 --mode=after  --out=C:\tmp\light-after
//   node tools/verify/light-contrast.mjs --port=9225 --mode=before --out=C:\tmp\light-before
//
// --mode=before 只是把**旧值**内联上去(--glass-lift:0 与旧灰阶),不碰任何文件。

import { writeFileSync, mkdirSync } from 'node:fs';

const args = process.argv.slice(2);
const port = Number((args.find((a) => a.startsWith('--port=')) || '--port=9225').split('=')[1]);
const mode = (args.find((a) => a.startsWith('--mode=')) || '--mode=after').split('=')[1];
const out = (args.find((a) => a.startsWith('--out=')) || '--out=light').split('=')[1];
const doc = (args.find((a) => a.startsWith('--doc=')) || '--doc=').slice(6);
const root = (args.find((a) => a.startsWith('--root=')) || '--root=').slice(7);
const side = (args.find((a) => a.startsWith('--side=')) || '--side=').slice(7);   // tree = 侧栏停在文件树
const empty = args.includes('--empty');                                          // 只留空态(不种文档)

// v1.8.12 及以前的浅色取值(before 档用;不是"设计",是"待证的旧状态")
const LEGACY = {
  '--glass-lift': '0%',
  '--fg': '#3c3836', '--fg-dim': '#7c6f64', '--fg-faint': '#928374',
  '--accent': '#af3a03', '--accent2': '#b57614', '--border': '#d5c4a1',
  '--bg': '#fbf1c7', '--bg2': '#f2e5bc', '--bg3': '#ebdbb2',
};

let targets;
try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); }
catch (e) { console.error(`CDP 不通 :${port}(先起调试实例):${e.message}`); process.exit(2); }
const page = targets.find((t) => t.type === 'page');
if (!page) { console.error('没有 page target'); process.exit(2); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws 连接失败')); });
let seq = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
function send(method, params, ms = 20000) {
  const id = ++seq;
  return new Promise((resolve) => {
    const t = setTimeout(() => { pending.delete(id); resolve({ timeout: true }); }, ms);
    pending.set(id, (m) => { clearTimeout(t); resolve(m); });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function val(expr, ms) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, ms);
  if (r.timeout) throw new Error(`evaluate 超时:${expr.slice(0, 90)}`);
  if (r.result?.exceptionDetails) throw new Error(`JS 异常:${JSON.stringify(r.result.exceptionDetails).slice(0, 300)}`);
  return r.result?.result?.value;
}

// 透明截屏:先压掉默认底,再抓图(否则透明窗会被烘成白底)
await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });

// 种一个库根(隔离实例开局没有 roots.json,侧栏就只有目录树;种了才有文件树,取证更接近用户视角)
if (root) {
  const seededRoot = await val(`(async()=>{
    const p = ${JSON.stringify(root)};
    const meta = { id: 'rv' + Date.now(), name: ${JSON.stringify(root.split(/[\\/]/).pop() || root)}, path: p };
    S.roots = [meta];
    if (typeof LS !== 'undefined') LS.set('sr_roots', S.roots);
    try { await invoke('save_roots', { roots: S.roots }); } catch (e) {}
    await loadRoot(meta);
    await new Promise(r=>setTimeout(r, 900));
    return 'tree=' + document.querySelectorAll('.tree-item').length;
  })()`, 30000);
  console.log(`种库根 -> ${seededRoot}`);
}

// 空态取证:把已有标签全关掉(隔离 profile 会恢复上次的标签)
if (empty) {
  const closed = await val(`(() => { let n = 0; document.querySelectorAll('.tab .tab-x').forEach(b => { b.click(); n++; }); return n; })()`);
  await new Promise((r) => setTimeout(r, 1200));
  console.log(`关标签 -> ${closed} 个`);
}

// 打开一份文档(隔离实例开局是空态,不种文档就没有正文字块可量)
if (doc && !empty) {
  const seeded = await val(`(async()=>{ await openExternal(${JSON.stringify(doc)}); await new Promise(r=>setTimeout(r,2200)); return 'tabs=' + (typeof S!=='undefined' ? S.tabs.length : '?'); })()`, 30000);
  console.log(`种文档 -> ${seeded}`);
}

// 侧栏停在文件树(打开文档后侧栏会切到目录,点回文件树更像"知识库"视角)
if (side === 'tree') {
  const r = await val(`(() => { const b = document.querySelector('#btnTree'); if (!b) return 'no #btnTree'; b.click(); return document.querySelector('.side-title')?.textContent?.trim() || 'clicked'; })()`);
  await new Promise((r2) => setTimeout(r2, 700));
  console.log(`侧栏 -> ${r}`);
}

// 切浅色(走应用自己的存档 + applySettings,和用户点按钮同一条路)
const theme = await val(`(() => {
  if (typeof S !== 'undefined') { S.theme = 'light'; if (typeof LS !== 'undefined') LS.set('sr_theme', 'light'); }
  document.body.dataset.theme = 'light';
  document.documentElement.dataset.theme = 'light';
  document.documentElement.dataset.palette = 'gruvbox';
  if (typeof applySettings === 'function') applySettings();
  if (typeof applyGlass === 'function') applyGlass(false);
  return document.documentElement.dataset.theme + '/' + document.body.dataset.theme;
})()`);
const legacyJson = JSON.stringify(LEGACY);
// before 档:把 v1.8.12 的旧值写回 html+body 两处
// (applySettings 把 data-theme 同时写在 html 与 body 上,浅色变量因此有两份声明 —— 只覆盖 html 不够)
const beforeExpr = "(() => { const old = " + legacyJson + "; for (const [k, v] of Object.entries(old)) {"
  + " document.documentElement.style.setProperty(k, v); document.body.style.setProperty(k, v); }"
  + " return Object.keys(old).length; })()";
// after 档:清掉上一次 before 留下的内联旧值,量的就是文件里的真值
const afterExpr = "(() => { const ks = Object.keys(" + legacyJson + "); for (const k of ks) {"
  + " document.documentElement.style.removeProperty(k); document.body.style.removeProperty(k); }"
  + " return 'cleared'; })()";
const inject = await val(mode === 'before' ? beforeExpr : afterExpr);

await new Promise((r) => setTimeout(r, 900));

// 取样本:每个可见文字块的 computed 色 + rect + 实际文本
const probe = `(() => {
  const sel = [
    ['.side-title', '侧栏分组标题'],
    ['.tree-item.toc', '目录树项'],
    ['.tree-item.file.active .name', '当前文件'],
    ['.drawer-item .name', '最近打开'],
    ['.brand', '品牌字'],
    ['.tree-item.dir .name', '目录名'],
    ['.tree-item.file .name', '文件名'],
    ['.tree-item.file.active .name', '当前文件'],
    ['#reader .markdown-body h1', '正文 H1'],
    ['#reader .markdown-body p', '正文段落'],
    ['#reader .markdown-body a', '正文链接'],
    ['#reader .markdown-body code', '行内码'],
    ['#reader .markdown-body pre code', '代码块'],
    ['#reader .markdown-body blockquote p', '引用'],
    ['#reader .markdown-body th', '表头'],
  ];
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 4 && r.height > 4; };
  const rows = [];
  for (const [s, label] of sel) {
    const el = document.querySelector(s);
    if (!el || !vis(el)) { rows.push({ selector: s, label, present: false }); continue; }
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    rows.push({
      selector: s, label, present: true,
      color: cs.color, bg: cs.backgroundColor, shadow: cs.textShadow ? cs.textShadow.slice(0, 90) : 'none',
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      text: (el.textContent || '').trim().slice(0, 24),
    });
  }
  const body = getComputedStyle(document.body);
  const b = document.body.getBoundingClientRect();
  return {
    viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
    theme: document.documentElement.dataset.theme,
    palette: document.documentElement.dataset.palette,
    glass: { conc: (typeof S !== 'undefined' && S.glass ? S.glass.conc : null), css: document.documentElement.style.getPropertyValue('--glass'), halo: document.documentElement.style.getPropertyValue('--halo-k') },
    body: { bg: body.backgroundColor, rect: { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) } },
    rows,
  };
})()`;
const data = await val(probe);

const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
mkdirSync(out.replace(/[\\/][^\\/]*$/, '') || '.', { recursive: true });
const png = `${out}.png`;
writeFileSync(png, Buffer.from(shot.result.data, 'base64'));
const json = `${out}.json`;
writeFileSync(json, JSON.stringify({ mode, inject, theme, data }, null, 2));

console.log(`mode=${mode} theme=${theme} 视口 ${data.viewport.w}x${data.viewport.h}@${data.viewport.dpr}`);
console.log(`玻璃:conc=${data.glass.conc} --glass=${data.glass.css} --halo-k=${data.glass.halo}`);
console.log(`板(body 背景)= ${data.body.bg}  窗口 ${data.body.rect.w}x${data.body.rect.h}`);
for (const r of data.rows) {
  if (!r.present) { console.log(`  ${r.label.padEnd(10)} (页面上没有)`); continue; }
  console.log(`  ${r.label.padEnd(10)} ${r.color.padEnd(22)} rect=${r.rect.x},${r.rect.y} ${r.rect.w}x${r.rect.h}  「${r.text}」`);
}
console.log(`截图 ${png}`);
console.log(`数据 ${json}`);
ws.close();
