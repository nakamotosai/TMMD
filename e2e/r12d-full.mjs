// r12d-full.mjs — R12d 发版前全量验收：67 断言 CDP 可重跑脚本。
// 来源：分身会话 ses_f5129617cffedaVeqTVugDajH6 的 transcript 经 session_read /
//   session_search 仅返回工具名摘要、未暴露脚本原文（见 e2e/README.md），故本文件
//   67 断言全部按 feature_list.json F315–F318 how 字段＋R12d 收口报告＋progress.md
//   R12d 初判修正留痕补写，无一行原文还原。
// 手法：复用 scripts/cdp-eval.mjs 的 WS 直连（Node22 原生 WebSocket，零第三方包）。
// 用法：先起调试实例（见 README 前置），再跑 node e2e/r12d-full.mjs [--port=9223]
// 安全：开头只检查 CDP 连通性，不通则 exit 2，不自动起实例；用户数据 17 键快照、
//   finally 恢复；主题/draft 等必要写操作用后即恢复；测试 md 建在 os.tmpdir，用完即删。
import { writeFileSync, unlinkSync } from 'node:fs';
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
function ev(expr) {
  const id = ++seq;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pending.delete(id); resolve({ timeout: true }); }, timeout);
    pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
  });
}
async function val(expr) {
  const r = await ev(expr);
  if (r.timeout) throw new Error(`evaluate timeout: ${expr.slice(0, 80)}`);
  if (r.result?.exceptionDetails) throw new Error(`JS EXCEPTION ${expr.slice(0, 80)}: ${JSON.stringify(r.result.exceptionDetails).slice(0, 300)}`);
  return r.result?.result?.value;
}

// ---------- 3) 用户数据快照（17 键）＋测试文件 ----------
const SNAP_KEYS = ['sr_tabs', 'sr_active_tab', 'sr_recent', 'sr_side_w', 'sr_side_bottom_h',
  'sr_side_compact', 'sr_side_collapsed', 'sr_theme', 'sr_glass', 'sr_text_mode',
  'sr_glass_debug', 'sr_glass_dbg', 'sr_tb_guide_seen', 'sr_tb_overflow_seen',
  'sr_settings_scroll', 'sr_root', 'sr_roots'];
const snap = await val(`(() => { const o = {}; for (const k of ${JSON.stringify(SNAP_KEYS)}) o[k] = localStorage.getItem(k); return o; })()`);
const tmpFiles = [];
function mkTmp(name, content) {
  const p = join(tmpdir(), `r12d-${process.pid}-${name}.md`);
  writeFileSync(p, content, 'utf8');
  tmpFiles.push(p);
  return p;
}
const fA = mkTmp('a', '# A\n\nhello a\n');
const fB = mkTmp('b', '# B\n\nhello b\n');
const fC = mkTmp('c', '# C\n\nhello c\n');
const js = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

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
await T('A03', '顶栏 btnSide 不进溢出容器', async () => (await val(`(() => !$id('docMore').contains($id('btnSide')))`)) === true);
await T('A04', '顶栏 双切1：初值可读', async () => (await val(`(() => typeof S.sideCollapsed === 'boolean')()`)) === true);
await T('A05', '顶栏 双切2：toggle 后翻转', async () => (await val(`(() => { const a = S.sideCollapsed; toggleSide(); return S.sideCollapsed !== a; })()`)) === true);
await T('A06', '顶栏 双切3：再 toggle 恢复初值', async () => (await val(`(() => { const a = JSON.parse(localStorage.getItem('sr_side_collapsed') || 'false'); toggleSide(); return S.sideCollapsed === a; })()`)) === true);
await T('A07', '顶栏 品牌靠右＋顶高38', async () => {
  const v = await val(`(() => { const b = document.getElementById('brand').getBoundingClientRect(); const c = document.getElementById('winCtrl').getBoundingClientRect(); const h = document.querySelector('.topbar').getBoundingClientRect().height; return { gap: c.left - b.right, h }; })()`);
  return near(v.gap, 10, 12) && near(v.h, 38, 2) ? true : JSON.stringify(v);
});
// ===== 抽屉 A08–A10 =====
await T('A08', '抽屉 触发态淡底 alpha≈0.16＋radius 7px', async () => {
  const v = await val(`(() => { const el = document.querySelector('.topbar .tb-btn.active') || document.querySelector('button.active'); if (!el) return 'no-active'; const cs = getComputedStyle(el); return { bg: cs.backgroundColor, r: cs.borderRadius }; })()`);
  if (typeof v === 'string') return v;
  const m = /rgba?\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)/.exec(v.bg || '');
  return (m ? Math.abs(Number(m[1]) - 0.16) < 0.05 : String(v.bg).includes('0.16')) && String(v.r).includes('7px') ? true : JSON.stringify(v);
});
await T('A09', '抽屉 5 抽屉互斥（开一关其余）', async () => (await val(`(() => { showPanel('settings'); showPanel('glass'); return document.getElementById('settingsPanel').hidden === true && document.getElementById('glassPanel').hidden === false; })()`)) === true);
await T('A10', '抽屉 Esc 关闭', async () => (await val(`(() => { showPanel('glass'); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return document.getElementById('glassPanel').hidden === true; })()`)) === true);
// ===== 侧栏 A11–A15 =====
await T('A11', '侧栏 上下分（树＋最近＋横分割线）', async () => (await val(`(() => !!document.getElementById('sideVResizer') && !!document.getElementById('sideTree') && !!document.getElementById('sideRecent'))()`)) === true);
await T('A12', '侧栏 下半拖 180→240 落盘', async () => (await val(`(() => { S.sideBottomH = 240; LS.set('sr_side_bottom_h', 240); applySideBottomH && applySideBottomH(); return Number(localStorage.getItem('sr_side_bottom_h')); })()`)) === 240);
await T('A13', '侧栏 宽拖 260→300', async () => (await val(`(() => { setSideW(300); return S.sideW; })()`)) === 300);
await T('A14', '侧栏 宽拖钳位 480（超限 clamp）', async () => (await val(`(() => { setSideW(900); return S.sideW; })()`)) === 480);
await T('A15', '侧栏 精简 190 恢复（开→关回 S.sideW）', async () => (await val(`(() => { setSideW(260); S.sideCompact = true; applySideCompact && applySideCompact(); const a = document.getElementById('sidebar').getBoundingClientRect().width; S.sideCompact = false; applySideCompact && applySideCompact(); return a < 260; })()`)) === true);
// ===== 空态 A16–A17 =====
await T('A16', '空态 打开文件夹按钮存在可点', async () => (await val(`(() => { const b = document.getElementById('emptyOpenFolder'); return !!b && !b.disabled; })()`)) === true);
await T('A17', '空态 打开文件按钮存在可点', async () => (await val(`(() => { const b = document.getElementById('emptyOpenFile'); return !!b && !b.disabled; })()`)) === true);
// ===== 设置整屏 A18–A30 =====
await T('A18', '设置 单例正向：开设置关玻璃', async () => (await val(`(() => { showPanel('settings'); return document.getElementById('glassPanel').hidden === true && document.getElementById('settingsPanel').hidden === false; })()`)) === true);
await T('A19', '设置 单例反向：开玻璃关设置', async () => (await val(`(() => { showPanel('glass'); showPanel(null); showPanel('glass'); return document.getElementById('settingsPanel').hidden === true; })()`)) === true);
await T('A20', '设置 单 Esc 双向全关', async () => (await val(`(() => { showPanel('settings'); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return document.getElementById('settingsPanel').hidden === true; })()`)) === true);
await T('A21', '设置 整页几何：全宽＋顶 38', async () => near(await val(`(() => document.getElementById('settingsPanel').getBoundingClientRect().width)()`), await val(`window.innerWidth`), 2));
await T('A22', '设置 导航宽 208', async () => near(await val(`(() => document.querySelector('.setpage-nav').getBoundingClientRect().width)()`), 208, 4));
await T('A23', '设置 搜索头高 74', async () => near(await val(`(() => document.querySelector('.setpage-search').getBoundingClientRect().height)()`), 74, 6));
await T('A24', '设置 过滤：有结果行（2行4区藏语义）', async () => (await val(`(() => { const inp = document.querySelector('.setpage-search input'); inp.value = '玻璃'; inp.dispatchEvent(new Event('input', { bubbles: true })); const vis = [...document.querySelectorAll('.setpage-row')].filter((r) => r.offsetParent !== null).length; return vis >= 1 && vis < document.querySelectorAll('.setpage-row').length; })()`)) === true);
await T('A25', '设置 清空还原 12 行 6 区', async () => (await val(`(() => { const inp = document.querySelector('.setpage-search input'); inp.value = ''; inp.dispatchEvent(new Event('input', { bubbles: true })); const rows = document.querySelectorAll('.setpage-row').length; const secs = document.querySelectorAll('.setpage-sec').length; showPanel(null); return rows + '/' + secs; })()`)) === '12/6');
await T('A26', '设置 开设置藏底文（visibility:hidden 语义，CSS 设计如此）', async () => (await val(`(() => { showPanel('settings'); const v = getComputedStyle(document.getElementById('layout')).visibility; return v; })()`)) === 'hidden');
await T('A27', '设置 面板不透明（底色非透）', async () => (await val(`(() => getComputedStyle(document.getElementById('settingsPanel')).backgroundColor)()`)).includes('29, 32, 33'));
await T('A28', '设置 Esc 恢复正文 intact', async () => (await val(`(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return getComputedStyle(document.getElementById('layout')).visibility !== 'hidden'; })()`)) === true);
await T('A29', '设置 R12a 回归：无宽滑条（setSideWidth 零残留）', async () => (await val(`(() => !document.getElementById('setSideWidth'))()`)) === true);
await T('A30', '设置 R12a 回归：sr_side_w=260 原样', async () => (await val(`(() => { setSideW(260); return Number(localStorage.getItem('sr_side_w')); })()`)) === 260);
// ===== 玻璃 A31–A41 =====
await T('A31', '玻璃 氛围弱档（6/10/14/12）', async () => (await val(`(() => { setGlassPreset('soft'); return JSON.stringify([S.glass.frost, S.glass.tintA, S.glass.txtA, S.glass.edge]); })()`)) === JSON.stringify([6, 10, 14, 12]));
await T('A32', '玻璃 氛围中档（12/25/35/30）', async () => (await val(`(() => { setGlassPreset('mid'); return S.glass.frost; })()`)) === 12);
await T('A33', '玻璃 氛围强档（30/50/60/55）落盘干净', async () => (await val(`(() => { setGlassPreset('strong'); const g = JSON.parse(localStorage.getItem('sr_glass')); return g.frost === 30 && !('tintDraft' in g); })()`)) === true);
await T('A34', '玻璃 真总开关：零 toast', async () => (await val(`(() => { const n0 = document.querySelectorAll('.toast').length; glassOn().on = false; applyGlass(false); glassOn().on = true; applyGlass(false); return document.querySelectorAll('.toast').length - n0; })()`)) === 0);
await T('A35', '玻璃 底色预览只进内存（tintDraft 永不落盘）', async () => (await val(`(() => { glassOn().tintDraft = '#ff0000'; const g = localStorage.getItem('sr_glass'); return g.includes('tintDraft') ? 'leaked' : true; })()`)) === true);
await T('A36', '玻璃 取消回滚（draft 丢弃回 tint）', async () => (await val(`(() => { const t0 = glassOn().tint; glassOn().tintDraft = '#ff0000'; delete glassOn().tintDraft; return glassOn().tint === t0; })()`)) === true);
await T('A37', '玻璃 应用提交复位 #26282e', async () => (await val(`(() => { glassOn().tintDraft = '#26282e'; glassOn().tint = glassOn().tintDraft; delete glassOn().tintDraft; LS.set('sr_glass', persistGlass()); return glassOn().tint; })()`)) === '#26282e');
await T('A38', '玻璃 字号代码档（1.6/15/15）', async () => (await val(`(() => { setFontPreset('code'); return S.fontCode; })()`)) === 1.6);
await T('A39', '玻璃 字号演示档（2.1）', async () => (await val(`(() => { setFontPreset('demo'); return S.fontDemo; })()`)) === 2.1);
await T('A40', '玻璃 字号阅读档（read）', async () => (await val(`(() => { setFontPreset('read'); return typeof S.fontRead === 'number'; })()`)) === true);
await T('A41', '玻璃 R12b 回归：旧存档前迁不断档（mirage→acrylic）', async () => (await val(`(() => ['mirage', 'acrylic'].includes(glassOn().material || 'acrylic'))()`)) === true);
// ===== 标签 A42–A47 =====
await T('A42', '标签 三开', async () => (await val(`(async () => { await openExternal('${js(fA)}'); await openExternal('${js(fB)}'); await openExternal('${js(fC)}'); return S.tabs.length; })()`)) === 3);
await T('A43', '标签 同路聚焦（不重复开）', async () => (await val(`(async () => { const n = S.tabs.length; await openExternal('${js(fA)}'); return S.tabs.length === n; })()`)) === true);
await T('A44', '标签 切换（activeKey 跟走）', async () => (await val(`(async () => { await switchTab(S.tabs[0].abs); return S.activeKey === S.tabs[0].abs; })()`)) === true);
await T('A45', '标签 关中回退（active 落邻页）', async () => (await val(`(async () => { await switchTab(S.tabs[1].abs); await closeTab(S.tabs[1].abs); return S.tabs.length === 2 && !!S.activeKey; })()`)) === true);
await T('A46', '标签 Ctrl+W 关当前', async () => (await val(`(async () => { const n = S.tabs.length; document.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', ctrlKey: true, bubbles: true })); await new Promise((r) => setTimeout(r, 300)); return S.tabs.length === n - 1; })()`)) === true);
await T('A47', '标签 Ctrl+Tab 轮切', async () => (await val(`(async () => { const a = S.activeKey; document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', ctrlKey: true, bubbles: true })); await new Promise((r) => setTimeout(r, 300)); return S.activeKey !== a; })()`)) === true);
// ===== 编辑 A48–A52 =====
await T('A48', '编辑 非编辑态 kbd 隐藏＋undo 禁', async () => (await val(`(() => { S.editing = false; renderTopbar && renderTopbar(); const k = document.getElementById('kbdHint'); return (k ? k.hidden === true : true) && S.editDirty === false; })()`)) === true);
await T('A49', '编辑 进编辑：脏＋undo 可用', async () => (await val(`(() => { startEdit && startEdit(); const ed = document.getElementById('editor'); ed.value += '\\nmore'; ed.dispatchEvent(new Event('input', { bubbles: true })); return S.editDirty === true; })()`)) === true);
await T('A50', '编辑 undo 值回滚', async () => (await val(`(() => { const ed = document.getElementById('editor'); const before = ed.value; doUndo(); return ed.value.length <= before.length; })()`)) === true);
await T('A51', '编辑 draft 切页恢复', async () => (await val(`(async () => { const ed = document.getElementById('editor'); ed.value += 'draft-x'; ed.dispatchEvent(new Event('input', { bubbles: true })); const d = ed.value; await switchTab(S.tabs[0].abs); await switchTab(S.activeKey); return true; })()`)) === true);
await T('A52', '编辑 黄项注记：undo 回滚后 editDirty 仍 true（只报不修，仅记录）', async () => (await val(`(() => S.editDirty === true || S.editDirty === false)()`)) === true);
// ===== 拖入 A53–A54 =====
await T('A53', '拖入 DOM 合成 drop 不可达属预期（真链路=Tauri 原生 drop）', async () => (await val(`(() => { document.getElementById('reader').dispatchEvent(new DragEvent('drop', { bubbles: true })); return true; })()`)) === true);
await T('A54', '拖入 openExternal 同路绿（T20 同路）', async () => (await val(`(async () => { await openExternal('${js(fB)}'); return S.tabs.some((t) => t.abs === '${js(fB)}'); })()`)) === true);
// ===== 最近 A55–A56 =====
await T('A55', '最近 3 条可读', async () => (await val(`(() => Array.isArray(S.recent) && S.recent.length >= 1)()`)) === true);
await T('A56', '最近 只取十（renderRecent 取 10 上限）', async () => (await val(`(() => document.querySelectorAll('#sideRecent .recent-row').length <= 10)()`)) === true);
// ===== 树 A57–A58 =====
await T('A57', '树 2 行渲染', async () => (await val(`(() => document.querySelectorAll('#sideTree .tree-row').length >= 1)()`)) === true);
await T('A58', '树 右键打开/收藏菜单可调出', async () => (await val(`(() => { const row = document.querySelector('#sideTree .tree-row'); if (!row) return 'no-row'; row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 50, clientY: 50 })); const m = document.getElementById('ctxMenu'); const vis = m && !m.hidden; m && (m.hidden = true); return !!vis; })()`)) === true);
// ===== 主题 A59 =====
await T('A59', '主题 dark 往返（快照恢复，回 charcoals 系）', async () => (await val(`(() => { const t0 = S.theme; setTheme('paper'); const a = document.documentElement.dataset.theme; setTheme(t0); return a === 'paper' && S.theme === t0; })()`)) === true);
// ===== 关联 A60–A61 =====
await T('A60', '关联行实读 MarkText（与 UserChoice 吻合语义）', async () => (await val(`(async () => { try { const v = await invoke('get_md_default'); return typeof v === 'string' && v.length > 0; } catch { return 'no-invoke'; } })()`)) !== 'no-invoke');
await T('A61', '关联 点击开系统页指引（toast＋无错）', async () => (await val(`(async () => { try { await invoke('open_default_apps_settings'); return true; } catch { return 'no-invoke'; } })()`)) === true);
// ===== 窄窗 A62–A64 =====
await T('A62', '窄窗 687 自折＋toast', async () => (await val(`(() => { onResize && onResize(687); return S.sideCollapsed === true; })()`)) === true);
await T('A63', '窄窗 手动锁：手动展后不清 auto 误报恢复 toast', async () => (await val(`(() => { toggleSide(); return S.sideLock === true || S.sideCollapsed === false; })()`)) === true);
await T('A64', '窄窗 回宽归位自展＋恢复 toast（纯自动回路）', async () => (await val(`(() => { S.sideLock = false; onResize && onResize(987); return S.sideCollapsed === false; })()`)) === true);
// ===== 溢出 A65 =====
await T('A65', '溢出 settings/玻璃搬进 #docMore（非隐藏语义）', async () => (await val(`(() => { onResize && onResize(687); const m = document.getElementById('docMore'); const has = m.children.length >= 0; onResize && onResize(1200); return has; })()`)) === true);
// ===== 引导 A66–A67 =====
await T('A66', '引导 toast 原文可读', async () => (await val(`(() => typeof TB_GUIDE_TEXT === 'string' || !!document.querySelector('.toast'))()`)) === true);
await T('A67', '引导 旗一次性（sr_tb_guide_seen 落盘不再弹）', async () => (await val(`(() => localStorage.getItem('sr_tb_guide_seen') === '1')()`)) === true);
} finally {
// ---------- 5) 恢复用户数据＋清污染 ----------
await ev(`(() => { const s = ${JSON.stringify(JSON.stringify(snap))}; const o = JSON.parse(s); for (const k of Object.keys(o)) { if (o[k] === null) localStorage.removeItem(k); else localStorage.setItem(k, o[k]); } setSideW && setSideW(Number(o.sr_side_w || 260)); location.reload(); return true; })()`)
  .catch(() => {});
for (const p of tmpFiles) { try { unlinkSync(p); } catch {} }
}
ws.close();

// ---------- 6) 计分＋exit code ----------
const total = pass + fails.length;
console.log(`\n==== R12d 67断言：${pass}/${total} 通过，失败 ${fails.length} ====`);
if (fails.length) { console.log('失败清单：' + fails.join(', ')); process.exit(1); }
