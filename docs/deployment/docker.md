# Docker 部署

> 目标：用单容器单端口跑全栈（同进程提供 API 与 Web 静态），数据全部持久化到一个挂载卷；一条 `docker compose up -d` 完成启动（含自动迁移）。适用于通用 Linux 服务器，以及群晖/威联通/飞牛等**支持 Docker 的 NAS**。
> 部署物在仓库 `deploy/docker/`：`Dockerfile`、`docker-compose.yml`、`docker-entrypoint.sh`、`gouxiangdb.env.example`、仓库根 `.dockerignore`。

---

## 1. 前置条件

### 1.1 主机

| 项 | 要求 |
| --- | --- |
| 系统 | Linux（内核 ≥ 3.10）；Windows/macOS 仅作本地测试 |
| Docker | Engine 20.10+，含 Compose v2 插件（`docker compose version` 可用） |
| 资源 | 2C/4GB 起（Tier-L），预留 ≥1GB 数据空间 |
| 架构 | x86_64 或 arm64；**镜像架构必须与主机一致**（better-sqlite3/Prisma 引擎是原生二进制） |
| 网络 | 构建机能访问 npm registry；运行机若只用预构建镜像可不联网 |

可用只读探针快速自检（不安装任何东西）：

```bash
bash deploy/probe/docker-probe.sh
# 三态：docker-ready / docker-installable / docker-unavailable
```

### 1.2 镜像来源（二选一）

- **自行构建**（推荐，源码交付）：在仓库根用 `deploy/docker/Dockerfile` 构建。
- **预构建镜像**（若将来发布到 registry）：`docker pull` 后直接用 compose，需确认是多架构 manifest list。

---

## 2. 镜像构建

### 2.1 Dockerfile 结构（多阶段）

`deploy/docker/Dockerfile` 分两阶段：

- **builder**（`node:22-bookworm-slim`）：装 ca-certificates/openssl，corepack 启用 pnpm@9；先按 workspace 清单 `pnpm install --frozen-lockfile` 利用缓存，再拷全源码 `pnpm -r run build`（web vite + api esbuild），并在 **builder 架构**上 `prisma generate`。
- **runner**（同基础镜像）：非 root 用户（镜像内置 `node`）运行；只复制运行所需 `apps/api/dist`、`apps/api/prisma`、`apps/web/dist`、必要 package.json/lock，`pnpm install --prod` 后在 runner 架构再 `prisma generate`，确保 better-sqlite3 prebuild 与 query engine 匹配；entrypoint 启动前 `prisma migrate deploy`。

内置默认环境（可被 compose/env 覆盖）：

```dockerfile
ENV NODE_ENV=production \
    PORT=3001 \
    GX_DATA_DIR=/data \
    UPLOAD_ROOT=/data/uploads \
    BACKUP_DIR=/data/backups \
    GX_AUDIT_DIR=/data/log \
    DATABASE_URL=file:/data/app.db \
    GX_WEB_DIST=/app/apps/web/dist \
    GX_MIGRATIONS_DIR=/app/apps/api/prisma/migrations
EXPOSE 3001
VOLUME ["/data"]
```

> `JWT_SECRET` 与 `CORS_ORIGIN` **不内置**，必须运行时注入（缺失则生产闸门退出码 2 / compose 直接报错）。

### 2.2 本机构建（与主机同架构）

```bash
cd <仓库根>
docker build -f deploy/docker/Dockerfile -t gouxiangdb:0.1.7 .
```

### 2.3 跨架构构建（x86 + arm，发布到多架构）

```bash
docker buildx create --use --name gxbuilder 2>/dev/null || true
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -f deploy/docker/Dockerfile \
  -t gouxiangdb:0.1.7 --push .
```

- 必须在**目标平台阶段**装原生依赖 + `prisma generate`（Dockerfile 已如此设计）；切勿在 amd64 装好 `node_modules` 再复制进 arm 镜像。
- better-sqlite3 依赖 Node 官方 glibc prebuild，`bookworm-slim` 满足；alpine（musl）需要额外编译工具链，故不用 alpine。
- 仅本地验证单架构可不 push，用 `--load`（一次只能 load 一个平台）。

---

## 3. 容器运行（docker compose）

### 3.1 准备配置

```bash
cp deploy/docker/gouxiangdb.env.example deploy/docker/gouxiangdb.env
chmod 600 deploy/docker/gouxiangdb.env
# 编辑：至少填 JWT_SECRET 与 CORS_ORIGIN
```

`gouxiangdb.env.example` 关键项：

```dotenv
# 必填：openssl rand -base64 32（≥16，禁用源码内置开发默认值）
JWT_SECRET=
# 必填：浏览器访问本服务的来源（含协议/端口），逗号分隔多个
CORS_ORIGIN=http://localhost:3001
# 可选（默认 1024）：/readyz disk 探针下限（MB）
GX_MIN_DISK_MB=1024

# 异地加密备份默认【不启用】（commit 92d0a34：仅本地快照），以下保持注释：
# BACKUP_ENCRYPT_OFFSITE=false
# AGE_RECIPIENT=
# AGE_BIN=age
# GX_OFFSITE_TARGET=

# 可选：首次部署自动创建超级管理员（三个都取消注释并填真值才生效）
# GX_INIT_ADMIN_EMAIL=admin@example.com
# GX_INIT_ADMIN_PASSWORD=<openssl rand -base64 24>
# GX_INIT_ADMIN_NAME=超级管理员
```

#### 首次部署的超级管理员（可选）

`docker-entrypoint.sh` 在 `prisma migrate deploy` + nav-reconcile 之后、`exec node dist/index.js` 之前执行一次 `node dist/init-admin.js`：只在 `GX_INIT_ADMIN_EMAIL` 与 `GX_INIT_ADMIN_PASSWORD` **两个都非空**时创建第一个 ACTIVE 用户、授予系统 owner、标记首登强制改密；任一为空则打印一行提示并**正常继续、不阻断启动**（首个通过 `/api/auth/signup` 注册的用户会自动成为所有者）。脚本**幂等**（`users` 表已有任何用户即跳过），初始化完成后建议把这三行从 `gouxiangdb.env` 删掉。失败即非零退出、不接流量（容器按 `restart: unless-stopped` 重启）。详见 [`first-admin-init.md`](./first-admin-init.md)。

生成密钥：

```bash
openssl rand -base64 32
```

### 3.2 `docker-compose.yml`（要点）

```yaml
services:
  gouxiangdb:
    build:
      context: ../..            # 仓库根
      dockerfile: deploy/docker/Dockerfile
    image: gouxiangdb:0.1.7
    container_name: gouxiangdb
    restart: unless-stopped
    ports:
      - "127.0.0.1:3001:3001"   # 默认只绑回环，前置反代；要直连改 "0.0.0.0:3001:3001"
    env_file:
      - ./gouxiangdb.env
    environment:
      JWT_SECRET: ${JWT_SECRET:?set JWT_SECRET in gouxiangdb.env}
      CORS_ORIGIN: ${CORS_ORIGIN:?set CORS_ORIGIN in gouxiangdb.env}
    volumes:
      - gouxiang-data:/data
    healthcheck:
      test: ["CMD","node","-e","fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 5
      start_period: 20s

volumes:
  gouxiang-data:
```

### 3.3 启动 / 停止 / 看日志

```bash
docker compose -f deploy/docker/docker-compose.yml up -d --build
docker compose -f deploy/docker/docker-compose.yml ps
docker compose -f deploy/docker/docker-compose.yml logs -f
docker compose -f deploy/docker/docker-compose.yml restart
docker compose -f deploy/docker/docker-compose.yml down        # 停容器，命名卷数据保留
```

---

## 4. 端口、数据卷与环境变量

### 4.1 端口

| 容器端口 | 用途 | 宿主默认 |
| --- | --- | --- |
| 3001/TCP | API + Web（同进程，`GX_WEB_DIST` 已设）+ `/healthz` `/readyz` `/uploads` | `127.0.0.1:3001`（仅本机/反代可达） |

- 直接局域网暴露：把映射改 `0.0.0.0:3001:3001`，并让 `CORS_ORIGIN` 包含实际来源。
- 生产建议前置 Caddy/Traefik/NAS 反向代理终结 TLS；裸机 Caddy 范例见 `deploy/caddy/Caddyfile`（把后端指到容器映射端口即可）。

### 4.2 数据持久化（全部在 `/data`）

| 容器路径 | 内容 | 对应变量 |
| --- | --- | --- |
| `/data/app.db`（+ `-wal` `-shm`） | SQLite 主库 | `DATABASE_URL=file:/data/app.db` |
| `/data/uploads/` | 头像等附件 | `UPLOAD_ROOT` |
| `/data/backups/` | 本地在线快照 | `BACKUP_DIR` |
| `/data/log/` | 审计日志 | `GX_AUDIT_DIR` |

- 用**命名卷** `gouxiang-data:/data`（compose 默认）；也可换绑定挂载便于直接在主机/NAS 共享目录查看：

  ```yaml
  volumes:
    - /srv/gouxiangdb/data:/data
  ```

  绑定挂载在某些 NAS（网络盘/特殊权限）上要确认 uid 一致、支持 POSIX 文件锁与 fsync（SQLite WAL 要求）。

- **备份**：对运行中的库不要直接拷 `app.db`（WAL 下不一致）。用容器内在线快照：

  ```bash
  docker compose exec gouxiangdb node scripts/backup/online-backup.mjs
  ```

  产物在 `/data/backups`（持久化卷内）。异地加密默认关闭。

### 4.3 环境变量速查

| 变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `NODE_ENV` | 镜像内置 | production | 启动闸门 |
| `JWT_SECRET` | ✅ | — | ≥16 随机，非内置默认值 |
| `CORS_ORIGIN` | ✅ | — | 前端来源白名单（逗号分隔，支持 `*.` 子域通配写法，不裸 `*`） |
| `DATABASE_URL` | 内置 | `file:/data/app.db` | 改它则数据落别处（一般不动） |
| `PORT` | 否 | 3001 | |
| `GX_DATA_DIR` | 内置 | `/data` | |
| `GX_MIN_DISK_MB` | 否 | 1024 | disk 探针下限 |
| `GX_BODY_LIMIT_JSON` / `GX_BODY_LIMIT_UPLOAD` / `GX_BODY_LIMIT_ATTACHMENT` | 否 | 1 / 6 / 20（MB） | 附件档同时是单文件上限与 `/api/attachments` 请求体总闸 |
| `GX_RATE_LIMIT` | 否 | on | 压测才设 off |
| `GX_INIT_ADMIN_EMAIL`/`GX_INIT_ADMIN_PASSWORD`/`GX_INIT_ADMIN_NAME` | 否 | 空 | 首次部署创建超级管理员；两者（EMAIL/PASSWORD）都非空才执行，空则跳过且不失败，详见 [`first-admin-init.md`](./first-admin-init.md) |
| `GX_SOCKET_PATH`/`GX_BASE_PATH` | 否 | 空 | Docker 走 TCP 根路径，**不用**；仅飞牛原生用 |
| 备份四变量 | 否 | 关 | 异地加密预留，默认不启用 |

---

## 5. 部署验证

```bash
# 1) 容器健康（health: starting -> healthy）
docker compose ps
docker inspect --format '{{.State.Health.Status}}' gouxiangdb

# 2) 就绪探针：期望 200 + "status":"ready"
curl -fsS http://127.0.0.1:3001/readyz | head
curl -fsS http://127.0.0.1:3001/healthz

# 3) 前端首页
curl -fsS http://127.0.0.1:3001/ | grep -o '<div id="root">' 
# 任意前端深路径回退 index.html（SPA）
curl -fsS -o /dev/null -w '%{http_code} %{content_type}\n' http://127.0.0.1:3001/some/spa/route

# 4) API
curl -fsS http://127.0.0.1:3001/api/health

# 5) 浏览器打开 http://<host>:3001 注册/登录、建表、写记录、传头像
```

`/readyz` 返回体含五探针（`dbPing/dbWritable/migrations/uploadsWritable/disk`）；任一 false 会以短码给出 503。

**初始超级管理员验证**（仅配置了 `GX_INIT_ADMIN_*` 时）：

```bash
# 1) entrypoint 日志出现初始化步骤（未配置凭据时应是"跳过自动初始化"且不失败）
docker compose -f deploy/docker/docker-compose.yml logs gouxiangdb | grep -E 'init-admin|超级管理员'

# 2) 用初始账号登录：期望 200 且 user.mustChangePassword 为 true
curl -sS -X POST http://127.0.0.1:3001/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"<GX_INIT_ADMIN_EMAIL>","password":"<GX_INIT_ADMIN_PASSWORD>"}'

# 3) 查库确认用户与 owner 授予（镜像无 sqlite3 CLI，用发布包自带的 better-sqlite3）
docker compose -f deploy/docker/docker-compose.yml exec gouxiangdb node -e \
  "const D=require('better-sqlite3');const db=new D('/data/app.db',{readonly:true});\
console.log(db.prepare('SELECT id,email,displayName,status,mustChangePassword FROM users').all());\
console.log(db.prepare(\"SELECT id,roleId,subjectType,subjectId FROM role_assignments WHERE roleId='role_owner' AND subjectType='user'\").all());"

# 4) 审计事件
docker compose -f deploy/docker/docker-compose.yml exec gouxiangdb \
  grep '"event":"admin_initialized"' /data/log/audit.logl
```

**持久化验证**：写几条记录 → `docker compose down` → 重新 `up -d` → 数据仍在；附件可访问。

**升级演练**：换镜像 tag → `up -d`，entrypoint 先 `migrate deploy`（只增）再起服务；升级前先在旧容器跑一次在线快照。

---

## 6. 常见问题排查

| 症状 | 排查点 |
| --- | --- |
| 容器反复重启 / `Exited (2)` | 生产闸门：`JWT_SECRET` 缺失或太短/为内置默认值、`DATABASE_URL` 非绝对路径、`CORS_ORIGIN` 空。`docker compose logs` 看 `[config]` 明细 |
| `compose up` 立即报 `JWT_SECRET:?set ...` | 没填 `deploy/docker/gouxiangdb.env` 或没 `env_file`；填后重试 |
| 启动卡在迁移/迁移失败 | entrypoint 仅执行 `migrate deploy`；看日志具体迁移错误；数据卷是旧版本库时确认迁移链连续；不要用 dev/reset |
| `Illegal instruction` / 加载 `.node` 失败 | 镜像架构与主机不符（arm 主机跑了 amd64 原生模块）；用 buildx 按目标架构重建，`docker inspect <img> --format '{{.Architecture}}'` 核对 |
| health 一直 unhealthy | 进容器 `node -e "fetch('http://127.0.0.1:3001/readyz')..."`；多为 disk 探针（空间 < `GX_MIN_DISK_MB`）、migrations 未就绪、`/data` 只读 |
| 浏览器 CORS 报错 | `CORS_ORIGIN` 与实际访问来源（协议+主机+端口）不一致；经反代后要填对外域名 |
| 绑定端口打不开 | 默认仅绑 `127.0.0.1`；需局域网直连改 `0.0.0.0:3001:3001` 并用防火墙限制 |
| `database is locked` | 多容器/多进程写同一卷上的 `app.db`（只能单写实例）；绑定到不支持锁的网络盘；备份与迁移并发 |
| 绑定挂载权限/上传失败 | 容器内运行 uid 对宿主目录无写权限；`chown` 到该 uid 或改用命名卷；看 disk/uploadsWritable 探针 |
| 页面 404 / 刷新 404 | 应回退 index.html；确认走的是镜像内同进程托管（`GX_WEB_DIST` 未被覆盖为空），不是另挂了错误的静态 server |
| 构建慢/拉取失败 | 网络访问 npm；Dockerfile 已先拷 package 清单利用层缓存；企业网配 build 代理/registry mirror |

---

## 7. 附录：在飞牛 fnOS 内以 Docker 形态交付（docker-project）

同一镜像也能打成飞牛 fpk 的**容器形态**（与 [`fnos-native.md`](./fnos-native.md) 的原生 socket 形态二选一）。要点（对齐飞牛 Docker 应用案例）：

- `fnpack create gouxiangdb-docker --template docker`；`config/resource`：

  ```json
  { "docker-project": { "projects": [ { "name": "gouxiangdb", "path": "docker" } ] } }
  ```

- `app/docker/docker-compose.yaml` 用飞牛变量挂数据目录，二选一暴露：
  - **端口入口**：`manifest` 写 `service_port`（如 3001）+ `checkport=true`，compose `"${TRIM_SERVICE_PORT}:3001"`，`app/ui/config` 用 `protocol/port`；
  - **统一网关 socket**（更整合）：把 `${TRIM_APPDEST}:/app/target` 挂进容器，设 `GX_SOCKET_PATH=/app/target/app.sock`、`GX_BASE_PATH=/app/gouxiangdb`，`app/ui/config` 用 `gatewayPrefix:/app/gouxiangdb` + `gatewaySocket:app.sock`（容器内服务监听 `/app/target/app.sock`）。
  - 数据持久化挂 `${TRIM_DATA_SHARE_PATHS}` 到容器 `/data`（并在 `config/resource` 同时声明 data-share）。
- `cmd/main status` 用 `docker inspect --format` 判容器 `running`（运行 0 / 停止 3）。
- **架构**：即使 fpk 写 `platform=all`，镜像本身仍须支持目标架构（多架构 manifest list），否则容器起不来。

> 选型：要最整合的 fnOS 体验、不想依赖容器运行时 → 原生形态（fnos-native.md）；要与非飞牛环境共用同一套镜像/构建 → 本附录的 docker-project 形态。
