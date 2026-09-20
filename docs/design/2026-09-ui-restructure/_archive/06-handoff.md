# 06 · 落地映射、已知缺陷与验收清单

## 1. 方案 → 代码映射表

| 方案章节 | 改动对象 |
|---|---|
| `02` 配色 / 字阶 / 间距 / 圆角 / 阴影 | `packages/design-tokens/src/colors.ts`、`layout.ts`、`tailwind.ts` |
| `03` §3.1 一级导航 | `features/workspace/PrimaryNav.tsx`（保留 menu 驱动 + 虚拟化，只改视觉层） |
| `03` §3.2 二级导航 | `features/workspace/SecondaryNav.tsx`、`SecondaryNavSections.tsx`；新增 tree 模式，吸收 `features/kb/KbSidebar.tsx` + `KbTree.tsx` |
| `03` §3.3 顶栏 | `features/workspace/WorkspaceTopBar.tsx`（补分享/更多），旧 `features/shell/TopBar.tsx` 随双壳下线 |
| `03` §3.4 视图标签条 | 新组件（可基于 `features/shell/ViewTabs.tsx` 改造），从 `GridView` 中上移 |
| `04` 工具栏 | `features/grid/GridToolbar.tsx`（行高 48→40，视觉层对齐） |
| `04` 表头/行/聚合 | `features/grid/GridHeaderCell.tsx`、`GridRow.tsx`、`AggregationBar.tsx`、`GridView.tsx` |
| `04` 状态栏 | `GridView.tsx` 内联段抽成组件 |
| `05` 组件 | `components/ui.tsx`（收敛 + 新增 Drawer/Tabs/Tooltip/Breadcrumb） |

## 2. 必须同步修复的存量缺陷（重构顺带完成）

| # | 缺陷 | 修法 |
|---|---|---|
| 1 | `text-gx-15` 6 处引用但档位不存在 | 统一到 `gx-14` / `gx-16` |
| 2 | `rounded-gx-pill` 14 处引用但档位不存在 → Badge 是直角 | `tailwind.ts` 补 `pill: 9999px` |
| 3 | `shadow.*` 未映射进 Tailwind | `tailwind.ts` 补 `boxShadow`，浮层改用 `gx-shadow-*` |
| 4 | `gx-bg`/`gx-card-bg`/`gx-zebra`/`gx-table-header` 同值 | 按新 token 拆分为 canvas / surface / surface-alt |
| 5 | `gx-text-secondary` 是紫色，语义不符 | 改 `gx-text-2: #48484A` |
| 6 | `kb.css` 引用的 `--gx-*` CSS 变量全未定义 | KB 菜单栏收编进 `SecondaryNav` 后，`.kb-tree-*` 样式删除；确需保留的 CSS 变量在 `index.css` 显式定义 |
| 7 | 浮层用裸 `z-[800]` 魔法数 | 统一走 `gx-z-*` |
| 8 | Modal 无动画 / 无 focus-visible | 见 `05` §1、§10 |
| 9 | IconButton / Input 无 disabled 样式 | 见 `05` §2、§3 |
| 10 | GridToolbar「更多」按钮图标（download）与文案（更多）不匹配 | 改 `⋯` |
| 11 | 日历视图右边框被涂透明导致格线不齐 | 统一 `gx-hairline` |
| 12 | WorkspaceShell 底部「工作区设置」用 `database` 图标，与「导航编排」同域混淆 | 改 `settings` 图标 |

## 3. 不做 / 延后

- 移动端适配（仅在 <1024px 隐藏二级导航，不另做布局）。
- 暗色模式（token 已按语义命名，后续可加 mode）。
- 文档编辑区 / 画布 / ERD / 看板画廊日历表单详情**内容区**的视觉重构（仅外框对齐）。
- 设计稿到代码的自动转换。

## 4. 重构验收清单

### 4.1 视觉一致性

- [ ] 全站无写死 hex，一律走 `gx-*` token（可用 `grep -r "#[0-9A-Fa-f]\{6\}" apps/web/src --include="*.tsx"` 抽查，`colors.ts` / 图标 / 色板除外）
- [ ] 四层底色（canvas / surface-alt / surface / selected）层级与设计稿一致
- [ ] 表头、聚合栏、状态栏与数据面有可感知的底色差
- [ ] 字号只出现 11/12/13/14/16/20/24，无 `gx-15`

### 4.2 组件状态

- [ ] Button / IconButton / Input / Menu / Tabs 五类组件具备 default·hover·active·disabled 四态
- [ ] 所有可聚焦控件有 `focus-visible` 环
- [ ] Modal 有 180ms 入场动画

### 4.3 功能回归

- [ ] 菜单树：服务端驱动、分组折叠、虚拟滚动（1000+ 项）、broken/soft_dangling 过滤行为不变
- [ ] 二级导航 asset 模式三视角计数、行内收纳/移动操作不变
- [ ] 二级导航 tree 模式：拖拽建父子、折叠持久化、more 菜单、空态文案不变
- [ ] 表格：列宽拖拽、行高三档、斑马纹、分组、聚合、批量选中条、降级提示、虚拟滚动、RecordDrawer 全部回归
- [ ] 双壳回退路径（flag off → 旧壳）在过渡期内仍可用
- [ ] 四门（vitest 收集数恒等 + 三包 tsc 0 + eslint 0 error + S0 golden）通过

## 5. 推进顺序建议

1. **design-tokens 包改造**（`02` 全部 token + 缺陷 #1–#5）——低风险，先行合入。
2. **ui.tsx 组件状态补齐 + 新增通用组件**（`05`）。
3. **壳层收敛**：WorkspaceShell 视觉对齐（`03`），SecondaryNav 增加 tree 模式。
4. **数据表界面**（`04`）：工具栏 → 表头 → 行 → 聚合/状态栏。
5. **KB 外框**：编辑器顶栏 / 首页工具条 / 回收站设置页页头。
6. 每步完成后跑四门 + 在 `进度数据.js` / PROJECT-STATUS 记录。

---

- [修订 2026-09-18] 初版。
