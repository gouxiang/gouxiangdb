# 飞牛 fnOS 原生应用部署（.fpk）

> ⚠️ **现状更新（2026-10-22 最近核对；0.2.6 沿用，机制自 0.2.5 起）**：本文第 0 节等早期段落
> 曾保留 socket/CGI 时代的初版设计叙述，**现行实现为「独立 TCP 端口 + 跨源 iframe」**，要点如下，
> 一切以 `deploy/fnos/gouxiangdb/` 实际文件与 `deploy/fnos/build-fpk.mjs` 的打包自检为权威：
> - 应用监听自己的 TCP 端口，**默认 9527**（`manifest.service_port`、向导 `wizard_port`、
>   env `PORT`），页面与 API 同源在 `http://NAS:端口`，**不用**统一网关 socket、**不用** CGI；
> - `app/ui/config` 为 `"type":"iframe"`、`"protocol":"http"`、`"port":"${wizard_port}"`、
>   `"url":"/"`；
> - 向导有三个：`wizard/install`、**`wizard/upgrade`（升级路径必需，缺失会致桌面白屏与
>   `${wizard_port}` 字面量显示）**、`wizard/config`，均收集 `wizard_port`；
> - 桌面入口图标必须用**连字符** `images/icon-{0}.png`（磁盘文件 `icon-64.png`/`icon-256.png`）；
>   开发者文档示例的下划线命名在实测固件上取不到图、回退系统兜底旧图标。

> 目标：把 GouXiangDB 打包成飞牛 fnOS 官方应用，用户在**应用中心**一键安装/启停、从**桌面卡片**打开；后端进程由 fnOS 应用框架托管，以**独立 TCP 端口（默认 9527）**单进程在根路径同时提供 API 与 Web 静态资源，桌面门户以跨源 iframe 嵌入（0.2.6 沿用，机制自 0.2.5 起）。
> 规范来源：飞牛 fnOS 开发者文档（`fnnas-docs` 技能：Native 应用案例、Manifest、环境变量、运行时、应用框架、fnpack CLI）。字段语义以该文档为参考；凡文档与真机实测冲突处（如入口图标连字符命名、升级向导机制），以真机实测与 `build-fpk.mjs` 自检为准。

---

## 0. 为什么不能"直接把裸机包丢进去"

裸机/API 形态与飞牛原生形态有四个差异，本方案逐一处理：

| # | 现状（裸机/API 形态） | 飞牛原生形态（0.2.6 现行） | 适配 |
| --- | --- | --- | --- |
| 1 | 裸机默认监听 TCP 3001 | 应用监听 **`0.0.0.0` 的独立 TCP 端口**（env `PORT`，向导 `wizard_port`，默认 **9527**），**不用** Unix socket | `cmd/main` 导出 `PORT="${PORT:-9527}"` 且**不设** `GX_SOCKET_PATH`（不设即走 TCP 分支），后端默认绑 `0.0.0.0` |
| 2 | API 只挂 `/api`，Web 由外部 Caddy 托管 | **单进程在同一端口、根路径**同时提供页面与 API（页面/接口同源在 `http://NAS:端口`） | `cmd/main` 设 `GX_WEB_DIST`（同进程托管 `public/` + SPA 回退），并 **`unset GX_BASE_PATH`**（根部署，误设前缀会多期望一层路径而 404） |
| 3 | Vite `base=/`，前端请求写死同源根 `/api` | 页面资源在根 `/assets/...`、接口在同源根 `/api/...` | 前端按 **`VITE_BASE_PATH=/`** 根路径构建（`build-fpk.mjs` 已内置），无需子路径 |
| 4 | better-sqlite3 `.node` + Prisma query engine 是**架构相关二进制** | `manifest.platform=all` 仅适用于"不含架构二进制"的包 | **必须按 `x86` / `arm` 分别构建两份 fpk**，不能 `all` |

> 上述 #1/#2/#3 即现行飞牛交付形态：**独立 TCP 端口（默认 9527）+ 根路径同进程托管 + 桌面门户跨源 iframe**。
> `GX_SOCKET_PATH` 与 `GX_BASE_PATH` 是 **0.2.4 及以前「统一网关 socket + `/app/gouxiangdb` 子路径」旧形态的遗留适配变量**，
> 代码里的 socket 适配仍在，但当前飞牛部署物**不消费**（无生产调用方）；`cmd/main` 还会主动 `unset GX_BASE_PATH`、stop 时仅为兼容清理一次旧 `app.sock` 残留。

---

## 1. 前置条件

### 1.1 构建机

| 项 | 要求 |
| --- | --- |
| 操作系统 | Linux（推荐与目标 NAS 同架构 / 用目标架构机或容器构建）；macOS 可打"纯 JS 组装"但**无法可靠选取 Linux 原生模块**，跨架构请在 Linux + Docker/QEMU 中构建 |
| Node.js | **必须 v22**（与飞牛 `nodejs_v22` 大版本一致；Node 20 加载 better-sqlite3@13 会直接 SIGSEGV，开发机同理，见总览 §2.4） |
| pnpm | 9.x（`corepack enable && corepack prepare pnpm@9.0.0 --activate`） |
| fnpack CLI | 1.2.3（按构建机系统下载，见 §6） |
| 网络 | 可访问 npm registry（安装生产依赖、`prisma generate` 拉对应架构引擎） |
| 源码 | GouXiangDB monorepo（含 `deploy/fnos/` 打包骨架） |

> **架构铁律**：fpk 内 `node_modules` 必须是 **Linux + 目标架构**（glibc）。在 Apple Silicon Mac 上直接 `pnpm install --prod` 得到的是 darwin/arm64 的 better-sqlite3，塞进飞牛（Linux）必崩。稳妥做法见 §6.3「按架构构建」。

### 1.2 目标设备

| 项 | 要求 |
| --- | --- |
| 系统 | 飞牛 fnOS，国内版 **≥ 1.1.3100**（对应 `os_min_version`）；基础内核 Debian 系 |
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
│   │   ├── main                   # start/stop/status（PID + 独立 TCP 端口生命周期）
│   │   ├── install_callback       # 首装：写配置/密钥 + migrate deploy + nav-reconcile + 可选 init-admin
│   │   ├── upgrade_callback       # 升级：定点回写 PORT + 在线快照 + migrate deploy + nav-reconcile（只增）
│   │   └── uninstall_callback     # 卸载：默认保留用户数据，仅清理 pid/旧 socket 残留
│   ├── wizard/
│   │   ├── install                # 首装收集 wizard_port（默认 9527）
│   │   ├── upgrade                # 升级收集 wizard_port（升级路径必需）
│   │   └── config                 # 应用设置改端口
│   ├── app/
│   │   ├── ui/
│   │   │   ├── config             # 桌面卡片（iframe 跨源嵌入独立端口）
│   │   │   └── images/            # icon-64.png / icon-256.png（连字符，另保留下划线副本兼容）
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

> **版本不用手改**：`version` 与 `platform` 两行由 `deploy/fnos/build-fpk.mjs` 从**根 `package.json` 的 `version`**
> 统一重写（脚本内注释原话：「version 必须和 platform 一样由 rootPkg 统一重写，不能留在 manifest 里手改」）。
> 下文示例写 `0.2.6` 只是当前值示意；发新版本时**改根 `package.json` 即可**，不要手编 manifest。

```ini
appname=gouxiangdb
version=0.2.6
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
service_port=9527
checkport=false
ctl_stop=true
```

要点（对齐 Manifest 文档与真机实测）：

- **`platform=x86`（arm 设备构建时改为 `arm`）——绝不使用 `all`**：包含 better-sqlite3/Prisma 架构二进制。两份 fpk 仅该字段与内置 `node_modules` 架构不同。
- **写 `service_port=9527` 仅声明默认端口，`checkport=false`**：实际端口由安装/配置向导 `wizard_port` 收集并写入 env。静态 `checkport` 只认这里声明的 9527，对用户自定义端口会误判，故关闭；端口占用由后端 `listen` 的 `EADDRINUSE` 兜底报错。
- `install_dep_apps=nodejs_v22`：框架自动装 Node 22 运行时，PATH 在 `/var/apps/nodejs_v22/target/bin`。**Node 必须 v22**（better-sqlite3@13 为 NAPI v10，Node 20 加载直接 SIGSEGV）。
- `os_min_version=1.1.3100`：国内版下限。
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

### 3.4 `app/ui/config`（桌面卡片：跨源 iframe 嵌入独立端口）【0.2.6 沿用，机制自 0.2.5 起】

```json
{
  ".url": {
    "gouxiangdb.main": {
      "title": "构想工作台",
      "icon": "images/icon-{0}.png",
      "type": "iframe",
      "protocol": "http",
      "port": "${wizard_port}",
      "url": "/",
      "allUsers": true
    }
  }
}
```

- **独立端口 + 跨源 iframe**（0.2.5 起）：应用在自己的 TCP 端口（向导 `wizard_port`，默认
  9527）提供服务，页面与 API 同源在 `http://NAS:端口`；桌面门户以 iframe 跨源嵌入。
  `${host}` 由系统运行时替换，`${wizard_port}` 必须由 install/upgrade/config 向导收集后替换；
  **升级路径只收集 `wizard/upgrade`**——缺该文件时 `${wizard_port}` 以字面量注册进
  `app_service`，桌面点开白屏、应用设置"访问端口"显示 `${wizard_port}`（2026-10-22 真机事故）。
- **不使用统一网关、不使用 CGI**：2026-09-18 实测统一网关注册被门户拦 `invalid token`；
  CGI 反代依赖 NAS 登录态、无法独立穿透，0.2.5 已移除 `index.cgi`。
- `manifest.service_port=9527` 仅声明默认端口；`checkport=false`（静态校验只认声明值，对用户
  自定义端口会误判），端口占用由后端 listen 的 EADDRINUSE 兜底。
- 应用自身鉴权不依赖门户头；Web 端令牌走 **`X-GX-Token`** 头（飞牛门户曾吞 `Authorization`），
  后端 `resolveActiveAuth` 两头收。

### 3.5 图标

桌面入口：`app/ui/images/icon-64.png`、`icon-256.png`（**连字符**，供 `{0}` 占位按尺寸选择；
真机实测该版固件的 serviceicon 路由只认连字符，下划线命名取不到文件、回退系统兜底旧图标，
开发者文档示例的下划线命名与真机不一致，以真机为准）。应用中心卡片：根目录 `ICON.PNG`、
`ICON_256.PNG`（fnpack 强制检查）。六处均由 `build-fpk.mjs` 与品牌单源
`branding/app-icon/png/` 做 md5 逐字节校验。

---

## 4. 生命周期脚本

> 公共约定：每个脚本开头 `export PATH=/var/apps/nodejs_v22/target/bin:$PATH`；失败前把**简短可执行**的中文/英文信息写入 `$TRIM_TEMP_LOGFILE` 并以非零退出；脚本尽量幂等。

### 4.1 `cmd/main`（start/stop/status）

```bash
#!/bin/bash
# GouXiangDB fnOS 生命周期：start/stop/status
# 独立 TCP 端口服务（PORT 来自持久配置 gouxiangdb.env，首装由向导 wizard_port
# 写入、默认 9527）；后端默认绑 0.0.0.0，浏览器可直接 http://NAS:端口 访问，
# 飞牛桌面门户以跨源 iframe 嵌入该端口。
set -uo pipefail
export PATH=/var/apps/nodejs_v22/target/bin:$PATH

APP_DIR="${TRIM_APPDEST}/server"
PID_FILE="${TRIM_PKGVAR}/app.pid"
LOG_FILE="${TRIM_PKGVAR}/app.log"
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
  cd "$APP_DIR" || { echo "server dir missing: $APP_DIR" > "$TRIM_TEMP_LOGFILE"; exit 1; }
  # shellcheck disable=SC1090
  set -a; source "$ENV_FILE"; set +a
  # 监听 TCP（不设 GX_SOCKET_PATH 即走 TCP 分支）：env 的 PORT 由 install_callback
  # 写入（向导 wizard_port，默认 9527），config_callback 可改；后端默认绑 0.0.0.0。
  export PORT="${PORT:-9527}"
  # 独立端口为根部署（页面与 API 同源在 http://NAS:端口），【不能】设 GX_BASE_PATH，
  # 否则路由会多期望一层前缀而 404。
  unset GX_BASE_PATH
  export GX_WEB_DIST="$APP_DIR/public"
  export GX_DATA_DIR="$DATA_DIR"
  export UPLOAD_ROOT="$DATA_DIR/uploads"
  export BACKUP_DIR="$DATA_DIR/backups"
  export GX_AUDIT_DIR="${TRIM_PKGVAR}/log"
  export GX_MIGRATIONS_DIR="$APP_DIR/prisma/migrations"
  # 应用更新机制的通道标识：node 进程读不到 TRIM_* 变量，须显式声明「我是飞牛 fpk 安装」。
  export GX_DEPLOY_CHANNEL="fnos-fpk"
  node dist/index.js >> "$LOG_FILE" 2>&1 &
  echo "$!" > "$PID_FILE"
}

stop_app() {
  if [ ! -f "$PID_FILE" ]; then exit 0; fi
  local pid; pid="$(head -n1 "$PID_FILE" | tr -d '[:space:]')"
  if [ -n "$pid" ] && alive "$pid"; then
    kill -TERM "$pid" 2>/dev/null || true
    local i=0
    while alive "$pid" && [ $i -lt 10 ]; do sleep 1; i=$((i+1)); done
    alive "$pid" && kill -KILL "$pid" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
  # 兼容：旧版本用统一网关 socket，卸载/升级后清一次残留
  rm -f "${TRIM_APPDEST}/app.sock"
}

case "$1" in
  start)  start_app ;;
  stop)   stop_app ;;
  status) status_app ;;
  *) echo "Unknown command: $1" > "$TRIM_TEMP_LOGFILE"; exit 1 ;;
esac
```

要点：

- **不设 `GX_SOCKET_PATH`**：缺省即走 TCP 分支，监听 env `PORT`（默认 9527），后端绑 `0.0.0.0`。
- **`unset GX_BASE_PATH`**：独立端口为根部署，页面与 API 同源在 `http://NAS:端口`；若残留前缀，路由多期望一层而 404。
- **`GX_DEPLOY_CHANNEL="fnos-fpk"`**：node 进程读不到 `TRIM_*` 变量，须由此显式标识部署通道（应用更新机制使用）。
- stop 里对 `${TRIM_APPDEST}/app.sock` 的清理仅为兼容旧版本 socket 残留，现行不使用 socket。

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

# 服务端口：来自安装向导字段 wizard_port（app/ui/config 的入口用 ${wizard_port} 引用同一值）。
# 向导只校验「纯数字」，范围（1024-65535）必须在脚本里二次校验；未提供时回退默认 9527。
APP_PORT="${wizard_port:-9527}"
if ! [[ "$APP_PORT" =~ ^[0-9]+$ ]] || [ "$APP_PORT" -lt 1024 ] || [ "$APP_PORT" -gt 65535 ]; then
  echo "服务端口非法：${wizard_port}（需为 1024-65535 之间的数字），请在安装向导中重新填写。" > "$TRIM_TEMP_LOGFILE"
  exit 1
fi

# 1) 生成持久配置（幂等：已存在则保留，不覆盖既有密钥/配置）
if [ ! -f "$ENV_FILE" ]; then
  JWT_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")"
  # 独立端口下浏览器与 API 同源（页面即 http://NAS:端口），CORS 保留默认占位即可：
  # 后端对同源/无 Origin 请求一律放行；向导不再收集 external_origin。
  CORS_ORIGIN="${external_origin:-http://localhost}"
  umask 077
  cat > "$ENV_FILE" <<EOF
NODE_ENV=production
JWT_SECRET=${JWT_SECRET}
DATABASE_URL=file:${DATA_DIR}/app.db
CORS_ORIGIN=${CORS_ORIGIN}
PORT=${APP_PORT}
GX_MIN_DISK_MB=1024
# 应用更新只读 Gitea 令牌；占位符由 build-fpk.mjs 在打包副本中替换，源模板不写死令牌。
GX_UPDATE_TOKEN=__GX_UPDATE_TOKEN__
EOF
fi

# 2) 数据库迁移（只允许 migrate deploy，只增）
cd "$APP_DIR"
# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a
node node_modules/prisma/build/index.js migrate deploy --schema=prisma/schema.prisma \
  || { echo "prisma migrate deploy failed on install" > "$TRIM_TEMP_LOGFILE"; exit 1; }

# 迁移只给根节点 path，迁移后必须全量重算非根节点 path/depth（失败 exit 1）
node dist/nav-reconcile.js --apply \
  || { echo "nav reconcile failed on install" > "$TRIM_TEMP_LOGFILE"; exit 1; }

# 3) 可选：创建初始超级管理员（两者都非空才跑；否则跳过、不阻断安装，
#    首个通过 /api/auth/signup 注册的用户自动成为所有者）
if [[ -n "${GX_INIT_ADMIN_EMAIL:-}" && -n "${GX_INIT_ADMIN_PASSWORD:-}" ]]; then
  node dist/init-admin.js || { echo "init-admin failed on install" > "$TRIM_TEMP_LOGFILE"; exit 1; }
else
  echo "未配置初始管理员凭据，跳过自动初始化（首个注册用户自动成为所有者）"
fi
```

要点：

- **端口二次校验**：向导只做 `^[0-9]+$` 纯数字校验，1024-65535 范围必须在 callback 脚本里再判一次，非法即 `exit 1` 拒绝安装。
- `JWT_SECRET` 首装随机生成、落 `TRIM_PKGETC`（0600），**升级绝不重生成**（否则所有登录态失效）。
- `DATABASE_URL` 指向 data-share，绝对路径，满足生产闸门（`file:`+绝对路径）。
- **`CORS_ORIGIN` 用 `http://localhost` 占位**：独立端口下页面与 API 同源，后端对同源/无 Origin 请求放行，向导**不再收集** `external_origin`。
- **迁移后必跑 `node dist/nav-reconcile.js --apply`**（失败 `exit 1`），全量重算导航节点 path/depth，防升级/首装后导航失效。
- **`init-admin` 仅在 `GX_INIT_ADMIN_EMAIL`/`GX_INIT_ADMIN_PASSWORD` 都非空时执行**，否则跳过且不阻断安装。
- `GX_UPDATE_TOKEN=__GX_UPDATE_TOKEN__` 为构建期占位符，由 `build-fpk.mjs` 在打包副本替换为真实只读令牌，源模板绝不写死。

### 4.3 `cmd/upgrade_callback`（升级：端口回写 → 快照 → 迁移 → nav-reconcile → 令牌轮换）

真实顺序（详见 `deploy/fnos/gouxiangdb/cmd/upgrade_callback`）：

1. **升级向导端口定点回写（在 `source env` 之前）**：`wizard/upgrade` 收集 `wizard_port`。
   - 未收集到（静默升级/无该字段）：保留现 env `PORT`，绝不强改老用户端口；
   - 收集到但非法（非纯数字或超出 1024-65535）：`exit 1` **拒绝升级**，端口与数据均不动；
   - 与现 `PORT` 相同：不动文件；不同：逐行重建 env 仅替换 `PORT=` 行 + 临时文件原子 `mv`，`JWT_SECRET`/`DATABASE_URL`/`GX_UPDATE_TOKEN` 等其它行逐字保留。
   - **升级路径只读 `wizard/upgrade`，不读 `wizard/install`**；缺 `wizard/upgrade` 时 `${wizard_port}` 会以字面量注册进桌面入口，点开白屏、应用设置显示 `${wizard_port}`（2026-10-22 真机事故）。
2. `source` 持久 env 后 `cd "$APP_DIR"`，先做升级前**本地在线一致性快照** `node scripts/backup/online-backup.mjs`（存在才跑；失败 `exit 1` 中止升级，保护数据）。
3. **只增迁移** `prisma migrate deploy`（失败 `exit 1`）。
4. **`node dist/nav-reconcile.js --apply`**（失败 `exit 1`，fpk 升级中止、旧版应用不被切换）。
5. **`GX_UPDATE_TOKEN` 定点轮换**：从新包自带的 `install_callback` 模板提取新令牌（脚本按**自身同目录**定位 `install_callback`，再回退两种历史布局）；模板仍是占位符 `__GX_UPDATE_TOKEN__` 或为空则跳过；与现值相同则不动；不同则逐行重建 + 原子 `mv`，只改这一行。

> 应用文件（`target/server`）由框架在 init→callback 之间替换；`TRIM_PKGETC` 配置与 data-share 数据保留。回应不回数据，迁移不可逆，故先快照。

### 4.4 `cmd/uninstall_callback`（默认保留数据）

```bash
#!/bin/bash
set -euo pipefail
# 默认只清理运行态（pid；并兼容清理旧版 app.sock 残留），数据库/上传/备份位于 data-share，保留供用户备份/重装。
rm -f "${TRIM_APPDEST}/app.sock" "${TRIM_PKGVAR}/app.pid"
exit 0
```

如需"卸载时询问是否删除数据"，在 `wizard/uninstall` 收集选择后据此脚本条件清理 data-share（默认仍建议保留）。

### 4.5 向导（`wizard/install` / `wizard/upgrade` / `wizard/config`）【0.2.6 沿用，机制自 0.2.5 起】

三个向导同构，均收集 `wizard_port`（文本，默认 **9527**，纯数字；范围 1024-65535 在
install/upgrade/config 三个 callback 里二次校验）。向导变量无 `TRIM_` 前缀，提交时以同名环境
变量进入对应 callback，定点回写 `TRIM_PKGETC/gouxiangdb.env` 的 `PORT` 行（其它行逐字保留）。

- `install`：首装收集端口写入 env；
- `upgrade`：**升级路径只收 `wizard/upgrade`（不读 install）**，必须存在；未收集到值时
  upgrade_callback 保留现端口不强改；
- `config`：应用设置改端口，回写后如系统未自动重启，停止再启动一次生效。

> 历史：早期方案曾在安装向导收集 `external_origin` 写 `CORS_ORIGIN`；独立端口同源部署后浏览器
> 与 API 同源，后端对同源/无 Origin 请求放行，该字段已不再需要。

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
| `GX_WEB_DIST` | `${TRIM_APPDEST}/server/public` | 同进程根路径托管前端 |
| `GX_DEPLOY_CHANNEL` | `fnos-fpk`（`cmd/main` 导出） | 标识飞牛 fpk 部署通道（应用更新机制使用） |
| `CORS_ORIGIN` | `http://localhost` 占位（首装写入，向导不再收集 `external_origin`） | 独立端口下页面与 API 同源，后端对同源/无 Origin 放行，默认占位即可 |
| `PORT` | 向导 `wizard_port`，默认 **9527** | 应用实际监听的 TCP 端口（绑 `0.0.0.0`），桌面门户跨源 iframe 嵌入 |
| `GX_UPDATE_TOKEN` | `build-fpk.mjs` 构建期替换占位符写入；升级由 upgrade_callback 定点轮换 | 应用更新只读 Gitea 令牌 |
| `GX_MIN_DISK_MB` | 1024（小盘可调） | disk 探针 |

> `GX_SOCKET_PATH`（旧 `${TRIM_APPDEST}/app.sock`）与 `GX_BASE_PATH`（旧 `/app/gouxiangdb` 网关前缀）是 **0.2.4 及以前统一网关形态的遗留变量，当前飞牛部署物均不设置/不消费**：`cmd/main` 不设 `GX_SOCKET_PATH`（走 TCP 分支）并主动 `unset GX_BASE_PATH`（根部署）。代码中的 socket 适配仍保留但无生产调用方。

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

1. `pnpm --filter @gx/api run build`（esbuild）、`pnpm --filter @gx/web run build`（脚本内置 **`VITE_BASE_PATH=/`**，根路径前端：index.html 资源走 `/assets/...`、API 走同源 `/api/...`）。
2. 白名单组装 `deploy/fnos/gouxiangdb/app/server/`：拷 `dist`、`prisma/{schema,migrations}`、`scripts/backup`、web `dist`→`public`、生成精简 `package.json`（去掉 `@gx/*`，把 prisma CLI 入运行时依赖）。
3. 在 `app/server` 内 `pnpm install --prod --ignore-workspace` 装**目标 Linux 架构**原生依赖 + `prisma generate`（架构控制见 6.3）。
4. 兜底扫描禁带物（`.env`、`*.db*`、`*.log`、`.workbuddy`，命中即失败）；**入口一致性自检**：仍存在 `app/ui/index.cgi` 直接 fail（0.2.5 起 CGI 已删），并校验入口为 `type=iframe`/`protocol=http`/`port=${wizard_port}`/`url="/"`、无 `gatewayPrefix/gatewaySocket`、图标为连字符命名。
5. 按目标架构写 `manifest.platform`（`x86`/`arm`）、从根 `package.json` 重写 `manifest.version`，调 `fnpack build --directory deploy/fnos/gouxiangdb`，产出 `gouxiangdb-<ver>-<arch>.fpk`。

一键命令（脚本参数化架构）：

```bash
# 在与目标同架构的 Linux 机/容器内
node deploy/fnos/build-fpk.mjs --arch x86     # 产 gouxiangdb-0.2.6-x86.fpk
node deploy/fnos/build-fpk.mjs --arch arm     # 产 gouxiangdb-0.2.6-arm.fpk
```

> 令牌头口径：浏览器经飞牛门户 iframe 访问时走 **`X-GX-Token`** 头（门户转发链路会丢 `Authorization`）；MCP/PAT 等非浏览器链路走 `Authorization`，后端两头收。

### 6.3 按架构构建（关键）

- **最稳**：分别在 x86 Linux 与 arm64 Linux（飞牛 arm 设备/Debian arm 虚拟机/Docker）上运行 6.2，`pnpm install` 与 `prisma generate` 自然取对架构的 better-sqlite3 prebuild 与 query engine。
- **单机构建多架构**：用 Docker buildx/QEMU 在目标架构容器内执行组装步骤（`--platform linux/amd64` 与 `linux/arm64` 各跑一遍），不要在宿主直接装原生模块后跨架构复制。
- 构建后自检 `app/server/node_modules` 内存在目标架构的 better-sqlite3 `*.node` 与 Prisma `libquery_engine-*.so.node`（`linux-arm64` / `linux-debian-openssl-*` 对应命名）。

---

## 7. 安装、启动、升级、卸载

### 7.1 安装（两种）

- **应用中心手动安装（本地测试/单台）**：打开飞牛应用中心 → 手动安装本地 `.fpk` → 选安装存储空间 → 在安装向导填/确认**服务端口**（`wizard_port`，默认 9527，范围 1024-65535）→ 完成。框架顺序：`install_init` → 落应用文件 → `install_callback`（生成 env + `migrate deploy` + `nav-reconcile --apply` + 可选 `init-admin`）。
- **设备命令行**：

  ```bash
  appcenter-cli install-fpk gouxiangdb-0.2.6-x86.fpk
  # 带向导/配置：appcenter-cli install-fpk gouxiangdb-0.2.6-x86.fpk --env config.env
  ```

- **（可选，推荐）预置初始管理员凭据**：`install_callback` 只在 `GX_INIT_ADMIN_EMAIL` 与 `GX_INIT_ADMIN_PASSWORD` **两个都非空**时创建超级管理员，两者读自 `${TRIM_PKGETC}/gouxiangdb.env`（首装由 `install_callback` 生成，可事后编辑并在应用中心重启补跑）。任一为空则跳过——**不阻断安装**，首个通过 `/api/auth/signup` 注册的用户会自动成为所有者。凭据只在 `install_callback`（首次安装）里被消费，`upgrade_callback`（升级）不做初始化。初始化完成后建议把这三行从 env 删除（脚本幂等，删了不会重复创建）。详见 [`first-admin-init.md`](./first-admin-init.md)。

### 7.2 启动 / 停止 / 状态

由应用中心调用 `cmd/main start|stop|status`；也可看 `status` 退出码（运行 0 / 停止 3）。

### 7.3 升级

应用中心更新新版 fpk：升级向导（`wizard/upgrade`，**必须存在**）收集/确认 `wizard_port` → 框架可能先停应用 → `upgrade_init` → 替换应用文件 → `upgrade_callback`（定点回写 PORT → 在线快照 → `migrate deploy` → `nav-reconcile --apply` → 令牌轮换）→ 重启。配置（`TRIM_PKGETC`，含 `JWT_SECRET`）与数据（data-share）保留。

### 7.4 卸载

应用中心卸载；默认 `uninstall_callback` 仅清 pid（及兼容清理旧版 `app.sock` 残留），**保留 data-share 数据**（便于备份/重装恢复）。确认要彻底清除时，再手动删除数据共享目录 `gouxiangdb/data`。

---

## 8. 部署验证（在飞牛设备上逐项打勾）

1. **安装**：应用中心无报错；`TRIM_PKGETC/gouxiangdb.env` 已生成（含随机 `JWT_SECRET`、绝对路径 `DATABASE_URL`）。
2. **迁移**：data-share 出现 `app.db`；`app.db` 内表为最新迁移（可对比 `_prisma_migrations` 表）。
3. **状态/端口**：应用中心显示"运行中"（`cmd/main status`=0）；`${TRIM_PKGVAR}/app.pid` 指向活进程；`ss -ltnp`（或 `netstat`）可见进程监听配置的 TCP 端口（默认 **9527**，绑 `0.0.0.0`）。
4. **两个入口**：① 浏览器直连 `http://NAS:9527/`（或自定义端口）页面加载、根路径静态资源 200 无白屏；② 飞牛桌面点卡片，门户以跨源 iframe 嵌入同一地址，正常显示。
5. **接口（根路径同源）**：在页面注册/登录、建 base、建表、增删记录、传头像成功（验证根路径 `/api/*`，浏览器令牌走 `X-GX-Token` 头）。
6. **健康探针**：访问 `http://NAS:9527/healthz` 200；`http://NAS:9527/readyz` 200 且 `status:"ready"`（五探针 `dbPing/dbWritable/migrations/uploadsWritable/disk` 全 true）。
7. **持久化**：重启应用/重启 NAS 后数据仍在；附件仍可访问。
8. **升级向导完备性**：确认升级包含 `wizard/upgrade`；缺失时桌面入口会把 `${wizard_port}` 当字面量注册——卡片白屏、应用设置"访问端口"显示 `${wizard_port}`（见 §9）。
9. **升级演练**：装旧版→造数据→升级新版，确认向导端口被正确收集/回写、快照生成、迁移只增、nav-reconcile 成功、数据无损。
10. **卸载演练**：卸载后 data-share 数据仍在（默认保留策略生效）。
11. **初始超级管理员**（仅配置了凭据时）：`install_callback` 输出「创建初始超级管理员：\<email\>」；用该账号 `POST http://NAS:9527/api/auth/login` 登录返回 200 且 `user.mustChangePassword` 为 `true`；审计 `${TRIM_PKGVAR}/log/audit.logl` 有 `"event":"admin_initialized"`。未配置凭据时应看到「未配置初始管理员凭据，跳过自动初始化」且安装仍成功（首个注册用户自动成为所有者）。

---

## 9. 常见问题排查

| 症状 | 排查点 |
| --- | --- |
| 安装阶段失败 | 看 `$TRIM_TEMP_LOGFILE` 与 `install_callback`；多为 data-share 未就绪（误放到 install_init）、`prisma generate`/migrate 架构不符、Node PATH 未加 |
| 应用中心一直"未运行" | `cmd/main status` 是否 0；`$TRIM_PKGVAR/app.log`；配置缺失会写 `$TRIM_TEMP_LOGFILE`；端口（默认 9527）是否被占用导致后端 `EADDRINUSE`（`checkport=false`，占用由后端兜底报错） |
| 卡片白屏 / 入口显示 `${wizard_port}` 字面量 | **升级包缺 `wizard/upgrade`**（升级不读 `wizard/install`），`${wizard_port}` 没被收集替换、以字面量注册进桌面入口。补齐升级向导后重升 |
| 卡片白屏 / 资源 404 | 前端不是按 `VITE_BASE_PATH=/` 根路径构建；或 `GX_WEB_DIST` 未指向 `server/public`；浏览器 Network 看资源是否在根 `/assets/...`（误设 `GX_BASE_PATH` 前缀也会 404，`cmd/main` 已 `unset`） |
| 页面开但登录/写请求失败（CORS/令牌） | 独立端口同源默认放行；浏览器经门户 iframe 时令牌必须走 **`X-GX-Token`** 头（门户转发会丢 `Authorization`），MCP/PAT 才走 `Authorization`。改 `TRIM_PKGETC/gouxiangdb.env` 后在应用中心重启 |
| 接口 404 | 独立端口为**根路径**部署，接口在 `/api/*`；若 env 里残留 `GX_BASE_PATH`（旧网关前缀）会多期望一层路径而 404——`cmd/main` 已 `unset GX_BASE_PATH`，勿在 env 中设置 |
| 启动即退出码 2 | 生产闸门：`JWT_SECRET` 太短/为内置默认值、`DATABASE_URL` 非绝对路径、`CORS_ORIGIN` 空 |
| `Illegal instruction` / 原生模块加载失败 | fpk 架构装错（x86 包装到 arm 或反之），或 `node_modules` 是在 macOS 上装的；按 §6.3 在目标 Linux 架构重建 |
| `database is locked` | 确认只有一个应用实例在写同一 `app.db`；备份/迁移窗口并发；WAL+busy_timeout 已内置（5000ms） |
| readyz `migrations` 失败 | `GX_MIGRATIONS_DIR` 指错或没跑 `migrate deploy`；手动 source env 后执行迁移命令 |
| 上传失败/503 disk | data-share 目录权限或空间不足；看 `GX_MIN_DISK_MB` 与实际剩余 |
| 升级后无法登录 | `JWT_SECRET` 被升级脚本重生成（不应发生）；确认 upgrade_callback 不覆盖 env |

---

## 10. 与其它方案的边界

- 飞牛原生以**独立 TCP 端口（默认 9527，向导可改）+ 根路径 + 桌面门户跨源 iframe** 交付，不需要用户自装 Node/反代，应用中心一键启停、桌面卡片打开；浏览器也可直接 `http://NAS:端口` 访问。**TLS/外网暴露不由应用负责**，由用户自行对该端口做内网穿透/外网映射或反代。只能运行在 fnOS，且需按 x86/arm 出两份包。
- 若希望同一套镜像也能在非飞牛环境跑，或团队更熟 Compose，选 **Docker**（见 [`docker.md`](./docker.md)）。飞牛上也**可选**用 `docker-project` 资源把同一镜像打包成 fpk（见 docker.md 附录），但那是容器形态、不走本文的原生独立端口形态。
- 开发/调试用 **macOS 直装**（见 [`macos-dev.md`](./macos-dev.md)）。
