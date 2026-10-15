#!/usr/bin/env python3
"""从定稿 SVG 生成完整图标套件（PNG 多尺寸 / ICO / ICNS / iOS / Android / Web）。"""
import os, subprocess, shutil
from PIL import Image

ROOT = "/Users/daijing/Desktop/GouXiangDB/branding/app-icon"
Q = "/usr/bin/qlmanage"
SIPS = "/usr/bin/sips"
ICONUTIL = "/usr/bin/iconutil"

def render(svg, size, outdir, name):
    os.makedirs(outdir, exist_ok=True)
    tmp = os.path.join(outdir, "_t")
    os.makedirs(tmp, exist_ok=True)
    subprocess.run([Q, "-t", "-s", str(size), "-o", tmp, svg],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    src = os.path.join(tmp, os.path.basename(svg) + ".png")
    dst = os.path.join(outdir, name)
    shutil.move(src, dst)
    shutil.rmtree(tmp, ignore_errors=True)
    with Image.open(dst) as im:
        assert im.size == (size, size), f"{dst} 尺寸异常 {im.size}"
    return dst

rounded = os.path.join(ROOT, "svg", "icon.svg")
fullbleed = os.path.join(ROOT, "svg", "icon-fullbleed.svg")

# —— 1. 通用 PNG 多尺寸 ——
sizes = [16, 32, 48, 64, 128, 256, 512, 1024]
for s in sizes:
    render(rounded, s, os.path.join(ROOT, "png"), f"icon-{s}.png")
print("png/ ok:", sizes)

# —— 2. Web 专用（favicon / apple-touch / PWA）——
web = os.path.join(ROOT, "web")
for s, n in [(16, "favicon-16x16.png"), (32, "favicon-32x32.png"),
             (180, "apple-touch-icon.png"), (192, "android-chrome-192x192.png"),
             (512, "android-chrome-512x512.png")]:
    render(rounded, s, web, n)
print("web/ ok")

# —— 3. ICO（favicon.ico 小尺寸合集 / icon.ico 全尺寸）——
def build_ico(target, size_list, src_from_1024=False):
    os.makedirs(os.path.dirname(target), exist_ok=True)
    base = Image.open(os.path.join(ROOT, "png", "icon-1024.png")).convert("RGBA")
    base.save(target, format="ICO", sizes=[(s, s) for s in size_list])
    return target

build_ico(os.path.join(web, "favicon.ico"), [16, 32, 48])
build_ico(os.path.join(ROOT, "ico", "icon.ico"), [16, 32, 48, 64, 128, 256])
print("ico/ ok")

# —— 4. macOS icns（用满出血版，交给系统裁圆角）——
iconset = os.path.join(ROOT, "mac", "icon.iconset")
os.makedirs(iconset, exist_ok=True)
for s in [16, 32, 128, 256, 512]:
    render(fullbleed, s, iconset, f"icon_{s}x{s}.png")
    render(fullbleed, s * 2, iconset, f"icon_{s}x{s}@2x.png")
icns = os.path.join(ROOT, "mac", "icon.icns")
subprocess.run([ICONUTIL, "-c", "icns", iconset, "-o", icns], check=True)
print("mac/icon.icns ok")

# —— 5. Android mipmap ——
android = os.path.join(ROOT, "android")
for d, s in [("mdpi", 48), ("hdpi", 72), ("xhdpi", 96), ("xxhdpi", 144), ("xxxhdpi", 192)]:
    render(rounded, s, os.path.join(android, f"mipmap-{d}"), "ic_launcher.png")
print("android/ ok")

# —— 6. iOS AppIcon.appiconset ——
ios = os.path.join(ROOT, "ios", "AppIcon.appiconset")
ios_specs = [
    (20, 2, "Icon-20@2x.png"), (20, 3, "Icon-20@3x.png"),
    (29, 2, "Icon-29@2x.png"), (29, 3, "Icon-29@3x.png"),
    (40, 2, "Icon-40@2x.png"), (40, 3, "Icon-40@3x.png"),
    (60, 2, "Icon-60@2x.png"), (60, 3, "Icon-60@3x.png"),
    (76, 2, "Icon-76@2x.png"),
    (83.5, 2, "Icon-83.5@2x.png"),
    (1024, 1, "Icon-1024.png"),
]
entries = []
for pt, scale, name in ios_specs:
    px = int(round(pt * scale))
    render(rounded, px, ios, name)
    entries.append({"size": f"{pt}x{pt}", "idiom": "iphone" if pt < 76 else "ipad",
                    "filename": name, "scale": f"{scale}x"})
import json
json.dump({"images": entries, "info": {"version": 1, "author": "gouxiangdb"}},
          open(os.path.join(ios, "Contents.json"), "w"), indent=2)
print("ios/ ok")

# —— 7. Web app manifest 片段 ——
manifest = {
    "name": "构想工作台",
    "short_name": "构想工作台",
    "icons": [
        {"src": "/android-chrome-192x192.png", "sizes": "192x192", "type": "image/png"},
        {"src": "/android-chrome-512x512.png", "sizes": "512x512", "type": "image/png"},
    ],
    "theme_color": "#F7A81B",
    "background_color": "#FDFBF5",
}
json.dump(manifest, open(os.path.join(web, "site.webmanifest"), "w"), ensure_ascii=False, indent=2)
print("web/site.webmanifest ok")
print("\n套件生成完成")
