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
index.html            查看器容器（左侧清单 + 右侧画布）
standalone.html       生成物：资源全内联的单文件版（受限预览环境用）
build-standalone.mjs  standalone.html 的生成脚本
assets/
  tokens.css      ★ 设计令牌唯一取值来源（禁止在别处写 hex）
  proto.css       查看器 chrome + 骨架块样式
  pages.js        ★ 全站页面清单 + 每页信息结构（数据源）
  app.js          骨架渲染器
DECISIONS.md      拍板记录（只追加，不改写）
```

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
| `CORE-SKELETON.md` | **核心骨架框架**：壳层层级 / 区域契约 / 全站 32 页清单 / 五态契约 / 令牌契约 / 主题暴露面 |
| `THEMING-FEASIBILITY.md` | **主题功能可行性调研**：现状实测数据、三条技术路径对比、9 类难点、影响面、风险矩阵、三期路线与结论 |

## 迭代流程

1. 骨架期：`pages.js` 里调区域结构 → 戴总过目
2. 结构拍板后 → 换 `tokens.css` 出视觉方向稿（同一套结构，2~3 套皮对比）
3. 视觉拍板 → 逐页精修 → 每轮定稿在 `DECISIONS.md` 记一行
4. 最终落地时：`tokens.css` 逐条映射回 `packages/design-tokens/src/colors.ts`（现 106 行）与 `layout.ts`，组件按定稿原型重排——**不需要任何人对着图片猜色值**

## 为什么放这里

- `apps/web` 的 tailwind content 是 `./index.html, ./src/**`，tsc 只扫 apps/packages，eslint 不进 `docs/` → 本目录天然不触发四道检查（vitest 收集数 / 三包 tsc / eslint / golden）
- 图标候选（`2026-10-icon-candidates/v6-pearl/index.html`）已有同型先例
