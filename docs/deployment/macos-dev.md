# macOS 直接部署（本地开发与调试）

> 目标：在 Mac（Intel / Apple Silicon 均可）上跑起 GouXiangDB 全栈用于**开发、断点调试、跑测试、本地演示**。这不是生产交付形态——数据在仓库内、无 TLS、用开发密钥、进程由终端管理。
> 技术栈：Node ≥20（推荐 22）、pnpm 9（corepack）、Vite 5173（前端 dev，热更新）+ Hono/tsx 3001（API）。

---

## 1. 前置条件

| 项 | 要求 | 核对命令 |
| --- | --- | --- |
| macOS | 12+ 均可；Apple Silicon / Intel 都行（原生模块按本机构架安装，无跨架构问题） | `uname -m` |
| Node.js | ≥ 20，推荐 **22**（与飞牛 `nodejs_v22`、Docker `node:22` 对齐） | `node -v` |
| pnpm | 9.x，用 corepack 启用（仓库 `packageManager=pnpm@9.0.0`） | `pnpm -v` |
| Git | 拉源码 | `git --version` |
| 磁盘 | 预留 ≥2GB（node_modules + 构建产物），数据量另计 | — |
| 工具链 | 一般无需 Xcode；仅当 better-sqlite3 无本机 prebuild 需编译时，才要 Xcode CLT（`xcode-select --install`）。Node 22 + better-sqlite3 13 通常有 darwin prebuild | — |

启用 pnpm（若 `pnpm -v` 报找不到）：

```bash
corepack enable
corepack prepare pnpm@9.0.0 --activate
pnpm -v   # 9.0.0
```

> 不要用 `npm install -g pnpm` 与 corepack 混用，避免版本漂移。

---

## 2. 启动步骤

### 2.1 取码与安装依赖

```bash
cd ~/Desktop   # 或任意工作目录
git clone <repo-url> GouXiangDB   # 已有源码则跳过
cd GouXiangDB

pnpm -w install --frozen-lockfile
```

> monorepo（pnpm workspace）含 `apps/api`、`apps/web`、`apps/desktop`、`packages/*`。`--frozen-lockfile` 保证按 lockfile 安装，better-sqlite3 自动取 **darwin/本机架构** prebuild。

### 2.2 配置本地环境变量

API 的本地配置在 `apps/api/.env`（已被 `.gitignore` 忽略，不提交、不进发布包）。从样例复制：

```bash
cp apps/api/.env.example apps/api/.env
```

最小本地 `.env`（开发闸门全放行）：

```dotenv
NODE_ENV=development
DATABASE_URL="file:./dev.db"
JWT_SECRET="dev-secret-change-in-prod-gouxiangdb-v2"   # 仅本地；该值在生产被拉黑
PORT=3001
# CORS 留空即放行 http://localhost:* 与 127.0.0.1:*
```

要点：

- `NODE_ENV` **不要**设成 `production`，否则会触发生产启动闸门（要求强随机 `JWT_SECRET`、`DATABASE_URL` 绝对路径、`CORS_ORIGIN`）。
- 开发态 `DATABASE_URL=file:./dev.db` 是相对 **`prisma/schema.prisma` 目录**解析的，实际文件在 `apps/api/prisma/dev.db`（含 `-wal`/`-shm`）。
- 本地账号：用页面注册首个账号即管理员；开发环境也可用团队约定的测试账号（凭据存本地、勿入库）。

### 2.3 生成 Prisma Client 并建表

```bash
# 生成 @prisma/client（含本机 query engine）
pnpm db:generate

# 应用迁移到开发库（开发可用 migrate dev；它会按 migrations/ 建表）
pnpm db:migrate
```

- 首次若 `dev.db` 为空，`migrate dev` 会按 `apps/api/prisma/migrations/` 建全部表。
- **只想重放迁移、不要交互/重置**（更接近生产）：`pnpm --filter @gx/api db:deploy`（= `prisma migrate deploy`）。
- 想推倒重来：`pnpm db:reset`（⚠️ 清空 `dev.db` 重建，仅开发库）。

> 说明：根 `package.json` 有 `db:seed` 脚本，但当前仓库**未附带 `prisma/seed.ts`**，执行会报缺文件。本地造数据请走界面注册/建表，或用 API；不要依赖 seed。

### 2.4 启动开发服务（热更新）

最简单——一键并行起所有 app（api + web + desktop）：

```bash
pnpm dev
```

只起前后端（最常用）：

```bash
pnpm dev:api    # 终端 A：tsx watch，http://localhost:3001
pnpm dev:web    # 终端 B：Vite，http://localhost:5173
```

打开 **<http://localhost:5173>**：

- Vite dev server 把 `/api`、`/health`、`/healthz`、`/readyz`、`/uploads` 代理到 `:3001`（见 `apps/web/vite.config.ts`），所以前端只访问 5173 即可，无跨域问题。
- 改 `apps/api/src` → tsx watch 自动重启；改 `apps/web/src` → Vite HMR 即时生效。

### 2.5 生产形态本地预览（可选，验证打包/网关行为）

用于在本机验证"同进程托管前端 + 构建产物"或"socket/子路径"等部署相关改动：

```bash
pnpm -r run build                       # 构建 api(dist/index.js) 与 web(dist/)
cd apps/api
DATABASE_URL="file:./prisma/dev.db" \
GX_WEB_DIST="$(pwd)/../web/dist" \
PORT=3001 \
node dist/index.js
```

然后直接访问 <http://localhost:3001>（API 与前端同端口，等同容器内形态）。

**模拟飞牛网关（unix socket + 子路径）**：

> 【2026-10 注】本节模拟的是 **0.2.4 及以前** 的旧飞牛网关（socket+子路径）形态，当前飞牛已改 9527 独立 TCP 端口（见 `fnos-native.md`）；socket 适配代码仍在、可用于复现旧版，勿当作现行飞牛调试路径。

```bash
# 先用子路径构建前端
VITE_BASE_PATH=/app/gouxiangdb pnpm --filter @gx/web build

SOCK=/tmp/gx-dev.sock
GX_SOCKET_PATH=$SOCK \
GX_BASE_PATH=/app/gouxiangdb \
GX_WEB_DIST="$(pwd)/apps/web/dist" \
DATABASE_URL="file:$(pwd)/apps/api/prisma/dev.db" \
node apps/api/dist/index.js

# 另一终端经 unix socket 验证
curl -s --unix-socket $SOCK http://localhost/app/gouxiangdb/healthz
curl -s --unix-socket $SOCK http://localhost/app/gouxiangdb/ | grep -o '<div id="root">'
# 用完 kill 进程（会自动 unlink socket）
```

---

## 3. 关键配置项（本地）

| 变量 | 本地典型值 | 说明 |
| --- | --- | --- |
| `NODE_ENV` | `development` | 开发免生产闸门；test 由 vitest 自动设 |
| `DATABASE_URL` | `file:./dev.db` | 实际 `apps/api/prisma/dev.db`；换库改这里 |
| `JWT_SECRET` | 开发默认串 | 仅本地，生产值被启动闸门拉黑 |
| `PORT` | 3001 | API 端口；被占用可改（同时改 vite proxy 目标，见下） |
| `CORS_ORIGIN` | 留空 | 放行 localhost/127.0.0.1 任意端口 |
| `GX_DATA_DIR` | 留空（=apps/api） | 上传默认 `apps/api/uploads`，审计 `apps/api/.audit` |
| `GX_NO_LISTEN` | 不设 | 设 `1` 时只 import 不起服务（测试用） |
| `GX_SOCKET_PATH` / `GX_BASE_PATH` / `GX_WEB_DIST` | 仅 2.5 模拟时设 | 默认空＝TCP 根路径、纯 API（现状） |
| `VITE_API_URL` | 一般不设 | 显式指定前端 API 来源；不设则同源（dev 走 5173 代理） |
| `VITE_BASE_PATH` | 不设（根） | 设 `/app/gouxiangdb` 可本地复现飞鱼子路径 |

改了 API 端口（如 3002）：同步改 `apps/web/vite.config.ts` 的 proxy target，或 dev 时设 `VITE_API_URL=http://localhost:3002`。

### 测试与质量命令

```bash
pnpm typecheck                 # 全仓类型检查
pnpm --filter @gx/web typecheck
pnpm --filter @gx/api typecheck
pnpm test                      # 各包 vitest run
pnpm --filter @gx/api test     # 仅后端（单测；vitest 自动 NODE_ENV=test）
pnpm --filter @gx/web test:e2e # 前端 Playwright E2E（需要浏览器依赖）
pnpm lint
```

### 本地备份/恢复演练

```bash
# 在线一致性快照（零额外二进制，输出到 apps/api/.db-backups/ 或 BACKUP_DIR）
pnpm --filter @gx/api backup:online
pnpm --filter @gx/api backup:verify    # 校验快照可恢复
```

恢复步骤见 [`../runbooks/restore.md`](../runbooks/restore.md)。异地加密备份默认关闭，本地不需要配 age。

---

## 4. 部署验证（本地自检）

```bash
# API 存活/就绪（直接打 3001）
curl -fsS http://localhost:3001/healthz
curl -fsS http://localhost:3001/readyz | python3 -m json.tool   # 期望 "status": "ready"
curl -fsS http://localhost:3001/api/health
curl -fsS http://localhost:3001/                                # 根 JSON 服务信息

# 经 Vite 代理（5173）
curl -fsS http://localhost:5173/api/health
```

浏览器 <http://localhost:5173>：注册首个账号 → 新建 base/表 → 增删记录 → 上传头像 → 建知识库文档，确认数据落 `apps/api/prisma/dev.db`、附件落 `apps/api/uploads/`。

查库（可选）：用任意 SQLite 工具打开 `apps/api/prisma/dev.db`，或 `sqlite3 apps/api/prisma/dev.db ".tables"`。

---

## 5. 常见问题排查

| 症状 | 原因 / 处理 |
| --- | --- |
| `pnpm install` 原生模块失败（better-sqlite3 编译） | 缺 darwin prebuild 或网络；装 Xcode CLT（`xcode-select --install`）后重装；确认 Node 大版本为 20/22；删除 node_modules 与 lock 外的缓存重装 |
| API 启动即退出码 2，打印 `[config] 启动配置校验失败` | `NODE_ENV` 被设成了 production 但用了开发密钥/相对库路径/CORS 空。本地设回 `NODE_ENV=development` |
| `EADDRINUSE: 3001` | 端口被占：`lsof -i :3001` 找进程 kill，或改 `.env` 的 `PORT` 并同步 vite proxy |
| 5173 页面开但接口网络错误/CORS | API（3001）没起；或改了 API 端口没改 proxy target；确认 `pnpm dev:api` 正在运行 |
| Prisma 报 client 未生成 / engine 找不到 | 先 `pnpm db:generate`；切换 Node 大版本后重新 `pnpm install` + generate（query engine 与版本/架构相关） |
| `Can't reach database`/迁移没生效 | 确认对正确的 `dev.db` 操作（相对路径基准是 `apps/api/prisma/`）；`pnpm db:deploy` 重放迁移 |
| HMR/改代码不生效 | tsx watch/Vite 偶发缓存：重启对应 dev 进程；清 `apps/web/node_modules/.vite`（应用 plait 补丁后也要求清这个缓存） |
| Apple Silicon 上起容器报架构错 | 与本地直装无关；容器走 [`docker.md`](./docker.md) 的 buildx arm64。本地 `node dist` 用的是 darwin/arm64 prebuild，正常 |
| 上传的图不显示 | 看 `UPLOAD_ROOT`（默认 `apps/api/uploads/avatars`）；5173 经 `/uploads` 代理到 3001 |
| 想彻底重置本地数据 | `pnpm db:reset`（清空重建 dev.db）；附件另删 `apps/api/uploads`（⚠️ 仅本地） |
| 数据库锁 `database is locked` | 多个进程同时写同一 dev.db（如误开两个 api）；关掉多余实例；WAL busy_timeout 已内置 |

---

## 6. 与生产部署的差异（务必知悉）

- **密钥**：本地用开发默认 `JWT_SECRET`（生产会被直接拉黑）；生产用 `openssl rand -base64 32`。
- **数据库路径**：本地相对路径（随 `prisma/` 解析）；生产/Docker/飞牛一律**绝对路径**。
- **TLS/网关**：本地 http + Vite 代理；生产由 Caddy/飞牛统一网关终结 TLS。
- **进程管理**：本地终端前台 + watch；生产用 systemd / Docker restart / 飞牛 `cmd/main`。
- **数据位置**：本地在仓库工作树（可随时 reset 清掉）；生产在独立数据目录/卷/data-share，升级只增迁移、不回数据。
- **架构二进制**：本地只装本机构架；发布 fpk/镜像必须按目标 Linux 架构分别构建。
- **CORS**：本地留空放行 localhost；生产必须显式白名单。

继续读：[`README.md`](./README.md)（总览与选型）、[`docker.md`](./docker.md)、[`fnos-native.md`](./fnos-native.md)。
