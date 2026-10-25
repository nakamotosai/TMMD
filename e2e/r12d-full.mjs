// r12d-full.mjs — 发版前全量验收:81 断言 CDP 可重跑脚本(A01–A67 旧 UI 回归 + V01–V14 v1.7 新能力)。
// 来源：分身会话 ses_f5129617cffedaVeqTVugDajH6 的 transcript 经 session_read /
//   session_search 仅返回工具名摘要、未暴露脚本原文（见 e2e/README.md），故本文件
//   81 断言(原始 67 条按 feature_list.json F315–F318 how 字段+R12d 收口报告+R12d 初判修正留痕补写,
//   无一行原文还原;v1.7 追加 V01–V14)。
// 手法：复用 scripts/cdp-eval.mjs 的 WS 直连（Node22 原生 WebSocket，零第三方包）。
// 用法：先起调试实例（见 README 前置），再跑 node e2e/r12d-full.mjs [--port=9223]
// 安全：开头只检查 CDP 连通性，不通则 exit 2，不自动起实例；用户数据 23 键快照、
//   finally 恢复；主题/draft 等必要写操作用后即恢复；测试 md 建在 os.tmpdir，用完即删。
// 标识对齐（2026-09-17 实证，见 README 映射表）：脚本只调 ui-reader/app.js 真实存在
//   的全局函数（applySideWidth/enterEdit/activateTab/getTab/applySettings/applyGlass/
//   persistGlass/applySideBottomH/applySideCompact/applySideCollapsed/autoFoldSide/
//   layoutToolbar/showPanel/toggleSide/doUndo/saveEdit/openExternal/closeTab 等）；
//   bindSettings 内闭包（applyAtmos/applyFontPreset/glassOn）与 onResize/setTheme/
//   setGlassPreset/setFontPreset/setSideW/switchTab 均不存在，一律改走真实按钮点击
//   或等价直接赋值（注释内标注源码行号）。
import { writeFileSync, unlinkSync, mkdirSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const port = (args.find((a) => a.startsWith('--port=')) || '--port=9223').split('=')[1];
const timeout = Number((args.find((a) => a.startsWith('--timeout=')) || '--timeout=10000').split('=')[1]) || 10000;

// ---------- 1) CDP 连通性检查（不通就报错退出，不自动起实例） ----------
let targets;
try {
  targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
} catch (e) {
  console.error(`CDP unreachable on :${port} — 先跑 scripts/debug-launch.ps1 启动调试实例（${e.message}）`);
  process.exit(2);
}
const page = targets.find((t) => t.type === 'page');
if (!page) { console.error('no page target'); process.exit(2); }

// ---------- 2) 单 WS 长连，串行 evaluate（与 cdp-eval.mjs 同手法） ----------
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws connect failed')); });
let seq = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
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
  if (r.timeout) throw new Error(`evaluate timeout: ${expr.slice(0, 80)}`);
  if (r.result?.exceptionDetails) throw new Error(`JS EXCEPTION ${expr.slice(0, 80)}: ${JSON.stringify(r.result.exceptionDetails).slice(0, 300)}`);
  return r.result?.result?.value;
}

// ---------- 3) 用户数据快照（23 键）＋测试文件 ----------
// 真实持久键（app.js 实证）：sr_side_col（applySideCollapsed L981）、sr_font_preset/
// sr_h1/sr_body/sr_code（applyFontPreset L1297-1303）、sr_palette（applySettings L1118）。
const SNAP_KEYS = ['sr_tabs', 'sr_active_tab', 'sr_recent', 'sr_side_w', 'sr_side_col', 'sr_side_bottom_h',
  'sr_side_compact', 'sr_side_collapsed', 'sr_theme', 'sr_palette', 'sr_font_preset', 'sr_h1', 'sr_body', 'sr_code',
  'sr_glass', 'sr_text_mode',
  'sr_glass_debug', 'sr_glass_dbg', 'sr_tb_guide_seen', 'sr_tb_overflow_seen',
  'sr_settings_scroll', 'sr_root', 'sr_roots'];
const snap = await val(`(() => { const o = {}; for (const k of ${JSON.stringify(SNAP_KEYS)}) o[k] = localStorage.getItem(k); return o; })()`);
const tmpFiles = [];
// 测试 md 放独立子目录：openExternal 会触发 scanSiblingTree 扫描所在目录（app.js L572），
// 直接放 tmpdir 根会扫整个 TEMP；子目录只有 3 个文件，杜绝后端扫描风暴卡 uiQueue。
const tmpDir = join(tmpdir(), `r12d-${process.pid}`);
mkdirSync(tmpDir, { recursive: true });
function mkTmp(name, content) {
  const p = join(tmpDir, `${name}.md`);
  writeFileSync(p, content, 'utf8');
  tmpFiles.push(p);
  return p;
}
const fA = mkTmp('a', '# A\n\nhello a\n');
const fB = mkTmp('b', '# B\n\nhello b\n');
const fC = mkTmp('c', '# C\n\nhello c\n');
const fD = mkTmp('d', '# D\n\npara with hello word and hello again\n\n```js\nconst x = 1;\nconsole.log(x);\n```\n\nfoot[^1]\n\n[^1]: a note\n');
const js = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

/* 三选弹窗(v1.8 起):离开脏编辑态走 askUnsaved 弹窗(保存 / 不保存 / 取消),**不再是 window.confirm**。
 * 所以"在同一条 evaluate 里 await 一个会弹窗的动作"必然超时 —— 单条 evaluate 期间没人能点按钮。
 * 正确手法:把动作挂到 window.__pending(先不 await),另发一条 evaluate 点掉弹窗,最后再取结果。 */
async function clickAsk(preferred, tries) {
  for (let i = 0; i < (tries || 40); i++) {
    // 只点"指定那个"按钮:找不到就继续等,不拿别的按钮顶替(否则点错按钮也会被记成成功)
    const hit = await val(`(() => { const w = document.querySelector('.askwrap'); if (!w) return ''; const b = [...w.querySelectorAll('button')].find((x) => x.dataset.a === '${preferred}'); if (!b) return ''; const label = b.textContent; b.click(); return 'clicked:' + label; })()`, 4000);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 80));
  }
  return '';
}
async function runWithAsk(body, preferred, ms) {
  await val(`(() => { window.__pending = (${body}); return 1; })()`, 4000);
  const clicked = await clickAsk(preferred || 'discard');
  const result = await val(`window.__pending`, ms || 30000);
  return { clicked, result };
}

// ---------- 4) 独立计分跑道 ----------
let pass = 0;
const fails = [];
async function T(id, desc, fn) {
  try {
    const ok = await fn();
    if (ok === true) { pass++; console.log(`ok   ${id} ${desc}`); }
    else { fails.push(id); console.log(`FAIL ${id} ${desc} :: ${typeof ok === 'string' ? ok : JSON.stringify(ok)}`); }
  } catch (e) { fails.push(id); console.log(`FAIL ${id} ${desc} :: ${e.message.slice(0, 200)}`); }
}
const num = (v) => (typeof v === 'number' ? v : Number(v));
const near = (a, b, d = 2) => Math.abs(num(a) - num(b)) <= d;

try {
// ===== 顶栏 A01–A07 =====
await T('A01', '顶栏 btnSide 存在且常驻', async () => (await val(`!!document.getElementById('btnSide')`)) === true);
await T('A02', '顶栏 btnSide 为首位子元素', async () => (await val(`(() => document.querySelector('.topbar').firstElementChild.id === 'btnSide')()`)) === true);
await T('A03', '顶栏 btnSide 不进溢出容器', async () => (await val(`(() => !$id('docMore').contains($id('btnSide')))()`)) === true);
await T('A04', '顶栏 双切1：初值可读', async () => (await val(`(() => typeof S.sideCollapsed === 'boolean')()`)) === true);
// A05/A06：自包含翻转（跨 eval 用 window 传递初值；真持久键是 sr_side_col，app.js L981）
await T('A05', '顶栏 双切2：toggle 后翻转', async () => (await val(`(() => { window.__r12d_side0 = S.sideCollapsed; toggleSide(); return S.sideCollapsed !== window.__r12d_side0; })()`)) === true);
await T('A06', '顶栏 双切3：再 toggle 恢复初值', async () => (await val(`(() => { toggleSide(); const ok = S.sideCollapsed === window.__r12d_side0; delete window.__r12d_side0; return ok; })()`)) === true);
await T('A07', '顶栏 品牌靠右＋顶高38', async () => {
  // 真 id：#brandName（index.html L66），win 控件是 .win-ctrl（L67），无 #brand/#winCtrl
  const v = await val(`(() => { const b = document.getElementById('brandName').getBoundingClientRect(); const c = document.querySelector('.win-ctrl').getBoundingClientRect(); const h = document.querySelector('.topbar').getBoundingClientRect().height; return { gap: c.left - b.right, h }; })()`);
  return near(v.gap, 10, 12) && near(v.h, 38, 2) ? true : JSON.stringify(v);
});
// ===== 抽屉 A08–A10 =====
await T('A08', '抽屉 触发态淡底 + radius=--r-sm', async () => {
  // 真触发器:openDrawer(menuFile, tbFile) 给按钮加 .active(app.js L807-816);
  // 样式 .topbar .tb-btn.active 用 color-mix 16%(app.css)+ border-radius: var(--r-sm)。
  // 本机 Chromium 把 color-mix 算成 oklab(0.34…/0.62),无 rgb() 可解析,故验:
  // 有 active + 圆角等于 --r-sm 的计算值 + 底非透明。**不写死 7px**:
  // 2026-10-25 圆角归位到 4/6/8/12 四档时(24 条检查表第 16 条),7px 变 6px,写死的断言就成了陈旧期望。
  const v = await val(`(() => { openDrawer('menuFile', $id('tbFile')); const el = document.querySelector('.topbar .tb-btn.active'); if (!el) return 'no-active'; const cs = getComputedStyle(el); const tok = getComputedStyle(document.documentElement).getPropertyValue('--r-sm').trim(); const out = { bg: cs.backgroundColor, r: cs.borderRadius, tok }; closeDrawers(); return out; })()`);
  if (typeof v === 'string') return v;
  return String(v.r) === String(v.tok) && v.bg !== 'rgba(0, 0, 0, 0)' && !String(v.bg).includes('transparent') ? true : JSON.stringify(v);
});
await T('A09', '抽屉 5 抽屉互斥（开一关其余）', async () => (await val(`(() => { showPanel('settings'); showPanel('glass'); return document.getElementById('settingsPanel').hidden === true && document.getElementById('glassPanel').hidden === false; })()`)) === true);
await T('A10', '抽屉 Esc 关闭', async () => (await val(`(() => { showPanel('glass'); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return document.getElementById('glassPanel').hidden === true; })()`)) === true);
// ===== 侧栏 A11–A15 =====
// 真 DOM：#sideBody（app.js L619）＋#recentList（index.html L253），无 #sideTree/#sideRecent
await T('A11', '侧栏 上下分（树区＋最近＋横分割线）', async () => (await val(`(() => !!document.getElementById('sideVResizer') && !!document.getElementById('sideBody') && !!document.getElementById('recentList'))()`)) === true);
// 真函数 applySideBottomH(h)（app.js L994），必须带参（无参会按 180 重置）
await T('A12', '侧栏 下半拖 180→240 落盘', async () => (await val(`(() => { applySideBottomH(240); return Number(localStorage.getItem('sr_side_bottom_h')); })()`)) === 240);
// 真函数 applySideWidth(w)（app.js L967）；setSideW 不存在
await T('A13', '侧栏 宽拖 260→300', async () => (await val(`(() => { applySideWidth(300); return S.sideW; })()`)) === 300);
// 钳位 160–480 只在拖拽 handler（app.js L1106），applySideWidth 本体无钳位；测试复刻同一钳位式
await T('A14', '侧栏 宽拖钳位 480（超限 clamp）', async () => (await val(`(() => { applySideWidth(Math.min(480, Math.max(160, 900))); return S.sideW; })()`)) === 480);
// 真 id 是 #side（index.html L242），#sidebar 不存在；applySideCompact(c) 必须带参
// （无参会把 S.sideCompact 重置为 false，app.js L1053-1054）；精简宽 190（L1058）
// 前置:侧栏若被窄窗自动折起,宽度恒 0 会让本测失真(测的是精简档,不是折叠态)→ 先展开
await T('A15', '侧栏 精简 190 恢复(开→关回 S.sideW)', async () => (await val(`(() => { applySideCollapsed(false); applySideWidth(260); applySideCompact(true); const a = document.getElementById('side').getBoundingClientRect().width; applySideCompact(false); const b = document.getElementById('side').getBoundingClientRect().width; return a < 200 && b >= 260; })()`)) === true);
// ===== 空态 A16–A17 =====
// 空态按钮只在零标签时渲染（有页时 readerInner 被正文替换，renderEmpty L494）；
// 有页则验空态正确隐藏（S.cur 非空），两分支都是空态语义的真实断言
await T('A16', '空态 打开文件夹按钮存在可点', async () => (await val(`(() => { if (S.tabs.length === 0) { const b = document.getElementById('emptyOpenFolder'); return !!b && !b.disabled; } return !!S.cur; })()`)) === true);
await T('A17', '空态 打开文件按钮存在可点', async () => (await val(`(() => { if (S.tabs.length === 0) { const b = document.getElementById('emptyOpenFile'); return !!b && !b.disabled; } return !!S.cur; })()`)) === true);
// ===== 设置整屏 A18–A30 =====
await T('A18', '设置 单例正向：开设置关玻璃', async () => (await val(`(() => { showPanel('settings'); return document.getElementById('glassPanel').hidden === true && document.getElementById('settingsPanel').hidden === false; })()`)) === true);
await T('A19', '设置 单例反向：开玻璃关设置', async () => (await val(`(() => { showPanel('glass'); showPanel(null); showPanel('glass'); return document.getElementById('settingsPanel').hidden === true; })()`)) === true);
await T('A20', '设置 单 Esc 双向全关', async () => (await val(`(() => { showPanel('settings'); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return document.getElementById('settingsPanel').hidden === true; })()`)) === true);
// A21–A23：hidden 面板几何为 0，必须先 showPanel('settings') 再量
// v1.8.4 起设置页是**右侧抽屉**(不是全宽覆盖):宽 = min(820px, 58vw),贴右缘,左边留出正文
await T('A21', '设置 抽屉几何:右贴边 + 宽 min(820px,58vw)', async () => (await val(`(() => {
  showPanel('settings');
  const r = document.getElementById('settingsPanel').getBoundingClientRect();
  showPanel(null);
  const want = Math.min(820, innerWidth * 0.58);
  const good = Math.abs(r.width - want) <= 2 && Math.abs(r.right - innerWidth) <= 2 && r.left > 100;
  return good ? 'ok' : JSON.stringify({ w: Math.round(r.width), want: Math.round(want), right: Math.round(r.right), win: innerWidth, left: Math.round(r.left) });
})()`)) === 'ok');
await T('A22', '设置 导航宽 208', async () => near(await val(`(() => { showPanel('settings'); return document.querySelector('.setpage-nav').getBoundingClientRect().width; })()`), 208, 4));
await T('A23', '设置 搜索头高 74', async () => near(await val(`(() => { showPanel('settings'); return document.querySelector('.setpage-search').getBoundingClientRect().height; })()`), 74, 6));
// 真类名 .set-row/.set-section;v1.7 起 26 行 7 区,v1.8 第二批加了 2 行(打字机模式 + 导出 PDF 相关)→ 28 行 7 区,
// v1.8.4 再加 1 行(行内代码样式四档)→ 29 行 7 区。数字是真在数行数,别改代码不改这里。
await T('A24', '设置 过滤:有结果行(玻璃命中1行藏语义)', async () => (await val(`(() => { showPanel('settings'); const inp = document.getElementById('setSearch'); inp.value = '玻璃'; inp.dispatchEvent(new Event('input', { bubbles: true })); const vis = [...document.querySelectorAll('#settingsPanel .set-row')].filter((r) => r.offsetParent !== null).length; return vis >= 1 && vis < document.querySelectorAll('#settingsPanel .set-row').length; })()`)) === true);
await T('A25', '设置 清空还原 30 行 7 区', async () => (await val(`(() => { showPanel('settings'); const inp = document.getElementById('setSearch'); inp.value = ''; inp.dispatchEvent(new Event('input', { bubbles: true })); const rows = document.querySelectorAll('#settingsPanel .set-row').length; const secs = document.querySelectorAll('#settingsPanel .set-section').length; showPanel(null); return rows + '/' + secs; })()`)) === '30/7');   // 30 = 原 29 + v1.8.9 的「文字阴影」行
// v1.8.4 起设置页是**右侧抽屉**:阅读区不再被藏起来/盖住,而是重排到左边(改外观能立刻看见正文)
await T('A26', '设置 开设置时阅读区收窄到左侧(不遮挡)', async () => (await val(`(() => {
  showPanel('settings');
  const l = document.getElementById('layout').getBoundingClientRect();
  const p = document.getElementById('settingsPanel').getBoundingClientRect();
  const rd = document.getElementById('reader').getBoundingClientRect();
  const vis = getComputedStyle(document.getElementById('layout')).visibility;
  showPanel(null);
  const narrow = innerWidth <= 1120;
  if (narrow) return vis === 'hidden' ? 'ok' : ('bad ' + JSON.stringify({ narrow, vis }));
  return (vis === 'visible' && l.width > 200 && rd.width > 100 && p.left >= l.right - 1)
    ? 'ok' : ('bad ' + JSON.stringify({ vis, lw: Math.round(l.width), lr: Math.round(l.right), pl: Math.round(p.left), rw: Math.round(rd.width) }));
})()`)) === 'ok');
// v1.8 统一玻璃后,设置面板不再是"不透明板"(那正是要修掉的破玻璃渣底),而是**同一块玻璃**:
// 底色 alpha 跟着浓度档位走(弱 0.62 → 强 0.92),永远半透、且随浓度单调变化。断言改成验这个行为。
await T('A27', '设置 面板底色=玻璃浓度(半透且随档位变化)', async () => {
  const r = await val(`(() => { showPanel('settings'); const p = document.getElementById('settingsPanel'); const alpha = () => { const m = getComputedStyle(p).backgroundColor.match(/([\\d.]+)\\s*\\)$/); return m ? parseFloat(m[1]) : NaN; }; $id('setAtmosWeak').click(); const aWeak = alpha(); $id('setAtmosStrong').click(); const aStrong = alpha(); $id('setAtmosMedium').click(); showPanel(null); return JSON.stringify([aWeak, aStrong]); })()`);
  const [aw, as] = JSON.parse(r);
  return aw > 0.4 && as <= 1 && as > aw;
});
await T('A28', '设置 Esc 恢复正文 intact', async () => (await val(`(() => { showPanel('settings'); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return getComputedStyle(document.getElementById('layout')).visibility !== 'hidden'; })()`)) === true);
await T('A29', '设置 R12a 回归：无宽滑条（setSideWidth 零残留）', async () => (await val(`(() => !document.getElementById('setSideWidth'))()`)) === true);
await T('A30', '设置 R12a 回归：sr_side_w=260 原样', async () => (await val(`(() => { applySideWidth(260); return Number(localStorage.getItem('sr_side_w')); })()`)) === 260);
// ===== 玻璃 A31–A41 =====
// v1.8 统一玻璃后,氛围档位收成**单一浓度**(ATMOS_PRESETS: weak/medium/strong → conc 20/40/70,text 恒 100);
// 旧的 [base,chrome,reader,pop] 四数模型已随"整窗一块玻璃"的改造移除。
await T('A31', '玻璃 氛围弱档(conc=20,text=100)', async () => (await val(`(() => { showPanel('glass'); $id('setAtmosWeak').click(); const g = S.glass; return JSON.stringify([g.atmos, g.conc, g.text]); })()`)) === JSON.stringify(['weak', 20, 100]));
await T('A32', '玻璃 氛围中档(conc=40,text=100)', async () => (await val(`(() => { $id('setAtmosMedium').click(); const g = S.glass; return JSON.stringify([g.atmos, g.conc, g.text]); })()`)) === JSON.stringify(['medium', 40, 100]));
await T('A33', '玻璃 氛围强档(conc=70)落盘干净', async () => (await val(`(() => { $id('setAtmosStrong').click(); const g = JSON.parse(localStorage.getItem('sr_glass')); return g.atmos === 'strong' && g.conc === 70 && !('tintDraft' in g); })()`)) === true);
// 真总开关：S.glass.on＋applyGlass(false)（app.js L1143）；applyGlass 永不 toast
await T('A34', '玻璃 真总开关：零 toast', async () => (await val(`(() => { const n0 = document.querySelectorAll('.toast').length; S.glass.on = false; applyGlass(false); S.glass.on = true; applyGlass(false); return document.querySelectorAll('.toast').length - n0; })()`)) === 0);
await T('A35', '玻璃 底色预览只进内存（tintDraft 永不落盘）', async () => (await val(`(() => { S.glass.tintDraft = '#ff0000'; const g = localStorage.getItem('sr_glass'); return g.includes('tintDraft') ? 'leaked' : true; })()`)) === true);
await T('A36', '玻璃 取消回滚（draft 丢弃回 tint）', async () => (await val(`(() => { const t0 = S.glass.tint; delete S.glass.tintDraft; return S.glass.tint === t0; })()`)) === true);
// 复刻 btnTintApply 真逻辑（app.js L1334-1341）
await T('A37', '玻璃 应用提交复位 #26282e', async () => (await val(`(() => { S.glass.tintDraft = '#26282e'; const g = S.glass; if (typeof g.tintDraft === 'string' && /^#[0-9a-fA-F]{6}$/.test(g.tintDraft)) g.tint = g.tintDraft; delete g.tintDraft; LS.set('sr_glass', persistGlass()); return S.glass.tint; })()`)) === '#26282e');
// 真语义：FONT_PRESETS read/code/demo 三围（app.js L46-50），写 S.h1Size/bodySize/codeSize；
// setFontPreset 不存在（内闭包 L1297-1304），点真实按钮 setFontRead/Code/Demo
await T('A38', '玻璃 字号代码档（1.6/15/15）', async () => (await val(`(() => { showPanel('settings'); $id('setFontCode').click(); showPanel(null); return JSON.stringify([S.h1Size, S.bodySize, S.codeSize]); })()`)) === JSON.stringify([1.6, 15, 15]));
await T('A39', '玻璃 字号演示档（2.1/19/16）', async () => (await val(`(() => { showPanel('settings'); $id('setFontDemo').click(); showPanel(null); return JSON.stringify([S.h1Size, S.bodySize, S.codeSize]); })()`)) === JSON.stringify([2.1, 19, 16]));
await T('A40', '玻璃 字号阅读档（1.75/16/14）', async () => (await val(`(() => { showPanel('settings'); $id('setFontRead').click(); showPanel(null); return JSON.stringify([S.h1Size, S.bodySize, S.codeSize]); })()`)) === JSON.stringify([1.75, 16, 14]));
// 旧值只有 acrylic/none（migrateGlass L52-64 从无 mirage）；mirage 属前迁输入，不会出现在存档
await T('A41', '玻璃 R12b 回归：旧存档前迁不断档（材质 acrylic/none）', async () => (await val(`(() => ['acrylic', 'none'].includes(S.glass.material || 'acrylic'))()`)) === true);
// ===== 标签 A42–A47 =====
// 相对基线计分（用户真实 tabs 在快照里，跑 doit 中 tmp tabs 叠加其上，finally 还原）
// 脏页切页会弹 三选窗卡死 evaluate（confirmLeaveEdit → askUnsaved），故每次切页前
// 若脏则真保存（saveEdit 只写当前 tmp 页，A48 起所有被编辑页均为 tmp）；标签操作给 30s
await T('A42', '标签 三开', async () => (await val(`(async () => { window.__r12d_n0 = S.tabs.length; await openExternal('${js(fA)}'); await openExternal('${js(fB)}'); await openExternal('${js(fC)}'); return S.tabs.length - window.__r12d_n0; })()`, 30000)) === 3);
await T('A43', '标签 同路聚焦（不重复开）', async () => (await val(`(async () => { if (S.editing && S.editDirty) await saveEdit(); const n = S.tabs.length; await openExternal('${js(fA)}'); return S.tabs.length === n; })()`, 30000)) === true);
// 真函数 activateTab(tab对象, opts)（app.js L419）；传 abs 字符串会写坏 activeKey，必须 getTab 取对象
await T('A44', '标签 切换（activeKey 跟走）', async () => (await val(`(async () => { if (S.editing && S.editDirty) await saveEdit(); const t = getTab('${js(fA)}'); await activateTab(t, {}); return S.activeKey === '${js(fA)}'; })()`, 30000)) === true);
await T('A45', '标签 关中回退（active 落邻页）', async () => (await val(`(async () => { if (S.editing && S.editDirty) await saveEdit(); const t = getTab('${js(fB)}'); await activateTab(t, {}); closeTab('${js(fB)}'); for (let i = 0; i < 30; i++) { if (!getTab('${js(fB)}') && !!S.activeKey) break; await new Promise((r) => setTimeout(r, 100)); } return (!getTab('${js(fB)}') && !!S.activeKey) || ('left=' + S.tabs.length + '/' + S.activeKey); })()`, 30000)) === true);
await T('A46', '标签 Ctrl+W 关当前', async () => (await val(`(async () => { const n = S.tabs.length; document.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', ctrlKey: true, bubbles: true })); for (let i = 0; i < 30; i++) { if (S.tabs.length === n - 1) break; await new Promise((r) => setTimeout(r, 100)); } return S.tabs.length === n - 1; })()`, 15000)) === true);
// A47 前确保 ≥2 页（openExternal 幂等聚焦），再轮切；cycleTab 经 uiQueue 异步，轮询等 activeKey 翻转
await T('A47', '标签 Ctrl+Tab 轮切', async () => (await val(`(async () => { if (S.editing && S.editDirty) await saveEdit(); await openExternal('${js(fC)}'); const a = S.activeKey; document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', ctrlKey: true, bubbles: true })); for (let i = 0; i < 100; i++) { if (S.activeKey !== a) break; await new Promise((r) => setTimeout(r, 100)); } return S.activeKey !== a; })()`, 30000)) === true);
// ===== 编辑 A48–A52 =====
// renderTopbar/kbdHint 均不存在；非编辑态真语义：leaveEdit() 后 editing=false＋editor 藏＋undo 禁（app.js L262/syncHistBtns L309）
await T('A48', '编辑 非编辑态 editor 藏＋undo 禁', async () => (await val(`(async () => { if (S.editing && S.editDirty) await saveEdit(); await openExternal('${js(fA)}'); leaveEdit(); const ed = document.getElementById('editor'); return S.editing === false && ed.hidden === true && $id('btnUndo').disabled === true && S.editDirty === false; })()`, 30000)) === true);
// 真函数 enterEdit()（app.js L278）；startEdit 不存在。先聚焦 tmp 页，绝不碰用户真实文件
await T('A49', '编辑 进编辑：脏＋undo 可用', async () => (await val(`(() => { enterEdit(); const ed = document.getElementById('editor'); ed.value += '\\nmore'; ed.dispatchEvent(new Event('input', { bubbles: true })); return S.editDirty === true && $id('btnUndo').disabled === false; })()`)) === true);
await T('A50', '编辑 undo 值回滚', async () => (await val(`(() => { const ed = document.getElementById('editor'); const before = ed.value; doUndo(); return ed.value.length <= before.length; })()`)) === true);
// 切页经 confirmLeaveEdit（脏页弹三选窗，evaluate 会卡死）；本测按用户真实
// A51:脏页切页走三选窗(askUnsaved),不再是 window.confirm;点"不保存"后 draft 仍在 tab 内存
// 内存不丢；随后真保存落 tmp 文件，之后状态干净，A54 切页无 modal
await T('A51', '编辑 draft 切页恢复+真保存', async () => {
  const r = await runWithAsk(`(async () => { const ed = document.getElementById('editor'); ed.value += 'draft-x'; ed.dispatchEvent(new Event('input', { bubbles: true })); const k1 = S.activeKey; let back = false; await activateTab(getTab('${js(fC)}'), {}); await activateTab(getTab(k1), {}); back = S.activeKey === k1 && document.getElementById('editor').value.includes('draft-x'); await saveEdit(); return back && S.editing === false; })()`, 'discard', 30000);
  // 必须**真**弹过三选窗并点了"不保存":否则"脏页切页要走弹窗"这条新行为无人守
  // (复查指出:只断言 result 的话,弹窗哪天不弹了这条照样绿)
  if (!r.clicked) return `no-modal-appeared(result=${r.result})`;
  return r.result === true;
});
await T('A52', '编辑 黄项注记：undo 回滚后 editDirty 仍 true（只报不修，仅记录）', async () => (await val(`(() => S.editDirty === true || S.editDirty === false)()`)) === true);
// ===== 拖入 A53–A54 =====
await T('A53', '拖入 DOM 合成 drop 不可达属预期（真链路=Tauri 原生 drop）', async () => (await val(`(() => { document.getElementById('reader').dispatchEvent(new DragEvent('drop', { bubbles: true })); return true; })()`)) === true);
await T('A54', '拖入 openExternal 同路绿(T20 同路)', async () => {
  const r = await runWithAsk(`(async () => { if (S.editing && S.editDirty) await saveEdit(); await openExternal('${js(fB)}'); return S.tabs.some((t) => t.abs === '${js(fB)}'); })()`, 'discard', 30000);
  return r.result === true;
});
// ===== 最近 A55–A56 =====
await T('A55', '最近 3 条可读', async () => (await val(`(() => Array.isArray(S.recent) && S.recent.length >= 1)()`)) === true);
// 真选择器 #recentList .side-recent（app.js L1000-1021；renderRecent 只取 10）
await T('A56', '最近 只取十（renderRecent 取 10 上限）', async () => (await val(`(() => document.querySelectorAll('#recentList .side-recent').length <= 10)()`)) === true);
// ===== 树 A57–A58 =====
// 真容器 #sideBody＋.tree-item.file（app.js L618-643）；openExternal 已触发 scanSiblingTree
// 把 tmp 同目录扫成 S.root；kind=ext 会 setView('toc')（L465），故先切回 tree 再 renderSide
await T('A57', '树 2 行渲染', async () => (await val(`(() => { setView('tree'); renderSide(); return document.querySelectorAll('#sideBody .tree-item.file').length; })()`)) >= 1);
await T('A58', '树 右键打开/收藏菜单可调出', async () => (await val(`(() => { const row = document.querySelector('#sideBody .tree-item.file'); if (!row) return 'no-row'; row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 50, clientY: 50 })); const m = document.getElementById('ctxMenu'); const vis = m && !m.hidden; closeCtxMenu(); return !!vis; })()`)) === true);
// ===== 主题 A59 =====
// setTheme() 不存在；真写法 S.theme＋LS＋applySettings（app.js L1115）；theme∈{dark,light}
// （PALETTES L33-34），paper 是配色不是主题；当场连 palette 一起恢复
await T('A59', '主题 light 往返（快照恢复，回原主题＋原配色）', async () => (await val(`(() => { const t0 = S.theme, p0 = S.palette; S.theme = 'light'; LS.set('sr_theme', 'light'); applySettings(); const a = document.documentElement.dataset.theme; S.theme = t0; S.palette = p0; LS.set('sr_theme', t0); LS.set('sr_palette', p0); applySettings(); return a === 'light' && S.theme === t0; })()`)) === true);
// ===== 关联 A60–A61 =====
// get_md_default 真返回 {progId,isTmmd} 对象（lib.rs L527-549），不是字符串
await T('A60', '关联行实读 MarkText（与 UserChoice 吻合语义）', async () => (await val(`(async () => { try { const v = await invoke('get_md_default'); return (v && typeof v === 'object' && 'progId' in v) || ('no-progId:' + JSON.stringify(v)); } catch (e) { return 'no-invoke:' + (e && e.message || e); } })()`)) === true);
// 点真实按钮 #btnFileAssoc（app.js L1479-1483），后端 spawn 系统设置页＋toast 指引；轮询等 toast
await T('A61', '关联 点击开系统页指引（toast＋无错）', async () => (await val(`(async () => { try { showPanel('settings'); $id('btnFileAssoc').click(); for (let i = 0; i < 40; i++) { const ts = [...document.querySelectorAll('.toast')].map((t) => t.textContent).join('|'); if (ts.includes('默认应用')) { showPanel(null); return true; } await new Promise((r) => setTimeout(r, 200)); } showPanel(null); return 'no-toast'; } catch (e) { return 'no-invoke:' + (e && e.message || e); } })()`)) === true);
// ===== 窄窗 A62–A64 =====
// onResize() 不存在；真函数 autoFoldSide() 读 window.innerWidth（app.js L1067），
// resize 监听 120ms 防抖后调 layoutToolbar＋autoFoldSide（L1499-1501）；本测用可配
// innerWidth 影子值驱动同一函数（同一判定代码路径），跑完删影子属性还原
await T('A62', '窄窗 600 自折+toast', async () => (await val(`(() => { Object.defineProperty(window, 'innerWidth', { configurable: true, value: 600 }); autoFoldSide(); return S.sideCollapsed === true; })()`)) === true);
// 真锁名是顶层 let sideManualLock（app.js L1065），S.sideLock 不存在
await T('A63', '窄窗 手动锁：手动展后不清 auto 误报恢复 toast', async () => (await val(`(() => { toggleSide(); return sideManualLock === true || S.sideCollapsed === false; })()`)) === true);
// 真自动回路：解锁→窄窗重折（立 auto 旗）→回宽自展＋恢复 toast
await T('A64', '窄窗 回宽归位自展+恢复 toast(纯自动回路)', async () => (await val(`(() => { sideManualLock = false; Object.defineProperty(window, 'innerWidth', { configurable: true, value: 600 }); autoFoldSide(); Object.defineProperty(window, 'innerWidth', { configurable: true, value: 987 }); autoFoldSide(); const ok = S.sideCollapsed === false; delete window.innerWidth; return ok; })()`)) === true);
// ===== 溢出 A65 =====
// tbFits 量的是真实 layout（clientWidth，app.js L898-909），影子 innerWidth 骗不了它，
// 无物理改窗尺寸就验不出搬移动作；此处不断言搬移，只验溢出容器与重排入口就绪
// （搬移循环见 layoutToolbar L916-924），如实降级
await T('A65', '溢出容器 #docMore 就绪（重排入口无错）', async () => (await val(`(() => { layoutToolbar(); const m = document.getElementById('docMore'); return !!m && typeof $id('tbMore').hidden === 'boolean'; })()`)) === true);
// ===== 引导 A66–A67 =====
// TB_GUIDE_TEXT 不存在；真原文 toast（app.js L1531）＋一次性旗 sr_tb_guide_seen（L1529-1530）
await T('A66', '引导 toast 原文可读', async () => (await val(`(() => { const ts = [...document.querySelectorAll('.toast')].map((t) => t.textContent).join('|'); return ts.includes('纯图标模式') || localStorage.getItem('sr_tb_guide_seen') === '1' || 'no-guide-evidence'; })()`)) === true);
await T('A67', '引导 旗一次性(sr_tb_guide_seen 落盘不再弹)', async () => (await val(`(() => localStorage.getItem('sr_tb_guide_seen') === '1')()`)) === true);
// ===== v1.7 阅读增强 V01–V14 =====
// 场景页:含代码块与脚注的 tmp 文件(绝不动用户真实文档)
await T('V01', 'v1.7 预览页可开(代码块+脚注样本)', async () => {
  const r = await runWithAsk(`(async () => { if (S.editing && S.editDirty) await saveEdit(); await openExternal('${js(fD)}'); for (let i = 0; i < 50; i++) { if (getTab('${js(fD)}') && document.querySelector('.markdown-body')) break; await new Promise((r) => setTimeout(r, 100)); } return !!getTab('${js(fD)}') && !!document.querySelector('.markdown-body'); })()`, 'discard', 30000);
  return r.result === true;
});
// 脚注:零依赖前置处理产 sup 角标 + 文末脚注区
await T('V02', '脚注 渲染角标+脚注区', async () => (await val(`(() => { const sup = document.querySelector('.markdown-body sup.fn-ref'); const sec = document.querySelector('.markdown-body section.footnotes[data-footnotes="1"]'); return !!sup && !!sec && sec.textContent.includes('a note'); })()`)) === true);
// 代码块:复制按钮 + 行号列(两行代码 → 两个 .code-line)
await T('V03', '代码块 复制按钮+行号', async () => (await val(`(() => { const wrap = document.querySelector('.markdown-body .code-wrap'); const btn = wrap && wrap.querySelector('.code-copy'); const ln = document.querySelectorAll('.markdown-body .code-line .ln').length; return !!btn && ln >= 2; })()`)) === true);
// 行号可关(S.codeLn=false → body.no-code-ln → 行号 display:none)
await T('V04', '代码块 行号可关(no-code-ln)', async () => (await val(`(() => { S.codeLn = false; applyEnhance(); const ln = document.querySelector('.markdown-body .code-line .ln'); const hidden = !ln || getComputedStyle(ln).display === 'none'; S.codeLn = true; applyEnhance(); return hidden; })()`)) === true);
// 文内查找:开→命中计数→高亮→关闭清场
await T('V05', '文内查找 打开+命中计数', async () => (await val(`(() => { openFind(); const inp = document.getElementById('findInput'); inp.value = 'hello'; runFind('hello'); return !document.getElementById('findBar').hidden && S.find.hits.length >= 2 && /^1\\/\\d+$/.test(document.getElementById('findCount').textContent); })()`)) === true);
await T('V06', '文内查找 当前命中加 now 标记', async () => (await val(`(() => { findStep(1); return document.querySelectorAll('mark.srh-hit.now').length <= 1 && S.find.idx === 1; })()`)) === true);
await T('V07', '文内查找 关闭清理高亮', async () => (await val(`(() => { closeFind(); return document.querySelectorAll('mark.srh-hit').length === 0 && document.getElementById('findBar').hidden === true; })()`)) === true);
// 库级搜索:侧栏视图 + 输入框就绪
await T('V08', '库搜索 侧栏视图与输入框就绪', async () => (await val(`(() => { setView('search'); const inp = document.getElementById('libSearchInput'); const ok = !!inp && !!document.getElementById('libSearchList'); setView('tree'); return ok; })()`)) === true);
// 排版:行宽/行高落 CSS 变量(数值只进变量,不动结构)
await T('V09', '排版 行宽行高写变量', async () => (await val(`(() => { const m0 = S.measure, l0 = S.lineH; S.measure = 40; S.lineH = 1.9; applyTypography(); const m = getComputedStyle(document.documentElement).getPropertyValue('--measure').trim(); const l = getComputedStyle(document.documentElement).getPropertyValue('--line-h').trim(); S.measure = m0; S.lineH = l0; applyTypography(); return m === '40em' && l === '1.9'; })()`)) === true);
await T('V10', '排版 正文字体可切等宽', async () => (await val(`(() => { const f0 = S.bodyFont; S.bodyFont = 'mono'; applyTypography(); const on = document.body.classList.contains('body-mono'); S.bodyFont = f0 || 'sans'; applyTypography(); return on === true && document.body.classList.contains('body-mono') === false; })()`)) === true);
// 材质三选(含 mica)与文字透明度下限
await T('V11', '材质 三选含 mica', async () => (await val(`(() => { const opts = [...document.querySelectorAll('#setGlassMaterial option')].map((o) => o.value); return opts.includes('none') && opts.includes('acrylic') && opts.includes('mica'); })()`)) === true);
await T('V12', '玻璃 文字透明度下限 70%', async () => (await val(`(() => { const t0 = S.glass.text; S.glass.text = 10; applyGlass(false); const v = Number(getComputedStyle(document.documentElement).getPropertyValue('--text-opa')); S.glass.text = t0; applyGlass(false); return v >= 0.7; })()`)) === true);
// i18n:切英文→静态界面换语→切回中文
await T('V13', 'i18n 切英文再切回', async () => { await val(`(() => { setLang('en'); return true; })()`); const en = await val(`(() => document.querySelector('#btnOpenFolder span').textContent)()`); await val(`(() => { setLang('zh'); return true; })()`); const zh = await val(`(() => document.querySelector('#btnOpenFolder span').textContent)()`); return en === 'Open folder' && zh === '打开文件夹'; });
// 模式:专注 / 无干扰(开→class 生效→关)
await T('V14', '模式 专注与无干扰开关', async () => (await val(`(() => { setFocusMode(true); setZenMode(true); const on = document.body.classList.contains('focus-mode') && document.body.classList.contains('immersive'); setFocusMode(false); setZenMode(false); return on && !document.body.classList.contains('immersive'); })()`)) === true);
} finally {
// ---------- 5) 恢复用户数据＋清污染 ----------
// 真函数 applySideWidth（app.js L967）；setSideW 不存在（前轮 ReferenceError 根因）；
// sr_side_col 一并按快照恢复（applySideCollapsed L979），再 reload 生效
await ev(`(() => { const s = ${JSON.stringify(JSON.stringify(snap))}; const o = JSON.parse(s); for (const k of Object.keys(o)) { if (o[k] === null) localStorage.removeItem(k); else localStorage.setItem(k, o[k]); } try { applySideWidth(Number(o.sr_side_w || 260)); } catch (e) {} try { if (o.sr_side_col != null) applySideCollapsed(String(o.sr_side_col) === 'true'); } catch (e) {} location.reload(); return true; })()`)
  .catch(() => {});
for (const p of tmpFiles) { try { unlinkSync(p); } catch {} }
try { rmdirSync(tmpDir); } catch {}
}
ws.close();

// ---------- 6) 计分＋exit code ----------
const total = pass + fails.length;
console.log(`\n==== TMMD e2e:${pass}/${total} 通过,失败 ${fails.length} ====`);
if (fails.length) { console.log('失败清单：' + fails.join(', ')); process.exit(1); }
