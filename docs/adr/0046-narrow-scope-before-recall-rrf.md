# ADR-0046：先收敛后召回（temp_scope + field_grant 物化 + RRF）

**状态（Status）**：Accepted（M5 计划 §11 第 5 条、§4.5 实现细则定稿；S7/S8/S11 已过 AC-M5-2 与 EXPLAIN 门；2026-09-17 M5 出口归档）
**作者**：架构师 高见远（M5-S14 归档；实现由后端 贝洛奇 落地）
**上游依据**：M5-implementation-plan.md §4.5（:388-449）、§11（:711）、§13 AC-M5-2（:731）；ADR-0038（M4 scope 两形态契约）
**关联**：ADR-0038（scope 契约与 >499 临时表纪律）；ADR-0035（field mask 表策略行）；ADR-0048（字段 chunk 召回前排除模型）；ADR-0047（FTS/trigram/RRF 与 shadow 裁决）

---

## 1. 背景（Context）

统一检索有 FTS（trigram MATCH）、短词 LIKE、向量 KNN 三条召回路。若各路
先把全库召回再在应用层按权限过滤，无权数据已经离开 search.db、进入距离计算、
RRF 排序与摘要拼接——既慢（暴力 KNN 还要为无权行算距离）又会从
top-k 占位/snippet/日志侧泄漏。M4 已把"这个用户能看到哪些 node"的 scope
契约定稿（ADR-0038），M5 必须在召回前把它与字段授权物化为 SQL 收敛集。

## 2. 决策（Decision）

### 2.1 AC-M5-2"零泄漏"的工程定义

无权 id **不进入任何一路召回**。表级不可见节点由 temp_scope INNER JOIN 在
产出前整体剔除；字段级被 mask 的 field chunk 由 temp_field_grant 在
FTS MATCH / vec KNN **之前**排除（字段模型细节见 ADR-0048）。这不是"召回后
过滤干净即可"，而是收敛必须物理出现在查询计划里。

### 2.2 每检索会话先物化两临时表

search.db 只读会话内：

1. `CREATE TEMP TABLE temp_scope(nodeId TEXT PRIMARY KEY)`，把 M4
   resolveVisibleNodeIds 返回的 nodeIds 批量 INSERT（**每批 ≤499**，SQLite
   999 变量上限留余量；M5 一律走临时表，不按 M4 的 IN/临时表两形态分支直拼）。
   scope 为空 -> 直接返空（EMPTY_SCOPE_PREDICATE，不跑召回）。
2. `CREATE TEMP TABLE temp_field_grant(tableNodeId TEXT, fieldId TEXT)`，
   只物化 scope.maskedTableFields 中**有 mask 的表**的白名单行；空表代表
   "无字段收窄"。

### 2.3 allowed 三分支谓词（S3 勘误，勿回退二分支）

因 temp_field_grant 只登 mask 表，召回 allowed 必须是三分支：

```
chunkKind='identity'
 OR NOT EXISTS(SELECT 1 FROM temp_field_grant g0 WHERE g0.tableNodeId=c.nodeId)
 OR EXISTS(SELECT 1 FROM temp_field_grant g
           WHERE g.tableNodeId=c.nodeId AND g.fieldId=c.fieldId)
```

(1) identity chunk 恒可见；(2) 该 scope 内表在 temp_field_grant 无任何行
（=无 mask）-> 全部 field chunk 可见；(3) 有 mask 表仅白名单字段可见。早先稿的
二分支 `identity OR EXISTS` 会把无 mask 表的 field 全部误隐，已废弃。

- FTS 路（码元≥3）：trigram MATCH，`WITH allowed AS (... JOIN temp_scope
  ...)` 后 JOIN fts_chunks，`ORDER BY bm25 LIMIT 100`。
- LIKE 路（码元<3）：allowed 同构，title/body 参数化 LIKE（%/_/\ 转义），
  LIMIT 100。
- vec 路（与门通过）：先求收敛 rowid 集（allowed_rowid 子查询），KNN
  `WHERE embedding MATCH ? AND entityType IN (...) AND rowid IN
  (allowed_rowid) ORDER BY distance LIMIT 100`。S11 已实测 vec0 接受该子查询，
  EXPLAIN 下推为 `LIST SUBQUERY`，收敛发生在 KNN 扫描约束中，**非全量 KNN
  后过滤**；收敛独立于 k（100 个距离≈0 越权行在 k=10 时也挤不掉白名单），
  无需 hash(rootNode) 分桶退路。严禁静默退回"全量召回后应用层过滤"。

### 2.4 RRF 融合 + 实体聚合 + 二次 decide

- 每路 score = `1/(60+rank)` 累加，标题 boost 见 ADR-0047；默认 k=60，
  每路 top100。
- 实体聚合：同 entityId 多 chunk（identity + 多 field + doc 多块）取
  max(score)；doc 带命中 chunk seq。
- **纵深防御二次 decide**：top 候选逐实体 `decideMany(prisma, subject,
  nodeIds, 'r')`，与 scope 用同一判定内核；失配丢弃并记 metric。正常应为 0，
  非 0 = scope 快照与决策不一致的 bug 信号（不用于常态授权，只兜底）。
- 粒度对齐：record 不建 nav 节点，record chunk 的 nodeId=tableNodeId，scope
  kinds 取 `table`；doc/canvas 挂各自节点。

### 2.5 truncated 诚实标记

M4 budget 默认 5000、硬顶 20000；超限 temp_scope 只装截断集时，响应必须
`scopeTruncated:true` 并提示缩小范围，**不得静默只搜部分却谎称全量**。

### 2.6 EXPLAIN 铁律

三路召回 EXPLAIN 必须出现 temp_scope/allowed 的 JOIN/过滤在结果产出前；
vec0 本就 SCAN（无 ANN），WHERE/子查询下推即满足（S11 留证）。

## 3. 被否决的备选

1. **先召回后过滤（应用层过滤）**：无权数据进入距离/排序/摘要管线，慢且
   无法防 top-k 占位与侧信道；AC-M5-2 明确禁止。
2. **SQLite CTE 递归算可见集**：难与 decide 同口径，必然两处判定漂移；
   集合运算上移应用层复用同一纯函数（ADR-0038）。
3. **超长 IN 直拼**：撞 999 变量上限且有注入面；M5 一律临时表批量绑定。
4. **二分支 identity OR EXISTS 字段谓词**：在"只物化 mask 表行"前提下误隐
   无 mask 表全部字段；定稿三分支。
5. **靠 hash 分桶做向量权限收敛**：S11 证明 rowid IN 子查询独立于 k 生效，
   分桶退路不需要。

## 4. 后果（Consequences）

- 权限收敛相关 SQL 与节点数/主体数**解耦（常量级）**：建表/召回/清理固定
  条数，唯一随规模变化的是 temp_scope/temp_field_grant 的批量 INSERT（每
  499 行一批亚线性增长），召回语句恒 1 条（S11 计数证据）。
- 权限/调岗/继承/move 变更**零 reindex**：授权信息不在索引里，每次检索现算
  scope，下次请求即变（ADR-0048、S10 对抗）。
- 超大客户（可见 node >20000）走截断集并诚实提示，不假装全量。
- 暴力 KNN 成本 ∝ 索引内向量总数 N、与 scope 大小无关（收紧 scope 不省 KNN
  扫描），容量后果见 ADR-0044。

## 5. 验证证据

- 实现：domain/search/query.ts（scope/字段物化 + 三路 + 聚合 + 二次
  decide）、queryPlan.ts（buildAllowedPredicate 三分支/码元分流/转义）、
  fieldGrant.ts（buildFieldGrantRows）、rrf.ts。
- EXPLAIN：docs/baseline/2026-09-17-m5-gate.md §1（三路 temp_scope 覆盖
  索引搜索；vec 路 LIST SUBQUERY；field_grant CORRELATED SCALAR SUBQUERY）。
- SQL 计数常量化：同文件 §2（1 vs 450 节点语句数一致；grant 0 vs 450 仅
  +1；500/1000 仅多批量 INSERT；召回语句恒 1）。
- KNN×白名单：query-s11-knn.test.ts（3 组 k + EXPLAIN + 反面对照，收敛独立
  于 k）。
- 字段零泄漏：M5-S8 AC-M5-2 字段系统对抗；权限即时失效：M5-S10。
