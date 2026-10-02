# 备份 Runbook（M0）

适用：GouXiangDB 单实例裸机部署（Caddy → Node → 同机 SQLite + uploads）。
备份对象：SQLite 主库（含 WAL）与 `uploads/` 目录。

> **2026-09-12 NAS 重定向（见 `docs/planning/phase2/PLAN-ADJUST-nas-min-hardware.md` §3，commit 92d0a34）**：
> 备份分两层，默认姿态不同——
> - **层① 本地在线快照＝内置基础能力，默认提供**：防误删/损坏/升级回滚的最低安全网，零额外二进制。
>   发布前 `deploy.sh` 自动执行，也可按本手册 §2 手动执行；每日 timer **默认不 enable**，需要时用户手动开启（§4）。
> - **层② 完整异地容灾（age 加密 + 异地推送，§3）＝接口预留、默认不激活、本期不交付为容灾能力**：
>   代码已就位并保留（BackupTransport 契约的 age-rsync 实现样例），但 env 变量默认全关、
>   部署不 enable、不在 M0/M1 出口验收范围；未来确有需求时按 §3 填配置启用即可，无需改代码。

## 1. 备份机制

- 用 better-sqlite3 的在线 `.backup()` 做一致性快照：在 live WAL 库上安全，
  自动把 WAL 合并进快照主文件，**不做** `cp db db-wal db-shm` 那种非一致性多文件拷贝。
- 快照只读校验：`PRAGMA integrity_check=ok`、已应用迁移数、关键表计数。
- uploads 目录打 tar；对 db 与 tar 计算 sha256，写 `manifest-*.json`（快照时落 `app-YYYYmmdd.manifest.json`）。
- 保留：每日最新一份，保留最近 7 天；另每周（优先周日）保留 1 份，保留最近 4 周。
- 异地：`BACKUP_ENCRYPT_OFFSITE=true` 时，`tar -czf - db uploads | age -r $AGE_RECIPIENT -o spool/offsite-*.tar.gz.age`。
  任何明文都不写入 offsite 目录。

## 2. 手动执行本地明文备份（无 age 也可）

```bash
cd apps/api
DATABASE_URL="file:/var/lib/gouxiangdb/app.db" \
BACKUP_DIR=/var/backups/gouxiangdb \
BACKUP_ENCRYPT_OFFSITE=false \
node scripts/backup/online-backup.mjs
```

成功输出关键行：

```
[backup] OK .../daily/app-YYYYmmdd.db integrity=ok migrations=11 records=N
[backup] sha256 <64hex>
```

产物：

```
$BACKUP_DIR/
  daily/app-YYYYmmdd.db
  daily/app-YYYYmmdd.manifest.json
  daily/uploads-YYYYmmdd.tar
  weekly/app-YYYYmmdd.db           # UTC 周日自动另存，或手工加 --weekly 强制另存
  weekly/uploads-YYYYmmdd.tar      # 与周快照成对（附件外置后周备份必须带文件）
  offsite/spool/offsite-*.tar.gz.age   # 仅启用加密时
```

手工补一份周快照（不等周日）：

```bash
BACKUP_DIR=/var/lib/gouxiangdb/backups \
node scripts/backup/online-backup.mjs --weekly
```

> `--weekly` 的另一个用途是让"周备份带 uploads"这条分支在 CI 里可测——它原本一年只在 52 个
> 周日触发，没有注入点就无法证伪。恢复演练前手工补一份周快照，应确认 `weekly/` 下 db 与
> uploads tar **成对**存在；只有 db 的周份恢复出来会"附件行都在、文件全丢"。

## 3. 异地加密（age X25519 收件人模式）——可选扩展，默认不启用

> **本节描述的完整异地容灾为"接口预留、未激活"状态**（PLAN-ADJUST §3，commit 92d0a34）：
> 当前产品默认不提供异地/异机容灾，env.conf 中下列变量全部保持注释/默认，部署不 enable 相关调度。
> 以下操作步骤保留，供未来确有异地备份/加密合规需求时按 `BackupTransport` 契约启用，无需改代码。

密钥模型：

- 备份机只放**公钥** `AGE_RECIPIENT=age1...`（公钥泄露不危及备份）。
- **解密私钥（identity）离线保管，绝不进生产机、备份机、cron 环境文件。**
- age 为随发布物分发的外部静态二进制（`bin/age`），或用 `AGE_BIN` 指定路径。

一次性离线生成密钥（在非生产、安全的机器）：

```bash
age-keygen -o age.key          # 私钥离线保管
grep "public key:" age.key     # 公钥 age1... 填入 AGE_RECIPIENT
```

启用：

```ini
# /etc/gouxiangdb/env.conf（600）
BACKUP_ENCRYPT_OFFSITE=true
AGE_RECIPIENT=age1...
AGE_BIN=/srv/gouxiangdb/current/api/bin/age
GX_OFFSITE_TARGET=remote:/backups/gouxiangdb   # 可选：rclone/rsync 远端
```

行为约定：

- 启用加密但缺 `AGE_RECIPIENT` 或找不到 age 二进制 → 脚本非 0 退出（fail-loud）。
- 未配置 `GX_OFFSITE_TARGET`（或推送失败）→ 加密件停留 `offsite/spool/` 并告警，本地明文备份仍算成功。

## 4. 定时调度（可选，默认不启用）

`gouxiangdb-backup.{service,timer}` 随部署物安装到 systemd，但 **2026-09-12 起部署流程默认不 enable**
（PLAN-ADJUST §3，commit 92d0a34）。需要每日**本地**快照定时的用户手动开启：

```bash
sudo systemctl enable --now gouxiangdb-backup.timer   # 每日 02:00，错过 Persistent 补跑
systemctl list-timers gouxiangdb-backup.timer
```

timer 加载与 API 相同的 `/etc/gouxiangdb/env.conf`（其中不含 identity 私钥）；
默认 env 下它只做本地快照，**不会**做异地/加密投递——异地段仅在显式配置 §3 变量后才发生。

## 5. 校验备份

```bash
node scripts/backup/verify-restore.mjs $BACKUP_DIR/daily
# integrity_check: ok / applied migrations / counts / sha256 / VERIFY PASS
```

## 6. 故障速查

| 现象 | 处置 |
|---|---|
| `integrity_check` 非 ok | 该快照不可用；查源库磁盘/WAL，立即手动补一份并告警 |
| `源数据库不存在` | 检查 DATABASE_URL；相对路径相对 `apps/api/prisma`，生产应绝对路径 |
| `找不到 age 二进制` | 放置 `bin/age` 或设 AGE_BIN；本地明文备份不受影响 |
| 快照目录出现空 `-wal/-shm` | 只读校验的连接产物，脚本会自动清理；勿手动删源库同名文件 |
