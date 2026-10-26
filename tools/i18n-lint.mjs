#!/usr/bin/env node
/* ============================================================================
 * TMMD i18n 静态闸 —— tools/i18n-lint.mjs
 *
 * 目的:把"界面残留中文"从"靠眼睛看"变成"可回归的机械闸"。零依赖 / 只读
 * (除本文件外不改任何文件)/ node ESM。
 *
 * 用法:
 *   node tools/i18n-lint.mjs           # 人读报告;有违规退出码 1,全绿 0
 *   node tools/i18n-lint.mjs --json    # 机器可读(CI / r12f 验收用)
 *   node tools/i18n-lint.mjs --all     # 明细不截断(默认每闸只列前 12 条)
 *
 * 五道闸:
 *   G1 字典三语完备        I18N 每个键恰好 3 个非空字符串;键名重复也报
 *   G2 app.js 残留         字典块外的 字符串/模板串/正则/innerHTML 串 不得含汉字
 *   G3 index.html 残留     含汉字的文本节点 / title·aria-label·placeholder·alt·content
 *                          必须挂对应声明式钩子,且键在字典里
 *   G4 钩子键存在性        index.html 里所有 data-i18n* 的键必须存在于字典
 *   G5 Rust 错误串覆盖     lib.rs 里会返回前端的含汉字串,逐条必须被 ERR_MAP 兜住;
 *                          同时反向校验两张映射表指向的字典键都存在
 *
 * 判定口径(启发式的边界)写在文件末尾 NOTES,报告里也会原样打印。
 * ========================================================================== */

import { readFileSync, writeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const ARGV = process.argv.slice(2);
const OPT = {
  json: ARGV.includes('--json'),
  all: ARGV.includes('--all'),
  help: ARGV.includes('--help') || ARGV.includes('-h'),
};
const MAX_SHOW = OPT.all ? Infinity : 12;

const PATHS = {
  js: join(ROOT, 'ui-reader', 'app.js'),
  html: join(ROOT, 'ui-reader', 'index.html'),
  rust: join(ROOT, 'src-tauri', 'src', 'lib.rs'),
};

/* 汉字(含扩展 A 与兼容表意文字)。刻意不含假名 —— 本闸的门槛是"汉字",假名/半角
 * 不在判定范围内(见 NOTES)。 */
const HAN = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;

/* ============================ 白名单(每条必须写清为什么) ====================
 * 每条豁免都是一条"规则 + 理由"。理由同时以注释形式写在源码里,并原样打进报告,
 * 便于复盘"这条豁免凭什么"。hits 会在运行中累加。
 */
const WL = [
  // 理由:注释不是字面量。被注释围住的中文(含整句被注释掉的中文代码)是维护说明,
  //       例如 // t('x','中文') 整段都是注释文本,永远不会进 DOM。
  { id: 'js-comment', gate: 'G2', hits: 0, why: '注释(// 与 /* */)内的中文不是字面量,不进界面;含"被注释围住的字面量"(如 // t(\'x\',\'中文\'))。' },
  // 理由:ERR_MAP / ERR_TAIL_MAP 的职责就是把 lib.rs 的中文错误串翻成字典键,
  //       中文正则模式是它的工作内容本身,不是残留。
  { id: 'err-map-regex', gate: 'G2', hits: 0, why: 'ERR_MAP / ERR_TAIL_MAP 里的正则字面量:该表就是"中文错误串 → 字典键"的翻译器,中文模式是内容。' },
  // 理由:两张映射表里指向的字典键名必须是 ASCII 标识符,不参与翻译。
  { id: 'err-map-key', gate: 'G2', hits: 0, why: '错误映射表指向的字典键名:键名是 ASCII 标识符,不参与翻译。' },
  // 理由:t() 的第一个实参是字典键名(不是界面文案)。
  { id: 't-key', gate: 'G2', hits: 0, why: "t('...') 的第一个实参:字典键名,不是界面文案。" },
  // 理由:I18N_TARGETS 接线表里只有字典键名与 CSS 选择器。
  { id: 'targets-block', gate: 'G2', hits: 0, why: 'I18N_TARGETS 接线表内的字符串:字典键名与 CSS 选择器,不参与翻译。' },
  // 理由:语言自名。语言选择按钮在任何界面语言下都必须显示本语言的原生写法,
  //       把它翻译掉反而是错的。
  { id: 'lang-endonym', gate: 'G2', hits: 0, why: '语言自名(中文 / English / 日本語):语言按钮恒显本语言原生写法,翻译它反而错。' },
  // 理由:HTML 注释不是文本节点。
  { id: 'html-comment', gate: 'G3', hits: 0, why: 'HTML 注释(<!-- -->)不是文本节点,不进界面。' },
  // 理由:<title> 由窗口层决定,不参与运行时语言切换。
  { id: 'title-element', gate: 'G3', hits: 0, why: '<title> 元素文本:窗口标题由 Tauri/系统层决定,不参与运行时切换。' },
  // 理由:meta 是静态元数据(SEO/描述)。
  { id: 'meta-element', gate: 'G3', hits: 0, why: '<meta> 元素含其 content 属性:静态元数据(描述/主题色),不参与界面语言切换。' },
  // 理由:语言按钮文本 = 语言自名。
  { id: 'lang-endonym-el', gate: 'G3', hits: 0, why: '语言按钮(id 含 lang)的文本:语言自名,同上。' },
  // 理由:路径/URL 是数据不是文案(含带汉字的文件名,如 docs/2026-10-24-竞品与差距分析.md)。
  { id: 'path-text', gate: 'G3', hits: 0, why: '形如文件路径/URL 的文本节点(无空格 + 含分隔符 + 以常见扩展名结尾):是数据不是文案,文件名里的汉字属于用户数据。' },
  // 理由:Rust 注释(含文档注释)不参与抽取。
  { id: 'rust-comment', gate: 'G5', hits: 0, why: 'Rust 注释(含 ///、//!、/* */)不参与抽取。' },
];

const ENDONYMS = new Set(['中文', 'English', '日本語', 'Ja', 'EN', 'ZH']);

/* 判定口径,原样打印到报告里 */
const NOTES = [
  'G2 只认"字面量":注释里的中文一律不参与判定 —— 被注释围住的字面量(例如 // t("x","中文"))整段都是注释文本,不是代码。此类按 js-comment 规则豁免并计数。',
  'G2 正则:出现在 ERR_MAP/ERR_TAIL_MAP 之外、又含汉字的正则字面量会报违规(它们同样是会进界面的文本来源);表内正则整体豁免。',
  'G2 模板串只取字面部分,${...} 里的表达式文本不算(那里出现的汉字通常是键名或变量)。',
  'G2 转义写法(如 \\u4e2d)按解码后的值判定,同样会报出来。',
  'G2 不含假名/半角:本闸门槛是"汉字";假名串不进判定范围(如需要可把 HAN 扩成 CJK 全表)。',
  'G2 调整项里提到的 null 是关键字而非字面量(字符串内容不可能是 null),天然不进判定;两张映射表(ERR_MAP 与 ERR_TAIL_MAP)都按"表"豁免。',
  'G3 判定对象 = 文本节点 + title/aria-label/placeholder/alt/content 属性;HTML 注释与 <script>/<style> 正文不算文本节点。',
  'G3 钩子映射:title→data-i18n-title,aria-label→data-i18n-aria,placeholder→data-i18n-ph,alt/content→data-i18n(亦接受 data-i18n-alt / data-i18n-content);文本节点→data-i18n(或 data-i18n-html)。',
  'G3 只看 index.html 上的声明式钩子:若某段文本目前由 I18N_TARGETS(JS)在运行时替换、但 HTML 里没挂钩子,照样报 —— 这正是"声明式接线"要补齐的部分(HTML 在 JS 跑之前是静态可见的)。',
  'G3 只检查"有汉字"的文本/属性:纯 ASCII 的静态文本(类名、快捷键、单位符号)不在闸内。',
  'G5 只抽"错误位"里的中文串,错误位 = Err(...) / ok_or_else / map_err / bail! / anyhow!;语句边界用最近的 ; { } 划定,因此跨行的 format!(...) 也能覆盖。',
  'G5 panic!/expect!/println!/eprintln! 等非错误位的中文串单列为"参考",不参与退出码(它们多数是日志/断言,不返回给前端)。',
  'G5 匹配用字面量原文(保留 {} 占位符),所以 ^前缀 与 $整句$ 两种模式都能命中。',
  'G5 不是"要求 Rust 别写中文" —— Rust 错误串保持中文是既定设计(前端 ERR_MAP 负责翻译),闸只要求"每一条都有映射兜住"。',
];

/* ============================== 通用小工具 ============================== */

const rel = (p) => relative(ROOT, p).split('\\').join('/');

function lineStartsOf(src) {
  const ls = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') ls.push(i + 1);
  return ls;
}
function mkLineAt(ls) {
  return (off) => {
    let lo = 0, hi = ls.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (ls[mid] <= off) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
}
function lineText(src, ls, line) {
  const s = ls[line - 1];
  const e = line < ls.length ? ls[line] : src.length;
  return src.slice(s, e).replace(/\r?\n$/, '');
}
const clip = (s, n = 200) => {
  const one = String(s).replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n) + ' …' : one;
};
function unescapeJs(s) {
  return s.replace(/\\(u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|(\r?\n)|([\s\S]))/g,
    (m, _all, cp, u4, x2, cont, ch) => {
      if (cp) return String.fromCodePoint(parseInt(cp, 16));
      if (u4) return String.fromCharCode(parseInt(u4, 16));
      if (x2) return String.fromCharCode(parseInt(x2, 16));
      if (cont !== undefined) return '';
      const map = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0', "'": "'", '"': '"', '`': '`', '\\': '\\' };
      return Object.prototype.hasOwnProperty.call(map, ch) ? map[ch] : ch;
    });
}
function unescapeRust(s) {
  return s.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r')
    .replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\\\/g, '\\')
    .replace(/\\u\{([0-9a-fA-F]+)\}/g, (m, cp) => String.fromCodePoint(parseInt(cp, 16)))
    .replace(/\\x([0-9a-fA-F]{2})/g, (m, x) => String.fromCharCode(parseInt(x, 16)));
}

/* ============================== JS 词法扫描 ==============================
 * 手写扫描器(不引依赖)。产出 token 流,注释与字符串/模板/正则各自成 token,
 * 位置精确到 offset,便于"字典块外"与行号报告。
 */
const REGEX_PRECEDERS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'case', 'do', 'else', 'yield', 'await', 'throw']);

function skipJsString(src, start) {
  const q = src[start];
  let i = start + 1;
  while (i < src.length) {
    if (src[i] === '\\') { i += 2; continue; }
    if (src[i] === q) return i + 1;
    if (src[i] === '\n') return i;
    i++;
  }
  return i;
}
function scanTemplate(src, start) {
  const segments = [];
  const n = src.length;
  let i = start + 1;
  let segStart = i;
  while (i < n) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '`') { segments.push([segStart, i]); return { end: i + 1, segments }; }
    if (c === '$' && src[i + 1] === '{') {
      segments.push([segStart, i]);
      i += 2;
      let depth = 1;
      while (i < n && depth > 0) {
        const d = src[i];
        if (d === '\\') { i += 2; continue; }
        if (d === "'" || d === '"') { i = skipJsString(src, i); continue; }
        if (d === '`') { i = scanTemplate(src, i).end; continue; }
        if (d === '{') depth++;
        else if (d === '}') { depth--; if (depth === 0) { i++; break; } }
        i++;
      }
      segStart = i;
      continue;
    }
    i++;
  }
  segments.push([segStart, i]);
  return { end: i, segments };
}

function lexJs(src) {
  const ls = lineStartsOf(src);
  const lineAt = mkLineAt(ls);
  const tokens = [];
  const n = src.length;
  let i = 0;
  let prev = null;

  const emit = (type, start, end, extra) => {
    const t = Object.assign({
      type, start, end,
      raw: src.slice(start, end),
      line: lineAt(start),
      endLine: lineAt(Math.max(start, end - 1)),
    }, extra || {});
    tokens.push(t);
    if (type !== 'comment') prev = t;
    return t;
  };
  const regexAllowed = () => {
    if (!prev) return true;
    if (prev.type === 'word') return REGEX_PRECEDERS.has(prev.value);
    if (prev.type === 'number' || prev.type === 'string' || prev.type === 'template' || prev.type === 'regex') return false;
    if (prev.type === 'punct') return !(prev.raw === ')' || prev.raw === ']');
    return true;
  };

  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v' || c === '\u00a0') { i++; continue; }
    if (c === '/' && src[i + 1] === '/') {
      const s = i; i += 2;
      while (i < n && src[i] !== '\n') i++;
      emit('comment', s, i, { kind: 'line' });
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const s = i; i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i = Math.min(n, i + 2);
      emit('comment', s, i, { kind: 'block' });
      continue;
    }
    if (c === "'" || c === '"') {
      const s = i, q = c; i++;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === q) { i++; break; }
        if (src[i] === '\n') break;
        i++;
      }
      const inner = src.slice(s + 1, src[i - 1] === q ? i - 1 : i);
      emit('string', s, i, { quote: q, value: unescapeJs(inner) });
      continue;
    }
    if (c === '`') {
      const { end, segments } = scanTemplate(src, i);
      const value = segments.map(([a, b]) => unescapeJs(src.slice(a, b))).join('\u0000');
      emit('template', i, end, { value, segments });
      i = end;
      continue;
    }
    if (c === '/' && regexAllowed()) {
      const s = i; i++;
      let inClass = false;
      while (i < n) {
        const d = src[i];
        if (d === '\\') { i += 2; continue; }
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) { i++; break; }
        else if (d === '\n') break;
        i++;
      }
      while (i < n && /[a-z]/i.test(src[i])) i++;
      emit('regex', s, i, { value: src.slice(s, i) });
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      const s = i;
      while (i < n && /[\w$]/.test(src[i])) i++;
      emit('word', s, i, { value: src.slice(s, i) });
      continue;
    }
    if (/[0-9]/.test(c)) {
      const s = i;
      while (i < n && /[\w.]/.test(src[i])) i++;
      emit('number', s, i, { value: src.slice(s, i) });
      continue;
    }
    emit('punct', i, i + 1, { value: c });
    i++;
  }
  return { tokens, ls, lineAt };
}

/** 从 openOff 处的 open 符号开始,做配对容器扫描,返回 [start, end] */
function findBlock(src, tokens, openOff, open, close) {
  let depth = 0, started = false;
  for (const t of tokens) {
    if (t.start < openOff) continue;
    if (t.type !== 'punct') continue;
    if (t.raw === open) { depth++; started = true; }
    else if (t.raw === close) {
      depth--;
      if (started && depth === 0) return [openOff, t.end];
    }
  }
  return [openOff, src.length];
}
/** 语句边界(用最近的 ; { } 划定),注释 token 已剔除 */
function stmtText(src, tokens, idx, stops) {
  const set = stops || new Set([';', '{', '}']);
  let a = idx;
  while (a > 0 && !set.has(tokens[a - 1].raw)) a--;
  let b = idx;
  while (b < tokens.length - 1 && !set.has(tokens[b].raw)) b++;
  return tokens.slice(a, b + 1).filter((t) => t.type !== 'comment').map((t) => t.raw).join(' ');
}
function prevSignificant(tokens, idx, k) {
  let j = idx - 1, seen = 0;
  while (j >= 0) {
    if (tokens[j].type !== 'comment') { seen++; if (seen === k) return tokens[j]; }
    j--;
  }
  return null;
}
function reFromRaw(raw) {
  const m = /^\/([\s\S]*)\/([a-z]*)$/.exec(raw);
  if (!m) return null;
  try { return new RegExp(m[1], m[2].replace(/[gy]/g, '')); } catch { return null; }
}

/* ============================== HTML 扫描 ============================== */

const VOID_EL = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

function maskSpans(src, spans) {
  const arr = src.split('');
  for (const [a, b] of spans) {
    for (let k = a; k < b; k++) if (arr[k] !== '\n' && arr[k] !== '\r') arr[k] = ' ';
  }
  return arr.join('');
}
function findTagEnd(s, lt) {
  let i = lt + 1;
  let q = null;
  while (i < s.length) {
    const c = s[i];
    if (q) { if (c === q) q = null; }
    else if (c === '"' || c === "'") q = c;
    else if (c === '>') return i;
    i++;
  }
  return s.length - 1;
}
function parseAttrs(raw) {
  const attrs = new Map();
  const body = raw.replace(/^<\/?\s*[a-zA-Z][\w:-]*/, '').replace(/\/?>\s*$/, ' ');
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?/g;
  let m;
  while ((m = re.exec(body))) {
    const name = m[1].toLowerCase();
    if (name === '/') continue;
    const value = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : '';
    attrs.set(name, { name, value, raw: m[0] });
  }
  return attrs;
}
function scanHtml(src) {
  // 先遮住注释与 <script>/<style> 正文(等比空格,行号不受影响)
  const spans = [];
  let i = 0;
  while ((i = src.indexOf('<!--', i)) !== -1) {
    const e = src.indexOf('-->', i + 4);
    const end = e === -1 ? src.length : e + 3;
    spans.push([i, end]);
    i = end;
  }
  const sre = /<(script|style)\b[^>]*>/gi;
  let sm;
  while ((sm = sre.exec(src))) {
    const close = new RegExp('</' + sm[1] + '\\s*>', 'i');
    close.lastIndex = sm.index + sm[0].length;
    const cm = close.exec(src);
    const end = cm ? cm.index : src.length;
    spans.push([sm.index + sm[0].length, end]);
  }
  const masked = maskSpans(src, spans);

  const tags = [];
  const textNodes = [];
  const stack = [];
  let p = 0;
  const n = masked.length;
  while (p < n) {
    const lt = masked.indexOf('<', p);
    const text = masked.slice(p, lt === -1 ? n : lt);
    if (text.trim()) textNodes.push({ text, start: p, parent: stack.length ? stack[stack.length - 1] : null });
    if (lt === -1) break;
    if (masked[lt + 1] === '!') { const gt = masked.indexOf('>', lt); p = gt === -1 ? n : gt + 1; continue; }
    const gt = findTagEnd(masked, lt);
    const raw = masked.slice(lt, gt + 1);
    const nm = /^<\s*(\/?)\s*([a-zA-Z][\w:-]*)/.exec(raw);
    if (!nm) { p = gt + 1; continue; }
    const closing = !!nm[1];
    const name = nm[2].toLowerCase();
    const tag = { name, raw, start: lt, end: gt + 1, attrs: parseAttrs(raw), closing };
    tags.push(tag);
    if (closing) {
      for (let k = stack.length - 1; k >= 0; k--) if (stack[k].name === name) { stack.length = k; break; }
    } else if (!(/\/\s*>$/.test(raw)) && !VOID_EL.has(name)) {
      stack.push(tag);
    }
    p = gt + 1;
  }
  return { tags, textNodes, masked, spans };
}

/* ============================== Rust 扫描 ============================== */

function lexRust(src) {
  const ls = lineStartsOf(src);
  const lineAt = mkLineAt(ls);
  const toks = [];
  const n = src.length;
  let i = 0;
  const mk = (type, start, end, extra) => Object.assign({
    type, start, end, raw: src.slice(start, end), line: lineAt(start),
  }, extra || {});
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v') { i++; continue; }
    if (c === '/' && src[i + 1] === '/') {
      const s = i; i += 2;
      while (i < n && src[i] !== '\n') i++;
      toks.push(mk('comment', s, i));
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const s = i; i += 2;
      let d = 1;
      while (i < n && d > 0) {
        if (src[i] === '/' && src[i + 1] === '*') { d++; i += 2; continue; }
        if (src[i] === '*' && src[i + 1] === '/') { d--; i += 2; continue; }
        i++;
      }
      toks.push(mk('comment', s, i));
      continue;
    }
    if (c === 'r' && (src[i + 1] === '"' || src[i + 1] === '#')) {
      let j = i + 1, hashes = 0;
      while (src[j] === '#') { hashes++; j++; }
      if (src[j] === '"') {
        const term = '"' + '#'.repeat(hashes);
        const e = src.indexOf(term, j + 1);
        const end = e === -1 ? n : e + term.length;
        toks.push(mk('string', i, end, { value: src.slice(j + 1, e === -1 ? n : e), rawString: true }));
        i = end;
        continue;
      }
    }
    if (c === '"') {
      const s = i; i++;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '"') { i++; break; }
        i++;
      }
      toks.push(mk('string', s, i, { value: unescapeRust(src.slice(s + 1, Math.max(s + 1, i - 1))) }));
      continue;
    }
    if (c === "'") {
      const m = /^'(\\.|[^\\'])'/.exec(src.slice(i));
      if (m) { toks.push(mk('char', i, i + m[0].length, { value: m[1] })); i += m[0].length; continue; }
      toks.push(mk('punct', i, i + 1));
      i++;
      continue;
    }
    if (/[A-Za-z_0-9]/.test(c)) {
      const s = i;
      while (i < n && /[\w]/.test(src[i])) i++;
      toks.push(mk('word', s, i));
      continue;
    }
    toks.push(mk('punct', i, i + 1));
    i++;
  }
  return { toks, ls, lineAt };
}

const RUST_ERR_POS = /(^|[^\w.])Err\s*\(|ok_or_else|map_err|bail!|anyhow!/;
const RUST_REF_POS = /panic!|expect\s*\(|unwrap_or_else|eprintln!|println!|assert\w*!|emit\s*\(|log::/;

/* ============================== 读文件 ============================== */

/* 是不是"路径/URL"文案:无空格 + 含路径分隔符 + 以常见扩展名结尾,或者本身是 http(s)/file URL。
 * 判成路径就不再当"界面文案"要求挂钩子 —— 文件名/URL 里的汉字是用户数据。 */
function looksLikePath(t) {
  const s = String(t).trim();
  if (!s || /\s/.test(s)) return false;
  if (/^(https?|file|data):\/\//i.test(s)) return true;
  if (/[/\\]/.test(s) && /\.[A-Za-z0-9]{1,6}$/.test(s)) return true;
  return false;
}

function die(msg) {
  console.error('[i18n-lint] ' + msg);
  process.exit(2);
}
function readAll() {
  const out = {};
  for (const [k, p] of Object.entries(PATHS)) {
    try { out[k] = readFileSync(p, 'utf8'); }
    catch (e) { die(`读不到 ${rel(p)}: ${e.message}`); }
  }
  return out;
}

/* ============================== 主流程 ============================== */

function main() {
  if (OPT.help) {
    emitOut([
      'TMMD i18n 静态闸 · tools/i18n-lint.mjs',
      '',
      '用法: node tools/i18n-lint.mjs [--json] [--all] [--help]',
      '  (无参)   人读报告;有违规退出码 1,全绿 0',
      '  --json   机器可读 JSON(CI 用),退出码同上',
      '  --all    明细不截断(默认每闸只列前 12 条)',
      '',
      '五道闸: G1 字典三语完备 / G2 app.js 残留汉字 / G3 index.html 残留汉字',
      '        G4 data-i18n 键存在性 / G5 Rust 错误串覆盖',
      '运行时的判定口径与白名单理由会随报告一起打印。',
      '',
    ].join('\n'));
    process.exit(0);
  }
  const SRC = readAll();
  const jsLex = lexJs(SRC.js);
  const jsTokens = jsLex.tokens;
  const jsLS = jsLex.ls;

  const gate = {
    G1: { id: 'G1', title: '字典三语完备', ok: true, items: [] },
    G2: { id: 'G2', title: 'app.js 残留汉字(字典块外)', ok: true, items: [] },
    G3: { id: 'G3', title: 'index.html 残留汉字(缺声明式钩子)', ok: true, items: [] },
    G4: { id: 'G4', title: 'data-i18n 键存在性', ok: true, items: [] },
    G5: { id: 'G5', title: 'Rust 错误串覆盖闸', ok: true, items: [] },
  };
  const fail = (g, item) => { gate[g].ok = false; gate[g].items.push(item); };

  /* ---------- 定位字典块 ---------- */
  const dictM = /\bconst\s+I18N\s*=\s*\{/.exec(SRC.js);
  if (!dictM) die('app.js 里找不到 `const I18N = {`');
  const dictOpenOff = dictM.index + dictM[0].length - 1;
  const [dictStart, dictEnd] = findBlock(SRC.js, jsTokens, dictOpenOff, '{', '}');
  const inDict = (t) => t.start >= dictStart && t.end <= dictEnd;
  const dictTokens = jsTokens.filter(inDict);

  /* ---------- 定位两张错误映射表 / 接线表 ---------- */
  const errMaps = [];
  {
    const re = /\bconst\s+(ERR_MAP|ERR_TAIL_MAP)\s*=\s*\[/g;
    let m;
    while ((m = re.exec(SRC.js))) {
      const openOff = m.index + m[0].length - 1;
      const [s, e] = findBlock(SRC.js, jsTokens, openOff, '[', ']');
      const inner = jsTokens.filter((t) => t.start >= s && t.end <= e);
      const entries = [];
      for (let k = 0; k < inner.length; k++) {
        const t = inner[k];
        if (t.type !== 'regex') continue;
        const cm = inner[k + 1], st = inner[k + 2];
        if (cm && cm.type === 'punct' && cm.raw === ',' && st && st.type === 'string') {
          entries.push({ reTok: t, keyTok: st, key: st.value, re: reFromRaw(t.raw) });
        }
      }
      errMaps.push({ name: m[1], start: s, end: e, entries });
    }
  }
  const inErrMap = (t) => errMaps.some((mp) => t.start >= mp.start && t.end <= mp.end);

  const targetsM = /\bconst\s+I18N_TARGETS\s*=\s*\[/.exec(SRC.js);
  let targetsRange = null;
  if (targetsM) {
    const openOff = targetsM.index + targetsM[0].length - 1;
    targetsRange = findBlock(SRC.js, jsTokens, openOff, '[', ']');
  }
  const inTargets = (t) => targetsRange && t.start >= targetsRange[0] && t.end <= targetsRange[1];

  /* ---------- 解析字典条目 ---------- */
  const dictEntries = [];
  const dupKeys = [];
  const dictKeys = new Map();
  {
    for (let k = 0; k < dictTokens.length; k++) {
      const t = dictTokens[k];
      if (t.type !== 'string') continue;
      const nx = dictTokens[k + 1];
      if (!nx || nx.type !== 'punct' || nx.raw !== ':') continue;
      const vals = [];
      let j = k + 2;
      const arrTok = dictTokens[j];
      if (arrTok && arrTok.type === 'punct' && arrTok.raw === '[') {
        j++;
        while (j < dictTokens.length && !(dictTokens[j].type === 'punct' && dictTokens[j].raw === ']')) {
          // 分隔符不算值;其余 token 一律收进来,好让"不是字符串/为空"能被报出来
          if (!(dictTokens[j].type === 'punct' && dictTokens[j].raw === ',')) vals.push(dictTokens[j]);
          j++;
        }
      }
      dictEntries.push({ keyTok: t, key: t.value, vals, arrTok });
      if (dictKeys.has(t.value)) dupKeys.push({ key: t.value, first: dictKeys.get(t.value), again: t });
      else dictKeys.set(t.value, t);
      k = j;
    }
  }
  const hasKey = (k) => dictKeys.has(k);

  /* ================= G1 字典三语完备 ================= */
  for (const e of dictEntries) {
    const bad = [];
    if (e.vals.length !== 3) bad.push(`值有 ${e.vals.length} 项(应为 3)`);
    e.vals.forEach((v, i) => {
      const tag = ['zh', 'en', 'ja'][i] || `#${i + 1}`;
      if (v.type !== 'string' && v.type !== 'template') bad.push(`${tag} 不是字符串字面量`);
      else if (!String(v.value).trim()) bad.push(`${tag} 为空`);
    });
    if (bad.length) {
      fail('G1', {
        file: rel(PATHS.js), line: e.keyTok.line, kind: 'value', key: e.key,
        text: `${e.keyTok.raw}: [${e.vals.map((v) => v.raw).join(', ')}]`,
        detail: bad.join('; '),
      });
    }
  }
  for (const d of dupKeys) {
    fail('G1', {
      file: rel(PATHS.js), line: d.again.line, kind: 'duplicate-key', key: d.key,
      text: lineText(SRC.js, jsLS, d.again.line).trim(),
      detail: `键名重复:首次出现于第 ${d.first.line} 行`,
    });
  }

  /* ================= G2 app.js 残留 ================= */
  for (let k = 0; k < jsTokens.length; k++) {
    const t = jsTokens[k];
    if (t.type === 'comment') {
      if (HAN.test(t.raw)) WL.find((w) => w.id === 'js-comment').hits++;
      continue;
    }
    if (t.type !== 'string' && t.type !== 'template' && t.type !== 'regex') continue;
    if (inDict(t)) continue;
    if (!HAN.test(t.value)) continue;

    let rule = null;
    if (t.type === 'regex' && inErrMap(t)) rule = 'err-map-regex';
    else if (t.type === 'string' && inErrMap(t)) rule = 'err-map-key';
    else if (t.type === 'string' && inTargets(t)) rule = 'targets-block';
    else {
      const p1 = prevSignificant(jsTokens, k, 1);
      const p2 = prevSignificant(jsTokens, k, 2);
      if (p1 && p1.type === 'punct' && p1.raw === '(' && p2 && p2.type === 'word' && (p2.value === 't' || p2.value === 'trErr')) rule = 't-key';
      else if (t.type === 'string' && ENDONYMS.has(t.value) && /lang/i.test(lineText(SRC.js, jsLS, t.line))) rule = 'lang-endonym';
    }
    if (rule) { WL.find((w) => w.id === rule).hits++; continue; }

    const stmt = stmtText(SRC.js, jsTokens, k);
    fail('G2', {
      file: rel(PATHS.js), line: t.line, endLine: t.endLine,
      kind: t.type === 'template' ? 'template' : t.type === 'regex' ? 'regex' : (/innerHTML/.test(stmt) ? 'innerHTML' : 'string'),
      text: clip(t.raw),
      detail: clip(lineText(SRC.js, jsLS, t.line)),
    });
  }

  /* ================= G3 / G4 index.html ================= */
  const dom = scanHtml(SRC.html);
  const htmlLS = lineStartsOf(SRC.html);
  const ATTR_HOOKS = {
    title: ['data-i18n-title'],
    'aria-label': ['data-i18n-aria', 'data-i18n-title'],
    placeholder: ['data-i18n-ph', 'data-i18n-placeholder'],
    alt: ['data-i18n-alt', 'data-i18n'],
    content: ['data-i18n-content', 'data-i18n'],
  };
  const TEXT_HOOKS = ['data-i18n', 'data-i18n-html'];
  const hasHook = (attrs, names) => names.some((nm) => attrs.has(nm));

  // G3-属性
  for (const tg of dom.tags) {
    for (const [an, av] of tg.attrs) {
      if (!ATTR_HOOKS[an]) continue;
      if (!HAN.test(av.value)) continue;
      if (tg.name === 'meta') { WL.find((w) => w.id === 'meta-element').hits++; continue; }
      if (hasHook(tg.attrs, ATTR_HOOKS[an])) continue;
      fail('G3', {
        file: rel(PATHS.html), line: attrLine(htmlLS, tg, av),
        kind: `attr:${an}`, text: clip(tg.raw),
        detail: `属性 ${an}="${clip(av.value, 60)}" 含汉字,但没有 ${ATTR_HOOKS[an].join(' / ')}`,
      });
    }
  }
  // G3-文本节点
  for (const tn of dom.textNodes) {
    if (!HAN.test(tn.text)) continue;
    const parent = tn.parent;
    const line = mkLineAt(htmlLS)(tn.start);
    if (!parent) {
      fail('G3', { file: rel(PATHS.html), line, kind: 'text', text: clip(tn.text), detail: '顶层文本节点(无父元素可挂钩子)' });
      continue;
    }
    if (parent.name === 'title') { WL.find((w) => w.id === 'title-element').hits++; continue; }
    if (parent.name === 'meta') { WL.find((w) => w.id === 'meta-element').hits++; continue; }
    const pid = (parent.attrs.get('id') || {}).value || '';
    if (ENDONYMS.has(tn.text.trim()) && /lang/i.test(pid)) { WL.find((w) => w.id === 'lang-endonym-el').hits++; continue; }
    if (looksLikePath(tn.text)) { WL.find((w) => w.id === 'path-text').hits++; continue; }
    if (hasHook(parent.attrs, TEXT_HOOKS)) continue;
    fail('G3', {
      file: rel(PATHS.html), line, kind: 'text', text: clip(tn.text),
      detail: `文本节点("${clip(tn.text.trim(), 40)}")的父元素 <${parent.name}${pid ? ' id="' + pid + '"' : ''}> 缺 ${TEXT_HOOKS.join(' / ')}`,
    });
  }
  // 顺带统计 html 注释豁免
  for (const [a, b] of dom.spans) if (SRC.html.slice(a, b).startsWith('<!--') && HAN.test(SRC.html.slice(a, b))) WL.find((w) => w.id === 'html-comment').hits++;

  // G4 钩子键存在性
  const hookAttrs = new Set(['data-i18n', 'data-i18n-title', 'data-i18n-aria', 'data-i18n-ph', 'data-i18n-placeholder', 'data-i18n-html', 'data-i18n-alt', 'data-i18n-content']);
  const hookKeysSeen = new Set();
  for (const tg of dom.tags) {
    for (const [an, av] of tg.attrs) {
      if (!hookAttrs.has(an)) continue;
      const keys = String(av.value).split(',').map((s) => s.trim()).filter(Boolean);
      if (!keys.length) {
        fail('G4', { file: rel(PATHS.html), line: mkLineAt(htmlLS)(tg.start), kind: 'empty', text: clip(tg.raw), detail: `${an} 是空值` });
        continue;
      }
      for (const key of keys) {
        hookKeysSeen.add(key);
        if (!hasKey(key)) {
          fail('G4', { file: rel(PATHS.html), line: mkLineAt(htmlLS)(tg.start), kind: 'missing-key', key, text: clip(tg.raw), detail: `${an}="${key}" 在字典里不存在` });
        }
      }
    }
  }

  /* ================= G5 Rust 错误串覆盖 ================= */
  const rs = lexRust(SRC.rust);
  const errMapAll = errMaps.flatMap((mp) => mp.entries);
  const rustCovered = [];
  const rustUncovered = [];
  const rustRef = [];
  for (let k = 0; k < rs.toks.length; k++) {
    const t = rs.toks[k];
    if (t.type === 'comment') { if (HAN.test(t.raw)) WL.find((w) => w.id === 'rust-comment').hits++; continue; }
    if (t.type !== 'string' && t.type !== 'char') continue;
    if (!HAN.test(t.value)) continue;
    const stmt = stmtText(SRC.rust, rs.toks, k);
    if (!RUST_ERR_POS.test(stmt)) {
      rustRef.push({ file: rel(PATHS.rust), line: t.line, text: clip(t.raw), detail: RUST_REF_POS.test(stmt) ? '非错误位(日志/断言/事件)' : '非错误位(未被 Err/ok_or_else/map_err 包住)' });
      continue;
    }
    const probe = t.value;
    const hit = errMapAll.find((en) => en.re && en.re.test(probe));
    if (hit) rustCovered.push({ file: rel(PATHS.rust), line: t.line, text: clip(t.raw), key: hit.key });
    else {
      rustUncovered.push({
        file: rel(PATHS.rust), line: t.line, kind: 'uncovered', text: clip(t.raw),
        detail: `错误位中文串没有任何 ERR_MAP 规则兜住 → EN/JA 界面会漏出中文:${clip(t.value, 80)}`,
      });
      fail('G5', rustUncovered[rustUncovered.length - 1]);
    }
  }
  // 反向:映射表指向的键必须在字典里
  const reverseMissing = [];
  for (const mp of errMaps) {
    for (const en of mp.entries) {
      if (!hasKey(en.key)) {
        reverseMissing.push({ file: rel(PATHS.js), line: en.keyTok.line, kind: 'orphan-key', key: en.key, text: clip(en.reTok.raw + ', ' + en.keyTok.raw), detail: `${mp.name} 指向的字典键 "${en.key}" 不存在` });
        fail('G5', reverseMissing[reverseMissing.length - 1]);
      }
    }
  }

  /* ================= 输出 ================= */
  const summary = {
    tool: 'tools/i18n-lint.mjs',
    ok: Object.values(gate).every((g) => g.ok),
    files: Object.fromEntries(Object.entries(PATHS).map(([k, p]) => [k, { path: rel(p), lines: SRC[k].split('\n').length }])),
    dict: {
      entries: dictEntries.length,
      keys: dictKeys.size,
      duplicates: dupKeys.length,
      errMap: errMaps.find((m) => m.name === 'ERR_MAP')?.entries.length ?? 0,
      errTailMap: errMaps.find((m) => m.name === 'ERR_TAIL_MAP')?.entries.length ?? 0,
    },
    gates: Object.values(gate).map((g) => ({ id: g.id, title: g.title, ok: g.ok, violations: g.items.length, items: g.items })),
    rust: { covered: rustCovered.length, uncovered: rustUncovered.length, advisory: rustRef },
    html: { hookKeys: [...hookKeysSeen].sort() },
    whitelist: WL.map((w) => ({ id: w.id, gate: w.gate, hits: w.hits, why: w.why })),
    notes: NOTES,
  };

  if (OPT.json) {
    emitOut(JSON.stringify(summary, null, 2) + '\n');
    process.exit(summary.ok ? 0 : 1);
  }

  const L = [];
  const head = (s) => L.push('\n── ' + s + ' ' + '─'.repeat(Math.max(0, 62 - s.length)));
  const show = (g) => {
    const items = OPT.all ? g.items : g.items.slice(0, MAX_SHOW);
    for (const it of items) {
      const loc = it.endLine && it.endLine !== it.line ? `${it.file}:${it.line}-${it.endLine}` : `${it.file}:${it.line}`;
      L.push(`   · ${loc}  [${it.kind}${it.key ? ' ' + it.key : ''}]  ${it.detail}`);
      if (it.text) L.push(`       ${it.text}`);
    }
    if (!OPT.all && g.items.length > MAX_SHOW) L.push(`   … 其余 ${g.items.length - MAX_SHOW} 条省略(加 --all 看全量)`);
  };

  L.push('TMMD i18n 静态闸  ·  tools/i18n-lint.mjs');
  L.push('扫描: ' + Object.entries(PATHS).map(([k, p]) => `${rel(p)} (${SRC[k].split('\n').length} 行)`).join('  ·  '));
  L.push(`字典: ${dictKeys.size} 键 / ${dictEntries.length} 条  ·  错误映射: ERR_MAP ${summary.dict.errMap} 条, ERR_TAIL_MAP ${summary.dict.errTailMap} 条`);

  head(`${gate.G1.id} ${gate.G1.title} —— ${gate.G1.ok ? 'PASS' : 'FAIL ' + gate.G1.items.length}`);
  show(gate.G1);
  head(`${gate.G2.id} ${gate.G2.title} —— ${gate.G2.ok ? 'PASS' : 'FAIL ' + gate.G2.items.length}`);
  show(gate.G2);
  head(`${gate.G3.id} ${gate.G3.title} —— ${gate.G3.ok ? 'PASS' : 'FAIL ' + gate.G3.items.length}`);
  show(gate.G3);
  head(`${gate.G4.id} ${gate.G4.title} —— ${gate.G4.ok ? 'PASS' : 'FAIL ' + gate.G4.items.length}`);
  if (!gate.G4.items.length) L.push(`   · index.html 里的 data-i18n* 键:${hookKeysSeen.size ? [...hookKeysSeen].join(', ') : '(无 —— 声明式钩子尚未接线)'}`);
  show(gate.G4);
  head(`${gate.G5.id} ${gate.G5.title} —— ${gate.G5.ok ? 'PASS' : 'FAIL ' + gate.G5.items.length}`);
  L.push(`   · 错误位中文串:兜住 ${rustCovered.length} 条,漏出 ${rustUncovered.length} 条`);
  show(gate.G5);
  if (rustRef.length) {
    L.push(`   · 参考(非错误位中文串 ${rustRef.length} 条,不计入退出码):`);
    for (const r of (OPT.all ? rustRef : rustRef.slice(0, 6))) L.push(`       ${r.file}:${r.line}  ${r.text}  — ${r.detail}`);
    if (!OPT.all && rustRef.length > 6) L.push(`       … 其余 ${rustRef.length - 6} 条省略`);
  }

  head('白名单(每条豁免的理由都写在这里;命中 = 被这条规则挡下的"含汉字"条数)');
  for (const w of WL) L.push(`   · [${w.gate}] ${w.id}  (命中 ${w.hits} 条含汉字项)\n       ${w.why}`);

  head('判定口径(启发式边界)');
  for (const nt of NOTES) L.push('   · ' + nt);

  head('汇总');
  for (const g of Object.values(gate)) L.push(`   ${g.ok ? 'PASS' : 'FAIL'}  ${g.id}  ${g.title}  ${g.ok ? '' : '违规 ' + g.items.length}`);
  L.push(`\n${summary.ok ? '全绿(退出码 0)' : '有未整改项(退出码 1)'}`);
  emitOut(L.join('\n') + '\n');
  process.exit(summary.ok ? 0 : 1);
}

/* 直接同步写 fd 1:管道被 head 截断时既不会丢内容,也不会抛 EPIPE 栈。 */
function emitOut(s) {
  try { writeSync(1, s); }
  catch (e) { if (!e || (e.code !== 'EPIPE' && e.code !== 'EBADF')) throw e; }
}

/* 属性违规定位:取属性在标签原文里的偏移,折算成行号 */
function attrLine(ls, tg, av) {
  let off = tg.raw.indexOf(av.name + '=');
  if (off === -1) off = tg.raw.indexOf(av.name);
  if (off === -1) off = 0;
  return mkLineAt(ls)(tg.start + off);
}

main();