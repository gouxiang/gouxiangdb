# GouXiangDB 运维手册（Runbooks）索引

M0 生产基座的可执行运维流程。所有手册与仓内脚本/配置一一对应；架构决策见 [`../adr/`](../adr/) 目录下各 ADR 文件（本页下方已列相关条目）。

## 手册列表

| 手册 | 用途 | 关键入口 |
|------|------|----------|
| [deploy.md](deploy.md) | 干净 Linux 机从零装机、打包投递、首次部署、证书（公网自动 HTTPS / 内网 CA）、升级与回滚、卸载 | `deploy/bin/package-release.mjs`、`deploy/bin/deploy.sh`、`deploy/bin/rollback.sh`、`deploy/caddy/Caddyfile`、`deploy/systemd/*` |
| [backup.md](backup.md) | 在线一致性备份、daily7/weekly4 保留、异地 age 加密、手动备份 | `apps/api/scripts/backup/online-backup.mjs`、`deploy/systemd/gouxiangdb-backup.{service,timer}` |
| [restore.md](restore.md) | 从备份恢复：临时库校验、隔离现网、就位、migrate deploy、readyz 验收 | `apps/api/scripts/backup/verify-restore.mjs` |
| [wal-crash-recovery.md](wal-crash-recovery.md) | SQLite WAL/-shm 崩溃恢复纪律（禁止凭感觉手删旁路文件） | 库文件三件套处理流程 |
| [ci.md](ci.md) | 平台中立质量门、真 ESLint 基线、本地复现 CI、Gitee Go 开通与 runner | `scripts/ci-quality.sh`、`eslint.config.mjs`、`.workflow/ci.yml` |

## 相关架构决策（ADR）

- [ADR-0003](../adr/0003-bare-metal-topology.md)：私有部署拓扑（Caddy + systemd 单实例 + WAL 单写者）
- [ADR-0007](../adr/0007-sqlite-online-backup.md)：SQLite 在线备份、保留与季度恢复演练
- [ADR-0009](../adr/0009-deployment-dual-track-probe.md)：部署双轨与 Docker 探针（占位）
- [ADR-0010](../adr/0010-offsite-age-encryption.md)：异地备份 age X25519 加密、解密身份分离
- [ADR-0021](../adr/0021-api-esbuild-flat-bundle.md)：API esbuild 扁平单文件构建

## 速查

```bash
# 质量门（任何 Node>=20/pnpm9 环境）
bash scripts/ci-quality.sh

# 构建发布物并自检
node deploy/bin/package-release.mjs
cd release && shasum -a 256 -c checksums.txt

# 目标机部署 / 回滚
sudo bash deploy/bin/deploy.sh --release release/gouxiangdb-release-*.tar.gz
sudo bash deploy/bin/rollback.sh

# 健康探针
curl -fsS http://127.0.0.1:3001/healthz   # 存活
curl -fsS http://127.0.0.1:3001/readyz    # 就绪（db/disk/migrations/uploads）
```
