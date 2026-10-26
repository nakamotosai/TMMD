// r12h-i18n.mjs — 三语 DOM 残留闸:切到 en/ja 之后,UI 外壳里不该再出现「中文原文」。
//
// 为什么不用「含汉字就报」:日语本身就用汉字(弱/中/強、保存、表示言語…),日语字典值里也带汉字。
// 所以判据改成**字典值比对**(在页面里现算,不手抄):
//   R1 接线检查:HTML 上挂了 i18n 钩子的元素(与 app.js 的 applyI18n() 一一对应)——
//      data-i18n 文本 | data-i18n-html 富文本 | data-i18n-title | data-i18n-aria | data-i18n-ph
//      DOM 值必须 **===** 该键在当前语言下的字典值。不等分两类:
//        · 接线错(硬失败):DOM 值既不是该键的值、也不是任何别的键的值(典型:漏贴钩子 → en 下留着 zh 硬编码;
//          或钩子贴了但键不在字典里 → 页面上直接显示 "settings.title" 这种键名)。
//        · 钩子被 JS 覆盖(只警告):DOM 值是**当前语言的另一条字典值** —— 说明 JS 现算文案盖住了钩子,
//          不是中文残留,但切语言时 applyI18n 会把它改回钩子的键(值得看一眼,不该让闸永远红)。
//      旧版按选择器贴的 I18N_TARGETS 若还在也会一并查(声明式上线后已被删除,删了就不查、不当失败)。
//   R2 残留检查:遍历 UI 外壳,凡「含汉字的可见值」且 **在当前语言字典值集合里找不到同值**(含 {var} 模板与
//      html 模式的 | 变体)才报 —— 这样 ja 的 弱/中/強 不会误报,而 en 下的纯中文必然被抓。
//   R3 zh 一档只作自检:外壳里**确实存在汉字**(raw > 0),证明扫描面没扫空。
//
// 扫描面(UI 外壳,逐个浮层开出来扫,扫完立刻关回去):
//   shell(顶栏/侧栏/标签栏/toast/沉浸提示) · settings 设置页 · glass 玻璃面板 · 5 个抽屉 · 文内查找栏 · 右键菜单
// 排除(正文 = 用户内容,不是 UI 文案):
//   `.markdown-body`(渲染后的 Markdown 正文)、`#editor`(编辑态 textarea 里的 Markdown 源码)。
//   注意:#readerEmpty(空态)属于外壳,照扫 —— 空态模板只在「没打开文档」的实例里存在;在开着文档的实例上
//   跑本闸覆盖不到它(本闸不关用户的文档)。要在空态实例上复跑同一脚本即可自动覆盖。
// 可见性:沿祖先链逐级判 `hidden` / `aria-hidden=true` / `display:none` / `visibility:hidden|collapse` / `opacity<=0.01`,
//   任一级不可见即整棵子树不算 —— 所以「没开出来的浮层」不会污染结果,必须显式开出来扫。
// 白名单(故意保留,不是漏翻):
//   W1 语言名 endonym:精确等于 `中文` / `日本語` / `English`(语言名按钮按惯例不翻译)
//   W2 路径串:按空白切 token 判 —— 含 `docs/`、盘符 `C:\`、任意反斜杠、有扩展名的文件名、`目录/文件.ext` 形态。
//      单独成 token 的 `.md`(「系统当前 .md 默认程序」)不放过 —— 那是 UI 文案里的举例,不是路径。
//   W3 文件/目录名标签:`.name` / `.meta` 且位于 `[data-abs]|[data-rel]|[data-path]` 行内(库列表/文件树里是用户自己的文件名)
//   —— 但同一行里的按钮文案(如 `title="移除"`)或与文件名拼在一起的 UI 词(「关闭README.md」)**不**白名单。
//
// 其它两条护栏:
//   实例新鲜度:比 `performance.timeOrigin` 与 ui-reader/*.{html,js,css} 的 mtime —— 前端改了不重载 = 验的是旧包,会大声警告。
//   target 选取:优先 `tauri.localhost` 页面(Tauri 重载瞬间会冒出一个 about:blank 的 page target,挑错就连到空页);
//      连上后还要等 currentLang/I18N/LANGS 就绪,整体重试到 30s;扫描途中断开则判定本次结果不可信并报出来。
//
// 用法:先起隔离调试实例(CDP 9223),再
//   cd /f/projects/tmmd && node e2e/r12h-i18n.mjs --port=9223 [--detail=30]
// 收尾:恢复进闸前的语言、关掉本闸开过的所有浮层。
// 说明:本闸只读 + 只切语言/开关浮层,不碰文件、不写配置、不弹窗。
import { existsSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

const args = process.argv.slice(2);
const port = (args.find((a) => a.startsWith('--port=')) || '--port=9223').split('=')[1];
const timeout = Number((args.find((a) => a.startsWith('--timeout=')) || '--timeout=15000').split('=')[1]) || 15000;
const DETAIL = Number((args.find((a) => a.startsWith('--detail=')) || '--detail=30').split('=')[1]) || 30;
const REPO = process.cwd();

// ---------- 1) CDP 连通性 + 挑对 target ----------
// 注意:Tauri 重载的一瞬间会短暂出现 about:blank 的 page target;挑错了就连到空页(全局全 undefined)。
// 所以策略是「优先 tauri.localhost 的页面 + 连上后再等应用上下文就绪」,整体重试到 30s。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DEADLINE = Date.now() + 30000;
const pickAppPage = (targets) => {
  const pages = (targets || []).filter((t) => t.type === 'page');
  return pages.find((t) => /tauri\.localhost/.test(t.url || ''))
    || pages.find((t) => t.url && t.url !== 'about:blank')
    || null;
};

let ws = null, page = null, seq = 0;
const pending = new Map();
function ev(expr, ms) {
  const id = ++seq;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pending.delete(id); resolve({ timeout: true }); }, ms || timeout);
    pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
    if (!ws || ws.readyState !== 1) { clearTimeout(timer); pending.delete(id); resolve({ timeout: true }); return; }
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
  });
}
async function val(expr, ms) {
  const r = await ev(expr, ms);
  if (r.timeout) throw new Error(`evaluate timeout: ${expr.slice(0, 120)}`);
  if (r.result?.exceptionDetails) throw new Error(`JS EXCEPTION: ${JSON.stringify(r.result.exceptionDetails).slice(0, 300)}`);
  return r.result?.result?.value;
}

let lastErr = 'no attempt';
for (;;) {
  try {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    const cand = pickAppPage(targets);
    if (!cand) {
      lastErr = 'no app page target (saw: ' + (targets || []).map((t) => t.type + ':' + t.url).join(', ') + ')';
    } else {
      if (!ws || ws.readyState !== 1 || page?.id !== cand.id) {
        if (ws) { try { ws.close(); } catch (e) {} }
        pending.clear();
        ws = new WebSocket(cand.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws connect failed')); });
        ws.onmessage = (e) => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
        page = cand;
      }
      const probe = await ev(`(function(){ return (typeof currentLang === 'function') && (typeof I18N === 'object') && (typeof LANGS === 'object'); })()`, 5000);
      if (probe && !probe.timeout && probe.result?.result?.value === true) break;
      lastErr = `页面 ${cand.url} 里还没有应用上下文(currentLang/I18N/LANGS)—— 可能正在重载`;
    }
  } catch (e) { lastErr = e.message; }
  if (Date.now() > DEADLINE) {
    console.error(`实例未就绪 :${port} 重试 30s 无效 — ${lastErr}`);
    process.exit(2);
  }
  await sleep(1500);
}
console.log(`CDP ok :${port} — ${page.url} (重试 ${Math.round((Date.now() - (DEADLINE - 30000)) / 1000)}s 内连上)`);
const results = { pass: 0, fail: 0, fails: [] };
function ok(name, cond, extra) {
  if (cond) { results.pass++; console.log(`  ok   ${name}`); }
  else { results.fail++; results.fails.push(name); console.log(`  FAIL ${name}${extra !== undefined ? ' :: ' + JSON.stringify(extra).slice(0, 300) : ''}`); }
}

// ---------- 2) 页面内扫描器(源串用 String.raw,避免反斜杠二次转义) ----------
const HAN_SRC = String.raw`/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3005\u3007]/`;
const SCAN_SRC = String.raw`(function () {
  const HAN = HAN_SRC_PLACEHOLDER;
  const EXCL = '#editor, .markdown-body, [data-user-content]';
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

  if (typeof I18N === 'undefined' || typeof LANGS === 'undefined' || typeof currentLang !== 'function') {
    return { fatal: 'globals unreachable: I18N=' + (typeof I18N) + ' LANGS=' + (typeof LANGS) + ' currentLang=' + (typeof currentLang) };
  }
  const lang = currentLang();
  const li = LANGS.indexOf(lang);

  // --- 期望值集合:当前语言下所有字典值(含 html 模式的 | 变体 + {var} 模板) ---
  const EXPECT = new Set();
  const TEMPLATES = [];
  const ESCCH = { '.': 1, '*': 1, '+': 1, '?': 1, '^': 1, '$': 1, '{': 1, '}': 1, '(': 1, ')': 1, '|': 1, '[': 1, ']': 1 };
  const esc = (s) => String(s).split('').map((c) => (ESCCH[c] || c === String.fromCharCode(92)) ? String.fromCharCode(92) + c : c).join('');
  Object.keys(I18N).forEach((k) => {
    const row = I18N[k];
    if (!Array.isArray(row)) return;
    const v = row[li];
    if (typeof v !== 'string') return;
    [v, v.split('|').join(''), v.split('|').join('\n'), v.split('|').join(' ')].forEach((x) => EXPECT.add(norm(x)));
    v.split('|').forEach((x) => EXPECT.add(norm(x)));
    if (v.indexOf('{') >= 0) {
      v.split('|').forEach((part) => {
        TEMPLATES.push(new RegExp('^' + part.split(/\{[^}]*\}/).map(esc).join('[\\s\\S]*') + '$'));
      });
    }
  });
  const dictMatch = (s) => {
    const v = norm(s);
    if (!v) return true;
    if (EXPECT.has(v)) return true;
    for (let i = 0; i < TEMPLATES.length; i++) if (TEMPLATES[i].test(v)) return true;
    return false;
  };

  // --- 可见性:沿祖先链 ---
  const styleCache = new WeakMap();
  const st = (el) => { let s = styleCache.get(el); if (!s) { s = getComputedStyle(el); styleCache.set(el, s); } return s; };
  function visible(el) {
    let n = el;
    while (n && n.nodeType === 1) {
      if (n.hidden) return false;
      if (n.getAttribute && n.getAttribute('aria-hidden') === 'true') return false;
      const s = st(n);
      if (s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse') return false;
      if (s.opacity !== '' && parseFloat(s.opacity) <= 0.01) return false;
      n = n.parentElement;
    }
    return true;
  }
  function selOf(el) {
    const parts = [];
    let n = el;
    while (n && n.nodeType === 1 && n !== document.body && parts.length < 6) {
      if (n.id) { parts.unshift('#' + n.id); break; }
      let p = n.tagName.toLowerCase();
      const cls = (typeof n.className === 'string' && n.className.trim()) ? n.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : [];
      if (cls.length) p += '.' + cls.join('.');
      const par = n.parentElement;
      if (par && par.children) {
        const sibs = Array.prototype.filter.call(par.children, (c) => c.tagName === n.tagName);
        if (sibs.length > 1) p += ':nth-of-type(' + (sibs.indexOf(n) + 1) + ')';
      }
      parts.unshift(p);
      n = n.parentElement;
    }
    return parts.join(' > ') || el.tagName.toLowerCase();
  }

  // --- 白名单 ---
  const BS = String.fromCharCode(92);
  const EXTS = /^(md|markdown|txt|json|ya?ml|pdf|html?|png|jpe?g|svg|gif|log|exe|zip)$/i;
  function isPathToken(tok) {
    if (/docs[\\/]/.test(tok)) return true;             // 文档目录
    if (/[A-Za-z]:[\\/]/.test(tok)) return true;        // 盘符路径
    if (tok.indexOf(BS) >= 0) return true;              // 任意反斜杠
    const m = /^(.*)\.([A-Za-z0-9]{1,6})$/.exec(tok);
    if (m && EXTS.test(m[2])) {
      if (m[1].indexOf('/') >= 0) return true;          // 目录/文件.ext
      if (/^[\w\-. ]+$/.test(m[1])) return true;        // 纯 ASCII 文件名(README.md / 2026-10-24.md)
    }
    return false;
  }
  // 按空白切 token 判:任一个 token 是路径/文件名 → 整串放行(覆盖「关闭 README.md」这类拼接 aria-label)。
  // 反例:.md 单独成 token(「系统当前 .md 默认程序」)不放过 —— 那是 UI 文案里的举例,不是路径。
  const isPathish = (t) => t.split(/\s+/).some(isPathToken);
  function whitelisted(el, t) {
    const s = norm(t);
    if (!s) return true;
    if (s === '中文' || s === '日本語' || s === 'English') return true;          // W1 endonym
    if (isPathish(s)) return true;                                              // W2 路径串
    const cls = el && el.classList;
    if (cls && (cls.contains('name') || cls.contains('meta')) && el.closest && el.closest('[data-abs],[data-rel],[data-path]')) return true; // W3 文件/目录名标签
    return false;
  }

  // --- 归属:残留挂在哪块 UI 上(按祖先容器判,不用选择器串反推 —— 路径会在最近的 id 处截断) ---
  const OVERLAYS = [
    ['settingsPanel', 'settings 设置页'], ['glassPanel', 'glass 玻璃面板'],
    ['menuFile', 'drawer 文件'], ['menuEdit', 'drawer 编辑'], ['menuView', 'drawer 视图'],
    ['menuDoc', 'drawer 文档'], ['menuMore', 'drawer 更多'], ['ctxMenu', 'ctxmenu 右键菜单']
  ];
  function ownerOf(el) {
    let n = el;
    while (n && n.nodeType === 1) {
      for (let i = 0; i < OVERLAYS.length; i++) if (n.id === OVERLAYS[i][0]) return OVERLAYS[i][1];
      n = n.parentElement;
    }
    return 'shell 外壳(顶栏/侧栏/标签栏/查找栏/toast)';
  }

  // --- 收集 ---
  const out = { lang: lang, raw: 0, hits: [], wl: [], wiring: [], fatal: null, cover: { targets: 0, matched: 0, els: 0, hooks: 0 } };
  const seen = new Set();
  const rawSeen = new Set();
  function collect(where, el, text) {
    const s = norm(text);
    if (!s || !HAN.test(s)) return;
    const rec = { where: where, sel: selOf(el), text: s.slice(0, 200), owner: ownerOf(el) };
    const key = where + '|' + rec.sel + '|' + rec.text;
    if (!rawSeen.has(key)) { rawSeen.add(key); out.raw++; }
    if (dictMatch(s)) return;                        // 命中字典 = 已本地化,放行(ja 的汉字走这条)
    if (seen.has(key)) return;
    seen.add(key);
    if (whitelisted(el, s)) out.wl.push(rec); else out.hits.push(rec);
  }

  // 文本节点
  const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: function (n) {
      const p = n.parentElement;
      if (!p) return NodeFilter.FILTER_REJECT;
      const tg = p.tagName;
      if (tg === 'SCRIPT' || tg === 'STYLE' || tg === 'NOSCRIPT' || tg === 'TEMPLATE') return NodeFilter.FILTER_REJECT;
      if (p.closest(EXCL)) return NodeFilter.FILTER_REJECT;
      if (!HAN.test(n.nodeValue || '')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  let tn;
  while ((tn = tw.nextNode())) { if (visible(tn.parentElement)) collect('text', tn.parentElement, tn.nodeValue); }

  // 属性:title / aria-label / placeholder / alt
  ['title', 'aria-label', 'placeholder', 'alt'].forEach(function (a) {
    Array.prototype.forEach.call(document.querySelectorAll('[' + a + ']'), function (el) {
      if (el.closest(EXCL)) return;
      const v = el.getAttribute(a);
      if (!v || !HAN.test(v)) return;
      if (!visible(el)) return;
      collect(a, el, v);
    });
  });

  // 输入类元素的 value
  Array.prototype.forEach.call(document.querySelectorAll('input, textarea, select'), function (el) {
    if (el.closest(EXCL)) return;
    const ty = String(el.type || '').toLowerCase();
    if (ty === 'checkbox' || ty === 'radio' || ty === 'range' || ty === 'color' || ty === 'file') return;
    const v = el.value;
    if (!v || !HAN.test(v)) return;
    if (!visible(el)) return;
    collect('value', el, v);
  });

  // 文档级
  collect('document.title', document.documentElement, document.title);
  const md = document.querySelector('meta[name="description"]');
  if (md) collect('meta.description', md, md.getAttribute('content') || '');

  // --- R1 接线检查:v1.8.17 起是**声明式钩子**(HTML 上写 data-i18n*),旧的 I18N_TARGETS 若还在也一并查 ---
  // 钩子语义与 app.js 的 applyI18n() 一一对应:
  //   data-i18n 文本(svg 保留,文本接在后面)| data-i18n-html 富文本('|' 换行)| data-i18n-title|aria|ph 属性
  const HOOKS = [['data-i18n', 'text'], ['data-i18n-html', 'html'], ['data-i18n-title', 'title'], ['data-i18n-aria', 'aria-label'], ['data-i18n-ph', 'placeholder']];
  const attrVal = (el, mode) => (mode === 'text' || mode === 'html') ? (el.textContent || '') : (el.getAttribute(mode) || '');
  function checkHook(el, key, mode, chan) {
    if (!key) return;
    const dict = I18N[key];
    const gotN = norm(attrVal(el, mode));
    if (!dict) { out.wiring.push({ src: chan, sel: selOf(el), key: key, mode: mode, want: '<key missing in I18N>', got: gotN.slice(0, 80), altDict: false }); return; }
    const raw = String(dict[li] == null ? '' : dict[li]);
    const want = mode === 'html' ? raw.split('|').join('') : raw;
    if (gotN === norm(want)) return;
    // altDict=DOM 值本身就是当前语言的另一条字典值 → 是 JS 现算文案盖住了钩子(不是中文残留),
    // 与「没贴/贴错键/键缺失」要分开看:后者是接线错(硬失败),前者只警告。
    out.wiring.push({ src: chan, sel: selOf(el), key: key, mode: mode, want: norm(want).slice(0, 80), got: gotN.slice(0, 80), altDict: EXPECT.has(gotN) });
  }
  HOOKS.forEach(function (pair) {
    const attr = pair[0], mode = pair[1];
    const list = document.querySelectorAll('[' + attr + ']');
    out.cover[attr] = list.length;
    Array.prototype.forEach.call(list, function (el) { checkHook(el, el.getAttribute(attr), mode, attr); });
  });
  // 兼容:旧版按选择器贴的 I18N_TARGETS(声明式上线后可能已删;删了就不查,不当失败)
  if (typeof I18N_TARGETS !== 'undefined' && I18N_TARGETS) {
    I18N_TARGETS.forEach(function (row) {
      const sel = row[0], key = row[1], mode = row[2];
      let list;
      try { list = document.querySelectorAll(sel); } catch (e) { return; }
      out.cover.legacyTargets = (out.cover.legacyTargets || 0) + 1;
      out.cover.legacyEls = (out.cover.legacyEls || 0) + list.length;
      Array.prototype.forEach.call(list, function (el, i) {
        checkHook(el, Array.isArray(key) ? key[i] : key, mode === 'html' ? 'html' : (mode || 'text'), 'legacy:I18N_TARGETS');
      });
    });
  }
  // 自检:一个钩子都没有 = 接线机制变了,本闸的 R1 空转,必须报出来(别让闸悄悄变空)
  out.hookTotal = HOOKS.reduce((a, p) => a + (out.cover[p[0]] || 0), 0) + (out.cover.legacyEls || 0);

  return out;
})()`.replace('HAN_SRC_PLACEHOLDER', HAN_SRC);

// ---------- 3) 浮层清单(逐个开出来扫,扫完立刻关回去) ----------
const CTX_OPEN = `(function () {
  var sels = ['#recentList .side-recent', '#sideBottom .side-recent', '#sideBody .tree-item.file', '#docRecent .drawer-item'];
  for (var i = 0; i < sels.length; i++) {
    var el = document.querySelector(sels[i]);
    if (el) {
      var r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: Math.round(r.left + 8), clientY: Math.round(r.top + 8) }));
    }
  }
  return !!(document.getElementById('ctxMenu') && !document.getElementById('ctxMenu').hidden);
})()`;
const SURFACES = [
  { n: 'shell', o: '1', c: '1' },
  { n: 'settings', o: `showPanel('settings')`, c: `showPanel(null)` },
  { n: 'glass', o: `showPanel('glass')`, c: `showPanel(null)` },
  { n: 'drawer.file', o: `openDrawer('menuFile', $id('tbFile'))`, c: `closeDrawers()` },
  { n: 'drawer.edit', o: `openDrawer('menuEdit', $id('tbEdit'))`, c: `closeDrawers()` },
  { n: 'drawer.view', o: `openDrawer('menuView', $id('tbView'))`, c: `closeDrawers()` },
  { n: 'drawer.doc', o: `openDrawer('menuDoc', $id('tbDoc'))`, c: `closeDrawers()` },
  { n: 'drawer.more', o: `openDrawer('menuMore', $id('tbMore'))`, c: `closeDrawers()` },
  { n: 'findbar', o: `openFind()`, c: `closeFind()` },
  { n: 'ctxmenu', o: CTX_OPEN, c: `closeCtxMenu()` },
];

const CLOSE_ALL = `(function () {
  try { closeDrawers(); } catch (e) {}
  try { closeCtxMenu(); } catch (e) {}
  try { showPanel(null); } catch (e) {}
  try { closeFind(); } catch (e) {}
  try { closeEditFind(); } catch (e) {}
  try { $id('toast').hidden = true; } catch (e) {}
  return 1;
})()`;

const switchSrc = (L) => `(function () {
  var l = ${JSON.stringify(L)};
  try { if (typeof setLang === 'function') { setLang(l); return 'setLang'; } } catch (e) {}
  var B = { zh: 'langZh', en: 'langEn', ja: 'langJa' };
  try { if (typeof showPanel === 'function') showPanel('settings'); } catch (e) {}
  var b = document.getElementById(B[l]);
  if (b) b.click();
  try { if (typeof showPanel === 'function') showPanel(null); } catch (e) {}
  return 'click:' + (b ? 'ok' : 'noBtn');
})()`;

// ---------- 4) 主流程 ----------
console.log('== r12h 三语 DOM 残留闸 ==');
const BEFORE = await val(`(function(){ return {
  lang: currentLang(), ls: localStorage.getItem('sr_lang'),
  t: typeof I18N, keys: (typeof I18N !== 'undefined') ? Object.keys(I18N).length : -1,
  langs: (typeof LANGS !== 'undefined') ? LANGS.join('/') : '',
  hooks: document.querySelectorAll('[data-i18n],[data-i18n-html],[data-i18n-title],[data-i18n-aria],[data-i18n-ph]').length,
  legacy: (typeof I18N_TARGETS !== 'undefined') ? I18N_TARGETS.length : -1,
  setLang: typeof setLang, applyI18n: typeof applyI18n
}; })()`);
console.log(`  实例状态: lang=${BEFORE.lang} sr_lang=${BEFORE.ls} I18N=${BEFORE.t}(${BEFORE.keys} 键) LANGS=${BEFORE.langs}`);
console.log(`  接线机制: 声明式钩子元素 ${BEFORE.hooks} 个;I18N_TARGETS ${BEFORE.legacy < 0 ? '(已删除)' : BEFORE.legacy + ' 条'};setLang=${BEFORE.setLang} applyI18n=${BEFORE.applyI18n}`);
ok('I18N / LANGS / t() 在页面里可直接取到(判据现算,不手抄)', BEFORE.t === 'object' && BEFORE.keys > 0 && !!BEFORE.langs, BEFORE);
ok('接线机制存在(声明式钩子或 I18N_TARGETS,至少一种;否则 R1 空转)', BEFORE.hooks > 0 || BEFORE.legacy > 0, { hooks: BEFORE.hooks, legacy: BEFORE.legacy });
ok('切语言入口可用(setLang 或语言按钮)', BEFORE.setLang === 'function' || BEFORE.applyI18n === 'function', { setLang: BEFORE.setLang, applyI18n: BEFORE.applyI18n });

// ---------- 4) 实例新鲜度:闸扫的是**已加载的页面**,前端改了却不重载 = 验的是旧包 ----------
// 判据:页面导航时刻(performance.timeOrigin) vs UI 文件的磁盘 mtime。只警告、不计入 pass/fail。
let staleList = [];
try {
  const timeOrigin = await val(`performance.timeOrigin`);
  const watch = ['index.html', 'app.js', 'styles.css', 'style.css'].map((f) => join(REPO, 'ui-reader', f));
  staleList = watch.filter((p) => existsSync(p) && statSync(p).mtimeMs > timeOrigin)
    .map((p) => `${basename(p)}+${Math.round((statSync(p).mtimeMs - timeOrigin) / 1000)}s`);
  if (!staleList.length) console.log(`  实例新鲜度: ok(页面加载于 ${new Date(timeOrigin).toLocaleString()},之后 ui-reader 无改动)`);
  else {
    console.log(`\n!! 实例不新鲜:页面加载于 ${new Date(timeOrigin).toLocaleString()},之后被改过 → ${staleList.join(', ')}`);
    console.log('!! 本闸验的是已加载页面,上面这些改动不在本次结果里。复跑前请重载窗口/重启实例,否则看到的是旧前端。\n');
  }
} catch (e) { console.log(`  实例新鲜度: 无法判定(${e.message})`); }

/* ═══════════ S) 自检:种一条假残留,扫描器必须咬住 ═══════════
 * 一个永远返回 0 的闸毫无意义。所以在正式跑之前,往 body 上挂一个可见的、带中文文本 + 中文 title 的临时节点,
 * 用 en 跑一次扫描:两条都必须被抓到;移除后计数必须回到种之前的值。
 * 这样「0」才有意义:它证明的是"没有残留",不是"扫描器坏了"。种的是 DOM 节点,不动任何文件,用完 remove。 */
console.log('\n== 自检:闸能不能咬住(种一条假残留) ==');
const PLANT_SRC = `(function () {
  var d = document.createElement('div');
  d.id = 'r12hSelfTest';
  d.setAttribute('title', '哨兵属性残留');
  d.style.cssText = 'position:fixed;left:0;bottom:0;z-index:2147483000';
  d.textContent = '哨兵文本残留';
  document.body.appendChild(d);
  return 1;
})()`;
const UNPLANT_SRC = `(function(){ var d = document.getElementById('r12hSelfTest'); if (d) d.remove(); return !document.getElementById('r12hSelfTest'); })()`;
try {
  await val(switchSrc('en'));
  await sleep(450);
  const pre = await val(SCAN_SRC, 20000);
  const preN = (pre.hits || []).length;
  await val(PLANT_SRC);
  await sleep(120);
  const post = await val(SCAN_SRC, 20000);
  const got = (post.hits || []).map((h) => h.where + ' | ' + h.text);
  const hitText = got.some((x) => x.indexOf('哨兵文本残留') >= 0);
  const hitAttr = got.some((x) => x.indexOf('哨兵属性残留') >= 0);
  ok('自检:种下的中文文本节点被抓到', hitText, got);
  ok('自检:种下的中文 title 属性被抓到', hitAttr, got);
  ok('自检:只多出这 2 条,没有误伤别的元素', (post.hits || []).length === preN + 2, { pre: preN, post: (post.hits || []).length, got });
  const removed = await val(UNPLANT_SRC);
  await sleep(120);
  const after = await val(SCAN_SRC, 20000);
  ok('自检:移除哨兵后计数回到种之前(0 是真的 0,不是扫描器坏了)', removed === true && (after.hits || []).length === preN, { pre: preN, after: (after.hits || []).length });
} catch (e) {
  ok('自检:可执行', false, e.message);
  try { await val(UNPLANT_SRC); } catch (e2) { /* 连接已断 */ }
}

const LANGS_ORDER = ['zh', 'en', 'ja'];
const perLang = {};
// 归属(owner)由页面内的 ownerOf() 按祖先容器判定,这里只做去重:
// 基础外壳(顶栏/侧栏/标签栏/toast)在每一轮浮层扫描里都会出现,所以按「所属 UI」去重,
// 否则同一个顶栏按钮会被记 10 次。
const dedup = (arr, kf) => { const s = new Set(); return arr.filter((x) => { const k = kf(x); if (s.has(k)) return false; s.add(k); return true; }); };

await val(CLOSE_ALL);
await sleep(200);

for (const L of LANGS_ORDER) {
  console.log(`\n== 语言 ${L} ==`);
  const how = await val(switchSrc(L));
  await sleep(450);                                    // 等 applyI18n + renderSide + applySystemEffects 落定
  const active = await val(`currentLang()`);
  ok(`${L}: 语言已生效(currentLang=${active}, 走 ${how})`, active === L, { how, active });

  const merged = { raw: 0, rawShell: 0, hits: [], wl: [], wiring: [], cover: null, hookTotal: 0 };
  let fatal = null;
  for (const s of SURFACES) {
    try {
      if (s.o !== '1') await val(s.o, 6000);
      await sleep(260);                                // 等浮层展开动画(透明度/display 切换)
      const r = await val(SCAN_SRC, 20000);
      if (s.c !== '1') await val(s.c, 6000);
      await sleep(60);
      if (!r) { fatal = 'scan returned undefined on surface ' + s.n; continue; }
      if (r.fatal) { fatal = r.fatal; continue; }
      merged.raw += r.raw || 0;
      merged.hookTotal = Math.max(merged.hookTotal, r.hookTotal || 0); // 浮层开出来时钩子最多,取最大即全量
      if (s.n === 'shell') { merged.rawShell = r.raw || 0; merged.cover = r.cover || null; }
      (r.hits || []).forEach((h) => merged.hits.push(Object.assign({ seenIn: s.n }, h)));
      (r.wl || []).forEach((h) => merged.wl.push(Object.assign({ seenIn: s.n }, h)));
      (r.wiring || []).forEach((h) => merged.wiring.push(Object.assign({ seenIn: s.n }, h)));
    } catch (e) {
      // 兄弟 agent 在改前端并重载窗口时,WS 会断/上下文会丢 —— 本次结果不可信,直接收工报出来
      fatal = `扫描途中连接中断(浮层 ${s.n}): ${e.message} —— 实例可能正在重载,请重跑`;
      break;
    }
  }
  if (fatal) { ok(`${L}: 扫描器可用`, false, fatal); perLang[L] = merged; continue; }

  merged.hits.forEach((h) => { if (!h.owner) h.owner = 'shell 外壳(顶栏/侧栏/标签栏/查找栏/toast)'; });
  merged.hits = dedup(merged.hits, (h) => h.owner + '|' + h.where + '|' + h.sel + '|' + h.text);
  merged.wl = dedup(merged.wl, (h) => h.owner + '|' + h.where + '|' + h.sel + '|' + h.text);
  merged.wiring = dedup(merged.wiring, (h) => h.sel + '|' + h.key + '|' + h.mode + '|' + h.got);
  // 接线发现分两类:bad = 真的接线错(没贴/贴错键/键缺失)→ 硬失败;
  //                over = DOM 值本身是**当前语言的另一条字典值**(JS 现算文案盖住了钩子)→ 只警告,不算中文残留。
  merged.wiring.forEach((h) => { h.kind = h.want === '<key missing in I18N>' ? 'missing' : (h.altDict ? 'overridden' : 'wrong'); });
  merged.wiringBad = merged.wiring.filter((h) => h.kind !== 'overridden');
  merged.wiringWarn = merged.wiring.filter((h) => h.kind === 'overridden');
  perLang[L] = merged;

  const byOwner = {};
  merged.hits.forEach((h) => { byOwner[h.owner] = (byOwner[h.owner] || 0) + 1; });
  console.log(`  扫描: 含汉字的可见值 shell=${merged.rawShell} 条(全部浮层累计 ${merged.raw});残留(不在当前语言字典里)=${merged.hits.length}  白名单放行=${merged.wl.length}  接线错=${merged.wiringBad.length}  钩子被 JS 覆盖=${merged.wiringWarn.length}`);
  if (merged.cover) console.log(`  检查覆盖: 钩子元素共 ${merged.hookTotal} 个(${Object.entries(merged.cover).filter(([k, v]) => v > 0).map(([k, v]) => `${k}=${v}`).join('  ')})`);
  ok(`${L}: R1 接线检查有覆盖(钩子元素 > 0)`, merged.hookTotal > 0, { hookTotal: merged.hookTotal });
  console.log(`  残留分布: ${Object.keys(byOwner).length ? Object.entries(byOwner).map(([k, v]) => `${k}=${v}`).join('  |  ') : '(无)'}`);
  if (L === 'zh') {
    ok('zh: 扫描逻辑自检(外壳里确实扫到汉字,排除空扫)', merged.rawShell > 0, { rawShell: merged.rawShell });
  } else {
    ok(`${L}: UI 外壳无残留中文(排除正文区,白名单=语言名/路径)`, merged.hits.length === 0, merged.hits.length);
  }
  ok(`${L}: R1 钩子接线无错(贴了钩子就必须等于该键的当前语言字典值)`, merged.wiringBad.length === 0, merged.wiringBad.length);
}

// ---------- 5) 失败明细 ----------
function dumpDetail(L) {
  const m = perLang[L];
  if (!m) return;
  const byOwner = {};
  m.hits.forEach((h) => { (byOwner[h.owner] = byOwner[h.owner] || []).push(h); });
  const owners = Object.keys(byOwner);
  if (!owners.length && !m.wiring.length) { console.log(`\n--- ${L} 明细:无 ---`); return; }
  console.log(`\n--- ${L} 残留明细(前 ${DETAIL} 条,按所属 UI 分块)---`);
  let shown = 0, stop = false;
  for (const o of owners) {
    if (stop) break;
    console.log(`  ▸ ${o}(${byOwner[o].length} 条)`);
    for (const h of byOwner[o]) {
      if (shown >= DETAIL) { console.log(`    … 其余省略(共 ${m.hits.length} 条)`); stop = true; break; }
      console.log(`    - [${h.where}] ${h.sel} :: ${h.text}`);
      shown++;
    }
  }
  if (m.wiringBad && m.wiringBad.length) {
    console.log(`\n--- ${L} 接线错明细(前 ${DETAIL} 条;贴了钩子但 DOM 值既不是该键的字典值,也不是别的键的字典值)---`);
    m.wiringBad.slice(0, DETAIL).forEach((w) => console.log(`    - ${w.sel} [${w.src} ${w.key}/${w.mode}] want="${w.want}" got="${w.got}"`));
    if (m.wiringBad.length > DETAIL) console.log(`    ... 其余省略(${m.wiringBad.length - DETAIL} 条)`);
  }
  if (m.wiringWarn && m.wiringWarn.length) {
    console.log(`\n--- ${L} 钩子被 JS 覆盖(前 ${DETAIL} 条;DOM 值本身是当前语言的另一条字典值 ⇒ 不是中文残留,但切语言时 applyI18n 会把它改回钩子的键)---`);
    m.wiringWarn.slice(0, DETAIL).forEach((w) => console.log(`    - ${w.sel} [${w.src} ${w.key}/${w.mode}] 钩子="${w.want}" 实际="${w.got}"`));
    if (m.wiringWarn.length > DETAIL) console.log(`    ... 其余省略(${m.wiringWarn.length - DETAIL} 条)`);
  }
  if (m.wl.length) {
    console.log(`\n--- ${L} 白名单放行(仅供核对,不算失败;前 ${Math.min(10, m.wl.length)} 条 / 共 ${m.wl.length} 条)---`);
    m.wl.slice(0, 10).forEach((w) => console.log(`    - [${w.where}] ${w.sel} :: ${w.text}`));
  }
}
dumpDetail('en');
dumpDetail('ja');

// ---------- 6) 收尾:恢复语言 + 关掉本闸开过的浮层 ----------
try {
  await val(CLOSE_ALL);
  await val(switchSrc(BEFORE.lang || 'zh'));
  await sleep(300);
  await val(CLOSE_ALL);
} catch (e) {
  console.log(`  (收尾时连接已断:${e.message} — 实例可能正在重载,语言/浮层状态未复位)`);
}
const AFTER = await val(`(function(){ return { lang: currentLang(), ls: localStorage.getItem('sr_lang'), sp: !$id('settingsPanel').hidden, gp: !$id('glassPanel').hidden, cd: !!document.querySelector('[data-drawer].active'), cx: !$id('ctxMenu').hidden, fb: !$id('findBar').hidden }; })()`)
  .catch((e) => ({ err: e.message }));
ok(`收尾:语言恢复为 ${BEFORE.lang || 'zh'}`, !!AFTER && AFTER.lang === (BEFORE.lang || 'zh'), AFTER);
ok('收尾:浮层全部关闭(设置/玻璃/抽屉/右键菜单/查找栏)', !!AFTER && !AFTER.sp && !AFTER.gp && !AFTER.cd && !AFTER.cx && !AFTER.fb, AFTER);
console.log(`  收尾后: ${JSON.stringify(AFTER)}`);

console.log(`\n== r12h: pass=${results.pass} fail=${results.fail} ==`);
if (results.fail) { console.log('failures:'); results.fails.forEach((f) => console.log('  - ' + f)); }
const warnLangs = LANGS_ORDER.filter((l) => perLang[l] && perLang[l].wiringWarn && perLang[l].wiringWarn.length);
if (warnLangs.length) {
  console.log('warnings(不算失败,但值得看一眼:钩子被 JS 现算文案覆盖,切语言会被改回钩子的键):');
  warnLangs.forEach((l) => console.log(`  - ${l}: ${perLang[l].wiringWarn.length} 处 → ${perLang[l].wiringWarn.map((w) => w.sel + '(' + w.key + ')').join(', ')}`));
}
ws.close();
process.exit(results.fail ? 1 : 0);
