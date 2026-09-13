# GouXiangDB Phase 1 企业版技术架构：统一资源树、组织架构、统一权限引擎、向量语义检索与带鉴权 MCP

- 日期：2026-09-12
- 作者：架构师 高见远
- 状态：Proposed（待项目总监大湾区靓仔拍板）
- 适用基线：`main` @ v0.1.0（pnpm monorepo：apps/api Hono+Prisma、apps/web React18+Vite、apps/desktop Tauri2）
- 与已有方案关系：`ARCH-production.md`（容量/私有部署/四支柱）整体保留，作为本文的 **M0-M1 底座子集**（其 P0-P3 阶段在本文统一记为 M0-M1）。本文不重复其容量重写、备份、部署双轨结论，只引用衔接点。
- MCP 接入调研归档：`SPIKE-workbuddy-integration.md`（research-workbuddy，2026-09-12）作为**历史调研文档**保留，记录早期面向特定平台的接入勘察；按裁决 R-MCP-2，本期不再以其为实施输入——M6 交付协议无关的标准 MCP server，详见 §8.6。
- 证据约定：本文所有"现状"陈述均引 `文件:行号`，设计章节无行号引用处为新设计。

---

## 0. 结论先行（TL;DR）

1. **统一资源树是六支柱的承重墙，导航引用与权威节点分两层**：新增一棵以 `nav_nodes` 为唯一真源的**权威资源树**（工作区 → 资源挂载节点 → 列表 → 分组 → 字段），授权与继承只认这棵树：每个资源在同一工作区有唯一父级（`UNIQUE(workspaceId, resourceType, resourceId)`）。导航菜单是独立的**引用层 `menu_items`**（容器/快捷项，字段 `nodeId` 引用 nav_nodes，可同资源多处添加、可起别名、可拖动、可删快捷项而不删资源），菜单编排不改变权威父级与继承边界（对齐 PRD N2/C-1 与 UIUX §1.1"导航是引用/编排层"）。现状里"导航"（前端按 `tables` 列表和 `kb_docs.parentId` 各拼一棵树，`Sidebar.tsx:134`、`KbTree.tsx:20`）与"授权"（`members`/`kb_members`/`kb_doc_acls` 三套表）是两套漂移的数据，企业版必须把授权收口到权威树，把灵活编排留给引用层，否则"菜单自定义"和"细粒度权限"永远对不齐。
2. **权限引擎为纯 allow 三源并集，收窄靠继承开关不靠 deny**（对齐 PRD D-2/O8/C-6/§12）：主体有效权限 = 角色授权 ∪ 部门授权（沿部门物化路径向上继承）∪ 资源树直接授权，三路全部表达为同一张 `auth_policies` 表（**无 effect 列，恒为 allow**），客体一律是权威节点 `nav_nodes`。默认只增不减（沿用现状取较高角色的语义，`kb.ts:54-55`）；"无 allow 即拒绝"，**不引入对主体的显式 deny，收权靠移除授予来源**。单文档/画布"对个别继承主体收紧/私密"用内容叶子节点属性 `inheritAncestors`（默认 true）表达：判定该节点时只收集「节点直接 allow ∪ 创建者/owner 与 workspace_admin 兜底」，不再收集上层分组/库继承策略；组内重新分享 = 对该节点加直接 allow。字段隐藏/只读是 allow 策略上的 `fieldMask` 能力裁剪，不是 deny 主体。统一权限面板与现有单文档权限弹窗（`DocAclModal.tsx`）写同一张表，双向同步问题在数据层消失，只剩一个聚合视图。
3. **细化到库/表/分组/字段 × CRUD**：库/表是真实树节点；字段叶节点由 `fields` 表自动同步，读做列掩码、写拒绝越权字段键；"分组"在现状里不是实体（只是视图配置 `groupByFieldId` + 运行时计算，`shared-types/src/views.ts:101`、`domain/group.ts:31`），企业版把它建成**条件策略节点**（tableId+fieldId+桶值），引擎在查询时注入行级过滤条件、写时校验记录所属桶，不复制记录数据。
4. **向量检索全部是可重建的派生数据，主写链路零等待**：写事务只多写一行 `change_event`（outbox），同进程 worker 异步完成 FTS5 索引与向量化，失败退避重放。embedding 双模式可配置（`EMBEDDING_MODE=local|cloud|off`）：本地默认用 `@huggingface/transformers` + `Xenova/bge-small-zh-v1.5`（512 维、q8 ONNX 约 30-100MB、CPU 单句毫秒级、Worker 线程隔离、模型文件随包预置不出内网）；云端走 OpenAI 兼容 `/v1/embeddings`，key/baseURL/model 可配。向量库选 **sqlite-vec 0.1.x 旁路派生库**（better-sqlite3 连接，不经 Prisma），FTS5 用 **trigram 分词器**解决中文子串（1-2 字短词回退 LIKE），两路结果 RRF 融合；embedding 不可用自动降级为纯 FTS5。向量阶段第一天做本地中文 embedding spike（M5 首日，编号已对齐 PM 冻结表 M0-M7，见 §10.2）。
5. **MCP 是权限引擎的第二个客户端，不是旁路**：单 server（`@modelcontextprotocol/sdk` 1.x）同进程双传输——Streamable HTTP（stateless，挂 Hono `/mcp`，内网/远程）+ stdio（独立入口，本机），共用同一 tool registry。**可发现性与可执行性分离双闸门（裁决 R-MCP-1）**：`tools/list` 按账号有效权限动态过滤（仅在至少一个资源上持对应动作位的工具才出现、schema 随资源/字段收窄），操作逻辑说明书（三套机器语言的纯语言文档，经 MCP Resources 只读承载）对所有连接者可发现；**执行期每个 tool 在 service 首行强制过统一鉴权**，模型传入的资源参数一律不可信，被裁工具直调返回"不存在"口径、参数内越权二次拦截。鉴权先用每用户 PAT（设置页生成、hash 存储、可吊销），OAuth 2.1+PKCE 端点按标准规范预留/同阶段可选（是否进 M6 必做见 §13 第 4 条）。两套机器操作语言分别锚定现有 KB Block 模型（`blocks.ts`，含 `<!-- align -->` 注释约定 `blocks.ts:569-586`）与 Plait 板模型（元素数组、`children` 数组序即 z 序 `canvas-ops.ts:551-552,662-669`、3×2 网格 `canvas-ops.ts:381-411`、显式 id 取代前端 WeakMap 选区、不触碰 WebKit 补偿层），全部写操作携带 `contentVersion` 乐观锁（现状 409 机制已在 `kb.ts:426-438`）。
6. **最高风险**：统一鉴权替换现状三套并存的守卫（bases/records 侧 `guards.ts:66-95`、kb 侧 `kb.ts:40-60`、search 侧手工成员过滤 `search.ts:57-122`）是跨全部路由的高回归面改造；缓解方式是"引擎并行实现 + feature flag 双跑对拍 + 只增迁移 + 发布前快照"，且存量 `members`/`kb_members`/`kb_doc_acls` 全部回填为 `auth_policies` 行后旧守卫才允许下线。次高风险：sqlite-vec 仍为 0.1.x pre-v1 与 transformers.js 在内网低规格 x64 机的离线加载/内存占用，均有零新组件兜底（纯 JS 余弦、纯 FTS5）。

---

## 1. 现状核实（代码事实，逐条引行号）

### 1.1 账号与成员：三套互相独立的 RBAC

| 事实 | 证据 |
|---|---|
| 账号只有平铺 `users`，无工作区/组织/部门/停用概念 | `apps/api/prisma/schema.prisma:182-200`（无 status/workspaceId 字段） |
| Base 成员关系 `members`，5 角色 owner/creator/editor/commenter/viewer，唯一键 (baseId,userId) | `schema.prisma:202-215`；角色权限矩阵 `packages/shared-types/src/permissions.ts:33-69` |
| 知识库成员关系 `kb_members`，4 角色（无 creator） | `schema.prisma:264-277` |
| 单文档/画布独立授权 `kb_doc_acls`，仅 editor/commenter/viewer | `schema.prisma:333-346` |
| 有效角色 = 知识库角色与文档 ACL **取较高者**（只增不减语义） | `apps/api/src/routes/kb.ts:38,49-60` |
| 账号注销已有"唯一 owner 拒绝"保护，删除级联带走全部成员关系 | `apps/api/src/auth.ts:194-225` |
| JWT HS256，7 天有效期，生产缺密钥 fail-closed | `auth.ts:26-41` |

### 1.2 鉴权守卫：三套并存，无统一入口

| 通道 | 实现 | 证据 |
|---|---|---|
| bases/tables/fields/records/views 路由 | `requireCanView/EditData/ManageSchema/ManageBase/Comment`，逐路由手工调用 | `guards.ts:66-95`；调用密度 records.ts 24 处、bases.ts 14 处、tables.ts 11 处、fields.ts 7 处、views.ts 7 处（grep 统计） |
| kb 路由 | 路由文件内自建 `requireKb/requireDocAccess/kbRoleOf/docAclRoleOf` | `kb.ts:22-60`，文件内 26 处调用 |
| 全局搜索 | 不走任何守卫抽象，手工查 members/kbMembers 后循环过滤 | `search.ts:57-61,119-123` |
| 公开分享 | 完全独立的匿名通道，token 即凭证 | `routes/public.ts:1-60` |

结论：企业版"API/MCP 共用统一鉴权入口、禁旁路"需要替换的就是上述四个触点；现有守卫签名稳定、调用点集中，适合适配层灰度，不需要重写路由业务。

### 1.3 导航：两棵前端拼装的树，不是数据实体

- 数据表侧栏直接遍历 `tables` 列表渲染，无分组/无文件夹：`Sidebar.tsx:130-188`；库切换靠 `LibrarySwitcher`（base 与 kb 平铺）：`LibrarySwitcher.tsx:27-58`。
- 知识库树在前端由 `kb_docs.parentId` 数组内存构建（`buildDocTree`），文档可层级、画布平铺：`KbTree.tsx:20-25,74-75`；后端父子完整性仅应用层维护、移动有防环：`kb.ts:69-108,453-487`。
- "分组"是视图运行时概念：视图配置只存 `groupByFieldId`（`shared-types/src/views.ts:101`），桶由 `computeGroups` 按字段值实时算出（`domain/group.ts:14-60`）。数据库里不存在"分组"实体。
- 字段是真实实体（`fields`，`schema.prisma:54-118`），软删 `deletedAt`。

### 1.4 文档/画布内容契约（MCP 机器语言的锚点）

- 存储：`kb_docs.content`（doc=Markdown，canvas=PlaitElement[] JSON），`searchText` 冗余纯文本，`contentVersion` 乐观锁，10MB 上限：`schema.prisma:279-313`、`kb.ts:403-449`。
- 乐观锁：PUT 携带 baseVersion 条件更新，冲突 409 + currentVersion；前端持久层已实现版本跟随与 409 处理：`kb.ts:426-438`、`useDocPersistence.ts:79-92,140-148`。
- 文档块模型：`Block` 含 id/type/text/checked/align 等；对齐只能序列化为紧邻内容前的 HTML 注释 `<!-- align:center|right -->`，不得发明新存储字段：`blocks.ts:31-63,569-586,865-868`。
- 画布板模型关键不变量：
  - 自定义数据挂元素自定义键（`gxNote/gxDocRef/gxLinkRef`），plait normalize 不剥离：`canvas/types.ts:1-13,15-58`；
  - 关联块为透明 rectangle 承载（280×160），自动定位走可见区 **3 列×2 行网格、gap 40、超 6 张 cycleShift 60**：`canvas-ops.ts:368-411`；
  - 插入路径 = `[board.children.length]`：`canvas-ops.ts:450-451`；
  - z 序唯一真源是 `board.children` 数组顺序，四类重排只走 ZIndexTransforms：`canvas-ops.ts:551-552,662-669`；
  - 实时选区在前端 `BOARD_TO_SELECTED_ELEMENT WeakMap`，右键菜单只改 WeakMap 不发 op：`canvas-ops.ts:677-680`；
  - WebKit 白卡补偿是渲染层（foreignObject 挂同层补偿 g、随 viewBox 原点平移）：`LinkBlockForeignObject.tsx:21-27,138-175`。
- 画布为非受控组件，外部整体替换靠 `key` 重挂载：`DrawnixCanvas.tsx:11-14,37-40`。MCP 走服务端读-改-写，不经过该组件，但写出的 JSON 必须仍满足上述数据层不变量。
- 画布纯文本抽取已存在递归实现：`domain/kb.ts:28-57`；Markdown 去标记：`domain/kb.ts:7-21`。

### 1.5 搜索现状与数据库工程约束

- 全局搜索是"成员库循环 + 每表最多扫 2000 行 + JS `includes`"，文档侧 `contains`：`search.ts:46-152`。容量问题已在 ARCH-production §1.3 定性，本文不重复。
- Prisma 5.22 + SQLite，单连接、WAL、busy_timeout=5000：`db.ts:30-37`。Prisma 无法加载 SQLite 扩展（FTS5/vec0），ARCH-production 已锁定 better-sqlite3 13.0.3 旁路连接预案（该包已在 apps/api devDependencies 锁定，非新增）。
- 迁移为 Prisma migrate SQL 文件，已有 SQLite 重建表式迁移先例（defer_foreign_keys + new table + copy）：`migrations/20260908023042_add_doc_tree_and_share/migration.sql`。

---

## 2. 边界、约束与总体架构

### 2.1 已拍板边界（2026-09-12 team-lead 派工，不再讨论）

1. **embedding 双模式可配置**：本地默认、云端可选；另加 `off`（仅 FTS5）作为降级/测试模式。
2. **权限 = RBAC 角色 ∪ 部门归属 ∪ 资源树直接授权，取并集**。
3. **菜单自定义仅工作区级**（管理员维护，全员同一套菜单按权限剪枝）；本期不做用户个人级菜单。实现上分两层：**权威资源树 `nav_nodes`**（唯一父级决定继承）+ **导航引用层 `menu_items`**（同一资源可被多个菜单项引用、可起别名、可多处添加；引用不改父级、不承载授权），见 §3.1/§3.4（对齐 PRD N2/C-1、UIUX §1.1）。
4. **本期无原生 AI，只交付标准 MCP server（裁决 R-MCP-2）**：M6 的 MCP 是协议无关标准件（Streamable HTTP + stdio 双传输、PAT/OAuth、双闸门），任何第三方标准 MCP 客户端（含 Claude Desktop、Cursor、ChatGPT 类客户端、客户自研智能体，WorkBuddy 仅为其中之一）均可接入，不为单一平台定制；本期不内置任何聊天 UI、不做服务端模型编排/对话面板，未来 AI 产品形态另行立项，复用同一套 service/tool-core。

### 2.2 P0 工程纪律在本方案的落地

- 图标：全项目继续锁定**自建 SVG 图标集** `apps/web/src/components/icons.tsx`（`IconName` 联合 + `PATHS` 单一映射，`icons.tsx:7,108`），新图标在同文件追加 path；企业版新页面（通讯录/权限面板/菜单编辑/MCP 授权页）禁止引入第二套图标库，禁止 emoji 充当功能图标。
- 颜色一律走 `gx-*` design token（现状侧栏已如此，`Sidebar.tsx:110-121`），新增页面禁止硬编码色值。
- 文档与 UI 文案禁止空洞占位（"敬请期待"类），不可用功能不暴露入口。
- 后端新增代码遵守 `references/01-standards/code-organization.md`：routes 只编排、service 承业务、repository 封查询，单文件 ≤300 行；**鉴权强制点放在 service 层**，使 HTTP 控制器与 MCP tool handler 物理上无法绕过。
- 无 emoji、无紫粉渐变（UIUX 侧约束，本文不出现此类推荐）。

### 2.3 分层与数据流

```
[Web React]  [Tauri 壳]  [任一标准 MCP 客户端（如 Claude Desktop/Cursor/ChatGPT 类/客户自研智能体，含 WorkBuddy）]  [公开分享 /s/*]
      │             │              │ (Streamable HTTP / stdio)           │
      └─────────────┴────── HTTP ──┴──────────────────────────────────────┘
                         Hono app (apps/api, 单进程)
  ┌──────────────────────────────────────────────────────────────────────┐
  │ 表现层  routes/* (现有 REST)   mcp/transport + tools/* (新增)  public  │
  │              │                          │                             │
  │ 业务层  services/* (每个写/读方法首行 enforce(authzCtx, node, action)) │
  │              ├─ authz 引擎(统一)  ├─ nav-tree 同步  ├─ search/hybrid   │
  │              ├─ org/membership   ├─ docs/canvas ops(乐观锁)           │
  │              └─ indexer worker(同进程, outbox 驱动)                    │
  │ 数据层  repositories/* (Prisma)              vector/FTS repo (bsqlite3)│
  └───────────────┬──────────────────────────────────┬────────────────────┘
        主库 app.db (Prisma/SQLite, WAL)      派生库 search.db (better-sqlite3)
        业务真相源 + outbox                   FTS5(trigram) + vec0，可 truncate
```

关键约束：

- **MCP 与 REST 共用 services**。tool handler 与 route handler 都不允许直接 import prisma（lint 规则 + code review 双保险）；公开分享通道是唯一特例，它以匿名主体经引擎的 share 策略路径（见 §5.7）。
- **写串行**：indexer worker 与 API 同进程，主库写操作经 ARCH-production M1 的写串行队列；派生库写操作只在 worker 线程/连接内发生，不产生跨进程 SQLite 写竞争。
- 功能开关总表（env + `feature_flags` 表，沿用架构师规范的轻量 flag 模式）：

| flag | 默认 | 关闭时行为 |
|---|---|---|
| `enterprise_org` | off | 不挂载通讯录/部门路由，用户仍平铺 |
| `enterprise_navtree` | off | 侧栏仍按 tables/kb_docs 渲染（旧树） |
| `authz_engine_v2` | off | 全部守卫走旧逻辑；on 时引擎生效，shadow 模式可只对拍不拦截 |
| `field_level_acl` | off | 字段节点存在但不做掩码 |
| `semantic_search` | off | 搜索仅 FTS5/trigram |
| `mcp_server` | off | 不监听 /mcp、不发布 stdio bin |

flag 间依赖：`authz_engine_v2=on` 要求 `enterprise_navtree=on`；`field_level_acl=on` 要求 `authz_engine_v2=on`。启动时校验，非法组合拒绝启动（fail-closed，与 `auth.ts:28-31` 同风格）。

---

## 3. 支柱一：统一资源树（承重墙）——权威节点层 + 菜单引用层

### 3.1 两层模型与权威树语义

权限继承要求每个资源有**唯一父级**，而 N2/UIUX 要求同一表/文档/画布可在工作区菜单多处出现、可起别名、可自由拖动。一个数据结构无法同时满足两者，故拆两层（PRD C-1 裁决、PM 已裁"资源唯一父级决定继承、导航项只是引用"）：

- **权威资源节点 `nav_nodes`**：资源与"授权分组"的唯一真源，唯一父级，承载继承与授权；不对管理员菜单编排开放自由多挂。
- **菜单引用 `menu_items`**：工作区一级菜单的编排层（容器 + 快捷项），只引用 `nav_nodes`，可多处添加、改名（别名）、拖动、删除而不影响权威父级与任何权限（详见 §3.4）。

权威树层次：

```
L0 Workspace（工作区，私有化初期默认单工作区）
└─ 权威节点（nav_nodes，唯一父级）
   ├─ 资源类型 base：库入口节点（"先入库再入表"）
   │   └─ table 节点（= 列表层；视图 views 是表内变体配置，系统同步，不占授权客体）
   │       └─ group 授权分组节点（N4：条件节点 groupByFieldId+桶值，真实授权单元，按需创建/运行时枚举）
   │           └─ field 字段节点（fields 自动同步）
   ├─ 资源类型 doc / canvas：内容叶子节点（resourceId = kb_docs.id）
   │   └─ doc 的 parentId 文档层级通过节点 parentId 复刻（KbTree 视觉不变）；
   │      文档/画布分组是 N4 授权分组节点（其下内容继承组策略）
   └─ 纯菜单文件夹（UIUX"客户管理"容器，不承载授权）不在本树——它是 menu_items(type=container)
```

规则：

1. 一个可挂载资源在同一工作区内**只有一个权威挂载点**（`@@unique([workspaceId, resourceType, resourceId])`），继承边界唯一确定。需要"两处/多处可见"时**不复制节点、不建 link 型节点**，而是在菜单层加多条 `menu_items(type=shortcut)` 引用同一 nodeId（§3.4）；授权永远以权威节点及其祖先链为准，菜单引用不参与决策。
2. 权威节点由资源结构自动 upsert（系统节点）：建表/建字段/改字段名 → 事务内同步节点；删表/删字段（软删）→ 节点 `isSystem=1` 标记隐藏，不物理删除（保留其上策略历史与审计）。管理员可手工创建的权威节点只有 **group 授权分组**（N4，授权单元）与内容层级；菜单容器/快捷项的增删改全部落在 `menu_items`。
3. 分组节点不按"字段×所有值"预生成（选项表可能无限）。两种产生方式：(a) 管理员在权限面板对某个桶授权，或在二级菜单建授权分组时创建；(b) 运行时引擎按用户可见分组剪枝展示。分组节点 `config = {tableId, fieldId, bucket}`，bucket 用 SelectOption.id 或标准化值（与 `group.ts:14-60` 的桶 key 同一口径，含 `__empty__` 空桶）。
4. 文档/画布节点直接以 `resourceId = kb_docs.id` 建立；知识库容器（kb）退化为文档节点上的 `kbId` 属性与 L0 之下的系统分组，不再作为独立授权层级（迁移后 `kb_members` 语义被祖先节点策略取代，见 §6.3）。
5. 导航/菜单读接口返回时**按调用者权限剪枝**（shortcut 解析到的 nodeId 无 R 权限则整条快捷项不返回；无任一可见 shortcut 的容器对普通成员整容器隐藏），菜单保存校验操作者对工作区有 `manage_menu`（workspace_admin）。
6. **资源唯一父级变更（跨授权分组移动）= 改变继承边界**，与"菜单层拖动"严格区分：前者走 N6 权限影响预览 + 审计（改 nav_nodes.parentId），后者只改 menu_items 排序/归属、零权限影响（UIUX §7-C8 防误解）。

### 3.2 Prisma 模型草案（只增不删）

```prisma
// ---- 工作区 ----
model Workspace {
  id         String   @id @default(cuid())
  name       String
  // 策略/树结构版本号：任何 auth_policies / nav_nodes 写事务内 +1，供缓存失效
  policyVersion Int    @default(1)
  navVersion    Int    @default(1)
  menuVersion   Int    @default(1)  // menu_items 写事务内 +1
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt
  nodes      NavNode[]
  menuItems  MenuItem[]
  @@map("workspaces")
}

// ---- 权威资源节点（继承树 = 授权客体树，唯一真源；不承载菜单编排）----
model NavNode {
  id           String   @id @default(cuid())
  workspaceId  String
  parentId     String?              // L0 为 null；其余必填（唯一父级，决定继承）
  // base/table/doc/canvas/view/group/field
  kind         String
  name         String               // 展示名冗余（系统节点随表名/字段名同步）
  ord          Int                  // 同父排序（权威层排序；菜单展示排序在 menu_items）
  isSystem     Boolean  @default(true) // 系统资源节点=true；group 授权分组/复刻内容层级=false
  // 挂载的资源（group/view/field 走 config；纯菜单文件夹不进本表，它是 menu_items container）
  resourceType String?              // base/table/doc/canvas
  resourceId   String?
  // group 节点：{tableId, fieldId, bucket}；view 节点：{viewId}；field 节点：{fieldId}
  config       String?              // JSON
  // 继承开关（仅 doc/canvas 内容叶子可置 false；见 §5.4）
  // false=私密/restricted：判定本节点不收集祖先策略，只用「直接 allow + 创建者/owner/admin 兜底」
  inheritAncestors Boolean @default(true)
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
  deletedAt    DateTime?

  workspace    Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  policies     AuthPolicy[]
  shortcuts    MenuItem[]

  // 一资源一权威挂载点：继承边界唯一；"多处可见"由 menu_items 引用满足
  @@unique([workspaceId, resourceType, resourceId])
  @@index([workspaceId, parentId])
  @@index([resourceType, resourceId])
  @@map("nav_nodes")
}

// ---- 菜单引用层（N2：工作区一级菜单编排；只是引用，不承载继承/授权）----
model MenuItem {
  id           String   @id @default(cuid())
  workspaceId  String
  parentId     String?              // 父菜单容器（一级菜单 parentId=null）；自引用
  type         String               // container=纯菜单文件夹(UIUX"客户管理") / shortcut=资源快捷项
  nodeId       String?              // type=shortcut 时引用 nav_nodes.id；container 时为 null
  label        String?              // 导航显示别名（null=用资源真名；UIUX §7-C12）
  iconName     String?              // 必须是 icons.tsx 的 IconName，禁止 emoji/URL
  ord          Int                  // 同父菜单排序（拖动只改这里）
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
  deletedAt    DateTime?

  workspace    Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  parent       MenuItem?  @relation("MenuTree", fields: [parentId], references: [id], onDelete: Cascade)
  children     MenuItem[] @relation("MenuTree")
  node         NavNode?   @relation(fields: [nodeId], references: [id], onDelete: Cascade) // 级联见 §3.4

  // 同一权威节点可被多个菜单项引用（多处添加）；不设 nodeId 唯一约束
  @@index([workspaceId, parentId])
  @@index([nodeId])
  @@map("menu_items")
}

// ---- 统一策略表（角色授权/部门授权/直接授权全部落这一张表；纯 allow，无 effect 列）----
model AuthPolicy {
  id           String   @id @default(cuid())
  workspaceId  String
  nodeId       String                    // 客体：NavNode.id
  subjectType  String                    // user / dept / role
  subjectId    String                    // users.id / departments.id / roles.id
  // 动作位：c/r/u/d 四态位图 "crud"；管理类动作另用 manage/share/comment 位
  actions      String   @default("r")
  // 字段能力裁剪（allow 授权的能力位，非 deny 主体）：
  // { allowFields?: string[], readOnlyFields?: string[] }；缺省=该节点全部字段随 actions
  fieldMask    String?
  // group 节点策略可带条件（一般冗余在 node.config，保留给未来动态条件）
  conditions   String?
  reason       String?                  // 授权来源备注（面板填写/迁移回填）
  createdAt    DateTime @default(now())
  createdBy    String

  node         NavNode  @relation(fields: [nodeId], references: [id], onDelete: Cascade)

  @@unique([nodeId, subjectType, subjectId])
  @@index([workspaceId, subjectType, subjectId])
  @@index([nodeId])
  @@map("auth_policies")
}
```

设计要点：

- **不存在 effect/deny 列**（裁决1，对齐 D-2/O8）。同主体同节点仅一行 allow，唯一键 `[nodeId, subjectType, subjectId]` 保证无二义；"收权"= 删除该行或移除其角色/部门来源（O8"移除全部来源才收回"，C-6 UI 明示）。
- `inheritAncestors` 是**节点属性**而非主体策略，只允许内容叶子置 false：它表达"这篇/这个画布是私密/受限"，对所有继承主体确定性一致生效，不产生 per-subject 的 allow/deny 冲突。组内重新分享 = 对该节点新增直接 allow。
- 字段隐藏/只读用 `fieldMask.allowFields/readOnlyFields` 表达（§5.1/§5.2），是该 allow 授权的能力裁剪；全文不再出现 denyFields。
- `menu_items` 与 `nav_nodes` 解耦：别名、拖动、多处添加、删除快捷项全部不触碰权威父级与 `auth_policies`（§3.4）。

`bases`、`knowledge_bases` 各增列：`workspaceId String?`（回填默认工作区，回填后置 NOT NULL 的步骤放在同一迁移末尾的第二步——SQLite 下用"加可空列→回填→新建 NOT NULL 表拷贝"既有模式）。`users` 增列见 §4.2。

### 3.3 迁移与回填（只增兼容，旧代码可跑）

迁移分两个只增迁移（对齐 §10.2）：M2 迁移建 workspaces 与 §4 组织表（departments/dept_members/roles/role_assignments）+ users 加可空列；M3 迁移 `xxxxxx_enterprise_navtree` 建 nav_nodes/menu_items/auth_policies（auth_policies 在 M3 只建表、M4 才启用写入与回填）。下述 M3 迁移每步幂等可重跑：

1. CREATE 新表 nav_nodes/menu_items/auth_policies，全部新表，无旧表改动风险。
2. 插入默认工作区引用（M2 已播种 `Default Workspace`，此处幂等校验）。
3. 回填权威树：
   - 每个未删除 `bases`（`schema.prisma:19-32`）→ base 节点；其下每个 table → table 节点；table 下每个未删除 field → field 节点。
   - 每个未删除 `knowledge_bases` → 每个未删除 `kb_docs`（`schema.prisma:279-313`）→ doc/canvas 内容叶子（`parentId` 文档层级通过 nav_nodes.parentId 复刻，保证 KbTree 视觉不变）；kb 本身建为节点下的系统分组/`kbId` 属性。
   - `views` 不同步为授权节点（视图是表内 tab，不占授权客体；如后续要对单个视图授权再补 kind=view）。
4. 回填菜单引用层（N2/UIUX §1.3 默认值，零入口丢失）：为每个 base 建一个同名 `menu_items(type=container)`，其下为该 base 全部 table 各建一条 `shortcut`（nodeId 指向权威 table 节点）；为每个 kb 建同名 container，其下为全部 doc/canvas 各建 shortcut（复刻文档层级为容器嵌套）。此步只写引用，**不改变第 3 步的权威父级与继承**。
5. 发布前快照（ARCH-production §4.4/§5.3 既有机制），迁移失败自动还原快照文件。
6. **存量授权回填（members/kb_members/kb_doc_acls → auth_policies）在 M4 独立只增迁移执行**（见 §6.2/§6.3），不随 M3 树迁移一起跑，保证 M3 上线时旧守卫与旧表完全照旧工作。

迁移期间旧代码行为不变：新表均为旁路追加，旧查询不读 `nav_nodes`/`menu_items`；`enterprise_navtree=on` 后前端改读 §3.4 菜单读接口，提供一键 flag 回退。

### 3.4 菜单引用层（menu_items）行为与级联

对接 PRD N2（一级菜单自由添加表/文档/画布，可多处出现）、N4（三类内容统一分组）、C-1（唯一父级决定继承、导航项只是引用）与 UIUX §1.1/§1.2（容器 + 叶子快捷项、别名、"删除节点仅删引用"）。

**读**：`GET /api/v1/workspaces/current/menu` 返回 menu_items 树；每条 shortcut 解析 nodeId，经引擎 `can(user,node,'r')` 过滤——无权的 shortcut 整条剔除，无任一可见 shortcut 的 container 对普通成员隐藏（管理员可见并标灰"成员不可见"，对齐 UIUX §7-C7）。别名 `label` 为 null 时展示 `nav_nodes.name`（资源真名，UIUX §7-C12 次级 hint 展示真名）。

**写**（`PATCH /api/v1/workspaces/current/menu`，需 manage_menu）：
- 新增 shortcut：同一 nodeId 允许在不同容器/一级下重复添加（多处出现），仅插入 menu_items 行；禁止成环（parentId 链）。
- 重命名：只改 menu_items.label（导航别名），不改 nav_nodes.name（资产真名）。
- 拖动排序/换容器：只改 menu_items.parentId/ord，**零权限影响、不触发 N6 预览**（UIUX §7-C8）。
- 删除快捷项/容器：只删 menu_items（容器删除先二次确认其下引用去向），**不删 nav_nodes、不删资源、不动任何策略**。
- 跨**授权分组**移动资源（改 nav_nodes.parentId）是另一条写路径，必须走 N6 权限影响预览 + 审计（§3.1 规则 6）。

**级联规则**：
- 资源物理删除（nav_nodes 删除/硬删）：其所有 menu_items shortcut 由外键 `onDelete: Cascade` 自动清理引用；容器节点不级联（只是空了）。资源**软删**（deletedAt）：shortcut 保留但读接口按不可见处理，资源恢复后引用自动还原（与 §11 悬挂风险缓解一致）。
- 容器删除：其下子菜单按自引用 `onDelete: Cascade` 处理（UI 强制先选"移到其他容器/一并删除引用"）。
- 菜单变更不影响 `policyVersion`；menu_items 写事务内递增 `workspace.menuVersion` 供菜单缓存失效。
- 校验：shortcut.nodeId 必须属于本工作区且操作者对其有 r；iconName ∈ IconName 枚举（与 icons.tsx 同源）；非法引用 400。

---

## 4. 支柱二：组织架构模型

### 4.1 部门树选型

| 方案 | 子树查询 | 移动部门 | SQLite 友好度 | 结论 |
|---|---|---|---|---|
| 邻接表（仅 parentId，现状 kb_docs 模式 `kb.ts:69-108`） | 递归/全表内存遍历 | 改 1 行 | 高 | 部门子树授权要高频查祖先链，递归成本不可接受 |
| **物化路径（parentId + path）** | `WHERE path LIKE '/a/b/%'`，前缀 LIKE 可走 B-tree 索引 | 更新子树 path（部门移动罕见，批更新可接受） | 高，无扩展 | **选用** |
| 嵌套集（lft/rgt） | 子树一次区间查 | 移动需重写半表 | 高 | 写维护重、易出错，组织调整场景不划算 |
| 闭包表 | 子树/祖先都快 | 多行事务 | 高 | 多一张表与触发器式维护，MVP 阶段过度设计 |

path 规则：`/` + 各级 departmentId 以 `/` 连接并以 `/` 结尾，根部门路径 `/{id}/`。`parentId` 为结构真相，`path` 为派生数据：移动部门时在单事务内重算该子树全部 path（深度上限 32，超限拒绝，防异常数据）。

### 4.2 Prisma 模型草案

```prisma
model Department {
  id          String   @id @default(cuid())
  workspaceId String
  parentId    String?
  path        String                         // 物化路径，见 §4.1
  name        String
  ord         Int      @default(0)
  status      String   @default("active")   // active / archived
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  deletedAt   DateTime?
  members     DeptMember[]
  @@index([workspaceId, parentId])
  @@index([path])
  @@map("departments")
}

// 成员-部门 多对多（一人可兼多部门；mainDept 仅标记主部门）
model DeptMember {
  id           String @id @default(cuid())
  departmentId String
  userId       String
  isMain       Boolean @default(false)
  joinedAt     DateTime @default(now())
  department   Department @relation(fields: [departmentId], references: [id], onDelete: Cascade)
  user         User @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@unique([departmentId, userId])
  @@index([userId])
  @@map("dept_members")
}

// 角色：系统角色不可删；自定义角色工作区级
model Role {
  id          String   @id @default(cuid())
  workspaceId String
  name        String
  description String   @default("")
  isSystem    Boolean  @default(false)
  // 动作模板：应用到被授权节点时展开为 actions，例如 ["r","c","u","comment"]
  permissions String   // JSON: { nodes?: {"*":"r"}, manageMembers?: bool, manageMenu?: bool }
  createdAt   DateTime @default(now())
  deletedAt   DateTime?
  assignments RoleAssignment[]
  @@unique([workspaceId, name])
  @@map("roles")
}

// 角色成员：主体可以是用户或部门（部门被授权 = 部门全体现成员经 path 继承）
model RoleAssignment {
  id        String @id @default(cuid())
  roleId    String
  subjectType String // user / dept
  subjectId String
  // 角色生效范围：workspace=全工作区；node=仅某节点子树（与资源直接授权等价的角色形态）
  scopeType String @default("workspace")
  nodeId    String?
  role      Role @relation(fields: [roleId], references: [id], onDelete: Cascade)
  @@unique([roleId, subjectType, subjectId, nodeId])
  @@index([subjectType, subjectId])
  @@map("role_assignments")
}
```

`users` 增列（只增）：

```prisma
status         String?  // active / invited / disabled；回填 'active'
workspaceId    String?  // 回填默认工作区
lastSeenAt     DateTime?
deactivatedAt  DateTime?
```

预置系统角色（迁移播种，`isSystem=true`）：

| 角色 | 权限要点 |
|---|---|
| workspace_admin | 成员/部门/角色/菜单/所有资源管理；对应现状 owner 的管理面 |
| workspace_member | 默认登录即可见被授权资源；无任何默认资源写权限（白名单制，避免迁移后越权） |

资源内角色（owner/creator/editor/commenter/viewer）不进 Role 表自定义体系，它们由 §5 的策略动作位直接表达；现状角色语义映射见 §6.3。

### 4.3 账号生命周期

| 状态 | 进入方式 | 可登录 | 数据处理 |
|---|---|---|---|
| invited | 管理员邀请（邮箱建 user，status=invited） | 否（完成注册激活后 active） | 不占授权席位提示；已存在的策略预先可配 |
| active | 注册/激活 | 是 | — |
| disabled | 管理员停用（离职/暂停） | 否，JWT 校验加查 status | **不删任何数据**：其 createdBy 记录、成员关系、策略保留；复用账号重新激活 |
| 注销 | 用户自助（现状 `DELETE /me`，`auth.ts:194-225`）或管理员匿名化 | — | 沿用现状级联与"唯一 owner 拒绝"，企业版额外校验"唯一 workspace_admin 拒绝" |

JWT 校验路径（`auth.ts:284-294`）增加一次 status 检查；停用即时生效依赖 §5.6 的短缓存（60s 上限）与 PAT 吊销表。

### 4.4 与 users/Member 的存量映射

- 全部存量 `users` → 默认工作区 active 成员。
- `members`（base 五角色）与 `kb_members`（四角色）**表保留不删**（M4 引擎切换期双读校验），其语义在回填时物化为 `auth_policies`（§6.3）；引擎稳定两个迭代后再评估是否清理，本期不做物理删除。
- KbMember 的 owner 唯一性保护（`kb.ts:272-281`）升级为工作区级 admin 保护。

---

## 5. 支柱三：统一权限引擎

### 5.1 模型：主体、客体、动作

- **Subject（主体）**：`user:{id}`。其权限来源三路并集：
  1. 角色：`role_assignments(subjectType=user)` 直接分配 ∪ 用户所属部门（`dept_members`）经部门 path 向上收集到的、`subjectType=dept` 的角色分配；
  2. 部门：`auth_policies(subjectType=dept)`，部门授权沿部门 path 对"该部门及其子部门全体成员"生效（给 A 部门授权 = A.path 前缀匹配用户任一部门 path）；
  3. 直接：`auth_policies(subjectType=user)`。
- **Object（客体）**：`nav_node:{id}`，含沿权威资源树 `parentId` 链的继承；**菜单引用 menu_items 不是客体、不参与决策**（§3.4）。继承是否被收集由内容叶子节点的 `inheritAncestors` 开关决定。
- **Action（动作）**：数据动作 `c/r/u/d` 四态；管理动作 `manage_share/manage_members/manage_menu/comment`。数据库资源细化四级：

| 级别 | 节点 | R | C/U/D 语义 |
|---|---|---|---|
| 库 | base 节点 | 见库内表列表 | 建表(c)/改名(u)/删库(d) |
| 表 | table 节点 | 见表与记录 | 建记录/改记录/删记录；改表结构归 u+schema 管理位（沿用 canManageSchema 语义，`permissions.ts:79-81`） |
| 分组 | group 条件节点 | 仅返回命中条件的记录行 | 仅允许写命中条件的行（行级条件，见 §5.3） |
| 字段 | field 节点 | 列掩码：未授权字段不出现在响应 | 写 payload 出现未授权字段键即 403（整条拒绝，不静默丢弃） |

- **文档/画布**：默认（`inheritAncestors=true`）继承分组/库祖先策略；需要"对个别继承主体收紧/设为私密"时把该内容叶子置 `inheritAncestors=false`（节点级开关，对所有继承主体一致生效），收紧后仅保留「节点直接 allow ∪ 创建者/owner ∪ workspace_admin」，对组内某人重新开放=加一条该节点直接 allow（§5.4）。评论权限沿用 comment 位（现状 `guards.ts:91-95`）。

### 5.2 鉴权决策伪代码（纯 allow，无 deny 分支）

```text
function can(user, node, action, ctx):
  # 0. 公开分享走独立判定（匿名主体 + shareToken），不经下面三路
  if ctx.shareRoot: return sharePolicyAllows(ctx.shareRoot, node, action)

  # 1) 兜底全权：内容创建者/owner、workspace_admin 恒放行（D-2：所有者/管理员兜底）
  if isOwnerOrCreator(user, node) or isWorkspaceAdmin(user, node.workspaceId):
      return ALLOW(source="owner_fallback")

  # 2) 收集 allow：节点直接策略 ∪（inheritAncestors 时的祖先策略）；无 deny 可收
  pols = collectPolicies(user, node)          # 带版本缓存，§5.6

  # 3) ALLOW 并集：任一路命中即放行；无任何命中即默认拒绝（no allow => deny）
  for p in pols:
      if action not in p.actions: continue
      if p.conditions and not evalRowCondition(p.conditions, ctx.row): continue
      if action == 'r' and ctx.fieldId and not fieldVisible(p, ctx.fieldId): continue
      if action in (c,u,d) and ctx.fieldId and not fieldWritable(p, ctx.fieldId): continue
      return ALLOW(source=p)
  return DENY(reason="no_matching_allow")      # 默认拒绝；收权=移除来源（O8/C-6）

function collectPolicies(user, node):
  out = policiesOnNode(user, node)             # 节点直接 allow（角色/部门/直接 三源）
  if node.inheritAncestors:                    # 内容叶子的私密开关=false 时不向上收集
      for anc in ancestorChain(node):          # 权威树祖先（含 L0 工作区），不含 menu_items
          out += policiesOnNode(user, anc)
  return out

function policiesOnNode(user, anc):
  auth_policies where nodeId=anc.id
       and (subjectType='user' and subjectId=user.id
            or subjectType='role' and roleHeldByUser(user, subjectId, anc)
            or subjectType='dept' and userInDeptOrSubDept(user, subjectId))

function roleHeldByUser(user, roleId, anc):
  # 直接分配 + 用户任一部门 path 被分配部门 path 前缀覆盖 + scope 包含 anc
  ...

function visibleColumns(user, tableNode):   # 列表出口统一调用
  allow = fields with can(user, fieldNode, 'r')
  return schema.fields.filter(in allow)      # 计算字段的依赖列用于服务端计算但不出投影

function writableRowPredicate(user, tableNode):
  # 收集该表下所有 group 节点条件，命中 allow 的条件取并集；注入 WHERE
  return OR(group.conditions for group where can(user, groupNode, 'r'))
```

确定性规则（替代旧的 DENY 优先级，无"后写覆盖"）：**owner/admin 兜底 → 节点直接 allow →（`inheritAncestors=true` 时）祖先 allow 并集 → 无 allow 即拒绝**；字段可见/可写是命中 allow 上的 `fieldMask` 能力裁剪。这天然表达三类诉求：私密文档（叶子 `inheritAncestors=false` 且无直接授权→无 allow 即 403）、组内个别开放（叶子 restricted + 对该人加直接 allow）、字段收窄（allow 上 fieldMask）。

写校验顺序（在 service 事务内）：表级动作 → 行级条件（更新/删除前先读出旧行判定桶，防止"改分组键越权挪走"）→ 字段键掩码。任一不过：403 + 结构化 `code`（`FORBIDDEN_FIELD`/`FORBIDDEN_GROUP`/`FORBIDDEN_RESOURCE`），MCP 与 REST 共用同一错误体。

### 5.3 分组（行级条件）如何不复制数据

- group 节点 `config.bucket` 对应一个可翻译为 FilterNode 的条件（Select 单选=等值；多选=has；checkbox=布尔；links=包含；空桶=`null/""`；口径对齐 `group.ts:14-60` 与 `domain/filter.ts`）。
- 读：把条件编译进现有过滤管线（`recordService.queryRecords`），**不下推到旁路索引之外的新 SQL**（ARCH-production M1 的过滤下推完成后直接复用参数化 WHERE）。
- 写：C 时校验提交值至少落在一个有 c 权限的桶（无分组授权但有表级 c 时按表级放行——表级 ALLOW 是分组缺失时的上位权）；U/D 时对旧行、新行分别判定，禁止跨桶越权移动。
- 搜索/MCP 返回的记录同样经过谓词过滤（权限感知检索，§7.6）。

### 5.4 统一面板 ↔ 单文档权限：一张表、两个视图、确定的优先级

现状：统一成员管理在知识库设置（`kb.ts:216-286`），单文档 ACL 在 `DocAclModal.tsx` + `kb_doc_acls`，两者靠"取较高角色"弱耦合（`kb.ts:54-55`），面板上看不到单文档例外。

企业版规则：

1. **同一张 `auth_policies`**。统一权限面板编辑"节点 → 主体 → 动作"；单文档/画布权限弹窗是同一表在 `nodeId=该内容节点` 上的过滤视图。任意入口写完，另一入口刷新立即可见（`policyVersion` 失效缓存）。
2. 面板对内容节点展示三块（纯 allow 模型，无 deny 分区）：
   - 继承权限（`inheritAncestors=true` 时来自哪些祖先节点/部门/角色，只读列出，点击可跳转祖先节点面板）；
   - 直接授权（可增删，= 现状 kb_doc_acls 的只增语义，写 auth_policies 直接 allow）；
   - **继承开关（私密/restricted）**：内容叶子的 `inheritAncestors` 布尔，默认开。关闭=该内容不再继承上层分组/库策略，仅「直接授权 + 创建者/owner + admin」可访问；UI 文案明示"关闭继承后，需在此逐人/逐部门添加直接授权，组内默认不可见"，与"添加成员"分区并二次确认。
3. 确定性规则（无 deny、无"后写覆盖"）：
   **owner/admin 兜底 → 节点直接 allow →（`inheritAncestors=true`）祖先 allow 并集 → 无 allow 即拒绝**；同主体同节点只有一行 allow（唯一键），调整动作位即 upsert，不存在 allow/deny 两行并存。
   - 现状"取较高角色"（`kb.ts:54-55`）是本规则在「继承开 + 纯 allow」下的退化形态，语义连续。
   - O8/C-6 可解释性：收权必须移除来源；面板对仍生效的访问逐条列出来源（角色 X / 部门 Y / 直接 Z / owner 兜底），提供"查看其他来源并一并移除"。
4. 可切换继承开关/管理单内容直接授权的人：内容创建人、对内容有 u（可编辑）权限者、workspace_admin（对齐派工"创建人+可编辑者+管理员"）。分享（外链）设置沿用 `kb_docs` 字段与 `/s/*` 通道（`schema.prisma:299-302`、`public.ts`），分享开关本身要求 `manage_share` 动作；外链在面板中按 PRD C-10 独立分区计数，不属于 auth_policies。
5. 批量"团队权限"（现状 `kb.ts:562-592` 把全库成员统一升降级）升级为面板上的批量策略编辑，仍只允许 workspace_admin；操作产生一组 allow 策略 upsert，单事务提交。
6. O7 下推语义在纯 allow 下的表达：分组改权限"覆盖例外"= 删除该内容节点上对应的直接 allow 行（并可按需把 `inheritAncestors` 重新打开）；"保留例外"= 不动直接 allow。系统不提供任何"对人拒绝"开关。

### 5.5 统一入口：旧守卫如何退场

- 新增 `services/authz/*`：`engine.ts`（纯决策，可单测）、`subjects.ts`（角色/部门展开）、`nodes.ts`（祖先链/树同步）、`policies.repository.ts`。
- 适配层保持旧函数签名，内部改调引擎：`requireCanView(c, baseId)` → 解析 base 对应 nodeId 后 `enforce(user, node, 'r')`；`requireDocAccess` → 内容节点判定。路由文件零改动（调用点 60+ 处不动，降低回归面）。
- 三阶段灰度（flag `authz_engine_v2`）：
  1. **shadow**：旧守卫决策照跑，引擎并行计算并只记日志差异（含差异主体/节点/动作/两路结果），不拦截；
  2. **enforce**：以引擎结果为准，旧结果仅记日志；差异率连续一个迭代为 0 是进入下一阶段的门；
  3. **清理**：删除旧决策分支（函数壳保留到下一期），MCP 通道从第一天起只走引擎。
- search 路由的手工成员循环（`search.ts:57-150`）在混合检索服务里重写为"可见节点集合 + 索引过滤"（§7.6）。

### 5.6 缓存与失效

- 进程内 L1 缓存（LRU 容量 5000，单实例部署足够）：
  - `sub:{userId}` → 展开后的角色/部门集合（TTL 300s）；
  - `pols:{userId}:{nodeId}` → 策略快照（含 workspace.policyVersion）；
  - `tree:{workspaceId}` → 祖先链/树版本；`menu:{workspaceId}` → 菜单引用树（menuVersion）。
- 失效：任何 `auth_policies/role_assignments/dept_members/departments` 写事务内 `workspace.policyVersion += 1`；`nav_nodes` 写 → `navVersion += 1`；`menu_items` 写 → `menuVersion += 1`（菜单变更不触发 policyVersion）。缓存 key 带版本号，版本失配即弃（无主动广播，单实例无此需要；多实例是 §11 的 PG/Redis 触发条件之一）。
- 账号停用最长 300s 延迟不可接受：停用/改密/PAT 吊销走用户行 `tokenVersion`（ARCH-production 安全支柱已规划），JWT 与缓存按其失效，实时生效。
- 决策结果不做跨请求正缓存（只缓存策略原始数据），避免行级条件/字段掩码上下文串味。

### 5.7 公开分享通道

匿名主体不进入三路并集：`findShareRoot` 与子树闭包已实现（`public.ts:27-60`），引擎仅提供 `sharePolicyAllows(root, doc, action)` 纯函数复用其 shareRole/shareIncludeChildren 规则；MCP 不允许匿名访问（无 token 不列出任何工具之外的业务能力）。

### 5.8 越权测试矩阵（M4 权限引擎出口门，必须自动化）

横轴主体来源，纵轴客体与动作，通道列 REST/MCP 各跑一遍（MCP 通道在 M6 补跑，M4 先以 service 层单测覆盖同一决策），公开分享单列：

| # | 主体 | 客体 | 动作 | 期望 |
|---|---|---|---|---|
| 1 | 无任何关系 | 库/表 | r/c/u/d | 403/404（不可见节点返回 404，不泄露存在性） |
| 2 | 仅 viewer 角色 | 表 | r 放行；c/u/d | 403 |
| 3 | editor（表级 allow:cud） | 表内字段（未授 field） | u 含该字段键 | 403 FORBIDDEN_FIELD，整行不写 |
| 4 | 分组 A allow（条件节点） | A 桶记录 | r | 仅返回 A 桶；越桶记录不出现 |
| 5 | 同 #4 | B 桶记录 | u/d | 403 FORBIDDEN_GROUP |
| 6 | 同 #4 | 改记录把分组键从 A 改到 B | u | 403（旧行可写、新行无权） |
| 7 | 部门 D 被授权 | D 子部门成员、D 外成员 | r | 前者放行后者拒绝 |
| 8 | 用户多部门（D1 有权/D2 无权） | D1 资源 | r | 放行（并集） |
| 9 | 角色经部门继承 + 用户直接 allow 并存 | 内容叶子（inheritAncestors=true） | r | 并集放行；O8 来源链同时列出两条来源 |
| 10 | 内容叶子 `inheritAncestors=false` 且无该主体直接 allow | doc（同库其他 doc 继承开） | r | 403（no matching allow）；同库其他 doc 不受影响、仍可继承访问 |
| 10b | 叶子 restricted + 对组内某人加该节点直接 allow | doc | r | 该人凭直接 allow 放行，其余继承主体仍 403；移除该直接 allow 后立即恢复 403（O8 收权） |
| 11 | 文档创建人/编辑者/admin vs 普通 viewer | 切换内容叶子 inheritAncestors / 加直接授权 | manage | 前者放行；viewer 403 |
| 12 | 被停用账号（status=disabled）持旧 JWT | 任意 | 任意 | 401（tokenVersion/status 生效） |
| 13 | MCP 持有效 PAT | 无权表 record.create | — | tool 返回 isError + FORBIDDEN，数据无写入 |
| 14 | MCP 伪造他人 userId 参数 | 他人有权资源 | read | 以 token 主体判定，403/404 |
| 15 | 分享 token viewer | 分享根 | u | 403；非闭包 doc 404 |
| 16 | 字段级 r 掩码 | 列表/详情/搜索/MCP read | — | 四处投影一致，无侧信道（搜索摘要也脱敏） |
| 17 | 菜单读接口（menu_items shortcut 解析到无权 nodeId） | 无权限快捷项/空容器 | r | 无权 shortcut 整条剔除、空容器对普通成员整容器隐藏；admin 可见标灰 |
| 17b | 管理员删除菜单快捷项/对同一资源多处添加、改别名 | menu_items | cud | nav_nodes 父级与 auth_policies 零变化、资源仍可经旧 URL/其他引用访问、权限不变 |
| 18 | shadow 期差异巡检 | 全 fixture | 全动作 | 差异日志为 0（fixture 由现有 21 hydrate/filter 单测数据派生） |

---

## 6. 支柱一/二/三的存量授权回填映射

### 6.1 角色 → 动作位

| 现状角色 | 策略 actions | 管理位 |
|---|---|---|
| owner（members/kb_members） | crud | manage_share, manage_members |
| creator（members） | crud（表结构 u 额外带 schema 位） | — |
| editor | cud + r | — |
| commenter | r + comment | — |
| viewer | r | — |

### 6.2 回填规则（迁移内执行）

- 每个 `members` 行 → 在该 base 对应 base 节点写一行 `auth_policies(subject=user, actions=映射值)`。
- 每个 `kb_members` 行 → 对该库下**每个** doc/canvas 节点写 allow 策略（现状知识库角色对全部内容生效）。数量大时按批 INSERT（单库内容千级以内可接受；超大库走迁移脚本分批，每批 5000 行）。
- 每个 `kb_doc_acls` 行 → 内容节点 `subject=user` 直接 allow 策略（auth_policies 无 effect 列，回填只产 allow）；与 kb_member 回填命中同一唯一键时 upsert 保留较高 actions（与 `kb.ts:54` 同语义）。
- owner 成员额外写 workspace_admin 角色分配（每个库/Base 的 owner；多人则多分配，admin 不设唯一生效，但 UI 提示"建议 2-3 人"）。
- 回填后全部内容节点 `inheritAncestors=true`（默认继承）；现状无"私密文档"概念，不制造 restricted 节点，保证升级语义等价——私密是用户在 M4 主动开启的新能力。
- 回填完成后输出对账报告：旧关系行数 vs 策略行数、每主体随机 20 个节点的新旧决策对拍（复用 §5.8 shadow 设施）。
- 菜单引用回填（§3.3 第 4 步）与授权回填解耦：menu_items 不产生任何 auth_policies，策略只挂权威 nav_nodes。

### 6.3 双跑期数据写同步

`authz_engine_v2=on` 后，成员管理/单文档 ACL 的**写路径同时维护旧表与 auth_policies**（适配层在事务内双写），保证 flag 回退后旧守卫仍正确；字段级/分组级新能力只写 auth_policies（旧表无承载，回退意味着放弃新特性，可接受）。

---

## 7. 支柱四：向量与语义混合检索

### 7.1 Outbox：主写事务不等待

```prisma
model ChangeEvent {
  id          String   @id @default(cuid())
  entityType  String   // record / doc / canvas
  entityId    String
  workspaceId String
  version     Int      // 内容版本（kb contentVersion / record updatedAt 序号）
  op          String   // upsert / delete
  status      String   @default("pending") // pending / processing / done / failed / dead
  attempts    Int      @default(0)
  lastError   String?
  nextRunAt   DateTime @default(now())
  createdAt   DateTime @default(now())
  processedAt DateTime?
  @@index([status, nextRunAt])
  @@index([entityType, entityId])
  @@map("change_events")
}
```

- 记录保存、文档/画布内容写（现有事务点：records 路由、`kb.ts:403-449`）同事务插入 pending 事件（合并去重：同实体连续编辑只保留最新 version，取事件前在事务内 update 旧 pending 行的 version/op）。
- 同进程 worker（单例，系统级 mutex 防多实例；ARCH-production 单实例部署前提）：认领（status→processing 带批 50）→ 抽文本 → 写 FTS → embedding → 写 vec → done。失败指数退避（10s/1m/10m/1h，attempts≥8 标 dead 并告警），管理页提供"重试全部 failed"与"重放某实体"（可重放设计）。
- 删除事件先删派生行再 done；实体软删（deletedAt）同样发 delete，保证回收站内容不被搜到（现状搜索已手工过滤 deletedAt，`search.ts:64,77`，派生索引不收录即可）。

### 7.2 Embedding Provider 抽象与双模式

```ts
export interface EmbeddingProvider {
  readonly mode: "local" | "cloud";
  readonly model: string; readonly dim: number;
  embed(texts: string[]): Promise<Float32Array[]>;   // 内部批量、归一化
  health(): Promise<"ok" | "degraded">;
}
```

配置（env，启动校验）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `EMBEDDING_MODE` | `local` | local/cloud/off |
| 本地固定 | model=`Xenova/bge-small-zh-v1.5`，dim=512 | 不允许配置成其他本地模型（维度漂移会污染索引） |
| `EMBEDDING_CLOUD_BASEURL` | — | OpenAI 兼容 `/v1/embeddings`（DeepSeek 不提供 embedding 时可用混元/OpenAI/内网 vLLM） |
| `EMBEDDING_CLOUD_KEY` | — | 仅存服务端 env，不下发前端/MCP |
| `EMBEDDING_CLOUD_MODEL` / `_DIM` | text-embedding-3-small / 1536 | 改 dim 必须整体重建索引（§7.7） |

本地模式工程要点：

- 依赖 `@huggingface/transformers`（调研日 npm latest 4.2.0；`@xenova/transformers` 旧包末代 2.17.2 后迁移至该包名；实施时锁经 spike 验证的大版本，4.x 为目标、3.8.x 为保守回退，spike 报告中记录实测版本）放 **optionalDependencies** 并动态 import；云端/off 模式不加载，不占内存、安装包可选裁剪。
- 模型 q8 ONNX（约 30-100MB 量级，以实测为准）与 tokenizer 文件**随安装包/内网镜像预置**，`env.allowRemoteModels = false`，初始化不得依赖外网（内网硬要求）。
- Worker Thread 内加载运行（CPU 密集不阻塞 Hono 事件循环，与现有 API 主线程隔离）；单例 pipeline、批量 16/32。
- 公开实测参照（联网调研，2026-09-12）：该模型 512 维、中文 C-MTEB small 档领先；Transformers.js 在 Apple M4 CPU warm 后续推理约 7-10ms/句；模型驻留内存预算按 200-400MB 估。x64 低规格内网机（2C4G）表现未知 → **spike 项**。
- **向量阶段首日 spike 清单**（M5 首日，PM 已冻结编号）：
  1. 干净 Linux x64（2C4G）内网机离线加载 q8/fp32，记录冷启动、驻留内存、P50/P95 单句与 32 批量延迟；
  2. 中文召回小样（财务/制度/技术文档各 20 篇，含同义不同词），人工评 top5 命中率，与云端模式对拍；
  3. 与 FTS5 各损一路时的降级正确性；
  4. 结论不达标（内存 >800MB 或 P95 >300ms/句或召回显著劣化）→ 默认改 `off` 发版、本地模式降为可选，云端成为主推，不阻塞 MCP。

### 7.3 向量库选型（内网可部署、SQLite 友好、可重建）

| 方案 | 形态/依赖 | 检索能力 | 资源 | 适配度 | 结论 |
|---|---|---|---|---|---|
| **sqlite-vec 0.1.x** | SQLite 扩展（纯 C 预编译 .so/.dylib/.dll，npm 包 `sqlite-vec` 0.1.9 自带二进制），vec0 虚表 | 暴力 KNN（无 ANN），L2/余弦；公开实测 10 万 22-35ms、50 万 ~108-145ms | 零额外进程，派生库文件 | 10 万 chunk 内最佳，与 better-sqlite3 旁路方案天然一体 | **选用** || LanceDB | 嵌入式列存（napi 二方包），IVF-PQ | ANN，百万级 | 零进程，磁盘为主 | Node 生态较新、备份格式独立 | 阈值触顶后的第一升级位（接口不变） |
| Qdrant | 独立单二进制服务 | ANN/HNSW，过滤强 | 2C2G 可跑 | 多一个进程与备份面 | 多实例/共享检索服务时再评估 |
| pgvector | PG 扩展 | HNSW | 需 PG | 与 ARCH-production 路线 A（深挖 SQLite）冲突 | 随 §11 PG 阈值整体切换，不单独提前 |
| 纯 JS 余弦兜底 | 零依赖 | 暴力 | Float32 内存 10 万×512 ≈ 200MB | 永远可用 | sqlite-vec 加载失败的降级，不默认启用 |

连接方式（关键）：**独立派生库文件 `search.db` + better-sqlite3 13.0.3 连接**（该依赖已在 apps/api devDependencies 锁定，随 ARCH-production P2 FTS5 spike（M1 底座）提升为 dependency）。原因：Prisma 5.22 的 SQLite 引擎无法 `loadExtension`，也不应把易重建的派生数据与主库混在一个 WAL 文件里（truncate/重建不碰业务库、备份策略分离、体积可控）。

切换阈值：派生 chunk > 50 万 或混合检索 P95 > 500ms（内网目标机实测）→ ADR 启动 LanceDB 评估；embedding/indexer 接口不变。

### 7.4 FTS5：中文与短词

- better-sqlite3 内置 SQLite ≥3.45（13.0.3 发布线），FTS5 与 trigram tokenizer 可用（3.34+ 引入），无需自编译。
- 建表（派生库，contentless 外部内容模式由 worker 单写维护，不用触发器——主表在 Prisma 侧另一个库文件，触发器无法跨库）：

```sql
CREATE VIRTUAL TABLE fts_chunks USING fts5(
  title, body, nodeId UNINDEXED, entityType UNINDEXED, entityId UNINDEXED,
  tokenize = 'trigram remove_diacritics 1'
);
```

- trigram 对 >=3 字符（中文 >=3 字）做子串匹配，不需要词库，CJK 与拉丁行为一致；代价是索引体积约 3-4 倍（公开实测 18 万标题 22MB→78MB，量级可接受）。
- **1-2 字短词** trigram 不命中（静默空结果）：查询规划层检测长度，短词自动回退现有 LIKE/contains 语义（`search.ts:93,129`），并以 RRF 之外的加性 boost 合并；纯英文单词按 trigram 正常。
- bm25 噪声（trigram 在排字符窗）：二级排序键用更新时间/标题命中加权，保持稳定可解释。

### 7.5 三类内容的索引 schema

派生库统一 chunk 表（关系元数据）+ fts5 虚表 + vec0 虚表，rowid 三处一致：

```sql
CREATE TABLE chunks(
  rowid INTEGER PRIMARY KEY,
  chunkId TEXT UNIQUE, entityType TEXT, entityId TEXT, nodeId TEXT,
  workspaceId TEXT, title TEXT, seq INTEGER, version INTEGER,
  length INTEGER, updatedAt TEXT);
CREATE INDEX idx_chunks_node ON chunks(nodeId);
CREATE VIRTUAL TABLE vec_chunks USING vec0(embedding float[512]);  -- dim 随 provider 元数据建库
```

| 内容 | chunk 粒度 | 文本构成 | 元数据 |
|---|---|---|---|
| 记录 record | 一期每记录 1 chunk（主字段标题 + 可搜索非计算字段值拼接，逻辑对齐 `search.ts:82-98`，计算字段不入索引与现状 `isComputedFieldType` 过滤一致 `search.ts:75`） | title + 各字段文本 | tableId/baseId/nodeId |
| 文档 doc | 按块切分：h1/h2/h3 语义边界粗切 + 超长块滑窗（目标 300-512 字、overlap 64） | 块正文（md 去标记复用 `domain/kb.ts:7-21`） | docId/nodeId、seq、标题路径 |
| 画布 canvas | 按元素切分：每个含文本的元素 1 chunk（改造 `canvasToSearchText`，从"全板递归一个字符串" `kb.ts:28-57` 变为按元素遍历产出，保留 gxNote） | 元素 text/label + gxNote | docId/nodeId、elementId、seq |

重建幂等：以 `(entityId, seq, version)` upsert；实体变更先按 entityId 删旧 chunk 三表行再写新。

### 7.6 混合检索、融合与权限收口

```
query
 ├─ FTS 路：trigram MATCH（短词 LIKE 回退）→ bm25 排名 → topK 50（先按可见 nodeId 集合过滤）
 ├─ 向量路：query embed → vec0 KNN 50 → 同样按可见 nodeId 集合过滤
 └─ RRF 融合：score = Σ 1/(60+rank)；标题精确命中额外加权
→ 按 chunk→实体聚合（同实体多 chunk 取最高分）→ top20
→ 出参前逐实体再过一次 engine.can(user,node,'r')（检索后二次校验，防缓存版本滞后）
→ 记录类按字段 r 权限生成摘要（无权字段不进 snippet）
```

- 可见 nodeId 集合 = 引擎一次性算出的用户可读子树（树剪枝），作为 SQL `IN` 条件进两路检索（权限感知 RAG 的"检索前过滤"，参照架构知识库 RAG 模式；权限易变，该集合每次查询实时计算或带 policyVersion 缓存）。
- 搜索接口保持 `GET /api/v1/search?q=` 形态（现状 `/api/search/`，版本化在 M2/M3 随 API 版本前缀改造一并处理，见 §9.1 与 §13 第 5 条），响应加 `mode: "hybrid"|"fts"|"like"` 让前端展示降级状态。
- embedding 健康检查连续失败（本地 worker 崩溃/cloud 401/超时）→ 该查询自动 fts-only；模式切换记指标，不向用户报错。

### 7.7 派生数据即弃原则

- `search.db` 不进业务备份主集（进独立的可重建资产备份，可有可无）；提供 `pnpm gx:reindex [--type record|doc|canvas] [--id]`：truncate 三表 → 全量扫主库灌 outbox → worker 消化；幂等，跑期间搜索自动降级 LIKE（与现状能力持平）。
- provider/维度/model 变更：标记 indexMeta 不匹配 → 拒绝向量路并自动触发全量重建（与 OpenClaw 等项目"tokenizer/模型变更触发 reindex"的通行做法一致）。
- 索引损坏（vec0/FTS 打开失败）：记录错误、隔离派生库文件、自动重建，主应用不受影响。

---

## 8. 支柱五：带鉴权的 MCP

### 8.1 形态与传输

- 一个 server、一套 tool registry，同进程双入口（MCP 的连接模型即"一个客户端连接一个 MCP server 端点"，历史调研归档 `SPIKE:16,55` 亦确认无歧义）：
  - **Streamable HTTP（主）**：无状态模式，挂 Hono `/mcp`。SDK 的 transport 接受 WHATWG `Request` 并返回 `Response`，在 Hono 里透传 `c.req.raw` 即可桥接，无需第二端口/第二框架；遵循 2025-03 引入、2025-11-25 无状态化的现行规范（不使用已废弃的 HTTP+SSE 双端点）。
  - **stdio（兼容本机客户端）**：`apps/api/src/mcp/stdio.ts` 独立入口（`tsx`/编译后 bin），供 Claude Desktop 等本机标准 MCP 客户端（含本机 WorkBuddy）做 stdio 配置；stdio 下身份由环境变量注入 PAT（`GX_MCP_TOKEN`），server 启动即校验。
- 版本锚定：新增依赖 `@modelcontextprotocol/sdk`（调研日 npm latest 1.30.0，实施时锁 `^1.30` 并复测 Streamable HTTP 无状态 API）。Node 引擎 >=20 与现状一致（根 package.json:37-39）。
- 超时契约：工具 30s 内返回（MCP 官方实践建议，历史调研归档 `SPIKE:51,57` 佐证）；大批量导入/全量重建返回 `jobId`，由 `jobs.get` 轮询（复用 outbox/worker，天然幂等可重放）。

### 8.2 鉴权与连接

- **可发现性与可执行性分离（裁决 R-MCP-1，双闸门）**。安全不靠单一闸门，列表过滤与执行期强制同时存在。
  - **闸门一：`tools/list` 按账号有效权限动态过滤。** 返回的工具集按凭证所属账号在本工作区的有效权限裁剪：某个工具（动作）仅当该账号在**至少一个资源节点**上被授予对应动作位时才出现在列表中；在任何资源上都无权执行该动作的工具一律不出现（如纯只读账号看不到任何 create/update/delete/admin 工具）。资源层与字段层在工具的输入/输出 schema 与说明中同步收窄：枚举/可引用项只含权限内库表与节点（对齐 §8.3、MC3），不可见字段不进入 schema、也不出现在任何返回中。此口径调和需求原文"连接即暴露全部功能操作逻辑"与最小权限：**"操作逻辑说明书"对任何已连接客户端开放**——数据表/文档块/画布图元三套机器语言的类型说明、操作语义、确认规则（不含任何真实库名/字段值/业务数据的纯语言文档）作为可发现内容，经 MCP Resources 原语以一份只读说明书承载（本期 Resources 原语仅此一用途，见 §12）。因此 AI"学得到全部能力该怎么操作"，但看不到、也调不了无权工具（PM MC6"语言可学、无权不可调"）。
  - **闸门二：执行期强制鉴权（纵深防御，绝不因列表过滤而省略）。** 每个 handler 调 service，service 首行 `enforce`，不信模型自报身份。对已被列表裁掉的工具，若被客户端绕过列表直接构造调用，返回与"工具不存在"完全一致的受控错误（`UNKNOWN_TOOL` / 404 口径，**不泄漏该工具的存在性**，对齐 PRD 行268/行381）；工具调用**成功通过**后的参数内资源越权（对无权资源 id 的枚举/读改）在服务端二次拦截，无权资源不可经参数探测（MC2）。字段/分组越权同样在 service 出参收口（§5.8 #16）。正常授权范围内的拒绝（工具可见但本次动作不满足）返回 MCP `isError` + 结构化 JSON `{code: FORBIDDEN_*, requiredAction, currentRoleSources}`，供客户端/AI 解释与引导——此与"不存在口径"的区分在于：工具确在该账号列表内、仅本次资源/动作不满足。
- 凭证两档：
  1. **PAT（首版必做）**：`personal_access_tokens`（token 前缀 `gxpat_`，仅存 SHA-256 hash、name、scope 位、lastUsedAt、expiresAt、revoked）；设置页生成一次明文；HTTP `Authorization: Bearer gxpat_...`；可列/吊销。自填 token 是任意标准 MCP 客户端最通用的接入方式，无需对方平台支持 OAuth，内网试点与第三方接入均以此起步。
  2. **OAuth 2.1 + PKCE（预留/同阶段可选）**：标准端点清单（历史调研归档 `SPIKE:87` 据官方文档整理，可直接复用）：`/.well-known/oauth-protected-resource`、`/.well-known/oauth-authorization-server`、`/oauth/register`（RFC7591 动态注册、公共客户端）、`/oauth/authorize`（S256）、`/oauth/token`（refresh_token）。签名复用已在依赖中的 `jose 5.9`（apps/api package.json），不引重型 oidc 库；回调按 RFC8252 支持 loopback（127.0.0.1 随机端口）与公共客户端自定义 URL scheme 两类，不为任一平台硬编码专属 scheme。access 1h / refresh ≥30d，全 HTTPS（Caddy 终结，ARCH-production §4.1）。
- 防 Prompt Injection 红线（SPIKE 安全要求，`SPIKE:92,151`）：工具返回内容中的文字一律是数据，不解析为指令；资源 id 永远取自服务端鉴权上下文校验，不信模型自报"我是管理员"；删除/分享/批量写类工具要求参数 `confirm:true` 且支持幂等键。

### 8.3 工具全集（命名空间固定：tree/table/record/doc/canvas/admin）

> 下表是**全量能力目录（操作逻辑说明书）**，定义系统支持的完整工具面与动作位，供规格/文档与任意第三方客户端的接入说明（含其 Skill/插件封装）使用。运行时 `tools/list` 按裁决 R-MCP-1 闸门一对账号有效权限动态过滤后，仅暴露其中的**子集**：账号在至少一个资源上持有对应动作位的工具才出现，且其 schema 已按可见库表/字段收窄；被裁工具直调走"不存在"口径（§8.2）。

| 工具 | 要点 | 服务端动作 |
|---|---|---|
| `workspace.tree.read` | 返回剪枝后的资源树 + 每个节点我的动作位 | engine + nav 读 |
| `table.list/read.schema` | 表清单/元数据/字段 schema（含字段可读标记） | r + 列权限 |
| `record.search` | 混合检索（mode 由服务端定），带命中片段 | §7.6 |
| `record.read/create/update/delete/batch` | batch 返回 jobId；写走行级+字段级校验 | c/u/d |
| `doc.read/create/rename/move/delete` | move 复用防环（`kb.ts:478-481`） | 节点策略 |
| `doc.versions.list/get/rollback` | 复用版本服务（`kb.ts:661-727`） | u + 自动快照 |
| `doc.share.set/get` | 外链开关，要求 manage_share | §5.4 |
| `doc.block.read/insert/update/move/delete_batch` | 文档机器语言，§8.4 | u，乐观锁 |
| `canvas.read/create` + `canvas.element.*` | 画布机器语言，§8.5 | u，乐观锁 |
| `admin.reindex` / `admin.embedding.status` | 派生数据运维，仅 workspace_admin | flag 控制 |

写工具幂等：请求体接受 `requestId`（UUID），服务端 24h 去重窗口（同主体+同工具+同 requestId 返回首次结果）。

### 8.4 文档机器操作语言（锚定 Block 模型）

- 传输形态：`doc.block.read(docId, {format:"blocks"|"markdown", range?:{seqStart,seqEnd}})` → `{blocks: Block[], contentVersion, title}`。blocks 即 `blocks.ts:31-63` 定义，id 稳定。
- 原子操作（一次调用一批，服务端单事务、一次 contentVersion 递增）：

```jsonc
// insert：在锚点后插入（锚点缺省=文末）；服务端按 newBlock() 补 id，AI 不得自带 id
{"op":"insert", "afterBlockId":"b...", "blocks":[{"type":"h2","text":"..."},
  {"type":"task","text":"...","checked":false}]}
// update：整块文本替换/勾选/对齐；align 仅 left|center|right
{"op":"update", "blockId":"b...", "patch":{"text":"...","checked":true,"align":"center"}}
// move / delete
{"op":"move","blockId":"b...","afterBlockId":"b..."}  {"op":"delete","blockId":"b..."}
```

- **乐观锁**：每批带 `baseVersion`（=读到的 contentVersion）；不匹配返回 409 语义错误（MCP 错误码 `VERSION_CONFLICT` + currentVersion，与 REST `kb.ts:432-437` 完全一致），由调用方重读合并后重试。
- **align 不变量**：居中/右对齐只能表现为序列化时紧邻内容前的 `<!-- align:center|right -->` 注释（`blocks.ts:865-868`）；机器语言不接受"样式 JSON"等第二通道，服务端 blocksToMd 是唯一写出路径。
- 服务端转换只准复用 `mdToBlocks/blocksToMd`（blocks.ts），不允许工具直接拼 Markdown 字符串覆盖全文（防止 AI 手写 md 破坏块结构/表格 spans）。
- 文档大小上限沿用 10MB（`kb.ts:410`）；单批 op ≤100、插入文本总长 ≤100KB，超限要求分批。
- move 的防环不适用扁平块序列；block.id 不存在即整批失败（事务原子性，无半应用）。

### 8.5 画布机器操作语言（锚定 Plait 板模型）

- `canvas.read(docId)` → `{elements: PlaitElement[], contentVersion, viewport?}`；元素结构以 `canvas/types.ts` 为准，未知键透传不剥离（`types.ts:5-7`）。
- 操作集（服务端对 JSON 读-改-写，全部操作最终表现为元素数组的一次新快照 + contentVersion 递增）：

```jsonc
{"op":"element.create","el":{"type":"geometry","shape":"rectangle","points":[[x,y],[x2,y2]],
   "text":"...","gxNote":"..."}}                      // 关联块：带 gxLinkRef（types.ts:45-58）
{"op":"element.update","id":"...","patch":{...}}
{"op":"element.delete","ids":["..."]}
{"op":"element.connect","from":{"id":"...","port?":"center"},"to":{"id":"..."},"kind":"arrow-line"}
{"op":"zorder","ids":["..."],"to":"front"|"back"|"up"|"down"}
{"op":"locate","ids":["..."],"x":..,"y":..}            // 显式坐标
{"op":"batch","ops":[...]}
```

必须遵守的既有不变量（写为服务端校验规则）：

1. **z 序 = 元素数组序**：front/back/up/down 只允许重排数组（对应前端 ZIndexTransforms，`canvas-ops.ts:551-552`），不接受 `zIndex` 字段（出现即校验失败）。
2. **缺省坐标网格**：create 未给 points 时，服务端执行 3×2 网格算法的无 DOM 版本——以画布现有元素包围盒（gxLinkBlock 计数优先，对齐前端 `existing = children.filter(isLinkBlock)`，`canvas-ops.ts:385`）按 cols=3/rows=2/gap=40/card 280×160/超 6 张 cycleShift=60 推进；常量与前端同源（抽到 shared 包，禁止两份魔法数字）。
3. **选区不存在于机器语言**：前端右键/样式依赖 `BOARD_TO_SELECTED_ELEMENT WeakMap`（`canvas-ops.ts:677-680`），服务端无此概念——所有操作必须显式 elementId/path，不提供"对选中元素操作"。
4. **不碰渲染补偿层**：WebKit 白卡补偿 g 是前端渲染期产物（`LinkBlockForeignObject.tsx:138-175`），快照 JSON 中不存在该节点；机器写入只产出数据字段（含关联块 `fill:"transparent"`/`strokeColor:"transparent"`，`canvas-ops.ts:446-447`），补偿由各端渲染层自行重建。
5. 关联块必须是 geometry+rectangle+gxLinkRef（`types.ts:45-63`）；gxDocRef/gxLinkRef 目标 docId 必须经引擎校验可读（防止 AI 制造无权引用卡片）。
6. 思维导图子元素不允许单独 zorder（前端约束 `canvas-ops.ts:555-557` 同义规则）。
- 乐观锁/10MB/原子批与文档一致；并发同一画布的两批 MCP 写操作靠 409 串行化（画布非受控前端的整板保存也走同一版本号，`useDocPersistence.ts` 已跟随版本）。
- 长任务（如 markdown/mermaid 转画布，现有 `@plait-board/markdown-to-drawnix`/`mermaid-to-drawnix` 在前端，web package.json:20-21）本期不放 MCP（转换在浏览器态依赖），需要时作为 job 在服务端另评估。

### 8.6 协议无关的标准 MCP 交付（不为单一平台定制）

- **M6 交付的是协议无关的标准 MCP server**：单 server、Streamable HTTP + stdio 双传输、PAT（首版必做）/OAuth 2.1（同阶段可选）、tools/list 过滤 + 执行期强制鉴权双闸门，全部遵循 MCP 现行规范。任何第三方标准 MCP 客户端——Claude Desktop、Cursor、ChatGPT 类客户端、客户自研智能体，以及 WorkBuddy——只要按标准协议配置端点（或 stdio 命令）与凭证即可接入，**不为任一平台做专属适配、专属回调或功能分叉**。
- 随附一份通用《MCP 客户端接入说明》：工具语义、确认规则、错误恢复、PAT/OAuth 配置方式（即 §8.2/§8.3 的对外文档化），不绑定特定连接器市场的上架流程与商务条款。
- **本期不内置任何聊天 UI，不做服务端模型编排/对话面板**：系统只提供"能力与数据的标准接口"，对话体验、模型选择、提示词编排全部发生在客户自行选用的第三方 AI 客户端侧；工具结果被送往哪个模型、是否出内网，由客户选择的客户端部署形态决定，不在本系统边界内。未来若立项自有 AI 产品形态（内置对话、内网模型闭环等），直接复用本期沉淀的同一套 service/tool-core（对话面板作为又一个调用 services 的客户端，不经 MCP 网络层亦可），但该形态不在 M0-M7 范围内、本期不预留任何 UI/编排代码。
- 历史调研文档 `SPIKE-workbuddy-integration.md` 保留归档，其中单 server、30s 超时、注入防护等通用技术结论已吸收进 §8.1/§8.2；其面向特定平台的接入路径、方案 B（自建 Web 对话面板）及待官方回复的开放问题，**自裁决 R-MCP-2 起不再作为本期实施输入**。

---

## 9. API 增补与契约要点

### 9.1 新增端点（全部 `/api/v1/` 前缀，版本化规则按架构师规范）

> **契约冻结点 = M3 出口**：`openapi.yaml`（OpenAPI 3.0）覆盖组织/资源树/菜单引用/策略全部端点，在 M3（统一导航与资源树）出口门冻结，作为 M4 权限引擎编码启动的前置 sidecar；M4 起编码严格按 spec 实现，前端据 spec 生成 TS 类型 + MSW Mock，后端据 spec 实现。此处给契约纲要，前后端以 spec 为唯一联调依据。

| 方法 路径 | 主体动作 | 说明 |
|---|---|---|
| GET `/api/v1/workspaces/current/tree` | r | 权威资源树（nav_nodes，管理/同步视图，含我的动作位） |
| GET `/api/v1/workspaces/current/menu` | r（登录即可） | 菜单引用层（menu_items 容器/快捷项），shortcut 按引擎剪枝、别名解析后返回 |
| PATCH `/api/v1/workspaces/current/menu` | manage_menu | menu_items 批量增改/排序/换容器/删引用（不触 nav_nodes 父级与策略，§3.4） |
| GET/POST `/api/v1/org/departments` … `/org/departments/:id/members` | admin/部门管理 | 部门 CRUD、成员分配、移动（path 重算） |
| GET/POST `/api/v1/org/members`、POST `/:id/disable`、POST `/:id/reactivate` | manage_members | 生命周期 |
| GET/POST `/api/v1/org/roles`、`/:id/assignments` | manage_members | 自定义角色与分配（user/dept） |
| GET `/api/v1/nodes/:id/policies` | 节点 r + 查看权限 | 面板数据：继承来源/直接 allow/inheritAncestors 状态分区返回（无 deny 分区） |
| PUT `/api/v1/nodes/:id/policies` | 节点 manage_share | 批量 upsert/delete 纯 allow 策略行（无 effect 字段） |
| PATCH `/api/v1/nodes/:id/inheritance` | 节点 manage_share | 切换内容叶子 `inheritAncestors`（仅 doc/canvas，受限校验） |
| GET `/api/v1/nodes/:id/effective` | r | 调试用：返回某主体有效权限来源链（角色/部门/直接/owner 兜底，O8 两视角） |
| POST `/api/v1/pats`、GET、DELETE `/api/v1/pats/:id` | 本人 | PAT 管理（明文仅创建响应一次） |
| GET `/api/v1/search?q=&mode=auto` | r | 混合检索（§7.6） |
| POST `/api/v1/admin/reindex` | admin | 派生数据重建（job） |
| `/mcp`（任意） | Bearer PAT/OAuth | MCP Streamable HTTP |
| `/oauth/*`、`/.well-known/oauth-*` | 公开 | OAuth 2.1（可选档） |

### 9.2 统一响应与错误

沿用 `{code,data,message}` 规范与现有 `{error}` 过渡：v1 新端点使用规范信封，旧端点保持现状直到统一版本化改造。403 错误体新增 `code`（FORBIDDEN_RESOURCE/GROUP/FIELD）、`nodeId`、`requiredAction`，供前端定位与 MCP 透传。

### 9.3 菜单保存契约示例（menu_items 引用层）

```json
// PATCH /api/v1/workspaces/current/menu  （需 manage_menu；整棵菜单 diff upsert，单事务）
{"items":[
  {"id":"(新建可空)","type":"container","label":"客户成功","iconName":"book","ord":0,"parentId":null},
  {"id":"(新建可空)","type":"shortcut","nodeId":"nav_node_abc","label":"客户资料-别名","ord":0,"parentId":"menu_container_1"},
  {"id":"menu_shortcut_9","type":"shortcut","nodeId":"nav_node_abc","ord":2,"parentId":"menu_container_2"},
  {"id":"menu_item_del_3","deleted":true}
]}
```

同一 `nodeId` 在两个容器各出现一次（多处添加）合法。服务端校验：iconName ∈ IconName 枚举（与 icons.tsx 同源生成）；shortcut.nodeId 在本工作区存在（软删节点拒绝新建引用）；操作者对被引用节点有 r；菜单 parentId 不成环；非法引用 400。**该接口不接受也不修改 nav_nodes.parentId 与任何 auth_policies**（跨授权分组移动走 N6 预览接口，另立端点）。

---

## 10. 支柱六：迁移、回滚与阶段总策略

### 10.1 与 M0-M1 底座的衔接

- 本文所有内容建立在 ARCH-production 的 M0（生产基座：CI、配置闸门、备份、安全收口）与 M1（容量核心：写串行队列、keyset 分页、hydration 批量化）之上：
  - outbox worker 的同进程单写依赖 M1 写串行队列；
  - 分组行级条件注入依赖 M1 过滤下推；
  - 企业版迁移发布使用 M0 的 `migrate deploy` + 发布前快照 + runbook；
  - FTS5 trigram 是 ARCH-production P2"FTS5 spike（ADR-0005）"的中文方案细化与定论：**trigram + 短词 LIKE 回退**，better-sqlite3 旁路预案在本文升级为派生库正式方案。
- 编号关系统一采用 PM 冻结的 **M0-M7**（PRD §六），不再使用架构侧 E1-E4 旧编号，也不与 PRD-production 旧 E 编号混用。映射关系：

| 架构工程内容 | 企业版里程碑（PRD §6.1） |
|---|---|
| 组织模型（Workspace/部门/成员生命周期/角色表） | **M2 组织通讯录** |
| 权威资源树 nav_nodes + 菜单引用层 menu_items + 存量回填 + N1-N6 导航 | **M3 统一导航与资源树** |
| authz 纯 allow 引擎、策略 API、统一面板、inheritAncestors、字段/分组、shadow→enforce | **M4 统一权限引擎** |
| outbox/派生库/FTS5 trigram/embedding 双模式 + 首日 spike/混合检索 | **M5 向量库与统一检索** |
| PAT、双传输 MCP、工具全集、文档/画布机器语言 | **M6 鉴权 MCP** |
| 本期无原生 AI；M7＝企业版总验收 | 第三方 AI 接入能力已在 M6 由标准 MCP 承载（协议无关、任意标准客户端可用）；service/tool-core 保持干净分层，供未来 AI 产品形态复用，M7 不开发新功能 |

### 10.2 企业版阶段（工程视角，编号对齐 M0-M7）

| 里程碑 | 内容 | flag | 数据变更 | 出口门 |
|---|---|---|---|---|
| **M2 组织通讯录** | Workspace/部门物化路径树/成员生命周期/一人多部门/系统+自定义角色与角色成员；管理后台挂入左下角设置区；**不动资源权限**（旧角色空跑） | enterprise_org | 一次只增迁移（workspaces/departments/dept_members/roles/role_assignments；users 加 status/workspaceId 等可空列） | 6 层部门/调岗/兼岗/停用即时失效（PRD M2 出口）；组织 CRUD 单测；干净机迁移演练（含快照回滚） |
| **M3 统一导航与资源树** | nav_nodes 权威树与资源结构同步服务；**menu_items 引用层**（容器/快捷项/别名/多处添加/拖动/删引用不删资源，§3.4）；N1 外壳/N3 二级/N4 授权分组节点/N5 旧链接重定向；存量 nav_nodes + menu_items 回填；**`openapi.yaml` 在本里程碑出口冻结**（组织+树+菜单+策略端点全量契约） | enterprise_navtree | nav_nodes/menu_items 新表 + 回填；auth_policies 建表（M4 才启用写入） | 旧树/新树 flag 双切视觉一致；权威树回填对账 0 差异；同一资源多处菜单引用且权限不随拖动变化（§5.8 #17b）；旧 URL 重定向可达；**契约评审通过并入库，作为 M4 编码前置** |
| **M4 统一权限引擎** | authz 纯 allow 引擎、策略 API、统一面板与 DocAclModal 合流、inheritAncestors 私密开关、旧守卫适配、shadow→enforce、字段/分组两级、O8 来源链两视角；按 M3 冻结的 openapi 编码 | authz_engine_v2, field_level_acl | 无新表（auth_policies 已随 M3 建表、M4 启用）；存量 members/kb_members/kb_doc_acls 回填 allow 策略 | shadow 差异为 0 连续一个迭代；§5.8 矩阵全绿（REST 通道；MCP 行 M6 补跑）；#10/#10b 继承开关用例、#17b 菜单引用零权限变化演示；面板↔单内容双向同步；v0.1.0→M4 直升抽样核对 |
| **M5 向量库与统一检索** | **首日：本地中文 embedding spike（2C4G 离线机，§7.2）**；派生库 search.db + better-sqlite3、FTS5 trigram、outbox+worker、RRF、reindex、embedding local/cloud/off 抽象、降级 | semantic_search, EMBEDDING_MODE | change_events + search.db（派生，可 truncate） | spike 报告达标，不达标默认 off/cloud；10 万 chunk 混合检索 P95 <500ms；kill embedding 后 fts-only 自动生效；reindex 幂等；无权内容向量零泄漏对抗用例 |
| **M6 鉴权 MCP** | PAT、双传输 server、工具全集（§8.2：**tools/list 按账号有效权限动态过滤 + 执行期 service 首行 enforce 双闸门，裁决 R-MCP-1**；能力说明书经 MCP Resources 对所有连接者可发现；被裁工具直调返回"不存在"口径）、文档/画布机器语言、幂等/长任务、（可选）OAuth 2.1、《MCP 客户端接入说明》通用文档（§8.6，协议无关、不绑定单一平台） | mcp_server | personal_access_tokens；oauth 表（可选） | MCP Inspector 全工具手测；**tools/list 按账号过滤 + 执行期强制鉴权双闸门验证，并补三条对抗用例：①只读账号 tools/list 无任何写/删/admin 工具，且绕过列表直调被裁工具返回与工具不存在一致口径（UNKNOWN_TOOL/404，不泄漏存在性）；②字段受限账号的工具 schema 中无不可见字段、返回中亦无；③任何工具对无权资源 id 的参数越权被服务端二次拦截且不泄漏存在性（MC2）**；越权矩阵 #13/#14/#16 MCP 通道补跑；机器语言对拍真实编辑器产物；30s 契约；至少两种第三方标准 MCP 客户端（如 Claude Desktop 走 stdio、一款 HTTP 客户端）连通 PoC，验证协议无关性；全量审计 |
| **M7 企业版总验收（无新功能开发）** | 组织/资源树/权限/向量/MCP 五主线端到端对抗验收 + v0.1.0 直升 M7 实测 + 验收报告；不开发任何原生 AI/聊天框功能，第三方 AI 接入已由 M6 标准 MCP 承载 | 无新 flag（不引入 ai_chat） | 无架构新表 | 五主线 P0 对抗用例全绿（含 M6 越权三用例）；v0.1.0→M7 直升抽样 0 差异；回滚演练通过（M0 快照还原 + 各 kill switch 关闭旧路径可用）；验收报告归档 |

依赖序与 PRD 一致：M4 挂在 M3 的树上、M5 的权限感知检索必须在 M4 后、M6 依赖 M4 与 M5 的 record.search；M5 的 V1/V3 派生子系统可与 M3/M4 部分并行预研（PRD §十三风险同口径），但 V4 上线不早于 M4。

### 10.3 回滚四原则（六支柱通用）

1. **只增兼容迁移**：所有变更为新表/新可空列/回填；发布前在线快照（M0 机制），失败还原快照 + 应用包回滚 30 分钟内完成。
2. **功能开关灰度**：每个支柱一个 kill switch；关闭后旧路径必须仍可用（旧表双写期保留、旧树接口保留、搜索回退 LIKE）。
3. **派生数据可重建**：search.db 全部内容可 truncate 重建，不作为回滚资产；outbox 可重放。
4. **不损坏已存档数据**：软删/回收站/版本表（kb_doc_versions）语义不变；纯 allow 策略与菜单引用不删除任何业务行；账号停用不级联删内容（仅屏蔽登录）。

### 10.4 新增 ADR 清单（MADR，立项时落 docs/decisions/）

| 编号 | 标题 | 里程碑 |
|---|---|---|
| ADR-0011 | 权威资源树与菜单引用分离：nav_nodes（唯一父级承载继承/授权）+ menu_items（只引用不授权） | M3 |
| ADR-0012 | 部门无限级树：物化路径（parentId 为真相、path 派生） | M2 |
| ADR-0013 | 统一策略模型：auth_policies 纯 allow 三主体并集（无 effect/deny），收窄靠 inheritAncestors 节点开关 + 移除来源 | M4 |
| ADR-0014 | 分组行级授权：条件策略节点而非行副本 | M4 |
| ADR-0015 | 检索变更管道：同进程 outbox + 可重建派生库 | M5 |
| ADR-0016 | Embedding 双模式：本地 transformers.js/bge-small-zh 默认、云端 OpenAI 兼容可选 | M5 |
| ADR-0017 | sqlite-vec 派生向量库与 LanceDB/Qdrant 升级阈值 | M5 |
| ADR-0018 | FTS5 trigram 中文检索与短词 LIKE 回退（细化 ADR-0005） | M5 |
| ADR-0019 | 协议无关标准 MCP server：单 server 双传输（Streamable HTTP + stdio）+ tools/list 按账号动态过滤 + 执行期强制鉴权双闸门、能力说明书可发现、PAT 先行；任意标准 MCP 客户端可用，不为单一平台定制（裁决 R-MCP-1、R-MCP-2） | M6 |
| ADR-0020 | 文档/画布机器操作语言：Block/Plait 原子操作 + contentVersion 乐观锁 | M6 |

---

## 11. 风险登记

| 风险 | 等级 | 缓解 |
|---|---|---|
| 鉴权替换跨 60+ 调用点，shadow/enforce 切换期回归 | 高 | 路由零改动适配层；shadow 差异日志为 0 的硬门；§5.8 矩阵；旧表双写保留一个迭代 |
| 分组条件策略与计算字段/视图过滤组合产生不可判定语义 | 中高 | 仅允许可翻译为 FilterNode 的桶（与 group.ts 同口径）；计算字段不得作为授权分组键（与不入索引同原则）；谓词单测对拍 computeGroups |
| 字段级掩码在搜索摘要/关联 hydration/公式依赖列侧信道泄漏 | 中高 | 掩码收口在 service 出参而非路由；公式依赖列只用于计算不投影；测试 #16 覆盖四通道 |
| 策略/树版本缓存在多实例下失效不了 | 中（形态性） | 单实例是本期部署前提（ARCH-production）；多实例/PG 切换触发时升级为 Redis pub/sub 或短 TTL，列入 PG 阈值附件 |
| sqlite-vec 0.1.x pre-v1：API/二进制兼容变化 | 中 | 锁版本 + 派生库隔离（坏了不影响主应用）；纯 JS 暴力余弦兜底；>50 万 chunk 切 LanceDB |
| 本地模型在内网 x64 低配机内存/延迟不达标 | 中 | 首日 spike 证伪；EMBEDDING_MODE=off 可独立发版；云端模式零本地资源；optionalDependencies 不拖垮安装 |
| transformers.js/onnxruntime 原生包在客户 CPU 架构（老 Xeon/arm 服务器）兼容 | 中 | spike 覆盖目标采购机型清单；不达标机型走 cloud/off；安装文档写明指令集要求 |
| MCP 模型误调/注入致越权写 | 高（SPIKE 同结论） | 执行期强制鉴权（不信模型参数）、confirm 位、幂等键、审计日志（谁的 PAT、什么参数、结果码）、高危工具可在分发侧 disabledTools（SPIKE:56,150） |
| OAuth 2.1 端点实现成本挤压主线 | 低中 | PAT 先行已满足内网试点；OAuth 为同阶段可选项而非门；复用 jose 不引大型 IdP 库 |
| 菜单引用层与权威树/系统节点同步冲突（资源改名/删除后快捷项悬挂） | 中 | menu_items 只存 nodeId 引用：资源软删后 shortcut 读接口按不可见处理、恢复即还原；资源硬删由外键级联清理引用（§3.4）；别名与资产真名分离（UIUX §7-C12）；唯一父级约束只作用于 nav_nodes，防继承漂移 |
| inheritAncestors 私密开关被误开导致组内集体失访 | 中 | 开关切换在 UI 二次确认并预览影响人数；节点状态在面板与单内容处双向可见；创建者/owner/admin 兜底恒可访问，不会自锁；审计记录切换前后值（O10） |
| kb_members → 每内容节点策略回填放大行数 | 低中 | 批量 INSERT；超大库迁移脚本分批；回填只增表不锁旧业务（WAL 下读写仍可进行，安排低峰） |
| 派生库备份/恢复被客户忽略导致重建耗时 | 低 | runbook 说明 search.db 可弃；首次启动空库自动触发全量索引（outbox 播种）；进度可观测 |

---

## 12. Out of Scope（企业版本期明确不做）

- 用户个人级菜单定制、菜单多套方案/按人分发（仅工作区级一棵树）。
- 跨工作区协作、多工作区切换 UI（模型预留 workspaceId，私有化单工作区交付）。
- ABAC 动态属性策略（IP/时间/设备）、审批流/会签授权。
- 自定义工作流/触发器引擎。
- 记录级（任意行、非分组桶）自由条件授权与字段级黑白名单混合编辑器（本期字段级仅 allow 的 fieldMask 能力裁剪，不做行级自由条件；PRD §12 已排除行级权限）。
- 主体级显式拒绝（deny/effect 列）：D-2/O8 已裁纯 allow 并集，收窄只靠内容叶子 inheritAncestors 开关 + 移除授予来源；不提供 per-subject deny。
- 菜单层承载授权/改变继承：menu_items 永远是引用，不支持"把快捷项拖到别处从而改权限"；跨授权分组移动唯一走 nav_nodes 父级变更 + N6 预览。
- 实时协同/CRDT（ARCH-production 已排除；MCP 的乐观锁不是协同）。
- 向量重排序模型（reranker）、多模态 embedding（图片内容向量化）。
- MCP prompts 原语的完整实现（先 Tools）；MCP Resources 原语本期**仅承载只读"操作逻辑说明书"**（裁决 R-MCP-1，§8.2 闸门一），不接业务数据读通道；Resources 作为通用数据读通道与 prompts 一并放二期。
- 原生/内置 AI 对话能力：本期不内置任何聊天 UI、不做服务端模型编排与自建 Web 对话面板（历史调研中的方案 B 不落地、不预留 UI 代码）；AI 接入统一由 M6 协议无关的标准 MCP server 承载，客户在自选第三方 AI 客户端中使用；自有 AI 产品形态待未来另行立项，复用本期 service/tool-core。
- 面向单一平台（含 WorkBuddy/Buddy 应用）的专属定制：不做 Buddy 应用 iframe 集成、不为任一连接器做专属协议/回调分叉、不承担连接器市场上架商务流程（只交付标准 MCP server + 通用接入说明，能否上架由各平台标准兼容性决定）。
- 旧 members/kb_members/kb_doc_acls 物理删表（双跑后下一期评估）。

---

## 13. 悬而未决（需决策/外部确认）

1. ~~六支柱→里程碑冻结映射~~ **已定（PM PRD §6.1，M0-M7）**；本文 §10.2 已按 M2-M7 回填，本条关闭。
2. 客户目标内网机型清单（CPU 架构/核数/内存），是 M5 首日本地 embedding spike 的输入与发版默认模式的依据。
3. 云端 embedding 的合规供应商与 key 发放流程（数据出域边界需客户书面确认；默认不启用）。
4. OAuth 2.1 是否进 M6 必做范围：取决于实际接入的第三方标准 MCP 客户端是否要求标准 OAuth 授权（不再以任何单一平台的 SSO/免填 token 体验为由）；PAT 先行不变，至少一个明确接入方提出 OAuth 需求或合规要求时升级为必做。早期调研中等待特定平台官方书面回复的开放问题（原 SPIKE 开放问题 1/2）随 R-MCP-2 一并关闭，不再作为依赖项等待。
5. ~~API 统一 `/api/v1/` 前缀改造~~ **已裁决：随 M2/M3 实施。** 新前缀挂载、旧 `/api` 路径保留一个迭代后下线；在 M3 出口冻结 openapi.yaml 前定版（现状全部挂 `/api/`，见 `index.ts:94-105`）。
6. ~~§8.2"连接即列全集 + 执行期强制鉴权"与 PRD MC2"tools/list 按账号动态过滤"的口径差异~~ **已由裁决 R-MCP-1 关闭。** 结论 = 可发现性与可执行性分离的**双闸门**：闸门一 `tools/list` 按账号有效权限动态过滤（工具仅在账号至少一个资源上持对应动作位时出现，schema 按资源/字段收窄），闸门二执行期 service 首行 `enforce` 强制鉴权、被裁工具直调返回"不存在"口径（UNKNOWN_TOOL/404，不泄漏存在性）、参数内资源越权二次拦截；**操作逻辑说明书（三套机器语言的纯语言文档，经 MCP Resources 只读承载）对所有已连接客户端可发现**，故"语言可学、无权不可调"。详见 §8.2，出口验收见 §10.2 M6。
