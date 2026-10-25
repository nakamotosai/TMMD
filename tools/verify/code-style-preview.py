#!/usr/bin/env python3
"""code-style-preview.py — 把 code-style-shots.mjs 出的**透明页面截图**贴到壁纸样本上,出一张对照图,给人拍板用。

用法:
    python tools/verify/code-style-preview.py \
        --shots "%TEMP%\\code-shots" \
        --wallpaper "%TEMP%\\pebrel-paste-3TDQ5X.png" \
        --out docs/preview/code-styles.png

诚实边界(别把这张图当成"真机合成像素"):
  * 页面层 = 遮蔽背景后的**真截图**(Emulation.setDefaultBackgroundColorOverride alpha=0),谁画了什么板就是什么;
  * 壁纸 = 从用户截图里**无文字边缘**取一条,横向拉伸 + 高斯模糊,**近似** DWM acrylic 的模糊底;
    真实窗口里 DWM 的模糊半径/亮度与这里不完全一致,所以这张图适合**比较四档之间的差别**,不适合量绝对对比度
    (绝对对比度用 capture-secondary.ps1 + contrast-bands.py 在真屏上量)。
"""
from __future__ import annotations

import argparse
import os
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

FONT_CANDIDATES = [
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\msyhl.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
    r"C:\Windows\Fonts\segoeui.ttf",
]


def load_font(size: int):
    for p in FONT_CANDIDATES:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                continue
    return ImageFont.load_default()


def make_backdrop(wallpaper: str, size: tuple[int, int], blur: float) -> Image.Image:
    """从壁纸样本的**无文字边缘**取一条 → 拉伸 → 模糊,得到近似 acrylic 的底。"""
    wp = Image.open(wallpaper).convert("RGB")
    W, H = wp.size
    strip_w = max(24, min(90, W // 8))
    strip = wp.crop((0, 0, strip_w, H))                      # 左侧留白 = 纯壁纸(截图里文字从 ~x=85 起)
    bg = strip.resize(size, Image.LANCZOS)
    bg = bg.filter(ImageFilter.GaussianBlur(blur))
    return bg


def panel(backdrop: Image.Image, shot: str, label: str, cell: tuple[int, int], font) -> Image.Image:
    cw, ch = cell
    tile = backdrop.copy().convert("RGBA")
    layer = Image.open(shot).convert("RGBA")
    if layer.size != cell:
        layer = layer.resize(cell, Image.LANCZOS)             # 700×430 → 420×258,比例几乎一致
    tile.alpha_composite(layer)
    out = Image.new("RGBA", (cw, ch + 26), (0, 0, 0, 0))
    out.paste(tile, (0, 26))
    d = ImageDraw.Draw(out)
    d.rectangle([0, 0, cw - 1, 24], fill=(24, 24, 26, 255))            # 标题条(只占 25px 高)
    d.rectangle([0, 0, cw - 1, ch + 25], outline=(70, 68, 64, 255))    # 整格描边(不填充)
    d.text((8, 4), label, font=font, fill=(235, 219, 178, 255))
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--shots", required=True)
    ap.add_argument("--wallpaper", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--cell-w", type=int, default=420)
    ap.add_argument("--blur", type=float, default=16.0)
    # 也可以只导出壁纸底(feed 给 code-style-shots.mjs --backdrop,让页面自己画这层底,截图即真合成)
    ap.add_argument("--backdrop-out")
    ap.add_argument("--backdrop-size", default="1502x803")
    a = ap.parse_args()

    if a.backdrop_out:
        w, h = (int(x) for x in a.backdrop_size.lower().split("x"))
        make_backdrop(a.wallpaper, (w, h), a.blur).save(a.backdrop_out)
        print(f"== backdrop {a.backdrop_size} → {a.backdrop_out} ==")
        return 0

    names = [("01-old", "① 旧版 v1.8.3(灰块)"), ("02-wash", "② 荧光笔 wash(新默认)"),
             ("03-underline", "③ 下划线 underline"), ("04-bare", "④ 无痕 bare"),
             ("05-plate", "⑤ 薄底 plate")]
    shots = [(f, lbl) for f, lbl in names if os.path.exists(os.path.join(a.shots, f + ".png"))]
    if not shots:
        print(f"no shots in {a.shots}", file=sys.stderr)
        return 2

    cell_w = a.cell_w
    cell_h = int(round(cell_w / (700 / 430)))                 # 与截图同为 ~1.63:1,不裁不拉变形
    backdrop = make_backdrop(a.wallpaper, (cell_w, cell_h), a.blur)
    font = load_font(14)

    cols = 3
    rows = (len(shots) + cols - 1) // cols
    pad, top = 10, 34
    footer = 46
    W = cols * cell_w + (cols + 1) * pad
    H = top + rows * (cell_h + 26) + (rows - 1) * pad + footer
    canvas = Image.new("RGB", (W, H), (16, 16, 18))
    d = ImageDraw.Draw(canvas)
    d.text((pad, 10), "TMMD 行内代码样式对照(页面层透明截图 @ 玻璃浓度 40% + 壁纸样本近似)", font=load_font(15), fill=(235, 219, 178))

    for i, (f, lbl) in enumerate(shots):
        r, c = divmod(i, cols)
        x = pad + c * (cell_w + pad)
        y = top + r * (cell_h + 26 + pad)
        canvas.paste(panel(backdrop, os.path.join(a.shots, f + ".png"), lbl, (cell_w, cell_h), font), (x, y), None)

    note = ("页面层为**真截图**;底是壁纸无文字边缘取样 + 拉伸模糊后贴进页面的近似底(近似 DWM acrylic)—— "
            "适合比较四档差别,不适合量绝对对比度。代码块 pre 本轮未动(仍 α≥0.9)。")
    d.text((pad, H - footer + 8), note[:150], font=load_font(12), fill=(168, 153, 132))
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    canvas.save(a.out)
    print(f"== {len(shots)} 档对照图 → {a.out} ({canvas.size[0]}x{canvas.size[1]}) ==")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
