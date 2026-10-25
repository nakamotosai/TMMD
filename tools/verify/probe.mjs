// tools/verify/probe.mjs — 一行命令读/改运行中实例的状态(CDP),用于排障与"眼见为实"取证。
// 用法:
//   node tools/verify/probe.mjs --port=9225 "S.editing"                       # 读一个表达式
//   node tools/verify/probe.mjs --port=9225 --text "document.body.innerText"  # 输出原始字符串
//   node tools/verify/probe.mjs --port=9225 --json "{a:1}"                    # JSON 输出
// 只连本机 CDP,不弹任何窗口;不修改文件。退出码:0 成功,2 连不上 CDP,1 表达式抛错。
const args = process.argv.slice(2);
const port = (args.find((a) => a.startsWith('--port=')) || '--port=9225').split('=')[1];
const asText = args.includes('--text');
const expr = args.filter((a) => !a.startsWith('--')).join(' ');
if (!expr) { console.error('usage: probe.mjs [--port=9225] [--text] <expression>'); process.exit(2); }

let targets;
try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); }
catch (e) { console.error(`CDP unreachable on :${port}: ${e.message}`); process.exit(2); }
const page = targets.find((t) => t.type === 'page');
if (!page) { console.error('no page target'); process.exit(2); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws connect failed')); });
const id = 1;
const done = new Promise((res) => { ws.onmessage = (e) => res(JSON.parse(e.data)); });
ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
const msg = await Promise.race([done, new Promise((r) => setTimeout(() => r(null), 20000))]);
ws.close();
if (!msg) { console.error('evaluate timeout'); process.exit(1); }
if (msg.result?.exceptionDetails) {
  console.error('JS EXCEPTION:', JSON.stringify(msg.result.exceptionDetails).slice(0, 500));
  process.exit(1);
}
const v = msg.result?.result?.value;
if (asText) console.log(typeof v === 'string' ? v : JSON.stringify(v));
else console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
process.exit(0);
