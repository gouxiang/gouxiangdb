#!/usr/bin/env python3
"""从定稿 SVG 生成完整图标套件（PNG 多尺寸 / ICO / ICNS / iOS / Android / Web）。"""
import os, subprocess, shutil
from PIL import Image, ImageDraw

# Apple macOS 图标网格（Big Sur 起官方模板，1024 画布）：
#   安全边 inset = 100 / 1024（≈9.77%），底板 side = 824 / 1024（≈80.47%），
#   底板超椭圆圆角 radius = 185 / 824（≈22.45% 底板边长）。
MAC_INSET_RATIO = 100 / 1024
MAC_TILE_RATIO = 824 / 1024
MAC_RADIUS_RATIO = 185 / 824

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
macsvg = os.path.join(ROOT, "svg", "icon-mac.svg")

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

# —— 4. macOS icns（网格内缩直角板 + 放大 G，PIL 单一超椭圆遮罩按底板矩形裁透明安全边）——
# Big Sur 起 App 图标圆角由图标自身承担，且图标必须内缩在 Apple 网格内（底板 ~80.47%、
# 四周安全边 ~9.77%），否则在 Dock 里会比满网格的主流图标「肥大一圈」。qlmanage 会把 SVG
# 透明区域压平成白底，故渲染后用 PIL 加一道 alpha 超椭圆遮罩：仅底板矩形（含 ~22.45% 圆角）
# 不透明、安全边全透明。为避免在小尺寸上直接栅格化圆角产生锯齿，**只在 1024 母版上画一次
# 遮罩（边缘最平滑），其余尺寸一律 LANCZOS 降采样**。只裁这一次，SVG 不带圆角，杜绝双重圆角。
MAC_MASTER = 1024

def downscale_premultiplied(src, size):
    """预乘 alpha 后 LANCZOS 降采样再反预乘，避免透明安全边在缩小时混入颜色产生淡晕。"""
    import numpy as np
    arr = np.asarray(src).astype(np.float32)          # H,W,4 (RGBA)
    rgb, alpha = arr[..., :3], arr[..., 3:4]
    prem = np.concatenate([rgb * alpha / 255.0, alpha], axis=-1)
    out = np.asarray(Image.fromarray(prem.astype(np.uint8), "RGBA")
                     .resize((size, size), Image.LANCZOS)).astype(np.float32)
    o_rgb, o_alpha = out[..., :3], out[..., 3:4]
    safe = np.where(o_alpha > 0, o_alpha, 255.0)      # alpha=0 处不放大颜色
    u_rgb = np.clip(o_rgb * 255.0 / safe, 0, 255)
    res = np.concatenate([u_rgb, o_alpha], axis=-1).astype(np.uint8)
    return Image.fromarray(res, "RGBA")

def build_mac_iconset(iconset):
    os.makedirs(iconset, exist_ok=True)
    master_p = render(macsvg, MAC_MASTER, iconset, "_master.png")
    with Image.open(master_p) as p:
        master = p.convert("RGBA")
    inset = int(round(MAC_MASTER * MAC_INSET_RATIO))
    side = MAC_MASTER - 2 * inset
    r = int(round(side * MAC_RADIUS_RATIO))
    mask = Image.new("L", (MAC_MASTER, MAC_MASTER), 0)
    x1 = inset + side - 1
    ImageDraw.Draw(mask).rounded_rectangle([inset, inset, x1, x1], radius=r, fill=255)
    master.putalpha(mask)
    for s in [16, 32, 128, 256, 512]:
        downscale_premultiplied(master, s).save(os.path.join(iconset, f"icon_{s}x{s}.png"))
        downscale_premultiplied(master, s * 2).save(os.path.join(iconset, f"icon_{s}x{s}@2x.png"))
    os.remove(master_p)

iconset = os.path.join(ROOT, "mac", "icon.iconset")
build_mac_iconset(iconset)
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
