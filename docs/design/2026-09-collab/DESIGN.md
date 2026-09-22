# 三类内容多人实时协同编辑 · 设计方案

> 状态：**草案 · 待修订**（2026-09-19）
>
> **⚠️ 勘误（2026-09-19 晚，必须先读）**：本文 §1.6 与 §6 中「文档编辑器 = Slate、可接现成绑定」的判断**是错误的**。实际是：`slate`/`slate-react` 是 **Drawnix 画布内部文字编辑的传递依赖**，文档编辑器为**自研的原生 `contentEditable` + 扁平 `Block[]` 数组 + Markdown 落库**（`packages/blocks/src/blocks.ts:31-62`、`WysiwygEditor.tsx:178-181`、`:203`、`:331-349`）。
> 受影响：§6 文档列的「现成绑定」不成立，文档接入点与工量需按新结论重写；§10 的 R1 风险项作废。
> 不受影响：§2.1 引擎选型、§3 数据模型、§4 协议、§5 租约、§7 权限、§8 侵入点、§9 阶段划分。
> 范围：文档、画布、数据表 —— 多人实时协同编辑
> 本文是**开发跟进文档**，不是给产品负责人看的汇报。面向产品负责人的大白话说明见本目录 `README.md`。

---

## 0. 产品决策（已由产品负责人拍板，不可自行更改）

| # | 决策 | 影响 |
|---|---|---|
| D1 | **真协同（自动合并）** | 必须引入 CRDT；不允许"轮流占用式"简化 |
| D2 | **允许引入外部协同引擎** | 本功能对"禁新增前端依赖"公约**例外**，需在 ADR 记录豁免范围 |
| D3 | **三类一起做**（文档 + 画布 + 数据表） | 不按期分裂交付；底座一次建好 |
| D4 | **匿名参与者参与协同** | 必须新造"访客主体"；光标与在线名单显示「匿名」 |
| D5 | **画布一期只做「图形级」合并** | 允许"两人同时改同一个图形内部"时一方被覆盖；同图形内部细粒度留二期 |
| **D6** | **UI 冻结**：允许引入的是**同步引擎**，**不是编辑器**。现有 UI 与交互**零变化** | 三类内容的现有组件与其全部能力必须原样保留（见下） |

### D6 展开（产品负责人 2026-09-21 明确红线）

> 原话：*"现有的 UI 交互和功能都是已经成熟的了，如果引入别的引擎加入会造成 UI 交互功能的破坏和 UI 界面的大幅度变化，那么就得考虑只引入技术方案，而不是整个编辑器都被改造……如果你能最大程度保留原本的 UI 交互功能的情况下引入我也不介意。"*

**允许引入的**：Yjs（一个同步引擎库，不渲染任何界面）。
**禁止引入的**：任何**编辑器 / 画布 / 表格组件**的替代品（例如用别人的协同富文本编辑器换掉自研编辑器、用别人的协同白板换掉 Plait、换掉现有 Grid）。

**三类内容的 UI 与交互必须原样保留**：

| 内容 | 必须保留的东西（举例，非穷举） |
|---|---|
| 文档 | 自研 `contentEditable` 编辑器（`WysiwygEditor.tsx`）及其全部块类型、快捷键、右键菜单、上下插入热区、大纲、编辑/源码/预览模式切换、版本历史入口 |
| 画布 | Drawnix + Plait 的组件、工具栏、样式条、色板、浮层、手势、缩放/框选行为 |
| 数据表 | 现有 Grid、各视图（看板/画廊/日历/详情/表单）、字段渲染器与单元格编辑器、工具栏、筛选/分组/排序 |

**协同能力一律以「叠加层」形式加入，不改现有组件内部结构**：
- **协同光标**：编辑器 / 画布**之上的独立浮层**，**不得写入编辑器内部 DOM**。
- **在线头像列表**：内容页固定区域的**新增** UI（属需求本体，D4/需求第 4 条）。
- **单元占用提示**：复用现有占位 / 禁用态的视觉，**不新造视觉语言**；一律走 `gx-*` token。

**机械验收判据（必须执行）**：**在不建立任何协同连接（单机编辑）时，页面 DOM 结构与引入前逐元素一致。** 该判据进 §9 阶段 2/3/4 的验收清单。

---

## 1. 现状取证（全部亲验，含文件:行号）

### 1.1 三条写入链路与变更粒度（**三态不同构，这是本次改造的核心矛盾**）

| 内容 | 前端变更粒度 | 后端写入 | 并发保护 |
|---|---|---|---|
| 文档 / 画布 | **整篇覆盖** | `PUT /api/kb/docs/:docId/content` | 乐观锁 `baseVersion`（`kbDocWrite.ts:51-60`） |
| 数据表 | **单元格级** | `PATCH /api/records/:recordId` body `{fields:{[fieldId]:next}}` | **无**（纯 last-write-wins） |

- 文档与画布**共用同一存储与同一持久化 hook**：`useDocPersistence.ts`（防抖 1200ms，`flush` 走 `keepalive` PUT）。画布入口 `DrawnixCanvas.tsx:274-280`：
  ```ts
  function handleChange(els: PlaitElement[]) {
    if (readonlyRef.current) return;
    const json = JSON.stringify(els);
    if (json === lastEmitted.current) return;
    lastEmitted.current = json;
    onContentChange?.(json);
  }
  ```
  → **画布内容是 `PlaitElement[]` 的整篇 JSON**；结构上是**元素数组**，故"图形级"可映射为 `Y.Array<Y.Map>`，D5 可行。
- 数据表 `GridView.tsx:210-220` `commitValue` 已是单元格级 → 数据表**存储模型天然是"最小单元"形态**，无需改造数据结构。
- 后端写实现唯一真源：`domain/kbDocWrite.ts:43 saveDocContentTx`（REST 与 MCP 共用，文件头 `:3-5` 明写动机是"避免语义漂移"）。

### 1.2 服务端**零实时通道**

- `apps/api/src/index.ts:46`（`startTcp`）与 `:86`（`startUnixSocket`）两处各自 `createServer(getRequestListener(app.fetch))` → 具备挂原生 `upgrade` 的物理条件。
- 全仓 **零 WebSocket / SSE / EventSource**。
- `:63-73` 已有优雅关闭链：`server.close()` → `stopSearchWorker()` → `prisma.$disconnect()` → `exit`，**10s 强制退出兜底** → 协同 flush 必须挂进这里，否则重启丢最后一段编辑。

### 1.3 权限判定的唯一出口

- `domain/authz/libraryPolicy.ts`（14 导出）：`resolveKbAccess` / `resolveBaseAccess` / `resolveBaseAccessByTable/ByView/ByRecord` / `contentAccessOf` / `tableAccessOf` / `fieldWriteGate` / `firstUnwritableField` / `humanCanWriteField` / `visibleLibraryIds` / `synthesizeAccess` …
- `domain/share/shareCaps.ts`（8 导出）：`resolveDocShareCaps` / `resolveTableShareCaps` / `shareVisibleFields` / `externalFieldGate` / `canSharerGrantDocEdit` …
- **★ 不存在访客主体**：`domain/authz/subjects.ts:28 resolveSubject(userId: string, client)` 的 `userId` **必填**；外链场景只能借分享人 `link.createdBy` 作 `sharerId`（`shareCaps.ts:33`），审计 actor 亦记分享人（`externalDoc.ts:5`）。→ **D4 是本次最大新写面**。

### 1.4 并发与写入基础设施

- `db/writeQueue.ts:41 createWriteQueue`，`db.ts:102` globalThis 单例，**并发度恒 1**；铁律 `writeQueue.ts:7`「回调体内绝不能再入队（自死锁）」。
- `db.ts:117 withWriteTx` / `:129 runWrite` / `:138 withWriteBatch`。
- **数据表无任何版本字段**（`schema.prisma:137 model Record` 仅 createdAt/updatedAt/deletedAt），`domain/recordWrite.ts:392` 无条件 `tx.record.update` → 并发写 = last-write-wins。
- 审计：`audit/audit.ts` 零依赖 JSONL；事件枚举实测 **42 枚**（`audit.ts:8`）。

### 1.5 ★ 内容保存的派生链（最高风险点）

`kbDocWrite.ts:43-77 saveDocContentTx` 在更新 content 之后串行执行：

```
条件更新（乐观锁） → maybeAutoSnapshotTx（10 分钟窗口封顶）
                  → enqueueChangeEventTx（搜索索引 outbox）
                  → syncNavFromEntitiesTx（:75）
```

`nav/sync.ts:56-61` 的 `buildExpectedNodes(tx)` 是**全库扫所有 base/table/view/kb/doc/canvas 重建期望节点集** + reconcile + rebuildPaths + bumpNavVersion。

→ **今天每一次内容保存都跑一次全库 nav 对账**。协同若热路径直连此链路，将把已登记未收口的性能债（任务 #158：nav N+1 批量化 / 10 万节点 P95）放大为 T0 风险。

**可比数（用于裁定 #158 是否构成前置）**：今天文档自动保存防抖 1200ms（`useDocPersistence.ts:152-155`）且每次保存都跑全库对账 → 单文档 ≈ **0.83 次/秒**，已是上线行为。协同按"两档写"后冷归结 ≤ 0.033 次/秒/房间 → **低约 25 倍**，且协同会取代该自动保存路径。
→ **裁定：#158 不构成协同上线前置**，但登记为「协同依赖的已知债」，并加参数护栏（见 §7）。

### 1.6 其它已确认事实

- `KbDocVersion`（`schema.prisma:389-405`，表 `kb_doc_versions`）是**整篇 content 快照**，`@@unique([docId, version])`，自动快照上限 50、手动不淘汰。
- `kb_docs.updatedAt` 是 **Prisma 客户端侧 `@updatedAt`**（`:359`），全仓迁移**零 TRIGGER**，裸 raw SQL 更新**不会 bump**；而 nav 节点 `ord` 依赖 `updatedAt desc`。
- `KbDoc.updatedBy` **非空**（`:357`），全仓**无 "system" 哨兵**。
- 前端文档编辑器 = **Slate**（`apps/web/package.json:45-47`：`slate ^0.116.0` / `slate-react ^0.116.0` / `slate-history ^0.115.0`）；画布 = **Drawnix + Plait**（`@drawnix/drawnix 0.4.0-0`、`@plait/core 0.89.2`）。
- 备份：`ops/backup.ts:205-232` 只备份主库 + uploads；当前单文档最大 content 3.1KB（canvas）。

---

## 2. 架构总览

### 2.1 选型

| 层 | 选型 | 理由 |
|---|---|---|
| CRDT 引擎 | **Yjs `13.6.32`** + `y-protocols 1.0.7` | 唯一有成熟 awareness 协议（在线状态/光标）；`Y.Array<Y.Map>` 天然适配表格行×列与画布元素数组；**服务端纯转发、不解析内容** |
| WS 库 | **原生 `server.on('upgrade')` + `ws@8.21.3`** | `@hono/node-ws` 已 DEPRECATED；本机 `@hono/node-server@1.19.17` 无 `upgradeWebSocket`，升 v2 需改两条 listen 路径，收益不抵风险 |
| 持久化 | **内存 Y.Doc + SQLite BLOB 旁路表 + 合批 flush** | 排除 `y-leveldb`（引入第二存储引擎）、`@hocuspocus/server`（其 SQLite 扩展依赖 `better-sqlite3@^12.6.2`，与本仓 `^13.0.3` 双实例争锁） |

实测体积（本机）：5000 汉字文档 15KB；表格 100 行×10 列 20.7KB；画布 500 图元 42KB；**单字符增量 18B**。

### 2.2 房间模型

- `roomId = "<kind>:<objectId>"`，`kind ∈ {doc, canvas, table}`（沿用既有词汇；`kb_docs.kind` 已区分 doc/canvas）。
- 房间持有：`Y.Doc` 实例、连接集合、**最后编辑者标识**、`dirty` 标志、`baseVersion` 基线。
- 连接集合天然承载在线状态与占用租约（见 §5）。

### 2.3 ★ 两档写（核心设计）

```
                    ┌── 热路径（防抖 500ms）─────────────────────┐
用户编辑 → Y.Doc 变更 →│ 只写 collab_docs 一行 state BLOB          │  不碰 kb_docs/records
                    │ 不 bump updatedAt / 不跑 nav / 不发 outbox │  零派生负载
                    └──────────────────────────────────────────┘

                    ┌── 冷归结（最后一人离开立即 + 长会话每 30s 兜底，且必须 dirty）─┐
                    │ 文档/画布：withWriteTx + saveDocContentTx（复用唯一真源）      │
                    │   同一事务内一次跑完：content + searchText + contentVersion+1  │
                    │   + updatedBy + updatedAt + maybeAutoSnapshot + outbox + nav   │
                    │ 数据表：updateRecordTx 逐条 diff 落库                          │
                    └──────────────────────────────────────────────────────────────┘
```

**为什么这样切**：
1. 热路径零派生负载 → 彻底避开 §1.5 的全库 nav 对账高频问题；
2. 冷归结**复用既有 domain 写事务**而非另开同构入口 → 不违反 `kbDocWrite.ts:3-5` 的"避免语义漂移"动机，`maybeAutoSnapshotTx` / outbox / nav 全部照旧生效，**版本历史与搜索索引不留空洞**；
3. 残留代价只有一个参数：列表「最近更新」排序与语义检索滞后 ≤ 归结间隔（默认 30s，空置 0s）。

**冷归结的硬约束**（缺一即错）：
- ① 房间必须记录**最后编辑者的真实 userId**；无编辑者则跳过归结（`updatedBy` 非空且无哨兵）；
- ② **匿名编辑者**的 `updatedBy` 记**分享人 userId**（与 `externalDoc.ts:5` 既有外链口径一致，不新造哨兵）；
- ③ 必须捕获 `VersionConflictError`（`kbDocWrite.ts:22-27`）并按 §3.2 规则处理，**不得当作归结终态**；
- ④ 30s tick **必须走 dirty 门** + **单个全局定时器**（非每房间一个），否则空闲房间也全库扫；
- ⑤ 归结间隔护栏 **不得 < 1.2s**（不得密集于今天的自动保存）。

---

## 3. 数据模型改动

### 3.1 新表 `collab_docs`（迁移 **#31**）

```sql
CREATE TABLE collab_docs (
  room_id    TEXT PRIMARY KEY,        -- "<kind>:<objectId>"
  kind       TEXT NOT NULL,           -- doc | canvas | table
  state      BLOB NOT NULL,           -- Y.encodeStateAsUpdate(doc)
  seq        INTEGER NOT NULL DEFAULT 0,
  base_version INTEGER,               -- 房间建立时的 kb_docs.contentVersion
  updated_at INTEGER NOT NULL
);
CREATE INDEX collab_docs_kind_updated ON collab_docs(kind, updated_at);
```

- 列名 camelCase + 尾部注释声明，照 `record_field_index` 先例；**不加 Prisma model**（raw-only 旁路表）。
- 多态主键 + `kind` 判别列，照 `share_links.objectType/objectId` 先例（不加 FK，应用层校验）。
- **`base_version` 必须保留**：它是判断"房间空置期间是否被 HTTP PUT 改过"的唯一依据，缺失会导致**静默丢编辑**。
- **BLOB 往返已实测闭环**：Prisma raw × SQLite blob 全等（含 0x00/0xFF 边界），42KB blob 完整往返，`ON CONFLICT DO UPDATE` + `seq` 递增生效，**交互事务内 `tx.$executeRawUnsafe` 生效**（与 `withWriteTx` 适配）。`Uint8Array` 直绑即可，**base64 备选方案可删**。
- 配 `prisma/docs/rollback/*.down.sql`；三处自动对账（`scripts/ci-quality.sh:94-112`、`ops/readiness.ts:56-68`、`ops/backup.ts:252`）无需改常量。

### 3.2 与既有乐观锁契约的接合

- 房间建立：读 `kb_docs.contentVersion` 存入 `base_version`，`bindState` 时 `Y.applyUpdate`。
- 冷归结：带 `base_version` 走 `saveDocContentTx` 的条件更新。
- **房间空置期间被 HTTP PUT 改过**（`contentVersion` 已推进）→ 条件更新 count=0 → 捕获 `VersionConflictError` → **不放弃**：重新读库中 content 重建 Y.Doc（或按 §3.3 合并策略），更新 `base_version` 后重试一次。
- 回滚路径**必须同步修**：`routes/kb/versions.ts:69-83` 回滚改了 content 但**不 bump contentVersion** → 房间的 base 判断失效 → 冷归结会覆盖回滚结果。**这是协同正确性的硬依赖**，列入阶段 0 前置加固（不单独立项）。

### 3.3 运行中的 HTTP PUT 与 CRDT（**不能用 409**）

房间在线时若 `PUT /api/kb/docs/:docId/content` 直接写库，30s 后冷归结会把房间的 Y.Doc 写回 → **HTTP 侧的改动被静默吞掉**。

**裁定**：
- 房间**无**在线连接 → PUT 走原有路径（今天的行为，零改动）。
- 房间**有**在线连接 → PUT 的 content 作为**一次 CRDT 更新注入房间**（服务端换算为 Y.Doc 变更后广播），由房间统一归结落库，HTTP 响应语义不变（200 + 新 `contentVersion`）。
- 一期若"注入房间"实现成本过高，可退化为"写库 + 通知房间重新 bindState"，但必须把**"重建会打断在线编辑"**记为已知限制。
- **明确不做**：一律 409 —— 会打断 MCP / AI 写入（`mcp/tools/doc.tools.ts:39`、`canvasWrite.tools.ts:43`），构成功能回退。
- `useDocPersistence.ts:168-181` 的 `pagehide` keepalive PUT 走同一路由，**是最易绕过闸门的入口**，需单列用例。

### 3.4 版本历史策略

- 协同**不新增**版本历史写入点；沿用 `maybeAutoSnapshotTx` 的既有 10 分钟窗口（成本已封顶）。
- **Yjs 二进制只进 `collab_docs`，绝不进 `KbDocVersion`**（否则整篇快照表按 42KB/次膨胀）。
- **验收项**：协同上线后复核 `kb_doc_versions` 行数增长曲线与主库体积，与"备份时长 + `GX_MIN_DISK_MB` 余量"一起纳入（画布一份快照可能从 3KB → 40KB+）。

### 3.5 数据表侧的写冲突收口（**按行，不是按表**）

> **2026-09-21 复核修正（以此为准）**：原稿"7 个写点 / 两个后端出口"已过期。下文为重新穷举后的实测订正，行号以复核当日为准。

**前提事实（复核后）**：
- 前端写点 **8 个**（原 7 个 + 新增 1 个，见下表）；`updateRecord` 的**物理调用点只有 5 个**（`GridView.tsx:278` 与 `:301` 共用 `:213` 的 `commitValue`）。
- 后端出口 **4 个端点**，但**公共汇点只有 2 处**：
  1. `updateRecordTx`（`domain/recordWrite.ts:387`）—— REST `PATCH /api/records/:recordId`（`records.ts:372`→`393`）、**MCP** `record.update_record`（`mcp/tools/record.tools.ts:276`）、**分享 / 嵌入公开写**（`publicTable.ts:70/78`、`publicEmbed.ts:122/129` → `externalRecords.ts:216`）**三路共用**；
  2. `POST /api/records/bulk-update`（`records.ts:527`→`562`）**绕过 `updateRecordTx` 直调 `applyFieldWrites`**（`recordWrite.ts:141`）—— 最易漏。
- 已证否的旁路：批量粘贴、填充柄拖拽、键盘隐式提交（`onPaste|fillHandle|fillDown` 在 grid/views 下 **0 命中**）。
- **CSV 导入不写存量行**（`records.ts:606` 只 `record.create` + `applyFieldWrites`），**不收口**；公式回填无独立端点。
- **★ 409 必须在权限闸门之后、事务之前抛**（`resolveTableMask` `maskGate.ts:42`、`runMaskWriteGate` `recordWrite.ts:29`、`fieldWriteGate` `records.ts:392` 之后），否则会白占写队列。

**收口位置定案：服务端写入口**，**不改前端 8 个组件**（与「写入链路唯一出口」纪律一致）。**插桩点仅 2 处**：`updateRecordTx` 内 + `records.ts:562` 批量事务前（按 `scopedIds` 逐行判）。

**判定粒度：按行。**
- 表房间是**每表一个** → 若按「表房间在线 → 409」，只要有人打开这张表，**全表所有 REST / MCP 写都会被挡**（含 CSV 导入、公式回填、MCP write），副作用不可接受。
- 物理冲突域是**行**（`Record.fields` 是整行 JSON）→ 定案：**某行被 awareness 占用 → 该行的 REST 写返回 409；未占用行照常放行**。
- 服务端**只解析 awareness 载荷（本身是 JSON），不解析 Y.Doc 内容** → 「服务端只中转、不解析内容」的核心原则不变，内容仍是黑盒二进制，只多一份结构化 presence。
- 409 必须带可展示的信息（哪一行、被谁占用），供前端提示「该行正在被某某编辑」。

**8 个写点的处置**（路径已订正：`DetailLayout` 在 `features/detail/`，`KanbanView` 在 `features/views/`，原稿的 `features/grid/` 前缀已过期）：

| 写点 | 处置 |
|---|---|
| `features/grid/GridView.tsx:301` 编辑会话提交（实际 `updateRecord` 在 `:213`） | **软锁**（按行 409 的唯一适用点） |
| `features/grid/GridView.tsx:278` checkbox（同上，共用 `:213`） | 改走 **Y.Map**（瞬时原子写，不需锁） |
| `features/views/KanbanView.tsx:77` 看板拖卡（`moveTo`） | 改走 **Y.Map** |
| `features/detail/DetailLayout.tsx:338` 关联即时写（`commitLinks`） | 改走 **Y.Map** |
| `features/grid/GridView.tsx:751` 批量修改（`bulkUpdateRecords`） | 放进**单个 Y transaction** 批量写 N 行的同名 key（保持原子）；服务端侧落在 `records.ts:562`，**语义待裁决**（整批 409 vs 跳过占用行） |
| `features/detail/DetailLayout.tsx:827` 详情视图单元格（`DetailCell.commit`） | 有**第二套 draft/editing 语义** → 软锁登记表必须是**跨组件模块单例**，否则单边屏蔽形同虚设 |
| `features/detail/DetailLayout.tsx:778` 关联记录弹窗（`save`，写 peer 记录） | 单条 `updateRecord` 写多字段、可能跨表到 peer 记录 → 单事务写多 key 可覆盖；**跨表房间归属待确认** |
| **`features/kb/canvas/TableEmbedPreview.tsx:160`（新增）** 画布内嵌数据表单元格 | 经 `table-embed-data.ts:154` → `Records.update`（`client.ts:660`）。**「画布 × 数据表」交叉点，恰恰是本期最先撞上的场景 → 必须入清单** |

### 3.6 结构变更独占（**必须，非可选**）

**风险**：字段删除（`GridView.tsx:246`）后，Y.Map 中对应 key 成为孤儿；冷归结写回 `Record.fields` 时会把**已删字段的值复活**。且「A 正在编辑、B 已删该字段」目前无任何裁决。

**定案**（与 §3.5 同构 —— 按「是否被占用」而非「房间是否在线」，避免阻塞日常管理）：
- **某字段正被编辑（awareness 占用该字段的任一单元）→ 禁止删除该字段、禁止变更其类型**；未被占用的字段管理操作照常放行。
- **回收站还原**会重建行，与在线行冲突 → 房间在线时禁止该表的记录还原。
- **兜底：冷归结时做孤儿 key 剪枝** —— 写入 `Record.fields` 时忽略当前字段集之外的 key，并记 ops 日志（防漏）。

### 3.7 冷归结的四条必做（缺一即错）

**前提修正**：`withWriteTx`（`db.ts:117`）与 `runWrite`（`:129`）**都走同一个 `writeQueue.run`** → L1/L2/L3 三层（含 defaults 的全部 10 个调用点，已穷举，**无一嵌套**）**早已全部在唯一写队列内**，现状健康，**不需要**为协同改造其排队方式。真正的约束对象是**协同自己引入的写者**。

1. **冷归结必须入队**：一律 `withWriteTx("collab.flush", ...)`。**明令禁止「裸定时器 + 直接 prisma 写」** —— 这是初版设计中最危险的一个默认值，会让队列保证的「交错不发生」直接失效。
2. **冷归结必须做键级 merge**：即使同队列串行，Y.Doc 中的行状态也**不知道** defaults 在两次 flush 之间算出的键；整行覆写仍会把它们抹掉。
3. **`changedFieldIds` 语义重定义**：现取自 REST payload 键（路由内实际变量名是 `changed`），协同路径**没有 payload** → 必须改由 flush 记录的 **touched keys** 提供。否则「手动值优先」（`defaults.ts:332` `if (changedFieldIds.has(f.id)) continue;`）在协同写入时**静默失效**。
   **★ 复核修正：计算点不是 1 处而是 3 处**（原稿只统计了第 1 处）：
   - `records.ts:398`（PATCH，用于 401 / 420）
   - `records.ts:577`（bulk，用于 581）← **原稿漏**
   - `mcp/tools/record.tools.ts:280`（MCP，用于 283）← **原稿漏**

  消费点在 `defaults.ts:316`（形参）/ `:332`（手动值优先）/ `:338`（触发字段命中）。**改造面由"很小"改判为"3 处计算点 + 1 处消费语义"**，但仍是唯一需要改动既有语义的地方。
4. **冷归结失败不得静默**：既有 defaults 的失败惯例是一律 try/catch 吞掉（五处），**该惯例不得复制到协同** —— 丢的是用户已确认、不可重放的输入。定为：失败 → 保留 `dirty` + 退避重试 + 显式 ops 日志。

**已知限制（非缺陷，有意取舍，一期接受；已如实告知产品负责人）**：

1. **默认值 / 点引用公式不实时反哺**：房间在线期间服务端算出的值不会推给在线客户端（Y.Doc 在客户端，defaults 写的是 DB）→ 需**下次进入或刷新**才可见。二期若需消除，可让服务端把计算结果作为 remote update 推入 Y.Doc（届时才需定「同一格两种来源」的仲裁规则）。
2. **行的新增 / 删除不在 CRDT 模型内**：导入新行、他人删行需**刷新**才可见（行是 `Record` 实体，涉及主键生成与回收站语义，不属字段值同步）。二期若纳入，`defaults.ts:369 materializeSubtable` 的种子行重播种（服务端唯一会删行的写点）是第一个冲突点。
3. **有序列表重编号会扩大差分**：同一列表被并发编辑时属于冲突区域（**能收敛，但不一定合意**）。

---

## 4. 接口与消息协议

### 4.1 握手与认证（**浏览器 WS 不支持自定义请求头**）

Web 端主凭据是 `X-GX-Token`（因飞牛 CGI 网关会吞 `Authorization`），但 `new WebSocket()` 无法带自定义头。三方案取舍：

| 方案 | 做法 | 取舍 |
|---|---|---|
| A. query 参数 | `?t=<token>`，y-websocket 3.1.0 原生支持 `params`（源码 `:317-321`） | 简单；**token 会落 nginx access_log** → 该 location 关日志或 `log_format` 去 `$args` |
| B. 子协议 | `protocols: ['gx.<token>']`（源码 `:220`） | 不进 URL；仍可能进 `$http_sec_websocket_protocol` |
| **C. 一次性票据（推荐终态）** | `GET /api/collab/ticket`（走现有 `client.ts`，正常带 `X-GX-Token`）换 **60s 一次性短票**，再按 A 连接，服务端内存核销 | 日志里只有短票；需一个 HTTP 端点 + 内存票据表 |

### 4.2 端点与房间凭据

- 端点：`/ws/collab/<roomId>?t=<ticket>`。
- 登录用户房间凭据：一次性票据 → 服务端解析出 `userId`。
- **匿名参与者**：以**分享 token** 作为房间凭据（`?t=<shareToken>`），走现有 public share 校验链（含 `canEdit` 档位）。
- **★ 拒绝 upgrade 无效**：浏览器只看到 opaque `1006` 并无限重连（y-websocket README 明示）。必须**先 accept 再 `ws.close(4401)`** —— `4400–4499` 为私有段，客户端判定为「永久错误」而停止重连。
- 消息层：服务端只需认 `y-protocols` 四种消息码（`0=sync / 1=awareness / 2=auth / 3=queryAwareness`），把 `Uint8Array` 广播给同房 socket，**全程不 import 任何编辑器实现**。

### 4.3 前后端消息/接口清单

| 方向 | 内容 |
|---|---|
| HTTP `GET /api/collab/ticket` | 换一次性连接票据（60s，单次核销） |
| HTTP `GET /api/collab/presence?roomId=` | 在线名单快照（首屏兜底，WS 未连上时也能显示） |
| WS → | `sync`（Y.Doc 增量）、`awareness`（光标 / 昵称 / 颜色 / 占用的单元） |
| WS 权限消息 | 服务端 → 客户端：`{"type":"revoked","reason":"..."}` 主动踢线；客户端收到后转只读 |
| 关闭码 | `4401` 无权限/票据失效、`4403` 只读连接尝试写、`4408` 握手超时 |

`packages/shared-types` 新增：`CollabRoomRef`、`CollabPresenceEntry`（`{ id, kind: 'user'|'guest', nick, color, selection, leases }`）、`CollabTicketResponse`、`CollabDenyReason`。

---

## 5. 协同光标、在线状态与单元占用（租约）

### 5.1 光标与在线状态

- 载体：**Yjs awareness**（`y-protocols/awareness`），随连接生命周期自动进出，无需服务端存储。
- 光标位置：**Yjs relative position**（`Y.createRelativePositionFromTypeIndex`），远端换算回本地的 `path/offset` 与 PlaitElement id / `(recordId, fieldId)`。
- 匿名者：`nick = "匿名"`、`color` 由服务端分配，`kind = 'guest'`。
- 在线名单 UI：内容页固定区域头像列表（进入/离开实时更新）。**同浏览器多标签页不多开 WS** —— `BroadcastChannel` 在标签页间转发；同账号两个标签页 awareness `clientID` 不同，显示为两个光标（符合预期）。

### 5.2 单元占用（租约）—— **不建独立存储**

**设计要点：租约借用 awareness 的生命周期，不落库、无清理任务。**

- 单元定义（按 D5 与三类结构）：

| 内容 | 租约单元 | 标识 |
|---|---|---|
| 文档 | 块级（段落/标题/列表项等 Slate block） | block id（无则段落路径） |
| 画布 | **元素级**（图形/连线） | `PlaitElement.id` |
| 数据表 | 单元格级 | `(recordId, fieldId)` |

- **申请**：进入编辑态即向 awareness 写入 lease 声明（本地即时生效，无需服务端裁决，避免引入往返延迟）。
- **仲裁**：同一单元出现多个 lease 时按 **`clientID` 升序 / 或首次声明时间戳**确定性裁决，保证两端看到同一个胜者。
- **续约**：编辑态持续期间每 5s 刷新 lease 时间戳。
- **超时释放**：lease 时间戳超过 **30s** 未续约即视为失效，本地自动解除遮挡。
- **断线释放**：服务端每 25s `ws.ping()`、30s 无 `pong` → `terminate()`（对齐 y-websocket-server 的 30s pingTimeout）→ awareness 剔除 → 所有租约随之消失。**双保险**（端侧超时 + 服务端剔除）消灭幽灵锁。
- **冲突回退**：CRDT 会自动合并，租约只是**体验层遮挡**（防止两人改同一处造成画面跳动与误操作），**不承担数据安全职责**。因此租约失效、误判、丢失均不导致数据丢失 —— 这是本设计把"占用控制"做成软锁的前提。
- 数据表额外一层：`fieldWriteGate`（`libraryPolicy.ts:149`）已能做字段级拒写，租约与其**职责正交**（前者是权限，后者是体验）。

---

## 6. 三类内容的接入差异

| | 文档 | 数据表 | 画布 |
|---|---|---|---|
| 编辑器 | **自研**：原生 `contentEditable` + 扁平 `Block[]`（**非 Slate**；`WysiwygEditor.tsx:178-181`、`:203`） | 自研 Grid | Plait `0.89.2` |
| 落库形态 | Markdown 字符串 | `Record.fields` 整行 JSON | `PlaitElement[]` 的 JSON |
| CRDT 映射 | **单个 `Y.Text` 装整篇 Markdown** + **shadow-copy 最小差分** | 每 record 一个 `Y.Map`（key = `fieldId`） | `Y.Array<Y.Map>` 管顺序 + 每图元 `Y.Map`（key = `${creatorClientId}:${PlaitElement.id}`），**图元内文本用 `Y.Text`** |
| presence | Markdown 字符偏移（`b<seq>` + offset） | `{recordId, fieldId}` | `element.id` |
| 现成绑定 | **无** —— `@slate-yjs` **不适用，勿装** | 无（结构契合，自写量小） | 无（`board.apply` 已验证可拦截，**仅作本地兜底 / 审计**，不作传输层） |
| 一期粒度 | 字符级自动合并 | 单元格级自动合并 | **图形级**；**图元内文字按字符合并**，位置 / 颜色等属性可能被覆盖（D5） |
| 需补的存量债 | 无 | **补并发保护**（现为 last-write-wins） | 无 |

**各类的关键约束（实施时必须遵守）**：

- **文档**：编辑器内 `Block.id` **稳定**（`newBlock()` 生成，可直接作 Y 键）；远端变更**按差分热补 DOM，禁止整篇重解析**（否则本地光标跳）；协同光标用 `(blockId, 文本 offset)` 坐标 + **浮层渲染**（不进编辑器 DOM）；需补 `inlineMdToHtml` 的**「源码 offset → DOM offset」映射**；Markdown ↔ `Block[]` 往返**只保证「二次起幂等」**（首次是规范化）。
- **数据表**：**行的新增 / 删除不在 CRDT 模型内**（导入新行、他人删行需刷新）；软锁 + 提交时单写。
- **画布**：op 流已否（path 寻址、并发三条硬分叉，§11）；`set_selection` → awareness、`set_viewport` → 纯本地、拖拽 =「awareness 跟手 + `pointerup` 落终值」。

- 文档接入点：`apps/web/src/features/kb/WysiwygEditor.tsx` + `useDocPersistence.ts`。
- 画布接入点：`DrawnixCanvas.tsx:274 handleChange`（改为"变更 → Y.Doc 增量"而非"整篇 JSON 覆盖"）；`readonlyRef.current` 分支与协同只读态语义一致，可直接复用。
- 数据表接入点：`GridView.tsx:210 commitValue` 保持单元格级；后端 `updateRecordTx` 之外需补一个"从 CRDT diff 落库"的批处理路径。
- **待 POC 结论补充**：`@slate-yjs` 与 slate 0.116 的兼容性、是否需 patch、inline void 元素（@提及 / 嵌入块 / 数据表嵌入）在绑定层的特殊处理。

---

## 7. 权限与安全

### 7.1 三档身份

| 档 | 凭据 | 能做什么 |
|---|---|---|
| 可编辑 | 登录票据（`userId`）或分享 token（`mode=edit` 且分享人未降权） | 收发 CRDT 更新、占用单元、显示光标 |
| 只读 | 登录票据但库/表/文档不可写；或分享 token `mode=view` | **可连接**：看实时内容、看在线上、看光标；**写消息被丢弃**（不断开连接） |
| 匿名 | 分享 token | 同"可编辑"或"只读"（由分享设置决定），昵称「匿名」 |

### 7.2 校验落点

- **握手时（一次）**：复用 `resolveKbAccess` / `resolveBaseAccessByTable` / `contentAccessOf(access).update` / `resolveDocShareCaps`。分享态**不可缓存**（`shareCaps.ts:8` 动态降级纪律）。
- **每条消息（高频）**：**禁止**每消息直调 `resolveKbAccess`（≥3 条 SQL / 次）。做法＝连接建立时缓存"本连接是否可写"结论，配合 ① 定期刷新（30s）② 收到失效通知立即刷新 → **降权主动踢线**（`{"type":"revoked"}` 或 `close(4401)`）。
- **连接断开时**：复用 `withWriteTx + saveDocContentTx` 落盘终态；`runWrite` 用于默认值联动补偿写。
- 写消息速率/体量上限：参照既有 `bodyLimit.ts` 与文档 10MB 上限另设消息级门。
- **纪律**：WS handler 若已在 `withWriteTx` 内，**不得再入队**（`writeQueue.ts:7` 自死锁）。

### 7.3 新增的访客主体（D4 的最大新写面）

- 新增 `resolveCollabSubject(credential) → { kind: 'user'|'guest', userId?: string, shareLinkId?: string, nick: string, color: string }`。
- 访客 `userId = null`，但**冷归结的 `updatedBy` 记分享人**；审计 actor 亦记分享人（沿用 `externalDoc.ts:5` 口径）。
- 现有 `resolveSubject(userId: string, ...)` **不可直接复用**，需在其上加协同专用入口，避免污染既有签名。

---

## 8. 对现有代码的侵入点清单

| # | 文件 | 改动 |
|---|---|---|
| 1 | `apps/api/src/index.ts:46` / `:86` | 两处 `createServer` 后各加 `attachCollab(server)`（**漏一处 = 某种部署形态下协同不工作**） |
| 2 | `apps/api/src/index.ts:63-73` | `shutdown()` 内加 `await collab.flushAllAndClose()`，且须在 10s 兜底强退之前 |
| 3 | `apps/api/src/domain/kbDocWrite.ts` | 冷归结薄包装复用 `saveDocContentTx`（不改其语义），新增"从 Y.Doc 取 content/searchText"的适配 |
| 4 | `apps/api/src/routes/kb/docs.ts:187` | 房间在线时的 PUT 处理（§3.3） |
| 5 | `apps/api/src/routes/kb/versions.ts:69-83` | **前置加固**：回滚必须 bump `contentVersion` |
| 6 | `apps/api/src/routes/records.ts:372` 及 `domain/recordWrite.ts` | 数据表协同落库路径 + 并发保护 |
| 7 | `apps/api/prisma/schema.prisma` + 迁移 #31 | `collab_docs` 表 + 回滚 SQL |
| 8 | `apps/api/package.json` | `yjs` `y-protocols` `ws` `@types/ws` |
| 9 | `apps/web/package.json` | `yjs` `y-protocols` `y-websocket` `y-indexeddb`。**不装 `@slate-yjs`** —— 文档编辑器不是 Slate（见顶部勘误） |
| 10 | `apps/web/src/features/kb/useDocPersistence.ts` | 协同分支（可用则走 WS，不可用回落现有 PUT —— **渐进增强，不破坏现状**） |
| 11 | `apps/web/src/features/kb/DrawnixCanvas.tsx:274` | `handleChange` 走 Y.Doc 增量 |
| 12 | `apps/web/src/features/grid/GridView.tsx:210` | `commitValue` 协同分支 + 单元格租约态 |
| 13 | `packages/shared-types` | 协同消息/DTO 类型 |
| 14 | 前端新增 `apps/web/src/features/collab/` | `collab-provider.ts`、`useCollabDoc.ts`、`PresenceAvatars.tsx`、`RemoteCursors.tsx`、`useLease.ts`（单文件 ≤300 行） |
| 15 | nginx 站点配置（生产 167） | WS location（见 §9） |

**nginx 必需配置**（默认 `proxy_read_timeout 60s` = **每分钟掉一次**，头号元凶）：

```nginx
map $http_upgrade $conn_upgrade { default upgrade; '' close; }
location /ws/collab/ {
  proxy_pass http://127.0.0.1:3001;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection $conn_upgrade;
  proxy_set_header Host $host;
  proxy_read_timeout 3600s;
  proxy_send_timeout 3600s;
  proxy_buffering off;
  proxy_request_buffering off;
  access_log off;              # 或 log_format 去掉 $args（票据不进日志）
}
```

---

## 9. 分阶段落地路径

> **每阶段共同验收项**：**单机模式（不建立任何协同连接）下页面 DOM 逐元素一致**（D6 UI 冻结）。

### 阶段 0 · 前置加固（无协同代码，可独立验收）
1. `routes/kb/versions.ts` 回滚 bump `contentVersion`（协同正确性硬依赖）。
2. 本机 `db:deploy` 补齐到迁移 30（本机 dev.db 仅 applied=25，与目录 30 不一致）。
3. 基线文档的迁移数同步。

### 阶段 1 · 底座（三类共用，先只服务文档）
4. 依赖接入（api + web），锁精确版本。
5. `collab_docs` 表 + 迁移 #31 + 回滚 SQL。
6. WS 通道：`apps/api/src/collab/`（`attachCollab` / 房间注册表 / 两档写 / 优雅关闭 flush）。
7. 票据端点 `GET /api/collab/ticket` + 握手鉴权（三档身份）。
8. nginx WS location（预览机 167 同步配置）。
9. **验收**：手写脚本用两个 WS 客户端对同一 room 收发 y-protocols 消息，验证双向广播 + 只读连接被拒写 + `close(4401)` 语义 + 服务重启不丢已 flush 内容。

### 阶段 2 · 文档协同
10. 文档绑定接入 = **自研 contentEditable + `Block[]` 接 Yjs**（`blocksYjs.ts`，见 §13；**不是 Slate**，见顶部勘误）+ `useDocPersistence` 协同分支（渐进增强）。
11. 协同光标（relative position）+ 在线头像列表。
12. 块级租约 + 遮挡 UI。
13. **验收**：两个浏览器并发编辑同一文档，逐字/中文输入法/删除/marks/块级元素全同步；断线 30s 后租约自动释放；一人断网重连后内容收敛。

### 阶段 3 · 数据表协同
14. 单元格级 CRDT 映射 + 单元格租约（"某某正在编辑"提示 + 该格不可编）。
15. 并发保护补齐 + diff 落库路径。
16. **验收**：两人改同一行不同列互不干扰；改同一格时后到者被遮挡；`fieldWriteGate` 无权限字段仍拒写。

### 阶段 4 · 画布协同（**一期图形级**，D5）
17. `Y.Array<Y.Map>` 绑定，接管 `DrawnixCanvas.tsx:274 handleChange`。
18. 元素级租约 + 选中态广播。
19. **验收**：两人各自拖拽/新增/删除不同图形完全收敛；拖拽过程中对方画面实时跟随；同图形内部同时改时按 D5 允许覆盖（**作为已知限制写入验收报告**）。

### 阶段 5 · 权限融合与匿名
20. 访客主体 `resolveCollabSubject`；分享 token 作为房间凭据。
21. 匿名昵称「匿名」+ 服务端配色；匿名冷归结 `updatedBy` 记分享人。
22. 连接级权限缓存 + 30s 刷新 + 降权主动踢线。
23. **验收**：外链只读访客能看实时内容与在线名单但写被拒；分享人降权后在线访客被踢为只读；匿名与登录用户同房间协同内容收敛。

### 阶段 6 · 收口
24. 全量测试（api + web + shared + canvas 四包）与反向验证。
25. 部署到预览机 167（rsync 带 `--delete` + 排除清单、`migrate deploy`、nginx 配置、readyz 五探针）。
26. **长连线压测**：≥30 分钟不断线（验证 nginx 超时配置）。
27. **备份体积复核**：`kb_doc_versions` 行数与主库体积、备份时长、`GX_MIN_DISK_MB` 余量（§3.4）。
28. ADR：记录 Yjs 选型、两档写、访客主体、依赖豁免范围。

---

## 10. 风险与护栏

| # | 风险 | 护栏 |
|---|---|---|
| R1 | `@slate-yjs` 停在 2023-07 vs slate 0.116 | **阶段 0 POC 定论**；不兼容则自写约 300 行绑定（需明确 `apply` → Yjs 映射清单） |
| R2 | 画布 op 是 **path 寻址**，直接广播会**永久分叉**（三例实测，见 §11） | **不广播 op**；改用 `Y.Map` keyed by `element.id`，由 Yjs 提供全局定序；移动与打字必须节流 |
| R3 | 租约软锁产生幽灵锁 | 端侧 30s 超时 + 服务端 30s ping 剔除双保险；租约**不承担数据安全职责**（CRDT 兜底） |
| R4 | REST 与 CRDT 双写互相覆盖 | §3.3 注入房间；冷归结 `VersionConflictError` 必须捕获重试；`pagehide keepalive` 入口单列用例 |
| R5 | 冷归结撞全库 nav 对账（§1.5） | 两档写隔离热路径；归结间隔 ≥1.2s、按房间合批、dirty 门、单全局定时器；#158 登记为已知债 |
| R6 | nginx 默认 60s 超时 + 票据进日志 | §8 配置为上线 checklist 首条；阶段 6 做 30 分钟不断线压测 |
| R7 | 备份体积膨胀（画布 3KB → 40KB+） | Yjs 二进制只进 `collab_docs`；版本历史沿用 10 分钟窗口；阶段 6 复核 |
| R8 | 每消息查权限打爆 SQL | 连接级权限缓存 + 30s 刷新 + 失效通知；禁止每消息直调 `resolveKbAccess` |
| R9 | 匿名主体缺失（`resolveSubject` userId 必填） | 新增 `resolveCollabSubject`；匿名归结 `updatedBy` 记分享人；**不得**污染既有签名 |
| R10 | 服务重启丢最后一段编辑 | flush 挂进既有 `shutdown()` 且在 10s 强制退出之前；`writeState` 在最后一人离开时强制落盘 |
| R11 | 数据表「整表 409」会挡掉 CSV 导入 / 公式回填 / MCP 写 | 收口下沉到**按行**（§3.5）；勾选 / 拖卡 / 关联三个高频体感写改走 Y.Map |
| R12 | 已删字段的值被协同通道**复活**（数据完整性） | 结构变更独占 + 冷归结孤儿 key 剪枝（§3.6） |
| R13 | 协同 flush 跑在写队列外 → 与 defaults 交错抹值 | 冷归结一律 `withWriteTx("collab.flush")` + 键级 merge + touched keys 驱动 `changedFieldIds`（§3.7） |
| **R14** | **引入引擎后现有 UI / 交互被改造（产品负责人明确红线）** | **D6 UI 冻结**：只引入同步引擎、不引入编辑器；协同能力一律走叠加层；**单机模式 DOM 逐元素一致**作为机械验收项 |

---

## 11. 画布 op 拦截实测结论（POC 已闭环，真实 Chromium 双板对拍）

**结论：`board.apply` 可拦截、可重放，但不能作为传输层。**

可用骨架（实测有效，`/tmp/gx-canvas-poc/src/collab.ts`）：

```ts
import { PlaitHistoryBoard } from "@plait/core";
const VIEW_OPS = new Set(["set_viewport", "set_selection", "set_interaction"]);
export const isContentOp = (t?: string) => !!t && !VIEW_OPS.has(t);

export function installCollab(board: any, send: (op: any) => void) {
  const orig = board.apply.bind(board); // 必须在 afterInit 内 patch（此时已是 withHistory 包过的版本）
  let replaying = false;
  board.apply = (op: any) => {
    if (!replaying && isContentOp(op?.type)) send(op);
    return orig(op);
  };
  return {
    applyRemote(op: any) {
      replaying = true;
      try { PlaitHistoryBoard.withoutSaving(board, () => orig(op)); } // 不进 undo 栈
      finally { replaying = false; }
    },
  };
}
```

**为什么不能直接广播 op**（并发三例，均实测复现）：

| 场景 | 后果 |
|---|---|
| 双方并发插入 | 各自算出 `path=[0]` → **图层顺序相反**（元素集合相同） |
| 并发改同一图元 | **永久分叉**（各以对方 op 收尾，位置不一致） |
| A 改 / B 删 同一图元 | **元素集合永久分叉** |

根因：plait op 全部是 **path 寻址**，无全局定序。

**定稿方案**：不广播 op。`Y.Array<Y.Map> elements` 承载顺序（数组序 = 图层顺序），每个图元为一个 `Y.Map`（`id` = `PlaitElement.id`，已核 `@plait/core@0.89.2/interfaces/element.d.ts:5` 该字段必需）→ Yjs 提供全局定序与并发合并，绕开 path 重定位。不同图元零冲突；同图元不同属性零冲突、同一标量逐 key **确定性收敛**（非发散）；**图元内文本用 `Y.Text`**（plait 每敲一个字符发一次「text 整体替换」的 `set_node`，若当标量同步会互相覆盖，改用 `Y.Text` 后按字符合并 —— 这使**图形内文字可做到字符级合并**，优于 D5 的下限）。`board.apply` 退为本地拦截 / 只读兜底 / 审计。

**流量三级分流**：

| op | 去向 |
|---|---|
| `insert_node` / `remove_node` / `set_node` | **进 Y.Doc**（持久化 + 合并） |
| `set_selection` | **只进 awareness**（不进 doc，不持久化） |
| `set_viewport` | **纯本地**（不广播） |

**拖拽节流定稿**：`pointermove` 期间把位置写入 **awareness**（远端跟手、不进 doc、不产生墓碑），`pointerup` 时把**终值**落一次 `Y.Map`。避免 60 update/s 与墓碑堆积。

**三条基石前提（已验证完毕，全部通过，但各带一个必须打的补丁）**：

1. **`PlaitElement.id` 跨更新稳定 OK，但裸 id 不能当 key**：id 由客户端 `idCreator()` 生成（5 字符随机串，字符表 40 → 空间 ≈ 1.024e8），**跨 `set_node` 实测稳定不变**（方案可依赖）；但 20 万抽样碰撞 176 次，且 plait **允许同 id 元素共存**（不去重、不报错）。两块各 1000 图元的板合并时**跨板碰撞约 1% → 静默丢一个图元**。
   → **补丁（必须）**：key 用 `${creatorClientId}:${id}`，或入 doc 前重生成 id。
2. **不存在「Y → board → op」回环**：一次远端写在 board 上恰好产生 **1 次 `apply`**，700ms 内无派生 op（plait 重渲染不回写内容 op），无隐蔽污染。
   → **补丁（必须）**：仍需 origin 哨兵（`replaying` 标志 / Yjs `transaction.origin`），否则远端 op 会被当作本地变更广播出去。
3. **未知图元类型：数据层不崩，渲染层会炸**：children 正确、后续 op 可用；但渲染阶段**每次重绘**抛 `can not resolve plugin element component type` 及连带 TypeError。
   → **补丁（必须）**：Y 回写前做类型白名单过滤，或给 board 装默认 `drawElement` 兜底。

**流量粒度实测**（决定节流策略）：

| 交互 | op 数 |
|---|---|
| 绘制矩形 | 拖拽中 **0**，松手 **1** 个 `insert_node`（预览走 temporary element） |
| **拖动已有图形** | **每帧 1 个 `set_node`**（20 次移动 = 20 op）；多选 2 个移动 15 步 = 30 op |
| **图形内文字编辑** | **每敲一个字符 1 个 `set_node`**（`text` 整体替换，非 `insert_text`） |
| 缩放 / 框选 | `set_viewport` / `set_selection`（视图 op，不广播；框选每次移动 1 个） |

→ **移动与打字必须节流**（rAF 合并 / 50ms 窗口，松手或停顿后补终值）。

**其它实测事实**：
- 真实交互出现的 op 只有 5 个：`insert_node` / `set_node` / `remove_node` / `set_selection` / `set_viewport`；`move_node` / `merge_node` / `split_node` / `insert_text` / `remove_text` / `*_fragment` / `set_theme` / `set_board` / `set_interaction` **均未出现**。
- **`readonly-preview.ts:23-37` 的兜底正则会误吞未知 op** → 协同场景必须改**白名单**判定（不要沿用该正则）。
- `remove_node` 自带全量 node，`PlaitOperation.inverse()` 可无损撤销。
- 远端 op 用 `withoutSaving` 包裹后**不进本地 undo 栈**（有对照组验证）。
- 撤销/重做的逆 op 同样经过 `board.apply` → 会自动广播并双向收敛。

---

## 12. 裁决汇总（lead 定案，实施时不得自行改选）

| # | 事项 | 裁决 | 依据 |
|---|---|---|---|
| A1 | 归结滞后窗口 | **30s**；房间空置立即触发 | 冷归结负载较现状低约 25 倍；内容本身实时，仅列表排序与语义检索滞后 |
| A2 | REST 写与 CRDT 互斥 | **服务端按行收口**：行被占用 → 该行 REST 写 409，未占用放行；勾选 / 拖卡 / 关联改走 Y.Map | 按表判定会挡掉导入 / 公式回填 / MCP；`Record.fields` 是整行 JSON，行才是真实冲突域（§3.5） |
| A3 | 结构变更独占 | **按占用判定**：字段被编辑中 → 禁删 / 禁改类型；还原类操作房间在线时禁；**冷归结必须做孤儿 key 剪枝** | 否则已删字段的值会被协同通道复活（§3.6） |
| A4 | `versions.ts:69-83` 回滚不 bump `contentVersion` | **不单列，作为协同阶段 0 前置加固** | 它是房间 base 判断与冷归结正确性的硬依赖 |
| A5 | 任务 #158（nav N+1 批量化） | **不作为协同上线前置**；登记为已知债 + 参数护栏 | 两档写后冷归结 ≤ 0.033 次/秒/房间（§1.5） |
| A6 | 上线前补 blocks golden 往返用例 | **采纳**，覆盖 raw / callout / toggle / math / embed 五类 | 协同改变内容存取路径（Markdown ↔ Block[] 往返），特殊块类型最易丢格式 |
| A7 | 文档 / 画布的 HTTP PUT（§3.3） | 房间在线时**注入 CRDT**；**不得一律 409** | 409 会打断 MCP / AI 写入 |
| A8 | 匿名冷归结的 `updatedBy` | 记**分享人 userId** | 与 `externalDoc.ts:5` 既有外链口径一致，不新造 "system" 哨兵 |
| A9 | 画布一期粒度 | **图形级**（D5），但**图元内文本用 `Y.Text` 做到字符级合并** | 优于 D5 的下限（§11） |
| A10 | 画布图元 key | `${creatorClientId}:${PlaitElement.id}` | 裸 id 5 字符随机串会碰撞（约 1% → 静默丢图元，§11） |
| A11 | 软锁粒度是否区分 userId | **不区分**，按**连接**粒度（同一人开两个标签页也会互锁） | 与租约的连接级生命周期（awareness）一致；按用户去重会引入服务端聚合复杂度 |
| A12 | 是否启用「只对无默认值字段开放协同」的降级闸门 | **不启用**，维持全字段可协同 | 闸门两个理由中一个已被证否（队列本就健康），另一个（`changedFieldIds`）改造面很小（§3.7） |
| A13 | 默认值 / 公式结果不实时反哺在线端 | **一期接受**，登记为已知限制；二期可选消除 | 消除需先定「同一格两种来源」的仲裁规则，复杂度不应由一期承担（§3.7） |
| A14 | 文档块内字符级协同的「源码 offset → DOM offset」映射（约 60-80 行纯函数） | **做，不降级** | 降级会使「同一段内两人同时打字互相覆盖」，与 D1（真协同）冲突（§13） |

---

## 13. 文档绑定实测结论（POC 已闭环，17 项浏览器实测全绿）

**结论：能做到。** 「自研 `contentEditable` + `Block[]` 接 Yjs」可实现**块内字符级协同 + 协同光标**，**全程不改造 UI 与交互**。

**Y 结构**：`Y.Array<string>` 存块顺序 + `Y.Map<Y.Map>` 存块元数据（type / checked / lang / spans）+ `Y.Map<Y.Text>` 存块正文。

**四项验证**：

1. **块内输入拦截**：`onInput` 读 `el.textContent`，与 Y.Text 现值做**最小前后缀 diff**，只把差异段 `delete/insert` 写进 Y.Doc（不做整块替换）；**组词期间不写，等 `compositionend` 一次性提交**（中文输入法路径）。
2. **远端变更不打断光标**：只热补差异段（`Range.deleteContents` + 就地 `insertData`），随后修正 caret（光标在被改区间之后 → 加位移；之内 → 夹到插入末尾）。实测：B 光标在 offset 3，远端在 offset 0 插入 `XYZ` → 光标自动变 6，B 继续打字落在正确位置。**组词中远端改的是别的块 → 组词完全不受影响**；改的是同一块 → 补丁排队到 `compositionend` 再应用，最终收敛。
3. **协同光标坐标**：用 `(blockId, 文本 offset)`（**不依赖任何编辑器内部 path**）；渲染时 TreeWalker 定位文本节点 → `Range.getBoundingClientRect()` → 画到浮层。offset 自解释、随文本变化自动成立，**无需 CRDT relative position**。
4. **块 id**：编辑器内 `newBlock()` 生成的 id **天然稳定**，可直接作 Y 键。（此前"块 id 是位置派生、不稳定"的判断**只适用于 MCP 侧的块 API**，不适用于编辑器运行时。）实测新增块、块类型转换双向同步且 id 一致。

**D6（UI 冻结）合规证据 —— 三条硬约束实测通过**：

| 约束 | 实测 |
|---|---|
| **最小 DOM 热补** | `fullRewrites=0 / hotPatches=20`；被打标记的 DOM 节点与文本节点在 20 次远端补丁后**仍是同一批对象**，`childNodes` 数从 1 保持 1 → **不重渲染、不改结构** |
| **光标浮层不进编辑器 DOM** | 浮层内 `.rc` 元素数 ≥ 1，而 `[data-editable]` 内部 `.rc` 数 = **0**；光标从 offset 2 移到段尾时浮层 `left` 87 → 215 正确跟随 |
| **现有能力不受影响** | 块类型 / 快捷键 / 右键菜单 / 上下插入热区 / 大纲 / 三态切换 / 版本历史全部由 `Block[]` 驱动、仍由 React 渲染；绑定层只碰 `[data-editable]` 内的**文本节点**，结构性操作（增删块 / 改类型）走与现在完全相同的 React 列表更新路径；三态切换与版本历史消费的 `blocksToMd(blocks)` 仍能产出完整快照 |

**改造量**：新增 `features/collab/blocksYjs.ts`（约 200 行）+ `useCollabDoc.ts`（约 80 行）；`WysiwygEditor.tsx` **只改 3 处数据同步点**（`:169-176` 的 innerHTML 回写权交给 Yjs、`onInput` 改走 diff、加 composition 补丁队列），**不改任何组件结构、样式、快捷键、菜单**。

**★ 唯一需投入的点（已裁决：做，不降级）**：块正文存的是**行内 Markdown 源码**（`**粗**`、`[链接](url)`、`@[u:xx|名]`），而 DOM 是渲染后的 HTML，**两者偏移不一致**。需要给 `blocks.ts:115 inlineMdToHtml` 加一层**「源码 offset → DOM offset」映射表**（约 60-80 行纯函数，可单测，**不改变渲染结果**）。

- 降级方案（**不采纳**）：只做块级协同（`Y.Map` 存整块 text，LWW）—— 同一块内两人同时打字会互相覆盖、块内看不到别人的实时改动、协同光标降级为"谁在编辑这块"的角标。工作量减半但牺牲块内并发体验，**与 D1（真协同）冲突**。

**★ 流程教训**：本轮 `poc-slate-yjs` **未收到**方向纠正消息（其收件箱里只有初始任务），导致 Slate 方向的验证白跑（结论"兼容"但前提错误）。→ **给已启动的 worker 改方向时不能只发一次 SendMessage，必须要求回执确认**（后续统一以"第一行回答：是否已更改方向"作为回执要求）。

---

## 附：待验证 / 待补充项

- [x] ~~`@slate-yjs` 兼容性验证~~ —— **作废**：文档编辑器不是 Slate（见顶部勘误）。**不要安装 `@slate-yjs/*` 任何包**。
- [x] **文档绑定验证** —— **已完成，见 §13**（结论：**能做到**，17 项浏览器实测全绿，D6 三条硬约束全部实测通过）。
- [x] **A14「源码 offset → DOM offset」映射** —— **已落地**：`packages/blocks/src/inlineOffsets.ts`（300 行，`inlineMdToHtmlWithOffsets` + `htmlToSrcAt`），95 条 gold 断言锁死与 `inlineMdToHtml` 逐字节一致；**并已上移为 §13 的前置条件**（见 §13.1）。
- [x] ~~**画布 `initialValue` 的受控语义**~~ —— **已闭环，见 §11.1**：`initialValue` 确实非受控，但**不需要受控**；远端变更走 `board.apply(op)` + `withoutSaving` 回放即可实时生效，**不重挂载、选中态不丢**。实测同时修正了"未知类型白名单过滤"应改为**占位替换**。
- [ ] 协同光标在自研 `contentEditable` 与 Plait 画布上的**叠加层渲染方案**（**不得写入编辑器内部 DOM**，见 D6）。
