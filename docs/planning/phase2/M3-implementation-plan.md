# M3 统一导航资源树 — 可执行实施切片（设计与现状核对，不改业务码）

- 日期：2026-09-16
- 作者：架构师 高见远
- 状态：Proposed（交项目总监大湾区靓仔复核后派后端/前端工程师实施）
- 上游依据：SPEC-enterprise-v1.0 §2（M3 行，:23 P0）/§5（:62-69 `/api/v1/workspaces/current/tree|menu`、openapi 冻结点 :62）/§6（:85 nav_nodes/menu_items/auth_policies 表清单）/§7（:95-96 工作区外壳/一级三类列表）/§8（:109 单一 SVG 图标体系）/§9（AC-M3-1，:119）/§10（:134 资源 10 万节点首屏 <1s）/§11（:144 画布坑位）/§12；PRD-enterprise §支柱2（N1 :132 / N2 :133 / N3 :134 / N4 :135 / N5 :136 / N6 :137）/C-1（:308）/C-7（:314）/C-11（:318）/C-12（:319）/§六 M3（:253-258）；ARCH-enterprise §3.1（两层模型，:135-166）/§3.2（Prisma 草案，:168-278）/§3.3（迁移回填，:280-294）/§3.4（menu_items 行为级联，:296-313）/§9（:849 openapi M3 冻结）；UIUX-enterprise §1（:51-77）/§2（线框:84-179、设置收拢:203-234）/§5（路由建议:531-545）；M2 实施计划（`docs/planning/phase2/M2-implementation-plan.md`）§2.2（:105 明确划给 M3 的边界）、§4.1（GX_ENTERPRISE_ORG flag）、§5-A（manage_menu 留 M3，:193）
- 适用代码基线：`main`（本文档随 commit 提交时业务码基线为 `f8ddde3`）；派工基线 `32f7bea` 之后 **M2-S0/S1 已落地**（`b19dfa1` 特征测试、`f8ddde3` 组织五表迁移与 users 扩列回填），M2-S2（/api/v1 骨架与 GX_ENTERPRISE_ORG flag）仍在实施中；根 `package.json` v0.1.0
- 本机核对环境：Node v22.22.2、pnpm 9.0.0、Prisma 5.22、better-sqlite3 13.0.3（SQLite 3.53.4）、Hono 4.13.5、React 18 / react-router-dom 现状版本 / TanStack Query 5.62
- 测试基线两次实跑：2026-09-14 13:00（派工基线 32f7bea）= api 47 文件 598/3 skipped、web 33、迁移 12；**2026-09-16 M2-S1 后复跑 = apps/api 51 文件 641 passed / 3 skipped、shared-types 4 文件 56 passed、apps/web 2 文件 33 passed；迁移目录 14 个**（新增 `20260915090000_enterprise_org_ddl`、`20260915090100_enterprise_org_backfill`，已播种固定 id `ws_default`/`role_owner` 等）。本文行号证据在两次基线上均复核（§1.4 的 schema 行号以 f8ddde3 为准）；全仓 glob 无任何 `openapi*.y(a)ml`，`routes/v1` 目录尚不存在

> 本文所有"现状证据"行号均在本机实际读码/跑命令核对。与旧 ARCH/SPEC/UIUX 或所给锚点不符之处集中列在 §12。本阶段只产出规划文档，不改任何源码、不提交业务代码。

---

## 0. 结论先行

1. **M3 同样是"加一层 + 换外壳"，不是搬迁资产**：新增 `nav_nodes`（权威实体树，唯一父级）与 `menu_items`（引用编排层）两张旁路表，base/kb/table/view/doc/canvas 六类实体的物理归属、URL、旧 RBAC 守卫**一行不动**；`auth_policies` 按 SPEC §6 同期建表冻结，**不写策略、不接判定**（M4 启用）。权限纪律与 M2 完全一致：M3 不做任何 enforce，连菜单剪枝也不做（与主理人"权限先不 enforce"口径一致，PRD N2 的旧角色剪枝归 M4，见 §10 待裁决-1）。
2. **两层模型按 SPEC §6 落地，但对 ARCH §3 做三处事实性裁剪（请总监复核，§12-7/8/10）**：①**建 view 节点、不建 field 节点**：①**建 view 节点、不建 field 节点**（SPEC/派工列了 view 未列 field；字段权限 M4 走 policy.fieldMask，建 field 节点只带来 ~10x 行数膨胀）；②**建 kb 节点**（ARCH 说 kb 退化为属性，派工明确 kb 是实体类型）；③doc 层级在 nav_nodes 用 parentId 镜像 `kb_docs.parentId`，**menu_items 回填不做"容器嵌套复刻文档树"**（二级文档树由 nav_nodes 子树呈现，避免每篇文档一个容器行）。
3. **nav_nodes 树结构选用 M2 同款 `parentId 真相 + path 物化派生`，不引入闭包表/CTE**：M4 权限引擎要求沿权威树收集祖先链（ARCH §5），物化 path 前缀切分即可在无递归 SQL 下完成，且与 M2 部门树同一套纯函数/方言纪律；menu_items 是浅树（一级+二级，容器嵌套限 2 层），只保留 parentId + 应用层防环。
4. **内容深链 URL 永不改名**：`/base/:id/table/:id/view/:id`、`/kb/:id/doc|canvas/:id` 是被 Markdown 正文（`lib/internal-links.ts`）、画布引用卡（`DocRefCard`/`GxLinkBlockView`）、匿名公开分享（`/s/:token`）持久化存储的资源身份，M3 只统一承载它们的**外壳**，不引入 `/w/node/:id` 内容路径（UIUX §5 建议路由只采纳工作区级：`/workspace/*`）。N5"旧链接可达"因此以"内容 URL 不变 + 外壳级旧入口配 SPA 别名路由"实现，而非服务端 301（SPA 静态兜底下发 index.html，服务端 301 无落点）。此为关键 ADR 候选（ADR-0027，§8），请总监裁决。
5. **回填分两个只增迁移 + 一个可重跑对账脚本**：迁移 A 建三表 + workspaces 加 `navVersion/menuVersion`；迁移 B 用 `INSERT...SELECT` 幂等回填实体节点与默认菜单（零入口丢失：每个活表/活文档至少一条 shortcut）。对账脚本输出 A/B/C 三类差异，**0 差异定义见 §5**。实体写点接线覆盖五个路由文件（bases/tables/views/kb/records），§4.4 表逐条列出 18 个条目，全部在既有 `withWriteTx/withWriteBatch` 事务内接 `domain/nav/sync.ts` 原语，不新增写队列。
6. **删除悬挂按三态处理（C-12）**：活（alive）/ 软删悬挂（资源 `deletedAt` 非空：节点与 shortcut 保留、读接口隐藏、随资源恢复自动还原）/ 失效悬挂（资源物理消失：shortcut 标记 `broken`，管理员显灰可清理，清理入审计）。现状删除语义不对称（base/kb 软删无恢复端点；view 是物理删；table 走回收站 order=-1 隐藏视图），§4.4 逐写点列清。
7. M3 切成 **S0–S11 共 12 片**：S0 特征 → S1 DDL → S2 回填 → S3 写点接线 → S4 对账脚本 → S5 读 API → S6 写 API（含 manage_menu 第四动作位）→ S7 openapi.yaml 首版冻结 → S8 新外壳骨架（含 M2 通讯录入口收敛）→ S9 一级导航/编排器/二级三类列表 → S10 旧链兼容+AC-M3-1 对抗+10 万节点性能 → S11 出口收口。openapi 冻结片（S7）明确排在后端契约稳定（S6）之后、前端大改（S8/S9）之前。
8. flag：新增 `GX_ENTERPRISE_NAV`（默认 on，test 默认 on），与 M2 的 `GX_ENTERPRISE_ORG` 正交：off 时不挂 v1 nav 路由、前端探测 404 回退旧 AppShell/KbShell（双壳保留一个迭代，PRD :258 回滚承诺）。旧 `/api` 与旧页面零行为变化。

---

## 1. 现状证据（行号已核对，2026-09-14 实读）

### 1.1 两套平行外壳与路由表（今天用户怎么导航）

| 事实 | 证据（已核对） |
|---|---|
| 路由表硬编码两套布局壳，登录后内容路由分两组 | `App.tsx:107-123`（RequireAuth+ErrorBoundary 包 **AppShell**：`/`、`/base/:baseId`、`/settings`、`/trash`、`/erd`、`/table/:tableId`、`/view/:viewId`）；`App.tsx:126-141`（平行 **KbShell**：`/kb`、`/kb/:kbId`、`/doc/:docId`、`/canvas/:docId`、`/trash`、`/settings`） |
| `/` 跳第一个 base；base 空表跳 base 设置 | `App.tsx:50-63`（RootRedirect：无 base 显示空态）、`:65-72`（BaseIndexRedirect：无表 → `/base/:id/settings`）、`:74-91`（TableIndexRedirect：取首视图，`?design=1` 选 detail） |
| 匿名公开页独立在外壳之外 | `App.tsx:101-105`：`/login`、`/join/:token`、`/s/:token`、`/s/:token/doc/:docId` |
| 未匹配路由全部回 `/` | `App.tsx:143`（`path="*"` Navigate） |
| AppShell = 左 Sidebar + 右 TopBar/简化栏 + Outlet；⌘K 搜索 | `features/shell/AppShell.tsx:12-65`（无表时简化头 :41-55） |
| KbShell = 左 KbSidebar + Outlet；⌘K 搜索 | `features/kb/KbShell.tsx:12-35` |
| 唯一面包屑只有表页 TopBar 一段 | `features/shell/TopBar.tsx:104-121`（base 名 → 表名，两个硬编码 navigate :108/:116）；知识库侧无面包屑，文档页只有返回按钮（`DocEditorPage.tsx:154-159`、`CanvasEditorPage.tsx` 近似） |

### 1.2 左侧栏数据来源与底部区（设置入口层级）

| 事实 | 证据 |
|---|---|
| base 侧栏数据：库切换器 + `GET /api/tables?baseId` 表列表 | `Sidebar.tsx:112-114`（LibrarySwitcher）、`:33`（`useTables(baseId)`）、`:134-188`（表行渲染，点击 navigate :140）；后端列表 `tables.ts:41-64`，**按 `createdAt asc` 排序**（:50），membership 经 requireCanView 把关 |
| 库列表来自 membership，不是全工作区 | `GET /api/bases`（`bases.ts:110-136`，查 `member.findMany({where:{userId}})` 过滤 deletedAt）；kb 同理 `kb.ts:112-141`（`kbMember.findMany`） |
| base 侧栏底部三件套：回收站/设置/头像 | `Sidebar.tsx:239-278`；回收站跳 `/base/:id/trash`（:243）；**"设置"是 base 级** `/base/:id/settings`（:251）；头像开 PersonalCenterDrawer（:259-276） |
| kb 侧栏同构：切换器 + "全部内容" + KbTree + 底部 | `KbSidebar.tsx:57-59`、`:78`（全部内容 `/kb/:id`）、`:82`（KbTree）、`:90-116`（回收站/设置，均 kb 级） |
| KbTree：doc 按 `kb_docs.parentId` 前端组树、canvas 平铺；doc/canvas 分段页签 | `KbTree.tsx:20-33`（buildDocTree）、`:44-49`（tab/折叠态存 localStorage）、`:73-75`（doc 树 / canvas 平铺）、`:318-381`；数据 `useKbDocs(kbId,"all")` → `GET /api/kb/:id/docs`，后端**按 `updatedAt desc` 返回**（`kb.ts:290-315`，:305），前端按返回序组树（故文档视觉序=updatedAt desc） |
| 文档树拖拽改 parentId（应用层防环） | `KbTree.tsx:142-177`（isDescendantOfDrag/handleDrop）→ `POST /api/kb/docs/:id/move`（`kb.ts:453-487`，仅 doc 可嵌套，canvas 400，:464） |
| 设置中心现状两套，均为资产级 | base：`SettingsPage.tsx:20-28` 五 tab（概览/成员与权限/分享/数据表/危险操作，hash 直达）；kb：`KbSettingsPage.tsx:1-10`（成员 + UploadLimitsPanel）；**工作区级设置尚不存在**（M2 的 `/workspace/contacts` 在规划中，代码里无该路由，全仓 grep 无 contacts） |
| LibrarySwitcher 已统一两类库的切换/新建 | `components/LibrarySwitcher.tsx:27-83`（新建 base→`/base/:id` :70，新建 kb→`/kb/:id` :76；切换 :124/:142），是 M3 一级导航最直接的可复用件（UIUX §2.3 映射表 :160 已指定收进 Logo 区） |

### 1.3 硬编码旧 URL 的全部生成点（N5 兼容面，逐个 grep 实查）

> 以下是除 `<Route path>` 声明外，所有在代码里拼 `/base/...`、`/kb/...` 的位置（grep `navigate(|href=|<Link |to=` 全仓 32 个命中文件中筛出的导航点）。M3 换外壳时这些点**原则上不改路径**，但需逐个回归；其中共享正文/画布里的链接是**持久化数据**，决定了内容 URL 不可变（结论 §0-4）。

| 区域 | 文件:行 | 目标形态 |
|---|---|---|
| 路由内重定向 | `App.tsx:62,70,82,90,124` | base/table/view 旧形 |
| base 侧栏 | `Sidebar.tsx:55`（?design=1）、`:64`（建表后）、`:102`（删表后）、`:140`（表行）、`:243`（回收站）、`:251`（设置） | 旧形 |
| kb 侧栏/树 | `KbSidebar.tsx:78,95,106`；`KbTree.tsx:95,105`（打开/新建 doc/canvas）、`:135`（删当前文档回 kb 首页） | 旧形 |
| 库切换器 | `LibrarySwitcher.tsx:70,76,124,142` | 旧形 |
| 表顶栏/视图签 | `TopBar.tsx:44,55`（视图）、`:95`（删表）、`:108,116`（面包屑）、`:144`（`settings#share`）；`ViewTabs.tsx:42,77` | 旧形 |
| 全局搜索 | `SearchDialog.tsx:86`（record）、`:88`（doc）、`:90`（canvas） | 旧形 |
| kb 列表/首页 | `KbListPage.tsx:31,63`；`KbHomePage.tsx:64,99` | 旧形 |
| base 设置/ERD | `SettingsPage.tsx:55,70,124（删库后回 /）,156,180`；`ErdPage.tsx:179` | 旧形 |
| 内容编辑器返回 | `DocEditorPage.tsx:141,156`；`CanvasEditorPage.tsx:89,103` | 旧形 |
| 画布内文档引用 | `canvas/DocRefCard.tsx:126-127`；`canvas/GxLinkBlockView.tsx:68,76`（拼 `/kb/:id/:kind/:docId`）；`canvas/RefEmbedBody.tsx:61-63`（Markdown 点击委托） | 旧形 |
| 正文内部链接协议 | `lib/internal-links.ts:13-34`（internalHref 五种目标，**单一真源**）；消费方 `MarkdownEditor.tsx:425`、`WysiwygEditor.tsx:1581`（另有锚点解析 :2437-2464） | 旧形，且**已落库为正文内容** |
| 其他跳转 | `ViewRouter.tsx:158`（跨表开记录）、`designer/ViewSettingsPanel.tsx:62`、`auth/ShareJoinPage.tsx:66`（持票加入后） | 旧形 |
| 部署 basename | `main.tsx:17`（BrowserRouter basename=BASE_URL）；`lib/base.ts:42-47`（withBase）；`api/client.ts:39-47,119`（apiFetch 自动前缀） | 已支持子路径部署，M3 不破坏 |

### 1.4 后端实体模型与删除语义（nav 同步接线点，逐个实读）

| 实体 | 模型/删除语义 | 写点文件:行 |
|---|---|---|
| Base | `schema.prisma:19-32`（两基线下行号未移动；name/iconColor/createdBy/deletedAt，**无 workspaceId**；M2-S1 只给 users 加列，资产表未动） | 建 `bases.ts:141-166`（同时建 owner member + createStarterTable :154）；改名 `:203-210`；**软删 :212-218（base+其下 tables 打 deletedAt，无字段/记录处理，无恢复端点）** |
| Table | `:34-50`（baseId/primaryFieldId/deletedAt） | 建 `tables.ts:66-141`（withWriteTx：表+主字段+可选默认字段+网格视图）；改名 `:169-181`；**软删 :183-197（table/records/fields 打 deletedAt，views 置 `order=-1` 隐藏——不是 deletedAt）**；复制 `:201` |
| Field | `:54-118`（order，无 ord） | 建经 `domain/fieldService.ts:122/167/181/305`（含配对反向字段）；**软删 :363-402（含对称反向字段、link_row 标记）**；路由 `fields.ts:100/170/233/245`。M3 **不为 field 建 nav 节点**（§0-2），故 field 写点**不接 nav 同步** |
| View | `:164-178`（order/config，**无 deletedAt 列**） | 建 `views.ts:82-117`；改名 `:129-173`；**物理删 :175-190（至少保留一个视图，prisma.view.delete）**；复制 `:192`。table 软删时视图变 `order=-1`；table 恢复时视图 order 重排（`records.ts:1086-1090`） |
| Record | `:122-139` | 回收站列表 `records.ts:468`；**恢复 :1027-1092（kind=record/field/table 三态；table 分支连带恢复 fields/records/linkRows/sidecar/视图序 :1064-1091）**；物理删 :1094-1128。record 不进 nav，无需同步；**table 恢复/物理删两条必须接 nav** |
| KnowledgeBase | `:267-280`（M2-S1 后位移；32f7bea 时 249-262）（createdBy/deletedAt） | 建 `kb.ts:143-165`（带 owner member）；改名 `:180-197`；**软删 :199-211（kb+其下 docs 打 deletedAt，无恢复端点）** |
| KbDoc | `:297-331`（M2-S1 后位移；32f7bea 时 279-313）（kind=doc/canvas、parentId :296 仅 doc 用、share* 外链字段、deletedAt/deletedBy） | 建 `:317-361`（仅 doc 可带 parentId，canvas 恒顶级；同时写首版本）；改名 `:383-401`；移动 parentId `:453-487`（防环 isDescendant :70-83）；**软删 :595-605；恢复 :607-622（deletedAt/deletedBy 清空）；物理删 :624-640（连删 versions/acls 后 prisma 删行，仅 kb owner）** |
| 匿名公开 | `routes/public.ts:183/213/223`（/s/:token、/s/:token/doc/:docId、/ref/:docId，不解析用户） | M3 不动（与 M2 §5-D.5 同口径） |
| 全局搜索 | `search.ts:47` 起，membership 内逐表有界预览 + kb 文档 | M3 不接 nav；M5 统一检索替换 |

- 写串行门面复用 M1 设施：`db.ts` 的 `withWriteTx/runWrite/withWriteBatch`（M2 计划已核对 :111-138）。nav 同步原语只允许在这些回调内用传入 tx。
- 审计事件名当前仅 6 枚（`audit/audit.ts:9-15`：login_success/login_failure/signup/change_password/account_delete/avatar_delete），M3 只增菜单/节点事件名。
- 迁移目录 **14 个**（M2-S1 后；脚本 `ci-quality.sh:87-96` 按 `_prisma_migrations` 动态对账，不写死数字）；M3 后变 16。

### 1.5 前端工程设施（决定切片接法）

- API 唯一出口 `api/client.ts`：`apiFetch`（:119）自动注 JWT、401 全局登出；所有路径经 BASE_URL 前缀（:39-47）。M3 v1 调用在此追加 `Nav`/`Menu` 段，不裸 fetch。
- TanStack Query 失效惯例：`api/hooks.ts:326-411`（invalidateAll/invalidateTable 按 queryKey 收敛），kb 侧 `features/kb/kb-hooks.ts`；M3 菜单/树 query key 新增 `["nav-tree"]`、`["nav-menu"]`，在资源增删改 mutation 上**追加失效**（不改既有 key）。
- 图标：`components/icons.tsx:7-106` 为唯一 IconName 联合（100 枚），PATHS 单一映射（:108）。M3 需在同文件**追加**：grip（拖拽手柄）、folder/folderOpen（菜单容器，现有 group 偏"分组字段"语义，建议新追加）、folderPlus、linkExternal（broken/别名真名提示，现有 external 先复用）、building/sitemap 等若 M2 已追加则复用、key 留给 M6。**禁止第二套图标库、禁止 emoji**（SPEC §8 :109）。
- web 无组件测试设施；纯函数/vitest 可用（现有 2 测试文件 33 例）。树组装/防环/差异纯函数照 M2/KbTree 模式抽到 `features/workspace/lib/*` 并配单测。
- 子路径部署已闭环：Vite base → `main.tsx:17` basename；API → `lib/base.ts`；M3 新路由/新请求自动继承，不需特殊处理（S10 专项验证）。

---

## 2. M3 范围边界

### 2.1 必做（SPEC M3 行 + N1/N2/N4/N5/N6 + AC-M3-1）

1. **nav_nodes 权威实体树**：六类系统节点 base/kb/table/view/doc/canvas（外加 M3 可手工建的 group 分组节点，N4）；字段 parentId/ord/name/kind/图标（iconName 走菜单层，实体节点用类型默认图标）/path 物化；`@@unique([workspaceId,resourceType,resourceId])` 保证一资源一权威挂载；workspaceId 恒为 M2 的 `ws_default`。
2. **menu_items 引用层**：type=container|shortcut；shortcut.nodeId 可重复（同一实体多处挂载）、label 可空（回落实体真名）、可起别名、可拖拽排序/换容器；删除 shortcut/container 不触 nav_nodes 父级与任何策略（AC-M3-1 前半句）。
3. **存量自动回填 + 0 差异对账**：迁移回填全部活实体节点与默认菜单（每 base 一个同名容器挂全部 table；每 kb 一个同名容器挂全部根级 doc/canvas；doc 树层级由 nav_nodes parentId 镜像承载）；独立可重跑对账脚本（§5）。
4. **实体写点同事务同步 nav_nodes**：§4.4 表 18 个条目，含软删/恢复/物理删/移动/改名/建复制；重复回填安全（upsert by 唯一键，软删行原地复活，不新增行）。
5. **新工作区外壳（N1）**：顶部 Logo 区 + 全局搜索（⌘K 提权顶栏）+ 左下设置/通用功能区 + 左一级导航 + 可选二级内容栏 + 内容区；M2 的 `/workspace/contacts` 通讯录入口并入左下设置区（M2 S7 临时侧栏入口在 S8 摘除）；工作区设置中心首版只收"通讯录 + 库设置入口（base/kb 资产级设置原页保留可达）+ 导航编排"，安全/备份/embedding/MCP 各项随 M5/M6 填充，本里程碑只留导航占位或不留（待裁决 §10-7）。
6. **一级导航编排（N2）与三类统一分组（N4）**：管理员对 menu_items 增删改排、多处添加、别名；建 group 节点与"移动到其他分组"走 nav_nodes.parentId 变更 + N6 粗粒度影响预览（M3 用旧 members/kb_members 口径计算受影响人数，M4 自动升级三源并集）。
7. **二级内容列表（N3 的 P0 部分）**：进入一级容器后，二级按 [数据表｜文档｜画布] 三分区列出被收纳内容（KbTree 分段页签同款样式），带列表内搜索；**收藏/最近访问为 N3 P1，本里程碑不做**（C-7/D-3 已定，§10-8 知会）。
8. **旧入口/旧链接（N5）**：全部旧 URL 在新外壳下可达且操作步数 ≤ 旧版 +1（PRD :257）；旧外壳经 flag 回退保留一个迭代；`/kb` 网格列表等"外壳级页面"给 SPA 别名路由。
9. **API**：`GET /api/v1/workspaces/current/tree`、`GET/PATCH /api/v1/workspaces/current/menu`（SPEC §5 :68-69），另加节点管理端点（group 建改删、移动+影响预览、菜单批量 diff 写）；manage_menu 成为继 M2 三枚之后的第四枚组织管理动作位（owner 默认持有，自定义角色可勾）。
10. **auth_policies 同期建表冻结**（SPEC §6 :85）：按 ARCH §3.2 结构建空表，M3 无任何写入/读取路径（一个测试断言"全代码无 authPolicy 写调用"）。
11. **openapi.yaml 首版出口冻结**：覆盖 M2 org 全量（M2 只有 draft 分册）+ M3 tree/menu/node，OpenAPI 3.0，作为 M4 启动前置 sidecar。
12. **可见性/剪枝字段留给 M4**：M3 的 tree/menu 读接口**不做权限剪枝**（登录即返回全量菜单，含 broken 标记仅对管理者可见）；数据 API 本身的旧守卫（members/kb_members/kb_doc_acls）原样生效，URL 直访旧防护不削弱。

### 2.2 明确不做（划给后续里程碑）

| 不做 | 归属 | M3 临时姿态 |
|---|---|---|
| 任何资源权限判定/三源并集/菜单按权限剪枝/字段掩码 | **M4** | auth_policies 空表；tree/menu 不剪枝；requireCan*/requireKb 旧守卫一行不动 |
| nav_nodes 不建 field 节点 | M4（fieldMask） | 字段权限不依赖节点；如 M4 设计证伪再补只增回填 |
| PAT、MCP 通道、AI | M6 | 无 |
| 向量/语义检索/outbox/search.db | M5 | 全局搜索维持 search.ts 现状，新壳只提权入口 |
| 收藏/最近访问（N3 P1）、个人导航、多主题、多工作区切换、多租户 | P1/Out-of-Scope | workspaceId 恒 ws_default |
| base/kb 软删恢复端点 | 不新增（待裁决 §10-6） | nav 跟随软删；其恢复能力现状缺失是既存事实，不夹在 M3 补 |
| 全局回收站聚合页 | P1/设置中心后续 | 两个资产级回收站原样保留入口 |
| 服务端 301 重定向表 | 不做 | 内容 URL 不变（§0-4）；外壳级迁移用 SPA 别名 |
| 文档导航分组与 kb_docs.parentId 双向改写 | 不做（UIUX :179 注：两套层级并存不互改） | 二级文档区默认按权威树（=parentId 镜像）呈现 |
| 内置 group 按字段桶预生成 | M4 | M3 group 只是空分组节点，config 留列不填桶 |
| 旧 `/api` 下线/响应信封切换 | 下一迭代 | v1 与 /api 平级；openapi 按实现写实（§10-5） |

---

## 3. 不能动的契约（Characterization 先锁）

1. **内容 URL 形态零变化**：§1.3 表中所有 `/base/:id/...`、`/kb/:id/...` 路由路径与参数不变；已落库的 Markdown 内部链接、画布 gxLinkRef、公开分享链接升级后逐条仍可达（S10 抽样回归，列入 RC）。
2. **旧资源 RBAC 结果逐值不变**：M3 不引 auth_policies 判定；nav/tree/menu 是新增读路径，任何 requireCan*/requireKb/requireDocAccess 结果与 M3 前一致（仿 M2 S0 写 characterization，S11 复跑）。
3. **旧列表接口契约不动**：`GET /api/bases`、`/api/tables`、`/api/kb`、`/api/kb/:id/docs` 的响应字段/排序保持（侧栏旧壳回退时仍消费它们；新壳首版也可并行消费，直到 flag 摘除）。
4. **软删/恢复语义不被 nav 接线改变**：同步原语只在既有事务内追加写，不改变实体 deletedAt/order 现有写法；事务失败整体回滚（含 nav 行）。
5. **匿名三条公开通道**（public.ts）不经工作区外壳、不查 nav 权限，行为不变。
6. **迁移只增、回填幂等**：三新表 + workspaces 两列；重跑 migrate deploy 与对账修复零副作用（唯一键 upsert、软删行原地复活）。
7. **M2 契约消费不修改**：M3 依赖 M2 的 workspaces（ws_default）、roles/role_assignments、requireActiveUser、`/api/v1` 挂载点与 flag 模式；M3 只在其后追加路由与第四动作位，不改 M2 端点签名。
8. **画布 R10 契约**：新外壳挂载画布编辑器时只换外层框架，画布页内部交互/快捷键/portal 层级像素不动（SPEC §10 :133、§11 :144-146 坑位；S10 必跑画布回归）。

---

## 4. 数据模型与同步设计

### 4.1 Prisma 模型草案（只增；命名/软删/ord 与 M2 对齐）

```prisma
// M3 给 M2 的 workspaces 只增两列（M2 刻意只建 policyVersion，见 M2 计划 S1）
// workspaces: + navVersion Int @default(0)、menuVersion Int @default(0)

model NavNode {
  id               String    @id @default(cuid())
  workspaceId      String                    // 恒 ws_default（M2 固定 id）
  parentId         String?                   // L0 实体节点为 null；doc 节点镜像 kb_docs.parentId
  kind             String                    // base | kb | table | view | doc | canvas | group
  resourceType     String?                   // 资源节点同 kind（group 为 null）
  resourceId       String?                   // 实体表主键；group 为 null
  name             String                    // 冗余展示名，随实体改名同步；group 由管理员命名
  ord              Int       @default(0)     // 同父排序（表=createdAt asc 序；doc=updatedAt desc 序，见 §5.2）
  path             String    @default("")    // 物化派生：'/'+各级 id+'/'，M2 部门同款规则
  depth            Int       @default(0)
  isSystem         Int       @default(1)     // 1=实体自动节点；0=管理员 group（SQLite 0/1，M2 同纪律）
  config           String?                   // JSON：group 预留 {tableId,fieldId,bucket}（M3 不消费）；view 预留 {viewId 冗余}
  iconName         String?                   // 实体节点默认图标可覆盖；null=前端按 kind 取
  inheritAncestors Int       @default(1)     // 内容叶子继承开关，M3 恒 1，M4 才可置 0
  createdAt        DateTime  @default(now())
  updatedAt        DateTime  @updatedAt
  deletedAt        DateTime?

  shortcuts        MenuItem[]

  @@unique([workspaceId, resourceType, resourceId])
  @@index([workspaceId, parentId])
  @@index([workspaceId, kind])
  @@index([resourceType, resourceId])
  @@index([path])
  @@map("nav_nodes")
}

model MenuItem {
  id           String    @id @default(cuid())
  workspaceId  String
  parentId     String?                   // 自引用；一级为 null；容器嵌套限 2 层（应用层校验）
  type         String                    // container | shortcut
  nodeId       String?                   // shortcut → nav_nodes.id（不唯一，可多处引用）；container 为 null
  label        String?                   // 别名；null=展示节点真名
  iconName     String?                   // 必须 ∈ icons.tsx IconName（后端校验白名单由 shared-types 常量下发）
  ord          Int       @default(0)
  brokenReason String?                   // 仅审计/排查：missing_resource | soft_deleted（读接口派生为主，列仅留痕）
  createdAt    DateTime @default(now())
  updatedAt   DateTime @updatedAt
  deletedAt    DateTime?

  parent       MenuItem? @relation("MenuTree", fields: [parentId], references: [id], onDelete: Cascade)
  children     MenuItem[] @relation("MenuTree")
  node         NavNode?  @relation(fields: [nodeId], references: [id], onDelete: Restrict)

  @@index([workspaceId, parentId])
  @@index([nodeId])
  @@map("menu_items")
}

// M3 只建表冻结契约，全里程碑无写入/读取业务路径（M4 启用）。结构按 ARCH §3.2，
// M4 启动前如要调结构仍可只增迁移；冻结的是"存在与字段语义"，不是 M4 不可加列。
model AuthPolicy {
  id          String   @id @default(cuid())
  workspaceId String
  nodeId      String
  subjectType String                    // user | dept | role
  subjectId   String
  actions     String   @default("r")
  fieldMask   String?
  conditions  String?
  reason      String?
  createdAt   DateTime @default(now())
  createdBy   String

  @@unique([nodeId, subjectType, subjectId])
  @@index([workspaceId, subjectType, subjectId])
  @@index([nodeId])
  @@map("auth_policies")
}
```

设计要点/与 ARCH 草案的差异：

1. **布尔落 INTEGER 0/1**（isSystem/inheritAncestors），与 M2 迁移纪律一致；Prisma 端仍按 boolean 用，迁移 SQL 写 0/1。
2. **menu_items.nodeId 用真实 FK + `ON DELETE RESTRICT`，不用 ARCH 的 Cascade**：M3 没有资源物理删联动（资源与 nav 之间无跨表 FK，见下条），node 清理只发生在显式 purge 事务中；RESTRICT 强制"先清引用再删节点"的正确顺序，杜绝静默丢菜单。purge 事务内先删 shortcut 再删 node。
3. **nav_nodes 与六张实体表之间不建 FK**：实体表无 workspaceId（M2 只给 users 加了列），且软删/物理删语义各表不一；引用完整性由同步原语 + 对账脚本保证（与 M2 users.workspaceId 同款应用层保证）。
4. **workspaces 加 navVersion/menuVersion**：M2 计划 S1 刻意 YAGNI 未建（M2 计划 :335），M3 以只增迁移补上；任何 nav_nodes 写事务 +navVersion、menu_items 写事务 +menuVersion（菜单写不动 navVersion/policyVersion，ARCH §3.4 :312）。M3 无缓存消费者，版本列先行只为 M4/前端缓存失效留口。
5. **唯一键含 NULL 的注意**：SQLite 中 NULL 互不相等，group 节点（resourceType/resourceId 均 NULL）不受唯一键限制，符合预期；回填 INSERT...SELECT 需显式 `WHERE resourceType IS NOT NULL` 防重复。
6. **inheritAncestors 列 M3 建而不用**：恒 1，M3 无切换端点（SPEC 把 inheritance PATCH 列在 M4，:72）；建列是 SPEC §6 明确要求的冻结契约一部分。

### 4.2 树结构选型：parentId + 物化 path（同 M2），不建闭包表

| 方案 | 祖先链/子树查询 | 移动子树 | 与 M2 一致性 | 结论 |
|---|---|---|---|---|
| 仅 parentId + 递归 | 需 CTE（违方言边界，SQLite/PG 语法与版本差异）或全表内存遍历（kb.ts 现有 isDescendant :70-83 逐行 N+1，doc 树深时放大） | 改 1 行 | 部分 | 否：M4 每请求都要祖先链 |
| **parentId + path 物化** | 前缀 LIKE / path 切段，B-tree 可走索引；M4 ancestorChain 一次查询 | 子树 path 重写（M2 deptTree 已有纯函数） | **完全同款** | **选** |
| 闭包表 | 祖先/后代双查快 | 多行维护、多一张表 | 新增范式 | 否：MVP 过度设计，且 10 万节点下闭包行数随深度膨胀 |
| 嵌套集 | 区间查快 | 半表重写 | 无 | 否 |

- path 规则与 M2 部门逐字一致：`/` 连接各级 nav node id、首尾 `/`；path 永远可由 parentId 链重算（派生数据，对账脚本可全量重建）。
- 实体节点移动罕见（仅"移动到其他分组"与 doc parentId 镜像变更）；doc 树回填后运行期镜像移动复用 M2 `rewriteSubtreePathsTx` 同款应用层 map + 参数化 UPDATE。
- 深度护栏：group/doc 树 MAX_DEPTH=32（同 M2，护栏不是功能承诺）；menu 容器嵌套硬上限 2 层（一级容器 + 子容器；shortcut 永远叶子）。
- 方言纪律：不用 CTE、不在 SQL 内做 JSON 抽取（config 只整存整取）、LIKE 带 `ESCAPE`、raw 全参数化。

### 4.3 目录组织（新增代码边界）

```
apps/api/src/
  domain/nav/
    sync.ts          // 事务原语：upsertResourceNodeTx/renameNodeTx/softDeleteResourceNodeTx/
                     // restoreResourceNodeTx/purgeResourceNodeTx/moveSubtreeTx/rebuildPathsTx
    tree.ts          // 纯函数：path 拼接/前缀/防环/深度/子树重写（与 M2 deptTree 同构，抽公共 util 或复制小函数）
    menu.ts          // 菜单批量 diff 应用、容器嵌套/环校验、iconName 白名单校验、broken 派生
    backfill.ts      // 回填逻辑的可调用实现（迁移 SQL 负责首跑；此文件供对账修复脚本复用，禁止另写一套规则）
    reconcile.ts     // A/B/C 三类差异计算与 --apply 修复
  routes/v1/
    workspace.ts     // GET /workspaces/current/tree、GET/PATCH /workspaces/current/menu
    nodes.ts         // group CRUD、POST /nodes/:id/move-impact、POST /nodes/:id/move
    index.ts（M2 建）// v1 装配追加 workspace/nodes
scripts/nav/
  reconcile-nav.mjs  // CLI：对当前库跑差异报告/--apply（仿 scripts/bench 现有脚本风格与 prisma 初始化）
```

- nav 路由全部经 M2 的 `requireActiveUser`；写操作经 `requireOrgAction('manage_menu')`（节点移动/菜单编排同一动作位；group 的 CRUD 也算 manage_menu）。
- tree 读：登录即可；M3 不剪枝（§2.1-12），DTO 带 `deletedAt` 不下发（软删节点在 tree 管理视图里带 `state` 字段供管理员看，普通 menu 解析隐藏——普通 menu 读对软删 shortcut 返回 `state:"soft_deleted"` 但**不剪**？定口径：普通 menu 读也返回，由前端对全员隐藏软删项，M4 改为服务端剪枝。保持后端无权限逻辑，只做存在性解析）。

### 4.4 实体写点 → nav 同步接线表（18 个条目，全部入既有事务）

| # | 触发 | 文件:行 | 事务形态 | nav 原语 |
|---|---|---|---|---|
| 1 | 建 base（含 starter table/view） | `bases.ts:141-166`（createStarterTable :47-106） | 当前**无显式事务**（多写裸奔是既存事实） | S3 顺手包进 `withWriteTx("base.create",…)`（行为等价收紧），同事务 upsert base+table+view 节点 |
| 2 | base 改名 | `bases.ts:203-210` | runWrite | renameNode(base) |
| 3 | base 软删 | `bases.ts:212-218` | 裸多写 | 包 withWriteBatch；softDelete 子树（base+table+view 节点） |
| 4 | 建 table（含字段+视图） | `tables.ts:66-141` | withWriteTx | upsert table+view 节点（field 不建） |
| 5 | table 改名 | `tables.ts:169-181` | runWrite | renameNode(table) |
| 6 | table 软删（views order=-1） | `tables.ts:183-197` | withWriteBatch | softDelete table/view 节点 |
| 7 | table 复制 | `tables.ts:201-`（事务内建新表/字段/视图） | withWriteTx | 为新表/视图 upsert 节点（父=同源 base 节点，菜单**不自动加快捷项**，零噪音，新表以"未收纳"态出现在二级"数据表"全量列表——见 §6 S6 收纳规则） |
| 8 | 建视图 | `views.ts:82-117` | 裸写 | upsert view 节点（建议入 runWrite，最小包裹） |
| 9 | 视图改名 | `views.ts:129-173` | 裸写 | renameNode(view) |
| 10 | 视图物理删 | `views.ts:175-190` | 裸写 | 先确认无 shortcut（RESTRICT）→ purgeNode(view)；有 shortcut 则 409 引导先删引用（C-12），**不级联静默删菜单** |
| 11 | 建 kb | `kb.ts:143-165` | 裸写 | upsert kb 节点（withWriteTx 包裹） |
| 12 | kb 改名/软删 | `kb.ts:180-211` | 裸写 | renameNode / softDelete 子树（kb+其下 doc/canvas） |
| 13a | doc/canvas 建 | `kb.ts:317-361` | 裸写（+版本行） | upsert 节点：doc 父=parent doc 节点（无则 kb 节点），canvas 父=kb 节点 |
| 13b | doc 改名 | `kb.ts:383-401` | 裸写 | renameNode |
| 13c | doc 移动 parentId | `kb.ts:453-487` | 裸写 | moveSubtree（仅单节点 path 重算 + 子树：doc 子文档的 nav 节点是其后代，必须按 M2 子树重写） |
| 13d | doc 软删/恢复/物理删 | `kb.ts:595-640` | 裸写 | softDelete（:600）/restore（:617 原地复活）/purge（:635 前先清 shortcut 与节点） |
| 14 | 回收站恢复 table（连带字段/记录/视图序） | `records.ts:1064-1091` | 多语句 | restoreNode 子树（table+views）；record/field 分支不涉 nav |
| 15 | 回收站物理删 table | `records.ts:1116-1127`（table 分支） | 多语句 | purge：有 shortcut 409 或按菜单删除规约处理（同 #10） |

接线纪律：

- 原语一律 `*Tx(tx, …)` 签名，回调内只用传入 tx（M1 铁律）；route 文件不得直接 prisma.navNode.*。
- **找不到节点不阻断实体写**（防御：nav 同步异常记审计 + console.error，但不回滚实体事务？——相反选择：M3 期同步必须强一致，接线期让 nav 写与实体写**同生共死**，任何 nav 写失败整体回滚，由测试保证不发生；对账脚本是上线后的兜底修复。若总监倾向"导航可重建、不该阻断主业务"，改为 best-effort+审计，请裁决 §10-9。本计划默认强一致）。
- 前端 query 失效：bases/tables/kb/docs 既有 mutation onSuccess 上追加 invalidate `["nav-tree"]`/`["nav-menu"]`（hooks.ts:326-411、kb-hooks.ts 对应位置）。

### 4.5 API 端点（v1，具体契约 S7 进 openapi 冻结）

| Method | Path | 动作位 | 说明 |
|---|---|---|---|
| GET | `/api/v1/workspaces/current/tree` | 登录 | 权威树读：`?parentId=&maxDepth=2&kind=` 分页/分块；返回节点数组（平铺+parentId，前端组树）+ workspace navVersion；管理视图含软删/未收纳标记。**不分页全量只在对账/管理开关下允许**（10 万节点保护，见 S10） |
| GET | `/api/v1/workspaces/current/menu` | 登录 | 菜单引用树 + shortcut 解析后的节点摘要（id/kind/name/iconName/resourceType/resourceId/state）；带 menuVersion |
| PATCH | `/api/v1/workspaces/current/menu` | manage_menu | 批量 diff 单事务：`{operations:[{op:"insert"|"update"|"delete"|"reorder", …}]}`（ARCH §9.3 形态），含容器/快捷项增删、别名、换容器、排序；服务端校验防环/层级/图标白名/nodeId 存在性；整单成功或 4xx 全拒 |
| POST | `/api/v1/nav/groups` | manage_menu | 建 group 节点（name/parentId/ord；config 留空） |
| PATCH | `/api/v1/nav/groups/:id` | manage_menu | 改名/排序 |
| DELETE | `/api/v1/nav/groups/:id?strategy=move|retain` | manage_menu | N6 删组：strategy=move 须带 targetParentId（组内实体节点迁走）；retain=组内内容变"未收纳"（父回落实体默认父：table→base 节点，doc→原 kb 树位），二次确认在前端 |
| GET | `/api/v1/nodes/:id/move-impact` | manage_menu | N6 预览：拟改 parentId 后，按**旧角色口径**受影响成员数（去重）、子树内容数、菜单引用数；M4 自动升级为并集口径 |
| POST | `/api/v1/nodes/:id/move` | manage_menu | body `{newParentId, confirmed:true}`；未带 confirmed 返回 409+impact 载荷（防误触）；执行 parentId 变更 + path 子树重写 + navVersion+1 + 审计 |

错误码沿用现网信封（`{error, code}` + HTTP 4xx），新增 code：`NAV_CYCLE`（400）、`NAV_DEPTH_EXCEEDED`（400）、`NAV_MENU_DEPTH`（400）、`NAV_NODE_IN_USE`（409，物理删时仍有 shortcut）、`NAV_GROUP_NOT_EMPTY`（409，需 strategy）、`NAV_RESOURCE_MISSING`（409，broken 引用操作）、`MOVE_NEEDS_CONFIRM`（409）。

---

## 5. 回填与对账（0 差异定义）

### 5.1 迁移拆分（两个只增目录）

- 迁移 A `20260916xxxxxx_enterprise_nav_ddl/migration.sql`：CREATE nav_nodes/menu_items/auth_policies + 索引 + workspaces ADD navVersion/menuVersion（常量默认 0，SQLite ALTER 友好）+ menu_items 两约束（自引用 FK cascade、node FK restrict）。
- 迁移 B `20260916xxxxxy_enterprise_nav_backfill/migration.sql`：纯幂等 DML，全部 `WHERE NOT EXISTS`/按唯一键防重；workspace 取 M2 播种的固定 `'ws_default'`。
- rollback SQL 另存 `prisma/docs/rollback/<ts>_enterprise_nav.down.sql`（DROP 三表；workspaces 两列旧 SQLite 不可 DROP，注明闲置无害）；主回滚路径 = flag off + 发布前快照。

### 5.2 实体节点回填映射（B 内 SQL，顺序固定）

1. **base 节点**：活 bases（deletedAt IS NULL）→ parentId=null，kind='base'，ord = ROW_NUMBER 按 created_at asc。
2. **kb 节点**：活 knowledge_bases → parentId=null，kind='kb'，ord 同序规则（created_at asc，排在 base 之后或独立 ord 空间；ord 同父内排序，base/kb 同为 L0 故统一按 (kind, created_at)：base 先 kb 后，常量排序）。
3. **table 节点**：活 tables → parentId=其 base 节点 id（JOIN nav_nodes base 行），ord 按 tables.created_at asc（与侧栏现状一致，tables.ts:50）。
4. **view 节点**：活 views 且 `order >= 0`（排除软删表隐藏的 order=-1 视图，tables.ts:193）→ parentId=其 table 节点，ord=views.order。
5. **doc/canvas 节点**：活 kb_docs（deletedAt IS NULL）：
   - canvas：parentId=其 kb 节点；
   - doc：parentId = 同库父文档存在且活时的父 doc 节点，否则其 kb 节点（LEFT JOIN 自连接映射，纯 SQL 可表达：先插全部 doc 节点（resourceId 即 kb_docs.id），再 UPDATE 自连接 nav_nodes 父子）；
   - ord 按 **updated_at desc**（复刻 KbTree 视觉序，kb.ts:305 + KbTree 组树顺序）。
6. path/depth 回填：节点插入后无法在纯 SQL 里轻易递归拼 path——用应用层脚本步骤（迁移内用 Node 脚本不行；migrate 只跑 SQL）。两个可选实现：
   - **方案 i（选定）**：path 在回填 SQL 中先插 parentId，path 初值 = 根节点 `'/'||id||'/'`；非根 path 由**对账/修复脚本首跑** `rebuildPathsTx` 全量重算（脚本在部署手册中作为迁移后必跑一步，幂等）。理由：实体深度小（base/table/view 3 层；doc 树 SQL 递归拼 path 方言风险高），path 是可重算派生数据。
   - 方案 ii（否决）：迁移 SQL 用 SQLite CTE 递归——违 M2 已定方言边界。
   - S2 验收把"deploy 后立即跑 scripts/nav/reconcile-nav.mjs --apply"作为部署步骤固化进 runbook；CI 干跑迁移后也跑该脚本断言 0 差异。
7. group 节点：无（存量无此概念）。

### 5.3 默认菜单回填（零入口丢失）

- 每个活 base：一个一级 `container`（label=base.name，iconName='database'，ord 同 base 节点），其下每个活 table 一条 shortcut（nodeId=table 节点，ord 同 table 序）。
- 每个活 kb：一个一级 `container`（iconName='book'），其下挂**根级** doc（parentId 为 null 的活 doc）与全部活 canvas 的 shortcut（与 KbTree 顶级视觉一致）；子文档不生成 shortcut（二级文档树从 tree 接口的节点子树呈现，不在菜单层复制层级——对 ARCH §3.3-4"复刻文档层级为容器嵌套"的裁剪，§12-10）。
- 不生成 view 级 shortcut（视图通过表页 TopBar/ViewTabs 到达，不是一级导航对象；菜单加视图留给后续需求，M3 有节点无默认引用）。
- 幂等键：menu_items 无业务唯一键，回填用"存在性相关子查询"防重（同 parent + type=shortcut + nodeId 已存在则跳过）。

### 5.4 对账脚本：差异分类与 0 差异定义

`scripts/nav/reconcile-nav.mjs [--apply]`，只读默认，输出 JSON + 人类摘要，exit code：有差异=1：

- **A 类（实体→节点缺失/不一致）**：每个活实体必须恰好有 1 个活节点，且 kind/parentId/name/ord 符合映射规则。
  - A1 缺节点；A2 多个活节点（违反唯一意图）；A3 父节点错（table 不挂其 base、doc 父不镜像 parentId 等）；A4 name 与实体不一致（改名漏同步）；A5 ord 不符排序规则；A6 path/depth 与 parentId 链不一致。
- **B 类（节点→实体悬挂）**：每个活系统节点的 (resourceType, resourceId) 必须能解析到活实体行：B1 实体行不存在（broken）；B2 实体软删而节点活（soft 漏同步）；B3 实体活而节点软删（restore 漏同步）。
- **C 类（菜单引用）**：C1 shortcut.nodeId 不存在/软删（broken/soft_dangling 计数）；C2 容器环或层级 >2；C3 iconName 不在白名单；C4 **零入口丢失**：每个活 table/根级 doc/canvas 至少被 1 条活 shortcut 引用（view/base/kb 不计此条）；C5 menu ord 同父重复（允许但报告，拖拽并发可产生，修复为稳定排序）。
- **0 差异**：A/B/C 三组计数全 0（C5 报告为 warning 不计阻断）。`--apply` 用 backfill.ts 同一套 upsert/修复原语（重建 path、补缺失节点、修正 name/ord、清理 broken shortcut 需显式 `--purge-broken` 才删，否则只报告），重跑幂等。
- 重复回填安全性：迁移 B 重跑（migrate deploy 已应用会跳过；对手动执行 SQL 的场景）与 reconcile --apply 连跑两次，第二次必须 0 变化（输出"no changes"）。

---

## 6. 切片总览与依赖

| 切片 | 标题 | 类型 | 主要触碰 | 对 641/33 基线影响 | 依赖 | 可并行 |
|---|---|---|---|---|---|---|
| S0 | M3 基线留证 + 导航/URL/删除语义 Characterization | 后端+文档 | docs/baseline；domain/nav/__tests__；web lib 测试 | 只增测试 | — | 与 S1 并行 |
| S1 | 迁移 A：nav_nodes/menu_items/auth_policies DDL + ws 两列 | 纯后端 | 1 迁移；schema.prisma 三 model+workspace 改；rollback SQL | 无（CI 干跑 14→15） | S0 | 先行阻塞 |
| S2 | 迁移 B：实体节点+默认菜单幂等回填 + path 重算脚本首跑 | 纯后端 | 1 迁移；domain/nav/{tree,backfill}.ts；scripts/nav/reconcile-nav.mjs（只读版先行） | 无 | S1 | S1 后立即 |
| S3 | nav 同步原语 + §4.4 全部写点事务接线 | 纯后端 | domain/nav/sync.ts；bases/tables/views/kb/records 五路由；hooks 失效 | **中敏**（动 5 个业务路由的写事务形态），S0 对拍保护 | S2 | 与 S5 准备并行 |
| S4 | 对账脚本 --apply/purge + 幂等/重复回填 + 异常库演练 | 纯后端 | scripts/nav；reconcile.ts；测试夹具 | 只增 | S2、S3 | S3 后 |
| S5 | v1 读 API：tree/menu GET + DTO/shared-types + flag 挂载 | 纯后端 | routes/v1/workspace.ts；config.ts；app 装配 | 无（新路由，flag off 404） | M2-S2（v1 骨架）、S2 | S2 后即可（可与 S3 并行） |
| S6 | v1 写 API：menu 批量 diff + group CRUD + move/impact + manage_menu 第四动作位 | 纯后端 | routes/v1/{workspace,nodes}.ts；domain/nav/menu.ts；系统 owner 动作种子补位迁移或启动幂等 | 无 | S5、M2-S5（角色求值） | 串行 |
| S7 | **openapi.yaml 首版冻结**（M2 org + M3 nav/menu/node） | 文档+校验 | docs/api/openapi.yaml；契约对拍测试（响应形状快照） | 只增测试 | **S6 后**；前端 S8 前 | 汇合点 |
| S8 | 前端新外壳骨架：WorkspaceShell/顶栏/左下设置区/flag 回退/通讯录入口收敛 | 前端 | features/workspace/*；App.tsx 路由分组；main 包壳；旧两壳保留 | web 只增；旧壳 flag off 路径回归 | S7 | S7 后与 S9 分段并行 |
| S9 | 一级导航渲染+编排器（N2/N4）+ 二级三分区列表（N3-P0）+ N6 预览模态 | 前端 | features/workspace/{PrimaryNav,NavComposer,SecondaryNav,MoveImpactModal}；client/hooks；icons 追加 | web 只增 | S8、S6 | S8 后 |
| S10 | 旧链兼容/别名 + AC-M3-1 对抗 + C-12 三态 + 画布 R10 回归 + 10 万节点首屏性能 | 混合 | routes/v1/__tests__；web 测试；造数脚本；RC 增补 | 只增测试 | S3、S9 | 收尾 |
| S11 | 出口收口：ADR/40RC/flag 生命周期/runbook/baseline 报告 | 文档+验证 | docs/adr、docs/baseline、docs/runbooks | 无 | 全部 | 收尾 |

关键路径：S0/S1 → S2 → S3 → S5 → S6 → S7 → S8 → S9 → S10 → S11（S4 在 S3 后并行收；后端两人时 S3 与 S5 可并行，因为文件集不重叠：S3 动旧路由，S5 只加 v1 新文件）。

**硬前置**：S5/S6 依赖 M2-S2（/api/v1 挂载与 requireActiveUser）落地；S6 依赖 M2-S5（角色/动作求值，manage_menu 判定）。派工时若 M2 延期，M3 后端片 S1-S4 可先行（不依赖 v1）。

---

## 7. 切片明细

> 每片统一给：新增/改动文件（具体路径）、要点与陷阱、独立验收命令、回滚。

### S0 — 基线留证 + Characterization 锁行为

**新增**
- `docs/baseline/2026-09-16-m3-baseline.md`：记录双基线（32f7bea=598/12 迁移；f8ddde3=641/14 迁移、shared 56、web 33）、Node/Hono/Prisma 版本、10 万节点目标（SPEC :134）。
- 后端 characterization（真库真迁移，仿 records-keyset 模式）：
  - `domain/nav/__tests__/characterization/entity-lifecycle-current.test.ts`：锁六类实体的建/改名/软删/恢复/物理删现状行为（含 views 无 deletedAt 物理删、table 软删 views order=-1、base/kb 软删无恢复、doc restore 清双字段），S3/S10 后复跑逐值不变。
  - `.../membership-list-current.test.ts`：锁 `/api/bases`、`/api/tables?baseId`、`/api/kb`、`/api/kb/:id/docs` 的 membership 过滤与排序（tables created asc、docs updated desc）。
  - `.../rbac-current.test.ts`：仿 M2 S0 锁 requireCan*/requireKb 矩阵（M3 后逐值不变）。
- web：`features/workspace/lib/__tests__/url-inventory.test.ts`（S8 才建目录，可放 `lib/__tests__/nav-urls.test.ts`）：把 §1.3 的 URL 形态清单固化为 internalHref/internal-links 的快照测试 + 一条"内部链接解析后仍以 /base//kb 为根"的断言（防 S8 误改协议）。
**验收**：`pnpm -w test` 全绿（api 641+N、web 33+M、shared-types 56 不变）。
**回滚**：删测试与文档。

---

### S1 — 迁移 A：三表 DDL + workspaces 两列

**新增/改动**
- `apps/api/prisma/migrations/20260916090000_enterprise_nav_ddl/migration.sql`：按 §4.1 建表/索引/FK（menu 自引用 cascade、node 引用 restrict）；workspaces ADD navVersion/menuVersion INTEGER NOT NULL DEFAULT 0。
- `schema.prisma`：+NavNode/MenuItem/AuthPolicy 三 model（AuthPolicy 上方注释"M3 冻结、M4 启用，禁止在 M3 写业务代码引用"），Workspace 增两列与反向关系；`prisma generate`。
- `prisma/docs/rollback/20260916090000_enterprise_nav.down.sql`。
**陷阱**：menu_items/node FK 方向与 onDelete 语义（RESTRICT 非 ARCH 草案的 CASCADE，§4.1-2 已注记）；SQLite ADD COLUMN 带常量默认合法；三表普通 rowid、INTEGER 0/1 布尔、无 SQLite 专有语法。
**独立验收**
```bash
T=$(mktemp -d); DATABASE_URL="file:$T/t.db" pnpm --filter @gx/api exec prisma migrate deploy
# 断言：15 个迁移目录；三表/索引/FK 存在；workspaces 两列默认 0；auth_policies 为空表
pnpm -w test   # 641+N 全绿（M2-S1 后基线）
bash scripts/ci-quality.sh
```
**回滚**：快照恢复 + down SQL；无任何代码读新表。

---

### S2 — 迁移 B：回填实体节点与默认菜单（幂等）

**新增**
- `migrations/20260916093000_enterprise_nav_backfill/migration.sql`：§5.2/§5.3 全部 INSERT...SELECT，带 `WHERE NOT EXISTS` 与活实体过滤；根节点 path 初值；非根 path 留脚本补。
- `domain/nav/tree.ts`（path 纯函数 + rebuildPathsTx）、`domain/nav/backfill.ts`（与 SQL 同规则的 upsert 实现，供脚本复用）。
- `scripts/nav/reconcile-nav.mjs`（本片刻只读 + `--apply` 的 path 重建与补缺；purge-broken 在 S4 补）。
- runbook 部署步骤："migrate deploy 后必须跑 reconcile --apply 重算 path"。
**要点**：canvas 恒顶级；doc 父映射用"先全插再 UPDATE 自连接"两步；ord 排序规则两实体不同（表 created asc / 文档 updated desc）；menu 防重子查询。
**独立验收**
```bash
# 旧库快照升级：节点数 = 活(base+kb+table+view(order>=0)+doc+canvas)；菜单容器数 = 活 base+活 kb
node scripts/nav/reconcile-nav.mjs --apply    # 首次：path 补齐
node scripts/nav/reconcile-nav.mjs            # 第二次：A/B/C 全 0、no changes
# 重跑迁移 SQL（手动）：行数零增长
```
**回滚**：新表数据清空（表是 M3 新增，TRUNCATE 无副作用）；快照恢复。

---

### S3 — 同步原语 + §4.4 全部写点接线（中敏）

**新增/改动**
- `domain/nav/sync.ts`：§4.4 表中全部 `*Tx` 原语（upsert/rename/softDelete/restore/purge/moveSubtree），内部 bump navVersion；menu 不动。
- 五路由按 §4.4 接线；#1/#3/#8/#11-13 涉及把裸多写**收紧进 withWriteTx/withWriteBatch**——这是本片刻唯一对旧代码的结构性触碰，每处单独 commit 语义清晰，S0 characterization 对拍。
- view 物理删（#10）与 table purge（#15）：shortcut 存在性检查，有引用抛 NAV_NODE_IN_USE 409（C-12：先清引用）。
- web：hooks.ts / kb-hooks.ts 资源 mutation onSuccess 追加 nav query 失效（仅在 flag on 时有消费者，失效空 query 无害）。
**陷阱**：table 软删后视图 order=-1：节点树状态以 table 节点软删为准（视图子节点连带软删），恢复时 views order 重排后节点连带 restore；doc move 必须重算子树 path（复用 tree.ts）；复制表不自动加菜单。
**独立验收**
```bash
pnpm -w test
# 新增：建/改名/删/恢复/移动实体后 reconcile 立刻 0 差异（每个写点一条真库测试）
# 视图物理删遇 shortcut → 409 NAV_NODE_IN_USE；清 shortcut 后删除成功
node scripts/nav/reconcile-nav.mjs   # 全套操作随机序列后 0 差异
```
**回滚**：每写点接线独立可 revert；表数据保留；紧急时 GX_ENTERPRISE_NAV=off 只摘新路由（不摘同步——同步无开关，因其与实体强一致且失败即回滚；若接线引发故障回退代码发布 + 快照恢复）。

---

### S4 — 对账脚本完工与异常库演练

- reconcile 增 B1 broken 清理（`--purge-broken` 连带删 shortcut，写审计 JSONL 复用 audit emit 需要脚本侧最小写入——脚本直接 append 同格式行并注明 actor='reconcile-script'）、C 类修复、C5 ord 稳定化。
- 造 3 个异常夹具：①手工删实体行模拟 broken；②把节点 name 改错；③复制 menu shortcut 制造多处引用后软删资源——分别验证报告/修复/幂等。
- 10 万节点前的小规模演演练（1k/1w）：reconcile 全表扫耗时留证（S10 扩到 10 万）。
**验收**：三夹具报告正确、--apply 后 0 差异、再跑 no changes。
**回滚**：纯脚本。

---

### S5 — v1 读 API（tree/menu）+ flag

**新增/改动**
- `config.ts`：`enterpriseNav: boolean`（GX_ENTERPRISE_NAV，on 默认，test on，可显式 off）。
- `routes/v1/workspace.ts`（GET tree/menu，§4.5 参数与 DTO）；`routes/v1/index.ts`（M2 文件）追加装配；app.ts 挂载条件与 M2 v1 合并：`if (config.enterpriseOrg || config.enterpriseNav) mount.route("/api/v1", v1)`，子路由内部按 flag 各自 404（或 v1 实例内条件挂载子路由）。
- shared-types 只增：NavNodeDTO/MenuItemDTO/MenuTreeDTO/NavKind/MenuOp 类型与图标白名单常量（icons.tsx 名称的后端镜像，单一真源放 shared-types）。
- 真库测试：tree 平铺→组树、menu 解析真名/别名、软删节点 state、10 万行保护参数（maxDepth/parentId 必传限制，全量请求 400 或 admin 显式 all=1）。
**独立验收**
```bash
pnpm --filter @gx/api test
GX_ENTERPRISE_ORG=off GX_ENTERPRISE_NAV=off pnpm --filter @gx/api test  # v1 全 404 模式
```
**回滚**：flag off 摘路由；新文件保留无害。

---

### S6 — 菜单写 + group + 移动影响预览 + manage_menu

- owner 系统角色补第四动作位：只增迁移 `UPDATE roles SET permissions='["manage_departments","manage_members","manage_roles","manage_menu"]' WHERE systemKey='owner' AND workspaceId='ws_default'`（固定 JSON 串，幂等）；自定义角色动作白名单（M2 S5 三处校验点）扩 manage_menu。
- `domain/nav/menu.ts`：operations diff 单事务应用（insert/update/delete/reorder）、容器环/2 层校验、iconName 白名单、shortcut nodeId 存在性；bump menuVersion。
- `routes/v1/nodes.ts`：group 三端点 + move-impact + move（§4.5）。影响预览 M3 口径：沿移动子树收集受影响实体（table/doc/canvas），按现有 members/kb_members 求**去重成员数**（owner/creator 豁免口径与 M4 对齐预留），返回 `{affectedUserCount, subtreeItemCount, shortcutCount, willBreakInheritanceHint:false}`（hint 恒 false，M4 才有继承语义——但 UI 文案按 N6 展示人数）。
- move 端点 confirmed 闸门 + 审计事件（nav_group_created/deleted、nav_node_moved、menu_changed）。
- 测试：同节点三处快捷项、别名、拖拽换容器、环拒绝、超层拒绝、坏图标 400、move 未确认 409、确认后 path 子树重写、reconcile 仍 0 差异。
**验收**：api 全绿；manage_menu 非授权写 403；owner 外系统角色 403。
**回滚**：新模块摘除；owner 动作位多一枚无副作用（M2 不消费该位）。

---

### S7 — openapi.yaml 首版冻结（契约汇合点）

- 产出 `docs/api/openapi.yaml`（OpenAPI 3.0.3，info.version=1.0.0）：覆盖 M2 全部 `/api/v1/org/*`（吸收 M2 draft 分册）+ M3 `/workspaces/current/tree|menu`、`/nav/groups`、`/nodes/:id/move(-impact)`、错误码全集、安全方案 bearerJwt。
- **写实原则**：响应 schema 按**现网真实信封**描述（成功资源本体/`{items,total,…}`/错误 `{error,code}`），不把未实现的 `{code:0,data,message}` 写进冻结契约（§10-5 待总监确认；若裁决要借冻结切信封，另开切片，不在 M3 偷渡）。
- 契约对拍：新增测试用真实路由响应做关键端点 schema 形状快照（非全量校验框架，零新依赖；用手写 JSON 形状断言），前后端以此为唯一联调依据；TS 类型由 shared-types 手工保持一致（openapi→TS 代码生成不引入，YAGNI，体量小）。
**验收**：yaml 可被任意标准 Swagger/Redoc 打开（CI 加一步 `node -e "require('js-yaml')..."`？——不引依赖：用现有依赖若有 yaml 解析则用，否则只做结构 grep 校验，列入 §10-5b）；对拍测试绿。
**回滚**：纯文档/测试。

---

### S8 — 前端新外壳骨架（含 M2 通讯录入口收敛）

**遵循 web 纪律**：只走 api/client.ts；无新依赖；图标只追加 icons.tsx；gx-* token；无 emoji。

**新增/改动**
- `features/workspace/WorkspaceShell.tsx`：四区骨架——顶栏（左 Logo+工作区名（LibrarySwitcher 收入下拉，UIUX :160）；中全局搜索（提权现有 SearchDialog，⌘K 不变）；右帮助/头像）、左 w-60 PrimaryNav 槽位（S9 填充）、左下设置/通用区、内容 Outlet；窄宽 <1024 左栏可折叠抽屉（M3 只做桌面三版浏览器，SPEC :133）。
- `App.tsx` 路由重组（路径不变，§3-1）：登录态统一包 WorkspaceShell 一组 `<Route>`，旧 `/base/*`、`/kb/*` 全部成为其子路由；**旧 AppShell/KbShell 文件保留**，由 `featureFlags.navV2`（启动时探活 GET menu：404→false）决定渲染新壳或旧壳；ErrorBoundary key 策略沿用现状（pathname）。
- 左下设置区：工作区设置中心页 `features/workspace/WorkspaceSettingsPage.tsx`（仿 SettingsPage 左二级+右内容）：M3 条目=通讯录（→ M2 的 `/workspace/contacts`）、导航编排（S9 全屏编辑器入口）、数据库与知识库（资产入口列表 → 跳各资产原设置页 `/base/:id/settings`、`/kb/:id/settings`，UIUX :224-229 映射表逐入口可达）；其余项（安全/备份/embedding/MCP）**不放假入口**或仅置灰"随版本提供"（§10-7）。
- **M2 收敛**：M2 S7 在侧栏底部加的通讯录临时按钮在新壳下移除，唯一入口为设置中心；M2 页面/路由/API 不动。flag off 旧壳仍显 M2 入口（M2 自己的回退姿态）。
- 全局搜索挂顶栏后两处旧侧栏搜索按钮在新壳隐藏（组件不删）。
- 纯函数：`features/workspace/lib/tree.ts`（平铺组树、激活态定位）、`featureFlags.ts`（探活缓存）。
**独立验收**
```bash
pnpm --filter @gx/web typecheck && pnpm --filter @gx/web build && pnpm -w test
# flag on：新壳可达全部旧内容 URL；flag off（后端 off）：自动回退旧两壳，视觉/路径与 32f7bea 一致
```
**回滚**：GX_ENTERPRISE_NAV=off 整壳回退；新文件不被旧路径引用。

---

### S9 — 一级导航 + 编排器 + 二级三分区（N2/N3-P0/N4/N6 UI）

- PrimaryNav：渲染 menu 树（容器 chevron 展开、shortcut 类型图标 table/doc/canvas、别名 + tooltip 真名（UIUX C12）、激活 3px 指示条沿用现视觉）；点击 shortcut 解析实体类型**navigate 到既有内容 URL**（/base/.../view 首视图、/kb/.../doc|canvas）；一级快捷项点击后二级定位其权威父容器（UIUX :75）。
- NavComposer（manage_menu 可见者）：容器/快捷项增删、添加实体选择器（复用 LibrarySwitcher 同款弹层 + 三类搜索）、内联重命名（别名）、grip 拖拽（HTML5 DnD，同 KbTree 防环前端拦一次）、"多处添加"、删容器二次确认（子项去向：移到其他容器/一并删引用，UIUX :311）；全屏编排复用为设置中心"导航编排"页（同组件两容器）。
- SecondaryNav：进入容器时第二栏，segmented [数据表 n｜文档 n｜画布 n]（KbTree 分段样式）；表分区列表来自 tree 节点（未收纳表也列出，标"未分组"，行 more 可"收纳到导航"）；文档分区按 nav 节点树（=parentId 镜像）可展开；列表内搜索（前端过滤 + 大列表走 q 参数，S5 tree 读支持 q）；N3 收藏/最近不做。
- 分组（N4）：建 group（容器内"新建分组"）、拖拽实体到组 = 调 move-impact → **BulkImpactConfirmModal 同款确认**（列去重人数/内容数，默认保留语义，PRD N6）→ move；菜单层拖拽不弹预览（AC-M3-1 后半句边界）。
- 空态/加载/broken 标灰（仅管理者可见清理按钮）；软删项全员隐藏。
- web 单测：组树、防环、快捷项映射、激活定位、排序纯函数（33+N）。
**验收**：typecheck/build/全测；手工 AC-M3-1 全链路预演（S10 自动化封口）；500 容器/节点拖拽帧率主观流畅。
**回滚**：组件级摘除回 S8 骨架（左栏暂显"导航编排随本片提供"空态），路由不受影响。

---

### S10 — 兼容/对抗/性能总验证

- **N5 回归矩阵**：§1.3 全部 32 文件链接点逐一手测/冒烟（含正文 internalHref 五种目标、画布 DocRefCard/GxLinkBlock、SearchDialog 跳转、ShareJoin 落地）；`/kb` 旧网格列表加 SPA 别名（新壳下可跳"知识库"二级聚合或保留原页为路由别名，一个迭代后删，UIUX C-11）；子路径部署构建（base=/app/gouxiangdb/）下新壳+API+跳转全通。
- **AC-M3-1 自动化对抗**（`routes/v1/__tests__/ac-m3-1.nav.test.ts` + 一组 web 测试）：
  1. 同一 table 经菜单加到 3 个容器；各容器拖拽排序/删除快捷项后，nav_nodes.parentId 与 base 归属不变、GET table 200、权限矩阵不变；
  2. 仅"移动到其他分组"改 parentId，必须弹影响预览（未确认 409），确认后 path 子树重写正确；
  3. 软删表→快捷项隐藏、reconcile 0 差异、回收站恢复→引用自动还原；视图物理删遇引用 409；
  4. doc 移动 parentId 后 nav 子树与 KbTree 双视图一致；
  5. 画布 R10：新壳打开画布→矩形/箭头/连线手势/右键菜单/参考卡跳转全通过（SPEC :144-146）；
  6. flag off 全链路回退旧壳；
  7. 旧匿名分享 /s/:token 在新壳外不受影响；
  8. 非 manage_menu 角色改菜单 403；M3 菜单对登录用户不剪枝（锁定本里程碑行为，M4 翻转点留注释）。
- **性能（SPEC :134 10 万节点）**：scripts 造 10 万实体节点（base/table/view/doc 按比例），`GET menu`（默认菜单只含被引用节点，远小于 10 万）P95 与首屏导航渲染 <1s（后端 ms 留证 + 前端 DOM 节点有界：虚拟滚动同 M2 模式或分页展开）；`GET tree?parentId=&maxDepth=2` 单次 P95 留证；EXPLAIN 关键查询走索引（parentId/path/resource 索引，无全表 SCAN）。
- RC 增补：在 `docs/baseline/2026-09-12-regression-cases.md` 追加 M3 RC 组（旧链/画布/两壳回退/正文内链），40 RC 全量复跑。
**验收**：上述全绿；结果入 `docs/baseline/2026-09-16-m3-gate.md`。
**回滚**：纯测试/脚本。

---

### S11 — 出口收口

- ADR（docs/adr/）候选见 §8；40 RC + S0 characterization 复跑逐值绿。
- openapi.yaml 与 shared-types/真实响应对拍无 diff；`docs/api/` 下补一份"枚举/错误码表"。
- flag 生命周期文档：GX_ENTERPRISE_NAV 稳定一个迭代后随 M4 或下一期删旧壳与 off 分支（PRD :258 承诺保留一个迭代）；菜单不剪枝的 M4 翻转点写入 M4 输入清单。
- runbook 增章："导航树差异排查与 reconcile 执行"、"菜单丢失/实体找不到（0 入口丢失校验）"、"新壳回退旧壳（flag）"、"move 误操作恢复（快照指引）"。
- baseline 收口：测试计数、迁移数 14→16、10 万节点性能、升级演练（v0.1.0 风格库 → deploy → reconcile → 菜单零丢失抽样）。

---

## 8. 关键设计决策（ADR 候选）

- **ADR-0025 权威节点层 vs 菜单引用层**：记录两表拆分、shortcut 可重复/nodeId 非唯一、唯一父级决定 M4 继承边界；AC-M3-1 两类拖拽的分流（菜单拖拽零副作用 vs 权威移动走预览）；menu→nav RESTRICT FK 的取舍（对 ARCH Cascade 的覆盖理由）。
- **ADR-0026 nav_nodes 物化 path（与 M2 部门树同构）**：parentId 真相 + path 派生、32 护栏、否决闭包表/CTE、doc 子树移动重写、path 由对账脚本可全量重建（派生数据定位）。
- **ADR-0027 内容 URL 不可变 + 外壳别名策略**：内部链接已落库（正文/画布/分享），资源身份即 URL；N5 以"不改名 + 外壳级 SPA 别名 + 双壳 flag 回退"实现，而非 UIUX §5 的 /w/node 新路径；列出被否决方案（全量新 URL + 301：服务端 SPA 无 301 落点、存量正文链接全部失效或需双解析）。
- **ADR-0028 删除悬挂三态（C-12）**：alive/soft_dangling/broken；软删保留引用（恢复自动还原）、物理删 RESTRICT 先清引用、broken 管理员显灰可清理并入审计；现状删除语义不对称清单（view 物理删、base/kb 无恢复、table order=-1）作为附件。
- **ADR-0029 M3 不做权限剪枝 + openapi 写实信封**：与 M2 同纪律（空跑一层）；菜单全员可见、数据守卫照旧；M4 翻转计划；冻结契约描述真实响应（待 §10-1/§10-5 裁决后定稿措辞）。
- **ADR-0030（候选）实体范围：六类节点，无 field 节点**：view 建节点、field 不建（fieldMask 承载字段权限）；kb 建节点（覆盖 ARCH "kb 退化属性"草案）；M4 若证伪的只增回填路径。

---

## 9. 对 641/33 基线的影响面与保护（shared-types 56 同护）

| 触碰源 | 切片 | 保护 |
|---|---|---|
| 三新表 + ws 两列迁移 | S1/S2 | 只增；CI 临时库干跑 14→16；现有查询不读新表 |
| 5 个业务路由写事务接线 | S3 | **中敏**：S0 characterization 对拍；每写点独立测试 reconcile=0；事务形态收紧（裸多写→withWrite*）本身修一致性隐患，行为等价 |
| roles owner 动作 +manage_menu | S6 | 只增一枚动作位；M2 不消费即无效果；自定义角色白名单只增 |
| /api/v1 新路由 + 新 flag | S5/S6 | flag off 不挂载；旧 /api 零 diff；限流选择器按 /api/ 前缀自动覆盖 |
| 审计事件名只增 | S6 | 联合类型只增；现有 6 事件不变 |
| 前端新外壳 | S8/S9 | 旧两壳文件保留、flag 回退；App.tsx 路由路径不变只换布局组件；client/hooks/queryKey 只增；web 33 只增 |
| shared-types 只增 | S5/S7 | 不动现有 Role/PermissionSet/ViewConfig |
| 全局搜索提权 | S8 | SearchDialog 组件原样挂顶栏；旧侧栏入口在新壳隐藏、旧壳保留 |

统一回归口令（每片 PR 必贴，同 M2）：
```bash
pnpm -w install --frozen-lockfile
pnpm --filter @gx/shared-types build
pnpm --filter @gx/api typecheck && pnpm --filter @gx/web typecheck
pnpm -w test            # api 641+N / 3 skipped、web 33+M、shared-types 56 不变，只许增不许转红
pnpm --filter @gx/api lint
bash scripts/ci-quality.sh
```

预计新增测试：S0 ~20、S1/S2 迁移回填 ~16、S3 写点同步 ~22、S4 对账 ~10、S5 读 API ~14、S6 写 API/预览 ~24、S7 契约对拍 ~8、S8/S9 web 纯函数/flag ~14、S10 对抗/性能 ~18（api 641 → 约 +130~160，以实现为准）。

---

## 10. 外部输入清单（需总监裁决，不阻塞 S0-S4，阻塞对应合入）

1. **M3 菜单是否按旧角色剪枝**：PRD N2/PRD M3 行写"过滤先按旧角色跑"，主理人口径"权限先不 enforce，可见性留 M4"。本计划按**不剪枝**（登录见全量菜单，数据 API 旧守卫不变），AC-M3-1 不涉剪枝。若裁决 M3 必须粗剪，S5 增加一层旧成员口径过滤（members/kb_members/kb_doc_acls 三源），工作量 +1 片且与 M4 有返工。
2. **URL 方案**：建议内容深链 `/base/:id/...`、`/kb/:id/...` 永不改名、工作区级才用 `/workspace/*`（ADR-0027）；UIUX §5 建议过 `/w/node/:nodeId`。请确认不引入内容新路径。
3. **view 建节点、field 不建节点、kb 建节点**（对 ARCH §3.1/§3.3 的三处覆盖，§0-2，ADR-0030）。
4. **默认菜单不嵌套复刻文档树**（二级文档树走 nav_nodes 子树；ARCH §3.3-4 原文是容器嵌套），确认。
5. **openapi 信封口径**：冻结 spec 按真实响应 `{error,code}`/资源本体写实（建议），还是借冻结把 v1 切到 `{code,data,message}`（需同步前端解析，建议另开切片，M3 不做）。
5b. openapi 校验是否允许引入 swagger 解析依赖做 CI 校验（建议不引，手写形状对拍）。
6. **base/kb 软删无恢复端点**：现状如此（bases.ts:212、kb.ts:199 均无 restore）。M3 不补恢复（导航跟随软删）；全局回收站聚合为 P1。确认。
7. **工作区设置中心首版条目**：建议仅 通讯录 / 导航编排 / 资产设置入口；安全/备份/embedding/MCP 不放假入口。确认占位策略。
8. **收藏/最近访问（N3 P1）确认不做**；二级只做三分区+搜索。
9. **nav 同步与实体写的强度**：默认强一致（同事务共生死）；备选 best-effort+审计（不阻断主业务）。建议强一致（规模小、有对账兜底）。
10. M3 排期与 M2 的咬合点确认：S5/S6 硬依赖 M2-S2/S5；若 M2 出口晚于 M3 启动，先做 S1-S4（纯旁路表，不需要 /api/v1）。

---

## 11. M3 出口 Definition of Done（摘）

1. AC-M3-1 自动化全绿：同一资源多处菜单引用下，快捷项拖拽/删除不改权威父级与权限结果；仅"移动到其他分组"改 nav_nodes.parentId 且必经影响预览+确认；移动后子树 path/权限边界（M3 口径=旧成员可见性）正确。
2. 回填对账：v0.1.0 风格旧库升级后 A/B/C 三类差异 0；默认菜单零入口丢失（每个活表/根级文档/画布可达）；迁移与 reconcile 重跑幂等；10 万节点 menu 首屏 <1s 有留证、关键查询无全表 SCAN。
3. N5：§1.3 全部旧链接在新壳可达，操作步数 ≤ 旧版 +1；正文内链/画布引用/匿名分享抽样 0 损坏；flag off 一键回退旧两壳；子路径部署验证通过；画布 R10 回归全过。
4. 三新表只增迁移在干净库/旧库快照均可 deploy；auth_policies 全里程碑零写入（有断言）；旧 RBAC 矩阵与 40 RC 逐值不变；641+N/33+M/typecheck/lint/ci-quality 全绿。
5. openapi.yaml 冻结并与真实响应/TS 类型对拍无 diff；ADR-0025~0030 归档；runbook/baseline 齐备；manage_menu 第四动作位 owner 默认持有、非授权 403。
6. 边界用例全自动：菜单环/超层 400、坏图标 400、shortcut 指向缺失 400/标 broken、视图物理删遇引用 409、移动未确认 409、删组未选 strategy 409、doc 移入自身子树 400。

---

## 12. 现状核对后与旧文档/所给锚点的不符与澄清

1. **M2 落地进度（本文档期间发生基线移动）**：派工时点 32f7bea 无 `routes/v1`、无组织表；截至 f8ddde3，**M2-S0/S1 已落地**——workspaces/departments/dept_members/roles/role_assignments 五表与 users 六列（status/workspaceId/tokenVersion/disabledAt/inviteTokenHash/invitedAt）、固定 id `ws_default`/`role_owner` 已由迁移 20260915090000/20260915090100 播种（`schema.prisma:376` 起为组织 model；Workspace 当前仅 policyVersion，navVersion/menuVersion 仍缺，由 M3-S1 补）。**`routes/v1` 目录与 GX_ENTERPRISE_ORG flag 仍不存在**（M2-S2 进行中）。M3 的 S5/S6 以 M2-S2/S5 为硬前置；S1-S4 只依赖表与 ws_default，已可开工。
2. **workspaces 现状只有 policyVersion**（`schema.prisma:379` 实查）：M2 按其计划 S1 刻意只建此列（M2 文档 :335 YAGNI 注记），navVersion/menuVersion 由 M3-S1 以只增迁移补。
3. **openapi 文件全仓不存在**（glob `**/openapi*.y(a)ml"` 无命中；M2 的 openapi 仅是计划中的 draft 分册，未落盘）。M3 S7 是首版。
4. **v1 挂载点行号**：M2 计划说"app.ts:136 后条件挂载"——现 app.ts:136 正是 `mount.route("/api", api)`，:140-142 是 SPA 兜底；v1 必须在 :136 之后、SPA 之前插入，且 flag 合并挂载条件（S5 已写明），basePath 双副本（:162-164）自动覆盖。
5. **views 无软删列**（schema.prisma:164-178）：删除是物理删（views.ts:186 `prisma.view.delete`），table 软删时视图不打 deletedAt 而置 `order=-1`（tables.ts:193），table 恢复时 order 重排（records.ts:1086-1090）。nav view 节点生命周期必须照此三态接线，ARCH §3.1-2"删表/删字段软删→节点 isSystem 隐藏"的笼统描述对 view 不成立。
6. **base/kb 软删没有恢复端点**（bases.ts:212-218、kb.ts:199-211；grep 全路由无 base/kb restore）；table/field/record 的恢复在 records.ts:1027 回收站，doc 恢复在 kb.ts:607。nav"软删自动还原"只对 table/doc 成立，base/kb 只能靠快照。§10-6 请总监确认不补。
7. **ARCH §3.1 树层次含 field 节点、§3.3-3 回填 field**，SPEC §6 与派工的实体枚举是"base/table/view/kb/doc 等"且字段权限走 fieldMask——本计划裁掉 field 节点（ADR-0030），避免节点数 ~10x 膨胀且 M4 不消费。
8. **ARCH §3.1-4/§3.3 把 kb 退化为"kbId 属性/系统分组"，不建独立节点**；派工明确 kb 是实体类型之一，且 UIUX 一级导航收纳知识库需要可点容器客体。本计划建 kb 节点（doc/canvas 的权威父），覆盖 ARCH 该点。
9. **文档排序口径**：侧栏表列表按 `createdAt asc`（tables.ts:50），KbTree 视觉序实际是 `updatedAt desc`（kb.ts:305 + 前端按返回序组树，KbTree.tsx:20-33）。回填 ord 已分别对齐，ARCH/UIUX 未给此细节。
10. **ARCH §3.3-4 要求菜单回填"复刻文档层级为容器嵌套"**：本计划改为菜单只挂根级、层级由 nav_nodes 子树在二级呈现（每文档一个容器行既无意义又放大 menu_items 行数，且容器不承载授权）。见 §10-4。
11. **ARCH §3.4 的级联用 onDelete Cascade 清 shortcut**：本计划改 RESTRICT + 显式清理事务（§4.1-2），以强制 C-12 可解释性；软删不走数据库级联（要保留引用待恢复）。
12. **菜单剪枝口径冲突**：ARCH §3.1-5/§3.4 读接口按引擎 can() 剪枝、空容器隐藏；M3 时引擎不存在（M4 才有），PRD M3 行说"先按旧角色跑"，主理人指示"先不 enforce"。本计划按主理人：不剪枝，行为翻转写进 M4 输入（§10-1）。
13. **UIUX §5 路由建议**（/w/node、/contacts、/settings/workspace）与 M2 已定的 `/workspace/contacts` 不一致；本计划统一为 `/workspace/*` 工作区级前缀，资产内容路由保持旧形（ADR-0027）。
14. **现状无工作区级设置/回收站聚合**：左下设置是资产级（Sidebar.tsx:251、KbSidebar.tsx:106），两个 TrashPage 分属 base/kb。N1 设置收敛在 M3 只做"入口收敛 + 资产设置可达"，不搬迁资产设置页（UIUX :220-234 同口径）。
15. **M2 owner 系统角色只播种三枚动作**（M2 计划 §5-A）：manage_menu 是 M3 新增的第四枚，S6 用只增迁移补到 owner；自定义角色动作编辑器白名单同步扩位。
16. **测试基线在编写期间移动一次，已复核**：32f7bea（2026-09-14）= 598/3（47 文件）、web 33、迁移 12；f8ddde3（M2-S0/S1 后，2026-09-16 复跑）= **641/3（51 文件）、web 33、shared-types 56（4 文件）、迁移 14**。本文计数以新基线为准，旧数字仅在 baseline 双记录中保留。
17. **全局搜索是 membership 逐表有界预览**（search.ts:47 起，ADR-0005 口径），不读 nav；M3 只把入口提权到顶栏，搜索逻辑一行不动（M5 替换）。
18. **图标现状**：icons.tsx 已有 table/database/book/doc/canvas/group/star/clock/external/users 等 100 枚；缺 grip 与专用 folder 语义（group 图标当前语义偏字段分组），S8/S9 在同文件追加，不引库。

---

## 13. 切片速查（供派工 / RoleVerdict）

| ID | 标题 | 关键文件 | 独立验收（一句话） | 跨端 |
|---|---|---|---|---|
| S0 | 基线+特征测试 | docs/baseline/2026-09-16-m3-baseline.md；domain/nav/__tests__ | 641/33/56 全绿，锁实体生命周期/成员列表/RBAC/URL 清单 | 否 |
| S1 | 三表 DDL+ws 两列 | 迁移 A；schema.prisma；down SQL | 干净库 deploy 15 迁移成功，641 基线全绿 | 否 |
| S2 | 实体/菜单回填 | 迁移 B；domain/nav/{tree,backfill}.ts；scripts/nav/reconcile-nav.mjs | 旧库升级节点/菜单数与实体精确一致，重跑 0 变化 | 否 |
| S3 | 写点同步接线 | domain/nav/sync.ts；bases/tables/views/kb/records 五路由 | §4.4 全部写点操作后 reconcile 0 差异，旧 characterization 逐值绿 | 否 |
| S4 | 对账完工+异常库演练 | reconcile.ts；脚本 | broken/改名/多引用三夹具可报告可修复且幂等 | 否 |
| S5 | tree/menu 读 API+flag | routes/v1/workspace.ts；config.ts；shared-types | 登录可读树/菜单，flag off 404，旧 /api 零影响 | 否 |
| S6 | 菜单写/group/move+manage_menu | routes/v1/nodes.ts；domain/nav/menu.ts；动作位迁移 | 多处引用/别名/拖拽/防环/409 预览全正确，非授权 403 | 否 |
| S7 | openapi 首版冻结 | docs/api/openapi.yaml；契约对拍测试 | M2+M3 端点全覆盖且与真实响应形状一致 | 否 |
| S8 | 新外壳骨架+设置收敛+通讯录并入 | features/workspace/*；App.tsx；featureFlags | flag on 新壳达全部旧 URL；off 自动回退旧两壳 | **是** |
| S9 | 一级导航/编排器/二级三分区/N6 模态 | PrimaryNav/NavComposer/SecondaryNav/MoveImpactModal | N2/N3-P0/N4/N6 端到端可用，AC 预演通过 | **是** |
| S10 | 兼容/对抗/画布/10 万性能 | v1 __tests__；web 测试；造数脚本；RC | AC-M3-1 八条全绿、旧链 0 损坏、menu 首屏 <1s、无 SCAN | 混合 |
| S11 | 收口 | ADR-0025~0030；40RC；runbook；baseline | RC/characterization 逐值绿、升级演练 0 丢失、文档齐备 | 否 |
