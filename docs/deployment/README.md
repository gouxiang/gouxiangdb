# GouXiangDB 部署方案总览

> 适用版本：v2（pnpm monorepo；`apps/api` = Hono + Prisma 5 + better-sqlite3 / SQLite；`apps/web` = React 18 + Vite 7）。
> 硬件基线：2 核 x86_64/arm64、4GB 内存、机械盘或典型 NAS 网络盘（Tier-L，见 `docs/planning/phase2/PLAN-ADJUST-nas-min-hardware.md`）。
> 三套部署形态同源同构，区别只在"谁来管进程、谁来做 TLS/网关、数据目录从哪来、原生二进制怎么取"。

本目录提供三套**彼此独立、按需选用**的部署方案：

| 方案 | 文档 | 定位 | 谁管进程 | 访问入口 | 数据目录 |
| --- | --- | --- | --- | --- | --- |
| 飞牛 fnOS 原生应用 | [`fnos-native.md`](./fnos-native.md) | 在飞牛 NAS 上以官方应用形态交付（应用中心一键启停、统一网关、桌面卡片） | fnOS 应用框架（`cmd/main`） | 统一网关 Unix socket + `/app/gouxiangdb` 前缀 | `TRIM_DATA_SHARE_PATHS`（data-share） |
| Docker | [`docker.md`](./docker.md) | 通用 Linux 服务器 / 任意支持 Docker 的 NAS；自包含、可移植 | Docker Engine + Compose | 容器内 TCP 3001，宿主机映射端口 | 命名卷挂 `/data` |
| macOS 直装 | [`macos-dev.md`](./macos-dev.md) | 本地开发与调试（非生产交付） | 终端进程 / 手动 | Vite 5173（dev）或 Node 3001（prod 预览） | 仓库内 `dev.db` / 本地目录 |

> 另有一条**裸机 systemd + Caddy** 的传统 Linux 服务器部署路径（M0 已交付），不在本文档范围，见 [`../runbooks/deploy.md`](../runbooks/deploy.md) 与 `deploy/`（`deploy.sh` 原子发布 + 在线快照 + 失败回滚）。

---

## 1. 三种方案怎么选

```
你要把 GouXiangDB 装到哪？
│
├─ 飞牛 fnOS NAS，希望像官方应用一样在应用中心管理
│        └─► 飞牛原生应用（.fpk）          → fnos-native.md
│
├─ 通用 Linux 服务器 / 群晖威联通等支持 Docker 的 NAS / 想一条 compose 起全栈
│        └─► Docker（推荐生产自托管）       → docker.md
│
└─ 自己的 Mac，改代码、断点调试、跑测试
         └─► macOS 直装（开发模式）          → macos-dev.md
```

- **生产自托管、且不是飞牛系统**：优先 Docker（依赖进镜像、迁移在启动时自动 `migrate deploy`、数据卷持久化、回滚靠镜像 tag）。
- **明确交付给飞牛 fnOS 用户**：用原生 `.fpk`，融入统一网关与应用中心，不暴露独立端口、不需要用户自己装 Node/反代。
- **开发调试**：永远用 macOS（或任意开发机）直装，`pnpm dev` 热更 + Vite 代理，不要在镜像里做开发。

---

## 2. 三种形态的共同事实（一次看懂，三篇通用）

### 2.1 同一份代码、同一套环境变量

所有形态都跑同一个 `apps/api/dist/index.js`，差异通过环境变量表达。后端新增三个**可选**变量用于网关/单进程托管（缺省即与裸机根路径 TCP 完全一致）：

| 变量 | 缺省 | 作用 | 谁会用 |
| --- | --- | --- | --- |
| `GX_SOCKET_PATH` | 空（监听 TCP `PORT`） | 非空则监听该 Unix socket 而非 TCP 端口 | 飞牛原生 |
| `GX_BASE_PATH` | 空（根路径） | 网关前缀，如 `/app/gouxiangdb`；设置后前缀与根两套路径都挂载 | 飞牛原生 |
| `GX_WEB_DIST` | 空（不托管前端，纯 API） | 指向 `web/dist` 目录，存在则同进程托管静态资源 + SPA 回退 | 飞牛原生 / Docker |

> 生产必填的仍是 `NODE_ENV/JWT_SECRET/DATABASE_URL/CORS_ORIGIN`（见 `apps/api/src/config.ts` 启动闸门，非法即退出码 2）。三个新变量**不**进必填校验，缺失不影响启动。

### 2.2 数据全部落在一个目录，物理上只有一个 SQLite 文件 + 两个附件/备份目录

- 数据库：`DATABASE_URL=file:<绝对路径>/app.db`（生产要求绝对路径），伴随 `-wal`/`-shm`。
- 上传附件：`UPLOAD_ROOT`（默认 `$GX_DATA_DIR/uploads`）。
- 本地快照：`BACKUP_DIR`（默认生产 `/var/backups/gouxiangdb`）。

> **备份/容灾口径（commit 92d0a34）**：产品默认只提供**本地在线一致性快照**（better-sqlite3 `.backup()`，零额外二进制）。异地 age 加密 + 推送是**预留接口、默认关闭、不进验收**，三套方案都不要默认启用 `BACKUP_ENCRYPT_OFFSITE`。恢复演练见 [`../runbooks/restore.md`](../runbooks/restore.md)。

### 2.3 架构相关的两个原生二进制（贯穿三篇，务必匹配目标架构）

GouXiangDB 含两个**平台相关**的原生组件：

1. **better-sqlite3**（`.node`，npm 按平台/架构取 prebuild）；
2. **Prisma query engine**（`@prisma/client` 引擎二进制，`prisma generate` 时按当前平台落地）。

因此：

- **不能打"一份到处跑"的包**。飞牛 `.fpk` 的 `manifest.platform` **不能写 `all`**（官方 `all` 仅用于不含架构二进制的包），必须按 `x86` / `arm` 分别构建两份。
- **Docker 镜像**要按目标架构构建（`docker buildx --platform linux/amd64,linux/arm64`），在目标架构阶段装原生依赖 + `prisma generate`，不能在 amd64 装好原生模块再塞进 arm 镜像。
- Node 版本统一 **v22**（飞牛运行时 `nodejs_v22`；Docker 基础镜像 `node:22`；本地要求 Node ≥ 20，推荐 22）。

### 2.4 数据库迁移只增、不回滚

- 所有形态启动前/发布时统一执行 **`prisma migrate deploy`**（只应用未执行的迁移，已应用则跳过），**禁止** `migrate dev/reset/db push`（裸机 `deploy.sh` 有白名单守卫）。
- 升级 = 换应用代码/镜像 + `migrate deploy`；**回应不回数据**，回滚应用版本不会自动撤销已落地的迁移。升级前先做本地在线快照。

### 2.5 健康探针（验证通用）

- `GET /healthz`：存活（liveness）。
- `GET /readyz`：就绪（readiness），串行五探针 `dbPing/dbWritable/migrations/uploadsWritable/disk`；全过返回 `200 {"status":"ready",...}`，任一失败 `503`。
- 兼容别名 `GET /api/health`。

---

## 3. 三方案关键差异矩阵

| 维度 | 飞牛原生 fpk | Docker | macOS 直装 |
| --- | --- | --- | --- |
| 产物 | `<app>-<ver>-<arch>.fpk` | OCI 镜像 + compose | 源码工作树 |
| Node 运行时 | fnOS 依赖包 `nodejs_v22`（`/var/apps/nodejs_v22/target/bin`） | 镜像内置 `node:22-bookworm` | 本机 Node ≥20（pnpm via corepack） |
| 进程入口 | `cmd/main start/stop/status` | 容器 1 号进程 entrypoint | `pnpm dev` / `node dist/index.js` |
| 监听 | Unix socket `${TRIM_APPDEST}/app.sock` | TCP 3001（可绑回环） | dev 5173 / API 3001 TCP |
| 对外前缀 | `/app/gouxiangdb`（统一网关注入，带 fnOS 登录态 + `X-Trim-Userid`） | 根 `/`（反代自行加前缀/TLS） | `/` |
| TLS | fnOS 统一网关终结 | 自行挂反代（Caddy/Traefik/NAS 网关） | 无（http 本地） |
| 前端 base | Vite `base=/app/gouxiangdb/` | `/` | `/` |
| 数据目录 | data-share（`TRIM_DATA_SHARE_PATHS`） | 卷 `/data` | `apps/api/dev.db` 等仓库内文件 |
| 配置注入 | 生命周期脚本导出 env（`TRIM_*` 映射 `GX_*`） | compose `environment`/env_file | `.env` / shell env |
| 迁移时机 | `install_callback` / `upgrade_callback` | 容器 entrypoint（启动前） | 手动 `pnpm db:migrate`/`db:deploy` |
| 架构包 | 每架构一份 fpk | 每架构一个镜像（manifest list） | 本机架构即可 |
| 升级 | fnOS 应用中心升级 + `upgrade_callback` | 换镜像 tag 重建容器 | `git pull && pnpm install && db:deploy` |
| 适用场景 | 飞牛 NAS 终端用户 | 通用自托管生产 | 开发/调试/演示 |

---

## 4. 最低硬件与容量基线（Tier-L）

- **最低**：2 核（x86_64 或 arm64）、4GB RAM、机械盘/典型 NAS 网络盘、Linux（或 fnOS 0.9.27+ / 国内版 `os_min_version=1.1.3100` 起的统一网关能力）。
- 设计活跃数据量：单表 1 万–10 万行为日常舒适区；50 万/100 万行仅作为**参考画像**，不是硬门。
- 磁盘门：`GX_MIN_DISK_MB` 默认 1024MB，`/readyz` 的 disk 探针低于即 not ready；NAS 小盘可按实际下调（但要给 WAL、快照留足空间）。
- 内存：SQLite 单进程 + Node，RSS 有界；NAS 上建议为容器/应用预留 ≥512MB 可用内存。

---

## 5. 通用排障速查（详见各篇）

| 症状 | 先看 |
| --- | --- |
| 进程一启动就退出，码 2 | 生产配置闸门：`JWT_SECRET`（≥16 且非内置默认值）、`DATABASE_URL`（`file:`+绝对路径）、`CORS_ORIGIN` 缺失/非法 |
| 飞牛里卡片打不开 | socket 未建/路径不符、`app/ui/config` 的 `gatewayPrefix/gatewaySocket`、`cmd/main status` 是否 0 |
| 页面打开但接口 404 | 前端 base/API 前缀与后端 `GX_BASE_PATH` 不一致；子路径资源 404 是 Vite `base` 没设 |
| Docker 起不来或 Illegal instruction | 镜像架构与宿主不符（amd64/arm 原生模块装错），用 buildx 按目标架构重建 |
| `database is locked`/BUSY | WAL + busy_timeout（已内置 5000ms）；检查是否多进程写同一 `app.db`、备份/迁移是否并发 |
| readyz 503 migrations | 迁移没跑或迁移目录不对（`GX_MIGRATIONS_DIR`）；执行 `prisma migrate deploy` |
| 上传/附件写失败 | `UPLOAD_ROOT`/data-share 目录权限或磁盘满（disk 探针） |
