#!/usr/bin/env python3
"""tools/verify/update-manifest-check.py — 更新通道的脚本化核验(真起实例、真读清单)。

为什么要有它:更新器是"发布侧一改就整体失效、而且看起来完全正常"的那类功能。
2026-10-25 实测踩到:`latest.json` 带 UTF-8 BOM(PowerShell 5.1 的 `Set-Content -Encoding UTF8` 就会写),
`serde_json` 直接 `expected value at line 1 column 1` —— 通道对外可下载、对内全军覆没。
此前的验证只是"手演一遍"(见 docs/2026-10-25-验证清单.md §7),没有可复跑的脚本。

覆盖:
  1 BOM 清单必须能解析(BOM 是打死整条通道的真凶)
  2 同版本 → 不算更新(None)
  3 sha256 不合法(长度/非十六进制)→ 拒
  4 有新版但下载物 sha 不符 → 下载被拒,且不留下文件
  5 真链路:不带测试缝 → 读 GitHub 的 latest.json → 已是最新(None)

用法(先 `cargo build` 出调试实例,副屏可用,node 在 PATH):
  python tools/verify/update-manifest-check.py [-Port 9241] [-Exe <path>]
"""
import argparse
import hashlib
import json
import os
import re
import socketserver
import subprocess
import sys
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CNW = 0x08000000
TEMP = Path(os.environ.get('TEMP', '/tmp'))


def run(cmd, timeout=180, cwd=None, capture=True):
    """capture=False 时把输出写文件:启动器会拉起 tmmd.exe,子进程继承管道会让
    subprocess.run 在 timeout 杀掉直接子进程后仍等 EOF(实测卡死 40 分钟)。"""
    if capture:
        p = subprocess.run([str(c) for c in cmd], cwd=str(cwd or REPO), capture_output=True, text=True,
                           encoding='utf-8', errors='replace', creationflags=CNW, timeout=timeout)
        return p.returncode, (p.stdout or '') + (p.stderr or '')
    log = TEMP / 'tmmd-updcheck-cmd.log'
    with open(log, 'w', encoding='utf-8') as fh:
        p = subprocess.run([str(c) for c in cmd], cwd=str(cwd or REPO), stdout=fh, stderr=subprocess.STDOUT,
                           creationflags=CNW, timeout=timeout)
    return p.returncode, log.read_text(encoding='utf-8', errors='replace')


def probe(port, expr, timeout=120):
    rc, out = run(['node', str(REPO / 'tools' / 'verify' / 'probe.mjs'), '--port=%d' % port, '--json', expr], timeout=timeout)
    if rc != 0:
        return {'__probe_failed__': out.strip()[:300]}
    try:
        return json.loads(out)
    except Exception:
        return {'__probe_unparsed__': out.strip()[:300]}


def stopall():
    run(['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(REPO / 'tools' / 'verify' / 'stopall.ps1')],
        timeout=300, capture=False)


def launch(exe, port, endpoint):
    cmd = ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
           str(REPO / 'tools' / 'verify' / 'launch-on-secondary.ps1'), '-Exe', str(exe), '-Port', str(port)]
    if endpoint:
        cmd += ['-UpdateEndpoint', endpoint]
    rc, out = run(cmd, timeout=300, capture=False)
    ok = rc == 0 and 'seed doc' in out and 'touchedPrimaryScreen=False' in out
    return ok, out.strip().splitlines()[-3:]


def make_manifest(dirpath, version, url, sha, size, bom=True):
    body = json.dumps({'version': version, 'asset': 'fake-setup.exe', 'url': url,
                       'sha256': sha, 'size': size, 'notes': 'update-manifest-check'}, indent=2)
    raw = body.encode('utf-8')
    (dirpath / 'latest.json').write_bytes((b'\xef\xbb\xbf' + raw) if bom else raw)


class Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


def serve(dirpath, port):
    handler = partial(Quiet, directory=str(dirpath))
    httpd = socketserver.TCPServer(('127.0.0.1', port), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=9241)
    ap.add_argument('--exe', default=str(REPO / 'src-tauri' / 'target' / 'debug' / 'tmmd.exe'))
    ap.add_argument('--srv-port', type=int, default=8791)
    a = ap.parse_args()

    installed = json.loads((REPO / 'src-tauri' / 'tauri.conf.json').read_text(encoding='utf-8'))['version']
    root = TEMP / 'tmmd-updcheck'
    for f in root.glob('*') if root.exists() else []:
        f.unlink()
    root.mkdir(parents=True, exist_ok=True)
    payload = b'not-a-real-installer\n' * 40
    (root / 'fake-setup.exe').write_bytes(payload)
    real_sha = hashlib.sha256(payload).hexdigest()
    base = 'http://127.0.0.1:%d/' % a.srv_port
    httpd = serve(root, a.srv_port)
    results = []

    def case(name, expect_ok, checker, version=installed, sha=None, size=None, bom=True, endpoint=None, exe_call=None, files_check=None):
        make_manifest(root, version, base + 'fake-setup.exe', sha or real_sha, size or len(payload), bom=bom)
        stopall()
        ok, tail = launch(a.exe, a.port, endpoint)
        if not ok:
            results.append((name, False, 'launch failed: ' + ' / '.join(tail)))
            return
        got = probe(a.port, exe_call)
        good = checker(got)
        detail = json.dumps(got, ensure_ascii=False)[:220]
        if good and files_check:
            extra = files_check()
            if not extra[0]:
                good = False
            detail += ' | ' + extra[1]
        results.append((name, good, detail))

    def updates_dir_empty():
        """下载失败后 updates/ 必须不留东西(隔离配置目录里看)。"""
        d = TEMP / 'tmmd-verify-cfg' / 'updates'
        left = sorted(p.name for p in d.glob('*')) if d.exists() else []
        return (len(left) == 0, 'updates/ left=' + json.dumps(left))

    manifest_url = base + 'latest.json'
    case('1 BOM 清单可解析(同版本→None)', True, lambda g: g is None, endpoint=manifest_url,
         exe_call='(async()=>{try{return await invoke("update_check",{force:true})}catch(e){return {err:String(e&&e.message||e)}}})()')
    case('2 sha 长度非法 → 拒', True,
         lambda g: isinstance(g, dict) and 'sha256' in str(g.get('err', '')),
         version='9.9.9', sha='deadbeef', endpoint=manifest_url,
         exe_call='(async()=>{try{return await invoke("update_check",{force:true})}catch(e){return {err:String(e&&e.message||e)}}})()')
    case('3 新版但 sha 不符 → 下载被拒且不留文件', True,
         lambda g: isinstance(g, dict) and not g.get('ok') and '校验失败' in str(g.get('e', '')),
         version='9.9.9', sha='a' * 64, endpoint=manifest_url, files_check=updates_dir_empty,
         exe_call='(async()=>{try{const m=await invoke("update_check",{force:true});await invoke("update_download",{manifest:m});return {ok:true}}catch(e){return {ok:false,e:String(e&&e.message||e)}}})()')
    case('4 真链路(GitHub latest.json)→ 已是最新', True, lambda g: g is None,
         endpoint=None,
         exe_call='(async()=>{try{return await invoke("update_check",{force:true})}catch(e){return {err:String(e&&e.message||e)}}})()')

    stopall()
    httpd.shutdown()
    print(f'installed version: {installed}')
    bad = 0
    for name, good, detail in results:
        print(('  ok   ' if good else '  FAIL ') + name + ' :: ' + detail)
        bad += 0 if good else 1
    print(f'== update-manifest-check: pass={len(results) - bad} fail={bad} ==')
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
