# ADR-0047：FTS5 trigram + 短词 LIKE 中文策略（BM25 + 标题 boost + RRF），及 shadow 闸门语义裁决

**状态（Status）**：Accepted（M5 计划 §11 第 6 条、§4.5 步骤 5 定稿；S11 boost 标定与三路 EXPLAIN 已取证；**shadow strict 判据经 2026-09-17 项目总监裁决修订**；2026-09-17 M5 出口归档）
**作者**：架构师 高见远（M5-S14 归档；实现/标定由后端 贝洛奇 落地，shadow 裁决由项目总监下、后端实施）
**上游依据**：docs/_archive/originals/planning-phase2-M5-implementation-plan.md §4.5 步骤 5（:439）、§6（:594、:597-598）、§11（:712）；docs/_archive/originals/planning-phase2-spike-sqlite-vec.md §3（trigram 门槛）；docs/baseline/2026-09-17-m5-gate.md §3.5
**关联**：ADR-0046（先收敛后召回与 RRF）；ADR-0005（LIKE 有界口径）；ADR-0044（vec 路与降级）；ADR-0038（scope 契约）

---

## 1. 背景（Context）

中文检索没有空格天然分词，M5 又明确不引入词库/分词器依赖（保持零外部
依赖、可重建）。需要一个在 better-sqlite3 内建 SQLite 3.53.4 上即可用、对
中文/拉丁子串都正确、且能与向量路用统一 RRF 融合的关键词策略。同时，新链
路上线前用 shadow 对拍旧 `/api/search` 防回归，但 RRF/标题 boost 是**有意的
排序改进**，与旧链天然存在顺序差异，闸门"什么算失败"必须重新界定，否则误报
会拖垮整个对拍机制。

## 2. 决策（Decision）

### 2.1 FTS5 trigram，3 码元门槛；短词回参数化 LIKE；无词库

- `fts_chunks USING fts5(title, body, chunkId UNINDEXED, nodeId UNINDEXED,
  entityType UNINDEXED, tokenize='trigram remove_diacritics 1')`。
- spike §3 实测：trigram 对中文/拉丁 **≥3 字符**子串命中正确；**2 字词命中
  0**。故按码元长度分流（queryPlan 纯函数）：码元 ≥3 走 trigram MATCH
  （用户输入包双引号短语并转义，MATCH 左值用虚表名）；码元 <3 回退对
  title/body 的**参数化** LIKE（`%`/`_`/`\` 经 ESCAPE 转义，复用
  ADR-0005 有界口径，无字符串拼接）。
- **不引入任何分词词库/ jieba 等依赖**：trigram 以子串匹配覆盖中文，靠
  RRF 与 BM25 排序，避免词典维护与派生依赖。
- 排序：FTS 路用 `bm25(fts_chunks)` rank；短词 LIKE 路无 BM25（按 rowid/
  插入序），两路结果统一进 RRF（ADR-0046）。

### 2.2 标题 boost 标定（S11，常量已冻结）

默认 `k=60` 时单路 rank=1 的 RRF 权重 = `1/(60+1) ≈ 0.016393`，取为标尺：

| 常量（rrf.ts 导出） | 取值 | 与 1/(k+1) 的关系 |
|---|---|---|
| `TITLE_EXACT_BOOST`（标题 trim 后大小写不敏感**精确等于** q） | **0.016** | ≈0.98 个 rank-1 单位，**严格小于一整个单位** |
| `TITLE_PREFIX_BOOST`（标题以 q 为**前缀**） | **0.008** | exact 的一半 |

语义与硬约束：

1. **每实体跨路取最大、只加一次**：实体任一命中 chunk 标题（record
   identity=记录 id、record field=字段名、doc/canvas=标题(+章节路径)）等于
   查询得 exact、前缀得 prefix；多 chunk/多路命中不重复累加。
2. **单调**：`exact(0.016) > prefix(0.008) > 无(0)`，排序可解释。
3. **有界、不挤出多路强命中**：因 exact 严格小于一整个 rank-1 单位，
   `单路 rank-1 标题精确 = 1/61 + 0.016 ≈ 0.0324` **<**
   `两路 rank-1 正文 = 2/61 ≈ 0.0328`——标题精确命中仍压不过两路正文强命中，
   不会越级把明显不相关结果顶掉；同时足以把强名次标题命中拉到纯正文单路
   rank1（0.0164）之上。
4. **缺省/空 titleQuery 零加成**：仅当 `reciprocalRankFusion(...,
   {titleQuery})` 给出且非空才加成；否则计分与历史**逐位一致**（保证旧链
   golden 零 diff、无命中时新链行为不变）。

小样标定（q=「季度报告」，确定性断言）：排序
`bodyStrong(两路正文 0.0328) > exactWeak(单路 rank6+exact 0.0312) >
prefixA(0.0241) > veconly(纯向量 rank1 0.0164)`；不相关纯向量命中不被顶到
标题命中之前。

### 2.3 shadow 闸门语义裁决（2026-09-17 项目总监裁决）

> 这是**对计划 §6 原句的带日期修订**。计划正文只加了注（:598 裁决注记）、
> **未改写原句**（:594 表内仍作"drift 非0 即失败"）；权威语义以本 ADR 与
> 该注记为准。

**背景问题**：原 `queryShadow.ts` 定义
`driftCount = overDeny + overAllow + (orderDiffer ? 1 : 0)`，
`GX_M5_SHADOW_STRICT=on` 时可比集 drift>0 -> 500。S11 确定性证据
（query-shadow-boost-drift.test.ts，4 例，real RRF + real compare）：

- 合成段：无 boost 序 `[a,b,c]` -> `orderDiffer=false, driftCount=0`；同输入
  加 titleQuery 重排为 `[b,a,c]` -> `orderDiffer=true, driftCount=1`
  （overDeny=overAllow=0，**纯 ORDER 漂移**）；换成不命中词顺序复原、drift
  回 0——证明翻转由加成单独引起。
- 真 search.db LIKE 段：LIKE 路无 ORDER BY，SQLite 按 rowid（=插入序=
  createdAt asc）返回，与旧链 record 序 `createdAt asc` 在单表/单批下天然
  一致，故"boost 前两链顺序一致"是常见姿态，boost 一重排即翻 drift。
- 更根本：**FTS 路新链序 = bm25 rank、旧链序 = createdAt asc，多实体本就
  倾向 orderDiffer=true**——这是 S7 引入新链起就存在的隐含假设，boost 只是
  更易触发。

**裁决**：

- shadow `strict` 判据 = **集合漂移**（set drift）：`overDeny`（漏召回）+
  `overAllow`（多召回）。实现为新增 **`setDriftCount = overDeny +
  overAllow`，作为 strict 的唯一判据**。
- **ORDER 漂移降为可观测项**：`driftCount` 保留为
  `setDriftCount + (orderDiffer?1:0)` 的**含 ORDER 可观测总量**，仍计入
  registry（`counts.order`）并 `console.warn`，但**不再导致 strict 失败/
  500**。

**理由**：闸门的安全价值是抓"漏召回/多召回"（越权或丢结果）；RRF 与标题
boost 是**设计内**的排序改进，FTS 路 bm25 vs 旧链 createdAt 本就倾向顺序
差异（S7 起隐含）。把设计内行为算失败会形成误报 -> 报警疲劳 -> 有人把整个
闸门关掉，**连集合保护一起丢**。长期稳定性要求"硬门只对真正的错误失败，
其余保留为信号"。

**实施与反证（集合保护未被弱化）**：

- `queryShadow.ts`：新增 `setDriftCount`（strict 唯一判据）；`driftCount`
  保留为含 ORDER 的可观测总量；comparable 口径、overDeny/overAllow 计算、
  vector_route/empty_query 跳过逻辑**逐位未改**。
- `routes/v1/search.ts`：strict 失败判据 `report.driftCount>0` ->
  `report.setDriftCount>0`。
- registry：ORDER-only 漂移仍计数 + warn（观测不丢）。
- **反证用例**：queryShadow.test.ts overDeny/overAllow 例断言
  `setDriftCount>0`；query-v1-route.test.ts 真实 overDeny（member-only 表无
  r 策略）/overAllow 用例在 `GX_M5_SHADOW_STRICT=on` 下仍 **500
  `M5_SHADOW_DRIFT`**。
- **影响面**：仅 `GX_M5_SEARCH=shadow` 且 `GX_M5_SHADOW_STRICT=on`；`on`
  档不跑 shadow -> **生产（on）零影响**。boost 常量未动。

## 3. 被否决的备选

1. **引入中文分词词库（jieba 等）**：新增运行时依赖与词典维护，违背零外部
   依赖/可重建；trigram 子串 + RRF 已覆盖召回，排序由 BM25/boost 承担。
2. **2 字词也强制 trigram**：实测 trigram 对 2 字命中 0，会漏召回；定稿
   <3 码元回参数化 LIKE。
3. **标题 boost ≥ 一个 rank-1 单位或跨路累加**：会把单路标题命中顶过多路
   正文强命中、且重复累加失真；定稿每实体一次、exact 严格小于一单位。
4. **strict 继续把 ORDER 差异算失败**：设计内排序改进触发误报->报警疲劳->
   闸门被整体关闭；定稿硬门只守集合漂移，ORDER 降可观测。
5. **完全关掉 ORDER 对拍**：会丢失排序退化的信号；定稿保留 registry 计数 +
   warn，只是不再 500。

## 4. 后果（Consequences）

- 关键词路对 1 字/2 字中文短词与 ≥3 字子串都可召回，无词典依赖；LIKE 路
  必须坚持参数化 + 转义 + 有界（ADR-0005）。
- 无标题命中时新链计分逐位不变，旧 `/api/search` S0 golden 字节零 diff
  （boost 只在新链 rrf.ts，旧链不引用）。
- shadow strict 的通过含义收敛为"集合零漂移"；顺序差异作为观测信号长期
  保留，排障时看 registry `counts.order`/warn。
- 硬门不再对设计内排序改进误报，闸门可长期开启而不被关闭。

## 5. 验证证据

- trigram 门槛：docs/_archive/originals/planning-phase2-spike-sqlite-vec.md §3（≥3 字符命中、2 字命中 0）。
- boost 标定：docs/baseline/2026-09-17-m5-gate.md §3.1–3.4（常量/单位关系/
  小样表/接线/旧链零 diff）；rrf-title-boost.test.ts（15 例）、
  query-title-boost.test.ts（3 例端到端）。
- shadow 裁决：同文件 §3.5；query-shadow-boost-drift.test.ts（4 例翻转
  确定性证据 + setDriftCount=0）、queryShadow.test.ts（12 例，overDeny/
  overAllow->setDriftCount>0；纯 ORDER->orderDiffer=true,setDriftCount=0,
  driftCount=1）、query-v1-route.test.ts（6 例，集合漂移 STRICT 下仍 500）。
- 计划注记：docs/_archive/originals/planning-phase2-M5-implementation-plan.md §6 :598（2026-09-17 裁决注，原句
  :594 未改写）。
