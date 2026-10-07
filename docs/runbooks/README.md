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
| ~~[authz-policy-dual-write.md](authz-policy-dual-write.md)~~（已退役，保留防死链） | 原 M4 双写/开关往返手册；现行 authz 对账与 scope 投影见 deploy.md §6.7/§6.7.1 | — |
| ~~[authz-engine-flip-on.md](authz-engine-flip-on.md)~~（已退役，保留防死链） | 原"切 on 操作清单"；引擎已永久生效、无开关，现行执法见 deploy.md §6.8 | — |
| ~~[authz-drift-and-incidents.md](authz-drift-and-incidents.md)~~（已退役，保留防死链） | 原 shadow drift/应急手册；现行误授/误拒处置见 deploy.md §6.7/§6.7.1/§6.8 | — |
| [ci.md](ci.md) | 平台中立质量门、真 ESLint 基线、本地复现 CI、Gitee Go 开通与 runner | `scripts/ci-quality.sh`、`eslint.config.mjs`、`.workflow/ci.yml` |
| [m5-search.md](m5-search.md) | M5 统一检索：off/cloud 零外网抓包验收（AC-M5-5）、search.db 损坏自愈与降级审计判读、vec0/musl/NFS/资产边界、reindex 与 model 切换、**S13 真机压测（一条命令 + 三杠杆参数 + 容量指引）** | `GX_M5_SEARCH`、`GX_EMBEDDING_MODE`、`GX_VEC_EXT_PATH`、`/api/v1/admin/{reindex,search/status,embedding/config}`、`scripts/bench/m5-gate.ts --mode|--k|--scope-caps` |
| [mcp.md](mcp.md) | M6 鉴权 MCP 服务：PAT 签发/吊销与停用连带吊销、`GX_ENTERPRISE_ORG` 门控与紧急收回、HTTP `/mcp` 与 `dist/mcp-stdio.js` 两入口、11MB/限流/超时三旋钮调档（含 Caddy 12MB 余量）、401 六态判读、审计四事件字段与"永不记录"清单、常见故障（stdio 退出码 2 / 429 退避 / 超时不挂连接） | `GX_ENTERPRISE_ORG`、`GX_MCP_BODY_LIMIT`、`GX_MCP_RATE_{IP,PAT,PAT_REST}_MAX`、`GX_MCP_TOOL_TIMEOUT_MS`、`/mcp`、`/api/v1/pats`、`GX_MCP_TOKEN` + `dist/mcp-stdio.js` |

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

**M5 统一检索（ADR-0042~0050，S14 由架构师归档；编号与题名见 [M5 出口基线](../baseline/2026-09-17-m5-exit.md) §5）**：

- ADR-0042 独立 search.db 分库连接（非 ATTACH/非主库虚表）
- ADR-0043 同进程 outbox + 可重建派生库（主写零等待）
- ADR-0044 sqlite-vec 暴力 KNN 与降级一等公民（无 ANN；50 万或真机持续超标升级 LanceDB）
- ADR-0045 embedding 默认仅远端：cloud/off 两态半，local 为未来可选 provider
- ADR-0046 先收敛后召回（temp_scope + field_grant 物化 + RRF）
- ADR-0047 FTS5 trigram + 短词 LIKE 中文策略
- ADR-0048 授权信息不入索引、权限变更零 reindex + 字段 chunk 召回前排除
- ADR-0049 reindex 双库原子切换与派生库损坏自愈
- ADR-0050 cloud embedding 凭据管理与供应链边界

> 归档落点：`docs/adr/00{42..50}-*.md`（**S14 由架构师产出**；本索引先挂编号/题名，文件名以后者为准）。

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
