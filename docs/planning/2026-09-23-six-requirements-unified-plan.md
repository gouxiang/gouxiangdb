# 六项需求统一实施方案（v1.1，已定稿）

- 日期：2026-09-23
- 版本基线：方案定稿时 HEAD fafe09c（P0 三线索已提交），根 `package.json` = 0.1.7，数据库迁移 36 枚
- 调研方式：6 路并行只读盘点（响应式 / 权限 / 视图 / 新视图 / 语义检索 / MCP），关键结论已由团队负责人读生产代码复核
- 文档状态：**戴总已拍板，进入开发**。
  - 拍板 A：**方案二**——上线前把 M4 新权限引擎彻底做完、把当前已配权限完整搬进新引擎，双轨对拍零差异后才通电切换，并始终保留一键回退（不取 A1）。
  - 拍板 B：MCP 补搭建类工具，分两步（先表/字段/视图/文档/画布，建库/建 KB 第二步）。
  - 拍板 C：新建 `view_user_prefs` 表承载用户个性化，让"每人独立"名副其实。

---

## 1. 给戴总的一页纸（先看这里）

### 这次要做的六件事
1. **响应式布局**：窗口缩小时二级菜单（数据表 / 文档·画布）不再"凭空消失"，有明确的收起/展开按钮；全站其他页面在小窗口下也不出现消失、遮挡、点不动。
2. **表级管理权限**：在"能不能增删改数据"之外，单独给一套"能不能管理这张表"的权限——重命名、删除、进表单设计器改字段、控制哪些行可见。两类权限各管各的、分开配、分开生效。
3. **视图管理员配置**：画廊可指定附件字段当封面；管理员可限定可展示字段及顺序；可按条件/按用户过滤，让不同人看同一视图看到不同数据。和"用户自己的个性化显示/排序"严格分开、互不冲突；无权字段绝不能看到。
4. **两种新视图**：层级视图（同表自引用关联，树状展示）、甘特图（起止时间、进度、依赖关系），且都具备第 3 项的全部管理配置。
5. **语义检索全量 E2E**：用豆包 `doubao-embedding-vision` 跑通"配置→建索引→检索召回"，修复全部问题。
6. **MCP 全功能测试**：测通通过 MCP 搭表单、建视图、管数据、建文档、建画布及各类改动，修复全部 Bug。

### 三件事已拍板（详见 §2）
- **拍板 A｜权限走方案二（已定）**：把当前已配好的权限完整、准确地搬进 M4 新引擎，补齐表级管理权和可见行控制，双轨对拍到零差异，才通电切换；手里始终攥着一键回退。
- **拍板 B｜MCP 补"搭建类"工具（已定）**：分两步——先补建表/字段/视图/文档/画布，建库工具放第二步。
- **拍板 C｜"每人独立视图"做成真的（已定）**：新建"用户个性化"表，让它名副其实，同时承载第 3 项的"用户个性化显示/排序"。

### 建议的总顺序（六件事互相咬合，不能乱序）
打地基 → 表级权限 + 视图管理员配置 → 两种新视图 → 语义检索 → MCP 工具与全量测试 → 全量回归与部署。详见 §4。

---

## 2. 三个拍板项的细节

### 拍板 A：权限引擎路线（已定：方案二——彻底做完并切 M4）
**现状（证据，团队负责人逐行读码确认）**
- 真正生效（当前唯一通电挡门）：`apps/api/src/domain/authz/libraryPolicy.ts:213` `resolveBaseAccess()`，读 **`role_library_scope`** 表，按"角色 × 库 × 表 × 字段"放行；全部业务路由走这一轨。戴总和管理员现在配的所有权限都在这里。该轨 `TableAccess`（`roleLibraryScope.ts:30`）只有 read/create/update/delete 四个"数据位"，没有"管理位"。
- 第一代旧表（已退为登记本，不再放行）：`member` / `kb_member` / `kb_doc_acls` 三表。注释明确新权限模型后不再参与放行（`bases.ts:184`），但仍有写入（建库 owner 行、policyAdminTx 反写）。
- 新引擎 M4：`apps/api/src/domain/authz/engine.ts:82`，读 `auth_policies` + `nav_nodes`，纯 allow，conditions 恒 null（无行级求值）；被 `GX_AUTHZ_ENGINE` 门控默认 off，且 `AUTHZ_ENFORCE_READY=false`（`configAuthz.ts:17`），即使 on 也先降级 shadow。
- **★ 决定走方案二后必须先处理的头号风险（读码证实）**：M4 的 `auth_policies` 数据投影源现在接的是**第一代旧三表**（`backfill.ts` / `projection.ts` 把 member/kbMember/kbDocAcl 投影成 `legacy:*` 策略），**完全没接第二代 `role_library_scope`**。若直接掰 on，引擎认的是老权限、不是戴总现在配好的这套，已界定的权限会错乱。因此第一步必须把 `role_library_scope` 完整、准确投影/双写进 `auth_policies`，替换/补齐现有 `legacy:*` 投影口径。
- 动作词汇：M4 有 7 个资源动作（`packages/shared-types/src/authz.ts:11`），其中已有"改结构"位 `manage_schema`，但与"库管理权 canManage"绑死（`guards.ts:70`）。表级管理位需在引擎侧独立建模，不能再绑 canManage。
- 改名/删表/改字段当前都用 `requireCanManageSchema`：`routes/tables.ts:262,299`、`routes/fields.ts:104,174,238`。
- **"可见行控制"目前没有写入口**：`auth_policies.conditions` 被 M4 明确禁写（`reconcile.ts:164`）。需在引擎侧补行级条件的写入与求值（当前 conditions 恒 null，`engine.ts:79`）。

**方案二的四步落地（顺序不可乱，全程不破坏当前生效轨）**
1. **接对管子**：把 `role_library_scope` 当前全部配置（角色 × 库 × 表 × 字段，含 canManage/canShare 等库级位）完整、准确投影成 `auth_policies`；写路径（PUT library-scopes 等）同事务双写到新投影，保证两套永远同步。第一代 `legacy:*` 投影保留但不与第二代冲突。
2. **补缺**：在引擎/契约侧独立补"表级管理位"（重命名/删除/进设计器/可见行，与数据 CRUD 分离）和"可见行"条件的写入口与求值；四条写路径改用能同时被新旧两轨理解的校验。
3. **对答案**：开 shadow 双轨对拍（`shadow.ts` 已有 DRIFT_OVERDENY/OVERALLOW 分类），在真实库和规模夹具上跑到**零差异**（OVERALLOW 零容忍、OVERDENY 清零）；翻 `AUTHZ_ENFORCE_READY` 前先满足全部就绪条件。
4. **通电 + 留退路**：翻门让 M4 真拦；以配置开关保留"一键切回 `role_library_scope` 旧轨"，并完成回滚演练计时。回退开关在观察期内不拆除。

### 拍板 B：MCP 搭建类工具范围
**现状（证据）**：MCP 共 15 个工具（`apps/api/src/mcp/tools/catalog.ts`），全部围绕"已存在的 base/table/doc/canvas"读和增量写。
- 缺失：建库、建表、建字段、**建视图**、建知识库、建文档本体、建画布本体——都没有。
- 画布改动极弱：`canvas.commit_elements` 只支持"末尾加矩形"（`canvasWrite.tools.ts:40`），改/删/移动/连线/箭头/关联块一律 `UNSUPPORTED_OPERATION`。
- 远端测试：stdio 读本地 SQLite、**无法指向远端**；打飞牛/预览机只能走 HTTP `POST /mcp` + 目标实例签发的 PAT（`mcp/transport/mcpApp.ts:77`）。

**建议（分两步）**
- 第一步：补 `table.create/update/delete`、`field.create/update/delete`、`view.create/update/delete`、`doc.create`、`canvas.create`；扩 `canvas.commit_elements` 支持 update/move/delete/connect 与箭头。
- 第二步：补 `base.create`、`kb.create`（搭建链路起点）。
- 理由：MCP 工具是对后端领域服务的薄封装，必须等第 2/3/4 项的后端权限与配置定稿后再包，否则会包进旧口径、返工。

### 拍板 C：用户个性化存储
**现状（证据）**
- 六类视图共用一份 `views.config`（单 JSON、全员共享，`packages/shared-types/src/views.ts:95-139`），**没有任何 per-user 存储**；`lockMode:"personal"` 文案写"每人独立配置"，后端注释自陈其实全成员共享（`routes/views.ts:155-157`）——名实不符。
- 字段顺序 `fieldOrder`、画廊封面 `coverFieldId` 等键后端会读，但前端零写入入口。
- localStorage 目前只存抽屉宽度、L1/L2 折叠等，不存视图字段显示/排序。

**建议**：新增表 `view_user_prefs(viewId, userId, prefs JSON)` 带唯一约束（见 §6），承载每用户每视图的字段二次显隐、个人排序、列宽、搜索词、分组折叠；换设备一致、可被企业管理、分享态可禁。localStorage 仅作离线兜底。

---

## 3. 六项现状与缺口（带证据）

### 3.1 响应式布局
- 新壳 `features/workspace/WorkspaceShell.tsx` 已实现五档（档位 `lib/breakpoint.ts:17-23`：≥1440 / 1280–1439 / 1024–1279 / 768–1023 / <768）。
  - ≥1280：L2 常驻流内（xl 档压到 208）；收起后留 56px 全高窄条唤回（`SecondaryNavRail.tsx`）。
  - 768–1279：L2 为浮出面板（绝对定位、top=48 不盖工具带）；收起后从 L1 底部"展开面板"按钮唤回。
  - <768：汉堡"导航"条唤出抽屉，L1/L2 都进抽屉、L2 叠在 L1 之上。
- 壳门控：`features/workspace/ShellGate.tsx`，新壳默认 on；探活 menu 失败则回退旧 `AppShell`/`KbShell`。
- **真机若问题仍在的五种原因（按概率）**：① 走了旧壳（flag 被关，旧 `Sidebar.tsx:116`、`KbSidebar.tsx:43` 固定 w-60 不折叠）；② 浏览器缓存旧 bundle/旧 index.html；③ 只更新后端、web dist 未同步；④ 恰在 1024 附近，浮出档默认收起、用户没注意"展开面板"；⑤ `l2Peeked` 是死状态（`WorkspaceShell.tsx:246` 未接线）。
- **待修的 12 处小窗隐患**（详见调研底稿）：
  1. 全站 Modal 外层 p-6，<400 吃宽（`components/ui.tsx:673`）→ 窄档 p-3 近全宽，一处全站生效。
  2. 设置页左侧写死 180（`settings/SettingsPage.tsx:117`）→ <md 顶部横向 tab。
  3. 通讯录部门树 w-60 + 断点口径不一（`contacts/ContactsDirectory.tsx:56-60,88`）→ 统一用 breakpoint，<md 树进抽屉。
  4. 角色栏写死 420（同文件 :132）→ 保持窄档 tab 兜底。
  5. 成员抽屉 380（`MemberDrawer.tsx:108`）→ 已兜底，无需改。
  6. 日历固定 7 列（`views/CalendarView.tsx:173,181`）→ sm 档切单列日列表。
  7. 看板列固定 280（`views/KanbanView.tsx:133`）→ 保留横滚 + 加边缘提示。
  8. 记录抽屉 340–960（`drawer/RecordDrawer.tsx:41-43`）→ <md 可改 w-full。
  9. 分享弹窗 560（`sharing/TableShareModal.tsx:104`）→ 随通用 Modal 修。
  10. 画布/文档弹窗 90vw 未减 padding（`kb/CanvasEditModal.tsx:98,104`、`kb/canvas/DocEditModal.tsx:98`）→ 窄档 calc(100vw-24px)+p-3。
  11. ERD 固定内容宽（`erd/ErdPage.tsx:113,123`）→ 加"适应窗口"缩放。
  12. 知识库斜杠菜单写死 300（`kb/kb.css:339`）→ 窄档 min(300px,100vw-24px)。
- 断点口径分叉：Tailwind 默认 2xl=1536，JS 档位 2xl=1440（`tailwind.config.ts` 未显式 screens）。建议在 `packages/design-tokens/src/tailwind.ts` 显式声明 screens 统一为 1440。

### 3.2 表级权限
见拍板 A。四条写路径：改名 `routes/tables.ts:262`、删表 `:299`、字段增删改 `routes/fields.ts:104,174,238`、布局/视图 `layoutVersions.ts:181`、`routes/views.ts:147`。可见行控制写路径需新建。

### 3.3 视图管理员配置
- 类型联合唯一真源：`packages/shared-types/src/views.ts:8`（grid/gallery/form/detail/kanban/calendar）；后端枚举 `routes/views.ts:15`。
- 视图模型：prisma `View`（`schema.prisma:179-193`），`config` 为序列化 JSON；`parseViewConfig` 在 `domain/recordService.ts:318-388`。
- 画廊封面：前端按 `config.coverFieldId` 读附件（`views/GalleryView.tsx:46,105-119`），守卫 `canBeCoverField`（`views.ts:257-259`），**缺设置入口**。
- 字段范围/顺序：后端 `visibleFields()`（`recordService.ts:56-70`）按 fieldOrder 重排、按 hiddenFieldIds 剔除；grid 有"隐藏列"勾选（`grid/GridToolbarParts.tsx:189-230`），但**白名单与拖拽排序无入口**。
- 视图级筛选：`config.filters/sorts` 后端权威应用（内存 `recordService.ts:77-110`，sidecar `queryPlan/compile.ts:210-242`）；**不支持"当前用户"动态值**（`FilterCondition.valueType` 只有 literal/field，`packages/shared-types/src/filters.ts:37-45`），也无通用"用户关联"字段类型。
- 字段权限已三道闭合（定义缺席 + config 脱敏 `fieldMask.ts:280-294` + 出口抹键）；**但脱敏函数未覆盖 coverFieldId/cardFieldIds/kanbanFieldId/dateFieldId/detailFieldIds**，引用无权字段目前不剔除（仅因字段缺席才不渲染）——需补缝。

### 3.4 两种新视图（均零新增依赖可实现）
- 新增视图类型需改 7 处：`views.ts:8/10-17/19-26`（类型/数组/标签）、`views.ts:95-139/189-212`（config/默认值）、`routes/views.ts:15`（zod 卡口）、`recordService.ts:318-387`（默认透传）、`views/ViewRouter.tsx:244-259`（分发 switch）、`components/icons.tsx:364-371`（图标）；默认名自动派生（`grid/view-default-name.ts`），DB `View.type` 自由 String 无需迁移。
- 同表自引用：后端本就允许（`relatedTableId` 无 != tableId 校验，`schema.prisma:97`；已有同表 link 测试先例 `record-single-hydrate.test.ts:56-59`），**前端字段编辑器把本表过滤掉了**（`designer/FieldEditorSheet.tsx:660,817`）→ 放开。
- link 值独立存 `link_rows` 表（`schema.prisma:158-175`），hydration 现算为 `LinkRef[]`（`hydrate.ts:477-527`）。
- 层级视图（建议 type `tree`，标签"层级"，图标用既有 sitemap）：新增 `treeParentFieldId`；新建 `features/tree/`，LinkRef→{id,parentId} 适配（约 20 行）后复用 `contacts/lib/tree.ts` 的 `buildDeptTree/flattenVisible/virtualWindow`（`:35-171`）与 `DeptTree` 交互范式；走 `useRecordsBounded` 取数。
- 甘特图（type `gantt`，标签"甘特"，图标需新增一个 path）：新增 `ganttStartFieldId/ganttEndFieldId/ganttProgressFieldId/ganttDependencyFieldId/ganttRange`；新建 `features/gantt/`，左任务列 + 右时间轴 div（日期↔px 纯算术）+ 绝对定位任务条与进度填充 + 全屏 SVG 依赖线（仿 `erd/ErdPage.tsx:120-195`），日期解析/刻度仿 `CalendarView.tsx:53-88`；拖拽改期/进度/连线用原生指针事件，写回既有 updateRecord / writeLinks。
- 公共前置：① 放开同表 link；② 新增"当前用户"动态值（`filters.ts:37-45` + `packages/shared-types/src/filter.ts:235-262` 求值注入 userId + `recordService.ts:87` 透传）。

### 3.5 语义检索（豆包）
- Provider 契约 `domain/search/embedding/types.ts:72-80`：`embed(text: string[])`，**只有纯文本通道**；URL 硬编码补 `/v1/embeddings`（`types.ts:111-115`），**不认方舟 `/api/v3`，更不认 `/api/plan/v3`**——必须改 URL 逻辑（允许 /v3 或可配 embeddings path）。
- 云端请求体纯 OpenAI 文本形态（`embedding/cloud.ts:100,111`）。
- 图片零索引：chunk 可索引类型不含 attachment（`search/chunks.ts:23-26,42-51`）；doc 图片 markdown 被整体丢弃（`domain/kb.ts:11`）。
- 配置/加密、outbox→worker→SearchStore、双库切换 reindex、三路召回 + RRF + fieldGrant + hydrate **底座均已就绪**。
- 小遗留：reindex 成功后 `reindexRequired` 没有清零点（`adminEmbedding.ts:175-182` 只置 true）。
- **两个待实测确认（不臆断）**：① base URL 用 `/api/v3` 还是 `/api/plan/v3`——用 `POST /admin/embedding/test-connection` 分别打一次，看 200/dim 还是 404；② 多模态输入格式（image 类型名、URL/base64、能否图文混排、文图是否同维、dim 值）以一次最小真实请求 + 官方文档确认后再定契约。

### 3.6 MCP
见拍板 B。15 工具、双闸门（注册期按 M4 实时可见集 `tools/registry.ts:193-219` + 执行期 `ctx.port.can`）、限流（IP 300 / PAT 120 / 60s）、30s 超时、幂等 24h、审计 4 事件；PAT 六位 scope 已在 P3 退出授权（文档有漂移，需同步）。远端只能 HTTP + 目标实例 PAT。

---

## 4. 开发顺序与阶段划分

| 阶段 | 内容 | 依赖 | 对应需求 |
|---|---|---|---|
| **P0 地基** | ① URL 拼接支持 /v3、可配 embeddings path；② 放开同表 link（FieldEditorSheet 两处）；③ 新增"当前用户"动态值并在 evalFilter/compile 注入 userId；④ design-tokens 显式 screens 统一 1440；⑤ 清 reindexRequired 清零点；⑥ l2Peeked 接线或删除 | — | 1/3/4/5 |
| **P1 权限 + 视图配置（方案二）** | ① `role_library_scope` 全量投影 + 写点同事务双写到 `auth_policies`（接对管子）；② 引擎侧独立表级管理位（不绑 canManage）+ 可见行条件写入/求值；四条写路径换新旧两轨都认的校验；③ shadow 对拍零差异后满足 enforce-ready 再翻门、保留一键回退；④ ViewConfig 分 admin/user 两层 + 管理员配置保存校验 + 扩 `sanitizeViewConfigForMask` 覆盖 cover/card/kanban/date/detail 键 + 画廊封面/字段范围顺序/视图级行筛选管理 UI | P0 | 2/3 |
| **P2 用户个性化** | 新表 `view_user_prefs` + 迁移；个人层字段二次显隐/排序/列宽/搜索/折叠；个人层在"权限裁剪→管理员裁剪"之后叠加；personal lockMode 名副其实 | P1 | 3 |
| **P3 新视图** | tree、gantt 两类型 7 处注册；`features/tree`、`features/gantt` 组件与设置段；均走 useRecordsBounded + 窗口化；具备管理员全部配置 | P1/P2 | 4 |
| **P4 语义检索 E2E** | provider 多模态 content 契约 + cloud 请求体；attachment/ doc 图片入索引；test-connection 定 base URL 与 dim；全量 reindex；建"查询→期望实体"命中表跑真召回；结束删真 key | P0 | 5 |
| **P5 MCP 工具 + 全测** | 按拍板 B 补搭建类工具、扩 canvas ops；远端 HTTP 全功能矩阵（owner/受限/只读 三身份）；同步过期文档 | P1/P2/P3 | 6 |
| **P6 回归与部署** | 四门（vitest 总数恒定 + 三包 tsc 0 + eslint 0 error + S0 golden）；真机五档截图；预览机 167 五步法部署；按需重打飞牛 fpk | 全部 | 1–6 |

**为何这个顺序**：MCP 工具是后端服务的薄封装，必须等权限/视图/新视图定稿；新视图依赖视图配置分层与两个公共前置；语义检索除 URL/多模态外底座现成，可与 P1–P3 并行收尾。写操作在 P1/P2 集中改同一批文件，故串行、不并行派单。

---

## 5. 接口衔接约定（避免相互冲突）

- **配置分层固定次序**：先权限裁剪（字段定义/fieldMask）→ 再管理员裁剪（adminFieldIds/adminFilters/coverFieldId）→ 最后个人裁剪（view_user_prefs）。任何新配置键都必须进 `sanitizeViewConfigForMask`，禁止新增存在性侧信道。
- **过滤 AND 语义**：管理员 `adminFilters` 与用户临时 `filters` 用 AND 拼接；动态值 `valueType:"dynamic", value:"currentUser"` 在内存 evalFilter 与 sidecar compile 两处同口径绑定请求 userId；无关联值的行对非 owner 不可见。
- **权限校验**：表结构管理走新"表级管理位"，与数据 CRUD 分离；MCP 执行期统一经 `ctx.port.can`，写字段 fail-closed。
- **令牌头**：Web 用 `X-GX-Token`；MCP/PAT 用 `Authorization`。
- **分享态**：公开分享默认只应用管理员层与分享人字段权限，不应用个人层。

---

## 6. 数据模型与迁移（手写 migration.sql + deploy）

> 铁律：列名用 camelCase；落库后 `PRAGMA table_info` 核对；`migrate deploy` 后无条件 `prisma generate`。

- 新表（拍板 C）`view_user_prefs`
  - `id` PK；`viewId`（→ views.id，级联）；`userId`（→ users.id）；`prefs` String（JSON）；`createdAt/updatedAt`
  - 唯一约束 `[viewId, userId]`；索引 `userId`
  - @@map `view_user_prefs`
- **方案二权限投影（P1 核心，无新业务表优先）**：以现有 `auth_policies` + `nav_nodes` 承载从 `role_library_scope` 投影出的策略（角色 × 库 × 表 × 字段）；新增写点把 PUT library-scopes 与策略写同事务双写。表级管理位优先在 `authz` 契约/动作层扩展（独立于 canManage），仅当无法表达时才评估新表（如 `table_grants`）。
- **可见行控制存储**：在引擎策略的行级条件上承载（需放开 conditions 写入并实现求值），替代当前恒 null；不新造平行权限表。
- ViewConfig 新增键（admin 层）：`adminFieldIds`、`adminFilters`、`treeParentFieldId`、`ganttStartFieldId/ganttEndFieldId/ganttProgressFieldId/ganttDependencyFieldId/ganttRange`。
- 迁移编号：现 36 → 自 37 起，逐阶段增量；每迁移附 down.sql。

---

## 7. 测试计划

### 7.1 四门（每阶段必过）
- vitest 收集总数与基线恒等（新增用例需同步更新基线）；api/web/shared 三包 `tsc --noEmit` 0 错；eslint 0 error；S0 golden。
- 写串行：新写路径一律走 `runWrite/withWriteTx/withWriteBatch`。

### 7.2 响应式（需求 1）
- 单测：`shell-responsive`、`breakpoint`、`grid-toolbar-narrow`、`workspace-topbar-narrow`、`record-card-list` 扩边界。
- 真机五档（1440/1280/1024/768/375）浏览器复验 + 截图：L2 收起后三处入口（窄条/展开面板/抽屉）都能回到数据；12 处隐患逐条核对。

### 7.3 权限与视图（需求 2/3）
- 表级 × 数据级独立生效矩阵；四条写路径越权 403；无权字段在定义/config/出口三道缺席；管理员配置引用无权字段被脱敏；个人层在 admin 上限内做减法。
- 视图 currentUser 过滤双身份（owner/他人）对抗。

### 7.4 新视图（需求 4）
- 树：断链容错、环防御（wouldFormCycle）、多父取父规则、窗口化 DOM 有界；bounded 截断时建树提示。
- 甘特：日期↔px 边界、跨月/周刻度、进度填充、依赖线视口裁剪、拖拽改期/进度/连线写回。
- 两视图均复用第 3 项配置测试。

### 7.5 语义检索（需求 5）
- CI 默认仍走 controllable-fetch、保持零外网断言（`m5-s12-zero-egress`）。
- 手工真 provider（不进 CI）：test-connection → reindex → 10–20 组命中表。成功判据建议：文本 Top-5 命中率 ≥0.8；图文/以图搜图 Top-5 ≥0.7；vector 与 auto 一致；权限对抗零命中不回归；结束删 key。

### 7.6 MCP（需求 6）
- 远端 HTTP，三身份各签 PAT：建表/字段/视图 → 回读校验；记录 CRUD；建文档/画布；画布改/删/移动/连线；每步 audit `mcp_tool_call`；越权 isError + FORBIDDEN；IDOR 与不存在同码。
- 复用 `src/e2e` harness（serverHarness/clientHarness）；命令 `cd apps/api && pnpm exec vitest run --config vitest.e2e.config.ts`。

---

## 8. 交付物

1. 本实施方案（定稿）。
2. 改动清单（按阶段、按文件，随 P1–P5 产出并在每阶段汇报中给出 commit hash）。
3. 测试用例与测试结果（四门实数 + 真机截图 + 检索命中表 + MCP 矩阵报告）。
4. 部署/重打：预览机 167 部署复验；按需产出飞牛 0.1.8 fpk。
5. 出口收口：RELEASE/RC 增量、ADR（表级权限与多模态两个新决策）、runbook 更新。

---

## 9. 风险与遗留

- 方案二要在不中断当前生效轨的前提下切 M4：核心风险是"投影源接错"（M4 现接第一代旧三表、未接 `role_library_scope`），已在 P1 第 1 步以全量投影 + 同事务双写 + 零差异对拍兜底；通电后观察期内保留一键回退，回退开关不提前拆除。
- 切引擎后 `role_library_scope` 旧轨不立即删除，先作为回退与对拍基准冻结；其退出（删旧轨/旧投影）需另立 ADR、在稳定观察期之后再议，本轮不做物理摘除。
- "行级权限"名实差距：本轮通过可见行条件写入/求值补齐，产品文案与实际能力对齐。
- 多模态视觉模型对私有 NAS 图片 URL 不可达：需确认图片以公网/签名 URL 提供，或做数据转接（base64）。
- 甘特在禁新依赖下拖拽/连线工作量大但无技术阻断；万级依赖线需视口裁剪。
- 非本次历史遗留（tables.ts 拆分、分享链接访客问题等）不并入，避免范围膨胀。
