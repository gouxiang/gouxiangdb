# 门⑥ fpk 面真机复验（总监独立执行）

- 日期：2026-09-18
- 设备：**飞牛 fnOS 真机**（用户新开的虚拟机，授权"随便折腾"）
  - 访问：`192.168.31.183`，Web 管理端端口 **5666**，SSH 账号 `戴静`
  - 系统：fnOS **1.2.0604** / Debian GNU/Linux 12 (bookworm) / 内核 `6.18.18.c1032-trim` / **x86_64**
  - 资源：2 CPU / 3920 MiB / 系统盘 63G（可用 49G）；数据卷 `/vol1` = **btrfs** + `trimacl` 挂载选项，50G
- 预装 CLI：`/usr/local/bin/fnpack` **1.2.4**、`/usr/local/bin/appcenter-cli` **1.0.2**
- 结论：**fpk 面从【未实测】转为【已过】**，同时暴露并修掉 3 个真缺陷（此前 fpk 从未被真实安装过）

---

## 1. 打通过程（可复现的坑）

| 步骤 | 现象 | 解法 |
|---|---|---|
| SSH 登录 | `sshpass -p … 戴静@…` 报 `remote username contains invalid characters`（中文用户名） | 改用 **paramiko**（Python）登录成功 |
| `appcenter-cli` 直接跑 | `panic: ApplyPermission … dial unix /run/trim_app_cgi/rpcbroker: permission denied` | 必须 **sudo**（`sudo -S` 用同一密码有效） |
| 安装依赖应用 | `appcenter-cli install nodejs_v22` 下载到 90% 报 `Use --volume to specify` | `appcenter-cli default-volume 1` 后再装（装得 `nodejs_v22 22.18.0-1`） |
| x86 构建 | 飞牛机**没有 node/pnpm**，不能在真机上构建 | 在 x86 Linux VM（192.168.31.15，node v22.22.1）构建，fnpack 用官方 `fnpack-1.2.1-linux-amd64`（静态二进制） |
| 传包 | 中文用户名 scp 不可用 | 本机 scp 从 VM 取回 → paramiko **SFTP** PUT 到飞牛（sha256 全程一致） |

> `fnpack` 打包必须在**包目录内**执行（`cd <pkg> && fnpack build`）；用 `--directory` 从别处调用会报
> `Compress /tmp/fnpack.<ts>/app.tgz file error : lstat …/bin: no such file or directory`。
> 且 `fnpack build` 的输入必须是**未打包的项目目录**（含 `app/`），不能拿解包出来的 `app.tgz` 再打包。

---

## 2. 三个真缺陷（对照实验矩阵）

### 缺陷 1：cmd/ 缺 5 个生命周期脚本，fnpack 直接拒绝打包

```
Verifying files...
Packing failed. Required file "cmd/install_init" is missing
```
fnpack 要求 `cmd/` 下 **9 个脚本全部存在**。补齐 `install_init / uninstall_init / upgrade_init /
config_init / config_callback`（均 `exit 0`）——`*_init` 阶段飞牛官方明确 `TRIM_PKGETC` /
`TRIM_DATA_SHARE_PATHS` **不保证就绪**，在里面引用会误中止安装；真正初始化本就在
`install_callback`（生成 env + `prisma migrate deploy` + `nav reconcile`）。

### 缺陷 2：pnpm 默认布局的 fpk 在真机上**必定装不上**（code 10234）

安装报错（`/var/log/trim_app_center/error.log` 原文）：
```
install error appName=gouxiangdb error="10234:set app dir permissions failed:
installType=volume appname=gouxiangdb: acl_get_file failed"
```
现场特征：`app.tgz` 已解压到 `/vol1/appcenter-downloads/<name>-<ver>-tpk`（51–53M），
但 `/vol1/@appcenter/<name>` **始终建不出来** → 失败在"应用目录设 ACL"阶段。

同一台设备、同一个 fnpack 的对照实验：

| # | 包内容 | 规模 | 结果 |
|---|---|---|---|
| A | 官方模板空包 | 68K | ✅ 成功 |
| B | 模板 + 自定义 `privilege(username/groupname)` + `data-share` | 68K | ✅ 成功（排除 config 层） |
| C | 我们的最小 manifest（去掉 os_min_version/install_dep_apps/ctl_stop） | 53M | ❌ 10234 |
| D | 换名 `gouxiangdb2`（排除脏状态） | 53M | ❌ 10234 |
| E | 模板 + **仅我们的 dist** | 1.4M | ✅ 成功 |
| F | 模板 + **仅我们的 node_modules**（pnpm 默认布局） | 142M / 5373 条目（4161 文件 / 938 目录 / **274 符号链接**） | ❌ **10234 复现** |
| G | 模板 + 5000 个相对符号链接 | 108K | ✅ 成功（不是"链接多"本身） |
| H | 模板 + 指向**目录**的相对链接 | 68K | ✅ 成功 |
| I | 模板 + 指向**包外**的绝对链接 | 8K | ❌ 但报错不同：`refusing to create symlink outside destination` |
| J | 最长路径 180 字符 | — | 排除路径长度因素 |

结论：默认 pnpm 布局（`.pnpm/<pkg>@<ver>_<peer>/…` 深层目录 + 274 符号链接）会让飞牛的
应用目录 ACL 设置失败。**这不是包体量问题**（dist 1.4M 行、142M 不行；但同为 142M 的
hoisted 布局就行）。

修法：`pnpm install --prod --ignore-workspace --node-linker=hoisted`
→ 扁平真实目录（**0 符号链接**，`.bin` 里的 shim 也一并实体化），实测装上。
并在打包前把"零符号链接"做成**硬闸门**。

### 缺陷 3：build-fpk.mjs 两处假绿（会误导发布决策）

1. **fnpack 校验失败却仍以 0 退出** —— 打印 `Packing failed. …` 后 exit 0，`run()` 放行，
   脚本照常打印"fpk 已生成"，而磁盘上根本没有 .fpk。
   → 改为**以磁盘产物为准**（构建前后扫 `*.fpk`）；且必须先清掉旧同名产物，
   否则新包覆盖旧包导致差集为空、把"已产出"误判成"未产出"（这个二次坑是修完第一版才暴露的）。
2. **better-sqlite3 架构自检只判目录存在** —— hoisted 下二进制在 `prebuilds/linux-x64.node`，
   而 `build/Release` 是个**空目录**，`existsSync` 照样为 true。
   → 改为必须真的找到 `prebuilds/<platform>-<arch>.node` 或 `build/Release/*.node`。

---

## 3. 最终真机结果（`gouxiangdb 0.1.0`，状态 **running**）

安装命令：`sudo appcenter-cli install-fpk /tmp/gouxiangdb-hoisted.fpk --env /tmp/gx.env`
（`gx.env` 提供 `external_origin=http://192.168.31.183:5666`）

### 安装与初始化
- 应用列表：`gouxiangdb | 勾享数据库 | 0.1.0 | running | 依赖 nodejs_v22`
- `/vol1/@appconf/gouxiangdb/gouxiangdb.env` 生成正确：
  `DATABASE_URL=file:/vol1/@appshare/gouxiangdb/data/app.db`、`CORS_ORIGIN=http://192.168.31.183:5666`、
  `PORT=3001`、`GX_MIN_DISK_MB=1024`（JWT_SECRET 随机）
- **`install_callback` 真的跑通**：应用日志显示 `All migrations have been successfully applied`，
  随后 `dist/nav-reconcile.js --apply` 执行完成（`修复前 A=0 B=0 C=0 / 修复后 A=0 B=0 C=0 / no changes`）
- data-share 落地：`/vol1/@appshare/gouxiangdb/data/{app.db, uploads, backups}`

### 健康与运行时
```
GET /healthz → 200 {"status":"ok","service":"gouxiangdb-api","version":"0.1.0",...}
GET /readyz  → {"status":"ready","checks":{"dbPing":true,"dbWritable":true,"migrations":true,
                "uploadsWritable":true,"disk":true},
                "migration":{"applied":23,"latest":"20260918090000_mcp_pat_ddl"}}
```
（与门⑥ Docker 复验的 `applied=23 / latest=20260918090000_mcp_pat_ddl` **完全一致**）

原生件就位：`server/native/linux-x64/vec0.so`（159,816 B）、`better-sqlite3/prebuilds/linux-x64.node`。

### 业务链路（走 Unix socket `/var/apps/gouxiangdb/target/app.sock`）
| 步骤 | 结果 |
|---|---|
| `POST /api/auth/signup`（首用户自举 owner） | 200 |
| `POST /api/bases` | 201 |
| `POST /api/tables?baseId=` | 201 |
| `POST /api/records?tableId=`（写入 `fnos-hello`） | 201 |
| `GET /api/records?tableId=`（读回一致） | 200 |
| `POST /api/v1/pats` | 201，`token=gxpat_…` |
| `POST /mcp` `initialize`（用 PAT） | 200，`serverInfo=gouxiangdb-mcp 0.1.0`，`protocolVersion=2024-11-05` |
| `POST /mcp` `notifications/initialized` | 202 |
| `POST /mcp` `tools/list` | 200（含 `ping_echo` 等） |

> 注：MCP 用**登录 JWT** 会 401（设计如此，MCP 走 PAT）；不带
> `Accept: application/json, text/event-stream` 会 406（Streamable HTTP 协议要求）。

### 生命周期
`status=running → stop（socket 随之清理）→ status=stopped → start → status=running`，
重启后 `/healthz` 仍 200。

### 网关子路径
`http://192.168.31.183:5666/app/gouxiangdb/healthz` → **HTTP 200**（body 是飞牛自己的
`invalid token`，即路径**已注册**并进入门户鉴权，而非 404）。

---

## 3.1 补充：升级 / 卸载 / 重装与版本一致性（同日追加）

| 项 | 结果 |
|---|---|
| CLI 触发升级 | `appcenter-cli` **无 upgrade 子命令**；`install-fpk` 对已装同名应用只回 `Application [gouxiangdb] is installed.`（不升级）；`install-local` 实测会把应用**卸掉**（非升级路径） |
| 版本升级（0.1.0 → 0.1.1，手工改 manifest 后重装） | 版本变 0.1.1、running、healthz 200、readyz ready；**数据逐项零丢失**：`_prisma_migrations=23 / bases=1 / tables=2 / records=1 / users=3 / personal_access_tokens=2 / nav_nodes=5` 与升级前**完全一致** |
| **卸载保留数据**（`uninstall_callback` 语义） | 卸载成功；`/vol1/@appshare/gouxiangdb/data/app.db`（528,384 B）与 `/vol1/@appconf/gouxiangdb/gouxiangdb.env`（202 B）**均保留**（与"只清运行态、保留 data-share"的设计一致） |
| 重装复用数据 | 重装后 bases 1→2、users 3→4、records 1→2（差额为期间冒烟累积），**旧数据一条没丢** |

**顺带查出并修掉第 4 个缺陷（提交 `e4b10ee`）**：`build-fpk.mjs` 只重写 `manifest.platform`，
`version` 是 manifest 里的静态值 → 手工改 manifest 到 0.1.1 装上后，应用中心显示 0.1.1，
而 `/healthz` `/readyz` 仍报 `"version":"0.1.0"`（dist 内版本来自 `rootPkg.version`），
**两个版本各说各话**。已改为由 `rootPkg.version` 统一重写 `manifest.version`
（缺 version 行即 fail）。闭环：重建后 manifest.version=0.1.0 = /healthz version 0.1.0。

> 仍未覆盖：真正走 `upgrade_callback`（在线快照 + migrate deploy + nav reconcile）的
> **原地升级**没能触发（CLI 无升级入口，需应用中心 UI 或官方升级通道）。

---

## 4. 本次未覆盖（如实标注，不美化）

1. **带登录态的网关端到端 UI** —— 未取得飞牛门户 token（`/cgi/api/login` 一律返回 `invalid token`），
   故"桌面图标点开 → 看到 GouXiangDB 页面"这一段**未实测**；已验证的是网关前缀已注册 + 应用侧全通。
2. **fpk 原地升级的 `upgrade_callback`**（在线快照 + migrate deploy + nav reconcile）—— **未能触发**：CLI 无 upgrade 入口（`install-fpk` 对已装应用只回 "is installed"，`install-local` 实测会把应用卸掉）。已用"卸载→重装"替代路径验证数据零丢失（见 §3.1），但 `upgrade_callback` 自身仍未跑到。
3. **arm64 真机** —— 本次设备为 x86_64；`--arch arm` 仅经脚本守卫，无真机。
4. ~~卸载保留数据~~ —— **已补测并通过**（§3.1：卸载后 app.db 与 gouxiangdb.env 均保留）。
5. Caddy 真机反代、旧 Tauri 桌面 UI 手测 —— 门⑥ 其余格，仍【未实测】。

---

## 5. 落地产物

- 代码：提交 **`f98bb8f`**（cmd/ 补 5 个生命周期脚本 + `deploy/fnos/build-fpk.mjs` 三处修复）、**`e4b10ee`**（manifest.version 统一由 rootPkg 重写）
- 规范沉淀：`build-fpk.mjs` 内 `--node-linker=hoisted` 的**原因注释**与**零符号链接硬闸门**
  （下次再有人改回默认布局，构建阶段直接 FAIL，不会等到真机才发现装不上）
