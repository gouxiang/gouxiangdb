# ADR-0048：授权信息不入索引、权限变更零 reindex + 字段 chunk 召回前排除模型

**状态（Status）**：Accepted（M5 计划 §11 第 7 条、§4.7（Q4 裁决强度）、§4.8、§15 Q4 定稿；S8/S10 已过 AC-M5-2 与权限即时失效对抗；2026-09-17 M5 出口归档）
**作者**：架构师 高见远（M5-S14 归档；实现由后端 贝洛奇 落地）
**上游依据**：M5-implementation-plan.md §4.6（身份/字段拆分 :451-462）、§4.7（Q4 :464-487）、§4.8（:489-493）、§11（:713）、§15 Q4（:751）
**关联**：ADR-0035（字段 mask 落表策略行）；ADR-0038（scope 与 maskedTableFields 契约）；ADR-0046（先收敛后召回）；ADR-0042（独立可重建派生库）；ADR-0049（损坏自愈）

---

## 1. 背景（Context）

统一检索要同时满足两个看似冲突的要求：(a) 被字段级 mask 与节点级不可见
保护的内容，不能从搜索的任何一路（FTS/LIKE/向量）或摘要中泄漏；(b) 调岗、
收权、继承中断、move 等权限变更必须"下次搜索即变"，不能等待 reindex。若把
"谁能看"写进索引（按授权域分片、为每主体建索引或落盘加密），则每次授权
变更都要重建索引，且派生库膨胀到与主库同等敏感。Q4 裁决要求给出一个既零
泄漏又零 reindex 的强度模型。

## 2. 决策（Decision）

### 2.1 授权信息一律不入索引

chunks/fts_chunks/vec_chunks/field_grant **不含任何主体授权位**（无
userId/角色/允许集合列）。索引只描述"内容是什么、属于哪个 node/table/
field"，不描述"谁能看"。"谁能看"完全由检索时的 M4 scope 实时求解。

- **节点级可见性由查询时 scope 承担**：每次检索先 resolveVisibleNodeIds
  现算（M4 决策无跨请求正缓存、policyVersion 递增），物化为 temp_scope，
  INNER JOIN 收敛。nodeId 稳定性（M3 move/rename id 不变）是前提；purge 后
  悬空 chunks.nodeId 由删除事件清理 + INNER JOIN temp_scope 天然不可达 +
  覆盖度 C 类巡检清除。
- **权限变更零 reindex**：调岗/角色收授/继承开关/tree 移动只影响 scope 计算，
  索引行一个字节都不用改；AC-M2-1"下次请求即变"在检索通道自动成立（S10
  对抗：移出部门/收 direct/移除角色/中断继承/重开/move 后下一次搜索即变，
  无 reindex、无缓存等待、policyVersion 递增回传）。

### 2.2 字段级：身份/字段 chunk 拆分 + field_grant 召回前收敛（Q4 强度）

写入侧（无主体、按字段分块）：

1. 可被任何 r 策略 mask 的业务值**只进 field chunk**，不进 identity chunk；
   record 的 identity chunk 仅含表名/Base 名/记录定位标题（primaryField 被
   mask 时回退 record id），不含可被字段 mask 的业务值。因此不存在"一条含
   全部字段的 chunk 被部分 mask"的矛盾。
2. 每个 record field chunk 在 `field_grant(chunkRowid, tableNodeId, fieldId)`
   登记；identity chunk 不登记。计算字段不索引；超 fieldChunkCap 按确定性
   规则截断（Q7）。

查询侧（每主体，召回前收敛）：

3. scope 返回 `maskedTableFields`（tableNodeId -> 该用户有掩码字段），物化为
   temp_field_grant 白名单行；allowed 三分支谓词（ADR-0046 §2.3）保证被 mask
   的 field chunk 在 **FTS MATCH / vec KNN 之前**就被排除——不进候选、不占
   top-k、不进向量距离计算。
4. 摘要只用 fieldMask `canSeeField` 可见字段重拼；title 候选被 mask 回退
   record id（M4 A-4）；`matchedField` 对 mask 字段返回 null，措辞不出现
   "无权限"、不反证字段存在。
5. 表级不可见（无该表 r）：tableNodeId 不在 temp_scope，identity 与 field
   全部 INNER JOIN 落空，整实体缺席。

### 2.3 明确不做：授权域分片索引 / 落盘加密

- **不做按授权域分片索引**（不为每主体/每域建向量或 FTS 索引）：存储放大与
  重建成本与 M5 单机 MVP 不相称，且授权一变就要重建，违背零 reindex。
- **不做 search.db 落盘加密**：见 2.4 威胁模型——派生物不引入比主库更高的
  敏感度，加密的复杂度/密钥管理与收益不匹配。

### 2.4 search.db 是同机可重建派生产物（威胁模型口径）

被 mask 字段的文本作为派生行**物理存在于磁盘**，但按主体在召回前排除；这是
产品语义强度，其安全论证建立在"派生库不引入新增越权面"上：

1. **不进备份**：在线备份（ADR-0007）只备 `DATABASE_URL` 主库；search.db
   内容由主库活实体经 outbox/indexer 或 reindex 随时重建，换机/恢复主库后
   无需恢复 search.db。
2. **可随时 reindex 重建**：双库原子切换（ADR-0049），重建不依赖事件史。
3. **文件系统权限等同主库 dev.db**：同机同用户、同 0600 文件 / 0700 目录
   口径。能读到 search.db 的攻击面，本就已经能读到主库全量明文——派生物不
   引入新增越权面。
4. **网络面由 scope + field_grant 召回前收敛 + 二次 decide 封口**（AC-M5-2
   对拍：命中实体集合 == 逐实体 decideMany 允许集，零差；无任何
   snippet/title/matchedField 含 mask 原文）。
5. **版本号仅用于缓存失效**：policyVersion 回传供前端作废缓存，M5 不建结果
   缓存，也不用版本号做任何授权存储。

## 3. 被否决的备选

1. **授权位/允许集合写进索引行**：授权变更即需 reindex，且派生库与主库同
   敏感；违背零 reindex 与可重建定位。
2. **每主体/每授权域分片建索引**：存储与计算放大，MVP 不可接受。
3. **search.db 落盘加密**：派生物敏感度不高于主库、文件权限同级，加密徒增
   密钥管理复杂度；Q4 明确不做。
4. **先召回后在应用层过滤 mask**：无权片段已离开库、进入距离/排序/摘要，
   无法防侧信道与 top-k 占位；Q4 定稿召回前排除。
5. **把 mask 文本混入 identity chunk 再打标记**：一条 chunk 部分可读的矛盾
   无法在召回前按字段排除；定稿身份/字段物理拆分。

## 4. 后果（Consequences）

- 权限/组织变更对搜索即时生效、零 reindex、零缓存等待（S10 全对抗）。
- search.db 不进备份、不入敏感资产清单；运维须保证其文件权限与主库同级、
  落本地盘（非 NFS/只读安装目录）。
- 字段保护依赖"M4 scope/mask 正确 + 召回前三分支谓词 + 二次 decide"三层；
  任一层回退都会被 AC-M5-2 对拍与 S8 字段对抗抓住。
- 被 mask 文本物理在盘这一事实必须在 runbook「search.db 资产边界」明示
  （已落 m5-search.md §5），不得对外宣称"密文不可见"。

## 5. 验证证据

- 字段零泄漏：M5-S8 AC-M5-2 字段系统对抗（多主体×多资源×三 mode，独特语句
  hybrid/fts/like 逐一检索；集合对拍零差、无 mask 原文、EXPLAIN 三路含
  temp_scope/field_grant 且先于 MATCH/KNN、mock decide 拒绝结果被二次校验
  丢弃）。
- 权限即时失效：M5-S10 AC-M5-3（调岗/收 direct/移除角色/中断继承/重开/
  move 后下次搜索即变，无 reindex、policyVersion 递增）。
- EXPLAIN：docs/baseline/2026-09-17-m5-gate.md §1（temp_field_grant
  CORRELATED SCALAR SUBQUERY 三分支；temp_scope 覆盖索引先于产出）。
- 资产边界：docs/runbooks/m5-search.md §5（不进备份、换机无需恢复、权限同级、
  不做分片/加密）。
- 契约：ADR-0038（maskedTableFields）、ADR-0035（mask 落表策略行）。
