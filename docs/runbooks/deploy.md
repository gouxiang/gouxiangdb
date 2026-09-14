# 裸机部署 Runbook（M0 S8）

面向一台干净的内网/公网 Linux 服务器，从零把 GouXiangDB 跑成 systemd 常驻服务，前置 Caddy 做 TLS 与反代。拓扑与约束见 [ADR-0003](../adr/0003-bare-metal-topology.md)。

> 验证边界：本 runbook 中**构建/打包/校验**步骤已在开发机（macOS arm64）实跑通过；
> **systemd 安装、Caddy 实跑、真实 Linux 部署/回滚**需要一台干净 Linux 机执行，
> 本机无法验证，标注为【需干净 Linux 机】。所有脚本均通过 `bash -n` 与负面路径自测。

## 1. 拓扑与硬约束

```
客户端 ──HTTPS(443)──> Caddy(同机) ──回环明文 127.0.0.1:3001──> gouxiangdb-api(systemd)
                                          SQLite + uploads 同在本机 /var/lib/gouxiangdb
```

- 单实例：不开 cluster、不部署副本；Caddy 与 Node 同机。
- Node 仅监听回环，外部靠主机防火墙禁止直连 3001。
- 迁移只由 `deploy.sh` 在“先快照后”显式 `prisma migrate deploy`，不挂开机/重启自动迁移。

## 2. 前置条件

- 目标机：Linux x86_64，建议 2 vCPU / 4GB，systemd；与构建机**同 OS/架构**（见 §10）。
- 构建机：Node >= 20、pnpm 9（`corepack enable && corepack prepare pnpm@9 --activate`）、可访问 npm registry（装生产依赖、拉 prisma engine）、tar/shasum。
- 目标机运行时：Node >= 20、Caddy 2.x；curl、bash >= 4（mapfile）。

## 3. 目标机初始化【需干净 Linux 机】

```bash
# 3.1 专用系统用户（不允许登录 shell）
sudo useradd --system --create-home --home-dir /var/lib/gouxiangdb --shell /usr/sbin/nologin gouxiangdb

# 3.2 标准目录与权限
sudo mkdir -p /srv/gouxiangdb/releases /var/lib/gouxiangdb/uploads \
              /var/backups/gouxiangdb /var/log/gouxiangdb /etc/gouxiangdb
sudo chown -R gouxiangdb:gouxiangdb /var/lib/gouxiangdb /var/backups/gouxiangdb /var/log/gouxiangdb
sudo chmod 750 /var/lib/gouxiangdb /var/backups/gouxiangdb
sudo chmod 750 /srv/gouxiangdb /srv/gouxiangdb/releases

# 3.3 Node 20（按发行版官方源安装；示例为 NodeSource，离线机用内部分发的 node 包）
#   安装后确认 /usr/bin/node 存在；若实际路径不同，部署时用 NODE_BIN=/path/node 覆盖。
node -v   # 期望 v20+

# 3.4 Caddy（按 https://caddyserver.com/docs/install 的发行版方式）
caddy version

# 3.5 防火墙：只放行 22/80/443，拒绝外部直连 API 端口
sudo ufw allow 22/tcp && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
sudo ufw deny 3001/tcp || true
sudo ufw --force enable
```

## 4. 生产环境变量（600）

```bash
sudo install -m 600 -o gouxiangdb -g gouxiangdb /dev/null /etc/gouxiangdb/env.conf
sudo -e /etc/gouxiangdb/env.conf      # 粘贴 deploy/env.conf.example 并逐项填值
```

必填：`JWT_SECRET`（`openssl rand -base64 32`）、`DATABASE_URL=file:/var/lib/gouxiangdb/app.db`、
`CORS_ORIGIN=https://你的域名`、`GX_DOMAIN`。缺任一项，生产启动闸门退出码 2（见 S3）。
env.conf 不入库、不进发布包；私钥（age identity）也不得放入。

## 5. 构建机打包与投递

```bash
# 构建机（仓库根）
node deploy/bin/package-release.mjs
# 产物：release/api、release/web、release/checksums.txt、
#       release/gouxiangdb-release-<version>-<ts>.tar.gz
cd release && shasum -a 256 -c checksums.txt      # 期望全部 OK
# 投递到目标机
scp release/gouxiangdb-release-*.tar.gz user@server:/tmp/
```

打包采用白名单组装并兜底扫描，发布包不含 `.env`、`*.db*`、`*.log`、`.workbuddy`、`uploads` 内容。

## 6. 首次部署【需干净 Linux 机】

```bash
# 6.1 安装 systemd 单元与 Caddyfile
sudo install -m 0644 deploy/systemd/gouxiangdb-api.service      /etc/systemd/system/
sudo install -m 0644 deploy/systemd/gouxiangdb-backup.service   /etc/systemd/system/
sudo install -m 0644 deploy/systemd/gouxiangdb-backup.timer     /etc/systemd/system/
sudo install -m 0644 deploy/caddy/Caddyfile                     /etc/caddy/Caddyfile
sudo systemctl daemon-reload

# 6.2 提供 GX_DOMAIN 给 Caddy（让 {$GX_DOMAIN} 占位生效）
sudo systemctl edit caddy --force      # 在 [Service] 加：Environment=GX_DOMAIN=gx.example.com

# 6.3 首次部署（无在运行版本，脚本按“首次”跳过发布前快照）
sudo bash deploy/bin/deploy.sh --release /tmp/gouxiangdb-release-*.tar.gz

# 6.4 起 API、重载 Caddy（备份 timer 默认不启用，见下方说明）
sudo systemctl enable --now gouxiangdb-api
sudo systemctl reload caddy
# 每日【本地】快照定时为可选项，需要时由用户手动开启（仅本地快照，不含异地/加密）：
#   sudo systemctl enable --now gouxiangdb-backup.timer
# 2026-09-12 NAS 重定向（PLAN-ADJUST §3，commit 92d0a34）：产品默认只提供手动/升级前本地快照，
# 部署流程不再默认 enable 备份 timer；异地 age 加密容灾为预留接口、默认不激活（见 backup.md §3）。

# 6.5 验收
curl -fsS http://127.0.0.1:3001/healthz
curl -fsS http://127.0.0.1:3001/readyz      # 五探针 true、migrations applied 与迁移目录数一致（M1 起为 12）
curl -fsS https://gx.example.com/healthz
systemctl list-timers gouxiangdb-backup.timer   # 未 enable 时显示 n/a 或不列出，属预期
```

## 7. 证书两条路径

- **公网正式域名（推荐）**：DNS 已指向本机、80/443 可出网。保留 Caddyfile 站点块即可，
  Caddy 自动申请并续期公信 CA 证书。确认证书为公信 CA 后，取消 Caddyfile 中
  HSTS 行注释（`Strict-Transport-Security`）。
- **内网 / 自签 / 内部 CA**：在 Caddyfile 用
  `tls /etc/gouxiangdb/certs/server.crt /etc/gouxiangdb/certs/server.key` 指向内部证书；
  客户端需信任签发根 CA。**不要开启 HSTS**（自签下浏览器可能强制拒绝后续访问），
  故 Caddyfile 的 HSTS 默认保持注释。证书目录权限建议 600、属主 caddy/gouxiangdb 按实际放行。

## 8. 日常升级与回滚

```bash
# 升级：脚本自动先做在线快照、迁移、原子切换、30s readyz 轮询，失败自动回滚到上一版
sudo bash deploy/bin/deploy.sh --release /tmp/gouxiangdb-release-新.tar.gz

# 手动回滚（只回应用、不回数据；30s 内 readyz 判定）
sudo bash deploy/bin/rollback.sh                 # 上一版
sudo bash deploy/bin/rollback.sh 20260920-1      # 指定 release
```

发布默认保留最近 5 个 release（`KEEP_RELEASES=5`，可用环境变量覆盖）。
应用回滚不撤销迁移（迁移只增、向后兼容）；仅当迁移本身损坏需恢复数据时，
按 [restore.md](restore.md) 从发布前快照做时间点恢复。

## 9. 备份与监控

- **本地在线快照是内置基础能力**（防误删/损坏/升级回滚的最低安全网，零额外二进制）：
  `deploy.sh` 每次发布前自动执行一次；也可随时手动跑 `online-backup.mjs`（见 [backup.md](backup.md)），
  落 `/var/backups/gouxiangdb`，daily7/weekly4 本地保留。
- **每日 timer 默认不启用**（2026-09-12 NAS 重定向，PLAN-ADJUST §3，commit 92d0a34）：需要本地每日定时时，
  用户手动 `sudo systemctl enable --now gouxiangdb-backup.timer`（每日 02:00，仅本地快照）。
- **异地 age 加密容灾＝可选扩展、接口预留、默认不激活**：相关变量
  （`BACKUP_ENCRYPT_OFFSITE`/`AGE_RECIPIENT`/`AGE_BIN`/`GX_OFFSITE_TARGET`）在 env.conf 中默认全部关闭/注释，
  详见 [backup.md](backup.md) §3。当前产品不宣称具备异地/异机容灾能力。
- 日志：`journalctl -u gouxiangdb-api -f`、`-u gouxiangdb-backup`；
  审计 JSONL 在 `/var/log/gouxiangdb/audit.logl`，logrotate 配置见 `deploy/logrotate/gouxiangdb.conf`。
- 健康：外部探针对 `/healthz`（存活）与 `/readyz`（就绪，含 db/disk/migrations/uploads）。

## 10. 架构匹配与离线说明

- `better-sqlite3` 13 携带全平台 prebuilds（linux/darwin/win × x64/arm64），随包即可按目标平台加载。
- Prisma 的 query engine 由打包时 `prisma generate` 按**构建机平台**拉取。因此标准做法是
  **在与目标同 OS/架构的构建机打包**（如都为 linux-x64）。
- 必须交叉打包或完全离线时：在目标机首次部署前，于发布目录 `api/` 内用内部 registry
  重新 `pnpm install --prod --ignore-workspace` 并 `prisma generate`（需要内网能取得对应 engine），
  或在 `schema.prisma` 的 generator 配置 `binaryTargets` 后重新生成（属业务配置变更，M0 不默认改）。
- `deploy.sh` 在目标机执行 migrate；若 engine 平台不匹配会在迁移步明确失败，且因切换发生在迁移之后，
  现网不受影响。

## 11. 卸载（完全撤销）

```bash
sudo systemctl disable --now gouxiangdb-api gouxiangdb-backup.timer
sudo rm -f /etc/systemd/system/gouxiangdb-{api,backup.service,backup.timer}
sudo systemctl daemon-reload
# 数据与配置按需保留或删除：/srv/gouxiangdb /etc/gouxiangdb /var/lib/gouxiangdb /var/backups/gouxiangdb
```
