# 裸机部署 Runbook（M0 S8）

面向一台干净的内网/公网 Linux 服务器，从零把 GouXiangDB 跑成 systemd 常驻服务，前置 Caddy 做 TLS 与反代。拓扑与约束见 [ADR-0003](../adr/0003-bare-metal-topology.md)。

> 验证边界：本 runbook 中**构建/打包/校验**步骤已在开发机（macOS arm64）实跑通过；
> **systemd 安装、Caddy 实跑、真实 Linux 部署/回滚**需要一台干净 Linux 机执行，
> 本机无法验证，标注为【需干净 Linux 机】。所有脚本均通过 `bash -n` 与负面路径自测。

## 1. 拓扑与硬约束

```
客户端 ──HTTPS(443)──> Caddy(同机) ──回环明文 127.0.0.1:3001──> gouxiangdb-api(systemd)
                                          SQLite + uploads 同在本机 /var/lib/gouxiangdb
```

- 单实例：不开 cluster、不部署副本；Caddy 与 Node 同机。
- Node 仅监听回环，外部靠主机防火墙禁止直连 3001。
- 迁移只由 `deploy.sh` 在“先快照后”显式 `prisma migrate deploy`，不挂开机/重启自动迁移。
- **M3 起**：迁移成功后、版本切换/服务接流量前，部署链路必须幂等执行一次 **nav path 重算**（见 §6.6），否则旧库升级后导航树深层缺节点、菜单快捷项全部失效。

## 2. 前置条件

- 目标机：Linux x86_64，建议 2 vCPU / 4GB，systemd；与构建机**同 OS/架构**（见 §10）。
- 构建机：Node >= 20、pnpm 9（`corepack enable && corepack prepare pnpm@9 --activate`）、可访问 npm registry（装生产依赖、拉 prisma engine）、tar/shasum。
- 目标机运行时：Node >= 20、Caddy 2.x；curl、bash >= 4（mapfile）。

## 3. 目标机初始化【需干净 Linux 机】

```bash
# 3.1 专用系统用户（不允许登录 shell）
sudo useradd --system --create-home --home-dir /var/lib/gouxiangdb --shell /usr/sbin/nologin gouxiangdb

# 3.2 标准目录与权限
sudo mkdir -p /srv/gouxiangdb/releases /var/lib/gouxiangdb/uploads \
              /var/backups/gouxiangdb /var/log/gouxiangdb /etc/gouxiangdb
sudo chown -R gouxiangdb:gouxiangdb /var/lib/gouxiangdb /var/backups/gouxiangdb /var/log/gouxiangdb
sudo chmod 750 /var/lib/gouxiangdb /var/backups/gouxiangdb
sudo chmod 750 /srv/gouxiangdb /srv/gouxiangdb/releases

# 3.3 Node 20（按发行版官方源安装；示例为 NodeSource，离线机用内部分发的 node 包）
#   安装后确认 /usr/bin/node 存在；若实际路径不同，部署时用 NODE_BIN=/path/node 覆盖。
node -v   # 期望 v20+

# 3.4 Caddy（按 https://caddyserver.com/docs/install 的发行版方式）
caddy version

# 3.5 防火墙：只放行 22/80/443，拒绝外部直连 API 端口
sudo ufw allow 22/tcp && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
sudo ufw deny 3001/tcp || true
sudo ufw --force enable
```

## 4. 生产环境变量（600）

```bash
sudo install -m 600 -o gouxiangdb -g gouxiangdb /dev/null /etc/gouxiangdb/env.conf
sudo -e /etc/gouxiangdb/env.conf      # 粘贴 deploy/env.conf.example 并逐项填值
```

必填：`JWT_SECRET`（`openssl rand -base64 32`）、`DATABASE_URL=file:/var/lib/gouxiangdb/app.db`、
`CORS_ORIGIN=https://你的域名`、`GX_DOMAIN`。缺任一项，生产启动闸门退出码 2（见 S3）。
env.conf 不入库、不进发布包；私钥（age identity）也不得放入。

## 5. 构建机打包与投递

```bash
# 构建机（仓库根）
node deploy/bin/package-release.mjs
# 产物：release/api、release/web、release/checksums.txt、
#       release/gouxiangdb-release-<version>-<ts>.tar.gz
cd release && shasum -a 256 -c checksums.txt      # 期望全部 OK
# 投递到目标机
scp release/gouxiangdb-release-*.tar.gz user@server:/tmp/
```

打包采用白名单组装并兜底扫描，发布包不含 `.env`、`*.db*`、`*.log`、`.workbuddy`、`uploads` 内容。

### 5.1 产物冒烟门（必过，构建后自动执行）

`package-release.mjs` 在 `pnpm install --prod` 之后、打 tar 之前，会在**精简生产 node_modules**
环境真跑一次产物（`node release/api/scripts/smoke-dist.mjs`）。它是为堵住「`pnpm build` 只打包
不执行，CJS 依赖被 esbuild 内化进 ESM 单文件后真机启动即崩」这类缺陷（`ws` 事件，真机 systemd
连炸 5 次才暴露）。两道检查：

1. 真跑 `dist/index.js`：脚本自建临时库 `migrate deploy` + 临时端口 + 临时数据目录（**不碰业务库、
   不绑 3001、离线**），轮询 `/readyz` 且断言 `status==="ready"` 与 `checks` 各项为 true；30s 预算。
2. 静态扫描全部 `dist/*.js`：不允许出现 esbuild 动态 require 垫片字面量 `Dynamic require of`
   （`init-admin` / `nav-reconcile` / `mcp-stdio` 不能真跑，这是它们的唯一手段；命中即硬失败）。

退出码：0 通过 / 1 冒烟失败（探针不 ready 或扫描命中）/ 2 进程崩溃。任一步非零都会终止打包。

真机手动复验（升级/部署 restart 前，建议先跑一遍）：

```bash
# 在解包后的发布目录（含 prod node_modules）内：
node /srv/gouxiangdb/current/api/scripts/smoke-dist.mjs && echo "SMOKE OK，可 restart"
# 脚本自带隔离与收尸，不会触碰当前在跑的服务或真实数据；exit 0 才允许 systemctl restart。
```

> 同样的门也接在 CI（`scripts/ci-quality.sh` 第 5 步 build 之后）、Docker（runner 阶段）、
> 飞牛 fpk（`build-fpk.mjs` hoisted 安装之后）；三处缺一门等于没有，真机 prod 环境那步最关键。

构建期网络依赖（2026-09 精简 prod 环境实测，证据 #487）：

- prod 安装用 `--ignore-scripts`，会跳过 `@prisma/engines` 的 postinstall，装完没有
  `node_modules/@prisma/engines/` 目录、也无 `migration-engine` 二进制。实测在此状态下
  `migrate deploy` 与冒烟门仍 exit 0——Prisma CLI 会在需要时自行取用引擎。
- 代价：**这一步依赖构建/打包机能出网取引擎**。离线构建（含 NAS 离线安装场景）有失败风险，
  须在离线前于同平台、可出网环境完成 `prisma generate` 并确认引擎就位，或预置 `@prisma/engines`；
  详见 §10。
- 证据边界：在精简 prod node_modules（`--prod --ignore-workspace --ignore-scripts`）真跑通的
  冒烟为【打包态裁剪完整性证据】（含 `ws@8.21.3` 确在精简 deps 内）。在含 devDeps 的全量
  node_modules 上跑的冒烟仅为【产物级真机证据】，不担保 prod 裁剪后依赖齐全；两类不可混用。
  真 Docker 镜像（基础镜像库依赖 / 多架构 / 镜像内权限入口）仍需在可达 Docker Hub 的机器上
  `docker build` 单独举证。

## 6. 首次部署【需干净 Linux 机】

```bash
# 6.1 安装 systemd 单元与 Caddyfile
sudo install -m 0644 deploy/systemd/gouxiangdb-api.service      /etc/systemd/system/
sudo install -m 0644 deploy/systemd/gouxiangdb-backup.service   /etc/systemd/system/
sudo install -m 0644 deploy/systemd/gouxiangdb-backup.timer     /etc/systemd/system/
sudo install -m 0644 deploy/caddy/Caddyfile                     /etc/caddy/Caddyfile
sudo systemctl daemon-reload

# 6.2 提供 GX_DOMAIN 给 Caddy（让 {$GX_DOMAIN} 占位生效）
sudo systemctl edit caddy --force      # 在 [Service] 加：Environment=GX_DOMAIN=gx.example.com

# 6.3 首次部署（无在运行版本，脚本按“首次”跳过发布前快照）
sudo bash deploy/bin/deploy.sh --release /tmp/gouxiangdb-release-*.tar.gz

# 6.4 起 API、重载 Caddy（备份 timer 默认不启用，见下方说明）
sudo systemctl enable --now gouxiangdb-api
sudo systemctl reload caddy
# 每日【本地】快照定时为可选项，需要时由用户手动开启（仅本地快照，不含异地/加密）：
#   sudo systemctl enable --now gouxiangdb-backup.timer
# 2026-09-12 NAS 重定向（PLAN-ADJUST §3，commit 92d0a34）：产品默认只提供手动/升级前本地快照，
# 部署流程不再默认 enable 备份 timer；异地 age 加密容灾为预留接口、默认不激活（见 backup.md §3）。

# 6.5 验收
curl -fsS http://127.0.0.1:3001/healthz
curl -fsS http://127.0.0.1:3001/readyz      # 五探针 true、migrations applied 与迁移目录数一致
curl -fsS https://gx.example.com/healthz
systemctl list-timers gouxiangdb-backup.timer   # 未 enable 时显示 n/a 或不列出，属预期
```

## 6.6 nav path 重算（幂等，M3 起必须）

`deploy.sh` 的固定顺序是：在线快照 → 解包校验 → `prisma migrate deploy` → **nav path 重算** → 原子切换 + restart。
nav 回填迁移（`20260916093000_enterprise_nav_backfill`）只给根节点写 path，非根节点的 `path/depth`
留空（默认 `''/0`），设计上由应用层重算入口首跑补齐；**不跑则 tree 深层索引缺节点、菜单快捷项全部
disabled**（M3-S8 真机实证）。重算失败时脚本 die 在原子切换之前，current 仍指旧版本、旧进程继续服务，
按 [restore.md](restore.md) 评估从发布前快照恢复或排障后重跑部署，不允许带着空 path 切流量。

- 入口由 **M3-S11-A** 提供：经 esbuild 构建进发布包的生产 CLI（推荐形态 `api/dist/cli/nav-reconcile.js`，
  裸机发布物与 Docker 镜像随 `dist/` 白名单自带，无需 tsx/源码）。**最终入口路径/文件名以 M3-S11-A
  实现为准**；该切片落地前仓内只有开发态源码脚本 `apps/api/scripts/nav/reconcile-nav.ts`（tsx），
  生产包尚不可用，不要在目标机臆造命令。
- 手工补跑/排障（在新版本发布目录内；命令以 S11-A 落地后的实际入口为准）：

```bash
cd /srv/gouxiangdb/current/api
sudo -u gouxiangdb env DATABASE_URL=file:/var/lib/gouxiangdb/app.db \
  node dist/cli/nav-reconcile.js --apply      # 占位命令，最终入口以 M3-S11-A 实现为准
# 期望：首次 pathsRebuilt=N、exit 0；再跑一次输出 no changes、exit 0（幂等）
```

语义边界（与 ADR-0025 一致）：

- **幂等**：每次部署都执行，二次起 `no changes`，无副作用；只重算派生 `path/depth`、修复 nav_nodes
  阻断类差异（A/B/C1-C3）。
- **不自动补菜单快捷项**：未收纳实体（C4）始终只是 warning，运行期收纳唯一入口是 M3 菜单写 API；
  warning 非零不影响 exit 0。
- Docker 部署同一顺序内置于 `deploy/docker/docker-entrypoint.sh`（migrate 后、`node dist/index.js` 前），
  失败容器不启动、不接流量。

## 6.7 auth_policies 回填对账（幂等，M4 起升级后必跑）

M4-S2 起，`prisma migrate deploy` 应用回填迁移 `20260916110000_authz_policies_backfill`，把旧三表
（members / kb_members / kb_doc_acls）活行幂等投影到 `auth_policies`。**升级后、接流量前必须跑一次
authz 对账**确认 0 漂移（A=旧表缺/不一致投影、B=悬挂/虚高投影、C=结构非法；D 类逐请求决策对拍见 §6.8
`GX_AUTHZ_ENGINE=shadow`）：

```bash
cd /srv/gouxiangdb/current/api
sudo -u gouxiangdb env DATABASE_URL=file:/var/lib/gouxiangdb/app.db \
  pnpm tsx scripts/authz/reconcile-policies.ts            # 只读；期望 A=0 B=0 C=0、exit 0
sudo -u gouxiangdb env DATABASE_URL=file:/var/lib/gouxiangdb/app.db \
  pnpm tsx scripts/authz/reconcile-policies.ts --apply    # 有 A1/A2/B 漂移时幂等修复
# 再跑一次 --apply 必须 no changes；行数 expected == legacy == 活 members+kb_members+kb_doc_acls
```

语义边界：

- **幂等**：回填迁移是 `INSERT...SELECT WHERE NOT EXISTS`，重放零增长；对账脚本二次起 `no changes`。
- **只投影活行**：软删 base/kb/doc 与未知角色档不投影；DISABLED 用户的成员行保留投影（停用由鉴权层
  tokenVersion/status 拦截，不删授权行）。kb_members 只投影到 kb 容器节点一行，不逐 doc 膨胀；
  kb_doc_acls 覆盖 doc/canvas 两种内容节点。
- **owner 不抬权**：资源 owner 只持本资源 manage_share（base owner 另持 manage_schema），不写
  role_assignments，不等于工作区管理员。
- **A3/C 类不自动改**：非 legacy 行动作串恰等于旧角色档（疑似手工污染）与 C 类结构非法只报告，按人工
  处理；`--apply` 只修 A1/A2/B1/B2/B3。
- 当前仓内入口是开发态 tsx 源码脚本（不 import `src/config.ts`，只读 `DATABASE_URL`，无启动闸门）；
  是否随 esbuild 进生产发布包属 M4-S11 出口收口范围，在那之前目标机按实际可用的 node/tsx 运行环境执行，
  不要臆造 `dist/cli` 路径。

## 6.7.1 通电前存量 scope 投影与体检（翻 enforce 门之前必跑）

**为什么单列一节**：双写（第二代 `role_library_scope` -> `auth_policies`）只挂在写路径上
（PUT `/api/v1/org/library-scopes`、建库 seed、建表、字段变更），双写上线之前就存在的存量 scope 行
从未被投影过——无迁移全量回填、无启动回填。引擎通电瞬间只认 `auth_policies` 里有什么，
不补这段存量就等于把用户配好的权限整体抹掉。实测（开发库）：`role_library_scope` 203 行、
`auth_policies` 里 `reason='scope:role'` 0 行、对账 S=31。

```bash
cd /srv/gouxiangdb/current/api
# 1) 存量全量投影：只读默认，--apply 单事务写入，幂等（第二次必须 no changes）
sudo -u gouxiangdb env DATABASE_URL=file:/var/lib/gouxiangdb/app.db \
  pnpm tsx scripts/authz/project-scope.ts             # 只读报告；有差异 exit 1
sudo -u gouxiangdb env DATABASE_URL=file:/var/lib/gouxiangdb/app.db \
  pnpm tsx scripts/authz/project-scope.ts --apply     # 补存量；期望 applied changes=N、exit 0

# 2) 通电前体检：一次回答「这个库能不能安全通电」
sudo -u gouxiangdb env DATABASE_URL=file:/var/lib/gouxiangdb/app.db \
  pnpm tsx scripts/authz/preflight.ts                 # READY exit 0 / NOT_READY exit 1
```

- `project-scope.ts` 与 `reconcile-policies.ts` 同口径（只读默认 / `--apply` / `--json`，
  0=已一致或已修复、1=仍有差异、64=用法错），只用 `scopeProjection*` 同源原语，
  只写 `reason='scope:role'` 行，不碰 `legacy:*` / `policy:v1` / user 行。
- `preflight.ts` 逐项输出：① 覆盖（scope 行数 vs `scope:role` 行数 vs 期望，缺口必须为 0）、
  ② 对账 A/B/C/S 四段、③ 库级判定可达性（七守按库节点判 vs 投影把数据动作挂表节点）、
  ④ 库节点是否在 S4 可见集（表可见而库全不可见 = 通电后库整层从导航/检索消失）、
  ⑤ legacy 残留（只报告不删）、⑥ 双写接线（静态扫描 `apps/api/src` 真实调用点）、
  ⑦ 门 `AUTHZ_ENFORCE_READY`。阻断项全空才 READY；A3（只报不改）与 legacy 残留是提示项，不阻断。
- ③④ 是同一根因（引擎缺「库级可见性」一等表达）的两层失效，两条直觉修法均已证伪并锁死在测试里：
  投影层给库节点补 `r` 会淹没逐表字段收窄（OVERALLOW，`fieldMask.ts:97`）；
  enforceGate 改走库内活表并集则与 S4 可见集分叉（`scope.ts:174`，撞零分叉门禁）。
  两项归零前不得通电，修法待架构裁决。
- **④ 是现存可触发态，不需要翻总门**：剪枝门 `navPruneEnforceEffective` 读原始 env
  （`configAuthz.ts:85`，`NAV_PRUNE_ENFORCE_READY=true`，不经 on→shadow 降级），
  故 `GX_AUTHZ_ENGINE=on` 而 `AUTHZ_ENFORCE_READY=false` 时，**剪枝已按 on 生效、七守仍 shadow**。
  且 `nav/prune.ts` 的 `resourceAncestorsPass` 沿 parentId 向上「任一资源祖先不可见即拒」，
  库被剪 ⇒ 库内表/视图一并消失。**④ 归零前 `GX_AUTHZ_ENGINE` 不得置 on**（不是"翻门要谨慎"，
  是"连 on 都不能设"）。详见 [authz-engine-flip-on.md §1.5.0](authz-engine-flip-on.md#150-风险当前可触发4-不需要翻总门envon-即发生)。
- 顺序：先 `reconcile-policies.ts --apply`（修 A1/A2/B），再 `project-scope.ts --apply`（补存量），
  最后 `preflight.ts` 收口。三者都幂等，可以重复跑。

## 6.8 权限引擎 shadow 对拍（GX_AUTHZ_ENGINE，M4-S3 起）

M4-S3 在七个旧守卫（`guards.ts` 的 requireCanView/EditData/ManageSchema/ManageBase/Comment，
`routes/kb.ts` 的 requireKb/requireDocAccess）内挂了新旧决策对拍，默认完全关闭、旧行为零变化：

| 取值 | 行为 |
|---|---|
| `off`（默认，含未设置/未知值） | 七守只走旧三表决策，不实例化引擎、零新增 SQL。回滚态。 |
| `shadow` | 旧决策为准并照常返回；额外 `await` 新引擎同上下文（同主体/nav 节点/动作）对拍，差异只计数+脱敏日志，**绝不改响应、不抛错**。引擎自身抛错也只记 metric，旧响应照常（fail-open 仅限观测层）。 |
| `on` | **S3-S5 阶段不可真正生效**：阶段门 `AUTHZ_ENFORCE_READY=false`，运行时一律降级为 `shadow` 并在启动行打一次 warn；S6 完成且 M4 计划 §4.8 翻门五条件全满足、仅由项目总监下令后才会以引擎为准。 |

开启影子观测（升级并跑完 §6.7 对账、A/B/C=0 后）：

```bash
# systemd EnvironmentFile 或环境注入；重启后看启动行：
#   [authz] GX_AUTHZ_ENGINE configured=shadow effective=shadow
GX_AUTHZ_ENGINE=shadow
```

观测口径（不落盘、不含响应体；userId 只存 sha256 前 12 位短哈希）：

- 结构化日志事件 `authz_drift`：字段 `kind/direction/guard/action/nodeId/userHash/old/engine/ts`。
  - `DRIFT_OVERDENY` = 旧允新拒（引擎更严，可能把用户锁外，可用性风险）；
  - `DRIFT_OVERALLOW` = 旧拒新允（引擎更宽，越权风险，**零容忍**）；
  - `direction=forward` = 影子期（旧为准、引擎只对比）；`direction=reverse` = enforce 期
    （引擎为准、旧决策只作对比基准；R1 接线后 on 态才可能出现）。两个方向的分类口径完全一致。
- `authz_shadow_error` = 引擎对拍自身异常（旧响应未受影响），错误明文仅进进程内环形缓冲供现场排查。
- enforce 期专属事件（仅生效模式真正为 `on` 时可能出现）：
  - `authz_enforce_error` = 引擎在**放行链上**抛错，该请求已回落旧决策（`fallback=legacy`，
    请求不受影响）。与 `authz_shadow_error` 同族同机制（同一环形缓冲），但**必须单独告警**：
    它意味着"这一条请求实际没走引擎"，影子期的同类事件只意味着"少了一次对拍"。
  - `authz_enforce_unresolved` = 资源反查不到活 nav 节点，该请求已按 fail-closed 拒绝
    （`denied=true`），节点缺口归 M3 `reconcile-nav`，不当授权漂移。
- 进程内最近 200 条漂移/错误环形缓冲 + 分类计数（含 `comparedReverse`/`enforceErrors`/
  `enforceUnresolved`），供运维接口/现场诊断（M4 不单独落盘）。
- 翻门纪律（§4.8）：shadow 连续一个迭代 `DRIFT_OVERALLOW=0` 且 `DRIFT_OVERDENY=0` 双零，才允许评估切 on。

回滚：`GX_AUTHZ_ENGINE=off` 重启即恢复纯旧守卫，适配分支保留无副作用（无数据迁移、无双写）。

切 on（enforce）操作面：七守真正以引擎为准需要独立的 enforce 接线构建 + 翻就绪门 + 项目总监
按 §4.8 五前置下令，操作清单与签收/回滚纪律见
[authz-engine-flip-on.md](authz-engine-flip-on.md)，规模门与翻转演练证据见
`docs/baseline/2026-09-16-m4-gate.md`。M4 出口姿态为代码默认 off、生产建议 shadow。

## 6.9 Prisma Client 生成（含新增迁移时，源码同步通道必须先生成再重启）

**结论先行**：三条正规通道（fnOS `install_callback`/`upgrade_callback`、`deploy.sh` 解包、Docker
`docker-entrypoint.sh`）都**不需要**在目标机上补 `prisma generate`——Prisma Client 是**打包时**就生成好
随包分发的（`deploy/bin/package-release.mjs`、`deploy/fnos/build-fpk.mjs`、`deploy/docker/Dockerfile`
各自的 generate 步）。它们只跑 `migrate deploy` 是安全的，不要凭"多跑一次更保险"往里加。

**唯一会漏的是 rsync 源码同步通道**：把工作区源码直接同步到目标机、在目标机 `install` + `build`
（预览机 167 常用这条）。这条通道不会自动 generate，于是会出现这种组合：

- DB 侧已经 `migrate deploy` 到最新（新表建好了）；
- 但 `node_modules/.prisma/client` 还是**旧 schema 生成的**，里面没有新 model；
- 运行期 `prisma.<新表>.create is not a function` / `Unknown arg`，所有写该表的端点 500。

这正是本项目踩过的坑（新增 `attachments`、`record_changes` 时）。因此 rsync 通道的**固定顺序**是：

```bash
cd /srv/gouxiangdb/current/api          # 或预览机的实际目录
node node_modules/prisma/build/index.js migrate deploy --schema=prisma/schema.prisma
# ↓ 新增迁移时必须补这一步，且必须在 restart 之前
node node_modules/prisma/build/index.js generate --schema=prisma/schema.prisma
systemctl restart gouxiangdb
```

判定与自检：

- 现象：日志出现 `prisma.xxx.findMany is not a function`、`Unknown argument`、或对某新表的写入
  一律 500 而库里表确实存在 → 即"库新、client 旧"，补 generate 后重启即恢复。
- 主动校验（列出 client 里实际可用的 model 委托，新表不在列表里就是 client 陈旧）：

```bash
node -e "const {PrismaClient}=require('@prisma/client');const p=new PrismaClient();\
console.log(Object.keys(p).filter(k=>!k.startsWith('_')&&!k.startsWith('\$')).join(' '))"
# 期望包含本次新增的表（如 attachment / recordChange）；缺失即 client 陈旧，需 generate
```

纪律：凡发布内容含 `apps/api/prisma/migrations/` 下的新增目录，该通道**无条件**多跑一次
generate；生成是幂等的，代价只有几秒，漏跑的代价是整条新功能 500。

## 7. 证书两条路径

- **公网正式域名（推荐）**：DNS 已指向本机、80/443 可出网。保留 Caddyfile 站点块即可，
  Caddy 自动申请并续期公信 CA 证书。确认证书为公信 CA 后，取消 Caddyfile 中
  HSTS 行注释（`Strict-Transport-Security`）。
- **内网 / 自签 / 内部 CA**：在 Caddyfile 用
  `tls /etc/gouxiangdb/certs/server.crt /etc/gouxiangdb/certs/server.key` 指向内部证书；
  客户端需信任签发根 CA。**不要开启 HSTS**（自签下浏览器可能强制拒绝后续访问），
  故 Caddyfile 的 HSTS 默认保持注释。证书目录权限建议 600、属主 caddy/gouxiangdb 按实际放行。

## 8. 日常升级与回滚

```bash
# 升级：脚本自动先做在线快照、迁移、nav path 重算（M3 起，§6.6）、原子切换、30s readyz 轮询，失败自动回滚到上一版
sudo bash deploy/bin/deploy.sh --release /tmp/gouxiangdb-release-新.tar.gz

# 手动回滚（只回应用、不回数据；30s 内 readyz 判定）
sudo bash deploy/bin/rollback.sh                 # 上一版
sudo bash deploy/bin/rollback.sh 20260920-1      # 指定 release
```

发布默认保留最近 5 个 release（`KEEP_RELEASES=5`，可用环境变量覆盖）。
应用回滚不撤销迁移（迁移只增、向后兼容）；仅当迁移本身损坏需恢复数据时，
按 [restore.md](restore.md) 从发布前快照做时间点恢复。

## 9. 备份与监控

- **本地在线快照是内置基础能力**（防误删/损坏/升级回滚的最低安全网，零额外二进制）：
  `deploy.sh` 每次发布前自动执行一次；也可随时手动跑 `online-backup.mjs`（见 [backup.md](backup.md)），
  落 `/var/backups/gouxiangdb`，daily7/weekly4 本地保留。
- **每日 timer 默认不启用**（2026-09-12 NAS 重定向，PLAN-ADJUST §3，commit 92d0a34）：需要本地每日定时时，
  用户手动 `sudo systemctl enable --now gouxiangdb-backup.timer`（每日 02:00，仅本地快照）。
- **异地 age 加密容灾＝可选扩展、接口预留、默认不激活**：相关变量
  （`BACKUP_ENCRYPT_OFFSITE`/`AGE_RECIPIENT`/`AGE_BIN`/`GX_OFFSITE_TARGET`）在 env.conf 中默认全部关闭/注释，
  详见 [backup.md](backup.md) §3。当前产品不宣称具备异地/异机容灾能力。
- 日志：`journalctl -u gouxiangdb-api -f`、`-u gouxiangdb-backup`；
  审计 JSONL 在 `/var/log/gouxiangdb/audit.logl`，logrotate 配置见 `deploy/logrotate/gouxiangdb.conf`。
- 健康：外部探针对 `/healthz`（存活）与 `/readyz`（就绪，含 db/disk/migrations/uploads）。

## 10. 架构匹配与离线说明

- `better-sqlite3` 13 携带全平台 prebuilds（linux/darwin/win × x64/arm64），随包即可按目标平台加载。
- Prisma 的 query engine 由打包时 `prisma generate` 按**构建机平台**拉取。因此标准做法是
  **在与目标同 OS/架构的构建机打包**（如都为 linux-x64）。
- 必须交叉打包或完全离线时：在目标机首次部署前，于发布目录 `api/` 内用内部 registry
  重新 `pnpm install --prod --ignore-workspace` 并 `prisma generate`（需要内网能取得对应 engine），
  或在 `schema.prisma` 的 generator 配置 `binaryTargets` 后重新生成（属业务配置变更，M0 不默认改）。
- `deploy.sh` 在目标机执行 migrate；若 engine 平台不匹配会在迁移步明确失败，且因切换发生在迁移之后，
  现网不受影响。
- 迁移引擎的取用（2026-09 实测）：`--ignore-scripts` 下即便没有本地 `@prisma/engines` 目录与
  `migration-engine` 二进制，`migrate deploy` 也能成功（CLI 按需取引擎），但取引擎过程需要网络。
  故离线机执行迁移前，必须在同平台、可出网环境预跑一次 `prisma migrate deploy`/`generate` 使引擎落盘，
  否则离线迁移有失败风险。

## 11. 卸载（完全撤销）

```bash
sudo systemctl disable --now gouxiangdb-api gouxiangdb-backup.timer
sudo rm -f /etc/systemd/system/gouxiangdb-{api,backup.service,backup.timer}
sudo systemctl daemon-reload
# 数据与配置按需保留或删除：/srv/gouxiangdb /etc/gouxiangdb /var/lib/gouxiangdb /var/backups/gouxiangdb
```
