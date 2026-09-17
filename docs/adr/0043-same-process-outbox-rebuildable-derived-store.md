# ADR-0043：同进程 outbox + 可重建派生库（主写零等待）

**状态（Status）**：Accepted（M5 计划 §11 第 2 条、§4.3/§5.2/§5.3 定稿；S1 独立 PR 已落并过"共生死/主写无回退"门；2026-09-17 M5 出口归档）
**作者**：架构师 高见远（M5-S14 归档；实现由后端 贝洛奇 落地）
**上游依据**：M5-implementation-plan.md §4.3（:323-349）、§5.2（接线点清单 :552-566）、§5.3（worker 状态机 :568-573）、§11（:708）
**关联**：ADR-0042（独立 search.db）；ADR-0049（reindex 双库切换）；ADR-0048（派生库可重建资产边界）

---

## 1. 背景（Context）

业务写路径（record/doc/canvas 的建改删、软删恢复、公开编辑、表删级联）
必须让派生 search.db 随之更新，但绝不能被向量/全文索引拖慢或被远端
embedding 故障阻断。两类反模式要避免：

- **写路径同步建索引/调远端**：一次 record 编辑要等抽文本、FTS 写、cloud
  `/v1/embeddings` 往返才返回，cloud 超时即主写失败——违背"主应用编辑全程
  可写"（AC-M5-1）。
- **纯触发即忘（fire-and-forget）无事务保证**：写完业务再异步投个消息，
  崩溃/回滚时消息与数据不一致，且无补偿重放的权威来源。

## 2. 决策（Decision）

采用**同进程事务内 outbox + 异步单写 worker + 扫表可重建**三段：

### 2.1 change_events 同事务共生死

主库新增 `change_events`（手写迁移 #21 DDL + `app_settings`，#22 活实体
播种）。每个既有写点在**同一个 withWriteTx 事务内**，业务写之后调用
`enqueueChangeEventTx(tx, {...})`：

- **合并去重**：先 `UPDATE ... SET version=?,op='upsert',status='pending',
  nextRunAt=now,lastError=NULL WHERE entityType? AND entityId? AND status
  IN('pending','failed')`，count=0 才 INSERT；processing/done 不动（done 后
  再编辑产生新事件行）。
- **共生死**：outbox INSERT 失败随主事务整体回滚；业务回滚则事件不留。
  op=upsert|delete；软删发 delete、恢复发 upsert、物理 purge 发 delete 并由
  worker 清派生行。
- **S1 是唯一触碰 M2/M3/M4 既有写点事务的例外**：S1 独立 PR、触碰点清单
  在计划 §5.2 逐点单列（records.ts/kb docs.ts/public.ts 等）；之后 S2–S13
  不再改这些写点事务。

### 2.2 worker 异步，主写零等待

同进程单例 indexer（`GX_SEARCH_WORKER` 开关，不演化成独立进程/外部队列）：

- **认领**：SQLite 3.53 `UPDATE ... RETURNING` 取一条 pending，单写者 +
  `index_meta.worker_lock` 时间戳防双开重复（不引分布式锁）；单轮批 50、
  空闲轮询 2s、启动延迟 3s。
- **处理**：取实体（活/deletedAt）-> delete 清四表派生行（chunks/fts/vec/
  field_grant 按 entityId，rowid 联动）-> upsert：抽文本与身份/字段 chunk
  拆分 -> 删旧行 -> 取新 rowid -> 写 chunks/fts/field_grant -> cloud 才
  provider.embed 写 vec（off 跳过）。
- **退避**：失败置 failed + `nextRunAt` 指数退避（10s/1m/10m/1h），
  `attempts≥8` 转 **dead**（不再自动重试，status 暴露 backlog/dead）。
- **FTS 优先、向量欠账**：FTS 写成功即事件 done（检索可用性优先）；cloud
  401/故障期向量欠账，由覆盖度对账（chunks LEFT JOIN vec_chunks，D 类）
  周期补发，恢复后补齐。worker 卡死/积压时旧索引继续服务，主写不受阻。

### 2.3 reindex 扫表，不依赖事件史

全量重建（ADR-0049）直接**扫主库活实体**灌入 `rebuild-<ts>` 临时库，不经
change_events 历史。因此事件表可以是短命的、可清理的，丢历史/乱序/漏投都
不影响最终可收敛性——派生源的权威永远是主库当前活数据，而非事件流。#22
播种（活实体 NOT EXISTS 幂等分批 INSERT）保证空 search.db 首启自动建索引，
不靠手工 reindex。

## 3. 被否决的备选

1. **写路径同步 embed/建索引**：主写被远端时延与故障绑架，违背主写零等待。
2. **事务外 fire-and-forget**：回滚留事件/崩溃丢事件，无权威补偿源。
3. **外部消息队列/独立索引服务**：MVP 部署与故障面过大；SQLite 单库同事务
   outbox + 单写者已满足串行一致，无需跨进程锁。
4. **以事件史为重建依据（event sourcing）**：事件表会膨胀且必须永久留存；
   定稿以主库活数据为唯一重建源，事件仅作触发。

## 4. 后果（Consequences）

- 主写路径只多一条同事务 INSERT（合并去重后通常更省），噪声级差值；主写
  P95 无回退为 S1 验收项。
- 检索相对编辑存在受控最终一致窗口（worker 轮询/积压）；旧索引在重建完成
  前继续服务，不返回空。
- 迁移数 20 -> 22；down SQL DROP 两表（事件表只被 M5 读，删除不影响旧功能；
  主回滚靠发布前快照）。
- dead 事件需运维可见并可通过 reindex 兜底；覆盖度 A–F 巡检（含 A 漏索引、
  D 向量欠账、F 字段授权漏登）exit 非 0 供 CI/运维。

## 5. 验证证据

- 迁移与接线：迁移 20260916140000_m5_search_outbox_ddl、
  20260916140100_m5_search_outbox_seed；domain/search/outbox.ts
  （enqueueChangeEventTx）、indexer.ts（认领/状态机/退避/删除/对账）。
- 接线点清单：M5 计划 §5.2（records/kb/public 逐点同事务）。
- 起点事实：docs/baseline/2026-09-16-m5-baseline.md §4（S0 grep 实证
  change_events/outbox 生产零实现，由 S1 落地）。
- 独立 PR：M5-S1 commit A（迁移+原语单测不接线）、commit B（全写点同事务
  接线）；S12 主应用编辑链路时延证据（cloud 断网/坏 endpoint 下可写）。
