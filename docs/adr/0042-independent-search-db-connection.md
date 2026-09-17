# ADR-0042：独立 search.db 分库连接（非 ATTACH、非主库虚表）

**状态（Status）**：Accepted（M5 计划 §11 第 1 条、§4.1 三连接拓扑定稿；spike-sqlite-vec §4/§8.1 实测通过；2026-09-17 M5 出口归档）
**作者**：架构师 高见远（M5-S14 归档；实现由后端 贝洛奇 落地）
**上游依据**：M5-implementation-plan.md §4.1（:213-262）、§11（:707）；spike-sqlite-vec.md §4（多库并存实测）、§8.1（SearchStore 单例）
**关联**：ADR-0002（SQLite 单库基线）；ADR-0004（EAV sidecar 只增索引）；ADR-0007（主库在线备份边界）；ADR-0044（vec0 暴力 KNN 与降级）；ADR-0049（双库原子切换与损坏自愈）

---

## 1. 背景（Context）

M5 需要在既有 Prisma 主库（main.db / dev.db，WAL，M1 起的串行写队列）之外
承载全文（FTS5 trigram）与向量（sqlite-vec vec0）两类派生索引。两条朴素路线
都不可行：

1. **在主库连接里建 FTS5/vec0 虚表**：主库由 Prisma 管理，Prisma 连接不暴露
   `loadExtension`，无法在其上加载 vec0；即便裸连主库加载，扩展与虚表也会被
   Prisma 的迁移/内省/备份视为既有 schema 的一部分，污染单一真源。
2. **裸连接 `ATTACH 'search.db'` 到主库连接**：ATTACH 把两库的 WAL/锁耦合到
   同一连接事务，派生库重建（rm/rebuild）会牵动主库连接状态；且主库单文件
   在线备份（ADR-0007）无法覆盖一个 ATTACH 组。

spike §4 已实测：同一进程内 PrismaClient（主库）与裸 better-sqlite3 打开的
独立 search.db 互不干扰、物理文件独立、扩展连接级隔离（主库连接里
`vec_version()` 不存在，vec0 只加载在 search 连接），search.db 可整文件删除
重建。

## 2. 决策（Decision）

采用**三连接拓扑**，派生索引落独立物理文件 `<dataDir>/search.db`，由不经
Prisma 的 better-sqlite3 `SearchStore` 单例打开：

1. 主库 Prisma 读写连接（既有，业务写事务、scope/decide 读取）；
2. 主库裸 better-sqlite3 **只读**连接（worker 认领事件/拉实体文本 + scope 快
   路径，仿 M1 rawRead 单例）；
3. search.db 一条**单写**连接（indexer 单例）+ 每检索会话的**只读池**
   （cap 4）。vec0 只在 search 连接 `loadExtension`，FTS5/vec0/field_grant/
   index_meta 全部自举于该文件，**不进 Prisma 迁移、不进 `_prisma_migrations`**。

选择独立文件而非 ATTACH/主库虚表的硬理由：

- **扩展加载边界**：Prisma 不能 `loadExtension`；裸连主库再 ATTACH 会让 vec0
  附着到主库连接，破坏"扩展连接级隔离"。独立 search 连接把唯一原生面
  （vec0）关在派生物内。
- **备份边界**：search.db 是同机可重建派生产物（ADR-0048），**不进在线备份**；
  独立文件让备份脚本只需继续只备 `DATABASE_URL` 主库，无需理解 ATTACH 组。
- **WAL/锁解耦**：派生库灌库、双库切换、损坏隔离的锁与 WAL 不与主库业务写
  互相阻塞，主应用编辑链路在任何检索侧故障下都可写（AC-M5-1 时延证据）。
- **可 rm / 可替换**：search.db 可整文件删除或 POSIX rename 替换，是
  ADR-0049 双库原子切换（`rebuild-<ts>` -> rename）与损坏自愈
  （`.corrupt-<ts>` 隔离）的物理前提。
- **替换面清晰**：未来若向量后端升级为 ANN（LanceDB 或等价，见
  ADR-0044 §升级触发），只需替换 search 连接后的派生实现；主库 schema、
  EmbeddingProvider、RRF、scope 收敛均不动。

## 3. 被否决的备选

1. **主库内建 FTS5/vec0 虚表**：Prisma 无法 loadExtension；虚表进 Prisma
   schema 污染单一真源与迁移计数；派生物与权威数据混在一个文件，无法独立
   rm/重建，也无法不进备份。
2. **裸连主库后 ATTACH search.db**：WAL/锁跨库耦合、单文件备份覆盖不了
   ATTACH 组、rename 重建会扰动主库连接；隔离收益尽失。
3. **独立进程/独立服务承载检索**：MVP 阶段引入额外进程编排与 IPC，部署与
   故障面扩大；spike §4 已证同进程多库无干扰，无此必要（worker 也保持同
   进程单例，不演化成独立进程形态）。

## 4. 后果（Consequences）

- 主库迁移数 20 -> 22（#21 outbox DDL+app_settings、#22 播种）；search.db
  DDL 自举，**不计入** Prisma 迁移数，内部版本由 `index_meta.schema_version`
  管理。
- 数据目录必须是本地可写盘（ext4，非只读安装目录、非 NFS）；search.db
  文件权限与主库 dev.db 同级（ADR-0048）。
- search/vec 故障**不挂 /readyz**（可降级、可重建资产，列 readiness 会在
  低端 NAS/musl 上误摘流）；可观测走 status 端点 + warn + 审计。
- 代价：派生一致性不依赖跨库事务，而靠主库同事务 outbox + 异步 worker +
  reindex 扫表保证（ADR-0043），存在受控的最终一致窗口。

## 5. 验证证据

- 拓扑实测：spike-sqlite-vec.md §4（Prisma 主库与独立 search.db 同进程并存、
  主库连接 vec_version NOT loaded、search.db 可整文件删重建）。
- 实现：domain/search/searchStore.ts（单例打开/PRAGMA/loadExtension/双库
  切换）、schema.ts（DDL 自举）、vecLoader.ts。
- 资产边界：docs/runbooks/m5-search.md §5（不进备份、换机无需恢复）。
- 迁移口径：docs/baseline/2026-09-16-m5-baseline.md §2（S0 迁移实数 20、
  search.db DDL 不进 Prisma）。
