# 飞牛 fnOS 原生应用部署（.fpk）

> 目标：把 GouXiangDB 打包成飞牛 fnOS 官方应用，用户在**应用中心**一键安装/启停、从**桌面卡片**打开；后端进程由 fnOS 应用框架托管，经**统一网关 Unix socket** 暴露在 `/app/gouxiangdb` 前缀下，单进程同时提供 API 与 Web 静态资源。
> 规范来源：飞牛 fnOS 开发者文档（`fnnas-docs` 技能：Native 应用案例、Manifest、环境变量、运行时、应用框架、fnpack CLI）。本文所有字段/路径/退出码均以该文档为准。

---

## 0. 为什么不能"直接把裸机包丢进去"

GouXiangDB 当前实现与飞牛原生形态有四个差异，本方案逐一适配：

| # | 现状（裸机/API 形态） | 飞牛原生要求 | 适配 |
| --- | --- | --- | --- |
| 1 | `serve({fetch,port})` 只监听 TCP 3001 | 统一网关经 **Unix socket** 转发，不声明 `service_port` | 后端新增 `GX_SOCKET_PATH`，用 `@hono/node-server` 的 `getRequestListener` + `node:http` 监听 `${TRIM_APPDEST}/app.sock` |
| 2 | API 只挂 `/api`，Web 由外部 Caddy 托管 | 单进程、网关前缀下要同时给前端页面与接口 | 后端新增 `GX_BASE_PATH=/app/gouxiangdb`（前缀+根双挂载）与 `GX_WEB_DIST`（同进程托管 `web/dist` + SPA 回退） |
| 3 | Vite `base=/`，前端请求写死同源根 `/api` | 页面资源与接口都在 `/app/gouxiangdb/` 子路径 | 前端构建期 `VITE_BASE_PATH=/app/gouxiangdb`，API 基址随 Vite base 走 |
| 4 | better-sqlite3 `.node` + Prisma query engine 是**架构相关二进制** | `manifest.platform=all` 仅适用于"不含架构二进制"的包 | **必须按 `x86` / `arm` 分别构建两份 fpk**，不能 `all` |

> 上述 #1/#2 由后端在 `apps/api` 落地（`GX_SOCKET_PATH`/`GX_BASE_PATH`/`GX_WEB_DIST`，缺省即维持现状）；#3 由前端落地（`VITE_BASE_PATH`）。三者都默认关闭，不影响 Docker/裸机/macOS。

---

## 1. 前置条件

### 1.1 构建机

| 项 | 要求 |
| --- | --- |
| 操作系统 | Linux（推荐与目标 NAS 同架构 / 用目标架构机或容器构建）；macOS 可打"纯 JS 组装"但**无法可靠选取 Linux 原生模块**，跨架构请在 Linux + Docker/QEMU 中构建 |
| Node.js | v22（与飞牛 `nodejs_v22` 大版本一致；仓库要求 ≥20） |
| pnpm | 9.x（`corepack enable && corepack prepare pnpm@9.0.0 --activate`） |
| fnpack CLI | 1.2.3（按构建机系统下载，见 §6） |
| 网络 | 可访问 npm registry（安装生产依赖、`prisma generate` 拉对应架构引擎） |
| 源码 | GouXiangDB monorepo（含本方案新增的 socket/basePath 适配与 `deploy/fnos/` 打包骨架） |

> **架构铁律**：fpk 内 `node_modules` 必须是 **Linux + 目标架构**（glibc）。在 Apple Silicon Mac 上直接 `pnpm install --prod` 得到的是 darwin/arm64 的 better-sqlite3，塞进飞牛（Linux）必崩。稳妥做法见 §6.3「按架构构建」。

### 1.2 目标设备

| 项 | 要求 |
| --- | --- |
| 系统 | 飞牛 fnOS，国内版 **≥ 1.1.3100**（统一网关能力，对应 `os_min_version`）；基础内核 Debian 系 |
| 架构 | x86_64 或 arm64（安装与之匹配的 fpk） |
| 运行时 | `nodejs_v22` 依赖应用（由 `install_dep_apps=nodejs_v22` 自动安装，无需用户手装） |
| 资源 | 2C/4GB 起、预留 ≥1GB 可用数据空间（Tier-L 基线） |
| 账号 | 可在应用中心"手动安装"本地 fpk，或设备上可用 `appcenter-cli install-fpk` |

---

## 2. 打包格式与目录结构

### 2.1 fnpack 包目录（源骨架，纳入仓库 `deploy/fnos/gouxiangdb/`）

```text
deploy/fnos/
├── gouxiangdb/                    # fnpack 应用包目录（fnpack build 的输入）
│   ├── manifest                   # INI，无扩展名
│   ├── config/
│   │   ├── privilege              # run-as package
│   │   └── resource               # data-share 数据共享声明
│   ├── cmd/
│   │   ├── main                   # start/stop/status（PID + socket 生命周期）
│   │   ├── install_callback       # 首装：写配置/密钥 + migrate deploy
│   │   ├── upgrade_callback       # 升级：migrate deploy（只增）
│   │   └── uninstall_callback     # 卸载：默认保留用户数据，仅清理 socket/pid
│   ├── wizard/
│   │   └── install                # （可选）收集外部访问 origin，用于 CORS
│   ├── app/
│   │   ├── ui/
│   │   │   ├── config             # 桌面卡片/统一网关注册
│   │   │   └── images/            # icon_64.png / icon_256.png
│   │   └── server/                # 构建时填充（见 2.2）
│   ├── ICON.PNG
│   └── ICON_256.PNG
├── build-fpk.mjs                  # 组装 server/ + 调 fnpack build（参数化架构）
└── README.md                      # 本文档的构建速查（可选）
```

> fnOS 安装后，框架在 `/var/apps/gouxiangdb` 下生成标准结构：`target`（=`TRIM_APPDEST`，应用文件）、`etc`（`TRIM_PKGETC`，配置）、`var`（`TRIM_PKGVAR`，运行数据/pid/log）、`shares/`（data-share 软链）。脚本中**一律用 `TRIM_*` 变量，不硬编码路径**。

### 2.2 `app/server/`（构建产物，不手维护）

由 `build-fpk.mjs` 在打包时填充，对应裸机发布物的"自包含运行目录"：

```text
app/server/
├── dist/index.js          # esbuild 扁平单文件（external 原生依赖在 node_modules）
├── prisma/
│   ├── schema.prisma
│   └── migrations/        # migrate deploy 所需
├── public/                # = apps/web/dist（index.html + assets/），由 GX_WEB_DIST 指向
├── node_modules/          # 仅生产依赖，Linux/目标架构（better-sqlite3 prebuild + prisma engine）
└── package.json           # 精简运行时 package.json
```

---

## 3. 依赖声明与各配置文件内容

### 3.1 `manifest`（无扩展名，INI）

```ini
appname=gouxiangdb
version=0.1.0
display_name=构想工作台
desc=面向个人与小团队的智能多维表格（SQLite，本地优先）
source=thirdparty
platform=x86
maintainer=构想工作台团队
distributor=构想工作台团队
os_min_version=1.1.3100
install_dep_apps=nodejs_v22
desktop_uidir=ui
desktop_applaunchname=gouxiangdb.main
ctl_stop=true
```

要点（对齐 Manifest 文档）：

- **`platform=x86`（arm 设备构建时改为 `arm`）——绝不使用 `all`**：包含 better-sqlite3/Prisma 架构二进制。两份 fpk 仅该字段与内置 `node_modules` 架构不同。
- **不写 `service_port`/`checkport`**：统一网关经 socket 转发，不占宿主 TCP 端口（参考 Notepad 案例）。
- `install_dep_apps=nodejs_v22`：框架自动装 Node 22 运行时，PATH 在 `/var/apps/nodejs_v22/target/bin`。
- `os_min_version=1.1.3100`：用统一网关的国内版下限。
- `ctl_stop=true`：应用中心显示启动/停止/状态，由 `cmd/main` 实现。
- `desktop_applaunchname=gouxiangdb.main` 必须与 `app/ui/config` 的入口 ID 一致。

### 3.2 `config/privilege`

```json
{
  "defaults": { "run-as": "package" },
  "username": "gouxiangdb",
  "groupname": "gouxiangdb"
}
```

进程以专用应用用户 `gouxiangdb` 运行，最小权限。

### 3.3 `config/resource`（数据共享目录承载数据库/附件/备份）

```json
{
  "data-share": {
    "shares": [
      { "name": "gouxiangdb/data" }
    ]
  }
}
```

安装时系统创建该共享目录并对应用用户授权；运行时经 `TRIM_DATA_SHARE_PATHS`（`:` 分隔多个）拿到绝对路径，也可经 `/var/apps/gouxiangdb/share/data` 软链访问。数据库、上传、本地快照都放这里（卸载可保留、用户可在文件管理器中备份）。

### 3.4 `app/ui/config`（桌面卡片 + CGI 反代入口）

```json
{
  ".url": {
    "gouxiangdb.main": {
      "title": "构想工作台",
      "icon": "images/icon_{0}.png",
      "type": "iframe",
      "protocol": "",
      "url": "/cgi/ThirdParty/gouxiangdb/index.cgi/",
      "allUsers": true
    }
  }
}
```

- **不使用统一网关**（`gatewayPrefix` / `gatewaySocket`）：2026-09-18 在 fnOS 1.2.0604 上实测，
  声明统一网关后访问 `http://<nas>:5666/app/gouxiangdb/` 返回的是门户自身的 `invalid token`，
  请求根本没进到应用（桌面点开即空白页）。设备上唯一正常工作的第三方应用
  `com.fnos.dashboard` 走的正是 CGI 反代路线。
- `url` 必须指向 `app/ui/index.cgi`（fnOS 先校验 NAS 登录态，再执行该脚本；脚本用 `curl`
  反代到 `127.0.0.1:${TRIM_SERVICE_PORT}`，端口由 manifest 的 `service_port=3001` 注入）。
- 门户会把用户身份经 **`X-Trim-Userid` / `X-Trim-Username` / `X-Trim-Isadmin`** 头传给 CGI。
- ⚠️ **不要把应用 JWT 放在 `Authorization` 头**：`trim_http_cgi` 会把它当 fnOS 令牌校验，
  非 fnOS 令牌一律返回 `200 invalid token` 并吞掉请求。Web 端统一用 **`X-GX-Token`** 头
  （后端 `resolveActiveAuth` 同时接受 `Authorization: Bearer` 与 `X-GX-Token`）。

### 3.5 图标

`app/ui/images/icon_64.png`、`icon_256.png`（供 `{0}` 占位按尺寸选择），根目录 `ICON.PNG`、`ICON_256.PNG`（fnpack 强制检查）。

---

## 4. 生命周期脚本

> 公共约定：每个脚本开头 `export PATH=/var/apps/nodejs_v22/target/bin:$PATH`；失败前把**简短可执行**的中文/英文信息写入 `$TRIM_TEMP_LOGFILE` 并以非零退出；脚本尽量幂等。

### 4.1 `cmd/main`（start/stop/status）

```bash
#!/bin/bash
# GouXiangDB fnOS 生命周期：start/stop/status
set -uo pipefail
export PATH=/var/apps/nodejs_v22/target/bin:$PATH

APP_DIR="${TRIM_APPDEST}/server"
PID_FILE="${TRIM_PKGVAR}/app.pid"
LOG_FILE="${TRIM_PKGVAR}/app.log"
SOCKET_PATH="${TRIM_APPDEST}/app.sock"
ENV_FILE="${TRIM_PKGETC}/gouxiangdb.env"

# 数据共享目录（第一个 share）
DATA_DIR="${TRIM_DATA_SHARE_PATHS%%:*}"

alive() { kill -0 "$1" 2>/dev/null; }

status_app() {
  [ -f "$PID_FILE" ] || return 3
  local pid; pid="$(head -n1 "$PID_FILE" | tr -d '[:space:]')"
  if [ -n "$pid" ] && alive "$pid"; then return 0; fi
  rm -f "$PID_FILE"; return 3
}

start_app() {
  if status_app; then exit 0; fi
  mkdir -p "$TRIM_PKGVAR" "$DATA_DIR/uploads" "$DATA_DIR/backups"
  # 配置由 install_callback 生成；缺失则拒绝启动（避免裸跑用开发默认值）
  if [ ! -f "$ENV_FILE" ]; then
    echo "Missing $ENV_FILE; reinstall the app to initialize config." > "$TRIM_TEMP_LOGFILE"
    exit 1
  fi
  rm -f "$SOCKET_PATH"
  cd "$APP_DIR" || exit 1
  # shellcheck disable=SC1090
  set -a; source "$ENV_FILE"; set +a
  export GX_SOCKET_PATH="$SOCKET_PATH"
  export GX_BASE_PATH="/app/gouxiangdb"
  export GX_WEB_DIST="$APP_DIR/public"
  export GX_DATA_DIR="$DATA_DIR"
  export UPLOAD_ROOT="$DATA_DIR/uploads"
  export BACKUP_DIR="$DATA_DIR/backups"
  export GX_AUDIT_DIR="${TRIM_PKGVAR}/log"
  export GX_MIGRATIONS_DIR="$APP_DIR/prisma/migrations"
  node dist/index.js >> "$LOG_FILE" 2>&1 &
  echo "$!" > "$PID_FILE"
}

stop_app() {
  [ -f "$PID_FILE" ] || { rm -f "$SOCKET_PATH"; exit 0; }
  local pid; pid="$(head -n1 "$PID_FILE" | tr -d '[:space:]')"
  if [ -n "$pid" ] && alive "$pid"; then
    kill -TERM "$pid" 2>/dev/null || true
    local i=0
    while alive "$pid" && [ $i -lt 10 ]; do sleep 1; i=$((i+1)); done
    alive "$pid" && kill -KILL "$pid" 2>/dev/null || true
  fi
  rm -f "$PID_FILE" "$SOCKET_PATH"
}

case "$1" in
  start)  start_app ;;
  stop)   stop_app ;;
  status) status_app ;;
  *) echo "Unknown command: $1" > "$TRIM_TEMP_LOGFILE"; exit 1 ;;
esac
```

退出码遵循框架：`status` 运行返回 0、未运行返回 3；其它命令失败返回 1。

### 4.2 `cmd/install_callback`（首装初始化：配置 + 密钥 + 迁移）

> 放在 `install_callback`（文件落地后），此时 `TRIM_DATA_SHARE_PATHS`/`TRIM_PKGETC` 已就绪；**不要放 `install_init`**。

```bash
#!/bin/bash
set -euo pipefail
export PATH=/var/apps/nodejs_v22/target/bin:$PATH

APP_DIR="${TRIM_APPDEST}/server"
DATA_DIR="${TRIM_DATA_SHARE_PATHS%%:*}"
ENV_FILE="${TRIM_PKGETC}/gouxiangdb.env"
mkdir -p "$DATA_DIR/uploads" "$DATA_DIR/backups" "${TRIM_PKGVAR}/log"

# 1) 生成持久配置（幂等：已存在则保留，不覆盖既有密钥/配置）
if [ ! -f "$ENV_FILE" ]; then
  JWT_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")"
  # 向导字段 external_origin（用户填的 NAS 访问地址，如 https://192.168.1.10:5666）
  # 同源经网关访问时浏览器仍可能在 POST 带 Origin，故 CORS 需包含该来源。
  CORS_ORIGIN="${external_origin:-*}"
  umask 077
  cat > "$ENV_FILE" <<EOF
NODE_ENV=production
JWT_SECRET=${JWT_SECRET}
DATABASE_URL=file:${DATA_DIR}/app.db
CORS_ORIGIN=${CORS_ORIGIN}
PORT=3001
GX_MIN_DISK_MB=1024
EOF
fi

# 2) 数据库迁移（只允许 migrate deploy，只增）
cd "$APP_DIR"
# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a
node node_modules/prisma/build/index.js migrate deploy --schema=prisma/schema.prisma \
  || { echo "prisma migrate deploy failed on install" > "$TRIM_TEMP_LOGFILE"; exit 1; }
```

要点：

- `JWT_SECRET` 首装随机生成、落 `TRIM_PKGETC`（0600），**升级绝不重生成**（否则所有登录态失效）。
- `DATABASE_URL` 指向 data-share，绝对路径，满足生产闸门（`file:`+绝对路径）。
- `CORS_ORIGIN` 取自安装向导 `external_origin`（见 4.5）。同源 iframe 的写请求浏览器仍会带 `Origin`，必须把 NAS 实际访问来源加入白名单；`*` 仅作缺省占位，正式使用应填具体来源（注意白名单不支持裸 `*` 跨带凭证，故向导必填更稳）。

### 4.3 `cmd/upgrade_callback`（升级：先快照再迁移）

```bash
#!/bin/bash
set -euo pipefail
export PATH=/var/apps/nodejs_v22/target/bin:$PATH
APP_DIR="${TRIM_APPDEST}/server"
ENV_FILE="${TRIM_PKGETC}/gouxiangdb.env"
# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a
cd "$APP_DIR"

# 升级前做一次本地在线一致性快照（零额外二进制；失败中止升级，保护数据）
node scripts/backup/online-backup.mjs \
  || { echo "pre-upgrade online backup failed; aborting upgrade" > "$TRIM_TEMP_LOGFILE"; exit 1; }

# 只增迁移；已应用自动跳过
node node_modules/prisma/build/index.js migrate deploy --schema=prisma/schema.prisma \
  || { echo "prisma migrate deploy failed on upgrade" > "$TRIM_TEMP_LOGFILE"; exit 1; }
```

> 应用文件（`target/server`）由框架在 init→callback 之间替换；`TRIM_PKGETC` 配置与 data-share 数据保留。新版若改了 `CORS_ORIGIN` 等需求，在脚本中做**幂等补齐**而不是覆盖。回应不回数据，迁移不可逆，故先快照。

### 4.4 `cmd/uninstall_callback`（默认保留数据）

```bash
#!/bin/bash
set -euo pipefail
# 默认只清理运行态（socket/pid），数据库/上传/备份位于 data-share，保留供用户备份/重装。
rm -f "${TRIM_APPDEST}/app.sock" "${TRIM_PKGVAR}/app.pid"
exit 0
```

如需"卸载时询问是否删除数据"，在 `wizard/uninstall` 收集选择后据此脚本条件清理 data-share（默认仍建议保留）。

### 4.5 `wizard/install`（可选：收集外部访问来源）

收集 `external_origin`（文本，如 `https://192.168.1.10:5666` 或 `https://nas.example.com`），向导变量无 `TRIM_` 前缀，安装时以同名环境变量进入 `install_callback`。具体字段 JSON 结构以飞牛「配置向导弹」文档为准；最小可用版本也可省略向导，安装后由用户在 `TRIM_PKGETC/gouxiangdb.env` 手改 `CORS_ORIGIN` 再在应用中心重启。

---

## 5. `TRIM_*` → GouXiangDB 环境变量映射

| GouXiangDB 变量 | 飞牛原生取值 | 说明 |
| --- | --- | --- |
| `NODE_ENV` | `production` | 启用生产启动闸门 |
| `JWT_SECRET` | install_callback 随机生成，落 `TRIM_PKGETC/gouxiangdb.env` | ≥16，升级保留 |
| `DATABASE_URL` | `file:${TRIM_DATA_SHARE_PATHS%%:*}/app.db` | 数据共享目录，绝对路径 |
| `GX_DATA_DIR` | 同上 data-share 根 | |
| `UPLOAD_ROOT` | `$DATA_DIR/uploads` | 附件 |
| `BACKUP_DIR` | `$DATA_DIR/backups` | 本地快照 |
| `GX_AUDIT_DIR` | `${TRIM_PKGVAR}/log` | 审计日志 |
| `GX_MIGRATIONS_DIR` | `${TRIM_APPDEST}/server/prisma/migrations` | readyz migrations 探针 |
| `GX_SOCKET_PATH` | `${TRIM_APPDEST}/app.sock` | **网关 socket** |
| `GX_BASE_PATH` | `/app/gouxiangdb` | 网关前缀 |
| `GX_WEB_DIST` | `${TRIM_APPDEST}/server/public` | 托管前端 |
| `CORS_ORIGIN` | 向导 `external_origin` | NAS 实际访问来源 |
| `PORT` | 3001（socket 模式不实际监听，占位） | |
| `GX_MIN_DISK_MB` | 1024（小盘可调） | disk 探针 |

> 异地加密备份四变量（`BACKUP_ENCRYPT_OFFSITE`/`AGE_RECIPIENT`/`AGE_BIN`/`GX_OFFSITE_TARGET`）**一律不设置/保持注释**，与 92d0a34 决策一致：默认仅本地快照。

---

## 6. 构建步骤

### 6.1 安装 fnpack（构建机）

从飞牛开发者站点下载对应构建机的 `fnpack-1.2.3-<os>-<arch>`，例如 Linux x86：

```bash
chmod +x fnpack-1.2.3-linux-amd64
sudo mv fnpack-1.2.3-linux-amd64 /usr/local/bin/fnpack
fnpack --help
```

### 6.2 组装 + 打包（由 `deploy/fnos/build-fpk.mjs` 完成）

脚本职责（等价裸机 `deploy/bin/package-release.mjs` 的白名单组装，再加飞牛外壳）：

1. `pnpm --filter @gx/api run build`（esbuild）、`VITE_BASE_PATH=/app/gouxiangdb pnpm --filter @gx/web run build`（**子路径前端**）。
2. 白名单组装 `deploy/fnos/gouxiangdb/app/server/`：拷 `dist`、`prisma/{schema,migrations}`、`scripts/backup`、web `dist`→`public`、生成精简 `package.json`（去掉 `@gx/*`，把 prisma CLI 入运行时依赖）。
3. 在 `app/server` 内 `pnpm install --prod --ignore-workspace` 装**目标 Linux 架构**原生依赖 + `prisma generate`（架构控制见 6.3）。
4. 兜底扫描禁带物（`.env`、`*.db*`、`*.log`、`.workbuddy`），命中即失败。
5. 按目标架构写 `manifest.platform`（`x86`/`arm`），调 `fnpack build --directory deploy/fnos/gouxiangdb`，产出 `gouxiangdb-<ver>-<arch>.fpk`。

一键命令（脚本参数化架构）：

```bash
# 在与目标同架构的 Linux 机/容器内
node deploy/fnos/build-fpk.mjs --arch x86     # 产 gouxiangdb-0.1.0-x86.fpk
node deploy/fnos/build-fpk.mjs --arch arm     # 产 gouxiangdb-0.1.0-arm.fpk
```

### 6.3 按架构构建（关键）

- **最稳**：分别在 x86 Linux 与 arm64 Linux（飞牛 arm 设备/Debian arm 虚拟机/Docker）上运行 6.2，`pnpm install` 与 `prisma generate` 自然取对架构的 better-sqlite3 prebuild 与 query engine。
- **单机构建多架构**：用 Docker buildx/QEMU 在目标架构容器内执行组装步骤（`--platform linux/amd64` 与 `linux/arm64` 各跑一遍），不要在宿主直接装原生模块后跨架构复制。
- 构建后自检 `app/server/node_modules` 内存在目标架构的 better-sqlite3 `*.node` 与 Prisma `libquery_engine-*.so.node`（`linux-arm64` / `linux-debian-openssl-*` 对应命名）。

---

## 7. 安装、启动、升级、卸载

### 7.1 安装（两种）

- **应用中心手动安装（本地测试/单台）**：打开飞牛应用中心 → 手动安装本地 `.fpk` → 选安装存储空间 → （有向导则填 `external_origin`）→ 完成。框架顺序：`install_init` → 落应用文件 → `install_callback`（生成 env + `migrate deploy` + nav-reconcile + **创建超级管理员**）。
- **设备命令行**：

  ```bash
  appcenter-cli install-fpk gouxiangdb-0.1.0-x86.fpk
  # 带向导/配置：appcenter-cli install-fpk gouxiangdb-0.1.0-x86.fpk --env config.env
  ```

- **（可选，推荐）预置初始管理员凭据**：`install_callback` 只在 `GX_INIT_ADMIN_EMAIL` 与 `GX_INIT_ADMIN_PASSWORD` **两个都非空**时创建超级管理员，两者读自 `${TRIM_PKGETC}/gouxiangdb.env`（首装由 `install_callback` 生成，可事后编辑并在应用中心重启补跑）。任一为空则跳过——**不阻断安装**，首个通过 `/api/auth/signup` 注册的用户会自动成为所有者。凭据只在 `install_callback`（首次安装）里被消费，`upgrade_callback`（升级）不做初始化。初始化完成后建议把这三行从 env 删除（脚本幂等，删了不会重复创建）。详见 [`first-admin-init.md`](./first-admin-init.md)。

### 7.2 启动 / 停止 / 状态

由应用中心调用 `cmd/main start|stop|status`；也可看 `status` 退出码（运行 0 / 停止 3）。

### 7.3 升级

应用中心更新新版 fpk：框架可能先停应用 → `upgrade_init` → 替换应用文件 → `upgrade_callback`（在线快照 + `migrate deploy`）→ 重启。配置（`TRIM_PKGETC`）与数据（data-share）保留。

### 7.4 卸载

应用中心卸载；默认 `uninstall_callback` 仅清 socket/pid，**保留 data-share 数据**（便于备份/重装恢复）。确认要彻底清除时，再手动删除数据共享目录 `gouxiangdb/data`。

---

## 8. 部署验证（在飞牛设备上逐项打勾）

1. **安装**：应用中心无报错；`TRIM_PKGETC/gouxiangdb.env` 已生成（含随机 `JWT_SECRET`、绝对路径 `DATABASE_URL`）。
2. **迁移**：data-share 出现 `app.db`；`app.db` 内表为最新迁移（可对比 `_prisma_migrations` 表）。
3. **状态**：应用中心显示"运行中"（`cmd/main status`=0）；`${TRIM_APPDEST}/app.sock` 存在，`${TRIM_PKGVAR}/app.pid` 指向活进程。
4. **桌面卡片**：点开卡片进入 `/app/gouxiangdb/`，页面加载（子路径静态资源 200，无 404 白屏）。
5. **接口经网关**：在页面注册/登录、建 base、建表、增删记录、传头像成功（验证 `/app/gouxiangdb/api/*` 与子路径资源）。
6. **健康探针**：经网关访问 `/app/gouxiangdb/healthz` 200；`/app/gouxiangdb/readyz` 200 且 `status:"ready"`（五探针全 true）。
7. **持久化**：重启应用/重启 NAS 后数据仍在；附件仍可访问。
8. **多用户隔离头**：不同 fnOS 用户经网关，应用收到各自的 `X-Trim-Userid`（应用层账号体系独立，此头可用于审计/未来映射）。
9. **升级演练**：装旧版→造数据→升级新版，确认快照生成、迁移只增、数据无损。
10. **卸载演练**：卸载后 data-share 数据仍在（默认保留策略生效）。
11. **初始超级管理员**（仅配置了凭据时）：`install_callback` 输出「创建初始超级管理员：\<email\>」；用该账号经网关 `POST /app/gouxiangdb/api/auth/login` 登录返回 200 且 `user.mustChangePassword` 为 `true`；审计 `${TRIM_PKGVAR}/log/audit.logl` 有 `"event":"admin_initialized"`。未配置凭据时应看到「未配置初始管理员凭据，跳过自动初始化」且安装仍成功（首个注册用户自动成为所有者）。

---

## 9. 常见问题排查

| 症状 | 排查点 |
| --- | --- |
| 安装阶段失败 | 看 `$TRIM_TEMP_LOGFILE` 与 `install_callback`；多为 data-share 未就绪（误放到 install_init）、`prisma generate`/migrate 架构不符、Node PATH 未加 |
| 应用中心一直"未运行" | `cmd/main status` 是否 0；`$TRIM_PKGVAR/app.log`；配置缺失会写 `$TRIM_TEMP_LOGFILE`；`app.sock` 是否被旧实例残留（start 已 `rm -f`，仍异常查权限） |
| 卡片白屏 / 资源 404 | 前端不是用 `VITE_BASE_PATH=/app/gouxiangdb` 构建；或 `GX_WEB_DIST` 未指向 `server/public`；浏览器 Network 看资源是否在 `/app/gouxiangdb/assets/` |
| 页面开但登录/写请求失败（CORS） | `CORS_ORIGIN` 没包含 NAS 实际来源（含协议/端口）；同源 POST 仍带 `Origin`。改 `TRIM_PKGETC/gouxiangdb.env` 后在应用中心重启 |
| 接口 404 | 后端未设 `GX_BASE_PATH=/app/gouxiangdb`（只挂了根 `/api`）；或 `ui/config` 的 `gatewayPrefix` 与之一致性 |
| 启动即退出码 2 | 生产闸门：`JWT_SECRET` 太短/为内置默认值、`DATABASE_URL` 非绝对路径、`CORS_ORIGIN` 空 |
| `Illegal instruction` / 原生模块加载失败 | fpk 架构装错（x86 包装到 arm 或反之），或 `node_modules` 是在 macOS 上装的；按 §6.3 在目标 Linux 架构重建 |
| `database is locked` | 确认只有一个应用实例在写同一 `app.db`；备份/迁移窗口并发；WAL+busy_timeout 已内置（5000ms） |
| readyz `migrations` 失败 | `GX_MIGRATIONS_DIR` 指错或没跑 `migrate deploy`；手动 source env 后执行迁移命令 |
| 上传失败/503 disk | data-share 目录权限或空间不足；看 `GX_MIN_DISK_MB` 与实际剩余 |
| 升级后无法登录 | `JWT_SECRET` 被升级脚本重生成（不应发生）；确认 upgrade_callback 不覆盖 env |

---

## 10. 与其它方案的边界

- 飞牛原生**不暴露独立端口、不需要用户装 Node/反代、TLS 与登录态由统一网关负责**，体验最整合；但只能运行在 fnOS，且需按 x86/arm 出两份包。
- 若希望同一套镜像也能在非飞牛环境跑，或团队更熟 Compose，选 **Docker**（见 [`docker.md`](./docker.md)）。飞牛上也**可选**用 `docker-project` 资源把同一镜像打包成 fpk（见 docker.md 附录），但那是容器形态、不走本文的 socket 原生形态。
- 开发/调试用 **macOS 直装**（见 [`macos-dev.md`](./macos-dev.md)）。
