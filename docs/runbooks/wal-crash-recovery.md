# SQLite WAL 崩溃恢复 Runbook

适用：API 异常退出、断电、磁盘写满后，数据库打不开、报 database disk image is malformed、
或服务启动后 `/readyz` 的 dbPing/dbWritable/migrations 探针失败。

核心原则：**先整体隔离现状（db + wal + shm 三件一起），再判断；禁止凭感觉只删某个 `-wal`/`-shm`。**

## 1. 先停服务、保现场

```bash
sudo systemctl stop gouxiangdb-api
DATA=/var/lib/gouxiangdb
TS=$(date -u +%Y%m%d-%H%M%S)
sudo mkdir -p "$DATA/_incident-$TS"
sudo cp -p "$DATA/app.db" "$DATA/app.db-wal" "$DATA/app.db-shm" "$DATA/_incident-$TS/" 2>/dev/null || true
```

始终把三件作为一个整体复制/移动；单独拷贝主库会漏掉 WAL 里尚未 checkpoint 的最新写入。

## 2. 判断健康度（只读）

```bash
node -e '
const Database=require("better-sqlite3");
const db=new Database(process.argv[1], {readonly:true});
console.log("integrity:", Object.values(db.prepare("PRAGMA integrity_check").get())[0]);
console.log("journal_mode:", db.prepare("PRAGMA journal_mode").get().journal_mode);
db.close();' "$DATA/app.db"
```

- `integrity_check = ok`：结构完好。若只是启动探针偶发失败，优先排查磁盘空间/权限/锁（见第 4 节）。
- 返回多行错误：结构损坏，进入第 5 节。

## 3. WAL 的正确处理（常见误操作纠正）

- `-shm`（共享内存索引）是可重建的临时文件；损坏/陈旧时，**在已停服务且 db/-wal 完好**的前提下可删除：
  `sudo rm -f "$DATA/app.db-shm"`，下次打开自动重建。
- `-wal` 里可能有最近已提交事务。**只有在确认要丢弃 WAL 中未合并的写入时**才移除它；
  移除前务必已在第 1 步整体备份。正常关闭时 SQLite 会自动 checkpoint 并清空 WAL。
- 不要在服务运行时删除 `-wal`/`-shm`。
- 换机器/拷贝数据库时，用在线备份产物（`.backup()` 已合并 WAL 的单文件）或停服后整体拷贝三件，
  不要只 `cp app.db`。

## 4. 非损坏类启动失败

| 症状 | 排查/处置 |
|---|---|
| `SQLITE_BUSY` | 确认无第二进程占库（单写者）；`fuser "$DATA/app.db"`；应用 busy_timeout=5000 |
| `unable to open database file` | 检查目录存在与属主 gouxiangdb、磁盘空间、`DATABASE_URL` 是否绝对路径 |
| readyz dbWritable FAIL/BUSY | 磁盘是否满、目录是否只读；`stat -f` 看可用空间（对应 GX_MIN_DISK_MB） |
| 迁移对不上 | 用 `prisma migrate status`；`failed` 迁移按 §5 处理，勿手改 _prisma_migrations |

## 5. 结构损坏恢复

1. 保持第 1 步的隔离现场不动。
2. 取最近一份一致性备份，按 [restore.md](./restore.md) 第 4–8 步：先在临时库
   `verify-restore.mjs` 得 VERIFY PASS，再隔离现网、就位、`migrate deploy`、起服务、`/readyz`。
3. 若想抢救损坏库中比备份更新的数据（高级、需评审）：
   - 复制损坏三件到隔离环境后尝试 `.recover`（sqlite3 CLI）导出可恢复数据；
   - 或对损坏库只读查询逐表导出到干净库；**全程不在原损坏文件上写操作**。
4. 数据回放到备份点之后的缺口，由应用层手段（重新录入/从其他副本）处理；记录事故时间线与丢失窗口。

## 6. 预防

- 每日在线一致性备份 + 每半年加密异地恢复演练（见 [backup.md](./backup.md)）。
- 监控 `/readyz` 与磁盘余量（GX_MIN_DISK_MB）；日志 JSONL 与备份目录分卷，避免日志写满数据盘。
- 迁移只增、发布前先快照（SPEC §4 铁律）。
