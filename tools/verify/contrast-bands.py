#!/usr/bin/env python3
"""tools/verify/contrast-bands.py - 用真实合成像素算"窗内最坏对比度"。

为什么需要它:玻璃浓度与文字对比度是一对矛盾(浓度越低越透、亮壁纸处正文越糊)。
docs/CHANGELOG.md 里那些"conc 45 → 中位 3.71:1 / 最坏 2.15:1"的数字此前没有可复跑的
工具,别人(或半年后的自己)无法复核。这个脚本就是那把尺子。

口径(与文档一致):
  * 只取 `--band` 指定的"壁纸能透出来的正文区",按 `--strips` 切成横条;
  * 每条取**逐通道中位色**(中位能自动滤掉字形像素——一行里字只占少数);
  * 中位对比度 = 各条对比度的中位数;最坏对比度 = 最差的那一条(通常是最亮的壁纸带);
  * 对比度按 WCAG 2.x 相对亮度算:(L1+0.05)/(L2+0.05)。

**必须给 `--mask-png`**:同一场景、换一档浓度再抓的**另一张**图。两张图相减,像素值跟着浓度变的
才算"玻璃区"——文档里的不透明配图/代码块/窗口外桌面都不变,自动被剔除。否则最坏值会被
README 那张淡黄底配图(`#f7edc4`,30 条里 1 条)钉死在 1.06:1,量出来是图不是玻璃。

用法(先抓图,再量):
  powershell -File tools/verify/capture-secondary.ps1 -Out C:\\tmp\\c40.png
  # 切到另一档浓度(probe.mjs)再抓一张 → 作为遮蔽参照
  powershell -File tools/verify/capture-secondary.ps1 -Out C:\\tmp\\c70.png
  python tools/verify/contrast-bands.py --png C:\\tmp\\c40.png --mask-png C:\\tmp\\c70.png \
      --band 921,211,920,1346 --fg "#e8e6e3" [--strips 30] [--min-glass 0.25] [--json]

坐标一律是**副屏本地物理像素**(capture-secondary.ps1 的 -Rect 同一坐标系)。
"""
import argparse
import json
import sys

import numpy as np
from PIL import Image


def srgb_lum(rgb: np.ndarray) -> np.ndarray:
    """WCAG 相对亮度(输入 0-255 的 sRGB,输出 0-1)。"""
    c = rgb.astype(np.float64) / 255.0
    c = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    return c[..., 0] * 0.2126 + c[..., 1] * 0.7152 + c[..., 2] * 0.0722


def ratio(l1: float, l2: float) -> float:
    hi, lo = (l1, l2) if l1 >= l2 else (l2, l1)
    return (hi + 0.05) / (lo + 0.05)


def parse_hex(s: str) -> tuple:
    s = s.strip().lstrip("#")
    return tuple(int(s[i:i + 2], 16) for i in (0, 2, 4))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--png", required=True)
    ap.add_argument("--mask-png", help="另一档浓度的同场景抓图:pixel 值随浓度变的才算玻璃区")
    ap.add_argument("--mask-thresh", type=int, default=3, help="判定'随浓度变化'的最小通道差(默认 3)")
    ap.add_argument("--min-glass", type=float, default=0.25, help="一条里玻璃像素占比低于此值就跳过(默认 0.25)")
    ap.add_argument("--band", required=True, help="x,y,w,h  正文取样区(副屏本地物理像素)")
    ap.add_argument("--fg", required=True, help="文字色,#rrggbb")
    ap.add_argument("--strips", type=int, default=30, help="横条数(默认 30)")
    ap.add_argument("--step", type=int, default=2, help="采样步长(默认 2)")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    x, y, w, h = (int(v) for v in a.band.split(","))
    img = np.asarray(Image.open(a.png).convert("RGB"))
    ih, iw = img.shape[:2]
    x0, y0 = max(0, x), max(0, y)
    x1, y1 = min(iw, x + w), min(ih, y + h)
    if x1 <= x0 or y1 <= y0:
        print(f"band out of image: band={a.band} image={iw}x{ih}", file=sys.stderr)
        return 2

    glass = None
    if a.mask_png:
        ref = np.asarray(Image.open(a.mask_png).convert("RGB"))
        if ref.shape != img.shape:
            print(f"mask size mismatch: {ref.shape} vs {img.shape}", file=sys.stderr)
            return 2
        glass = np.abs(img.astype(np.int16) - ref.astype(np.int16)).max(axis=2) >= a.mask_thresh

    fg = parse_hex(a.fg)
    fg_lum = float(srgb_lum(np.array(fg)))
    rows = np.array_split(np.arange(y0, y1), a.strips)

    strips, skipped = [], 0
    for r in rows:
        if r.size == 0:
            continue
        block = img[r[0]:r[-1] + 1, x0:x1:a.step, :].reshape(-1, 3)
        keep = None
        if glass is not None:
            keep = glass[r[0]:r[-1] + 1, x0:x1:a.step].reshape(-1)
            frac = float(keep.mean()) if keep.size else 0.0
            if frac < a.min_glass:
                skipped += 1
                continue
            block = block[keep]
        med = np.median(block, axis=0)                     # 逐通道中位:自动滤掉字形像素
        lum = float(srgb_lum(med))
        strips.append({
            "y": int(r[0]),
            "rgb": [int(v) for v in med],
            "lum": round(lum, 4),
            "glass_frac": round(float(keep.mean()), 3) if keep is not None else None,
            "contrast": round(ratio(fg_lum, lum), 2),
        })

    if not strips:
        print("no usable strips (all below --min-glass)", file=sys.stderr)
        return 1

    cons = np.array([s["contrast"] for s in strips])
    lums = np.array([s["lum"] for s in strips])
    worst = strips[int(np.argmin(cons))]
    best = strips[int(np.argmax(cons))]
    out = {
        "fg": "#%02x%02x%02x" % fg,
        "fg_lum": round(fg_lum, 4),
        "median_contrast": round(float(np.median(cons)), 2),
        "worst_contrast": worst["contrast"],
        "worst_rgb": "#%02x%02x%02x" % tuple(worst["rgb"]),
        "worst_y": worst["y"],
        "best_contrast": best["contrast"],
        "median_band_lum": round(float(np.median(lums)), 4),
        "brightest_band_lum": round(float(np.max(lums)), 4),
        "strips": len(strips),
        "strips_skipped": skipped,
    }
    if a.json:
        print(json.dumps(out, ensure_ascii=False))
    else:
        print(f"fg {out['fg']} (lum {out['fg_lum']})  strips={out['strips']} "
              f"(跳过不透明条 {out['strips_skipped']})  band={a.band}")
        print(f"  中位对比度 {out['median_contrast']}:1   最坏 {out['worst_contrast']}:1 "
              f"@ y={out['worst_y']} ({out['worst_rgb']})   最好 {out['best_contrast']}:1")
        print(f"  壁纸带亮度: 中位 {out['median_band_lum']}  最亮 {out['brightest_band_lum']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
