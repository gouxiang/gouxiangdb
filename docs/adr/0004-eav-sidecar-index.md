# ADR-0004：动态字段的 EAV 旁路索引（record_field_index）与写时同事务维护

**状态（Status）**：Accepted（M1 落地：S3 迁移 / S4 写维护与回填 / S6 读下推 / S7 keyset，2026-09-13）
**作者**：后端（mvp-dev-expert-team-backend）
**编号来源**：生产化架构 §6「新增 ADR 清单」预留 0004「动态字段模型的旁路索引表（EAV sidecar）与写时维护」。

---

## 背景（Background）

业务记录的可变字段值是 `records.fields` 里的一个 JSON 字符串（字段定义在 `fields` 表，
可由用户任意增删、类型多达 20 余种）。M1 之前的列表读路径把整表活记录 `findMany`
拉进内存再做 filter/sort/group/聚合（`recordService.queryRecords`），并以内存
`slice(offset, offset+limit)` 假分页。单表过万行后，延迟随行数近线性增长，
深翻页与物理字段筛选没有任何数据库索引可用（见 M1 基线与 S10 报告）。

给 JSON 动态 key 建索引有三条现成路线：

1. **SQLite JSON1 表达式索引**（`CREATE INDEX ... ON records(json_extract(fields,$.fld))`）：
   字段是运行期数据而非 schema，每个字段一条 DDL，字段增删要同步建/删索引，
   多值字段（multiSelect）无法用单列表达式表达，且 PostgreSQL 侧要改写成
   JSONB + GIN/生成列，方言不对齐。
2. **正排宽表**（每个字段一列、ALTER TABLE 加列）：与"字段是用户数据"的产品形态冲突，
   单表字段数上限、锁表加列、跨库方言都是长期负担。
3. **EAV 旁路表**（一条记录的一个被索引字段摊平成一行，标量入双类型列）：字段增删不触 DDL，
   multiSelect 天然摊多行，谓词是普通参数化 SQL，两库（SQLite/PostgreSQL）同构。

架构 §3.1 A2 选定路线 3。本 ADR 固化其最终落地形态与边界。

## 决策（Decision）

新增一张**派生、可重建**的 EAV 旁路表 `record_field_index`，作为 `records.fields`
JSON 的冗余索引；它不承载任何真相，任何时刻都可由 fields JSON 全量重建。

### D1. 普通 rowid 表，不用 WITHOUT ROWID（保 PostgreSQL 通道）

迁移 `20260913062000_record_field_index_sidecar/migration.sql`：

- `INTEGER PRIMARY KEY AUTOINCREMENT` 普通表，**刻意不用** SQLite 专有的
  `WITHOUT ROWID` 与蛇形列名；列名用与 Prisma 现状一致的引号驼峰名
  （`"recordId"` 等），标准 SQL 类型。这样 ADR-0008 若真触发，DDL 可平移到
  PostgreSQL（只需换占位符风格，`REAL`→`DOUBLE PRECISION` 属机械改写）。
- 该表**不进 schema.prisma**：不加 Prisma model，避免 migrate 试图管理/漂移它；
  完全由手写迁移建表、应用层 raw SQL（`domain/fieldIndex/sync.ts`）维护。
  Prisma 对它是"看不见的表"，只通过 `$executeRawUnsafe` 访问。
- 迁移只建空表与索引，**不在迁移里回填**，避免大表迁移期长时间锁库；
  回填由独立幂等脚本在低峰执行（D4）。

### D2. 只索引物理标量，计算字段与关联字段永不物化

哪些字段入索引由纯函数 `domain/fieldIndex/policy.ts` 的 `isIndexedField` 单一事实源决定
（sync 写维护、backfill 回填、check 巡检三处共用同一口径）：

- 入索引：短文本组（singleLineText/email/url/phone/autoNumber）、数值组
  （number/currency/percent/duration/rating）、date/datetime、checkbox、
  singleSelect/multiSelect（存 optionId，multiSelect 摊平为多行，`ord`=选项序号）、
  以及**主字段**（即便物理类型是 longText 也按文本等值/排序入索引）。
- 不索引：longText/richText/json 正文（主字段除外）、attachment、
  links/subtable、lookup/rollup/count/formula 等计算字段、tabs、
  createdTime/lastModifiedTime/createdBy/lastModifiedBy 等系统字段。
  这些值要么不来自本行 JSON、要么体量大、要么是应用层算出的派生物——
  给它们建第二套派生数据会制造写时一致性负担（架构 §2.3 已明确不做异步预计算）。

值的抽取（`extractEntries`）与 shared-types 的过滤归一保持同一口径：
日期用 `Date.parse` 得毫秒、严格日期形态才解析；数字有限才入数值列；
checkbox JSON boolean→0/1。标量字段恒一行（`ord=0`），空值写
`valueText/valueNum=NULL, isNull=1` 形成显式 NULL 桶（支撑 isEmpty/isNotEmpty）。

### D3. 双类型列 + 三个索引，覆盖下推热路径

列：`valueText TEXT`、`valueNum REAL`、`isNull INT`、`ord INT`。文本等值/排序/
选项命中走 `valueText`，数字/日期/勾选走 `valueNum`。索引：

- 唯一键 `(recordId, fieldId, ord)`：保证一条记录同一字段同一摊平序号最多一行，
  支撑"先删后插"的幂等维护。
- `rfi_table_field_num (tableId, fieldId, valueNum)` 与
  `rfi_table_field_text (tableId, fieldId, valueText)`：S6 物理谓词下推的
  `WHERE tableId=? AND fieldId=? AND value…`。
- `rfi_table_record (tableId, recordId)`：按记录/表批量删插与巡检 join。
- 另给主表加 `records (tableId, deletedAt, createdAt, id)` 复合索引
  `records_table_live_created_id`：默认列表热路径等值过滤活记录后覆盖
  `(createdAt,id)` 排序，避免 filesort。

### D4. 写时同事务维护；强一致、不吞错、可整体回滚

`syncRecordsTx` / `deleteRecordsTx` / `restoreRecordsTx` / 批语句形态
（`deleteRecordsStatement`/`deleteTableStatement`）在**调用方已开启的交互事务内**
执行，放在 record JSON 写之后、提交之前；函数自身绝不自开事务、不入写队列
（S1 事务回调内再入队会自死锁）。

- record JSON 与 sidecar 同生共死：维护抛错随所在事务整体回滚，
  **不做 try/catch 静默降级**——静默会制造 check 抓不到的隐蔽 drift。
- 维护是"只写不读业务结果"：S6 之前没有任何读路径查它；linkRow 变化不进 sidecar。
- 幂等：先按 recordId 删旧、再按最新 fields 批量插新（每批 200 行，限占位符数）；
  软删撤行，物理删由 FK `ON DELETE CASCADE` 兜底。
- 重建：`scripts/bench/backfill-sidecar.ts` 逐表 id 游标分批、批内先删后插，
  不开跨全表大事务（避免百万行锁库），中断重跑仍收敛；
  `check-sidecar.ts` 只读对拍缺失/多余/值不一致/孤儿，drift=0 才退出 0。

### D5. 读路径经 query plan 灰度，物理算符不齐即回退内存

sidecar 只解决"物理标量的 WHERE/ORDER BY/COUNT 能走索引"。S6 的 query planner
对每个过滤/排序节点判断能否下推：命中 `isIndexedPlanField` 白名单且算符语义可对齐
才生成物理叶子，否则整体退回 S5 的全表 hydrate + 内存计算（characterization
已锁定该现状语义），**绝不半下推导致结果与内存语义不一致**。读路径默认保守，
由 flag 灰度（见下"flag 与回退"）。

## 后果（Consequences）

正面：

- **物理层在 50 万行实测健康**（S10，2026-09-13，本机 M5/16GB，SQLite 3.53.4，
  详见 `docs/baseline/2026-09-13-m1-s10-gate.md` §2）：带过滤命中场景
  0.4–12ms（home keyset 0.386ms、单选等值 1.133ms、金额范围 1.231ms、过滤后
  COUNT 12.153ms），`EXPLAIN QUERY PLAN` 全部走
  `records_table_live_created_id` / `rfi_table_field_num` /
  `rfi_table_field_text` / `rfi_table_record` 索引，零全表 SCAN。
- 字段增删不触 DDL；写维护集中在 policy 单一事实源，三路口径一致；
  sidecar drift 由 check 脚本可机器验收，S4/S9 多档实测 drift=0。
- 纯派生、可随时 truncate 重建，事故恢复成本低；读路径 flag off 时 sidecar
  闲置无害，事后 backfill 即可追平。
- 表结构方言中性，ADR-0008 迁 PostgreSQL 不需要重写模型。

负面/约束：

- **写放大**：一条记录的每个被索引字段在 sidecar 占一行，且每次写先删后插。
  宽表（17 物理字段）50 万行产生约 1,078 万 sidecar 行、库 4.24GB——
  存储成本是明确的代价，靠"只收物理标量"控制膨胀，不索引正文/关联/计算字段。
- sidecar 不加速**全文子串**（那是 M5 FTS 的职责，见 ADR-0005）与**计算字段**
  （应用层 hydration）。S10 证实大表端到端剩余瓶颈在应用 hydration 关联扇出/N+1，
  不在物理索引层；该项由后续"hydration 关联扇出收口"处理，不构成本 ADR 的失败，
  也不是 ADR-0008 的触发条件。
- 读下推依赖算符白名单与内存语义严格对齐，新增物理类型/算符必须同步
  policy、planner 与类型一致性守卫测试，否则会静默走错路径。

## flag 与回退（M1 内不删旧路径）

| flag | 默认 | 作用 |
|---|---|---|
| `GX_M1_SIDECAR` | on（≠off 即开） | 写维护总开关；=off 旁路所有同事务维护，派生表闲置 |
| `GX_M1_SIDECAR_READ` | off（off/shadow/on） | 读下推；shadow 只对拍记日志不改响应，on 才走 planner |
| `GX_M1_KEYSET` | off（off/shadow/on） | keyset 分页，仅在 read=on 时可能对外生效 |

一键回退到 M0 行为：三个读/分页 flag 置 off（写侧可保留 on，闲置表无害）。
flag 生命周期（shadow→on 时间表、稳定一迭代后删旧路径的条件）见
`docs/baseline/2026-09-13-m1-gate.md` §flag 生命周期；M1 内不删旧路径与 flag。

## 相关（Related）

- [ADR-0002](0002-database-sqlite.md)：SQLite 基线、手写迁移与 raw SQL 纪律
- [ADR-0005](0005-fulltext-search.md)：全文检索边界（占位）；sidecar 不管子串召回
- ADR-0008（预留不写）：迁 PostgreSQL 的客观阈值；本 ADR 的方言中性为其留通道；
  S10 已据客观条件判定本轮不触发
- 迁移：`apps/api/prisma/migrations/20260913062000_record_field_index_sidecar/migration.sql`
- 策略/维护：`apps/api/src/domain/fieldIndex/{policy,sync}.ts`
- 读下推：`apps/api/src/domain/queryPlan/*`（flags/planner/compile/sidecarQuery）
- 重建/巡检：`apps/api/scripts/bench/{backfill-sidecar,check-sidecar}.ts`
- 实测：`docs/baseline/2026-09-13-m1-s10-gate.md`（物理层 EXPLAIN 与 ADR-0008 判定）
