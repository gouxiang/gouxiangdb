# M1 数据底座 — 可执行实施切片（设计与现状核对，不改业务码）

- 日期：2026-09-13
- 作者：架构师 高见远
- 状态：Proposed（交项目总监大湾区靓仔复核后派后端工程师实施）
- 上游依据：SPEC-enterprise-v1.0 §2（M1 行）/§4（铁律）/§11（假分页、hydration N+1 坑）/§12；ARCH-production §1/§2/§3（路线 A：A1/A2/A4/A5/A6）/§5.1/§6（P1/P2）；ARCH-enterprise §7/§10.1（M5 search.db 与 M1 衔接）；ADR-0004（EAV sidecar，规划槽位）、ADR-0005（FTS5/trigram，规划槽位）、ADR-0008（迁 PG 阈值，预留不写）
- 适用代码基线：`main` @ git `e2a4f8e`（M0 S9 收口）；根 `package.json` v0.1.0
- 本机核对环境：Node v22.22.2、pnpm 9.0.0、Prisma 5.22、better-sqlite3 13.0.3（M0 已提升为 dependency，内置 SQLite **3.53.4**）、Hono 4.13.5

> 本文所有"现状证据"行号均在本机实际读码/跑命令核对（非照抄旧行号）。与主理人提供的旧行号不符之处集中列在 §11。压测脚本与生成器为可执行交付物，但本阶段（设计）不提交任何业务代码、不改 package.json。

---

## 0. 结论先行

1. **瓶颈定性成立且比旧描述更严重**：主列表 `queryRecords` 全表 `findMany`→全量 hydrate→内存 filter/search/sort/group/aggregate→`slice`（`recordService.ts:59`/`:66-70`/`:73-96`/`:148-152`）。额外发现一处旧 ARCH 未点名的放大点：**POST 创建（`records.ts:385`）与 PATCH 更新（`:590`）成功后都对整张表跑一次 `queryRecords(noPaging:true)` 再 `.find` 出本行**——这意味着"写一行 = 全表读 + 全表两轮 hydration"，在百万行下单次普通编辑即可拖垮服务。M1 必须连同它一起收口（切片 S5/S8），否则只改列表读路径，写一条记录仍 O(全表)。
2. **测试基线 317 全绿**：api **261**（16 个测试文件）+ shared-types **56**（4 个文件），本机两次复验。M0 基线文档写的 270 是 M0 起点；M1 一律以 **317** 为"不许由绿转红"的回归基线。
3. **FTS5/trigram 能力已在本机提前证伪/证实（仅作 M1/M5 边界判定，不在 M1 交付 FTS）**：better-sqlite3 13.0.3 内置 SQLite 3.53.4，`CREATE VIRTUAL TABLE ... USING fts5` 与 `tokenize='trigram'` 均可建；实测 trigram 对 **≥3 字符子串（含中文 3 字、拉丁 3 字符）命中**，但对 **2 字中文词（"订单""离职"）返回 0**——与 ARCH-enterprise §7.4"trigram ≥3 字、1-2 字短词回退 LIKE"完全一致。因此 M1 **不在主库建任何 FTS 虚表**（避免与 M5 独立 `search.db` 重复建设），只解决"主库列表的物理字段筛选/排序/分页"，跨表全文搜索的 2000 行截断明确留给 M5（见 §2 边界与 S11）。
4. **方言红线可落地**：sidecar 用普通表（**不用 SQLite 专有的 `WITHOUT ROWID`**，偏离 ARCH-production 草稿 DDL 以保住 ADR-0008 通道）、全部参数化、写侧用 Prisma 交互事务内 `tx.$executeRaw`（与记录写同事务、同连接，天然原子），读侧用独立 better-sqlite3 只读连接（复用 M0 readiness/backup 已验证的连接模式）。
5. M1 切成 **S0–S11 共 12 片**，每片独立可提交/可验收/可回滚，受 **3 个 env feature flag（默认 off/影子）** 保护灰度；先加 Characterization 测试锁行为，再动主链路。S0–S7、S9–S11 为纯后端可独立做；**S8（游标消费 + 看板/月历分组口径）必须前端配合**，是唯一跨端片。

---

## 1. 现状证据（行号已核对）

### 1.1 列表读路径：全表拉取 + 内存计算 + 假分页

`apps/api/src/domain/recordService.ts` 的 `queryRecords`（`:54-155`）是 Grid/Gallery/Kanban/Calendar 唯一数据出口：

| 环节 | 现状证据（已核对） | 事实 |
|---|---|---|
| 全表拉取 | `recordService.ts:59-62` | `findMany({ where:{tableId,deletedAt:null}, orderBy:[createdAt asc,id asc] })`，**无 take/skip**，整表 fields JSON 进堆 |
| total | `recordService.ts:63` | `total = rows.length`（靠全量行数） |
| 全量 hydration | `recordService.ts:66-70` | 对全部行跑两轮 hydrate |
| 内存过滤 | `recordService.ts:73-75` | `hydrated.filter(r => evalFilter(...))` |
| 内存搜索 | `recordService.ts:78-83` | `matchesSearch` 对可见字段文本化后 contains |
| filteredTotal | `recordService.ts:85` | 过滤后数组长度 |
| 内存排序 | `recordService.ts:90-96` | `sortRows(...)` 全量排 |
| 内存分组/聚合 | `recordService.ts:100-145` | `computeGroups`/`aggregateAll` 遍历全量 |
| 假分页 | `recordService.ts:148-152` | 默认 limit 200（`:150`），`hydrated.slice(offset, offset+limit)`（`:151`），翻页零节省 |
| 契约 | `recordService.ts:29-35` | `QueryResult { records,total,filteredTotal,groups,aggregations }` —— M1 保留，只增不改字段语义 |

`queryRecords` 全部调用点（grep 已核对）：
- `routes/records.ts:292` 列表（传 limit/offset）；
- `routes/records.ts:385` POST 创建后回查（`noPaging:true` 全表，见 §0-1 放大点）；
- `routes/records.ts:529` GET 详情（`noPaging:true` 全表后 `.find`）；
- `routes/records.ts:590` PATCH 更新后回查（`noPaging:true` 全表）；
- `routes/tables.ts:345` CSV 导出（`noPaging:true`，导出本就需要全量，保留但要走专用批量流式读，不占列表路径）。

### 1.2 路由层分页/截断

- `routes/records.ts:280-281`：`limit = min(Number(query.limit ?? 200)||200, 1000)`，`offset` 仅下界钳制；`:292` 透传。
- **两处独立的 2000 行硬截断**（与列表路径无关，是第二、三处全量读）：
  - `routes/records.ts:474-478`（`GET /api/records/search`，每表 `take:2000`，`:500-502` 满 100 即提前终止，后排表永不可搜）；
  - `routes/search.ts:76-80`（统一搜索 `GET /api/search` 记录支路，同样 `take:2000`）。
- `assertUnique` 也是全表读：`routes/records.ts:254-257` `findMany({where:{tableId,deletedAt:null}, select:{id,fields}})` 后内存比对（每次创建/编辑/批量都跑）。M1 用 sidecar 等值通道在 S6 顺带收敛（同事务 `SELECT ... WHERE field_id=? AND value_text/value_num=?`），但**行为（含字符串/数字归一与中文文案）必须先用测试锁死**。

### 1.3 Hydration：逐行串行 + 每行多次查库

`apps/api/src/domain/hydrate.ts`：

- 主循环逐行串行 await：`hydrateRecords` 的 `for (const r of records){ ... await hydrateOne(...) }` 在 **`:74-77`**（旧证据一致）。
- 每个 links/subtable 字段各查一次 link_rows：正向 `:407`、反向 `:418`；再对关联 id 集合 `getRecordsByIds`：`:431`（`buildLinkRefs` 内还**逐 id** `await primaryTitle`，`:436-444`）。
- lookup/count：`:501`/`:508`（resolveLinkedPeerIds）、`:530`（lookup 取对端记录）、`:597`/`:602`（count 取对端记录）。
- 点引用子记录未命中按单 id 查：`getMergedCached` `:366`（`getRecordsByIds([recordId])`）。
- 两轮语义与递归守卫（**禁改契约**）：第一轮物理→系统→autoNumber→links(正/反)→lookup/rollup/count（`buildFirstPassMerged :138-201`），第二轮公式按 Kahn 拓扑序（`computeFormulas :210-252`）；防双向递归 `stack`（`:95-106`）、点引用循环守卫 `merging`（`:357-378`）。

`apps/api/src/domain/prismaDeps.ts` 的 Deps **本就是批量签名**（旧证据一致）：`getRecordsByIds(ids[])` `:100-106`、`getLinkRows(q)` `:108-126`、`countLinkRows` `:128-137`；批量能力被"单行单字段"调用方式浪费。另有既有缓解（保留）：autoNumber 全表 id 5 秒 TTL 缓存 `:66-85`、用户名 60 秒缓存 `:88-152`。

### 1.4 写并发与事务现状

- `db.ts:33-36`：启动 `PRAGMA busy_timeout=5000` + `journal_mode=WAL`，`void ... .catch(()=>{})` 悬空 promise（M0 D14 已备注留待 M1 收口）；Prisma SQLite 单连接、多读单写。
- `DbTx` 类型 `db.ts:10`；写函数统一收事务客户端。
- 全仓 `$transaction` 共 9 处、分布 4 个路由文件（grep 已核对）：`records.ts`（交互事务：`:346` 创建、`:555` 更新、`:709` 批量更新；数组事务：`:607` 删、`:655` 批量删）、`tables.ts`、`fields.ts`、`kb.ts`。
- 记录/关联写 mutate 调用点全仓约 38 处（含 `defaults.ts` 事务外补偿写：`:301/:352/:441/:448/:471/:524` 等）。CSV 导入已是"单行单事务"（`records.ts:815-820`），RC-09 要求保留行级原子。
- 写路径无行级乐观锁（基线 R9）。**注意：KbDoc 已有独立 `contentVersion`（schema `:287`），M1 不给 records 加 version 列**——见 §3 契约与 §2 非目标。

### 1.5 物理索引现状

`prisma/schema.prisma` Record 模型 `:122-139`：
- `fields String`（JSON TEXT）`:125`，无字段级索引通道；
- 仅 `@@index([tableId])` `:136` 与 `@@index([createdAt])` `:137`（两个**单列**索引）。
- LinkRow `:143-160`：`@@unique([linkFieldId,parentRowId,childRowId])` `:156`、`@@index([linkFieldId,parentRowId])` `:157`、`@@index([linkFieldId,childRowId])` `:158`（批量 hydration 的 IN 预取已被覆盖）。
- 实际 DDL 列名是 Prisma 引号蛇形/驼形（`"tableId"`、`"createdAt"`、`"deletedAt"`，见 init migration `:49-59`），**手写 SQL 必须用引号列名**。
- 迁移：`prisma/migrations/` 现有 **11 个**目录；CI `scripts/ci-quality.sh:87` 的期望迁移数由 `find migrations -type d | wc -l` **动态得出**（非硬编码），新增迁移会自动把 11 抬到 12/13，无需改 CI 常量。
- Prisma schema 无法声明 FTS/sidecar，sidecar 表在 schema 中以独立手写迁移维护、经 raw SQL 访问（ADR-0004 既定路线）。

### 1.6 前端消费现状（决定 S8 边界）

- 唯一数据出口 `apps/web/src/api/client.ts:304-320` `Records.list({tableId,viewId,limit,offset,search})`；hook `hooks.ts:213-239` `useRecords`。
- **没有任何视图传 limit/offset**（grep 全仓，`useRecords(` 10 处调用均不传分页），即前端今天始终吃服务端默认 200 行；`offset/limit` 只存在于类型层。
- Grid 已做行窗口虚拟化（`GridView.tsx:412-413` 算 start/end、`:519 records.slice(start,end)`），但数据本身仍是一次最多 200 行全量。
- **Kanban/Calendar 在前端按"全量记录"自行分组**：`KanbanView.tsx:78-84` 对 `records.forEach` 分桶；`CalendarView.tsx:79` 同样 forEach 归日（`:200` 每天还 `slice(0,3)`）。
- 服务端 `groups` 仅 Grid 消费（`GridView.tsx:82`）；`aggregations` 仅 `AggregationBar`。`filteredTotal` 在 `FilterPanel.tsx:112`、`GridToolbar`、`GridView.tsx:577` 展示。
- 结论：纯 keyset"只回一页"会直接让看板/月历缺桶。**S8 必须前端配合**，且需要一个区别于"网格分页"的"分组视图受限全量"口径（见 S8）。

### 1.7 字段类型与可索引性（single source：shared-types/type-groups.ts）

- 物理标量组：text（singleLineText/longText/richText/email/url/phone/json/autoNumber）、number（number/currency/percent/duration/rating）、date（date/datetime）、bool（checkbox）、select（singleSelect/multiSelect）。
- 系统字段 `createdTime/lastModifiedTime/createdBy/lastModifiedBy`；计算字段 `lookup/rollup/count/formula/links`（`fields.ts:38-49`）；`links` 不落在 records.fields。
- **字段类型不可变**：`fieldService.updateField :248-279` 不写 `type`（只改 name/options/required/unique/...）；选项按 id 存储、改名不改 id（故 sidecar 选项 id 稳定，不存在"改类型触发重建"，只有"删字段/恢复字段"需要清/补 sidecar）。

---

## 2. M1 范围边界（避免重复建设 / 范围蔓延）

### 2.1 M1 必做（对应 SPEC M1 行 + A1/A2/A4/A5/A6）

1. 进程内**写串行化**（保 DbTx 全事务语义），为 M5 outbox worker / MCP 长任务提供单写者纪律。
2. **keyset/游标分页 + COUNT 下推**，禁 offset 深翻；列表响应契约对前端**只增兼容**。
3. **hydration 批量化**（查询数与行数解耦），并消灭"写一行全表 hydration"（POST/PATCH/详情回查）。
4. **EAV sidecar 物理旁路索引**（只增迁移 + 写时同事务维护 + 回填 + 幂等重建），把**物理字段**的等值/集合/范围/排序/表尾 count 下推；热路径加 records 复合索引。
5. **证伪压测门**：50 万/100 万数据生成器 + 可重复压测 + P50/P95 阈值 + ADR-0008 客观判定与数据留存。

### 2.2 M1 明确不做（划给后续里程碑，禁止越界）

| 不做 | 归属 | M1 的临时姿态 |
|---|---|---|
| 主库 FTS5/虚表/trigram、跨表全文搜索召回改造、独立 `search.db`、outbox、向量、RRF | **M5**（ARCH-enterprise §7；ADR-0005/0015/0018） | 两处 `take:2000` 截断**保留但显式化**：响应头/日志标注"搜索为有界预览，企业版统一检索在 M5"，不偷偷扩成全表扫（S11） |
| longText/richText 的任意子串全文索引 | M5 | sidecar 不索引长文本正文；列表对长文本 contains 走有界回退（见 S6 回退表），不全表扫 |
| 计算字段（formula/lookup/rollup/count/links）的 SQL 化、异步预计算/物化 | 不做（ARCH §2.3 已决） | 大表对计算字段排序/筛选"禁用并提示"；阈值以下维持内存路径（S7） |
| records 行级 version 乐观锁 | 不单独立项 | M1 靠写串行队列从根上消除同进程写写竞争；**不新增 version 列**（KbDoc 的 contentVersion 是另一套，勿混） |
| 附件外置（attachments 表/内容寻址/ multipart） | M2（ADR-0006，ARCH P1） | M1 不动 fields 内 dataURL；压测生成器的"附件字段"用小尺寸占位，不把 2MB dataURL 当容量因子 |
| R3 字段约束存量扫描三选一、JWT tokenVersion、分享收敛等 | M2/安全线 | 不在 M1 |
| 多实例/读写分离/PG 实施 | 触 ADR-0008 阈值才立项 | 仅保方言通道（§4） |

---

## 3. M1 内"绝对不能动"的契约（Characterization 先锁）

1. **`record.fields` JSON 形状**：key=fieldId，物理值标量/数组（multiSelect 为 id[]、links 不落此 JSON、附件为对象数组）。sidecar 是**派生**，真相源永远是 fields JSON；删 sidecar 可完整重建，业务读写永不依赖 sidecar 才能解析记录。
2. **hydration 两轮语义与结果逐值等价**：第一轮（物理→系统→autoNumber→links 正/反→lookup→rollup→count）、第二轮公式拓扑序；双向关联浅层切断、bt/hm 反向基数、点引用 `{关联.子字段}` 保留原始类型与多值 list 语义、循环依赖置 null 不炸表。批量化只改"取数方式"，**一个 cell 值都不许变**（RC-31~RC-37）。
3. **公式引擎契约**：`safeEvaluateFormula`/`formulaFieldRefs`/FNULL 与 null/除零/空 CONCAT/自引用边界（RC-34）不动；默认值公式与公式字段两入口结果一致（RC-35）。
4. **链接软删/恢复语义**：删记录只对 linkRow 打 `deletedAt`、恢复按"两端皆活"回填（`records.ts:607-614`、`restoreLinkRows :911-926`）；sidecar 维护必须遵守同一软删/恢复时刻，不得物理删关联、不得让软删记录进入索引候选。
5. **contentVersion（KbDoc）**：M1 不碰知识库乐观锁（schema `:287`）；写串行队列接入 kb.ts 事务时不得改变其 409 冲突行为（RC-07）。
6. **对外响应契约只增不改**：`GET /api/records` 现有 `records/total/filteredTotal/fields/allFields/groups/aggregations` 字段与类型不变；新增 `nextCursor/hasMore`（可选）与降级标记，老前端不传游标时行为与今天一致（默认窗口内）。
7. **过滤/排序/搜索的语义口径**：`evalFilter` 22 个操作符（shared/filter.ts）、空值恒排后（sort.ts:91-94）、localeCompare `zh-CN,numeric:true`、日期 DATE_LIKE 时间戳比较（filter.ts:47-64）——SQL 下推必须与之**逐算符对拍**，对不齐的算符一律回退内存路径，不得"近似"。

---

## 4. 横切工程纪律（所有切片共用）

### 4.1 Feature flag（env，默认保守；单实例内存态即可，不引服务）

| flag | 默认 | 含义 |
|---|---|---|
| `GX_M1_WRITE_QUEUE` | `on`（纯收口，先影子计数一周可 off 回退） | 写操作经进程内串行队列 |
| `GX_M1_KEYSET` | `off` → 灰度 `shadow` → `on` | off=旧全表路径；shadow=新旧同跑对拍只返回旧结果；on=走 keyset/下推；异常自动回退旧路径并计数 |
| `GX_M1_SIDECAR` | `off` → `on` | sidecar 写维护与读下推开关；off 时只不读，写维护可常开（数据先备好） |

- flag 解析进 `src/config.ts`（沿用 M0 `GX_RATE_LIMIT` 的 on/off 模式，`NODE_ENV=test` 下默认走旧路径，测试显式打开）。
- 灰度策略对齐项目规范：内测（shadow 对拍 0 差异）→ 小流量 → 全量；每片给"关 flag 即回退到 M0 行为"的单步回退。

### 4.2 方言边界（为 ADR-0008 留通道，SPEC §4 铁律）

- sidecar 用**普通表**，不用 `WITHOUT ROWID`（SQLite 专有）；类型只用 `TEXT/REAL/INTEGER`，PG 对应 `text/double precision/integer`。
- 所有 raw SQL **参数化**（`$executeRaw` 模板 / better-sqlite3 prepared statement），禁止字符串拼用户输入。
- 空值排序用可移植写法：`ORDER BY (CASE WHEN col IS NULL THEN 1 ELSE 0 END), col ...`（不依赖 SQLite 的 `col IS NULL` 表达式排序，PG 亦可 `ORDER BY col IS NULL` 但 CASE 更通用）。
- upsert 用标准 `INSERT ... ON CONFLICT ... DO UPDATE`（PG 9.5+/SQLite 3.24+ 都支持），冲突目标显式命名唯一约束。
- 不在 SQL 里做 JSON 抽取（PG/SQLite JSON 语法不兼容）；可索引值一律在应用层写时抽取进 sidecar。
- 布尔存 `INTEGER 0/1`（checkbox），不用方言布尔字面量。

### 4.3 迁移/备份/回滚纪律

- 全部为**只增迁移**：新表、新可空列、新索引；发布前 `deploy.sh` 已强制在线快照（M0 S8）。回填走**独立可中断脚本**（分批、进度、可重跑），不放进 `migrate deploy` 的 DDL 事务里长跑。
- sidecar/FTS 派生数据可随时 truncate 重建，故"回应用不回数据"为常态。
- 手写迁移列名带引号蛇形/驼形与现状一致；新增迁移目录后 CI 期望数自动 +1。

---

## 5. 切片总览与依赖

| 切片 | 标题 | 类型 | 主要触碰 | 对 317 影响 | 依赖 | 可并行 |
|---|---|---|---|---|---|---|
| S0 | M1 基线留证 + Characterization 测试锁行为 | 纯后端 | 新增 `__tests__/characterization/*`、基线文档 | 只增测试 | — | 与 S1/S2 并行 |
| S1 | 进程内写串行队列（WAL 单写者纪律） | 纯后端 | 新增 `db/writeQueue.ts`；db.ts；写路由接入 | 无（默认 on 但语义等价） | S0 | 与 S2/S3/S9 并行 |
| S2 | 只读 raw 连接网关 + COUNT/keyset 原语（不接业务） | 纯后端 | 新增 `db/rawRead.ts`（better-sqlite3 只读） | 无（新模块） | S0 | 与 S1/S3 并行 |
| S3 | 迁移：sidecar 表 + records 复合索引（只增 DDL） | 纯后端 | 新增 1 个手写迁移；schema 注释 | 无（DDL + 干跑） | S2 | 与 S4 并行准备 |
| S4 | sidecar 写时同事务维护 + 回填/重建工具（`GX_M1_SIDECAR` 只写不读） | 纯后端 | 新增 `domain/fieldIndex/*`；records/tables/fields/defaults 写点；脚本 | 无（flag off 读路径不变） | S1、S3 | 依赖 S1/S3，后可与 S5 并行 |
| S5 | hydration 批量化（两阶段预取）+ 消灭写后全表回查 | 纯后端 | hydrate.ts、prismaDeps.ts、recordService 调用点、records POST/PATCH/详情 | **最高回归面**，靠 S0 对拍 | S0 | 与 S2/S3/S4 并行（不同文件） |
| S6 | 物理字段过滤/排序/聚合下推（sidecar）+ unique 走索引 + 算符回退表 | 纯后端 | 新增 `domain/queryPlan/*`；recordService 编排 | 高，靠 S0/S5 | S2、S4、S5 | 串行在其后 |
| S7 | keyset 分页接入列表 + COUNT 下推 + `GX_M1_KEYSET` shadow 对拍 | 纯后端（契约 additive） | recordService、routes/records 列表 | 中 | S6 | S6 后 |
| S8 | **前端**游标消费 + 看板/月历"受限全量"口径 + 大表计算字段禁用提示 | **需前端** | web client/hooks/GridView/Kanban/Calendar/FilterPanel | web 今无单测（M0 已 --passWithNoTests），加少量 hook 测试 | S7（契约冻结后） | 唯一跨端，后端 S9-S11 可并行 |
| S9 | 数据生成器 + 压测脚手架（50 万/100 万，关联/附件/多类型） | 纯后端 | 新增 `scripts/bench/*` | 无（脚本） | S3（可先用裸表） | S2 后即可起步 |
| S10 | 证伪门执行：P50/P95 度量、阈值、ADR-0008 判定、产物留存 | 纯后端（验证） | `scripts/bench/run-gate.mjs`、压测报告 | 无 | S7、S9 | S7 后 |
| S11 | M1 出口收口：40 条 RC 回归、搜索截断边界文档、flag 生命周期、ADR-0004 落档 | 纯后端 | docs/adr/0004、baseline 报告、runbook | 无 | 全部 | 收尾 |

依赖关键路径：S0 → S1/S2/S3 → S4 → S6 → S7 → S10 → S11；S5 可与 S2/S3/S4 并行但必须在 S7 前合入；S8 依赖 S7 的契约定稿，可与 S9/S10/S11 并行。**建议并行度 2**（一人主攻读链路 S2/S6/S7，一人主攻 S1+S4 写链路与 S5 hydration，S0/S9 脚本可见缝插针），避免同一批写点 merge 冲突。

---

## 6. 切片明细

> 每片统一给：现状证据（行号）、新增/改动文件（具体路径）、改动要点、独立验收命令/基准、对 317 与 40 RC 的影响/保护、回滚。

### S0 — M1 基线留证 + Characterization 测试锁行为

**现状证据**：317 全绿（api 261 / shared 56，本机复验）；hydration 已有内存 deps 夹具 `domain/__tests__/hydrate.test.ts:178-200`（`makeDeps`），可直接扩展记录"每批调用次数"。

**新增文件**
- `docs/baseline/2026-09-13-m1-baseline.md`：记录 git 提交、317 计数、Node/SQLite 3.53.4 版本、各档（1 万/10 万）改造前延迟与查询条数（用 S9 雏形先取一次"前"基线，作为 A/B 对照的 A）。
- `apps/api/src/domain/__tests__/characterization/recordService.shape.test.ts`：锁 `queryRecords` 返回**形状与逐行值**——total/filteredTotal 口径、groups 的 key/label/color/recordIds 顺序（group.ts:90-110 的选项序/空白桶最后）、aggregations 数值、默认排序 (createdAt,id)、空值排序。
- `.../characterization/hydration.batch-parity.test.ts`：构造多表 + 正向/反向 links + lookup/rollup/count + 链式公式 + 点引用 + 双向环 + 自引用的夹具，记录**期望值快照**（供 S5 新旧 hydration 逐值 deep-equal）。
- `.../characterization/filter-operator-matrix.test.ts`：22 个操作符 × 标量/多选/日期/布尔/匹配字段(valueType=field) 的真值表（直接喂 shared `evalFilter`，锁 S6 SQL 下推对拍基准）。
- `.../characterization/pagination-shape.test.ts`：锁 `GET /records` 列表 JSON 现状（为 S7 additive 变更做对照）。
- `.../characterization/unique-validation.test.ts`：锁 `assertUnique`（records.ts:242-269）现有归一行为（含数字/字符串、排除自身/批内），供 S6 改走索引后对拍。

**要点**：Characterization 不修正任何现状行为（哪怕"看起来怪"），只把现状钉死；快照里包含中文错误文案（如 409 文案）。

**独立验收**
```bash
pnpm --filter @gx/api test    # 317 基线中 api 由 261 增至 261+N，全绿；shared 56 不变
pnpm -w test                  # 退出 0
```
**回滚**：仅新增测试与文档，删除即可。

---

### S1 — 进程内写串行队列（保 DbTx 全事务）

**现状证据**：db.ts:10 `DbTx`；9 处 `$transaction`；压测文档 `docs/benchmark-api.md:26-30` 并发批量写失败约 50%；db.ts:33-36 WAL/busy_timeout 悬空 promise。

**新增/改动文件**
- 新增 `apps/api/src/db/writeQueue.ts`（<120 行，零依赖）：
  - 导出 `runSerialized<T>(label:string, task: () => Promise<T>): Promise<T>`，单 promise 链尾追加；每任务记 `waitMs/runMs`、队列深度、失败计数（供 S10/readyz 观测，先内存直方图不引依赖）。
  - 并发度恒 1；队列本身不开启事务、不吞错（异常原样透传，HTTP 状态码不变）。
- 改 `db.ts`：导出一个写访问门面 `withWriteTx(fn)` 与 `runWrite(label, fn)`；**收口悬空 PRAGMA**：改为模块级一次性 `await` 好的就绪 promise（保留 queryRawUnsafe，失败静默降级的现有策略），raw 读连接（S2）与写队列都等它；readyz 已有独立探针不耦合。
- 接入 9 处事务调用点：把每个"一次 HTTP 请求对应一个工作单元"的最外层包进 `runSerialized`，**交互事务回调体内部仍只用传入的 `tx`，不得再入队**（避免同事务自死锁）。具体：
  - records.ts 创建 `:346`、更新 `:555`、批量更新 `:709`、删除 `:607`、批量删 `:655`；
  - tables.ts 清空/建表删表等事务；fields.ts 建字段/配对/删字段事务；kb.ts 写事务（**不改 contentVersion 409 逻辑**）。
  - `defaults.ts` 的事务外补偿写（`:301` 等）经 `runWrite` 入队（它们本就是"尽力执行、失败不阻断"，串行化只改时序不改语义）。
- CSV 导入保持"每行一个交互事务"（RC-09），但整段导入在请求级入一次队（或逐行入队，二选一在 S0 性能基线后定；默认逐行，避免长事务阻塞所有写）。

**要点/陷阱**
- Prisma SQLite 本就单连接，队列主要价值是：① 在应用层把"并发→busy 失败"变成"并发→排队等待"，消除那 50% 失败；② 为 M5 outbox/MCP 长任务立下"同进程唯一写入口"纪律；③ 队列等待可观测（S10 用它判定写吞吐是否触 ADR-0008 阈值）。
- **绝不能**把 `$transaction` 回调整体入队后又在回调里调用另一个 `runSerialized`（自死锁）；code review 清单与一条 lint 注释约束。
- 队列入参不持锁跨 await 业务对象；事务函数签名不变（仍 `(tx: DbTx) => ...`）。

**独立验收**
```bash
pnpm --filter @gx/api test
# 并发写对抗：并发 20 个 PATCH/创建，全部成功或按既有业务校验失败（4xx），不得出现 SQLITE_BUSY(5)
GX_M1_WRITE_QUEUE=on  pnpm tsx scripts/bench/write-contention.mjs   # 脚本 S9 提供，S1 可先用最小复现
GX_M1_WRITE_QUEUE=off pnpm tsx scripts/bench/write-contention.mjs   # 可回退旧行为
```
**对 RC**：RC-08（WAL/busy_timeout）、RC-09（CSV 行级事务）、RC-10（多步写事务化）、RC-07（KB 409 不变）必跑。
**回滚**：`GX_M1_WRITE_QUEUE=off` 完全旁路队列（直接 await task）；代码层还原门面为直调。

---

### S2 — 只读 raw 连接网关 + COUNT/keyset 原语（暂不接业务）

**现状证据**：M0 已用 better-sqlite3 做 readiness（`ops/readiness.ts:145 new Database(dbFile,{timeout:1000})`）与 backup；路径解析 `ops/readiness.ts:51-56`、`scripts/backup/lib.mjs:9-16`。

**新增文件**
- `apps/api/src/db/rawRead.ts`（<150 行）：
  - 单例**只读** better-sqlite3 连接（`new Database(file,{readonly:true})`），`pragma('busy_timeout=5000')`、WAL 下只读安全；文件路径复用 readiness 的 `DATABASE_URL` 解析（抽到共享小函数，两处引用）。
  - 导出 prepared 语句助手与三个纯查询原语（本片刻画语句、不挂路由）：
    - `countLive(tableId)`；
    - `countByPlan(tableId, whereSql, params)`（S6 用）；
    - `keysetPage({tableId, cursor:{createdAt,id}|null, limit, whereSql, params, order})` 返回 `{rows, nextCursor}`。
  - 默认排序固定 `(createdAt ASC, id ASC)`，游标谓词：`("createdAt" > ? OR ("createdAt" = ? AND "id" > ?))`（旧版 SQLite/Prisma 不支持行值比较时的可移植展开；PG 亦兼容）。
- `apps/api/src/db/__tests__/rawRead.test.ts`：对临时文件真实建表（better-sqlite3）验证 keyset 跨页**不重不漏**、排序稳定、COUNT 正确、软删排除。

**要点**：本片**不读 sidecar、不改任何路由输出**，只是可测原语；raw 连接只读，避免与 Prisma 写连接产生跨连接事务。
**独立验收**：新增单测全绿；`pnpm --filter @gx/api typecheck`。
**回滚**：删除新模块（无调用方）。

---

### S3 — 迁移：sidecar 表 + records 复合索引（只增 DDL）

**现状证据**：schema.prisma:136-137 仅单列索引；records DDL 引号列名（init migration:49-59）。

**新增文件**：`apps/api/prisma/migrations/<ts>_record_field_index_sidecar/migration.sql`
```sql
-- M1 / ADR-0004：热物理字段 EAV 旁路索引（可重建派生数据）。
-- 刻意不用 WITHOUT ROWID（SQLite 专有），保 ADR-0008 PG 通道。
CREATE TABLE "record_field_index" (
    "id"         INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "recordId"   TEXT NOT NULL,
    "tableId"    TEXT NOT NULL,
    "fieldId"    TEXT NOT NULL,
    "valueText"  TEXT,
    "valueNum"   REAL,
    "isNull"     INTEGER NOT NULL DEFAULT 0,
    "ord"        INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "rfi_record_fkey" FOREIGN KEY ("recordId") REFERENCES "records" ("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "rfi_record_field_ord_key"
    ON "record_field_index" ("recordId", "fieldId", "ord");
CREATE INDEX "rfi_table_field_num"
    ON "record_field_index" ("tableId", "fieldId", "valueNum");
CREATE INDEX "rfi_table_field_text"
    ON "record_field_index" ("tableId", "fieldId", "valueText");
CREATE INDEX "rfi_table_record"
    ON "record_field_index" ("tableId", "recordId");

-- 默认列表热路径：WHERE tableId=? AND deletedAt IS NULL ORDER BY createdAt,id
CREATE INDEX "records_table_live_created_id"
    ON "records" ("tableId", "deletedAt", "createdAt", "id");
```
- `ord`：multiSelect 摊平多行时的选项序号（0..n），标量字段恒 0；唯一键含 ord 以容纳多选项行。
- schema.prisma 不加 model（避免 Prisma 试图管理它），但在文件尾加注释说明该表由手写迁移 + raw SQL 维护（防止后人 `migrate dev` 漂移）。
- 回填**不在本迁移**：迁移只建空表/索引；回填由 S4 的可重跑脚本完成。

**独立验收**
```bash
bash scripts/ci-quality.sh        # 迁移干跑：期望数自动 11→12，integrity_check=ok
DATABASE_URL=file:/tmp/m1.db pnpm --filter @gx/api exec prisma migrate deploy
# 用 better-sqlite3 断言表/索引存在、空表 COUNT=0
```
**回滚**：派生表，`DROP TABLE` + `DROP INDEX`（出一份回滚 SQL 存 `migrations/` 同级 `docs/`，不在主迁移链执行）；应用回滚旧 release 后该表闲置无害。

---

### S4 — sidecar 写时同事务维护 + 回填/幂等重建（flag 只写不读）

**现状证据**：记录 JSON 写唯一收口 `applyFieldWrites`（records.ts:148-199，`:196` update JSON）；创建 `:354`、批量 `:709-714`；软删 `:607-614`/批量 `:655-666`、恢复 `:936-937`+restoreLinkRows、清空表 tables.ts clear；字段删/恢复 fieldService.deleteField `:364-410`；defaults.ts 补偿写。

**新增/改动文件**
- 新增 `apps/api/src/domain/fieldIndex/policy.ts`（纯函数）：
  - `isIndexedField(f: FieldMeta): boolean`——物理标量才入：text 组只取 singleLineText/email/url/phone/autoNumber + 表 primaryFieldId（即便它是 longText 也入 text，供标题等值/排序）；number/date 组全入；checkbox；singleSelect/multiSelect。**排除** longText/richText/json 正文、attachment、links、lookup、rollup、count、formula、tabs/subtable、createdBy/lastModifiedBy。
  - `extractEntries(f, storedValue): {valueText,valueNum,isNull,ord}[]`——multiSelect 每选项一行（valueText=optionId, ord=i）；singleSelect 单行（text=id）；number/date→valueNum（date 用 `Date.parse` 时间戳，与 filter.ts:59-62 同口径），同时 valueText 存原始串供 eq 文本回退；checkbox→valueNum 0/1；空→isNull=1。
- 新增 `domain/fieldIndex/sync.ts`：
  - `syncRecordsTx(tx: DbTx, tableId, recordIds[])`：在**同一交互事务内**用 `tx.$executeRaw` 先删这些 record 的旧 sidecar 行再批量 insert（读最新 fields JSON）。所有调用点把它放在 record JSON 写之后、事务提交之前。
  - `deleteRecordsTx(tx, recordIds[])`（软删时清 sidecar；物理删由 FK cascade 兜底）、`restoreRecordsTx(tx, ids)`（按恢复后的 fields 重建，只对仍活的记录）。
  - `rebuildFieldTx/table`（脚本用，分批）。
- 接入点（同事务）：
  - 创建：`:354` create + `applyFieldWrites` 后 `syncRecordsTx(tx,[created.id])`；
  - 更新/批量更新：在各自交互事务内对受影响 id sync；
  - 软删/批量删/清空：同事务 `deleteRecordsTx`；恢复记录/恢复表：同事务重建；
  - **linkRow 变化不进 sidecar**（links 不索引）；但需确认 primaryField 不会是 links（policy 已排除），故 link 改名不触发 sidecar 更新。
  - defaults.ts 对 fields JSON 的补偿写（`:301/:352/:471/:524`）后，对该 record sync（包进既有写点，尽量同批；若历史上确为跨语句尽力写，则紧随同函数调用，接受与 JSON 同生共死）。
- 新增 `apps/api/scripts/bench/backfill-sidecar.mjs`（或 tsx 脚本）：分批（每批 1000，`id > lastId` 游标）扫 records，解析 fields、按现存 fields 定义抽 entries 批量插；进度输出、可重跑（先按 recordId 幂等删插）；**不要求一次性进单事务**，在低峰跑；跑期间读路径 `GX_M1_SIDECAR=off`。
- `GX_M1_SIDECAR=on` 时写维护常开；读是否使用由 S6/S7 决定，本片刻意"只写不读"。

**一致性自检**：新增 `fieldIndex/__tests__/parity.test.ts`（对拍）与一个只读巡检函数 `sidecarDrift(tableId)`（抽样比对 fields JSON 抽出值 vs sidecar 行数/值），S10 在大数据集上要求 drift=0；启动/readyz 不强制（避免百万行巡检拖慢），提供 CLI。
**独立验收**
```bash
GX_M1_SIDECAR=on pnpm tsx scripts/bench/backfill-sidecar.mjs --table <t> --batch 1000
pnpm tsx scripts/bench/check-sidecar.mjs --table <t>     # drift 0
pnpm --filter @gx/api test                              # 317 全绿（读路径未变）
```
**对 RC**：RC-12 软删/恢复（sidecar 随软删撤、随恢复重建）、RC-29 必填/draft（草稿空值 isNull 行为）必跑。
**回滚**：`GX_M1_SIDECAR=off`（停读，写维护可停可留）；表为派生，truncate/丢弃即可。

---

### S5 — hydration 批量化（两阶段预取）+ 消灭写后全表回查

**现状证据**：hydrate.ts:74-77 串行；`:407/:418/:431/:436-444/:501/:508/:530/:597/:602/:366` 逐行/逐字段查；prismaDeps 批量签名 `:100-126`；写后全表回查 records.ts:385 与 :590；详情全表回查 :529。

**改动要点（行为锁死，只改取数编排）**
- 在 `hydrateRecords` 顶层引入**列表级两阶段**，保持对每行仍调用（或等价内联）既有 `buildFirstPassMerged` + `computeFormulas`，逐值 deep-equal S0 快照：
  1. **预取阶段（按依赖图有限批量）**：
     - 对本批 records 的每个 links/subtable 字段：**一条** `getLinkRows({linkFieldId 集合, parentRowId IN 页ids})` 与反向 `(childRowId IN 页ids)`（按 linkFieldId 分组，单字段 IN；用现有 `(linkFieldId,parentRowId)/(linkFieldId,childRowId)` 索引）。
     - 收集全部对端 record id → **一次/每对端表一次** `getRecordsByIds(IN)`；字段元数据每表一次（fieldCache 提升为列表级）。
     - lookup/rollup/count 需要的对端记录在同一批 IN 里取；`count` 无筛选时直接用预取的 linkRows/活对端集合计数（**保持 resolveCount :594-599 的"排除软删对端"口径**）。
     - 点引用 `{关联.子字段}` 需要的子记录，先在本批 merged/shallow 缓存命中；未命中 id 收敛成**每表一次 IN** 再递归（受 `merging` 循环守卫保护），替代 `:366` 单 id 查。
  2. **计算阶段**：纯内存跑第一轮 + 公式 Kahn 拓扑；`shallowCache/mergedCache` 从"单行递归内"扩展为"列表请求级"（hydrate.ts:41-52 的上下文结构已有，直接在整个 records 集合共享）。
  - 并发用"按层有限并发"（每层 `Promise.all`，并发上限常量如 8），**不引入新依赖**；跨层 await 点与现状一致，保证 bt/hm、浅层 links（跳过计算字段，防无限递归）行为不变。
  - `getRecordOrdinal` 沿用 `orderedIds` 缓存（prismaDeps.ts:69-80），批量化后首屏仍是一次 id 列表查询；`resolveUserName` 批量解析页内去重 userId（一次 `user.findMany({id IN})` 填缓存）。
- **消灭写后全表回查**：
  - 新增 `hydrateRecordById(tableId, recordId)`（内部 = 取该行 RawRecord + `hydrateRecords([row],...)`），POST/PATCH 成功后只 hydrate **本行**返回，替换 records.ts:385、:590 的 `queryRecords(noPaging)`。affectedParents 计算不变。
  - 详情 GET `:529` 同样改为单行 hydrate（不再全表）。
  - CSV 导出 tables.ts:345 保留全量，但改走 S2 的**只读流式/分批 keyset 拉取 + 批量化 hydrate**（每批 500-1000 行拼 CSV），避免一次性百万行进堆；RC-04 公式注入防护在拼串层保持。
- Deps 接口可**只增**一个批量可选方法（如 `getLinkRowsBulk(qs[])`），旧签名保留（317 里的内存 deps 夹具无需重写，新方法给默认实现）。

**独立验收**
```bash
pnpm --filter @gx/api test
# 新增：N 行宽表（2 links + 1 lookup + 1 rollup + 1 count + 2 公式含点引用/链式/环）
# 断言：① 与串行实现逐 cell deep-equal（S0 快照）；② 查询总次数为常量（统计注入 deps 的调用数），不随 N 线性增长
# POST/PATCH 后响应 record 与改造前全表回查 .find 的结果 deep-equal
```
**对 RC**：RC-31~RC-37（公式/聚合/点引用/默认值一致性）、RC-32（多子记录不 join 成串）、RC-11（bt 多目标 400）必跑。**这是 M1 最高回归风险片**，任何一个 cell 对拍不一致即阻断。
**回滚**：`hydrateRecords` 保留旧串行实现为函数内分支（临时 flag 或直接 git revert 该文件）；写后回查还原。S5 与 S6 独立，可单独回滚不影响 sidecar。

---

### S6 — 物理字段过滤/排序/聚合下推 + unique 走索引 + 算符回退表

**现状证据**：recordService.ts:73-96 内存 filter/sort；filter.ts 18 算符（shared）；sort.ts 空值后/zh-CN numeric；group.ts/aggregate.ts；assertUnique records.ts:254-257 全表。

**新增 `apps/api/src/domain/queryPlan/`**
- `compile.ts`：把 `ViewConfig.filters(FilterNode)` 与 `sorts[]` 编译为三部分：
  - `physical`：所有条件字段都经 policy 可索引、算符在"可下推白名单"→ 生成 sidecar 参数化 WHERE（自连接/EAV：每个条件一个 EXISTS/JOIN，AND/OR/NOT 用 SQL 布尔组合）；
  - `residual`：涉及计算字段或不可下推算符 → 保留为内存 `evalFilter`，在候选集上执行；
  - `sortPush`：排序字段可索引且**无 residual 过滤、无计算字段排序**时生成 sidecar/列 ORDER BY；否则内存排。
- **算符下推白名单（首批，对拍通过才开）**：
  - 数字/日期（valueNum）：`eq/neq/gt/lt/gte/lte/isEmpty/isNotEmpty`；
  - 单选/文本（valueText）：`is/isNot/isAnyOf/isNoneOf/isEmpty/isNotEmpty`；`contains/startsWith/endsWith` 仅对 sidecar 短文本用参数化 `LIKE`（**禁 `%` 注入**，转义 LIKE 通配）；
  - 多选：靠多行 sidecar，`isAnyOf`=EXISTS 同 fieldId/valueText IN(...)，`isNoneOf`=NOT EXISTS；
  - checkbox：`checked/unchecked`（valueNum=1/0）。
  - **回退内存**：notContains（EAV 多行情景下 NOT 语义易错位，保守回退）、匹配字段 valueType=field（跨列比较）、formula/lookup/rollup/count/links 上的任何条件、长文本 contains。
- 排序下推：单字段或首排序字段为物理可索引时走 sidecar ORDER BY + 记录级去重（EAV 多行需 GROUP BY recordId 取该字段值），tie-break `(createdAt,id)`；空值用 CASE 排后。多排序中夹计算字段则整体回退内存。
- 聚合下推（A5，只做能精确对齐的）：
  - 表尾 `count/countEmpty/countFilled/sum/avg/min/max` 对**物理数字/日期/checkbox** 字段在过滤后候选 record 集合上用一条 sidecar 聚合（`percentEmpty/percentFilled` 由 count 推导）；
  - `groups`：singleSelect/checkbox 分组可在 sidecar 上 `GROUP BY valueText/valueNum` 取桶与 recordIds（保持 group.ts 的选项顺序/颜色/空白桶最后——选项顺序在应用层重排，SQL 只负责分桶）；multiSelect/links/其余分组与含计算字段的分组回退内存 `computeGroups`。
  - formula/lookup/rollup 的聚合仍内存（文档化为大表提示，对齐 ARCH A5）。
- 编排（recordService 重构为计划器，但 `QueryResult` 契约不变）：
  1. `total = countLive`；
  2. 有 physical 谓词/排序 → sidecar 解析出候选 **recordId 有序集合**（keyset 在该集合上翻页）；
  3. **只对当页 recordId** 拉 RawRecord（按 createdAt,id keyset）+ 批量化 hydrate（S5）；
  4. 有 residual 谓词/计算排序/计算分组 → 触发"受限宽口径"：对**过滤后候选（非全部表）**批量取数后内存精修；若候选数超过 `GX_M1_INMEM_LIMIT`（默认 5 万，可配）且含计算字段排序/筛选 → 按 §2.3 返回"计算字段大表禁用"提示（S8 置灰），不硬算。
- `assertUnique` 改走 sidecar 等值通道（同事务内 SELECT 是否存在同 fieldId 同值、异 recordId、记录未删），行为与文案对拍 S0；sidecar 不可用（flag off/drift）时回退现有全表校验。

**独立验收**
```bash
pnpm --filter @gx/api test
# 新增 queryPlan 编译测试：随机 FilterNode → 断言 physical/residual 分类；
# 同一份数据上 SQL 下推结果集 == 全量内存 evalFilter/filter/sort 结果集（recordId 序列完全一致），覆盖 18 算符矩阵
# EXPLAIN QUERY PLAN 断言：等值/范围/排序命中 rfi_table_field_* / records_table_live_created_id，无全表 SCAN
```
**对 RC**：RC-01（日期 gt/lt）、RC-02（多选 isAnyOf 按选项 id）必跑。
**回滚**：`GX_M1_KEYSET=off` 且编排保留旧路径分支（S7 落地）；queryPlan 为新增模块，摘除其接线即回旧逻辑。

---

### S7 — keyset 分页接入列表 + COUNT 下推 + shadow 对拍（契约 additive）

**现状证据**：records.ts:280-302 列表；recordService QueryOptions:18-27（limit/offset/noPaging）；前端从不传 offset（§1.6）。

**改动文件**：`domain/recordService.ts`、`routes/records.ts`（仅 GET 列表）、`packages/shared-types/src/api.ts`（响应类型 additive）。
- QueryOptions 增 `cursor?: string | null`（不透明度令牌，base64url 编码 `{c:createdAt,id}`，服务端解码校验，防注入）；保留 `offset/limit/noPaging`。
- 响应**只增**：`nextCursor: string | null`、`hasMore: boolean`、（可选）`degraded: string[]`（如"computedInMem"/"boundedPreview"）。`records/total/filteredTotal/fields/allFields/groups/aggregations` 一字段不动。
- 兼容规则：
  - 不传 cursor：返回首页（与今天默认窗口同一有序集合的前 limit 行），并带 nextCursor；
  - 传 `offset`（老客户端）：仅允许 `offset < GX_M1_OFFSET_WINDOW`（默认 5 页 ×limit），窗口内用 keyset 内部快进实现（不使用 SQL OFFSET 深翻）；超窗返回 400 + 明确文案，引导用 cursor（当前无前端用 offset，风险极低）。
  - `limit` 钳制维持 ≤1000；默认页大小给网格 200（与现状一致），S8 再调。
- **shadow 模式**（`GX_M1_KEYSET=shadow`）：每个列表请求同时跑旧路径与新路径，对拍 `recordId 序列/total/filteredTotal/groups/aggregations`，只返回旧结果；差异计数与首个差异样例进日志（脱敏）。连续一迭代差异 0 才允许切 on（对齐项目灰度纪律）。
- `total/filteredTotal` 改为 COUNT（S2/S6），不再依赖数组长度；数字语义与今天一致（total=表内活行、filteredTotal=过滤后活行）。

**独立验收**
```bash
GX_M1_KEYSET=shadow pnpm --filter @gx/api test
# 新增路由测试（fake prisma + 真 better-sqlite3 临时库）：翻 10 页拼接 == 全量有序集合，无重复/遗漏；
# 老参数（无 cursor）响应字段与 S0 pagination-shape 快照一致，仅新增 nextCursor/hasMore
# shadow 日志在基准集上 drift=0
```
**回滚**：`GX_M1_KEYSET=off` 即完全旧行为；共享类型仅新增可选字段，老客户端不受影响。

---

### S8 — 前端游标消费 + 看板/月历"受限全量"口径 + 大表计算字段置灰（**需前端配合**）

**现状证据**：client.ts:304-320、hooks.ts:213-239；视图不传分页；KanbanView.tsx:78-84、CalendarView.tsx:79 客户端全量分桶；GridView 已有行虚拟化 :412-413/:519；FilterPanel 显示 filteredTotal。

**改动要点（web，遵循 web-conventions：只走 `api/client.ts`、不裸 fetch、用 gx-* token、不加新依赖；TanStack Query 5.62 已在依赖）**
- `client.ts` `Records.list` 增 `cursor?: string`，响应类型增 `nextCursor/hasMore/degraded`；`hooks.ts`：
  - 网格 `useRecordsInfinite`（`useInfiniteQuery`，getNextPageParam=nextCursor），GridView 改为随滚动累积页（复用现有 scrollTop/行高窗口，只把数据源从"一次 200"变"按页累积"），聚合栏 `aggregations/filteredTotal` 仍取服务端权威值。
  - **看板/月历/画廊**保留"需要完整分组结果"的语义，但数据来自服务端：
    - 方案（M1 采用）：这些视图在**有界候选集**内由服务端保证完整分组——当结果集 ≤ `GX_M1_GROUP_BOUND`（默认 1 万行）时走"分组全量模式"（内部对候选集 keyset 取满到 bound，仍只 hydrate 需要的轻字段/或全字段但受 bound 保护）；超过 bound 时前端显示"结果过多，请先用筛选/搜索缩小范围（当前覆盖前 N 条）"并按 bound 分组，**不静默假装全量**。
    - 单选分组（看板）在 M1 已可 sidecar GROUP BY（S6），可作为后续增强把 recordIds 直接取自服务端 groups；但为控爆炸半径，M1 先用"有界全量 + 明确提示"，groups 服务端聚合增强记为后续，不阻塞出口。
  - 选择器/关联记录选择（CellEditor.tsx:401、DetailLayout 三处、RecordDrawer）本就只需要对端表选项：改为**带搜索的限量查询**（按 primaryField sidecar LIKE/等值，limit 50 + 关键字），不再 `useRecords` 拉全表（这几处今天也是隐式全表，是百万行隐患，随 S8 一并改成受限查询）。
- **大表计算字段排序/筛选置灰**（ARCH §2.3 已决）：当表行数或预估成本超阈值（沿用 10 万档，具体值 S10 后定）且字段是 formula/lookup/rollup/count 时，排序/筛选控件 disabled + 提示"该字段为计算字段，数据量大时不支持排序/筛选，请先按物理字段缩小范围"；物理字段不受影响。
- 搜索框：列表内搜索走 S6 物理字段下推（flag on 后）；跨表全局搜索（SearchDialog）仍打 `/api/search`（M5 前是有界预览），UI 在收到截断标记时提示"仅搜索部分结果，完整检索即将推出"。

**独立验收**
```bash
pnpm --filter @gx/web typecheck && pnpm --filter @gx/web build
pnpm -w test
# 手测/Playwright 冒烟（M0 已具备 CI 冒烟位）：网格滚动加载 3 页无重复行；看板/月历在 5 万行下表单完整、
# 2 万行超 bound 出现提示且不白屏；关联选择器输入关键字只发限量请求（网络面板确认不带全表）
```
**对 RC**：RC-03（纯日期 Calendar 不跨时区错位）、画布类不受影响但需冒烟 R10 契约。
**回滚**：client/hooks 保留旧 `useRecords`（limit 默认 200）路径；新 hook 与置灰为增量，移除接线即回。**该片必须后端 S7 契约定稿后开工，是唯一不能纯后端独立完成的片。**

---

### S9 — 数据生成器 + 压测脚手架（50 万 / 100 万）

**现状证据**：现有 `docs/benchmark-api.md` 只有 2000 行 4 字段口径；M1 需宽表 + 关联 + 多类型。

**新增（全部在 `apps/api/scripts/bench/`，不影响服务代码）**
- `gen-data.mjs`（或 tsx）：参数 `--rows 500000|1000000 --tables 2 --shape wide|narrow --out <dbFile>`：
  - 直接用 better-sqlite3 写一个**与生产同 schema**（先 `prisma migrate deploy` 到临时库）的库，或打运行中服务的 API 二选一；默认 **SQL 直灌**（可控、快），关键路径再用 API 灌一版小样本验证写链路。
  - 宽表 30 字段：singleLineText（含主字段）、longText（小比例）、number/currency/percent/duration/rating、date/datetime、checkbox、singleSelect(8 项)/multiSelect(≤5 项)、email/url/phone、autoNumber、2 个 links（mm 与 hm 各一）、1 lookup、1 rollup(sum)、1 count、1 链式 formula、1 点引用 formula、1 个 attachment 字段（**用 1KB 小占位对象**，不灌 2MB dataURL——附件外置属 M2，避免把未外置因子混进 M1 测量）。
  - 关联分布：80/20 偏态（少量父记录挂大量子记录），含一部分软删记录（默认 5%）与跨表 links；数据确定性可播种（`--seed`），保证 A/B 与重跑可复现。
  - 生成后执行 `backfill-sidecar.mjs`（S4），产出 sidecar 就绪库。
- `bench-gate/`：
  - `run-gate.mjs`：对目标服务（默认本地起 dist，NODE_ENV=production，独立 DATABASE_URL）按场景发请求，**每场景先 50 次预热丢弃，再 ≥200 次采样**，记录每次服务端耗时（服务端在响应头/日志给 `x-gx-serve-ms`，压测脚本也自测客户端耗时），输出 P50/P95/P99、QPS、失败率、**每请求 SQL 查询条数**（Prisma `query` 日志在 bench 模式开启计数）、RSS 峰值。
  - 场景矩阵：默认列表首页/翻深页（游标到 80% 处）/物理字段等值/范围/多选 isAnyOf/排序（数字、日期、单选）/组合 AND-OR/表尾聚合/分组/关键词搜索（短词与 ≥3 字词）/并发写（batch=20）/混合读写。
  - 宽表与窄表各一轮；1 万/10 万/50 万/100 万四档。
- `write-contention.mjs`（S1 验收用）。

**独立验收**：生成 1 万、10 万档在本地分钟级完成；行数/字段数/关联数/软删比例输出清单；库文件与 WAL 大小记录。
**回滚**：脚本为新增，删除即可；生成的库一律写临时目录，不碰开发/生产库。

---

### S10 — 证伪门执行：P50/P95、阈值、ADR-0008 客观判定、产物留存

> **⚠ 2026-09-12 调整（见 `docs/planning/phase2/PLAN-ADJUST-nas-min-hardware.md`，项目总监 92d0a34 决策）**
> 本节切片正文保留（run-gate / gen-data / audit-server-log 等工具全部保留、有用、零服务开销），但**验收口径按 NAS 最低硬件重定向**，以下方批注为准：
>
> 1. **放行不再以固定规格机 4C8G+SSD / 百万行 / best-of-5 / P95 硬阈值为门槛**，改为 **Tier-L（2C4G / 机械盘或典型 NAS 网络盘）小规模基线 DoD**（PLAN-ADJUST §5.2）：1k/1万/10万 三档验证"无 SCAN + 内存有界 + 并发写零 BUSY + 可回退"。下方"硬阈值表"与"5 轮取 P95"不再作为放行硬门。
> 2. **常规回归只跑 1k / 1万 / 10万**；**50万/100万降为可选参考画像（profile）**：谁需要谁在自己机器上跑，报告必须标注机型/冷热/盘型，不作统一对客毫秒承诺、不阻塞里程碑。
> 3. **ADR-0008 T1 已硬件无关改写**：不再是"4C8G+SSD 百万行 P95≥1.5s（≥3/5 轮）"，改为真实目标机/最低参考机 + 代表性真实工作负载 + 持续症状（延迟持续超标 / RSS 触顶 OOM / 写排队超时）+ 已穷尽调索引/调 bound/升 better-sqlite3，方议迁 PG（PLAN-ADJUST §5.3、ADR-0008 §10）。T0/T2/T3/T4/T5 不变。
> 4. **bound 默认按 Tier-L 保守设定**（建议起点 `GX_M1_GROUP_BOUND=5000` / `GX_M1_INMEM_LIMIT=20000`、网格默认页 100–200；**建议起点，待 Tier-L 实测回填，非拍板阈值**）。
> 5. **读 keyset + sidecar 在 Tier-L 完成 shadow drift=0 + 内存有界验证后默认置 on**（异常自动回退旧路径的机制保持），让低配默认走有界/索引路径；旧路径保留可一键 off 回退。
> 6. S5b-Ⅱ（字段投影器）前提已被 cpu-prof 证伪（点引三函数 self 仅 busy 1.15%，`docs/baseline/2026-09-14-s5b-cpuprof-attribution.md`）正式后移；S5b-Ⅰ、展示标题物化第三类成本、§3.3 宽命中 COUNT 优化一并登记为"按规模触发的延后候选"（PLAN-ADJUST §2.3、ADR-0008 §10.3）。

**度量口径**
- 冷机（重启服务、清 OS 页缓存的说明：macOS/Linux 给方法，Linux `vfs.drop_caches` 需 root，跑不了就标注"温缓存"并同时给冷/温两组）。
- 每场景 5 轮，取每轮 P95 的中位数作为报告值（对齐 ARCH §5.1"5 轮取 P95"）；同时留原始每次样本。

**硬阈值（SPEC AC-M1-1 / §2.2）**

| 场景 | 50 万行 | 100 万行 |
|---|---|---|
| 物理字段索引命中（等值/范围 + keyset 翻页），页大小 100，P95 | **< 800ms** | **< 1.5s** |
| 默认列表首页 P95 | < 300ms（ARCH 目标，争取） | < 800ms |
| 每列表请求 SQL 条数 | 与行数无关的常量（记录实测上限） | 同左 |
| 物理字段排序/筛选 P95 | < 800ms | < 1.5s |
| 并发 batch=20 写 | 0 个 SQLITE_BUSY；失败仅允许业务 4xx | 同左 |
| RSS（宽表单次列表请求） | 不随行数线性放大（对比 10 万档给出倍数说明） | 同左 |

**ADR-0008 客观判定（不达标才立项，禁止凭感觉）**
- 触发需同时满足：A1/A2/A4/A5/A6（即 S1/S4/S5/S6/S7）全部上线、sidecar drift=0、查询计划确认命中索引（`EXPLAIN QUERY PLAN` 无全表 SCAN）、计算字段已按 §2.3 置灰——在此前提下，**物理索引命中场景 100 万行 P95 仍 ≥1.5s（5 轮中有 ≥3 轮超标）**，或默认列表 ≥800ms，方判定"SQLite 路线证伪"，立项 ADR-0008 迁 PG（ARCH §3.4 另列千万行/100GB/持续百写 QPS 等阈值，M1 门只引用性能这一条）。
- 若仅"计算字段/全文搜索"慢，**不触发** PG（那两项本就不在 M1 承诺，分别是已决禁用与 M5）。
- **数据留存（必须）**：报告目录入仓 `docs/baseline/m1-gate-<date>/`（大文件不入 git，报告 + 生成参数 + EXPLAIN 计划 + 每轮汇总入 git，原始 CSV 放制品库/压缩包旁注 sha256）；保留：种子值、行数与 schema 版本、机型/CPU/内存/磁盘类型（SSD/HDD）、Node/SQLite 版本、冷热缓存说明、5 轮原始样本、新旧（flag off/on）A/B 对照、查询条数、EXPLAIN QUERY PLAN 输出。
- 输出 `verdict: pass | fail` 与是否建议 ADR-0008 的书面结论；fail 也先给"调索引/调 bound/升 better-sqlite3"的二次尝试清单再谈迁库。

**独立验收**：`node scripts/bench/run-gate.mjs --rows 500000,1000000 --rounds 5` 产出报告，门脚本退出码反映 pass/fail（供 CI 手动触发 job，不进每次 push 的门）。
**回滚**：纯验证片，无代码回滚；压测库临时存放。

---

### S11 — M1 出口收口：40 条 RC 回归 + 搜索边界文档 + flag 生命周期 + ADR-0004 落档

- `docs/adr/0004-eav-sidecar-index.md`（MADR）：记录普通表（非 WITHOUT ROWID）、只索引物理标量、写时同事务维护、可重建派生、与 M5 FTS 的分工、PG 可移植取舍（Related: ADR-0002/0005/0008）。
- 在 ADR-0005 占位/企业 ADR-0018 备注：**M1 已实测 trigram ≥3 字命中、2 字中文不命中**（SQLite 3.53.4），M5 短词 LIKE 回退为已验证前提；M1 不建主库 FTS。
- `docs/baseline/2026-09-13-m1-gate.md`（或 S10 目录）：汇总 317→317+N、RC 结果、门结论。
- **搜索截断边界显式化**：records.ts:474-478 与 search.ts:76-80 的 `take:2000` 保留；在两处响应/日志加有界预览标记与注释指向 M5（不扩成全表扫、不引 FTS）；runbook/已知限制登记"全局搜索为有界预览，M5 统一检索替换"。
- flag 生命周期：列出各 flag 默认值演进（S1 on；S4 写 on；S7 shadow→on 时间表）、全量稳定一个迭代后删旧路径与 flag 的条件（另开清理任务，不在 M1 内删，保证可回退）。
- 全量跑 `docs/baseline/2026-09-12-regression-cases.md` 的 40 条 RC，重点：RC-01/02（过滤）、04（CSV）、07（KB 锁）、08（WAL）、09/10/11/12（事务/基数/软删）、28（日期/defaultNow）、29（必填/draft）、31-37（公式全家）。
- 更新 ARCH-production §6 P1/P2 勾选状态与 ADR 索引；runbook 增"sidecar 重建""大表提示""M1 回退（关三 flag）"。

**出口 DoD 见 §10**。

---

## 7. 对 317 基线与 40 条 RC 的影响面与保护

| 触碰源 | 切片 | 为什么不破坏 317 / 保护措施 |
|---|---|---|
| 写路由包队列 | S1 | 队列不改返回值/状态码；事务函数签名不变；RC-07/09/10/12 专项；test 环境默认旧路径可断言 |
| 新增 better-sqlite3 只读连接 | S2 | M0 readiness/backup 已用同依赖同模式；rawRead 为新模块，单测用临时库，不碰 fake-prisma 路由测试 |
| 新增迁移 | S3 | CI 迁移期望数按目录动态计；干跑临时库 + integrity 断言；只增 DDL |
| 写点插 sidecar 维护 | S4 | flag off 读路径零变化；写仍在同事务（失败整体回滚，RC-10/12）；drift 对拍测试 |
| hydrate 重写取数 | S5 | **最高风险**：S0 batch-parity 逐 cell deep-equal 门；保留串行实现可切换；RC-31~37 全跑 |
| 列表编排重写 | S6/S7 | QueryResult 字段不变；shadow 双跑对拍 0 差异才切；算符回退表保证语义不对齐即走旧内存路径 |
| POST/PATCH/详情回查改单行 | S5 | 返回的本行与旧"全表 .find" deep-equal 测试；affectedParents 不变 |
| 前端分页 | S8 | web 无单测（M0 已 --passWithNoTests），新增 hook 测试 + Playwright 冒烟；旧 useRecords 保留 |

**每切片统一回归口令（PR 必贴）**
```bash
pnpm -w install --frozen-lockfile
pnpm --filter @gx/api typecheck && pnpm --filter @gx/web typecheck && pnpm --filter @gx/shared-types typecheck
pnpm -w test          # api 261+N、shared 56；计数只许增，不许任何既有用例由绿转红
bash scripts/ci-quality.sh
```
合并策略：任一切片使既有 317 任意一条变红即阻断；S5/S6/S7 额外要求对应 characterization 对拍 0 差异。

**预计新增测试（317 → 约 317+70～100，以实现为准）**：S0 特征测试 ~20、S1 并发写 ~5、S2 raw/keyset ~6、S4 sidecar 抽取/对拍 ~12、S5 hydration 批处理奇偶/查询数 ~10、S6 queryPlan 算符矩阵/EXPLAIN ~15、S7 路由分页/兼容 ~6、web hook ~4。

---

## 8. 证伪压测门（补充操作细节）

> **⚠ 2026-09-12 调整（见 PLAN-ADJUST §5，项目总监 92d0a34 决策）**：本节"50 万 / 100 万两档"操作细节保留为**可选参考画像**的跑法；**放行回归只用 1k / 1万 / 10万 三档**（Tier-L 最低参考机或可得最接近机器，标注规格），核心判据是 EXPLAIN 无 SCAN、RSS 有界、并发写零 BUSY、shadow drift=0，而非 best-of-5 毫秒硬阈值。50万/100万不要求固定规格机、不阻塞里程碑；EXPLAIN 无 SCAN 与失败留存纪律对所有档位继续有效。

- 被测物必须是 **esbuild 生产产物 `dist/index.js`**（M0 S2 已具备 `node dist/index.js`），不用 tsx watch 测性能。
- 数据规模两档（50 万 / 100 万）× 两形态（窄表 4 字段 / 宽表 30 字段含关联公式）；每页 100 行。
- 计时以服务端中间件埋点为准（在 S1 写队列等待/运行计时基础上，给读路径加 `x-gx-serve-ms` 与 SQL 计数，仅 bench/日志，不入响应契约承诺字段）。
- "命中物理索引"的判据用 `EXPLAIN QUERY PLAN` 输出包含 `record_field_index` 的 `SEARCH ... USING INDEX rfi_table_field_*` 与 records 的 `records_table_live_created_id`，**不得出现 `SCAN record_field_index`/`SCAN records` 全表扫描**（计划文本在报告留存）。
- 失败留存：超标轮次的 EXPLAIN、参数、样本一并归档，作为 ADR-0008 讨论的事实输入。

---

## 9. 外部输入清单

### 可先行（不依赖外部，本地可完成并自测）
S0–S9 全部代码/脚本/迁移/单测；S10 在本机/CI 跑出 1 万/10 万/50 万档（100 万档取决于本机磁盘，见下）；S11 文档与 RC 回归。

### 待外部（不挡本地编码，单独跟进）

> **⚠ 2026-09-12 调整（见 PLAN-ADJUST §5，项目总监 92d0a34 决策）**：下表前两行的口径已反转——**不再等待固定规格 4C8G+SSD 压测机，也不再"先按 4C8G 标定"**。放行基线改为 **Tier-L 最低参考机（2C4G / 机械盘或典型 NAS 网络盘）**；4C8G+SSD 只是更高档的可选画像。bound 起点直接按 Tier-L 保守设定（`GX_M1_GROUP_BOUND=5000` / `GX_M1_INMEM_LIMIT=20000`，**建议起点、待 Tier-L 实测回填**），拿到真实 NAS 清单后回填修订。原表保留备查，按下方批注解读。

| 输入 | 用途 | 缺失时降级 |
|---|---|---|
| **一台固定规格压测机**：建议 4C8G + SSD（与生产最低/推荐对齐，ARCH §4.1），明确磁盘类型、是否可 drop_caches 【**2026-09-12 调整：不再是放行前置；Tier-L（2C4G/慢盘）才是验收基线，4C8G+SSD 仅高档画像，50万/100万为可选参考画像**】 | S10 的 100 万行终验数字要可复现、可与客户机对照 | 本机先出 50 万档与 100 万温缓存参考值；门结论标注机型，正式终验等压测机 |
| 生产最低机确认（2C4G 是否仍为下限）【**2026-09-12 调整：下限已确认按 2C4G + 慢盘（含 HDD/NAS 网络盘）验收；待真实 NAS 清单回填，而非等 4C8G**】 | 设定 bound 默认值（GROUP_BOUND/INMEM_LIMIT）与默认页大小 | 先按 4C8G 标定，2C4G 给保守默认【**改为：直接按 Tier-L 保守起点（5000/20000，建议起点待实测回填），高端机可调高**】 |
| 大表阈值的产品确认（计算字段置灰门槛行数） | S8 UI 置灰阈值 | 先用 10 万行档（ARCH §2.3），S10 后回填实测值 |
| 是否需要看板/月历在 >bound 时的服务端分组增强（单选 sidecar GROUP BY） | S8 后续增强，不阻塞 M1 出口 | M1 用"有界全量 + 提示" |
| Gitee Go 大库压测 job 的 runner 磁盘/时长配额 | S10 是否进流水线手动触发 | 脚本本地可跑，CI 只挂触发位 |

> 除"固定规格压测机"外，M1 编码与 50 万档证伪**不需要任何外部凭据/证书/新依赖**（better-sqlite3 已是 dependency，TanStack Query 已在 web 依赖）。

---

## 10. M1 出口 Definition of Done

1. `bash scripts/ci-quality.sh` 全绿；317+N 测试全绿；40 条 RC 中 M1 相关项（见 S11）逐条留证。
2. 三个 flag 均可一键回退到 M0 行为；`GX_M1_KEYSET=shadow` 在基准集连续一迭代对拍 0 差异。
3. 只增迁移在临时库 `migrate deploy` 干跑通过（迁移数自动对账）、`integrity_check=ok`；发布前在线快照链路（M0）对新表有效；sidecar truncate 后可幂等重建且 drift=0。
4. hydration 批量化：宽表列表请求 SQL 条数为与行数无关的常量（报告留实测值），与串行实现逐 cell 等价；POST/PATCH 不再全表 hydration（单行写在 50 万行下耗时不随表规模增长）。
5. 压测门：50 万物理索引命中 P95<800ms、100 万<1.5s；默认首页达 §10 阈值；并发写零 BUSY；EXPLAIN 命中索引无全表 SCAN；报告与原始数据按 S10 留存。【**⚠ 2026-09-12 调整（PLAN-ADJUST §5.2，92d0a34）**：50万/100万 P95 硬阈值不再是出口门，改按 Tier-L（2C4G/慢盘）1k/1万/10万 小规模基线（无 SCAN + RSS 有界 + 零 BUSY + 可回退），大规模仅可选参考画像；以 §S10 顶部调整批注为准。】
6. 不达标则按 S10 客观条件判定是否立项 ADR-0008（计算字段/全文慢不算触发项）。
7. 前端网格游标翻页无重复/遗漏；看板/月历超 bound 有明确提示且不白屏；大表计算字段排序/筛选置灰；无新增 npm 依赖、无裸 fetch、无 emoji/UI 越界（UI 仅置灰/提示与既有 gx-* 组件）。
8. 主库不新增任何 FTS 虚表；两处搜索 2000 行截断以"有界预览（M5 替换）"显式登记。

---

## 11. 现状核对后与主理人所给旧行号/描述的不符之处

1. **测试基线数字**：现状为 **api 261 + shared 56 = 317**（M0 基线文档起点是 270）。与主理人"317 测试"一致；M1 回归门以 317 为"不许转红"基线。
2. **假分页主证据行号基本一致**：findMany 在 `recordService.ts:59`、slice 在 `:151`（旧证据约 :59/:151，一致）；默认 limit=200 在 `:150`。补充：total 在 `:63`、filteredTotal 在 `:85`、内存 filter `:73-75`、search `:78-83`、sort `:90-96`。
3. **搜索 `take:2000` 旧行号有偏差且不止一处**：旧证据指 `routes/records.ts:474`，实际在 **`routes/records.ts:477`**（`/api/records/search`）；另有**第二处**同口径截断在 **`routes/search.ts:79`**（`/api/search` 记录支路，旧 ARCH/任务未点名）。两处都属 M5 边界，M1 只显式化不改造。
4. **hydration 串行行号一致**：`hydrate.ts:74-77`；批量签名在 `prismaDeps.ts:100-126`（旧指 :100-126，一致）。补充逐行 await 点：`:407/:418/:431/:436-444/:501/:508/:530/:597/:602/:366`。
5. **records 索引旧行号一致**：schema.prisma Record `:122-139`，`@@index([tableId])` 在 `:136`、`@@index([createdAt])` 在 `:137`（两个单列索引，无 `(tableId,deletedAt,createdAt,id)` 复合索引——M1 S3 新增）。
6. **任务未点名但同等严重的放大点（建议纳入 M1）**：POST 创建与 PATCH 更新成功后各跑一次**全表** `queryRecords(noPaging:true)` 再 `.find` 回本行——`routes/records.ts:385` 与 `:590`；详情 GET 同样全表回查 `:529`。百万行下"写一行即全表两轮 hydration"，已列入 S5 一并消除。
7. **ARCH-production 草稿 sidecar DDL 需修正以保方言**：其 `WITHOUT ROWID` 与 `value_text/value_num` 蛇形命名是 SQLite 风格；M1 改用**普通表**、引号列名（`"recordId"` 等，与现状 Prisma 命名一致）、标准类型，避免 ADR-0008 迁 PG 时重写（S3）。
8. **FTS5/trigram 已在本机预验证（仅定边界）**：better-sqlite3 13.0.3 内置 SQLite **3.53.4**，FTS5/trigram 可建；**trigram 对 2 字中文词不命中（实测"订单""离职"=0），≥3 字命中**。佐证 M5"短词 LIKE 回退"为必需；M1 据此明确不在主库建 FTS（避免与 M5 search.db 重复建设）。
9. **迁移数**：现状 **11 个**迁移；CI `scripts/ci-quality.sh` 期望数由目录数**动态**计算（非硬编码 11），新增迁移无需改 CI 常量。
10. **乐观锁范围澄清**：records 现状无 version；M1 用写串行队列消除同进程写写竞争，**不新增 records.version 列**。KbDoc 的 `contentVersion`（schema:287）是知识库独立机制，RC-07 要求保持，二者勿混。
11. **前端当前不传任何分页参数**：`useRecords` 的 10 个调用点均不传 limit/offset（类型支持但无人用），默认吃 200 行；且看板/月历在前端对全量记录自行分桶（KanbanView:78-84、CalendarView:79）。这决定了 keyset 不能只做后端、必须配 S8 的"分组视图有界全量"口径。
12. **字段类型不可变**：`updateField` 不写 type（fieldService:248-279），选项按 id 存储——sidecar 不存在"类型变更触发重建"，只需处理字段删除/恢复（S4），比旧 ARCH 设想的"类型变更重建"简单。

---

## 12. 切片速查（供派工 / RoleVerdict）

| ID | 标题 | 关键文件 | 独立验收（一句话） | 跨端 |
|---|---|---|---|---|
| S0 | 基线+特征测试 | docs/baseline/2026-09-13-m1-baseline.md；domain/__tests__/characterization/* | 317 全绿且新增快照锁死列表/hydration/算符/分页/unique 现状 | 否 |
| S1 | 写串行队列 | db/writeQueue.ts；db.ts；9 处 $transaction | batch=20 并发写零 SQLITE_BUSY，事务/409 语义不变，flag 可关 | 否 |
| S2 | 只读 raw 网关 | db/rawRead.ts | keyset 跨页不重不漏、COUNT 正确（临时库单测） | 否 |
| S3 | sidecar DDL 迁移 | prisma/migrations/<ts>_record_field_index_sidecar | 干跑迁移数自动 +1、integrity ok；普通表可移植 | 否 |
| S4 | sidecar 写维护+回填 | domain/fieldIndex/{policy,sync}.ts；写点；scripts/bench/backfill | 同事务维护、回填后 drift=0、读路径 flag off 不变 | 否 |
| S5 | hydration 批量化+消全表回查 | hydrate.ts；prismaDeps.ts；records.ts:385/529/590 | 与串行逐 cell 等价、查询数常量化、单行写不再 O(全表) | 否 |
| S6 | 过滤/排序/聚合下推 | domain/queryPlan/*；recordService.ts；assertUnique | SQL 结果序列==内存结果；EXPLAIN 命中索引；算符不齐即回退 | 否 |
| S7 | keyset+COUNT+shadow | recordService.ts；routes/records.ts；shared/api.ts | 翻页无重漏；响应只增 nextCursor/hasMore；shadow drift=0 | 契约 additive |
| S8 | 前端游标+分组口径+置灰 | web client/hooks/Grid/Kanban/Calendar/CellEditor/DetailLayout | 滚动加载正确；超 bound 提示不白屏；大表计算字段置灰 | **是** |
| S9 | 数据生成器+压测脚手架 | scripts/bench/{gen-data,run-gate,write-contention} | 可播种造 50 万/100 万宽表含关联/多类型 | 否 |
| S10 | 证伪门 | scripts/bench/run-gate.mjs；baseline 报告 | 50 万<800ms、100 万<1.5s，否则按客观条件议 ADR-0008 | 否 |
| S11 | 收口/ADR/RC/边界 | docs/adr/0004；baseline；两处搜索截断登记 | 40 条 RC 相关全绿、flag 生命周期与回退文档齐备 | 否 |
