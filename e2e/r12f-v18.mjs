// r12f-v18.mjs — v1.8 第二批四项的运行验证 + 一类静态检查(node --check 抓不到的"未定义标识符")。
// 覆盖:
//   A) 运行时标识符探针:把 app.js 里所有"被调用但文件内从未声明、也不是参数/内建"的名字拿去
//     页面里 typeof 一遍 —— 2026-10-25 的 `StringtrErr(e)`(i18n 批量的 sed 事故)就属于这一类:
//     语法检查全绿,但保存/冲突路径一跑就 ReferenceError。这条探针就是为了让同类事故再也过不去。
//   B) 打字机模式:光标行是否稳定停在视口约 38%;关掉后是否恢复"不自动滚动"。
//   C) 库级搜索:排序(文件名命中 > 标题命中 > 正文)+ UI 按文件分组。
//   D) PDF 直出:导出 HTML 里图片是否内联成 data:;无头浏览器是否真的产出 PDF。
//   E) i18n:字典三语齐备、用到的键都在字典里、EN 界面不再夹整块中文。
// 用法:先起隔离实例(tools/verify/launch-on-secondary.ps1),再 node e2e/r12f-v18.mjs [--port=9225]
// 安全:全部测试文件建在 os.tmpdir 的独立子目录;roots.json 写进 **隔离配置目录**(TMMD_CONFIG_DIR),
//       绝不碰用户真实配置。不调用任何会弹窗/打开外部程序的命令(不 open_any)。
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const port = (args.find((a) => a.startsWith('--port=')) || '--port=9225').split('=')[1];
const timeout = Number((args.find((a) => a.startsWith('--timeout=')) || '--timeout=15000').split('=')[1]) || 15000;
const REPO = process.cwd();

// ---------- 1) CDP 连通性 ----------
let targets;
try {
  targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
} catch (e) {
  console.error(`CDP unreachable on :${port} — 先起调试实例(${e.message})`);
  process.exit(2);
}
const page = targets.find((t) => t.type === 'page');
if (!page) { console.error('no page target'); process.exit(2); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws connect failed')); });
let seq = 0;
const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
function ev(expr, ms) {
  const id = ++seq;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pending.delete(id); resolve({ timeout: true }); }, ms || timeout);
    pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
  });
}
async function val(expr, ms) {
  const r = await ev(expr, ms);
  if (r.timeout) throw new Error(`evaluate timeout: ${expr.slice(0, 120)}`);
  if (r.result?.exceptionDetails) throw new Error(`JS EXCEPTION: ${JSON.stringify(r.result.exceptionDetails).slice(0, 300)}`);
  return r.result?.result?.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (s) => JSON.stringify(String(s));
const results = { pass: 0, fail: 0, fails: [] };
function ok(name, cond, extra) {
  if (cond) { results.pass++; console.log(`  ok   ${name}`); }
  else { results.fail++; results.fails.push(name); console.log(`  FAIL ${name}${extra ? ' :: ' + JSON.stringify(extra).slice(0, 400) : ''}`); }
}

// ---------- 沙箱 ----------
const ROOT = join(tmpdir(), 'tmmd-e2e-v18');
const CFG = process.env.TMMD_CONFIG_DIR || join(tmpdir(), 'tmmd-verify-cfg');
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });
const winPath = (p) => p.replace(/\//g, '\\');
const SAFE_FILE_RE = /tmmd-e2e-v18/i;

async function guardSandbox() {
  const cur = String((await val(`S.cur ? S.cur.abs : ''`, 2000)) || '');
  if (cur && !SAFE_FILE_RE.test(cur)) {
    await val(`(() => { try { leaveEdit(); } catch (e) {} S.cur = null; S.activeKey = null; S.tabs = []; return 1; })()`, 2000);
    throw new Error(`护栏拦下:活动文件不在沙箱内(${cur}),已清空标签拒绝继续`);
  }
}

console.log('== r12f v1.8 运行验证 ==');

/* ═══════════ A) 运行时标识符探针 ═══════════ */
{
  const raw = readFileSync(join(REPO, 'ui-reader/app.js'), 'utf8');
  // 先剥注释与字符串字面量:否则中文注释/HTML 串里的词(如 `paint_glass`、`Previous`、`draft`)
  // 会被当成"被调用的标识符",探针全是假阳性。模板串保留 ${...} 里的真实代码。
  const src = raw
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/`(?:\\.|[^`\\])*`/g, (m) => (m.match(/\$\{[^}]*\}/g) || []).join(' '))
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""');
  const declared = new Set();
  for (const m of src.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
  for (const m of src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
  for (const m of src.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
  for (const m of src.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*:/g)) declared.add(m[1]);   // 对象键 / 简写
  for (const m of src.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)) {                              // 参数
    for (const p of m[1].split(',')) {
      const n = p.trim().replace(/^\.\.\./, '').split(/[:=]/)[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(n)) declared.add(n);
    }
  }
  // 对象字面量的简写方法:`image({...}) { ... }` / `acceptNode(n) { ... }` —— 是**声明**,不是调用
  for (const m of src.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{/g)) declared.add(m[1]);
  const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'new', 'await', 'do', 'else', 'in', 'of', 'delete', 'void', 'yield', 'super', 'import', 'case', 'async', 'get', 'set', 'var', 'let', 'const', 'this', 'try', 'throw', 'break', 'continue', 'instanceof', 'with', 'debugger']);
  const BUILTINS = new Set(['String', 'Number', 'Boolean', 'Array', 'Object', 'Math', 'JSON', 'Date', 'Map', 'Set', 'Promise', 'RegExp', 'Error', 'TypeError', 'RangeError', 'Symbol', 'BigInt', 'Proxy', 'Reflect', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'fetch', 'btoa', 'atob', 'alert', 'confirm', 'prompt', 'structuredClone', 'queueMicrotask', 'getComputedStyle', 'matchMedia', 'addEventListener', 'removeEventListener', 'dispatchEvent', 'URL', 'URLSearchParams', 'Blob', 'File', 'FileReader', 'TextEncoder', 'TextDecoder', 'AbortController', 'IntersectionObserver', 'ResizeObserver', 'MutationObserver', 'CustomEvent', 'Event', 'KeyboardEvent', 'MouseEvent', 'DragEvent', 'WeakMap', 'WeakSet', 'Intl', 'crypto', 'performance', 'console', 'Image', 'Audio', 'HTMLElement', 'Node', 'Element', 'DOMParser', 'XMLHttpRequest', 'Worker', 'top', 'self', 'window', 'document', 'location', 'navigator', 'history', 'screen', 'localStorage', 'sessionStorage', 'indexedDB', 'eval', 'Function', 'CSS', 'Notification', 'WebSocket', 'Path2D', 'OffscreenCanvas', 'DOMPoint', 'CanvasRenderingContext2D']);
  const cands = new Set();
  for (const m of src.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const n = m[1];
    if (KEYWORDS.has(n) || BUILTINS.has(n) || declared.has(n)) continue;
    cands.add(n);
  }
  const list = [...cands];
  const probe = `(() => { const out = []; for (const n of ${JSON.stringify(list)}) { let dead = false; try { eval(n); } catch (e) { dead = (e instanceof ReferenceError); } if (dead) out.push(n); } return out; })()`;
  const bad = (await val(probe, 30000)) || [];
  console.log(`  探针候选 ${list.length} 个`);
  ok('A1 无未被声明的标识符被调用', bad.length === 0, bad);
  const selfTest = await val(`(() => { try { eval('__definitely_missing__'); return 'no-throw'; } catch (e) { return e instanceof ReferenceError ? 'THROWS' : 'other'; } })()`);
  ok('A2 探针自身有效(未声明名会被抓到)', selfTest === 'THROWS', selfTest);
  // 反向自检:探针必须真能通过(否则"全绿"是假的)——trErr 是全项目都在用的真实函数
  ok('A3 探针能认出真实存在的函数(trErr)', (await val(`(typeof trErr === 'function') ? 'yes' : 'no'`)) === 'yes');
  // A4 源码级复查:i18n 的 t('...') 绝不能落在"同作用域里也声明了 t"的地方。
  // 局部 `t`(形参 / 局部变量)会把全局 i18n 函数 t 遮蔽 → 运行时变成"把 tab 对象当函数调"。
  // 2026-10-25 实测 activateTabRaw(读文件失败提示)与 closeTab(关脏标签冲突)各有这种点位。
  //
  // 注意两点(初版在这里栽过):
  // ① 必须在**没剥字符串**的源码上扫 —— 上一版拿剥过字符串的 `src` 去匹配 `t('key')`,
  //    引号之间的键已被清空,匹配 0 次 ⇒ 这条断言恒真(假绿)。这里用 srcNoComments。
  // ② 作用域要按"最近的围栏"算,不能拿整个函数体做正则 —— 否则嵌套回调里的 `const t` 会把
  //    外层函数误判成遮蔽者(误报),而箭头形参 `(t) => ...` 又完全漏掉(漏报)。
  function scanShadowers(text) {
    const scopes = [];
    const re = /function\s+([A-Za-z_$\w]*)\s*\(([^)]*)\)\s*\{|\(([^)]*)\)\s*=>\s*\{|([A-Za-z_$][\w$]*)\s*=>\s*\{/g;
    let m;
    while ((m = re.exec(text))) {
      let i = m.index + m[0].length, depth = 1;
      while (i < text.length && depth > 0) { if (text[i] === '{') depth++; else if (text[i] === '}') depth--; i++; }
      scopes.push({ name: m[1] || '(arrow)', params: m[2] || m[3] || m[4] || '', start: m.index, bodyStart: m.index + m[0].length, end: i });
    }
    const out = [];
    for (const call of text.matchAll(/(?<![\w$.])t\('([A-Za-z0-9_.]+)'/g)) {
      const p = call.index;
      const infl = scopes.filter((s) => s.bodyStart <= p && p < s.end);
      if (!infl.length) continue;
      const s = infl.sort((a, b) => b.bodyStart - a.bodyStart)[0];
      // 形参文本可能带上抓歪的括号(如 `(t`):先切词再按裸标识符比对
      const paramNames = s.params.split(',').map((x) => x.trim().replace(/^[^\w$]+|[^\w$]+$/g, '').split(/[:=]/)[0]);
      const paramShadow = paramNames.includes('t');
      // 只看**本层直接写的**局部声明:把嵌套作用域的字符挖空再测
      const chars = text.slice(s.bodyStart, s.end).split('');
      for (const inner of scopes) {
        if (inner.start > s.start && inner.end <= s.end) for (let i = inner.start - s.bodyStart; i < inner.end - s.bodyStart; i++) chars[i] = ' ';
      }
      const direct = chars.join('');
      const localShadow = /\b(?:const|let|var)\s+t\b/.test(direct) || /\bfor\s*\(\s*(?:const|let|var)\s+t\s+(?:of|in)\b/.test(direct);
      if (paramShadow || localShadow) out.push(`${s.name}@${text.slice(0, p).split('\n').length}`);
    }
    return out;
  }
  const srcNoComments = raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  const shadowed = scanShadowers(srcNoComments);
  ok('A4 i18n 的 t() 不被局部 t 遮蔽', shadowed.length === 0, shadowed);
  // A5 自检:扫描器必须**真会报**(否则 A4 又是恒真假绿)——
  // 喂三段合成样本:形参遮蔽、局部遮蔽、干净代码,期望分别 1/1/0。
  const s1 = scanShadowers('function f(t) { toast(t(\'toast.x\')); }\n').length;
  const s2 = scanShadowers('function g() { const t = getTab(1); return t(\'toast.y\'); }\n').length;
  const s3 = scanShadowers('function h() { return t(\'toast.z\'); }\n').length;
  const s4 = scanShadowers('outer();\nS.tabs.forEach((t) => { t(\'toast.w\'); });\n').length;   // 箭头形参(初版漏报)
  const s5 = scanShadowers('function k() { fn(() => { const t = 1; t(); }); return t(\'toast.v\'); }\n').length; // 嵌套局部(初版误报)
  ok('A5 遮蔽扫描器自检(形参/局部/箭头/嵌套)', s1 === 1 && s2 === 1 && s3 === 0 && s4 === 1 && s5 === 0, { s1, s2, s3, s4, s5 });
}

/** 每节开头把实例恢复干净:关掉残留弹窗、退出编辑态(否则切页会弹三选窗,evaluate 必卡死)。 */
async function reset() {
  await val(`(async () => { try { const w = document.querySelector('.askwrap'); if (w) { const b = [...w.querySelectorAll('button')].find((x) => x.dataset.a === 'cancel') || w.querySelector('button'); if (b) b.click(); } } catch (e) {} try { leaveEdit(); } catch (e) {} S.editDirty = false; await new Promise((r) => setTimeout(r, 120)); return 1; })()`, 8000);
}


/* ═══════════ B) 打字机模式 ═══════════ */
{
  console.log('-- B 打字机 --');
  await reset();
  const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1} of the sandbox document`);
  const B_MD = join(ROOT, 'typewriter-probe.md');
  writeFileSync(B_MD, lines.join('\n') + '\n', 'utf8');
  await val(`(async () => { await invoke('open_path', { path: ${q(winPath(B_MD))} }); await openTab({ abs: ${q(winPath(B_MD))}, kind: 'ext' }); enterEdit(); return 1; })()`);
  await guardSandbox();
  // 造 300 行内容,光标放**第 60 行末**(后面还有 240 行)——放末尾会一路顶到底部(clamp),
  // 那时量到的是"到底了"而不是"跟随",第一版测试就是这么假失败的。
  const setup = `(() => { const ed = $id('editor'); const v = Array.from({ length: 300 }, (_, i) => 'row ' + i).join('\\n'); ed.value = v; const pos = v.split('\\n').slice(0, 60).join('\\n').length; ed.selectionStart = ed.selectionEnd = pos; ed.focus(); ed.dispatchEvent(new Event('input', { bubbles: true })); applyTypewriter(true); return 1; })()`;
  await val(setup, 5000);
  const measure = `(() => { const ed = $id('editor'); const lh = typewriterLineHeight(ed); const line = ed.value.slice(0, ed.selectionStart).split('\\n').length - 1; const ratio = (((line + 0.5) * lh) - ed.scrollTop) / ed.clientHeight; return { tw: S.editorTypewriter, lh: Math.round(lh * 10) / 10, line, ratio: Math.round(ratio * 1000) / 1000, bottomed: ed.scrollTop >= (ed.scrollHeight - ed.clientHeight) - 1 }; })()`;
  const on = await val(measure, 5000);
  ok('B1 开关生效(S.editorTypewriter=true)', on && on.tw === true, on);
  ok('B2 光标行落在视口 30%~46% 高度(且没顶到底)', on && on.ratio >= 0.30 && on.ratio <= 0.46 && on.bottomed === false, on);
  // 在光标处插入 30 个换行(光标下移,后面仍有 240 行):每一次都要落回 38% 附近
  const burst = `(() => { const ed = $id('editor'); const out = []; for (let i = 0; i < 30; i++) { const p = ed.selectionStart; ed.value = ed.value.slice(0, p) + '\\nins' + i + ed.value.slice(p); ed.selectionStart = ed.selectionEnd = p + 5; ed.dispatchEvent(new Event('input', { bubbles: true })); const lh = typewriterLineHeight(ed); const line = ed.value.slice(0, ed.selectionStart).split('\\n').length - 1; out.push(Math.round(((((line + 0.5) * lh) - ed.scrollTop) / ed.clientHeight) * 1000) / 1000); } return out; })()`;
  const ratios = (await val(burst, 15000)) || [];
  const worst = ratios.length ? Math.max(...ratios.map((r) => Math.abs(r - 0.38))) : 99;
  const notBottom = await val(`(() => { const ed = $id('editor'); return ed.scrollTop < (ed.scrollHeight - ed.clientHeight) - 1; })()`);
  ok('B3 连打 30 行后光标仍在 38%±8%(且未顶到底)', ratios.length === 30 && worst <= 0.08 && notBottom === true, { count: ratios.length, worst: Math.round(worst * 1000) / 1000, head: ratios.slice(0, 3), tail: ratios.slice(-3), notBottom });
  // 关掉开关:同样的输入不再被"钉"在 38% —— 光标行随原生行为往下漂,比例上升
  const off = await val(`(() => { const ed = $id('editor'); applyTypewriter(false); const ratio = () => { const lh = typewriterLineHeight(ed); const line = ed.value.slice(0, ed.selectionStart).split('\\n').length - 1; return ((((line + 0.5) * lh) - ed.scrollTop) / ed.clientHeight); }; const r0 = ratio(); for (let i = 0; i < 20; i++) { const p = ed.selectionStart; ed.value = ed.value.slice(0, p) + '\\nplain' + i + ed.value.slice(p); ed.selectionStart = ed.selectionEnd = p + 7; ed.dispatchEvent(new Event('input', { bubbles: true })); } return { tw: S.editorTypewriter, r0: Math.round(r0 * 1000) / 1000, r1: Math.round(ratio() * 1000) / 1000 }; })()`, 15000);
  ok('B4 关闭后不再被钉在 38%(比例随光标下移上漂)', off && off.tw === false && off.r1 > 0.5 && off.r1 > off.r0, off);
  await val(`(() => { try { leaveEdit(); } catch (e) {} return 1; })()`, 3000);
}

/* ═══════════ C) 库级搜索:排序 + 分组 ═══════════ */
{
  console.log('-- C 库搜索 --');
  await reset();
  const f1 = join(ROOT, 'zebra-notes.md');
  const f2 = join(ROOT, 'heading.md');
  const f3 = join(ROOT, 'body.md');
  writeFileSync(f1, '# notes\n' + 'filler\n'.repeat(48) + 'a zebra appears in the body of the name-hit file\n', 'utf8');
  writeFileSync(f2, '# zebra report\n' + 'filler\n'.repeat(20) + 'tail\n', 'utf8');
  writeFileSync(f3, '# other\n' + 'filler\n'.repeat(28) + 'the zebra is only in the body here\n', 'utf8');
  // roots.json 写进**隔离配置目录**(不是用户真实配置)
  mkdirSync(CFG, { recursive: true });
  writeFileSync(join(CFG, 'roots.json'), JSON.stringify([{ id: 'e2e-v18', name: 'v18-sandbox', path: winPath(ROOT) }], null, 2), 'utf8');
  const hits = await val(`(async () => await invoke('search_library', { query: 'zebra', limit: 200 }))()`, 20000);
  ok('C1 搜索有结果', Array.isArray(hits) && hits.length >= 3, Array.isArray(hits) ? hits.length : hits);
  const order = (hits || []).map((h) => String(h.path).split(/[\\/]/).pop());
  const firstOf = (n) => order.indexOf(n);
  ok('C2 文件名命中排第一', order[0] === 'zebra-notes.md', order.slice(0, 5));
  ok('C3 标题命中排在纯正文命中之前', firstOf('heading.md') >= 0 && firstOf('body.md') >= 0 && firstOf('heading.md') < firstOf('body.md'), { heading: firstOf('heading.md'), body: firstOf('body.md'), order });
  ok('C4 得分单调不增', (hits || []).every((h, i, a) => i === 0 || a[i - 1].score >= h.score), (hits || []).map((h) => h.score));
  // UI 分组
  const ui = await val(`(async () => { S.view = 'search'; S.search.q = 'zebra'; renderSide(); await runLibrarySearch(); await new Promise(r => setTimeout(r, 120)); const groups = [...document.querySelectorAll('.search-file')].map((g) => g.textContent); const rows = document.querySelectorAll('.search-hit').length; return { groups, rows, meta: (document.getElementById('libSearchMeta') || {}).textContent }; })()`, 20000);
  ok('C5 UI 按文件分组(3 组)', ui && ui.groups.length === 3, ui);
  ok('C6 每组有命中数徽标', ui && ui.groups.every((g) => /\d/.test(g)), ui && ui.groups);
  ok('C7 分组顺序与后端排序一致(第一组=文件名命中)', ui && /zebra-notes\.md/.test(ui.groups[0]), ui && ui.groups);
  ok('C8 命中行数=渲染行数', ui && ui.rows === (hits || []).length, ui && { rows: ui.rows, hits: (hits || []).length });
  // 搜索 UI 的 meta 文案不应是英文键名残留
  ok('C9 meta 文案已本地化', ui && ui.meta && !/search\./.test(ui.meta), ui && ui.meta);
}

/* ═══════════ D) PDF 直出 + 媒体内联 ═══════════ */
{
  console.log('-- D PDF 直出 --');
  await reset();
  // 1x1 透明 PNG
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const img = join(ROOT, 'tiny.png');
  writeFileSync(img, PNG);
  const D_MD = join(ROOT, 'pdf-probe.md');
  writeFileSync(D_MD, `# PDF 直出探针\n\n段落一。\n\n![tiny](tiny.png)\n\n- a\n- b\n\n\`\`\`js\nconst x = 1;\n\`\`\`\n`, 'utf8');
  await val(`(async () => { await invoke('open_path', { path: ${q(winPath(D_MD))} }); await openTab({ abs: ${q(winPath(D_MD))}, kind: 'ext' }); await new Promise(r => setTimeout(r, 700)); return 1; })()`, 10000);
  await guardSandbox();
  const exp = await val(`(async () => { const p = await exportCurrentHtml(); return { p, toast: (document.getElementById('toast') || {}).textContent }; })()`, 30000);
  const htmlPath = exp && exp.p;
  ok('D1 导出 HTML 成功', !!htmlPath && existsSync(htmlPath), exp);
  if (htmlPath && existsSync(htmlPath)) {
    const html = readFileSync(htmlPath, 'utf8');
    ok('D2 图片已内联成 data:', html.includes('data:image/png;base64,'), html.slice(0, 0) || { hasData: html.includes('data:image/'), len: html.length });
    ok('D3 图片无 asset:// 残留', !html.includes('asset://'), { hasAsset: html.includes('asset://') });
    ok('D4 打印页边距已内置(@page)', /@page\s*\{\s*margin:/.test(html), {});
    ok('D5 导出物含正文与代码(highlight 后的 code-wrap)', html.includes('段落一') && html.includes('code-wrap') && html.includes('hljs'), { hasPara: html.includes('段落一'), hasCode: html.includes('code-wrap'), hljs: html.includes('hljs') });
  }
  const pdfPath = String(htmlPath || '').replace(/\.html?$/i, '') + '.pdf';
  const pdf = await val(`(async () => { try { const p = await invoke('export_pdf', { htmlPath: ${q(htmlPath)}, pdfPath: ${q(pdfPath)} }); return { ok: true, p }; } catch (e) { return { ok: false, e: String((e && e.message) || e) }; } })()`, 60000);
  // D6/D7:PDF 直出是"有内核就真产出、没内核就诚实拒绝"——按**本机事实**分支断言,别假装有内核。
  // 语义:有内核时这两条是硬要求(没产出就是 bug);没内核时硬要求"可读拒绝 + 不留假 PDF"。
  const kernKeys = ['ProgramFiles(x86)', 'ProgramFiles', 'LOCALAPPDATA'];
  const kernRel = ['Microsoft\\Edge\\Application\\msedge.exe', 'Google\\Chrome\\Application\\chrome.exe',
    'BraveSoftware\\Brave-Browser\\Application\\brave.exe', 'Vivaldi\\Application\\vivaldi.exe',
    'Chromium\\Application\\chrome.exe'];
  const kern = [process.env.TMMD_PDF_BROWSER,
    ...kernKeys.flatMap((k) => (process.env[k] ? kernRel.map((r) => join(process.env[k], r)) : []))]
    .filter(Boolean).find((c) => existsSync(c));
  const pdfExists = existsSync(pdfPath);
  if (kern) {
    ok('D6 无头浏览器产出 PDF(命令无异常)', pdf && pdf.ok === true, { kern, pdf });
    const buf = pdfExists ? readFileSync(pdfPath) : Buffer.alloc(0);
    ok('D7 PDF 头合法且体积正常', pdfExists && buf.subarray(0, 5).toString() === '%PDF-' && buf.length > 800,
      { head: buf.subarray(0, 8).toString(), size: buf.length });
  } else {
    ok('D6 无内核时诚实拒绝(不假装成功)', pdf && pdf.ok === false && /存 PDF/.test(String(pdf.e || '')), { kern: null, pdf });
    ok('D7 拒绝时不留下假 PDF', !pdfExists, { pdfPath, pdfExists });
  }
  // 负面:HTML 不存在 → 可读错误,不抛系统框
  const neg = await val(`(async () => { try { await invoke('export_pdf', { htmlPath: 'C:\\\\tmmd-nonexistent\\\\nope.html', pdfPath: ${q(join(ROOT, 'nope.pdf'))} }); return { threw: false }; } catch (e) { return { threw: true, msg: String((e && e.message) || e) }; } })()`, 20000);
  ok('D8 负面路径给可读错误', neg && neg.threw === true && /导出 HTML 不存在/.test(neg.msg || ''), neg);
  // 导出物清理:留在沙箱目录里,随沙箱一起删;这里顺手确认它确实写在沙箱内
  ok('D9 导出物落在源文件同级', !!htmlPath && String(htmlPath).toLowerCase().startsWith(ROOT.toLowerCase()), { htmlPath, ROOT });
}

/* ═══════════ E) i18n ═══════════ */
{
  console.log('-- E i18n --');
  const dict = await val(`(() => { const bad = []; const keys = Object.keys(I18N); for (const k of keys) { const v = I18N[k]; if (!Array.isArray(v) || v.length !== 3 || v.some((s) => typeof s !== 'string' || !s.length)) bad.push(k); } return { keys: keys.length, bad }; })()`, 10000);
  ok('E1 字典每条都有 zh/en/ja 三语且非空', dict && dict.keys > 100 && dict.bad.length === 0, dict);
  const usedSrc = readFileSync(join(REPO, 'ui-reader/app.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  const used = await val(`(() => { const s = ${q(usedSrc)}; const m = [...s.matchAll(/(?<![\\w$.])t\\('([A-Za-z0-9_.]+)'/g)].map((x) => x[1]); const missing = [...new Set(m)].filter((k) => !(k in I18N)); return { used: new Set(m).size, missing }; })()`, 15000);
  ok('E2 代码里用到的 t() 键都在字典里', used && used.missing.length === 0, used);
  const cjk = (s) => /[\u4e00-\u9fff]/.test(String(s));
  const en = await val(`(() => { setLang('en'); const samples = { saveFail: t('toast.saveFail'), tooBig: trErr('文件过大(>8MB)'), outOfCage: trErr('路径越界: x'), read: trErr('读文件失败: 拒绝访问'), unmapped: trErr('不认识的后端错误') }; return samples; })()`, 10000);
  ok('E3 EN 下 toast 文案无中文', en && !cjk(en.saveFail), en);
  ok('E4 EN 下后端错误前缀已翻译(过大/越界/读)', en && !cjk(en.tooBig) && !cjk(en.outOfCage) && !cjk(en.read) && /too large/i.test(en.tooBig), en);
  ok('E5 未命中的错误原样露出(不吞信息)', en && en.unmapped.includes('不认识的后端错误'), en);
  const ja = await val(`(() => { setLang('ja'); return { saveFail: t('toast.saveFail'), tooBig: trErr('文件过大(>8MB)'), zh: I18N['toast.saveFail'][0], ja: I18N['toast.saveFail'][2] }; })()`, 10000);
  ok('E6 JA 文案确实与中文不同(真翻译过)', ja && ja.ja !== ja.zh && ja.saveFail === ja.ja, ja);
  ok('E7 JA 下错误前缀走日文', ja && ja.tooBig !== '文件过大(>8MB)' && !ja.tooBig.startsWith('文件过大(>'), ja && ja.tooBig);
  const zh = await val(`(() => { setLang('zh'); return { saveFail: t('toast.saveFail'), keyLeak: /^[a-z]+\\.[a-zA-Z]+$/.test(t('toast.saveFail')) }; })()`, 10000);
  ok('E8 切回中文正常', zh && cjk(zh.saveFail) && !zh.keyLeak, zh);
  // E9 字典**不能有重复键**:对象字面量里同名键后者覆盖前者,是"改了不生效"的经典来源
  // (2026-10-25 实测:err.tooBig 有两份,后一份把新文案顶掉,EN 面里 8MB 那段直接丢了)
  const dup = await val(`(() => { const s = ${q(readFileSync(join(REPO, 'ui-reader/app.js'), 'utf8'))}; const m = [...s.matchAll(/^  '([A-Za-z0-9_.]+)': \\[/gm)].map((x) => x[1]); const seen = new Set(); const d = []; for (const k of m) { if (seen.has(k)) d.push(k); seen.add(k); } return d; })()`, 15000);
  ok('E9 字典无重复键', Array.isArray(dup) && dup.length === 0, dup);
  // E10 ERR_MAP / ERR_TAIL_MAP 里引用的键必须都在字典里(这类引用是变量形式,普通扫不出来)
  const errKeys = await val(`(() => { const m1 = [...ERR_MAP, ...ERR_TAIL_MAP].map((x) => x[1]); const miss = [...new Set(m1)].filter((k) => !(k in I18N)); return { total: m1.length, miss }; })()`, 10000);
  ok('E10 错误映射引用的键都在字典里', errKeys && errKeys.miss.length === 0, errKeys);
  // E11 **覆盖度**(2026-10-25 复查后新增):把 src-tauri/src/lib.rs 里全部"命令层可能返回给 UI 的
  // 中文错误串"抽出来,喂进 trErr —— EN 结果一个中文字都不许剩。只查映射表存在是没用的
  // (E10 的写法漏掉了"表没写全"这种情形:路径越界/无法读取文件/回收站失败… 全都会漏)。
  // 动态段({e}/{rel}/{path})用 ASCII 占位符替掉,所以残留的 CJK 只可能来自"没被规则吃掉的中文说明"。
  const rustSrc = readFileSync(join(REPO, 'src-tauri/src/lib.rs'), 'utf8').replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ' ');
  const rustMsgs = new Set();
  for (const m of rustSrc.matchAll(/Err\(\s*(?:format!\()?\s*"((?:[^"\\]|\\.)*)"/g)) {
    const s = m[1];
    if (/[\u4e00-\u9fff]/.test(s)) rustMsgs.add(s.replace(/\{[^}]*\}/g, 'X').replace(/\\n/g, ' '));
  }
  for (const m of rustSrc.matchAll(/format!\(\s*"((?:[^"\\]|\\.)*)"/g)) {
    const s = m[1];
    if (/[\u4e00-\u9fff]/.test(s) && /失败|错误|不支持|不存在|非法|异常|不可信|过大|越界|无效/.test(s)) rustMsgs.add(s.replace(/\{[^}]*\}/g, 'X').replace(/\\n/g, ' '));
  }
  const list = [...rustMsgs];
  const cov = await val(`(() => {
    const out = [];
    setLang('en');
    for (const s of ${JSON.stringify(list)}) {
      const r = trErr(s);
      if (/[\\u4e00-\\u9fff]/.test(r)) out.push(s + '  =>  ' + r);
    }
    setLang('zh');
    return { total: ${JSON.stringify(list)}.length, leaks: out };
  })()`, 20000);
  ok('E11 后端命令层中文错误串在 EN 下零残留', cov && cov.leaks.length === 0, cov && { total: cov.total, leaks: cov.leaks.slice(0, 12) });
  await val(`(() => { toast(t('toast.refreshed')); return document.getElementById('toast').textContent; })()`, 5000);
}

/* ═══════════ F) 大文件策略(>8MB 必须给可读错误 + 出路提示,不静默死) ═══════════ */
{
  console.log('-- F 大文件策略 --');
  await reset();
  const big = join(ROOT, 'huge-probe.md');
  writeFileSync(big, '# huge\n' + 'a'.repeat(9 * 1024 * 1024), 'utf8');   // 9MB > MAX_BYTES(8MB)
  const r = await val(`(async () => { setLang('zh'); const before = S.tabs.length; await openTab({ abs: ${q(winPath(big))}, kind: 'ext' }); return { toast: (document.getElementById('toast') || {}).textContent || '', tabs: S.tabs.length, before, cur: S.cur ? S.cur.abs : null }; })()`, 20000);
  ok('F1 超大文件被拒且给出可读提示', r && /文件过大/.test(r.toast) && /8MB/.test(r.toast), r);
  ok('F2 提示带出路(可用默认程序打开)', r && /默认程序/.test(r.toast), r);
  ok('F3 没有留下空标签/脏状态', r && !/huge-probe/.test(String(r.cur || '')) && r.tabs === r.before, r);
  const rEn = await val(`(async () => { setLang('en'); await openTab({ abs: ${q(winPath(big))}, kind: 'ext' }); const s = (document.getElementById('toast') || {}).textContent || ''; setLang('zh'); return s; })()`, 20000);
  ok('F4 EN 下这条提示也不夹中文', rEn && !/[\u4e00-\u9fff]/.test(rEn) && /too large/i.test(rEn), rEn);
}

/* ═══════════ G) 5000 行大文档滚动帧率(实测,不靠感觉) ═══════════ */
{
  console.log('-- G 5000 行滚动帧率 --');
  await reset();
  const big5k = join(ROOT, 'big-5000.md');
  const body = Array.from({ length: 5000 }, (_, i) => `## 段落 ${i + 1}\n\n这是第 ${i + 1} 行的正文内容,用来把文档撑到 5000 行。\n`);
  writeFileSync(big5k, '# 5000 行压力测试\n\n' + body.join('\n'), 'utf8');
  await val(`(async () => { await openTab({ abs: ${q(winPath(big5k))}, kind: 'ext' }); await new Promise(r => setTimeout(r, 900)); return 1; })()`, 30000);
  const fps = await val(`(async () => {
    // 滚动容器是 #reader(app.css: .reader{overflow:auto})。
    // 2026-10-25 复核抓到:原来写的是 .reader-scroll —— 全仓没有这个类,回落到 document.scrollingElement(html),
    // 而 html/body 被 height:100% + overflow:hidden 锁死 ⇒ scrollTop 恒 0,**60 帧全是空转**,G2/G3 一直在给假绿。
    // 现在改成 #reader,并加 G4 断言"真的滚动了",防止再退化成空转。
    const sc = document.querySelector('#reader') || document.scrollingElement;
    const frames = []; let last = performance.now(); let moved = 0;
    const steps = 60;
    for (let i = 0; i < steps; i++) {
      await new Promise(r => requestAnimationFrame(() => r()));
      const now = performance.now(); frames.push(now - last); last = now;
      sc.scrollTop = (sc.scrollHeight - sc.clientHeight) * (i / (steps - 1));
      if (sc.scrollTop > moved) moved = sc.scrollTop;
    }
    frames.shift();
    const sorted = [...frames].sort((a, b) => a - b);
    const p = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
    return { n: frames.length, avg: Math.round(frames.reduce((a, b) => a + b, 0) / frames.length * 10) / 10, p50: Math.round(p(0.5) * 10) / 10, p95: Math.round(p(0.95) * 10) / 10, max: Math.round(sorted[sorted.length - 1] * 10) / 10, nodes: document.querySelectorAll('#readerInner h2, #readerInner p, #readerInner li').length, tallest: sc.scrollHeight, clientH: sc.clientHeight, moved: Math.round(moved) };
  })()`, 60000);
  ok('G1 5000 行文档真渲染(块节点 > 5000)', fps && fps.nodes > 5000, fps);
  ok('G2 滚动均帧 < 20ms(≥50fps)', fps && fps.avg < 20, fps);
  ok('G3 p95 帧 < 40ms(无长时间卡顿)', fps && fps.p95 < 40, fps);
  ok('G4 滚动真的发生了(scrollTop > 0,防退化成空转)', fps && fps.moved > 0 && fps.tallest > fps.clientH, fps);
  console.log(`  帧率样本: ${JSON.stringify(fps)}`);
}

/* ═══════════ H) 设置页:分区归类 + 右侧抽屉(改外观能看见正文) ═══════════
 * 2026-10-25 用户投诉两条:①"行内代码样式"放在「阅读增强」里找不到(它本质是外观);
 * ②设置整页把正文全挡掉、面板里又没有预览 → 改外观看不到效果。
 * 这两条都是**可观测**的:分区归属看 DOM,遮挡看几何。 */
{
  console.log('-- H 设置页 --');
  const h1 = await val(`(() => {
    const inTheme = !!document.querySelector('#sec-theme #setCodeStyleWash');
    const inEnhance = !!document.querySelector('#sec-enhance #setCodeStyleWash');
    return JSON.stringify({ inTheme, inEnhance });
  })()`, 10000);
  const h1o = JSON.parse(h1 || '{}');
  ok('H1 行内代码样式归在「主题外观」区(不再放阅读增强)', h1o.inTheme === true && h1o.inEnhance === false, h1o);

  const h2 = await val(`(() => {
    showPanel('settings');
    const inp = document.getElementById('setSearch');
    const rows = () => [...document.querySelectorAll('#settingsPanel .set-row')].filter((r) => r.offsetParent !== null);
    inp.value = '代码'; inp.dispatchEvent(new Event('input', { bubbles: true }));
    const hitZh = rows().some((r) => r.querySelector('#setCodeStyleWash'));
    inp.value = 'code style'; inp.dispatchEvent(new Event('input', { bubbles: true }));
    const hitEn = rows().some((r) => r.querySelector('#setCodeStyleWash'));
    inp.value = ''; inp.dispatchEvent(new Event('input', { bubbles: true }));
    showPanel(null);
    return JSON.stringify({ hitZh, hitEn });
  })()`, 10000);
  const h2o = JSON.parse(h2 || '{}');
  ok('H2 设置搜索"代码"/"code style"都能过滤到它', h2o.hitZh === true && h2o.hitEn === true, h2o);

  // 抽屉几何:面板占右侧,阅读区留在左边且**不被盖住**(面板左缘 ≥ 阅读区右缘);
  // 窄窗(≤1120)回落到全覆盖,那时这条按"回落也要成立"判:要么并列,要么明确藏起来
  const h3 = await val(`(() => {
    showPanel('settings');
    const l = document.getElementById('layout').getBoundingClientRect();
    const p = document.getElementById('settingsPanel').getBoundingClientRect();
    const rd = document.getElementById('reader').getBoundingClientRect();
    const vis = getComputedStyle(document.getElementById('layout')).visibility;
    const narrow = innerWidth <= 1120;
    showPanel(null);
    const aside = l.width > 200 && p.left >= l.right - 1 && rd.width > 100;
    const fallback = narrow && vis === 'hidden';
    return JSON.stringify({ ok: (aside || fallback), narrow, aside, vis, layoutW: Math.round(l.width), layoutRight: Math.round(l.right), panelLeft: Math.round(p.left), readerW: Math.round(rd.width), innerW: innerWidth });
  })()`, 10000);
  const h3o = JSON.parse(h3 || '{}');
  ok('H3 设置页是右侧抽屉:阅读区在左边且不被覆盖(窄窗回落为全遮)', h3o.ok === true, h3o);
}

/* ═══════════ I) 媒体上的文字加固:全站文字都有**可用**的阴影 ═══════════
 * 2026-10-25 用户实拍:玻璃模式下侧栏灰字对背景只有 1.31:1 / 1.34:1(米白也才 2.71),字等于没了。
 * 配方(skill over-media-text-readability):文字必须带 shadow 做局部对比;button/input 的 text-shadow
 * 会被 UA 样式表重置成 none,必须显式接回继承;placeholder 在 UA shadow tree 里,TreeWalker 扫不到。
 * 判据(2026-10-25 复核后加强):不是"非 none"就算过 —— 必须**可用**:≥2 层、至少一层 α≥0.5、带几何(blur/offset);
 * 控件与 placeholder 全量;深浅主题各验极性(深色不许出现白色晕、浅色必须全是亮晕)。 */
{
  console.log('-- I 文字阴影覆盖 --');
  // 先钉基线:默认强度 + 玻璃开(别吃前面组留下的状态)
  await val(`(() => { if (S.glass && typeof S.glass === 'object') { S.glass.on = true; S.glass.halo = 55; } if (typeof applyGlass === 'function') applyGlass(false); return 1; })()`, 8000);
  const AUDIT = `(() => {
    // v1.8.9:强度提成可调(--halo-k,默认 55),判据改成"有几何 + 默认档落在带内":
    // 下限 0.3 = 还能当局部对比用;上限 0.6 = 不许悄悄回到用户否掉的"重口"(全强度 0.9,滑块拉满才到)。
    const usable = (ts) => {
      if (!ts || ts === 'none') return false;
      const layers = ts.split(/,(?![^(]*\\))/).length;
      const alphas = [...ts.matchAll(/rgba?\\(([^)]+)\\)/g)].map((m) => { const p = m[1].split(',').map((s) => parseFloat(s)); return p.length === 4 ? p[3] : 1; });
      const k = alphas.length ? Math.max(...alphas) : 0;
      return layers >= 2 && k >= 0.3 && k <= 0.6 && /\\d+(\\.\\d+)?px/.test(ts);
    };
    const isWhite = (ts) => /255, 255, 255/.test(ts);
    // v1.8.13:浅色主题的晕由纯白改为**纸色**(#fbf1c7) —— 纯白晕压在暖纸上会把深字烘出灰边。
    // 判据因此从"必须 255,255,255"改成"这一层是亮色"(相对亮度 ≥0.7),语义仍是"反相亮晕"。
    const isBright = (ts) => {
      const rgb = [...ts.matchAll(/rgba?\\(([^)]+)\\)/g)].map((m) => m[1].split(',').slice(0, 3).map((x) => parseFloat(x)));
      if (!rgb.length) return false;
      const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
      return Math.max(...rgb.map(lum)) >= 0.7;
    };
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n = 0; const bad = []; let whiteNodes = 0; let brightNodes = 0; let okNodes = 0;
    while (w.nextNode()) {
      const t = w.currentNode;
      if (!t.textContent || !t.textContent.trim()) continue;
      const el = t.parentElement; if (!el) continue;
      n++;
      const ts = getComputedStyle(el).textShadow;
      if (!usable(ts)) { bad.push(el.tagName + '.' + String(el.className).slice(0, 18) + ' :: ' + t.textContent.trim().slice(0, 14)); continue; }
      okNodes++;
      if (isWhite(ts)) whiteNodes++;
      if (isBright(ts)) brightNodes++;
    }
    const ctlBad = [];
    const ctls = [...document.querySelectorAll('button,input,select,textarea')];
    for (const el of ctls) {
      const ts = getComputedStyle(el).textShadow;
      if (!usable(ts)) ctlBad.push((el.id || el.tagName) + ':' + String(ts).slice(0, 26));
    }
    const phs = [...document.querySelectorAll('input[placeholder],textarea[placeholder]')];
    const phBad = [];
    for (const el of phs) {
      const ts = getComputedStyle(el, '::placeholder').textShadow;
      if (!usable(ts)) phBad.push((el.id || el.tagName) + ':' + String(ts).slice(0, 26));
    }
    return JSON.stringify({ n, badCount: bad.length, bad: bad.slice(0, 6), okNodes, whiteNodes, brightNodes,
      ctls: ctls.length, ctlBad: ctlBad.slice(0, 5), phCount: phs.length, phBad: phBad.slice(0, 5),
      bodyTs: getComputedStyle(document.body).textShadow.slice(0, 60) });
  })()`;
  const audit = async (theme) => {
    await val(`(() => { S.theme = ${JSON.stringify(theme)}; applySettings(); showPanel('settings'); return 1; })()`, 12000);
    const r = JSON.parse((await val(AUDIT, 30000)) || '{}');
    await val('(() => { showPanel(null); return 1; })()', 12000);
    return r;
  };
  const dark = await audit('dark');
  ok('I1 深色:每个非空白文本节点都有**可用**的晕(≥2 层、α≥0.5、带几何)', dark && dark.n > 50 && dark.badCount === 0, dark);
  ok('I2 深色:全部控件 + placeholder 都有可用晕(不再只抽第一个)', dark && dark.ctls > 0 && dark.ctlBad.length === 0 && dark.phCount > 0 && dark.phBad.length === 0, dark);
  ok('I3 深色:没有节点误用白色晕(极性正确)', dark && dark.whiteNodes === 0, dark && { whiteNodes: dark.whiteNodes, okNodes: dark.okNodes });
  const light = await audit('light');
  ok('I4 浅色:全部文本 + 控件 + placeholder 都是反相亮晕(亮色,含纸色晕),坏数 0', light && light.badCount === 0 && light.ctlBad.length === 0 && light.phBad.length === 0 && light.okNodes > 0 && light.brightNodes === light.okNodes, light);
  await val(`(() => { S.theme = 'dark'; applySettings(); return 1; })()`, 12000);
  // I5–I8:拖动条(--halo-k 的驱动链)。用户 2026-10-25 要求"做成拖动条" → 断言要盯**真实链路**:
  // 直接给 input 派发 input 事件(和用户拖动同一条路径),而不是绕过监听器手改 S.glass。
  const HX = `(() => {
    const el = document.getElementById('setHalo');
    const root = document.documentElement;
    const peak = () => { const ts = getComputedStyle(document.body).textShadow;
      return [...ts.matchAll(/rgba?\\(([^)]+)\\)/g)].map((x) => x[1].split(',').map(Number)).map((p) => (p.length === 4 ? p[3] : 1)); };
    const mx = (v) => (v.length ? Math.max(...v) : 1);
    const drag = (v) => { el.value = String(v); el.dispatchEvent(new Event('input', { bubbles: true })); return mx(peak()); };
    const inPanel = !!el && !!el.closest('#glassPanel');
    const value0 = el ? el.value : null;
    const z = drag(0); const kz = root.style.getPropertyValue('--halo-k');
    const saved0 = (JSON.parse(localStorage.getItem('sr_glass') || '{}') || {}).halo;
    const f = drag(100);
    const b = drag(55);
    const saved55 = (JSON.parse(localStorage.getItem('sr_glass') || '{}') || {}).halo;
    S.glass.on = false; applyGlass(false);
    const off = mx(peak()); const kOff = root.style.getPropertyValue('--halo-k');
    S.glass.on = true; applyGlass(false); drag(55);
    const valText = (document.getElementById('valHalo') || {}).textContent;
    return JSON.stringify({ inPanel, value0, z, f, b, off, kz, kOff, saved0, saved55, valText });
  })()`
  const hx = JSON.parse((await val(HX, 20000)) || '{}');
  ok('I5 玻璃面板里有「文字阴影」拖动条,默认落在 55%', hx.inPanel === true && hx.value0 === '55', hx);
  ok('I6 拖动条真的驱动晕:0% 无晕(α≤0.05)、100% 明显更强(α≥0.8)、回 55% 落在默认带 0.3–0.6',
    hx.z <= 0.05 && hx.f >= 0.8 && hx.b >= 0.3 && hx.b <= 0.6, hx);
  ok('I7 拖动条落盘:拖到 0 时存档读 0、回 55 时读 55(走 input 事件=用户同一条路径)',
    hx.saved0 === 0 && hx.saved55 === 55, hx && { saved0: hx.saved0, saved55: hx.saved55 });
  ok('I7b 面板读数回显跟着走(valHalo = 55%)', hx.valText === '55%', hx && { valText: hx.valText });
  ok('I8 玻璃关掉(实色)不画晕:--halo-k=0 且 α≤0.05(实色底上不该留灰边)', hx.kOff === '0' && hx.off <= 0.05, hx && { kOff: hx.kOff, off: hx.off });
}

// 收尾:退出编辑 + **关掉本套件开过的沙箱标签**。
// 为什么必须:r12d 的 A16/A17 验的是"空态(没有任何文档)里那两个按钮",而 G 段开的 5000 行文档
// 会一直挂在标签栏上 → 空态不渲染 → 后面那条跑道假失败(2026-10-25 实测踩到)。
/* ═══════════ J) 正文内容板:中性玻璃(不许再是实心灰块,也不许是掺了强调色的脏棕)═══════════
 * 用户实拍 2026-10-25:表头带 / 行内码芯片 / 代码块都是"中性灰块"→ v1.8.8 改成"暖板"(强调色掺底色);
 * 用户实拍 2026-10-26:「还行,但这橙色代码块和玻璃质感完全不配」→ v1.8.11 改成**中性玻璃**。
 * 口径换了三次,判据一直是**像素**,不是形容词:灰/棕/蓝都靠**合成之后的彩度 C** 拦下来。
 * 新契约:1 表格去板:表头无填充、单元格只留上发丝线(左/右/下 = 0px);
 *        2 代码块底 = 玻璃凹槽:0<α≤0.5、合成到中性灰(40,40,40)后 C≤6、发丝边 α≥0.12、
 *          合成到用户壁纸底(34,38,43)后字对板 ≥4.5:1;
 *        3 行内码板 = 玻璃薄片:0<α≤0.35、合成中性灰后 C≤8(ink 抬升自带一点暖,放宽到 8)、
 *          合成壁纸底后字对板 ≥4.5:1。
 * 已知边界(别当成漏判):浅色主题的**浅**板压在**暗**壁纸上时,板本身对深字不足 4.5:1 ——
 *   那里靠 I 组的反相亮晕兜底(与正文同口径),所以 J4 只查"中性 + 半透明 + 去板",不查合成对比度。 */
{
  console.log('-- J 内容板(灰块 → 暖板 → 中性玻璃)--');
  const mdJ = join(ROOT, 'j-content.md');
  writeFileSync(mdJ, ['# J 内容板', '',
    '行内码 `socks5://100.113.241.22:41005` 与 `161.153.47.182` 各一枚。', '',
    '```yaml', '8-原生-美国rNN:', '  type: socks5', '  server: 100.113.241.22', '```', '',
    '| # | 代号 | 当前出口 IP | 直连写法 |', '|---|---|---|---|',
    '| 1 | us-r00 | `161.153.47.182` | `socks5://100.113.241.22:41005` |',
    '| 2 | us-r01 | `161.153.80.31` | `socks5://100.113.241.22:41006` |', ''].join('\n'), 'utf8');
  await val(`(async () => { try { leaveEdit(); } catch (e) {}
    await openTab({ abs: ${JSON.stringify(winPath(mdJ))}, kind: 'ext' });
    await new Promise((r) => setTimeout(r, 800)); return 1; })()`, 25000);
  const AUDIT_J = `(() => {
    // 直接**解析 computed 字符串**,不要过 canvas:canvas 的 alpha 读回实测偏大(0.36 读成 0.60),
    // 而且 fillStyle 赋值失败时会静默保留上一次的值 → 结论全是错的(2026-10-25 踩过)。
    // 这段住在模板串里:带反斜杠的正则(\s / \d)会被 JS 先吃掉一层转义,所以**一律不用带反斜杠的正则**。
    const toSrgb = (s) => {
      if (s.indexOf('color(srgb') === 0) {
        const inner = s.slice(11, s.indexOf(')')).split('/');
        const rgb = inner[0].trim().split(' ').filter(Boolean).map(Number).map((v) => Math.round(v * 255));
        return { rgb, a: inner[1] ? Number(inner[1].trim()) : 1 };
      }
      if (s.indexOf('rgb') === 0) {
        const q = s.slice(s.indexOf('(') + 1, s.indexOf(')')).split(',').map((v) => Number(v.trim()));
        return { rgb: [q[0], q[1], q[2]], a: q.length > 3 ? q[3] : 1 };
      }
      return { rgb: [0, 0, 0], a: 0 };
    };
    const C = (p) => Math.max(p[0], p[1], p[2]) - Math.min(p[0], p[1], p[2]);
    const lum = (p) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(p[0]) + 0.7152 * f(p[1]) + 0.0722 * f(p[2]); };
    const cr = (a, b) => Math.round(((Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05)) * 100) / 100;
    const comp = (c, a, bd) => c.map((v, i) => Math.round(a * v + (1 - a) * bd[i]));
    const prev = S.codeStyle; S.codeStyle = 'plate'; applyEnhance();
    const th = document.querySelector('.markdown-body th'), td = document.querySelector('.markdown-body td');
    const rows = document.querySelectorAll('.markdown-body tbody tr');
    const td2 = rows[1] ? rows[1].cells[0] : td;   // 第二条数据行:行间发丝线长在这里
    const pre = document.querySelector('.markdown-body pre');
    const inline = [...document.querySelectorAll('.markdown-body code')].find((e) => !e.closest('pre'));
    const bw = (el, side) => parseFloat(getComputedStyle(el)['border' + side + 'Width']);
    const fg = toSrgb(getComputedStyle(document.body).color).rgb;
    const plate = toSrgb(getComputedStyle(inline).backgroundColor), well = toSrgb(getComputedStyle(pre).backgroundColor);
    const out = {
      glass: getComputedStyle(document.documentElement).getPropertyValue('--glass').trim(),
      found: { th: !!th, td: !!td, pre: !!pre, inline: !!inline },
      table: { thBg: getComputedStyle(th).backgroundColor, thBottom: bw(th, 'Bottom'), tdTop: bw(td, 'Top'),
        td2Top: bw(td2, 'Top'), tdLeft: bw(td, 'Left'), tdRight: bw(td, 'Right'), tdBottom: bw(td, 'Bottom') },
      plate: { rgb: plate.rgb, a: plate.a, C: C(plate.rgb), warm: plate.rgb[0] > plate.rgb[2],
        vsWall: cr(fg, comp(plate.rgb, plate.a, [34, 38, 43])),
        Cn: C(comp(plate.rgb, plate.a, [40, 40, 40])) },
      well: { rgb: well.rgb, a: well.a, C: C(well.rgb), warm: well.rgb[0] > well.rgb[2],
        line: toSrgb(getComputedStyle(pre).borderTopColor).a,
        vsWall: cr(fg, comp(well.rgb, well.a, [34, 38, 43])),
        Cn: C(comp(well.rgb, well.a, [40, 40, 40])) },
    };
    S.codeStyle = prev; applyEnhance();
    return JSON.stringify(out);
  })()`;
  const auditJ = async (theme) => {
    await val(`(() => { S.theme = ${JSON.stringify(theme)}; if (S.glass && typeof S.glass === 'object') S.glass.conc = 40;
      applySettings(); S.codeStyle = 'plate'; applyEnhance(); return 1; })()`, 12000);
    return JSON.parse((await val(AUDIT_J, 20000)) || '{}');
  };
  const dJ = await auditJ('dark');
  ok('J1 深色:表格去板(表头无填充、首行无上框、第二行有上发丝线、四边竖线/下线为 0)',
    dJ && dJ.table && dJ.table.thBg === 'rgba(0, 0, 0, 0)' && dJ.table.thBottom > 0 && dJ.table.tdTop === 0 &&
    dJ.table.td2Top > 0 && dJ.table.tdLeft === 0 && dJ.table.tdRight === 0 && dJ.table.tdBottom === 0, dJ && dJ.table);
  ok('J2 深色:代码块底 = 玻璃凹槽(0<α≤0.5、合成中性灰后 C≤6、发丝边 α≥0.12、字对板 ≥4.5:1)',
    dJ && dJ.well && dJ.well.a > 0 && dJ.well.a <= 0.5 && dJ.well.Cn <= 6 && dJ.well.line >= 0.12 && dJ.well.vsWall >= 4.5,
    dJ && dJ.well);
  ok('J3 深色:行内码板 = 玻璃薄片(0<α≤0.35、合成中性灰后 C≤8、合成壁纸底后字对板 ≥4.5:1)',
    dJ && dJ.plate && dJ.plate.a > 0 && dJ.plate.a <= 0.35 && dJ.plate.Cn <= 8 && dJ.plate.vsWall >= 4.5, dJ && dJ.plate);
  const lJ = await auditJ('light');
  ok('J4 浅色:同一套 token 也过(表去板 + 凹槽/薄片都中性半透明;合成对比度由反相亮晕兜,见段首已知边界)',
    lJ && lJ.table && lJ.table.thBg === 'rgba(0, 0, 0, 0)' && lJ.table.thBottom > 0 && lJ.table.td2Top > 0 &&
    lJ.table.tdLeft === 0 && lJ.well && lJ.well.a <= 0.5 && lJ.well.Cn <= 6 && lJ.well.line >= 0.12 &&
    lJ.plate && lJ.plate.a <= 0.35 && lJ.plate.Cn <= 8, lJ);
  await val(`(() => { S.theme = 'dark'; applySettings(); return 1; })()`, 12000);
}

await val(`(async () => {
  try { leaveEdit(); } catch (e) {}
  const root = ${JSON.stringify(winPath(ROOT))}.toLowerCase();
  S.tabs = S.tabs.filter((t) => !String(t.abs).toLowerCase().startsWith(root));
  if (!S.tabs.length) { S.activeKey = null; S.cur = null; renderEmpty(); }
  else if (!S.tabs.some((t) => t.abs === S.activeKey)) { S.activeKey = S.tabs[0].abs; S.cur = { abs: S.tabs[0].abs, raw: S.tabs[0].raw }; }
  persistTabs(); renderTabs();
  return 1;
})()`, 10000);
console.log(`\n== r12f: pass=${results.pass} fail=${results.fail} ==`);
if (results.fail) { console.log('failures:'); results.fails.forEach((f) => console.log('  - ' + f)); }
console.log(`sandbox kept for inspection: ${ROOT}`);
ws.close();
process.exit(results.fail ? 1 : 0);
