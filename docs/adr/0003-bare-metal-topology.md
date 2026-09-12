# ADR-0003：私有部署拓扑（Caddy + systemd 单实例 + SQLite WAL 单写者）

**状态（Status）**：Accepted（M0 落地，2026-09-13）
**作者**：后端（mvp-dev-expert-team-backend），依据 ARCH-production §4.1/§4.2/§4.4/§4.6

---

## 背景（Background）

GouXiangDB 的企业/私有交付目标是「客户内网或单台公网主机即可运行、零外部中间件依赖」。在 [ADR-0002](0002-database-sqlite.md) 选定 SQLite 后，需要确定进程编排、TLS 终止、静态资源与发布切换的具体形态。约束：

- 客户运维能力参差，交付物要能在一台干净 Linux 上由一份脚本装起；
- SQLite 的写入语义要求**同一时刻只有一个写进程**，不能用多副本/PM2 cluster 横向扩 API；
- 不能让应用直接裸露 80/443 或自行管证书；前端静态产物与 API 应同域，避免跨域与 Cookie 复杂性；
- 升级必须可在 30 秒级回滚，且升级窗口不自动迁移、迁移前必须有可恢复快照。

候选包括：Node 直接监听 443 + 应用内置 HTTPS；Node + Nginx；Node + Caddy；
Docker Compose 编排；多实例 + 外部 PG。结合 M0 的「单包、零外部依赖、SQLite」现实，
多实例与容器化在 M0 不具备必要性，Compose 降级为可选探针（见 ADR-0009）。

## 决策（Decision）

采用「同机 Caddy 反代 + systemd 管单实例 Node + 同机 SQLite（WAL 单写者）」的裸机拓扑：

```
客户端 ──HTTPS(443)──> Caddy(同机) ──回环明文 127.0.0.1:3001──> gouxiangdb-api(systemd)
                                        SQLite(+WAL) 与 uploads 同在 /var/lib/gouxiangdb
```

配套约束（落 S8 交付物）：

- **单实例硬约束**：一个 systemd 单元 `gouxiangdb-api.service`，不开 cluster/副本；
  Node 仅监听回环 `127.0.0.1:3001`，主机防火墙拒绝外部直连 3001，Caddy 是唯一入口。
- **TLS 与同域**：Caddy 终止 TLS，`{$GX_DOMAIN}` 占位；`/api/*`、`/healthz`、`/readyz`、
  `/mcp`、`/mcp/*`（M6 路由落地前仅预埋 matcher，不新开端口）、`/uploads/*` 反代 Node，
  其余路径由 Caddy 直接发 vite 静态产物并做 SPA `try_files` 回退。
- **WAL 单写者**：全系统只有该 API 进程写库；备份走 better-sqlite3 在线只读 `.backup()`
  一致性快照（ADR-0007），不通过复制库文件的方式备份。
- **发布原子切换**：版本解包到 `/srv/gouxiangdb/releases/<ts>/`，`ln -sfn releases/<ts> current`
  原子切换；迁移不进 `ExecStartPre`，由 `deploy.sh` 在「先在线快照」之后显式 `prisma migrate deploy`。
- **最小权限**：专用系统用户 `gouxiangdb`、`NoNewPrivileges`、`PrivateTmp`、
  `ReadWritePaths` 限定数据/日志/备份目录；配置走 600 的 `/etc/gouxiangdb/env.conf`，不入库不进包。

## 后果（Consequences）

正面：

- 一台干净 Linux + 一份 package/deploy 脚本即可复现；无外部 DB/TLS 运维负担。
- 回环绑定 + 防火墙 + 单写者，与 SQLite 语义自洽，避免多实例写锁竞争。
- 同域反代消除跨域与 Cookie 作用域问题；证书（含自动 HTTPS）集中在 Caddy。
- 原子软链切换 + 30 秒 readyz 轮询 + 失败自动回滚，升级风险可控。

负面/约束：

- **无水平扩展**：吞吐受单机限制；高并发写与多租户是后续演进（届时另立 ADR 切 PG）。
- Caddy/Node 同机意味着静态与动态争抢同机资源（M0 规模可接受）。
- 「Node 只绑回环」目前依赖防火墙保证（应用层 `serve()` 未强制 hostname）；
  若要应用自身也只绑回环，需后续在配置中增加绑定地址项（M0 不改业务代码，已在 runbook 标注）。
- systemd/Caddy 的真机安装与反代实跑**无法在开发机验证**，需在干净 Linux 机执行一次验收
  （见 `docs/runbooks/deploy.md` 的验证边界说明）。

## 相关（Related）

- [ADR-0002](0002-database-sqlite.md)：SQLite/WAL 与单写者前提
- [ADR-0007](0007-sqlite-online-backup.md)：在线一致性备份与恢复演练
- [ADR-0010](0010-offsite-age-encryption.md)：异地备份加密身份分离
- ADR-0009（占位）：Docker 双轨探针
- S8 交付物：`deploy/systemd/*`、`deploy/caddy/Caddyfile`、`deploy/bin/{package-release.mjs,deploy.sh,rollback.sh}`、`docs/runbooks/deploy.md`
