/* TMMD（透明MD） · 轻量本地 Markdown 阅读器（Tauri 2）
 * v1.3.0：导读地图视图（侧栏地铁图+进度）/ AI 章节导读卡（3判断+1反常识+1动作，LLM 生成+本机缓存）/ 设置面板 AI 网关配置
 * v1.2.1：窗口拖动修复——WebView2 不认 CSS -webkit-app-region，改 mousedown → startDragging()（capabilities 加 allow-start-dragging）
 * v1.2.0：正文本地图片/视频/音频渲染（asset 协议 convertFileSrc + 相对路径基于 md 目录解析）
 * v1.1.0：SVG 线性图标 / 工具栏分组+响应式溢出 / 历史与收藏合并 /
 *         主题降级防 dark palette 残留 / 路径规范化 / spawn 不覆盖已有 root
 */
/* global marked, hljs */
const $id = (s) => document.getElementById(s);
const $q = (s, r) => (r || document).querySelector(s);
const $qa = (s, r) => Array.from((r || document).querySelectorAll(s));

const __tauri = window.__TAURI__;
const invoke = (__tauri && __tauri.core.invoke) || null;
const listen = (__tauri && __tauri.event.listen) || null;
const wview = (__tauri && __tauri.webview && __tauri.webview.getCurrentWebview) ? __tauri.webview.getCurrentWebview() : null;

/* ---- 全局状态 ---- */
const LS = {
  get(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch { return d; } },
  set(k, v) { localStorage.setItem(k, JSON.stringify(v)); },
  str(k, v) { try { localStorage.setItem(k, String(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
  raw(k) { try { return localStorage.getItem(k); } catch { return null; } },
};
// 编辑历史（自维护 undo/redo 栈；拦截 Ctrl+Z/Y 避免与 textarea 原生栈双倍回退）
const editHist = { undo: [], redo: [] };
/* 撤销栈上限:每步是整文快照,长文档不设限会越堆越大(2026-10-25 加) */
const UNDO_MAX = 200;
let prevEditValue = '';
let lastHistT = 0;
let histLock = false; // doUndo/doRedo 编程赋值期间抑制 input 记史
// resize 防抖计时器（重排工具栏溢出；曾用于透明窗合成层 hack，见 wire 内注释）
const resizeTimer = { _t: 0 };
const PALETTES = {
  dark: ['charcoal', 'gruvbox'],
  light: ['paper', 'gruvbox'],
};
const SWATCH_COLORS = {
  'charcoal': '#e0a458', 'paper': '#b3541e', 'gruvbox': '#fe8019',
};
// R12b Round-2 氛围三预设：中 = R12a 默认(12/25/35/30)，弱接近清水，强深度磨砂；底色透明度(base)随预设走，后端 alpha 按拆分份额走(v1.8)
// R12b 字号三预设：阅读 = 旧默认(1.75/16/14)，代码放大代码，演示整体放大
/* v1.8 整窗一整块玻璃:氛围档不再分四路浓度,只给**一个总浓度**(percent)。
 * 默认浓度 = GLASS_CONC_DEFAULT = 40(用户 2026-10-25 定调:"要 40%,总之我要透出来半透明效果"),
 * 比 pebrel 的 45 再透一点点;选它就意味着接受亮壁纸处文字对比下降(实测见 docs/CHANGELOG.md 的 v1.8.1),
 * 所以滑条留着:嫌淡就往上推(strong=70)。 */
// 单一浓度的唯一 SSOT:预设 / 兜底 / 回显全用它,别再散写字面量(此前 3 处兜底写 45,与预设 40 打架)。
const GLASS_CONC_DEFAULT = 40;
const HALO_DEFAULT = 55;   // 文字晕默认强度(%);--halo-k 与它的关系见 app.css
const ATMOS_PRESETS = {
  weak: { conc: 20, text: 100 },
  medium: { conc: GLASS_CONC_DEFAULT, text: 100 },
  strong: { conc: 70, text: 100 },
};
/* 浓度 → 氛围档的**唯一**映射(v1.8.16 收):存档迁移与浓度拖动条都调它。
 * 阈值 60/25 是 v1.8 定的(conc≥60 强 / ≤25 弱 / 其余中),别再各处复写一份。 */
const atmosOf = (conc) => (Number(conc) >= 60 ? 'strong' : Number(conc) <= 25 ? 'weak' : 'medium');
const FONT_PRESETS = {
  read: { h1: 1.75, body: 16, code: 14 },
  code: { h1: 1.6, body: 15, code: 15 },
  demo: { h1: 2.1, body: 19, code: 16 },
};
// R12b 旧存档前迁：on/material/tint 原样保留；铬/正文/浮层三路均值就近落氛围档(>=45 强，<=18 弱，其余中)；数值按档重写
function migrateGlass(g) {
  // halo = 文字晕强度 0–100(玻璃面板「文字阴影」拖动条)。2026-10-25 用户"晕太重,有点丑" → 提成可调,默认 55。
  const d = { on: true, material: 'acrylic', tint: '#26282e', atmos: 'medium', halo: HALO_DEFAULT, ...ATMOS_PRESETS.medium };
  if (!(g && typeof g === 'object' && 'tint' in g)) return d;
  const out = { ...d };
  if (typeof g.on === 'boolean') out.on = g.on;
  out.material = (g.material === 'none' || g.material === 'acrylic' || g.material === 'mica') ? g.material : 'acrylic';
  if (typeof g.tint === 'string' && /^#[0-9a-fA-F]{6}$/.test(g.tint)) out.tint = g.tint;
  // 老存档没有 halo 键 → 落新默认(与 conc 不同:这个键没有"用户真调过"的历史包袱)
  out.halo = Math.min(100, Math.max(0, Number.isFinite(+g.halo) ? +g.halo : HALO_DEFAULT));
  const num = (v) => (Number.isFinite(+v) ? +v : NaN);
  // v1.8.1:老存档**就是旧默认档**时(12/25/35/30,说明用户从没动过浓度滑条),直接落新默认
  // (medium = 40);否则按正文区实际浓淡折算 —— 用户真调过的值不能被我覆盖。
  // 不这么分的话,旧默认档会折算成 43%,等于拿旧默认顶掉了用户新定的 40%(2026-10-25 实测踩到)。
  const LEGACY_MEDIUM = { base: 12, chrome: 25, reader: 35, pop: 30 };
  const isLegacyDefault = ['base', 'chrome', 'reader', 'pop'].every((k) => num(g[k]) === LEGACY_MEDIUM[k]);
  // v1.8:四路(base/chrome/reader/pop)→ 单一 conc。老存档按"正文区实际合成浓淡"折算:
  // 1-(1-base)(1-reader)(旧模型里 html+body 各画一次 base,此处按一次算,差值落在预设档内)。
  const eff = (Number.isFinite(num(g.base)) && Number.isFinite(num(g.reader)))
    ? 100 * (1 - (1 - num(g.base) / 100) * (1 - num(g.reader) / 100)) : NaN;
  const savedConc = Number.isFinite(num(g.conc)) ? num(g.conc)
    : (isLegacyDefault ? ATMOS_PRESETS.medium.conc : eff);
  if (Number.isFinite(savedConc)) out.conc = Math.round(Math.min(100, Math.max(1, savedConc)));
  const avg = (num(g.chrome) + num(g.reader) + num(g.pop)) / 3;
  out.atmos = Number.isFinite(out.conc)
    ? atmosOf(out.conc)
    : (Number.isFinite(avg) ? (avg >= 45 ? 'strong' : avg <= 18 ? 'weak' : 'medium') : 'medium');
  Object.assign(out, ATMOS_PRESETS[out.atmos]);
  // 用户存过自定义浓度时保留它(氛围档只负责回显高亮)
  if (Number.isFinite(savedConc)) out.conc = Math.round(Math.min(100, Math.max(1, savedConc)));
  return out;
}
// R12b 存档净化：tintDraft 是内存草稿，永不落盘（误点可取消的根基）
function persistGlass() {
  const g = (S.glass && typeof S.glass === 'object') ? { ...S.glass } : migrateGlass(null);
  delete g.tintDraft;
  return g;
}
// 旧字号三围精确命中用档名，否则正文>=18判演示、代码>=15判代码，余者阅读；三围数值原样保留
function migrateFontPreset() {
  const saved = LS.get('sr_font_preset', null);
  if (saved === 'read' || saved === 'code' || saved === 'demo') return saved;
  const h1 = +LS.get('sr_h1', 1.75), body = +LS.get('sr_body', 16), code = +LS.get('sr_code', 14);
  for (const k of ['read', 'code', 'demo']) {
    const p = FONT_PRESETS[k];
    if (h1 === p.h1 && body === p.body && code === p.code) return k;
  }
  return body >= 18 ? 'demo' : code >= 15 ? 'code' : 'read';
}

const S = {
  roots: LS.get('sr_roots', []),
  recent: LS.get('sr_recent', []),
  favorites: LS.get('sr_favorites', []),
  theme: LS.get('sr_theme', 'dark'),
  palette: LS.get('sr_palette', 'charcoal'),
  h1Size: LS.get('sr_h1', 1.75),
  bodySize: LS.get('sr_body', 16),
  codeSize: LS.get('sr_code', 14),
  fontPreset: migrateFontPreset(),
  glass: migrateGlass(LS.get('sr_glass', null)),
  sideW: LS.get('sr_side_w', 260),
  sideCollapsed: LS.get('sr_side_col', false),
  sideCompact: LS.get('sr_side_compact', false),
  sideBottomH: LS.get('sr_side_bottom_h', 180),
  toolbarMode: LS.get('sr_tb_mode', 'icon'),
  // v1.7 排版与阅读增强(docs/2026-10-24-竞品与差距分析.md P0/P1)
  bodyFont: LS.get('sr_body_font', 'sans'),
  measure: LS.get('sr_measure', 34),
  lineH: LS.get('sr_line_h', 1.7),
  codeLn: LS.get('sr_code_ln', true),
  /* 行内 code/引用的画法(设置 → 阅读增强)。默认 wash:不加盒子、不压亮度,又能一眼扫出代码片段。
   * 四档见 app.css 的 body.code-*;这里是 SSOT,LS 里存了非法值一律回落 wash。 */
  codeStyle: (() => { const v = LS.get('sr_code_style', 'wash'); return ['wash', 'underline', 'bare', 'plate'].includes(v) ? v : 'wash'; })(),
  focusMode: LS.get('sr_focus', false),
  zen: false,
  lang: LS.get('sr_lang', null),
  sysNoEffects: false,
  find: { q: '', hits: [], idx: -1 },
  search: { q: '', hits: [], busy: false },
  root: null,
  cur: null,
  // R7 标签页：多 md 并存。tabs 存描述符（持久化只留路径三元组），raw/draft/editing 常驻内存。
  tabs: (() => { const t = LS.get('sr_tabs', []); return Array.isArray(t) ? t.filter((x) => x && typeof x.abs === 'string') : []; })(),
  activeKey: LS.get('sr_active_tab', null),
  view: 'tree',
  toc: [],
  editing: false,
  editDirty: false,
};

/* ==================== 渲染 ==================== */
marked.setOptions({ gfm: true, breaks: true, headerIds: true, headerPrefix: 'srh-' });

// —— 本地多媒体（图片/视频/音频）asset 协议解析 ——
// WebView2 禁 file://；markdown 里的相对/绝对本地路径必须转成 tauri asset:// URL 才能加载。
let CURRENT_ABS = null; // 当前渲染 md 的绝对路径，marked.parse 同步执行期间有效

function isRemoteMedia(href) {
  return /^(https?:|data:|blob:|asset:)/i.test(href);
}

// 规整本地路径为 Windows 绝对路径（保留盘符/UNC，折叠 ./.. 段）
function normLocalMediaPath(p) {
  let s = String(p).trim().replace(/^file:\/\//i, '');
  const isUnc = /^\\\\/.test(s);
  const wasAbs = /^[a-zA-Z]:[\\/]/.test(s) || s.startsWith('/');
  const out = [];
  for (const seg of s.split(/[\\/]+/)) {
    if (!seg || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return (isUnc ? '\\\\' : '') + out.join('\\');
}

// href → 可加载 src：远程/已转原样；本地相对基于当前 md 目录解析成绝对再转 asset
function mediaSrc(href) {
  if (!href || isRemoteMedia(href)) return href;
  const tauri = window.__TAURI__ && window.__TAURI__.core;
  if (!tauri || !tauri.convertFileSrc) return href; // 非 Tauri 环境降级原样
  let abs;
  if (/^[a-zA-Z]:[\\/]/.test(href) || /^\\\\/.test(href) || href.startsWith('/')) {
    abs = normLocalMediaPath(href);
  } else if (CURRENT_ABS) {
    const m = CURRENT_ABS.match(/[\\/][^\\/]*$/);
    if (!m) return href; // 无目录上下文（如拖拽纯文件名）
    abs = normLocalMediaPath(CURRENT_ABS.slice(0, m.index) + '\\' + href);
  } else {
    return href;
  }
  return tauri.convertFileSrc(abs);
}

marked.use({
  renderer: {
    image({ href, title, text }) {
      const src = mediaSrc(href);
      const q = (x) => String(x || '').replace(/"/g, '&quot;');
      return `<img src="${src}" alt="${q(text)}"${title ? ` title="${q(title)}"` : ''} loading="lazy">`;
    },
  },
});

// 渲染后补转 md 内 HTML 直插的多媒体（img/video/audio/source）——幂等，已转的 asset:// 原样
function fixMediaSrc(root) {
  $qa('img, video[src], audio[src], source[src]', root).forEach((el) => {
    const s = el.getAttribute('src');
    if (s) el.setAttribute('src', mediaSrc(s));
  });
}

// 本地图片加载失败（路径错/文件缺失）→ 降级显示文件名占位，不挂破图
function wireImgFallback(root) {
  $qa('img', root).forEach((img) => {
    img.addEventListener('error', () => {
      const f = (img.getAttribute('alt') || img.getAttribute('src') || 'image').replace(/^.*[\\/]/, '');
      img.classList.add('srh-img-err');
      img.alt = '图片加载失败：' + f;
      img.removeAttribute('src');
    }, { once: true });
  });
}

function sanitize(root) {
  $qa('script', root).forEach((n) => n.remove());
  const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    for (const a of Array.from(n.attributes)) {
      if (/^on/i.test(a.name)) n.removeAttribute(a.name);
      else if (a.name === 'href' && /^javascript:/i.test(a.value)) n.removeAttribute(a.name);
    }
  }
}
function highlightCode(root) {
  $qa('pre code', root).forEach((el) => {
    const lang = (el.className.match(/language-([\w+\-]+)/) || [])[1];
    try { el.innerHTML = hljs.highlight(el.textContent, { language: lang }).value; }
    catch { try { el.innerHTML = hljs.highlightAuto(el.textContent).value; } catch {} }
    el.classList.add('hljs');
  });
}
function renderMath(root) {
  if (!window.renderMathInElement) return;
  try {
    renderMathInElement(root, {
      delimiters: [{ left: '$$', right: '$$', display: true }, { left: '$', right: '$', display: false }],
      ignoredTags: ['pre', 'code', 'script', 'style'], throwOnError: false,
    });
  } catch {}
}
function buildToc(root) {
  return $qa('h1,h2,h3,h4', root).map((h, i) => {
    if (!h.id) h.id = 'srh-' + i + '-' + Math.random().toString(36).slice(2, 6);
    return { level: +h.tagName[1], text: h.textContent, id: h.id };
  });
}

function renderMarkdown(md, absParam) {
  const inner = $id('readerInner');
  const body = document.createElement('div');
  body.className = 'markdown-body';
  CURRENT_ABS = absParam || null;
  body.innerHTML = marked.parse(preprocessFootnotes(md.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n/, '')));
  CURRENT_ABS = null;
  sanitize(body);
  highlightCode(body);
  renderMath(body);
  fixMediaSrc(body);
  enhanceCodeBlocks(body);   // v1.7:代码块复制按钮 + 行号(必须在 highlightCode 之后)
  wireImgFallback(body);
  S.toc = buildToc(body);
  inner.innerHTML = '';
  inner.appendChild(body);
  const name = absParam ? absParam.split(/[\\/]/).pop() : '';
  document.title = name ? name + ' · TMMD' : 'TMMD';
  const top = Number(LS.raw('sr_scr_' + absParam) || 0);
  const rd = $id('reader');
  rd.scrollTop = 0; // 容器复用：先清旧文件滚动残留，防切换 md 后新文件停在底部
  if (absParam && top > 0) {
    // 恢复上次阅读位置；值超出正文可滚高度 = 内容结构已变或值已陈旧毒化，
    // 归零从头读，避免首屏直接落在文末稀疏区（2026-08-05 用户"首屏黑"根因）
    const max = rd.scrollHeight - rd.clientHeight;
    if (top > max) {
      LS.del('sr_scr_' + absParam);
    } else {
      rd.scrollTop = top;
    }
  }
  refreshFavDocBtn();
  if (S.view === 'toc' || S.view === 'map') renderSide();
}

function rememberScroll() {
  if (S.cur && S.cur.abs) LS.str('sr_scr_' + S.cur.abs, $id('reader').scrollTop);
}

/* ==================== 刷新 / 编辑 ==================== */
/* 离开编辑态前的守卫:2026-10-25 起走三选弹窗(保存 / 不保存 / 取消),
 * 不再是 window.confirm 的"只有放弃"。返回 true 表示可以继续。 */
async function confirmLeaveEdit() {
  if (!(S.editing && S.editDirty)) return true;
  const a = await askUnsaved();
  if (a === 'save') return await saveEdit();
  return a === 'discard';
}
function leaveEdit() {
  if (!S.editing) return;
  S.editing = false;
  S.editDirty = false;
  const ed = $id('editor');
  if (ed) { ed.hidden = true; ed.value = ''; }
  const inner = $id('readerInner');
  if (inner) inner.hidden = false;
  const b = $id('btnEdit');
  if (b) {
    const lab = b.querySelector('span'); if (lab) lab.textContent = '编辑文档';
    const u = b.querySelector('use'); if (u) u.setAttribute('href', '#i-edit');
    b.title = '编辑当前文档';
  }
  syncHistBtns();
}
function enterEdit() {
  if (!S.cur) return toast(t('toast.noDoc'));
  rememberScroll();
  const ed = $id('editor');
  if (!ed) return;
  ed.value = S.cur.raw != null ? S.cur.raw : '';
  // 撤销栈按标签隔离:切回来时恢复该标签自己的历史(此前是全局单例,切标签即全丢)
  const tb = getTab(S.cur.abs);
  const h = (tb && tb.hist && Array.isArray(tb.hist.undo)) ? tb.hist : null;
  editHist.undo = h ? h.undo.slice() : [];
  editHist.redo = h ? h.redo.slice() : [];
  lastHistT = 0;
  prevEditValue = ed.value;
  ed.hidden = false;
  $id('readerInner').hidden = true;
  S.editing = true;
  S.editDirty = false;
  const b = $id('btnEdit');
  if (b) {
    const lab = b.querySelector('span'); if (lab) lab.textContent = '保存修改';
    const u = b.querySelector('use'); if (u) u.setAttribute('href', '#i-save');
    b.title = '保存修改到原文件';
  }
  syncHistBtns();
  ed.focus();
}
function pushUndo(v) {
  const now = Date.now();
  if (editHist.undo.length && now - lastHistT < 500) editHist.undo[editHist.undo.length - 1] = v;
  else editHist.undo.push(v);
  // 上限:每步是整文快照,长文档不设限会越堆越大(2026-10-25 加)
  while (editHist.undo.length > UNDO_MAX) editHist.undo.shift();
  lastHistT = now;
  editHist.redo.length = 0;
  syncHistBtns();
}
/* 把当前撤销/重做栈存回活动标签(切走/保存/关标签前调用),配合 enterEdit 实现"按标签隔离"。 */
function stashHist() {
  const tb = getTab(S.activeKey);
  if (!tb) return;
  tb.hist = { undo: editHist.undo.slice(), redo: editHist.redo.slice() };
}
function syncHistBtns() {
  const u = $id('btnUndo'); if (u) u.disabled = !S.editing || !editHist.undo.length;
  const r = $id('btnRedo'); if (r) r.disabled = !S.editing || !editHist.redo.length;
}
function doUndo() {
  const ed = $id('editor');
  if (!S.editing || !editHist.undo.length || !ed) return;
  histLock = true;
  try {
    editHist.redo.push(ed.value);
    ed.value = editHist.undo.pop();
    prevEditValue = ed.value;
    lastHistT = 0;
    S.editDirty = (ed.value !== (S.cur && S.cur.raw != null ? S.cur.raw : '').replace(/\r\n?/g, '\n'));
  } finally { histLock = false; }
  syncHistBtns();
  renderTabs();
}
function doRedo() {
  const ed = $id('editor');
  if (!S.editing || !editHist.redo.length || !ed) return;
  histLock = true;
  try {
    editHist.undo.push(ed.value);
    ed.value = editHist.redo.pop();
    prevEditValue = ed.value;
    lastHistT = 0;
    S.editDirty = (ed.value !== (S.cur && S.cur.raw != null ? S.cur.raw : '').replace(/\r\n?/g, '\n'));
  } finally { histLock = false; }
  syncHistBtns();
  renderTabs();
}
/* 落盘一个标签的内容(唯一写入口)。返回 'ok' | 'conflict';其它错误抛出,由调用方提示。
 * force=true 跳过后端冲突检测(用户已确认覆盖)。写成功后同步标签与 S.cur 状态。 */
async function writeTabContent(tab, content, force) {
  const args = { content, force: !!force };
  try {
    if (tab.relPos) await invoke('write_text', { root: tab.rootPath || S.root.rootPath, rel: tab.relPos, ...args });
    else await invoke('save_path', { path: tab.abs, ...args });
  } catch (e) {
    const msg = String(trErr(e));
    if (msg.includes('CONFLICT|')) return 'conflict'; // 后端发现磁盘被外部改过
    throw e;
  }
  tab.raw = content;
  tab.draft = null;
  tab.editDirty = false;
  tab.stale = false;
  tab.selfWriteAt = Date.now();   // 我们自己写的:watcher 会回声一次,别让它变成"磁盘已更新"的假提示/多余重读
  if (S.cur && normPath(S.cur.abs) === normPath(tab.abs)) { S.cur.raw = content; S.editDirty = false; }
  return 'ok';
}
/* 通用小弹窗:标题 + 可选说明 + 可选单行输入 + 按钮。返回 { action, value }。
 * action 取按钮的 data-a;输入值在 value。Escape / 点背景 = cancel。 */
function openDialog(opts) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'askwrap';
    wrap.innerHTML = '<div class="askcard" role="dialog" aria-modal="true">'
      + '<div class="ask-title"></div><div class="ask-sub"></div>'
      + (opts.input != null ? '<input class="ask-input" type="text" spellcheck="false" />' : '')
      + '<div class="ask-btns"></div></div>';
    wrap.querySelector('.ask-title').textContent = opts.title || '';
    const sub = wrap.querySelector('.ask-sub');
    if (opts.sub) sub.textContent = opts.sub;
    else sub.remove();
    const inp = wrap.querySelector('.ask-input');
    let done;
    if (inp) {
      inp.value = opts.input || '';
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); done(opts.primary || 'ok', inp.value); }
      });
    }
    const btns = wrap.querySelector('.ask-btns');
    (opts.buttons || []).forEach((b) => {
      const el = document.createElement('button');
      el.textContent = b.label;
      el.dataset.a = b.a;
      if (b.primary) el.className = 'active';
      btns.appendChild(el);
    });
    done = (a, v) => {
      document.removeEventListener('keydown', onKey, true);
      wrap.remove();
      resolve({ action: a, value: v });
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done('cancel'); } };
    document.addEventListener('keydown', onKey, true);
    wrap.addEventListener('click', (e) => {
      const a = e.target && e.target.dataset ? e.target.dataset.a : null;
      if (a) done(a, inp ? inp.value : undefined);
      else if (e.target === wrap) done('cancel');
    });
    document.body.appendChild(wrap);
    if (inp) { inp.focus(); inp.select(); }
    else { const f = btns.querySelector('button'); if (f) f.focus(); }
  });
}
/* 未保存三选弹窗(替代 window.confirm 的"只有放弃")。mode='conflict' 时是覆盖确认。
 * 返回 'save' | 'discard' | 'cancel'。 */
async function askUnsaved(mode) {
  const conflict = mode === 'conflict';
  const r = await openDialog({
    title: t(conflict ? 'conflict.title' : 'unsaved.title'),
    sub: t(conflict ? 'conflict.sub' : 'unsaved.sub'),
    primary: 'save',
    buttons: conflict
      ? [{ label: t('conflict.overwrite'), a: 'save', primary: true }, { label: t('unsaved.cancel'), a: 'cancel' }]
      : [{ label: t('unsaved.save'), a: 'save', primary: true }, { label: t('unsaved.discard'), a: 'discard' }, { label: t('unsaved.cancel'), a: 'cancel' }],
  });
  return r.action;
}
/* 单行输入弹窗:返回去空白后的字符串,取消返回 null。 */
async function askText(title, value, sub) {
  const r = await openDialog({
    title, sub, input: value, primary: 'ok',
    buttons: [{ label: t('dlg.ok'), a: 'ok', primary: true }, { label: t('unsaved.cancel'), a: 'cancel' }],
  });
  if (r.action !== 'ok') return null;
  const v = String(r.value || '').trim();
  return v || null;
}
/* 两选确认弹窗。 */
async function askConfirm(title, sub, okLabel) {
  const r = await openDialog({
    title, sub, primary: 'ok',
    buttons: [{ label: okLabel, a: 'ok', primary: true }, { label: t('unsaved.cancel'), a: 'cancel' }],
  });
  return r.action === 'ok';
}
async function saveEdit() {
  if (!S.cur || !S.editing) return false;
  const tb = getTab(S.cur.abs) || { abs: S.cur.abs, relPos: S.cur.relPos, rootPath: S.cur.rootPath };
  const content = $id('editor').value;
  try {
    let r = await writeTabContent(tb, content, false);
    if (r === 'conflict') {                                  // 不静默覆盖外部改动
      if ((await askUnsaved('conflict')) !== 'save') return false;
      r = await writeTabContent(tb, content, true);
      if (r !== 'ok') return false;
    }
    tb.editing = false;
    tb.editDirty = false;
    stashHist();                          // 保存后把撤销栈存回标签(切回来还能继续撤销)
    renderMarkdown(content, S.cur.abs);   // 恢复进入编辑前的滚动位置
    leaveEdit();
    persistTabs();
    renderTabs();
    toast(t('toast.saved'));
    refreshTreeOrder();
    return true;
  } catch (e) { toast(t('toast.saveFail') + trErr(e)); return false; }
}
/* 把所有脏标签逐个落盘(关窗 / 切库前用)。任一失败即停 —— 绝不"存一半就把窗口放走"。
 * 后台标签用它的 draft(切标签时 stash 过的草稿),当前标签用编辑器里的实时内容。 */
async function saveAllDirty() {
  const curAbs = S.cur && S.cur.abs;
  for (const tab of S.tabs.slice()) {
    const isCur = tab.abs === curAbs;
    const dirty = isCur ? !!(S.editing && S.editDirty) : !!tab.editDirty;
    if (!dirty) continue;
    const content = isCur ? $id('editor').value : (tab.draft != null ? tab.draft : tab.raw);
    if (typeof content !== 'string') continue;
    try {
      let r = await writeTabContent(tab, content, false);
      if (r === 'conflict') {
        if ((await askUnsaved('conflict')) !== 'save') return false;
        r = await writeTabContent(tab, content, true);
        if (r !== 'ok') return false;
      }
      if (isCur) { leaveEdit(); renderMarkdown(content, tab.abs); }
    } catch (e) { toast(t('toast.saveFail') + trErr(e)); return false; }
  }
  persistTabs();
  renderTabs();
  return true;
}
/* 还有未保存内容吗(关窗守卫与提示用)。 */
function anyDirty() {
  const curAbs = S.cur && S.cur.abs;
  return S.tabs.some((t) => (t.abs === curAbs ? !!(S.editing && S.editDirty) : !!t.editDirty));
}
async function refreshCurrent() {
  if (!S.cur) return toast(t('toast.noDoc'));
  if (!(await confirmLeaveEdit())) return;
  leaveEdit();
  rememberScroll();
  try {
    const md = S.cur.relPos
      ? await invoke('read_text', { root: S.cur.rootPath || S.root.rootPath, rel: S.cur.relPos })
      : await invoke('open_path', { path: S.cur.abs });
    S.cur.raw = md;
    const tb2 = getTab(S.cur.abs);
    if (tb2) { tb2.raw = md; tb2.draft = null; tb2.editing = false; tb2.editDirty = false; }
    renderMarkdown(md, S.cur.abs);
    persistTabs();
    renderTabs();
    toast(t('toast.refreshed'));
  } catch (e) { toast(t('toast.refreshFail') + trErr(e)); }
}
/// 保存后按 mtime 重排文件树（最新在前）
async function refreshTreeOrder() {
  if (!S.root || !S.root.rootPath) return;
  try {
    const scan = await invoke('list_md_tree', { root: S.root.rootPath });
    S.root.scan = scan;
    if (S.view === 'tree') renderSide();
  } catch { /* 静默：树保持现状 */ }
}

/* ==================== 新建 / 另存为 / 重命名 / 删除(2026-10-25 编辑第二批) ====================
 * 全部走囚笼校验(Rust 侧 cage_join),前端只负责问清楚、刷新树、维护标签状态。 */
async function newDoc() {
  if (!S.root || !S.root.rootPath) { toast(t('toast.needRoot')); return; }
  const rel = await askText(t('dlg.newTitle'), '未命名.md', t('dlg.newSub'));
  if (!rel) return;
  try {
    await invoke('create_file', { root: S.root.rootPath, rel, content: `# ${rel.split('/').pop().replace(/\.(md|markdown|txt)$/i, '')}\n\n` });
    await refreshTreeOrder();
    await openInRoot(rel);       // 建完直接打开
    if (!S.editing) enterEdit(); // 新建即改(不然还得再点一次编辑)
    toast(t('toast.created'));
  } catch (e) { toast(t('toast.createFail') + trErr(e)); }
}
async function saveAsDoc() {
  if (!S.cur) { toast(t('toast.noDoc')); return; }
  const content = S.editing ? $id('editor').value : (S.cur.raw || '');
  const base = String(S.cur.abs).split(/[\\/]/).pop() || '未命名.md';
  try {
    const path = await invoke('pick_save', { defaultName: base });
    if (!path) return;
    // 用户从系统对话框里选的路径 = 明确目标,force=true(覆盖与否由对话框负责)
    await invoke('save_path', { path, content, force: true });
    await openTab({ abs: path, kind: 'ext' });
    // 原文档的改动并没有写回原文件:如实说,不假装"保存成功"
    if (S.editing && getTab(S.cur.abs) && getTab(S.cur.abs).editDirty) toast(t('toast.saveAsDirty'));
    else toast(t('toast.saveAs', { name: String(path).split(/[\\/]/).pop() }));
  } catch (e) { toast(t('toast.saveFail') + trErr(e)); }
}
async function renameDoc() {
  const t0 = S.cur && getTab(S.cur.abs);
  if (!t0 || !t0.relPos) { toast(t('toast.renameOutOfRoot')); return; }
  const newRel = await askText(t('dlg.renameTitle'), t0.relPos, t('dlg.renameSub'));
  if (!newRel || newRel === t0.relPos) return;
  try {
    await invoke('rename_file', { root: t0.rootPath || S.root.rootPath, rel: t0.relPos, newRel });
    // 标签跟着改名,否则它指向一个已经不存在的路径
    const oldAbs = t0.abs;
    t0.relPos = newRel;
    t0.abs = absOfRel(newRel) || oldAbs;
    if (S.cur && normPath(S.cur.abs) === normPath(oldAbs)) {
      S.cur.abs = t0.abs;
      if (S.cur.relPos) S.cur.relPos = newRel;
    }
    S.activeKey = t0.abs;
    LS.del('sr_scr_' + oldAbs);
    if (S.fav && S.fav[oldAbs]) { delete S.fav[oldAbs]; }
    await refreshTreeOrder();
    persistTabs();
    renderTabs();
    toast(t('toast.renamed'));
  } catch (e) { toast(t('toast.renameFail') + trErr(e)); }
}
async function deleteDoc() {
  const tb = S.cur && getTab(S.cur.abs);
  if (!tb || !tb.relPos) { toast(t('toast.deleteOutOfRoot')); return; }
  const okDel = await askConfirm(t('dlg.deleteTitle'), t('dlg.deleteSub', { name: tb.relPos }), t('menu.delete'));
  if (!okDel) return;
  try {
    await invoke('delete_file', { root: tb.rootPath || S.root.rootPath, rel: tb.relPos });
    const abs = tb.abs;
    leaveEdit();
    S.tabs = S.tabs.filter((x) => x !== tb);
    if (normPath(S.activeKey) === normPath(abs)) {
      const next = S.tabs[S.tabs.length - 1];
      S.activeKey = next ? next.abs : null;
      if (next) activateTab(next, {}); else { S.cur = null; renderEmpty(); }
    }
    LS.del('sr_scr_' + abs);
    await refreshTreeOrder();
    persistTabs();
    renderTabs();
    toast(t('toast.deleted'));
  } catch (e) { toast(t('toast.deleteFail') + trErr(e)); }
}

/* ==================== 编辑态查找替换(2026-10-25 编辑第二批) ====================
 * 阅读态的 Ctrl+F 作用于渲染后的 DOM(能高亮);编辑态是 textarea,浏览器不允许高亮,
 * 所以这里做"选中 + 跳转 + 计数"的最小可用版:区分大小写的纯文本查找、替换当前、全部替换。
 * 每次改动都进撤销栈(Ctrl+Z 能退回来),并点亮标签脏点。 */
let editFind = { q: '', idx: 0 };
function buildEditFindBar() {
  const bar = document.createElement('div');
  bar.id = 'editFindBar';
  bar.className = 'findbar edit-find';
  bar.hidden = true;
  bar.innerHTML = '<input id="editFindQ" class="set-text" placeholder="查找" spellcheck="false">'
    + '<span id="editFindCnt" class="edit-find-cnt">0/0</span>'
    + '<button id="editFindPrev" class="icon-btn" title="上一个">\u2191</button>'
    + '<button id="editFindNext" class="icon-btn" title="下一个">\u2193</button>'
    + '<input id="editFindR" class="set-text" placeholder="替换为" spellcheck="false">'
    + '<button id="editFindOne"><span>替换</span></button>'
    + '<button id="editFindAll"><span>全部替换</span></button>'
    + '<button id="editFindClose" class="icon-btn" title="关闭">\u2715</button>';
  document.body.appendChild(bar);
  const on = (id, ev, fn) => { const el = bar.querySelector('#' + id); if (el) el.addEventListener(ev, fn); };
  on('editFindQ', 'input', () => { editFind.idx = 0; editFindRun(0); });
  on('editFindNext', 'click', () => editFindRun(1));
  on('editFindPrev', 'click', () => editFindRun(-1));
  on('editFindOne', 'click', () => editFindReplaceOne());
  on('editFindAll', 'click', () => editFindReplaceAll());
  on('editFindClose', 'click', () => closeEditFind());
  on('editFindQ', 'keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); editFindRun(e.shiftKey ? -1 : 1); } });
  on('editFindR', 'keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); editFindReplaceOne(); } });
}
function closeEditFind() { const b = $id('editFindBar'); if (b) b.hidden = true; const ed = $id('editor'); if (ed) ed.focus(); }
function openEditFind() {
  if (!S.editing) return;
  let b = $id('editFindBar');
  if (!b) { buildEditFindBar(); b = $id('editFindBar'); }
  b.hidden = false;
  const ed = $id('editor');
  const q = $id('editFindQ');
  if (!q) return;
  const sel = ed ? ed.value.slice(ed.selectionStart, ed.selectionEnd) : '';
  if (sel && !sel.includes('\n')) q.value = sel;   // 选中文本直接当查找词(编辑器惯例)
  q.focus();
  q.select();
  editFindRun(0);
}
/* dir=0 只重算计数;1/-1 跳下一个/上一个 */
function editFindRun(dir) {
  const ed = $id('editor');
  const q = $id('editFindQ');
  const cnt = $id('editFindCnt');
  if (!ed || !q) return;
  editFind.q = q.value;
  if (!editFind.q) { if (cnt) cnt.textContent = '0/0'; return; }
  const val = ed.value;
  const hits = [];
  let from = 0;
  for (;;) {
    const i = val.indexOf(editFind.q, from);
    if (i === -1) break;
    hits.push(i);
    from = i + editFind.q.length;
    if (hits.length > 5000) break;   // 兜底:极端情况不卡死
  }
  if (!hits.length) { if (cnt) cnt.textContent = '0/0'; return; }
  if (dir !== 0) {
    const cur = ed.selectionStart;
    let next;
    if (dir > 0) next = hits.find((h) => h > cur) ?? hits[0];
    else next = [...hits].reverse().find((h) => h < cur) ?? hits[hits.length - 1];
    editFind.idx = hits.indexOf(next);
    ed.focus();
    ed.setSelectionRange(next, next + editFind.q.length);
  }
  const at = hits[editFind.idx] != null ? editFind.idx : 0;
  if (cnt) cnt.textContent = (at + 1) + '/' + hits.length;
}
function editFindReplaceOne() {
  const ed = $id('editor');
  const r = $id('editFindR');
  if (!ed || !editFind.q) return;
  const cur = ed.value.slice(ed.selectionStart, ed.selectionEnd);
  if (cur !== editFind.q) { editFindRun(1); return; }   // 没选中命中项就先跳过去
  pushUndo(prevEditValue);
  ed.setRangeText(r ? r.value : '', ed.selectionStart, ed.selectionEnd, 'end');
  prevEditValue = ed.value;
  S.editDirty = true;
  renderTabs();
  editFindRun(1);
}
function editFindReplaceAll() {
  const ed = $id('editor');
  const r = $id('editFindR');
  if (!ed || !editFind.q) return;
  const val = ed.value;
  if (!val.includes(editFind.q)) { editFindRun(0); return; }
  const n = val.split(editFind.q).length - 1;
  pushUndo(prevEditValue);
  ed.value = val.split(editFind.q).join(r ? r.value : '');
  prevEditValue = ed.value;
  S.editDirty = true;
  renderTabs();
  toast(t('toast.replaced', { n }));
  editFindRun(0);
}

/* ==================== 打开文件(R7:统一进标签页) ==================== */
async function openExternal(abs) {
  await openTab({ abs, kind: 'ext' });
}
async function openInRoot(rel) {
  const root = S.root;
  if (!root || !root.scan || !root.rootPath) return toast(t('toast.needRoot'));
  const abs = root.rootPath.split('/').join('\\') + '\\' + rel.split('/').join('\\');
  await openTab({ abs, relPos: rel, rootPath: root.rootPath, kind: 'root' });
}

/* ==================== 标签页（R7：多 md 并存，浏览器式） ==================== */
// tab 描述符：{ abs, relPos?, rootPath?, raw?, draft?, editing?, editDirty? }；
// 持久化只留路径三元组（sr_tabs/sr_active_tab），内容重启重读，draft 不落盘。
// S.cur 恒指 active tab 的 live 文档，其余代码（保存/刷新/收藏/导读卡）零改动。
function persistTabs() {
  LS.set('sr_tabs', S.tabs.map((t) => ({ abs: t.abs, relPos: t.relPos || null, rootPath: t.rootPath || null })));
  LS.set('sr_active_tab', S.activeKey);
}
/* 路径比较统一走这里:后端(Tauri/notify)可能回反斜杠路径,而树/标签里是正斜杠拼的,
 * 直接 === 会静默不匹配(v1.7.0 的 watcher 就是这么死的)。只用于**比较**,不改存储值。 */
function normPath(p) { return String(p == null ? '' : p).replace(/\\/g, '/').toLowerCase(); }
function getTab(abs) { const k = normPath(abs); return S.tabs.find((t) => normPath(t.abs) === k); }
function stashTab() {
  rememberScroll();
  const t = getTab(S.activeKey);
  if (!t || !S.cur || normPath(S.cur.abs) !== normPath(t.abs)) return;
  t.raw = S.cur.raw;
  if (S.editing) { const ed = $id('editor'); t.draft = ed ? ed.value : null; t.editing = true; t.editDirty = S.editDirty; stashHist(); }
  else { t.draft = null; t.editing = false; t.editDirty = false; }
}
// R7：打开/切换串行化（连续双击/多文件拖拽/单实例连发/CDP 连发时渲染不交错）
let openChain = Promise.resolve();
function uiQueue(fn) { const p = openChain.then(fn); openChain = p.catch(() => {}); return p; }
function openTab(spec) { return uiQueue(() => openTabInner(spec)); }
function activateTab(t, opts) { return uiQueue(() => activateTabRaw(t, opts)); }
async function openTabInner(spec) {
  const abs = spec && spec.abs;
  if (!abs) return;
  let t = getTab(abs);
  if (!t) {
    t = { abs, relPos: spec.relPos || null, rootPath: spec.rootPath || null, raw: null, draft: null, editing: false, editDirty: false };
    S.tabs.push(t);
  } else if (spec.relPos) { t.relPos = spec.relPos; t.rootPath = spec.rootPath || t.rootPath; }
  const ok = await activateTabRaw(t, { recent: true, kind: spec.kind });
  if (ok && spec.kind === 'ext') await scanSiblingTree(abs);
}
/* 注意:参数名**不能叫 t** —— 全局 i18n 函数就叫 t,参数遮蔽后 `t('toast.x')` 会变成
 * "把 tab 对象当函数调"→ TypeError(2026-10-25 运行验证抓到:读文件失败这条提示一弹就炸)。 */
async function activateTabRaw(tab, opts) {
  opts = opts || {};
  if (tab.abs !== S.activeKey) {
    if (!(await confirmLeaveEdit())) return false;
    stashTab();
    leaveEdit();
  }
  S.activeKey = tab.abs;
  try {
    if (tab.raw == null || (tab.stale && !tab.editDirty)) {
      // raw==null:首次打开;stale:后台标签在磁盘上被改过(见 onFsChanged),
      // 且该标签没有未保存草稿时才敢覆盖 —— 有草稿就保留,避免顺手吃掉用户的字。
      tab.raw = tab.relPos
        ? await invoke('read_text', { root: tab.rootPath, rel: tab.relPos })
        : await invoke('open_path', { path: tab.abs });
      tab.stale = false;
    }
  } catch (e) {
    // 大文件这类"读不了"要给出路:提示可用系统默认程序打开(提示文案同样走字典)
    toast(t('toast.readFail') + trErr(e) + (trErrKey(e) === 'err.tooBig' ? t('toast.tooBigHint') : ''));
    S.tabs = S.tabs.filter((x) => x !== tab);
    if (S.activeKey === tab.abs) { S.activeKey = null; S.cur = null; renderEmpty(); }
    persistTabs();
    renderTabs();
    return false;
  }
  S.cur = { abs: tab.abs, raw: tab.raw };
  if (tab.relPos) { S.cur.relPos = tab.relPos; S.cur.rootPath = tab.rootPath; }
  renderMarkdown(tab.raw, tab.abs);
  if (tab.editing && tab.draft != null) {
    enterEdit();
    const ed = $id('editor');
    if (ed) { ed.value = tab.draft; prevEditValue = tab.draft; }
    S.editDirty = !!tab.editDirty;
    syncHistBtns();
  }
  if (opts.recent) pushRecent(tab.abs);
  markActive(tab.relPos || null);
  if (opts.kind) setView('toc');
  persistTabs();
  renderTabs();
  return true;
}
async function closeTab(abs) {
  const tab = getTab(abs);   // 局部名不叫 t:i18n 的 t() 会被遮蔽(见 activateTabRaw 的注释)
  if (!tab) return;
  const isActive = normPath(S.activeKey) === normPath(abs);
  const dirty = isActive ? (S.editing && S.editDirty) : !!tab.editDirty;
  if (dirty) {
    if (isActive) {
      if (!(await confirmLeaveEdit())) return;
    } else {
      const a = await askUnsaved();
      if (a === 'cancel') return;
      if (a === 'save') {
        const content = tab.draft != null ? tab.draft : tab.raw;
        try {
          const r = await writeTabContent(tab, content, false);
          // 后台标签不做"覆盖"确认(弹窗里没有上下文):冲突时保守拦下,让用户切过去处理
          if (r !== 'ok') { toast(t('conflict.title')); return; }
        } catch (e) { toast(t('toast.saveFail') + trErr(e)); return; }
      }
    }
  }
  if (isActive) { stashTab(); leaveEdit(); }
  const idx = S.tabs.indexOf(tab);
  if (idx < 0) return;   // 弹窗是异步的:等待期间用户可能已经关掉这个标签,indexOf=-1 会误删最后一个无关标签
  S.tabs.splice(idx, 1);
  LS.del('sr_scr_' + abs);
  if (isActive) {
    const next = S.tabs[Math.min(idx, S.tabs.length - 1)];
    if (next) activateTab(next, {});
    else { S.activeKey = null; S.cur = null; renderEmpty(); }
  }
  persistTabs();
  renderTabs();
}
function cycleTab(dir) {
  if (S.tabs.length < 2) return;
  const i = S.tabs.findIndex((t) => t.abs === S.activeKey);
  const n = S.tabs[(i + dir + S.tabs.length) % S.tabs.length];
  if (n) activateTab(n, {});
}
function renderEmpty() {
  S.cur = null;
  S.toc = [];
  leaveEdit();
  const inner = $id('readerInner');
  if (inner) {
    inner.hidden = false;
    inner.innerHTML = '<div class="empty" id="readerEmpty"><h2>还没有打开任何文档</h2><p>轻量本地 Markdown 阅读器</p><p class="empty-actions"><button type="button" id="emptyOpenFolder">打开文件夹</button> <button type="button" id="emptyOpenFile">打开文件</button></p><p class="empty-hint">也可以把 .md 文件拖进窗口。</p></div>';
    $id('emptyOpenFolder')?.addEventListener('click', onOpenFolder);
    $id('emptyOpenFile')?.addEventListener('click', pickOpenFile);
  }
  document.title = 'TMMD';
  markActive(null);
  try { applyI18n(); } catch { /* v1.7:空态重建后重贴语言 */ }
  if (S.view === 'toc' || S.view === 'map') renderSide();
}
function renderTabs() {
  const bar = $id('tabBar');
  if (!bar) return;
  bar.hidden = S.tabs.length === 0;
  bar.innerHTML = '';
  S.tabs.forEach((t) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tab' + (t.abs === S.activeKey ? ' active' : '');
    b.title = t.abs;
    const nm = document.createElement('span');
    nm.className = 'tab-name';
    nm.textContent = fileName(t.abs);
    b.appendChild(nm);
    const dirty = (t.abs === S.activeKey) ? (S.editing && S.editDirty) : !!t.editDirty;
    if (dirty) {
      const d = document.createElement('span');
      d.className = 'tab-dirty';
      d.textContent = '•';
      b.appendChild(d);
    }
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'tab-x';
    x.title = '关闭标签页';
    x.setAttribute('aria-label', '关闭' + fileName(t.abs));
    x.innerHTML = '<svg class="ic"><use href="#i-close"/></svg>';
    x.addEventListener('click', (e) => { e.stopPropagation(); closeTab(t.abs); });
    b.appendChild(x);
    b.addEventListener('click', () => { if (t.abs !== S.activeKey) activateTab(t, {}); });
    bar.appendChild(b);
  });
  const act = bar.querySelector('.tab.active');
  if (act && act.scrollIntoView) act.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  if (typeof layoutToolbar === 'function') layoutToolbar();   // R7b：标签占宽变化后重排工具栏溢出
}
async function restoreTabs() {
  renderTabs();
  if (!S.tabs.length || !invoke) return;
  let target = getTab(S.activeKey) || S.tabs[0];
  for (;;) {
    if (!target) { S.activeKey = null; S.cur = null; renderEmpty(); break; }
    try {
      target.raw = target.relPos
        ? await invoke('read_text', { root: target.rootPath, rel: target.relPos })
        : await invoke('open_path', { path: target.abs });
      await activateTab(target, {});
      break;
    } catch { S.tabs = S.tabs.filter((x) => x !== target); target = S.tabs[0]; }
  }
  persistTabs();
  renderTabs();
}
function fileName(p) { return p.split(/[\\/]/).pop(); }
function pushRecent(abs) {
  S.recent = S.recent.filter((r) => r !== abs);
  S.recent.unshift(abs);
  if (S.recent.length > 40) S.recent.length = 40;
  LS.set('sr_recent', S.recent);
  renderRecent();
}

/// 打开文件后扫描所在目录，在文件树里显示同目录全部 .md（用后端 list_md_tree）
async function scanSiblingTree(abs) {
  if (!invoke) return;
  const dir = abs.split(/[\\/]/).slice(0, -1).join('\\');
  try {
    const scan = await invoke('list_md_tree', { root: dir });
    S.root = { scan, rootPath: dir, name: dir.split(/[\\/]/).pop() || dir };
  } catch { /* 静默：目录无权或不存在，树保持现状 */ }
}

/* ==================== 收藏 ==================== */
function isFavorited(abs) { return S.favorites.includes(abs); }
function toggleFavorite(abs, btnEl) {
  if (isFavorited(abs)) {
    S.favorites = S.favorites.filter((f) => f !== abs);
    toast(t('toast.unfav'));
  } else {
    S.favorites = S.favorites.filter((f) => f !== abs);
    S.favorites.unshift(abs);
    if (S.favorites.length > 200) S.favorites.length = 200;
    toast(t('toast.fav'));
  }
  LS.set('sr_favorites', S.favorites);
  if (btnEl) renderFavDocBtn(btnEl);
  else refreshFavDocBtn();
}
function renderFavDocBtn(btn) {
  if (!btn) return;
  const fav = S.cur ? isFavorited(S.cur.abs) : false;
  const lab = btn.querySelector('span');
  if (lab) lab.textContent = fav ? '已收藏' : '收藏本文';
  const u = btn.querySelector('use');
  if (u) u.setAttribute('href', fav ? '#i-star-fill' : '#i-star');
  btn.classList.toggle('active', fav);
  btn.title = fav ? '取消收藏本文' : '收藏本文';
}
function refreshFavDocBtn() {
  const btn = $id('btnFavDoc');
  if (!btn) return;
  btn.disabled = !S.cur;
  renderFavDocBtn(btn);
  const rf = $id('btnRefresh'); if (rf) rf.disabled = !S.cur;
  const ed = $id('btnEdit'); if (ed) ed.disabled = !S.cur;
  // 编辑第二批:另存为任何时候只要打开着文档就能用;重命名/删除只对"库内文件"开放(库外不支持)
  const inRoot = !!(S.cur && getTab(S.cur.abs) && getTab(S.cur.abs).relPos);
  const sa = $id('btnSaveAs'); if (sa) sa.disabled = !S.cur;
  const rn = $id('btnRenameDoc'); if (rn) rn.disabled = !inRoot;
  const dl = $id('btnDeleteDoc'); if (dl) dl.disabled = !inRoot;
}

/* ==================== 侧栏 ==================== */
function renderSide() {
  const side = $id('sideBody');
  side.innerHTML = '';
  $id('sideEmpty').hidden = true;
  $id('btnBackToTree').hidden = (S.view !== 'toc' && S.view !== 'map' && S.view !== 'search');
  if (S.view === 'toc') { renderToc(side); return; }
  if (S.view === 'map') { renderMap(side); return; }
  if (S.view === 'search') { renderSearch(side); return; }
  renderTree(side);
}
function renderTree(side) {
  if (!S.root) { $id('sideEmpty').hidden = false; return; }
  const t = document.createElement('div');
  t.className = 'side-title'; t.textContent = S.root.name || '…';
  side.appendChild(t);
  const tree = document.createElement('div');
  tree.className = 'tree';
  (S.root.scan && S.root.scan.tree ? S.root.scan.tree : []).forEach((n) => tree.appendChild(treeItem(n, 0)));
  side.appendChild(tree);
  if (S.cur) markActive(S.cur.relPos);
}
function treeItem(node, depth) {
  const wrap = document.createElement('div');
  wrap.className = 'tree-node';
  const isDir = node.type === 'dir';
  const it = document.createElement('div');
  it.className = 'tree-item ' + (isDir ? 'dir' : 'file');
  it.style.paddingLeft = (6 + depth * 17) + 'px';
  it.innerHTML = '<span class="caret"></span><span class="name"></span>';
  it.querySelector('.name').textContent = node.name;
  it.dataset.rel = node.path; it.dataset.kind = node.type;
  if (isDir) it.querySelector('.caret').textContent = '▾';
  it.onclick = () => {
    if (isDir) {
      const box = wrap.querySelector(':scope > .tree-indent');
      if (box) { box.hidden = !box.hidden; it.querySelector('.caret').textContent = box.hidden ? '▸' : '▾'; }
    } else openInRoot(node.path);
  };
  wrap.appendChild(it);
  if (isDir && Array.isArray(node.children) && node.children.length) {
    const box = document.createElement('div');
    box.className = 'tree-indent';
    node.children.forEach((c) => box.appendChild(treeItem(c, depth + 1)));
    wrap.appendChild(box);
  }
  return wrap;
}
function markActive(rel) {
  $qa('#side .file').forEach((f) => f.classList.remove('active'));
  const el = $qa('#side .file').find((f) => f.dataset.rel === rel);
  if (el) el.classList.add('active');
}
function renderToc(side) {
  if (!S.toc.length) { side.innerHTML = '<div class="side-empty">本文没有标题大纲</div>'; return; }
  const t = document.createElement('div');
  t.className = 'side-title'; t.textContent = '目录';
  side.appendChild(t);
  const list = document.createElement('div');
  list.className = 'tree';
  S.toc.forEach((h) => {
    const it = document.createElement('div');
    it.className = 'tree-item toc';
    it.style.paddingLeft = (10 + (h.level - 1) * 14) + 'px';
    it.dataset.tocId = h.id;
    it.dataset.level = h.level;
    it.textContent = h.text;
    it.onclick = () => { const el = document.getElementById(h.id); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
    list.appendChild(it);
  });
  side.appendChild(list);
}
const VIEW_BTNS = ['btnTree', 'btnToc', 'btnMap', 'btnFindLib'];
function setView(v) {
  S.view = v;
  VIEW_BTNS.forEach((id) => { const b = $id(id); if (b) b.classList.toggle('active', id === ({ tree: 'btnTree', toc: 'btnToc', map: 'btnMap', search: 'btnFindLib' }[v])); });
  renderSide();
}

/* ---- 大纲高亮：滚动时标记当前可见区域最顶的标题 ---- */
function highlightCurrentToc() {
  if (S.view === 'map') { updateMapHighlight(); return; }
  if (S.view !== 'toc' || !S.toc.length) return;
  const reader = $id('reader');
  const y = reader.scrollTop + 30;
  let cur = null;
  for (const h of S.toc) {
    const el = document.getElementById(h.id);
    if (!el) continue;
    if (el.offsetTop <= y) cur = h;
    else break;
  }
  $qa('#side .toc').forEach((it) => it.classList.remove('toc-active'));
  if (!cur) return;
  const act = $q('#side .toc[data-toc-id="' + CSS.escape(cur.id) + '"]');
  if (act) { act.classList.add('toc-active'); act.scrollIntoView({ block: 'nearest' }); }
}

/* ==================== 导读地图 + AI 章节卡（v1.3.0） ==================== */

/* 章节集合 = 深度 ≤2 的标题；无二级标题时降级用 h1 */
function chapterList() {
  const h2 = S.toc.filter((h) => h.level === 2);
  if (h2.length) return h2;
  return S.toc.filter((h) => h.level === 1);
}

/* 取某一章的正文纯文本（标题到下一个同级标题之间） */
function chapterText(idx) {
  const chs = chapterList();
  const h = chs[idx];
  if (!h) return '';
  const el = document.getElementById(h.id);
  if (!el) return '';
  let txt = h.text + '\n';
  for (let n = el.nextElementSibling; n; n = n.nextElementSibling) {
    if (/^H[1-3]$/.test(n.tagName) && +n.tagName[1] <= h.level) break;
    if (!/^(H4|H5|H6)$/.test(n.tagName)) txt += n.textContent + '\n';
    else txt += n.textContent + '\n';
  }
  return txt.slice(0, 6000);
}

/* ---- 导读地图视图 ---- */
function renderMap(side) {
  const chs = chapterList();
  if (!chs.length) { side.innerHTML = '<div class="map-empty">本文没有可用章节标题，无法生成地图。</div>'; return; }
  const total = chs.length;
  // 每章字数（粗略）
  const lens = chs.map((c, i) => chapterText(i).length);
  const doneIdx = currentChapterIndex();
  const head = document.createElement('div');
  head.className = 'map-head';
  head.innerHTML =
    '<div class="map-title">导读地图</div>' +
    '<div class="map-prog"><div class="map-prog-fill" id="mapProgFill"></div></div>' +
    '<div class="map-prog-text" id="mapProgText"></div>';
  side.appendChild(head);
  const list = document.createElement('div');
  list.className = 'map-list';
  chs.forEach((h, i) => {
    const n = document.createElement('div');
    n.className = 'map-node';
    n.dataset.ch = String(i);
    n.innerHTML =
      '<div class="map-dot">' + (i + 1) + '</div>' +
      '<div class="map-meta"><div class="map-name"></div>' +
      '<div class="map-sub"><span>约 ' + Math.max(1, Math.round(lens[i] / 400)) + ' 分钟</span></div></div>';
    n.querySelector('.map-name').textContent = h.text;
    n.addEventListener('click', () => {
      const el = document.getElementById(h.id);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    list.appendChild(n);
  });
  side.appendChild(list);
  updateMapHighlight();
}

function currentChapterIndex() {
  const chs = chapterList();
  if (!chs.length) return -1;
  const reader = $id('reader');
  const y = reader.scrollTop + 40;
  let cur = -1;
  chs.forEach((h, i) => {
    const el = document.getElementById(h.id);
    if (el && el.offsetTop <= y) cur = i;
  });
  return cur;
}
function updateMapHighlight() {
  if (S.view !== 'map') return;
  const cur = currentChapterIndex();
  $qa('#side .map-node').forEach((n) => {
    const i = +n.dataset.ch;
    n.classList.toggle('now', i === cur);
    n.classList.toggle('done', cur > i);
  });
  const chs = chapterList();
  const fill = $id('mapProgFill');
  const txt = $id('mapProgText');
  const reader = $id('reader');
  const pct = reader.scrollHeight > reader.clientHeight
    ? Math.min(100, Math.round((reader.scrollTop + reader.clientHeight) / reader.scrollHeight * 100))
    : 100;
  if (fill) fill.style.width = pct + '%';
  if (txt) txt.textContent = '第 ' + (cur + 1) + ' / ' + chs.length + ' 章 · 已读约 ' + pct + '%';
}
/* ==================== 下拉抽屉（文件/编辑/视图/文档/更多） ==================== */
let drawerOpen = null; // 当前打开的抽屉 id
function openDrawer(id, btn) {
  const d = $id(id);
  if (!d) return;
  if (drawerOpen === id) { closeDrawers(); return; }
  closeDrawers();
  const r = btn.getBoundingClientRect();
  d.hidden = false;
  d.style.left = Math.max(4, Math.min(r.left, window.innerWidth - d.offsetWidth - 8)) + 'px';
  d.style.top = (r.bottom + 2) + 'px';
  drawerOpen = id;
  btn.classList.add('active');
  if (id === 'menuDoc') renderDocDrawer();
}
function closeDrawers() {
  if (!drawerOpen) return;
  $id(drawerOpen).hidden = true;
  const t = $q('[data-drawer].active');
  if (t) t.classList.remove('active');
  drawerOpen = null;
}
function drawerFileRow(abs, isFav) {
  const row = document.createElement('div');
  row.className = 'drawer-item';
  row.dataset.abs = abs; // R12c(e)：右键菜单定位用
  const nm = document.createElement('span'); nm.className = 'name'; nm.textContent = fileName(abs); nm.title = abs;
  const meta = document.createElement('span'); meta.className = 'meta';
  meta.textContent = abs.split(/[\\/]/).slice(-2, -1)[0] || '';
  const del = document.createElement('span'); del.className = 'del'; del.textContent = '✕';
  del.title = '移除';
  del.onclick = (ev) => {
    ev.stopPropagation();
    if (isFav) { S.favorites = S.favorites.filter((f) => f !== abs); LS.set('sr_favorites', S.favorites); refreshFavDocBtn(); }
    else { S.recent = S.recent.filter((r) => r !== abs); LS.set('sr_recent', S.recent); }
    renderDocDrawer();
  };
  row.onclick = () => { closeDrawers(); openExternal(abs); };
  row.append(nm, meta, del);
  return row;
}
function renderDocDrawer() {
  const rec = $id('docRecent'); const fav = $id('docFavs');
  if (!rec || !fav) return;
  rec.innerHTML = ''; fav.innerHTML = '';
  if (!S.recent.length) rec.innerHTML = '<div class="drawer-empty">暂无</div>';
  else S.recent.slice(0, 8).forEach((a) => rec.appendChild(drawerFileRow(a, false)));
  const favs = S.favorites.slice(0, 8);
  if (!favs.length) fav.innerHTML = '<div class="drawer-empty">暂无</div>';
  else favs.forEach((a) => fav.appendChild(drawerFileRow(a, true)));
}
/* R12c(e)：右键菜单（单例 #ctxMenu；项复用 .menu-item 样式，onclick 自关+阻冒泡，不碰抽屉路由） */
function closeCtxMenu() { const m = $id('ctxMenu'); if (m) m.hidden = true; }
function showCtxMenu(x, y, items) {
  const m = $id('ctxMenu');
  if (!m || !items || !items.length) return;
  m.innerHTML = '';
  items.forEach((it) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'menu-item';
    b.disabled = !!it.disabled;
    const nm = document.createElement('span'); nm.textContent = it.label;
    b.appendChild(nm);
    b.onclick = (ev) => { ev.stopPropagation(); closeCtxMenu(); if (typeof it.fn === 'function') it.fn(); };
    m.appendChild(b);
  });
  m.hidden = false;
  m.style.left = Math.max(4, Math.min(x, window.innerWidth - m.offsetWidth - 8)) + 'px';
  m.style.top = Math.max(4, Math.min(y, window.innerHeight - m.offsetHeight - 8)) + 'px';
}
// 由绝对路径拼所在 root 的 rel（openInRoot 要 rel；拼法与 openInRoot 的 abs 互逆）
function relOfAbs(abs) {
  const rootPath = S.root && S.root.rootPath ? S.root.rootPath : null;
  if (!rootPath) return null;
  const rp = rootPath.split('/').join('\\').replace(/\\+$/, '');
  const ap = abs.split('/').join('\\');
  if (ap.toLowerCase().indexOf(rp.toLowerCase() + '\\') !== 0) return null;
  return ap.slice(rp.length + 1).split('\\').join('/');
}
function absOfRel(rel) {
  const rootPath = S.root && S.root.rootPath ? S.root.rootPath : null;
  if (!rootPath) return null;
  return rootPath.split('/').join('\\') + '\\' + String(rel).split('/').join('\\');
}

/* ==================== 工具栏双模式 + 溢出进 ⋮ 抽屉 ==================== */
/* 2026-10-25 用户实拍:窗口 1502px 很宽,工具栏却一直折叠着(主题/设置/玻璃缩在 ⋮ 里)。
 * 根因(实测复现):旧判据是"栏内各项宽 + 每项 5px ≤ #actions 的 clientWidth",而 #actions 是
 *   `flex: 0 1 auto; min-width: 148px` —— **宽度等于自己的内容宽**,拿它对内容求和是自指:
 *   ① 每项多算一个 5px(gap 只在项与项之间,N 项只有 N−1 个 gap)⇒ 落进 min-width 后恒为真;
 *   ② 折叠会让容器跟着变窄 ⇒ "放不下"永远成立 ⇒ **折进去就再也回不来**(用户看到的正是这个)。
 * 新判据:整条顶栏的**自然宽度** ≤ 顶栏可用宽度(全部可见项按真实尺寸 + gap 求和,减去顶栏 padding)。
 * 按钮折进抽屉后 offsetWidth = 0,自然宽走缓存 TB_W;切模式(图标↔文字)按钮宽会变 ⇒ 缓存作废并先全部归位再量。 */
let TB_W = new WeakMap();
function tbNatural(el) {
  const w = el.offsetWidth;
  if (w > 0) TB_W.set(el, w);                 // 只在可见时才能量到真尺寸
  return w > 0 ? w : (TB_W.get(el) || 34);    // 34 ≈ 图标模式按钮宽,仅当它从没在可见态被量过
}
function tbGap(el) { return parseFloat(getComputedStyle(el).columnGap) || 0; }
function tbBarWidth() {
  const bar = $id('actions'), moreBtn = $id('tbMore');
  if (!bar) return 0;
  let w = 0, n = 0;
  for (const c of bar.children) {
    if (c === moreBtn || c.hidden || getComputedStyle(c).display === 'none') continue;
    w += tbNatural(c); n++;
  }
  return n ? w + tbGap(bar) * (n - 1) : 0;
}
function tbFits(extra) {
  const bar = $id('actions'), moreBtn = $id('tbMore'), top = bar && bar.parentElement;
  if (!bar || !top) return true;
  let w = 0, n = 0;
  for (const c of top.children) {
    if (c === moreBtn || c.hidden || getComputedStyle(c).display === 'none') continue;
    // 非工具栏项用 max(offsetWidth, scrollWidth):标签栏被 flex 压窄后 offsetWidth 是压窄值,
    // 拿它求和会**低估**需求 ⇒ 折叠来得太晚,按钮会溢出压到品牌字上。
    w += (c === bar ? tbBarWidth() : Math.max(c.offsetWidth, c.scrollWidth || 0)); n++;
  }
  if (extra) { w += tbNatural(extra) + tbGap(bar); n++; }   // 归还一个:栏内多一个项、多一个 gap
  const topCS = getComputedStyle(top);
  const pad = (parseFloat(topCS.paddingLeft) || 0) + (parseFloat(topCS.paddingRight) || 0);
  const need = n ? w + tbGap(top) * (n - 1) : 0;
  return need <= top.clientWidth - pad - 2;                 // 2px 余量:防缩放/取整在边界抖动
}
function applyToolbarMode() {
  document.body.classList.toggle('tb-icon', S.toolbarMode === 'icon');
  document.body.classList.toggle('tb-text', S.toolbarMode === 'text');
  const bi = $id('setTbIcon'); if (bi) bi.classList.toggle('active', S.toolbarMode === 'icon');
  const bt = $id('setTbText'); if (bt) bt.classList.toggle('active', S.toolbarMode === 'text');
  // 按钮宽随模式变(图标 30 / 文字更宽):缓存作废,且**先全部归位**——折在抽屉里量不到真宽度
  TB_W = new WeakMap();
  const bar = $id('actions'), moreBtn = $id('tbMore'), box = $id('docMore');
  if (bar && moreBtn && box) while (box.firstElementChild) bar.insertBefore(box.firstElementChild, moreBtn);
  layoutToolbar();
}
function layoutToolbar() {
  const bar = $id('actions');
  const moreBtn = $id('tbMore');
  const box = $id('docMore');
  if (!bar || !moreBtn || !box) return;
  for (const c of bar.children) if (c !== moreBtn) tbNatural(c);   // 先把可见项量下来
  // 归还:空间足够时按序把溢出按钮移回 ⋮ 前
  let guard = 0;
  while (box.firstElementChild && tbFits(box.firstElementChild) && guard++ < 20) bar.insertBefore(box.firstElementChild, moreBtn);
  // 溢出:从右往左把放不下的按钮挪进 ⋮ 抽屉(prepend 保持原顺序)
  guard = 0;
  while (!tbFits(null) && guard++ < 20) {
    const els = Array.from(bar.children).filter((c) => c.dataset && c.dataset.overflow === '1');
    if (!els.length) break;
    box.prepend(els[els.length - 1]);
  }
  moreBtn.hidden = !box.children.length;
  if (drawerOpen === 'menuMore' && !box.children.length) closeDrawers();
}

/* ==================== 打字机模式(2026-10-25,v1.8 队列) ====================
 * 阅读侧的"其余淡出"已由专注模式覆盖;这里补**编辑侧**:打字时让光标所在行停在视口
 * 偏上位置(经典打字机滚动),省得写到屏幕底部才回滚一次。
 * 实现要点:textarea 无法只给某一行加样式,所以只做"滚动跟随 + 平滑";
 * 行高靠计算样式读,不写死(字号/行高都可调)。 */
function typewriterLineHeight(ed) {
  const cs = getComputedStyle(ed);
  const lh = parseFloat(cs.lineHeight);
  if (Number.isFinite(lh) && lh > 0) return lh;
  const fs = parseFloat(cs.fontSize) || 14;
  return fs * 1.7;
}
function typewriterFollow() {
  if (!S.editorTypewriter || !S.editing) return;
  const ed = $id('editor');
  if (!ed || ed.hidden) return;
  const lh = typewriterLineHeight(ed);
  const before = ed.value.slice(0, ed.selectionStart || 0);
  const line = before.split('\n').length - 1;             // 0 基行号
  const caretY = (line + 0.5) * lh;
  const want = caretY - ed.clientHeight * 0.38;           // 目标:光标行落在 38% 高度处
  const max = Math.max(0, ed.scrollHeight - ed.clientHeight);
  const target = Math.max(0, Math.min(max, want));
  if (Math.abs(target - ed.scrollTop) < lh * 0.5) return; // 小抖动不动,避免逐字抖屏
  ed.scrollTop = target;
}
function applyTypewriter(on) {
  S.editorTypewriter = !!on;
  LS.set('sr_typewriter', S.editorTypewriter ? '1' : '0');
  document.body.classList.toggle('typewriter', S.editorTypewriter);
  const b = $id('setTypewriterOn');
  const b2 = $id('setTypewriterOff');
  b?.classList.toggle('active', S.editorTypewriter);
  b2?.classList.toggle('active', !S.editorTypewriter);
  if (S.editorTypewriter) typewriterFollow();
}

/* ==================== 自研更新器(2026-10-25,用户定调:程序内部自己更新) ====================
 * 后端命令:update_check / update_download / update_install / update_note。
 * 这里只负责"问一句 + 显示进度 + 放行关窗";信任链(SHA-256、URL 前缀)全在后端。 */
function setUpdateStatus(s) {
  const el = $id('updState');
  if (el) el.textContent = s;
}
async function checkUpdate(force) {
  if (!invoke) return null;
  setUpdateStatus(t('upd.checking'));
  try {
    const m = await invoke('update_check', { force: !!force });
    if (!m) { setUpdateStatus(t('upd.latest')); return null; }
    setUpdateStatus(t('upd.available', { v: m.version }));
    return m;
  } catch (e) {
    setUpdateStatus(t('upd.fail') + trErr(e));
    return null;
  }
}
async function runUpdate(m) {
  let off = null;
  setUpdateStatus(t('upd.downloading', { p: 0 }));
  try {
    if (listen) {
      off = await listen('update-progress', (e) => {
        const p = (e && e.payload) || {};
        const pct = p.total ? Math.min(100, Math.round((p.received / p.total) * 100)) : 0;
        setUpdateStatus(t('upd.downloading', { p: pct }));
      });
    }
  } catch { off = null; }
  try {
    const path = await invoke('update_download', { manifest: m });
    setUpdateStatus(t('upd.installing'));
    await invoke('update_install', { path });
    toast(t('upd.byebye'));
    setTimeout(() => { invoke('allow_close').catch(() => {}); }, 700);
  } catch (e) {
    const msg = trErr(e);
    setUpdateStatus(t('upd.fail') + msg);
    toast(t('upd.fail') + msg);
  } finally {
    if (off) { try { off(); } catch { /* 解绑失败忽略 */ } }
  }
}
async function promptUpdate(m) {
  const mb = (Number(m.size || 0) / 1048576).toFixed(1);
  const r = await openDialog({
    title: t('upd.title', { v: m.version }),
    sub: t('upd.sub', { size: mb }) + (m.notes ? '\n\n' + m.notes : ''),
    primary: 'install',
    buttons: [
      { label: t('upd.install'), a: 'install', primary: true },
      { label: t('upd.later'), a: 'later' },
      { label: t('upd.skip'), a: 'skip' },
    ],
  });
  if (r.action === 'later' || r.action === 'skip') {
    invoke('update_note', { version: m.version, action: r.action }).catch(() => {});
    setUpdateStatus(r.action === 'skip' ? t('upd.latest') : t('upd.available', { v: m.version }));
    return;
  }
  if (r.action === 'install') await runUpdate(m);
}
/* 启动后台检查:不抢流程,4 秒后静默问一次;有新版才提示。 */
function scheduleUpdateCheck() {
  if (!invoke) return;
  setTimeout(async () => {
    const m = await checkUpdate(false);
    if (m) toast(t('upd.available', { v: m.version }));
  }, 4000);
}
/* 更新器:文案与状态自检(供 e2e 与肉眼核对,不改状态) */
function updateDebugInfo() {
  return { hasRow: !!$id('updState'), statusText: $id('updState') ? $id('updState').textContent : null };
}

/* 后端错误串是中文(命令层直接返回人话)。这里做一层**常见前缀**映射,让 EN/JA 界面不至于
 * 夹一整句中文;未命中的原样返回 —— 宁可露出中文,也不能把错误信息吞掉或改写成语义不同的句子。
 *
 * 约定(2026-10-25 复查后统一):**规则要么整句吃掉(`.*$`),要么只吃"中文那一段"**;
 * 绝不允许"吃一半留一半"——那会拼出 "Path is outside the registered folders:不在已登记库内"
 * 这种中英混句,比不翻译更难看。所以 `src-tauri/src/lib.rs` 里凡是被前缀规则命中的消息,
 * 其后半段只能是**数据**(路径 / OS 错误 / 数字),不能再留中文说明(说明都搬进下面的字典)。
 * r12f 的 E11 会把 lib.rs 里全部命令层中文错误串喂进来逐条验证,漏一条就红。 */
const ERR_MAP = [
  // —— 路径 / 文档 ——
  [/^路径非法.*$/, 'err.badPath'],
  [/^路径越界.*$/, 'err.outOfCage'],
  [/^不是目录: /, 'err.notDir'],
  [/^目录不存在: /, 'err.noDir'],
  [/^不是文件/, 'err.notFile'],
  [/^仅支持 \.html \/ \.htm 文件$/, 'err.onlyHtml'],
  [/^仅支持.*文件$/, 'err.onlyExt'],
  [/^文件过大.*$/, 'err.tooBig'],
  [/^内容过大.*$/, 'err.tooBig'],
  [/^读文件失败: |^读取失败: |^无法读取文件: /, 'err.read'],
  [/^写临时文件失败/, 'err.writeTmp'],
  [/^替换文件失败/, 'err.replace'],
  [/^重命名失败: /, 'err.rename'],
  [/^源文件不存在: /, 'err.srcMissing'],
  [/^目标已存在: |^已存在同名文件: /, 'err.exists'],
  [/^创建目录失败: /, 'err.mkdir'],
  [/^移入回收站失败/, 'err.recycle'],
  [/^移入回收站被中断$/, 'err.recycleAbort'],
  [/^当前平台未实现回收站删除$/, 'err.recycleUnsupported'],
  // —— 导出 / 打开 / 浏览器 ——
  [/^导出 HTML 不存在/, 'err.exportHtmlMissing'],
  [/^导出失败: /, 'err.export'],
  [/^打开失败: /, 'err.open'],
  [/^找不到 Chromium 内核浏览器.*$/, 'err.noBrowser'],
  [/^起无头浏览器失败: /, 'err.browserSpawn'],
  [/^PDF 未生成/, 'err.pdfFailed'],
  // —— 窗口 / 材质 ——
  [/^找不到主窗口$/, 'err.noWindow'],
  [/^关窗失败: /, 'err.closeFail'],
  [/^玻璃材质仅 Windows 支持$|^仅 Windows 支持$/, 'err.winOnly'],
  [/^未知探针: /, 'err.unknownProbe'],
  [/^读 backdrop 失败: /, 'err.backdropFail'],
  // —— 监听 / 材质 / 系统集成 ——
  [/^监听锁失败: |^创建监听失败: |^监听目录失败: /, 'err.watch'],
  [/^写安装脚本失败: /, 'err.installScript'],
  [/^起安装脚本失败: /, 'err.installSpawn'],
  [/^打开默认应用设置失败: /, 'err.openSettings'],
  [/^读默认打开方式失败: /, 'err.readAssoc'],
  [/^取 HWND 失败: /, 'err.noHwnd'],
  [/^材质记忆锁失败: /, 'err.glassLock'],
  [/^玻璃应用失败: /, 'err.glassApply'],
  // —— 更新链 ——
  [/^取更新清单失败: |^读更新清单失败: |^更新清单无效: /, 'err.manifest'],
  [/^更新清单里的 sha256 不合法$/, 'err.manifestSha'],
  [/^更新包来源不可信/, 'err.untrusted'],
  [/^更新包体积异常$/, 'err.badSize'],
  [/^更新包不存在: /, 'err.pkgMissing'],
  [/^建更新目录失败: /, 'err.updDir'],
  [/^下载失败: |^读下载流失败: |^建临时文件失败: /, 'err.download'],
  [/^写盘失败: /, 'err.write'],
  [/^落位失败: /, 'err.moveFail'],
  [/^校验失败/, 'err.sha'],
  [/^写文件失败|^保存失败/, 'err.write'],
  [/^删除失败/, 'err.delete'],
];
/* 细节层:命令层的错误串常带 Windows 的中文系统消息(拒绝访问 / 找不到文件 / 被占用),
 * EN/JA 界面里这几句也得翻,否则"前缀英文 + 后半句中文"更难看。未命中的原样露出 —— 不吞信息。 */
const ERR_TAIL_MAP = [
  [/拒绝访问/g, 'err.tailDenied'],
  [/系统找不到指定的文件。/g, 'err.tailNoFile'],
  [/系统找不到指定的路径。/g, 'err.tailNoPath'],
  [/另一个程序正在使用此文件/g, 'err.tailBusy'],
  [/文件名、目录名或卷标语法不正确。/g, 'err.tailBadName'],
  [/浏览器退出码/g, 'err.tailExitCode'],
  [/可改用「打印 \/ 存 PDF」手动另存/g, 'err.tailUsePrint'],
  [/期望\s*/g, 'err.tailExpected'],
  [/实际\s*/g, 'err.tailActual'],
];
function trErr(e) {
  let msg = String((e && e.message) || e || '');
  for (const [re, key] of ERR_MAP) {
    if (re.test(msg)) { msg = t(key) + msg.replace(re, ''); break; }
  }
  for (const [re, key] of ERR_TAIL_MAP) msg = msg.replace(re, t(key));
  return msg;
}
/** 命中的映射键(没命中返回 '')。用于"某一类错误要额外补一句可操作提示"的场景:
 * 提示文案本身也要走字典,否则 EN/JA 界面又会夹中文。 */
function trErrKey(e) {
  const msg = String((e && e.message) || e || '');
  for (const [re, key] of ERR_MAP) if (re.test(msg)) return key;
  return '';
}

/* ==================== 拖放(Tauri webview 事件拿磁盘路径) ==================== */
/* 可打开/可编辑的扩展名(前端唯一真源,必须与后端 DOC_EXTS + TEXT_EXTS 一致:
 * lib.rs 的 is_openable)。拖放、文件对话框、树过滤都走它,避免"树里有、点开报错"。 */
const DOC_EXT_RE = /\.(md|markdown|mdx|txt|html|htm)$/i;

function bindDragDrop() {
  if (wview && typeof wview.onDragDropEvent === 'function') {
    let depth = 0;
    wview.onDragDropEvent((ev) => {
      const p = ev && ev.payload;
      if (!p) return;
      if (p.type === 'enter' || p.type === 'over') { depth++; document.body.classList.add('dragover'); }
      else if (p.type === 'leave') { if (--depth <= 0) { depth = 0; document.body.classList.remove('dragover'); } }
      else if (p.type === 'drop') {
        depth = 0; document.body.classList.remove('dragover');
        const paths = (p.paths || []).filter((x) => DOC_EXT_RE.test(x));
        (async () => { for (const ph of paths) await openExternal(ph); })();   // R7：多文件依次进标签页
      }
    });
    return;
  }
  let depth2 = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); depth2++; document.body.classList.add('dragover'); });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('dragleave', () => { if (--depth2 <= 0) { depth2 = 0; document.body.classList.remove('dragover'); } });
  window.addEventListener('drop', (e) => {
    e.preventDefault(); depth2 = 0; document.body.classList.remove('dragover');
    Array.from(e.dataTransfer.files || [])
      .filter((f) => DOC_EXT_RE.test(f.name))
      .forEach((f) => { const r = new FileReader(); r.onload = () => renderMarkdown(String(r.result), f.name); r.readAsText(f); });
  });
}

/* ==================== 自绘窗口控件 ==================== */
const winApi = (__tauri && __tauri.window && typeof __tauri.window.getCurrentWindow === 'function') ? __tauri.window.getCurrentWindow() : null;
function bindWinCtrl() {
  if (!winApi) return;
  $id('btnMin')?.addEventListener('click', () => winApi.minimize().catch(() => {}));
  $id('btnMax')?.addEventListener('click', async () => { try { const old = await winApi.isMaximized(); if (old) { await winApi.unmaximize(); $id('btnMax').textContent = '▢'; } else { await winApi.maximize(); $id('btnMax').textContent = '⤧'; } } catch {} });
  $id('btnClose')?.addEventListener('click', () => winApi.close().catch(() => {}));
}

/* ==================== 侧栏折叠/调宽 ==================== */
function applySideWidth(w) {
  document.documentElement.style.setProperty('--side-w', w + 'px');
  S.sideW = w;
  LS.set('sr_side_w', w);
  // 侧栏宽度只走拖拽分隔条（#sideResizer），面板内滑杆已删，不再回写控件
}
// R10a：侧栏开关唯一入口（顶栏常驻按钮＋视图菜单共用；窄窗手动拨过即加锁）
function toggleSide() {
  if (window.innerWidth < 640) sideManualLock = true;   // v1.7:与 autoFoldSide 阈值同源(640)
  sideAutoFolded = false;
  applySideCollapsed(!S.sideCollapsed);
}
function applySideCollapsed(c) {
  S.sideCollapsed = c;
  LS.set('sr_side_col', c);
  const side = $id('side');
  side.classList.toggle('collapsed', c);
  const btn = $id('btnSideToggle');
  if (btn) {
    const lab = btn.querySelector('span'); if (lab) lab.textContent = c ? '显示侧栏' : '隐藏侧栏';
    const u = btn.querySelector('use'); if (u) u.setAttribute('href', c ? '#i-side-off' : '#i-side');
    btn.title = c ? '显示侧栏' : '隐藏侧栏';
  }
  const sb = $id('btnSide');
  if (sb) sb.title = c ? '展开侧栏' : '收起侧栏';
}
/* ==================== 侧栏下半（R8a：最近十条＋中间可拖） ==================== */
function applySideBottomH(h) {
  h = Math.max(48, Math.min(600, Math.round(Number(h) || 180)));
  document.documentElement.style.setProperty('--side-bottom-h', h + 'px');
  S.sideBottomH = h;
  LS.set('sr_side_bottom_h', h);
}
function renderRecent() {
  const box = $id('recentList');
  if (!box) return;
  box.innerHTML = '';
  const cnt = $id('recentCount');
  const list = S.recent.slice(0, 10);
  if (cnt) cnt.textContent = list.length ? list.length + ' 项' : '';
  if (!list.length) { box.innerHTML = '<div class="side-empty">暂无打开记录</div>'; return; }
  list.forEach((abs) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'side-recent';
    b.title = abs;
    b.dataset.abs = abs; // R12c(e)：右键菜单定位用
    const nm = document.createElement('span');
    nm.className = 'tab-name';
    nm.textContent = fileName(abs);
    b.appendChild(nm);
    b.addEventListener('click', () => openExternal(abs));
    box.appendChild(b);
  });
}
let vResizeDragging = false;
function bindSideVResizer() {
  const rz = $id('sideVResizer');
  const side = $id('side');
  if (!rz || !side) return;
  rz.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || S.sideCollapsed) return;
    vResizeDragging = true;
    rz.classList.add('dragging');
    document.body.style.cursor = 'row-resize';
    const startY = e.clientY;
    const startH = $id('sideBottom').offsetHeight;
    const max = Math.max(96, side.clientHeight - 120);
    const move = (ev) => {
      if (!vResizeDragging) return;
      applySideBottomH(Math.min(max, startH + (startY - ev.clientY)));
    };
    const up = () => {
      if (!vResizeDragging) return;
      vResizeDragging = false;
      rz.classList.remove('dragging');
      document.body.style.cursor = '';
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    e.preventDefault();
  });
}
/* ==================== 侧栏精简＋窄窗自适应（R8b） ==================== */
function applySideCompact(c) {
  S.sideCompact = !!c;
  LS.set('sr_side_compact', S.sideCompact);
  document.body.classList.toggle('side-compact', S.sideCompact);
  const st = document.documentElement.style;
  if (S.sideCompact) st.setProperty('--side-w', '190px');
  else st.setProperty('--side-w', S.sideW + 'px');
  const b = $id('btnCompact');
  if (b) b.classList.toggle('active', S.sideCompact);
}
// 窄窗自动折叠：<640px 自动收（记 auto），回宽自动放；窄窗下手动拨过开关就不再代劳，直到回宽重置。
// R12c(c)：自动收/放只在边沿吐一次 toast（靠 sideAutoFolded 状态判定，不骚扰重复 resize）
let sideManualLock = false;
let sideAutoFolded = false;
function autoFoldSide() {
  const narrow = window.innerWidth < 640;
  if (!narrow) {
    sideManualLock = false;
    if (sideAutoFolded && S.sideCollapsed) { applySideCollapsed(false); toast(t('toast.sideExpanded')); }
    sideAutoFolded = false;
    return;
  }
  if (!sideManualLock && !S.sideCollapsed) { applySideCollapsed(true); sideAutoFolded = true; toast(t('toast.sideFolded')); }
}
/* ==================== 窗口拖动 ==================== */
// WebView2 不认 CSS -webkit-app-region: drag（computed 生效但系统忽略，2026-08-06 实证），
// 必须 mousedown 同步调 startDragging()（Tauri 2 官方机制；capabilities 需 core:window:allow-start-dragging）。
// 交互区（按钮/链接/输入/窗口控制）跳过保留点击；actions 间隙可拖 = 顶栏大片空白都能拖窗口。
function bindWindowDrag() {
  const tb = document.querySelector('.topbar');
  if (!tb || !window.__TAURI__ || !window.__TAURI__.window) return;
  const win = window.__TAURI__.window.getCurrentWindow();
  tb.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('button, a, input, select, textarea, .win-ctrl')) return;
    e.preventDefault();
    win.startDragging().catch(() => {});
  });
}

let resizeDragging = false;
function bindSideResizer() {
  const resizer = $id('sideResizer');
  const side = $id('side');
  if (!resizer || !side) return;
  resizer.addEventListener('mousedown', (e) => {
    if (side.classList.contains('collapsed')) return;
    resizeDragging = true;
    document.body.style.cursor = 'col-resize';
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!resizeDragging) return;
    const w = Math.min(480, Math.max(160, e.clientX - side.getBoundingClientRect().left));
    applySideWidth(Math.round(w / 10) * 10);
  });
  window.addEventListener('mouseup', () => {
    if (resizeDragging) { resizeDragging = false; document.body.style.cursor = ''; }
  });
}

/* ==================== 设置面板 ==================== */
function applySettings() {
  // 主题降级（scout T4）：切主题时若当前 palette 不属于该主题，回落到 gruvbox
  if (!PALETTES[S.theme] || !PALETTES[S.theme].includes(S.palette)) {
    S.palette = 'gruvbox'; LS.set('sr_palette', 'gruvbox');
  }
  document.documentElement.style.setProperty('--h1-size', S.h1Size + 'em');
  document.documentElement.style.setProperty('--body-size', S.bodySize + 'px');
  document.documentElement.style.setProperty('--code-size', S.codeSize + 'px');
  document.body.dataset.theme = S.theme;
  document.documentElement.dataset.palette = S.palette;
  document.documentElement.dataset.theme = S.theme;
  // R12b 字号预设回显：三按钮 active + 当前三围文字（滑条已删，三围只由预设写入）
  $id('setFontRead')?.classList.toggle('active', S.fontPreset === 'read');
  $id('setFontCode')?.classList.toggle('active', S.fontPreset === 'code');
  $id('setFontDemo')?.classList.toggle('active', S.fontPreset === 'demo');
  const fp = $id('valFontPreset');
  if (fp) {
    const nm = S.fontPreset === 'code' ? '代码' : S.fontPreset === 'demo' ? '演示' : '阅读';
    fp.textContent = `${nm} · 标题${S.h1Size.toFixed(2)}em·正文${S.bodySize}px·代码${S.codeSize}px`;
  }
  $id('setThemeDark')?.classList.toggle('active', S.theme === 'dark');
  $id('setThemeLight')?.classList.toggle('active', S.theme === 'light');
  // 主题图标 sun/moon 切换
  const tf = $q('#btnTheme use'); if (tf) tf.setAttribute('href', S.theme === 'dark' ? '#i-moon' : '#i-sun');
  applyTypography();
}

/* v1.7 排版三件套:行宽 / 行高 / 正文字体。数值只落 CSS 变量,不动结构。 */
function applyTypography() {
  const st = document.documentElement.style;
  const m = Math.min(52, Math.max(26, Number(S.measure) || 34));
  const lh = Math.min(2, Math.max(1.4, Number(S.lineH) || 1.7));
  st.setProperty('--measure', m + 'em');
  st.setProperty('--line-h', String(lh));
  document.body.classList.toggle('body-mono', S.bodyFont === 'mono');
  $id('setBodySans')?.classList.toggle('active', S.bodyFont !== 'mono');
  $id('setBodyMono')?.classList.toggle('active', S.bodyFont === 'mono');
  const rv = $id('setMeasure'); if (rv) rv.value = String(m);
  const rvl = $id('valMeasure'); if (rvl) rvl.textContent = m + 'em';
  const lv = $id('setLineH'); if (lv) lv.value = String(lh);
  const lvl = $id('valLineH'); if (lvl) lvl.textContent = lh.toFixed(2);
}

/* v1.7 阅读增强三开关:专注 / 无干扰 / 代码块行号 */
function applyEnhance() {
  document.body.classList.toggle('focus-mode', !!S.focusMode);
  document.body.classList.toggle('immersive', !!S.zen);
  document.body.classList.toggle('no-code-ln', S.codeLn === false);
  for (const m of ['wash', 'underline', 'bare', 'plate']) {
    document.body.classList.toggle('code-' + m, S.codeStyle === m);
    $id('setCodeStyle' + m[0].toUpperCase() + m.slice(1))?.classList.toggle('active', S.codeStyle === m);
  }
  $id('setFocusOn')?.classList.toggle('active', !!S.focusMode);
  $id('setFocusOff')?.classList.toggle('active', !S.focusMode);
  $id('setZenOn')?.classList.toggle('active', !!S.zen);
  $id('setZenOff')?.classList.toggle('active', !S.zen);
  $id('setCodeLnOn')?.classList.toggle('active', S.codeLn !== false);
  $id('setCodeLnOff')?.classList.toggle('active', S.codeLn === false);
}
/* v1.8 浓度拆分(与 pebrel 对齐):**DWM 只做模糊,不承担浓度** —— 浓度全由页面层画。
 * 依据是同门产品的实测配方:`blur=acrylic` 首选 WinAppSDK DesktopAcrylicController(tint=0/luminosity=0),
 * 回落 WCA accent state 4 时 gradient_color = 0x01000000(alpha=1);两种都等于"纯模糊、不加底色",
 * 它那 0.45 的浓度完全来自自己画的壳色/卡底。我们照抄这条,顺带让滑条诚实:写多少就得到多少。
 * alpha 不取 0:部分 DWM 版本会直接跳过 alpha=0 的 accent,玻璃会整个消失(pebrel 也踩过,故写 1)。 */
const GLASS_DWM_ALPHA = 1; // /255 ≈ 0.4%,仅用来保住 accent 通道
function glassSplit(conc) {
  const total = Math.min(100, Math.max(1, Number(conc) || GLASS_CONC_DEFAULT));
  return { dwm: GLASS_DWM_ALPHA, css: Math.round(total) };
}
/* R12b 玻璃质感:S.glass 的数值由**氛围三档预设或浓度拖动条**写入(v1.8.16 起两者并存,写同一个 conc),
 * 本函数只负责落 CSS 变量 + 面板回显。
 * opaque=true 强制全不透明(开机首帧用,避开透明窗冷启动合成坑);平时走存储值。
 * S.glass.tintDraft 为内存草稿(取色器未点应用前),回显优先显示草稿,后端预览见 bindSettings。 */
function applyGlass(opaque) {
  if (!S.glass || typeof S.glass !== 'object') S.glass = migrateGlass(null);
  const on = opaque ? false : (S.glass.on !== false && !S.sysNoEffects);
  const num = (v, d, lo, hi) => { v = Number(v); if (!Number.isFinite(v)) v = d; return Math.min(hi, Math.max(lo, v)); };
  // v1.8:浓度只有一路(conc)。页面层承担的那份 = 总浓度减去 DWM 份额(拆分见 glassSplit);
  // 铬层/正文区/浮层不再各有各的浓度 —— 那正是"不像一整块"的来源。
  const conc = num(S.glass.conc, GLASS_CONC_DEFAULT, 1, 100);
  const text = num(S.glass.text, 100, 70, 100);   // 文字整体透明度下限 70%(再低正文掉对比度)
  const root = document.documentElement.style;
  root.setProperty('--glass', (on ? glassSplit(conc).css : 100) + '%');
  root.setProperty('--text-opa', String(on ? text / 100 : 1));
  // 文字晕强度:实色模式(玻璃关)不需要晕 —— 那里文字直接压在实色底上,晕只会显脏。
  const halo = num(S.glass.halo, HALO_DEFAULT, 0, 100);
  root.setProperty('--halo-k', String(on ? halo / 100 : 0));
  // 面板控件回显（面板关闭时节点仍在，?. 守无）
  $id('setGlassOn')?.classList.toggle('active', on);
  $id('setGlassOff')?.classList.toggle('active', !on);
  const hs = $id('setHalo'); if (hs) hs.value = String(halo);
  const hv = $id('valHalo'); if (hv) hv.textContent = (on ? halo : 0) + '%';
  const hg = $id('glassHaloVal'); if (hg) hg.textContent = (on ? halo : 0) + '%';
  const mm = $id('setGlassMaterial'); if (mm) { const m = (typeof S.glass.material === 'string' ? S.glass.material : 'acrylic'); mm.value = (m === 'none' || m === 'acrylic' || m === 'mica') ? m : 'acrylic'; }
  const tintShown = (typeof S.glass.tintDraft === 'string' && /^#[0-9a-fA-F]{6}$/.test(S.glass.tintDraft)) ? S.glass.tintDraft : ((typeof S.glass.tint === 'string' && /^#[0-9a-fA-F]{6}$/.test(S.glass.tint)) ? S.glass.tint : '#26282e');
  const ti = $id('setGlassTint'); if (ti) ti.value = tintShown;
  const tv = $id('valGlassTint'); if (tv) tv.textContent = tintShown;
  const am = (typeof S.glass.atmos === 'string' && ATMOS_PRESETS[S.glass.atmos]) ? S.glass.atmos : 'medium';
  $id('setAtmosWeak')?.classList.toggle('active', am === 'weak');
  $id('setAtmosMedium')?.classList.toggle('active', am === 'medium');
  $id('setAtmosStrong')?.classList.toggle('active', am === 'strong');
  // 浓度拖动条回显(v1.8.16):拖条与三档预设写的是同一个 SSOT(S.glass.conc),回显也只此一处
  const cr = $id('setConc'); if (cr) cr.value = String(conc);
  const cv = $id('valConc'); if (cv) cv.textContent = (on ? conc : 0) + '%';
}
/* R2 材质 + 底色直驱后端：material（none/acrylic）+ tint。mica/aero 已删，旧值一律按 acrylic。
 * 非 Tauri 环境（invoke 为空）静默跳过。失焦重放在 boot 里（R3）；圆角是 R4 的事，本轮不碰。 */
/* R3-诊断：玻璃事件环形日志。默认关闭（sr_glass_debug !== '1' 时零开销零落盘），
 * agent 自测时手动开，存在共享 localStorage（sr_glass_dbg，上限 60 条），正常实例与调试实例都能读。
 * 这是摆在明面上的诊断开关，不是隐蔽后门：无网络、无外发、关 flag 即停。 */
function glassDbg(evt) {
  try {
    if (localStorage.getItem('sr_glass_debug') !== '1') return;
    let a = [];
    try { a = JSON.parse(localStorage.getItem('sr_glass_dbg') || '[]'); } catch { a = []; }
    if (!Array.isArray(a)) a = [];
    a.push(Date.now() + ':' + evt);
    while (a.length > 60) a.shift();
    localStorage.setItem('sr_glass_dbg', JSON.stringify(a));
  } catch { /* 存储不可用则静默跳过 */ }
}
/* R12b 材质 + 底色直驱后端：R12b 起总开关是真开关——on=false 时强制走直透(state 2)，不再是 CSS 假关。
 * tintOverride 专供取色预览（草稿不落盘，DWM 先看效果）；提交/取消走存档值重放。 */
async function applyGlassMaterial(force, tintOverride) {
  if (!invoke) return;
  const g = (S.glass && typeof S.glass === 'object') ? S.glass : {};
  // 总开关关 / 系统禁用透明效果 = 真直透:无视存档材质,直接 paint_glass(false) 的 state 2 通道
  let material = (g.on === false || S.sysNoEffects) ? 'none' : (typeof g.material === 'string' ? g.material : 'acrylic');
  if (material !== 'none' && material !== 'acrylic' && material !== 'mica') material = 'acrylic';
  const tintSrc = (typeof tintOverride === 'string' && /^#[0-9a-fA-F]{6}$/.test(tintOverride)) ? tintOverride : g.tint;
  const tint = (typeof tintSrc === 'string' && /^#[0-9a-fA-F]{6}$/.test(tintSrc)) ? tintSrc : '#26282e';
  const dark = S.theme !== 'light';
  const n = parseInt(tint.slice(1), 16);
  // 连续映射：底色滑杆 1–100 → DWM alpha 1–255（磨砂霜跟着滑杆走，不透明↔透明一杆到底）；
  // 直透通道渐变恒零，透明度全由页面层承担。开机/回焦重放带 force 穿透去重（DWM 丢状态自愈）。
  // v1.8:DWM 只出模糊(alpha=1,pebrel 配方),浓度全在页面层 —— 见 glassSplit。
  const alpha = glassSplit(Number(g.conc) || GLASS_CONC_DEFAULT).dwm;
  try {
    await invoke('set_glass_material', { material, r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, alpha, dark, force: !!force });
    glassDbg('mat:' + material + ':ok');
  } catch (e) {
    glassDbg('mat:' + material + ':ERR');
    toast(t('toast.glassFail') + trErr(e));
  }
}
function renderPaletteSwatches() {
  const box = $id('paletteSwatches');
  if (!box) return;
  box.innerHTML = '';
  (PALETTES[S.theme] || []).forEach((p) => {
    const sw = document.createElement('div');
    sw.className = 'swatch' + (S.palette === p ? ' active' : '');
    sw.style.background = SWATCH_COLORS[p] || 'var(--accent)';
    sw.title = p;
    sw.onclick = () => { S.palette = p; LS.set('sr_palette', p); applySettings(); renderPaletteSwatches(); };
    box.appendChild(sw);
  });
}
/* 单例面板路由：settings 与 glass 互斥，同一时间最多开一个；null 全关 */
/* R12c(a)：settings 开/关同步 body.settings-open，阅读区显隐只此一处（根治双显，不逐行打补丁） */
function showPanel(name) {
  const sp = $id('settingsPanel');
  const gp = $id('glassPanel');
  document.body.classList.toggle('settings-open', name === 'settings');
  if (name === 'settings') {
    if (gp) gp.hidden = true;
    closeDrawers();
    if (sp) { sp.hidden = false; applySettings(); renderPaletteSwatches(); applyGlass(false); }
  } else if (name === 'glass') {
    if (sp) sp.hidden = true;
    closeDrawers();
    if (gp) { gp.hidden = false; applyGlass(false); }
  } else {
    if (sp) sp.hidden = true;
    if (gp) gp.hidden = true;
  }
  // 设置页现在是右侧抽屉:阅读区宽度变了 → 工具栏要重算溢出(它按 clientWidth 判定,只有 resize 才会自动重跑)
  if (typeof layoutToolbar === 'function') layoutToolbar();
}
function isPanelOpen() {
  const sp = $id('settingsPanel');
  const gp = $id('glassPanel');
  return !!((sp && !sp.hidden) || (gp && !gp.hidden));
}
/* 设置页内搜索：中英别名过滤 + 自动定位首个命中分区，清空即还原 */
function filterSettings(q) {
  const query = String(q || '').trim().toLowerCase();
  const rows = $qa('#settingsPanel .set-row');
  const clearBtn = $id('btnSetSearchClear');
  if (clearBtn) clearBtn.hidden = !query;
  if (!query) {
    rows.forEach((r) => { r.hidden = false; });
    $qa('#settingsPanel .set-section').forEach((s) => { s.hidden = false; });
    return;
  }
  let firstSec = null;
  $qa('#settingsPanel .set-section').forEach((sec) => {
    let visible = 0;
    $qa('.set-row', sec).forEach((r) => {
      const hay = ((r.dataset.search || '') + ' ' + (r.textContent || '')).toLowerCase();
      const hit = query.split(/\s+/).every((tok) => tok && hay.includes(tok));
      r.hidden = !hit;
      if (hit) visible++;
    });
    sec.hidden = visible === 0;
    if (visible > 0 && !firstSec) firstSec = sec;
  });
  if (firstSec) {
    $qa('#setNav .setpage-nav-item').forEach((b) => b.classList.toggle('active', b.dataset.target === firstSec.id));
    firstSec.scrollIntoView({ block: 'start' });
  }
}
function bindSettings() {
  $id('btnSettings')?.addEventListener('click', () => {
    const p = $id('settingsPanel');
    showPanel(p && !p.hidden ? null : 'settings');
  });
  $id('btnSettingsClose')?.addEventListener('click', () => showPanel(null));
  // 左侧分类导航：点击滚动到对应分区
  $qa('#setNav .setpage-nav-item').forEach((b) => b.addEventListener('click', () => {
    $qa('#setNav .setpage-nav-item').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    const sec = $id(b.dataset.target);
    if (sec) sec.scrollIntoView({ block: 'start' });
  }));
  // 搜索框：输入过滤 + 清空还原
  $id('setSearch')?.addEventListener('input', (e) => filterSettings(e.target.value));
  $id('btnSetSearchClear')?.addEventListener('click', () => {
    const inp = $id('setSearch');
    if (inp) { inp.value = ''; filterSettings(''); inp.focus(); }
  });
  $id('setThemeDark')?.addEventListener('click', () => { S.theme = 'dark'; LS.set('sr_theme', 'dark'); applySettings(); renderPaletteSwatches(); });
  $id('setThemeLight')?.addEventListener('click', () => { S.theme = 'light'; LS.set('sr_theme', 'light'); applySettings(); renderPaletteSwatches(); });
  // R12b 字号预设：一点写三围并持久化（旧滑条已删，applySettings 只做回显）
  const applyFontPreset = (k) => {
    const p = FONT_PRESETS[k]; if (!p) return;
    S.fontPreset = k;
    S.h1Size = p.h1; S.bodySize = p.body; S.codeSize = p.code;
    LS.set('sr_font_preset', k);
    LS.set('sr_h1', S.h1Size); LS.set('sr_body', S.bodySize); LS.set('sr_code', S.codeSize);
    applySettings();
  };
  $id('setFontRead')?.addEventListener('click', () => applyFontPreset('read'));
  $id('setFontCode')?.addEventListener('click', () => applyFontPreset('code'));
  $id('setFontDemo')?.addEventListener('click', () => applyFontPreset('demo'));
  // R12b 玻璃：真总开关 + 氛围预设 + 底色草稿三步走（选即预览→应用落盘→取消回滚）
  const glassOn = () => { if (!S.glass || typeof S.glass !== 'object') S.glass = migrateGlass(null); return S.glass; };
  $id('setGlassOn')?.addEventListener('click', () => { glassOn().on = true; LS.set('sr_glass', persistGlass()); applyGlass(false); applyGlassMaterial(true); });
  $id('setGlassOff')?.addEventListener('click', () => { glassOn().on = false; LS.set('sr_glass', persistGlass()); applyGlass(false); applyGlassMaterial(true); });
  const applyAtmos = (k) => {
    const p = ATMOS_PRESETS[k]; if (!p) return;
    const g = glassOn();
    g.atmos = k;
    g.conc = p.conc; g.text = p.text;   // v1.8:单一浓度;旧四路键已废,别再往存档里塞 undefined
    LS.set('sr_glass', persistGlass());
    applyGlass(false);
    applyGlassMaterial(false); // conc 变了 DWM 份额跟着变,键不同必穿透去重
  };
  $id('setAtmosWeak')?.addEventListener('click', () => applyAtmos('weak'));
  $id('setAtmosMedium')?.addEventListener('click', () => applyAtmos('medium'));
  $id('setAtmosStrong')?.addEventListener('click', () => applyAtmos('strong'));
  // 浓度拖动条(v1.8.16,用户:「应该可以用滚拖动条来拖动透明度」):三档预设 = 快捷值,拖条 = 连续调节,
  // 两边都写同一个 SSOT(S.glass.conc);atmos 用 atmosOf 回算,按钮高亮才不撒谎。
  // 拖动只落 CSS 变量(glassSplit 的 dwm 恒 1,浓度已不影响 DWM 份额)→ 不调 applyGlassMaterial,免得每帧打后端。
  $id('setConc')?.addEventListener('input', (e) => {
    const g = glassOn();
    g.conc = Math.min(100, Math.max(1, Math.round(Number(e.target.value) || GLASS_CONC_DEFAULT)));
    g.atmos = atmosOf(g.conc);
    LS.set('sr_glass', persistGlass());
    applyGlass(false);
  });
  // 底色取色：input 只写内存草稿 + 防抖后端预览；应用才落盘；取消丢草稿并按存档值重放后端
  let tintPreviewTimer = 0;
  $id('setGlassTint')?.addEventListener('input', (e) => {
    const v = String(e.target.value || '');
    if (!/^#[0-9a-fA-F]{6}$/.test(v)) return;
    glassOn().tintDraft = v;
    applyGlass(false);
    clearTimeout(tintPreviewTimer);
    tintPreviewTimer = setTimeout(() => { applyGlassMaterial(false, v); }, 150);
  });
  $id('btnTintApply')?.addEventListener('click', () => {
    const g = glassOn();
    if (typeof g.tintDraft === 'string' && /^#[0-9a-fA-F]{6}$/.test(g.tintDraft)) g.tint = g.tintDraft;
    delete g.tintDraft;
    LS.set('sr_glass', persistGlass());
    applyGlass(false);
    applyGlassMaterial(true);
  });
  $id('btnTintCancel')?.addEventListener('click', () => {
    const g = glassOn();
    delete g.tintDraft;
    applyGlass(false);
    applyGlassMaterial(true); // 按已提交值重放，洗掉预览残留
  });
  // R2 材质下拉：切换即持久化并直驱后端；总开关关时切材质只记档不碰 DWM（开时重放生效）
  // 拖动条只落 CSS 变量,不动 DWM → 不调 applyGlassMaterial(避免每帧打后端)
  $id('setHalo')?.addEventListener('input', (e) => {
    glassOn().halo = Math.min(100, Math.max(0, Number(e.target.value) || 0));
    LS.set('sr_glass', persistGlass());
    applyGlass(false);
  });
  $id('setGlassMaterial')?.addEventListener('change', (e) => { glassOn().material = e.target.value; LS.set('sr_glass', persistGlass()); applyGlassMaterial(); });
  // 玻璃独立面板：工具栏按钮经单例路由直达，与设置页互斥
  $id('btnGlass')?.addEventListener('click', () => {
    const gp = $id('glassPanel'); if (!gp) return;
    showPanel(!gp.hidden ? null : 'glass');
  });
  $id('btnGlassClose')?.addEventListener('click', () => showPanel(null));
  // 单一 Esc：关闭任一面板（设置/玻璃两者其一）
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isPanelOpen()) showPanel(null); });
}

/* ==================== 启动 ==================== */
function toast(msg) {
  const t = $id('toast');
  if (!t) return;
  t.textContent = msg; t.hidden = false;
  t.classList.add('show'); // R12c：.toast 默认 opacity:0，不加 show 永不可见（基线漏加，c/d 通知靠它）
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.classList.remove('show'); t.hidden = true; }, 2600);
}
function installDragEnterNative() {
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
}
async function onOpenFolder() {
  if (!(await confirmLeaveEdit())) return;   // 2026-10-25:换库前也要问(此前直接 loadRoot,脏内容静默留/丢)
  const p = await invoke('pick_folder').catch(() => null);
  if (!p) return toast(t('toast.noFolder'));
  const rootMeta = { id: 'r' + Date.now(), name: p.name, path: p.path };
  S.roots = S.roots.filter((r) => r.path !== p.path);
  S.roots.unshift(rootMeta);
  LS.set('sr_roots', S.roots);
  invoke('save_roots', { roots: S.roots }).catch(() => {});
  await loadRoot(rootMeta);
}
async function loadRoot(rootMeta) {
  try {
    const scan = await invoke('list_md_tree', { root: rootMeta.path });
    S.root = { scan, rootPath: rootMeta.path, name: rootMeta.name };
    setView('tree');
  } catch (e) { toast(t('toast.readDirFail') + trErr(e)); }
}
async function pickOpenFile() {
  if (!invoke) return;
  const f = await invoke('pick_file').catch(() => null);
  if (f) openExternal(f.path);
}

function wire() {
  $id('btnOpenFolder').addEventListener('click', onOpenFolder);
  $id('btnOpenFile').addEventListener('click', pickOpenFile);
  $id('btnTheme')?.addEventListener('click', () => { S.theme = S.theme === 'dark' ? 'light' : 'dark'; LS.set('sr_theme', S.theme); applySettings(); renderPaletteSwatches(); });
  $id('btnTree').addEventListener('click', () => setView('tree'));
  $id('btnToc').addEventListener('click', () => setView('toc'));
  $id('btnMap')?.addEventListener('click', () => setView('map'));
  $id('btnBackToTree').addEventListener('click', () => setView('tree'));
  $id('btnFavDoc').addEventListener('click', () => { if (S.cur) toggleFavorite(S.cur.abs); });
  $id('btnRefresh')?.addEventListener('click', refreshCurrent);
  // 编辑第二批入口(抽屉按钮 + 快捷键共用同一批函数)
  $id('btnNewDoc')?.addEventListener('click', () => { closeDrawersSafe(); newDoc(); });
  $id('btnSaveAs')?.addEventListener('click', () => { closeDrawersSafe(); saveAsDoc(); });
  $id('btnRenameDoc')?.addEventListener('click', () => { closeDrawersSafe(); renameDoc(); });
  $id('btnDeleteDoc')?.addEventListener('click', () => { closeDrawersSafe(); deleteDoc(); });
  // 自研更新器:设置页手动检查(force 跳过节流)+ 启动后台静默检查
  $id('btnCheckUpdate')?.addEventListener('click', async () => {
    const m = await checkUpdate(true);
    if (m) await promptUpdate(m);
  });
  // 打字机模式(编辑侧滚动跟随)
  $id('setTypewriterOn')?.addEventListener('click', () => applyTypewriter(true));
  $id('setTypewriterOff')?.addEventListener('click', () => applyTypewriter(false));
  applyTypewriter(LS.get('sr_typewriter') === '1');
  scheduleUpdateCheck();
  $id('btnEdit')?.addEventListener('click', () => { if (!S.cur) return; if (S.editing) saveEdit(); else enterEdit(); });
  $id('btnUndo')?.addEventListener('click', () => { if (S.editing) doUndo(); });
  $id('btnRedo')?.addEventListener('click', () => { if (S.editing) doRedo(); });
  $id('editor')?.addEventListener('keydown', (e) => {
    // Tab 缩进(此前按 Tab 会把焦点跳出去 —— 编辑里最反直觉的一处)
    if (e.key === 'Tab') {
      e.preventDefault();
      const ed = $id('editor');
      const s = ed.selectionStart, en = ed.selectionEnd;
      if (!e.shiftKey && s === en) {
        ed.setRangeText('  ', s, en, 'end');
      } else {
        // 跨行选区:整块缩进 / 反缩进
        const val = ed.value;
        const lineStart = val.lastIndexOf('\n', s - 1) + 1;
        let lineEnd = val.indexOf('\n', en);
        if (lineEnd === -1) lineEnd = val.length;
        const block = val.slice(lineStart, lineEnd);
        const next = block
          .split('\n')
          .map((l) => (e.shiftKey ? l.replace(/^ {1,2}/, '') : '  ' + l))
          .join('\n');
        ed.setRangeText(next, lineStart, lineEnd, 'select');
      }
      // setRangeText 不触发 input 事件,手动记一步历史 + 点脏
      S.editDirty = true;
      pushUndo(prevEditValue);
      prevEditValue = ed.value;
      renderTabs();
      return;
    }
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = e.key.toLowerCase();
    if (k === 'z') { e.preventDefault(); if (e.shiftKey) doRedo(); else doUndo(); }
    else if (k === 'y') { e.preventDefault(); doRedo(); }
    else if (k === 's') { e.preventDefault(); saveEdit(); }   // 2026-10-25:编辑态补上 Ctrl+S(此前根本没有保存快捷键)
    else if (k === 'h') { e.preventDefault(); openEditFind(); } // 编辑态查找替换(阅读态的 Ctrl+F 是另一套)
  });
  $id('editor')?.addEventListener('input', () => {
    if (histLock) return; // doUndo/doRedo 编程赋值不记历史(防栈污染/弹跳)
    S.editDirty = true; pushUndo(prevEditValue); prevEditValue = $id('editor').value;
    renderTabs();   // R7:即时点亮 tab 脏点
    typewriterFollow();
  });
  // 光标移动(点选/方向键/回车)也要跟随:打字机模式下这几条路径同样会跑出视口
  ['keyup', 'click', 'select'].forEach((ev) => $id('editor')?.addEventListener(ev, () => typewriterFollow()));
  $id('btnSideToggle').addEventListener('click', toggleSide);
  $id('btnSide')?.addEventListener('click', toggleSide);
  $id('btnCompact')?.addEventListener('click', () => applySideCompact(!S.sideCompact));
  // 下拉抽屉：触发按钮 + 点击外部/Escape 关闭
  $qa('[data-drawer]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); openDrawer(b.dataset.drawer, b); }));
  // R12c(e)：右键菜单——文件树文件（打开/收藏）、收藏（取消收藏）、最近（移除），委托绑定防重建丢失
  $id('sideBody')?.addEventListener('contextmenu', (e) => {
    const t = e.target.closest('.tree-item.file');
    if (!t) return;
    e.preventDefault();
    const rel = t.dataset.rel;
    const abs = absOfRel(rel);
    if (!abs) return;
    const fav = isFavorited(abs);
    showCtxMenu(e.clientX, e.clientY, [
      { label: '打开', fn: () => openInRoot(rel) },
      { label: '重命名…', fn: () => { openInRoot(rel).then(() => renameDoc()); } },
      { label: '删除(进回收站)', fn: () => { openInRoot(rel).then(() => deleteDoc()); } },
      { label: '新建文档…', fn: () => newDoc() },
      fav ? { label: '取消收藏', fn: () => toggleFavorite(abs) } : { label: '收藏', fn: () => toggleFavorite(abs) },
    ]);
  });
  $id('docFavs')?.addEventListener('contextmenu', (e) => {
    const t = e.target.closest('.drawer-item');
    if (!t || !t.dataset.abs) return;
    e.preventDefault();
    const abs = t.dataset.abs;
    showCtxMenu(e.clientX, e.clientY, [
      { label: '打开', fn: () => openExternal(abs) },
      { label: '取消收藏', fn: () => { S.favorites = S.favorites.filter((f) => f !== abs); LS.set('sr_favorites', S.favorites); refreshFavDocBtn(); renderDocDrawer(); } },
    ]);
  });
  const ctxRecent = (boxId) => $id(boxId)?.addEventListener('contextmenu', (e) => {
    const t = e.target.closest('.drawer-item, .side-recent');
    if (!t || !t.dataset.abs) return;
    e.preventDefault();
    const abs = t.dataset.abs;
    showCtxMenu(e.clientX, e.clientY, [
      { label: '打开', fn: () => openExternal(abs) },
      { label: '移除这条记录', fn: () => { S.recent = S.recent.filter((r) => r !== abs); LS.set('sr_recent', S.recent); renderRecent(); renderDocDrawer(); } },
    ]);
  });
  ctxRecent('docRecent');
  ctxRecent('recentList');
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#ctxMenu')) closeCtxMenu(); // 右键菜单：点空白即关（项内点击由 onclick 自关）
    if (e.target.closest('.menu-item')) { closeDrawers(); return; }
    if (!drawerOpen) return;
    if (e.target.closest('.drawer') || e.target.closest('[data-drawer]')) return;
    closeDrawers();
  });
  // 单一 Esc：抽屉 + 任一面板一起关（单例路由 showPanel 全关；R12c(e)：右键菜单同车，不另起监听）
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeCtxMenu(); closeDrawers(); showPanel(null); closeEditFind(); } });
  // R7 标签页快捷键:Ctrl+W 关当前,Ctrl+Tab / Ctrl+Shift+Tab 轮切(浏览器同感;编辑框内同样生效)
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = e.key.toLowerCase();
    if (k === 'w') { e.preventDefault(); if (S.activeKey) closeTab(S.activeKey); }
    else if (k === 'tab') { e.preventDefault(); cycleTab(e.shiftKey ? -1 : 1); }
    else if (k === 'n' && !e.shiftKey) { e.preventDefault(); newDoc(); }             // 新建文档
    else if (k === 's' && e.shiftKey) { e.preventDefault(); saveAsDoc(); }           // 另存为(编辑态的 Ctrl+S 在 editor 上处理)
  });
  // F2 重命名 / Delete 删除(只在非编辑态生效:编辑框里的 F2、Delete 是文本操作)
  document.addEventListener('keydown', (e) => {
    if (S.editing) return;
    if (e.key === 'F2') { e.preventDefault(); renameDoc(); }
    else if (e.key === 'Delete' && S.cur) { e.preventDefault(); deleteDoc(); }
  });
  $id('setTbIcon')?.addEventListener('click', () => { S.toolbarMode = 'icon'; LS.set('sr_tb_mode', 'icon'); applyToolbarMode(); });
  $id('setTbText')?.addEventListener('click', () => { S.toolbarMode = 'text'; LS.set('sr_tb_mode', 'text'); applyToolbarMode(); });
  $id('btnFileAssoc')?.addEventListener('click', async () => {
    try { await invoke('open_default_apps_settings'); } catch (e) { toast(t('toast.sysSettingsFail') + e); return; }
    toast(t('toast.sysSettingsOpened'));
    refreshFileAssoc();
  });
  $id('reader').addEventListener('scroll', () => {
    clearTimeout(rememberScroll._t);
    rememberScroll._t = setTimeout(() => { rememberScroll(); highlightCurrentToc(); }, 120);
  });
  bindDragDrop();
  installDragEnterNative();
  bindWinCtrl();
  bindWindowDrag();
  bindSideResizer();
  bindSideVResizer();
  bindSettings();
  // resize 结束后重排工具栏溢出（纯 layoutToolbar，不做 opacity 合成层 hack——
  // 透明窗时代该 hack 轻触合成层强制刷新；实色窗（transparent:false）下它反而
  // 触发 WebView2 合成层损坏：正文/按钮大面积不绘制，只剩旧帧残影，2026-08-05 实证）
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer._t);
    resizeTimer._t = setTimeout(() => { layoutToolbar(); autoFoldSide(); }, 120);
  });
}

/* 文件关联：按钮只打开系统"默认应用"页（OS 禁止静默自设默认）；状态只读展示 */
async function refreshFileAssoc() {
  const el = $id('fileAssocStatus'); if (!el || !invoke) return;
  try {
    const r = await invoke('get_md_default');
    el.textContent = r && r.isTmmd ? 'TMMD（就是本应用）' : (r && r.progId ? r.progId : '未知');
  } catch { el.textContent = '读不到'; }
}
async function boot() {
  // 版本号（R7b：顶栏品牌字已撤，版本只在设置菜单显示；浏览器预览降级为空）
  try {
    const v = await window.__TAURI__.app.getVersion();
    const sv = $id('settingsVer');
    if (sv) sv.textContent = v ? 'TMMD v' + v : 'TMMD';
  } catch { /* 非 Tauri 环境 */ }
  applySettings();
  renderPaletteSwatches();
  applySideWidth(S.sideW);
  applySideCollapsed(S.sideCollapsed);
  applySideCompact(!!S.sideCompact);
  autoFoldSide();
  applySideBottomH(S.sideBottomH);
  renderRecent();
  applyToolbarMode();
  // R12c(d)：纯图标模式一次性引导（sr_tb_guide_seen 落盘，一生一次；延迟 1.2s 避开开机 toast 拥挤）
  if (!LS.get('sr_tb_guide_seen', null)) {
    LS.set('sr_tb_guide_seen', 1);
    if (S.toolbarMode === 'icon') setTimeout(() => toast(t('toast.iconModeHint')), 1200);
  }
  refreshFileAssoc();
  wire();
  initV17();   // v1.7:排版/增强/i18n/查找/搜索/导出/系统回落/文件监听
  // R3 失焦重放（修正版）：blur 时不动手——DWM 失活期写 backdrop 属性会丢渲染，写了也白写；
  // 只在 focus 回来后 300ms 全序列重放一次，等 DWM 走完激活再落 backdrop。直透无材质可丢，不受影响。
  // 非 Tauri 环境静默跳过。
  let glassRefocusTimer = 0;
  try {
    if (winApi && typeof winApi.onFocusChanged === 'function') winApi.onFocusChanged((ev) => {
      const focused = !!((ev && typeof ev === 'object' && 'payload' in ev) ? ev.payload : ev);
      glassDbg('focus:' + focused);
      if (!focused) return;
      clearTimeout(glassRefocusTimer);
      glassRefocusTimer = setTimeout(() => { applyGlassMaterial(true); }, 300);
    }).catch(() => {});
  } catch { /* 非 Tauri 环境 */ }
  glassDbg('boot:' + ((S.glass && S.glass.material) || '?'));
  // W3 开机延迟应用：首帧先全不透明（避开透明窗冷启动合成坑），450ms 后再落用户玻璃值（含材质 + 底色 tint）
  applyGlass(true);
  setTimeout(() => { applyGlass(false); applyGlassMaterial(true); }, 450);
  // 字体加载会改变按钮宽度，加载完成后重排溢出
  setTimeout(layoutToolbar, 300);
  window.addEventListener('load', layoutToolbar);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => layoutToolbar());
  if (!invoke) { toast(t('toast.needDesktop')); return; }
  S.roots = await invoke('load_roots').catch(() => []);
  if (S.roots.length) await loadRoot(S.roots[0]);
  await restoreTabs();   // R7：恢复上次标签页（内容重读，draft 不恢复）
  if (listen) {
    try { listen('open-file', (e) => { if (e && typeof e.payload === 'string') openExternal(e.payload); }); } catch {}
    // 关窗守卫:后端 CloseRequested 只发事件不真关;这里先处理未保存内容,再放行 allow_close。
    try {
      listen('close-requested', async () => {
        if (!anyDirty()) { invoke('allow_close').catch(() => {}); return; }
        const a = await askUnsaved();
        if (a === 'cancel') return;                       // 用户要留下自己处理
        if (a === 'save' && !(await saveAllDirty())) return; // 存失败就别关
        invoke('allow_close').catch(() => {});
      });
    } catch {}
  }
  try {
    const pending = await invoke('pending_open');
    if (pending && typeof pending === 'string') openExternal(pending);
  } catch {}
}
document.addEventListener('DOMContentLoaded', boot);

/* ============================================================================
 * v1.7.0 · 阅读增强层
 * 依据:docs/2026-10-24-竞品与差距分析.md
 *  i18n(zh/en/ja) · 脚注 · 代码块复制与行号 · 文内查找(Ctrl+F) · 库级全文搜索
 *  专注/无干扰 · 导出 HTML 与打印 · 系统透明效果回落 · 外部文件变更监听
 * 说明:本段只新增函数;既有函数体仅动 renderMarkdown / renderSide / setView 三处挂点。
 * ==========================================================================*/

/* ---------------- i18n ---------------- */
const LANGS = ['zh', 'en', 'ja'];
// 键 → [中文, English, 日本語]
const I18N = {
  'menu.file': ['文件', 'File', 'ファイル'],
  'menu.edit': ['编辑', 'Edit', '編集'],
  'menu.view': ['视图', 'View', '表示'],
  'menu.doc': ['文档', 'Docs', 'ドキュメント'],
  'menu.theme': ['切换深浅主题', 'Toggle theme', 'テーマ切替'],
  'menu.settings': ['显示设置', 'Settings', '設定'],
  'menu.glass': ['玻璃质感(材质/底色)', 'Glass material & tint', 'ガラス素材と色'],
  'menu.side': ['收起/展开侧栏', 'Toggle sidebar', 'サイドバー切替'],
  'file.openFolder': ['打开文件夹', 'Open folder', 'フォルダを開く'],
  'file.openFile': ['打开文件', 'Open file', 'ファイルを開く'],
  'file.exportHtml': ['导出 HTML', 'Export HTML', 'HTML 書き出し'],
  'file.print': ['打印 / 存 PDF', 'Print / Save as PDF', '印刷 / PDF 保存'],
  'file.new': ['新建文档', 'New document', '新規ドキュメント'],
  'file.saveAs': ['另存为...', 'Save as...', '名前を付けて保存...'],
  'file.rename': ['重命名...', 'Rename...', '名前を変更...'],
  'file.delete': ['删除', 'Delete', '削除'],
  'edit.undo': ['撤销', 'Undo', '元に戻す'],
  'edit.redo': ['恢复', 'Redo', 'やり直す'],
  'edit.edit': ['编辑文档', 'Edit document', '文書を編集'],
  'edit.refresh': ['从磁盘刷新', 'Reload from disk', 'ディスクから再読込'],
  'view.tree': ['文件树', 'File tree', 'ファイルツリー'],
  'view.toc': ['目录大纲', 'Outline', '目次'],
  'view.map': ['导读地图', 'Reading map', '読書マップ'],
  'view.search': ['全文搜索', 'Full-text search', '全文検索'],
  'view.find': ['文内查找', 'Find in document', '文書内検索'],
  'view.focus': ['专注模式', 'Focus mode', '集中モード'],
  'view.zen': ['无干扰模式', 'Immersive mode', '没入モード'],
  'view.hideSide': ['隐藏侧栏', 'Hide sidebar', 'サイドバーを隠す'],
  'view.compact': ['精简模式', 'Compact mode', 'コンパクト表示'],
  'doc.fav': ['收藏本文', 'Star this file', 'この文書をスター'],
  'doc.recent': ['最近打开', 'Recent', '最近'],
  'doc.favs': ['收藏', 'Starred', 'スター'],
  'empty.title': ['还没有打开任何文档', 'No document open', 'ドキュメントを開いていません'],
  'empty.sub': ['轻量本地 Markdown 阅读器', 'A lightweight local Markdown reader', '軽量ローカル Markdown リーダー'],
  'empty.openFolder': ['打开文件夹', 'Open folder', 'フォルダを開く'],
  'empty.openFile': ['打开文件', 'Open file', 'ファイルを開く'],
  'empty.hint': ['也可以把 .md 文件拖进窗口。', 'You can also drop a .md file into the window.', '.md ファイルをドロップしても開けます。'],
  'side.emptyHtml': ['还没有打开文件夹。|点上方「文件夹」,或把 .md 文件拖进窗口。', 'No folder open.|Use “File → Open folder”, or drop a .md file here.', 'フォルダが未選択です。|「ファイル → フォルダを開く」か .md をドロップ。'],
  'side.recent': ['最近打开', 'Recent', '最近'],
  'find.placeholder': ['在本文中查找', 'Find in document', '文書内を検索'],
  'find.prev': ['上一个 (Shift+Enter)', 'Previous (Shift+Enter)', '前へ (Shift+Enter)'],
  'find.next': ['下一个 (Enter)', 'Next (Enter)', '次へ (Enter)'],
  'find.close': ['关闭 (Esc)', 'Close (Esc)', '閉じる (Esc)'],
  'settings.title': ['设置', 'Settings', '設定'],
  'glass.title': ['玻璃质感', 'Glass', 'ガラス'],
  'nav.read': ['阅读', 'Reading', '閲覧'],
  'nav.enhance': ['阅读增强', 'Reading aids', '閲覧支援'],
  'nav.theme': ['主题外观', 'Appearance', '外観'],
  'nav.glass': ['玻璃', 'Glass', 'ガラス'],
  'nav.file': ['文件与导出', 'Files & export', 'ファイルと書き出し'],
  'nav.keys': ['快捷键', 'Shortcuts', 'ショートカット'],
  'nav.about': ['关于', 'About', 'このアプリ'],
  's.read.preset': ['字号预设', 'Type scale', '文字サイズ'],
  's.read.font': ['正文字体', 'Body font', '本文フォント'],
  's.read.measure': ['行宽', 'Line width', '行幅'],
  's.read.lineH': ['行高', 'Line height', '行間'],
  's.read.toolbar': ['工具栏', 'Toolbar', 'ツールバー'],
  's.read.side': ['侧栏宽度', 'Sidebar width', 'サイドバー幅'],
  's.enh.typewriter': ['打字机模式', 'Typewriter mode', 'タイプライターモード'],
  's.enh.focus': ['专注模式', 'Focus mode', '集中モード'],
  's.enh.zen': ['无干扰模式', 'Immersive mode', '没入モード'],
  's.enh.codeLn': ['代码块行号', 'Code line numbers', 'コード行番号'],
  's.theme.codeStyle': ['行内代码样式', 'Inline code style', 'インラインコードの表示'],
  's.theme.csWash': ['荧光笔', 'Highlighter', 'マーカー'],
  's.theme.csUnderline': ['下划线', 'Underline', '下線'],
  's.theme.csBare': ['无痕', 'Plain', '装飾なし'],
  's.theme.csPlate': ['薄底', 'Faint base', '薄い下地'],
  's.theme.theme': ['主题', 'Theme', 'テーマ'],
  's.theme.palette': ['配色方案', 'Palette', '配色'],
  's.theme.lang': ['界面语言', 'Language', '表示言語'],
  's.glass.glass': ['玻璃质感', 'Glass material', 'ガラス素材'],
  's.glass.floor': ['可读性保底', 'Legibility floor', '可読性の下限'],
  's.glass.sys': ['系统回落', 'System fallback', 'システム連動'],
  's.file.assoc': ['MD 默认打开', 'Default .md app', '.md 既定アプリ'],
  's.file.current': ['当前默认', 'Current default', '現在の既定'],
  's.file.export': ['导出 / 打印', 'Export / Print', '書き出し / 印刷'],
  's.about.ver': ['版本', 'Version', 'バージョン'],
  's.about.design': ['设计依据', 'Design basis', '設計根拠'],
  'sys.ok': ['透明效果可用', 'Transparency available', '透明効果:利用可'],
  'sys.transOff': ['系统已关闭透明效果 → 已回落实色', 'Transparency disabled by system → solid', 'OS の透明効果が無効 → 単色'],
  'sys.hc': ['高对比模式 → 已回落实色', 'High contrast → solid', 'ハイコントラスト → 単色'],
  'sys.reading': ['读取中...', 'Reading…', '読み込み中…'],
  'search.placeholder': ['搜索所有已注册库(≥2 字)', 'Search all registered libraries', '登録済みライブラリを検索'],
  'search.hits': ['{n} 条命中', '{n} matches', '{n} 件'],
  'search.none': ['没有匹配', 'No matches', '一致なし'],
  'search.hint': ['输入关键词开始搜索', 'Type a keyword to search', 'キーワードを入力'],
  'toast.exported': ['已导出:{p}', 'Exported: {p}', '書き出しました: {p}'],
  'toast.exportFail': ['导出失败:{e}', 'Export failed: {e}', '書き出しに失敗: {e}'],
  'toast.exportedInline': ['已导出自包含 HTML:{p}(内联 {n} 个媒体)', 'Exported self-contained HTML: {p} ({n} media inlined)', '自己完結 HTML を書き出しました: {p}(メディア {n} 件を埋め込み)'],
  'file.exportPdf': ['导出 PDF', 'Export PDF', 'PDF 書き出し'],
  'pdf.working': ['正在生成 PDF…(用系统 Edge 无头打印)', 'Generating PDF… (headless Edge)', 'PDF を生成中…(ヘッドレス Edge)'],
  'pdf.done': ['PDF 已生成:{p}', 'PDF created: {p}', 'PDF を作成しました: {p}'],
  'pdf.fail': ['PDF 生成失败:{e}(可用「打印 / 存 PDF」手动另存)', 'PDF failed: {e} (fall back to Print / Save as PDF)', 'PDF の生成に失敗: {e}(「印刷 / PDF 保存」も使えます)'],
  'toast.refreshed': ['已刷新', 'Reloaded', '再読込しました'],
  'toast.refreshFail': ['刷新失败:', 'Reload failed: ', '再読込に失敗: '],
  'toast.readFail': ['读取失败:', 'Read failed: ', '読み込みに失敗: '],
  'toast.readDirFail': ['读取目录失败:', 'Reading the folder failed: ', 'フォルダの読み込みに失敗: '],
  'toast.tooBigHint': [' —— 可改用系统默认程序打开', ' — open it with your default app instead', ' — 既定のアプリで開いてください'],
  'err.tailDenied': ['(拒绝访问)', ' (access denied)', '(アクセスが拒否されました)'],
  'err.tailNoFile': ['(系统找不到指定的文件)', ' (the system cannot find the file)', '(指定されたファイルが見つかりません)'],
  'err.tailNoPath': ['(系统找不到指定的路径)', ' (the system cannot find the path)', '(指定されたパスが見つかりません)'],
  'err.tailBusy': ['(文件正被其它程序占用)', ' (the file is in use by another process)', '(他のプロセスが使用中です)'],
  'err.tailBadName': ['(文件名不合法)', ' (invalid file name)', '(ファイル名が不正です)'],
  'err.tooBig': ['文件过大(超过 8MB)', 'File too large (over 8 MB)', 'ファイルが大きすぎます(8MB 超)'],
  'err.onlyExt': ['仅支持 Markdown / 文本文件', 'Only Markdown / text files are supported', 'Markdown / テキストファイルのみ対応'],
  'err.notFile': ['不是文件', 'Not a file', 'ファイルではありません'],
  'err.noBrowser': ['找不到 Chromium 内核浏览器(Edge / Chrome / Brave / Vivaldi),无法直出 PDF(可改用「打印 / 存 PDF」)', 'No Chromium-based browser found (Edge / Chrome / Brave / Vivaldi) — cannot export a PDF directly (use Print / Save as PDF instead)', 'Chromium 系ブラウザ(Edge / Chrome / Brave / Vivaldi)が見つからないため PDF を直接書き出せません(「印刷 / PDF に保存」をご利用ください)'],
  'err.tailExitCode': ['(浏览器退出码', ' (browser exit code', '(ブラウザ終了コード'],
  'err.tailUsePrint': [';可改用「打印 / 存 PDF」手动另存', '; use Print / Save as PDF instead', ';「印刷 / PDF に保存」をご利用ください'],
  'toast.replaced': ['已替换 {n} 处', 'Replaced {n} occurrence(s)', '{n} 件置換しました'],
  'toast.unfav': ['已取消收藏', 'Removed from favorites', 'お気に入りを解除しました'],
  'toast.fav': ['已收藏', 'Added to favorites', 'お気に入りに追加しました'],
  'toast.sideExpanded': ['窗口恢复,已展开侧栏', 'Window restored — sidebar expanded', 'ウィンドウ復帰:サイドバーを展開'],
  'toast.sideFolded': ['窗口较窄,已自动收起侧栏', 'Narrow window — sidebar auto-collapsed', 'ウィンドウが狭いためサイドバーを自動格納'],
  'toast.glassFail': ['玻璃材质应用失败:', 'Applying the glass material failed: ', 'グラス材質の適用に失敗: '],
  'toast.noFolder': ['未选择文件夹', 'No folder selected', 'フォルダが選択されていません'],
  'toast.sysSettingsFail': ['打不开系统设置:', 'Could not open system settings: ', 'システム設定を開けません: '],
  'toast.sysSettingsOpened': ['已打开系统「默认应用」页:搜 .md → 选 TMMD', 'Opened Default apps — search ".md" then pick TMMD', '「既定のアプリ」を開きました: .md を検索して TMMD を選択'],
  'toast.iconModeHint': ['顶栏为纯图标模式:悬停看名称,可在设置→阅读→工具栏切换', 'Icon-only toolbar: hover for names; switch in Settings → Reading → Toolbar', 'アイコンのみのツールバー: ホバーで名称表示、設定→閲覧→ツールバーで切替'],
  'toast.needDesktop': ['请通过 TMMD 桌面应用打开', 'Please open this inside the TMMD desktop app', 'TMMD デスクトップアプリから開いてください'],
  'err.outOfCage': ['路径不在已登记的文件夹内', 'Path is outside the registered folders', '登録フォルダ外のパスです'],
  'err.badPath': ['路径非法', 'Invalid path', '不正なパス'],
  'err.notDir': ['不是目录: ', 'Not a directory: ', 'ディレクトリではありません: '],
  'err.noDir': ['目录不存在: ', 'No such folder: ', 'フォルダが存在しません: '],
  'err.onlyHtml': ['仅支持 .html / .htm 文件', 'Only .html / .htm files are supported', '.html / .htm のみ対応'],
  'err.srcMissing': ['源文件不存在: ', 'Source file not found: ', 'コピー元が存在しません: '],
  'err.mkdir': ['创建目录失败: ', 'Creating the folder failed: ', 'フォルダの作成に失敗: '],
  'err.recycle': ['移入回收站失败,', 'Moving to the recycle bin failed, ', 'ごみ箱への移動に失敗,'],
  'err.recycleAbort': ['移入回收站被中断', 'Moving to the recycle bin was interrupted', 'ごみ箱への移動が中断されました'],
  'err.recycleUnsupported': ['当前平台未实现回收站删除', 'Recycle-bin delete is not implemented on this platform', 'この環境ではごみ箱削除は未実装です'],
  'err.exportHtmlMissing': ['导出 HTML 不存在', 'The exported HTML does not exist', '書き出した HTML が存在しません'],
  'err.export': ['导出失败: ', 'Export failed: ', '書き出しに失敗: '],
  'err.open': ['打开失败: ', 'Opening failed: ', 'オープンに失敗: '],
  'err.browserSpawn': ['起无头浏览器失败: ', 'Starting the headless browser failed: ', 'ヘッドレスブラウザの起動に失敗: '],
  'err.pdfFailed': ['PDF 未生成', 'The PDF was not generated', 'PDF を生成できませんでした'],
  'err.noWindow': ['找不到主窗口', 'Main window not found', 'メインウィンドウが見つかりません'],
  'err.closeFail': ['关窗失败: ', 'Closing the window failed: ', 'ウィンドウを閉じられません: '],
  'err.winOnly': ['仅 Windows 支持', 'Windows only', 'Windows のみ対応'],
  'err.unknownProbe': ['未知探针: ', 'Unknown probe: ', '不明なプローブ: '],
  'err.backdropFail': ['读 backdrop 失败: ', 'Reading the backdrop failed: ', 'backdrop の取得に失敗: '],
  'err.manifestSha': ['更新清单里的 sha256 不合法', 'The manifest contains an invalid sha256', 'マニフェストの sha256 が不正です'],
  'err.untrusted': ['更新包来源不可信', 'Untrusted update source', '信頼できない更新元です'],
  'err.badSize': ['更新包体积异常', 'The update package size looks wrong', '更新パッケージのサイズが異常です'],
  'err.pkgMissing': ['更新包不存在: ', 'Update package not found: ', '更新パッケージが存在しません: '],
  'err.updDir': ['建更新目录失败: ', 'Creating the update folder failed: ', '更新用フォルダの作成に失敗: '],
  'err.moveFail': ['落位失败: ', 'Moving the package into place failed: ', '配置に失敗: '],
  'err.watch': ['监听文件失败: ', 'Watching the file failed: ', 'ファイル監視に失敗: '],
  'err.installScript': ['写安装脚本失败: ', 'Writing the installer hand-off script failed: ', 'インストールスクリプトの作成に失敗: '],
  'err.installSpawn': ['起安装脚本失败: ', 'Starting the installer hand-off script failed: ', 'インストールスクリプトの起動に失敗: '],
  'err.openSettings': ['打开默认应用设置失败: ', 'Opening the Default apps settings failed: ', '既定のアプリ設定を開けません: '],
  'err.readAssoc': ['读默认打开方式失败: ', 'Reading the default-app association failed: ', '既定アプリの関連付けを読めません: '],
  'err.noHwnd': ['取窗口句柄失败: ', 'Getting the window handle failed: ', 'ウィンドウハンドルの取得に失敗: '],
  'err.glassLock': ['材质记忆锁失败: ', 'The material state lock failed: ', 'マテリアル状態のロックに失敗: '],
  'err.glassApply': ['玻璃应用失败: ', 'Applying the glass material failed: ', 'ガラス効果の適用に失敗: '],
  'err.tailExpected': ['期望 ', 'expected ', '期待 '],
  'err.tailActual': ['实际 ', 'actual ', '実際 '],
  'err.read': ['读文件失败', 'Reading the file failed', 'ファイルの読み込みに失敗'],
  'err.write': ['写入失败', 'Writing failed', '書き込みに失敗'],
  'err.writeTmp': ['写临时文件失败(可能是磁盘满或目录只读)', 'Writing the temp file failed (disk full or read-only folder)', '一時ファイルの書き込みに失敗(容量不足/読み取り専用の可能性)'],
  'err.replace': ['替换文件失败(可能被其他程序占用)', 'Replacing the file failed (maybe locked by another program)', 'ファイルの置換に失敗(他プロセスが使用中の可能性)'],
  'err.delete': ['删除失败', 'Delete failed', '削除に失敗'],
  'err.rename': ['重命名失败', 'Rename failed', '名前の変更に失敗'],
  'err.exists': ['目标已存在', 'Target already exists', '対象は既に存在します'],
  'err.download': ['下载失败', 'Download failed', 'ダウンロードに失敗'],
  'err.sha': ['校验失败(下载内容与发布清单不符,已丢弃)', 'Checksum mismatch — download discarded', 'チェックサム不一致のため破棄しました'],
  'err.manifest': ['取更新清单失败', 'Fetching the update manifest failed', '更新マニフェストの取得に失敗'],
  'toast.fsReloaded': ['磁盘上的文件已更新,已重新加载', 'File changed on disk — reloaded', 'ディスク上の変更を再読込しました'],
  'toast.fsEditing': ['磁盘文件已变更(编辑中,未覆盖你的草稿)', 'File changed on disk (editing — draft kept)', 'ディスク上で変更されました(編集中のため保持)'],
  'toast.fsStale': ['磁盘上的文件已更新(切到该标签时重读)', 'File changed on disk — reloaded when you switch to that tab', 'ディスク上の変更(タブを切り替えると再読込)'],
  'unsaved.title': ['有未保存的修改', 'Unsaved changes', '未保存の変更があります'],
  'unsaved.save': ['保存', 'Save', '保存'],
  'unsaved.discard': ['不保存', "Don't save", '保存しない'],
  'unsaved.cancel': ['取消', 'Cancel', 'キャンセル'],
  'unsaved.sub': ['关掉/切走前先处理它,或取消。', 'Deal with it before leaving, or cancel.', '閉じる前に処理するか、キャンセルしてください。'],
  'conflict.title': ['磁盘上的文件已被别处修改', 'This file changed on disk', 'ディスク上のファイルが変更されました'],
  'conflict.sub': ['覆盖会丢掉磁盘上的改动。', 'Overwriting discards the on-disk changes.', '上書きするとディスク上の変更は失われます。'],
  'conflict.overwrite': ['覆盖', 'Overwrite', '上書き'],
  'toast.saved': ['已保存', 'Saved', '保存しました'],
  'menu.new': ['新建文档', 'New document', '新規ドキュメント'],
  'menu.saveAs': ['另存为…', 'Save as…', '名前を付けて保存…'],
  'menu.rename': ['重命名…', 'Rename…', '名前を変更…'],
  'menu.delete': ['删除', 'Delete', '削除'],
  'dlg.ok': ['确定', 'OK', 'OK'],
  'dlg.newTitle': ['新建文档', 'New document', '新規ドキュメント'],
  'dlg.newSub': ['在已打开的文件夹下新建;可带子目录,如 notes/idea.md', 'Created under the open folder; subfolders allowed, e.g. notes/idea.md', '開いているフォルダ配下に作成。サブフォルダ可(例 notes/idea.md)'],
  'dlg.renameTitle': ['重命名', 'Rename', '名前を変更'],
  'dlg.renameSub': ['相对库根的路径,可连目录一起改', 'Path relative to the library root; folders allowed too', 'ライブラリ根部からの相対パス(フォルダ変更も可)'],
  'dlg.deleteTitle': ['删除这个文件?', 'Delete this file?', 'このファイルを削除しますか?'],
  'dlg.deleteSub': ['{name} 会移入系统回收站,可恢复', '{name} goes to the Recycle Bin and can be restored', '{name} はゴミ箱へ移動(復元可)'],
  'toast.created': ['已新建并进入编辑', 'Created — editing', '作成しました(編集モード)'],
  'toast.createFail': ['新建失败:', 'Create failed: ', '作成に失敗: '],
  'toast.saveAs': ['已另存为 {name}', 'Saved as {name}', '{name} として保存しました'],
  'toast.saveAsDirty': ['已另存为新文件;原文档的修改仍未保存', 'Saved as a new file — the original still has unsaved changes', '別名保存しました(元の変更は未保存)'],
  'toast.saveFail': ['保存失败:', 'Save failed: ', '保存に失敗: '],
  'toast.renamed': ['已重命名', 'Renamed', '名前を変更しました'],
  'toast.renameFail': ['重命名失败:', 'Rename failed: ', '名前の変更に失敗: '],
  'toast.deleted': ['已移入回收站', 'Moved to Recycle Bin', 'ゴミ箱へ移動しました'],
  'toast.deleteFail': ['删除失败:', 'Delete failed: ', '削除に失敗: '],
  'toast.needRoot': ['先打开一个文件夹', 'Open a folder first', '先にフォルダを開いてください'],
  'toast.noDoc': ['还没有打开文档', 'No document open', 'ドキュメントが開かれていません'],
  'toast.renameOutOfRoot': ['这个文件不在已登记的文件夹内,暂不支持重命名', 'Not inside a registered folder — rename unavailable', '登録フォルダ外のファイルは名前変更できません'],
  'toast.deleteOutOfRoot': ['这个文件不在已登记的文件夹内,请在资源管理器里删', 'Not inside a registered folder — delete it in Explorer', '登録フォルダ外はエクスプローラーで削除してください'],
  'upd.row': ['自动更新', 'Updates', '自動更新'],
  'upd.rowDesc': ['从官方发布取新版,在应用内下载并安装', 'Fetch, download and install inside the app', '公式リリースから取得し、アプリ内で導入します'],
  'upd.check': ['检查更新', 'Check now', '更新を確認'],
  'upd.checking': ['检查中…', 'Checking…', '確認中…'],
  'upd.latest': ['已是最新版本', 'Up to date', '最新版です'],
  'upd.available': ['发现新版 {v}', 'Version {v} available', '新しいバージョン {v}'],
  'upd.title': ['发现新版本 {v}', 'Version {v} is available', '新しいバージョン {v} があります'],
  'upd.sub': ['大小约 {size} MB。下载后先校验 SHA-256,再静默安装并重启到新版。', 'About {size} MB. It verifies SHA-256, installs silently, then restarts into the new version.', '約 {size} MB。SHA-256 検証後にサイレントインストールして再起動します。'],
  'upd.install': ['下载并安装', 'Download and install', 'ダウンロードして導入'],
  'upd.later': ['稍后', 'Later', '後で'],
  'upd.skip': ['跳过此版本', 'Skip this version', 'このバージョンをスキップ'],
  'upd.downloading': ['下载中 {p}%', 'Downloading {p}%', 'ダウンロード中 {p}%'],
  'upd.installing': ['正在安装,应用即将重启…', 'Installing — the app will restart…', 'インストール中。まもなく再起動します…'],
  'upd.byebye': ['正在退出以完成安装…', 'Closing to finish the update…', '更新のため終了します…'],
  'upd.fail': ['更新失败:', 'Update failed: ', '更新に失敗: '],
  'search.hitsFiles': ['{f} 个文件 · {n} 处命中', '{n} hits in {f} files', '{f} ファイル / {n} 件'],
  'search.rows': ['{n} 处', '{n} hits', '{n} 件'],
  'toast.copyFail': ['复制失败,请手动选择', 'Copy failed', 'コピーに失敗しました'],
  'toast.watchOn': ['已开始监听外部修改', 'Watching for external changes', '外部変更を監視中'],
  'code.copy': ['复制整块代码', 'Copy code', 'コードをコピー'],
};
const I18N_TARGETS = [
  ['#tbFile', 'menu.file', 'title'], ['#tbEdit', 'menu.edit', 'title'], ['#tbView', 'menu.view', 'title'],
  ['#tbDoc', 'menu.doc', 'title'], ['#btnTheme', 'menu.theme', 'title'], ['#btnSettings', 'menu.settings', 'title'],
  ['#btnGlass', 'menu.glass', 'title'], ['#btnSide', 'menu.side', 'title'],
  ['#btnOpenFolder span', 'file.openFolder'], ['#btnOpenFile span', 'file.openFile'],
  ['#btnNewDoc span', 'file.new'], ['#btnSaveAs span', 'file.saveAs'], ['#btnRenameDoc span', 'file.rename'], ['#btnDeleteDoc span', 'file.delete'],
  ['#btnExportHtml span', 'file.exportHtml'], ['#btnExportPdf span', 'file.exportPdf'], ['#btnPrint span', 'file.print'],
  ['#btnUndo span', 'edit.undo'], ['#btnRedo span', 'edit.redo'], ['#btnEdit span', 'edit.edit'], ['#btnRefresh span', 'edit.refresh'],
  ['#btnTree span', 'view.tree'], ['#btnToc span', 'view.toc'], ['#btnMap span', 'view.map'], ['#btnFindLib span', 'view.search'],
  ['#btnFindDoc span', 'view.find'], ['#btnFocus span', 'view.focus'], ['#btnZen span', 'view.zen'],
  ['#btnSideToggle span', 'view.hideSide'], ['#btnCompact span', 'view.compact'],
  ['#btnFavDoc span', 'doc.fav'], ['#menuDoc .drawer-title:first-of-type', 'doc.recent'], ['#menuDoc .drawer-title:last-of-type', 'doc.favs'],
  ['#readerEmpty h2', 'empty.title'], ['#readerEmpty > p:nth-of-type(1)', 'empty.sub'],
  ['#emptyOpenFolder', 'empty.openFolder'], ['#emptyOpenFile', 'empty.openFile'], ['#readerEmpty .empty-hint', 'empty.hint'],
  ['#sideEmpty', 'side.emptyHtml', 'html'], ['#sideBottom .side-bottom-head > span:first-child', 'side.recent'],
  ['#findInput', 'find.placeholder', 'placeholder'], ['#findPrev', 'find.prev', 'title'], ['#findNext', 'find.next', 'title'], ['#findClose', 'find.close', 'title'],
  ['#settingsPanel .settings-header span', 'settings.title'], ['#glassPanel .settings-header span', 'glass.title'],
  ['.setpage-nav-item[data-target="sec-read"]', 'nav.read'], ['.setpage-nav-item[data-target="sec-enhance"]', 'nav.enhance'],
  ['.setpage-nav-item[data-target="sec-theme"]', 'nav.theme'], ['.setpage-nav-item[data-target="sec-glass"]', 'nav.glass'],
  ['.setpage-nav-item[data-target="sec-file"]', 'nav.file'], ['.setpage-nav-item[data-target="sec-keys"]', 'nav.keys'],
  ['.setpage-nav-item[data-target="sec-about"]', 'nav.about'],
  ['#sec-read .set-section-title', 'nav.read', 'text'], ['#sec-enhance .set-section-title', 'nav.enhance', 'text'],
  ['#sec-theme .set-section-title', 'nav.theme', 'text'], ['#sec-glass .set-section-title', 'nav.glass', 'text'],
  ['#sec-file .set-section-title', 'nav.file', 'text'], ['#sec-keys .set-section-title', 'nav.keys', 'text'],
  ['#sec-about .set-section-title', 'nav.about', 'text'],
  ['#setCodeStyleWash', 's.theme.csWash', 'text'], ['#setCodeStyleUnderline', 's.theme.csUnderline', 'text'],
  ['#setCodeStyleBare', 's.theme.csBare', 'text'], ['#setCodeStylePlate', 's.theme.csPlate', 'text'],
  ['#sec-read .set-row-title', ['s.read.preset', 's.read.font', 's.read.measure', 's.read.lineH', 's.read.toolbar', 's.read.side']],
  ['#sec-enhance .set-row-title', ['s.enh.typewriter', 's.enh.focus', 's.enh.zen', 's.enh.codeLn']],
  ['#sec-theme .set-row-title', ['s.theme.theme', 's.theme.codeStyle', 's.theme.palette', 's.theme.lang']],
  ['#sec-glass .set-row-title', ['s.glass.glass', 's.glass.floor', 's.glass.sys']],
  ['#sec-file .set-row-title', ['s.file.assoc', 's.file.current', 's.file.export']],
  ['#sec-about .set-row-title', ['s.about.ver', 's.about.design']],
];
function currentLang() {
  const l = String(S.lang || (navigator.language || 'zh')).slice(0, 2).toLowerCase();
  return LANGS.includes(l) ? l : 'zh';
}
function t(key, vars) {
  const row = I18N[key];
  let s = row ? row[Math.max(0, LANGS.indexOf(currentLang()))] : key;
  if (vars) Object.keys(vars).forEach((k) => { s = s.split('{' + k + '}').join(String(vars[k])); });
  return s;
}
function applyI18n() {
  const lang = currentLang();
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : lang;
  I18N_TARGETS.forEach(([sel, key, mode]) => {
    if (Array.isArray(key)) {
      $qa(sel).forEach((el, i) => { if (key[i]) el.textContent = t(key[i]); });
      return;
    }
    const list = $qa(sel);
    list.forEach((el) => {
      if (mode === 'title' || mode === 'placeholder') el.setAttribute(mode, t(key));
      else if (mode === 'html') el.innerHTML = t(key).split('|').join('<br/>');
      else if (mode === 'text') {
        const svg = el.querySelector('svg');
        el.textContent = '';
        if (svg) { el.appendChild(svg); el.appendChild(document.createTextNode(' ')); }
        el.appendChild(document.createTextNode(t(key)));
      } else el.textContent = t(key);
    });
  });
  const LANG_BTN = { zh: 'langZh', en: 'langEn', ja: 'langJa' };
  LANGS.forEach((l) => $id(LANG_BTN[l])?.classList.toggle('active', lang === l));
  const zh = $id('langZh'); if (zh) zh.textContent = '中文';
}
function setLang(l) {
  if (!LANGS.includes(l)) return;
  S.lang = l; LS.set('sr_lang', l);
  applyI18n();
  renderSide();
  applySystemEffects();
}

/* ---------------- 脚注(独立于 marked,零依赖) ---------------- */
const escHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function preprocessFootnotes(src) {
  const lines = String(src).split(/\r?\n/);
  const defs = [];
  const body = [];
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; body.push(line); continue; }
    if (!fence) {
      const m = /^\[\^([^\]\s]+)\]:[ \t]*(.*)$/.exec(line);
      if (m) {
        let text = m[2];
        let j = i + 1;
        while (j < lines.length && /^[ \t]{2,}\S/.test(lines[j])) { text += ' ' + lines[j].trim(); j++; }
        defs.push({ id: m[1], text });
        i = j - 1;
        continue;
      }
    }
    body.push(line);
  }
  if (!defs.length) return src;
  const num = new Map(defs.map((d, i) => [d.id, i + 1]));
  let fence2 = false;
  const text = body.map((line) => {
    if (/^\s*(```|~~~)/.test(line)) { fence2 = !fence2; return line; }
    if (fence2) return line;
    return line.replace(/\[\^([^\]\s]+)\]/g, (s, id) => (num.has(id)
      ? `<sup class="fn-ref" id="fnref-${num.get(id)}"><a href="#fn-${num.get(id)}">${num.get(id)}</a></sup>` : s));
  }).join('\n');
  const items = defs.map((d, i) => `<li id="fn-${i + 1}">${escHtml(d.text)} <a class="fn-back" href="#fnref-${i + 1}">↩</a></li>`).join('');
  return `${text}\n\n<section class="footnotes" data-footnotes="1"><ol>${items}</ol></section>\n`;
}

/* ---------------- 代码块:复制按钮 + 行号 ---------------- */
function addCodeLineNumbers(code) {
  const html = code.innerHTML;
  if (!html.includes('\n')) return;
  let open = [];
  const out = [];
  html.split('\n').forEach((line, idx) => {
    const prefix = open.map((c) => `<span class="${c}">`).join('');
    const opens = [...line.matchAll(/<span[^>]*>/g)].map((m) => {
      const cm = /class="([^"]*)"/.exec(m[0]);
      return cm ? cm[1] : '';
    });
    const closes = (line.match(/<\/span>/g) || []).length;
    const stack = open.concat(opens);
    for (let k = 0; k < closes; k++) stack.pop();
    const suffix = stack.length ? '</span>'.repeat(stack.length) : '';
    out.push(`<span class="code-line"><span class="ln">${idx + 1}</span>${prefix}${line}${suffix}</span>`);
    open = stack;
  });
  code.innerHTML = out.join('\n');
}
function enhanceCodeBlocks(root) {
  $qa('pre', root).forEach((pre) => {
    if (pre.parentElement && pre.parentElement.classList.contains('code-wrap')) return;
    const code = pre.querySelector('code');
    if (!code) return;
    const raw = code.innerText;             // 复制用原文,先取(加行号会污染 innerText)
    if (S.codeLn !== false) addCodeLineNumbers(code);
    const wrap = document.createElement('div');
    wrap.className = 'code-wrap';
    pre.parentNode.insertBefore(wrap, pre);
    wrap.appendChild(pre);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'code-copy';
    btn.title = t('code.copy');
    btn.innerHTML = '<svg class="ic sm"><use href="#i-copy"/></svg>';
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(raw);
        btn.classList.add('done');
        btn.innerHTML = '<svg class="ic sm"><use href="#i-check"/></svg>';
        setTimeout(() => { btn.classList.remove('done'); btn.innerHTML = '<svg class="ic sm"><use href="#i-copy"/></svg>'; }, 1400);
      } catch { toast(t('toast.copyFail')); }
    });
    wrap.appendChild(btn);
  });
}

/* ---------------- 文内查找(Ctrl+F) ---------------- */
function isFindOpen() { const f = $id('findBar'); return !!(f && !f.hidden); }
function openFind() {
  const f = $id('findBar'); if (!f) return;
  f.hidden = false;
  const inp = $id('findInput');
  if (inp) { inp.placeholder = t('find.placeholder'); inp.focus(); inp.select(); }
  if (inp && inp.value.trim()) runFind(inp.value);
}
function closeFind() {
  const f = $id('findBar'); if (f) f.hidden = true;
  clearFindMarks();
  S.find.hits = []; S.find.idx = -1; S.find.q = '';
  const c = $id('findCount'); if (c) c.textContent = '0/0';
}
function clearFindMarks() {
  const body = $q('.markdown-body'); if (!body) return;
  $qa('mark.srh-hit', body).forEach((mk) => {
    const parent = mk.parentNode;
    if (!parent) return;
    parent.replaceChild(document.createTextNode(mk.textContent), mk);
    parent.normalize();
  });
}
function runFind(q) {
  clearFindMarks();
  S.find.hits = []; S.find.idx = -1; S.find.q = q || '';
  const body = $q('.markdown-body');
  const count = $id('findCount');
  if (!body || !q || q.trim() === '') { if (count) count.textContent = '0/0'; return; }
  const lq = q.toLowerCase();
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      const p = n.parentElement;
      if (!p || p.closest('pre, code, script, style, .footnotes a.fn-back')) return NodeFilter.FILTER_REJECT;
      return n.nodeValue.toLowerCase().includes(lq) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  const marks = [];
  nodes.forEach((node) => {
    const text = node.nodeValue;
    const lower = text.toLowerCase();
    const frag = document.createDocumentFragment();
    let from = 0;
    let idx = lower.indexOf(lq, from);
    while (idx !== -1) {
      if (idx > from) frag.appendChild(document.createTextNode(text.slice(from, idx)));
      const mk = document.createElement('mark');
      mk.className = 'srh-hit';
      mk.textContent = text.slice(idx, idx + q.length);
      frag.appendChild(mk);
      marks.push(mk);
      from = idx + q.length;
      idx = lower.indexOf(lq, from);
    }
    if (from < text.length) frag.appendChild(document.createTextNode(text.slice(from)));
    if (marks.length && node.parentNode) node.parentNode.replaceChild(frag, node);
  });
  S.find.hits = marks;
  if (marks.length) gotoFind(0);
  else if (count) count.textContent = '0/0';
}
function gotoFind(i) {
  const hits = S.find.hits;
  const count = $id('findCount');
  if (!hits.length) { if (count) count.textContent = '0/0'; return; }
  const n = ((i % hits.length) + hits.length) % hits.length;
  hits.forEach((mk, k) => mk.classList.toggle('now', k === n));
  S.find.idx = n;
  if (count) count.textContent = (n + 1) + '/' + hits.length;
  try { hits[n].scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch { hits[n].scrollIntoView(); }
}
function findStep(d) { gotoFind((S.find.idx < 0 ? 0 : S.find.idx + d)); }

/* ---------------- 库级全文搜索 ---------------- */
function renderSearch(side) {
  const box = document.createElement('div');
  box.className = 'search-box';
  const inp = document.createElement('input');
  inp.type = 'text'; inp.className = 'set-text'; inp.id = 'libSearchInput';
  inp.placeholder = t('search.placeholder'); inp.autocomplete = 'off';
  inp.value = S.search.q || '';
  box.appendChild(inp);
  side.appendChild(box);
  const meta = document.createElement('div');
  meta.className = 'search-meta'; meta.id = 'libSearchMeta';
  side.appendChild(meta);
  const list = document.createElement('div');
  list.id = 'libSearchList';
  side.appendChild(list);
  let timer = 0;
  inp.addEventListener('input', () => {
    S.search.q = inp.value;
    clearTimeout(timer);
    timer = setTimeout(runLibrarySearch, 280);
  });
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { clearTimeout(timer); runLibrarySearch(); }
  });
  renderSearchResults();
  setTimeout(() => { try { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); } catch {} }, 30);
}
function renderSearchResults() {
  const meta = $id('libSearchMeta');
  const list = $id('libSearchList');
  if (!list) return;
  list.innerHTML = '';
  const hits = S.search.hits || [];
  // 按文件归组:后端已按相关度排好序,这里保持"首次出现的文件在前",组内按行号升序
  const groups = new Map();
  hits.forEach((h) => {
    const key = h.path || h.rel || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(h);
  });
  if (meta) {
    meta.textContent = S.search.q
      ? (hits.length ? t('search.hitsFiles', { f: groups.size, n: hits.length }) : t('search.none'))
      : t('search.hint');
  }
  groups.forEach((rows, key) => {
    rows.sort((a, b) => (a.line || 0) - (b.line || 0));
    const head = document.createElement('div');
    head.className = 'search-file';
    const name = String(key).split(/[\\/]/).pop();
    const count = document.createElement('span');
    count.className = 'sh-count';
    count.textContent = t('search.rows', { n: rows.length });
    head.appendChild(document.createTextNode(name));
    head.appendChild(count);
    list.appendChild(head);
    rows.forEach((h) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'search-hit';
      const nm = document.createElement('div');
      nm.className = 'sh-name';
      const ln = document.createElement('span');
      ln.className = 'sh-line'; ln.textContent = 'L' + (h.line || 0);
      nm.appendChild(ln);
      const p = document.createElement('div');
      p.className = 'sh-path'; p.textContent = h.rel || h.path;
      const sn = document.createElement('div');
      sn.className = 'sh-snippet'; sn.textContent = (h.text || '').trim();
      b.appendChild(nm); b.appendChild(p); b.appendChild(sn);
      b.addEventListener('click', () => jumpToHit(h));
      list.appendChild(b);
    });
  });
}
async function runLibrarySearch() {
  const q = String(S.search.q || '').trim();
  const meta = $id('libSearchMeta');
  if (!invoke) return;
  if (!q) { S.search.hits = []; renderSearchResults(); return; }
  if (meta) meta.textContent = t('sys.reading');
  try {
    const hits = await invoke('search_library', { query: q, limit: 200 });
    S.search.hits = Array.isArray(hits) ? hits : [];
  } catch (e) {
    S.search.hits = [];
    if (meta) meta.textContent = String(trErr(e));
    return;
  }
  if (String(S.search.q).trim() !== q) return;   // 过期结果丢弃
  renderSearchResults();
}
async function jumpToHit(h) {
  await openExternal(h.path);
  setTimeout(() => {
    openFind();
    const inp = $id('findInput');
    if (inp) { inp.value = S.search.q; runFind(S.search.q); }
  }, 420);
}

/* ---------------- 专注 / 无干扰 ---------------- */
function setFocusMode(on) {
  S.focusMode = !!on;
  LS.set('sr_focus', S.focusMode);
  applyEnhance();
}
function setZenMode(on) {
  S.zen = !!on;
  applyEnhance();
  if (S.zen) toast(t('toast.watchOn') && 'F11 / Esc 退出无干扰');
}
function bindFocusTracking() {
  const reader = $id('reader');
  if (!reader) return;
  reader.addEventListener('mousemove', (e) => {
    if (!S.focusMode) return;
    const el = e.target instanceof Element ? e.target.closest('.markdown-body > *') : null;
    $qa('.markdown-body > .focus-now').forEach((n) => { if (n !== el) n.classList.remove('focus-now'); });
    if (el && !el.classList.contains('focus-now')) el.classList.add('focus-now');
  });
}

/* ---------------- 导出 HTML / 打印 ---------------- */
async function readAssetText(url) {
  try { const r = await fetch(url); return r.ok ? await r.text() : ''; } catch { return ''; }
}
function assetUrlToLocalPath(src) {
  const m = /^(?:https?:\/\/asset\.localhost\/|asset:\/\/localhost\/)(.*)$/i.exec(src || '');
  if (!m) return null;
  let p = m[1];
  try { p = decodeURIComponent(p); } catch { /* 原样 */ }
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
  return p.replace(/\//g, '\\');
}
function relativize(fromDir, abs) {
  const a = fromDir.replace(/[\\/]+$/, '').toLowerCase();
  const b = abs.toLowerCase();
  if (b.startsWith(a + '\\')) return abs.slice(fromDir.replace(/[\\/]+$/, '').length + 1).replace(/\\/g, '/');
  return null;
}
async function buildStandaloneHtml() {
  const cur = getTab(S.cur && S.cur.abs);   // S.cur 是**对象**({abs,raw}),不是路径:直接传进去恒 undefined(2026-10-25 修)
  if (!cur) return null;
  const inner = $id('readerInner');
  const clone = inner.cloneNode(true);
  $qa('mark.srh-hit', clone).forEach((mk) => { mk.parentNode.replaceChild(document.createTextNode(mk.textContent), mk); });
  $qa('.code-copy', clone).forEach((b) => b.remove());
  $qa('.code-line .ln', clone).forEach((n) => n.remove());
  const docDir = String(cur.abs || '').replace(/[\\/][^\\/]*$/, '');
  // 媒体:优先**内联成 data: URI**(导出物自包含,换台机器/发给别人也看得到图);
  // 单张过大或读失败就退回相对路径(宁可图丢链,也不让导出物变成几十 MB)
  let inlined = 0;
  for (const el of $qa('img,video,source', clone)) {
    const src = el.getAttribute('src') || '';
    const p = assetUrlToLocalPath(src);
    if (!p) continue;
    const data = await inlineLocalMedia(p);
    if (data) { el.setAttribute('src', data); inlined += 1; continue; }
    const rel = relativize(docDir, p);
    el.setAttribute('src', rel || 'file:///' + p.replace(/\\/g, '/'));
  }
  const css = [await readAssetText('app.css'), await readAssetText('vendor/katex.min.css'), await readAssetText('vendor/hljs-atom-one-dark.min.css')].join('\n');
  const fallback = 'html,body{background:#1d2021;color:#ebdbb2;font:16px/1.7 system-ui,"Microsoft YaHei UI",sans-serif;margin:0}main{max-width:34em;margin:0 auto;padding:40px 24px}pre{background:#282828;padding:12px;border-radius:6px;overflow:auto}table{border-collapse:collapse}th,td{border:1px solid #3c3836;padding:6px 12px}img{max-width:100%}';
  const theme = currentLang() && document.body.dataset.theme === 'light' ? 'light' : 'dark';
  const html = `<!DOCTYPE html>
<html lang="${document.documentElement.lang}" data-theme="${theme}" data-palette="${document.documentElement.dataset.palette || 'gruvbox'}">
<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${escHtml((cur.abs || '').split(/[\\/]/).pop() || 'TMMD')}</title>
<style>${css || fallback}
body{background:transparent}main.reader-inner{max-width:var(--measure,34em)}
:root{--halo-k:0}
@media print{@page{margin:18mm}:root,[data-theme="light"]{--text-halo:none;--title-halo:none}body{background:#fff;color:#111}}
</style></head>
<body class="${document.body.className}"><main class="reader-inner">${clone.innerHTML}</main></body></html>`;
  return { html, inlined };
}
/* 单张媒体内联上限:超过就退回相对路径(6MB base64 后约 8MB,再多导出物就不好用了) */
const MEDIA_INLINE_MAX = 6 * 1024 * 1024;
function mimeOfLocal(p) {
  const e = String(p).toLowerCase().split('.').pop();
  return ({
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    svg: 'image/svg+xml', bmp: 'image/bmp', avif: 'image/avif', ico: 'image/x-icon',
    mp4: 'video/mp4', webm: 'video/webm', ogg: 'video/ogg',
  })[e] || 'application/octet-stream';
}
/* 用 asset 协议把本地文件读成字节 → data: URI。任何一步失败都返回 null(调用方退回相对路径)。 */
async function inlineLocalMedia(localPath) {
  try {
    const core = window.__TAURI__ && window.__TAURI__.core;
    if (!core || typeof core.convertFileSrc !== 'function') return null;
    const resp = await fetch(core.convertFileSrc(localPath));
    if (!resp || !resp.ok) return null;
    const buf = new Uint8Array(await resp.arrayBuffer());
    if (!buf.length || buf.length > MEDIA_INLINE_MAX) return null;
    let bin = '';
    for (let i = 0; i < buf.length; i += 8192) {
      bin += String.fromCharCode.apply(null, buf.subarray(i, i + 8192));
    }
    return 'data:' + mimeOfLocal(localPath) + ';base64,' + btoa(bin);
  } catch { return null; }
}
async function exportCurrentHtml() {
  const cur = getTab(S.cur && S.cur.abs);
  if (!cur) { toast(t('empty.title')); return null; }
  const built = await buildStandaloneHtml();
  if (!built) return null;
  const out = String(cur.abs).replace(/\.(md|markdown|mdx|html|htm|txt)$/i, '') + '.export.html';
  try {
    const p = await invoke('export_file', { path: out, content: built.html });
    const target = p || out;
    toast(built.inlined
      ? t('toast.exportedInline', { p: target, n: built.inlined })
      : t('toast.exported', { p: target }));
    return target;
  } catch (e) {
    toast(t('toast.exportFail', { e: trErr(e) }));
    return null;
  }
}
/* PDF 直出:导出 HTML(含图片内联)→ 无头 Edge 打成 PDF → 打开。失败给可读原因,不弹系统框。 */
async function exportCurrentPdf() {
  const cur = getTab(S.cur && S.cur.abs);
  if (!cur) { toast(t('empty.title')); return; }
  toast(t('pdf.working'));
  const htmlPath = await exportCurrentHtml();
  if (!htmlPath) return;
  const pdfPath = String(htmlPath).replace(/\.html?$/i, '') + '.pdf';
  try {
    const p = await invoke('export_pdf', { htmlPath, pdfPath });
    toast(t('pdf.done', { p }));
    try { await invoke('open_any', { path: p }); } catch { /* 打不开就只是没自动打开,路径已给 */ }
  } catch (e) {
    toast(t('pdf.fail', { e: trErr(e) }));
  }
}
async function printCurrent() {
  const p = await exportCurrentHtml();
  if (!p) return;
  try { await invoke('open_any', { path: p }); } catch (e) { toast(String(trErr(e))); }
}

/* ---------------- 系统透明效果回落 ---------------- */
async function applySystemEffects() {
  if (!invoke) return;
  let st = null;
  try { st = await invoke('system_effects_state'); } catch { return; }
  const disable = !!st && (st.transparency_enabled === false || st.high_contrast === true);
  S.sysNoEffects = disable;
  document.body.classList.toggle('no-effects', disable);
  const txt = disable ? (st.high_contrast ? t('sys.hc') : t('sys.transOff')) : t('sys.ok');
  [$id('glassSysState'), $id('glassSysStateSet')].forEach((el) => { if (el) el.textContent = txt; });
  applyGlass(false);
  applyGlassMaterial(true);
}

/* ---------------- 外部文件变更监听 ---------------- */
async function syncWatch() {
  if (!invoke) return;
  // 2026-10-25 修:v1.7.0 起这里传的是 S.cur(**对象**),而 getTab 按字符串 abs 查 → 恒 undefined
  // → 每次都以 null 调 watch_file → 后端直接 return,外部变更监听**从未生效**(与 README 里的承诺不符)。
  const cur = getTab(S.cur && S.cur.abs);
  try { await invoke('watch_file', { path: cur ? cur.abs : null }); } catch { /* 后端未支持则静默 */ }
}
async function onFsChanged(p) {
  const tab = getTab(p);
  if (!tab) return;
  // 自己刚写完也会收到一次回声(native rename 命中监听)→ 1.5s 窗口内忽略,避免假提示与多余重读
  const quietUntil = Math.max(tab.lastFs || 0, tab.selfWriteAt || 0);
  if (Date.now() - quietUntil < 1500) return;
  tab.lastFs = Date.now();
  // 同上:别拿 S.cur(对象)跟路径字符串比,恒假会让"编辑中保护"和"自动重载"两条分支全部失效。
  const isCur = !!(S.cur && normPath(S.cur.abs) === normPath(p));
  if (isCur && S.editing) { toast(t('toast.fsEditing')); return; }
  if (isCur) { await refreshCurrent(); toast(t('toast.fsReloaded')); return; }
  if (tab.editing) { toast(t('toast.fsEditing')); return; }
  // 后台标签:不假装"已重载",打个 stale 标,切过去时由 activateTab 重读。
  tab.stale = true;
  toast(t('toast.fsStale'));
}

/* ---------------- v1.7 绑定 ---------------- */
function initV17() {
  applyI18n();
  applyEnhance();
  bindFocusTracking();
  const on = (sel, ev, fn) => { const el = $id(sel); if (el) el.addEventListener(ev, fn); };
  // 视图 / 模式
  on('btnFindLib', 'click', () => setView('search'));
  on('btnFindDoc', 'click', () => openFind());
  on('btnFocus', 'click', () => setFocusMode(!S.focusMode));
  on('btnZen', 'click', () => setZenMode(!S.zen));
  on('setFocusOn', 'click', () => setFocusMode(true));
  on('setFocusOff', 'click', () => setFocusMode(false));
  on('setZenOn', 'click', () => setZenMode(true));
  on('setZenOff', 'click', () => setZenMode(false));
  on('setCodeLnOn', 'click', () => { S.codeLn = true; LS.set('sr_code_ln', true); applyEnhance(); if (S.cur) refreshCurrent(); });
  on('setCodeLnOff', 'click', () => { S.codeLn = false; LS.set('sr_code_ln', false); applyEnhance(); if (S.cur) refreshCurrent(); });
  /* 行内代码样式:纯 CSS 档位,不用重渲染(applyEnhance 换 body 类即可) */
  for (const m of ['wash', 'underline', 'bare', 'plate']) {
    on('setCodeStyle' + m[0].toUpperCase() + m.slice(1), 'click', () => { S.codeStyle = m; LS.set('sr_code_style', m); applyEnhance(); });
  }
  // 排版
  on('setBodySans', 'click', () => { S.bodyFont = 'sans'; LS.set('sr_body_font', 'sans'); applyTypography(); });
  on('setBodyMono', 'click', () => { S.bodyFont = 'mono'; LS.set('sr_body_font', 'mono'); applyTypography(); });
  on('setMeasure', 'input', (e) => { S.measure = Number(e.target.value); LS.set('sr_measure', S.measure); applyTypography(); });
  on('setLineH', 'input', (e) => { S.lineH = Number(e.target.value); LS.set('sr_line_h', S.lineH); applyTypography(); });
  // 语言
  on('langZh', 'click', () => setLang('zh'));
  on('langEn', 'click', () => setLang('en'));
  on('langJa', 'click', () => setLang('ja'));
  // 导出
  on('btnExportHtml', 'click', () => { closeDrawersSafe(); exportCurrentHtml(); });
  on('btnExportPdf', 'click', () => { closeDrawersSafe(); exportCurrentPdf(); });
  on('setExportHtml', 'click', () => exportCurrentHtml());
  on('btnPrint', 'click', () => { closeDrawersSafe(); printCurrent(); });
  on('setPrintDoc', 'click', () => printCurrent());
  // 查找栏
  const fi = $id('findInput');
  if (fi) {
    fi.addEventListener('input', () => runFind(fi.value));
    fi.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); findStep(e.shiftKey ? -1 : 1); }
    });
  }
  on('findNext', 'click', () => findStep(1));
  on('findPrev', 'click', () => findStep(-1));
  on('findClose', 'click', () => closeFind());
  // 全局快捷键:只在非编辑态生效(Ctrl+F/F11/F3/Esc)
  document.addEventListener('keydown', (e) => {
    const k = (e.key || '').toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'f' && !e.shiftKey) {
      if (S.editing) return; // 编辑态留给原生
      e.preventDefault(); openFind(); return;
    }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && k === 'f') { e.preventDefault(); setFocusMode(!S.focusMode); return; }
    if (k === 'f11') { e.preventDefault(); setZenMode(!S.zen); return; }
    if (k === 'f3') { e.preventDefault(); if (!isFindOpen()) openFind(); else findStep(e.shiftKey ? -1 : 1); return; }
    if (k === 'escape') {
      if (isFindOpen()) { closeFind(); return; }
      if (S.zen) { setZenMode(false); return; }
    }
  });
  // 外部变更监听(后端支持则生效)
  try {
    if (listen) listen('fs-changed', (e) => { const p = e && e.payload; if (typeof p === 'string') onFsChanged(p); });
  } catch { /* 非 Tauri 环境 */ }
  syncWatch();
  applySystemEffects();
  // 标签切走/切回时重挂监听目标
  const _renderTabs = renderTabs;
  renderTabs = function () { const r = _renderTabs.apply(this, arguments); try { syncWatch(); } catch {} return r; };
}
function closeDrawersSafe() { try { closeDrawers(); } catch { /* 忽略 */ } }
