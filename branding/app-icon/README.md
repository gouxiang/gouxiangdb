# 构想工作台 · 应用图标套件（定稿）

> 定稿日期：2026-10-15 · 版本：v1.0
> 设计定稿：**方形字母 G（内部带文档横杠）+ 陡斜轴完整暖→冷色带 + 类纸白珠光底板**

---

## 一、设计规格（唯一事实源）

| 项目 | 规格 |
| :--- | :--- |
| 底板 | 类纸白 `#FDFBF5` 系暖白 + 珠光层（淡粉/暖黄/青/紫四段微光）+ 斜向光泽高光 + 左上柔光 |
| 色带 | 陡斜轴（自左上偏垂直向下，约 62°），平滑过渡 |
| 色序 | 橙黄 `#F7A81B` → 橙 `#F5841F` → 玫红 `#E8447A` → 紫 `#7B4CD8` → 蓝 `#2C7BE5` → 亮蓝 `#29B6F6` |
| 图形 | 方形字母 G：圆角 22 / 笔画 26（单位＝256 画布），右侧开口，内拐长横杠（兼 G 收笔与文档末行）+ 内部一条文档横杠（笔画 11） |
| 画布 | 256×256 逻辑坐标（矢量源），导出 1024px 母版 |
| 圆角（通用版） | 57/256 ≈ 22.3%（≈ macOS squircle） |
| 主题色 | `#F7A81B`（暖橙） · 背景色 `#FDFBF5` |

> 定稿判定依据：与戴总提供参考截图做关键点取色比对（左中、右中、左下等 6 点），本方案总色差 1120，显著优于对角轴方案 2265、密色标方案 3115，确认一致。

---

## 二、目录结构

```
branding/app-icon/
├── svg/
│   ├── icon.svg              矢量源（圆角版，web / Android / iOS / 通用）
│   └── icon-fullbleed.svg    矢量源（满出血方角版，macOS / Windows 交给系统裁圆角）
├── png/                      通用 PNG：16 / 32 / 48 / 64 / 128 / 256 / 512 / 1024
├── ico/icon.ico              Windows 图标（16/32/48/64/128/256 六尺寸合集）
├── mac/icon.icns             macOS 图标（由满出血版生成，含 16→1024 @1x/@2x）
├── ios/AppIcon.appiconset/   iOS 全套 AppIcon + Contents.json（iPhone/iPad）
├── android/mipmap-*/         Android 五档密度 ic_launcher.png（48/72/96/144/192）
├── web/                      Web 专用：favicon-16/32、favicon.ico、apple-touch-icon(180)、
│                             android-chrome-192/512、site.webmanifest
├── gen-kit.mjs               由设计参数重新生成 SVG
└── build-kit.py              由 SVG 重新生成上述全部位图资产
```

---

## 三、重新生成方式

```bash
cd branding/app-icon
node gen-kit.mjs                 # 改完参数（色值/圆角/笔画）后重新出 SVG
python build-kit.py              # 重新导出 PNG / ICO / ICNS / iOS / Android / Web
```

需要 Python 环境带 Pillow（本机：`/Users/daijing/.workbuddy/binaries/python/envs/default/bin/python`）。
SVG→PNG 用系统 `qlmanage`，ICNS 用系统 `iconutil`，均无需额外依赖。

---

## 四、各端接入指引（供后续替换）

### 1. Web（apps/web）
- `apps/web/index.html` 第 7 行已引用 `%BASE_URL%favicon.svg`，把 `svg/icon.svg` 复制为
  `apps/web/public/favicon.svg` 即可（**注意：该文件此前一直缺失，属补齐**）。
- 其余 `web/` 目录内的 PNG/ICO 复制到 `apps/web/public/` 下，并在 `<head>` 追加：
  ```html
  <link rel="apple-touch-icon" sizes="180x180" href="%BASE_URL%apple-touch-icon.png" />
  <link rel="icon" type="image/png" sizes="32x32" href="%BASE_URL%favicon-32x32.png" />
  <link rel="icon" href="%BASE_URL%favicon.ico" sizes="any" />
  <link rel="manifest" href="%BASE_URL%site.webmanifest" />
  ```

### 2. 飞牛 fnOS 应用包（deploy/fnos）
| 目标文件 | 使用本套件 |
| :--- | :--- |
| `deploy/fnos/gouxiangdb/ICON.PNG` | `png/icon-256.png`（**先核对原文件像素尺寸，按原尺寸覆盖**） |
| `deploy/fnos/gouxiangdb/ICON_256.PNG` | `png/icon-256.png` |
| `deploy/fnos/gouxiangdb/app/ui/images/icon_256.png` | `png/icon-256.png` |
| `deploy/fnos/gouxiangdb/app/ui/images/icon_64.png` | `png/icon-64.png` |

### 3. macOS 桌面 App（后续 apps/desktop）
- 使用 `mac/icon.icns`；若自行组装 `.app`，把 icns 放到 `Contents/Resources/`。
- 满出血版优先，让系统做圆角与阴影处理，避免「双重圆角」。

### 4. iOS / Android
- Android：把 `android/mipmap-*/ic_launcher.png` 直接放入对应密度目录。
- iOS：把 `ios/AppIcon.appiconset/` 整个目录拖进 Xcode Assets。

### 5. Windows
- 使用 `ico/icon.ico`（六尺寸合集）。

---

## 五、注意事项

- **不要直接编辑 `png/`、`ico/`、`mac/`、`ios/`、`android/`、`web/` 下的位图**——它们是生成物，
  改设计请改 `gen-kit.mjs` 参数后重跑 `build-kit.py`，否则下次生成会覆盖。
- macOS 图标规范要求四角由系统裁切，故 icns 用满出血版；Web/Android/iOS 用自带圆角版。
- 小尺寸（16/32px）下底板珠光基本不可见、只剩色带与 G 的轮廓，属正常现象。
