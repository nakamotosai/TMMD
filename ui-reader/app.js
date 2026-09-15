/* Sai Reader · 轻量本地 Markdown 阅读器（Tauri 2）
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
let prevEditValue = '';
let lastHistT = 0;
let histLock = false; // doUndo/doRedo 编程赋值期间抑制 input 记史
// resize 防抖计时器（重排工具栏溢出；曾用于透明窗合成层 hack，见 wire 内注释）
const resizeTimer = { _t: 0 };
const PALETTES = {
  dark: ['gruvbox', 'github-dark', 'monokai', 'solarized-dark', 'tokyonight'],
  light: ['gruvbox', 'github-light', 'solarized-light'],
};
const SWATCH_COLORS = {
  'gruvbox': '#fe8019', 'github-dark': '#58a6ff', 'github-light': '#0366d6',
  'monokai': '#a6e22e', 'solarized-dark': '#268bd2', 'solarized-light': '#268bd2', 'tokyonight': '#7aa2f7',
};

const S = {
  roots: LS.get('sr_roots', []),
  recent: LS.get('sr_recent', []),
  favorites: LS.get('sr_favorites', []),
  theme: LS.get('sr_theme', 'dark'),
  palette: LS.get('sr_palette', 'gruvbox'),
  h1Size: LS.get('sr_h1', 1.75),
  bodySize: LS.get('sr_body', 16),
  codeSize: LS.get('sr_code', 14),
  sideW: LS.get('sr_side_w', 260),
  sideCollapsed: LS.get('sr_side_col', false),
  toolbarMode: LS.get('sr_tb_mode', 'icon'),
  // W7 玻璃默认值（Pebrel 路线，真屏 30/40/55/45 定稿）：底 30 / 铬 40 / 正文 55 / 浮层 45。
  // 旧存档（仅 chrome/reader/pop、无 base）直接丢弃，用新默认（W7 迁移一次）。
  glass: (() => { const d = { on: true, base: 30, chrome: 40, reader: 55, pop: 45 }; const g = LS.get('sr_glass', null); return (g && typeof g === 'object' && 'base' in g) ? g : d; })(),
  aiEndpoint: LS.raw('sr_ai_endpoint') || 'http://100.86.60.101:8317',
  aiKey: LS.raw('sr_ai_key') || '',
  aiModel: LS.raw('sr_ai_model') || 'minimaxai/minimax-m3',
  root: null,
  cur: null,
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
  body.innerHTML = marked.parse(md.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n/, ''));
  CURRENT_ABS = null;
  sanitize(body);
  highlightCode(body);
  renderMath(body);
  fixMediaSrc(body);
  wireImgFallback(body);
  S.toc = buildToc(body);
  inner.innerHTML = '';
  inner.appendChild(body);
  const name = absParam ? absParam.split(/[\\/]/).pop() : '';
  document.title = name ? name + ' · Sai Reader' : 'Sai Reader';
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
  insertChapterCards(body);
  if (S.view === 'toc' || S.view === 'map') renderSide();
}

function rememberScroll() {
  if (S.cur && S.cur.abs) LS.str('sr_scr_' + S.cur.abs, $id('reader').scrollTop);
}

/* ==================== 刷新 / 编辑 ==================== */
function confirmLeaveEdit() {
  if (S.editing && S.editDirty) {
    return window.confirm('当前编辑有未保存的修改，放弃修改继续吗？');
  }
  return true;
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
  if (!S.cur) return toast('还没有打开文档');
  rememberScroll();
  const ed = $id('editor');
  if (!ed) return;
  ed.value = S.cur.raw != null ? S.cur.raw : '';
  editHist.undo.length = 0;
  editHist.redo.length = 0;
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
  lastHistT = now;
  editHist.redo.length = 0;
  syncHistBtns();
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
  } finally { histLock = false; }
  syncHistBtns();
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
  } finally { histLock = false; }
  syncHistBtns();
}
async function saveEdit() {
  if (!S.cur || !S.editing) return;
  const content = $id('editor').value;
  try {
    if (S.cur.relPos) await invoke('write_text', { root: S.root.rootPath, rel: S.cur.relPos, content });
    else await invoke('save_path', { path: S.cur.abs, content });
    S.cur.raw = content;
    S.editDirty = false;
    renderMarkdown(content, S.cur.abs);   // 恢复进入编辑前的滚动位置
    leaveEdit();
    toast('已保存');
    refreshTreeOrder();
  } catch (e) { toast('保存失败：' + ((e && e.message) || e)); }
}
async function refreshCurrent() {
  if (!S.cur) return toast('还没有打开文档');
  if (!confirmLeaveEdit()) return;
  leaveEdit();
  rememberScroll();
  try {
    const md = S.cur.relPos
      ? await invoke('read_text', { root: S.root.rootPath, rel: S.cur.relPos })
      : await invoke('open_path', { path: S.cur.abs });
    S.cur.raw = md;
    renderMarkdown(md, S.cur.abs);
    toast('已刷新');
  } catch (e) { toast('刷新失败：' + ((e && e.message) || e)); }
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

/* ==================== 打开文件 ==================== */
async function openExternal(abs) {
  if (!confirmLeaveEdit()) return;
  leaveEdit();
  try {
    const md = await invoke('open_path', { path: abs });
    S.cur = { abs, raw: md };
    renderMarkdown(md, abs);
    pushRecent(abs);
    await scanSiblingTree(abs);   // 扫描所在目录的 md 文件
    setView('toc');
  } catch (e) { toast('打开失败：' + ((e && e.message) || e)); }
}
async function openInRoot(rel) {
  const root = S.root;
  if (!root || !root.scan || !root.rootPath) return toast('请先打开文件夹');
  if (!confirmLeaveEdit()) return;
  leaveEdit();
  try {
    const md = await invoke('read_text', { root: root.rootPath, rel });
    const abs = root.rootPath.split('/').join('\\') + '\\' + rel.split('/').join('\\');
    S.cur = { abs, relPos: rel, raw: md };
    renderMarkdown(md, abs);
    pushRecent(abs);
    markActive(rel);
    setView('toc');
  } catch (e) { toast('读取失败：' + ((e && e.message) || e)); }
}
function fileName(p) { return p.split(/[\\/]/).pop(); }
function pushRecent(abs) {
  S.recent = S.recent.filter((r) => r !== abs);
  S.recent.unshift(abs);
  if (S.recent.length > 40) S.recent.length = 40;
  LS.set('sr_recent', S.recent);
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
    toast('已取消收藏');
  } else {
    S.favorites = S.favorites.filter((f) => f !== abs);
    S.favorites.unshift(abs);
    if (S.favorites.length > 200) S.favorites.length = 200;
    toast('已收藏');
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
}

/* ==================== 侧栏 ==================== */
function renderSide() {
  const side = $id('sideBody');
  side.innerHTML = '';
  $id('sideEmpty').hidden = true;
  $id('btnBackToTree').hidden = (S.view !== 'toc' && S.view !== 'map');
  if (S.view === 'toc') { renderToc(side); return; }
  if (S.view === 'map') { renderMap(side); return; }
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
    it.textContent = h.text;
    it.onclick = () => { const el = document.getElementById(h.id); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
    list.appendChild(it);
  });
  side.appendChild(list);
}
const VIEW_BTNS = ['btnTree', 'btnToc', 'btnMap'];
function setView(v) {
  S.view = v;
  VIEW_BTNS.forEach((id) => { const b = $id(id); if (b) b.classList.toggle('active', id === ({ tree: 'btnTree', toc: 'btnToc', map: 'btnMap' }[v])); });
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

function cardStoreKey() {
  const abs = (S.cur && S.cur.abs) || '';
  let h = 0;
  for (let i = 0; i < abs.length; i++) h = (h * 31 + abs.charCodeAt(i)) >>> 0;
  return 'sr_cards_' + h.toString(36);
}
function cardStore() {
  return LS.get(cardStoreKey(), null);
}
function cardStoreValid(store) {
  const sig = String((S.cur && S.cur.raw || '').length) + ':' + ((S.cur && S.cur.raw || '').slice(0, 64));
  return store && store.sig === sig ? store : null;
}
function getCachedCard(idx) {
  const st = cardStoreValid(cardStore());
  return st && st.cards && st.cards[idx] ? st.cards[idx] : null;
}
function setCachedCard(idx, card) {
  const sig = String((S.cur && S.cur.raw || '').length) + ':' + ((S.cur && S.cur.raw || '').slice(0, 64));
  const st = cardStoreValid(cardStore()) || { sig, cards: {} };
  st.sig = sig; st.cards[idx] = card;
  LS.set(cardStoreKey(), st);
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

/* 在每个章节标题下挂一张折叠导读卡 */
function insertChapterCards(body) {
  const chs = chapterList();
  chs.forEach((h, idx) => {
    const el = document.getElementById(h.id);
    if (!el) return;
    const card = document.createElement('div');
    card.className = 'ch-card';
    card.dataset.ch = String(idx);
    card.innerHTML =
      '<div class="ch-card-head"><svg class="ic"><use href="#i-card"/></svg><span class="ch-t">本章导读卡</span><span class="ch-hint"></span></div>' +
      '<div class="ch-card-body" hidden></div>';
    const head = card.querySelector('.ch-card-head');
    const hint = card.querySelector('.ch-hint');
    const bd = card.querySelector('.ch-card-body');
    function refreshHint() {
      hint.textContent = getCachedCard(idx) ? '已缓存✓ 点我展开' : '点击生成';
    }
    refreshHint();
    head.addEventListener('click', async () => {
      const opening = bd.hidden;
      bd.hidden = !bd.hidden;
      if (!opening) return;
      let data = getCachedCard(idx);
      if (!data) {
        bd.innerHTML = '<div class="ch-card-loading">正在请 AI 读这一章并做卡片…</div>';
        data = await genChapterCard(idx);
        if (data) { setCachedCard(idx, data); updateMapFlags(); }
      }
      if (data) renderCardInto(bd, data);
      else bd.innerHTML = '<div class="ch-card-error">生成失败：请在 设置 → AI 导读卡 里填网关与 Key 后重试。</div>';
      refreshHint();
    });
    el.insertAdjacentElement('afterend', card);
  });
}

/* 卡片渲染 */
function renderCardInto(bd, d) {
  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const judges = Array.isArray(d.judgments) ? d.judgments : [];
  bd.innerHTML =
    '<div class="ch-card-summary">' + esc(d.summary) + '</div>' +
    '<div class="ch-card-sec-t">三个判断</div>' +
    '<ol class="ch-card-judges">' + judges.slice(0, 3).map((j) => '<li>' + esc(j) + '</li>').join('') + '</ol>' +
    (d.counter ? '<div class="ch-card-sec-t">反常识</div><div class="ch-card-counter">' + esc(d.counter) + '</div>' : '') +
    (d.action ? '<div class="ch-card-sec-t">下一步动作</div><div class="ch-card-action">' + esc(d.action) + '</div>' : '') +
    (d.quote ? '<div class="ch-card-quote">「' + esc(d.quote) + '」</div>' : '');
}

/* 调 AI 网关生成卡片 */
async function genChapterCard(idx) {
  const chs = chapterList();
  const h = chs[idx];
  const text = chapterText(idx);
  if (!text.trim()) return null;
  const ep = (S.aiEndpoint || '').replace(/\/+$/, '');
  if (!ep || !S.aiKey) return null;
  const prompt =
    '你在为一篇知识库文章做章节导读卡。基于下面这一章的原文，输出严格 JSON（不要多余文字、不要用 markdown 代码块包裹）：\n' +
    '{"summary":"一句话总结本章（30字内）","judgments":["本章最重要的三个判断/结论，每条一句","",""],"counter":"本章里最反常识或最容易被忽略的一点","action":"读者读完本章最该做的下一步动作","quote":"从原文挑一句最有力的话（可修剪）"}\n\n' +
    '【章节标题】' + h.text + '\n【章节原文】\n' + text;
  try {
    const res = await fetch(ep + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + S.aiKey },
      body: JSON.stringify({
        model: S.aiModel || 'moonshotai/kimi-k3',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 2048,
      }),
    });
    if (!res.ok) return null;
    const j = await res.json();
    const raw = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const d = JSON.parse(m[0]);
    if (!d.summary || !Array.isArray(d.judgments)) return null;
    return d;
  } catch { return null; }
}

/* 一键生成本文全部章节卡 */
async function genAllCards(btn) {
  const chs = chapterList();
  if (!chs.length) return;
  btn.disabled = true;
  for (let i = 0; i < chs.length; i++) {
    if (getCachedCard(i)) continue;
    btn.textContent = '生成中 ' + (i + 1) + '/' + chs.length + '…';
    const d = await genChapterCard(i);
    if (d) setCachedCard(i, d);
    updateMapFlags();
    await new Promise((r) => setTimeout(r, 300));
  }
  btn.textContent = '重新生成全部章节卡';
  btn.disabled = false;
  toast('章节卡生成完毕');
  // 刷新所有已展开状态提示
  $qa('.ch-card').forEach((c) => {
    const idx = +c.dataset.ch;
    const hint = c.querySelector('.ch-hint');
    const bd = c.querySelector('.ch-card-body');
    if (hint) hint.textContent = getCachedCard(idx) ? '已缓存✓ 点我展开' : '点击生成';
    if (bd && !bd.hidden && getCachedCard(idx) && !bd.querySelector(':scope > div:not(.ch-card-error)')) {
      renderCardInto(bd, getCachedCard(idx));
    }
  });
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
  const act = document.createElement('div');
  act.className = 'map-actions';
  const genBtn = document.createElement('button');
  genBtn.className = 'map-gen-all';
  genBtn.textContent = '一键生成全部章节卡';
  genBtn.addEventListener('click', () => genAllCards(genBtn));
  act.appendChild(genBtn);
  side.appendChild(act);
  const list = document.createElement('div');
  list.className = 'map-list';
  chs.forEach((h, i) => {
    const n = document.createElement('div');
    n.className = 'map-node';
    n.dataset.ch = String(i);
    n.innerHTML =
      '<div class="map-dot">' + (i + 1) + '</div>' +
      '<div class="map-meta"><div class="map-name"></div>' +
      '<div class="map-sub"><span>约 ' + Math.max(1, Math.round(lens[i] / 400)) + ' 分钟</span><span class="map-card-flag"></span></div></div>';
    n.querySelector('.map-name').textContent = h.text;
    n.addEventListener('click', () => {
      const el = document.getElementById(h.id);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    list.appendChild(n);
  });
  side.appendChild(list);
  updateMapFlags();
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
function updateMapFlags() {
  $qa('#side .map-node').forEach((n) => {
    const i = +n.dataset.ch;
    const f = n.querySelector('.map-card-flag');
    if (f) f.textContent = getCachedCard(i) ? '✦ 有卡' : '';
  });
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

/* ==================== 工具栏双模式 + 溢出进 ⋮ 抽屉 ==================== */
function applyToolbarMode() {
  document.body.classList.toggle('tb-icon', S.toolbarMode === 'icon');
  document.body.classList.toggle('tb-text', S.toolbarMode === 'text');
  const bi = $id('setTbIcon'); if (bi) bi.classList.toggle('active', S.toolbarMode === 'icon');
  const bt = $id('setTbText'); if (bt) bt.classList.toggle('active', S.toolbarMode === 'text');
  layoutToolbar();
}
function tbFits(extra) {
  const bar = $id('actions');
  const moreBtn = $id('tbMore');
  if (!bar) return true;
  let w = 0;
  Array.from(bar.children).forEach((c) => {
    if (c === moreBtn) return; // 溢出目标自身不计入可用宽度（防自举：tbMore 一旦可见就撑爆判定）
    w += c.offsetWidth + 5;
  });
  if (extra) w += extra.offsetWidth + 5;
  return w <= bar.clientWidth;
}
function layoutToolbar() {
  const bar = $id('actions');
  const moreBtn = $id('tbMore');
  const box = $id('docMore');
  if (!bar || !moreBtn || !box) return;
  // 归还：空间足够时按序把溢出按钮移回 ⋮ 前
  while (box.firstChild && tbFits(box.firstChild)) bar.insertBefore(box.firstChild, moreBtn);
  // 溢出：从右往左把放不下的按钮挪进 ⋮ 抽屉（prepend 保持原顺序）
  let guard = 0;
  while (!tbFits(null) && guard++ < 20) {
    const els = Array.from(bar.children).filter((c) => c.dataset.overflow === '1');
    if (!els.length) break;
    box.prepend(els[els.length - 1]);
  }
  moreBtn.hidden = !box.children.length;
  if (drawerOpen === 'menuMore' && !box.children.length) closeDrawers();
}

/* ==================== 拖放（Tauri webview 事件拿磁盘路径） ==================== */
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
        const paths = (p.paths || []).filter((x) => /\.(md|markdown)$/i.test(x));
        if (paths.length) openExternal(paths[0]);
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
      .filter((f) => /\.(md|markdown)$/i.test(f.name))
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
  const sw = $id('setSideWidth'); if (sw) { sw.value = w; $id('valSideWidth').textContent = w + 'px'; }
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
  const si1 = $id('setH1Size'); if (si1) { si1.value = S.h1Size; $id('valH1Size').textContent = S.h1Size.toFixed(2) + 'em'; }
  const sb = $id('setBodySize'); if (sb) { sb.value = S.bodySize; $id('valBodySize').textContent = S.bodySize + 'px'; }
  const sc = $id('setCodeSize'); if (sc) { sc.value = S.codeSize; $id('valCodeSize').textContent = S.codeSize + 'px'; }
  $id('setThemeDark')?.classList.toggle('active', S.theme === 'dark');
  $id('setThemeLight')?.classList.toggle('active', S.theme === 'light');
  // 主题图标 sun/moon 切换
  const tf = $q('#btnTheme use'); if (tf) tf.setAttribute('href', S.theme === 'dark' ? '#i-moon' : '#i-sun');
}
/* W3 玻璃质感：把 S.glass 落到 --glass-* 三路上。opaque=true 强制全不透明
 *（开机首帧用，避开透明窗冷启动合成坑）；平时走存储值，即时生效。 */
function applyGlass(opaque) {
  if (!S.glass || typeof S.glass !== 'object') S.glass = {};
  const on = opaque ? false : S.glass.on !== false;
  const num = (v, d, lo, hi) => { v = Number(v); if (!Number.isFinite(v)) v = d; return Math.min(hi, Math.max(lo, v)); };
  // W6 默认走 Pebrel 路线，真屏 30/40/55/45 定稿。
  // 底色是见壁纸的总开关——它 100% 时上层再透也只透出实色底（W5 教训）。
  const base = num(S.glass.base, 30, 25, 100);
  const chrome = num(S.glass.chrome, 40, 35, 100);
  const reader = num(S.glass.reader, 55, 50, 100);
  const pop = num(S.glass.pop, 45, 35, 100);
  const root = document.documentElement.style;
  root.setProperty('--glass-base', (on ? base : 100) + '%');
  root.setProperty('--glass-chrome', (on ? chrome : 100) + '%');
  root.setProperty('--glass-reader', (on ? reader : 100) + '%');
  root.setProperty('--glass-pop', (on ? pop : 100) + '%');
  // 面板控件回显（面板关闭时节点仍在，?. 守无）
  $id('setGlassOn')?.classList.toggle('active', on);
  $id('setGlassOff')?.classList.toggle('active', !on);
  const gb = $id('setGlassBase'); if (gb) { gb.value = base; $id('valGlassBase').textContent = base + '%'; }
  const gc = $id('setGlassChrome'); if (gc) { gc.value = chrome; $id('valGlassChrome').textContent = chrome + '%'; }
  const gr = $id('setGlassReader'); if (gr) { gr.value = reader; $id('valGlassReader').textContent = reader + '%'; }
  const gp = $id('setGlassPop'); if (gp) { gp.value = pop; $id('valGlassPop').textContent = pop + '%'; }
}
function renderPaletteSwatches() {
  const box = $id('paletteSwatches');
  if (!box) return;
  box.innerHTML = '';
  (PALETTES[S.theme] || []).forEach((p) => {
    const sw = document.createElement('div');
    sw.className = 'swatch' + (S.palette === p ? ' active' : '');
    sw.style.background = SWATCH_COLORS[p] || 'var(--accent)';
    sw.textContent = p.slice(0, 3);
    sw.title = p;
    sw.onclick = () => { S.palette = p; LS.set('sr_palette', p); applySettings(); renderPaletteSwatches(); };
    box.appendChild(sw);
  });
}
function bindSettings() {
  $id('btnSettings')?.addEventListener('click', () => {
    const p = $id('settingsPanel');
    p.hidden = !p.hidden;
    if (!p.hidden) { applySettings(); renderPaletteSwatches(); applyGlass(false); }
  });
  $id('btnSettingsClose')?.addEventListener('click', () => { $id('settingsPanel').hidden = true; });
  $id('setH1Size')?.addEventListener('input', (e) => { S.h1Size = +e.target.value; $id('valH1Size').textContent = S.h1Size.toFixed(2) + 'em'; LS.set('sr_h1', S.h1Size); applySettings(); });
  $id('setBodySize')?.addEventListener('input', (e) => { S.bodySize = +e.target.value; $id('valBodySize').textContent = S.bodySize + 'px'; LS.set('sr_body', S.bodySize); applySettings(); });
  $id('setCodeSize')?.addEventListener('input', (e) => { S.codeSize = +e.target.value; $id('valCodeSize').textContent = S.codeSize + 'px'; LS.set('sr_code', S.codeSize); applySettings(); });
  $id('setSideWidth')?.addEventListener('input', (e) => { applySideWidth(+e.target.value); });
  $id('setThemeDark')?.addEventListener('click', () => { S.theme = 'dark'; LS.set('sr_theme', 'dark'); applySettings(); renderPaletteSwatches(); });
  $id('setThemeLight')?.addEventListener('click', () => { S.theme = 'light'; LS.set('sr_theme', 'light'); applySettings(); renderPaletteSwatches(); });
  // AI 导读卡设置
  const aiEp = $id('setAiEndpoint'); if (aiEp) { aiEp.value = S.aiEndpoint; aiEp.addEventListener('change', () => { S.aiEndpoint = aiEp.value.trim(); LS.str('sr_ai_endpoint', S.aiEndpoint); }); }
  const aiKey = $id('setAiKey'); if (aiKey) { aiKey.value = S.aiKey; aiKey.addEventListener('change', () => { S.aiKey = aiKey.value.trim(); LS.str('sr_ai_key', S.aiKey); }); }
  const aiModel = $id('setAiModel'); if (aiModel) { aiModel.value = S.aiModel; aiModel.addEventListener('change', () => { S.aiModel = aiModel.value.trim(); LS.str('sr_ai_model', S.aiModel); }); }
  // 玻璃质感：开关 + 三路不透明度，拖动即时生效并持久化
  const glassOn = () => { if (!S.glass || typeof S.glass !== 'object') S.glass = {}; return S.glass; };
  $id('setGlassOn')?.addEventListener('click', () => { glassOn().on = true; LS.set('sr_glass', S.glass); applyGlass(false); });
  $id('setGlassOff')?.addEventListener('click', () => { glassOn().on = false; LS.set('sr_glass', S.glass); applyGlass(false); });
  $id('setGlassBase')?.addEventListener('input', (e) => { glassOn().base = +e.target.value; LS.set('sr_glass', S.glass); applyGlass(false); });
  $id('setGlassChrome')?.addEventListener('input', (e) => { glassOn().chrome = +e.target.value; LS.set('sr_glass', S.glass); applyGlass(false); });
  $id('setGlassReader')?.addEventListener('input', (e) => { glassOn().reader = +e.target.value; LS.set('sr_glass', S.glass); applyGlass(false); });
  $id('setGlassPop')?.addEventListener('input', (e) => { glassOn().pop = +e.target.value; LS.set('sr_glass', S.glass); applyGlass(false); });
}

/* ==================== 启动 ==================== */
function toast(msg) {
  const t = $id('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 2600);
}
function installDragEnterNative() {
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
}
async function onOpenFolder() {
  const p = await invoke('pick_folder').catch(() => null);
  if (!p) return toast('未选择文件夹');
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
  } catch (e) { toast('读取目录失败：' + ((e && e.message) || e)); }
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
  $id('btnEdit')?.addEventListener('click', () => { if (!S.cur) return; if (S.editing) saveEdit(); else enterEdit(); });
  $id('btnUndo')?.addEventListener('click', () => { if (S.editing) doUndo(); });
  $id('btnRedo')?.addEventListener('click', () => { if (S.editing) doRedo(); });
  $id('editor')?.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = e.key.toLowerCase();
    if (k === 'z') { e.preventDefault(); if (e.shiftKey) doRedo(); else doUndo(); }
    else if (k === 'y') { e.preventDefault(); doRedo(); }
  });
  $id('editor')?.addEventListener('input', () => {
    if (histLock) return; // doUndo/doRedo 编程赋值不记历史（防栈污染/弹跳）
    S.editDirty = true; pushUndo(prevEditValue); prevEditValue = $id('editor').value;
  });
  $id('btnSideToggle').addEventListener('click', () => applySideCollapsed(!S.sideCollapsed));
  // 下拉抽屉：触发按钮 + 点击外部/Escape 关闭
  $qa('[data-drawer]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); openDrawer(b.dataset.drawer, b); }));
  document.addEventListener('click', (e) => {
    if (e.target.closest('.menu-item')) { closeDrawers(); return; }
    if (!drawerOpen) return;
    if (e.target.closest('.drawer') || e.target.closest('[data-drawer]')) return;
    closeDrawers();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawers(); });
  $id('setTbIcon')?.addEventListener('click', () => { S.toolbarMode = 'icon'; LS.set('sr_tb_mode', 'icon'); applyToolbarMode(); });
  $id('setTbText')?.addEventListener('click', () => { S.toolbarMode = 'text'; LS.set('sr_tb_mode', 'text'); applyToolbarMode(); });
  $id('reader').addEventListener('scroll', () => {
    clearTimeout(rememberScroll._t);
    rememberScroll._t = setTimeout(() => { rememberScroll(); highlightCurrentToc(); }, 120);
  });
  bindDragDrop();
  installDragEnterNative();
  bindWinCtrl();
  bindWindowDrag();
  bindSideResizer();
  bindSettings();
  // resize 结束后重排工具栏溢出（纯 layoutToolbar，不做 opacity 合成层 hack——
  // 透明窗时代该 hack 轻触合成层强制刷新；实色窗（transparent:false）下它反而
  // 触发 WebView2 合成层损坏：正文/按钮大面积不绘制，只剩旧帧残影，2026-08-05 实证）
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer._t);
    resizeTimer._t = setTimeout(layoutToolbar, 120);
  });
}

async function boot() {
  // 顶栏版本号：Tauri 桌面环境取包版本；浏览器预览降级为空
  const bv = $id('brandVer');
  if (bv) {
    try {
      const v = await window.__TAURI__.app.getVersion();
      if (v) bv.textContent = 'v' + v;
    } catch { /* 非 Tauri 环境 */ }
  }
  applySettings();
  renderPaletteSwatches();
  applySideWidth(S.sideW);
  applySideCollapsed(S.sideCollapsed);
  applyToolbarMode();
  wire();
  // W3 开机延迟应用：首帧先全不透明（避开透明窗冷启动合成坑），450ms 后再落用户玻璃值
  applyGlass(true);
  setTimeout(() => applyGlass(false), 450);
  // 字体加载会改变按钮宽度，加载完成后重排溢出
  setTimeout(layoutToolbar, 300);
  window.addEventListener('load', layoutToolbar);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => layoutToolbar());
  if (!invoke) { toast('请通过 Sai Reader 桌面应用打开'); return; }
  S.roots = await invoke('load_roots').catch(() => []);
  if (S.roots.length) await loadRoot(S.roots[0]);
  if (listen) {
    try { listen('open-file', (e) => { if (e && typeof e.payload === 'string') openExternal(e.payload); }); } catch {}
  }
  try {
    const pending = await invoke('pending_open');
    if (pending && typeof pending === 'string') openExternal(pending);
  } catch {}
}
document.addEventListener('DOMContentLoaded', boot);
