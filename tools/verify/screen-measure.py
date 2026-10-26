#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""screen-measure.py — 装机版**真机截屏**取证 + 像素实测(观感类交付的验收闸)。

为什么单独一件:`tools/verify/*.mjs` 走 CDP,只能看**隔离实例的页面层**;
"装到用户机器上到底长什么样"必须走**屏幕合成像素**(含 DWM 亚克力)。
2026-10-26 的教训:浅色改动只在隔离实例里量过、没装到用户机器上看,
用户看到的还是上一版,旧账记到新改动头上 —— 所以这条闸固定下来。

用法:
    python tools/verify/screen-measure.py --out shot.png                      # 截当前屏幕 + 自动找窗口
    python tools/verify/screen-measure.py --out shot.png --launch <exe>       # 起应用、等它起来再截
    python tools/verify/screen-measure.py --from shot.png --find TMMD         # 量已有截图(按窗口标题定位)
    python tools/verify/screen-measure.py --from shot.png --rect 1470,110,3600,1820
输出:<out> 全屏、<out>.crop.png 窗口裁剪;stdout 打印窗口矩形 / 板色 / 文字对板对比。

注意:窗口若被别的窗口遮挡,"最深 0.05% 像素"会被遮挡者污染 —— 那时只信**板色**(用 --sample 指定纯板区域),
或先把窗口提到最前再截。

坑(2026-10-26 踩过):
  1 屏幕可能是 200% 缩放:`ImageGrab` 拿到的是**物理**像素,而没做 DPI 感知的进程读到的窗口矩形是**虚拟化**的
    —— 本脚本用 GetWindowRect(物理)+ 与截图同尺度,不会错位;
  2 窗口被别的窗口挡住时,按屏幕中心找"浅色矩形"会失败 —— 用 --find <标题子串> 精确定位。
"""
import argparse
import ctypes
import statistics
import subprocess
import sys
import time
from ctypes import wintypes


def dpi_aware():
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)      # PER_MONITOR_DPI_AWARE
    except Exception:
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:
            pass


def lin(c):
    c /= 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def lum(p):
    return 0.2126 * lin(p[0]) + 0.7152 * lin(p[1]) + 0.0722 * lin(p[2])


def is_bright(p, thr=150):
    return lum(p) >= thr


def rect_by_title(sub, pid=0):
    """按窗口标题子串 / 属主 PID 找顶层可见窗口的物理矩形(调用前已做 DPI 感知)。
    按 PID 比按标题可靠:Tauri 会额外建单实例辅助窗口(实测 `Get-Process tmmd` 的
    MainWindowTitle 报 'com.saaaai.tmmd-siw'),标题不等于产品名。"""
    u = ctypes.windll.user32
    found = []
    EnumProc = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)

    def cb(hwnd, _):
        if not u.IsWindowVisible(hwnd):
            return True
        wpid = wintypes.DWORD()
        u.GetWindowThreadProcessId(hwnd, ctypes.byref(wpid))
        n = u.GetWindowTextLengthW(hwnd)
        buf = ctypes.create_unicode_buffer(n + 2)
        if n > 0:
            u.GetWindowTextW(hwnd, buf, n + 1)
        r = wintypes.RECT()
        u.GetWindowRect(hwnd, ctypes.byref(r))
        w, h = r.right - r.left, r.bottom - r.top
        if pid and wpid.value == pid and w > 200 and h > 150:
            found.append((r.left, r.top, r.right, r.bottom, buf.value))
        elif sub and sub.lower() in buf.value.lower() and w > 200 and h > 150:
            found.append((r.left, r.top, r.right, r.bottom, buf.value))
        return True

    u.EnumWindows(EnumProc(cb), 0)
    found.sort(key=lambda f: -(f[2] - f[0]) * (f[3] - f[1]))
    return found


def list_windows(pid=0):
    u = ctypes.windll.user32
    out = []
    EnumProc = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)

    def cb(hwnd, _):
        if not u.IsWindowVisible(hwnd):
            return True
        wpid = wintypes.DWORD()
        u.GetWindowThreadProcessId(hwnd, ctypes.byref(wpid))
        n = u.GetWindowTextLengthW(hwnd)
        buf = ctypes.create_unicode_buffer(n + 2)
        if n > 0:
            u.GetWindowTextW(hwnd, buf, n + 1)
        r = wintypes.RECT()
        u.GetWindowRect(hwnd, ctypes.byref(r))
        w, h = r.right - r.left, r.bottom - r.top
        if w > 200 and h > 150 and (not pid or wpid.value == pid):
            out.append((w * h, wpid.value, buf.value[:38], (r.left, r.top, r.right, r.bottom)))
        return True

    u.EnumWindows(EnumProc(cb), 0)
    out.sort(reverse=True)
    return out


def rect_by_center(px, W, H):
    cx, cy = W // 2, H // 2
    if not is_bright(px.getpixel((cx, cy))):
        return None
    step = 4

    def row_frac(y, x0, x1):
        xs = list(range(x0, x1, step))
        return sum(1 for x in xs if is_bright(px.getpixel((x, y)))) / max(1, len(xs))

    def col_frac(x, y0, y1):
        ys = list(range(y0, y1, step))
        return sum(1 for y in ys if is_bright(px.getpixel((x, y)))) / max(1, len(ys))

    x0 = x1 = cx
    while x0 - step > 0 and is_bright(px.getpixel((x0 - step, cy))):
        x0 -= step
    while x1 + step < W and is_bright(px.getpixel((x1 + step, cy))):
        x1 += step
    y0 = y1 = cy
    while y0 - step > 0 and row_frac(y0 - step, x0, x1) > 0.5:
        y0 -= step
    while y1 + step < H and row_frac(y1 + step, x0, x1) > 0.5:
        y1 += step
    while x1 - x0 > step and col_frac(x1, y0, y1) < 0.5:
        x1 -= step
    while x1 - x0 > step and col_frac(x0, y0, y1) < 0.5:
        x0 += step
    return (x0, y0, x1, y1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True)
    ap.add_argument('--from', dest='src', default='')
    ap.add_argument('--launch', default='')
    ap.add_argument('--find', default='')
    ap.add_argument('--pid', type=int, default=0)
    ap.add_argument('--rect', default='')       # x0,y0,x1,y1(截图坐标)
    ap.add_argument('--sample', default='')     # 板色采样框 x0,y0,x1,y1(截图坐标,必须全是空板)
    ap.add_argument('--wait', type=float, default=10.0)
    a = ap.parse_args()

    dpi_aware()
    if a.launch:
        subprocess.Popen([a.launch], close_fds=True)
        time.sleep(a.wait)
        time.sleep(1.5)   # 首帧之后再等一拍,避开窗口动画

    from PIL import Image, ImageGrab
    img = ImageGrab.grab() if not a.src else Image.open(a.src)
    px = img.convert('RGB')
    W, H = px.size
    img.save(a.out) if not a.src else px.save(a.out)
    print(f'截图 {W}x{H}')

    rect = None
    if a.rect:
        rect = tuple(int(v) for v in a.rect.split(','))
    elif a.pid or a.find:
        cands = rect_by_title(a.find, a.pid)
        if not cands:
            print(f'没找到匹配窗口(pid={a.pid} find={a.find!r});当前可见大窗口:')
            for area, wp, t, r in list_windows(a.pid)[:8]:
                print(f'  pid={wp} 「{t}」 {r}')
            return 1
        for c in cands:
            print(f'  候选窗口 「{c[4]}」 x={c[0]} y={c[1]} w={c[2]-c[0]} h={c[3]-c[1]}')
        rect = cands[0][:4]
    else:
        rect = rect_by_center(px, W, H)
        if not rect:
            print('屏幕中心不是浅色板:可能不是浅色主题,或应用被别的窗口挡住(用 --find 定位)')
            return 1
    x0, y0, x1, y1 = rect
    x0, y0 = max(0, x0), max(0, y0)
    x1, y1 = min(W - 1, x1), min(H - 1, y1)
    crop = px.crop((x0, y0, x1 + 1, y1 + 1))
    crop.save(a.out.replace('.png', '.crop.png'))
    print(f'窗口矩形 x={x0} y={y0} w={x1-x0+1} h={y1-y0+1}')

    if a.sample:
        sx0, sy0, sx1, sy1 = (int(v) for v in a.sample.split(','))
        box = px.crop((max(x0, sx0), max(y0, sy0), min(x1, sx1), min(y1, sy1)))
    else:
        box = crop.crop((int(crop.width * 0.10), int(crop.height * 0.60),
                         int(crop.width * 0.92), int(crop.height * 0.74)))
    band = list(box.getdata())
    med = tuple(int(statistics.median([p[i] for p in band])) for i in range(3))
    print('板色(采样框中位) rgb%s = #%02x%02x%02x  n=%d' % (med, *med, len(band)))

    allp = sorted(crop.getdata(), key=lambda p: -lum(p))
    n = max(1, len(allp) // 2000)
    dark = allp[-n:]
    d = tuple(int(statistics.median([p[i] for p in dark])) for i in range(3))
    la, lb = lum(d), lum(med)
    print('最深 0.05%% 像素 rgb%s(≈字心)  字/板对比 %.2f:1' % (d, (max(la, lb) + 0.05) / (min(la, lb) + 0.05)))
    print('saved', a.out)
    return 0


sys.exit(main())