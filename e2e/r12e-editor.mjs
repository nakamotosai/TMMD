// r12e-editor.mjs — 编辑链验收(v1.8 编辑第一批 + 第二批,与 r12d-full.mjs 同手法同风格)。
// 覆盖:保存链(原子写/CRLF 保留/冲突覆盖与取消)、外部变更监听(含编辑中保护)、关窗守卫、
//       扩展名口径、Ctrl+S、新建/重命名/删除(回收站)、换库守卫。
// 用法:先起调试实例(见 README 前置),再跑 node e2e/r12e-editor.mjs [--port=9225]
// 安全:开头只检查 CDP 连通性,不通则 exit 2;测试文件全部建在 os.tmpdir 的独立子目录,用完即删;
//       不触碰用户真实库(测试用临时目录临时登记为 root,结束后清掉标签与登记)。
import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const port = (args.find((a) => a.startsWith('--port=')) || '--port=9225').split('=')[1];
const timeout = Number((args.find((a) => a.startsWith('--timeout=')) || '--timeout=10000').split('=')[1]) || 10000;

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

// ---------- 2) 单 WS 长连 ----------
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
  if (r.timeout) throw new Error(`evaluate timeout: ${expr.slice(0, 80)}`);
  if (r.result?.exceptionDetails) throw new Error(`JS EXCEPTION: ${JSON.stringify(r.result.exceptionDetails).slice(0, 240)}`);
  return r.result?.result?.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/* 等页面就绪(2026-10-26):r12d 跑完会触发重载,重载后 app.js 还没执行完时 eval `S` 会
 * ReferenceError: S is not defined —— 表现是"只串跑才崩、单跑永远绿"。这里显式等一次。 */
async function waitBoot(ms = 30000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await ev(`(() => typeof S !== 'undefined' && typeof setLang === 'function' && typeof applyI18n === 'function')()`, 3000);
      if (r.result?.result?.value === true) return Date.now() - t0;
    } catch { /* 重载瞬间连接可能短暂不可用 */ }
    if (Date.now() - t0 > ms) throw new Error('页面 30s 内未就绪(app.js 没跑起来)');
    await sleep(250);
  }
}
const results = { pass: 0, fail: 0, fails: [] };
/* 沙箱护栏(2026-10-25 血泪):脚本只允许在 os.tmpdir 下的测试文件上进入编辑/保存。
 * 事故:早前的临时脚本没做这个检查,当时活动标签是仓库 README.md,于是"输入 + 保存"把
 * 真 README 写成了一行 "plain text edited",还被一起提交推送。 */
const SAFE_FILE_RE = /tmmd-e2e-editor|tmmd-edit-test|tmmd-ext-test|tmmd-conflict-probe|tmmd-del-root/i;
async function guardSandbox() {
  const cur = String(await val(`S.cur ? S.cur.abs : ''`, 2000) || '');
  if (cur && !SAFE_FILE_RE.test(cur)) {
    await val(`(() => { try { leaveEdit(); } catch (e) {} S.cur = null; S.activeKey = null; S.tabs = []; return 1; })()`, 2000);
    throw new Error(`护栏拦下:活动文件不在沙箱内(${cur}),已清空标签拒绝继续`);
  }
}
/* 每条断言前只做一件事:关掉可能残留的弹窗。
 * 为什么必须有:守卫(关窗/切标签/换库)会在"上一条断言留下的脏草稿"上弹窗,
 * 后面的断言就会卡在那个弹窗上超时 —— 那是测试卫生问题,不是产品缺陷。
 * 注意**不要**在这里 leaveEdit/清脏标记:很多断言本来就靠上一条留下的编辑态,
 * 清掉就变成"测了个空气"(2026-10-25 实测:E03/E06/E07/E16/E21 全因此假失败)。 */
async function settle() {
  try {
    for (let i = 0; i < 4; i++) {
      const has = await val(`!!document.querySelector('.askwrap')`, 2000);
      if (!has) break;
      await val(`(() => { const w = document.querySelector('.askwrap'); const b = [...w.querySelectorAll('button')].find((x) => x.dataset.a === 'cancel') || w.querySelector('button'); if (b) b.click(); return 1; })()`, 2000);
      await sleep(150);
    }
  } catch { /* 复位失败不阻塞:让断言自己暴露问题 */ }
}
async function check(id, desc, fn) {
  await settle();
  await guardSandbox();
  try {
    const ok = await fn();
    if (ok === true) { results.pass++; console.log(`PASS ${id} ${desc}`); }
    else { results.fail++; results.fails.push(id); console.log(`FAIL ${id} ${desc} :: ${typeof ok === 'string' ? ok : JSON.stringify(ok)}`); }
  } catch (e) { results.fail++; results.fails.push(id); console.log(`FAIL ${id} ${desc} :: ${e.message.slice(0, 200)}`); }
}
const q = (s) => JSON.stringify(s);

// ---------- 3) 测试沙箱 ----------
const SANDBOX = join(tmpdir(), 'tmmd-e2e-editor');
rmSync(SANDBOX, { recursive: true, force: true });
mkdirSync(SANDBOX, { recursive: true });
const MD = join(SANDBOX, 'doc.md');
const CRLF_MD = join(SANDBOX, 'crlf.md');
const TXT = join(SANDBOX, 'note.txt');
const probeDir = () => join(SANDBOX, 'notes');
const winPath = (p) => p.split('/').join('\\');
writeFileSync(CRLF_MD, 'line one\r\nline two\r\n');
writeFileSync(TXT, 'plain text\n');
writeFileSync(MD, 'ctrl-s target\n');

console.log('# 等页面就绪', await waitBoot(), 'ms');
const winBefore = await val(`JSON.stringify({ tabs: (S.tabs || []).map((t) => t.abs), active: S.activeKey })`);
console.log('# 起手状态', winBefore);
// 起手复位:关掉上次跑剩下的标签(它们的文件已被上轮清掉),否则后续断言会作用在错的标签上
await val(`(() => {
  try { leaveEdit(); } catch (e) {}
  for (const t of S.tabs.slice()) { t.editDirty = false; t.editing = false; t.draft = null; }
  localStorage.removeItem('sr_tabs');
  localStorage.removeItem('sr_active_tab');
  S.tabs = []; S.activeKey = null; S.cur = null;
  try { renderTabs(); renderEmpty(); } catch (e) {}
  return 1;
})()`, 2000);
console.log('# 已复位标签');

// ---------- E01–E06 保存链 ----------
await check('E01', '打开 CRLF 文档(open_path)并可进编辑', async () => {
  await val(`(async () => { await invoke('open_path', { path: ${q(winPath(CRLF_MD))} }); await openTab({ abs: ${q(winPath(CRLF_MD))}, kind: 'ext' }); return 1; })()`);
  return (await val(`!!S.cur && !S.editing`)) === true;
});
await check('E02', '输入后进入脏态', async () => {
  await val(`(async () => { enterEdit(); const ed = $id('editor'); ed.value = 'line one edited\\nline two\\n'; ed.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`, 2000);
  return (await val(`S.editDirty === true`)) === true;
});
await check('E03', '保存后磁盘内容更新且 CRLF 保持', async () => {
  await val(`(async () => await saveEdit())()`, 8000);
  const disk = readFileSync(CRLF_MD, 'utf8');
  return disk.includes('line one edited') && disk.includes('\r\n') ? true : `disk=${JSON.stringify(disk)}`;
});
await check('E04', '保存成功不清脏标记/不留临时件', async () => {
  const dirty = await val(`S.editDirty`);
  const leftover = readdirSync(SANDBOX).filter((f) => f.includes('.tmmd-tmp'));
  return dirty === false && leftover.length === 0 ? true : `dirty=${dirty} leftover=${leftover}`;
});
await check('E05', '外部改盘后保存 → 弹覆盖确认(不静默覆盖)', async () => {
  writeFileSync(CRLF_MD, 'line one edited\r\nEXTERNAL CHANGE\r\n');
  await val(`(async () => { enterEdit(); const ed = $id('editor'); ed.value = 'line one edited\\nMY DRAFT\\n'; ed.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`, 2000);
  void val(`(async () => await saveEdit())()`, 8000);   // 等弹窗
  await sleep(900);
  const btns = await val(`(() => { const w = document.querySelector('.askwrap'); return w ? [...w.querySelectorAll('button')].map((b) => b.textContent) : null; })()`);
  return !!(btns && btns.length) ? true : JSON.stringify(btns);
});
await check('E06', '点取消 → 磁盘保持外部版本且草稿不丢', async () => {
  await val(`(() => { const b = [...document.querySelectorAll('.askwrap button')].find((x) => x.dataset.a === 'cancel'); if (b) b.click(); return 1; })()`, 2000);
  await sleep(600);
  const disk = readFileSync(CRLF_MD, 'utf8');
  const draft = await val(`$id('editor').value.includes('MY DRAFT')`);
  return disk.includes('EXTERNAL CHANGE') && draft === true ? true : `disk=${JSON.stringify(disk)} draftKept=${draft}`;
});
await check('E07', '确认覆盖 → 磁盘变草稿且仍是 CRLF', async () => {
  void val(`(async () => await saveEdit())()`, 8000);
  await sleep(900);
  await val(`(() => { const b = [...document.querySelectorAll('.askwrap button')].find((x) => x.dataset.a === 'save'); if (b) b.click(); return 1; })()`, 2000);
  await sleep(800);
  const disk = readFileSync(CRLF_MD, 'utf8');
  return disk.includes('MY DRAFT') && disk.includes('\r\n') ? true : JSON.stringify(disk);
});

// ---------- E08–E10 外部变更监听 ----------
await check('E08', 'watcher 真生效:非编辑态外部改盘自动重载', async () => {
  await sleep(1800);   // 等过 1.5s 自写回声抑制窗(上一条断言刚保存过)
  await val(`(async () => { const t = getTab(${q(winPath(CRLF_MD))}); await invoke('watch_file', { path: t.abs }); return 1; })()`);
  writeFileSync(CRLF_MD, 'line one edited\r\nWATCHED CHANGE\r\n');
  await sleep(2000);
  const raw = await val(`(S.cur || {}).raw || ''`);
  return String(raw).includes('WATCHED CHANGE') ? true : JSON.stringify(String(raw).slice(0, 60));
});
await check('E09', '编辑中外部改盘只提示、不动草稿', async () => {
  await val(`(async () => { enterEdit(); const ed = $id('editor'); ed.value = 'KEEP ME\\n'; ed.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`, 2000);
  writeFileSync(CRLF_MD, 'external while editing\n');
  await sleep(1800);
  const draft = await val(`$id('editor').value`);
  return String(draft).includes('KEEP ME') ? true : JSON.stringify(draft);
});
await check('E10', '自写回声被抑制(保存后不产生 stale 标)', async () => {
  await sleep(1600);
  await val(`(async () => { const t = getTab(${q(winPath(CRLF_MD))}); t.stale = false; t.editDirty = false; t.draft = null; await activateTab(t, {}); enterEdit(); const ed = $id('editor'); ed.value = 'fresh save\\n'; ed.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`, 4000);
  // 直接走写入口(force=true):这条断言测的是"自写回声",不是冲突交互
  await val(`(async () => { const t = getTab(${q(winPath(CRLF_MD))}); const r = await writeTabContent(t, $id('editor').value, true); return r; })()`, 8000);
  await sleep(2200);
  const stale = await val(`!!getTab(${q(winPath(CRLF_MD))}).stale`);
  return stale === false ? true : `stale=${stale}`;
});

// ---------- E11–E13 扩展名 / Ctrl+S ----------
await check('E11', '.txt 可打开(扩展名口径统一)', async () => {
  await val(`(async () => { await invoke('open_path', { path: ${q(winPath(TXT))} }); await openTab({ abs: ${q(winPath(TXT))}, kind: 'ext' }); return 1; })()`);
  return (await val(`/note\\.txt$/.test(S.cur.abs)`)) === true;
});
await check('E12', '.txt 可保存(走同一套原子写)', async () => {
  await val(`(async () => { enterEdit(); const ed = $id('editor'); ed.value = 'plain text edited\\n'; ed.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`, 1500);
  await val(`(async () => await saveEdit())()`, 8000);
  return readFileSync(TXT, 'utf8').includes('plain text edited');
});
await check('E13', 'Ctrl+S 真按键存盘', async () => {
  await val(`(async () => { await invoke('open_path', { path: ${q(winPath(MD))} }); await openTab({ abs: ${q(winPath(MD))}, kind: 'ext' }); enterEdit(); const ed = $id('editor'); ed.value = 'ctrl-s saved this\\n'; ed.dispatchEvent(new Event('input', { bubbles: true })); ed.focus(); return 1; })()`, 2000);
  await ev(`(() => { const ed = $id('editor'); ed.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true })); return 1; })()`);
  await sleep(1200);
  return readFileSync(MD, 'utf8').includes('ctrl-s saved this');
});

// ---------- E14–E19 新建 / 重命名 / 删除 ----------
await check('E14', '登记临时目录为库(后续新建/改名的沙箱)', async () => {
  await val(`(async () => { await loadRoot({ id: 'e2e', name: 'e2e', path: ${q(winPath(SANDBOX))} }); return 1; })()`, 4000);
  return (await val(`S.root && /tmmd-e2e-editor/.test(S.root.rootPath)`)) === true;
});
await check('E15', '新建:弹输入框且能建到子目录', async () => {
  void val(`(async () => await newDoc())()`, 8000);
  await sleep(700);
  const hasInput = await val(`!!document.querySelector('.ask-input')`);
  if (!hasInput) return 'no input dialog';
  await val(`(() => { const i = document.querySelector('.ask-input'); i.value = 'notes/idea.md'; [...document.querySelectorAll('.askwrap button')].find((x) => x.dataset.a === 'ok').click(); return 1; })()`, 2500);
  await sleep(1200);
  return existsSync(join(probeDir(), 'idea.md'));
});
await check('E16', '新建后自动打开并进入编辑', async () => {
  await sleep(900);   // 建文件 → 重扫树 → 打开 → 进编辑是条异步链,给它落地时间
  return (await val(`S.editing === true && /idea\\.md$/.test(S.cur.abs)`)) === true;
});
await check('E17', '重命名:磁盘到位且标签跟着改', async () => {
  void val(`(async () => await renameDoc())()`, 8000);
  await sleep(700);
  await val(`(() => { const i = document.querySelector('.ask-input'); i.value = 'notes/final.md'; [...document.querySelectorAll('.askwrap button')].find((x) => x.dataset.a === 'ok').click(); return 1; })()`, 2500);
  await sleep(1200);
  const ok1 = existsSync(join(probeDir(), 'final.md')) && !existsSync(join(probeDir(), 'idea.md'));
  const ok2 = await val(`/final\\.md$/.test(S.cur.abs) && getTab(S.cur.abs).relPos === 'notes/final.md'`);
  return ok1 && ok2 === true ? true : `disk=${ok1} tab=${ok2}`;
});
await check('E18', '删除:二次确认 → 文件进回收站(磁盘上没了)', async () => {
  void val(`(async () => await deleteDoc())()`, 8000);
  await sleep(700);
  const btns = await val(`(() => { const w = document.querySelector('.askwrap'); return w ? w.querySelectorAll('button').length : 0; })()`);
  if (btns !== 2) return 'no confirm dialog';
  await val(`(() => { [...document.querySelectorAll('.askwrap button')].find((x) => x.dataset.a === 'ok').click(); return 1; })()`, 2500);
  await sleep(1400);
  return !existsSync(join(probeDir(), 'final.md'));
});
await check('E19', '删除后标签关闭且树同步', async () => {
  const tabs = await val(`S.tabs.map((x) => x.abs)`);
  const inTree = await val(`((S.root.scan.flat || []).some((x) => /final\\.md/.test(x.rel || x.name || '')))`);
  return !tabs.some((x) => /final\.md/.test(x)) && inTree === false ? true : `tabs=${JSON.stringify(tabs)} inTree=${inTree}`;
});

// ---------- E20–E21 守卫 ----------
await check('E20', '换库/切走前有未保存守卫(三选弹窗,不是静默丢弃)', async () => {
  await val(`(async () => { await openTab({ abs: ${q(winPath(MD))}, kind: 'ext' }); enterEdit(); const ed = $id('editor'); ed.value = 'guard me\\n'; ed.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`, 2500);
  void val(`(async () => await confirmLeaveEdit())()`, 4000);   // 不 await:它要等用户选
  await sleep(800);
  const btns = await val(`(() => { const w = document.querySelector('.askwrap'); return w ? [...w.querySelectorAll('button')].map((b) => b.textContent) : null; })()`);
  if (!btns || btns.length < 3) return `btns=${JSON.stringify(btns)}`;
  await val(`(() => { [...document.querySelectorAll('.askwrap button')].find((x) => x.dataset.a === 'cancel').click(); return 1; })()`, 1500);
  await sleep(400);
  return true;
});
await check('E21', '关窗守卫:带脏内容点关闭被拦下(窗口还活着)', async () => {
  const dirty = await val(`S.editing && S.editDirty`);
  if (dirty !== true) return `not dirty (${dirty})`;
  await val(`(() => { $id('btnClose').click(); return 1; })()`, 1200);
  await sleep(900);
  const btns = await val(`(() => { const w = document.querySelector('.askwrap'); return w ? [...w.querySelectorAll('button')].map((b) => b.textContent) : null; })()`);
  if (!btns || btns.length < 3) return `btns=${JSON.stringify(btns)}`;
  await val(`(() => { [...document.querySelectorAll('.askwrap button')].find((x) => x.dataset.a === 'cancel').click(); return 1; })()`, 1500);
  await sleep(500);
  return (await val(`1 + 1`)) === 2 ? true : 'window gone after cancel';
});

// ---------- 收尾:还原标签与悬空测试文件 ----------
try {
  await val(`(async () => { for (const t of S.tabs.slice()) { if (/tmmd-e2e-editor|doc\\.md|crlf\\.md|note\\.txt/.test(t.abs)) { if (normPath(S.activeKey) === normPath(t.abs)) { leaveEdit(); } } } return 1; })()`, 3000);
} catch { /* 收尾失败不影响计分 */ }
try { rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* 文件被占用时留待下次清 */ }

// ---------- E22–E25 编辑器手感:Tab 缩进 / 查找替换 / 撤销栈按标签 ----------
await check('E22', 'Tab 插入缩进而非跳走焦点(单点)', async () => {
  await val(`(async () => { await openTab({ abs: ${q(winPath(MD))}, kind: 'ext' }); enterEdit(); const ed = $id('editor'); ed.value = 'abc\\n'; ed.selectionStart = ed.selectionEnd = 0; ed.focus(); return 1; })()`, 2500);
  await ev(`(() => { const ed = $id('editor'); ed.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })); return 1; })()`);
  await sleep(300);
  const v = await val(`$id('editor').value`);
  return String(v).startsWith('  abc') ? true : JSON.stringify(String(v).slice(0, 20));
});
await check('E23', '跨行选区 Tab 整块缩进 / Shift+Tab 反缩进', async () => {
  await val(`(() => { const ed = $id('editor'); ed.value = 'l1\\nl2\\n'; ed.selectionStart = 0; ed.selectionEnd = 5; return 1; })()`, 300);
  await ev(`(() => { $id('editor').dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })); return 1; })()`);
  await sleep(250);
  const indented = await val(`$id('editor').value`);
  await ev(`(() => { $id('editor').dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })); return 1; })()`);
  await sleep(250);
  const back = await val(`$id('editor').value`);
  return String(indented) === '  l1\n  l2\n' && String(back) === 'l1\nl2\n' ? true : `indented=${JSON.stringify(indented)} back=${JSON.stringify(back)}`;
});
await check('E24', 'Ctrl+H 编辑态查找替换:计数 + 替换当前 + 全部替换', async () => {
  await val(`(() => { const ed = $id('editor'); ed.value = 'foo foo foo\\n'; return 1; })()`, 300);
  await ev(`(() => { $id('editor').dispatchEvent(new KeyboardEvent('keydown', { key: 'h', ctrlKey: true, bubbles: true, cancelable: true })); return 1; })()`);
  await sleep(400);
  const hasBar = await val(`!!document.getElementById('editFindBar') && !document.getElementById('editFindBar').hidden`);
  if (hasBar !== true) return 'no find bar';
  await val(`(() => { const q = $id('editFindQ'); q.value = 'foo'; q.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`, 500);
  const cnt = await val(`$id('editFindCnt').textContent`);
  await val(`(() => { $id('editFindR').value = 'bar'; $id('editFindNext').click(); return 1; })()`, 300);
  await val(`(() => { $id('editFindOne').click(); return 1; })()`, 400);
  const afterOne = await val(`$id('editor').value`);
  await val(`(() => { $id('editFindAll').click(); return 1; })()`, 600);
  const afterAll = await val(`$id('editor').value`);
  await val(`(() => { $id('editFindClose').click(); return 1; })()`, 300);
  return cnt === '1/3' && afterOne === 'bar foo foo\n' && afterAll === 'bar bar bar\n'
    ? true : `cnt=${cnt} one=${JSON.stringify(afterOne)} all=${JSON.stringify(afterAll)}`;
});
await check('E25', '撤销栈按标签隔离(切走再切回仍能撤销)', async () => {
  await val(`(async () => { const ed = $id('editor'); ed.value = 'A0\\n'; ed.dispatchEvent(new Event('input', { bubbles: true })); ed.value = 'A1\\n'; ed.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`, 800);
  // 切走:守卫弹窗出现就点"不保存"(这条断言测的是撤销栈,不是守卫)
  void val(`(async () => { await openTab({ abs: ${q(winPath(TXT))}, kind: 'ext' }); return 1; })()`, 3000);
  await sleep(700);
  await val(`(() => { const b = [...document.querySelectorAll('.askwrap button')].find((x) => x.dataset.a === 'discard'); if (b) b.click(); return 1; })()`, 800);
  await sleep(800);
  void val(`(async () => { await openTab({ abs: ${q(winPath(MD))}, kind: 'ext' }); return 1; })()`, 3000);
  await sleep(700);
  await val(`(() => { const b = [...document.querySelectorAll('.askwrap button')].find((x) => x.dataset.a === 'discard'); if (b) b.click(); return 1; })()`, 800);
  await sleep(900);
  const editing = await val(`S.editing`);
  const histLen = await val(`editHist.undo.length`);
  await val(`(() => { doUndo(); return 1; })()`, 400);
  const after = await val(`$id('editor').value`);
  return editing === true && histLen > 0 && after === 'A0\n' ? true : `editing=${editing} hist=${histLen} after=${JSON.stringify(after)}`;
});

console.log(`\n=== r12e-editor: ${results.pass}/${results.pass + results.fail} 通过 ===`);
if (results.fail) { console.log('失败清单:', results.fails.join(', ')); process.exit(1); }
ws.close();
process.exit(0);
