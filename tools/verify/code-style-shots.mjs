// code-style-shots.mjs — 出一组"行内代码画法"的透明页面截图(给人工拍板用)。
//
// 用法(先起隔离调试实例,GUI 别在用户桌面上):
//   node tools/verify/code-style-shots.mjs --port=9233 --out=%TEMP%\code-shots
// 产物:out/01-old.png 02-wash.png 03-underline.png 04-bare.png 05-plate.png
//      都是**页面层透明 PNG**(Emulation.setDefaultBackgroundColorOverride alpha=0),
//      交给 tools/verify/code-style-preview.py 贴到壁纸样本上出对照图。
// 只读:只动隔离实例的 localStorage 键 sr_code_style(测试档),不开用户文档、不写用户目录。
import { writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const arg = (k, d) => (args.find((a) => a.startsWith(`--${k}=`)) || `--${k}=${d}`).split('=').slice(1).join('=');
const port = arg('port', '9225');
const OUT = arg('out', join(tmpdir(), 'code-shots'));
const W = Number(arg('w', 700));
const H = Number(arg('h', 430));
const BACKDROP = arg('backdrop', '');

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
async function val(expr, ms) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, ms);
  if (r.timeout) throw new Error(`evaluate timeout: ${expr.slice(0, 110)}`);
  if (r.result?.exceptionDetails) throw new Error(`JS EXCEPTION: ${JSON.stringify(r.result.exceptionDetails).slice(0, 300)}`);
  return r.result?.result?.value;
}

// 沙箱文档:复刻用户那篇"端点清单"的典型形态(长路径行内码 + URL + 行内码换行 + 引用 + 代码块)
const ROOT = join(tmpdir(), 'tmmd-code-style');
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });
const MD = join(ROOT, 'code-style-probe.md');
writeFileSync(MD, [
  '一条 lane 两种写法,同一出口 IP:',
  '',
  '- 直连(tailnet,无账密,跨机也能用):美 `socks5://100.113.241.22:41005+i`,日 `socks5://100.86.60.101:41105+i`',
  '- 本机(mihomo 必须在跑):`socks5://127.0.0.1:421xx`(42120–42149 美、42150–42179 日),http 面板可填 `http://127.0.0.1:421xx`',
  '',
  '> 引用块:`api.ipify.org` 逐门实探,`C:\\Users\\sai\\egress-mihomo\\config.yaml` 里的 8-原生-美国rNN / 9-原生-日本rNN。',
  '',
  '```js',
  'const lane = "socks5://100.113.241.22:41005";',
  'const panel = "http://127.0.0.1:421xx";',
  '```',
  '',
  '正文继续:行内代码 `--glass` 与 `--code-plate` 两个变量在正文里的观感对比。',
].join('\n'), 'utf8');

const winPath = (p) => p.replace(/\//g, '\\');
console.log(`-- 打开沙箱文档 ${MD}`);
const opened = await val(`(async () => { try { leaveEdit(); } catch (e) {}
  await invoke('open_path', { path: ${JSON.stringify(winPath(MD))} });
  await openTab({ abs: ${JSON.stringify(winPath(MD))}, kind: 'ext' });
  await new Promise((r) => setTimeout(r, 900));
  document.querySelector('#reader')?.scrollTo(0, 0);
  const r = document.querySelector('.markdown-body').getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, code: document.querySelectorAll('.markdown-body code').length };
})()`, 25000);
console.log(`-- 正文 rect=${JSON.stringify(opened)}`);

const geo = await val(`(() => { const r = document.querySelector('.markdown-body').getBoundingClientRect(); return { x: r.x, y: r.y }; })()`);

// 旧版画法:把 v1.8.3 的两条规则原样贴回去(不引 --code-plate,直接 --surface-plate)
const OLD_CSS = `.markdown-body code { background: var(--surface-plate); padding: 2px 5px; border-radius: 4px; }
.markdown-body blockquote { background: var(--surface-plate); }`;

await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });

// --backdrop <png>:把"壁纸底"(无文字边缘取样 + 拉伸模糊,近似 DWM acrylic)直接贴成页面背景。
// 这样截出来就是**真合成**(页面自己的玻璃板压在壁纸底上),不用再去猜 alpha;
// 不给就用上面的透明底 override(WebView2 有时会给回一层浅灰,所以推荐给 backdrop)。
let backdropDataUri = null;
if (BACKDROP) {
  const b64 = readFileSync(BACKDROP).toString('base64');
  backdropDataUri = `data:image/png;base64,${b64}`;
  console.log(`-- 壁纸底 ${BACKDROP} (${Math.round(b64.length / 1024)}KB base64)`);
}
await val(`(() => {
  document.getElementById('__codeStyleBackdrop')?.remove();
  ${backdropDataUri === null ? '' : `const s = document.createElement('style'); s.id = '__codeStyleBackdrop';
  s.textContent = 'html { background-image: url(${JSON.stringify(backdropDataUri)}) !important; background-size: cover !important; background-position: center !important; }';
  document.head.appendChild(s);`}
  return 1;
})()`);
await new Promise((r) => setTimeout(r, 260));
// 隐藏桌面上的合成器会被节流:注入背景后**先空截一帧**(丢掉),否则前 1-2 张会缺这层底
{
  const warm = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, clip: { x: Math.round(geo.x), y: Math.round(geo.y), width: 32, height: 32, scale: 1 } }, 30000);
  console.log(`-- 预热帧 ${warm.result?.data ? 'ok' : 'failed'}`);
}

const STATES = [
  ['01-old', '旧版(v1.8.3 灰块)', null],
  ['02-wash', '荧光笔 wash', 'wash'],
  ['03-underline', '下划线 underline', 'underline'],
  ['04-bare', '无痕 bare', 'bare'],
  ['05-plate', '薄底 plate', 'plate'],
];

for (const [file, label, mode] of STATES) {
  await val(`(() => {
    document.getElementById('__codeStyleProbe')?.remove();
    if (${JSON.stringify(mode)} === null) {
      const s = document.createElement('style'); s.id = '__codeStyleProbe'; s.textContent = ${JSON.stringify(OLD_CSS)};
      document.head.appendChild(s);
      for (const m of ['wash', 'underline', 'bare', 'plate']) document.body.classList.remove('code-' + m);
    } else {
      S.codeStyle = ${JSON.stringify(mode)}; applyEnhance();
    }
    return document.body.className;
  })()`);
  await new Promise((r) => setTimeout(r, 220));
  process.stdout.write(`  capture ${file} … `);
  const shot = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
    clip: { x: Math.round(geo.x), y: Math.round(geo.y), width: W, height: H, scale: 1 },
  }, 30000);
  if (!shot.result?.data) { console.error(`capture failed for ${file}: ${JSON.stringify(shot).slice(0, 200)}`); process.exit(1); }
  writeFileSync(join(OUT, `${file}.png`), Buffer.from(shot.result.data, 'base64'));
  console.log(`ok ${label}`);
}

// 收尾:把探针样式删掉、档位恢复默认(隔离 profile 里也保持干净)
await val(`(() => { document.getElementById('__codeStyleProbe')?.remove(); document.getElementById('__codeStyleBackdrop')?.remove(); S.codeStyle = 'wash'; applyEnhance(); return 1; })()`);
await send('Emulation.setDefaultBackgroundColorOverride', {});
console.log(`== ${STATES.length} 张截图(${BACKDROP ? "壁纸底真合成" : "页面层透明"}) → ${OUT} ==`);
ws.close();      // 不关 WebSocket,Node 的事件循环不会退,调用方(&& 链)会一直等 —— 踩过一次
process.exit(0);
