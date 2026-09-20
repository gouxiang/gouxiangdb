# 编辑器/画布 + 导航入口 + 丢失功能 + 后台配置 —— 收尾报告

> 对应计划：`PLAN.md`（同目录）
> 取证方式：`git log --oneline 9a6ef44~1..HEAD`、`git show --stat/--numstat <hash>`、Grep/Glob 检索
> HEAD = `6cec628`；四个批次全部已提交
> **诚实度声明**：本报告所有 commit hash、文件数、增删行数均来自 `git` 输出；所有测试文件名与用例名均来自
> Grep 检索到的源码。凡本报告 worker 未亲自执行（未复跑全量测试、未做真机浏览器点验）而引用自 commit message
> 的数字，一律标 **【未实测】**，不得当作实测结论使用。

---

## 一、变更清单

### 批次一（P0）：编辑器/画布五处缺陷 —— `9a6ef44`

- **commit**：`9a6ef44` `fix(web): 修 P0 编辑器/画布五处缺陷（⑤①②④a④b）`
- **作者/时间**：戴静，2026-09-19 22:01:53 +0800
- **规模**：21 文件，+802 / −97（`git show --numstat` 合计）

| 文件 | +行 | −行 |
|---|---:|---:|
| `apps/web/src/features/workspace/SecondaryNav.tsx` | 25 | 3 |
| `apps/web/src/features/workspace/SecondaryNavSections.tsx` | 2 | 0 |
| `apps/web/src/features/workspace/secondary-nav-render.test.tsx` | 55 | 2 |
| `apps/web/src/features/kb/WysiwygEditor.tsx` | 17 | 33 |
| `apps/web/src/features/kb/wy-zones.ts`（新） | 66 | 0 |
| `apps/web/src/features/kb/wy-zones.test.ts`（新） | 65 | 0 |
| `apps/web/src/features/kb/canvas/GxLinkBlockView.tsx` | 44 | 16 |
| `apps/web/src/features/kb/canvas/link-drag.ts`（新） | 67 | 0 |
| `apps/web/src/features/kb/canvas/link-drag.test.ts`（新） | 107 | 0 |
| `apps/web/src/features/kb/DrawnixCanvas.tsx` | 11 | 37 |
| `apps/web/src/features/kb/canvas/board-guards.ts`（新） | 83 | 0 |
| `apps/web/src/features/kb/canvas/board-guards.test.ts`（新） | 91 | 0 |
| `apps/web/src/features/kb/kb.css` | 4 | 2 |
| `apps/web/src/features/kb/VersionHistoryDrawer.tsx` | 11 | 2 |
| `apps/web/src/features/kb/version-history-layer.test.tsx`（新） | 63 | 0 |
| `apps/web/src/components/ui.tsx` | 8 | 1 |
| `apps/web/src/components/feedback.tsx` | 4 | 0 |
| `apps/web/src/components/modal-a11y.test.tsx` | 22 | 1 |
| `packages/design-tokens/src/layout.ts` | 4 | 0 |
| `packages/design-tokens/src/tailwind.ts` | 2 | 0 |
| `docs/_archive/originals/acceptance-2026-09-19-p0-editor-canvas-recheck.md`（新） | 51 | 0 |

**行级要点**（逐条取自该 commit message，未作推断）：

1. **⑤** 二级导航：`kbTab` 从纯本地 state 改为**路由派生**（canvas/doc 路由反推），手动点 tab 只在当前路由内生效；数据源拉全量 tab 本地过滤 → 进画布编辑 L2 不再跳回文档列表、画布行选中态不再丢；二级行补 `aria-current="page"`。
2. **①** 富文本插入热区：判据从「邻块是否占用型」改为「邻块是否已给可输入空位」；嵌入块紧贴有内容的段落时上下热区都保留（可命中），仅邻块为空段落才省。
3. **②a** 关联卡拖拽：拖拽期**逐帧写 plait**（首帧 `withNewBatch` + 后续 `withMerging`，松手补写最后一帧）→ 连接线实时跟随，一次拖拽仍只一个撤销批次。
4. **②b** 画布预览残影：只读预览板安装 `installPreviewBoardGuards` **整体短路板手势**，从源头不产生选区/拖拽残留态（保留 wheel 缩放平移与命令式 fit/zoom）。
5. **④a** 二次确认弹窗：`design-tokens` 新增 `modalNested=860`（`gx-z-modal-nested`），`Modal` 增 `zClass` 入口，`ConfirmHost` 用它盖住 `canvasModal(820)`，**未调低后者**。
6. **④b** 版本历史抽屉：裸 `z-50` → `gx-z-drawer(400)` 令牌 + `createPortal` 到 body，不再被画布常驻工具条(75)压住。
7. 留证：`docs/_archive/originals/acceptance-2026-09-19-p0-editor-canvas-recheck.md`（51 行，随本 commit 新增）；截图 `docs/acceptance/screenshots/editor-canvas-*.png`（Grep/Glob 实测存在 6 张：`01-insert-zone`、`02-drag-follow-during`、`02-drag-after`、`02b-preview-no-ghost`、`04a-confirm-above-modal`、`04a-edit-modal-dirty`、`04a-after-discard`）。

> commit message 自述验证数字（**【未实测】**，本报告 worker 未复跑）：web 665 passed/54 files（基线 639/50）、
> api 2243/209、七包 typecheck Done、lint 0 error/114 warning（无新增）、真机 21/21 断言通过。

---

### 批次二（P1）：回挂丢失的五处功能入口 —— `a08d96d`

- **commit**：`a08d96d` `feat(web): 第五批回挂新 UI 改版后丢失的五处功能入口`
- **作者/时间**：戴静，2026-09-19 22:32:25 +0800
- **规模**：15 文件，+963 / −254
- **口径说明**：commit subject 写作「第五批」，实际对应本计划**第二批（P1）**，且同时提前落地了 P2 的 1/2/4 三条。

| 文件 | +行 | −行 |
|---|---:|---:|
| `apps/web/src/features/workspace/SecondaryNavTableOps.tsx`（新） | 245 | 0 |
| `apps/web/src/features/workspace/SecondaryNavKbOps.tsx`（新） | 175 | 0 |
| `apps/web/src/features/workspace/secondary-nav-lost-features.test.tsx`（新） | 228 | 0 |
| `apps/web/src/features/workspace/SecondaryNav.tsx` | 96 | 20 |
| `apps/web/src/features/workspace/SecondaryNavSections.tsx` | 51 | 6 |
| `apps/web/src/features/workspace/TableActionRow.tsx` | 10 | 117 |
| `apps/web/src/features/workspace/shell-stage1.test.tsx` | 30 | 8 |
| `apps/web/src/features/workspace/secondary-nav-render.test.tsx` | 23 | 3 |
| `apps/web/src/features/kb/KbHomePage.tsx` | 4 | 35 |
| `apps/web/src/features/grid/GridView.tsx` | 49 | 50 |
| `apps/web/src/features/grid/GridToolbar.tsx` | 10 | 4 |
| `apps/web/src/features/grid/grid-toolbar-narrow.test.tsx` | 18 | 3 |
| `apps/web/src/features/settings/perm-hide-gating.test.ts` | 11 | 6 |
| `apps/web/src/api/hooks.ts` | 9 | 1 |
| `apps/web/src/components/interaction.test.tsx` | 4 | 1 |

**行级要点**（逐条取自该 commit message，未作推断）：

1. 背景：第三批导航重构（`720e09c`）后 L2 只余纯导航行，旧壳 `Sidebar` / `KbTree` 已无引用点，挂在它们上的表操作与 KB 层级能力整批失联；本批**全部接回 L2**。
2. 表行菜单 + 新建数据表（`SecondaryNavTableOps.tsx`）：重命名 / 编辑表单(`?design=1`) / 复制表（含数据·不含数据）/ 清空数据(L3 输表名) / 删除表(L2 软删 + 撤销 toast)，删除后跳回库首页；复用 `useGXMutations` 既有封装，不复制实现。
3. KB 文档拖拽改层级（`SecondaryNavKbOps.tsx`）：`draggable` + 拖到文档上成子级 + 拖到根区回顶级，走既有 `useMoveDoc({parentId})`；**画布行不参与**（后端语义只到文档树）。
4. 新建文档/画布移入 L2 选项卡行右侧、按当前 tab 建对应类型；`KbHomePage` 原入口下线。
5. 导入导出收敛：`GridToolbar` 搜索框左侧常驻「导入/导出」，复用 `ImportWizard` / `ExportDialog`；「更多」菜单与 L2 表级操作行的重复入口一并摘下。
6. 回收站行：base → `/base/:id/trash`，kb → `/kb/:id/trash`。
7. 顺带修 `duplicateTable` 的缓存洞：原来只失效 `["bases"]`，库下表列表不刷新（复制成功但列表不出副本），**补失效 `["tables"]`**。
8. 权限：管理类入口（表操作菜单 / 新建数据表 / 新建文档画布）**无权限一律不渲染**。

> commit message 自述验证数字（**【未实测】**）：web 665/54 → 681/55，改 5 处既有断言（均注明原因，无删测试）。

---

### 批次三（P2）：互嵌循环/深度防护 + 权限管理与通讯录并入工作区设置 —— `5e97def`

- **commit**：`5e97def` `fix(web): P2 双修——互嵌循环/深度防护 + 权限管理与通讯录并入工作区设置`
- **作者/时间**：戴静，2026-09-19 23:29:37 +0800
- **规模**：18 文件，+919 / −187

| 文件 | +行 | −行 |
|---|---:|---:|
| `apps/web/src/features/kb/__tests__/embed-nest-guard.test.tsx`（新） | 206 | 0 |
| `apps/web/src/features/workspace/__tests__/workspace-settings-p2b.test.tsx`（新） | 170 | 0 |
| `apps/web/src/features/contacts/ContactsDirectory.tsx`（新） | 141 | 0 |
| `apps/web/src/features/kb/enhanceEmbeds.ts` | 76 | 12 |
| `apps/web/src/features/kb/embed-depth.ts`（新） | 85 | 0 |
| `apps/web/src/features/kb/EmbedDepthFallback.tsx`（新） | 61 | 0 |
| `apps/web/src/features/workspace/WorkspaceSettingsPage.tsx` | 58 | 28 |
| `apps/web/src/features/kb/canvas/RefEmbedCard.tsx` | 22 | 4 |
| `apps/web/src/features/workspace/WorkspaceSettingsSectionGating.test.tsx` | 26 | 2 |
| `apps/web/src/features/kb/VersionHistoryDrawer.tsx` | 16 | 0 |
| `apps/web/src/features/workspace/lib/nav-gate.ts` | 13 | 5 |
| `apps/web/src/features/contacts/ContactsPage.tsx` | 6 | 124 |
| `apps/web/src/features/authz/PermPanel.tsx` | 8 | 3 |
| `apps/web/src/features/kb/canvas/RefEmbedBody.tsx` | 9 | 1 |
| `apps/web/src/features/workspace/lib/nav-gate.test.ts` | 11 | 4 |
| `apps/web/src/features/kb/MarkdownEditor.tsx` | 4 | 1 |
| `apps/web/src/features/workspace/lib/nav-footer.ts` | 4 | 1 |
| `apps/web/src/features/workspace/nav-menu-polish.test.tsx` | 3 | 2 |

**行级要点**（分 A/B 两段，逐条取自该 commit message，未作推断）：

**A. 文档↔画布互嵌防护（对应 ③）**

1. `embed-depth.ts`：`MAX_EMBED_DEPTH=3`、`EmbedChain`（depth + 祖先 id 集）、`planEmbed` 纯函数（**环优先于深度判定**）、`EmbedChainContext` 沿组件树传递，中间渲染层零 props 改动。
2. `enhanceEmbeds`：逐占位问 `planEmbed`，环/超限挂 `EmbedDepthFallback` 链接卡（图标 + 标题 + 点击打开，**不取数不递归**）；放行时 Provider 下发含目标的新链。
3. 接线：`MarkdownEditor`（`chainWithSelf(docId)`）、`RefEmbedCard`（判环 + Provider）、`RefEmbedBody`（继承链）、`VersionHistoryDrawer`（历史预览同样纳入）。
4. 顺手修可达链上的既有崩溃：独立 root 缺 Router context，弹窗内关联块 `useNavigate()` 直接抛错——`MemoryRouter` + `NavBridge` 桥接回外层真实路由。

**B. 设置页整合（对应 3a / 3b）**

5. `FooterNav` 三项降两项（权限管理迁出 L1），`nav-gate` 删 authz case；`canSeeAuthz` **保留**（`PermPanel` 直访门控 + 设置页分区共用），`/workspace/authz` 仍可达。
6. `ContactsDirectory` 从 `ContactsPage` 抽出（resize 监听清理保持），页面壳只留路由；设置页通讯录分区直接内嵌（删「打开通讯录」跳转按钮与只做入口文案）。
7. `PermPanel` 增 `embedded` 形态（不重复大标题），设置页新增「权限管理」分区；通讯录/权限管理分区 `ownerOnly` + `canSeeAuthz` 双口径，**非 owner 不渲染不出假入口**（含通用分区通讯录卡片的收口）。

> commit message 自述验证数字（**【未实测】**）：web 706 passed/57 files（基线 681/55，+25/+2，nav-window 阈值未动）；
> 七包 typecheck Done；lint 0 err/114 warnings 与基线持平。

---

### 批次四（P3）：语义检索总门变量化 + MCP 令牌权限继承签发者 —— `6cec628`

- **commit**：`6cec628` `P3 后台配置改造：语义检索总门变量化 + MCP 令牌权限继承签发者`
- **作者/时间**：戴静，2026-09-20 00:41:54 +0800
- **规模**：37 文件，+728 / −266

| 文件 | +行 | −行 |
|---|---:|---:|
| `apps/api/src/domain/search/__tests__/search-gate-matrix.test.ts`（新） | 76 | 0 |
| `apps/api/src/routes/v1/__tests__/m5-search-gate.test.ts` | 74 | 5 |
| `apps/web/src/features/search/EmbeddingAdminSections.test.tsx`（新） | 53 | 0 |
| `apps/api/src/mcp/tools/__tests__/m6-p0a-search-scope.test.ts` | 47 | 39 |
| `apps/web/src/features/settings/PatListPanel.tsx` | 66 | 9 |
| `apps/web/src/features/settings/PatListPanel.test.tsx` | 42 | 15 |
| `apps/web/src/features/settings/CreatePatForm.tsx` | 22 | 52 |
| `apps/api/src/domain/search/searchGateRuntime.ts`（新） | 21 | 0 |
| `apps/api/src/domain/search/searchGate.ts` | 18 | 10 |
| `apps/api/src/mcp/tools/__tests__/registry-gate.test.ts` | 18 | 7 |
| `apps/api/src/mcp/transport/__tests__/m6-s3-gate.test.ts` | 17 | 11 |
| `apps/web/src/features/workspace/WorkspaceSettingsSectionGating.test.tsx` | 14 | 0 |
| `apps/api/src/routes/v1/adminSearch.ts` | 27 | 2 |
| `apps/web/src/features/search/search-admin-copy.ts` | 13 | 10 |
| `apps/web/src/features/settings/pat-labels.ts` | 20 | 3 |
| `apps/web/src/features/search/EmbeddingAdminSections.tsx` | 15 | 7 |
| `apps/web/src/features/workspace/WorkspaceSettingsPage.tsx` | 16 | 5 |
| `apps/api/src/mcp/tools/catalog.ts` | 8 | 4 |
| `apps/api/src/mcp/tools/record.tools.ts` | 13 | 21 |
| `apps/api/src/mcp/tools/registry.ts` | 11 | 9 |
| `apps/api/src/mcp/tools/types.ts` | 9 | 3 |
| `apps/api/src/mcp/transport/__tests__/m6-s6-canvas-read.test.ts` | 20 | 10 |
| `apps/api/src/mcp/transport/__tests__/m6-s7-audit-idempotency.test.ts` | 15 | 5 |
| `apps/web/src/features/settings/pat-labels.test.ts` | 15 | 5 |
| `apps/api/src/routes/v1/index.ts` | 10 | 8 |
| `apps/api/src/mcp/pat/patService.ts` | 10 | 3 |
| `apps/api/src/mcp/transport/__tests__/m6-s4-read-tools.test.ts` | 10 | 4 |
| `apps/api/src/mcp/transport/__tests__/m6-s4-write-tools.test.ts` | 9 | 4 |
| `apps/api/src/routes/v1/pats.ts` | 6 | 2 |
| `packages/shared-types/src/api.ts` | 7 | 3 |
| `apps/web/src/api/client.ts` | 7 | 1 |
| `apps/api/src/domain/search/__tests__/embedding-remote-config.test.ts` | 4 | 3 |
| `apps/api/src/mcp/permissions/types.ts` | 4 | 0 |
| `apps/api/src/mcp/transport/authenticate.ts` | 4 | 0 |
| `apps/api/src/routes/v1/search.ts` | 2 | 1 |
| `apps/web/src/features/workspace/lib/nav-gate.ts` | 3 | 4 |
| `apps/web/src/features/search/search-m5.test.ts` | 2 | 1 |

**行级要点**（分 A/B 两段，逐条取自该 commit message，未作推断）：

**A 语义检索总门（对应 8）**

1. 权威顺序改为 `app_settings.search.enabled` 显式 on/off > env > 默认 off；删除 `searchGate.ts` 的 env=off 短路，`resolveSearchGate.queryAvailable` 只按 effective 判定。
2. `/api/v1/search` 与 `/admin` 由**启动期按 env 静态挂载**改为**恒挂载**，请求期由 `assertSearchGate` 判定；配置面（config GET/PATCH、api-key）不受总门约束，避免 env=off 时后台开关成死结。
3. 前端门控由 `ownerOnly` 放宽为**持任一 `manage_*` 组织动作**（与 `nav-gate.canSeeWorkspaceSettings` 同口径）。
4. env=off 且未显式开启时，分区给出「当前由环境变量关闭，可在上方开启」行；三行热切换口径保留。
5. 新增判定矩阵单测（override × env 九格 + unset + 核心回归 env=off/db=on）。

**B MCP 令牌（对应 9）**

6. 令牌只做认证 + 有效期，能力一律**按签发者用户实时计算**：下线 `registry.ts` 的 `scopeAllows` 粗筛与 `record.tools.ts` 的 `allowedEntityTypes` 收窄两处消费点。
7. `scopes` 字段**保留入库与响应**（老数据兼容，不迁移）；老客户端显式传仍校验格式。
8. 新建表单移除 scope 勾选区，保留有效期；列表权限列改为「权限跟随签发者账号」。
9. `PatListPanel` 顶部接入方式块：端点按 `location.origin + withBase("/mcp")` 动态生成。

> commit message 自述验证数字（**【未实测】**）：web 715 passed/58 files（基线 706/57）；
> api 2260 passed/212 files（基线 2243）；七包 typecheck Done；真机 env=off 下 inherit→检索 404、置 on→200 已截图留证。

---

### 区间合计

`git diff --shortstat 9a6ef44~1..HEAD`：**84 文件、+3410 / −802**。
四个 commit 的文件数之和为 91（21+15+18+37），多出的 7 是被跨批次二次改动的文件（已由 `git diff --name-only`
与逐 commit 列表求交取证）：`VersionHistoryDrawer.tsx`、`SecondaryNav.tsx`、`SecondaryNavSections.tsx`、
`WorkspaceSettingsPage.tsx`、`WorkspaceSettingsSectionGating.test.tsx`、`lib/nav-gate.ts`、`secondary-nav-render.test.tsx`。
增删行合计也因此与区间净值略有出入（3412 vs 3410）。

---

## 二、逐条验证方式

> 「自动化」栏的测试文件与用例名全部来自 Grep 检索（已逐条核对文件存在），可直接 `grep "用例名"` 定位。
> 「浏览器手动点验」栏为本报告给出的点验步骤，供后续真机复验执行；**本报告 worker 未执行这些步骤，未产出新截图**。

### P0（批次一 `9a6ef44`）

| # | 问题 | 浏览器手动点验步骤 | 已有自动化测试（文件 / 用例名） |
|---|---|---|---|
| ⑤ | 画布编辑时左侧列表跳回文档列表、画布选中态丢失 | 进 `/kb/:kbId` → 点画布 tab → 打开任一画布进 `/kb/:kbId/canvas/:docId` → 观察 L2 是否**停在画布 tab**、画布行是否在列表内且为当前项；改文档内容再返回，L2 不应跳回文档列表 | `apps/web/src/features/workspace/secondary-nav-render.test.tsx`：`"画布路由下 L2 停在画布 tab：画布行在列表里且带当前项语义"`、`"文档路由下 L2 停在文档 tab：文档行在列表里且当前项有 aria-current"`、`"数据源拉全量后，画布子项不污染文档段的层级折叠"` |
| ① | 内容上/下无空行时无法插入 | 打开文档 → 在正文段落紧邻嵌入块（无空行）的位置，鼠标移到块上/下边缘 → 上下插入热区**都应出现且可点击**；在已有空段落的一侧不应重复出现热区 | `apps/web/src/features/kb/wy-zones.test.ts`：`"正文段落 ↔ 嵌入块：上下热区都在（这是缺陷现场）"`、`"已经存在空行（空段落）的那一侧不再包热区，避免视觉噪音"`、`"两个嵌入块相邻：两侧都保留（原行为保留不变）"`、`"首块 / 末块：没有邻块的那一侧恒给热区"` |
| ②a | 拖拽元素残影、连接线不实时跟随 | 在画布中拖动一张关联卡 → 拖动**过程中**连接线应实时跟随（松手前就动）；松手后按一次 Ctrl/Cmd+Z 应整段撤销一次拖拽 | `apps/web/src/features/kb/canvas/link-drag.test.ts`：`"首帧开新批次，后续帧并入同一批次（一次拖拽 = 一个 undo 项）"`、`"只读板不写（预览里拖卡片不应改动源数据）"`、`"元素已被删除（findPath 抛错）时静默放弃，不让拖拽炸掉"` |
| ②b | 画布预览残影（只读预览板） | 在文档中嵌入画布并以只读预览打开 → 拖动/框选后不应留下红色矩形残影；滚轮缩放与命令式 fit/zoom 仍可用 | `apps/web/src/features/kb/canvas/board-guards.test.ts`：`"pointerDown/Move/dblClick/键盘全部不再进入 plait（不给残留态留入口）"`、`"重复安装不会把守卫套两层（幂等）"`、`"事件落在画布本体 → 照常处理（编辑手势不能丢）"` |
| ④a | 二次确认弹窗被编辑弹窗遮挡 | 在画布/文档编辑弹窗中改动内容后点关闭 → 二次确认弹窗应**浮在编辑弹窗之上**，两个弹窗标题均可见 | `apps/web/src/components/modal-a11y.test.tsx`：`"P0-④a：确认弹窗走 gx-z-modal-nested，且层级真的高于画布编辑弹窗"`、`"confirmAction 的确认宿主喂给 Modal 的 props 形状：dialog 语义与可访问名都成立"` |
| ④b | 画布顶部工具条压住版本历史 | 在画布页打开版本历史抽屉 → 抽屉应盖住画布常驻工具条（不被压住），且 Esc / 点击遮罩可关 | `apps/web/src/features/kb/version-history-layer.test.tsx`：`"渲染出来的是 gx-z-drawer 令牌，不是裸 z-50"`、`"gx-z-drawer 的层级高于画布 chrome（75）"`、`"portal 到 document.body，且源码里不再出现裸 z 数值"` |

### P1（批次二 `a08d96d`）

| # | 问题 | 浏览器手动点验步骤 | 已有自动化测试（文件 / 用例名） |
|---|---|---|---|
| 5a | 表改名 / 新建数据表 / 删除表 | 选中一个数据库 → L2 表行悬停出现行菜单，应含「重命名」「删除表」；面板头应有「新建数据表」。删除后应跳回库首页并给出带撤销的 toast | `apps/web/src/features/workspace/secondary-nav-lost-features.test.tsx`：`"五项菜单齐全，且复用既有 mutation（不复制实现）"`、`"清空走 L3『输入表名』、删除走 L2 软删 + 撤销，都是 feedback 的既有危险确认"`、`"有表结构权限：面板头出现新建入口、表行出现行菜单"` |
| 5b | 可视化布局（表单设计器） | L2 表行菜单点「编辑表单」→ 应跳到带 `?design=1` 的详情页并进入表单设计器 | 同上文件：`"五项菜单齐全，且复用既有 mutation（不复制实现）"`（用例断言六项菜单标签，含「编辑表单」） |
| 5c | 复制表 / 清空数据 / 编辑表单 | 行菜单点「复制表（含数据）」→ 库下表列表**应立即出现副本**（验证 `["tables"]` 失效已补）；点「清空数据」→ 走 L3 输入表名确认 | 同上文件：`"五项菜单齐全……"`、`"清空走 L3『输入表名』、删除走 L2 软删 + 撤销……"` |
| 6 | KB 拖拽文档到另一文档下成为下一级 | 在 KB 的文档 tab 中，把文档 A 拖到文档 B 上 → A 成为 B 的子级；拖到列表底部「拖到此处移到顶级」区域 → 回顶级；画布行应**不可拖** | `apps/web/src/features/workspace/secondary-nav-lost-features.test.tsx`：`"走既有 useMoveDoc，且禁止拖到自己或自己的子树（防成环）"`、`"文档行可拖、画布行不可拖（画布不参与级联，不造后端没有的语义）"`、`"文档 tab 有「拖到此处移到顶级」根落区；无写权限时整块不渲染"` |
| 7 | 其余旧版入口 | 见本报告 §三 的逐条裁决表 | 见本报告 §三「证据/落地」列 |

### P2（批次二 `a08d96d` 的 1/2/4 + 批次三 `5e97def` 的 ③/3a/3b）

| # | 问题 | 浏览器手动点验步骤 | 已有自动化测试（文件 / 用例名） |
|---|---|---|---|
| ③ | 循环嵌套：文档↔画布互嵌 + 版本历史预览 | 构造 A 文档嵌 B 画布、B 画布再嵌回 A → 最内层应渲染为**降级链接卡**（图标 + 标题 + 点击打开），不递归、不卡死；嵌到第 4 层同样降级；打开版本历史预览时遵循同一规则 | `apps/web/src/features/kb/__tests__/embed-nest-guard.test.tsx`：`"自嵌（画布嵌回宿主自己）即成环，与层数无关"`、`"A 嵌 B、B 再嵌 A：第三层判环降级"`、`"正常多层仍能渲染：第 ${MAX_EMBED_DEPTH} 层（A→B→C→D）放行到第 ${MAX_EMBED_DEPTH} 层即为上限"`、
`"第 ${MAX_EMBED_DEPTH + 1} 层：超限降级"`（`MAX_EMBED_DEPTH = 3`，见 `embed-depth.ts:21`，故实际渲染为「第 3 层 / 第 4 层」）、`"判定不改入参（每次派生都换新集合），根链保持空"`、`"成环（宿主链里已有该画布）：挂降级卡，一个 CanvasEmbed 都不挂"`、`"超限卡带「点击打开」按钮，走的是目标画布地址"` |
| 3a | 权限管理并入工作区设置 | 底部导航应只剩**两项**（通讯录、工作区设置）；进工作区设置应看到「权限管理」分区且内嵌权限面板（不重复大标题）；直访 `/workspace/authz` 仍可达 | `apps/web/src/features/workspace/__tests__/workspace-settings-p2b.test.tsx`：`"App 仍注册 /workspace/authz → PermPanel（删导航入口≠删页面）"`、`"设置页左二级新增「权限管理」分区，图标沿用 shield"`、`"内嵌 PermPanel 走 embedded（不重复一个大标题）"` |
| 3b | 通讯录直接展示列表 | 进工作区设置 → 通讯录分区应**直接内嵌成员列表**，不再只有「打开通讯录」按钮 | 同上文件：`"直戳 /settings/contacts 渲染内嵌的 ContactsDirectory"`、`"旧的「打开通讯录」按钮与「这里只做入口」文案已删除"`、`"/workspace/contacts 页面壳只做路由占位，主体与设置页是同一个组件"`、`"抽出后 window resize 监听仍然成对（注销在同一个 effect 的 cleanup 里）"`；非 owner 口径见「非 owner：左二级不出现这两个分区（连 disabled 入口也没有）」 |
| 3c | 二级菜单顶部返回按钮 | **计划判定为「从未存在，无需修复」**，无需点验 | 无对应改动；四个 commit 的 `git show --numstat` 中均无相关文件。判定依据见 `PLAN.md` §一 P2 表（`SecondaryNav.tsx:175-195` 面板头只有图标+名称+收起） |
| 1 | 新建文档/画布按钮移入 L2 按当前选项卡 | 在 KB 下：文档 tab 时 L2 选项卡行右侧出「新建文档」，画布 tab 时出「新建画布」，二者互斥；`/kb/:kbId` 首页不应再有这组入口 | `apps/web/src/features/workspace/secondary-nav-lost-features.test.tsx`：`"文档 tab 出「新建文档」、画布 tab 出「新建画布」，二者互斥"`、`"无创建权限（viewer）时不渲染新建入口"`、`"KbHomePage 的原入口已下线（同一能力不留两处）"` |
| 2 | 导入导出移到表详情页搜索框右侧 | 打开任一表 → 工具栏搜索框左侧应**常驻**「导入/导出」；「更多」菜单内不应再有重复项 | 同上文件：`"工具栏常驻「导入 / 导出」，「更多」菜单不再重复"`、`"向导复用不重写：执行侧在 GridView，L2 操作行不再挂向导"` |
| 4 | 回收站改 L2 底部入口 | 选中数据库 → L2 列表末尾应有回收站行，点击进 `/base/:id/trash`；选中知识库 → 进 `/kb/:id/trash` | 同上文件：`"base 容器跳 /base/:id/trash，kb 容器跳 /kb/:id/trash"`、`"列表末尾渲染回收站行，data 属性带容器类型（两种容器都能断言）"`、`"两页路由都已存在（不是死链）"` |

### P3（批次四 `6cec628`）

| # | 问题 | 浏览器手动点验步骤 | 已有自动化测试（文件 / 用例名） |
|---|---|---|---|
| 8 | 语义检索「硬编码」 | 以 `GX_M5_SEARCH=off` 启动 → 进工作区设置「语义检索」分区，应看到「当前由环境变量关闭，可在上方开启」；把后台开关置 on → 检索接口应可用（不再被 env 短路）；非 owner 但持任一 `manage_*` 应能进该分区 | `apps/api/src/domain/search/__tests__/search-gate-matrix.test.ts`：`"核心回归：env=off 时后台置 on 必须压过 env（旧实现曾直接短路回 off）"`、`"env 未设置 ≡ off：inherit 时目标态 off，显式 on 仍可打开"`、`"覆盖值解析：仅精确小写 on/off 生效，其余一律 inherit（不报错）"`；`apps/api/src/routes/v1/__tests__/m5-search-gate.test.ts`：`"env=off + db=on：/api/v1/search 可用（空 q 回 §9 空壳，非 404）"`、`"env=off + db=off：显式停用压过一切，仍 404"`、`"env=on + db=off：后台显式停用也能关掉（覆盖值双向生效）"`；`apps/web/src/features/search/EmbeddingAdminSections.test.tsx`：`"env=off 且未显式设置：明说「当前由环境变量关闭，可在上方开启」"`、`"env 不为 off 时不出现「由环境变量关闭」那一行（不误导）"`；`apps/web/src/features/workspace/WorkspaceSettingsSectionGating.test.tsx`：`"非 owner 但持任一 manage_* 动作：/search 进得去（放宽不是收紧）"` |
| 9 | MCP 令牌权限 | 进工作区设置 → MCP 接入 → 新建令牌表单**不应有 scope 勾选区**，只有名称与有效期；列表权限列应显示「权限跟随签发者账号」；顶部接入方式块的端点应随当前站点 origin 变化（子路径部署不写死 localhost） | `apps/web/src/features/settings/PatListPanel.test.tsx`：`"不存在任何权限范围勾选框；默认有效期为 90 天；权限改为继承说明"`、`"SSR 无 location 时退回同源相对路径，绝不写死 localhost/域名"`、`"源码层面：端点由 location.origin + withBase(\"/mcp\") 拼出（子路径部署不写死）"`；`apps/web/src/features/settings/pat-labels.test.ts`：`"权限继承说明是界面唯一口径（不再有勾选默认值）"`、`"名称 1–60 才可提交（权限不再由表单决定）"`；`apps/api/src/mcp/tools/__tests__/registry-gate.test.ts`：`"令牌 scope 不参与注册判定：doc:read 与 record:read 主体注册集一致"`、`"写工具同入册：能力按签发者"`；`apps/api/src/mcp/tools/__tests__/m6-p0a-search-scope.test.ts`：`"仅 record:read 的 PAT 调 record.search：不再收窄成 [record]，三族全出（按签发者 u1 的授权）"`、`"无任何读 scope：不再 fail-closed FORBIDDEN_RESOURCE，仍走桥（能力与签发者一致）"` |

---

## 三、丢失入口排查报告

> 底稿：`PLAN.md` §一 P1 第 7 条「旧版有、新版不可达的完整盘点」。
> 裁决口径由任务书给定：第三批 `720e09c` 有意下线的编排类入口＝**不恢复**；旧壳 `Sidebar.tsx` / `KbTree.tsx` /
> `KbSidebar.tsx` 上的表操作与 KB 层级能力＝**已恢复（移到 L2）**。
> 未落入这两类的，按 grep 取证结果单独裁决，无证据的一律标 **【未实测】**。

| # | 来源（旧位置） | 能力 | 裁决 | 理由 / 落地 |
|---|---|---|---|---|
| 1 | `features/sidebar/Sidebar.tsx`（行菜单 :190-204，:50/:62/:97） | 表**重命名** | **已恢复（移到 L2）** | 落地 `a08d96d`，`SecondaryNavTableOps.tsx:138` 菜单项 `重命名`；用例 `secondary-nav-lost-features.test.tsx` → `"五项菜单齐全，且复用既有 mutation（不复制实现）"` |
| 2 | 同上 | **新建数据表** | **已恢复（移到 L2）** | 落地 `a08d96d`，`SecondaryNavTableOps.tsx` 面板头入口（受 `canManageSchema` 把门）；用例同上文件 `"有表结构权限：面板头出现新建入口、表行出现行菜单"` |
| 3 | 同上 | **删除表** | **已恢复（移到 L2）** | 落地 `a08d96d`，L2 软删 + 撤销 toast，删除后跳回库首页；用例 `"清空走 L3『输入表名』、删除走 L2 软删 + 撤销，都是 feedback 的既有危险确认"` |
| 4 | 同上 | **编辑表单**（`?design=1`，对应 P1-5b） | **已恢复（移到 L2）** | 落地 `a08d96d`，菜单项 `编辑表单`；用例断言标签集含「编辑表单」 |
| 5 | 同上 | **复制表（含数据 / 不含数据）** | **已恢复（移到 L2）** | 落地 `a08d96d`；同批顺带修 `duplicateTable` 只失效 `["bases"]` 的缓存洞（补 `["tables"]`），否则「复制成功但列表不出副本」 |
| 6 | 同上 | **清空数据** | **已恢复（移到 L2）** | 落地 `a08d96d`，走 L3 输入表名确认；用例同上 |
| 7 | 同上 | **数据表图标与颜色**（`Sidebar.tsx:73/316/320`，`EntityIconPicker`） | **已恢复（不在 L2，在表详情页）** | **非本四批所为**：`GridView.tsx:569/573` 工具栏最左侧挂 `EntityIconPicker`（`ariaLabel="数据表图标与颜色"`），落地 commit `32c3c6e`（经 `git merge-base --is-ancestor` 取证，早于 `9a6ef44`）；用例 `apps/web/src/features/grid/table-icon-entry.test.tsx` → `"数据表图标与颜色入口（表页可达性）"`。注：`EntityIconPicker` 在 `apps/web/src/features/workspace/` 下零引用，即 **L2 上确实没有**该入口 |
| 8 | `TopBar.tsx:167` | **删除表**（第二条入口） | **已恢复（收敛到 L2 一处）** | 与第 3 行同一能力；新壳由 `SecondaryNavTableOps` 单点提供，不留双入口 |
| 9 | `KbTree.tsx:72-73 / 225-233` | KB **拖拽文档改层级**（`moveDoc({parentId})`） | **已恢复（移到 L2）** | 落地 `a08d96d`，`SecondaryNavKbOps.tsx`（+175 行），复用既有 `useMoveDoc` 并沿用 KbTree 同一套防环判定；画布行不参与。用例 `"走既有 useMoveDoc，且禁止拖到自己或自己的子树（防成环）"`、`"文档行可拖、画布行不可拖……"` |
| 10 | `KbTree.tsx:296/305` | 文档**重命名** / **删除** | **已恢复（等价入口在 KB 首页，非 L2）** | `KbHomePage.tsx:92/99-104` 已有同名能力（行菜单「重命名/权限/删除」，删除走 L2 确认 + 撤销 toast）。Grep 取证：`apps/web/src/features/workspace/` 下无「重命名」，即**未**另在 L2 复制一份，避免同一能力两处入口 |
| 11 | `KbSidebar.tsx` | **库切换器** + **知识库新建** | **不恢复（已被覆盖，非丢失）** | `PLAN.md` §一 已判定「已被 L1 的 `NavLibraryBlock` 覆盖，不丢」；`LibrarySwitcher.tsx:5` 注释佐证其为两壳共用组件 |
| 12 | 第三批 `720e09c` 有意删除 | **`NavComposer`**（导航编排） | **不恢复（编排下线）** | 随 `menu_items` 手动收纳机制一并下线；`lib/nav-footer.ts:17` 注释明载，`nav-gate.ts:45` 仅保留纯函数 `canSeeNavComposer` 作兜底判定（`nav-gate.test.ts:84` 用例佐证「纯函数保留给工作区设置的兜底判定」） |
| 13 | 同上 | **三视角**（全部 / 未收纳 / 已收纳） | **不恢复（编排下线）** | 随收纳机制下线；`secondary-nav-render.test.tsx:74` 用例断言「二级列出该库下的表，且没有『全部/未收纳/已收纳』收纳视角」 |
| 14 | 同上 | **「收纳到导航」** | **不恢复（编排下线）** | `SecondaryNavSections.tsx:8`、`SecondaryNav.tsx:9` 注释明载已下线；`shell-stage1.test.tsx:226` 用例注释「二级行本体已不再挂三点菜单（「收纳到导航」与「移动到分组」随编排下线）」 |
| 15 | 同上 | **「移动到分组…」** | **不恢复（编排下线）** | `MoveToGroupModal.tsx:1` 组件文件仍在但随编排下线；同上 `shell-stage1.test.tsx:226` 注释（该文件内 `移动到分组` 仅在 `RowMoreMenu` 组件的通用渲染测试中作为标签样例出现，非业务入口回归） |
| 16 | 同上 | **`/workspace/settings/nav`** 路由页 | **不恢复（编排下线）** | `lib/nav-footer.ts:17-19` 明载该路径此后回落到工作区设置通用分区（不再可达）；`nav-gate.test.ts:82-83` 断言 `FOOTER_NAV_ITEMS` 不含该路径 |
| 17 | 同上 | **FooterNav 第四项** | **不恢复（编排下线）** | `nav-footer.ts` `FOOTER_NAV_ITEMS` 现为**两项**（`/workspace/contacts`、`/workspace/settings/assets`，`nav-footer.ts:24-27`）；由四项→三项（编排下线，`nav-footer.ts:17`）→两项（`5e97def` 权限管理迁出，`nav-footer.ts:20-23` 注释明载「故此处由三项降为两项」） |
| 18 | P2-3c | **二级菜单顶部返回按钮** | **不恢复（从未存在）** | `PLAN.md` §一 P2 表判定「从未存在，无需修复」；四个 commit 均无相关改动 |
| 19 | 任务书备注项 | **Johan `\n` / Cockpit 相关信息** | **不恢复（无可取证来源）** | 全仓（排除 `node_modules`）对 `johan`、`cockpit` 做大小写不敏感检索 `*.ts`/`*.tsx`/`*.md`/`*.json`，**零命中**；`git log` 亦无相关记录。记为 **【未实测】**，不认领到任何批次 |

### 排查结论

- 盘点清单共 19 条（原清单 5 个来源块拆解后 + 任务书备注项）。
- **已恢复** 10 条（#1–#10）：其中 #1–#6、#9 由本四批的 `a08d96d` 落地；#7 由 `32c3c6e` 早于本四批落地；#8 与 #3 同源；#10 走 KB 首页既有等价入口。
- **不恢复** 9 条（#11–#19）：#12–#17 属第三批有意下线（编排下线），#11 已被覆盖，#18 从未存在，#19 无取证来源。
- 未出现「有证据但仍未处理」的悬空项；#19 是唯一标 **【未实测】** 的条目。

---

## 附：本报告未做的事

- 未复跑 web/api 全量测试（任务书禁止），故所有测试总数均标注 **【未实测】** 并注明来源为 commit message 自述。
- 未做真机浏览器点验与截图，§二 的「浏览器手动点验步骤」为待执行步骤而非已完成结论。
- 未修改任何代码文件，改动仅限本目录 `PLAN.md` 与新建 `REPORT.md`。
