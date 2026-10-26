"""tools/verify/light-contrast.py - 把 CDP 截的透明页面合到真壁纸上,算每个文字块的真实对比度。

为什么不是直接量截图:透明窗的页面层只有"板"(比如浅色 76% 米黄),后面那张照片壁纸不在页面里,
DWM 负责模糊它。要回答"字看不看得清",必须把两层合起来量。这里用用户的真壁纸
(注册表 HKCU\\Control Panel\\Desktop\\WallPaper)+ 高斯模糊近似 acrylic,再合页面截图(带 alpha)。

用法:
  python tools/verify/light-contrast.py --shot C:\\tmp\\light-after.png --json C:\\tmp\\light-after.json
                                          [--wallpaper <png>] [--blur 42] [--crop 0.34,0.62,0.80,0.95]
"""
import argparse
import io
import json
import sys

from PIL import Image, ImageFilter

DEFAULT_WALL = r"C:\Users\sai\Desktop\生图\巨型黑洞与梦幻吸积盘_upscayl_5760px_digital-art-4x.png"


def lin(c):
    c /= 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def lum(p):
    r, g, b = (lin(x) for x in p[:3])
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def ratio(a, b):
    la, lb = lum(a), lum(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def parse_color(s):
    """同时吃 rgb(a,b,c) / rgba(...) 与 color(srgb 0-1 0-1 0-1 / a)。"""
    s = s.strip()
    if s.startswith("color("):
        body = s[s.index("(") + 1 : s.index(")")].replace("/", " ").split()
        vals = [float(x) for x in body[1:]]
        rgb = [round(v * 255) for v in vals[:3]]
        a = vals[3] if len(vals) > 3 else 1.0
        return tuple(rgb) + (a,)
    if s.startswith("rgb"):
        nums = s[s.index("(") + 1 : s.index(")")].replace("/", ",").split(",")
        vals = [float(x.strip()) for x in nums if x.strip()]
        return tuple(int(round(v)) for v in vals[:3]) + (vals[3] if len(vals) > 3 else 1.0,)
    return (0, 0, 0, 1.0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--shot", required=True)
    ap.add_argument("--json", required=True)
    ap.add_argument("--wallpaper", default=DEFAULT_WALL)
    ap.add_argument("--blur", type=float, default=42.0, help="acrylic 模糊半径近似(px,按 1440 宽)")
    ap.add_argument("--crop", default="0.30,0.58,0.86,0.98", help="壁纸取样区 x0,y0,x1,y1(比例)")
    ap.add_argument("--out", default="", help="合成图输出路径(默认 shot 同目录 -composite.png)")
    args = ap.parse_args()

    shot = Image.open(args.shot).convert("RGBA")
    W, H = shot.size
    wall = Image.open(args.wallpaper).convert("RGB")
    x0, y0, x1, y1 = (float(v) for v in args.crop.split(","))
    box = (int(wall.width * x0), int(wall.height * y0), int(wall.width * x1), int(wall.height * y1))
    wall = wall.crop(box)
    # 覆盖取样:等比放大到能盖住窗口,再居中裁
    s = max(W / wall.width, H / wall.height)
    wall = wall.resize((max(W, int(wall.width * s)), max(H, int(wall.height * s))), Image.LANCZOS)
    left = (wall.width - W) // 2
    top = (wall.height - H) // 2
    wall = wall.crop((left, top, left + W, top + H))
    wall = wall.filter(ImageFilter.GaussianBlur(args.blur * W / 1440.0))
    comp = Image.alpha_composite(wall.convert("RGBA"), shot).convert("RGB")

    out = args.out or (args.shot[:-4] + "-composite.png")
    comp.save(out)

    data = json.load(io.open(args.json, encoding="utf-8"))
    # rect 是 CSS px;截图是设备像素 → 按比例换算后再采样(否则采到的是半尺寸位置的空白)
    vp_w = data["data"]["viewport"]["w"] or W
    k = W / float(vp_w)
    print(f"合成图 {out}  ({W}x{H})   壁纸 {args.wallpaper.split(chr(92))[-1][:34]}… 模糊 {args.blur}px")
    print(f"玻璃 conc={data['data']['glass']['conc']}  板(body 背景,页面层)= {data['data']['body']['bg']}")
    print()
    print(f"{'文字块':12s}{'字色':>10s}{'字/板':>9s}{'局部底(实测)':>14s}{'字/底':>9s}{'AA极值':>9s}   判定")
    worst = []
    for r in data["data"]["rows"]:
        if not r.get("present"):
            continue
        c = r["rect"]
        if c["w"] < 2 or c["h"] < 2:
            continue
        box = (int(c["x"] * k), int(c["y"] * k), int((c["x"] + c["w"]) * k), int((c["y"] + c["h"]) * k))
        crop = comp.crop(box)
        px = list(crop.getdata())
        if not px:
            continue
        px.sort(key=lum)
        n = max(1, len(px) // 50)          # 别用 k:k 是设备像素换算系数,复用会把 box 撑爆
        dark = tuple(sum(p[i] for p in px[:n]) // n for i in range(3))
        bright = tuple(sum(p[i] for p in px[-n:]) // n for i in range(3))
        # 主指标:声明的字色 vs 该块**局部底**(框内像素中位数 = 底占多数)。
        # 极值对(dark/bright)只作 AA 旁证:稀疏文字(如两个字的组标题)框里大部分是底,极值对会失真。
        bg_px = px[len(px) // 2]
        declared = parse_color(r["color"])
        measured = ratio(declared[:3], bg_px[:3])
        plate = parse_color(data["data"]["body"]["bg"])
        # 字 vs 页面板本身(不含壁纸):页面层的保底对比
        vs_plate = ratio(declared[:3], plate[:3])
        ok = measured >= 4.5
        if not ok:
            worst.append((r["label"], round(measured, 2)))
        aa = ratio(dark, bright)
        print(f"{r['label']:12s}{r['color']:>10s}{vs_plate:>9.2f}{str(bg_px):>14s}{measured:>9.2f}{aa:>9.2f}   {'✅' if ok else '✗ <4.5'}")
    print()
    if worst:
        print("不达标:", ", ".join(f"{n} {v}:1" for n, v in worst))
    else:
        print("全部文字块实测 ≥4.5:1 ✅")
    return 0


if __name__ == "__main__":
    sys.exit(main())