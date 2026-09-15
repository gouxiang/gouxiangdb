# GouXiangDB 运维手册（Runbooks）索引

M0 生产基座的可执行运维流程。所有手册与仓内脚本/配置一一对应；架构决策见 [`../adr/`](../adr/) 目录下各 ADR 文件（本页下方已列相关条目）。

## 手册列表

| 手册 | 用途 | 关键入口 |
|------|------|----------|
| [deploy.md](deploy.md) | 干净 Linux 机从零装机、打包投递、首次部署、证书（公网自动 HTTPS / 内网 CA）、升级与回滚、卸载；M3 起迁移后必须 nav path 重算（§6.6） | `deploy/bin/package-release.mjs`、`deploy/bin/deploy.sh`、`deploy/bin/rollback.sh`、`deploy/caddy/Caddyfile`、`deploy/systemd/*` |
| [backup.md](backup.md) | 在线一致性备份、daily7/weekly4 保留、异地 age 加密、手动备份 | `apps/api/scripts/backup/online-backup.mjs`、`deploy/systemd/gouxiangdb-backup.{service,timer}` |
| [restore.md](restore.md) | 从备份恢复：临时库校验、隔离现网、就位、migrate deploy、nav path 重算（§7.5）、readyz 验收 | `apps/api/scripts/backup/verify-restore.mjs` |
| [wal-crash-recovery.md](wal-crash-recovery.md) | SQLite WAL/-shm 崩溃恢复纪律（禁止凭感觉手删旁路文件） | 库文件三件套处理流程 |
| [m1-sidecar.md](m1-sidecar.md) | M1 数据底座：sidecar 巡检/重建、功能 flag 回退、大表与搜索有界预览边界 | `scripts/bench/{check,backfill}-sidecar.ts`、`GX_M1_*` flag |
| [org-contacts.md](org-contacts.md) | M2 组织通讯录：flag off 紧急收回、停用后仍可访问排查、默认工作区/owner 修复、邀请重发、只增不删回滚姿态 | `GX_ENTERPRISE_ORG`、`GX_AUTH_STATE_TTL_MS`、`/api/v1/org/*` |
| [authz-policy-dual-write.md](authz-policy-dual-write.md) | M4 权限引擎：auth_policies 与旧三表同事务双写、GX_AUTHZ_ENGINE 开关往返、legacyUnmappable 恢复路径、purge 清孤儿策略 | `GX_AUTHZ_ENGINE`、`/api/v1/nodes/:id/{policies,effective}`、`scripts/authz/reconcile-policies.ts` |
| [ci.md](ci.md) | 平台中立质量门、真 ESLint 基线、本地复现 CI、Gitee Go 开通与 runner | `scripts/ci-quality.sh`、`eslint.config.mjs`、`.workflow/ci.yml` |

## 相关架构决策（ADR）

- [ADR-0003](../adr/0003-bare-metal-topology.md)：私有部署拓扑（Caddy + systemd 单实例 + WAL 单写者）
- [ADR-0004](../adr/0004-eav-sidecar-index.md)：动态字段 EAV 旁路索引与写时同事务维护
- [ADR-0005](../adr/0005-fulltext-search.md)：全文检索边界（M1 只定边界，M5 落地统一检索）
- [ADR-0007](../adr/0007-sqlite-online-backup.md)：SQLite 在线备份、保留与季度恢复演练
- [ADR-0009](../adr/0009-deployment-dual-track-probe.md)：部署双轨与 Docker 探针（占位）
- [ADR-0010](../adr/0010-offsite-age-encryption.md)：异地备份 age X25519 加密、解密身份分离
- [ADR-0021](../adr/0021-api-esbuild-flat-bundle.md)：API esbuild 扁平单文件构建
- [ADR-0022](../adr/0022-org-token-version-revocation.md)：tokenVersion 账号级即时吊销（默认零缓存、单实例纪律）
- [ADR-0023](../adr/0023-materialized-path-dept-tree.md)：部门树物化路径、移动子树重写、32 护栏
- [ADR-0024](../adr/0024-org-role-vs-resource-role-layering.md)：组织角色与资源角色物理分层，M4 auth_policies 衔接点
- [ADR-0025](../adr/0025-runtime-entities-uncollected-by-default.md)：运行期实体默认未收纳（nav 重算只修派生 path/节点，不自动补菜单快捷项）

## 速查

```bash
# 质量门（任何 Node>=20/pnpm9 环境）
bash scripts/ci-quality.sh

# 构建发布物并自检
node deploy/bin/package-release.mjs
cd release && shasum -a 256 -c checksums.txt

# 目标机部署 / 回滚（deploy.sh 迁移后自动幂等执行 nav path 重算，M3 起；详见 deploy.md §6.6）
sudo bash deploy/bin/deploy.sh --release release/gouxiangdb-release-*.tar.gz
sudo bash deploy/bin/rollback.sh

# 健康探针
curl -fsS http://127.0.0.1:3001/healthz   # 存活
curl -fsS http://127.0.0.1:3001/readyz    # 就绪（db/disk/migrations/uploads）
```
