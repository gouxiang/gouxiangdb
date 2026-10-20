# 构想工作台 · UI v2 全面重设计（隔离原型区）

> 2026-10-20 启动。**本目录是唯一的 UI v2 工作区：不碰 `apps/`、`packages/` 任何一行代码。**
> 与旧规范 `docs/design/2026-09-ui-restructure/UI-SPEC.md`（v1，仍对线上生效）互不干扰。

## 怎么看

双击打开 `index.html`（或任意静态服务器）。纯静态、零依赖、`file://` 可直接运行。

> 若在受限环境（WorkBuddy 预览面板 / Finder 快速预览）里左侧清单空白或点不动：
> 那是环境拦截了页面脚本，页面顶部会出现黄条提示。改用浏览器打开，
> 或直接双击 `standalone.html`（全部 css/js 内联的生成物，不依赖外部文件）。
> 改了源文件后重跑 `node build-standalone.mjs` 重新生成。

- **左侧**：全站 32 页清单，按「入口与独立页 / 数据表库 / 知识库 / 工作区与全局」分组
- **右侧**：1440×900 画布；顶部可切 50% / 75% / 100% 缩放、开关「区域标注」
- **翻页**：↑↓ 按钮、键盘 ↑↓（或 j/k）均可逐页翻
- 页面清单的权威来源是 `apps/web/src/App.tsx` 真实路由（32 页、8 种视图类型），不是凭空罗列

## 目录

```
index.html            ★ 实际 UI 改造工作台（iframe 装载 actual/ 页面，浏览器打开）
skeleton.html         早期骨架查看器（32 页虚线结构，已让位，保留备查）
standalone.html       骨架查看器的单文件版
actual/               ★ 实际 UI 抽离区（设计改造的主场）
  index.html          actual 专用查看器（同根 index.html，多一份入口）
  pages/*.html        抽离页面：自包含单文件（真实 CSS 已内联，预览面板可直接看）
  assets/real-ui.css  真实 Tailwind 产物（apps/web/dist-shell 复制，只读勿改）
  build-inline.mjs    把页面里的 real-ui.css link 内联成 <style>（幂等，加新页面后重跑）
assets/               骨架查看器的资源（tokens.css / proto.css / pages.js / app.js）
build-standalone.mjs  standalone.html 的生成脚本
DECISIONS.md          拍板记录（只追加，不改写）
```

**预览面板限制（重要）**：WorkBuddy 预览面板按「单文件」托管，跨文件相对引用（CSS/JS/iframe）一律 404。
因此：`actual/pages/*.html` 必须是自包含单文件（CSS 内联）；聚合查看器（iframe）只在浏览器里可用。
新页面流程：写 `pages/xxx.html`（先引用 `../assets/real-ui.css`）→ 跑 `node build-inline.mjs` 内联 → 在两处页面清单各加一条。

**健壮性约定**：页面切换一律用 `<button>` + 直接渲染，不依赖 `<a href="#...">` 导航
（预览面板 / iframe sandbox 会拦同文档跳转导致"点不动"）；hash 只做状态同步，
写失败也不影响使用；脚本未执行时页面顶部显示明确的黄色提示条，不会让人误以为点不动。

## 本阶段纪律（骨架期）

1. **只表达信息结构，不抠视觉细节**——虚线块 = 区域，块内小字 = 该区域的职责与关键约束
2. 所有颜色/圆角/间距/字号只引用 `tokens.css` 变量；散落 hex 视为不合格
3. 每页必须交代**五态**（加载 / 空数据 / 出错 / 无权限 / 超长文本），见「五态样张」页
4. 改壳只改一处：`app.js` 的 `buildShell()`，所有页面同步生效（这就是不拆 32 个 html 的原因）

## 文档

| 文件 | 内容 |
|---|---|
| `CORE-SKELETON.md` | **核心骨架框架**：壳层层级 / 区域契约 / 全站 32 页清单 / 五态契约 / 令牌现状 / 落地映射方式 |

## 迭代流程

1. 骨架期：`pages.js` 里调区域结构 → 戴总过目
2. 结构拍板后 → 换 `tokens.css` 出视觉方向稿（同一套结构，2~3 套皮对比）
3. 视觉拍板 → 逐页精修 → 每轮定稿在 `DECISIONS.md` 记一行
4. 最终落地时：`tokens.css` 逐条映射回 `packages/design-tokens/src/colors.ts`（现 106 行）与 `layout.ts`，组件按定稿原型重排——**不需要任何人对着图片猜色值**

## 为什么放这里

- `apps/web` 的 tailwind content 是 `./index.html, ./src/**`，tsc 只扫 apps/packages，eslint 不进 `docs/` → 本目录天然不触发四道检查（vitest 收集数 / 三包 tsc / eslint / golden）
- 图标候选（`2026-10-icon-candidates/v6-pearl/index.html`）已有同型先例
