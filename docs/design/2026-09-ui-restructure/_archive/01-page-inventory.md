# 01 · 页面与信息结构清单（重构范围界定）

> 勘察基准：`apps/web/src/App.tsx`（路由唯一声明处）+ `features/` 全量走读，2026-09-18。

## 1. 路由 → 页面映射

### 1.1 无壳路由（认证 / 公开）

| 路由 | 页面 | 业务域 |
|---|---|---|
| `/login` | `features/auth/LoginPage.tsx` | auth |
| `/change-password` | `features/auth/ForceChangePassword.tsx` | auth（首登强制改密） |
| `/join/:token` | `features/auth/ShareJoinPage.tsx` | auth |
| `/s/:token`、`/s/:token/doc/:docId` | `features/kb/PublicSharePage.tsx` | 公开分享 |
| `/invite/:token` | `features/contacts/InviteAcceptPage.tsx` | 公开邀请激活 |

### 1.2 有壳路由（统一经 `ShellGate` 包壳）

| 路由 | 页面 | 业务域 |
|---|---|---|
| `/` → `/base/:baseId` | 重定向到第一个 Base → 第一张表第一个视图 | base |
| `/base/:baseId/table/:tId/view/:vId` | `features/views/ViewRouter.tsx` 按 `view.type` 分发 | base ★核心 |
| `/base/:baseId/settings` | `features/settings/SettingsPage.tsx` | base |
| `/base/:baseId/trash` | `features/settings/TrashPage.tsx` | base |
| `/base/:baseId/erd` | `features/erd/ErdPage.tsx` | base |
| `/kb` | `features/kb/KbListPage.tsx` | kb |
| `/kb/:kbId` | `features/kb/KbHomePage.tsx` | kb |
| `/kb/:kbId/doc/:docId` | `features/kb/DocEditorPage.tsx` | kb（编辑区不动） |
| `/kb/:kbId/canvas/:docId` | `features/kb/CanvasEditorPage.tsx` | kb（编辑区不动） |
| `/kb/:kbId/trash` | `features/kb/KbTrashPage.tsx` | kb |
| `/kb/:kbId/settings` | `features/kb/KbSettingsPage.tsx` | kb |
| `/workspace/contacts` | `features/contacts/ContactsPage.tsx` | workspace |
| `/workspace/authz` | `features/authz/PermPanel.tsx` | workspace |
| `/workspace/settings/*` | `features/workspace/WorkspaceSettingsPage.tsx` | workspace |

### 1.3 视图分发（ViewRouter）

`grid → GridView`、`kanban → KanbanView`、`gallery → GalleryView`、`calendar → CalendarView`、`form → FormView`、`detail → DetailView`。常驻浮层：`RecordDrawer`（记录抽屉）、`?design=1` → 表单设计器 `DetailLayoutEditor`。

## 2. 现有壳层结构（重构对象）

当前存在**双壳**，由 `GX_ENTERPRISE_NAV`（探测 `GET /workspaces/current/menu`，404 即关闭）切换：

| 壳 | 文件 | 结构 |
|---|---|---|
| 新壳 | `features/workspace/WorkspaceShell.tsx` | 一级导航（`PrimaryNav`，224px）+ 二级导航（`SecondaryNav`，256px，仅 ≥1024px）+ 顶栏（`WorkspaceTopBar`，48px）+ 内容区 |
| 旧壳·数据表 | `features/shell/AppShell.tsx` | 侧栏 `Sidebar.tsx`（240px：库切换/搜索/表列表/新建表/底部入口）+ 顶栏 `TopBar.tsx`（面包屑 + 视图标签 + 右侧操作） |
| 旧壳·知识库 | `features/kb/KbShell.tsx` | 侧栏 `KbSidebar.tsx`（240px：库切换/搜索/全部内容/文档树/底部）+ 内容区 |

**问题**：两套壳视觉与交互不一致；新壳顶栏丢失了面包屑、视图标签、分享/成员入口（只在旧壳有）；知识库在新壳下没有树形导航。

## 3. 知识库模块的「菜单栏」实际有 4 处

| # | 位置 | 文件 | 生效条件 | 本轮处理 |
|---|---|---|---|---|
| 1 | KB 侧栏 | `features/kb/KbSidebar.tsx` | 仅旧壳 | **重新设计**（并入新壳二级导航） |
| 2 | 文档树 | `features/kb/KbTree.tsx` + `kb.css` `.kb-tree-*` | 仅旧壳 | **重新设计**（并入新壳二级导航的 tree 模式） |
| 3 | 文档编辑器顶栏 | `features/kb/DocEditorPage.tsx:153-218` | 两套壳都生效 | **外框重设计**（统一到新壳顶栏规格），编辑器本体不动 |
| 4 | KB 首页工具条 | `features/kb/KbHomePage.tsx:105-154` | 两套壳都生效 | **外框重设计**（按钮/搜索/筛选统一到组件规范） |

> ⚠️ 勘察发现：`kb.css` 的 `.kb-tree-*` 大量使用 `var(--gx-text-hint)` 等 CSS 变量，但全仓库**没有定义任何 `--gx-*` CSS 变量**，实际全部落在 fallback 值上。重构时必须先补这层基础设施。

## 4. 数据表界面（grid）区域清单

自上而下 8 个区域（详见 `04-grid-view.md`）：

| 区域 | 现文件 | 高度 |
|---|---|---|
| ① 视图工具栏 | `features/grid/GridToolbar.tsx`（426 行） | 48 |
| ② 降级提示条 | `ResultNotice`（条件渲染） | — |
| ③ 表头 | `GridHeaderCell.tsx` | 32 |
| ④ 数据行 | `GridRow.tsx`（行高 32/44/64） | 动态 |
| ⑤ 分组头 | `GridView.tsx renderGrouped()` | 36 |
| ⑥ 聚合栏 | `AggregationBar.tsx` | 32 |
| ⑦ 状态栏 | `GridView.tsx` 内联 | 28 |
| ⑧ 浮层 | `RecordDrawer` / `FieldEditorSheet` / `BulkEditModal` | — |

工具栏现有元素：新建记录、行高、字段显隐、筛选、分组、排序、行颜色、视图内搜索、更多（CSV 导入导出/复制视图/清空表）。批量选中态会整条替换为「N 行已选 + 批量修改 + 删除 + 取消」。

## 5. 重构范围分级

| 级别 | 内容 | 说明 |
|---|---|---|
| **A 全量重设计** | 一级导航、二级导航、顶栏、视图标签条、表格工具栏、表头、数据行、聚合栏、状态栏 | 本轮已完成主页面稿（S1） |
| **B 外框重设计** | KB 首页工具条、文档编辑器顶栏、KB 回收站/设置页的页头 | 统一到 A 的框架与组件，内容不变 |
| **C 完全不动** | 文档编辑区（`MarkdownEditor`/`MdContent`/`DocOutline`）、画布（`DrawnixCanvas`/`CanvasEmbed`）、ERD 画布、看板/画廊/日历/表单/详情视图的内容区、全部弹窗与抽屉的业务逻辑 | 仅在 A/B 完成后按需对齐视觉 |

## 6. 现有设计令牌的已知缺陷（重构必须一并修）

1. `text-gx-15` 被 6 处引用但**字号档位不存在**，实际回落到继承字号 → 统一到 `gx-14`/`gx-16`。
2. `rounded-gx-pill` 被 14 处引用但**圆角档位不存在**，Badge 实际是直角 → 补 `gx-pill: 9999px`。
3. `shadow.sm/md/lg/xl` 在 `layout.ts` 定义了，但 `tailwind.ts` **未映射 boxShadow** → 所有 `shadow-*` 用的是 Tailwind 原生值，与令牌脱钩。
4. `gx-bg` / `gx-card-bg` / `gx-zebra` / `gx-table-header` 四个 token 同值（`#F1EFE8`）→ 表头与页面底无层级差，这正是本次要解决的视觉问题。
5. `gx-text-secondary` 用的是紫色 `#534AB7`，与「次级文本」语义不符（更像强调色）→ 改中性灰阶。
6. `kb.css` 引用的 `--gx-*` CSS 变量在 `index.css` 中未定义。
7. `Modal/Popover/Toast` 用裸 `z-[800]` 等魔法数，未走 `gx-z-*` 令牌。

---

- [修订 2026-09-18] 初版。
