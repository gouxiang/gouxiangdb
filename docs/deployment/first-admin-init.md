# 首次部署：创建超级管理员（init-admin）

> 适用范围：飞牛 fnOS 原生（`.fpk`）、Docker、裸机 systemd 三套部署，以及本地开发验证。
> 相关文档：[`README.md`](./README.md) §2.7、[`docker.md`](./docker.md)、[`fnos-native.md`](./fnos-native.md)。

## 1. 它做什么，什么时候做

部署链路在**数据库迁移完成 + nav-reconcile 之后、服务启动之前**调用一次 `node dist/init-admin.js`：

- 创建 `users` 表里第一个 `ACTIVE` 用户（`GX_INIT_ADMIN_EMAIL` / `GX_INIT_ADMIN_PASSWORD` / `GX_INIT_ADMIN_NAME`）；
- 授予**系统 owner**（`role_assignments` 一行 `roleId='role_owner'`、`subjectType='user'`）；
- 置 `users.mustChangePassword = true`，强制首次登录先改密；
- 写审计事件 `admin_initialized`。

### 触发条件

只有 `GX_INIT_ADMIN_EMAIL` 与 `GX_INIT_ADMIN_PASSWORD` **两个都非空**时才执行。任一为空 → 打印一行提示、正常继续（**不失败**）：

```
未配置初始管理员凭据，跳过自动初始化（首个通过 /api/auth/signup 注册的用户会自动成为所有者）
```

### 幂等性

脚本检测到 `users` 表**已有任何用户**即打印「已初始化，跳过」并 `exit 0`，**绝不重复创建**。

为什么要"已有任何用户就跳过"而不是"已有 owner 才跳过"：项目里存在一条既有逻辑——`apps/api/src/domain/org/members.ts` 的 `bootstrapFirstOwnerTx()`，它在一个用户注册后、若该用户是工作区**唯一用户**且尚无 `user` 级 owner 授予时，自动授予系统 owner。若 init-admin 只按"已有 owner"判断，就可能与这条自举逻辑抢跑（例如先有人注册、后又跑 init-admin，会造出第二个 owner）。以"users 表非空即跳过"为准，把首个账号的归属权交给先到者，语义唯一且无歧义。

### 退出码

| 退出码 | 含义 | 部署链路行为 |
| --- | --- | --- |
| `0` | 创建成功，或检测到已初始化而跳过 | 继续 |
| `64` | 生产环境未提供凭据 | 打印错误 + 写日志 + 非零退出（部署失败） |
| `1` | 执行失败（建用户/授权/写审计任一步失败） | 打印错误 + 写日志 + 非零退出（部署失败） |

> 部署**不留假绿**：初始化失败必须让部署失败，而不是让服务带着"没有管理员"的状态起来。

## 2. 在部署流程中的位置与前置依赖

```
解包 / 落应用文件
      ↓
依赖安装（prisma generate 等）
      ↓
数据库迁移：prisma migrate deploy      ← users 表在此之后才（肯定）存在
      ↓
nav-reconcile --apply                  ← 迁移后重算 nav path/depth
      ↓
创建超级管理员：node dist/init-admin.js   ★ 本文这一步
      ↓
启动服务（systemd restart / exec node dist/index.js / cmd/main start）
```

**前置依赖（硬约束）**：`prisma migrate deploy` 必须**已经成功**。脚本要读写 `users` 与 `role_assignments` 两表，迁移没跑完就没有这两张表（以及 `users.mustChangePassword` 列，来自迁移 `20260918120000_init_admin_must_change`），脚本必然失败。反过来，nav-reconcile 与本步骤之间无数据依赖，但顺序上把它放在 nav-reconcile 之后是为了让"迁移后、接流量前"这一整段收尾动作集中在一处。

三套部署的插入点：

| 部署形态 | 文件 | 插入位置 |
| --- | --- | --- |
| 飞牛 fnOS 原生 | `deploy/fnos/gouxiangdb/cmd/install_callback` | `node dist/nav-reconcile.js --apply` 之后、`exit 0` 之前（第 3 步） |
| Docker | `deploy/docker/docker-entrypoint.sh` | nav-reconcile 之后、`exec node dist/index.js` 之前 |
| 裸机 systemd | `deploy/bin/deploy.sh` | 步骤 4b（nav-reconcile）之后、步骤 5（symlink 切换 + `systemctl restart`）之前，即步骤 4c |

> 飞牛只在 **`install_callback`（首次安装）** 里有这一步，`upgrade_callback`（升级）**没有**，升级路径不会重复初始化。
> 裸机把它放在 symlink 切换**之前**，是为了沿用既有失败姿态：失败即 `die`，`current` 仍指旧版本、现网不受影响。

## 3. 凭据来源（三种注入方式）

优先级：**命令行参数 > 环境变量 > 本地默认值（仅非生产环境）**。

| 方式 | 用法 | 说明 |
| --- | --- | --- |
| 环境变量 | `GX_INIT_ADMIN_EMAIL` / `GX_INIT_ADMIN_PASSWORD` / `GX_INIT_ADMIN_NAME` | 三套部署的标准方式，随部署的 env 文件注入 |
| 命令行参数 | `node dist/init-admin.js --email a@b.c --password 'xxx' --name 昵称` | 手动补跑时用；优先级最高 |
| 本地默认值 | 不传任何参数 | **仅非生产环境**生效（如本地开发联调），用于省事 |

约束：

- **生产禁止使用默认值**、**禁止把明文密码提交进仓库或打进发布包/镜像**。凭据由部署者在部署时注入。
- `GX_INIT_ADMIN_NAME` 可选，缺省「超级管理员」。
- 环境文件含密钥，建议 `chmod 600`（`deploy/env.conf.example` 与 `deploy/docker/gouxiangdb.env.example` 已提供注释掉的三行模板）。
- **初始化完成后建议从 env 里删掉这三行**：脚本幂等，删了也不会重复创建，可避免凭据长期留在环境文件里。

## 4. 操作命令

### 4.1 前置：把凭据写进环境文件

```bash
# 裸机（/etc/gouxiangdb/env.conf；systemd EnvironmentFile 语法，值不加引号）
sudo install -m 600 -o gouxiangdb -g gouxiangdb /dev/null /etc/gouxiangdb/env.conf   # 首次创建时
sudo $EDITOR /etc/gouxiangdb/env.conf
# GX_INIT_ADMIN_EMAIL=admin@example.com
# GX_INIT_ADMIN_PASSWORD=<openssl rand -base64 24 生成的强口令>
# GX_INIT_ADMIN_NAME=超级管理员

# Docker（deploy/docker/gouxiangdb.env）
cp deploy/docker/gouxiangdb.env.example deploy/docker/gouxiangdb.env
chmod 600 deploy/docker/gouxiangdb.env
$EDITOR deploy/docker/gouxiangdb.env

# 飞牛（${TRIM_PKGETC}/gouxiangdb.env，由 install_callback 首装生成）
#   在 NAS 上编辑该 env 后于应用中心重启；env 里的三个变量会被 install_callback 读取
```

### 4.2 三套部署各自的执行

**Docker** —— 不需要手动跑，容器启动时 `docker-entrypoint.sh` 自动执行：

```bash
docker compose -f deploy/docker/docker-compose.yml --env-file deploy/docker/gouxiangdb.env up -d --build
docker compose -f deploy/docker/docker-compose.yml logs -f gouxiangdb | grep -E 'init-admin|超级管理员'
```

**裸机 systemd** —— 由 `deploy.sh` 在步骤 4c 自动执行：

```bash
sudo bash deploy/bin/deploy.sh --release /path/to/gouxiangdb-release-*.tar.gz
sudo journalctl -u gouxiangdb-api -n 50 | grep -E 'init-admin|超级管理员'
```

**飞牛 fnOS** —— 由 `install_callback` 在首装时自动执行；失败信息写 `$TRIM_TEMP_LOGFILE`。

**手动补跑**（三套都适用，脚本幂等，可重复执行）：

```bash
# Docker
docker compose -f deploy/docker/docker-compose.yml exec gouxiangdb \
  node dist/init-admin.js

# 裸机（cwd=/srv/gouxiangdb/current/api）
sudo -u gouxiangdb bash -c 'set -a; source /etc/gouxiangdb/env.conf; set +a; \
  cd /srv/gouxiangdb/current/api && node dist/init-admin.js'

# 飞牛（在 NAS 上，TRIM_* 由框架注入；手动执行时需自行代入实际路径）
set -a; source "${TRIM_PKGETC}/gouxiangdb.env"; set +a
cd "${TRIM_APPDEST}/server" && node dist/init-admin.js
```

### 4.3 本地开发验证

```bash
# 仓库根（走 apps/api/package.json 的 init:admin，内部为 tsx scripts/init-admin.ts）
GX_INIT_ADMIN_EMAIL=dev@example.com GX_INIT_ADMIN_PASSWORD=devpass123 \
  pnpm --filter @gx/api init:admin

# 或等价地直接调源码
cd apps/api && DATABASE_URL=file:./dev.db \
  GX_INIT_ADMIN_EMAIL=dev@example.com GX_INIT_ADMIN_PASSWORD=devpass123 \
  pnpm tsx scripts/init-admin.ts
```

## 5. 验证方法

### 5.1 用初始账号登录，确认强制改密已生效

```bash
curl -sS -X POST http://127.0.0.1:3001/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"<GX_INIT_ADMIN_EMAIL>","password":"<GX_INIT_ADMIN_PASSWORD>"}' \
  | tee /tmp/login.json
# 期望：HTTP 200，且响应体 user.mustChangePassword === true
node -e 'const j=require("/tmp/login.json"); console.log("mustChangePassword =", j.user.mustChangePassword)'
```

判定：登录返回 `200`，且 `user.mustChangePassword` 为 `true`（`publicUser()` 投影含该字段，见 `apps/api/src/domain/userProjection.ts`）。
再验证闸门真的拦得住——拿返回的 `token` 访问任意业务接口应得到 `403 PASSWORD_CHANGE_REQUIRED`：

```bash
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3001/api/v1/org/members \
  -H "Authorization: Bearer $(node -e 'console.log(require("/tmp/login.json").token)')"
# 期望：403
```

改密后闸门解除（白名单接口 `POST /api/auth/me/change-password`），此后 `mustChangePassword` 回落 `false`。

### 5.2 查库确认用户与 owner 授予都存在

表名来自 `apps/api/prisma/schema.prisma`：`User @@map("users")`、`RoleAssignment @@map("role_assignments")`；字段未在 Prisma 里 `@map`，故 SQLite 列名就是 camelCase 原名（`email` / `displayName` / `status` / `mustChangePassword` / `roleId` / `subjectType` / `subjectId`）。

```sql
-- 1) 用户存在且为 ACTIVE + 强制改密
--    期望：1 行，status='ACTIVE'，mustChangePassword=1（SQLite 布尔存 1/0，1 即 true）
SELECT id, email, displayName, status, mustChangePassword, createdAt
FROM users
ORDER BY createdAt;

-- 2) 系统 owner 授予存在（owner 系统角色 id 固定为 'role_owner'）
SELECT id, roleId, subjectType, subjectId, scopeType, createdBy, createdAt
FROM role_assignments
WHERE roleId = 'role_owner' AND subjectType = 'user';

-- 3) 授予确实指向该用户（把 :uid 换成第 1 条查出的 id）
SELECT u.id, u.email, ra.roleId, ra.subjectType, ra.subjectId
FROM users u
JOIN role_assignments ra ON ra.subjectId = u.id AND ra.subjectType = 'user' AND ra.roleId = 'role_owner'
WHERE u.email = 'admin@example.com';
```

执行方式：

```bash
# 裸机（有 sqlite3 时）
sudo sqlite3 /var/lib/gouxiangdb/app.db "SELECT id,email,displayName,status,mustChangePassword FROM users;"

# 裸机 / 飞牛（无 sqlite3 CLI 时，用发布包自带的 better-sqlite3）
cd /srv/gouxiangdb/current/api && sudo -u gouxiangdb node -e \
  "const D=require('better-sqlite3');const db=new D(process.env.DATABASE_URL.replace(/^file:/,''),{readonly:true});\
console.log(db.prepare('SELECT id,email,displayName,status,mustChangePassword FROM users').all());\
console.log(db.prepare(\"SELECT id,roleId,subjectType,subjectId FROM role_assignments WHERE roleId='role_owner' AND subjectType='user'\").all());"

# Docker
docker compose -f deploy/docker/docker-compose.yml exec gouxiangdb \
  node -e "const D=require('better-sqlite3');const db=new D('/data/app.db',{readonly:true});\
console.log(db.prepare('SELECT id,email,displayName,status,mustChangePassword FROM users').all());\
console.log(db.prepare(\"SELECT id,roleId,subjectType,subjectId FROM role_assignments WHERE roleId='role_owner' AND subjectType='user'\").all());"
```

### 5.3 审计事件已落盘

初始化会写一条 `admin_initialized` 审计事件，落在 `$GX_AUDIT_DIR/audit.logl`（一行一 JSON）：

```bash
# 裸机默认 /var/log/gouxiangdb；Docker 镜像内置 /data/log；飞牛 = ${TRIM_PKGVAR}/log
grep '"event":"admin_initialized"' "${GX_AUDIT_DIR:-/var/log/gouxiangdb}/audit.logl"
```

## 6. 失败重试

脚本**幂等**：修好凭据后直接重跑即可，不需要先清理半截状态（`users` 表非空才会跳过；失败的那一轮要么没写要么整体回滚，不会留下半个管理员）。

```bash
# Docker：改完 deploy/docker/gouxiangdb.env 后
docker compose -f deploy/docker/docker-compose.yml --env-file deploy/docker/gouxiangdb.env up -d
# 或只补跑一次
docker compose -f deploy/docker/docker-compose.yml exec gouxiangdb node dist/init-admin.js

# 裸机：改完 /etc/gouxiangdb/env.conf 后重跑整条部署（4c 会再执行一次）
sudo bash deploy/bin/deploy.sh --release /path/to/gouxiangdb-release-*.tar.gz
# 或只补跑一次
sudo -u gouxiangdb bash -c 'set -a; source /etc/gouxiangdb/env.conf; set +a; \
  cd /srv/gouxiangdb/current/api && node dist/init-admin.js'

# 飞牛：在 NAS 上改 ${TRIM_PKGETC}/gouxiangdb.env 后于应用中心重启，
# 或手动 source env 后 cd "${TRIM_APPDEST}/server" && node dist/init-admin.js
```

常见失败原因：迁移没跑完（`users` 表不存在）、`DATABASE_URL` 指错库、生产环境只配了 EMAIL 没配 PASSWORD（退出码 64）、库文件权限不足。

## 7. 回滚

> **警告：本节 SQL 会物理删除账号与其 owner 授予。仅在确认该库尚无任何业务数据（首次部署、还没人注册、没建过 base/表/记录）时执行。已有业务数据的库请走 [`../runbooks/restore.md`](../runbooks/restore.md) 从快照恢复，不要手工删行。**

删除该 user 行及其 owner 授予行，即回到"未初始化"态，然后重新执行 init-admin：

```sql
-- 1) 先查到要删的用户 id（确认只有这一个、且无业务数据）
SELECT id, email, displayName, mustChangePassword FROM users;

-- 2) 先删授予，再删用户（把 '<uid>' 换成第 1 步查出的 id）
DELETE FROM role_assignments
WHERE subjectType = 'user' AND subjectId = '<uid>' AND roleId = 'role_owner';

DELETE FROM users WHERE id = '<uid>';

-- 3) 确认已回到未初始化态（应返回 0 行）
SELECT COUNT(*) AS user_count FROM users;
SELECT COUNT(*) AS owner_grants FROM role_assignments WHERE roleId = 'role_owner' AND subjectType = 'user';
```

随后按 §4.2 重跑对应部署形态的 init-admin；此时 `users` 表为空，脚本会正常创建。

执行方式同 §5.2 的三种（`sqlite3` CLI 或 `better-sqlite3` 的 `node -e`；注意删行时**不要**加 `{readonly:true}`）。

## 8. 安全约束

- **首次登录强制改密**：初始账号 `mustChangePassword = true`，登录后除白名单（`GET /api/auth/me`、`POST /api/auth/me/change-password`、`POST /api/auth/login`、`/api/health`）外一律 `403 PASSWORD_CHANGE_REQUIRED`；改密成功后置 `false` 解除。详见 `apps/api/src/middleware/mustChangePassword.ts`。
- **初始化完成后流程自动关闭**：无需额外开关——脚本检测到 `users` 表已有任何用户即跳过（§1 幂等性）。
- **审计可追溯**：初始化写入 `admin_initialized` 事件，落 `$GX_AUDIT_DIR/audit.logl`（JSONL），由 logrotate copytruncate 轮换。
- **凭据不留库**：部署者应在初始化完成后把 `GX_INIT_ADMIN_EMAIL` / `GX_INIT_ADMIN_PASSWORD` / `GX_INIT_ADMIN_NAME` 三行从环境文件里删除或注释掉；脚本幂等，删了不会重复创建。
- **禁止明文进仓库**：`deploy/env.conf.example` 与 `deploy/docker/gouxiangdb.env.example` 里这三行**保持注释状态**；真实值只在部署机上注入，文件权限 `600`。

## 9. 落地状态（如实标注）

**已实测（2026-09-18，临时 SQLite 库 + `prisma migrate deploy` 后，项目总监独立复跑，非脚本作者自报）**

```
$ node dist/init-admin.js --email lead@verify.local --password '<强口令>' --name 复核管理员
[init-admin] 已创建超级管理员 cmu6ryirm000112zfz6kcx9hg lead@verify.local，已授予系统 owner，已标记首次登录强制改密
[init-admin] 安全提示：请立即用初始账号登录并修改密码；完成后建议从 env 中删除 GX_INIT_ADMIN_* 三行。
EXIT=0
$ node dist/init-admin.js --email lead@verify.local --password '<强口令>'      # 第二次
[init-admin] 已初始化，跳过（users 表已有 1 个用户）
EXIT=0
```

- 落库核对：`users` 行 `status=ACTIVE`、`mustChangePassword=1`；`role_assignments` 行
  `roleId=role_owner / subjectType=user / scopeType=workspace / createdBy=system-init-admin`（与 §5.2 的 SQL 一致）。
- 审计落盘：`{"event":"admin_initialized",...,"detail":{"emailMasked":"l***@verify.local",...}}`，
  **密码明文出现次数 = 0**。
- 退出码：`NODE_ENV=production` 未提供凭据 → **64**；迁移未执行 → **1**；`--help` → 0。
- 构建产物：`dist/init-admin.js`（第四入口）已产出，`build.mjs` / `package-release.mjs` / `build-fpk.mjs` 三处断言均已就位。
- 三个部署 shell（`cmd/install_callback`、`docker-entrypoint.sh`、`deploy/bin/deploy.sh`）`bash -n` 语法检查通过。

**已核对但未实测（需目标机/真机联调）**

- §4.2 三套部署**整条链路**的实际执行（只做了接线块的分支冒烟，未跑真机安装）。
- §5.1 登录 200 + `mustChangePassword:true` 的端到端结果、§6 重跑、§7 回滚后重跑 —— 需在飞牛 / 容器 / 裸机上按本文逐条执行。
- 前端强制改密页的真机呈现（登录 → 跳 `/change-password` → 提交 → 进主界面），目前只有单测与 typecheck 覆盖。
