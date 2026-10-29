// r12i · 更新提示闸:上游有新版本时,本地**不用用户动手**就必须看得见。
//
// 立闸原因(2026-10-29,用户实测报):
//   「我还真测试成功了,确实自己升级了一个新版本。但是它有新版本怎么完全没有任何提示啊?
//     比如说我上游有了新版本之后,它应该本地也能弹出来……我现在是在设置面板里主动按了之后才知道。」
//   两个原因叠在一起:
//     1) 后端把"省一次网络请求"(24h 节流)和"要不要告诉用户"混在同一个 if 里 —— 节流命中直接
//        `Ok(None)`,前端于是显示"已是最新版本"。**上次检查之后才发布的新版,本地最长 24 小时无声。**
//     2) 唯一信号是 `toast()` 一次(2.6s 消失);窗口没在前台基本等于没有。
//   还有一个顺带洞:刚装完新版本,`last_checked` 是上一版留下的,于是新版本第一次启动也不查。
//
// 手段:后端有 `TMMD_UPDATE_ENDPOINT` 测试缝(设了它才放行 http://127.0.0.1)。这里起一个本地清单
// 服务器,逐案换版本号 / 预置 update_state.json,起隔离实例(隐藏桌面 + 临时配置),只读地看:
//   · 有没有**自己弹**安装弹窗(`.askcard`,不看设置面板、不点任何东西)
//   · 顶栏设置键上的标记(`#updDot` 是否可见)
//   · 设置行读数(`#updState` 文本)
//   · 这一案到底打没打网络(服务器请求计数)
// 四个案子:
//   A 冷启动有新版        → 4s 后自动弹窗 + 标记 + 打过一次网络
//   B 节流(刚查过 + 有缓存)→ 仍然弹 + 标记,**但一次网络都不打**(这就是用户报的那个洞)
//   C 用户点过"稍后"      → 3 天内不弹,但标记仍在(有痕迹、不烦人)
//   D 上游追平当前版本    → 不弹、不标记、设置行"已是最新版本"(不能把缓存里的旧新版一直报下去)
//
// 用法:cd /f/projects/tmmd && node e2e/r12i-update-notify.mjs [--exe=...] [--port=9431]
// 说明:自起自收 —— 每案一条全新实例,案与案之间等上一条进程真的消失(单实例锁会把第二条转给第一条)。
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const argOf = (k, d) => { const hit = args.find((a) => a.startsWith('--' + k + '=')); return hit ? hit.slice(k.length + 3) : d; };
const CDP_PORT = Number(argOf('port', '9431'));
const MFD_PORT = Number(argOf('mport', '9432'));
const EXE = resolve(argOf('exe', 'src-tauri/target/debug/tmmd.exe'));
const RUNNER = argOf('runner', 'C:/Users/sai/.omp/data/tmmd-verify/run-tmmd-cdp.ps1');
if (!existsSync(EXE)) { console.error('找不到 exe: ' + EXE); process.exit(2); }
const CUR = JSON.parse(readFileSync('package.json', 'utf8')).version;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = { pass: 0, fail: 0, fails: [] };
function ok(name, cond, extra) {
  if (cond) { results.pass++; console.log(`  ok   ${name}`); }
  else { results.fail++; results.fails.push(name); console.log(`  FAIL ${name}${extra !== undefined ? ' :: ' + JSON.stringify(extra).slice(0, 400) : ''}`); }
}

// ---------- 本地清单服务器 ----------
let manifest = null;
let hits = 0;
const server = createServer((req, res) => {
  if (req.url && req.url.startsWith('/latest.json')) {
    hits++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(manifest));
    return;
  }
  res.writeHead(404); res.end('not found');
});
await new Promise((r) => server.listen(MFD_PORT, '127.0.0.1', r));
const fake = (v) => ({
  version: v,
  asset: `TMMD_${v}_x64-setup.exe`,
  url: `http://127.0.0.1:${MFD_PORT}/TMMD_${v}_x64-setup.exe`,
  sha256: 'a'.repeat(64),
  size: 4242,
  notes: 'r12i fake manifest -- do not install',
});
const ENDPOINT = `http://127.0.0.1:${MFD_PORT}/latest.json`;

// ---------- CDP 连接(沿用 r12h 的挑 target 策略:Tauri 重载瞬间会有 about:blank) ----------
let ws = null, seq = 0; const pending = new Map();
function ev(expr, ms) {
  const id = ++seq;
  return new Promise((res) => {
    const timer = setTimeout(() => { pending.delete(id); res({ timeout: true }); }, ms || 8000);
    pending.set(id, (m) => { clearTimeout(timer); res(m); });
    if (!ws || ws.readyState !== 1) { clearTimeout(timer); pending.delete(id); res({ timeout: true }); return; }
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
  });
}
async function val(expr, ms) {
  const r = await ev(expr, ms);
  if (r.timeout) throw new Error('evaluate timeout: ' + expr.slice(0, 100));
  if (r.result?.exceptionDetails) throw new Error('JS EXCEPTION: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 300));
  return r.result?.result?.value;
}
async function connect() {
  const deadline = Date.now() + 25000;
  let lastErr = 'n/a';
  for (;;) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
      const pages = (targets || []).filter((t) => t.type === 'page');
      const cand = pages.find((t) => /tauri\.localhost/.test(t.url || '')) || pages.find((t) => t.url && t.url !== 'about:blank');
      if (cand) {
        if (!ws || ws.readyState !== 1) {
          ws = new WebSocket(cand.webSocketDebuggerUrl);
          await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws connect failed')); });
          ws.onmessage = (e) => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
        }
        // 就绪判据必须两个版本都在(app 上下文 + 顶栏):否则拿旧包跑本闸会卡在连接阶段,
        // 而不是把"旧包没有标记/没有弹窗"如实报成 FAIL。
        const ready = await ev(`(function(){ return typeof S === 'object' && typeof t === 'function' && !!document.querySelector('.topbar'); })()`, 4000);
        if (ready && !ready.timeout && ready.result?.result?.value === true) return;
        lastErr = 'app context not ready';
      } else lastErr = 'no page target';
    } catch (e) { lastErr = e.message; }
    if (Date.now() > deadline) throw new Error('CDP 未就绪: ' + lastErr);
    await sleep(700);
  }
}
function closeWs() { if (ws) { try { ws.close(); } catch (e) { /* ignore */ } } ws = null; pending.clear(); }

// ---------- 起/收一条隔离实例 ----------
const root = mkdtempSync(join(tmpdir(), 'tmmd-r12i-'));
let child = null, appPid = null;
async function launch(cfgDir, seedState) {
  mkdirSync(cfgDir, { recursive: true });
  if (seedState) writeFileSync(join(cfgDir, 'update_state.json'), JSON.stringify(seedState, null, 2));
  child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', RUNNER,
    '-Port', String(CDP_PORT), '-Exe', EXE,
    '-ProfileDir', join(cfgDir, 'webview'), '-CfgDir', cfgDir, '-Desktop', 'TMMDR12I'],
  { env: { ...process.env, TMMD_UPDATE_ENDPOINT: ENDPOINT }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });
  const deadline = Date.now() + 25000;
  for (;;) {
    const m = /pid=(\d+)/.exec(out);
    if (m) { appPid = Number(m[1]); break; }
    if (Date.now() > deadline) throw new Error('实例没起来: ' + out.slice(-400));
    await sleep(300);
  }
  await connect();
}
async function stop() {
  closeWs();
  if (appPid) { try { spawn('taskkill', ['/PID', String(appPid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* ignore */ } }
  if (child) { try { child.kill(); } catch (e) { /* ignore */ } }
  // 等真的消失:单实例锁会把下一条实例转给还活着的那条
  const deadline = Date.now() + 10000;
  for (;;) {
    let alive = false;
    try { await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, { signal: AbortSignal.timeout(400) }); alive = true; } catch (e) { alive = false; }
    if (!alive) break;
    if (Date.now() > deadline) { console.log('  warn 上一实例的 CDP 还在响应,继续下一案可能被单实例锁转走'); break; }
    await sleep(400);
  }
  child = null; appPid = null;
  await sleep(400);
}

// 页面侧探针:弹窗 / 标记 / 读数
const PROBE = `(function () {
  const card = document.querySelector('.askcard');
  const dot = document.getElementById('updDot');
  const st = document.getElementById('updState');
  return {
    dialog: !!card,
    dialogTitle: card ? (card.querySelector('.ask-title') || {}).textContent : null,
    badge: dot ? !dot.hidden : null,
    badgeTitle: dot ? dot.getAttribute('title') : null,
    status: st ? st.textContent : null,
  };
})()`;
async function waitProbe(pred, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    const p = await val(PROBE);
    if (pred(p)) return p;
    if (Date.now() > deadline) return p;
    await sleep(500);
  }
}

const t0 = Date.now();
console.log('== r12i 更新提示闸 ==');
console.log(`exe=${EXE}\n当前版本=${CUR}  清单服务器=:${MFD_PORT}  CDP=:${CDP_PORT}`);

// ---------- A:冷启动有新版 → 自己弹 + 挂标记 + 打过网络 ----------
hits = 0; manifest = fake('9.9.9');
await launch(join(root, 'A'), null);
const appVer = await val(`window.__TAURI__.app.getVersion()`, 8000).catch(() => null);
ok('A0 实例版本号与 package.json 一致(判据依赖它)', appVer === CUR, { appVer, CUR });
const a = await waitProbe((p) => p.dialog, 14000);
ok('A1 有新版时**自己弹**安装弹窗(不看设置面板、不点任何东西)', a.dialog === true && String(a.dialogTitle || '').includes('9.9.9'), a);
ok('A2 顶栏设置键挂上更新标记', a.badge === true, a);
ok('A3 这一案确实打过网络(不是靠缓存蒙对)', hits >= 1, { hits });
const aState = JSON.parse(readFileSync(join(root, 'A', 'update_state.json'), 'utf8'));
ok('A4 检查结果落盘:remote 与 checked_by_version 都写上', aState.remote && aState.remote.version === '9.9.9' && aState.checked_by_version === CUR, aState);
await stop();

// ---------- B:刚查过(节流命中)+ 缓存里有新版 → 仍然弹,但一次网络都不打 ----------
// 这就是用户报的洞:旧版在这里返回 None → 前端显示"已是最新版本" → 本地整天无声。
hits = 0; manifest = fake('9.9.9');
await launch(join(root, 'B'), {
  last_checked: Math.floor(Date.now() / 1000),
  last_prompted: null,
  skipped_version: null,
  remind_after: null,
  remote: fake('9.9.9'),
  checked_by_version: CUR,
});
const b = await waitProbe((p) => p.dialog, 14000);
ok('B1 节流命中时仍然弹(缓存里的新版不能被"省一次请求"吞掉)', b.dialog === true, b);
ok('B2 标记同时在', b.badge === true, b);
ok('B3 这一案一次网络都没打(证明走的是缓存分支,不是偷偷联网)', hits === 0, { hits });
await stop();

// ---------- C:点过"稍后" → 不弹,但标记还在 ----------
hits = 0; manifest = fake('9.9.9');
await launch(join(root, 'C'), {
  last_checked: Math.floor(Date.now() / 1000),
  last_prompted: '9.9.9',
  skipped_version: null,
  remind_after: Math.floor(Date.now() / 1000) + 3 * 24 * 3600,
  remote: fake('9.9.9'),
  checked_by_version: CUR,
});
const c = await waitProbe((p) => p.badge === true, 14000);
ok('C1 说过"稍后":3 天内不弹窗', c.dialog === false, c);
ok('C2 但标记还在(有你没看见过的痕迹,不靠记忆)', c.badge === true, c);
ok('C3 读数是"发现新版 9.9.9"而不是"已是最新"', String(c.status || '').includes('9.9.9'), c);
await stop();

// ---------- D:上游追平当前版本 → 不弹、不标记、读数"已是最新版本" ----------
hits = 0; manifest = fake(CUR);
await launch(join(root, 'D'), {
  last_checked: 1,                      // 很久以前查过:放行网络
  last_prompted: null,
  skipped_version: null,
  remind_after: null,
  remote: fake('9.9.9'),                // 故意留一个"上一次看到的新版",必须被清掉
  checked_by_version: '0.0.0',
});
const d = await waitProbe((p) => String(p.status || '').includes('已是最新') || p.dialog, 14000);
ok('D1 上游追平:不弹窗', d.dialog === false, d);
ok('D2 上游追平:标记不挂', d.badge !== true, d);
ok('D3 读数回到"已是最新版本"', String(d.status || '').includes('已是最新版本'), d);
const dState = JSON.parse(readFileSync(join(root, 'D', 'update_state.json'), 'utf8'));
ok('D4 追平后清掉缓存 remote(否则会一直报一个不存在的新版)', dState.remote == null, dState);
ok('D5 这一案打了网络(确实是新鲜答案)', hits >= 1, { hits });
await stop();

server.close();
try { rmSync(root, { recursive: true, force: true }); } catch (e) { /* ignore */ }

console.log(`\n== r12i: pass=${results.pass} fail=${results.fail} ==`);
if (results.fails.length) console.log('failures:\n  - ' + results.fails.join('\n  - '));
console.log(`\nWall time: ${((Date.now() - t0) / 1000).toFixed(2)} seconds`);
process.exit(results.fail ? 1 : 0);
