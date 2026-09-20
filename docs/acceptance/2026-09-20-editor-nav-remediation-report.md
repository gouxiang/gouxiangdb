# 编辑器/画布 + 导航入口 + 丢失功能 + 后台配置 —— 闭环报告

> 日期：2026-09-20
> 对应计划：`docs/design/2026-09-19-editor-nav-remediation/PLAN.md`
> 取证基线：HEAD = `9cdc85a`（写作时）。四个计划批次 commit：
> 一 `9a6ef44` / 二 `a08d96d` / 三 `5e97def` / 四 `6cec628`；批次外追加 `d562075`、`9cdc85a`。
> 取证方式：`git show --stat`、Grep 关键符号、读源文件。**本报告未独立复跑测试套件**——
> 所有测试数、断言数均逐条注明出处（commit message 或既有复验文档），无法从上述来源取得的数字一律标 `【未实测】`。

---

## 一、变更清单

### 批次一（P0）—— `9a6ef44`「fix(web): 修 P0 编辑器/画布五处缺陷（⑤①②④a④b）」
`git show --shortstat` = 21 文件、+802/−97

| 条目 | 改了什么 | 落在哪个文件哪一段（取证） | 影响面 |
|---|---|---|---|
| ⑤ | `kbTab` 从纯本地 `useState`（默认 `"doc"`、从不与路由同步）改为**路由派生**：由 `/kb/:kbId/canvas/:docId` 与 `/kb/:kbId/doc/:docId` 反推；数据源改为拉全量后本地按 tab 过滤；二级行补 `aria-current="page"` | `apps/web/src/features/workspace/SecondaryNav.tsx:94`（`useMatch("/kb/:kbId/canvas/:docId")`）、`:111`（`routeTab`）、`:114`（`kbTab` 合成）、`:162-185`（全量数据源 + `kindGroups` 本地过滤）、`:371-393`（`KbDocDTO→条目`，href 按 kind 分流）；`SecondaryNavSections.tsx` 二级行 `aria-current` | 前端。无数据结构变更。需重新构建前端并刷新 |
| ① | 插入热区判据从「邻块是否占用型（`needsEmptyPair`）」改为「邻块是否已给出可输入空位（`hasTypingRoom`）」：嵌入块紧邻**有内容的**普通段落时上下热区都保留；仅邻块本身是空段落才省 | `apps/web/src/features/kb/wy-zones.ts`（新，66 行）：`:33 needsEmptyPair`、`:41 hasTypingRoom`、`:54-64 zoneFlags`；消费点 `WysiwygEditor.tsx:40`（import）、`:2290`（`zoneFlags({...})`） | 前端编辑器。无数据结构变更。需重新构建前端 |
| ②a | 关联卡拖拽从「只写本地 `dragVb` 驱动 FO、松手一次性落库」改为**拖拽期逐帧写 plait**（首帧 `withNewBatch`、后续 `withMerging`、松手补写最后一帧），使连接线实时跟随；一次拖拽仍只产生一个撤销批次 | `apps/web/src/features/kb/canvas/link-drag.ts`（新，67 行）：`:25 liveLinkBlock`、`:32 translateLinkPoints`、`:44 syncLinkDragPoints`；消费点 `GxLinkBlockView.tsx:29`（import）、`:55-60`（注释说明不再走 dragVb）、`:179`、`:203`（两处 `syncLinkDragPoints`） | 前端画布。无数据结构变更（仍是一次落库）。需重新构建前端 |
| ②b | 只读预览板（文档内嵌画布）安装 `installPreviewBoardGuards` **整体短路板手势**，从源头不产生选区/拖拽残留态（保留 wheel 缩放平移与命令式 fit/zoom） | `apps/web/src/features/kb/canvas/board-guards.ts`（新，83 行）：`:68 installLinkBoardGuards`、`:80 installPreviewBoardGuards`；接线 `DrawnixCanvas.tsx:25`（import）、`:292-305`（按 readonly 分支安装/回写 `board.options.readonly`） | 前端画布预览。无数据结构变更。需重新构建前端 |
| ④a | 新增 z 档 `modalNested=860`（令牌 `gx-z-modal-nested`），`Modal` 增加 `zClass` 覆写入口，`ConfirmHost` 用它盖住 `canvasModal(820)`（未调低后者） | `packages/design-tokens/src/layout.ts:84`（`modalNested: 860`）、`tailwind.ts`（令牌出口）；`apps/web/src/components/ui.tsx:579`（`zClass = "gx-z-modal"` 默认）、`:593-597`（`zClass?: string` 说明）、`:641`（className 使用）；`apps/web/src/components/feedback.tsx:285`（`zClass="gx-z-modal-nested"`） | 前端（含 `packages/design-tokens` 公共包）。无数据结构变更。design-tokens 改动需连带前端重新构建 |
| ④b | 版本历史抽屉裸 `z-50` → `gx-z-drawer`(400) 令牌，并 `createPortal` 到 `document.body`，不再被画布常驻 chrome（75）压住 | `apps/web/src/features/kb/VersionHistoryDrawer.tsx:5`（import createPortal）、`:146-150`（注释 + `className="fixed inset-0 gx-z-drawer flex justify-end"`）、`:329-331`（`createPortal(drawer, document.body)`，SSR 兜底就地返回）；对照 `kb.css:178-188`（chrome 常驻 75） | 前端。无数据结构变更。需重新构建前端 |

**同批附带**：`kb.css`（+6，插入热区颜色改走 gx 令牌）、`modal-a11y.test.tsx`、新增 4 个测试文件
（`board-guards.test.ts`、`link-drag.test.ts`、`wy-zones.test.ts`、`version-history-layer.test.tsx`）、
`secondary-nav-render.test.tsx`（+57）、复验文档 `docs/_archive/originals/acceptance-2026-09-19-p0-editor-canvas-recheck.md`（新，51 行）。

### 批次二（P1）—— `a08d96d`「feat(web): 第五批回挂新 UI 改版后丢失的五处功能入口」
`git show --shortstat` = 15 文件、+963/−254
（commit subject 写作「第五批」，实际是本计划第二批——措辞不一致，内容对齐 5a/5b/5c/6 + P2 的 1/2/4）

| 条目 | 改了什么 | 落在哪个文件哪一段（取证） | 影响面 |
|---|---|---|---|
| 5a / 5c | 表行菜单五项一次性回挂 L2：重命名 / 编辑表单 / 复制表（含数据）/ 复制表（不含数据）/ 清空数据 / 删除表；另加面板头「+ 新建数据表」。全部复用 `useGXMutations` 既有封装 | `apps/web/src/features/workspace/SecondaryNavTableOps.tsx`（新，245 行）：`:33`（面板头新建入口）、`:50 useGXMutations`、`:65 编辑表单 → navigate('/base/:baseId/table/:tableId?design=1')`、`:80 renameTable`、`:88 duplicateTable`、`:96 clearTable`（L3 输表名）、`:107-131 deleteTable`（L2 软删 + 撤销 toast，成功后跳回库首页）、`:138-148` 菜单项数组；渲染接线 `SecondaryNav.tsx:154`（`useSecondaryTableOps`）、`:252-278`（`tableOps.panelNode`）、`:332`（`tableOps.rowMenuItems` 仅 `row.kind === "table"`） | 前端。**涉及数据**（删表/清空/复制均走既有 mutation + 回收站）。需重新构建前端 |
| 5b | 可视化布局（表单设计器）入口随「编辑表单」一并回落：不再需要先建 detail 视图再找齿轮菜单，直接 `?design=1` 跳目标表 | 同上 `SecondaryNavTableOps.tsx:58-65`（注释说明与旧壳 / DetailView 同源）、`:141` 菜单项「编辑表单」 | 前端。无数据结构变更。需重新构建前端 |
| 6 | KB 文档拖拽改层级回挂 L2：文档行 `draggable`、拖到另一文档上成为子级、拖到根区回顶级；走既有 `useMoveDoc({parentId})`；画布行不参与；成环（拖到自己/自己子树）拦截 | `apps/web/src/features/workspace/SecondaryNavKbOps.tsx`（新，175 行）：`:55 useMoveDoc`、`:81-84 isSelfOrDescendant`、`:95-102`（`parentId` 计算 + `mutateAsync`）、`:137 draggable: canCreate`、`:154/:168` 落区 `onDrop`；接线 `SecondaryNav.tsx:300-311`（根落区「拖到此处移到顶级」）、`:336`（`row.kind === "doc" ? kbOps.rowDrag(...)`） | 前端 + 后端既有 `moveDoc` API（无后端改动）。**涉及数据**（改文档 parentId）。需重新构建前端 |
| 1 | 新建文档 / 画布从 `KbHomePage` 移入 L2 选项卡行右侧，按当前 tab 建对应类型（文档 tab 出「新建文档」、画布 tab 出「新建画布」，互斥）；无创建权限不渲染 | `SecondaryNav.tsx:299`（`container.kind === "kb" && kbTab === "doc" && kbOps.canCreate`）；`KbHomePage.tsx:39` 行净减、`:140` 注释「新建文档/画布已移到二级导航（L2）选项卡行右侧」 | 前端。无数据结构变更。需重新构建前端 |
| 2 | 导入导出收敛：L2 表级操作行的重复入口摘除，`GridToolbar` 搜索框旁常驻「导入 / 导出」；向导复用 `ImportWizard` / `ExportDialog` 不重写 | `apps/web/src/features/grid/GridToolbar.tsx:408-413`（常驻 ToolButton）、`:416/:468`（「更多」菜单里的重复项摘除注释）；`GridView.tsx:419-439`（导出执行）、`:629-638`（向导挂载）；`TableActionRow.tsx` 净 −127 行 | 前端。**涉及数据**（导入写库、导出读库）。需重新构建前端 |
| 4 | 回收站行：L2 列表末尾按当前容器直跳（base → `/base/:id/trash`，kb → `/kb/:id/trash`） | `SecondaryNav.tsx:346-362`（`data-l2-trash={container.kind}` + 图标行） | 前端。无数据结构变更。需重新构建前端 |
| 附带 | 修 `duplicateTable` 缓存洞：原只失效 `["bases"]`，库下表列表不刷新（复制成功但列表不出副本），补失效 `["tables"]` | `apps/web/src/api/hooks.ts`（+10/−?） | 前端查询缓存。无后端改动。需重新构建前端 |

### 批次二-补（P1 位置微调）—— `d562075`「fix(web): 导入导出按钮移到搜索框右侧」
`git show --shortstat` = 3 文件、+13/−12

| 条目 | 改了什么 | 落在哪个文件哪一段（取证） | 影响面 |
|---|---|---|---|
| 2（二次修正） | `a08d96d` 把「导入 / 导出」放在搜索框**左侧**；主理人实测后要求移到**右侧**，本 commit 翻转到 `ListSearchBox` 之后（同一工具栏行内、仍紧跟搜索框）。`<768` 被压缩的是搜索框那个 `flex-1` 容器，按钮本身不换行不断行 | `apps/web/src/features/grid/GridToolbar.tsx`（+13/−6 段，`:408-413` 区块顺序）；`TableActionRow.tsx:1` 处指向该位置的说明同步更正；`grid-toolbar-narrow.test.tsx` 顺序断言由「在搜索框之前」翻转为「在搜索框之后」 | 前端。无数据结构变更。需重新构建前端 |

### 批次三（P2）—— `5e97def`「fix(web): P2 双修——互嵌循环/深度防护 + 权限管理与通讯录并入工作区设置」
`git show --shortstat` = 18 文件、+919/−187

| 条目 | 改了什么 | 落在哪个文件哪一段（取证） | 影响面 |
|---|---|---|---|
| ③ | 新增嵌入链模型：`MAX_EMBED_DEPTH=3` + 祖先 id 集；`planEmbed` 纯函数**环检测优先于深度判定**；`EmbedChainContext` 沿组件树传递（中间渲染层零 props 改动）；成环/超限统一降级为 `EmbedDepthFallback` 链接卡（图标 + 标题 + 点击打开，不取数不递归） | `apps/web/src/features/kb/embed-depth.ts`（新，85 行）：`:21 MAX_EMBED_DEPTH = 3`、`:24 EmbedChain`、`:47 chainWithSelf`、`:63-65 planEmbed`（先判环后判深度）、`:80-84 EmbedChainContext / useEmbedChain`；`enhanceEmbeds.ts:19`（import）、`:86-96`（按 `planEmbed` 决定挂载 `CanvasEmbed` 还是降级卡，并用 `EmbedChainContext.Provider` 下发新链）；`EmbedDepthFallback.tsx`（新，61 行） | 前端渲染链路。无数据结构变更。需重新构建前端 |
| ③（接线） | 四个入口纳入同一条链：MarkdownEditor 以「宿主自身」起链、RefEmbedCard 判环后下发新链、RefEmbedBody 继承链、版本历史预览同样纳入（宿主身份仍记 `doc.id`，即环看实体身份不看版本号） | `MarkdownEditor.tsx:21`（import `chainWithSelf`）、`:132`（`chain: chainWithSelf(docId)`）；`RefEmbedCard.tsx:9, :87-94`（`useEmbedChain` + `planEmbed` + Provider）；`RefEmbedBody.tsx:12, :55-71`（`useEmbedChain` 并透传）；`VersionHistoryDrawer.tsx:15, :107`（`chain: chainWithSelf(doc.id)`，`:98-100` 注释说明快照语义） | 前端。无数据结构变更。需重新构建前端 |
| ③（顺手修） | 可达链上的既有崩溃：独立 root 缺 Router context，弹窗内关联块 `useNavigate()` 直接抛错 → `MemoryRouter` + `NavBridge` 桥接回外层真实路由 | `apps/web/src/features/kb/enhanceEmbeds.ts:10`（注释）、`:15`（import）、`:25`（「MemoryRouter 只解决『useNavigate 有 context』」）、`:28 NavBridge`、`:62`、`:117-119`（`MemoryRouter` 包裹 + `createElement(NavBridge, { onNavigate })`） | 前端。需重新构建前端 |
| 3a | FooterNav 由三项降两项（`/workspace/authz` 移出 L1 底栏）；`nav-gate.ts` 删除 `authz` case，但 `canSeeAuthz` **保留**（PermPanel 直访门控 + 设置页分区共用，`/workspace/authz` 仍可达）；`PermPanel` 增 `embedded` 形态（不重复大标题）；设置页新增「权限管理」分区（icon: shield，ownerOnly + canSeeAuthz 双口径） | `apps/web/src/features/workspace/lib/nav-footer.ts:14-26`（现仅 `contacts`、`settings/assets` 两项）；`lib/nav-gate.ts:61-62`（`canSeeAuthz`）、`:76-87`（authz case 已删、落 default false）；`authz/PermPanel.tsx:19`（`{ embedded }`）、`:43-44`（embedded 时不重复大标题）；`WorkspaceSettingsPage.tsx:52-53`（contacts/authz 分区定义）、`:127-140`（可见性口径）、`:288-297`（authz 分区渲染 `<PermPanel embedded />`） | 前端。无数据结构变更。需重新构建前端 |
| 3b | 通讯录由「说明 + 跳转按钮」改为**内嵌真实成员列表**：`ContactsDirectory` 从 `ContactsPage` 抽出（resize 监听注册/注销保持成对），`ContactsPage` 缩为纯路由壳，设置页 contacts 分区直接内嵌同一组件；删「打开通讯录」按钮与「这里只做入口」文案；通用分区里那张对非 owner 无效的通讯录跳转卡片一并收口 | `apps/web/src/features/contacts/ContactsDirectory.tsx`（新，141 行）：`:25` 组件出口、`:45-46`（`addEventListener("resize")` + cleanup `removeEventListener`）；`ContactsPage.tsx:3-9`（壳只剩 `return <ContactsDirectory />`，净 −130）；`WorkspaceSettingsPage.tsx:16`（import）、`:271-285`（contacts 分区内嵌）、`:243-249`（非 owner 假入口收口注释） | 前端。无数据结构变更。需重新构建前端 |
| 3c | **判定为「从未存在，无需修复」，无任何对应改动** | `SecondaryNav.tsx:175-195`（面板头只有 图标 + 名称 + 收起）；PLAN §一 P2 表 3c 行 | 无 |

### 批次四（P3）—— `6cec628`「P3 后台配置改造：语义检索总门变量化 + MCP 令牌权限继承签发者」
`git show --shortstat` = 37 文件、+728/−266

| 条目 | 改了什么 | 落在哪个文件哪一段（取证） | 影响面 |
|---|---|---|---|
| 8（后端） | 总门权威顺序改为 `app_settings.search.enabled`（on/off/inherit）**>** env **>** 默认 off；删除 `searchGate.ts` 中 env=off 的短路；`queryAvailable` 只按 `effective` 判定 | `apps/api/src/domain/search/searchGate.ts:29-32`（`parseSearchEnabledOverride` 白名单，非法值按 inherit）、`:36-58`（`resolveSearchGate`，`:48 effective`、`:52 queryAvailable`）；`searchGateRuntime.ts`（新，21 行）`:19 isUnifiedSearchEnabled` | **后端**。涉及 `app_settings` 读（不写）。**需重启/重部署 API**（见 §四 遗留第 1 条：worker 仍按启动期 env 起） |
| 8（挂载） | `/api/v1/search` 与 `/api/v1/admin` 由启动期按 env **静态挂载**改为**恒挂载**，请求期由 `assertSearchGate` 判定；off 时仍落 404 且在任何 `search.db` 访问前短路；配置面（embedding config GET/PATCH、api-key）**不受总门约束**（否则 env=off 时后台开关成死结） | `apps/api/src/routes/v1/index.ts:67-76`（恒挂载 + 三条注释说明分工）、`:23-24`（import）；`adminSearch.ts:47`（`assertSearchGate` 定义）、`:80/:137/:220`（三处调用：运营/出网端点）；`search.ts`（+3） | **后端**。需重启/重部署 API |
| 8（前端） | 门控由 `ownerOnly` 放宽为持任一 `manage_*` 组织动作（与 `canSeeWorkspaceSettings` 同口径）；分区在 env=off 且未显式开启时给出「当前由环境变量关闭，可在上方开启」行；三态（启用/停用/跟随环境变量）热切换口径保留 | `apps/web/src/features/workspace/WorkspaceSettingsPage.tsx:54-56`（`search` 分区 `manageOnly: true` + 口径注释）、`:132-140`（可见性计算）；`features/search/EmbeddingAdminSections.tsx:14-17`（权威顺序注释）、`:29-33`（env=off 提示行）、`:41-50`（三态选项）；`search-admin-copy.ts:30/:40-51`（文案口径改为「界面已经能开，环境变量是另一种开法」）；`lib/nav-gate.ts:66-72`（`canSeeWorkspaceSettings`） | 前端 + 后端（口径需两端一致）。需重新构建前端 |
| 9（后端） | 令牌只做**认证 + 有效期**，能力一律按**签发者用户**实时计算：下线 `registry.ts` 的 scope 粗筛与 `record.tools.ts` 的 `allowedEntityTypes` 收窄两个消费点；`scopes` 字段**保留入库与响应**（老数据兼容，不迁移）；老客户端显式传仍校验格式；新令牌 `scopes` 缺省写全集 | `apps/api/src/mcp/tools/registry.ts:1`（文件头「能力按签发者用户实时计算」）、`:189-201`（注释 + `registerTools`，「P3 起不再用令牌自带的 scopes 粗筛」）；`mcp/tools/record.tools.ts:174-189`（注释 + 「不传 allowedEntityTypes」）；`mcp/pat/patService.ts:21-25`（scopes 仅作老数据兼容、不参与判定）、`:70-71`（缺省写全集）；`mcp/permissions/types.ts`（+4）、`mcp/tools/{catalog,types}.ts`、`mcp/transport/authenticate.ts`（+4）、`routes/v1/pats.ts`（+8）、`packages/shared-types/src/api.ts`（+10/−?） | **后端**。涉及既有令牌语义变更（**权限面放大，见 §四 遗留第 2 条**）。需重启/重部署 API |
| 9（前端） | 新建表单移除六位 scope 勾选区（保留有效期，不再提交 `scopes`）；列表权限列改为「权限跟随签发者账号」，不再渲染六位 scope 徽标；新增接入方式块，端点按 `location.origin + withBase("/mcp")` 动态生成 | `apps/web/src/features/settings/CreatePatForm.tsx:3-4`（注释）、`:42`（不再提交 scopes）；`PatListPanel.tsx:7`（注释）、`:36-39`（`mcpEndpoint()`）、`:79-82`（权限列只读说明）；`pat-labels.ts`（+23/−?）、`api/client.ts`（+8）、`WorkspaceSettingsPage.tsx`（+21） | 前端。无数据结构变更。需重新构建前端 |

### 追加（非计划条目）—— `9cdc85a`「chore(web): 清理第三批导航重构遗留死代码」
`git show --shortstat` = 1 文件、−35

| 条目 | 改了什么 | 落在哪个文件哪一段（取证） | 影响面 |
|---|---|---|---|
| — | 删 `menu-sections.ts` 的 `buildFlyoutRows` / `FlyoutRow` / `FLYOUT_MAX_DEPTH` 及文件头分工说明两行（第三批 L1 改由 `buildLibraryRows` 从 bases + knowledge_bases 摊平后已无调用方，Grep 全仓含 `*.test.*` 零引用后才删）；`nav-gate.ts` 的 `canSeeNavComposer` **未删**（仍是 `canSeeWorkspaceSettings` 的真实调用方，`nav-gate.test.ts` 有 4 条断言） | `apps/web/src/features/workspace/lib/menu-sections.ts`（−35）；`lib/nav-gate.ts:71`（`canSeeNavComposer` 仍在 `canSeeWorkspaceSettings` 内被调用） | 前端。无数据结构变更。需重新构建前端 |

---

## 二、逐条验证方式

> 覆盖 PLAN §一 总表全部条目：**P0 五条（⑤①②④a④b）+ P1 五条（5a/5b/5c/6/7）+ P2 七条（③/3a/3b/3c/1/2/4）+ P3 两条（8/9）= 19 条**。
> 每条 `前置 / 步骤 / 判定` 三行一组；有自动化测试的附「自动化覆盖」，只有人工步的标「覆盖率缺口」。

### P0

#### ⑤ 画布编辑时左侧列表跳回文档列表、画布选中态丢失

- **前置**：owner 账号；一个知识库（内含 ≥1 篇文档 + ≥1 张画布）；部署为前端新壳（`GX_ENTERPRISE_NAV` 生效，即 `GET /api/v1/workspaces/current/menu` 返 200）。
- **步骤**：L1 选中该知识库 → L2 停在「文档」tab → 点一张**画布**行进画布编辑器（URL 变 `/kb/:kbId/canvas/:docId`）→ 观察 L2。
- **判定**：（a）L2 顶部 tab 中「画布」为选中态，`[aria-selected="true"]` 在文档内**只有一处**且落在画布 tab 上；（b）该画布行仍在列表里且带 `aria-current="page"`；（c）再点其它文档行进 `/kb/:kbId/doc/:docId`，L2 自动回到「文档」tab。**失败**：L2 跳回文档 tab 或画布行不在列表里。
- **自动化覆盖**：`apps/web/src/features/workspace/secondary-nav-render.test.tsx::SecondaryNav：选中容器的子项（第三批语义）` → `画布路由下 L2 停在画布 tab：画布行在列表里且带当前项语义`、`文档路由下 L2 停在文档 tab：文档行在列表里且当前项有 aria-current`、`数据源拉全量后，画布子项不污染文档段的层级折叠`。
- **真机留证**：`docs/_archive/originals/acceptance-2026-09-19-p0-editor-canvas-recheck.md` 表格第 1–2 行 + 截图 `docs/acceptance/screenshots/editor-canvas-05-l2-canvas-tab.png`。
- **覆盖率缺口**：无（自动 + 真机双覆盖）。

#### ① 内容上/下无空行时无法插入

- **前置**：一篇 Markdown 文档，正文结构为「正文段落 / ```js 代码块 / 正文段落」，中间夹一个嵌入块（如文档内嵌画布），且嵌入块**上下都没有空段落**。
- **步骤**：打开该文档 → 把光标移到嵌入块上边缘 → 点击出现的插入热区 → 再在下边缘重复一次。
- **判定**：（a）嵌入块上下**都渲染**热区（DOM 中可查到两个热区节点，高度约 6px）；（b）用 `document.elementFromPoint(x, y)` 打在热区中心，命中的是热区自身而不是别的元素；（c）点击后块数 +1，新增的是**可输入空段落**（recheck 记载 3→4、4→5）。**失败**：热区不渲染，或渲染了但 `elementFromPoint` 命中不到。
- **自动化覆盖**：`apps/web/src/features/kb/wy-zones.test.ts::zoneFlags：嵌入块紧邻正文时两侧热区必须可命中（P0-①）` → `正文段落 ↔ 嵌入块：上下热区都在（这是缺陷现场）`；同文件 `needsEmptyPair`、`hasTypingRoom` 两组纯函数用例。
- **真机留证**：recheck 表格「①」三行 + `docs/acceptance/screenshots/editor-canvas-01-insert-zone.png`。
- **覆盖率缺口**：无。

#### ② 拖拽元素残影、连接线不实时跟随（②a 连线跟随 / ②b 预览残影）

- **前置**：一张画布，内有 ≥1 张「关联卡」（`GxLinkBlock`）且带连线；一篇文档内嵌该画布（用于验 ②b）。
- **步骤（②a）**：打开画布编辑器 → 按住一张关联卡拖动 → **松手前**观察连线 → 松手 → 按一次 Cmd/Ctrl+Z。
- **判定（②a）**：（a）拖拽中卡片带 `data-dragging="true"`；（b）拖拽中 plait 几何节点 `g[plait-data-id]` 与卡片 FO **同址**（recheck 记载 x 差 1px、位移 120px）；（c）松手落点与拖拽中一致，无回跳；（d）**一次** Cmd+Z 回到拖拽起点（证明整段拖拽只一个撤销批次）。**失败**：连线停在原位只松手时才跳，或撤销需要按多次。
- **步骤（②b）**：打开内嵌该画布的文档 → 在只读预览里做一次拖拽 → 检查残留。
- **判定（②b）**：预览区域内 `selection-rectangle` 类残留元素数 = **0**；滚轮缩放平移仍可用。**失败**：出现选区框/虚线框残留。
- **自动化覆盖**：②a → `apps/web/src/features/kb/canvas/link-drag.test.ts::syncLinkDragPoints：拖拽期写 plait + 单撤销批次` → `首帧开新批次，后续帧并入同一批次（一次拖拽 = 一个 undo 项）`、`只读板不写（预览里拖卡片不应改动源数据）`、`元素已被删除（findPath 抛错）时静默放弃，不让拖拽炸掉`；同文件 `translateLinkPoints`、`liveLinkBlock` 两组。②b → `apps/web/src/features/kb/canvas/board-guards.test.ts::installPreviewBoardGuards：只读预览一律短路板手势` → `pointerDown/Move/dblClick/键盘全部不再进入 plait（不给残留态留入口）`、`重复安装不会把守卫套两层（幂等）`。
- **真机留证**：recheck 表格「②a」「②b」各行 + `editor-canvas-02-drag-follow-during.png`、`editor-canvas-02-drag-after.png`、`editor-canvas-02b-preview-no-ghost.png`。
- **覆盖率缺口**：连线「视觉上真的跟着走」这一观感本身只能靠截图/几何断言间接证明；单测断言的是 plait 数据，不是像素。②b 的残影消失也只有真机断言（残留元素计数）。

#### ④a 嵌入编辑关闭的二次确认弹窗被编辑弹窗遮挡

- **前置**：一篇文档内嵌一张画布；在画布里改动内容使其变 dirty。
- **步骤**：打开画布编辑弹窗（`.gx-z-canvas-modal`）→ 改动内容 → 点关闭 → 出现二次确认弹窗。
- **判定**：（a）二次确认弹窗的计算样式 `z-index` = **860** 且 class 含 `gx-z-modal-nested`；（b）确认弹窗主按钮中心点 `document.elementFromPoint` 命中的是**该按钮本身**（可点，不是被盖住）；（c）点「放弃改动」后 `.gx-z-canvas-modal` 元素计数归 0。**失败**：主按钮命中到编辑弹窗层，或计数不归 0。
- **自动化覆盖**：`apps/web/src/components/modal-a11y.test.tsx::P3-a11y · 依赖 Modal 的阶段 3/4 调用点未被破坏` → `P0-④a：确认弹窗走 gx-z-modal-nested，且层级真的高于画布编辑弹窗`（`:239`，注释见 `:237`）；被测实现 `apps/web/src/components/ui.tsx:579/593-597/641`、`feedback.tsx:285`。
- **真机留证**：recheck 表格「④a」三行 + `editor-canvas-04a-confirm-above-modal.png`、`editor-canvas-04a-edit-modal-dirty.png`、`editor-canvas-04a-after-discard.png`。
- **覆盖率缺口**：「860 > 820 因此可见可点」的**层叠结果**没有单测直接断言，只有真机 `elementFromPoint`。

#### ④b 画布顶部工具条压住版本历史

- **前置**：一篇文档（或画布），有 ≥1 个历史版本。
- **步骤**：打开画布编辑器（顶部常驻工具条在位）→ 打开版本历史抽屉。
- **判定**：（a）抽屉根节点 `z-index` = **400** 且 class 含 `gx-z-drawer`（不再是裸 `z-50`）；（b）`抽屉.parentElement === document.body`（已 portal）；（c）在**与画布工具条重叠的区域**取一点做 `document.elementFromPoint`，命中的是抽屉内元素而不是工具条。**失败**：命中工具条，或抽屉 `parentElement` 不是 body。
- **自动化覆盖**：`apps/web/src/features/kb/version-history-layer.test.tsx::版本历史抽屉的层级（P0-④b）` → `渲染出来的是 gx-z-drawer 令牌，不是裸 z-50`、`gx-z-drawer 的层级高于画布 chrome（75）`、`portal 到 document.body，且源码里不再出现裸 z 数值`。
- **真机留证**：recheck 表格「④b」两行 + `editor-canvas-04b-version-history.png`。
- **覆盖率缺口**：无（自动 + 真机双覆盖）。

### P1

#### 5a 表改名 / 新建数据表 / 删除表

- **前置**：owner 账号（持 `canManageSchema`）；一个 base，内含 ≥1 张表。
- **步骤**：L1 选中该 base → L2 停在表列表 → 悬停某表行 → 点行尾三点菜单 → 依次验证「重命名」「删除表」；再点 L2 面板头的「+ 新建数据表」。
- **判定**：（a）菜单内六项齐全：重命名 / 编辑表单 / 复制表（含数据）/ 复制表（不含数据）/ 清空数据 / 删除表；（b）「重命名」弹窗提交后 L2 行名即时更新；（c）「删除表」走 L2 二次确认（标题「删除数据表「X」」、主按钮「删除数据表」），确认后 toast 带**撤销**，且**跳回库首页**（不停在已删表的死路由）；（d）「+ 新建数据表」在面板头渲染，无 `canManageSchema` 时**完全不渲染**（不是 disabled）。
- **自动化覆盖**：`apps/web/src/features/workspace/secondary-nav-lost-features.test.tsx::① 表行菜单：旧壳 Sidebar 失联的五项能力回挂 L2` → `五项菜单齐全，且复用既有 mutation（不复制实现）`、`清空走 L3『输入表名』、删除走 L2 软删 + 撤销，都是 feedback 的既有危险确认`、`有表结构权限：面板头出现新建入口、表行出现行菜单`、`无表结构权限：新建入口与行菜单都不渲染（不是 disabled 假装禁用）`。
- **覆盖率缺口**：「删表后跳回库首页」「重命名后行名即时更新」两条**只有人工步**，无单测（依赖真实 mutation + 路由跳转）。

#### 5b 可视化布局（表单设计器）

- **前置**：同上；目标表存在。
- **步骤**：L1 选中 base → L2 表行三点菜单 → 点「编辑表单」。
- **判定**：URL 变为 `/base/:baseId/table/:tableId?design=1`，页面进入表单设计态。**失败**：仍停在网格视图，或 404。
- **自动化覆盖**：无直接用例。`SecondaryNavTableOps.tsx:58-65` 的 `navigate(...?design=1)` 是被测实现；`secondary-nav-lost-features.test.tsx` 只断言「编辑表单」菜单项存在。
- **覆盖率缺口**：**大**。设计器本体是否被 `?design=1` 正确唤起，全靠人工点验，无自动化、无截图留证（`docs/acceptance/screenshots/` 下无 design 相关截图）。

#### 5c 复制表 / 清空数据 / 编辑表单

- **前置**：owner 账号；一个 base，内有表 A（含 ≥1 条记录）。
- **步骤（复制）**：表 A 行菜单 → 「复制表（含数据）」→ 观察 L2 列表；再试「复制表（不含数据）」。
- **判定（复制）**：列表**立刻**出现副本（这是 `a08d96d` 顺手修的 `["tables"]` 缓存洞——若副本不出现即该洞未修好）；含数据副本记录数 = A，不含数据副本记录数 = 0。
- **步骤（清空）**：副本行菜单 → 「清空数据」→ 输入表名确认。
- **判定（清空）**：记录清零并 toast「已清空数据，记录已移入回收站」；回收站（L2 底部 → `/base/:id/trash`）可见这些记录。
- **自动化覆盖**：`secondary-nav-lost-features.test.tsx::①` 组内的菜单齐全性 + 危险确认分级断言。
- **覆盖率缺口**：复制后的**缓存刷新**与清空后的**回收站可见性**是跨 mutation + 查询失效的集成行为，无单测，只有人工步。

#### 6 KB 拖拽文档到另一文档下成为下一级

- **前置**：owner/有创建权限的账号；一个知识库，内有文档 A、文档 B、画布 C。
- **步骤**：L1 选中该知识库 → L2 停在「文档」tab → 拖住 A 行 → 拖到 B 行上松手 → 再拖 A 到列表底部「拖到此处移到顶级」区松手。
- **判定**：（a）拖到 B 上后 A 变成 B 的子级（缩进 +1，B 行出现展开箭头）；（b）拖到根区后 A 回到顶级；（c）拖到**自己**或**自己的子树**上被拒绝（不成环）；（d）**画布 C 行不可拖**（无 draggable）；（e）无写权限时整块拖拽能力不渲染。**失败**：能把自己拖成自己的子孙（后端会造环）。
- **自动化覆盖**：`secondary-nav-lost-features.test.tsx::② KB 文档拖拽改层级（moveDoc 的 parentId）` → `走既有 useMoveDoc，且禁止拖到自己或自己的子树（防成环）`、`文档行可拖、画布行不可拖（画布不参与级联，不造后端没有的语义）`、`文档 tab 有「拖到此处移到顶级」根落区；无写权限时整块不渲染`。
- **覆盖率缺口**：拖放本身是 HTML5 DnD 事件，单测用合成事件覆盖不到真实浏览器拖放；**子级缩进是否真的渲染出来**需人工看。

#### 7 其余旧版入口（盘点清单）

- **前置**：不适用（本条为清单条目）。
- **步骤 / 判定**：不适用——逐条裁决见本报告 **§三**，那里每行给「恢复 / 不恢复 / 未丢失」与理由、落地 commit。
- **自动化覆盖**：不适用。
- **覆盖率缺口**：§三 中「未丢失」「不恢复」两类条目无自动化断言兜底，依赖人工确认现状。

### P2

#### ③ 循环嵌套：文档↔画布互嵌 + 版本历史预览

- **前置**：一个知识库；准备三组数据：文档 A 内嵌画布 B（正常一层）；画布 B 内嵌文档 A、文档 A 内嵌画布 B（互嵌成环）；A→B→C→D 四层链（A 嵌 B、B 嵌 C、C 嵌 D）与五层链。
- **步骤**：分别打开上述文档/画布。
- **判定**：（a）正常一层：画布正常渲染（不是链接卡）；（b）互嵌：第二/三层出现**降级链接卡**（图标 + 标题 +「点击打开」），页面不再无限展开、不卡死；（c）第 3 层（`MAX_EMBED_DEPTH`）仍放行渲染，第 4 层降级为 `kind=depth` 的卡；（d）打开文档 A 的**版本历史**并预览某个快照，快照里的互嵌同样被降级，不无限递归。**失败**：页面卡死/栈溢出/出现多层嵌套画布。
- **自动化覆盖**：`apps/web/src/features/kb/__tests__/embed-nest-guard.test.tsx` → `planEmbed：环检测优先于深度限制`（`自嵌（画布嵌回宿主自己）即成环，与层数无关`、`A 嵌 B、B 再嵌 A：第三层判环降级`、`正常多层仍能渲染：第 3 层放行`、`第 4 层：超限降级`、`判定不改入参（每次派生都换新集合），根链保持空`）；`enhanceCanvasEmbeds：按 planEmbed 的结果决定挂载什么`（放行/成环/超限/多处占位逐个判定）；`降级卡形态：图标 + 标题 + 跳转按钮`（`超限卡带「点击打开」按钮，走的是目标画布地址`、`环降级卡给出循环文案；无 kbId/无跳转回调时不出按钮（公开分享页不假装能跳）`）。
- **覆盖率缺口**：**版本历史预览**纳入链这一路（`VersionHistoryDrawer.tsx:107`）在 `embed-nest-guard.test.tsx` 中未见对应用例（该文件 206 行全部围绕 `planEmbed` / `enhanceCanvasEmbeds` / 降级卡），**只有人工步**。另外「独立 root 缺 Router context」那个顺手修的崩溃（`MemoryRouter` + `NavBridge`）未见专门用例。

#### 3a 权限管理并入工作区设置

- **前置**：owner 账号（持 `manage_share` 或 `authzManage`）；另备一个**非 owner 且无 manage 动作**的账号做反向验证。
- **步骤**：owner 登录 → 看 L1 底栏 → 进工作区设置 → 看左二级分区；再换非 owner 账号重复。
- **判定**：（a）L1 底栏**只剩两项**（通讯录、工作区设置），「权限管理」不在底栏；（b）设置页左二级出现「权限管理」分区（icon: shield），点进去是内嵌 `PermPanel`（**不重复一个大标题**）；（c）直访 `/workspace/authz` 仍**可达**（不 404）；（d）非 owner 账号左二级**不出现**这两个分区（连 disabled 入口也没有），直戳 `/settings/authz` 回落通用分区而不是空白或穿透到 general。
- **自动化覆盖**：`apps/web/src/features/workspace/__tests__/workspace-settings-p2b.test.tsx::B1：底部区只剩两项，但路由仍可达` → `App 仍注册 /workspace/authz → PermPanel（删导航入口≠删页面）`、`设置页左二级新增「权限管理」分区，图标沿用 shield`；`B3：非 owner / 无能力不渲染，不出 disabled 假入口` → 5 条（含 `非 owner：左二级不出现这两个分区`、`非 owner 直戳 /settings/contacts 与 /settings/authz 都回落通用`、`owner 但无任一授权动作且/authzManage 时：权限分区不出，通讯录仍在`、`内嵌 PermPanel 走 embedded`）；`lib/nav-gate.test.ts`（+15）。
- **覆盖率缺口**：无（反向用例齐全）。

#### 3b 通讯录直接展示列表

- **前置**：owner 账号；组织内有 ≥1 个部门、≥1 名成员。
- **步骤**：进工作区设置 → 点「通讯录」分区 → 观察；再直访 `/workspace/contacts` 页面对比。
- **判定**：（a）设置页通讯录分区**直接内嵌成员列表**（部门树 / 成员 / 角色都在），不再是「说明 + 跳转按钮」；（b）旧的「打开通讯录」按钮与「这里只做入口」文案已删除；（c）`/workspace/contacts` 页面与设置页内嵌的是**同一个组件**（`ContactsDirectory`），两处结构一致；（d）反复切换设置页分区多次后，`window` 的 `resize` 监听**不泄漏**（成对注销）；（e）非 owner 不出现该分区。
- **自动化覆盖**：`workspace-settings-p2b.test.tsx::B2：通讯录分区是真的列表，不再是跳转按钮` → `直戳 /settings/contacts 渲染内嵌的 ContactsDirectory`、`旧的「打开通讯录」按钮与「这里只做入口」文案已删除`、`/workspace/contacts 页面壳只做路由占位，主体与设置页是同一个组件`、`抽出后 window resize 监听仍然成对（注销在同一个 effect 的 cleanup 里）`。
- **覆盖率缺口**：真实成员数据渲染（部门树层级、角色列）无单测，只有人工步。

#### 3c 二级菜单顶部返回按钮

- **前置**：无（本条判定为「从未存在，无需修复」）。
- **步骤**：L1 选中任一容器 → 观察 L2 面板头。
- **判定**：面板头只有「图标 + 名称 + 收起」，**没有返回按钮**——这是既有设计，不是缺陷。若产品上确实需要返回按钮，应作为**新需求**另立条目，不计入本轮缺陷。
- **自动化覆盖**：无（无需修复，故无对应用例）。`SecondaryNav.tsx:175-195` 为现状证据。
- **覆盖率缺口**：不适用。该判定来自 PLAN §一，**未经主理人二次确认**，见 §四 遗留第 4 条。

#### 1 新建文档/画布按钮移入 L2 按当前选项卡

- **前置**：有创建权限的账号；一个知识库。另备一个 **viewer** 账号做反向验证。
- **步骤**：L1 选中知识库 → L2 「文档」tab → 看选项卡行右侧 → 切到「画布」tab 再看。
- **判定**：（a）文档 tab 出「新建文档」，画布 tab 出「新建画布」，**互斥**（不会同时出现两个）；（b）点它建的实体类型与当前 tab 一致；（c）`KbHomePage`（`/kb/:kbId`）里的原入口**已下线**（同一能力不留两处）；（d）viewer 账号下该入口**不渲染**。
- **自动化覆盖**：`secondary-nav-lost-features.test.tsx::③ KB 新建文档 / 画布：按当前选项卡建对类型` → `文档 tab 出「新建文档」、画布 tab 出「新建画布」，二者互斥`、`无创建权限（viewer）时不渲染新建入口`、`KbHomePage 的原入口已下线（同一能力不留两处）`。
- **覆盖率缺口**：「点击后真的建成对类型」是 mutation 行为，无单测。

#### 2 导入导出移到表详情页搜索框右侧

- **前置**：owner/有写权限账号；一个 base 内一张有数据的表；浏览器窗口宽 ≥768 与 <768 各测一次。
- **步骤**：打开该表的**网格**视图 → 看顶部工具栏。
- **判定**：（a）**搜索框右侧**常驻「导入」「导出」两个按钮（不是左侧，也不是藏在「更多」菜单里）；（b）「更多」菜单里**没有**重复项；（c）视口压到 <768 时，被压缩的是搜索框那个 `flex-1` 容器，两个按钮**本身不换行、不断行、不挤掉其它按钮**；（d）点「导出」能出 `ExportDialog`，点「导入」能出 `ImportWizard`，与 L2 表级操作行是同一套组件。
- **自动化覆盖**：`apps/web/src/features/grid/grid-toolbar-narrow.test.tsx`（`a08d96d` +21、`d562075` +10）：顺序断言已由「导入/导出在搜索框之前」翻转为「**在搜索框之后**」；`secondary-nav-lost-features.test.tsx::④ 导入 / 导出收敛：只有网格工具栏一处入口` → `工具栏常驻「导入 / 导出」，「更多」菜单不再重复`、`向导复用不重写：执行侧在 GridView，L2 操作行不再挂向导`。
- **覆盖率缺口**：<768 窄屏下的**视觉不换行/不断行**只能靠人工看（单测断言的是 DOM 顺序，不是布局）。另外 `d562075` 未记载跑测数字，该项复验数为 **【未实测】**。

#### 4 回收站改 L2 底部入口、进入即展示当前容器

- **前置**：一个 base（有 ≥1 条已删记录）与一个知识库（有 ≥1 个已删文档）。
- **步骤**：L1 选中该 base → L2 滚到列表末尾 → 点回收站行；换成知识库再点一次。
- **判定**：（a）L2 列表末尾有回收站行，带 `data-l2-trash` 属性（值为 `base` 或 `kb`）；（b）base 下跳转 URL = `/base/:id/trash`，kb 下 = `/kb/:id/trash`；（c）进入后**直接展示当前容器的回收内容**（不需要再选一次容器）；（d）两页路由都真实存在，不是死链。
- **自动化覆盖**：`secondary-nav-lost-features.test.tsx::⑤ 回收站入口：按当前容器直跳` → `base 容器跳 /base/:id/trash，kb 容器跳 /kb/:id/trash`、`列表末尾渲染回收站行，data 属性带容器类型（两种容器都能断言）`、`两页路由都已存在（不是死链）`。
- **覆盖率缺口**：「进入即展示当前容器内容」依赖路由参数与列表查询的配合，无单测，只有人工步。

### P3

#### 8 语义检索「硬编码」

- **前置**：能改服务端环境变量与重启 API 的权限；一个 owner 或持任一 `manage_*` 组织动作的管理员账号（用于验门控放宽）；部署上先把 `GX_M5_SEARCH` 设为 **off**。
- **步骤**：（a）env=off 时进「工作区设置 → 语义检索」分区，把总门覆盖值由「跟随环境变量」改为「**启用**」→ 调 `GET /api/v1/search?...` → 再改回「停用」→ 再调一次；（b）把覆盖值设回「跟随环境变量」、env 分别设 off / on，各调一次；（c）换一个**非 owner 但持 manage_* 动作**的账号登录，看能否看到该分区；（d）再换一个 viewer 账号，看是否看不到。
- **判定**：（a）env=off + 覆盖=启用 → 检索接口返 **200**（旧实现这里直接 404）；覆盖=停用 → **404**，且接口在访问任何 `search.db` 之前就短路；（b）覆盖=inherit 时完全跟随 env（env=off→404、env=on→200）；（c）配置面端点（embedding config GET/PATCH、api-key）**不受总门约束**，env=off 时仍能读写（否则开关成死结）；（d）持 manage_* 的管理员**可见**该分区（旧口径 ownerOnly 会把他们挡在外面），viewer **不可见**；（e）分区在 env=off 且未显式开启时显示「当前由环境变量关闭，可在上方将覆盖值设为「启用」打开」。
- **自动化覆盖**：`apps/api/src/domain/search/__tests__/search-gate-matrix.test.ts::总门判定矩阵（db 覆盖 × env）` → override × env **九格**参数化用例、`env 未设置 ≡ off：inherit 时目标态 off，显式 on 仍可打开`、`核心回归：env=off 时后台置 on 必须压过 env（旧实现曾直接短路回 off）`、`覆盖值解析：仅精确小写 on/off 生效，其余一律 inherit（不报错）`；路由侧 `apps/api/src/routes/v1/__tests__/m5-search-gate.test.ts`（+79）；`apps/web/src/features/search/EmbeddingAdminSections.test.tsx`（新，53 行）；`WorkspaceSettingsSectionGating.test.tsx`（+14，门控放宽）；`search-m5.test.ts`、`embedding-remote-config.test.ts` 同步。
- **真机留证**：commit message 记载「真机 env=off 下 inherit→检索 404、置 on→200 已截图留证」（截图文件名未在 commit 中给出，**【未实测】** 具体文件名）。
- **覆盖率缺口**：**索引 worker 仍需重启应用**才会按新的总门状态运行（见 §四 遗留第 1 条）——「开关打开了但索引不跑」这一半没有自动化断言，也没有人工复验记录。

#### 9 MCP 令牌权限

- **前置**：owner 账号；MCP 服务端可达；一个已存在的 PAT（含 P3 之前创建的、只勾了窄 scope 的老令牌）。
- **步骤**：进「工作区设置 → MCP」分区 → 点新建令牌 → 观察表单 → 创建 → 看列表权限列与顶部接入方式块 → 用令牌连一次 MCP 调一个写工具。
- **判定**：（a）新建表单**没有**六位 scope 勾选区，只有名称与有效期；（b）列表权限列显示「权限跟随签发者账号」，**不再渲染**六位 scope 徽标；（c）顶部接入方式块的端点 = `location.origin + /mcp`（带 basePath 时自动拼接），复制下来能连上；（d）用一个**签发者本人有写权限**的令牌调写工具 → 成功；换一个**签发者本人无写权限**的账号签发的令牌调同一工具 → 被拒（证明能力确实按签发者实时算，而不是按 token 上的 scope）；（e）令牌过期/撤销后调用被拒（有效期仍在生效）。
- **自动化覆盖**：`apps/web/src/features/settings/PatListPanel.test.tsx`（+57/−?）、`pat-labels.test.ts`（+20/−?）；api 侧 `apps/api/src/mcp/tools/__tests__/m6-p0a-search-scope.test.ts`（+86/−?）、`registry-gate.test.ts`（+25）、`mcp/transport/__tests__/m6-s3-gate.test.ts`、`m6-s4-read-tools.test.ts`、`m6-s4-write-tools.test.ts`、`m6-s6-canvas-read.test.ts`、`m6-s7-audit-idempotency.test.ts`（同步改写）。
- **覆盖率缺口**：「老窄 scope 令牌现在获得签发者全部能力」这一**权限放大副作用**没有任何用例或告警（见 §四 遗留第 2 条）。

---

## 三、丢失入口排查报告

> 底稿：PLAN §一 P1 第 7 条「旧版有、新版不可达的完整盘点」。
> 裁决口径：① **已恢复** = 能力在新壳重新有入口（注明落地 commit）；② **不恢复** = 属导航编排有意下线或从未存在；
> ③ **未丢失** = 入口在新壳其它位置仍在，本就不需要恢复；④ **未恢复（待决策）** = 确实丢了且查不到落地。

| # | 旧版入口 | 旧位置（PLAN 取证） | 裁决 | 理由 / 新位置（取证） | 落地 commit |
|---|---|---|---|---|---|
| 1 | 表 · 重命名 | `Sidebar.tsx` 行菜单 :190-204 | **已恢复**（迁到 L2 表行菜单） | `SecondaryNavTableOps.tsx:138` 菜单项「重命名」 → `:80 renameTable` | `a08d96d` |
| 2 | 表 · 编辑表单（可视化布局） | `Sidebar.tsx` / `DetailView.tsx:149-156` 齿轮菜单 | **已恢复**（迁到 L2 表行菜单） | `SecondaryNavTableOps.tsx:141` → `:65 navigate('/base/:baseId/table/:tableId?design=1')` | `a08d96d` |
| 3 | 表 · 复制表（含数据） | `Sidebar.tsx` | **已恢复**（迁到 L2） | `SecondaryNavTableOps.tsx:145` → `:88 duplicateTable(id, true)` | `a08d96d` |
| 4 | 表 · 复制表（不含数据） | `Sidebar.tsx` | **已恢复**（迁到 L2） | `SecondaryNavTableOps.tsx:146` → `:88 duplicateTable(id, false)` | `a08d96d` |
| 5 | 表 · 清空数据 | `Sidebar.tsx` / `TopBar.tsx:166` | **已恢复**（迁到 L2） | `SecondaryNavTableOps.tsx:147` → `:96 clearTable`（L3 输表名） | `a08d96d` |
| 6 | 表 · 删除表 | `Sidebar.tsx` / `TopBar.tsx:167` | **已恢复**（迁到 L2） | `SecondaryNavTableOps.tsx:148` → `:107-131 deleteTable`（L2 软删 + 撤销 toast + 跳回库首页）。旧壳 `TopBar.tsx:167` 入口**仍在**，但只作为 `GX_ENTERPRISE_NAV=off` 回退壳（`ShellGate.tsx:26`）存在 | `a08d96d` |
| 7 | 表 · 图标颜色 | `Sidebar.tsx` 重命名弹窗（`:318/:324`） | **已恢复**（迁到网格工具栏最左侧） | `GridView.tsx:569` `<EntityIconPicker ariaLabel="数据表图标与颜色" />`，无 `canManageSchema` 不渲染。**注意未在本轮四批内落地**，早于此轮 | `32c3c6e`（本轮四批之前；`git log -S "数据表图标与颜色"` 取证） |
| 8 | 表 · 「+ 新建数据表」 | `Sidebar.tsx:50/62/97` | **已恢复**（迁到 L2 面板头） | `SecondaryNavTableOps.tsx:33`「面板头入口：新建数据表」；渲染 `SecondaryNav.tsx:252-278`（`tableOps.panelNode`） | `a08d96d` |
| 9 | KB · 文档拖拽改层级 | `KbTree.tsx:72-73/225-233`（`moveDoc({parentId})`） | **已恢复**（迁到 L2 文档行 draggable） | `SecondaryNavKbOps.tsx:95-102`（`useMoveDoc` + 成环拦截）；接线 `SecondaryNav.tsx:336` | `a08d96d` |
| 10 | KB · 文档重命名 | `KbTree.tsx` | **未丢失**（无需恢复） | 新壳 `/kb/:kbId`（`App.tsx:178` 注册，新旧壳共用同一组内容路由）→ `KbHomePage.tsx:227` 行菜单「重命名」仍在 | —（无需落地） |
| 11 | KB · 文档删除 | `KbTree.tsx` | **未丢失**（无需恢复） | 同上，`KbHomePage.tsx:103-116`（`confirmSoftDelete` + 撤销 toast）仍在 | —（无需落地） |
| 12 | KB · 库切换器与知识库新建 | `KbSidebar.tsx` | **未丢失**（已被 L1 覆盖） | PLAN §一 P1 已注明「被 L1 的 `NavLibraryBlock` 覆盖，不丢」；新壳另有 `LibrarySwitcher.tsx:121` | —（无需落地） |
| 13 | 导航编排 `NavComposer` | 第三批 `720e09c` 删 | **不恢复**（导航编排下线） | 主理人既定裁决，属有意下线非丢失 | —（无需落地） |
| 14 | 三视角（全部 / 未收纳 / 已收纳） | 第三批 `720e09c` 删 | **不恢复**（导航编排下线） | 同上 | —（无需落地） |
| 15 | 「收纳到导航」 | 第三批 `720e09c` 删 | **不恢复**（导航编排下线） | 同上 | —（无需落地） |
| 16 | 「移动到分组…」 | 第三批 `720e09c` 删 | **不恢复**（导航编排下线） | 同上 | —（无需落地） |
| 17 | `/workspace/settings/nav` 路由 | 第三批 `720e09c` 删 | **不恢复**（导航编排下线） | 同上；`nav-gate.ts:86` 落 default `return false`（未知入口不猜、不兜底放行） | —（无需落地） |
| 18 | FooterNav 第四项 | 第三批 `720e09c` 删 | **不恢复**（导航编排下线） | 同上；`nav-footer.ts:25-26` 现为两项 | 第三项迁出见 `5e97def`；第四项无恢复动作 |
| 19 | KB · 图标颜色 | `KbTree.tsx:494`（`EntityIconPicker`） | **未丢失**（无需恢复） | `/kb/:kbId/settings`（`App.tsx:182` 注册）→ `KbSettingsPage.tsx:117` 的 `EntityIconPicker` 仍在 | —（无需落地） |

**裁决计数**：已恢复 **9** 条（#1–#9，其中 #7 落地于本轮四批之外的 `32c3c6e`）；不恢复 **6** 条（#13–#18）；
未丢失/无需恢复 **4** 条（#10、#11、#12、#19）；**未恢复（待决策）0 条**。

**关于「0 条未恢复」的说明**：这不是粉饰——盘点清单里所有条目要么能在 `a08d96d`（及 `#7` 的 `32c3c6e`）中找到落地，
要么本来就在新壳其它位置仍可达（`KbHomePage` / `KbSettingsPage` / L1 库切换器），要么属主理人已定裁决的编排下线。
但请注意两点保留意见，已列入 §四：**#7 的落地 commit 不在本轮四批内**（早于此轮，本轮无人为此负责），
且 **#10/#11 的「未丢失」依据是 `KbHomePage` 行菜单仍在**——若后续 `KbHomePage` 被新壳取代，这两条会重新变成丢失条目。

---

## 四、遗留与未闭环

> 本节只写**证据确凿**的问题，不做美化。凡属「修了一半」「有副作用」「口径不一致」的一律列入。

### 1. 第 8 条（语义检索总门）只修了一半：索引 worker 仍需重启

- 现象：后台把总门从「跟随环境变量」改为「启用」后，检索接口**立刻**可用（这是修好的一半），
  但**索引 worker 不会自动开始运行**，语义检索会出现「开关开了但没索引数据」的状态，必须重启应用。
- 证据：`apps/web/src/features/search/EmbeddingAdminSections.tsx:32-33` 明写
  「……检索接口现在可用；**索引 worker 仍需重启应用后才会运行**」；
  `apps/api/src/domain/search/searchGate.ts:54` 注释「worker 只在启动期按 env 起（`index.ts bootSearchWorker`），
  覆盖值对它**恒需重启**」。
- 影响：主理人的原始诉求是「语义检索不要硬编码、要能在后台配」。现在**接口层**可配了，**索引层**没配成。
- 未闭环点：既没有把 worker 改为按覆盖值动态起停，也没有在界面上给出「需重启」的强制提示（只有一行说明文字）。
- 建议决策：要么让 worker 随覆盖值热起停，要么在分区里把「需重启应用」做成显式的操作指引（而不仅仅是一行小字）。

### 2. 第 9 条（MCP 令牌）的副作用：存量窄 scope 令牌权限被放大

- 现象：P3 之前创建的 PAT，如果当时只勾了部分 scope（例如只读），现在这些 scope **不再参与任何鉴权判定**，
  令牌实际能力变成「签发者本人的全部能力」——即**老令牌的权限被静默放大**。
- 证据：
  - `apps/api/src/mcp/tools/registry.ts:199-201`「P3 起不再用令牌自带的 scopes 粗筛（能力按签发者用户实时计算）」；
  - `apps/api/src/mcp/tools/record.tools.ts:189`「不传 `allowedEntityTypes`：不做令牌级收窄」；
  - `apps/api/src/mcp/pat/patService.ts:21-25`「仅作老数据兼容，**不参与任何鉴权判定**」、`:70-71` 新令牌缺省写全集；
  - commit message 明写「scopes 字段保留入库与响应（**老数据兼容，不迁移**）」——即**没有**对存量窄 scope 令牌做任何收紧、失效或告知。
- 影响：安全面。任何历史「最小权限」令牌现在都等价于签发者本人。列表页 `PatListPanel.tsx:79-82` 只写「权限跟随签发者账号」，
  **不提示**持有老窄 scope 令牌的用户其权限已被放大。
- 未闭环点：无迁移、无告警、无一次性失效开关。
- 建议决策：至少应对存量窄 scope 令牌做一次显式提示或强制轮换；若接受「令牌即本人」的口径，应在文档中明写这是有意的安全模型变更。

### 3. 第 2 条（导入导出位置）经两轮才落到位，且第二轮无复验数字

- 现象：`a08d96d` 把「导入 / 导出」放在搜索框**左侧**；主理人实测后要求**右侧**，`d562075` 才翻转。
  即第二批交付时未核对 PLAN §一 第 2 条原文「移到表详情页**搜索框右侧**」。
- 证据：`GridToolbar.tsx:408-413` 最终位置在 `ListSearchBox` 之后；`grid-toolbar-narrow.test.tsx` 的断言在 `d562075` 中
  由「在搜索框之前」翻转为「在搜索框之后」（commit message 与用例名/注释均注明）。
- 影响：已修复，但属实施与计划口径不一致的过程缺陷；且 `d562075` 的 commit message **未记载**测试通过数，
  本报告中该批复验数字记为 **【未实测】**。
- 建议：补跑一次 web 单测并回填数字。

### 4. 第 3c 条判定「从未存在，无需修复」未经主理人二次确认

- 现象：PLAN §一 P2 表 3c 行判定「二级菜单顶部返回按钮**从未存在，无需修复**」，本轮四个批次**均无对应改动**，也无测试。
- 证据：`SecondaryNav.tsx:175-195` 面板头只有「图标 + 名称 + 收起」，确无返回按钮；`5e97def` 的 commit message 亦明写「3c 判定为『从未存在』，无对应改动」。
- 未闭环点：这是**单方面判定**，不是主理人确认。主理人原话里的「返回按钮」诉求是否已被正确理解，没有回填确认。
- 建议决策：找主理人确认一次；若确需返回按钮，应作为**新需求**另立条目，不要混进本轮缺陷清单。

### 5. 本轮文档的取证边界（诚实声明，非缺陷）

- 本报告**未独立复跑**任何测试套件（`pnpm test` / `pnpm typecheck` / lint）。
  所有测试数（web 665/54 → 681/55 → 706/57 → 715/58、api 2243/209 → 2260/212、typecheck 七包 Done、lint 0 err/114 warn）
  **均引自 commit message 与 `docs/_archive/originals/acceptance-2026-09-19-p0-editor-canvas-recheck.md` §二**，未现场验证。
- 批次三「顺手修独立 root 缺 Router context」一处已在 `enhanceEmbeds.ts:10/15/25/28/62/117-119` 取证到位（§一 已补行号）。
- 批次四真机截图（commit message 记载「env=off 下 inherit→404、置 on→200 已截图留证」）
  **未给出文件名**，故 §二 第 8 条的相关标注为 **【未实测】**。
- 写作时 HEAD = `9cdc85a`，期间仓库仍在被其它 worker 推进（`d562075`、`9cdc85a` 即为写作过程中新增），
  若后续再有提交，本报告的 hash 与行数需同步复核。
