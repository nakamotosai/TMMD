// halo-strength.mjs — 文字晕强度分档取样:同一段正文、同一窗口、同一浓度,只改 `--halo-k`。
//
// 为什么要有它:2026-10-25 用户反馈"晕太重,有点丑"。**"重"与"淡"是主观的,但两件事是客观的**:
//   ① 亮底上字对紧邻像素的局部对比(正文必须 ≥4.5:1)—— 这是晕的**存在理由**,砍晕不能砍掉它;
//   ② 晕在暗底上的**可见度**(相对 k=0 的平均压暗量)—— 越淡越不丑。
// 本脚本只负责出"页面层真截图"(RGBA,未合成),合成与两个指标由配套 Python 算(见 tools/verify/README.md)。
//
// 用法:
//   node tools/verify/halo-strength.mjs --port=9243 --doc=<md> --out=%TEMP%\tmmd-halo\shots
// 只读:只动隔离实例(改 localStorage 测试档 + 注入 style),不写用户目录、不改文档。

import { writeFileSync, mkdirSync } from 'node:fs';

const args = process.argv.slice(2);
const arg = (k, d) => (args.find((a) => a.startsWith(`--${k}=`)) || `--${k}=${d}`).split('=').slice(1).join('=');
const port = arg('port', '9225');
const OUT = arg('out', `${process.env.TEMP}\\tmmd-halo\\shots`);
const DOC = arg('doc', '');
const GLASS = Number(arg('glass', 40));
const KS = arg('ks', '0,0.35,0.55,0.7,1').split(',').map(Number);

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

const winPath = (p) => p.replace(/\//g, '\\');
// 隔离实例的 WebView2 profile 是空的 → 先钉住基线状态(深色 gruvbox / 用户默认浓度 / 无文本透明度折损)
const geo = await val(`(async () => {
  try { leaveEdit(); } catch (e) {}
  S.theme = 'dark'; S.palette = 'gruvbox'; S.glass = S.glass && typeof S.glass === 'object' ? S.glass : {};
  S.glass.on = true; S.glass.conc = ${GLASS}; S.glass.text = 100; if (typeof applyGlass === 'function') applyGlass(false);
  await openTab({ abs: ${JSON.stringify(winPath(DOC))}, kind: 'ext' });
  await new Promise((r) => setTimeout(r, 1000));
  const sc = document.querySelector('#reader');
  sc.scrollTo(0, 0);
  await new Promise((r) => setTimeout(r, 200));
  const p = document.querySelector('.markdown-body p');
  const abs = p.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
  sc.scrollTop = Math.max(0, abs - 60);
  await new Promise((r) => setTimeout(r, 250));
  const r = p.getBoundingClientRect();
  return { x: Math.round(r.left - 20), y: Math.round(r.top - 14), w: Math.min(900, Math.round(r.width + 40)), h: Math.round(r.height + 28), vh: innerHeight };
})()`, 30000);
console.log(`-- 取样窗: ${JSON.stringify(geo)}`);

await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, clip: { x: 0, y: 0, width: 32, height: 32, scale: 1 } }, 30000); // 预热帧丢掉

const rows = [];
for (const k of KS) {
  const shadow = await val(`(() => {
    const s = document.getElementById('__haloProbe') || (() => { const e = document.createElement('style'); e.id = '__haloProbe'; document.head.appendChild(e); return e; })();
    // 要连 token 定义一起注入:当前装机版里的 --text-halo 是写死 alpha 的字面量,只塞 --halo-k 不生效。
    s.textContent = ':root { --halo-k: ' + ${k} + ';'
      + ' --text-halo: 0 0 1px rgb(0 0 0 / calc(.9 * var(--halo-k))), 0 1px 2px rgb(0 0 0 / calc(.8 * var(--halo-k))),'
      + ' 0 2px calc(2px + 6px * var(--halo-k)) rgb(0 0 0 / calc(.75 * var(--halo-k)));'
      + ' --title-halo: 0 0 1px rgb(0 0 0 / calc(.95 * var(--halo-k))), 0 1px 2px rgb(0 0 0 / calc(.92 * var(--halo-k))),'
      + ' 0 2px calc(2px + 8px * var(--halo-k)) rgb(0 0 0 / calc(.88 * var(--halo-k))), 0 0 calc(1px + 3px * var(--halo-k)) rgb(0 0 0 / calc(.9 * var(--halo-k))); }';
    return getComputedStyle(document.body).textShadow;
  })()`, 10000);
  await new Promise((r) => setTimeout(r, 220));
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, clip: { x: geo.x, y: geo.y, width: geo.w, height: geo.h, scale: 1 } }, 30000);
  if (!shot.result?.data) { console.error(`capture failed k=${k}`); process.exit(1); }
  const name = `k${String(k).replace('.', 'p')}`;
  writeFileSync(`${OUT}\\${name}.png`, Buffer.from(shot.result.data, 'base64'));
  rows.push({ k, name, shadow: String(shadow).slice(0, 120) });
  console.log(`  k=${String(k).padEnd(5)} ${String(shadow).slice(0, 78)}`);
}
writeFileSync(`${OUT}\\meta.json`, JSON.stringify({ doc: DOC, glass: GLASS, clip: geo, rows }, null, 1), 'utf8');
await val(`(() => { document.getElementById('__haloProbe')?.remove(); return 1; })()`);
console.log(`== ${KS.length} 张 → ${OUT} ==`);
ws.close();
process.exit(0);
