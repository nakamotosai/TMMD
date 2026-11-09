// r12j-v193-fixes.mjs — v1.9.3 修复回归跑道(2026-11-09)。
// 覆盖本轮的 P0 与宽度模型换血,判据全部可复跑。与 r12d/r12e/r12g 同手法:单 WS 直连 CDP。
// 用法:先起调试实例(tools/verify/launch-on-secondary.ps1,或 tmp 里的离屏启动器)→ node e2e/r12j-v193-fixes.mjs [--port=9223]
// 安全:开头只查连通性,不通 exit 2;所有测试文件建在 os.tmpdir 的独立子目录,含一个 GBK 与一个 UTF-16 文件;
//       结束时删标签、删文件;不碰用户真实库(不动 roots.json)。
import { writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const port = (args.find((a) => a.startsWith('--port=')) || '--port=9223').split('=')[1];
const timeout = Number((args.find((a) => a.startsWith('--timeout=')) || '--timeout=10000').split('=')[1]) || 10000;

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
const send = (method, params, ms) => {
  const id = ++seq;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pending.delete(id); resolve({ timeout: true }); }, ms || timeout);
    pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
    ws.send(JSON.stringify({ id, method, params }));
  });
};
const ev = (expr, ms) => send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, ms);
async function val(expr, ms) {
  const r = await ev(expr, ms);
  if (r.timeout) throw new Error(`evaluate timeout: ${String(expr).slice(0, 80)}`);
  if (r.result?.exceptionDetails) throw new Error(`JS EXCEPTION: ${JSON.stringify(r.result.exceptionDetails).slice(0, 240)}`);
  return r.result?.result?.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitBoot(ms = 30000) {
  const t0 = Date.now();
  for (;;) {
    try { const r = await ev(`(() => typeof S !== 'undefined' && typeof setLang === 'function')()`, 3000); if (r.result?.result?.value === true) return; } catch { /* reload */ }
    if (Date.now() - t0 > ms) throw new Error('页面 30s 内未就绪');
    await sleep(250);
  }
}
const results = { pass: 0, fail: 0, fails: [] };
function ok(id, name, cond, extra) {
  if (cond) { results.pass++; console.log(`  ok   ${id} ${name}`); }
  else { results.fail++; results.fails.push(`${id} ${name}`); console.log(`  FAIL ${id} ${name}${extra !== undefined ? ' :: ' + JSON.stringify(extra).slice(0, 400) : ''}`); }
}
const q = (s) => JSON.stringify(s);
const winPath = (p) => p.replace(/\//g, '\\');
const SAFE_RE = /tmmd-e2e-v193/i;

const ROOT = join(tmpdir(), 'tmmd-e2e-v193');
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });
const P = {
  plain: join(ROOT, 'plain.md'),
  wide: join(ROOT, 'wide.md'),
  bom: join(ROOT, 'bom.md'),
  gbk: join(ROOT, 'gbk.md'),
  u16: join(ROOT, 'u16.md'),
  conflict: join(ROOT, 'conflict.md'),
};

const WIDE = [
  '# 宽度探针', '',
  '中文正文用来量行宽与行高。中文正文用来量行宽与行高。中文正文用来量行宽与行高。中文正文用来量行宽与行高。', '',
  '| 账号 | 链接 |', '|---|---|',
  '| Abroad in Japan | youtube.com/channel/UCx6Hq0FzVfZ0VfZ0VfZ0VfZ0 |',
  '| Rachel and Jun | youtube.com/channel/UCanotherverylongchannelidentifier123 |', '',
].join('\n');
writeFileSync(P.plain, '# 标题\n\n正文 **bold** 与 [链接](https://example.com/)\n\n## Target\n');
writeFileSync(P.wide, WIDE);
writeFileSync(P.bom, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('# 中文标题\n\n正文\n', 'utf8')]));
// GBK:"# 中文标题\n\n正文\n"(手工字节,不引依赖)
writeFileSync(P.gbk, Buffer.from([0x23, 0x20, 0xD6, 0xD0, 0xCE, 0xC4, 0xB1, 0xEA, 0xCC, 0xE2, 0x0A, 0x0A, 0xD5, 0xFD, 0xCE, 0xC4, 0x0A]));
// UTF-16LE with BOM
writeFileSync(P.u16, Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from('# 中文标题\n\n正文\n', 'utf16le')]));
writeFileSync(P.conflict, '# conflict\n\n原始内容\n');

async function cleanup() {
  try {
    await val(`(() => { try { leaveEdit(); } catch (e) {} S.tabs = []; S.activeKey = null; S.cur = null; renderEmpty(); renderTabs(); return 1; })()`, 3000);
  } catch { /* ignore */ }
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
}

try {
  await waitBoot();

  // ---------- J01 ACL:set_lang 必须真的被放行 ----------
  const j01 = await val(`(async () => { try { await invoke('set_lang', { lang: 'zh' }); return 'ok'; } catch (e) { return 'rej:' + String(e).slice(0, 120); } })()`, 8000);
  ok('J01', 'set_lang 被 ACL 放行(旧版 allow-set-lang 未登记 → 一直被拒)', j01 === 'ok', j01);

  // ---------- J02 宽度:整篇铺满阅读区 + 宽表不被裁 + 全篇同一列宽 ----------
  await val(`(async () => { await invoke('open_path', { path: ${q(winPath(P.wide))} }); await openTab({ abs: ${q(winPath(P.wide))}, kind: 'ext' }); await new Promise(r=>setTimeout(r,700)); return 1; })()`, 12000);
  const j02 = await val(`(() => {
    const r = document.getElementById('reader'), inner = document.getElementById('readerInner');
    const wrap = inner.querySelector('.md-table-wrap'), t = wrap && wrap.querySelector('table');
    const g = (e) => e.getBoundingClientRect();
    const cs = getComputedStyle(inner);
    const pad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    // 顶级块的左右缘必须全部一致(旧 bug:标题/段落居中限宽,表格铺满 → 两种列宽)
    const lefts = [...new Set(['p','h1','h2','blockquote','.md-table-wrap','pre']
      .map((s) => inner.querySelector(s)).filter(Boolean)
      .map((e) => Math.round(g(e).left)))];
    const rights = [...new Set(['p','h1','h2','blockquote','.md-table-wrap','pre']
      .map((s) => inner.querySelector(s)).filter(Boolean)
      .map((e) => Math.round(g(e).right)))];
    return { readerW: Math.round(g(r).width), slotW: Math.round(g(inner).width), pad: Math.round(pad),
      lefts, rights,
      tableOver: t ? Math.round(g(t).right - g(wrap).right) : null,
      wrapOver: wrap ? wrap.scrollWidth - wrap.clientWidth : null,
      pageOver: document.documentElement.scrollWidth - window.innerWidth };
  })()`, 6000);
  ok('J02', '阅读槽吃满阅读区(slot≈reader)', j02 && Math.abs(j02.slotW - j02.readerW) <= 2, j02);
  ok('J03', '超宽表格不再被裁 / 不需横向滚', j02 && j02.tableOver <= 1 && j02.wrapOver <= 1, j02);
  ok('J04', '最大化后页面无横向滚动条', j02 && j02.pageOver <= 0, j02);
  // v1.9.4:整篇同宽 —— 用户实拍投诉「有的扩展到两边 有的还是中间」,这条就是防它复发
  ok('J05', '全篇同一列宽(标题/正文/表格左右缘全一致)', j02 && j02.lefts.length === 1 && j02.rights.length === 1, j02);

  // ---------- J06 编码:GBK / UTF-16 ----------
  const j06 = await val(`(async () => {
    const out = {};
    for (const [k, p] of [['gbk', ${q(winPath(P.gbk))}], ['u16', ${q(winPath(P.u16))}], ['bom', ${q(winPath(P.bom))}]]) {
      try { const raw = await invoke('open_path', { path: p }); out[k] = { ok: true, head: raw.slice(0, 12), hasBom: /^\\uFEFF/.test(raw) }; }
      catch (e) { out[k] = { ok: false, err: String(e).slice(0, 100) }; }
    }
    return out;
  })()`, 12000);
  ok('J06', 'GBK 中文文档能读且不乱码', j06 && j06.gbk.ok && j06.gbk.head.includes('中文标题'), j06);
  ok('J07', 'UTF-16LE 中文文档能读', j06 && j06.u16.ok && j06.u16.head.includes('中文标题'), j06);
  ok('J08', '读出的文本不再带 BOM(前端不必再自己剥)', j06 && j06.bom.ok && j06.bom.hasBom === false, j06);

  // ---------- J09 BOM 不重复累积:读 → 存 → 再读 ----------
  const before = readFileSync(P.bom);
  await val(`(async () => { await invoke('open_path', { path: ${q(winPath(P.bom))} }); await openTab({ abs: ${q(winPath(P.bom))}, kind: 'ext' }); enterEdit(); const ed = $id('editor'); ed.value = '# 中文标题\\n\\n正文改了\\n'; ed.dispatchEvent(new Event('input', { bubbles: true })); await saveEdit(); await new Promise(r=>setTimeout(r,400)); leaveEdit(); return 1; })()`, 12000);
  const after = readFileSync(P.bom);
  const countBom = (b) => { let n = 0; let i = 0; while (i + 2 < b.length && b[i] === 0xEF && b[i + 1] === 0xBB && b[i + 2] === 0xBF) { n++; i += 3; } return n; };
  ok('J09', '带 BOM 的文档存一次不会多出第二个 BOM(旧版每存一次多一个)', countBom(before) === 1 && countBom(after) === 1, { before: countBom(before), after: countBom(after), afterBytes: after.length });

  // ---------- J10 冲突基线:首存也建基线,外部改动后必须报冲突 ----------
  await val(`(async () => { await invoke('open_path', { path: ${q(winPath(P.conflict))} }); await openTab({ abs: ${q(winPath(P.conflict))}, kind: 'ext' }); enterEdit(); const ed = $id('editor'); ed.value = '# conflict\\n\\n我改的\\n'; ed.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`, 8000);
  await sleep(1200);                                   // 让后端记住刚读到的内容
  writeFileSync(P.conflict, '# conflict\n\n外部编辑器改的\n');   // 模拟别的编辑器改动
  const j10 = await val(`(async () => { const r = await writeTabContent(getTab(${q(winPath(P.conflict))}), '# conflict\\n\\n我改的\\n', false); return String(r); })()`, 10000);
  ok('J10', '外部改动后保存被拦成冲突(不再静默覆盖)', String(j10).includes('conflict'), j10);
  await val(`(() => { try { leaveEdit(); } catch (e) {} return 1; })()`, 3000);
  ok('J11', '磁盘上的外部改动原样保留(没有被我们覆盖)', readFileSync(P.conflict, 'utf8').includes('外部编辑器改的'), readFileSync(P.conflict, 'utf8'));
  ok('J12', '沙箱护栏:活动文件都在 tmmd-e2e-v193 下', SAFE_RE.test(String(await val(`S.cur ? S.cur.abs : ''`, 2000))), await val(`S.cur ? S.cur.abs : ''`, 2000));

  // ---------- J13 渲染管线(在真 Tauri 里重跑一遍静态探针的核心几条) ----------
  const j13 = await val(`(() => {
    const at = ${q(winPath(P.plain))};
    const runs = [];
    for (let i = 0; i < 3; i++) { renderMarkdown('# A\\n\\n## Same\\n\\n## Same\\n\\n## Target\\n', at); runs.push([...document.querySelectorAll('.markdown-body h2')].map((h) => h.id).join(',')); }
    renderMarkdown('[go](#target)\\n\\n## Target\\n', at);
    const anchorOk = !!document.getElementById('target');
    renderMarkdown('<iframe srcdoc="<script>x</script>"></iframe>\\n\\n<object data="a"></object>', at);
    const san = { iframe: document.querySelectorAll('.markdown-body iframe').length, object: document.querySelectorAll('.markdown-body object').length };
    renderMarkdown('$$\\nE=mc^2\\n$$\\n\\nI paid $5 and $10 today.', at);
    const math = { block: !!document.querySelector('.md-math-block .katex-display'), money: (document.querySelector('.markdown-body p')||{}).textContent || '' };
    renderMarkdown('a **nee**dle here\\n', at);
    document.getElementById('findBar').hidden = false;
    document.getElementById('findInput').value = 'needle'; runFind('needle');
    const findHits = document.querySelectorAll('mark.srh-hit').length;
    document.getElementById('findBar').hidden = true; runFind('');
    renderMarkdown('\\u0060\\u0060\\u0060js\\nconst a = 1;\\nconst b = 2;\\n\\u0060\\u0060\\u0060\\n', at);
    const codeTxt = document.querySelector('.markdown-body pre code').textContent;
    renderMarkdown('x[^1] y[^1]\\n\\n[^1]: def with **bold**\\n', at);
    const fnIds = [...document.querySelectorAll('sup.fn-ref')].map((e) => e.id);
    return { runs, anchorOk, san, math, findHits, codeTxt, fnIds };
  })()`, 15000);
  ok('J13', '标题 id 三次渲染一致', j13 && j13.runs[0] === j13.runs[1] && j13.runs[1] === j13.runs[2], j13 && j13.runs);
  ok('J14', '文内锚点目标存在', j13 && j13.anchorOk === true, j13 && j13.anchorOk);
  ok('J15', 'iframe / object 不再是活元素', j13 && j13.san.iframe === 0 && j13.san.object === 0, j13 && j13.san);
  ok('J16', '块级 $$ 跨行渲染 + $5/$10 不被吞', j13 && j13.math.block === true && j13.math.money.replace(/\s+/g, '') === 'Ipaid$5and$10today.', j13 && j13.math);
  ok('J17', '跨 <strong> 的查找命中', j13 && j13.findHits >= 1, j13 && j13.findHits);
  ok('J18', 'pre code.textContent 不含行号', j13 && !/1\\s*const/.test(j13.codeTxt) && !j13.codeTxt.includes('1const'), j13 && j13.codeTxt);
  ok('J19', '同一脚注引用两次 id 唯一', j13 && j13.fnIds.length === 2 && new Set(j13.fnIds).size === 2, j13 && j13.fnIds);

  // ---------- J20 打印媒体 ----------
  await send('Emulation.setEmulatedMedia', { media: 'print' });
  await sleep(150);
  const j20 = await val(`(() => { const tb = document.querySelector('.topbar'); const md = document.querySelector('.markdown-body'); return { tb: tb ? getComputedStyle(tb).display : 'x', anim: md ? getComputedStyle(md).animationName : 'x' }; })()`, 5000);
  await send('Emulation.setEmulatedMedia', { media: '' });
  ok('J20', 'print 媒体下顶栏隐藏 + 入场动画关掉', j20 && j20.tb === 'none' && j20.anim === 'none', j20);

  // ---------- J21 外链不就地导航 ----------
  const j21 = await val(`(() => {
    renderMarkdown('[ext](https://example.com/x)', ${q(winPath(P.plain))});
    const before = location.href;
    const a = document.querySelector('.markdown-body a[href^="https"]');
    const e = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    a.dispatchEvent(e);
    return { prevented: e.defaultPrevented, same: location.href === before };
  })()`, 6000);
  ok('J21', '外链点击被拦住,阅读器不被换成网站', j21 && j21.prevented === true && j21.same === true, j21);
} catch (e) {
  results.fail++;
  results.fails.push('EXCEPTION ' + e.message);
  console.log('  FAIL EXCEPTION :: ' + e.message);
} finally {
  await cleanup();
  try { ws.close(); } catch { /* ignore */ }
}

console.log(`\n== ${results.pass} pass / ${results.fail} fail ==`);
if (results.fail) { console.log('FAILS:\n' + results.fails.join('\n')); process.exit(1); }
