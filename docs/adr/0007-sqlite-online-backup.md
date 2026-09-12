# ADR-0007：SQLite 在线一致性备份 + 分层保留 + 季度恢复演练

**状态（Status）**：Accepted（M0 落地，2026-09-13，S6 实现）
**作者**：后端（mvp-dev-expert-team-backend）

---

## 背景（Background）

单文件 SQLite + WAL 是唯一持久化存储，承载用户、Base、表结构、记录与知识库数据。
一旦磁盘损坏、误删或迁移异常，没有备份即不可逆丢失。备份方案必须解决：

- **不能直接拷库文件**：运行中的库可能处于 WAL 未 checkpoint 状态，冷拷 `.db` 会丢最近写入；
  且与业务写进程争抢文件，可能拷到撕裂页。
- **要可验证**：备份文件是否可打开、迁移是否齐全、关键表行数是否与源一致，必须自动核对，
  否则「以为有备份，恢复时才发现坏了」。
- **要能保留多个时间点**：单日覆盖无法应对「几天前才发现的误删」。
- **要真能恢复**：备份只有在被实际恢复演练验证后才算数。

## 决策（Decision）

采用 better-sqlite3 原生在线备份 API 做一致性快照，并对每份快照强制校验：

1. **在线一致性快照**：用独立的 better-sqlite3 只读连接执行 `Database#backup(dest)`（SQLite
   Online Backup API），它在 API 层把 live 库（含 WAL 已提交内容）合并写入一个干净的目标文件，
   不阻塞业务写、不需要停服、不依赖外部 `sqlite3` CLI。
2. **快照即校验**：备份后对目标文件依次做
   `PRAGMA integrity_check = ok`、已完成迁移计数（M0 为 11）、10 张关键表行数清点；
   校验只读打开，结束即删除校验产生的空 `-wal/-shm` 旁路文件（只清快照侧，绝不碰源库）。
3. **manifest + sha256 对账**：生成 `app-<stamp>.manifest.json`（版本、迁移、各表计数、
   数据库文件 sha256），恢复校验脚本用它与候选快照逐项对账。
4. **分层保留**：本地 daily 保留 7 份、weekly 保留 4 周（ISO 周，优先周日那份升级为 weekly），
   按时间戳与周序自动 prune；同日重跑幂等（覆盖当日文件，计数恒定）。
5. **uploads 一并归档**：同时间戳打 `uploads-<stamp>.tar`，保证记录中引用的附件可随库恢复。
6. **调度**：systemd `gouxiangdb-backup.timer` 每日 02:00 触发（关机错过则 `Persistent=true` 补跑）。
7. **恢复演练制度化**：每季度在隔离环境用最新备份走一遍
   `verify-restore` → 临时库恢复 → readyz，记录演练结果；演练不是可选项。

恢复操作（不自动执行）见 `docs/runbooks/restore.md`；WAL/崩溃场景见
`docs/runbooks/wal-crash-recovery.md`（禁止凭感觉手删 `-wal/-shm`）。

## 后果（Consequences）

正面：

- 备份在业务持续写入时仍保证事务一致、包含最新已提交数据，无需停机。
- integrity + 迁移数 + 行数 + sha256 四重核对，坏备份当场暴露（退出码非 0）。
- daily7/weekly4 提供近一周任意天与近四周每周的恢复点；自动 prune 控制磁盘占用。
- 全流程只依赖已在依赖树内的 better-sqlite3，无额外备份软件。

负面/约束：

- 备份与库同机（`/var/backups/gouxiangdb`），**不能防整机/机房损毁**；异机/异地容灾由
  [ADR-0010](0010-offsite-age-encryption.md) 的加密异地拷贝补齐。
- 备份窗口内的 IO 与磁盘占用随库增长；超大库后续需评估增量/页级备份（M0 规模可接受）。
- 计数校验只覆盖「关键 10 表行数」，不做逐字节业务一致性；恢复演练是最后一道人工确认。

## 相关（Related）

- [ADR-0002](0002-database-sqlite.md)：SQLite/WAL
- [ADR-0003](0003-bare-metal-topology.md)：单写者与备份目录
- [ADR-0010](0010-offsite-age-encryption.md)：异地加密
- 实现：`apps/api/src/ops/backup.ts`、`apps/api/scripts/backup/{online-backup,verify-restore,lib}.mjs`
- 手册：`docs/runbooks/backup.md`、`docs/runbooks/restore.md`、`docs/runbooks/wal-crash-recovery.md`
- 调度：`deploy/systemd/gouxiangdb-backup.{service,timer}`
