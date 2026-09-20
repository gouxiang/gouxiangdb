# GouXiangDB Phase 1 生产化架构方案：容量、私有部署与四支柱落地

- 日期：2026-09-12
- 作者：架构师 高见远
- 状态：Proposed（待项目总监大湾区靓仔拍板）
- 适用基线：`main` @ v0.1.0（稳定性基线见 `docs/baseline/2026-09-12-stability-baseline.md`）
- 关联决策：[ADR-0001](../../adr/0001-architecture-selection.md)、[ADR-0002](../../adr/0002-database-sqlite.md)
- 性能事实来源：`docs/baseline/2026-09-07-api-benchmark.md`（2026-09-07，2000 行压测）
- 修订：2026-09-12 按项目总监"裸机优先、compose 可选"双轨裁决，增补部署双轨（§4.6）、R3 字段约束存量校验（§5.1）、备份静态加密（§5.3）、P 阶段与 PM M 里程碑对照（§6.1），并将计算字段超大表交互由悬置改为已决（§2.3）

---

## 0. 结论先行（TL;DR）

1. **当前瓶颈不在 SQLite 引擎，在应用层访问模式**：列表接口对整表 `findMany` 全量拉取、逐行串行 hydration、内存 filter/sort/group/aggregate 后 `slice` 假分页。2000 行 4 字段无关联时 P95 14.7ms 是"假象"——成本随行数 x 字段数 x 关联层级 x 附件 JSON 体积连乘，5 万行宽表即可把单请求推过秒级并伴随内存尖峰。
2. **数据层推荐路线 A：深挖 SQLite**，不迁 PostgreSQL。私有部署、单实例、10-50 并发用户、中期单表百万行的目标区间内，SQLite + WAL + 查询下推 + 旁路索引 + FTS5 完全够用，且零外部依赖是本产品私有部署的核心竞争力，不能为不存在的规模提前付运维税。
3. **PostgreSQL 是明确预留的 Plan B 而非现在**：量化切换阈值见 §3.4（单表 >1000 万行 / 库 >100GB / 持续写 QPS >100 / 需要多实例水平扩展或多租户 SaaS，四者触一即启动 ADR-0008）。
4. **部署一句话拓扑**：Caddy（TLS + 静态 Web 托管 + `/api` 反代）→ systemd 单实例 Hono(Node >=20) → 同机 SQLite 单文件（WAL）+ uploads 目录，每日在线备份 + 异地副本 + 季度恢复演练；Tauri 壳只做"指向服务端地址"的薄客户端。
5. **最高风险**：旁路索引表与 FTS5 依赖 Prisma 未覆盖的原生 SQLite 能力（手写 migration + `$queryRaw`），其中 Prisma 5.22 内置 SQLite 引擎是否编译 FTS5 需在 P2 启动前用 1 天 spike 证伪；证伪则降级为 better-sqlite3 13.0.3 旁路只读连接（已在 devDependencies 中，版本已锁定，非新增依赖）。

---

## 1. 现状瓶颈定位（代码事实，逐条引行号）

### 1.1 列表读路径：全表拉取 + 内存计算 + 假分页

`apps/api/src/domain/recordService.ts` 的 `queryRecords` 是 Grid/Gallery/Kanban/Calendar 四类视图的唯一数据出口：

| 环节 | 位置 | 事实 | 问题 |
|---|---|---|---|
| 全表拉取 | `recordService.ts:59-62` | `prisma.record.findMany({ where: { tableId, deletedAt: null }, orderBy: [...] })`，**无 take/skip** | 一次请求把该表全部活记录（含完整 fields JSON）读进 Node 堆 |
| 全量 hydration | `recordService.ts:66-70` | 对全部行执行两轮 hydrate | hydration 内含关联/查找/汇总/公式，成本随行数连乘 |
| 内存过滤 | `recordService.ts:73-83` | `evalFilter` / `matchesSearch` 对 hydrated 数组 `.filter` | 过滤选择性再好也无法减少 IO 与 hydration 量 |
| 内存排序 | `recordService.ts:90-96` | `sortRows` 全量排序 | 同左 |
| 内存分组聚合 | `recordService.ts:100-145` | `computeGroups` / `aggregateAll` 遍历全量行 | 表尾 SUM/AVG 与分组统计无法走 SQL 聚合 |
| 假分页 | `recordService.ts:148-152` | `hydrated.slice(offset, offset + limit)`，默认 limit=200（`:150`） | 翻页不省任何成本；offset 增大还额外付出数组切片 |
| total 口径 | `recordService.ts:63,85` | `total`=全表行数、`filteredTotal`=过滤后行数，二者在全量计算后才能得到 | 总数需求本身逼迫全表扫描，需用 `COUNT` 查询替代 |

数据模型加剧因素：`apps/api/prisma/schema.prisma:122-139`，`Record.fields` 是 JSON 字符串 TEXT（`:125`），表上只有 `@@index([tableId])`（`:136`）与 `@@index([createdAt])`（`:137`）两个索引，**没有任何字段级数据的索引通道**，服务端过滤/排序在现状下物理上无索引可用。

### 1.2 Hydration：逐行串行 + 每行多次查库

`apps/api/src/domain/hydrate.ts`：

- `hydrateRecords` 主循环为 `for (const r of records) { ... await hydrateOne(...) }`（`hydrate.ts:74-77`），**逐行串行 await**，N 行无任何批量预取与并发。
- 每行每个 links/subtable 字段各发一次 `getLinkRows`（`hydrate.ts:407` 正向、`:418` 反向），再对关联 id 集合发 `getRecordsByIds`（`hydrate.ts:431`）。
- lookup/count 同样逐字段查 `link_rows` + `records`（`hydrate.ts:501/508/530/597/602`）。
- `getMergedCached` 缓存未命中时按单 id 查库（`hydrate.ts:366`，`getRecordsByIds([recordId])`）。

`apps/api/src/domain/prismaDeps.ts` 的 Deps 实现本身已是批量签名：`getRecordsByIds(ids[])`（`:100-106`）、`getLinkRows(q)`（`:108-126`），但调用方按"单行单字段"粒度使用，批量能力被浪费。典型列表请求的查询数 ≈ 1（全表）+ N x（关联字段数 + lookup 字段数），是典型 N+1 串行查询。

既有缓解（不是解决方案，保留）：autoNumber 序号有 5 秒 TTL 的全表 id 缓存（`prismaDeps.ts:66-80`）、用户名 60 秒缓存（`:88-152`）。

### 1.3 全局搜索：每表最多扫 2000 行 + JS includes

`apps/api/src/routes/records.ts:457-506`：

- 对 base 内每张表逐表串行（`:472`），`findMany({ take: 2000 })`（`:474-478`，全局搜索的 2000 行硬截断与列表路径无关，是独立的第二处全量读取）。
- 在 Node 内对每条记录的每个字段做 `text.toLowerCase().includes(lower)`（`:491`），**超过 2000 行的表静默漏召回**；`results.length >= 100` 提前终止（`:500-502`）导致多表场景下排在后面的表永远不可搜到。
- 知识库文档另有冗余 `searchText` 列 + LIKE 路径（`schema.prisma:285`），与记录搜索是两套机制。

### 1.4 SQLite 并发与写路径现状

- `apps/api/src/db.ts:34-37`：启动时 `PRAGMA busy_timeout=5000` + `PRAGMA journal_mode=WAL`，失败静默降级；注释已记录必须用 `$queryRawUnsafe`（该 Prisma 版本下 `$executeRawUnsafe` 会静默吞错）。
- Prisma 5.22 的 SQLite connector 为**单连接**，应用内不存在连接池；WAL 允许"多读单写"，写与写之间串行。
- 写路径已事务化（`DbTx` 类型，`db.ts:10`；写函数统一接收事务客户端），但记录更新是"读出整行 JSON - 改 - 整 JSON 覆盖写"，**无行级乐观锁重试**（基线 R9，`2026-09-12-stability-baseline.md:103`）。
- 压测事实（`docs/baseline/2026-09-07-api-benchmark.md:26-30`）：串行创建 124.7 QPS；**并发批量写（batch=20）失败率约 50%**，文档已建议"批量写推荐串行"。

### 1.5 附件放大效应

附件以 dataURL 内嵌在 `records.fields` JSON 中（单文件 2MB、每格 20 个上限的过渡方案，基线 R2，`stability-baseline.md:96`）。附件与 §1.1 的全表读取相乘：一张含少量图片附件的表，每次翻页都可能把数十 MB base64 读进堆并经 hydration 传输——这是把"全表 findMany"从理论瓶颈变成实际事故的最可能触发器。

### 1.6 部署与工程现状（生产化的起点，不是空白）

- 进程：Hono 4.10.x + `@hono/node-server` 1.13.x（`apps/api/package.json:22-25`），入口 `apps/api/src/index.ts:116-124`，监听 `PORT`（默认 3001），`GX_NO_LISTEN=1` 可只挂载不监听。
- 健康检查已存在：`apps/api/src/routes/health.ts:9-12` 执行 `SELECT 1`，基线冒烟返回 `db:ok`。
- 安全起点：生产缺 `JWT_SECRET`（<16 位）fail-closed 拒绝启动（`apps/api/src/auth.ts:26-31`）；CORS 白名单（`index.ts:57-74`）；头像路径穿越防护与 MIME 映射（`index.ts:38-55`）；写关联有 IDOR 越权校验（`records.ts:81-92`）；密码 bcrypt cost=10（`auth.ts:62,183`）。
- 数据路径：相对路径 `file:./dev.db`（`apps/api/.env.example:7`、ADR-0002 约束）；10 个手写迁移目录 + `migration_lock.toml` 锁 sqlite（`apps/api/prisma/migrations/`）。但 `apps/api/package.json:14` 的 `db:migrate` 目前是 `prisma migrate dev`——**交互式命令，生产禁用**，生产化必须新增 `db:deploy: prisma migrate deploy`。
- 现有"部署"只有开发脚本 `scripts/dev-up.sh`（nohup + tsx watch 直跑源码 + 日志写 `/tmp`，`:16-17,36`），无进程守护、无 TLS、无静态托管、无备份。
- Tauri 2.1 壳已配置但内嵌前端：`apps/desktop/src-tauri/tauri.conf.json` 中 `devUrl=http://localhost:5173`、`frontendDist=../web/dist`，当前是"壳内整站"模式；私有部署的多端形态需要改成"壳指向远程服务端"（见 §4.5）。
- 工程化缺口（基线 R6，`stability-baseline.md:100`）：无 CI、无根 lint 实现、web 无单测导致根 `pnpm test` 退出 1、e2e 指向不存在的 vitest 配置。

### 1.7 瓶颈定性

```
当前请求成本（列表）≈
  全表行 IO(含附件JSON)
  x 每行串行 await 的常数延迟
  x (关联字段数 + lookup/rollup/count 字段数) 次查库
  + 全量 filter/sort/group/agg 的 CPU
  + slice 假分页（零节省）
```

四个乘子**全部在应用层访问模式**，与 SQLite 的存储引擎能力无关。同一 SQLite 文件，换成 keyset 下推 + 批量 hydration + 旁路索引后，列表成本从 O(全表) 降为 O(页大小)。这是路线选择的事实基础。

---

## 2. 约束与目标

### 2.1 业务约束（来自 ADR-0001/0002 与产品形态）

- 交付形态是**客户内网/单机私有部署**，不是公有云多租户 SaaS；部署操作者可能不是专业运维，"clone 即跑"到"一条命令上线"的顺滑度是产品力。
- 功能 1:1 对等 v1、零新增 bug 的回归红线不变；28 种字段类型、两轮 hydration、公式拓扑求值、双向关联语义是不可裁剪的内核（`hydrate.ts:1-19` 的契约注释）。
- Web 与 Tauri 壳共用同一 API，业务逻辑零分叉（ADR-0001 §客户端壳策略）。

### 2.2 容量目标（Phase 1 设计目标，非实测）

| 指标 | 目标值 | 说明 |
|---|---|---|
| 单库数据量 | <= 20 GB | 含 fields JSON，不含附件文件 |
| 单表活跃行数 | 中期 100 万行可流畅使用 | "流畅"= 默认列表 P95 < 300ms |
| 并发用户 | 10-50 人同时在线，峰值写 QPS 10-20 | 私有部署典型内网团队规模 |
| 列表接口 P95 | < 300ms（默认视图）/ < 800ms（带筛选排序） | 页大小 100 |
| 全局搜索 P95 | < 500ms，召回不截断 | FTS5 路径 |
| 故障恢复 | RPO <= 24h，RTO <= 1h | 每日备份 + 单机恢复流程 |

### 2.3 非目标（本期明确不做）

- 不做多实例水平扩展、读写分离、连接池外部化。
- 不做实时协作（Yjs 仍在 P3 以后，ADR-0001 排序未变）。
- 不做 PostgreSQL 迁移（仅保留通道与阈值，见 §3.4）。
- 不做计算字段（formula/lookup/rollup）的 SQL 化——它们保持应用层计算，本期只保证"默认与物理字段路径"下推。**[已决 2026-09-12]** 计算字段在超大表上的排序/筛选采用"禁用并提示"，**不做异步全量预计算**：当表行数或预估计算成本超过阈值（沿用容量门 10 万行档，具体阈值在 P1 压测后定值）时，UI 对计算字段的排序、筛选控件置灰并提示"该字段为计算字段，数据量大时不支持排序/筛选，请先按物理字段缩小范围"；阈值以下维持现状的内存计算路径。该决策取代原 §9 悬置项，异步物化计算字段明确不做（避免引入写时维护/刷新一致性的第二套派生数据，与旁路表的"物理字段才索引"边界保持一致）。

---

## 3. 数据层路线决策：深挖 SQLite（路线 A）vs 迁移 PostgreSQL（路线 B）

### 3.1 路线 A：深挖 SQLite 的六项改造

**A1. Keyset/游标分页下推（默认视图）**

默认排序固定为 `(createdAt ASC, id ASC)`（与现状 `recordService.ts:61` 一致）时，查询直接下推：

```sql
SELECT id, table_id, fields, created_at, updated_at, created_by, updated_by
FROM records
WHERE table_id = ? AND deleted_at IS NULL
  AND (created_at, id) > (?, ?)
ORDER BY created_at ASC, id ASC
LIMIT ?;
```

- 总数改独立 `SELECT COUNT(*)`（命中 `@@index([tableId])`，`schema.prisma:136`），不再靠 `rows.length`。
- 前端从"页码 offset"改为"上一页末行游标"，TanStack Query 5.62 的 `useInfiniteQuery` 承载（依赖已在 `apps/web/package.json:29`）。
- 跳页（直接跳到第 N 页）退化为受限能力：提供"上一页/下一页/跳末尾"，不提供任意深 offset——这是 Airtable/Notable 类 EAV 模型的通行取舍。

**A2. 可过滤/排序字段的旁路索引表（EAV sidecar）**

动态字段模型下无法用"每字段一列 + 建索引"（用户随时增删字段，SQLite ALTER 成本与 Prisma 迁移模型都不允许）。采用写时维护的旁路表：

```sql
CREATE TABLE record_field_index (
  record_id   TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  table_id    TEXT NOT NULL,
  field_id    TEXT NOT NULL,
  value_text  TEXT,      -- 文本/单选标签/多选摊平
  value_num   REAL,      -- 数字/货币/日期时间戳
  value_null  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (record_id, field_id)
) WITHOUT ROWID;
CREATE INDEX idx_rfi_table_field_num  ON record_field_index(table_id, field_id, value_num);
CREATE INDEX idx_rfi_table_field_text ON record_field_index(table_id, field_id, value_text);
```

- 仅索引被字段配置标记为"可筛选/可排序"的物理字段（默认：主字段、单选、数字、日期、复选框；多选/人员摊平为多行或 value_text 归一化）。
- 维护点：记录创建/更新事务内同步 upsert/delete（与现有 `DbTx` 写路径同事务，无最终一致性窗口）；字段删除/类型变更时重建该 field_id 的旁路行。
- filter/sort 下推为对旁路表的 `JOIN + WHERE + ORDER BY`，先解析出当页 record_id 集合，**hydration 只对页内行执行**——这是把 §1.2 N 行 hydration 砍成 100 行的关键。
- 手写 `migration.sql`（遵循 ADR-0002"schema 变更一律手写迁移"），Prisma schema 中将该表标注为 `ignore`（Prisma 5 支持 `@@ignore`），通过 `$queryRaw` 访问。

**A3. FTS5 全文检索替换内存 includes**

```sql
CREATE VIRTUAL TABLE records_fts USING fts5(
  record_id UNINDEXED, table_id UNINDEXED, content,
  tokenize = 'unicode61 remove_diacritics 2'
);
```

- 写记录事务内同步更新 FTS 文档（物理字段文本化，规则同 `recordService.ts:79-82` 的可见字段集合）；删除/软删同步删除。
- 全局搜索改为 `records_fts MATCH ?` 一次查询跨表召回，消除 `records.ts:477` 的 2000 行截断与 `:500` 的百条截断；snippet/高亮用 FTS5 `snippet()`/`highlight()`。
- 中文分词：`unicode61` 对中文按字切分，对标题/短文本的"contains"语义召回率可接受（对标现有子串匹配体验，不降级）；若后期要词级中文，挂 jieba 预分词写入 content，不改表结构。
- **前置 spike（P2 第一天）**：Prisma 5.22 内置 SQLite 查询引擎对 `CREATE VIRTUAL TABLE ... USING fts5` 与 MATCH 的支持必须实测。证伪预案：仓库已锁定 `better-sqlite3@^13.0.3`（`apps/api/package.json:34`，目前在 devDependencies），提升为正式依赖，以**独立只读/单写连接**打开同一 db 文件（WAL 模式下多连接安全），仅承载 FTS 与旁路表查询，事务写仍走 Prisma，避免双写引擎跨事务。

**A4. Hydration 批量化（DataLoader 化）**

把 `hydrate.ts:74-77` 的串行单行循环改为"列表级两阶段"：

1. 预取阶段（每个目标表至多 2 条查询）：`link_rows WHERE parent_row_id IN (当页 ids) OR child_row_id IN (...)`（现有索引 `schema.prisma:157-158` 已覆盖）+ `records WHERE id IN (全部关联到的 id)`（`prismaDeps.getRecordsByIds` 已是批量签名，`:100-106`）。
2. 计算阶段：批量结果注入按请求生命周期的 `HydrationContext` 缓存（缓存结构 `hydrate.ts:41-52` 已存在，当前只在单行递归内生效，扩展到列表级），公式两轮计算保持纯内存、纯函数语义不变。

预期查询数从 1 + N x K 降为 1 + 2 x（涉及表数），与行数解耦。

**A5. SQL 聚合承担表尾/分组统计**

数字/日期字段的 sum/avg/min/max/count（`aggregateAll`，`recordService.ts:139-145`）在旁路表上一条 `SELECT field_id, SUM(value_num)... GROUP BY field_id` 取回；分组计数与组内聚合同构。formula/lookup/rollup 聚合仍走内存（只对过滤后 id 集合），文档化为"计算字段统计可能触发较大计算量"，UI 侧对超阈值表给提示而不是静默慢查询。

**A6. 写并发收口（WAL 单写者纪律）**

- 应用层写串行队列：单实例内的写操作经一个 promise 链串行化（或受限并发=1 的写执行器），配合现有 `busy_timeout=5000`（`db.ts:35`）把 §1.4 的 50% 并发写失败在应用内消化，对前端保持"发送即可"。
- 记录更新加乐观锁：`records` 增 `version INTEGER DEFAULT 0`，更新条件带 version，冲突 409（与 KbDoc 既有 contentVersion 模式一致，`schema.prisma:287`，不引入新模式）。
- 批量导入（CSV）走单事务多语句（现有 csv 域已存在），禁止每行一事务。
- 部署纪律固化：systemd 单实例、不启 cluster（见 §4.1），SQLite 的单写者从"偶然成立"变为"架构约束"。

### 3.2 路线 B：迁移 PostgreSQL 的真实工作量

ADR-0002 已预留通道（"新增 provider + 迁移方言适配"，ADR-0002:51-53），但不是免费的，盘点如下：

| 工作项 | 具体内容 |
|---|---|
| Provider 切换 | `schema.prisma:13` provider 改 postgresql；`fields String`（JSON，`:125`）改 `Json`/`jsonb`，所有 `options/recordFilter/config` 等 String JSON（如 `:66,78,93,171`）逐个评估类型迁移 |
| 方言迁移 | 10 个手写迁移全部为 SQLite 方言，需重写 PG 版；`db.ts:34-37` PRAGMA 全部移除，替换为 PG 连接池/语句超时配置；任何 `$queryRaw` 日期/布尔弱类型语义需重验 |
| JSONB 查询 | 路线 A 的旁路表在 PG 里可被 JSONB + GIN 部分替代，但动态 key（fieldId 为 key）上的表达式索引同样需要写时维护或生成列，**并不会因为换库就消失**；FTS 从 FTS5 换 pg_trgm/tsvector，中文分词换 zhparser，召回行为需重新对齐 |
| 数据迁移 | SQLite -> PG 导出导入通道、cuid 主键与日期格式核对、行数校验、附件去引用核对 |
| 部署形态 | 每个私有部署客户需要 PG 实例（安装、建库、账号、备份、vacuum、版本升级），或随产品打包 Docker Compose——交付物从"一个文件夹"变"一组容器/服务" |
| 回归风险 | 214 个 api 单测 + 全量功能回归（基线 §2）+ 公式/hydration 契约（基线 §3.2）需全量重跑，数据层差异可能引入静默错误 |

### 3.3 对比矩阵

评分 1-5，5 为最好；权重对应"私有部署团队工具"这一具体场景。

| 维度（权重） | 路线 A：深挖 SQLite | 路线 B：迁移 PostgreSQL |
|---|---|---|
| 私有部署复杂度（25%） | 5：单文件、零外部服务、备份即拷文件，延续 ADR-0002 的 clone 即跑 | 2：每客户一个 DB 服务的安装/升级/账号/调参，或强依赖 Docker |
| 增量成本（20%） | 4：六项改造均在应用层与手写迁移内，无新基础设施；better-sqlite3 已锁定 | 2：方言重写 + JSONB 改造 + 迁移通道 + 全量回归，估计 3-4 人周且与功能迭代争抢 |
| 性能与容量达成（20%） | 4：百万行/20GB/50 人目标区间内达成（§6 有分阶段验证门） | 5：百万行轻松，上限到千万行/多实例 |
| 运维与故障面（15%） | 4：无 DB 进程、无复制、无 vacuum；风险集中在单文件与单写者 | 3：成熟但新增连接池、锁、膨胀、版本升级等故障类型 |
| 数据安全/备份（10%） | 4：在线 `.backup` 单文件 + 附件目录，恢复演练简单 | 3：pg_dump/PITR 更专业但操作门槛高 |
| 平滑演进（10%） | 4：旁路表/FTS/批量化在 PG 上大部分可复用，不白做；Prisma 抽象保留切换权 | 3：一步到位但当前用不到的能力是永久成本 |
| **加权总分** | **4.2** | **2.9** |

路线 A 的所有投入（hydration 批量化、写纪律、分页契约、备份监控）在路线 B 中**全部依然需要**——它们修的是 §1 的应用层问题，换库不能替代。这意味着路线 B 不是"A 的替代"，而是"A 全部做完之后再追加一次数据层迁移"。

### 3.4 推荐与量化切换阈值

> **⚠ 2026-09-12 调整（见 `docs/planning/phase2/PLAN-ADJUST-nas-min-hardware.md` §5.3，项目总监 92d0a34 决策）**：
> 本表"列表性能"阈值不再绑定"固定规格 4C8G+SSD + 百万行 + best-of-5"口径，**T1 已硬件无关改写**：
> 在真实目标机 / 最低参考机（Tier-L：2C4G / 机械盘或典型 NAS 网络盘）上，应用层手段（索引 / bound / better-sqlite3 升级 / hydration 收口）穷尽后，
> 代表性**真实工作负载**出现**持续症状**（默认列表/命中筛选延迟持续超标，或 RSS 触顶 OOM，或串行化后仍写排队超时）才议迁 PG；
> 单纯"计算字段/全文搜索慢"或"人造百万行宽 COUNT 慢"不触发。50万/100万 best-of-5 数字降为**参考画像（标注机型/冷热/盘型，非对客毫秒承诺）**。
> 数据规模（千万行/100GB）、写吞吐、形态变化三信号及本 ADR 的 T0/T2/T3/T4/T5 维持不变。详见 ADR-0008 §10。

**推荐路线 A**，分阶段落地见 §6。PostgreSQL 触发条件（满足任一即立项 ADR-0008，不以"感觉数据多了"为依据；"列表性能"行按上方 2026-09-12 调整批注执行）：

| 信号 | 阈值 | 测量方式 |
|---|---|---|
| 数据规模 | 单库 > 100GB，或单表活跃行 > 1000 万 | 每日健康检查上报 `page_count` 与每表 count |
| 列表性能 | A1-A5 全部上线后，默认列表 P95 仍 > 800ms（连续 7 天，P95 口径为真实工作负载） | 慢查询日志（§5.4） |
| 写吞吐 | 峰值写 QPS 持续 > 100，或 busy/锁等待经 A6 串行化后仍出现写排队超时 | 结构化日志写计时器 |
| 形态变化 | 确定要做托管多租户 SaaS、多实例水平扩展、或跨机只读副本 | 产品决策，非技术信号 |

对直接问题的回答：

- **"私有部署 + 中期百万行，SQLite 深挖够不够？"——够。** 百万行 x 每行平均 2KB JSON 约 2GB 数据 + 旁路表与 FTS 索引约 1-2 倍，单文件 4-6GB，远低于 SQLite 在 WAL + 正常索引下的舒适区；页查询命中索引后与总行数近似无关，COUNT 在百万行级为毫秒到几十毫秒。
- **"什么时候必须 PG？"——不是按行数到百万，而是按上表阈值**：千万行级、百 GB 级、持续百级写 QPS、或产品形态变 SaaS。这四个信号在可预见的私有部署客户中都不成立，因此 PG 在 Phase 1 只保持通道热（Prisma 抽象 + 方言意识），不投实施成本。

---

## 4. 私有部署参考架构

### 4.1 拓扑

> **⚠ 2026-09-12 调整（见 PLAN-ADJUST §5.1，项目总监 92d0a34 决策）**：硬件验收基线改为 **Tier-L：2 核（x86_64/arm64）/ 4GB 内存 / 机械盘或典型 NAS 网络盘（非 SSD）/ Linux + Node ≥20**。下方拓扑图中"最低 2C4G，推荐 4C8G + SSD"按新口径解读：**2C4G + 慢盘（含 HDD/NAS 网络盘）是验收下限，4C8G+SSD 仅是更高档表现的可选画像、不是门槛**；容量设计点为单表活跃 1万–10万行，50万为"有界降级"画像，百万不作初期目标。备份姿态同图末行：**产品默认仅本地手动/升级前快照，每日 timer 与异地（rclone/rsync）均不默认启用，异地容灾为预留接口**（PLAN-ADJUST §3，见 ADR-0007/0010 修订）。

```
                                客户内网主机（Linux，最低 2C4G，推荐 4C8G + SSD）
 ┌──────────────────────────────────────────────────────────────────────────┐
 │  Tauri 桌面端 / 浏览器（内网或 VPN）                                       │
 │        │  HTTPS（自签或内网 CA）                                           │
 │        ▼                                                                   │
 │  Caddy 2.8（:443/:80）                                                     │
 │   ├─ /                → 静态文件 /srv/gouxiangdb/web（vite build 产物）     │
 │   ├─ /assets,/uploads → 静态/反代（uploads 鉴权见 §5.2 说明）              │
 │   └─ /api/*           → reverse_proxy 127.0.0.1:3001                      │
 │        │                                                                   │
 │        ▼                                                                   │
 │  gouxiangdb-api（systemd 单实例，Node >=20，Hono 4.10，start: node dist/） │
 │   ├─ Prisma 5.22（SQLite，WAL，busy_timeout 5s，单连接单写者）             │
 │   ├─ /var/lib/gouxiangdb/app.db (+ .wal/.shm)                             │
 │   ├─ /var/lib/gouxiangdb/uploads/{avatars,attachments}                    │
 │   └─ 结构化日志 → journald（stdout）                                       │
 │        │                                                                   │
 │  cron：02:00 在线备份 → /var/backups/gx → rclone/rsync 异地（NAS/SMB）     │
 └──────────────────────────────────────────────────────────────────────────┘
        Tauri 壳（另三台...）：启动后配置/记忆服务端 Base URL，壳内不跑 API/DB
```

- **反代选 Caddy**：自动 TLS（可用内网 CA/自签）、配置一行量级、单二进制，匹配"部署操作者非专业运维"。客户环境强制 nginx 的，提供等价 nginx 配置片段作为附录（gzip、client_max_body_size、proxy 头）。
- **进程守护选 systemd**（Linux 标准、无额外运行时）：

```ini
[Unit]
Description=GouXiangDB API
After=network.target

[Service]
Type=simple
WorkingDirectory=/srv/gouxiangdb/api
EnvironmentFile=/etc/gouxiangdb/env.conf
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=3
# SQLite 文件与 uploads 在独立数据盘时挂载到 /var/lib/gouxiangdb
ReadWritePaths=/var/lib/gouxiangdb
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

  macOS 单机/LAN 试用场景用 pm2（`pm2 start dist/index.js --name gx-api --time` + `pm2 save` + `pm2 startup`）作为备选，文档双轨给出；生产客户标准为 systemd。
- **单实例是硬约束**（呼应 §3.1-A6）：不装 pm2 cluster、不开多进程；升级靠停止-替换-启动，停机窗口内完成（单机私有部署可接受，见 §7 回滚）。

### 4.2 目录与发布物

```
/srv/gouxiangdb/
  current -> releases/20260920-1           # symlink 原子切换
  releases/
    20260920-1/
      api/                                   # tsc 产物 dist + node_modules(pruned) + prisma/
      web/                                   # vite build 产物
/etc/gouxiangdb/env.conf                     # 600 权限，JWT_SECRET/CORS_ORIGIN/DATABASE_URL
/var/lib/gouxiangdb/
  app.db / app.db-wal / app.db-shm
  uploads/avatars uploads/attachments
/var/backups/gouxiangdb/
```

`DATABASE_URL` 用绝对路径 `file:/var/lib/gouxiangdb/app.db`（生产显式路径，ADR-0002 的相对路径约束针对开发/打包自洽，两者不冲突；env 文件不入库）。

### 4.3 密钥与配置管理

- `env.conf` 权限 600、属主与服务用户一致；`JWT_SECRET` 由部署脚本 `openssl rand -base64 32` 生成（与 `.env.example:12` 的指引一致），启动校验沿用 `auth.ts:28-31` 的 fail-closed。
- 新增必填环境变量在启动时统一校验（当前 JWT 校验在 auth.ts，建议集中为 `src/config.ts` 启动闸门）：`NODE_ENV=production`、`JWT_SECRET`、`CORS_ORIGIN`、`DATABASE_URL`、`ATTACHMENT_ROOT`。备份加密相关：`BACKUP_ENCRYPT_OFFSITE=true` 时 `AGE_RECIPIENT`（公钥收件人）必填，缺失则备份任务 fail-loud 不产出明文异地副本；解密身份 `AGE_IDENTITY_KEY` 仅在恢复时注入，不进常驻服务 env、不写部署主机。
- JWT 轮换（配合 R4 收口，§5.2）：`users` 表增 `tokenVersion INTEGER DEFAULT 0`，payload 带 `tv`，校验不一致即拒；改密/注销时递增——旧 token 7 天自然过期变为立即失效。轮换签名密钥本身：升级 `hono/jwt` 验证为"双密钥窗口"（新旧 secret 都接受两周，只发新 secret），当前依赖 `jose@^5.9.0`（`apps/api/package.json:26`）具备多 key 验证能力，不需要新依赖。
- 不上任何云 KMS；私有部署的密钥边界就是主机文件权限与运维流程。

### 4.4 数据库发布：migrate deploy 与回滚

- `apps/api/package.json` 新增脚本：`"db:deploy": "prisma migrate deploy"`；发布脚本顺序固定：`pnpm i --frozen-lockfile` → `prisma generate` → `prisma migrate deploy` → 重启服务。`migrate dev` 明确禁止出现在部署脚本（ADR-0002:32 已定，补工具护栏：部署脚本中出现 `migrate dev` 直接退出）。
- 迁移编写纪律：只新增兼容迁移——加列带默认值/可空、加表、加索引；**禁止**收缩列、删列、改类型（旧版本进程在切换瞬间可能仍在跑）。旁路表与 FTS 表均为纯新增。
- 回滚策略（SQLite 无自动 down）：
  1. 应用回滚：`current` symlink 切回上一个 release，重启，30 秒级。
  2. 数据回滚：仅当迁移本身失败或引入损坏——停机后用发布前自动生成的 `.backup` 快照整库还原（发布前一步强制备份，无快照不执行 migrate），RTO 内完成；因此要求所有迁移向前兼容，使"回应用不用回数据"成为常态。

### 4.5 静态 Web 与 Tauri 多端

- Web：`pnpm --filter @gx/web build`（Vite 7.1，`apps/web/package.json:8`）产物由 Caddy 直接托管，API 走同源 `/api`，前端 client 的 baseURL 在同源下用相对路径，消灭跨域配置面。
- Tauri 2.1（`@tauri-apps/cli/api ^2.1`，`apps/desktop/package.json:13-18`）：
  - 改为"远程客户端"模式：首次启动进入服务端地址配置页（存 localStorage/应用配置），`frontendDist` 仍可内置一份 Web 产物做离线引导页，业务请求全部指向配置的 `https://host/api`；移除"壳内连本地 5173/本地数据库"的暗示。
  - CSP 当前为 `null`（`tauri.conf.json` security 段），P1 收紧为默认拒绝远程脚本、仅允许配置服务端 origin。
  - 应用内更新：引入 `@tauri-apps/plugin-updater` + `plugin-updater` 签名体系（Tauri 2 官方组件，随 2.1 版本线），更新清单 JSON 与安装包由 Caddy 静态目录托管；私钥在构建机、公钥入壳。客户内网无外网时更新走"手动下载新版安装包覆盖安装"，updater 作为增强而非唯一通道。
  - 打包：`tauri build` 产出 macOS（.app/.dmg，minimumSystemVersion 10.15 已设）、Windows（.msi/.nsis）、Linux（.AppImage/.deb）；产物纳入发布物 checksums 清单。

### 4.6 部署双轨：裸机 systemd（默认）与 Docker Compose（可选，非默认）

**裁决（2026-09-12 大湾区靓仔）**：两条部署轨道并存——**裸机 systemd 是 §4.1 起的默认主线**，Docker Compose 是**可选交付（P0 先做可行性探针，通过后 P2/P3 才补交付物）**，不是先决条件，也不取代裸机 runbook。理由：私有客户机是否允许装 Docker 是外部事实（§9-4），在确认前不应把交付押在容器上；而裸机路径零额外运行时、与 ADR-0002"一个文件夹"形态一致，先成立。

**Docker 可行性探针（P0/最早阶段，半天工作量）**：在部署脚本/初始化向导里做一次只读环境探测，输出结论而不做任何安装：

1. `command -v docker && docker --version`、`docker compose version`（区分 v1 `docker-compose` 与 v2 插件）是否可用；
2. 不可用则探测是否**有权**安装：当前用户特权（`id -u`/sudo）、是否有包管理器、（受限环境）`docker info` 是否被策略拦截；
3. 记录目标 OS/发行版/内核（`uname -r`、`/etc/os-release`），与客户环境基线（§9-4）对账；
4. 结论三态落盘到部署清单：`docker-ready`（可直接 compose）/ `docker-installable`（需客户授权安装）/ `docker-unavailable`（全程裸机）。

探针结果决定 compose 是否进入交付：`docker-ready`/`docker-installable` 且客户接受容器形态，则 **P2/P3 补 compose 交付物**；`docker-unavailable` 或客户拒绝，则全程裸机，compose 不投入。裸机路径在任何一态下都必须完整可用，不允许出现"只能用 Docker 部署"的回退依赖。

**Compose 交付物规格（探针通过后，P2/P3 补）**：

- 三服务（对齐主理人指定的 api + web + Caddy 三服务形态），不引入数据库/缓存容器（延续零外部依赖原则，SQLite 仍为单文件挂卷）：
  - `gx-api`：Node >=20 跑 `dist/index.js`（同 §4.1 的 `start: node dist/`），entrypoint 先执行一次 `prisma migrate deploy` 再起服务（迁移失败即中止启动并给排错指引，对齐 PRD E3），复用 §4.3 同一套 env 启动闸门；
  - `gx-web`：独立静态服务容器（Caddy 或 nginx 小镜像）托管 Vite build 产物，仅监听内网/容器网络，不直接对外暴露 TLS；
  - `gx-caddy`：边界 Caddy 2.8，终结 TLS（内网 CA/自签），`/` 与 `/assets` 反代到 `gx-web`、`/api/*` 与外置附件下载反代到 `gx-api:3001`；Caddyfile 与裸机版同源维护（一份模板两处挂载），避免两套反代规则漂移。裸机形态下"边界 Caddy 兼托管静态"是单进程合并，容器形态按三服务拆开，路由语义两者一致。
- **命名卷与挂载**：声明具名卷 `gx-data` 挂载到 `gx-api` 容器内 `/var/lib/gouxiangdb`（`app.db`/`-wal`/`-shm` + `uploads/{avatars,attachments}`）；env 文件（`JWT_SECRET`、age 解密身份文件路径等，600 权限）以文件形式 bind-mount，不写进镜像与 compose 文本；备份产物与 §5.3 一致，落在可挂出到宿主机的 `/var/backups/gouxiangdb`，保证容器删了备份仍在。
- **离线安装**：交付 `docker save` 导出的镜像 tar（`gx-api`、`gx-web`、`gx-caddy` 三镜像）+ compose 文件 + Caddyfile + `.env.example` + 一页纸部署/加固文档；离线客户 `docker load -i *.tar` 后 `docker compose up -d`，全程不访问任何 registry/CDN（呼应 PRD 离线边界）。镜像 tag 固定版本、禁 `latest`（对齐 PRD E3）。
- 备份/恢复在容器形态下等价：在线 `.backup` 通过 `docker exec gx-api pnpm backup:online`（或宿主机直接对挂载卷上的 db 文件）执行；恢复 runbook 增加"停 `gx-api` 容器→解密→还原卷内文件→起容器"步骤。
- **单实例约束不变**：compose 不挂 `replicas`、不做横向扩展；升级为换固定 tag 镜像 + 启动自动 migrate deploy + 失败回滚旧 tag（应用层），数据回滚仍按 §4.4 快照。

---

## 5. 四支柱落地方案（版本全部锚定 package.json 实装）

依赖基线：Node `>=20`、pnpm `>=9`（根 `package.json:37-39`）；API：Hono `^4.10.3`、@hono/node-server `^1.13.0`、Prisma/Client `^5.22.0`、bcryptjs `^2.4.3`、jose `^5.9.0`、zod `^3.23.0`、better-sqlite3 `^13.0.3`（dev，A3 预案转正）；Web：React `^18.3`、Vite `7.1.11`、TanStack Query `^5.62.0`、Zustand `5.0.0`、Tailwind `^3.4`、Playwright `^1.49.0`、Vitest `3.0.5`；Desktop：Tauri `^2.1`。下文新增 npm 运行时依赖只有显式标注的两项候选（pino、prom-client），均给零依赖备选。另有一个**非 npm 外部二进制 age**用于异地备份加密（§5.3）：单静态二进制、随发布物 `bin/` 分发、无需安装与系统库，符合零依赖交付原则（不用则不启用加密，不影响本地备份）。

### 5.1 支柱一：容量铺路（对齐 R1/R2/R3/R9）

| 项 | 落地内容 | 锚点 |
|---|---|---|
| 查询下推 | §3.1 A1-A5，按 §6 分期 | `recordService.ts:54-155` 重写但保持 `QueryResult` 契约（`:29-35`）不变，前端无感切换 |
| 服务端分页 | 列表 API 增 `cursor/limit` 参数（保留 offset 窗口仅前 N 页），react-query `useInfiniteQuery`；grid 行虚拟滚动 | 前端 `apps/web/src/api/` 唯一数据出口（基线 §3.1 已约定禁裸 fetch） |
| 附件外置（R2） | 新表 `attachments(id, record_id, field_id, filename, mime, size, storage_path, sha256, created_by, created_at, deleted_at)`；文件落 `uploads/attachments/<yyyy>/<mm>/<sha256>`；fields JSON 只存 `{attachmentId, name}` 引用；上传直走 multipart（头像链路 `auth.ts:228-257` 已有 multipart 先例）；一次性迁移把存量 dataURL 落盘并改写 JSON | 消除 §1.5 的堆放大；备份与 §5.3 统一 |
| 写纪律 | §3.1 A6 写串行队列 + version 乐观锁 + 批量导入单事务 | `db.ts:10` DbTx 复用 |
| 字段约束存量校验（R3） | 见下方 R3 专条：唯一/必填设置变更先出只读存量违反报告，产品三选一；relationKind 变更同机制收敛 linkRow | P1，与数据链路改造同期；字段设置写路径 |
| 索引卫生 | 旁路表/FTS 索引随迁移创建；软删数据膨胀定期任务（每日低峰 VACUUM 评估，不自动跑，先报 page_count 趋势） | 手动维护，避免夜间意外写锁 |

容量验证门（每阶段用数据说话，不允许"感觉快了"）：构造 1 万 / 10 万 / 100 万行三档数据集（复用 `docs/baseline/2026-09-07-api-benchmark.md` 的压测口径，5 轮取 P95），宽表（30 字段含 2 关联 1 公式 1 附件字段）与窄表各一轮；门槛值对照 §2.2。

> **⚠ 2026-09-12 调整（见 PLAN-ADJUST §5.2，项目总监 92d0a34 决策）**：上句"1万/10万/100万三档、5 轮取 P95、对照 §2.2 硬门槛"的**签核仪式已改**。新验收基线＝**Tier-L（2C4G/慢盘）小规模 DoD**：常规回归只构造 **1k / 1万 / 10万** 三档，判据为"小规模日常可用（工程目标首页/命中筛选约 300–500ms 量级，慢盘以实测为准、不卡 best-of-5）+ EXPLAIN 无 SCAN + RSS 有界不随行数线性放大 + 大表有界降级 + 并发写零 BUSY + flag 可回退"；**100万档不再作为放行门**，50万/100万数字一律降为标注机型/冷热/盘型的可选参考画像，不作统一毫秒承诺。run-gate/gen-data 等工具保留。

**R3 字段约束变更的存量扫描校验（P1，与数据链路改造同期）**

基线 R3（`stability-baseline.md:97`）的两个缺口都要收口：唯一/必填改设置不校验存量；relationKind 变更不收敛存量 linkRow。落地为"先只读体检、再按产品决策执行"，绝不在管理员点下"设为唯一/必填"时静默产出与历史数据冲突的约束：

1. **存量扫描（只读，不改数据）**：在字段设置保存为"唯一"或"必填"、或关联字段改 `relationKind`（如一对多改多对多）时，先对该字段当前全部活记录跑一次扫描，返回结构化报告：
   - 唯一：违反行数 + 重复值分组 Top N（值、出现次数、样例 record id），走 §3.1 旁路表或对 `fields` JSON 的只读聚合（P1 旁路表已覆盖被标记可筛选/排序字段；唯一字段默认纳入索引）；
   - 必填：空值/缺失行数；
   - relationKind：不满足新基数约束的 linkRow 组数与涉及行。
   扫描在大表上为异步只读任务，设置页显示扫描进度、不阻塞界面（对齐 PRD 第十节"长任务不可让页面假死"边界），结果落一张轻量校验报告（内存态或临时表即可，不做永久业务表）。
2. **产品三选一（扫描报告出具后由管理员显式选择，对齐 PM PRD 口径）**：
   - **拒绝变更**：存量不满足则保持旧设置，报告即结论，不写任何约束；
   - **仅新数据生效**：约束只作用于此后的写入/编辑（应用层校验新值），存量违反行保留并在 UI 标注待处理，不强制回填；
   - **迁移后生效**：先引导管理员处理/去重/补全存量（提供按报告定位记录的入口），清零违反行后才正式启用约束，启用点同事务切换。
3. **relationKind 收敛**：第三种决策下提供 linkRow 收敛动作（截断超限关系或转中间表的明确处理），同样先报告后执行、可在低峰窗口跑；不做静默自动删行。
4. 该机制是 P1 数据链路改造的一部分（与 A4/A6 同期，复用写事务与字段设置路由），不依赖 P2 旁路表全部就绪即可先以只读扫描上线；唯一字段索引在 P2 后自动获得加速。

### 5.2 支柱二：安全收口（R4 全部四项 + 生产加固）

基线 R4（`stability-baseline.md:98`）逐项：

1. **restore field 不校验对端存活**：恢复字段前校验同表同 name 无活字段冲突、其关联配置（linkFieldId/relatedTableId/lookupFieldId）指向对象存活；不存活则拒绝并提示，不静默恢复出半残字段。
2. **分享链接删除后 member 不回收**：盘点分享链路的派生授权，删除 ShareLink（`schema.prisma:233-245`）时确保其授予的访问权随 token 失效即时收敛（分享鉴权以 token 实时查活为准，不留常驻 member 影子行；若存在影子行则同事务清除）。补测试：删链接后旧 token 访问返回 401/404。
3. **JWT 改密不失效**：§4.3 的 `tokenVersion` 方案，改密（`auth.ts:171-186`）、注销（`:194-225`）、管理员强制下线三处递增。
4. **头像扩展名信任 file.type**（`auth.ts:236` 当前按客户端声明 MIME 定扩展名）：上传后读文件头 magic bytes 真实判别（JPEG FFD8FF / PNG 89504E47 / GIF GIF8 / WebP RIFF...WEBP），与白名单不符拒绝；落盘文件名已用 userId 不含原始文件名，保留该实践。

生产加固（P0 一并做）：

- 登录/改密限速：Hono 中间件做 IP+email 维度的内存滑窗（如 10 次/分钟，单实例内存态即可，不引 Redis），bcrypt cost 保持 10。
- 安全响应头：Hono 中间件补 `X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy`、`Content-Security-Policy`（按现有前端实际外链收敛，先 report-only 一周再 enforce）；TLS 由 Caddy 终结，HSTS 在 Caddy 配。
- 附件下载鉴权：`/uploads/*` 当前在鉴权体系之外（`index.ts:38-55` 只防穿越）；外置附件改为 `/api/attachments/:id/download` 经 `requireCanView` 后发文件（短签名直链可作为后续优化，本期不做）。
- 审计最小集：登录成功/失败、权限变更、分享创建/删除、数据导出，结构化日志记录（不含密码/token 明文）。

### 5.3 支柱三：备份与灾难恢复

- **在线备份（每日）**：WAL 模式下禁止直接 cp db 文件；用 SQLite 在线一致性接口：
  - 首选 `sqlite3 app.db ".backup '/var/backups/gx/app-$(date +%F).db'"`（备份瞬时快照自动合并 WAL）；
  - 应用内等价实现：`better-sqlite3`（已锁定 13.0.3）的 `db.backup()` 封装一个 `pnpm backup:online` 脚本，避免客户机必须装 sqlite3 CLI。
- 保留策略：本地 7 份每日 + 4 份每周；备份完成后 rclone/rsync 推异地（客户 NAS/SMB/对象存储挂载点，地址由 env 配置），推送校验 sha256。【**⚠ 2026-09-12 调整（PLAN-ADJUST §3，92d0a34）**：异地推送为**预留扩展、默认不激活**——本地快照保留为内置基础能力，rclone/rsync 异地投递仅在显式配置 `GX_OFFSITE_TARGET` 等变量并启用 age 段时发生，当前产品不默认宣称具备异机/异地容灾。】
- **备份静态加密（异地强制，本地可配开关）**：异地备份产物在推送前用 **age**（单二进制、无配置、零系统依赖，符合本产品私有部署零依赖原则；Go 参考实现 filippo.io/age 与 Rust 实现 rage 格式互通）加密。配置项：
  - `BACKUP_ENCRYPT_OFFSITE=true`（**默认关闭：未设置或非 `true` 时仅做本地快照**；实现为严格 `process.env.BACKUP_ENCRYPT_OFFSITE === "true"`，见 `apps/api/scripts/backup/online-backup.mjs`）：仅显式置 `true` 才启用 age 异地加密投递——**属 2026-09-12 NAS 重定向后的预留接口、默认不激活**（见 `docs/planning/phase2/PLAN-ADJUST-nas-min-hardware.md` §3 / commit 92d0a34；ADR-0010 状态补充、ADR-0007 两层切分）。即：上面第 438 行"推送异地"与本节"异地强制加密"描述的是**已实现但默认不注册启用的可选扩展**，当前产品默认仅提供本地手动/升级前快照，备份 timer 也不随部署自动 enable，启动配置闸门不要求任何 age/offsite 变量。`BACKUP_ENCRYPT_LOCAL`（开关，默认 `false`）：本地 `/var/backups/gx` 是否一并加密，由客户按主机磁盘是否已加密（LUKS 等）决定。
  - **密钥模型选 age X25519 收件人/身份，而不是口令对称模式**，这是据工具事实做的刻意选择：age 的口令对称模式（`-p/--passphrase`，scrypt）固定从 `/dev/tty` 读口令、不提供非交互 env 注入，在 cron/systemd-timer 无 tty 环境下无法无人值守运行（接 stdin 会与备份数据流冲突，也不进官方自动化范式）。X25519 模式下**加密只用公钥收件人**（`age1...`，经 env `AGE_RECIPIENT` 注入或放部署主机 600 文件，泄露公钥不危及备份），**解密私钥身份（identity）永不落在生产/备份主机**，恢复时才由 env `AGE_IDENTITY_KEY`（私钥全文）注入写入临时 600 文件、用后即删——这比"对称口令存放在备份机"更严格地满足了"密钥不与备份同机存放"。
  - 命令形态（加密，每日无人值守，只需公钥）：`tar -C /var/backups/gx -czf - app-<date>.db uploads-<date>.tar | age -r "$AGE_RECIPIENT" -o offsite-<date>.tar.gz.age`。解密（恢复时，私钥经 env 注入，落 600 临时文件、trap 中 `shred -u`）：`install -m 600 <(printf '%s' "$AGE_IDENTITY_KEY") "$tmpid" && age -d -i "$tmpid" offsite-<date>.tar.gz.age | tar -xz -C <restore-dir>`。
  - **密钥托管纪律**：identity 私钥由部署者在初始化时 `age-keygen` 生成，私钥交客户离线保管（密码管理器/密封纸质/另一台机器），与异地备份物理分离；公钥可随部署包。丢失私钥=备份不可解密，初始化向导与恢复 runbook 必须显著提示，并建议把私钥备份纳入客户自己的密钥管理。
  - **恢复 runbook 含解密步骤**（与下方季度演练同步）：取异地 `.age` → 注入 identity 解密并校验 sha256 → 再走现有"还原 db + uploads → migrate deploy → 冒烟"流程。
  - 若客户坚持"单一共享口令"而非密钥对：明确告知 age 口令模式仅支持交互式（强制读 `/dev/tty`）、无法进每日无人值守 cron；可选项是 rage 的 pinentry/`PINENTRY_PROGRAM`（仍需额外 pinentry 组件，违背零依赖）或 passphrase 保护的 identity 文件（多一层口令、身份文件仍需落盘），架构侧不推荐、不作为默认。
- **附件一致性**：备份窗口内先 `.backup` 再快照 uploads 目录；附件路径内容寻址（sha256 文件名，§5.1）使部分丢失可被校验发现。恢复时以 db 内引用清单反查文件存在性，输出缺失报告。
- **恢复演练（强制，每季度一次）**：在隔离目录还原最近备份 → `prisma migrate deploy`（校验到最新）→ 起临时实例（换端口）→ 跑健康检查 + 20 条只读冒烟（沿用基线冒烟口径，`stability-baseline.md:57-61`）→ 抽查行数与附件可下载。**至少每半年一次必须用加密异地副本走完整解密恢复**（注入离线保管的 identity），不能只用本地明文备份走过场，否则等于没验证"异地 + 加密"这条真实灾备路径，也无法及早发现私钥丢失/不可用。演练结果写成一页记录入 `docs/runbooks/`。
- **崩溃恢复**：WAL 文件损坏场景的处置 runbook（保留 `-wal` 重启、`PRAGMA integrity_check`、必要时丢弃 wal 的后果告知），明确"丢未 checkpoint 的最后事务"的边界，禁止凭感觉删文件。
- 发布前快照：§4.4 已述，无快照不迁移。
- RPO 24h（可配置到 12h）；需要 RPO 分钟级的客户，文档给出 litestream 可选方案（外部开源组件，非默认安装，另立评估）。

### 5.4 支柱四：监控可观测性（轻量、零外部服务）

- **结构化日志**：引入 `pino`（唯一建议新增的运行时依赖，Node 生态标准、与 Hono 无耦合），替换 `hono/logger()`（`index.ts:26`）为请求日志中间件：method/path/status/耗时/请求 id/userId(已鉴权时)；启动横幅、审计事件同走 pino。stdout 输出由 systemd-journald 收存。**零依赖备选**：若评审拒绝新依赖，用 30 行 JSON 序列化中间件达到同样字段集，二选一在 P0 评审定。
- **健康检查分层**：现有 `/api/health`（`health.ts:9`，SELECT 1）保留为 liveness；新增 `/api/health/ready`：SELECT 1 + uploads 目录可写 + 磁盘剩余 > 阈值（如 1GB），供探活/告警。
- **慢查询与 P95**：中间件内直方图（prom-client 可选，不装也行）：内存维护 1 小时滚动桶，暴露 `/api/metrics`（P95/P99、状态码分布、写等待次数、BUSY 错误数）；阈值默认慢请求 800ms 记 warn 日志（对齐 R1 口径）。SQL 级慢查询：Prisma log event 开 `query` 计时（当前 `db.ts:20-24` 只开 warn/error），仅在 `GX_LOG_SLOW_MS` 配置时开启，避免生产全量 query 日志。
- **错误追踪**：未捕获异常在 `app.onError`（`index.ts:111-114`）统一打 error 日志含堆栈与请求 id；不默认接 SaaS Sentry（私有部署数据不出网原则）。有外网且客户同意时，文档给 GlitchTip（自托管 Sentry 兼容）endpoint 的可选配置。
- **业务告警最小集**（cron 脚本读 metrics/日志，邮件或 webhook 地址由 env 配置，不配置则静默）：ready 连续失败 3 次、P95 > 800ms 持续 15 分钟、磁盘剩余 < 10%、备份失败、连续 5xx 激增。
- **容量台账**：每日上报（日志即可）：db 文件大小、WAL 大小、每表活行数 Top20、attachments 总大小——§3.4 切换阈值的测量来源。

### 5.5 支柱五：CI/CD 与多端发布

- **先修 R6 工程化红灯**（基线前置条件，`stability-baseline.md:121`）：
  - web `test` 改 `vitest run --passWithNoTests`；
  - 删除或补齐 `test:e2e` 的不存在配置（`apps/api/package.json:13` 同源问题）；
  - 根 `lint` 要么落 ESLint 9 扁平配置（依赖已在根 devDeps，`package.json:32`），要么移除脚本，不许空转。
- **最小 CI（Gitee Go 或 GitHub Actions，按代码托管定，一个文件双平台注释）**：
  - 触发：push/PR；步骤：pnpm 9 `--frozen-lockfile` → `typecheck`（全工作区）→ `test`（56 shared + 214 api，基线数）→ api/web build → Playwright 冒烟（仅主干，复用基线冒烟用例）。
  - 不接远程缓存/私服，保持分钟级。
- **发布流水线（单机私有部署版）**：打 tag → CI 构建 api tarball（dist + prisma/migrations + package.json + 裁剪后 node_modules）、web dist、三端 Tauri 安装包 → 生成 checksums 与 Tauri updater 的 latest.json（签名）→ 入 release 目录/客户内网分发点。
- **部署脚本 `scripts/deploy.sh`（新增，幂等）**：停服健康检查 → 强制在线备份 → 解包新 release → `migrate deploy` → 切 symlink → 启动 → `/api/health/ready` 轮询 30 秒 → 失败自动提示回滚命令（一键切回旧 symlink）。
- **回滚**：应用回滚 symlink 30 秒；数据回滚仅按 §4.4 的快照流程；Tauri 端用户覆盖安装或应用内更新回滚（updater 不强制升级，保留旧安装包）。
- **版本纪律**：API 应答 version（`index.ts:79` 当前 0.2.0 与根 package.json 0.1.0 已不一致）统一从根 package.json 注入单一版本源，避免排障时版本混淆——顺手修，不单独立项。

---

## 6. 分阶段演进路线

| 阶段 | 周期(人) | 内容 | 改动面 | 风险 | 数据兼容/回滚 | 出口门 |
|---|---|---|---|---|---|---|
| **P0 生产基座** | 1-1.5 周 | R6 工程化红灯；最小 CI；`db:deploy`；config 启动闸门；systemd/Caddy/部署脚本与 runbook；在线备份+恢复演练；pino 日志+ready+慢请求；§5.2 安全加固与 R4 四项；版本单源；**Docker 可行性探针（§4.6，半天，只探测不安装，输出 ready/installable/unavailable）** | CI、部署脚本、env、中间件、auth/guards | 低：均为外围与收口，无数据模型变更 | 纯代码回滚；备份为新增 | 干净 CI 全绿；在一台干净内网机按裸机 runbook 从零部署成功并完成一次恢复演练；探针结论落部署清单 |
| **P1 容量核心** | 2 周 | 附件外置(R2)；hydration 批量化(A4)；keyset 分页(A1)+COUNT；写串行队列+乐观锁(A6)；前端服务端分页与虚拟滚动；**R3 字段约束存量扫描三选一；异地副本 + age 静态加密（§5.3，含加密副本恢复演练）；升级前快照/回滚** | recordService/hydrate 重写、records 路由、字段设置路由、备份脚本、web grid 数据通路、1 个新迁移(attachments+version) | 中高：动到 hydration 契约与列表主链路，是本方案最高回归风险点 | 纯新增表/列，旧代码可跑；按 §4.4 快照回滚；hydrate 21 个单测 + RC 用例全绿才合并 | 10 万行宽表默认列表 P95 < 300ms；列表查询数与行数解耦（日志验证 <= 固定条数）；214+56 单测与全量 RC 回归通过；加密异地副本可解密恢复 |
| **P2 索引与搜索** | 1.5-2 周 | FTS5 spike（第 1 天证伪/证实）→ A3 全局搜索；旁路索引表 A2；过滤/排序下推；SQL 聚合 A5；索引重建工具（字段设置变更触发）；**（探针通过且客户接受时）compose 三服务交付物可在此启动，§4.6，最晚 P3 收尾** | 新迁移(旁路表+FTS+触发器或写路径维护)、写路径、search 路由、（可选）compose | 中：写时双维护的一致性、FTS 引擎不确定性（有预案） | 旁路/FTS 为纯派生数据，可随时 truncate 重建，天然可回滚 | 100 万行：带索引筛选 P95 < 800ms、全局搜索 P95 < 500ms 且无截断；重建工具幂等；中文召回不劣于现状 |
| **P3 多端发布** | 1-1.5 周 | Tauri 远程客户端模式+CSP；updater 签名与 latest.json；三端打包出包；发布 checksums；客户分发 runbook；**compose 三服务可选交付物（仅 §4.6 探针 ready/installable 且客户接受时；含离线镜像 tar），否则全程裸机** | desktop 配置、引导页、发布脚本、（可选）compose | 中：打包签名证书、macOS 公证（企业开发者证书是否具备为外部依赖） | 客户端无数据回滚问题，覆盖安装 | 三端安装包在干净机器安装、连真实内网服务端通过冒烟；断网/自签证书场景有明确提示文案；（如交付）compose 离线机 60 分钟内起服务 |

合计约 5.5-7 人周（不含证书办理等外部等待）。P0 与 P1 之间可对外发布一次"可私有部署版"；P2 后达到百万行承诺；P3 后多端齐备。

> **M1（2026-09-13）落地勾选回填**：本表部分容量/索引项已在 Phase2 M1 切片提前实现，状态如下，详见 `docs/baseline/2026-09-13-m1-gate.md`：
> - **P1 已完成**：hydration 批量化(A4，两阶段 BFS 预取 + 写后单行回查)、keyset 分页(A1)+COUNT 下推、写串行队列(A6，S1 零 BUSY)；前端服务端分页/有界全量/计算字段置灰(S8)。**未在 M1 做**：records.version 乐观锁（M1 用写串行队列消除同进程写写竞争，不新增 version 列）、附件外置(R2，仍 dataURL)、虚拟滚动。
> - **P2 部分前置完成**：旁路索引表 A2（ADR-0004，S3/S4）、过滤/排序/COUNT 物理下推（S6/S7）、幂等重建工具（backfill/check-sidecar）均已落地并经 S10 证伪门（50 万物理命中 0.4–12ms 无 SCAN，**ADR-0008 本轮不触发**）。**仍在后续（M5）**：FTS5 全文检索 A3（ADR-0005 仅落占位，trigram 2 字中文不命中已实测）、SQL 聚合 A5、中文召回无截断。
> - P1 出口门的"10 万行首页 P95<300ms"物理层满足；端到端受应用 hydration 关联扇出影响（非物理索引问题），收口为 M1 后专项，100 万终验待固定 4C8G+SSD 压测机。
>
> **⚠ 2026-09-12 调整（见 PLAN-ADJUST，项目总监 92d0a34 决策）**：本条"100 万终验待固定 4C8G+SSD 压测机"**作废为放行前置**——验收改按 Tier-L（2C4G/慢盘）1k/1万/10万小规模基线（无 SCAN + 内存有界 + 零 BUSY + 可回退）；百万行为可选参考画像，T1 迁库阈值已硬件无关改写（见 §3.4 批注与 ADR-0008 §10）。备份姿态：**本地在线快照为内置基础能力（手动/升级前默认提供，每日 timer 不自动 enable）；异地 age 加密容灾为接口预留、默认关、不占里程碑工期**（PLAN-ADJUST §3，ADR-0007/0010）。

### 6.1 阶段编号与 PM 里程碑对照（同一交付序列，两套编号）

本文用 P0-P3（按技术依赖与回归风险排序），PRD 用 M1-M4（按双周迭代的对外叙事）。**两套编号指向同一交付序列，不是两份计划**；执行排期以本节映射为准，避免"P 做了 M 没做"式错位。差异来源：技术视角把"安全/备份"前提（P0）排在"容量重写"（P1）之前以先有回滚安全网，而 PRD 把容量地基放进 M1、安全备份放进 M2。落地时按双周节奏切分，下列映射已把两边内容对齐。

| 架构阶段 | 对应 PM 里程碑 | 内容对应（PRD 需求 ID） |
|---|---|---|
| **P0 生产基座** | ≈ M1 质量门 + 部分 M2（安全/备份的安全网部分） | E1 CI 质量门 + R6 清理（M1）；A4 慢请求日志、D1 健康端点拆分（M1）；B1 限速、B2 安全头/HTTPS、B3 JWT 治理（M2 提前，作为动数据链路前的安全网）；C1 在线一致性备份、C2 调度保留、C3 恢复演练（M2 提前，重写前先有备份兜底）；db:deploy/migrate deploy + config 闸门 + 版本单源；**Docker 可行性探针（§4.6，半天，结论决定 compose 去留）** |
| **P1 容量核心** | ≈ M1 容量核心 + M2 附件外置 | A1 keyset 分页+COUNT、A4 已在 P0；hydration 批量化、写串行队列+乐观锁（A7/A6）、前端服务端分页与虚拟滚动（A6）；**A3 附件外置含存量迁移（M2）**；**C4 异地副本 + age 静态加密（M2/M3，加密与异地同期）**；C5 升级前快照/回滚；**R3 字段约束存量扫描三选一（本期补的基线缺口，与数据链路改造同期）**；B5 上传魔数、B6 审计等 M2 余项 |
| **P2 索引与搜索** | 介于 M2 末与 M3 之间（PRD 未单列，A5 过滤下推在 PRD 标 P1，并入技术序列的索引阶段） | A5 过滤/排序下推、旁路索引表、FTS5 全文检索、SQL 聚合、索引重建工具；A2 容量压测在 P0/P1 已做档位、P2 做百万行终验；**Docker 探针通过且客户接受时，在此阶段补 compose 三服务交付物（§4.6）** |
| **P3 多端发布** | ≈ M4 多端 + M3 部署包收口 | E6 Tauri 远程客户端+CSP+updater 签名+三端打包（M4）；E4 chunk 分包、E5 版本化发布（M4）；compose 若延后至此收尾则在此完成离线 tar 与分发 runbook；整机损毁灾备终验（M4） |

对照口径补充：

- PRD 的 **M3（私有化部署包 + 可观测性）** 被拆开吸收：可观测性 D2 结构化日志落在 P0、D3/D4 指标告警落 P1（与 §5.4 分期一致）；部署包的**裸机主线**随 P0 的 runbook/部署脚本即成立，**compose 可选包**按探针结论落 P2/P3——这正是"裸机优先、compose 可选非默认"双轨裁决在里程碑上的体现。
- PRD 的 **A2 百万行压测**：P0/P1 用 1 万/10 万档驱动重写与回归，100 万终验在 P2（对应 M4 终验复测），证伪切 PG 的决策点（PRD M1 末、本文 §3.4）以阈值表为准，两套编号均指向同一硬门。
  - **⚠ 2026-09-12 调整（见 PLAN-ADJUST §2.2/§5，项目总监 92d0a34 决策）**：100 万终验不再是 P2/M4 的硬门——常规回归只跑 1k/1万/10万；50万/100万为可得硬件上的可选参考画像（标注机型/盘型/冷热）。切 PG 决策点改按硬件无关 T1（真实目标机 + 真实负载 + 持续症状 + 应用手段穷尽），T2/T3/T4/T5 仍以阈值表为准。
- 排期若与双周不完全对齐，以"P0 出口门（干净 CI + 裸机从零部署 + 恢复演练成功）达成"作为进入 P1 的硬前提，该门等价于 PRD M1+部分 M2 的合并出口。

### 新增 ADR 清单（按立项时落盘，MADR 格式，存 docs/decisions 或沿用 docs/adr/）

| 编号 | 标题 | 阶段 |
|---|---|---|
| ADR-0003 | 私有部署参考拓扑：Caddy + systemd 单实例 + WAL 单写者约束 | P0 |
| ADR-0004 | 动态字段模型的旁路索引表（EAV sidecar）与写时维护 | P2（立项不晚于 P1 末）。**[M1 已落盘 Accepted 2026-09-13，`docs/adr/0004-eav-sidecar-index.md`；S3/S4/S6/S7 实现，S10 实测物理层 50 万行 0.4–12ms 无 SCAN]** |
| ADR-0005 | FTS5 全文检索与中文子串召回策略（含 better-sqlite3 预案） | P2。**[M1 落占位 2026-09-13，`docs/adr/0005-fulltext-search.md`：实测 trigram 对 2 字中文不命中、≥3 字命中（SQLite 3.53.4），M1 不建主库 FTS，正式方案随 M5]** |
| ADR-0006 | 附件外置：attachments 表 + 内容寻址文件存储 | P1 |
| ADR-0007 | SQLite 在线备份、保留策略与季度恢复演练制度 | P0 |
| ADR-0008（预留，不写） | 迁移 PostgreSQL 的决策 | 仅 §3.4 阈值触发时立项（编号在早期方案已预留引用，故保留 0008 槽位） |
| ADR-0009 | 部署双轨：裸机 systemd 默认 + Docker Compose 可选（可行性探针门控，compose 非默认） | P0 探针 / P2-P3 交付 |
| ADR-0010 | 异地备份静态加密：age X25519 收件人加密、解密身份与备份机分离（不用口令对称模式） | P1 |

---

## 7. 风险登记（本方案新增/残余）

| 风险 | 等级 | 缓解 |
|---|---|---|
| P1 重写 hydration/列表主链路引入静默数据错误 | 高 | 保持 QueryResult/HydrateDeps 契约不变；21 个 hydrate 单测 + 12 个 filter 单测 + RC 回归集全绿门；批量预取与逐行递归在同一测试夹具下结果对拍 |
| Prisma 内置 SQLite 不支持 FTS5 | 中 | P2 第一天 spike；better-sqlite3 13.0.3 已在依赖锁定中，预案不引新组件 |
| 旁路表写时维护与 JSON 真相源不一致 | 中 | 同事务维护；提供"全量重建"工具并在字段变更后自动调用；启动自检计数差异报警；旁路表永远是可重建的派生数据 |
| 单实例 = 单点故障 | 中（形态性） | 私有部署可接受；靠每日备份 + 30 秒应用回滚 + 1h RTO 控制；systemd 自动拉起；主机级冗余（UPS/磁盘）写入部署手册 |
| 写串行队列在峰值写下降损交互延迟 | 低中 | 内网 10-20 写 QPS 下每事务毫秒级，队列深度可观测（metrics）；阈值触顶即为 §3.4 迁 PG 信号之一 |
| macOS 公证/Windows 签名证书不具备 | 外部依赖 | P3 启动前确认；无证书时先出未签名包 + 客户侧白名单指引，不阻塞 Web 与 Linux 发布 |
| 计算字段无法 SQL 下推，超大表按公式排序仍慢 | 已知限制 | **已决（2026-09-12）**：计算字段排序/筛选走"禁用并提示"，不做异步全量预计算（§2.3）；物理字段才进旁路索引，边界清晰 |
| 目标客户机无法装 Docker（探针 docker-unavailable） | 低（双轨已对冲） | P0 探针早发现；裸机 systemd 为默认主线且必须独立完整可用，compose 仅在 ready/installable 且客户接受时投入，不产生沉没成本 |
| age 解密身份私钥丢失导致异地备份不可解密 | 中（运维流程） | 私钥交客户离线保管、初始化向导显著提示；季度演练强制走加密异地副本解密以尽早暴露密钥不可用；公钥可随包、私钥不入机 |
| R3 存量扫描在百万行字段上耗时 | 低中 | 只读异步任务 + 进度反馈；唯一字段优先走旁路表/索引聚合；扫描不阻塞表的正常使用，结果为临时报告不建重业务表 |

---

## 8. Out of Scope（Phase 1 明确不做）

- PostgreSQL 实施（保留通道，阈值驱动，§3.4）。
- 实时多人协作 / CRDT / WebSocket 增量推送（ADR-0001 的 P3 以后事项）。
- 多实例、K8s 容器编排、读写副本、分钟级 PITR（litestream 仅作文档可选项）。**Docker Compose 不是 Out-of-scope，但为可选、非默认**：裸机 systemd 是默认主线，compose 仅在 §4.6 可行性探针通过且客户接受容器形态时作为 P2/P3 可选交付，不投入镜像仓库/编排平台等额外基础设施。
- 计算字段（formula/lookup/rollup/count）的 SQL 化下推，以及超大表计算字段的异步全量预计算/物化（已决走"禁用并提示"，§2.3）。
- SaaS 化计费、租户隔离、OIDC/SSO（JWT 体系仅做 tokenVersion 与密钥轮换收口）。
- 移动端 Capacitor 打包（ADR-0001 排在桌面壳之后）。
- 向量检索/AI 语义搜索等新能力。

## 9. 悬而未决（需项目总监/PM 决策或外部确认）

1. **FTS5 spike 结论**（P2 第 1 天，技术自证，不需业务决策）。
2. **代码托管与 CI 平台**：Gitee 私有仓 PAT 是否已就绪（基线前提条件 1 未完成项，`stability-baseline.md:119`），决定 CI 配置文件平台。
3. **桌面端签名证书**：Apple Developer（含公证）与 Windows 代码签名证书的有无，决定 P3 交付形态（§7）。
4. **客户环境基线与 Docker 可用性**：目标客户主机是否统一 Linux + systemd；是否允许/可安装 Docker（§4.6 探针在 P0 给出 ready/installable/unavailable 事实，但"客户是否接受容器形态"仍需主理人/客户确认）；若大量 Windows Server 客户，需补 Windows 服务（nssm/任务计划）与 Win 版备份脚本，P0 工作量增加约 3 人日。
5. **附件大小与配额策略**：单文件/每记录/每 base 的上限数值（现过渡值 2MB/个、20/格），外置后建议单文件 50MB、可配置，需 PM 确认。
6. **备份异地通道**：客户提供 NAS/SMB 还是公网对象存储（影响 rclone 配置文档与数据出网合规口径）。

> 已决移出清单：~~计算字段排序/筛选的产品交互~~（2026-09-12 定为"禁用并提示"，不做异步全量计算，见 §2.3/§7）；~~Docker Compose 是否交付~~（2026-09-12 裁决为裸机主线 + compose 可选非默认、探针门控，见 §4.6）。
