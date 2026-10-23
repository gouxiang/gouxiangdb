# GouXiangDB 部署方案总览

> 适用版本：v2（pnpm monorepo；`apps/api` = Hono + Prisma 5 + better-sqlite3 / SQLite；`apps/web` = React 18 + Vite 7）。
> 硬件基线：2 核 x86_64/arm64、4GB 内存、机械盘或典型 NAS 网络盘（Tier-L，见 `docs/planning/phase2/PLAN-ADJUST-nas-min-hardware.md`）。
> 三套部署形态同源同构，区别只在"谁来管进程、谁来做 TLS/网关、数据目录从哪来、原生二进制怎么取"。

本目录提供三套**彼此独立、按需选用**的部署方案：

| 方案 | 文档 | 定位 | 谁管进程 | 访问入口 | 数据目录 |
| --- | --- | --- | --- | --- | --- |
| 飞牛 fnOS 原生应用 | [`fnos-native.md`](./fnos-native.md) | 在飞牛 NAS 上以官方应用形态交付（应用中心一键启停、桌面卡片跨源 iframe） | fnOS 应用框架（`cmd/main`） | 独立 TCP 端口（env `PORT`，默认 **9527**）根路径，桌面门户跨源 iframe | `TRIM_DATA_SHARE_PATHS`（data-share） |
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
- **明确交付给飞牛 fnOS 用户**：用原生 `.fpk`，应用监听**独立 TCP 端口**（安装向导可改，默认 **9527**），浏览器 `http://NAS:端口` 直连、桌面门户跨源 iframe 嵌入；由应用中心托管，无需用户自装 Node/反代。
- **开发调试**：永远用 macOS（或任意开发机）直装，`pnpm dev` 热更 + Vite 代理，不要在镜像里做开发。

---

## 2. 三种形态的共同事实（一次看懂，三篇通用）

### 2.1 同一份代码、同一套环境变量

所有形态都跑同一个 `apps/api/dist/index.js`，差异通过环境变量表达。与单进程静态托管相关的变量（缺省即与裸机根路径 TCP 完全一致）：

| 变量 | 缺省 | 作用 | 谁会用 |
| --- | --- | --- | --- |
| `GX_WEB_DIST` | 空（不托管前端，纯 API） | 指向 `web/dist` 目录，存在则同进程托管静态资源 + SPA 回退 | 飞牛原生 / Docker |

> 另有两个**旧网关形态（0.2.4 及以前曾用）的遗留适配变量**——`GX_SOCKET_PATH`（非空则监听 Unix socket 而非 TCP 端口）与 `GX_BASE_PATH`（网关前缀，如 `/app/gouxiangdb`，设置后前缀与根两套路径都挂载）。代码里的 socket 适配仍在，但**当前裸机 / Docker / 飞牛三套餐均不消费**：飞牛 `cmd/main` 不设 `GX_SOCKET_PATH`（走 TCP 分支，绑 `0.0.0.0` 的 `PORT` 默认 9527），并主动 `unset GX_BASE_PATH`（根部署）。

> 生产必填的仍是 `NODE_ENV/JWT_SECRET/DATABASE_URL/CORS_ORIGIN`（见 `apps/api/src/config.ts` 启动闸门，非法即退出码 2）。上述可选变量**不**进必填校验，缺失不影响启动。

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
- Node 版本统一 **v22**（飞牛运行时 `nodejs_v22`；Docker 基础镜像 `node:22`；本地开发机同样必须 22）——**硬约束与故障现象见 §2.4**，换 Node 大版本前必读。

### 2.4 Node 版本硬约束（换 Node 大版本必读）

**必须 Node 22（含本机开发）。** 飞牛运行时 `nodejs_v22`、Docker 基础镜像 `node:22-bookworm`；better-sqlite3@13 为 NAPI v10，Node 20 加载即 SIGSEGV，开发机同理，三套餐与本地一律 22。

**已实证的故障现象（排查时极易误判）**：在 **Node 20** 下启动不是报普通模块错误（如 `ERR_DLOPEN_FAILED` / `Module did not self-register`），而是进程直接 **SIGSEGV 崩溃**——没有任何可读堆栈指向 better-sqlite3，很容易被误判为内存问题、磁盘问题或 SQLite 文件损坏而查错方向。换到 Node 22 后立即正常。

**底层原因**：better-sqlite3 是原生模块，其 Linux prebuild 按 **NAPI 版本档位**发布，Node 20 与 Node 22 对应的 NAPI 档位不同；ABI 不匹配时加载期直接段错误，而非抛出可捕获的异常。

**因此**：

- 更换 Node **大版本**（20↔22、22→24 等）后，**必须重新安装依赖**（`rm -rf node_modules && pnpm install`）让 prebuild 按新 ABI 重新落地，**并复验** `node -e "require('better-sqlite3')"` 与服务 `/readyz`。
- 构建机与运行机的 **Node 大版本必须一致**（Docker 多阶段尤其注意：build 阶段与 runtime 阶段别用不同基础镜像）。
- 只升 Node **小版本/补丁版本**（22.x → 22.y）通常无需重装，但若启动出现 SIGSEGV，按上面流程重装依赖后再判。

> **本条来源说明**：本条来自 2026-09 的 Linux 部署**实证**（Node 20 → SIGSEGV，Node 22 → 正常），
> **仓内此前无任何文档记载，本次（2026-09-20）为首次落盘**。在此之前它属于口头传承。
> 若后续有更精确的 NAPI 档位号或官方发布矩阵依据，请回填本节的「底层原因」段。

### 2.5 数据库迁移只增、不回滚

- 所有形态启动前/发布时统一执行 **`prisma migrate deploy`**（只应用未执行的迁移，已应用则跳过），**禁止** `migrate dev/reset/db push`（裸机 `deploy.sh` 有白名单守卫）。
- 升级 = 换应用代码/镜像 + `migrate deploy`；**回应不回数据**，回滚应用版本不会自动撤销已落地的迁移。升级前先做本地在线快照。

### 2.6 健康探针（验证通用）

- `GET /healthz`：存活（liveness）。
- `GET /readyz`：就绪（readiness），串行五探针 `dbPing/dbWritable/migrations/uploadsWritable/disk`；全过返回 `200 {"status":"ready",...}`，任一失败 `503`。
- 兼容别名 `GET /api/health`。

### 2.7 首次部署：创建超级管理员

三套部署都在「`prisma migrate deploy` + nav-reconcile 之后、服务启动之前」执行一次 `node dist/init-admin.js`，用 `GX_INIT_ADMIN_EMAIL` / `GX_INIT_ADMIN_PASSWORD` 创建第一个 ACTIVE 用户、授予系统 owner、标记首次登录强制改密。脚本**幂等**（`users` 表已有任何用户即跳过）。三个包装脚本（fpk `install_callback`、docker entrypoint、裸机 `deploy.sh`）在两个变量任一为空时直接跳过、不调用该脚本，因此**包装层正常继续、不失败**（首个通过 `/api/auth/signup` 注册的用户会自动成为所有者）；但要区分：若在 `NODE_ENV=production` 下**直接执行** `init-admin.js` 且缺凭据，脚本自身以 exit 64 失败（退出码表见 first-admin-init.md）。生产必须由部署者注入真实凭据，初始化完成后建议从 env 删除这三行。完整顺序、验证 SQL、重试与回滚见 [`first-admin-init.md`](./first-admin-init.md)。

---

## 3. 三方案关键差异矩阵

| 维度 | 飞牛原生 fpk | Docker | macOS 直装 |
| --- | --- | --- | --- |
| 产物 | `<app>-<ver>-<arch>.fpk` | OCI 镜像 + compose | 源码工作树 |
| Node 运行时 | fnOS 依赖包 `nodejs_v22`（`/var/apps/nodejs_v22/target/bin`） | 镜像内置 `node:22-bookworm` | 本机 Node v22（pnpm via corepack） |
| 进程入口 | `cmd/main start/stop/status` | 容器 1 号进程 entrypoint | `pnpm dev` / `node dist/index.js` |
| 监听 | TCP 端口 env `PORT`（向导 `wizard_port`，默认 **9527**，绑 `0.0.0.0`） | TCP 3001（可绑回环） | dev 5173 / API 3001 TCP |
| 对外前缀 | 根 `/`（页面+API 同源 `http://NAS:端口`；桌面门户跨源 iframe 嵌入） | 根 `/`（反代自行加前缀/TLS） | `/` |
| TLS | 应用只出 http 独立端口；TLS/外网由用户自行映射/反代该端口 | 自行挂反代（Caddy/Traefik/NAS 网关） | 无（http 本地） |
| 前端 base | Vite `base=/`（`build-fpk.mjs` 内置） | `/` | `/` |
| 数据目录 | data-share（`TRIM_DATA_SHARE_PATHS`） | 卷 `/data` | `apps/api/dev.db` 等仓库内文件 |
| 配置注入 | 生命周期脚本导出 env（`TRIM_*` 映射 `GX_*`） | compose `environment`/env_file | `.env` / shell env |
| 迁移时机 | `install_callback` / `upgrade_callback` | 容器 entrypoint（启动前） | 手动 `pnpm db:migrate`/`db:deploy` |
| 架构包 | 每架构一份 fpk | 每架构一个镜像（manifest list） | 本机架构即可 |
| 升级 | fnOS 应用中心升级 + `upgrade_callback` | 换镜像 tag 重建容器 | `git pull && pnpm install && db:deploy` |
| 适用场景 | 飞牛 NAS 终端用户 | 通用自托管生产 | 开发/调试/演示 |

---

## 4. 最低硬件与容量基线（Tier-L）

- **最低**：2 核（x86_64 或 arm64）、4GB RAM、机械盘/典型 NAS 网络盘、Linux（飞牛原生需国内版 `os_min_version=1.1.3100` 及以上）。
- 设计活跃数据量：单表 1 万–10 万行为日常舒适区；50 万/100 万行仅作为**参考画像**，不是硬门。
- 磁盘门：`GX_MIN_DISK_MB` 默认 1024MB，`/readyz` 的 disk 探针低于即 not ready；NAS 小盘可按实际下调（但要给 WAL、快照留足空间）。
- 内存：SQLite 单进程 + Node，RSS 有界；NAS 上建议为容器/应用预留 ≥512MB 可用内存。

---

## 5. 通用排障速查（详见各篇）

| 症状 | 先看 |
| --- | --- |
| 进程一启动就退出，码 2 | 生产配置闸门：`JWT_SECRET`（≥16 且非内置默认值）、`DATABASE_URL`（`file:`+绝对路径）、`CORS_ORIGIN` 缺失/非法 |
| 飞牛里卡片打不开/白屏 | 独立端口（默认 9527）是否监听/被占用（后端 `EADDRINUSE` 兜底）、`wizard/upgrade` 是否存在（缺则 `${wizard_port}` 以字面量注册进桌面入口、点开白屏）、`app/ui/config` 是否 `type=iframe`+`port=${wizard_port}`、`cmd/main status` 是否 0 |
| 页面打开但接口 404 | 飞牛/裸机根路径部署接口在 `/api/*`；确认 env 未误设旧网关前缀 `GX_BASE_PATH`（飞牛 `cmd/main` 已 `unset`）、前端 Vite `base` 与实际前缀一致（独立端口用 `/`） |
| Docker 起不来或 Illegal instruction | 镜像架构与宿主不符（amd64/arm 原生模块装错），用 buildx 按目标架构重建 |
| `database is locked`/BUSY | WAL + busy_timeout（已内置 5000ms）；检查是否多进程写同一 `app.db`、备份/迁移是否并发 |
| readyz 503 migrations | 迁移没跑或迁移目录不对（`GX_MIGRATIONS_DIR`）；执行 `prisma migrate deploy` |
| 上传/附件写失败 | `UPLOAD_ROOT`/data-share 目录权限或磁盘满（disk 探针） |
