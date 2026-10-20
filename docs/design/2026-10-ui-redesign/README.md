# 构想工作台 · UI v2 全面重设计（隔离原型区）

> 2026-10-20 启动。**本目录是唯一的 UI v2 工作区：不碰 `apps/`、`packages/` 任何一行代码。**
> 与旧规范 `docs/design/2026-09-ui-restructure/UI-SPEC.md`（v1，仍对线上生效）互不干扰。

## 怎么看

双击打开 `index.html`（或任意静态服务器）。纯静态、零依赖、`file://` 可直接运行。

- **左侧**：全站 32 页清单，按「入口与独立页 / 数据表库 / 知识库 / 工作区与全局」分组
- **右侧**：1440×900 画布；顶部可切 50% / 75% / 100% 缩放、开关「区域标注」
- 页面清单的权威来源是 `apps/web/src/App.tsx` 真实路由（32 页、8 种视图类型），不是凭空罗列

## 目录

```
index.html        查看器容器（左侧清单 + 右侧画布）
assets/
  tokens.css      ★ 设计令牌唯一取值来源（禁止在别处写 hex）
  proto.css       查看器 chrome + 骨架块样式
  pages.js        ★ 全站页面清单 + 每页信息结构（数据源）
  app.js          骨架渲染器
DECISIONS.md      拍板记录（只追加，不改写）
```

## 本阶段纪律（骨架期）

1. **只表达信息结构，不抠视觉细节**——虚线块 = 区域，块内小字 = 该区域的职责与关键约束
2. 所有颜色/圆角/间距/字号只引用 `tokens.css` 变量；散落 hex 视为不合格
3. 每页必须交代**五态**（加载 / 空数据 / 出错 / 无权限 / 超长文本），见「五态样张」页
4. 改壳只改一处：`app.js` 的 `buildShell()`，所有页面同步生效（这就是不拆 32 个 html 的原因）

## 迭代流程

1. 骨架期：`pages.js` 里调区域结构 → 戴总过目
2. 结构拍板后 → 换 `tokens.css` 出视觉方向稿（同一套结构，2~3 套皮对比）
3. 视觉拍板 → 逐页精修 → 每轮定稿在 `DECISIONS.md` 记一行
4. 最终落地时：`tokens.css` 逐条映射回 `packages/design-tokens/src/colors.ts`（现 106 行）与 `layout.ts`，组件按定稿原型重排——**不需要任何人对着图片猜色值**

## 为什么放这里

- `apps/web` 的 tailwind content 是 `./index.html, ./src/**`，tsc 只扫 apps/packages，eslint 不进 `docs/` → 本目录天然不触发四道检查（vitest 收集数 / 三包 tsc / eslint / golden）
- 图标候选（`2026-10-icon-candidates/v6-pearl/index.html`）已有同型先例
