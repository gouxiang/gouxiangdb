# ADR-0049：reindex 双库原子切换与派生库损坏自愈

**状态（Status）**：Accepted（M5 计划 §11 第 8 条、§4.9/§5.4 定稿；S9 双库切换真机演练与 S12 AC-M5-1 损坏自愈对抗已过；2026-09-17 M5 出口归档）
**作者**：架构师 高见远（M5-S14 归档；实现由后端 贝洛奇 落地）
**上游依据**：docs/_archive/originals/planning-phase2-M5-implementation-plan.md §5.4（reindex 两步 :575-579）、§4.9（降级矩阵 :505-507）、§11（:714）；docs/runbooks/m5-search.md §4（损坏自愈程序）
**关联**：ADR-0042（独立 search.db，rename/rm 的物理前提）；ADR-0043（reindex 扫表不依赖事件史）；ADR-0048（可重建派生产物、不进备份）；ADR-0005（LIKE 有界应急）

---

## 1. 背景（Context）

派生 search.db 是可重建资产（ADR-0048），但它在生产中承担检索流量，带来两个
可用性问题：(a) 全量 reindex 往往耗时不短，灌库期间不能让检索返回空或长时间
不可用，也不能让外部看到半成品库；(b) search.db 可能因磁盘/异常关机而损坏或
打不开，此时检索不能 500、主应用写不能受影响。需要一套"灌库无空窗 + 损坏自愈
且当次仍有结果"的机制。

## 2. 决策（Decision）

### 2.1 双库原子切换：临时库 rebuild + POSIX rename

`POST /api/v1/admin/reindex {type?,entityId?}`（role_owner；CLI
`pnpm gx:reindex` 停机直跑同函数，`--with-config` 保留一步）：

1. index_meta 置 rebuilding=1 + 审计（search_reindex_started）。
2. 在独立临时文件 **`search.db.rebuild-<ts>`** 自举空库（按当前 dim 建
   vec_chunks），**扫主库活实体直接灌**（不经 change_events 事件史，
   ADR-0043）。
3. 灌完后用 **POSIX rename 原子替换**正式 search.db；灌库期间**旧库持续可读、
   新库对外不可见**，不存在"半空库被检索到"的窗口。
4. 切换瞬间 worker 与只读连接重开到新库，rebuilding=0，审计 done。
5. **进程锁同步 409**：rebuilding=1 期间再调 reindex 返回
   `409 REINDEX_IN_PROGRESS`（单实体原地更新走另一条路径，不需全量切换）。

### 2.2 派生库损坏自愈：分类 -> 隔离 -> 重开空库 -> 后台重播 -> 当次 LIKE 应急

当 search.db 打不开/查询报损坏时：

1. **错误分类**：仅当命中 `SQLITE_NOTADB` / `SQLITE_CORRUPT` / `malformed`
   等**真损坏**信号才启动自愈。**文件缺失不算损坏**——search.db 不存在是正常
   懒初始化（首启），直接建空库，不产生 `.corrupt-*`。
2. **只隔离、不删除**：把主库文件与**存在的** `-wal`、`-shm` **三件一起
   rename** 成 `search.db.corrupt-<unixms>`（同毫秒再损坏追加 `-2`/`-3`，
   不覆盖证据）。保留事故证据，需空间时整体成组归档异机，不就地删。
3. **重开空库 + 后台重播**：在原路径打开全新空库（自举 DDL），由后台
   outbox/reindex 重播重新灌入；重播期间旧数据不可查，但库本身可用。
4. **当次检索不 500——回主库参数化 LIKE 应急**：scope 实时收敛后，对**主库**
   title/searchText/主字段做**参数化** LIKE（复用 ADR-0005 有界语义，top20、
   limit≤50、无字符串拼接）。响应 `mode:"like"`、`degraded` 含
   **`search_store_recovering`**。
   - 应急候选**仅来自实时 scope**（表级收敛仍在，节点不可见整缺席）。
   - **字段 fieldMask fail-closed**：应急 LIKE 路没有字段 chunk 拆分能力，
     对字段级可见性采取 fail-closed——不返回无法确认字段可见性的片段，摘要
     只用可确认可见字段，确保降级不放大泄漏。
   - 重播完成后自动回 `fts`/`hybrid`，`search_store_recovering` 标记消失。

### 2.3 model/dim 与 fieldChunkCap 变更两步走（不自动重建）

- PATCH embedding/config 改 mode/model **不自动重建**，返回
  `reindexRequired:true`（请求体带 `reindex:true` 一律 400
  EMBEDDING_CONFIG_INVALID）。
- 新 model 首批 embed 返回 dim 与旧库 `index_meta.embedding_dim` 不符即
  `dim_mismatch`，拒向量路、回 FTS/LIKE，直到管理员显式调 reindex 经 2.1
  重建。
- 调整 `fieldChunkCap`（N）同样标记受影响记录需 reindex，不隐式触发全量重建。

## 3. 被否决的备选

1. **原地 DROP + 重建**：灌库期间检索空/不可用，存在长窗口；定稿双库 rename。
2. **跨库事务/ATTACH 切换**：SQLite 无跨文件原子事务，ATTACH 耦合 WAL/锁
   （ADR-0042 已否决）；单文件 POSIX rename 才是原子点。
3. **损坏即删库重建**：销毁事故证据、无法事后取证；定稿只 rename 隔离。
4. **损坏当次返回 500 或空结果**：违背 AC-M5-1"检索降级可用、主应用可写"；
   定稿回主库 LIKE 应急。
5. **应急 LIKE 路放宽字段可见性以求召回全**：降级不得放大泄漏；fieldMask
   fail-closed。
6. **改 model/dim/N 后自动后台全量重建**：可能在未确认时触发大规模 cloud
   出网与长任务；定稿两步走、管理员显式触发。

## 4. 后果（Consequences）

- reindex 对在线检索无空窗（旧库服役到 rename 瞬间）；并发 reindex 被 409
  挡住，靠 index_meta.rebuilding + 进程锁（不引分布式锁）。
- 损坏恢复期间检索降级为 scope 收敛后的主库 LIKE，功能收窄但不中断、不越权；
- 数据目录会累积 `.corrupt-<ts>` 证据文件，运维须按 runbook 成组归档/清理，
  监控关注 `search_store_recovering` 跳变审计（search_degraded）。
- 切换/自愈依赖**本地盘 POSIX rename 原子性**，故 search.db 严禁放 NFS/网络盘
  （ADR-0042、runbook §7 前置）。

## 5. 验证证据

- 双库切换真机演练：M5-S9（临时库 rebuild-<ts> + rename、灌库期旧库可读、
  409、幂等连跑等价、切换瞬态只读连接重开）。
- 损坏自愈对抗：M5-S12 AC-M5-1（分类 NOTADB/CORRUPT/malformed、三件 rename
  `.corrupt-<ts>`、重开空库 + 后台重播、当次 mode='like' +
  search_store_recovering、fieldMask fail-closed、恢复后欠账补齐）。
- 运维程序：docs/runbooks/m5-search.md §4（损坏判定、三件 rename、应急 LIKE
  top20/limit50、缺文件不算损坏、`.corrupt-*` 不删、日志与响应标记窗口）。
- 两步配置：M5 计划 §5.4；S9 openapi（reindexRequired、409/400 错误码）。
