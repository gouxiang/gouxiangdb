# 恢复 Runbook（M0）

目标：从在线备份把数据库（与 uploads）恢复到一个已知完好的点。
**铁律：先在临时目录完成解密与校验（VERIFY PASS），再动现网；现网旧库只挪到隔离目录，不直接删除。**

## 1. 停止写入

```bash
sudo systemctl stop gouxiangdb-api
```

## 2. 准备待恢复材料

- 本地明文：`$BACKUP_DIR/daily/app-YYYYmmdd.db` + 同名 `.manifest.json`（+ `uploads-*.tar`）。
- 异地加密：`offsite/spool/offsite-YYYYmmdd-HHMMSS.tar.gz.age`。

## 3. （仅加密副本）解密到临时目录

identity 私钥只在此刻、在受控机器上临时出现：

```bash
RESTORE_DIR=$(mktemp -d /tmp/gx-restore.XXXXXX)
install -m 600 /secure/path/age.key "$RESTORE_DIR/age.id"   # 离线保管的 identity
trap 'shred -u "$RESTORE_DIR/age.key" 2>/dev/null || true' EXIT

age -d -i "$RESTORE_DIR/age.id" offsite-YYYYmmdd-HHMMSS.tar.gz.age \
  | tar -xz -C "$RESTORE_DIR"
# 解出 app-*.db / app-*.manifest.json / uploads-*.tar
```

## 4. 先校验，不碰现网

```bash
node /srv/gouxiangdb/current/api/scripts/backup/verify-restore.mjs "$RESTORE_DIR"
# 必看：
#   integrity_check: ok
#   applied migrations == manifest 且 latest 为最新迁移
#   counts（records/bases/...）与 manifest 一致
#   sha256 一致
#   VERIFY PASS
```

VERIFY PASS 之前禁止进入第 5 步。也可直接在隔离临时库再核一遍计数（不依赖 manifest）：

```bash
node -e '
const Database=require("better-sqlite3");
const snap=new Database(process.argv[1],{readonly:true});
const src=new Database("/var/lib/gouxiangdb/app.db",{readonly:true});
for(const t of ["records","bases","tables","fields","views","users","kb_docs"]){
  const a=snap.prepare(`SELECT count(*) c FROM "${t}"`).get().c;
  const b=src.prepare(`SELECT count(*) c FROM "${t}"`).get().c;
  console.log(t, "restore=",a, "current=",b, a===b?"MATCH":"DIFF");
}' "$RESTORE_DIR/app-YYYYmmdd.db"
```

## 5. 现网旧库整体隔离（不删除）

```bash
sudo mkdir -p /var/lib/gouxiangdb/_quarantine
TS=$(date -u +%Y%m%d-%H%M%S)
cd /var/lib/gouxiangdb
sudo mv app.db app.db-wal app.db-shm "_quarantine/app.db.$TS.bak" 2>/dev/null || true
# 三者必须一起挪走，避免残留 WAL 覆盖恢复点
```

## 6. 就位恢复文件

```bash
sudo cp "$RESTORE_DIR/app-YYYYmmdd.db" /var/lib/gouxiangdb/app.db
sudo chown gouxiangdb:gouxiangdb /var/lib/gouxiangdb/app.db
sudo chmod 640 /var/lib/gouxiangdb/app.db
# uploads（如有）：
sudo tar -xf "$RESTORE_DIR/uploads-YYYYmmdd.tar" -C /var/lib/ \
  && sudo chown -R gouxiangdb:gouxiangdb /var/lib/gouxiangdb/uploads
```

## 7. 应用迁移（只增；正常应 no-op）

```bash
cd /srv/gouxiangdb/current/api
sudo -u gouxiangdb env DATABASE_URL=file:/var/lib/gouxiangdb/app.db \
  pnpm exec prisma migrate deploy
```

## 7.5 nav path 重算（幂等，M3 起必须）

恢复点可能早于 nav 迁移或其派生 path 不完整。迁移之后、启动服务之前，必须执行一次 nav path 重算；
它幂等地只重算 `nav_nodes` 派生 `path/depth`、修复阻断类差异，**不补任何菜单快捷项**（未收纳 C4 只是
warning，ADR-0025）。该入口由 M3-S11-A 构建进发布包（推荐形态 `dist/cli/nav-reconcile.js`，
**最终入口路径/文件名以 M3-S11-A 实现为准**；落地前生产包内不存在该入口，不得照占位命令臆造）：

```bash
cd /srv/gouxiangdb/current/api
sudo -u gouxiangdb env DATABASE_URL=file:/var/lib/gouxiangdb/app.db \
  node dist/cli/nav-reconcile.js --apply        # 占位命令，最终入口以 M3-S11-A 实现为准
# 期望：exit 0；再跑一次输出 no changes、exit 0（幂等）。
# 非零：不得启动服务；恢复点库与当前版本不兼容，按 §9 回滚本次恢复后重新评估。
```

## 8. 启动并验证

```bash
sudo systemctl start gouxiangdb-api
curl -fsS http://127.0.0.1:3001/healthz          # 200
curl -fsS http://127.0.0.1:3001/readyz           # 五项 true，migration 与快照一致
```

再做只读冒烟（登录、打开 Base、抽查记录/附件下载），确认后保留隔离目录至少一个备份周期。

## 9. 回滚本次恢复

恢复后如发现选错点：停 API，把 `_quarantine/app.db.$TS.bak*` 还原为 `app.db(+wal/+shm)`，
重新 `migrate deploy`、按 §7.5 重跑 nav path 重算（幂等）、启动、`/readyz`。

## 10. 演练要求

- 每季度演练一次本地明文备份恢复到临时库；
- **每半年至少完整走一次"加密异地副本解密 → 校验 → 临时库恢复"**，确认离线 identity 可用（防私钥丢失无法解密）。
