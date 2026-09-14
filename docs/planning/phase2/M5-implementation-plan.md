# M5 向量库与统一检索 — 可执行实施切片（设计与现状核对，不改业务码）

- 日期：2026-09-18
- 作者：架构师 高见远
- 状态：**待项目总监终审**（§11 待裁决清单未关闭前不得派工实施）
- 上游依据：SPEC-enterprise-v1.0 §5（`:75` `GET /api/v1/search`、`:76` `POST /api/v1/admin/reindex`）、§6（`:87` 主库仅 outbox/change_events、search.db 独立可 truncate 不进备份）、§7（embedding/检索设置页）、AC-M5-1（`:123` 崩溃自动降级 FTS-only/reindex 幂等）、AC-M5-2（`:124` 召回前剔除无权内容、不索引字段物理缺席）；PRD-enterprise V1-V6（`:169-177`：V2 异步向量化不阻主链路、V4 先收敛后召回 P95<500ms、V5 索引治理）、M5 出口验收（`:270-273`）；ARCH-enterprise §7.1-7.7（`:615-745` outbox/embedding/vec0/FTS5/RRF/即弃原则）；**硬约束来源：两份已入库 spike——`spike-sqlite-vec.md`（2026-09-14，实测）、`spike-mcp-transport.md`（M6 用，仅引用其审计/PAT 无关项，不引依赖）**
- 适用代码基线：`main` @ `1ad0836`（M4 切片文档 r2 已入库；代码 HEAD 为 6f7dc29 + 工作区在途 M2-S4 文件未提交）；根 package.json v0.1.0
- 测试基线（项目总监给定，本文不重跑）：api **56 文件 678 passed / 3 skipped**（M2-S3，6f7dc29）；迁移目录 **14 个**；M3 后预期 17（nav DDL/回填 + manage_menu 补位），M4 后预期 19（回填 + manage_share 补位，索引补强可能 20）。**M5 第一个数据迁移（change_events）编号排在 M4 全部迁移之后**
- 本机核对环境：Node v22.22.2、pnpm 9、Prisma 5.22、better-sqlite3 13.0.3（dependency，已在 `apps/api/package.json:28`）、Hono 4.13.5、React 18 / TanStack Query 5.62；**当前无 sqlite-vec 依赖（S2 新增 `sqlite-vec@0.1.9`，版本锁定理由见 §4.2）**

> **硬依赖声明（排期：M5 实施在 M4 收口之后，后端单线 M2→M3→M4→M5）**：M5 检索链路依赖 **M3-S1（nav_nodes 建表与回填）** 与 **M4-S4（`domain/authz/scope.ts` 的 resolveVisibleNodeIds/buildVisibleScopeSql 契约冻结）+ M4-S1（engine.decide 可供出参前二次校验）** 落地；outbox 接线（S1）只依赖在库实体表，技术上可提前，但按裁决单线纪律**未获派工不得开工**。本计划引用的 M4 接口签名以 M4 切片 §4.7（1ad0836 版）为准，开工逐点复核，**M5 不得改 M4/M3/M2 的文件**（唯一例外：M3/M4 已登记的写点同事务追加 outbox 行，见 §5.2，触碰在切片 PR 单列）。所有"现状证据"行号均于 2026-09-18 在 6f7dc29 工作区实读。本阶段只产出规划文档，不改任何 .ts 源码。

---

## 0. 结论先行

1. **形态定稿：主库 `change_events` outbox（Prisma/手写迁移，同事务）+ 独立 `search.db`（裸 better-sqlite3 连接，不经 Prisma、不 ATTACH），同进程单例 worker 异步消化**。主写事务只多一行 outbox INSERT，embedding/FTS/vec0 全部异步，主链路零等待（PRD V2、ARCH §7.1）。search.db 物理独立、可整文件删除重建、不进业务备份（现有备份脚本只备 DATABASE_URL 单文件，已核实 `scripts/backup/online-backup.mjs:139-153`，§1.6 证据）。
2. **spike 硬事实全部落为工程约束（不可重新讨论，实测来源 spike-sqlite-vec §0 五事实）**：① better-sqlite3@13 直接 `db.loadExtension()`，无编译开关；② vec0 虚表**所有整数列（rowid、integer metadata）必须 BigInt 绑定**，number 被绑成 REAL 致整批事务回滚；向量用 Float32 BLOB；③ KNN 必须带 `LIMIT`/`k=?`，vec0 无 ANN、暴力扫描、`EXPLAIN` 恒为 SCAN，延迟随 chunk 数近线性；④ 平台 .so 仅 glibc（linux-x64≤GLIBC_2.14 / arm64≤2.17），**无 musl/Alpine 版**，文件名必须恒为 `vec0.so`（入口符号按文件名推导，改名即加载失败）；⑤ 加载失败是**可捕获异常不 crash**，系统正常启动并降级 FTS5+LIKE。
3. **Embedding 仅 `cloud` / `off` 两态，`GX_EMBEDDING_MODE` 默认 `off`（不出域默认关，无本地模型/无权重文件/无 Worker Thread 推理）**——推翻 ARCH §7.2 的 local 三模式（spike §6.2 已按最新裁决收敛）。off：检索=FTS5 trigram + 短词 LIKE，开箱零外网零 key；cloud：OpenAI 兼容 `/v1/embeddings`，配置齐全且探活通过才启用向量路，任一不满足或连续失败自动回落 off 行为。维度一旦建表即固定，改 model/维度必须全量 reindex。
4. **零泄漏的工程定义（AC-M5-2）= "先收敛、后召回"，禁止"先全量召回再应用层过滤"**：检索时先用 **M4 冻结的 scope 接口**（M4 §4.7 resolveVisibleNodeIds/buildVisibleScopeSql）实时算出当前主体可见 nodeId 集，物化为 search.db 会话临时表（`temp_scope`），FTS 路 JOIN 临时表、vec 路以 metadata 分区列 + 白名单收敛（spike 遗留首日验证项：vec0 KNN 对 `rowid IN (子查询)` 的确切行为，S5 第一件事）；融合出参前再逐实体过一次 `engine.decide(user,node,'r')` 纵深防御；**无权 id 不进入任何一路召回，不可能占满 top-k**。
5. **权限变更无需索引失效机制**：索引内容只与实体文本有关、不含任何主体授权信息（不做 per-user 索引）；scope 每查询实时计算（M4 决策不做跨请求缓存），调岗/收权/继承变更（policyVersion/navVersion bump）后**下一次检索**即新可见集。版本号仅用于响应回传与前端缓存失效，不参与 worker 索引（§4.7）。
6. **FTS5 trigram + 短词 LIKE 回退 + 应用层 RRF 融合**：≥3 码元（CJK 3 字/拉丁 3 字符）走 trigram MATCH（实测中文 2 字词命中 0，spike §3），<3 走参数化 LIKE；FTS 与 vec 各取 top-N（默认 100），RRF `score=Σ 1/(60+rank)`，标题精确命中加性 boost，同实体多 chunk 取最高分聚合后 top20；响应带 `mode:"hybrid"|"fts"|"like"` 让前端展示降级状态。
7. **性能门分级，不拿开发机数字冒充 NAS 承诺**：spike 在 Apple M5/16GB 实测 100k×1536 维 KNN p95≈113ms、库文件 592MB（非 NAS，仅参考）；**10 万 chunk 混合检索 P95<500ms 只在 Tier-L 真机（2C4G ext4 本地盘，x86 与 arm 各一）验证后才允许写入对外承诺**；Tier-S 入门 NAS 的流畅基线定义为 **1 万-10 万 chunk 区间检索流畅（P95<500ms）+ 索引任务不饿死主写**，不达标先降维（512/768，MRL）/收紧 scope/控制 k，阈值沿用 ARCH §7.3：chunk>50 万或真机 P95 持续>500ms 立项评估 LanceDB（EmbeddingProvider/indexer 接口不变）。
8. **切片 S0-S11 共 12 片**：S0 旧检索 characterization → S1 主库 change_events 迁移 + 同事务 outbox 接线 → S2 SearchStore/search.db/vec0 加载降级 + 原生打包 → S3 EmbeddingProvider(off/cloud) + 配置契约 → S4 indexer worker（FTS/向量/退避/删除）→ S5 searchService 先收敛后召回 + RRF + `GET /api/v1/search` → S6 字段 mask 摘要剔除（接 M4 A-4 口径）→ S7 reindex + admin 状态端点 + openapi 冻结 → S8 权限/继承变更失效对抗 → S9 崩溃降级 AC-M5-1 全链路 → S10 规模与真机门 → S11 出口收口。**前端设置页（cloud/off 配置 UI）与搜索结果 UI 是独立 M5-FE 片，本文只给后端契约（输入清单 §8）。**
9. **搜索端点版本化**：新检索走 **`GET /api/v1/search`**（SPEC :75，挂 M2 v1 鉴权链 requireActiveUser）；旧 `/api/search/`（search.ts 160 行，成员循环+有界预览）M5 不动、不重写，保留至旧 /api 统一下线切片；前端切新端点在 M5-FE。回滚 = v1 路由摘除/flag off，旧端点字节不变。
10. **新增运行时依赖仅 `sqlite-vec@0.1.9`（可选平台子包，零 JS 传递依赖）**；不引入任何分词器/中文词库/Jieba/ORM；OpenAI 兼容 HTTP 调用用 Node 22 全局 `fetch` + AbortController，不引 SDK。

---

## 1. 现状证据（行号已核对，2026-09-18 于 6f7dc29 工作区实读）

### 1.1 旧检索（S0 要锁的现状，M5 不重写该文件）

| 事实 | 证据（已核对） |
|---|---|
| 全局搜索单文件、成员循环 + 有界内存预览 | `routes/search.ts:47-160`：records 支路遍历 `prisma.member.findMany`（:58-61）→ 每 base 每表 findMany fields（:72）→ 每表仅取 `SEARCH_PREVIEW_LIMIT` 条记录（:79-83，ADR-0005 有界预览注释 :77-78）→ 内存 `includes`（:96）；docs 支路遍历 kbMembers（:122-125）→ Prisma `contains` 查 title/searchText（:128-137） |
| 响应形状 | `{records: RecordHit[], docs: DocHit[], ...boundedPreviewMarker}`（:156）；RecordHit 字段 :27-37（type/baseId/baseName/tableId/tableName/recordId/title/snippet/matchedField），DocHit :38-45；空 q 直接 `{records:[],docs:[]}`（:51） |
| 计算字段不入搜索的现有纪律 | `isComputedFieldType` 过滤（search.ts:76）；记录主标题取 primaryFieldId 值（:86-87） |
| 旧搜索不读 nav/策略 | grep 确认 search.ts 无 auth_policies/nav_nodes 引用；这是 AC-M5-2 必须由 v1 新链路封口的原因（M4 已显式把全局检索划归 M5，M4 §2.2） |
| kb 库内限定搜索 | `routes/kb.ts:303` 同 Prisma `contains` 口径（`GET /api/kb/:kbId/docs?q=`）；M5 v1 全局检索上线后该端点保留不动 |

### 1.2 可复用的索引文本来源（不重新发明）

| 事实 | 证据 |
|---|---|
| Markdown 去标记纯文本 | `domain/kb.ts:7-21` `markdownToSearchText`（代码块/链接/标题/列表标记全剥） |
| 画布 JSON 文本提取 | `domain/kb.ts:28-57` `canvasToSearchText`（递归 text/label/content/title/name 五键，深度 12、2000 值、输出截 50k）；`buildSearchText(kind,content)` :60-62 |
| 文档写时已冗余 searchText | KbDoc.searchText 列（schema.prisma:303）；写点：`kb.ts:418-421`（PUT content）、`:720`；公开匿名写 `public.ts:270-273`；建文档初值 `kb.ts:347`；版本快照同存（KbDocVersion.searchText，schema.prisma:340） |
| 记录字段值 | records.fields JSON（schema.prisma:124）；LinkRef 标题拼接规则在 search.ts:93-95 已有旧实现可参照（数组取对象 title） |
| chunk 粒度依据 | ARCH §7.5 表（:717-721）：记录一期 1 chunk/记录（标题+非计算字段文本）、文档按 h1-h3 粗切 300-512 字 overlap64、画布每含文本元素 1 chunk（需把 canvasToSearchText 从全板一串改为按元素遍历，S4 做，保留 gxNote） |

### 1.3 主写事务点（outbox 同事务插入位置，§5.2 全量清单）

| 内容族 | 写点（已核对） |
|---|---|
| 记录 | create `records.ts:417-425`（withWriteTx 内 tx.record.create）；patch `:632-635`；批量 update `:743`、`:804`；软删 `:689`（update deletedAt）；恢复 `:1036`；子表/行创建 `:915`；**注意一处裸写：:206 `db.record.update`（await db. 旧门面，S1 接线时归类）** |
| 文档/画布 | PUT content `kb.ts:403-441`（updateMany 条件更新 :425 或 update :437，当前裸 Prisma 未包 withWriteTx——S1 按 M3 纪律最小包裹或用同连接事务，行为等价收紧）；建文档 :347 区；匿名公开写 `public.ts:270-273`（ANON 身份也发 outbox，实体存在即索引）；物理删文档 `kb.ts:634` 区（deleteMany + 清 acl） |
| 表结构/表删 | M3 nav sync 已接管 18 个实体写点；**实体物理删除导致的索引删除事件以 M3 purge 语义为准**（软删发 delete、purge 发 delete），S1 只补"文本变更"事件，删除/恢复事件尽量挂在 M3 sync 同事务的既有回调点（若 M3 已建 domain/nav/sync.ts，S1 在其 *Tx 原语旁挂 outbox 原语，不复制删除判定） |

### 1.4 数据库/连接设施（SearchStore 直接仿照的先例）

| 事实 | 证据 |
|---|---|
| Prisma 单例 + 写串行门面 | `db.ts:82` prisma 单例；`withWriteTx/runWrite/withWriteBatch` :117-144（队列并发 1，outbox INSERT 必须走传入 tx）；dbReady PRAGMA :95-99 |
| 裸 better-sqlite3 只读连接先例 | `db/rawRead.ts:126-131` openRawReader（`readonly:true, fileMustExist:true, timeout:5000` + busy_timeout pragma :128）；SqlBindValue 类型 :23（string/number/bigint/Buffer/null——**bigint 与 Buffer 绑定已被本仓类型覆盖，vec0 所需绑定类型在仓内有先例**）；库文件解析复用 `db/databaseFile.ts:17-21` |
| 多库并存实测依据 | spike §4：Prisma main.db + 裸驱动 search.db 同进程互不干扰，vec0 仅连接级加载不污染主库，search.db 可整文件 rm 重建 |
| readyz 五探针契约 | `ops/readiness.ts:21-26` CheckName 联合（dbPing/dbWritable/migrations/uploadsWritable/disk）；:89-95 CHECK_ORDER。**M5 不新增硬探针**（派生库故障=降级不是 not-ready，§4.8 述理由），探针常驻连接教训 :133-160 同样适用于 search 连接（SearchStore 单例常驻，勿每请求开关） |
| v1 挂载与鉴权链 | `app.ts:145-148`（GX_ENTERPRISE_ORG 条件挂载，:28-29 import）；`routes/v1/index.ts:17` `v1.use("*", requireActiveUser)` 全链鉴权——search 路由挂此链天然获得 ACTIVE 校验/tokenVersion |
| 限流按前缀 | DEFAULT_RULE 匹配 `/api/`（M6 spike 引 rateLimit.ts:44-49），`/api/v1/search` 自动覆盖 /api 兜底 600/60s；检索为读操作，不另设配额（M6 才需要 /mcp 独立档） |

### 1.5 配置/审计/错误信封/标志位先例

| 事实 | 证据 |
|---|---|
| config 结构 | `config.ts:154-191` AppConfig；dataDir :161（prod `/var/lib/gouxiangdb` :195-196，search.db 默认放此目录）；enterpriseOrg 布尔 flag :175/:229；env 解析风格 :193-235。**M5 新增 GX_EMBEDDING_* 配置走域内 flags 模块（仿 queryPlan/flags.ts），config.ts 只存原始值/默认** |
| 三态 flag 成熟形态 | `domain/queryPlan/flags.ts:16-20`（未知值保守回 off）、组合可用性判定 :28-30（读开关依赖写开关的先例——embedding 可用性判定同构：mode=cloud && provider healthy && dim 一致） |
| 错误信封 | 新增不切信封：成功返回资源本体/分页体，错误 `{error, code}`（M3 裁决 5）；M5 新错误码只增：`SEARCH_UNAVAILABLE`（派生库打不开且 LIKE 也失败的兜底，正常降级不抛错）、`EMBEDDING_CONFIG_INVALID`、`REINDEX_IN_PROGRESS`、`REINDEX_FAILED` |
| 审计 | `audit/audit.ts:9-15` AuditEventName 硬编码六联合；M5 只增事件名（`search_reindex_started/done/failed`、`embedding_config_changed`），脱敏设施 :33-41 起 SENSITIVE_PARTS 自动覆盖 key 类字段（apiKey 落 detail 会被脱敏——但**apiKey 根本不入审计 detail**，只记配置存在性/模型名/维度） |
| Prisma 调用计数 | db.ts:39-80 instrumentPrisma（GX_BENCH）；M5 规模门 SQL 计数复用同款 Proxy + search 连接的 instrumentDatabase（rawRead.ts:129 已用） |

### 1.6 部署/备份/打包现状（spike §5 落点）

| 事实 | 证据 |
|---|---|
| 在线备份只备主库单文件 | `scripts/backup/online-backup.mjs:139-153`：源文件由 `DATABASE_URL` 解析（:140-142），`new Database(sourceFile).backup(dbFile)` 单文件快照；**search.db 文件名/路径不同即天然不进备份**，无需改备份脚本（runbook 仅声明"可重建资产不备"，ARCH §7.7） |
| fpk 构建铁律 | `deploy/fnos/build-fpk.mjs:11-15`（包内平台原生二进制说明）、:62-70（强制 Linux 同架构机/buildx 内构建，主机架构不匹配 fail）、:134（server/ 内生产依赖安装取平台 prebuild）；spike §5.3 要求照 better-sqlite3/prebuilds 同构方式把 `vec0.so` 显式拷入白名单产物 + 架构自检 |
| Docker 基线 | bookworm（glibc）满足 spike §5.2（x64≤2.14/arm64≤2.17）；**runbook 必须写"不得换 alpine/musl 基础镜像"** |
| 运行时扩展路径 | spike §5.3：优先 `GX_VEC_EXT_PATH`，否则按 platform/arch 在 `${appDir}/native/<triplet>/vec0.<ext>` 拼绝对路径；fpk 基准 `${TRIM_APPDEST}/server/native/<triplet>/vec0.so`（0755 目录/0644 文件）；search.db 放可写数据目录（config.dataDir），不放只读安装目录、不放 NFS（spike §5.3-5/§7.2） |
| esbuild 扁平产物 | M0 S2；spike §5.3 明确不依赖运行时 `require.resolve('sqlite-vec-...')`（node_modules 子包不保证被保留），构建显式拷贝 |
| 三环境部署方案 | docs/planning/phase2 已入库（47d889b 前序）；M5 的 native/ 目录与 search.db 数据目录要在 Dockerfile/fpk/caddy 三套部署物各落一条（S2 切片） |

---

## 2. M5 范围边界

### 2.1 必做（SPEC M5 + V1-V6 + AC-M5-1/2）

1. **主库 outbox**：`change_events` 表（手写只增迁移，编号在 M4 后）+ records/kb/public 文本写点同事务 INSERT（同实体连续编辑合并去重，保留最新 version/op）。
2. **独立 search.db 派生库**：SearchStore 单例（chunks 普通表 + fts_chunks 虚表 + vec_chunks 虚表 + index_meta），CREATE IF NOT EXISTS 自举、不经 Prisma 迁移、可整文件重建；vec0 加载失败可捕获降级，绝不阻断启动。
3. **indexer 同进程 worker**：单例认领（批 50，状态机 pending/processing/done/failed/dead）、三类内容抽文本（复用 kb.ts 纯函数 + 记录字段拼接 + 画布按元素切）、FTS 写入、cloud embedding 批量向量化写 vec0、失败退避 10s/1m/10m/1h、attempts≥8 标 dead；删除事件先清派生行再 done；系统级单实例约束（单实例部署前提下用进程内认领锁，另加 `index_meta.worker_lock` 行级时间戳防双开重复处理，不引分布式锁）。
4. **EmbeddingProvider 两态**：off（默认）/cloud（OpenAI 兼容契约，spike §6.1）；批量切片、信号量限流、AbortController 超时、仅网络/5xx 重试（4xx 不重试）、health 探活；维度不匹配拒绝向量路并标记需 reindex。
5. **统一检索 v1**：`GET /api/v1/search?q=&type=&mode=auto&limit=`，先 M4 scope 收敛 → FTS/vec 各自白名单内召回 → RRF → 实体聚合 top20 → 出参前 engine.decide 二次校验；mode 回传 hybrid/fts/like + degraded 原因。
6. **字段级零泄漏（AC-M5-2 后半句）**：记录 chunk 收录非计算字段文本（现状纪律）；命中文档的 snippet/title 生成按 **M4 fieldCapability/maskedTableFields（M4 §4.7）逐用户剔除不可见字段片段**——被 mask 字段的文本不进该用户的摘要（chunk 仍可被该字段命中召回，但高亮/摘要不含其原文，命中标记只说"记录匹配"不说是哪个字段；表级不可见整体不召回由 scope 保证）。
7. **reindex 与可观测**：`POST /api/v1/admin/reindex`（role_owner，幂等，重建期间检索自动降 LIKE/FTS）、`GET /api/v1/admin/search/status`（vec 加载/embedding 模式/积压/失败/覆盖率/index_meta）、`GET/PATCH /api/v1/admin/embedding/config`（role_owner，后端契约供设置页）。
8. **降级与损坏自愈（AC-M5-1）**：vec .so 缺失/cloud 连续失败/超时/401/dim 不符/vec 表损坏，全部回落 FTS+LIKE，主应用与编辑链路不受影响；search.db 损坏时隔离文件自动重建（reindex 播种）。
9. **真机性能门**：Tier-L 两架构真机 10 万 chunk P95<500ms 验证（发版门，不达标走降杠杆）；Tier-S 1万-10万流畅基线；数据进 baseline。
10. **openapi 增补 + 后端契约片**：search/admin 两组端点进 M4 冻结的 openapi.yaml；M5-FE 输入清单（搜索结果 UI、设置页 cloud/off 配置、reindex/覆盖率面板）。
11. **审计与 runbook**：reindex/embedding 配置事件；"vec0 加载失败排查/降级说明/musl 禁令/search.db 重建/NFS 警告/model 切换 reindex/积压排查"。

### 2.2 明确不做

| 不做 | 归属 | M5 临时姿态 |
|---|---|---|
| 本地 embedding 模型（Xenova/ONNX/权重预置/Worker 推理） | **已裁决取消（spike §6.2）**，ARCH §7.2 local 态作废 | 只有 off/cloud；不新增任何模型依赖/权重包 |
| reranker / 多模态 embedding / 向量集群 | Out（SPEC :39） | 无 |
| ANN 索引（LanceDB/Qdrant） | 阈值触发后另立 ADR（chunk>50 万或真机 P95 持续>500ms） | 暴力 KNN；接口按可替换设计 |
| 旧 `/api/search/` 重写/下线 | 旧 /api 统一下线切片 | 字节不动；v1 新端点并存 |
| 知识库内 `GET /api/kb/:kbId/docs?q=` 改造 | 不做 | 保留 Prisma contains |
| V5 字段级"标记不参与语义索引"管理 UI（PRD V5 P1） | P1 | 索引收录集=非计算字段（对齐现状）；字段可见性靠 M4 mask 在摘要层剔除；`fields` 表无"可索引"标记列，不加 |
| 记录级分块（每字段/每句多 chunk） | 二期 | 1 记录 1 chunk |
| 实时协同/CRDT、搜索建议/拼音/同义词 | 不做 | trigram 子串已覆盖部分模糊需求 |
| 多工作区隔离 | Out（ws_default） | workspaceId 列照建（ARCH schema 含），值恒默认 |
| 备份 search.db | 永不进主备份集（可重建） | runbook 声明；异地备份只含主库/uploads（现状已如此） |
| 内置 AI 聊天/问答 | M6 后 | M5 只交付检索服务，M6 MCP 是消费方 |
| 前端搜索结果页/设置页实现 | 独立 M5-FE 片（S7 openapi 冻结后派工） | 本文只给 §8 契约清单 |

---

## 3. 不能动的契约（Characterization 先锁）

1. **旧 `/api/search/` URL/响应/有界预览语义字节不变**：S0 对 q 空/记录命中/doc 命中/boundedPreviewMarker 做真库快照，整个 M5 期间旧路由零 diff。
2. **主写链路时延不回退（PRD V2/AC-M5-1）**：outbox 只允许是业务写事务内一条同表库 INSERT（Prisma 同库，无跨库事务——search.db 写绝不能放进主事务）；基准门：record.create 与 PUT content 在 S1 前后 P95 差值在噪声内（bench 设施量化，写队列串行下额外 1 行 INSERT 预期 <1ms，留证）。
3. **主库 schema 方言纪律不变（SPEC :60 铁律）**：change_events 手写迁移、只增、幂等回填、发布前快照、30 分钟回滚；不写 SQLite 专有函数；search.db 的 FTS5/vec0 DDL 是派生库自举语句、**不进 Prisma migrations、不进 _prisma_migrations 对账**（否则 readiness migrations 探针 MISMATCH，readiness.ts:57-69）。
4. **M4 契约只消费不改**：resolveVisibleNodeIds/buildVisibleScopeSql/engine.decide 的签名以 M4 §4.7 为准；M5 不 import guards.ts/kb.ts 旧守卫做检索鉴权（v1 从第一天只认 M4 引擎，与 M6 同纪律，M4 §4.8）。
5. **降级不得改变可见性语义**：hybrid→fts→like 三态共用同一 scope 收敛结果；降级只损失召回能力，绝不放宽权限（AC-M5-2 在三种 mode 下分别对抗）。
6. **Embedding 密钥不出服务端**：apiKey 只从 env/受控配置读，不入任何响应（配置 GET 返回 `hasKey:true` 级存在性）、不入审计、不入日志、不入 search.db、不随 openapi 示例泄漏；MCP/前端永不下发（spike §6.1）。
7. **search.db 单写者**：worker 是唯一写连接（同进程单例）；reindex 的 truncate 与 worker 认领用同一把进程内锁 + rebuilding 标记；检索连接只读打开（仿 rawRead readonly），避免读写互斥污染。
8. **错误信封/限流/安全头/bodyLimit 不切**：v1 search 是 GET（无 body 问题）；admin/reindex POST 走现有 1MB 默认上限（任务参数极小，不需 M6 的 /mcp 豁免）。
9. **可重建即弃**：search.db 与 index_meta 任何损坏都能通过删文件 + reindex 恢复；主库 change_events 保留期由 reindex 播种逻辑决定（reindex = 清派生库 + 主库事件重放/直接扫表，不依赖 change_events 历史不丢失——以扫主库活实体为准，§5.5）。
10. **M1/M2/M3/M4 回归不回退**：GX_M1_* 四组合、组织 v1、nav、权限对抗在 M5 各 flag 组合下全绿；M5 新 flag（GX_EMBEDDING_MODE 等）默认态对旧功能零查询、零连接开销（embedding off 时不打开 search 写连接以外的任何网络连接；search.db 本身懒初始化，首次需要时才创建）。

---

## 4. 架构与数据模型设计

### 4.1 总览（ASCII）

```
                         主库 main.db（Prisma，WAL，串行写队列）
 ┌──────────────────────────────────────────────────────────────────┐
 │ records / kb_docs (+ M3 nav_nodes / M4 auth_policies)            │
 │   业务写事务 withWriteTx                                          │
 │     └─ 同事务 INSERT change_events(outbox)  ← S1，唯一主库新增    │
 │ workspaces.policyVersion / navVersion（M2/M3 已建）              │
 └───────────────▲──────────────────────────────┬───────────────────┘
                 │ 只读连接（better-sqlite3 readonly，仿 rawRead）   │
                 │ ① worker 认领事件/拉实体文本                       │
                 │ ② 检索时 M4 scope 在主库/Prisma 侧计算            │
                 │                               
  ┌──────────────┴──────────────────────────────────────────────────┐
  │  indexer worker（同进程单例，串行；不阻塞写队列）                 │
  │   认领批50 → 抽文本(kb.ts 纯函数/记录拼接/画布按元素)            │
  │     → 写 fts_chunks ──→ EmbeddingProvider.embed ──→ vec_chunks   │
  │             ↑ off/cloud 失败都写 FTS；cloud 失败退避向量部分     │
  │   退避 10s/1m/10m/1h，attempts≥8 → dead（管理页可重试）          │
  └──────────────┬──────────────────────────────────────▲───────────┘
                 │ 单写连接（better-sqlite3，WAL）        │ health/配置
                 ▼                                       │
        ┌────────────────────────────────────────────────┴─────────┐
        │ search.db（独立文件，config.dataDir/search.db，可 rm）     │
        │  chunks(rowid INTEGER PK, chunkId TEXT UNIQUE,             │
        │         entityType, entityId, nodeId, workspaceId,         │
        │         title, seq INTEGER, version INTEGER,              │
        │         length INTEGER, updatedAt TEXT)                    │
        │  fts_chunks  USING fts5(title, body, chunkId UNINDEXED,    │
        │                       nodeId UNINDEXED, entityType UNINDEXED, │
        │                       tokenize='trigram remove_diacritics 1')│
        │  vec_chunks USING vec0(embedding float[D],                 │
        │                       entityType INTEGER, k INTEGER)  ← 元数据列 BigInt │
        │  temp_scope(session 临时表，检索时由 M4 scope 物化)         │
        │  index_meta(k TEXT PRIMARY KEY, v TEXT)                    │
        └──────────────▲────────────────────────────────────────────┘
                       │ 只读连接（每检索会话，readonly）
  GET /api/v1/search ──┴─→ ① M4 scope（主库）→ INSERT temp 表
                           ② FTS: MATCH/LIKE JOIN temp_scope → top100
                           ③ vec: KNN WHERE entityType IN + rowid 收敛 → top100
                           ④ RRF 1/(60+rank) → 实体聚合 → 二次 decide → top20
                           ⑤ 字段 mask 摘要剔除 → 响应 mode/degraded
```

- **连接拓扑（三连接，职责分离）**：主库 Prisma 读写（既有）；主库裸驱动只读连接（worker 读事件/实体 + scope 快路径，复用/仿照 rawRead.ts 单例）；search.db 一写（worker 单例）一只读池（检索会话，容量上限 4，超出排队）。spike §4 已证同进程多库无干扰。
- **不使用 ATTACH 的理由（选型记录）**：ATTACH search.db 到主库连接要求该连接也 loadExtension（Prisma 连接无法 loadExtension，spike §7.3）；裸驱动连接 ATTACH 两库会让跨库 JOIN 持有两库句柄、WAL/锁语义耦合，且备份单文件快照（backup API）无法覆盖 ATTACH 组。独立连接 + temp_scope 物化白名单，权限计算（主库）与召回（派生库）边界清晰、各自可测、可独立替换为 LanceDB（ADR 候选）。

### 4.2 search.db schema 与 BigInt 铁律

```sql
-- 自举（SearchStore 初始化，IF NOT EXISTS；不进 Prisma 迁移）
CREATE TABLE IF NOT EXISTS chunks(
  rowid       INTEGER PRIMARY KEY,      -- 与 fts/vec rowid 三处一致；绑定必须 BigInt
  chunkId     TEXT NOT NULL UNIQUE,     -- `${entityType}:${entityId}:${seq}`
  entityType  TEXT NOT NULL,            -- 'record' | 'doc' | 'canvas'
  entityId    TEXT NOT NULL,
  nodeId      TEXT NOT NULL,            -- M3 nav_nodes.id（scope 收敛的连接键）
  workspaceId TEXT NOT NULL,
  title       TEXT NOT NULL DEFAULT '',
  seq         INTEGER NOT NULL DEFAULT 0,
  version     INTEGER NOT NULL DEFAULT 0,
  length      INTEGER NOT NULL DEFAULT 0,
  updatedAt   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_node ON chunks(nodeId);
CREATE INDEX IF NOT EXISTS idx_chunks_entity ON chunks(entityType, entityId);

CREATE VIRTUAL TABLE IF NOT EXISTS fts_chunks USING fts5(
  title, body, chunkId UNINDEXED, nodeId UNINDEXED, entityType UNINDEXED, entityId UNINDEXED,
  tokenize = 'trigram remove_diacritics 1'
);

-- 仅当 vec0 加载成功且 cloud 配置有效时创建；D 来自 index_meta.embedding_dim
CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
  embedding float[1536],          -- 实际 D 在建库时以常量拼接（禁止字符串拼接用户输入）
  entityType INTEGER,             -- 1=record 2=doc 3=canvas（整数映射，绑定 BigInt）
  k INTEGER                       -- 预留分区位（首版可恒 1），绑定 BigInt
);

CREATE TABLE IF NOT EXISTS index_meta(k TEXT PRIMARY KEY, v TEXT NOT NULL);
-- 键：schema_version / vec_loaded / vec_version / embedding_mode / embedding_model /
--     embedding_dim / indexed_at / rebuilding(0|1) / worker_lock(时间戳|workerId)
```

**BigInt/绑定铁律（spike §2/§4 实测，写进 code review 清单与单测）**：

1. vec0 表的 rowid 与**所有 integer metadata 列**（entityType/k）插入绑定一律 `BigInt(...)`；chunks.seq/version/length 写普通表可用 number，但 rowid 三处对齐值统一经一个 `toRowId()` 纯函数（Snowflake 式不需要——用 `index_meta` 维护分配游标 `next_rowid`，取号在写事务内 `UPDATE ... RETURNING` 或先读后插，单写者无竞争）。
2. 向量绑定 = Float32Array.buffer 的 Buffer（little-endian float32），禁止 JSON 数组文本绑定（spike 实测未走通）。
3. 所有 KNN 语句必须有 `LIMIT ?`（参数也可）或 `k = ?`，封装层强制，代码评审 grep `MATCH ?` 附近无 LIMIT 即打回。
4. `db.transaction(fn)` 返回函数须再调用 `fn()` 才执行（spike §4 踩坑，静默不执行）；封装 SearchStore 写事务的 helper 内置调用并在命名上区分。
5. 元数据等值过滤在暴力扫描期完成（spike §7.1：不加成本，语义是过滤后集合内 top-k）。

### 4.3 outbox（主库 change_events，手写迁移）

```prisma
model ChangeEvent {
  id          String   @id @default(cuid())
  entityType  String   // record | doc | canvas
  entityId    String
  workspaceId String   @default("ws_default")
  version     Int      // 内容版本：doc=contentVersion；record=updatedAt ms 序号（同事务内单调）
  op          String   // upsert | delete
  status      String   @default("pending") // pending|processing|done|failed|dead
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

- **合并去重（ARCH §7.1）**：业务写事务内先 `UPDATE change_events SET version=?, op=?, status='pending', nextRunAt=now, lastError=NULL WHERE entityType=? AND entityId=? AND status IN ('pending','failed')`，updateCount=0 再 INSERT；processing/done 行不动（已在飞/已完成的由后续事件新开一行；done 后再编辑 = 新事件）。
- 软删内容发 `delete`（回收站不可搜，与旧搜索手工过滤 deletedAt 同语义，search.ts 旧行为）；恢复发 upsert；物理 purge 发 delete 并由 worker 清三表派生行。
- 迁移只增；回填迁移（同批第二个迁移或同一迁移后段）：首次启用时为**全部活实体**播种 pending 事件（INSERT...SELECT records/kb_docs，限量分批，按 S2 回填纪律幂等 NOT EXISTS），保证空 search.db 首启自动建索引——不靠 worker 上线时手工点 reindex（ARCH :962 首启自动）。
- down：DROP TABLE change_events（发布前快照为主回滚路径；该表只被 M5 读，删除不影响旧功能）。

### 4.4 EmbeddingProvider（off/cloud，spike §6.3 签名收紧）

```ts
export type EmbeddingMode = "off" | "cloud";
export interface EmbeddingProvider {
  readonly mode: EmbeddingMode;
  readonly model: string;
  readonly dim: number;                 // 与 vec0 float[D] 严格一致
  readonly batchSize: number;           // GX_EMBEDDING_BATCH_SIZE 默认 64
  embed(texts: readonly string[]): Promise<Float32Array[]>;  // 等长同序，index 对齐
  health(): Promise<{ ok: boolean; latencyMs?: number; detail?: string }>;
}
```

- 配置（env 启动基线 + admin PATCH 运行态覆盖，**运行态覆盖存主库新表 or index_meta？定稿：存主库 `app_settings` 小表（只增迁移，key/value），env 仅作首启种子；apiKey 存主库必须加密——M0 age 公钥是备份加密，应用内对称密钥用 JWT_SECRET 派生 AES-256-GCM（crypto 内置，零依赖）；不引加密库**。待裁决项 B-2：是否允许设置页落 apiKey，还是仅 env。本文建议：PATCH 可落（加密存），env 为只读基线，UI 明示"已配置"）：
  `GX_EMBEDDING_MODE`（off|cloud，默认 **off**）、`GX_EMBEDDING_BASE_URL`、`GX_EMBEDDING_API_KEY`、`GX_EMBEDDING_MODEL`（默认 text-embedding-3-small）、`GX_EMBEDDING_DIM`（默认 1536，必须与 model 实际一致）、`GX_EMBEDDING_BATCH_SIZE`（64）、`GX_EMBEDDING_TIMEOUT_MS`（15000）。
- cloud 可用性四与门（仿 flags.ts:28-30 组合判定）：mode=cloud **且** baseURL/key/model/dim 配置齐全 **且** health().ok（启动探活 + 周期 60s 探活，连续 3 次失败置 unhealthy）**且** index_meta.embedding_dim 与配置 dim 一致（不一致拒绝向量路、status 报 `dim_mismatch_reindex_required`）。
- 请求：POST `${baseURL}/v1/embeddings`（baseURL 自带 /v1 与否做归一），Bearer key，`{model,input:[...],encoding_format:"float"}`；以 `data[].index` 对齐回序；4xx 不重试（配置/内容错误，直接 failed 让事件退避到 dead 暴露配置问题），网络错/5xx/超时指数退避（3 次，基数 1s）；整批 401/403 → provider 置 unhealthy，后续事件只写 FTS、向量部分 pending 不标 done？**定稿：FTS 成功即事件 done（检索可用性优先），向量缺失由"覆盖度对账"补发**（index_meta 维护 `vec_dirty` 清单或对 chunks LEFT JOIN vec_chunks 周期补向量，S4 实现对账）。
- 空文本不调用（零长度直接跳过向量）；超长文本按 batch 内截断保护（单条上限约 8000 字符，超出在抽文本层截断并记 length）。

### 4.5 先收敛后召回（AC-M5-2 的实现细则）

```
search(q, user, filters):
  1. q 规范化（trim；空 q 返回空结构，与旧端点 :51 一致）
  2. scope = M4.resolveVisibleNodeIds(user, {actions:['r'],
        kinds: filters.type 映射（record→table 节点？见下"粒度"）})
     → {nodeIds, resourceIdsByType, truncated, policyVersion, navVersion}
     budget 超限时 M4 返回 expectsTempTable 形态；M5 一律走临时表（不分支 IN 直拼）。
  3. search.db 只读会话：CREATE TEMP TABLE temp_scope(nodeId TEXT PRIMARY KEY)；
     批量 INSERT（每批 499）。
  4a. FTS 路（q 码元长度 ≥3）：
      SELECT c.entityType,c.entityId,c.chunkId,c.title, bm25(fts_chunks) rank
      FROM fts_chunks
      JOIN chunks c ON c.rowid=fts_chunks.rowid
      JOIN temp_scope s ON s.nodeId=c.nodeId
      WHERE fts_chunks MATCH ? ORDER BY rank LIMIT 100
      （FTS5 语法：MATCH 左值必须是虚表名 fts_chunks 本身（不可用别名）；
        trigram 子串用裸词/词加 *，用户输入统一包双引号短语并转义，防 MATCH 注入）
  4b. LIKE 路（q 码元 <3，或 FTS 结果不足时的补集？定稿：短词只走 LIKE）：
      JOIN temp_scope + (c.title LIKE ? ESCAPE '\' OR fts_chunks.body LIKE ? ESCAPE '\')
      参数化、%/_/\\ 转义；同样 LIMIT 100。
  4c. vec 路（provider 四与门通过时）：
      queryVec = provider.embed([q])
      KNN：SELECT rowid,distance FROM vec_chunks
           WHERE embedding MATCH ? AND entityType IN (BigInt 映射)
                 AND rowid IN (SELECT c.rowid FROM chunks c JOIN temp_scope s ...)
           ORDER BY distance LIMIT 100
      ★ spike §8.5-3 未实测项：S5 首日先在夹具上验证该 SQL 被接受且计划正确
       （白名单在 KNN 前收敛而非 top-k 后丢弃）。若 vec0 不支持/优化器先全量 KNN：
        退路 A = 按 scope 实体集映射到连续 chunk rowid 区间不可行（不连续）；
        退路 B = 两阶段：先 SELECT chunk rowid JOIN temp_scope 取白名单 rowid 集，
                 在应用层无法注入 vec0 距离函数 → 采用"分组 metadata 列"粗收敛
                 （entityType + 可选 partition 列=root node 哈希分桶，scope 展开为桶集）
                 + KNN 后 IN 白名单兜底；若仍需全量扫，则记录证据并把 k 调小/
                 推动降维，结论写入 S5 gate，严禁静默退回"全量召回后过滤"。
  5. RRF：每条结果 score += 1/(60+rank)（同名次两路即 2/61 级提升）；
     标题精确等于 q / 前缀命中加固定 boost（值在 S5 用小样标定，写常量不拍脑袋）。
  6. 实体聚合：同 entityId 多 chunk 取 max(score)，doc 带命中 chunk seq（摘要定位）。
  7. 纵深防御：对 top 候选逐实体 engine.decide(user, nodeFor(entity),'r')
     （M4 批量 decideMany，定数 SQL）——二次校验失配的丢弃并记 metric（正常应为 0；
       非 0 说明 scope 快照与决策不一致，是 bug 信号不是常态）。
  8. 摘要：record 用可见字段重拼 snippet（mask 剔除，§4.6）；doc 用 chunk 文本窗口。
  9. 响应（§6 契约）+ mode（两路都有 hybrid；仅 FTS fts；短词 like）+ degraded[]。
```

- **粒度对齐**：M4 scope 返回 nodeIds；record chunk 的 nodeId 挂**表节点**（记录在 M3 是 table 下内容，记录实体不建独立 nav 节点——M3 六类节点 base/table/view/doc/canvas/group，记录非节点；以 M3 落地为准，S5 开工核 nav sync 中记录变更如何反映，若 M3 不为记录建节点，则 record 可见性 = 其 table 节点 r，scope kinds 取 table，chunks.nodeId=tableNodeId）；doc/canvas chunk 挂各自 doc/canvas 节点。此映射在 S4 抽文本时固化，S5 用对拍测试锁"scope 集与 chunk 集的 join 语义 = 逐实体 decide"。
- **truncated 处理**：M4 budget 默认 5000、硬顶 20000；超限 M5 不允许全量召回——temp 表只装截断集时响应必须带 `scopeTruncated:true` + 提示缩小范围（管理类大规模检索不是 P0 场景），不得静默只搜部分却谎称全量。
- **严禁时序**：禁止"vec/fts 全量 top100 → 应用层过滤掉无权的 → 数量不足"（spike §8.4 铁律）；所有召回 SQL 的 EXPLAIN 必须出现 temp_scope/chunks 的 JOIN/过滤在 SCAN vec 之前或之中（vec0 本就 SCAN，WHERE 下推即满足）。

### 4.6 字段 mask 与摘要（接 M4 裁决 A-4 的检索侧口径）

- 索引收录（建库时无主体概念）：记录 chunk body = 非计算字段值文本拼接（search.ts:90-95 旧规则的服务端化）；**不新增"字段不索引"标记（V5 P1 不做，§2.2）**。
- 召回与摘要分离：被 mask 字段文本参与召回（用户能搜到"有一条记录匹配"），但：
  1. snippet 只由 `fieldCapability.visible` 字段文本生成，mask 字段命中不贡献高亮窗口；
  2. `matchedField` 不返回被 mask 字段名（旧 RecordHit.matchedField 字段语义降级：v1 对无字段可见性信息的命中返回 null 或"已隐藏字段"级中性值——**沿用 M4 A-4 最小泄漏原则：不出现"无权限"字样、不反证字段存在**；v1 新响应可重新定义 matchedField 为可选）；
  3. title 候选字段（primaryField/linkDisplayField）被 mask 时按 M4 A-4：回退 record id，不伪造；
  4. 若该用户在该表所有可见字段均未参与命中（纯靠隐藏字段命中），记录仍可出现在结果中吗？定稿：**仍出现**（表级 r 即有权知道记录存在，与列表可见行一致——M4 列表对表级可见用户返回行，只是字段缺席），snippet 给中性"此记录包含匹配内容"占位而非原文。该项列入待裁决 B-3（产品确认是否接受此存在性口径；替代方案是隐藏字段命中整行不出现，但那要求建 per-user 字段倒排，与单一派生库冲突）。
- doc/canvas 无字段概念，mask 不适用；doc 级不可见由 scope 整体剔除。

### 4.7 权限/继承变更与版本号联动

- **无索引失效**：chunks/fts/vec 不含授权数据，调岗（dept_members 变）、角色收授（role_assignments/auth_policies 变）、继承开关（nav_nodes.inheritAncestors 变）、tree 移动（path 重写）只影响 scope 计算；M4 已保证 bump policyVersion/navVersion 且决策无跨请求正缓存——M5 每次检索现算 scope，AC-M2-1"下次请求即变"在检索通道自动成立（S8 对抗验证）。
- nodeId 稳定性是联动前提：M3 nav 节点 id 在 move/rename 下稳定（path 变 id 不变，M3 契约）；若某实体节点被 purge 后重建为新 id，chunks.nodeId 悬空行由删除事件清理 + 检索 INNER JOIN temp_scope 天然不命中（悬空行不可达，但 reindex 对账清掉，coverage 对账含"chunks.nodeId 在 nav 不存在"巡检项）。
- 响应回传 `policyVersion/navVersion`（取自 scope），供前端作废缓存；不参与缓存键的服务端缓存（M5 不建结果缓存）。

### 4.8 降级矩阵（AC-M5-1 验收面）

| 情形 | 系统行为 | mode/degraded | 主应用 |
|---|---|---|---|
| vec0 .so 缺失/加载失败/musl 环境 | catch 加载异常，vecAvailable=false，不建 vec_chunks，worker 只写 FTS | fts/like，degraded:vec_unavailable（warn + status 可见） | 不受影响 |
| GX_EMBEDDING_MODE=off（默认） | 不建/不查向量（vec_chunks 可不建），不发起任何外网请求 | fts/like | 不受影响 |
| cloud 缺配置/401/超时/连续失败 | provider unhealthy，向量路关；事件 FTS 部分 done，向量待补 | fts/like，degraded:embedding_unhealthy | 不受影响 |
| dim 与建表不一致 | 拒向量路，status 提示 reindex；FTS 正常 | fts/like，degraded:dim_mismatch | 不受影响 |
| search.db 文件损坏/打不开 | 隔离文件（rename .corrupt-ts）→ 重建空库 → 自动播种 reindex；当次检索回退**主库 LIKE 应急路径**（受限：scope 收敛后对主库 title/searchText 参数化 LIKE，记录限 SEARCH_PREVIEW 有界口径复用 ADR-0005） | like，degraded:search_store_recovering | 不受影响 |
| worker 卡死/积压 | status 暴露 backlog/dead 计数；不影响检索（旧索引继续服务）与写入 | hybrid/fts 正常 | 不受影响 |
| reindex 进行中 | rebuilding=1：新库空期间检索自动降 like/旧库？定稿：**双库切换**——rebuild 在 search.db.rebuild-<ts> 临时文件进行，完成后原子 rename 替换（spike §4 rm 重建可行；rename 切换避免空窗）；切换瞬间只读连接重开 | 切换中 like 瞬态 | 不受影响 |
| embedding 进程/外部服务"崩溃" | 无本地进程可 kill；测试模拟=health 失败/请求超时断网，自动 fts-only（AC-M5-1 kill 演练对 cloud 用断网/坏 endpoint） | fts/like | 不受影响 |

- /readyz 五探针不加 search 项的理由：派生库是可降级、可重建资产，把它列入 readiness 会让"vec .so 没装"变成 503 摘流，而系统预期就是能纯 FTS 服役（低端 NAS/musl 环境）。可观测性放在 `GET /api/v1/admin/search/status` 与启动 warn 日志、审计事件。

### 4.9 目录组织（单文件 ≤300 行，资源分包）

```
apps/api/src/domain/search/
  searchStore.ts      // search.db 单例：打开/PRAGMA/loadExtension/降级标记/临时表
  schema.ts           // DDL 自举语句（纯字符串常量）+ index_meta 读写
  vecLoader.ts        // resolveVecPath（GX_VEC_EXT_PATH/平台 triplet）、load、BigInt 绑定 helper
  chunks.ts           // chunk 抽文本：recordConcat / docSplit / canvasElements（复用 domain/kb.ts）
  outbox.ts           // enqueueChangeEventTx（主库 *Tx 原语，合并去重）
  indexer.ts          // worker 认领/状态机/单例锁/退避/向量覆盖度对账
  embedding.ts        // EmbeddingProvider 接口 + offProvider + cloudProvider（fetch/超时/重试/health）
  embeddingConfig.ts  // env 解析 + app_settings 读取/加密落库（AES-256-GCM by JWT_SECRET）
  query.ts            // scope 物化 + FTS/LIKE/vec 三路 + RRF + 聚合 + 二次 decide
  snippets.ts         // mask 摘要剔除（消费 M4 fieldCapability）
  rrf.ts              // 纯融合函数（表驱动单测）
  __tests__/          // characterization/降级/零泄漏/融合/绑定类型
apps/api/src/routes/v1/
  search.ts           // GET /search
  adminSearch.ts      // POST /admin/reindex、GET /admin/search/status、GET/PATCH /admin/embedding/config
apps/api/scripts/search/
  reindex.mjs         // pnpm gx:reindex [--type record|doc|canvas] [--id]（ARCH :743）
  check-coverage.mjs  // 主库实体 vs 派生覆盖度/悬空 nodeId 巡检（只读）
```

---

## 5. 数据维护与运维

### 5.1 迁移拆分（只增；编号在 M4 迁移之后）

- 迁移 D `<ts>_search_outbox_ddl/migration.sql`：CREATE change_events + 两索引 + app_settings 表（key/value/updatedAt）。
- 迁移 E `<ts>_search_outbox_seed/migration.sql`：活实体播种（分批 INSERT...SELECT NOT EXISTS，records 活行 + kb_docs 活行），幂等可重跑；worker 上线后自动消化（首启建索引）。
- down：`prisma/docs/rollback/<ts>_search_outbox.down.sql` DROP 两表（主回滚靠发布前快照；事件表无业务读取方）。
- **search.db 零 Prisma 迁移**：schema.ts 自举，index_meta.schema_version 管内部版本升级（未来 DDL 变更走 bump + 迁移函数，不兼容则触发 rebuild）。

### 5.2 outbox 接线点清单（S1 收口，每点同事务）

| 内容 | 写点 | op/version 取法 |
|---|---|---|
| 记录建 | records.ts:417-425（withWriteTx） | upsert；version=Date.now()（同事务内） |
| 记录改 | :632-635、:743、:804、:915；:206 裸写先归入事务（若 M3 已包则挂其 tx） | upsert |
| 记录软删/恢复 | :689、:1036 | delete / upsert |
| 文档/画布内容 | kb.ts:403-441（PUT content，version 直接用 contentVersion 递增值，合并去重 UPDATE 同值） | upsert；version=新 contentVersion |
| 文档建/改名/树移动 | kb.ts 建文档点 + M3 nav sync 改名/移动（节点 id 稳定，移动不改文本→**不发事件**，scope 侧处理） | 仅建/内容变才发 |
| 文档物理删/清空 ACL | kb.ts:634 区 | delete |
| 匿名公开编辑 | public.ts:270-273 | upsert（ANON 不影响实体索引归属） |
| 表删除（级联记录） | M3 purge 点 | 按表实体集批量 delete（若 M3 sync 有 purge 原语，挂其回调；否则 S1 补一条按 tableId 的事件批量播种） |

每点只调 `enqueueChangeEventTx(tx, {...})`；注入失败随主事务整体回滚（共生死，M3 裁决 9 同纪律）。S1 验收含"outbox 插入失败 → 业务写整体回滚"与"主写 P95 噪声级差值"两组证明。

### 5.3 worker 状态机与退避

- 认领单条 SQL（单写者 + 防多实例）：`UPDATE change_events SET status='processing', workerId=?, attempts=attempts+1 WHERE id=(SELECT id FROM change_events WHERE status='pending' AND nextRunAt<=? ORDER BY nextRunAt LIMIT 1) RETURNING *`（SQLite 3.53 支持 RETURNING，better-sqlite3 内建 3.53.4 已由 spike 确认）；失败置 failed + nextRunAt 指数退避（10s/1m/10m/1h/1h/1h/1h/1h），attempts≥8 转 dead；成功 done + processedAt。
- 处理顺序：取实体（主库只读连接，活/deletedAt 判定）→ op=delete 清三表（chunks/fts/vec 按 entityId，rowid 联动）→ upsert：抽文本 → 删旧 chunk 行 → 取新 rowid → 写 chunks + fts → embed（cloud）→ 写 vec。
- 单轮批量 50 事件、轮询间隔空闲 2s（有积压连续处理）；不引入外部队列/cron（systemd timer 只跑 reindex CLI，不跑 worker——worker 在 API 进程内）。
- 启动：服务启动后延迟 3s 启动 worker（避开启动忙峰）；GX_SEARCH_WORKER=off 可关（排障/双开防护，默认 on）。

### 5.4 reindex（幂等 job）

- `POST /api/v1/admin/reindex {type?, entityId?}`：role_owner 限定；index_meta 置 rebuilding + 审计；在 `search.db.rebuild-<ts>` 自举空库 → 扫主库活实体直接灌（不经 change_events 重放，避免事件历史保留期问题，§3-9）→ 完成后原子 rename 替换 + worker 只读/写连接重开 + rebuilding=0；期间旧库继续服务、新库不可见，切换瞬态如 §4.8。
- 并发保护：rebuilding=1 时再调返回 409 REINDEX_IN_PROGRESS（不排队第二个）。
- CLI `pnpm gx:reindex`（ARCH :743）：停机维护场景直跑同一 service 函数。
- model/dim 变更：PATCH embedding/config 改 dim 时后端不自动重建（可能耗时），返回 `reindexRequired:true`；管理员确认后调 reindex（或 PATCH 带 `reindex:true` 一步触发）；vec_chunks 在新库按新 D 建。

### 5.5 覆盖度对账（check-coverage + status 数据源）

- A 类：主库活实体无派生 chunk（漏索引）；B 类：派生 chunk 对应实体不存在/已删（脏行）；C 类：chunks.nodeId 在 nav_nodes 无活节点（悬空）；D 类：cloud 模式下 chunks 缺 vec 行（向量欠账）；E 类：fts 缺失。只读巡检，exit 非 0 供 CI/运维；status 端点汇总计数。

---

## 6. v1 API 契约（S7 进 openapi 冻结，此处为契约纲要）

> 全部挂 `/api/v1`，经 v1 鉴权链（requireActiveUser）；现网信封：成功资源本体、错误 `{error,code}`；分页不涉及（固定 top20/可配 limit≤50）。

```
GET /api/v1/search?q=&type=all|record|doc|canvas&mode=auto&limit=20
  200: {
    items: [{
      type:"record"|"doc"|"canvas",
      entityId, nodeId, title, snippet,
      baseId/baseName/tableId/tableName?  (record 族，字段名对齐旧 RecordHit 便于前端迁移),
      kbId/kbName/docId?                  (doc 族),
      score, matchedVia:["fts","vec"], chunkSeq?,
      matchedField: string|null          // mask 时 null（§4.6-2）
    }],
    total: <本次返回条数>, limit,
    mode:"hybrid"|"fts"|"like",
    degraded: []|"vec_unavailable"|"embedding_unhealthy"|"dim_mismatch"|"search_store_recovering",
    scopeTruncated: false,
    policyVersion, navVersion
  }
  空 q → 200 {items:[], mode:"like"}（不报错，与旧端点一致）

POST /api/v1/admin/reindex   body: {type?, entityId?}        → role_owner
  202: {job:"reindex", status:"started"} | 409 REINDEX_IN_PROGRESS | 403

GET  /api/v1/admin/search/status → role_owner
  200: { vec:{loaded, version?, extPathKind?/*不给绝对路径，给 platform/builtin/env-override*/},
         embedding:{mode, model, dim, hasApiKey, healthy, detail?},
         index:{schemaVersion, indexedAt, chunks:{records,docs,canvas,total},
                backlog:{pending,failed,dead}, coverage:{a,b,c,d,e}, rebuilding} }

GET  /api/v1/admin/embedding/config → role_owner   （绝不回传 apiKey 明文/密文）
  200: {mode:"off"|"cloud", baseURL, model, dim, batchSize, timeoutMs, hasApiKey, source:"env"|"db"}
PATCH /api/v1/admin/embedding/config → role_owner
  body: {mode?, baseURL?, apiKey?, model?, dim?, batchSize?, timeoutMs?}
  → 200 同 GET 形状；dim/model 变更 → 200 带 reindexRequired:true（不自动重建）；
    cloud 模式保存后同步探活，失败 200 带 healthy:false（不阻断保存，允许先存后修网络）；
    非法 URL/越界 dim/批量 → 400 EMBEDDING_CONFIG_INVALID；审计 embedding_config_changed（无 key 值）
```

- 错误码新增（只增不改旧码）：`SEARCH_UNAVAILABLE`、`REINDEX_IN_PROGRESS`(409)、`REINDEX_FAILED`、`EMBEDDING_CONFIG_INVALID`(400)。
- 限流：沿用 /api 兜底；reindex 额外在应用层 409 防抖。
- 管理端"admin"角色口径：M2 无独立 admin 动作位，**以有效角色含 systemKey=role_owner 判定**（复用 M4 hasOrgAction/effective 角色，具体 helper 在 S7 按 M4/M2 落地形态取，不新造角色）。

---

## 7. 切片总览与依赖

| 切片 | 标题 | 类型 | 主要触碰 | 依赖 |
|---|---|---|---|---|
| S0 | 旧检索 characterization + M5 baseline | 测试+文档 | domain/search/__tests__；docs/baseline | —（可先做，未派工不动） |
| S1 | change_events 迁移/播种 + outbox 同事务接线 | 纯后端 | 2 迁移；domain/search/outbox.ts；records.ts/kb.ts/public.ts 写点 | M3-S3 收口（nav/purge 语义在库） |
| S2 | SearchStore + search.db 自举 + vec0 加载降级 + 原生打包 | 纯后端+部署 | domain/search/{searchStore,vecLoader,schema}.ts；build-fpk.mjs；Dockerfile；env 示例 | S1 |
| S3 | EmbeddingProvider off/cloud + app_settings 加密配置 | 纯后端 | embedding.ts/embeddingConfig.ts；迁移 D 的 app_settings | S2 |
| S4 | indexer worker（抽文本/FTS/vec/退避/删除/覆盖对账） | 纯后端 | chunks.ts/indexer.ts；scripts/search | S1-S3 |
| S5 | searchService 先收敛后召回 + RRF + GET /v1/search | 纯后端 | query.ts/rrf.ts；routes/v1/search.ts | **M4-S4（scope 冻结）+ M4-S1（decide）**；spike §8.5-3 首日验证 |
| S6 | mask 摘要剔除 + AC-M5-2 六对抗 | 纯后端 | snippets.ts；M4 fieldCapability 消费 | S5、M4-S6 |
| S7 | reindex/status/config 端点 + openapi 增补冻结 | 后端+契约 | routes/v1/adminSearch.ts；docs/api/openapi.yaml | S4/S5 |
| S8 | 权限/调岗/继承变更即时失效对抗（联动 policyVersion/navVersion） | 测试 | __tests__ | S5、M4-S7 |
| S9 | 崩溃/降级/损坏自愈全链路（AC-M5-1） | 测试+runbook | 断网/坏 endpoint/删库/杀 worker 演练 | 全部 |
| S10 | 规模门：10 万 chunk 真机 P95（Tier-L x86+arm）+ Tier-S 1-10 万流畅基线 | 混合 | bench 夹具；docs/baseline/m5-gate.md | S5/S9 |
| S11 | 出口收口：ADR/40RC/runbook/baseline/M5-FE 输入清单 | 文档 | docs/adr、docs/runbooks | S10 |

关键路径：S0→S1→S2→S3→S4→（S5 待 M4）→S6→S7→S8/S9→S10→S11。
排期硬约束：
1. 后端单线 M2→M3→M4→M5（M3 裁决 10 延伸）；S5 开工必须 M4-S4 已合入且 scope 契约复核一致；S6 待 M4-S6 fieldCapability 落地。
2. S1 与 M3-S3/M4-S5 都会触碰 records.ts/kb.ts/bases.ts 写事务区域——M5-S1 排在这些切片合入后 rebase，接线点以在库事务为准，禁止把裸写留在 M5 出口。
3. sqlite-vec 依赖加入与 native 打包（S2）要同步改 build-fpk.mjs/Dockerfile/三环境部署文档，**fpk/Docker 发版门含目标机 .so 加载冒烟（spike §8.5-1）**，缺门不发。
4. M5-FE 在 S7 openapi 冻结后派工，本文不排前端 S 号。
5. GX_EMBEDDING_MODE 默认 off 贯穿所有环境；Tier-L 真机门（S10）未过前，对外材料不得出现"10 万数据语义检索 P95<500ms"承诺（PRD D3 纪律）。

---

## 8. M5-FE 前端片输入清单（S7 冻结后派工，本文不拆前端切片）

1. 全局搜索结果页改造：数据源由 `/api/search/` 切 `/api/v1/search`，items 统一实体形态 + matchedVia/score；mode/degraded 状态条（hybrid/fts/like 与降级原因的中性文案，不向用户暴露技术细节如 ".so"）；scopeTruncated 提示。
2. 设置 → 语义检索页（SPEC §7 embedding/检索设置）：off/cloud 单选（默认 off，强调数据出域提示，文案过 PM/设计师）；cloud 下 baseURL/model/dim/batchSize/timeout 表单；apiKey 密码框（只写，GET 只回 hasApiKey）；"测试连接"（靠 PATCH 后 healthy 回显或 status）；reindexRequired 引导条 + 重建按钮（二次确认，显示 type 选择与进行中状态）；图标只追加 icons.tsx，禁止第二套 SVG 库与 emoji（团队 P0 规则）。
3. 索引覆盖度面板（V5 部分最小集）：status 的 backlog(dead/failed)/coverage/重建中进度（轮询 status，30s 节流）。
4. 全部 gx token、只走 api/client.ts、无新依赖；M4 A-4 中性文案纪律延伸到搜索（不出现"无权限"反证措辞）。
5. 嵌入状态徽标在主导航/搜索框的呈现形式由设计师定，数据只用 status 字段。

---

## 9. 切片明细（每片：新增/改动、陷阱、独立验收、回滚）

### S0 — 旧检索 characterization + baseline
- 真库夹具锁 `/api/search/`：空 q、记录命中、doc/canvas 命中、boundedPreviewMarker、计算字段不入选；旧响应键集合快照。M5 全程此文件零 diff。
- `docs/baseline/2026-09-18-m5-baseline.md`：HEAD、678/3（56 文件）、迁移 14（M 后预期 19/20）、环境版本、spike 版本锚（sqlite-vec 0.1.9）。
- 验收：全绿只增。回滚：删测试/文档。

### S1 — outbox DDL/播种/接线（中敏）
- 迁移 D/E（§5.1）；outbox.ts 合并去重原语；§5.2 全接线点。
- 陷阱：doc PUT 两处分支（条件更新/裸 update）都要在**同一逻辑事务**发事件，条件更新分支 updateMany count=0（409）时不得留事件（随 409 不写——当前 409 在更新前，事件原语在更新成功后调）；record 版本用 updatedAt 实际写入毫秒。
- 验收：每写点双向证明（写→事件合并；purge→delete 事件）；注入失败业务写回滚；bench record.create/PUT content P95 差噪声级；迁移幂等重跑 no changes。
- 回滚：down DROP；接线摘除。

### S2 — SearchStore + vec0 + 打包
- searchStore.ts（懒初始化、WAL/busy_timeout、只读池、rebuild rename 切换钩子）；vecLoader（GX_VEC_EXT_PATH/triplet 绝对路径，文件名恒 vec0）；schema.ts 自举；BigInt/Buffer 绑定 helper + toRowId 取号。
- 部署：package.json 加 `sqlite-vec@0.1.9`（dependencies，平台 optionalDependencies 由其包自带）；build-fpk.mjs 拷 `native/<triplet>/vec0.so` + `file` 架构自检；Dockerfile（bookworm）安装后验证平台子包；env.conf.example 加 GX_VEC_EXT_PATH/GX_EMBEDDING_* 注释段；三环境文档 + runbook musl 禁令/NFS 提示。
- 验收：darwin 本机 loadExtension + vec_version + 1 条 KNN（复现 spike exp1）；故意指向不存在路径→启动正常、vecAvailable=false、status fts 可用；`db.transaction(fn)()` 调用形态有单测防回归；search.db 删除后重启自举。
- 回滚：依赖移除与接线摘除；search.db 文件可弃。

### S3 — EmbeddingProvider
- offProvider（embed 抛 EmbeddingDisabled、health 恒 ok 不可向量化）；cloudProvider（§4.4）；embeddingConfig（env 种子 + app_settings AES-256-GCM：key=SHA-256(JWT_SECRET||"embedding-v1")，随机 IV，存 iv/tag/ciphertext）。
- 验收：off 态零外网（nock/拦截断言无请求）；cloud 用 mock server：批量 index 对齐、超时、5xx 重试、4xx 不重试、401 置 unhealthy、dim 不符拒绝；key 加解密往返；GET 不泄漏 key；typecheck/lint。
- 回滚：配置表保留无害；provider 摘除。

### S4 — worker
- 状态机/认领/退避/dead；chunks.ts 三族抽文本（记录拼接严格对齐 search.ts 旧匹配口径做对拍：同实体旧 includes 命中 ⇒ 新 chunk 文本命中；文档切块 h1-h3+滑窗；画布按元素含文本 1 chunk）；删除三表联动；向量欠账对账；GX_SEARCH_WORKER 开关。
- 陷阱：BigInt 漏绑整批回滚（spike 根因，单测覆盖每个 insert 点）；ROWID 三表一致；软删/恢复往返。
- 验收：播种事件消化到 0 积压；失败退避序列（假时钟）；dead@8；cloud 关时 FTS 完整、vec 欠账在开启后补齐；记录编辑合并去重（连改 5 次只 1 事件最新 version）。
- 回滚：worker off；事件表保留。

### S5 — 统一检索 v1（核心）
- 第一件事：spike §8.5-3 验证 vec0 KNN + rowid IN (JOIN 白名单) 的接受度/EXPLAIN/性能，证据入 gate；不满足走 §4.5 退路 B 并记录。
- query.ts（temp_scope 物化/三路/RRF/聚合/二次 decide）；rrf.ts 纯函数；routes/v1/search.ts；短词 LIKE 转义；MATCH 短语转义。
- 验收：权限对拍（逐实体 decide vs 检索命中集，scope 与 join 语义零差）；RRF 表驱动用例；EXPLAIN 含 scope 收敛；q 空/超长/特殊字符；SQL 计数有界（与库规模解耦的常量化断言）；M4 scope truncated 行为。
- 回滚：v1 路由摘除，旧端点无损。

### S6 — mask 摘要 + AC-M5-2 对抗
- snippets.ts 消费 M4 fieldCapability/maskedTableFields；matchedField 中性化；§4.6-4 存在性口径实现（待 B-3 确认）。
- 对抗：用无权内容**独特语句**搜索（PRD :273 原例），三种 mode 各断言零命中/零摘要泄漏；表级不可见整实体缺席；字段 mask 下 snippet 无原文、matchedField=null、title=record id；scope 与二次 decide 双层都在用（mock decide 拒绝时结果丢弃）。
- 回滚：随 v1 路由。

### S7 — admin + openapi
- adminSearch.ts 三端点（role_owner 口径）；reindex 双库切换；openapi 只增 search/admin/embedding schemas + 4 错误码；真实响应形状手写对拍（M3 S7 纪律，零新依赖）。
- 验收：非 owner 403；409 防重；dim 改 reindexRequired；yaml 合法 + 形状绿。
- 回滚：端点/文档摘除。

### S8 — 权限变更即时性
- 调岗（移出有权部门）下次搜索即不可见；收 direct/角色同理；继承中断后子孙文档立即从召回消失、重开恢复；move 跨继承边界后 scope 变化；policyVersion/navVersion 回传正确。全部无 reindex、无缓存等待。
- 回滚：测试。

### S9 — AC-M5-1 降级演练
- .so 缺失/改名（符号失败）/musl 容器静态论证+文档；cloud 断网/坏 endpoint/401/超时；dim 不符；rm search.db 自愈；worker kill -9 后积压恢复；reindex 中检索不中断（like 瞬态/旧库服务）；编辑主链路在上述各情形下全程可写并留时延证据。
- 回滚：测试/runbook。

### S10 — 规模与真机门
- bench 夹具扩造 10 万 chunk（三族按比例，记录宽表复用 M1 造数器）；开发机数据仅留档；**Tier-L 真机（x86 与 arm 各一，2C4G ext4）：混合检索 P95<500ms 十轮、索引灌库时长/主写影响、RSS/库文件大小；Tier-S 1 万-10 万流畅基线**；不达标的杠杆证据（降维 512 效果实测、scope 收敛比例、k 值曲线）；产出 m5-gate.md 与是否触发 LanceDB 评估的结论。
- 发版冒烟：目标机 vec_version + 1 KNN（spike §8.5-1）。
- 回滚：文档。

### S11 — 收口
- ADR（§10）；40RC 回归 + M5 新 RC；runbook 五章；baseline（678→预计 +N、迁移数、覆盖率、真机数据）；openapi/DTO 对拍 0 diff；M5-FE 输入清单评审；旧 `/api/search/` 零 diff 证明。

---

## 10. 关键设计决策（ADR 候选）

- **ADR-0041 独立 search.db 分库连接（非 ATTACH、非主库内虚表）**：spike §4 实测；Prisma 无法 loadExtension、备份单文件边界、WAL/锁解耦、可 rm 重建、LanceDB 替换面。
- **ADR-0042 同进程 outbox + 可重建派生库（主写零等待）**：change_events 同事务、worker 异步、退避 dead、reindex 扫表不依赖事件史；否决同步索引/双写搜索库。
- **ADR-0043 sqlite-vec 暴力 KNN 与降级一等公民**：无 ANN、BigInt/LIMIT/BLOB 三铁律、glibc/vec0.so 文件名约束、加载失败即 FTS+LIKE；50 万/500ms 阈值升级 LanceDB。
- **ADR-0044 embedding 收敛为 off/cloud 两态（取消本地模型）**：按 spike §6.2 最新裁决，推翻 ARCH §7.2 local（Xenova）；默认 off、不出域、无权重、无 Worker 推理；cloud 四与门与降级。
- **ADR-0045 先收敛后召回（temp_scope 物化 + RRF）**：AC-M5-2 的工程定义；否决先召回后过滤；二次 decide 纵深；scope 截断诚实标记。
- **ADR-0046 FTS5 trigram + 短词 LIKE 的中文策略**：实测 3 码元门槛；无词库；BM25+标题 boost+RRF；不引分词器。
- **ADR-0047 授权信息不入索引——权限变更零索引失效**：per-user 可见性完全由查询时 M4 scope 承担；版本号仅缓存失效；字段 mask 在摘要层最小泄漏（接 M4 A-4）。
- **ADR-0048 reindex 双库原子切换与派生库损坏自愈**：临时库 rebuild + rename；损坏隔离 + 自动重建 + 主库 LIKE 应急。
- **ADR-0049 embedding 凭据存储（env 基线 + AES-GCM 加密落库）**（待 B-2 裁决）：JWT_SECRET 派生密钥、零新加密依赖、只存在性回显。

---

## 11. 待项目总监裁决清单（终审前阻断）

| # | 议题 | 架构师建议 | 影响 |
|---|---|---|---|
| B-1 | record chunk 的 nodeId 挂 table 节点（M3 记录不建 nav 节点）是否与 M3 落地一致 | 挂 table 节点；S5 开工以 M3 nav sync 实现复核，若 M3 为记录建节点则改为记录节点（二选一在 S4 固化并对拍） | chunks schema/scope join |
| B-2 | embedding apiKey 是否允许设置页写入（加密存 app_settings），还是仅 env 配置 | 允许：env 种子 + AES-256-GCM（JWT_SECRET 派生）落库，只存在性回显；若总监要求纯 env，PATCH 对 key 字段 400、设置页只留 env 指引 | S3/S7/前端片 |
| B-3 | 记录仅"隐藏字段命中"（可见字段无命中）时该记录是否出现 | 建议出现（表级 r 即可见行存在，与 M4 列表一致），snippet 中性占位；若产品认为存在即泄漏，则需 per-user 字段倒排（推翻单派生库假设，工作量另计） | S6、AC-M5-2 口径 |
| B-4 | role_owner 作为 reindex/embedding 配置的管理权限口径（M2 无独立 admin 动作位）是否认可，还是新增第六枚组织动作 `manage_search` | 建议**不新增动作**（YAGNI），直接 role_owner；若要把检索管理授予自定义角色则需 manage_search（走 §4.10 同款清单第三次改动） | S7、§4.10 |
| B-5 | Tier-L 真机规格与提供方式（2C4G 是借用 M1 硬件门设备还是另备飞牛 x86+arm 两台）、验收轮次 | 需要总监/运维确认两台目标机与排期窗口；10 万 P95 门不过则默认 off+fts 发布、cloud 语义作高配能力（不阻塞 M7） | S10、发布承诺 |
| B-6 | reindex 是否允许 PATCH embedding/config 带 reindex:true 一步触发（长任务占 worker） | 建议分两步（配置返回 reindexRequired，管理员显式再调 reindex），防误触长任务；CLI 保留一步 | S7 |
| B-7 | worker 内嵌 API 进程（默认）外，是否要在 M5 提供独立 worker 进程开关形态（systemd 独立 unit） | 不做（单实例部署，ARCH-production 前提）；仅留 GX_SEARCH_WORKER 开关供排障；多实例时另立 | S4/部署 |
| B-8 | 前端搜索结果页是否在 M5 同里程碑随 M5-FE 交付（对齐 M4-FE 裁决 A-8） | 建议同里程碑，S7 后派工独立 M5-FE；否则新检索无 UI 入口、M7 无法人工验收 | 排期/M7 |

---

## 12. M5 出口 Definition of Done（摘）

1. AC-M5-1：vec 不可用/cloud 故障/损坏/kill 演练下自动降级 fts/like、主应用与编辑链路不受影响（有时延证据）；reindex 幂等（连跑两次等价、409 防重、双库切换无空窗）。
2. AC-M5-2：hybrid/fts/like 三态下"独特语句"对抗零泄漏；召回 SQL 全部 JOIN temp_scope（EXPLAIN 留证）；二次 decide 失配计数为 0；mask 摘要无原文、matchedField 中性、表级不可见整缺席。
3. 调岗/收权/继承中断/move 后下次搜索即变（S8 全绿），无 reindex/缓存等待。
4. outbox 同事务共生死、主写 P95 无回退；首启自动播种建索引；覆盖度对账 A-E=0 可复跑。
5. Tier-L 真机双架构 10 万 chunk P95<500ms（或如实记录不达标 + 降杠杆证据与降级发布结论）；Tier-S 1-10 万流畅；目标机 .so 冒烟过门；开发机数字只留档不作承诺。
6. openapi 冻结并对拍；ADR-0041~0049 归档；40RC 全绿；678+N/3、lint/typecheck/ci-quality；旧 `/api/search/` 字节零 diff；M1 flags 四组合/M2/M3/M4 回归全绿。
7. 密钥零泄漏审计（响应/日志/审计/库文件检查）；默认 off 下零外网连接抓包留证；runbook 五章齐备；M5-FE 输入清单可派工。

---

## 13. 切片速查（供派工 / RoleVerdict）

| ID | 标题 | 关键文件 | 独立验收（一句话） | 依赖 |
|---|---|---|---|---|
| S0 | 旧检索 golden + baseline | domain/search/__tests__；docs/baseline/2026-09-18-m5-baseline.md | 旧 search 快照锁住、678 只增 | — |
| S1 | outbox 迁移+接线 | 2 迁移；outbox.ts；records/kb/public 写点 | 每写点事件合并/删除正确、失败共回滚、主写无回退 | M3-S3 |
| S2 | SearchStore+vec0+打包 | searchStore/vecLoader/schema.ts；build-fpk；Dockerfile | .so 加载 KNN 通过、缺失降级启动正常、三平台产物含 vec0.so | S1 |
| S3 | Embedding 两态 | embedding.ts；embeddingConfig.ts | off 零外网；cloud 超时/重试/4xx/dim 行为正确；key 不明文 | S2 |
| S4 | indexer worker | chunks.ts；indexer.ts；scripts/search | 播种消化零积压、退避 dead、BigInt 全绑定、删除联动 | S1-S3 |
| S5 | 先收敛后召回+v1 搜索 | query.ts；rrf.ts；routes/v1/search.ts | scope 对拍零差、三 EXPLAIN 含白名单、RRF 正确（含 vec0 IN 首日验证） | **M4-S4/S1** |
| S6 | mask 摘要+零泄漏对抗 | snippets.ts | 独特语句三 mode 零命中、摘要无 mask 原文 | S5、M4-S6 |
| S7 | admin+openapi | adminSearch.ts；openapi.yaml | reindex/status/config 三端点 owner 限定、形状对拍 | S4/S5 |
| S8 | 权限即时失效 | __tests__ | 调岗/继承/move 下次搜索即变 | S5、M4-S7 |
| S9 | 降级自愈 | 演练脚本；runbook | 五类故障 fts-only 且主应用可写 | 全部 |
| S10 | 真机规模门 | bench；m5-gate.md | Tier-L 双架构 10 万 P95 留证（不达标给降级结论） | S5/S9 |
| S11 | 收口 | ADR-0041~0049；RC；runbook；FE 清单 | 全门绿、旧搜索零 diff、可派工 M5-FE | S10 |
