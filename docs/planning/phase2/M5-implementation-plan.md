# M5 向量库与统一检索 — 可执行实施切片（终稿，不改业务码）

- 日期：2026-09-16（七问裁决回填终稿；本文为**待项目总监复审后派工**的设计稿，复审通过前 DO NOT IMPLEMENT）
- 作者：架构师 高见远
- 状态：**设计稿终稿 / 待复审派工（DO NOT IMPLEMENT）**。本稿遵循在档 Accepted 决策 `PLAN-ADJUST-nas-min-hardware.md §4`，embedding 只做 **cloud / off 两态半**：cloud = OpenAI 兼容远端 API（配置了且管理员二次确认才启用），off = 未配置/显式关 → 纯 FTS5 trigram + 短词 LIKE，任何姿态关键词检索不瘫。**本期不做本地 embedding（无 transformers/onnx/模型权重/Worker 推理），接口保留 LocalEmbeddingProvider 未来位。**
- 适用代码基线：`main` @ `a4e1f50`（M4-S10 规模门/翻转演练已合，工作区实读；M4-S11 出口文档在途，开工以最新基线 rebase）；根 `package.json` v0.1.0。
- 上游依据：
  - **`PLAN-ADJUST-nas-min-hardware.md §4（2026-09-12，状态 Accepted）§4.1–4.3（:152-178）：embedding 唯一默认来源＝远端 OpenAI 兼容 API；不内置/不默认安装本地模型，删除本地权重/Worker Thread 推理/2C4G 本地模型 spike 前置；cloud/off 两态半，local 降为未来可选 provider（接口保留，未来加本地无需重构）；search.db 旁路与 FTS/RRF/先收敛后召回全部保留。本稿以该在档决策为最高依据，不修订该文档。**
  - `SPEC-enterprise-v1.0.md` §5 `:75`（`GET /api/v1/search?q=&mode=auto`，r）、`:76`（`POST /api/v1/admin/reindex`，admin job）、§6 `:87`（search.db 独立可 truncate、不进业务备份，主库仅 outbox/change_events）、§7 `:103`（设置→语义检索 + 重建）、AC-M5-1 `:123`、AC-M5-2 `:124`（召回前剔除无权 + **不索引字段物理缺席**）、P0 门 `:39`（10 万 chunk 量级越权零泄漏、kill 后降级 FTS）。SPEC `:52-53/:136` 中「本地模型默认」字样以 PLAN-ADJUST §4.1/§4.4 为准（该文档动作归 PLAN-ADJUST §4.4 另行处理，本稿不引 local 为依据、不改 SPEC）。
  - `ARCH-enterprise.md` §7.1–7.7（`:613-745`）outbox / provider 抽象（§7.2 含 LocalEmbeddingProvider 未来位）/ sqlite-vec / FTS5 trigram / 三族 chunk schema / RRF / 即弃原则；§10.4 ADR-0016/0017 槽位。
  - **硬约束实测来源：`spike-sqlite-vec.md`（2026-09-14）**。其 §0 五事实为不可重议的工程约束（§1.2）；spike §6.2 的 cloud/off 收敛结论与本稿一致，sqlite-vec/FTS 全部实测有效。
  - 2026-09-18 cloud/off 两态稿（B-1~B-8）的非 local 结论本稿全部继承：search.db 分库、先收敛后召回、双库切换、role_owner、apiKey 加密、内嵌 worker 唯一形态、M5-FE 同里程碑。

> **硬依赖与纪律（排期：后端单线 M2→M3→M4→M5，未派工不得开工）**：检索链路依赖 **M3-S1（nav_nodes）** 与 **M4-S4（`domain/authz/scope.ts` 契约冻结）+ M4-S1（engine.decide）+ M4-S6（fieldMask 五出口）**——三者在 `a4e1f50` 均已落地，开工仍须逐点复核签名。M5 不得改 M2/M3/M4 文件，**唯一例外**：在 M3/M4 已登记的实体写点所在事务内**追加一行 outbox INSERT**（S1 单独成 PR，触碰点清单在 PR 描述单列）。本阶段只产出本文档，不改任何 `.ts` 源码、不动其他文件。

---

## 0. 结论先行

### 0.1 形态定稿

1. **主库 `change_events` outbox（手写迁移，同事务）+ 独立 `search.db`（裸 better-sqlite3，不经 Prisma、不 ATTACH）+ 同进程单例 worker 异步消化**。主写事务只多一条同库 INSERT；FTS/embedding/vec0 全部异步，主链路零等待（PRD V2）。search.db 物理独立、可整文件删除重建、永不进业务备份（现备份只备 `DATABASE_URL` 单文件，`scripts/backup/online-backup.mjs` 的源文件解析口径天然不含 search.db，§1.6）。
2. **Embedding 两态半 `cloud | off`（PLAN-ADJUST §4），出厂默认 `off`**：
   - `cloud`：OpenAI 兼容 `POST /v1/embeddings` **单一契约**（全局 fetch，不引 SDK、不做任何非兼容供应商专用 adapter），baseURL 可指向通义/豆包/混元/Jina/内网 vLLM/网关等任意兼容端；切 cloud 需**管理员显式配置 + 二次确认**；key 仅 env/加密配置、600 权限、不入日志/审计/响应/派生库。
   - `off`：不向量化、不查向量；检索 = FTS5 trigram + 短词 LIKE，开箱零外网零 key。**未配置远端即 off。**
   - **MVP 不暴露 dimensions/MRL 参数**：向量维度由所选 model 的元数据决定（首次成功 embed 按返回向量长度落 `index_meta.embedding_dim`），降维靠选模型；model 变更导致 dim 变化必须全量 reindex（两步重建，§5.4）。
   - 两态共用同一 EmbeddingProvider 接口、同一 search.db / RRF / 权限收敛。**接口按 ARCH §7.2 保留 `LocalEmbeddingProvider` 未来位**：未来加本地模型 = 新增一个 provider 实现 + optionalDependencies 并 opt-in，接口/search.db/RRF/权限收敛零改动（与备份通道同构的「未来平滑增加、无需重构」）。
   - **注意保留点**：cloud embedding 的向量仍存本地 search.db 跑 sqlite-vec 暴力 KNN，所以 2C4G 的 **KNN 扫描/存储账仍要真机门**（§0.4、S13），只是没有本地推理账。
3. **「先收敛、后召回」是 AC-M5-2 的工程定义**：每查询先调 M4 冻结的 `resolveVisibleNodeIds(user,{actions:['r'],kinds})` 实时求可见 nodeId 集，物化为 search.db 会话临时表 `temp_scope`；FTS / LIKE / vec 三路都**只在该集合（及字段授权子集）内召回**；融合出参前再用 `engine.decide` 逐实体二次校验。**无权 id 不进入任何一路召回，不可能占满 top-k**。≥500 节点或 `truncated=true` 时 M4 契约即 `expectsTempTable=true,sql=""`，M5 必须物化临时表 JOIN，禁超长 IN（SQLite 999 变量上限）。
4. **fieldMask「物理缺席」= 写入侧「身份 chunk + 字段 chunk」拆分 + 查询侧字段授权召回前排除（Q4 已裁决采纳）**（§4.7）。表级不可见节点整体不被任何一路召回（temp_scope INNER JOIN）；被某主体 mask 的字段，其字段 chunk 对该主体在 **FTS MATCH / vec KNN 之前**就被 `field_grant` 收敛排除（非召回后过滤），不进候选、不进摘要。**不做**授权域分片索引、不做落盘加密（过度复杂）；search.db 是同机可重建派生产物的边界在 runbook 与 ADR-0048 写明。
5. **降级是一等公民**：vec0 `.so` 缺失/加载失败、cloud 401/超时/连续失败、dim 不符、search.db 损坏——全部 catch 后自动回落 FTS5+LIKE，主应用与编辑链路零影响、有状态标识（status 端点 + 启动 warn + 审计），不进 /readyz 硬探针（可降级资产故障不应摘流）。
6. **性能门分级，开发机数字不冒充 NAS 承诺（Q2 已裁决）**：spike 在 Apple M5/16GB 实测 **100k×1536 维 KNN p95≈113ms、库 ≈592MB、RSS≈86MB**——**仅留档，绝不写进对外承诺**。**Tier-L 2C4G（x86 + arm 各一）真机实测后定档**，S13 交付「可流畅 chunk 上限 + RSS + 库大小 + KNN p95」**参考画像**，不给跨硬件硬 500ms 承诺；超档在 status/UI 确定性提示并引导收紧 scope/降 k/关向量；chunk > 50 万或目标机持续超标才立项 LanceDB（provider/indexer 接口不变）。cloud 模型维度由所选 model 决定，存储预算随真机维度实测。
7. **切片 S0–S14 共 15 片**（原三模式稿 S4 local 片取消——不是 spike-gated，是**本期不做**；原 S5-S15 顺延为 S4-S14，依赖图/§17 速查表/§14 测试与迁移影响已同步），纯函数先行（chunk / RRF / 查询规划 / scope 物化 / 字段授权）、全程 `GX_M5_*` flag **默认 off**、shadow 对拍旧搜索再切。
8. **新增运行时原生面只有一个**：`sqlite-vec@0.1.9`（vec0 `.so`，glibc、文件名恒 `vec0`，optionalDependencies + 平台打包 + 失败降级）。**不引入** `@huggingface/transformers`、`onnxruntime-node`、模型权重、Worker Thread 本地推理。cloud/off 均无额外原生依赖。
9. **搜索端点版本化**：新检索走 `GET /api/v1/search`（挂 v1 `requireActiveUser` 链）；旧 `/api/search`（`routes/search.ts`，160 行，成员循环 + 有界预览）M5 **字节不动**——S0 以真库 golden 快照字节锁住，M5 全程旧路由零 diff，前端切新端点在 M5-FE。回滚 = v1 路由摘除 / flag off。
10. **两层门保证「代码合入绝不等于对存量用户开建库/出网」（Q6 已裁决）**：实施期 `GX_M5_SEARCH=off`（纯函数先行 + shadow 对拍旧 `/api/search`，连续一迭代 drift=0 才 on，与 M1/M4 同款）；切 on 后 `GX_EMBEDDING_MODE` 出厂默认 `off`，cloud 必须管理员显式配置 + 二次确认才启用。**off 态零外网须抓包留证（S12）。**
11. **chunk 放大确定性软上限（Q7 已裁决）**：单记录 field chunk 只取前 N 个可搜索字段（S3 先给常量 **N=50**，S13 真机门用宽表造数器数据校准），按字段类型确定性取舍（文本类优先、非可搜索类型不建 field chunk，平局按字段创建顺序）；超上限的记录数在 status/计数里可见、N 在 admin 可配，**不静默、不随机丢**。

### 0.2 spike 硬事实→工程约束（不可重议，实测来源 spike-sqlite-vec §0/§1-§5）

| # | 硬事实（实测） | M5 工程约束 |
|---|---|---|
| H1 | better-sqlite3@13.0.3 内建 SQLite 3.53.4，直接 `db.loadExtension()`，无 `enableLoadExtension` 开关，无需自编译 | SearchStore 初始化直接 load；FTS5/trigram 同连接可用 |
| H2 | bsc13 把普通 `number` 绑成 `REAL`，仅 `bigint`→INTEGER；vec0 rowid 与**所有 integer metadata 列**严格要 INTEGER，传 number 报 `Only integers...`/`received FLOAT` 且**同事务整批回滚** | vec0 全部整数绑定走 `BigInt`；每个 insert 点有类型单测；code review grep |
| H3 | 向量仅接受 **Float32Array 字节 BLOB**（Buffer），JSON 数组文本未走通 | 统一 `Buffer.from(ta.buffer)` 绑定，禁 JSON 文本 |
| H4 | KNN 必须带 `LIMIT`/`k=?`，否则报错；vec0 **无 ANN、暴力全扫**，EXPLAIN 恒 `SCAN ... USE TEMP B-TREE`，延迟随 chunk 数近线性 | KNN 封装强制 LIMIT；规模按暴力扫预算；>50 万或真机 P95 持续超标走 LanceDB ADR |
| H5 | Prisma 主库与裸驱动 search.db 同进程互不干扰、文件独立、扩展连接级隔离、可整文件 rm 重建 | 独立 SearchStore；vec0 只加载在 search 连接；reindex 可删/换文件 |
| H6 | sqlite-vec 按 os/cpu optionalDependencies 拆 5 包；linux-x64 .so 需 GLIBC≤2.14、arm64≤2.17，仅依赖 glibc；**无 musl/Alpine、无 32 位** | Docker 锁定 node:22-bookworm（禁 alpine）；fpk 目标机/buildx 内安装；不兼容平台纯 FTS |
| H7 | 入口符号按**文件名**推导，改名 `vec0.so` 即 `dlsym ... symbol not found` | 产物文件名恒 `vec0.so/.dylib/.dll`，按 triplet 分目录而非改名 |
| H8 | 加载失败是**可捕获异常**，不 crash 进程 | try/catch 置 `vecAvailable=false`，正常启动降级 |
| H9 | FTS5 trigram：中文/拉丁 **≥3 码元**才命中，2 字词命中 0；前缀可用 `term*` | 查询规划按码点长度分流：≥3 MATCH，<3 参数化 LIKE；用户输入统一短语转义 |
| H10 | `db.transaction(fn)` 返回函数，须再 `fn()` 才执行（漏写静默不执行） | 封装 SearchStore 写事务的 helper 内置调用并命名区分，单测防回归 |

### 0.3 与既往决策的冲突登记（七问已全部裁决，见 §15）

- **C-EMB-1（已裁决）**：2026-09-16 派单曾引用过期的三模式 SPEC 口径，与在档 Accepted 的 `PLAN-ADJUST-nas-min-hardware §4`（记录主理人 2026-09-12 原话「向量暂不考虑本地模型、仅远端 API」，并明确删本地模型/权重/ONNX 运行时/2C4G 本地 spike 前置）冲突。**裁决：遵循在档 PLAN-ADJUST §4，不修订该文档，M5 稿回归 cloud/off。** local 不是 spike-gated，是本期不做；`LocalEmbeddingProvider` 仅保留接口未来位。ADR-0045 按此改题、Status=Accepted。
- **C-MASK-1（Q4 已裁决）**：采纳「身份 chunk + 字段 chunk + field_grant 召回前排除」方案（§4.7）；不做授权域分片/落盘加密；search.db 可重建派生产物的威胁模型写进 runbook 与 ADR-0048。
- **C-GATE-1（Q2 已裁决）**：不给跨硬件硬 500ms 承诺，改 Tier-L 真机参考画像（可流畅 chunk 上限 + RSS + 库大小 + KNN p95），开发机数字仅留档；超档确定性提示 + 收紧 scope/降 k/关向量；chunk>50 万或持续超标立项 LanceDB。

### 0.4 门不过时的发布姿态（Q2 终稿）

- **cloud embedding 下向量仍在本地 search.db 跑暴力 KNN**，故 2C4G 目标机的 KNN 扫描/存储账保留真机门（S13），只是没有本地推理账；云端模型维度由所选 model 决定，存储预算随真机维度实测。
- 若 KNN 在 Tier-L 目标机超参考画像：优先收紧 scope/调小 k/关向量（off 纯 FTS/LIKE），status/UI 确定性提示档位与引导；**chunk > 50 万或目标机持续超标才立项 LanceDB**（provider/indexer 接口不变）。
- vec0 在不兼容平台（musl/老指令集）加载失败：纯 FTS/LIKE 服役，不发版阻塞。
- **任何姿态下系统都必须有关键词检索可用**（trigram+LIKE 不依赖任何原生扩展/外网）。

---

## 1. 现状证据（2026-09-16 于 a4e1f50 工作区实读；开工逐点复核）

### 1.1 旧检索（S0 锁现状，M5 不重写该文件）

| 事实 | 证据（已核对） |
|---|---|
| 全局搜索单文件、成员循环 + 有界内存预览 | `routes/search.ts:47-160`：records 支路遍历 `prisma.member.findMany`（:58-61）→ 每 base 每表 `field.findMany`（:72-75）→ 每表仅取 `SEARCH_PREVIEW_LIMIT` 条活记录（:79-83，ADR-0005 有界预览注释 :77-78）→ 内存 `includes`（:90-101）；docs 支路遍历 `kbMember.findMany`（:122-125）→ Prisma `contains` 查 title/searchText（:128-137） |
| 响应形状 | `{records: RecordHit[], docs: DocHit[], ...boundedPreviewMarker}`（:156）；RecordHit :27-37（type/baseId/baseName/tableId/tableName/recordId/title/snippet/matchedField），DocHit :38-45；空 q 直接 `{records:[],docs:[]}`（:51） |
| 计算字段不入搜索 | `isComputedFieldType` 过滤（search.ts:76）；记录主标题取 primaryFieldId 值（:86-87）；LinkRef 标题取对象 `title`（:93-95） |
| 旧搜索不读 nav/策略 | grep 确认 search.ts 无 auth_policies/nav_nodes/scope 引用——AC-M5-2 须由 v1 新链路封口 |
| kb 库内限定搜索 | `routes/kb/docs.ts` 与旧 `/api/kb/:kbId/docs?q=` 的 Prisma `contains` 口径；M5 不动该端点 |

### 1.2 M4 权限契约（M5 只消费，不重造）

| 能力 | 证据（a4e1f50 实读） |
|---|---|
| 可见集求解 | `domain/authz/scope.ts:148` `resolveVisibleNodeIds(client,userId,opts)`：opts `{actions?,kinds?,budget?,workspaceId?}`；返回 `VisibleScope`（:28-45）含 `nodeIds[]`、`resourceIdsByType`、`truncated`、`policyVersion`、**`maskedTableFields: Record<tableNodeId, allowFields[]>`**（:37，r 动作且表节点命中带 allowFields 的 r 策略时收集，:125-142）、`budget/evaluated/visibleTotal`、`sql: VisibleScopeSql` |
| 预算与临时表阈值 | `scopeSql.ts`：`DEFAULT_SCOPE_BUDGET=5000`（:12）、`MAX_SCOPE_BUDGET=20000`（:14）、`SCOPE_IN_BATCH=499`（:9）；`buildVisibleScopeSql`（:46）：0→`sql=""`；1..499 且未截断→`"?,?.."`；**>499 或 `truncated=true`→`expectsTempTable=true,sql="",batches=[]`**（:50-52）；`EMPTY_SCOPE_PREDICATE="1=0"`（:62） |
| ScopeKind 全集 | scope.ts:25-26：`base|kb|table|view|doc|canvas|group`（**无 record/field 节点**——记录挂表节点，见 §4.5 B-1） |
| 零分叉内核 | scope 复用 `evaluate.evaluateChainDecision`（scope.ts:120），与单节点 decide 同内核；截断按 `(path,id)` 确定性排序（:177） |
| 单实体/批量决策 | `domain/authz/engine.ts:82` `decide(deps,subject,nodeId,action,ctx)`（返回 `{decision,node,chain,policies,capability}`）、`:102` `decideMany(deps,subject,nodeIds,action,ctx)`（共享链缓存顺序 decide） |
| 字段能力 | `domain/authz/fieldMask.ts:62` `fieldCapability(policies)`→`{visible,visibleAll,visibleFields:Set|null,...}`；`:94 canSeeField`；记录字段投影 `applyMaskToRecords`（:143）；**注意 :192 注释：recordService 搜索以 visibleFields 为可搜域、隐藏列不入其内存搜索**——M5 物理缺席与此同源 |
| 探针现成样例 | `routes/v1/scope.ts:25` `GET /api/v1/authz/visible-scope` 直接调 `resolveVisibleNodeIds(prisma,...)`（:49），M5 接线照此取 prisma 为 client |

### 1.3 可复用索引文本来源

| 事实 | 证据 |
|---|---|
| Markdown 去标记 | `domain/kb.ts:7-21` `markdownToSearchText` |
| 画布 JSON 文本 | `domain/kb.ts:28-57` `canvasToSearchText`（递归 text/label/content/title/name 五键，深度 12、2000 值、截 50k）；`buildSearchText(kind,content)` :60-62。**canvas 元素级 chunk 需改为按元素遍历产出，见 §4.6** |
| 文档已冗余 searchText | `KbDoc.searchText`；写点 `routes/kb/docs.ts:171`（PUT content 构 searchText）、匿名公开写 `routes/public.ts:270-273`；版本快照亦存 searchText |
| 记录字段值 | `record.fields` JSON；LinkRef 标题拼接规则见 search.ts:93-95 |
| chunk 粒度依据 | ARCH §7.5（`:717-723`）：文档 h1-h3 粗切 300-512 字 overlap64、画布每含文本元素 1 chunk；本稿记录侧身份/字段拆分见 §4.6/§4.7 |

### 1.4 主写事务点（outbox 同事务插入位置，§5.2 全量清单）

| 族 | 写点（a4e1f50 实读，行号以开工为准） |
|---|---|
| 记录 create | `routes/records.ts:450` `withWriteTx("record.create", tx => … tx.record.create :458)` |
| 记录 patch | `:678` `withWriteTx("record.update", … tx.record.update :681)`；批量 `:854` `withWriteTx("record.bulkUpdate", … tx.record.update :857)` |
| 记录软删（含链接行） | `:738-742` 区（当前 `prisma.record.update` 裸 Prisma + 链接行 update，**S1 须最小包进 withWriteTx 或同连接事务再挂 outbox**）；批量软删 `:794-800` |
| **一处裸写** | `records.ts:223` `await db.record.update(...)`（旧门面，S1 归类入事务） |
| 子表/行创建 | records.ts 内 `tx.*` 写点（S1 grep `withWriteTx` 全收） |
| 文档/画布内容 | `routes/kb/docs.ts:176` `withWriteTx("doc.content.save", …)`：乐观锁分支 `tx.kbDoc.updateMany :186`（count=0 抛 VersionConflictError :192）、无版本分支 `tx.kbDoc.update :196`；`:200` 已挂 `syncNavFromEntitiesTx(tx)`（**outbox 原语挂在其旁，同 tx**） |
| 文档建/移动/改名 | `routes/kb/docs.ts:88` `tx.kbDoc.create`；树移动 `:230/:248` `tx.kbDoc.update`（**仅移动不改文本→不发内容事件**，scope 侧处理） |
| 文档软删/恢复 | `routes/kb/docs.ts:269`（deletedAt=now）、`:291`（恢复）；kb 整库删 `routes/kb/index.ts:151` `tx.kbDoc.updateMany` |
| 匿名公开写 | `routes/public.ts:271-273`（ANON 也发 outbox，实体存在即索引） |
| 表删除/级联 | 以 M3 purge/sync 语义为准，挂 `syncNavFromEntitiesTx` 同事务回调，按 tableId 批量 delete 事件 |

### 1.5 数据库/连接设施

| 事实 | 证据 |
|---|---|
| Prisma 单例 + 写串行门面 | `db.ts:82` prisma 单例；`withWriteTx :117` / `runWrite :129` / `withWriteBatch :138`（并发 1，outbox INSERT 必须走传入 tx）；`dbReady :95` PRAGMA 收口 |
| 裸 bsc 只读先例 | `db/rawRead.ts:126` `openRawReader(file)`（`readonly:true,fileMustExist:true,timeout:5000` + `busy_timeout=5000` :128）；单例 `getRawReader :142`；绑定类型含 bigint/Buffer；库路径 `resolveDatabaseFile(config.databaseUrl, dirname(migrationsDir))` :138 |
| readyz 五探针 | `ops/readiness.ts:21-26` CheckName（dbPing/dbWritable/migrations/uploadsWritable/disk）、`:89` CHECK_ORDER；**M5 不加硬探针**；migrations 探针按磁盘迁移与 `_prisma_migrations` 对账（:56+），故 search.db 自举 DDL 绝不能进 Prisma 迁移目录 |
| v1 挂载/鉴权 | `app.ts:143-151`（enterpriseOrg||enterpriseNav 才 `mount.route("/api/v1",v1)`，公开邀请挂前）；`routes/v1/index.ts:25` `v1.use("*",requireActiveUser)`；子路由按 flag 条件挂（org :31、nav :48）。**M5 search 路由照此加 `config.enterpriseSearch` 门**，未启用落 v1 404 |
| 限流 | /api 前缀兜底（M0 S5b 内存固定窗）覆盖 `/api/v1/search`；检索为读，不另设配额 |

### 1.6 配置/标志/信封/审计/备份/部署先例

| 事实 | 证据 |
|---|---|
| config 结构 | `config.ts:165-214` AppConfig；`dataDir :172`（prod `/var/lib/gouxiangdb` :218-219，search.db 默认放此）；enterprise 布尔 flag :186/:193；env 解析 :216-250 |
| 三态 flag 成熟形态 | `domain/queryPlan/flags.ts:16-30`（未知值保守回 off、组合可用性「读依赖写」判定）——embedding 与门判定同构 |
| 错误信封 | 成功资源本体、错误 `{error,code}`（不切信封）；M5 只增错误码 |
| 审计 | `audit/audit.ts:9` AuditEventName 硬编码联合 + 敏感键脱敏；M5 只增事件名，apiKey 不入 detail |
| 在线备份只备主库 | `scripts/backup/online-backup.mjs` 源文件由 `DATABASE_URL` 解析后 `.backup()` 单文件；search.db 文件名不同天然不进备份，无需改脚本（runbook 声明可重建资产不备） |
| fpk 构建铁律 | `deploy/fnos/build-fpk.mjs`：强制 Linux 同架构机/buildx 内安装、平台 prebuild 自检；vec0.so 照 better-sqlite3/prebuilds 同构显式拷入 + `file` 架构自检 |
| Docker | node:22-bookworm（glibc，满足 H6）；**runbook 写死禁换 alpine/musl** |
| esbuild 扁平产物 | M0 S2；**不依赖运行时 `require.resolve` 原生子包**，构建显式拷贝（vec0.so） |
| openapi | `docs/api/openapi.yaml`（M3 冻结、M4 增补）；scope 枚举已在 :206/:868 提到「M5 物化 search.db 临时表」；M5 只增 search/admin/embedding schemas |

### 1.7 cloud embedding 契约核实（2026-09-16；S4 首日以 mock/真兼容端复验）

- 单一契约：`POST {baseURL}/v1/embeddings`，Header `Authorization: Bearer <key>`，body `{model, input:[...], encoding_format:"float"}`；响应 `data[].index` + `data[].embedding`（按 index 对齐回序）。通义/豆包/混元/Jina/内网 vLLM/网关的 OpenAI 兼容模式均同此形；**本期不做任何非兼容供应商专用 adapter、不引 SDK（全局 fetch）**。
- **维度不配置**：OpenAI 兼容面无统一可靠的 model 元数据端点，故 MVP 不暴露 dimensions/MRL 参数；dim 以**首次成功 embed 返回向量长度**为准，写入 `index_meta.embedding_dim` 并据此建 vec 表；管理员改 model 后若响应 dim 与库不符 → dim_mismatch + reindexRequired（两步重建，§5.4）。
- 远端口径 P95 取决于网络与远端 SLA，产品上不做统一硬毫秒承诺（PLAN-ADJUST §4.3）。

### 1.8 测试 / 迁移 / ADR 基线

- 迁移目录 **20 个**（最新 `20260916130000_owner_manage_share`；M4 gate 文档 `docs/baseline/2026-09-16-m4-gate.md:65` 记录 17→20 过程）。**M5 第一个主库迁移编号 #21，排在全部 M4 迁移之后。**
- 测试：M4 收口点 api **86 文件 1008 passed / 3 skipped**（`2026-09-15-m4-baseline.md` 权威值；S10/S11 又增测试，S0 开工重跑取真值，本文不臆断）；shared-types 56。
- ADR：`docs/adr/` 实际到 0025（另有 M2/M3/M4 计划占用 0022–0041）；M6 计划起占 **0051–0055**。**M5 候选 ADR 固定为 0042–0050（§11）**，ADR-0045 已按 PLAN-ADJUST §4 改题为 cloud/off 终稿口径、Status=Accepted。

---

## 2. M5 范围边界

### 2.1 必做（SPEC M5 + V1-V6 + AC-M5-1/2，cloud/off 两态半）

1. 主库 outbox `change_events`（手写只增迁移 #21/#22）+ records/kb/public 文本写点同事务 INSERT（合并去重）。**这是本期唯一允许触碰 M2/M3/M4 既有写点事务的例外，S1 单独成 PR。**
2. 独立 search.db：SearchStore 单例（chunks + fts_chunks + vec_chunks + field_grant + index_meta），CREATE IF NOT EXISTS 自举、不经 Prisma、可整文件重建；vec0 加载失败可捕获降级。
3. **两态半 EmbeddingProvider**：cloud（OpenAI 兼容单一契约、全局 fetch、批量/限流/超时/重试/health）、off；维度随 model 元数据（首响应落库），model/dim 变更全量 reindex。**接口保留 LocalEmbeddingProvider 未来位（本期不实现、不打包、不进部署清单）。**
4. indexer 同进程 worker：单例认领（批 50、pending/processing/done/failed/dead）、三族抽文本（含身份/字段拆分 + N=50 软上限）、FTS 写入、cloud 模式向量化写 vec0、失败退避 10s/1m/10m/1h、attempts≥8 dead、删除四表联动、向量/字段覆盖度对账。
5. 统一检索 v1：`GET /api/v1/search`，先 scope 收敛（temp_scope + field_grant）→ FTS/LIKE/vec 白名单内三路召回 → RRF → 实体聚合 top20 → engine.decide 二次校验 → mask 摘要；回 mode/degraded。
6. 字段级零泄漏（AC-M5-2，Q4 定稿）：写入侧身份/字段 chunk 拆分，查询侧 field_grant 召回前排除（§4.7）。
7. reindex 与可观测：`POST /api/v1/admin/reindex`（role_owner、幂等、双库原子切换）、`GET /api/v1/admin/search/status`、`GET/PATCH /api/v1/admin/embedding/config` + apiKey rotate/DELETE（均 role_owner）；切 cloud 二次确认。
8. 降级与损坏自愈（AC-M5-1）：vec0 缺失、cloud 401/超时/连续失败、dim 不符、search.db 损坏——全部 fts/like，主应用零影响；search.db 损坏隔离重建。
9. 真机资源门（§13 S13）：Tier-L x86+arm 2C4G 上 **KNN 扫描/存储资源账（暴力 KNN P95 + RSS + 库大小 + 可流畅 chunk 上限参考画像）** + Tier-S 1万-10万流畅基线；EXPLAIN 证据；数据进 baseline。云端 embedding 无本地推理账。
10. openapi 增补冻结 + M5-FE 契约清单（搜索结果 UI、设置→语义检索 off/cloud、reindex/覆盖率面板）。
11. 审计 + runbook（vec0 加载失败、musl 禁令、search.db 可重建资产边界与文件权限、reindex、NFS、model 切换 reindex、积压排查、off 零外网抓包）。

### 2.2 明确不做

| 不做 | 归属 / 原因 | M5 临时姿态 |
|---|---|---|
| **本地 embedding（transformers.js/onnxruntime/模型权重/Worker Thread 推理）** | **PLAN-ADJUST §4 在档决策：本期不做** | cloud/off 两态；EmbeddingProvider 接口保留 LocalEmbeddingProvider 未来位，未来加本地＝新增 provider 文件 + optionalDependencies，零重构 |
| reranker / 多模态 embedding / 向量集群 | SPEC :39 Out | 无 |
| 可配置任意模型维度（dimensions/MRL 参数） | Q5 裁决：MVP 不暴露 | dim 由所选 model 元数据决定，降维靠选模型 |
| 非 OpenAI 兼容供应商专用 adapter | Q5 裁决 | baseURL 指任意兼容端；不适配的不支持 |
| ANN（LanceDB/Qdrant） | 阈值触发另立 ADR（chunk>50 万或真机持续超标） | 暴力 KNN，接口按可替换设计 |
| 授权域分片索引 / 落盘加密 | Q4 裁决：过度复杂 | 召回前排除 + 可重建资产威胁模型（§4.7/ADR-0048） |
| 旧 `/api/search` 重写/下线 | 旧 /api 统一下线切片 | 字节不动（S0 golden 锁住），v1 并存 |
| kb 内 `?q=` 改造 | 不做 | 保留 Prisma contains |
| 字段级「标记不参与语义索引」管理 UI（V5 P1） | P1 | 收录集=非计算可搜索字段按 N 确定性截断；可见性靠 M4 mask + §4.7 |
| 记录级过细分块（每句多 chunk） | 二期 | 身份 chunk 1 + 前 N 个可见字段 chunk（§4.6） |
| 搜索建议/拼音/同义词/CRDT | 不做 | trigram 已覆盖部分模糊 |
| 多工作区隔离 | Out（ws_default） | workspaceId 列照建，值恒默认 |
| 备份 search.db | 可重建派生产物 | runbook 声明不备、reindex 随时重建 |
| 内置 AI 聊天/问答 | M6 后 | M5 只交付检索，M6 MCP 消费 |
| 独立 worker 进程/systemd unit | 单实例内嵌（旧 B-7 继承） | 仅 `GX_SEARCH_WORKER=on/off` 排障 |
| M5-FE 前端实现 | 独立片，S9 契约冻结后派 | 本文只给 §10 契约 |

---

## 3. 不能动的契约（Characterization 先锁）

1. **旧 `/api/search` URL/响应/有界预览语义字节不变**：S0 对空 q/记录命中/doc 命中/boundedPreviewMarker/计算字段不入选做真库**字节级 golden 快照**，整个 M5 该文件零 diff（CI 加 golden 比对）。
2. **主写链路时延不回退（V2/AC-M5-1）**：outbox 只许是业务写事务内一条同库 INSERT（Prisma 同库，**search.db 写绝不进主事务**）；基准门：record.create 与 PUT content 在 S1 前后 P95 差值在噪声内（写队列串行下额外 1 INSERT 预期 <1ms，bench 留证）。outbox INSERT 是唯一允许触碰既有写点事务的例外，S1 PR 单列触碰清单。
3. **主库方言纪律不变（SPEC :60）**：change_events/手工配置表只增、幂等回填、发布前快照、30 分钟回滚、不写 SQLite 专有函数；**search.db 的 FTS5/vec0 DDL 是派生库自举语句，不进 Prisma migrations / `_prisma_migrations`**（否则 readiness migrations 探针 MISMATCH）。
4. **M4 契约只消费不改**：以 §1.2 在库签名为准；M5 不 import guards.ts/kb.ts 旧守卫做检索鉴权，v1 第一天只认 M4 引擎 + scope（与 M6 同纪律）。
5. **降级不改变可见性语义**：hybrid/fts/like 三态、cloud/off 两模式共用同一 scope + field_grant 收敛结果；降级只损失召回能力，绝不放宽权限（AC-M5-2 在三 mode×两 provider 组合下分别对抗）。
6. **Embedding 密钥不出服务端**：cloud apiKey 只从 env / AES-256-GCM 加密配置读；响应只回 `{configured,source,maskedLast4}`；不入审计 detail、日志、search.db、openapi 示例；JWT_SECRET 轮换致库存密文不可解时回落 configured:false 而非 500。
7. **search.db 单写者**：worker 是唯一写连接；reindex truncate/换文件与 worker 认领用同一进程内锁 + index_meta 标记；检索连接只读（仿 rawRead）。
8. **信封/限流/安全头/bodyLimit 不切**：search GET 无 body；reindex POST 走默认 1MB。
9. **可重建即弃**：search.db / index_meta 任何损坏可删文件 + reindex 恢复；reindex 以「扫主库活实体」为准，不依赖 change_events 永久历史（§5.5）。
10. **默认姿态零侵入**：所有 `GX_M5_*` / `GX_EMBEDDING_*` 默认态对旧功能零新增查询、零外网、零 vec0 加载；search.db 与 worker **懒初始化**，首次需要才创建/启动。未启用企业搜索面时行为与现状逐字节一致。
11. **off 态零外网**：`GX_EMBEDDING_MODE=off`（出厂默认）下任何路径不得发起 embedding 外网请求，S12 经代理抓包留证；cloud 仅在管理员显式配置 + 二次确认后才允许出网，baseURL 之外零外联。

---

## 4. 架构与数据模型

### 4.1 总览（ASCII）

```
                         主库 main.db（Prisma，WAL，串行写队列）
 ┌────────────────────────────────────────────────────────────────────┐
 │ records / kb_docs（+ M3 nav_nodes / M4 auth_policies）              │
 │  业务写事务 withWriteTx                                              │
 │    ├─ 同事务 INSERT change_events(outbox)   ← S1（主库唯一新增表）    │
 │    └─ M3 syncNavFromEntitiesTx / M4 policyVersion bump（既有，不动）  │
 └───────────▲───────────────────────────────┬─────────────────────────┘
             │ 裸 bsc 只读连接（仿 rawRead）   │ Prisma client（scope/decide）
             │ ① worker 认领事件/拉实体文本    │ ② 检索时 M4 scope 实时求解
             ▼                                ▼
 ┌────────────────────────────────────────────────────────────────────┐
 │ indexer worker（同进程单例，串行；不阻写队列；GX_SEARCH_WORKER 开关） │
 │  认领批50 → 抽文本 + 身份/字段 chunk 拆分（§4.6，前 N=50 字段）       │
 │   → 写 fts_chunks / chunks / field_grant                            │
 │   → EmbeddingProvider.embed（cloud fetch | off 跳过）               │
 │        cloud: OpenAI 兼容 POST /v1/embeddings，Bearer，二次确认     │
 │               dim 取首响应长度，不暴露 dimensions 参数              │
 │   → 写 vec_chunks（BLOB Float32，整数全 BigInt，强制 LIMIT）        │
 │  off/cloud 失败：FTS 照写，向量退避/欠账对账                         │
 │  退避 10s/1m/10m/1h，attempts≥8→dead                                │
 └───────────┬──────────────────────────────────────▲─────────────────┘
             │ 单写连接(bsc,WAL)                      │ provider health/配置
             ▼                                        │
 ┌───────────────────────────────────────────────────┴────────────────┐
 │ search.db（独立文件 config.dataDir/search.db，可 rm / 双库切换）     │
 │  chunks(rowid PK, chunkId UNQ, entityType, entityId, nodeId,         │
 │         workspaceId, kind(identity|field), fieldId?, title, seq,     │
 │         version, length, updatedAt)                                 │
 │  fts_chunks USING fts5(title,body,chunkId UNINDEXED,nodeId UNINDEXED,│
 │         entityType UNINDEXED, tokenize='trigram remove_diacritics 1')│
 │  vec_chunks USING vec0(embedding float[D], entityType INTEGER)       │
 │           D=所选 cloud model 维度（首响应落 index_meta，如 1536）     │
 │  field_grant(chunkRowid, tableNodeId, fieldId)  ← §4.7 召回前收敛    │
 │  index_meta(k PK, v)                                                │
 │  temp_scope / temp_field_grant（每检索会话 TEMP 表，M4 scope 物化）  │
 └───────────▲─────────────────────────────────────────────────────────┘
             │ 只读连接（每检索会话 readonly，池上限 4）
 GET /api/v1/search ──► ① M4 scope(主库) → temp_scope（nodeId 白名单）
                        ② maskedTableFields → temp_field_grant（字段白名单）
                        ③ FTS(≥3)/LIKE(<3) JOIN 两临时表 → top100
                        ④ vec KNN（与门通过）在收敛 rowid 集内 → top100
                        ⑤ RRF 1/(60+rank) → 实体聚合 → decideMany 二次校验
                        ⑥ mask 摘要 → 响应 mode/degraded/scopeTruncated
```

- **三连接拓扑**：主库 Prisma 读写（既有）；主库裸驱动只读（worker 读事件/实体 + scope 快路径，仿 rawRead 单例）；search.db 一写（worker 单例）一只读池（会话，cap 4）。spike §4 已证同进程多库无干扰。
- **不用 ATTACH**：Prisma 连接无法 loadExtension；裸连接 ATTACH 两库耦合 WAL/锁且 backup 单文件无法覆盖 ATTACH 组；独立连接 + 临时表物化，权限（主库）与召回（派生库）边界清晰、可独立替换 LanceDB。

### 4.2 search.db schema 与 BigInt 铁律

```sql
-- 自举（SearchStore 初始化 IF NOT EXISTS；不进 Prisma 迁移）
CREATE TABLE IF NOT EXISTS chunks(
  rowid       INTEGER PRIMARY KEY,   -- 与 fts/vec rowid 三处一致；绑定 BigInt
  chunkId     TEXT NOT NULL UNIQUE,  -- identity: `${etype}:${eid}`; field: `${etype}:${eid}:f:${fieldId}`
  entityType  TEXT NOT NULL,         -- 'record'|'doc'|'canvas'
  entityId    TEXT NOT NULL,
  nodeId      TEXT NOT NULL,         -- record=table 节点；doc/canvas=各自节点（B-1）
  workspaceId TEXT NOT NULL,
  chunkKind   TEXT NOT NULL,         -- 'identity' | 'field'
  fieldId     TEXT,                  -- 仅 chunkKind='field'（record 字段）
  title       TEXT NOT NULL DEFAULT '',
  seq         INTEGER NOT NULL DEFAULT 0,
  version     INTEGER NOT NULL DEFAULT 0,
  length      INTEGER NOT NULL DEFAULT 0,
  updatedAt   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_node   ON chunks(nodeId);
CREATE INDEX IF NOT EXISTS idx_chunks_entity ON chunks(entityType, entityId);
CREATE INDEX IF NOT EXISTS idx_chunks_field  ON chunks(fieldId) WHERE fieldId IS NOT NULL;

CREATE VIRTUAL TABLE IF NOT EXISTS fts_chunks USING fts5(
  title, body, chunkId UNINDEXED, nodeId UNINDEXED, entityType UNINDEXED,
  tokenize='trigram remove_diacritics 1'
);

-- 仅当 vec0 加载成功且 cloud provider 首次成功 embed 后按 D 创建；
-- D = 首次响应向量长度，落 index_meta.embedding_dim
CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
  embedding float[1536],    -- 实际 D 建库时以【index_meta 内首响应维度】拼接，绝不拼接用户输入
  entityType INTEGER        -- 1=record 2=doc 3=canvas（整数映射，绑 BigInt）
);

-- 字段授权收敛表（§4.7）：record 的 field chunk 每行登记其 tableNodeId+fieldId；
-- identity chunk 不登记（对任何能 r 该 node 的主体可见）。
CREATE TABLE IF NOT EXISTS field_grant(
  chunkRowid  INTEGER NOT NULL,   -- = chunks.rowid（绑 BigInt）
  tableNodeId TEXT NOT NULL,
  fieldId     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fg_lookup ON field_grant(tableNodeId, fieldId);

CREATE TABLE IF NOT EXISTS index_meta(k TEXT PRIMARY KEY, v TEXT NOT NULL);
-- 键：schema_version / vec_loaded / vec_version / embedding_mode / embedding_model /
--     embedding_dim（首响应长度，无管理员配置项）/ indexed_at /
--     rebuilding(0|1) / active_db / worker_lock / next_rowid /
--     field_chunk_cap / capped_records（因超 N 被截断的记录计数）
```

**BigInt/绑定铁律（H2/H3/H4/H10，进 code review 清单与单测）**：

1. vec0 rowid 与所有 integer metadata（entityType）插入一律 `BigInt(...)`；普通 chunks 表 seq/version/length 可用 number，但三处对齐 rowid 统一经纯函数 `toRowId()`，由单写者在写事务内用 index_meta `next_rowid` 取号（先取后插或 `UPDATE ... RETURNING`，无竞争）。
2. 向量绑定 `Buffer.from(Float32Array.buffer)`（little-endian float32），禁 JSON 数组文本。
3. 所有 KNN 语句必须 `LIMIT ?`/`k=?`，封装层强制；grep `MATCH ?` 附近无 LIMIT 打回。
4. SearchStore 写事务 helper 内建 `db.transaction(fn)()` 调用并命名区分，单测防 H10。
5. metadata 等值过滤在暴力扫描期完成（不加成本，语义=过滤后集合内 top-k）。

### 4.3 outbox（主库 change_events，手写迁移 #21/#22）

```prisma
model ChangeEvent {
  id          String   @id @default(cuid())
  entityType  String   // record | doc | canvas
  entityId    String
  workspaceId String   @default("ws_default")
  version     Int      // doc=contentVersion；record=同事务内 updatedAt ms 单调序号
  op          String   // upsert | delete
  status      String   @default("pending") // pending|processing|done|failed|dead
  attempts    Int      @default(0)
  workerId    String?
  lastError   String?
  nextRunAt   DateTime @default(now())
  createdAt   DateTime @default(now())
  processedAt DateTime?
  @@index([status, nextRunAt])
  @@index([entityType, entityId])
  @@map("change_events")
}
```

- **合并去重（ARCH §7.1）**：业务写事务内先 `UPDATE change_events SET version=?,op=?,status='pending',nextRunAt=now,lastError=NULL WHERE entityType=? AND entityId=? AND status IN('pending','failed')`，count=0 再 INSERT；processing/done 不动（done 后再编辑=新事件行）。
- 软删发 delete（回收站不可搜，对齐旧搜索手工过滤 deletedAt）；恢复发 upsert；物理 purge 发 delete 并由 worker 清派生行。
- 迁移 #21 DDL + 手工 KV 配置表 `app_settings(k TEXT PK,v TEXT,updatedAt)`（cloud 凭据/配置加密落库，§4.4）；#22 活实体播种（分批 `INSERT...SELECT ... WHERE NOT EXISTS`，records 活行 + kb_docs 活行，幂等可重跑），空 search.db 首启自动建索引（不靠手工 reindex）。
- down：`prisma/docs/rollback/<ts>_m5_search.down.sql` DROP 表（主回滚靠发布前快照；事件表只被 M5 读，删除不影响旧功能）。

### 4.4 EmbeddingProvider（cloud/off 两态；local 仅留未来位）

```ts
export type EmbeddingMode = "off" | "cloud";
// 未来扩 "local" = 新增 LocalEmbeddingProvider 文件 + optionalDependencies（ARCH §7.2 未来位），
// 本接口/search.db schema/RRF/scope 收敛均不随之改动；本期不实现、不打包、不进部署清单。
export interface EmbeddingProvider {
  readonly mode: EmbeddingMode;
  readonly model: string;
  readonly dim: number;            // cloud：首次成功 embed 的返回长度；off=0；变更即触发 reindex
  readonly batchSize: number;      // cloud 默认 64
  /** 等长、同序（按 data[].index 对齐）；内部切片/限流/超时/重试 */
  embed(texts: readonly string[]): Promise<Float32Array[]>;
  health(): Promise<{ ok: boolean; latencyMs?: number; detail?: string }>;
  /** 释放资源：cloud/off no-op；预留给未来 LocalEmbeddingProvider 终止 Worker */
  dispose?(): Promise<void>;
}
```

配置（env 为只读首启种子；管理员 PATCH 落 `app_settings`，cloud key 加密）：

| env | 默认 | 说明 |
|---|---|---|
| `GX_M5_SEARCH` | `off`（实施期总门，shadow→on 纪律，§6） | v1 search 路由与 worker 是否启用 |
| `GX_EMBEDDING_MODE` | **`off`（切 on 后的出厂默认；未配置远端即纯 FTS/LIKE）** | off\|cloud，未知值保守回 off |
| `GX_SEARCH_WORKER` | `on` | 内嵌 worker 排障开关（不演化成进程形态） |
| `GX_VEC_EXT_PATH` | 空 | 显式覆盖 vec0 扩展绝对路径（文件名仍须 vec0） |
| `GX_EMBEDDING_BASE_URL` / `_API_KEY` / `_MODEL` | —/—/—（cloud **无默认 model，必须显式配置**） | cloud；baseURL 自带 /v1 归一 |
| `GX_EMBEDDING_BATCH_SIZE` / `_TIMEOUT_MS` | 64 / 15000 | cloud 批量/超时 |
| `GX_SEARCH_FIELD_CHUNK_CAP` | 50 | 单记录 field chunk 软上限 N（§4.6，S13 校准） |

- **cloud（Q5 单一契约）**：POST `${baseURL}/v1/embeddings`，Bearer，`{model,input:[...],encoding_format:"float"}`；按 `data[].index` 对齐回序，dim 取响应向量长度；网络错/5xx/超时指数退避（3 次，基数 1s），4xx 不重试；401/403 置 unhealthy；信号量限流 + AbortController 超时；空文本不调用，单条超 ~8000 字符在抽文本层截断。**不引 SDK、不暴露 dimensions/MRL、不做非兼容供应商 adapter。**
- **off**：provider 不加载任何网络/原生资源，`embed()` 不被调用（worker 跳过向量步）；检索 = fts/like。
- **向量可用性「与门」**（仿 flags.ts:28-30）：`mode=cloud` **且** 配置齐 + health ok（周期 60s 连续 3 次失败置 unhealthy）**且** vec0 已加载 **且** `index_meta.embedding_dim` 与最近响应 dim 一致。任一不满足→查询自动 fts/like，status 报原因（vec_unavailable/embedding_unhealthy/dim_mismatch）。
- **失败不阻断主写**：FTS 写成功即事件 done（检索可用性优先）；向量缺失由覆盖度对账（chunks LEFT JOIN vec_chunks）周期补发，cloud 401/故障期间向量欠账、恢复后补齐。
- **凭据存储（继承旧稿 B-2）**：apiKey PATCH 落 app_settings，以 `key=SHA-256(JWT_SECRET||"embedding-v1")` 派生 AES-256-GCM（node:crypto 内置，零新依赖），随机 IV，库存 iv/tag/ciphertext；GET/status 只回 `{configured,source:env|db|none,maskedLast4}`；rotate/DELETE 端点；JWT_SECRET 变更解密失败回落 configured:false 不 500（写进 S4 验收）。

### 4.5 先收敛后召回（AC-M5-2 实现细则）

```
search(q,user,filters):
  1. q=trim；空 q 返回 {items:[],mode:"like"}（对齐旧 :51）。
  1b. 请求 mode（query 参数，默认 auto）：auto=FTS/LIKE+vec 自适应融合；fts=强制只走关键词
      （trigram 或短词 LIKE，不调 embedding）；vector=强制只走向量 KNN。强制档在能力不可用
      （off/降级）时自动回退并在 degraded 标注：vector 不可用→fts/like；不得报错或放宽权限。
  2. scope = resolveVisibleNodeIds(prisma,user,{actions:['r'],
            kinds: typeFilter 映射（record→'table'，doc→'doc'，canvas→'canvas'；all 不传）})
     → {nodeIds, resourceIdsByType, truncated, maskedTableFields, policyVersion}
     nodeIds 为空 → 直接返回空（EMPTY_SCOPE_PREDICATE，不跑召回）。
  3. search.db 只读会话：
       CREATE TEMP TABLE temp_scope(nodeId TEXT PRIMARY KEY);
       批量 INSERT（每批 499）。——M4 契约 expectsTempTable 与否，M5 一律走临时表（不分支 IN 直拼）
       CREATE TEMP TABLE temp_field_grant(tableNodeId TEXT, fieldId TEXT);
       INSERT maskedTableFields 展开（tableNodeId,fieldId）行；空表代表"无字段收窄"。
  4a. FTS 路（码元≥3）：trigram MATCH（用户输入包双引号短语并转义，MATCH 左值用虚表名）
      WITH allowed AS (
        SELECT c.rowid,c.entityType,c.entityId,c.chunkKind,c.fieldId,c.title,c.nodeId
        FROM chunks c JOIN temp_scope s ON s.nodeId=c.nodeId
        WHERE c.chunkKind='identity'
           OR EXISTS(SELECT 1 FROM temp_field_grant g
                     WHERE g.tableNodeId=c.nodeId AND g.fieldId=c.fieldId)
      )
      SELECT a.*, bm25(fts_chunks) rank FROM fts_chunks
      JOIN allowed a ON a.rowid=fts_chunks.rowid
      WHERE fts_chunks MATCH ? ORDER BY rank LIMIT 100
  4b. LIKE 路（码元<3）：allowed 同构；c.title LIKE ? ESCAPE'\' OR fts_chunks.body LIKE ?，
      参数化、%/_/\ 转义，LIMIT 100。
  4c. vec 路（与门通过）：qv=provider.embed([q])（cloud；失败即跳过该路，不报错）
      先求收敛 rowid 集（identity ∪ 授权 field）：
        allowed_rowid = SELECT c.rowid FROM chunks c JOIN temp_scope s ...
                        LEFT JOIN field_grant fg ...（同 4a 谓词）
      KNN：SELECT rowid,distance FROM vec_chunks
           WHERE embedding MATCH ? AND entityType IN (BigInt 映射)
                 AND rowid IN (allowed_rowid 子查询)
           ORDER BY distance LIMIT 100
      ★ spike §8.5-3 未实测项：S11 第一件事在夹具验证该 SQL 被接受且计划在 KNN 前/中收敛。
        若 vec0 不支持子查询或优化器先全量 KNN：退路=用 chunks 上的 metadata 分桶列粗收敛
        （partition=hash(rootNode)，scope 展成桶集）+ KNN 后 IN allowed 兜底；
        若仍被迫全量扫，记录证据、调小 k，结论入 S11 gate；
        【严禁静默退回"全量召回后应用层过滤"】。
  5. RRF：每路 score += 1/(60+rank)；标题精确等于 q / 前缀命中加固定 boost（S11 小样标定常量）。
  6. 实体聚合：同 entityId 多 chunk（identity+多 field+doc 多块）取 max(score)；doc 带命中 chunk seq。
  7. 纵深防御：top 候选逐实体 decideMany(prisma,subject,nodeIds,'r')；失配丢弃并记 metric
     （正常应为 0，非 0=scope 快照与决策不一致的 bug 信号）。
  8. 摘要：record 只用 visibleFields 重拼 snippet（§4.7）；doc 用命中 chunk 文本窗口。
  9. 响应 §9：mode=hybrid|vector|fts|like（由实际执行路决定，请求 mode=vector 成功时 vector）、degraded[]、scopeTruncated、policyVersion。
```

- **粒度对齐（继承旧稿 B-1）**：record 不建 nav 节点（M3 六类：base/kb/table/view/doc/canvas/group），record chunk 的 `nodeId=tableNodeId`，scope kinds 取 `table`；doc/canvas 挂各自节点。S7 用对拍测试锁「scope 集 × chunk 集 join 语义 == 逐实体 decide」。
- **truncated 诚实标记**：M4 budget 默认 5000、硬顶 20000；超限时 temp_scope 只装截断集，响应必须 `scopeTruncated:true` + 提示缩小范围，不得静默只搜部分却谎称全量。
- **EXPLAIN 铁律**：三路召回的 EXPLAIN 必须出现 temp_scope/allowed 的 JOIN/过滤在结果产出前；vec0 本就 SCAN，WHERE/子查询下推即满足（S11 留证）。

### 4.6 三族内容与 chunk 策略（Q7 软上限定稿）

| 族 | chunk 构成 | 文本 | 元数据 |
|---|---|---|---|
| record | **identity ×1**：title（primaryField，mask 时按 §4.7 回退 record id）+ 表名/Base 名等「身份」文本，**不放任何可被字段 mask 的业务值**；**field ×N（N≤软上限，默认 50）**：每个非计算、可搜索且实际有值的字段 1 chunk（body=该字段文本，title 带字段标签），按确定性规则取前 N 个 | 字段值拼接规则对齐 search.ts:90-95（LinkRef 取对象 title） | field chunk 登 field_grant(tableNodeId,fieldId)；nodeId=table 节点 |
| doc | 按 h1/h2/h3 粗切 + 超长滑窗（目标 300–512 字、overlap 64）；md 去标记复用 markdownToSearchText | 块正文 + 标题路径 | nodeId=doc 节点；seq；全部 identity 类（doc 无字段概念） |
| canvas | 每个含文本元素 1 chunk（**需把 canvasToSearchText 从全板一串改为按元素遍历产出**，保留 gxNote 与深度/上限保护） | 元素 text/label + gxNote | nodeId=canvas 节点；seq；identity 类 |

- doc/canvas 无字段 mask 概念，全部走 identity；record 才有 identity/field 拆分。
- **字段截断确定性规则（Q7）**：候选 = 非计算、可搜索（文本类：文本/长文本/数字/日期/选项等可出搜索文本的类型；附件/公式等非可搜索类型不建 field chunk）且实际有值的字段；排序 = 字段类型优先级（文本类优先）→ 字段创建顺序（field.id/createdAt 确定性平局）；取前 N。超 N 的记录：(i) 不建第 N+1 个起的 field chunk，(ii) index_meta `capped_records` 累加、status 返回 `fieldChunksCapped` 计数与当前 N，(iii) N 经 `GX_SEARCH_FIELD_CHUNK_CAP` / admin PATCH 可配，改 N 后受影响实体由 reindex 重建。**不静默、不随机丢。**
- 重建幂等：以 chunkId upsert；实体变更先按 entityId 删旧 chunks/fts/vec/field_grant 行再写新（§5.3）。
- 字段 chunk 放大系数在 S13 记账：用 M1 宽表造数器（可造数百字段）量 chunks/库大小/P95，并据此校准 N 的默认建议值。

### 4.7 fieldMask「物理缺席」的落地（Q4 已裁决：召回前排除）

**目标**：被某主体 mask 的字段文本，不得出现在该主体的任何一路召回候选与摘要里——且在写入侧拆分、查询侧收敛保证，不靠召回后过滤。

**写入侧（无主体、按字段分块）**：

1. 可被任何 r 策略 mask 的业务值**只进 field chunk**，不进 identity chunk；identity 仅含表名/记录定位标题。这样不存在「一条含全部字段的 chunk 被部分 mask」的矛盾。
2. 每个 record field chunk 在 `field_grant` 登记 `(tableNodeId,fieldId)`；identity chunk 不登记。
3. 计算字段仍不索引（对齐现状）；超 N 截断按 §4.6 确定性规则。

**查询侧（每主体，召回前收敛）**：

4. scope 已返回 `maskedTableFields`（tableNodeId→allowFields 并集，缺省 key=该表无 r 字段收窄）。生成该主体的字段授权：对每个其可见 table 节点，若在 maskedTableFields 中，则仅其中 fieldId 的 field chunk 可见；不在其中（无 mask）则该表全部 field chunk 可见。物化为 temp_field_grant。
5. 三路召回的 `allowed` 谓词 = `chunkKind='identity' OR EXISTS(temp_field_grant 命中)`。于是被 mask 的 field chunk **在 FTS MATCH / vec KNN 之前就被排除**，既不泄漏片段/距离，也不会占满 top-k。
6. 摘要只用 fieldMask `canSeeField` 可见字段重拼；title 候选（primaryField/linkDisplayField）被 mask 时回退 record id（沿用 M4 A-4）；`matchedField` 对 mask 字段返回 null，措辞不出现「无权限」、不反证字段存在。
7. 表级不可见（无该表 r）：该 tableNodeId 不在 temp_scope，identity 与 field 全部 INNER JOIN 落空，整实体缺席。

**强度边界（Q4 裁决，写进 ADR-0048 与 runbook）**：派生库 search.db 是**同机可重建派生产物**——被 mask 字段的文本作为行物理存在于磁盘，但按主体在召回前排除。**不做**按授权域分片索引、不做落盘加密（复杂度/存储放大与 M5 不相称）。威胁模型口径：

- search.db **不进备份**、损坏可随时 reindex 重建（§3-9）；
- search.db 的**文件系统访问权限等同主库 dev.db**（同机同用户、同 0600/目录 0700 口径）：能读到 search.db 的攻击面本就已有主库全量明文，派生物不引入新增越权面；
- 网络面上 AC-M5-2 由 scope + field_grant 召回前收敛 + 二次 decide 封口。

这就是产品语义强度，照此写 S8 验收与 runbook「search.db 资产边界」章节。

### 4.8 权限/继承变更与版本号联动

- chunks/fts/vec/field_grant **不含任何主体授权**，调岗/角色收授/继承开关/tree 移动只影响 scope 计算；M4 已 bump policyVersion 且决策无跨请求正缓存，M5 每次检索现算 scope，AC-M2-1「下次请求即变」在检索通道自动成立（S10 对抗）。
- nodeId 稳定性是前提（M3：move/rename 下 id 稳定）；实体 purge 后 chunks.nodeId 悬空行由删除事件清理 + INNER JOIN temp_scope 天然不可达 + 覆盖度 C 类巡检清除。
- 响应回传 policyVersion 供前端作废缓存；M5 不建结果缓存。

### 4.9 降级矩阵（AC-M5-1 验收面）

| 情形 | 行为 | mode/degraded | 主应用 |
|---|---|---|---|
| `GX_M5_SEARCH=off`（实施期默认） | 不挂 v1 search、不启 worker、不建 search 连接 | 旧 /api/search 现状 | 逐字节不变 |
| vec0 .so 缺失/加载失败/musl/改名 | catch（H8），vecAvailable=false，不建/不查 vec_chunks | fts/like，vec_unavailable（warn+status） | 不受影响 |
| mode=off（出厂默认） | 不向量化/不查向量、零外网 | fts/like | 不受影响 |
| cloud 缺配置/未二次确认 | 不启用 cloud；FTS 正常、无向量 | fts/like（非 degraded，配置态 status 可见） | 不受影响 |
| cloud 401/403/超时/连续失败 | provider unhealthy；FTS done、向量欠账待补 | fts/like，embedding_unhealthy | 不受影响 |
| dim 与建表不一致（model 变更未 reindex） | 拒向量路，status 提示 reindexRequired | fts/like，dim_mismatch | 不受影响 |
| search.db 损坏/打不开 | rename `.corrupt-<ts>` 隔离→重建空库→自动播种；当次检索回主库 LIKE 应急（scope 收敛后对 title/searchText 参数化 LIKE，复用 ADR-0005 有界口径） | like，search_store_recovering | 不受影响 |
| worker 卡死/积压 | status 暴露 backlog/dead；旧索引继续服务、写入不受阻 | hybrid/fts 正常 | 不受影响 |
| reindex 进行中 | **双库原子切换**：在 `search.db.rebuild-<ts>` 灌完后 rename 替换，旧库继续服务，切换瞬态只读连接重开 | 切换中 like 瞬态 | 不受影响 |

- 不把 search/vec 加入 /readyz 的理由：可降级、可重建资产故障预期就是纯 FTS 服役（低端 NAS/musl），列入 readiness 会变成 503 摘流。可观测放 status 端点 + warn + 审计。

### 4.10 目录组织（单文件 ≤300 行，资源分包）

```
apps/api/src/domain/search/
  searchStore.ts      // search.db 单例：打开/PRAGMA/loadExtension/降级标记/临时表/双库切换
  schema.ts           // DDL 自举常量 + index_meta 读写
  vecLoader.ts        // resolveVecPath（GX_VEC_EXT_PATH/triplet）、load、BigInt/BLOB 绑定 helper
  chunks.ts           // 抽文本 + 身份/字段 chunk 拆分（复用 domain/kb.ts、画布按元素）+ FIELD_CHUNK_CAP 常量与取舍纯函数
  fieldGrant.ts       // 纯函数：maskedTableFields → temp_field_grant 行 + allowed 谓词
  outbox.ts           // enqueueChangeEventTx（主库 *Tx 原语，合并去重）
  indexer.ts          // worker 认领/状态机/单例锁/退避/删除联动/覆盖度对账
  embedding/types.ts  // EmbeddingProvider 接口 + 模式解析/与门（含 LocalEmbeddingProvider 未来位注释）
  embedding/off.ts    // offProvider
  embedding/cloud.ts  // fetch/超时/重试/health/dim 首响应探测
  embeddingConfig.ts  // env 种子 + app_settings AES-256-GCM 读写 + fieldChunkCap
  query.ts            // scope/字段物化 + FTS/LIKE/vec 三路 + 聚合 + 二次 decide
  queryPlan.ts        // 纯函数：码元长度分流/MATCH 与 LIKE 转义/allowed 谓词/topN
  rrf.ts              // 纯融合函数（表驱动单测）
  snippets.ts         // mask 摘要剔除（消费 M4 fieldCapability/canSeeField）
  __tests__/          // characterization/降级/零泄漏/融合/绑定类型/字段授权/截断确定性
apps/api/src/routes/v1/
  search.ts           // GET /search（GX_M5_SEARCH 门）
  adminSearch.ts      // reindex / search/status / embedding config + apiKey（role_owner）
apps/api/scripts/search/
  reindex.mjs         // pnpm gx:reindex [--type] [--id] [--with-config]
  check-coverage.mjs  // A-F 覆盖度/悬空 nodeId 巡检（只读，exit 非0）
```

- **本期不存在** `embedding/local.ts` / `embedding/local.worker.ts` / 模型投放脚本：未来加 local 时新增 `embedding/local.ts`（实现同接口）+ optionalDependencies 即可，目录与接线已为其留位。

---

## 5. 数据维护与运维

### 5.1 迁移拆分（只增；#21/#22 排在 M4 之后）

- `20260917090000_m5_search_outbox_ddl`：CREATE change_events + 两索引 + app_settings(KV)。
- `20260917090100_m5_search_outbox_seed`：活实体分批播种（records 活行 + kb_docs 活行，NOT EXISTS 幂等）。
- down：`prisma/docs/rollback/20260917090000_m5_search.down.sql` DROP（主回滚靠快照）。
- **search.db 零 Prisma 迁移**：schema.ts 自举，`index_meta.schema_version` 管内部版本；不兼容 DDL 变更 bump + 迁移函数或触发 rebuild。

### 5.2 outbox 接线点清单（S1 收口，每点同事务；S1 PR 单列触碰清单）

| 内容 | 写点（§1.4） | op/version |
|---|---|---|
| 记录建 | records.ts:450 withWriteTx 内 tx.record.create 后 | upsert；version=Date.now() |
| 记录改 | :678/:854（及 S1 归入事务的 :223 裸写、:738 软删区） | upsert |
| 记录软删/恢复 | :738-742、:794-800；恢复点 | delete / upsert |
| 文档/画布内容 | kb/docs.ts:176 同 tx（两分支都在更新成功后、`:200` syncNav 旁） | upsert；version=新 contentVersion |
| 文档建 | kb/docs.ts:88 tx.kbDoc.create 后 | upsert |
| 文档移动/改名 | :230/:240 移动不改文本→**不发**；改名若影响标题文本则发 upsert | 仅文本变才发 |
| 文档软删/恢复/整库删 | :269/:291；kb/index.ts:151 | delete |
| 匿名公开编辑 | public.ts:271-273 | upsert（ANON 不影响归属） |
| 表删级联记录 | M3 purge/sync 同事务回调 | 按 tableId 批量 delete |

每点只调 `enqueueChangeEventTx(tx,{...})`；插入失败随主事务整体回滚（共生死）。S1 验收含「outbox 失败→业务写回滚」与「主写 P95 噪声级差值」两组证明。

### 5.3 worker 状态机与退避

- 认领（SQLite 3.53 支持 RETURNING）：`UPDATE change_events SET status='processing',workerId=?,attempts=attempts+1 WHERE id=(SELECT id FROM change_events WHERE status='pending' AND nextRunAt<=? ORDER BY nextRunAt LIMIT 1) RETURNING *`；单写者 + index_meta.worker_lock 时间戳防双开重复（不引分布式锁）。
- 失败置 failed + nextRunAt 指数退避（10s/1m/10m/1h×5），attempts≥8 转 dead；成功 done+processedAt。
- 处理：取实体（活/deletedAt）→ delete 清四表派生行（chunks/fts/vec/field_grant 按 entityId，rowid 联动）→ upsert：抽文本拆分（含 N 截断）→删旧行→取新 rowid→写 chunks/fts/field_grant→cloud 模式 provider.embed→写 vec；off 模式跳过向量步。
- 单轮批 50、空闲轮询 2s（有积压连续）；启动延迟 3s；不引外部队列/cron。cloud 向量化配合信号量限流与批量限速，不阻主写。

### 5.4 reindex（幂等 job，两步配置变更）

- `POST /api/v1/admin/reindex {type?,entityId?}`：role_owner；index_meta 置 rebuilding + 审计；在 `search.db.rebuild-<ts>` 自举空库（按当前 dim 建 vec_chunks）→扫主库活实体直接灌（不经事件史，§3-9）→完成后原子 rename 替换 + worker/只读连接重开 + rebuilding=0；期间旧库服务、新库不可见。
- 并发：rebuilding=1 再调返 409 REINDEX_IN_PROGRESS。CLI `pnpm gx:reindex`（停机维护直跑同函数）；`--with-config` CLI 保留一步（应用配置再重建）。
- **model/dim 变更两步（继承 B-6，Q5 调整）**：PATCH embedding/config 改 mode/model 不自动重建，返 `reindexRequired:true`（PATCH 拒绝请求体 `reindex:true`，400 EMBEDDING_CONFIG_INVALID）；管理员显式再调 reindex。新 model 首批 embed 返回 dim 与旧库不符即 dim_mismatch，必须经此路径重建。fieldChunkCap 调整同样标记受影响记录需 reindex。

### 5.5 覆盖度对账（check-coverage + status 数据源）

A 主库活实体无派生 chunk（漏索引）；B 派生 chunk 对应实体不存在/已删（脏行）；C chunks.nodeId 在 nav 无活节点（悬空）；D cloud 模式下 chunk 缺 vec 行（向量欠账，含 cloud 故障期；off 模式 D 不适用）；E fts 缺失；F field chunk 缺 field_grant 行（字段授权漏登）。只读巡检，exit 非0 供 CI/运维；status 汇总计数 + `fieldChunksCapped`（超 N 截断记录数）。

---

## 6. Flag 与上线纪律（GX_M5_*，纯函数先行 + shadow；Q6 两层门）

| flag | 默认 | 形态 | 作用 |
|---|---|---|---|
| `GX_M5_SEARCH` | **off** | off\|shadow\|on | off=不挂 v1 search/不启 worker（旧搜索字节不变）；shadow=新链路跑并对拍旧 `/api/search`（仅 FTS/LIKE 可比集），结果只记日志不返回；on=v1 search 对外 |
| `GX_EMBEDDING_MODE` | **off（切 on 后的出厂默认）** | off\|cloud | provider 选择；未知回 off；cloud 必须显式配置 + 二次确认 |
| `GX_SEARCH_WORKER` | on | on\|off | 内嵌 worker 排障 |
| `GX_M5_SHADOW_STRICT` | off | on 时 drift 非0 即失败 | 对拍闸门 |

- **两层门**：实施期 `GX_M5_SEARCH=off` 保证代码合入不建库、不出网；纯函数（rrf/queryPlan/chunks/fieldGrant）先落地不接线，随后 SearchStore/provider/worker，再 shadow 对拍，连续一迭代 drift=0 才允许 on（与 M1/M4 同款）。on 之后 `GX_EMBEDDING_MODE=off`，存量用户升级后仍是纯 FTS/LIKE；只有管理员显式配置 cloud 并通过二次确认后才建向量、才出网。
- shadow 对拍口径：仅在「旧搜索有界预览可达 + 两模式都用 FTS/LIKE（不引入向量差异）」的交集上比对命中实体集合/顺序；向量召回属于新增能力，用 S11 独立小样召回评测而非与旧 includes 对拍。
- 回滚：GX_M5_SEARCH=off 即回现状；v1 路由摘除为代码级最终回退，旧端点无损。

---

## 7. 切片总览与依赖（15 片：S0–S14）

| ID | 标题 | 类型 | 主要触碰 | 依赖 |
|---|---|---|---|---|
| S0 | 旧检索字节级 golden + M5 baseline | 测试+文档 | search/__tests__；docs/baseline | — |
| S1 | change_events/app_settings 迁移 + outbox 同事务接线（**独立 PR，触碰清单单列**） | 后端 | 2 迁移；outbox.ts；records/kb/public 写点 | M3-S3/M4 已合 |
| S2 | SearchStore/search.db 自举 + vec0 加载降级 + 原生打包 | 后端+部署 | searchStore/vecLoader/schema.ts；build-fpk；Dockerfile；env 例 | S1 |
| S3 | 纯函数层（rrf/queryPlan/chunks/fieldGrant/截断取舍）不接线 | 后端+测试 | rrf/queryPlan/chunks/fieldGrant + 表驱动单测 | S0 |
| S4 | cloud + off provider 与两态配置/凭据加密 | 后端 | embedding/{cloud,off,types}.ts；embeddingConfig.ts | S2 |
| S5 | indexer worker（拆分/FTS/vec/退避/删除/对账） | 后端 | indexer.ts；scripts/search | S1-S4 |
| S6 | 路由门 + 挂载骨架（GX_M5_SEARCH，空实现/404 门） | 后端 | routes/v1/search.ts 占位；v1/index.ts；config | S2 |
| S7 | 先收敛后召回 + v1 search（shadow；含 S11 KNN 子验证前移） | 后端 | query.ts；routes/v1/search.ts | S3/S5，M4-S4/S1 |
| S8 | fieldGrant 物理缺席 + AC-M5-2 字段对抗（Q4 定稿方案） | 后端+测试 | fieldGrant/query/snippets | S7，M4-S6 |
| S9 | reindex/status/config + apiKey 六端点 + openapi 冻结 | 后端+契约 | adminSearch.ts；docs/api/openapi.yaml | S5/S7 |
| S10 | 权限/调岗/继承/move 即时失效对抗 | 测试 | __tests__ | S7，M4-S7 |
| S11 | vec0 KNN×白名单首日验证 + RRF/EXPLAIN/SQL 计数 | 测试+证据 | 夹具；gate 证据 | S7（可与 S7 同启动） |
| S12 | AC-M5-1 降级/损坏自愈全链路 + off 零外网抓包 | 测试+runbook | 断网/坏 endpoint/删库/.so 缺失/抓包代理 | 全部 |
| S13 | 规模与真机门（KNN 扫描/存储账，Tier-L x86+arm 2C4G；N 校准） | 混合 | bench；m5-gate.md；宽表造数器 | S5/S7/S12 |
| S14 | 出口收口：ADR/RC/runbook/baseline/M5-FE 清单 | 文档 | docs/adr、runbooks、RC | S13 |

关键路径：S0→S1→S2→（S3 纯函数可早）→S4(cloud/off)→S5→S6→S7→S8→S9→S10/S11/S12→S13→S14。
排期硬约束：
1. **S1 是唯一触碰 M2/M3/M4 既有写点事务的切片**：独立 PR、触碰点清单在 PR 描述单列；接线排在最新基线 rebase，禁止把裸写（:223 等）留在 M5 出口。
2. **S0 golden 必须字节锁住**旧 `/api/search`，CI 全程比对，M5 出口旧路由零 diff。
3. 唯一原生面 sqlite-vec 的 fpk/Docker 打包与目标机加载冒烟过门才发（S2/S13）；不兼容平台纯 FTS 降级必须有断言。
4. S8 物理缺席按 §4.7 定稿方案实施（Q4 已裁决，无待裁门）。
5. S13 真机门不过不给对外硬承诺：按 §0.4 给参考画像与降级发布结论。
6. M5-FE 在 S9 openapi 冻结后派，本文不排前端 S 号。

---

## 8. EARS 验收句式（QA 可直接转用例）

- **AC-M5-1a**：When vec0 扩展加载失败，系统**应**自动以 fts/like 提供检索且主应用读写**必须**不受影响。
- **AC-M5-1b**：When 管理员连续两次触发 reindex，系统**应**幂等（第二次 409 或等价无副作用）且重建期间检索**应**持续可用（旧库/like 瞬态）。
- **AC-M5-2a**：Given 主体对某 node 无 r，When 以其独有文本/向量近义检索，系统在 hybrid/fts/like 三 mode 下**必须**零命中、零摘要泄漏。
- **AC-M5-2b**：Given 某字段对主体被 fieldMask，When 以该字段独有值检索，系统**必须**不使该 field chunk 进入其召回（EXPLAIN 含 field_grant 收敛先于 MATCH/KNN），且 matchedField=null、摘要无原文。
- **AC-M5-3**：When 调岗/收权/中断继承/move 提交成功，下一次检索（无 reindex、无缓存等待）**应**反映新可见集。
- **AC-M5-4**：While GX_M5_SEARCH=off，系统行为**必须**与 a4e1f50 逐字节一致（旧 /api/search golden 零 diff、无 search.db/外网副作用）。
- **AC-M5-5**：When GX_EMBEDDING_MODE=off（出厂默认），系统**必须**不发起任意外网请求（S12 代理抓包留证）；cloud 仅在管理员显式配置 + 二次确认后才允许出网。
- **AC-M5-6**：When 切换 model 致 dim 变化而未 reindex，系统**应**拒向量路并回 fts/like 且 status 标 dim_mismatch/reindexRequired，不得混用维度。
- **AC-M5-7**：Given 单记录可搜索字段数超过 N（默认 50），系统**应**按字段类型优先级与创建顺序确定性只建前 N 个 field chunk，且 status.fieldChunksCapped 可见、重复构建取舍结果一致（不随机丢）。

---

## 9. v1 API 契约（S9 进 openapi 冻结，此为纲要）

> 全挂 `/api/v1`、requireActiveUser、`GX_M5_SEARCH` 门；成功返资源本体，错误 `{error,code}`；固定 top20、limit≤50。

```
GET /api/v1/search?q=&type=all|record|doc|canvas&mode=auto|vector|fts&limit=20
  200: { items:[{
          type:"record"|"doc"|"canvas", entityId, nodeId, title, snippet,
          baseId/baseName/tableId/tableName? , kbId/kbName/docId?,
          score, matchedVia:("fts"|"vec")[], chunkSeq?, matchedField:string|null }],
         total, limit,
         mode:"hybrid"|"vector"|"fts"|"like",
         degraded:[]|("vec_unavailable"|"embedding_unhealthy"
                     |"dim_mismatch"|"search_store_recovering"),
         scopeTruncated:false, policyVersion }
  空 q → 200 {items:[],mode:"like"}

POST /api/v1/admin/reindex  body:{type?,entityId?}            → role_owner
  202 {job:"reindex",status:"started"} | 409 REINDEX_IN_PROGRESS | 403
GET  /api/v1/admin/search/status                              → role_owner
  200 { vec:{loaded,version,extPathKind:"builtin"|"env-override"|"platform"},
        embedding:{mode:"off"|"cloud",model,dim,healthy,detail?,reindexRequired},
        index:{schemaVersion,indexedAt,chunks:{records,docs,canvas,total,fieldChunks,
                 fieldChunksCapped,fieldChunkCap},
               backlog:{pending,failed,dead},coverage:{a,b,c,d,e,f},rebuilding} }
GET  /api/v1/admin/embedding/config                           → role_owner
  200 {mode:"off"|"cloud", baseURL, model, dim, batchSize, timeoutMs, fieldChunkCap,
        apiKey:{configured:bool,source:"env"|"db"|"none",maskedLast4:string|null}}
PATCH /api/v1/admin/embedding/config                          → role_owner
  body:{mode?,baseURL?,apiKey?,model?,batchSize?,timeoutMs?,fieldChunkCap?}
   · 不接受 dim/dimensions（维度由 model 元数据决定）；出现即 400 EMBEDDING_CONFIG_INVALID
   · 切 cloud（off→cloud）须 confirmCloud:true（二次确认，缺省 409 NEED_CLOUD_CONFIRM）
   · apiKey 传入覆盖（AES-GCM 落 app_settings）/不传保持/传 null 清库存
   · mode/model 变更 → 200 带 reindexRequired:true（不自动重建，不收 reindex:true）
   · fieldChunkCap 越界（<1 或 >1000）→ 400 EMBEDDING_CONFIG_INVALID
   · 非法 URL/批量 → 400 EMBEDDING_CONFIG_INVALID
   · JWT_SECRET 轮换致解密失败 → configured:false/source:"none"，不 500
POST /api/v1/admin/embedding/api-key/rotate  body:{apiKey}    → role_owner（回存在性形状）
DELETE /api/v1/admin/embedding/api-key                         → role_owner（204，回落 env/none）
```

- 新增错误码（只增）：`SEARCH_UNAVAILABLE`、`REINDEX_IN_PROGRESS`(409)、`REINDEX_FAILED`、`EMBEDDING_CONFIG_INVALID`(400)、`NEED_CLOUD_CONFIRM`(409)。
- 管理端角色（继承旧 B-4）：限 role_owner（复用 M4 hasOrgAction/effective），**不新增 manage_search 动作**。
- 审计事件（只增，脱敏，无 key 值）：`search_reindex_started/done/failed`、`embedding_config_changed`、`embedding_api_key_rotated/cleared`、`search_degraded`（状态降级跳变时采样）。

---

## 10. M5-FE 前端片输入清单（S9 冻结后派）

1. 搜索结果：数据源切 `/api/v1/search`，统一实体 items + matchedVia/score；mode/degraded 中性状态条（不向用户暴露 ".so" 等技术词）；scopeTruncated 提示；空 q 行为一致。
2. 设置→语义检索（SPEC :103）：**off（默认，文案「仅本机关键词检索，零外网」）/ 云端（数据出域二次确认弹窗，文案过 PM/设计）** 单选，无本地选项；cloud 下表单 baseURL/model/batch/timeout + apiKey 密码框（只写，GET 仅 configured/source/maskedLast4；轮换/清除两按钮），**无 dim 输入项**（dim 由 model 决定，状态页只读展示）；测试连接（PATCH 后 healthy 回显）；reindexRequired 引导 + 重建按钮（二次确认、type 选择、进行中）。
3. 覆盖度面板（V5 最小集）：backlog(dead/failed)/coverage A-F/fieldChunksCapped 与当前 N/重建进度（30s 节流轮询）。
4. 全 gx token、只走 api/client.ts、无新依赖、图标只追加 `components/icons.tsx`（禁第二套 SVG 库、禁 emoji——团队 P0）。
5. 嵌入状态徽标呈现由设计师定，数据仅取 status 字段；中性文案纪律（不出现「无权限」反证措辞）延伸到搜索。

---

## 11. 关键设计决策（ADR 候选，带 0042–0050）

- **ADR-0042 独立 search.db 分库连接（非 ATTACH/非主库虚表）**，Accepted：spike §4；Prisma 不能 loadExtension、备份边界、WAL/锁解耦、可 rm、LanceDB 替换面。
- **ADR-0043 同进程 outbox + 可重建派生库（主写零等待）**，Accepted：change_events 同事务、worker 异步、退避 dead、reindex 扫表不依赖事件史；S1 是唯一触碰既有写点事务的例外。
- **ADR-0044 sqlite-vec 暴力 KNN 与降级一等公民**，Accepted：无 ANN、BigInt/BLOB/LIMIT 三铁律、glibc/vec0.so 文件名、加载失败即 FTS+LIKE；50 万/持续超标升级 LanceDB。
- **ADR-0045 embedding 默认仅远端：cloud/off 两态半，local 为未来可选 provider**，**Accepted（依据 PLAN-ADJUST-nas-min-hardware §4，2026-09-12，记录主理人原话「向量暂不考虑本地模型、仅远端 API」）**：本期不引入 @huggingface/transformers、onnxruntime-node、模型权重、Worker Thread 本地推理，原生运行时面只有 sqlite-vec；cloud 锁定 OpenAI 兼容 `/v1/embeddings` 单一契约（全局 fetch、无 SDK、无专用 adapter、不暴露 dimensions/MRL）；off 出厂默认、零外网；EmbeddingProvider 接口按 ARCH §7.2 保留 LocalEmbeddingProvider 未来位——未来加本地＝新增 provider 实现 + optionalDependencies 并 opt-in，**接口/search.db/RRF/权限收敛零改动，无需重构**；dim 随 model 元数据、变更强制两步 reindex。
- **ADR-0046 先收敛后召回（temp_scope + field_grant 物化 + RRF）**，Accepted：AC-M5-2 工程定义；否决先召回后过滤；二次 decide；truncated 诚实标记。
- **ADR-0047 FTS5 trigram + 短词 LIKE 中文策略**，Accepted：3 码元门槛实测、无词库、BM25+标题 boost+RRF。
- **ADR-0048 授权信息不入索引、权限变更零 reindex + 字段 chunk 召回前排除模型**，Accepted：node 级可见性由查询时 scope 承担；字段级由身份/字段 chunk 拆分 + field_grant 召回前收敛承担（Q4 裁决强度）；**不做授权域分片/落盘加密**；search.db 为同机可重建派生产物：不进备份、reindex 随时重建、文件系统权限等同主库 dev.db，不引入新增越权面；版本号仅缓存失效。
- **ADR-0049 reindex 双库原子切换与派生库损坏自愈**，Accepted：临时库 rebuild + rename；损坏隔离 + 自动重建 + 主库 LIKE 应急；model/dim 与 fieldChunkCap 变更两步走。
- **ADR-0050 cloud embedding 凭据管理与供应链边界**，Accepted：apiKey AES-256-GCM（JWT_SECRET 派生）只回显存在性 + 轮换/清除；OpenAI 兼容单一契约、无 SDK、无 vendor adapter；role_owner 限定（不新增 manage_search）；唯一原生供应链 sqlite-vec 平台包/vec0.so/bookworm/非 musl。

---

## 12. 部署 / 原生供应链 / CI

- **sqlite-vec（S2，唯一原生面）**：`package.json` dependencies 加 `sqlite-vec@0.1.9`（平台子包由其 optionalDependencies 自带）；构建显式拷 `native/<triplet>/vec0.<ext>` 到白名单产物 + `file` 架构自检；运行时 `resolveVecPath()`：优先 GX_VEC_EXT_PATH，否则按 platform/arch（必要时判 libc）拼 `${appDir}/native/<triplet>/vec0.<ext>` 绝对路径，文件名恒 vec0；fpk 基准 `${TRIM_APPDEST}/server/native/<triplet>/vec0.so`（目录 0755/文件 0644）；search.db 落可写数据目录（非只读安装目录、非 NFS）。
- **无本地推理供应链**：不引入 transformers/onnxruntime/模型权重，无 postinstall 拉二进制问题，无模型分发/离线校验/版本钉死事项（PLAN-ADJUST §4.2 删除项）。
- **Docker**：node:22-bookworm-slim（glibc 满足 vec0 x64≤2.14/arm64≤2.17）；**runbook 禁 alpine/musl（vec0 无 musl 版）**；三环境部署文档各落 native/ 目录、search.db 数据卷。
- **CI 矩阵**：平台中立 Linux runner 常规质量门（typecheck/lint/test/ci-quality）；新增 (a) darwin 本机 vec0 load+1 KNN（开发门），(b) **buildx linux/amd64 与 linux/arm64 目标平台内安装并冒烟 vec_version+1 KNN**（发版门，spike §8.5-1 未做的 linux 真机项在此补），(c) 故意缺 .so → 启动正常降级断言；(d) musl 静态论证仅文档（不跑 alpine 镜像）；(e) **off 零外网抓包断言**（S12，代理见零外联记录）。
- 不依赖客户机装 sqlite3/age；扩展投放失败不阻断主服务启动（降级）。

---

## 13. AC 自动化对抗设计（S8/S10/S11/S12/S13）

- **AC-M5-2 越权零泄漏（S8/S10）**：建多主体（owner / 仅部门获权 / 表级 r 但字段 mask / 无任何关系）× 多资源（record 全字段、mask 字段独有值、超 N 字段宽表截断边界、doc、canvas、继承中断子孙、move 跨边界）；用**独特语句**（PRD 原例）在 hybrid/fts/like 逐一检索；断言 (i) 命中实体集合 == 逐实体 decideMany 允许集（对拍零差），(ii) 无任何 snippet/title/matchedField 含 mask 原文，(iii) 三路召回 SQL EXPLAIN 都含 temp_scope/field_grant 收敛且先于 MATCH/KNN（grep 计划文本），(iv) mock decide 拒绝时该结果被二次校验丢弃。
- **权限即时性（S10）**：调岗移出有权部门 / 收 direct / 移除角色 / 中断继承 / 重开 / move 后，**下一次**搜索即变；断言无 reindex、无缓存等待、policyVersion 递增回传。
- **AC-M5-1（S12）**：.so 改名（dlsym 失败）/缺失、musl 文档论证、cloud 断网/坏 endpoint/401/超时、dim 不符、rm search.db、reindex 中检索——全部断言：检索降级 fts/like 可用、主应用编辑链路全程可写（带 record.create/PUT content 时延证据）、status/审计有降级状态、恢复后向量欠账补齐。**off 零外网**：经本地代理（如 mitm/录制 socket）断言 off 态与 GX_M5_SEARCH=off 态全程零外联；cloud 仅在二次确认后出现唯一 baseURL 方向流量。
- **规模门（S13，Q2 参考画像口径）**：复用 M1 造数器造 1k/1万/10万 chunk（三族按比例 + 记录宽表字段拆分，含数百字段宽表）；开发机（Apple M5/16GB，100k×1536≈113ms/592MB/RSS≈86MB）数字**仅留档**；**Tier-L x86 与 arm 各一（2C4G 本地 ext4）**：512/1024/1536 等真机所选 model 维度下的**混合检索 KNN p95（十轮）+ warm RSS + 库文件大小 + 可流畅 chunk 上限**，给出参考画像而非硬 500ms 承诺；Tier-S 1万-10万流畅基线；EXPLAIN 无「先全量召回」；权限收敛 SQL 计数与节点/主体规模解耦的常量化断言；超档给收紧 scope/调 k/off 关向量的杠杆证据与降级发布结论；用宽表数据校准 fieldChunkCap N 的默认建议；产出 `docs/baseline/<date>-m5-gate.md`。

---

## 14. 对基线测试数与迁移的影响

- 迁移：20 → **22**（#21 DDL+app_settings、#22 播种）；search.db 不计入 Prisma 迁移数。
- 测试：S0 起以重跑真值为基线（旧权威值 86 文件 1008/3，M4-S10/S11 后更多，S0 记真值）；M5 预计新增文件：旧检索 golden、outbox 接线、SearchStore/绑定类型、两 provider（cloud/off）、worker 状态机、scope 对拍、fieldGrant 六对抗、RRF/queryPlan 表驱动、字段截断确定性、降级自愈、off 零外网、规模夹具（只增测试）；出口保持全绿 + 新增。
- 回归不回退：GX_M1_* 四组合、M2 组织、M3 nav、M4 权限对抗在 M5 各 flag 组合下全绿；旧 `/api/search` 字节零 diff（golden 门）；M1 flags 默认态零新连接/零外网。

---

## 15. 开放问题裁决回填（七问已全部裁决；残留问题：无）

- **Q1（C-EMB-1）终审 — 已裁决：回归 cloud/off**。以在档 Accepted 的 PLAN-ADJUST-nas-min-hardware §4（主理人 2026-09-12「向量暂不考虑本地模型、仅远端 API」）为准，不修订该文档；取消 local 片（本期不做，非 spike-gated），切片 16→15；不引入 transformers/onnx/权重/Worker 本地推理，原生运行时面仅 sqlite-vec；ADR-0045 改题 Accepted 并写清「未来加 local 无需重构」。cloud 下向量仍本地 KNN，扫描/存储真机门保留（见 Q2）。
- **Q2 规模档 — 已裁决**：开发机数字仅留档、不进对外承诺；Tier-L 2C4G x86+arm 真机实测后定档，S13 交付「可流畅 chunk 上限 + RSS + 库大小 + KNN p95」参考画像；无跨硬件硬 500ms；超档 status/UI 确定性提示并引导收紧 scope/降 k/关向量；chunk>50 万或持续超标立项 LanceDB；云端维度由 model 决定，存储预算随真机维度实测。
- **Q3 local 选型/分发 — moot**：local 不做，模型分发与 onnx postinstall 全部移除；§4.4/§12 只保留 sqlite-vec 平台包/vec0.so 文件名/bookworm/非 musl 降级验证。
- **Q4 物理缺席强度 — 已裁决：采纳召回前排除**。写入侧 identity+per-field chunk + field_grant，查询侧 maskedTableFields 物化 temp_field_grant，mask 字段在 FTS MATCH/vec KNN 之前排除；表级不可见 temp_scope INNER JOIN 整体剔除；不做授权域分片/落盘加密；runbook/ADR-0048 写明 search.db 同机可重建、不进备份、文件权限等同主库 dev.db、reindex 可随时重建。§4.7 与 S8 验收按此定稿。
- **Q5 cloud 边界 — 已裁决**：锁定 OpenAI 兼容 POST /v1/embeddings 单一契约；baseURL 任意兼容端；全局 fetch 不引 SDK、不做非兼容 adapter；MVP 不暴露 dimensions/MRL，dim 由 model 元数据决定（首响应落库），降维靠选模型；dim 变化两步全量 reindex。
- **Q6 两层门 — 已裁决**：实施期 GX_M5_SEARCH=off（纯函数先行 + shadow 对拍再 on）；切 on 后 GX_EMBEDDING_MODE 出厂默认 off；cloud 必须管理员显式配置 + 二次确认；代码合入绝不等于对存量用户开建库/出网；off 态零外网抓包留证（S12）。
- **Q7 chunk 放大 — 已裁决**：单记录 field chunk 确定性软上限 N（S3 常量建议 50，S13 宽表造数器校准），按字段类型确定性取舍（文本类优先、非可搜索类型不建、平局创建顺序），超上限 status/计数可见、admin 可配，不静默不随机丢。
- **残留问题：无**（预期清零）。S1 outbox 同事务 INSERT 作为唯一触碰 M2/M3/M4 写点事务的例外已写进 §3/§5.2/§7；S0 旧路由 golden 字节锁已写进 §3/§7/S0 验收。

---

## 16. M5 出口 Definition of Done（摘）

1. AC-M5-1：vec0 缺失/cloud 故障/损坏/reindex 各情形自动 fts/like、主应用与编辑不受影响（时延证据）；reindex 幂等（连跑等价、409、双库切换无空窗）。
2. AC-M5-2：三 mode×cloud/off 下独特语句对抗零泄漏；召回 SQL 全含 temp_scope/field_grant 且收敛先于 MATCH/KNN（EXPLAIN 留证）；二次 decide 失配计数 0；mask 摘要无原文、matchedField 中性、表级不可见整缺席（Q4 定稿强度）。
3. 调岗/收权/继承/move 后下次搜索即变（S10），无 reindex/缓存。
4. outbox 同事务共生死（S1 独立 PR、触碰清单单列）、主写 P95 无回退；首启自动播种；覆盖度 A-F=0 可复跑。
5. Tier-L 双架构 KNN 扫描/存储参考画像留证（可流畅 chunk 上限/RSS/库大小/p95，不给硬 500ms 承诺）；目标机 vec0 冒烟过门；开发机数字仅留档。
6. openapi 冻结对拍；ADR-0042~0050 按本稿归档（0045 cloud/off 改题 Accepted）；40RC 全绿；typecheck/lint/ci-quality；旧 `/api/search` golden 字节零 diff；M1-M4 回归全绿。
7. 密钥零泄漏（响应/日志/审计/库文件）；JWT_SECRET 轮换回落未配置不 500；**off 态零外网抓包留证**、cloud 仅二次确认后出网；runbook 齐备（vec0/musl/search.db 资产边界/reindex/积压/NFS/model 切换）；M5-FE 清单可派工。

---

## 17. 切片速查（供派工 / RoleVerdict）

| ID | 标题 | 关键文件 | 独立验收（一句话） | 依赖 |
|---|---|---|---|---|
| S0 | 旧检索字节级 golden+baseline | search/__tests__；baseline | 旧 search 快照字节锁住、测试数取真值只增 | — |
| S1 | outbox 迁移+接线（独立 PR） | 2 迁移；outbox.ts；records/kb/public | 事件合并/删除正确、失败共回滚、主写无回退、触碰清单单列 | M3/M4 已合 |
| S2 | SearchStore+vec0+打包 | searchStore/vecLoader/schema；build-fpk/Dockerfile | .so 加载 KNN、缺失降级启动正常、产物含 vec0.so | S1 |
| S3 | 纯函数层不接线 | rrf/queryPlan/chunks/fieldGrant | 表驱动单测全绿、零 IO/零接线、N=50 截断纯函数确定性 | S0 |
| S4 | cloud/off+配置凭据 | embedding/{cloud,off,types}；embeddingConfig | off 零外网；cloud 超时/重试/4xx/dim 探测正确；key 不明文 | S2 |
| S5 | indexer worker | indexer.ts；scripts/search | 播种消化零积压、退避 dead、BigInt 全绑、删除/对账、N 截断 | S1-S4 |
| S6 | 路由门骨架 | routes/v1/search；v1/index；config | GX_M5_SEARCH 三门、off 态零副作用 | S2 |
| S7 | 先收敛后召回+shadow | query.ts；routes/v1/search | scope 对拍零差、EXPLAIN 含白名单、shadow drift=0 | S3/S5/M4-S4 |
| S8 | 字段物理缺席对抗 | fieldGrant/query/snippets | 独特字段值三 mode 零召回、收敛先于 MATCH/KNN、摘要无 mask 原文 | S7/M4-S6 |
| S9 | admin+openapi | adminSearch.ts；openapi.yaml | 六端点 owner、两步 reindex、cloud 二次确认、形状对拍、无 dim 入参 | S5/S7 |
| S10 | 权限即时失效 | __tests__ | 调岗/继承/move 下次搜索即变 | S7/M4-S7 |
| S11 | KNN×白名单+RRF 证据 | 夹具；gate | vec0 IN 白名单接受度/计划/SQL 计数定数 | S7 |
| S12 | 降级自愈+零外网抓包 | 演练；runbook | 各故障 fts-only 且主应用可写；off 代理抓包零外联 | 全部 |
| S13 | 真机规模门 | bench；m5-gate.md | Tier-L 双架构 KNN p95/RSS/库大小/流畅上限画像 + N 校准 | S5/S7/S12 |
| S14 | 收口 | ADR 0042-0050；RC；runbook；FE 清单 | 全门绿、旧搜索 golden 零 diff、可派 M5-FE | S13 |
