# M0 生产基座 — 可执行实施切片（设计与现状核对，不改业务码）

- 日期：2026-09-13
- 作者：架构师 高见远
- 状态：Proposed（交项目总监大湾区靓仔派后端工程师实施）
- 上游依据：SPEC-enterprise-v1.0 §4/§11/§12、PRD-production 支柱 B/C/E、ARCH-production §4/§5/§6（P0）
- 适用代码基线：`main` @ 根 `package.json` v0.1.0（远程 Gitee 私有仓 `gouxiang_admin/gouxiangdb`）
- 本机核对环境：Node v22.22.2、pnpm 9.0.0、Hono 4.13.5、Prisma 5.22、better-sqlite3 13.0.3、sqlite3 CLI 3.51、esbuild 0.28.2（已在 lock 内，Vite 传递依赖）

> 本文所有"现状证据"行号均已在本机实际读码/跑命令核对（非凭记忆）。所有关键技术动作（在线备份、`migrate deploy` 干跑、可运行产物构建、磁盘探测、健康探针）均已在 `/tmp` 或临时目录实测通过，未改动任何被 Git 跟踪的源码。

---

## 0. 结论先行

1. M0 七项需求成立，但**顺序必须先补一个被旧 ARCH 漏掉的前置阻断项：当前生产产物根本跑不起来**（见 §1 阻断项 B0 与 §7 不符 D1）。`pnpm --filter @gx/api build` 产物是 `dist/apps/api/src/index.js`（嵌套路径），而 `start`/systemd 都调 `node dist/index.js`（文件不存在）；即便改调真实产物，也会因 `@gx/shared-types` 只发裸 TS 而 `ERR_MODULE_NOT_FOUND`。不修此项，systemd/部署/回滚切片全部无法验收。已实测 **esbuild 扁平打包（内置 `@gx/*`、外置原生/运行时依赖）可产出可直接 `node dist/index.js` 运行的单文件**，是最小改动解。
2. 测试基线已留证：**api 214 + shared-types 56 = 270，全绿**（2026-09-13 两次复验）。根 `pnpm -w test` 当前却是红的（web 无测试文件，vitest 退出 1）——Spec §12 写的命令今天不能直接跑，切片 S0 先修。
3. 270 测试**不 import `src/index.ts`**（路由测试直接调路由模块/域函数，fake prisma）。因此 M0 在 `index.ts` 新增的全局中间件（安全头/体积/限流）与配置闸门对 270 零影响；配置闸门只在 `NODE_ENV=production` fail-closed，vitest 下实测 `NODE_ENV=test`（直接放行）。这是"不破坏基线"的结构性保证。
4. 备份/恢复、健康探针所需的 SQLite 能力用**已锁定的 better-sqlite3 13.0.3**（在 devDependencies，M0 提升为 dependencies），不要求客户机装 sqlite3 CLI；在线 `.backup()`、`integrity_check`、迁移计数、磁盘 `statfsSync` 均已实测。
5. 需求里写的 "helmet" 是 Express 中间件且未安装；实测 Hono 4.13.5 自带 `hono/secure-headers`、`hono/body-limit`（可直接 import），用 Hono 原生件、零新增运行时依赖，最符合私有化零依赖交付。限流用单实例内存固定窗，审计用零依赖 JSONL（pino 留作可选 ADR，不进 M0 必做）。

---

## 1. 现状证据（行号已核对）与阻断项

| 编号 | 事实 | 证据（本机核对） | 影响 |
|---|---|---|---|
| E1 | 版本三处硬编码且互相矛盾 | `apps/api/src/index.ts:79` = `"0.2.0"`；`apps/api/src/routes/health.ts:15` 与 `:24` = `"0.1.0"`；根 `package.json:3` = `0.1.0`，其余 6 个 package.json/tauri.conf 均 0.1.0 | 版本单源要改 3 处（旧 ARCH 只点了 index.ts 一处） |
| E2 | **生产构建产物路径错位** | `tsc`（rootDir 被 `@gx/shared-types` path 引用抬到 monorepo 根）产物在 `apps/api/dist/apps/api/src/index.js`；`apps/api/package.json:9` `start: node dist/index.js` | `node dist/index.js` 必 ENOENT |
| E3 | **真实产物也无法启动** | `node dist/apps/api/src/index.js` → `ERR_MODULE_NOT_FOUND: packages/shared-types/src/ids.js`；该包 `package.json` exports 指向 `./src/index.ts`（裸 TS），无 build 脚本 | 干净机无法运行 |
| E4 | tsc 还把测试编译进产物 | 干净 build 后 `dist` 内有 8 个 `*.test.js` | 产物污染 |
| E5 | **JWT fail-closed 在带 `.env` 的机器上被静默绕过** | `apps/api/src/auth.ts:26-31` 启动校验；实测 `import('@prisma/client')` 会自动 dotenv 加载 `apps/api/.env`，把里面的 `JWT_SECRET="dev-secret-change-in-prod-gouxiangdb-v2"` 注入 `process.env`，即使 `NODE_ENV=production` 且真实环境无该变量，校验也通过 | 闸门输入被污染；生产打包必须不含 `.env`，闸门必须先于 prisma 求值并拉黑开发默认值 |
| E6 | 根 `pnpm -w test` 红 | web 测试文件数 0，vitest "No test files found, exiting with code 1"，`ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL @gx/web` | Spec §12 "pnpm -w test 270 绿" 今天不成立 |
| E7 | `pnpm --filter @gx/shared-types build` 是空操作 | "None of the selected packages has a build script"，退出 0；该包发裸 TS，靠 tsconfig path/vite alias 消费 | Spec §12 的 "shared build" 步骤应改为 typecheck；运行时由打包内化解决 |
| E8 | lint 是假绿 | 根与各包均无 `lint` 脚本、全仓无 eslint 配置；`pnpm -w lint` 打印 "None of the selected packages has a lint script" 退出 0；但根 `node_modules/.bin/eslint` = 9.39.5（devDep 已声明） | `pnpm --filter @gx/api lint` 不构成门禁 |
| E9 | 健康检查只有一个且会泄漏内部错误 | `apps/api/src/routes/health.ts:9-30` 仅 `GET /api/health`，失败分支 `error: String(e)`（回传原始异常，可能含 SQL/路径），版本硬编码；无 `/healthz` `/readyz` | 需分层并去泄漏 |
| E10 | 迁移已应用 11 个 | `prisma/migrations` 11 个目录；`_prisma_migrations` finished 非 rolled-back = 11；`prisma migrate deploy` 到空库实测 11/11、`integrity_check=ok` | readyz 迁移对账基线 = 11 |
| E11 | 无 `db:deploy` | `apps/api/package.json:14` `db:migrate: prisma migrate dev`（交互式，生产禁用） | 需加 `db:deploy: prisma migrate deploy` |
| E12 | 现有"备份"是不安全的多文件 cp | `.db-backups/20260912-100746/` 内为分别拷贝的 `dev.db` + `dev.db-wal` + `dev.db-shm` + `dev-consolidated.db` | 不是 WAL 一致性快照，不能作为备份机制，需新建 |
| E13 | 无 CI、无 systemd、无 Caddy、无部署脚本 | 仓内无 `.github/`、`.workflow/`、`.gitee/`；`scripts/` 仅有 dev-up/compare/smoke | 全量新建部署物 |
| E14 | 本机 age/caddy 缺失，sqlite3 CLI 有 | `which age` 无；`which caddy` 无；`sqlite3` 3.51 在 | age 属外部二进制随发布物 `bin/`；备份不依赖 sqlite3 CLI |
| E15 | JWT 现状是单一 7 天 token | `apps/api/src/auth.ts:34` `TOKEN_TTL_SEC=7d` | access/refresh、tokenVersion 属 M2/M6，**不在 M0**，勿误做 |
| E16 | vite 代理不含 /mcp | `apps/web/vite.config` 仅代理 /api、/health、/uploads | Caddy 需预埋同域 /mcp（路由 M6 才落） |
| E17 | 上传目录是相对入口拼的 | `index.ts:30` 与 `auth.ts:15` 各用 `path.resolve(__dirname,"../uploads")`；嵌套 dist 下会指到 `dist/apps/api/uploads`（错位）；扁平 dist 下指向 `apps/api/uploads`（正确但应可配） | M0 抽 `GX_DATA_DIR`/`UPLOAD_ROOT` 单一来源 |
| E18 | db.ts PRAGMA 为悬空 promise | `apps/api/src/db.ts:34-37` `void prisma.$queryRawUnsafe(...).then(...).catch(()=>{})` import 即跑（含测试） | M0 不动它；readyz 用独立 better-sqlite3 探针，避免耦合 |

**阻断项（必须最先处理）**

- **B0（隐藏，最高优先）**：生产可运行构建（对应切片 S2）。没有它，S8/S9 的 systemd、部署、回滚无从验收。旧 ARCH §6 P0 与 systemd 单元默认"`node dist/` 可用"，与现状不符。
- **B1**：根测试命令修绿（S0），否则 CI 无门禁可言。

---

## 2. M0 切片总览与顺序

切片按依赖排序，每片**可独立提交、独立验收、单独回滚**。建议一一切片单独 PR，严禁合成巨型改动。每片完成后都要复跑 270（M0 新增测试后为 270+N）并在 PR 描述记录数字。

| 切片 | 标题 | 主要触碰 | 对 270 影响 | 依赖 |
|---|---|---|---|---|
| S0 | 基线留证 + 修根测试命令 | web package.json | 无（仅放宽空测试） | — |
| S1 | 版本单源 | 新增 version.ts；改 index.ts/health.ts | 无（无测试断言版本字面值，已核对） | — |
| S2 | **修生产构建（esbuild 扁平产物）+ 脚本补全**（B0） | api 构建链路、package.json | 无（typecheck 仍用 tsc） | S1 |
| S3 | 配置/环境启动闸门 | 新增 config.ts；改 index.ts/auth.ts | 无（test 环境放行，已核对 NODE_ENV=test） | S2 |
| S4 | /healthz 与 /readyz 契约 | 新增 ops 路由；改 health.ts/index.ts、dev-up、vite | 无（新端点） | S1、S3 |
| S5a | 安全响应头 + 请求体上限 + 错误信封收口 | 新增 middleware；改 index.ts/guards.ts | 无（测试不经 app） | S3 |
| S5b | 认证限流（内存固定窗） | 新增 middleware；挂到 auth 路由 | 无（测试不发 HTTP） | S5a |
| S5c | 审计日志目录与轮换 | 新增 audit 模块 + logrotate 片段 | 无（纯函数可单测） | S3 |
| S6 | 在线备份 + age X25519 加密 + 保留 + 恢复演练 | 新增 ops/backup、scripts、runbook | 无（独立脚本） | S2、S3 |
| S7 | 平台中立 CI 脚本 + Gitee Go 模板 + migrate 干跑 + 真 lint | 新增 eslint 配置、ci 脚本、.workflow | 无（门禁本身） | S0、S2、S6 |
| S8 | 裸机部署物（systemd/Caddy/部署回滚/打包/env 模板） | 新增 deploy/ 全套 | 无（仓外交付物） | S2、S3、S4、S6 |
| S9 | ADR 与 runbook 归档 | docs | 无 | 随 S6/S8 |

> S5a/S5b/S5c 拆成三片，便于各自独立验证与回滚；如人力紧张，S5c 可与 S5a 同 PR，但提交粒度仍分开。

---

## 3. 切片明细

### S0 — 基线留证 + 修根测试命令

**现状证据**：E6（`pnpm -w test` 红，web 0 测试文件）；基线 api 214（8 文件）、shared 56（4 文件）实测全绿。

**新增/改动文件**
- 改 `apps/web/package.json`：`"test": "vitest run --passWithNoTests"`（对齐 ARCH R6；web 暂无单测属事实，M0 不补 web 测试）。
- 新增 `docs/baseline/2026-09-13-m0-baseline.md`：记录留证命令与输出摘要（270 全绿、Node/pnpm/Hono/Prisma 版本、git commit），作为后续每切片回归对照。

**实施要点**
- 不删除 api/web 的 `test:e2e`（playwright 另有用途），但 CI 不调用；仅把"无测试即失败"这一假红消掉。
- api 与 shared-types 的 `vitest run` **不加** `--passWithNoTests`（它们有测试，必须保持严格）。

**独立验收命令**
```bash
pnpm -w install --frozen-lockfile
pnpm -w test        # 必须退出 0；api 214、shared 56 全绿，web "No test files" 但不再致命
pnpm --filter @gx/api test  | grep -E "Tests "   # Tests 214 passed
pnpm --filter @gx/shared-types test | grep -E "Tests "  # Tests 56 passed
```

**回滚**：还原 web package.json 一行；删除基线文档。

---

### S1 — 版本单源（根 package.json 唯一真源）

**现状证据**：E1（三处字面值：`index.ts:79`=0.2.0，`health.ts:15/:24`=0.1.0）。全仓搜索确认业务源码仅这三处版本字面（`kb.ts` 的 `version` 是文档版本号，勿动）。

**唯一真源**：根 `package.json` 的 `version`。禁止任何运行时响应再出现硬编码版本字面。

**新增/改动文件**
- 新增 `apps/api/src/version.ts`（单一职责，<50 行）：
  - 导出 `VERSION`。
  - 取值顺序：`process.env.GX_VERSION`（S2 构建期由 esbuild `define` 从根 package.json 注入）→ 开发/测试回退：从 `import.meta.url` 向上找到 `name === "gouxiangdb-v2"` 的 package.json 读取（tsx/vitest 下可靠）。
  - 找不到则 fallback 常量 `"0.0.0-dev"`，但**不吞错**，dev 下 console.warn 一次。
- 改 `apps/api/src/index.ts:76-92`：根路由 `version: VERSION`，删除 `"0.2.0"`。
- 改 `apps/api/src/routes/health.ts:15,:24`：两处都用 `VERSION`。
- 新增 `apps/api/src/__tests__/version.test.ts`：断言 `VERSION` 等于根 package.json 的 version（用 fs 读根 package.json 对照），且不是 0.2.0/0.0.0-dev 之外的游离值。

**实施要点**
- version.ts 不 import db/config，避免在打包/测试期引入副作用。
- S2 的 esbuild 用 `define: { 'process.env.GX_VERSION': JSON.stringify(rootPkg.version) }`，使发布产物不依赖仓库目录布局；dev/test 走上溯回退。

**独立验收命令**
```bash
pnpm --filter @gx/api typecheck
pnpm --filter @gx/api test
# 无残留硬编码（应只剩根 package.json 与各包 package.json 的版本声明）
grep -rn '"0\.2\.0"\|version: "0\.' apps/api/src || echo "no hardcoded runtime version"
GX_NO_LISTEN=1 NODE_ENV=development pnpm --filter @gx/api exec tsx src/index.ts
curl -fsS localhost:3001/api/health | grep -q "\"version\":\"0.1.0\""   # 与根 package.json 一致
```

**回滚**：还原 3 个文件、删 version.ts 与其测试。

---

### S2 — 修生产构建：esbuild 扁平产物 + 脚本补全（阻断项 B0）

**现状证据**：E2/E3/E4（tsc 嵌套产物、shared-types 裸 TS 导致 ERR_MODULE_NOT_FOUND、测试被编译进 dist）；已在 `/tmp` 与 `apps/api/dist-spike/` 实测 esbuild 打包产物**可直接运行**（`@gx/shared-types` 完全内化，产物中裸 `@gx/shared-types` 引用数 = 0），且在 apps/api 目录下外置运行时依赖正常解析。

**技术决策（立项落 ADR-0021；编号裁决：0011–0020 已由企业版架构 §10.4 分配给资源树→机器语言，esbuild 顺延 0021）**：生产构建用 esbuild 把入口打成**单文件 ESM `dist/index.js`**：
- **内化打包**：`@gx/shared-types`（内部源码，解决裸 TS 与嵌套 rootDir 问题）。
- **外置（external，不打包）**：`@hono/node-server`、`@prisma/client`、`hono`、`jose`、`zod`、`bcryptjs`，以及**原生模块 `better-sqlite3`（含 `.node` 二进制，严禁打包）**。
- `platform=node`、`format=esm`、`target=node20`、`bundle=true`、`sourcemap`（生产可开 inline hidden，M0 先关）。
- `tsc` 保留为**类型检查器**（`typecheck: tsc --noEmit`），不再承担产物编译。

**新增/改动文件**
- 新增 `apps/api/scripts/build.mjs`（Node 脚本调 esbuild JS API，跨平台，不引 shell 工具）：
  - 读根 package.json 版本 → `define['process.env.GX_VERSION']`。
  - 清空并重建 `apps/api/dist`，只输出 `dist/index.js`（不输出 test）。
  - 构建后断言 `fs.existsSync('dist/index.js')`，失败退出非 0。
- 改 `apps/api/package.json`：
  - `"build": "node scripts/build.mjs"`（替换 `tsc`）；
  - 保留 `"typecheck": "tsc --noEmit"`；
  - `"start": "node dist/index.js"`（路径现在**真正成立**）；
  - 新增 `"db:deploy": "prisma migrate deploy"`、`"db:generate": "prisma generate"`（已有则保留）、`"backup:online": "node scripts/backup/online-backup.mjs"`（S6 落地，先占位不急于本切片）、`"lint": "eslint src"`（S7 落地）。
  - dependencies 提升 `"better-sqlite3": "13.0.3"`（从 devDependencies 移正，锁版本不升级）；devDependencies 增 `"esbuild": "0.28.2"`（该版本已在 pnpm-lock 内，frozen install 不漂移）。
- 改 `apps/api/.gitignore`（或根 .gitignore，已忽略 `dist/`，确认覆盖即可）。

**实施要点**
- esbuild 版本必须与 lock 内既有版本一致（核对为 0.28.2），避免 `--frozen-lockfile` 失配。
- 不内化 `@prisma/client`/`better-sqlite3`：发布包仍需裁剪后的 `node_modules`（含 Prisma query engine 与 better-sqlite3 预编译二进制，按目标 arch）。
- `prisma generate` 不进 build 脚本（产物外置），但 CI 在 install 后显式跑一次（S7）。

**独立验收命令**
```bash
pnpm -w install --frozen-lockfile
pnpm --filter @gx/api db:generate
pnpm --filter @gx/api build
test -f apps/api/dist/index.js && echo "flat artifact OK"
find apps/api/dist -name '*.test.js' | wc -l   # 必须为 0
grep -c "@gx/shared-types" apps/api/dist/index.js  # 必须为 0（已内化）
# 开发态可运行（不监听）
(cd apps/api && GX_NO_LISTEN=1 NODE_ENV=development node dist/index.js)  # 无 ERR_MODULE_NOT_FOUND
# fail-closed 仍在（干净 shell、显式删掉 JWT、且临时移开 .env 以排除 prisma 自动 dotenv）
(cd apps/api && mv .env .env.bak; env -u JWT_SECRET NODE_ENV=production GX_NO_LISTEN=1 node dist/index.js; \
  rc=$?; mv .env.bak .env; test $rc -ne 0 && echo "fail-closed OK")
pnpm --filter @gx/api typecheck && pnpm --filter @gx/api test   # 270 不受影响
```

**回滚**：还原 package.json/scripts，删 build.mjs 与 dist；恢复 `build: tsc`。

---

### S3 — 配置/环境启动闸门（fail-fast，先于 Prisma）

**现状证据**：E5（prisma 自动 dotenv 使 JWT 闸门在带 `.env` 机器上失效）；`auth.ts:26-31` 是当前唯一闸门且位置在模块图深处；配置散见 `index.ts:58(CORS)`、`:116(PORT)`、`db.ts`、`auth.ts`。

**目标**：启动时一次性校验，缺失/非法即打印聚合错误并以退出码 2 终止，**不监听端口、不连库**；区分必填/可选/默认。

**新增/改动文件**
- 新增 `apps/api/src/config.ts`（单一职责，<200 行；不 import `./db.js` 或任何会牵出 prisma 的模块）：
  - 导出 `config`（只读冻结对象）与 `validateConfig()`。
  - **必须作为 `index.ts` 的第一行 side-effect import**：`import "./config.js";`（ESM 深度优先求值，保证在 `auth.js→db.js→@prisma/client` 加载 dotenv **之前**完成校验）。
  - 环境分级：

| 变量 | production | development/test | 默认/说明 |
|---|---|---|---|
| `NODE_ENV` | 必填，=production | test/dev | vitest 实测为 test |
| `JWT_SECRET` | 必填，≥16 字符，且**拉黑两个开发默认值** | 缺省回落 dev 固定值 | 生产出现 `dev-secret-change-me-in-production` 或 `...gouxiangdb-v2` 一律拒绝（即使 .env 泄漏进包也 fail） |
| `DATABASE_URL` | 必填，必须 `file:` 前缀，**生产建议绝对路径** | `file:./dev.db` | 相对路径仅 dev；readyz/backup 需解析为绝对路径 |
| `CORS_ORIGIN`（或 `GX_PUBLIC_ORIGIN`） | 必填（生产禁裸跨域放行） | 缺省放行 localhost | 复用 `index.ts:58` 现有通配解析逻辑，迁入 config |
| `PORT` | 可选 | 3001 | |
| `GX_DATA_DIR` | 可选 | 派生 | 生产默认 `/var/lib/gouxiangdb`；dev 为 `apps/api` 下；`UPLOAD_ROOT=$GX_DATA_DIR/uploads`，单一来源替换 index.ts:30 与 auth.ts:15 两处重复 |
| `BACKUP_DIR` | 启用备份时必填 | `.db-backups`（仅本地） | 默认 `/var/backups/gouxiangdb` |
| `BACKUP_ENCRYPT_OFFSITE` | 可选 | true（生产建议） | =true 时 `AGE_RECIPIENT` 必填，否则备份任务 fail-loud |
| `AGE_RECIPIENT` | 条件必填 | 不需 | `age1...` 公钥收件人；identity 永不进本机 |
| `GX_OFFSITE_TARGET` | 可选 | 无 | rclone remote/挂载点；未配则加密件停留 spool 并告警（外部输入，见 §5） |
| `GX_MIGRATIONS_DIR` | 可选 | 解析 `../prisma/migrations` | readyz 对账用 |
| `GX_MIN_DISK_MB` | 可选 | 1024 | readyz 磁盘阈值 |
| `GX_AUDIT_DIR` | 可选 | `/var/log/gouxiangdb` | S5c |
| `GX_RATE_LIMIT` | 可选 | on；test=off | S5b |
| `GX_BODY_LIMIT_JSON` / `GX_BODY_LIMIT_UPLOAD` | 可选 | 1MB / 6MB | S5a |

  - 错误聚合：一次收集所有问题，`console.error` 多行可读清单（含变量名、原因），`process.exit(2)`。
- 改 `apps/api/src/index.ts`：首行 import config；用 `config.port/config.corsOriginPatterns` 替换散落读取。
- 改 `apps/api/src/auth.ts:26-31`：删除本地重复闸门，改从 `config` 取 `jwtSecret`（单一闸门），保留 fail-closed 语义（来源变为 config 已校验）。
- 改 `apps/api/.env.example`：补齐上述变量、注释必填/可选/默认与生产要求；顶部声明"`.env` 仅本地，生产用 EnvironmentFile，发布包不含 .env"。
- 新增 `apps/api/src/__tests__/config.test.ts`：用子进程方式（vitest `node:child_process`）验证：生产缺 JWT→非 0 退出且信息含变量名；生产用拉黑默认值→拒绝；test/dev 缺省可启动；合法配置通过。主进程内测试不触发副作用。
- 新增 `deploy/env.conf.example`（S8 用，本切片可先建模板）：600 权限说明注释。

**实施要点（关键）**
- 打包/发布**必须排除 `apps/api/.env`**（S8 打包脚本显式 exclude；`.env` 已在 `.gitignore:10`）。这是关闭 E5 的第二道闸：即使代码顺序万无一失，干净生产机也不应存在 dev `.env`。
- 配置校验纯函数化（输入 env 对象 → 错误列表），便于单测，不在函数里 `process.exit`，由入口决定退出。

**独立验收命令**
```bash
pnpm --filter @gx/api typecheck && pnpm --filter @gx/api test
(cd apps/api && mv .env .env.bak)
# 生产缺密钥：必须非 0
(cd apps/api && env -i PATH="$PATH" NODE_ENV=production GX_NO_LISTEN=1 node ../../node_modules/.pnpm/tsx@4.23.13/node_modules/tsx/dist/cli.mjs src/index.ts); echo "rc=$? (non-zero)"
# 生产用被拉黑的开发默认值：必须拒绝
(cd apps/api && env -i PATH="$PATH" NODE_ENV=production JWT_SECRET="dev-secret-change-in-prod-gouxiangdb-v2" GX_NO_LISTEN=1 node ../../node_modules/.pnpm/tsx@4.23.13/node_modules/tsx/dist/cli.mjs src/index.ts); echo "rc=$? (non-zero)"
# 合法生产配置：通过（不监听即正常退出 0）
(cd apps/api && env -i PATH="$PATH" NODE_ENV=production JWT_SECRET="$(openssl rand -base64 32)" DATABASE_URL="file:/var/lib/gouxiangdb/app.db" CORS_ORIGIN="https://gx.example.com" GX_NO_LISTEN=1 node ../../node_modules/.pnpm/tsx@4.23.13/node_modules/tsx/dist/cli.mjs src/index.ts); echo "rc=$?"
(cd apps/api && mv .env.bak .env)
```

**回滚**：还原 index.ts/auth.ts/.env.example，删 config.ts 与其测试。

---

### S4 — /healthz（liveness）与 /readyz（readiness）契约

**现状证据**：E9（仅 /api/health，失败泄漏 `String(e)`，版本硬编码）；E10（迁移 11）；E17（uploads 路径）；dev-up.sh:39 探测 `/api/health`；web vite 代理 /health。

**端点契约（M0 冻结，供 Caddy/systemd/监控对接）**

`GET /healthz` — 存活，**不查库、不鉴权**，进程事件循环活着即 200：
```json
{ "status": "ok", "service": "gouxiangdb-api", "version": "0.1.0", "time": "2026-09-13T00:00:00.000Z" }
```
HTTP 200（正常情况恒 200；仅进程将死才可能无响应）。

`GET /readyz` — 就绪，**不鉴权**，串行跑 5 项探针，全过 200，任一失败 503；响应只含布尔/版本/迁移名，**不含绝对路径、行数、异常堆栈**：
```json
{
  "status": "ready",
  "service": "gouxiangdb-api",
  "version": "0.1.0",
  "checks": {
    "dbPing": true,          // prisma SELECT 1
    "dbWritable": true,      // better-sqlite3 同库 BEGIN IMMEDIATE; ROLLBACK（非破坏 RW）
    "migrations": true,      // 已应用(finished 非 rolled-back) == 磁盘迁移目录数，且最新迁移名一致
    "uploadsWritable": true, // 在 UPLOAD_ROOT 写临时文件→rename→unlink
    "disk": true             // statfsSync 可用字节 >= GX_MIN_DISK_MB
  },
  "migration": { "applied": 11, "latest": "20260911233000_kbdoc_content_version" }
}
```
失败：HTTP 503，`status:"not_ready"`，失败项给短码（如 `"dbPing": "FAIL"`），`error` 仅短码字符串，**绝不回传 `String(e)`**。

**新增/改动文件**
- 新增 `apps/api/src/routes/healthz.ts`（liveness，极薄）。
- 新增 `apps/api/src/routes/readyz.ts` 与 `apps/api/src/ops/readiness.ts`（探针纯函数 + better-sqlite3 只读/瞬时写连接，<200 行；`dbWritable` 立即回滚不留数据）。
- 改 `apps/api/src/routes/health.ts`：失败分支去掉 `error: String(e)`，改短码；version 用 VERSION；标记为**兼容别名**（桌面壳/旧脚本可能仍探）。
- 改 `apps/api/src/index.ts`：根级挂 `app.route("/healthz",healthz)`、`app.route("/readyz",readyz)`；`/api/health` 保留。注意挂载位置：健康端点放在限流中间件之外（S5b 豁免清单）。
- 改 `scripts/dev-up.sh:39`：探测改为 `/healthz`（或先 /healthz 成功即可）。
- 改 `apps/web/vite.config`：proxy 增加 `/healthz`、`/readyz`（本地联调用；readyz 浏览器一般不用，加而无害）。
- 新增探针单测：mock better-sqlite3/prisma 的通过/失败两态，断言 200/503 与响应不含路径/堆栈。

**实施要点**
- readyz 用独立 better-sqlite3 连接（WAL 多连接安全，已实测并发 `.backup()` 无问题），与 db.ts 的 PRAGMA 悬空 promise 解耦（E18）。
- DB 路径解析：从 `DATABASE_URL` 取 `file:` 后段；生产绝对路径直接用；dev 相对 `file:./dev.db` 以 `apps/api/prisma` 为基准解析（与 Prisma 相对 schema 目录解析一致）。
- 探针总耗时目标 <50ms；`dbWritable` 拿不到写锁（BUSY）短暂重试一次再判失败。

**独立验收命令**
```bash
pnpm --filter @gx/api build && (cd apps/api && NODE_ENV=development PORT=3001 node dist/index.js &) ; sleep 1
curl -fsS localhost:3001/healthz ; echo
curl -fsS localhost:3001/readyz  ; echo        # 200 + 五项 true
curl -fsS localhost:3001/api/health ; echo     # 兼容别名仍 200
# 故障注入：把 DATABASE_URL 指向不存在目录后重启，readyz 应 503 且无路径/堆栈泄漏
# 磁盘阈值：GX_MIN_DISK_MB=9999999 重启，readyz 503、checks.disk=false
pnpm --filter @gx/api test
```

**回滚**：还原 index.ts/health.ts/dev-up/vite，删新路由/ops/测试。

---

### S5a — 安全响应头 + 请求体上限 + 统一错误信封

**现状证据**：无 helmet（且 helmet 面向 Express，不适用 Hono）；实测 Hono 4.13.5 自带 `hono/secure-headers`、`hono/body-limit`（import 成功，导出 `secureHeaders`/NONCE）；`guards.ts:98-108` 500 已不回传内部消息（生产），但 `index.ts:108` notFound 回显 path、无统一 code 信封；270 测试不经 `app`（直接调路由模块），全局中间件零影响。

**新增/改动文件**
- 新增 `apps/api/src/middleware/secureHeaders.ts`：包一层 `secureHeaders()`，显式开 `X-Content-Type-Options:nosniff`、`X-Frame-Options:DENY`、`Referrer-Policy:no-referrer`、`X-DNS-Prefetch-Control:off`、`Cross-Origin-*` 用宽松安全默认；**CSP M0 先不 enforce**（前端有内联/画板，贸然 CSP 易炸，先只由 Caddy 给基础头；CSP report-only 留待后续），HSTS 由 Caddy 在 TLS 侧给（应用在 HTTP 反代后不应发 HSTS）。
- 新增 `apps/api/src/middleware/bodyLimit.ts`：
  - 全局 JSON 默认上限 `GX_BODY_LIMIT_JSON`（默认 1MB），超限 413 统一信封；
  - 头像上传路由 `/api/auth/me/avatar` 单独放宽到 6MB（对齐 auth.ts:17 的 5MB 业务上限 + 余量）；M1 附件外置后再按路由放到可配上限。
- 改 `apps/api/src/index.ts`：在 cors 之后、路由之前挂 secureHeaders 与 bodyLimit；notFound/onError 收敛为统一错误信封（见下），不放行堆栈。
- 改 `apps/api/src/guards.ts` `errorResponse`：统一错误信封（保持现有 `{error}` 可读文案，新增机器码字段，且不破坏现有前端取值——前端取 `error`，新增字段为附加）：
  - 建议形如 `{ "error": "人类可读中文消息", "code": "FORBIDDEN" }`；500 生产仅 `{error:"服务器内部错误",code:"INTERNAL"}`，堆栈只进服务端日志（S5c）。
  - **不改变既有 HTTP 状态码与 `error` 文案**（避免前端回归），仅"增补 code + 收敛泄漏面"。
- 新增中间件单测：构造 Hono app 验证头存在、超限 413、错误信封无 stack。

**实施要点**
- 不引入 helmet 等 npm 运行时依赖（零依赖私有化交付）；不需要 NONCE（无 CSP）。
- body-limit 必须在 body 解析前；头像 multipart 单独策略，避免全局 1MB 卡掉既有 5MB 头像回归。

**独立验收命令**
```bash
pnpm --filter @gx/api typecheck && pnpm --filter @gx/api test
# 起服务后：
curl -fsS -D- localhost:3001/healthz -o /dev/null | grep -iE "x-content-type-options|x-frame-options|referrer-policy"
# 超限：构造 >1MB JSON
head -c 1100000 /dev/zero | tr '\0' 'a' > /tmp/big.txt
curl -s -o /dev/null -w "%{http_code}\n" -X POST localhost:3001/api/auth/login -H 'Content-Type: application/json' --data-binary @/tmp/big.txt  # 413
# 500/404 响应不含 'stack'/'at ... (' 痕迹
pnpm --filter @gx/api test   # 270+ 新增全绿
```

**回滚**：从 index.ts 摘下中间件、还原 guards.ts、删文件。

---

### S5b — 认证限流（单实例内存固定窗）

**现状证据**：无限流；单实例是硬约束（ARCH §4.1），无需 Redis；bcrypt cost=10（auth.ts:62）。

**新增/改动文件**
- 新增 `apps/api/src/middleware/rateLimit.ts`（<150 行，纯内存 `Map`，固定时间窗）：
  - 按 `路由组 + 客户端键` 计数。键：反代后仅信任来自 127.0.0.1 的 `X-Forwarded-For`（Caddy 同机），否则用 socket remote address。
  - 默认：登录/注册/改密 `/api/auth/(login|signup|change-password)` = 10 次/60 秒/键；其余 `/api/*` 兜底 600 次/60 秒/键（宽松到正常使用绝不触发）。
  - 豁免：`/healthz`、`/readyz`、`/api/health`、`/uploads`（静态）。
  - 超限 429 统一信封 + `Retry-After` 头。
  - 开关：`GX_RATE_LIMIT=off` 关闭；`NODE_ENV=test` 自动关闭（保 270）。周期清理过期键，避免内存增长。
- 改 `apps/api/src/index.ts`（或 auth 路由挂载处）：仅给 auth 子路由挂严格限流，全局兜底挂宽松限流。
- 新增单测：虚拟时间或直接调用计数纯函数，验证第 11 次 429、窗口重置、豁免路径不计。

**独立验收命令**
```bash
pnpm --filter @gx/api typecheck && pnpm --filter @gx/api test
# 连发 12 次错误登录，第 11/12 次应 429 且带 Retry-After
for i in $(seq 1 12); do curl -s -o /dev/null -w "%{http_code} " -X POST localhost:3001/api/auth/login -H 'Content-Type: application/json' -d '{"email":"x@y.z","password":"wrongpass"}'; done; echo
```

**回滚**：摘下限流中间件、删文件与测试。

---

### S5c — 审计日志（目录 + 轮换）

**目标（M0 最小集）**：关键安全事件落结构化 JSONL，文件目录 + logrotate 轮换；不含密码/token 明文/Authorization 头。M0 事件：登录成功/失败、注册、改密、注销账号、头像删除（可含）；分享创建/删除、数据导出、权限变更等随对应里程碑（M4/M6）接入同一个 emitter。

**新增/改动文件**
- 新增 `apps/api/src/audit/audit.ts`（<150 行）：纯函数 `formatAuditEvent()`（可单测）+ `writeAudit()`（append 到 `$GX_AUDIT_DIR/audit.logl`，目录缺失自动建，失败只 console.error 不阻断业务）。字段：`ts,event,actorId?,ip,method,path,status,detail?`，detail 内敏感字段白名单脱敏。
- 在 `auth.ts` 登录/注册/改密/注销成败点调用（成败都记，失败不含提交密码）。
- 新增 `deploy/logrotate/gouxiangdb.conf`：
  ```
  /var/log/gouxiangdb/audit.logl {
    daily
    rotate 14
    missingok
    notifempty
    compress
    delaycompress
    copytruncate
    create 0640 gouxiangdb gouxiangdb
  }
  ```
  用 `copytruncate`（应用以 append 打开，无需 reopen 逻辑）。
- systemd 服务标准输出/错误仍走 journald（应用访问日志），审计独立成文件。
- 新增 audit 纯函数单测（断言脱敏、JSON 每行一条、字段齐全）。

**独立验收命令**
```bash
GX_AUDIT_DIR=/tmp/gx-audit pnpm --filter @gx/api test
# 起服务做一次失败登录 + 一次成功登录，检查：
#   /tmp/gx-audit/audit.logl 两行 JSON，且无密码/token 字段
node -e "const l=require('fs').readFileSync('/tmp/gx-audit/audit.logl','utf8').trim().split('\n');l.forEach(JSON.parse);console.log('jsonl ok', l.length)"
grep -qiE 'password|authorization|bearer' /tmp/gx-audit/audit.logl && echo "LEAK" || echo "no secrets"
```

**回滚**：移除调用点与文件；logrotate 片段在仓外，删除即可。

---

### S6 — 在线备份 + age X25519 加密 + 保留策略 + 恢复 runbook

**现状证据**：E12（现有备份是危险多文件 cp）；E14（本机无 age）；已实测：
- better-sqlite3 `db.backup(dest)` 在 live WAL 库上成功，快照 `integrity_check=ok`，记录数与源库一致（108 records / 7 kb_docs 等），`_prisma_migrations(finished,非rolled-back)=11`；
- `fs.statfsSync` 可用；sqlite3 CLI `.backup` 同样可用但**不作为客户机依赖**。

**密钥模型（沿用 ARCH §5.3，已据工具事实选定）**：age **X25519 收件人模式**，不用口令对称模式（口令模式强制从 `/dev/tty` 读，cron 无 tty 无法无人值守）。
- 公钥 `AGE_RECIPIENT=age1...` 在备份机（env/600 文件），加密只用公钥，泄露公钥不危及备份。
- identity 私钥**离线保管，永不进生产/备份机、不进 cron env**；仅恢复时由 `AGE_IDENTITY_KEY` 临时注入，落 600 临时文件，`trap` 中 `shred -u`。
- age 为外部静态二进制（架构在 §5 外部输入核对 x86/arm），随发布物 `bin/age`；未启用异地加密时本地备份可完全不依赖 age。

**新增/改动文件**
- 新增 `apps/api/src/ops/backup.ts`（<250 行，纯逻辑，可单测）：解析 DB 绝对路径、better-sqlite3 在线 backup、快照校验（integrity/quick_check、迁移数、关键表计数）、manifest 生成、保留裁剪（纯函数部分可测）。
- 新增 `apps/api/scripts/backup/online-backup.mjs`（命令入口，`pnpm backup:online`）：
  1. 解析路径；`better-sqlite3` 在线 backup 到 `$BACKUP_DIR/daily/app-YYYYmmdd.db`（WAL 自动合并，不直接 cp 三件套）；
  2. 打开快照只读：`PRAGMA integrity_check='ok'`、applied 迁移数、关键表计数；
  3. 打包 uploads：`uploads-YYYYmmdd.tar`（目录缺失则跳过并标记）；对 db 与 tar 算 sha256；写 `manifest-YYYYmmdd.json`（含源 version、计数、哈希、时间戳）；
  4. 若 `BACKUP_ENCRYPT_OFFSITE=true`：`tar -czf - db uploads manifest | age -r "$AGE_RECIPIENT" -o offsite/spool/offsite-YYYYmmdd-HHMMSS.tar.gz.age`；**任何明文绝不写入 offsite 目录**；age 缺失/收件人缺失 → fail-loud 退出非 0；
  5. `GX_OFFSITE_TARGET` 已配则 rclone/rsync 推送并回读校验 sha256；未配则加密件留 spool + 警告（不阻断本地备份成功，退出码区分）。
- 新增 `apps/api/scripts/backup/verify-restore.mjs`：对一个（已解密的）恢复候选目录跑 integrity_check + 与 manifest 计数/哈希比对，输出 PASS/FAIL。
- 保留策略：本地每日 7 份 + 每周 4 份（ISO 周，周日另存 weekly），纯函数按文件名时间戳裁剪；加密异地件同策略或由远端生命周期管理（二选一，runbook 写明）。
- 新增调度：`deploy/systemd/gouxiangdb-backup.service` + `gouxiangdb-backup.timer`（每日 02:00，加载与 API 同一 env.conf，但其中**不含** identity）。
- 新增 `docs/runbooks/backup.md`（日常备份/排障）、`docs/runbooks/restore.md`（含解密与完整性校验的完整恢复）、`docs/runbooks/wal-crash-recovery.md`（WAL 损坏处置，禁止凭感觉删 -wal）。

**恢复 runbook 关键步骤（restore.md 摘要）**
1. 停 API（`systemctl stop gouxiangdb-api`）；取最近 `.age` 与对应 manifest；
2. `install -m 600 <(printf '%s' "$AGE_IDENTITY_KEY") /tmp/age.id`（`trap 'shred -u /tmp/age.id' EXIT`）→ `age -d -i /tmp/age.id offsite-x.tar.gz.age | tar -xz -C /tmp/restore`；
3. **先不覆盖现网**：`verify-restore.mjs /tmp/restore`（integrity_check + 计数/哈希对 manifest）；
4. 现网 db 与 `-wal/-shm` 整体挪到隔离目录（不直接删）；把校验通过的快照就位，解密 uploads 归位；
5. `prisma migrate deploy`（应为 no-op，核对到最新 11+N）；
6. 起 API，`curl /readyz` 全绿 + 20 条只读冒烟（沿用基线冒烟口径）+ 抽查附件可下载；
7. 演练：每季度一次，且**每半年至少一次完整走"加密异地副本解密恢复"**，记录入 runbook（防私钥丢失不可解密）。

**实施要点**
- backup 脚本对库只读/瞬时连接，不在业务库写任何东西；`.backup()` 目标为新文件。
- uploads 当前在 M0 仍是本地目录（附件外置是 M1）；M0 备份 uploads 整个目录即可，S3 后按引用反查（runbook 预留）。
- M0 验收可在**无 age** 情况下先验本地明文备份全链路（加密开关 false）；加密/异地链路的端到端演练依赖外部 age 二进制与收件人（§5 标外部，但脚本与 runbook 本地可写完）。

**独立验收命令**
```bash
pnpm --filter @gx/api typecheck && pnpm --filter @gx/api test
# 本地明文在线备份（不启用加密）
(cd apps/api && BACKUP_DIR=/tmp/gx-bak BACKUP_ENCRYPT_OFFSITE=false node scripts/backup/online-backup.mjs)
ls -la /tmp/gx-bak/daily ; test -f /tmp/gx-bak/daily/app-*.db
# 快照完整性 + 计数
sqlite3 /tmp/gx-bak/daily/app-*.db "PRAGMA integrity_check;"          # ok
sqlite3 /tmp/gx-bak/daily/app-*.db "SELECT count(*) FROM records;"    # 与源一致(当前 108)
# 加密链路（提供 age 与公钥后）：
#   age-keygen -o /tmp/age.key  (离线做一次，公钥 age1... 入 AGE_RECIPIENT，私钥离线)
#   BACKUP_ENCRYPT_OFFSITE=true AGE_RECIPIENT=age1... AGE_BIN=bin/age node scripts/backup/online-backup.mjs
#   file /tmp/gx-bak/offsite/spool/*.age   # 二进制 age，非明文 SQLite
# 恢复演练
#   AGE_IDENTITY_KEY="$(cat /tmp/age.key)" node scripts/backup/verify-restore.mjs /tmp/restore  # PASS
```

**回滚**：删 ops/scripts/systemd timer/runbook；备份为纯新增，不动业务库与既有代码。

---

### S7 — 平台中立 CI 质量脚本 + Gitee Go 模板 + migrate 干跑 + 真 lint

**现状证据**：E13（无 CI）、E8（lint 假绿）、E7（shared 无 build）、E10（deploy 干跑已实测 11/11、integrity ok）；远程为 Gitee 私有仓。

**设计原则**：唯一事实是**仓内平台中立脚本 `scripts/ci-quality.sh`**（任何 runner/本机都能跑）；Gitee Go 配置只负责"拉起 Linux + Node20/pnpm9 + 调脚本"。这样 Gitee Go 新旧两版 YAML 语法差异不影响门禁本身。

**新增/改动文件**
- 新增 `scripts/ci-quality.sh`（`set -euo pipefail`，可本地复现）：
  ```bash
  #!/usr/bin/env bash
  # 用法：bash scripts/ci-quality.sh
  # 1) 工具版本断言（engines: node>=20, pnpm>=9）
  # 2) pnpm -w install --frozen-lockfile
  # 3) pnpm --filter @gx/api db:generate
  # 4) typecheck（api + web + shared-types；无 "shared build" 这一伪步骤）
  # 5) pnpm --filter @gx/api build，然后 test -f apps/api/dist/index.js
  # 6) pnpm -w test          # S0 后全绿：api 214 + shared 56 + M0 新增
  # 7) pnpm -w lint          # 真 lint（见下），注入错误必须变红
  # 8) migrate deploy 干跑（不改业务库）：
       tmpdb="$(mktemp -d)/ci.db"
       DATABASE_URL="file:$tmpdb" pnpm --filter @gx/api exec prisma migrate deploy
       n="$(ls -1 apps/api/prisma/migrations | grep -v migration_lock | wc -l | tr -d ' ')"
       sqlite3 "$tmpdb" "SELECT count(*) FROM _prisma_migrations;" | grep -q "^$n$"
       sqlite3 "$tmpdb" "PRAGMA integrity_check;" | grep -q '^ok$'
       rm -rf "$(dirname "$tmpdb")"
  ```
  > CI runner 若无 sqlite3 CLI，第 8 步改用 Node one-liner 调 better-sqlite3（已在依赖）做断言；脚本内置两种实现，优先 better-sqlite3，不依赖 runner 装 sqlite3。
- 新增根 `eslint.config.js`（ESLint 9 flat config，eslint 9.39.5 已在根 devDep）：
  - devDependencies 增加 `typescript-eslint`（meta 包，仅 dev，锁定与 eslint9 兼容版本，写入 lock）；
  - 覆盖 `apps/*/src`、`packages/*/src`，用 `typescript-eslint` 的**非类型感知** recommended（避免全仓类型感知的海量告警）；
  - 规则基线：潜在 bug（no-undef 由 TS 接管关闭、no-unused-private 等）为 error，风格类为 warn；
  - 在 api/shared/web 三个 package.json 各加 `"lint": "eslint ."`（flat config 自动按 cwd 取根配置）；
  - **落地纪律（不制造大面积红）**：首次接入先在本机跑一遍，把现有告警全部校准为"基线警告数"，CI 用 `eslint . --max-warnings <基线数>`，保证当前树退出 0，但**新增告警会使门禁变红**；后续再逐步降基线。必须验证"注入一个未使用变量/语法错误时 lint 变红"，否则就是又一个假绿。
- 新增 `.workflow/ci.yml`（Gitee Go 模板，放仓内但顶部注释说明：**以仓库开通 Gitee Go 时控制台生成的 schema 为准，平台存在新旧两版语法；本文件仅示意，门禁真相在 ci-quality.sh**）。骨架（新版语法）：
  ```yaml
  version: '1.0'
  name: gx-ci
  displayName: GouXiangDB CI
  triggers:
    push:
      branches: { precise: [master, main] }
    pr:
      branches: { precise: [master, main] }
  stages:
    - stage: quality
      displayName: 质量门
      steps:
        - step: shell@1          # 以开通时实际可用的 shell/构建插件为准
          name: ci_quality
          displayName: install/typecheck/build/test/lint/migrate-dryrun
          inputs:
            nodeVersion: '20'
            goals: |
              corepack enable && corepack prepare pnpm@9 --activate
              bash scripts/ci-quality.sh
  ```
  并在文件注释附 GitHub Actions 等价写法要点（`actions/setup-node` + `pnpm/action-setup` + 同一脚本），但**不实际创建** `.github/workflows`（远程是 Gitee，避免死配置）。
- 新增 `docs/runbooks/ci.md`：runner 资源、缓存、PAT 开通、本地复现、Gitee Go 免费时长说明。

**Runner 资源与缓存**
- Linux x86_64，建议 2 vCPU / 4GB（esbuild + 将来 Playwright 够用）；Node 20 LTS、pnpm 9（corepack）。
- 缓存：pnpm store（key = `pnpm-lock.yaml` 哈希）；不接私服/远程缓存；私有仓需 Gitee Go 已开通并有可用 PAT/runner（外部输入，§5）。
- migrate 干跑只在 runner 临时目录，不碰真实库；不需要密钥（不连生产）。

**独立验收命令**
```bash
bash scripts/ci-quality.sh ; echo "ci rc=$?"   # 本地必须 0
# lint 真实性自证：
echo 'const __unusedProbe = 1;' >> apps/api/src/__lintprobe.ts
pnpm -w lint ; echo "expect non-zero" ; rm apps/api/src/__lintprobe.ts
```

**回滚**：删脚本/配置；还原三个 package.json 的 lint 行；根 lock 回退 typescript-eslint。

---

### S8 — 裸机部署物（systemd + Caddy + 部署/回滚 + 打包 + env 模板）

**现状证据**：E13（全无）、E2/E3（部署依赖 S2 产物）、ARCH §4.1/§4.2/§4.4/§4.6 已定拓扑（Caddy→systemd 单实例 Node→同机 SQLite+uploads）。Docker Compose 在 M0 **仅为可选探针**，不进必做（文末附探针清单，落地与否由 §5 外部事实决定）。

**目录约定（落 ADR-0003）**
```
/srv/gouxiangdb/
  current -> releases/20260920-1            # 原子切换
  releases/<ts>/
    api/   dist/index.js + prisma/{schema.prisma,migrations} + package.json + node_modules(pruned)
    web/   vite build 产物
/etc/gouxiangdb/env.conf                    # 600，属主 gouxiangdb
/var/lib/gouxiangdb/  app.db(+wal/shm)  uploads/{avatars,attachments}
/var/backups/gouxiangdb/                   # S6
/var/log/gouxiangdb/audit.logl             # S5c
```
生产 `DATABASE_URL=file:/var/lib/gouxiangdb/app.db`（绝对路径；env.conf 不入库、不进发布包）。

**新增文件（全部在仓内 `deploy/` 与 `docs/runbooks/`，可评审可回滚）**
- `deploy/env.conf.example`：全量变量模板，注释必填/默认；文件头注明权限 600、属主。
- `deploy/systemd/gouxiangdb-api.service`：
  ```ini
  [Unit]
  Description=GouXiangDB API
  After=network.target

  [Service]
  Type=simple
  User=gouxiangdb
  Group=gouxiangdb
  WorkingDirectory=/srv/gouxiangdb/current/api
  EnvironmentFile=/etc/gouxiangdb/env.conf
  ExecStart=/usr/bin/node dist/index.js
  Restart=on-failure
  RestartSec=3
  NoNewPrivileges=true
  PrivateTmp=true
  ReadWritePaths=/var/lib/gouxiangdb /var/log/gouxiangdb
  # 迁移不放 ExecStartPre：统一由 deploy.sh 在"先快照"后显式 migrate deploy，
  # 避免每次重启都自动迁移。

  [Install]
  WantedBy=multi-user.target
  ```
- `deploy/caddy/Caddyfile`（同域单端口，TLS；/mcp 预埋，路由 M6 才落）：
  ```
  {$GX_DOMAIN} {
      encode gzip zstd

      # 应用 API 与健康检查：同域反代到单实例 Node，不为 MCP 新开端口
      @api path /api/* /healthz /readyz /mcp /mcp/*
      reverse_proxy @api 127.0.0.1:3001

      # 附件/头像（M0 维持现状；M1 附件外置后改鉴权下载路由）
      reverse_proxy /uploads/* 127.0.0.1:3001

      # 静态 Web（vite build 产物）
      handle {
          root * /srv/gouxiangdb/current/web
          try_files {path} /index.html
          file_server
          header /assets/* Cache-Control "public, max-age=31536000, immutable"
      }

      # 上传体积第一道闸（与应用 body-limit 双保险；头像 6MB，预留余量）
      request_body {
          max_size 12MB
      }

      # TLS：公网域名用 Caddy 自动 HTTPS；内网/自签见 runbook（GX_DOMAIN + internal CA）
      # HSTS 仅在正式证书域名下开启
  }
  ```
- `deploy/bin/package-release.mjs`：在构建机产出 release 目录：
  - 跑 api 构建（esbuild 单文件）、web 构建（vite）；
  - 组装 `api/`（dist + prisma/schema.prisma + prisma/migrations + package.json + pnpm-lock 片段）→ 在 release 内 `pnpm install --prod --frozen-lockfile`（裁剪 dev 依赖；注意 better-sqlite3 已转 prod 依赖、按目标 arch 取预编译；交叉 arch 在 runbook 说明）；
  - 拷 web dist；生成 `checksums.txt`（sha256）；
  - **显式排除 `apps/api/.env`、`*.db*`、`*.log`、`.workbuddy`**（关 E5 第三道闸）。
- `deploy/bin/deploy.sh`（幂等，骨架）：
  1. 参数/环境检查（env.conf 存在、GX_DOMAIN 合法）；
  2. `curl -fsS 127.0.0.1:3001/readyz`（可选，确认当前健康）；
  3. **发布前强制在线快照**：`pnpm --filter @gx/api backup:online`（无快照不继续）；
  4. 解包新 release 到 `releases/<ts>`；校验 checksums；
  5. 在新版本目录用生产 env 跑 `prisma migrate deploy`（只增迁移；脚本中出现 `migrate dev` 直接拒绝退出）；
  6. `ln -sfn releases/<ts> current`（原子）；`systemctl restart gouxiangdb-api`；
  7. 轮询 `/readyz` 最多 30 秒；失败打印并**自动提示/执行回滚**；
  8. 成功打印旧 release 路径（保留最近 N 个供回滚）。
- `deploy/bin/rollback.sh`：`ln -sfn releases/<上一版> current` → restart → 轮询 readyz（30 秒级应用回滚）；数据回滚仅在迁移损坏时按 S6 restore runbook（常态"回应用不回数据"，因迁移只增兼容）。
- `deploy/systemd/gouxiangdb-backup.{service,timer}`：S6 调度（每日 02:00）。
- `docs/runbooks/deploy.md`：干净内网机从零装机步骤（建用户/目录、装 Node20+/Caddy、放 env.conf、首次 package release→deploy→readyz、证书来源选择）。
- **Docker 可选探针（不进必做，半天）**：`deploy/probe/docker-probe.sh` 只读探测 `docker`/`docker compose` 可用性、安装权限、OS/内核，输出 `docker-ready/docker-installable/docker-unavailable` 落部署清单；不安装任何东西、不写 compose 交付物（按 ARCH §4.6，compose 交付物在 P2/P3 且需客户接受）。

**实施要点**
- systemd `ExecStart=node dist/index.js` 只有在 S2 完成后才成立——这是 S8 依赖 S2 的原因。
- 单实例硬约束：不开 cluster/副本；Caddy 与 Node 同机，Node 只监听 127.0.0.1:3001（env 可绑回环）。
- 证书来源未定（公网域名自动 HTTPS vs 内网 CA/自签）是外部输入（§5），Caddyfile 用 `{$GX_DOMAIN}` 占位，两种路径 runbook 都写。

**独立验收命令（在一台干净 Linux 机/VM 上做一次，本地写不完的部分明确标注）**
```bash
# 构建机（本地可做）
node deploy/bin/package-release.mjs && ls -la release/ && shasum -a 256 -c release/checksums.txt
# 目标干净机（外部主机，按 deploy.md）：
sudo bash deploy/bin/deploy.sh --release release.tar.gz
curl -fsS https://$GX_DOMAIN/healthz
curl -fsS https://$GX_DOMAIN/readyz
sudo bash deploy/bin/rollback.sh ; curl -fsS https://$GX_DOMAIN/readyz   # 30 秒级回滚
bash deploy/probe/docker-probe.sh   # 记录 docker-* 三态
```

**回滚**：deploy/ 全为新增；停止/禁用 service、删 /srv 与 /etc 配置即完全撤销，不影响仓库代码。

---

### S9 — ADR 与 runbook 归档

**新增文件**
- `docs/adr/0003-...` 私有部署拓扑（Caddy + systemd 单实例 + WAL 单写者）。
- `docs/adr/0007-...` SQLite 在线备份 + 保留 + 季度恢复演练。
- `docs/adr/0021-api-esbuild-flat-bundle.md` API 生产构建改为 esbuild 扁平单文件、内化 `@gx/*`、外置原生/运行时依赖（记录为何 tsc 直出不可用）。编号用 0021：0011–0020 已由企业版架构 §10.4 分配。
- ADR-0009（部署双轨/探针）可仅建占位，正文随容器决策补。
- 汇总 `docs/runbooks/README.md` 索引（deploy/backup/restore/wal-crash/ci）。

MADR 格式：Status/Background/Decision/Consequences/Related。

**验收**：文档链接可达；与 S2/S6/S8 实际文件一致。

---

## 4. 对 270 基线的影响面与"不破坏"保证

| 触碰源 | 切片 | 为什么不破坏 270 |
|---|---|---|
| `index.ts` 加全局中间件 | S4/S5a/S5b | 8 个测试文件全部直接 import 路由/域模块（`routes/__tests__` 用 fake prisma 调 `pub.request`；`required-create` 直调域函数），**无任何测试 import `src/index.ts`**（已全仓核对），app 级中间件不在测试路径 |
| 配置闸门 | S3 | vitest 下实测 `NODE_ENV=test`，闸门对 test/dev 放行；生产 fail-closed 仅在真实进程 |
| 改 auth.ts JWT 来源 | S3 | 仅把常量来源迁到 config；签名/校验算法、7 天 TTL 不变；无测试断言 JWT_SECRET 字面值 |
| 改 health.ts | S4 | 无测试引用 /health 或版本字面值（已 grep 核对测试目录） |
| 改 guards.errorResponse | S5a | 只**增补** `code` 字段，HTTP 状态码与 `error` 中文文案不变，前端取 `error` 不受影响 |
| 构建 tsc→esbuild | S2 | `typecheck` 仍走 `tsc --noEmit`；测试仍由 vitest 用 tsx/esbuild 转译源码，与生产打包互不影响；打包不触碰测试文件 |
| 根 test 命令 | S0 | 只对"无测试的 web"加 `--passWithNoTests`，api/shared 保持严格 |

**每切片统一回归口令（PR 必贴）**
```bash
pnpm -w install --frozen-lockfile
pnpm --filter @gx/api typecheck && pnpm --filter @gx/web typecheck && pnpm --filter @gx/shared-types typecheck
pnpm -w test        # 计数只允许增加（新增 M0 测试），不允许任何既有 270 由绿转红
```
合并策略：任一切片让 270 中任意一条变红即阻断合并，先修切片不放行基线。

**M0 预计新增测试（基线从 270 → 约 270+25，具体以实现为准）**：version(1)、config fail-closed(4-5)、readyz/healthz(4)、secure/body-limit/error-envelope(3)、rate-limit(3)、audit 脱敏(2)、backup 纯函数/校验(4)。

---

## 5. 外部输入清单：可先行 vs 待外部

### 可先行（不依赖任何外部输入，本地即可做完并自测）
- S0、S1、S2、S3、S4、S5a、S5b、S5c 全部代码与测试；
- S6 备份脚本与 **本地明文备份 + 完整性校验 + 恢复到临时库**全链路（加密开关 false）；
- S6/S9 的 runbook、ADR；
- S7 的 `ci-quality.sh`、eslint 配置、`.workflow/ci.yml` 模板（本地跑脚本即验）；
- S8 的 systemd/Caddyfile/deploy/rollback/package 脚本与 Docker 只读探针（脚本可写完，真机部署待主机）。

### 待外部（不挡本地部分，单独跟进）
| 输入 | 用途 | 缺失时的降级 |
|---|---|---|
| Gitee Go 是否开通、PAT、用托管还是自建 runner（Node20/pnpm9/出网装 frozen 依赖） | S7 流水线真正亮起 | 脚本在本地/任意 Linux 可跑；先不亮灯 |
| 目标主机基线：是否统一 Linux+systemd、CPU 架构（x86_64/arm64，影响 better-sqlite3 预编译与 age 二进制）、OS 版本 | S8 真机部署、打包 arch | 先按 x86_64 打包 |
| 域名与证书来源：公网域名（Caddy 自动 HTTPS）还是内网 CA/自签；`GX_DOMAIN` | Caddy TLS | 先用 HTTP/自签在 VM 验证反代 |
| age X25519 收件人公钥 `age1...`（离线 `age-keygen` 生成，identity 客户离线保管）；age/rage 二进制（按 arch 随包） | S6 异地加密 | 先验本地明文备份；加密脚本与 runbook 先就位 |
| 异地备份通道（NAS/SMB/对象存储挂载）与 rclone 可用性/凭据；RPO 确认（默认每日 02:00，RPO 24h） | 异地推送 | 加密件留本机 spool + 告警 |
| 部署主机 SSH/账号、端口、备份窗口 | deploy.sh 真机执行 | 脚本先在 VM 演练 |
| 客户是否接受容器形态（配合 docker-probe 三态） | 决定 compose 是否在 P2/P3 投入 | M0 全程裸机，compose 不阻塞 |

---

## 6. M0 出口验收（Definition of Done）

1. 干净 checkout：`bash scripts/ci-quality.sh` 全绿（含 `dist/index.js` 存在、270+N 测试、真 lint、migrate 干跑 11/11 integrity ok）。
2. 在一台干净 Linux 机按 `docs/runbooks/deploy.md` 从零部署成功：systemd 单实例起来，`/healthz` 200、`/readyz` 五项 true，Web 同域可访问，/api 同域，无新开端口。
3. 完成一次备份→（在隔离目录）恢复→`migrate deploy`→临时实例 readyz + 只读冒烟 + 计数比对，`verify-restore.mjs` PASS；加密链路在拿到 age 公钥/二进制后补一次完整异地解密恢复演练。
4. 版本单源：根 package.json 改版本号，重建后 `/`、`/healthz`、`/readyz` 三处一致，仓内无运行时硬编码版本。
5. 生产缺 JWT/用开发默认密钥/缺 DATABASE_URL/CORS 时，服务启动即非 0 退出并打印明确变量清单；发布包不含 `.env`。
6. 安全头存在、超大请求 413、错误响应无堆栈/路径、登录暴力 429、审计 JSONL 可轮换且无密钥泄漏。
7. `deploy.sh` 失败可 `rollback.sh` 在 30 秒级回到上一 release，发布前在线快照确实生成。

---

## 7. 现状核对中发现的与旧 ARCH/Spec 不符之处（需主理人知悉）

1. **D1（最关键，旧 ARCH 漏判）**：ARCH §5.5/§6 与 systemd `ExecStart=node dist/index.js` 默认生产构建可运行，实际**不可运行**：`tsc` 因 `@gx/shared-types` path 引用把 rootDir 抬到 monorepo 根，产物在 `dist/apps/api/src/index.js`，且 shared-types 发裸 TS 无 build，真实产物 `ERR_MODULE_NOT_FOUND`。已实测 esbuild 扁平打包解决（S2，立项 ADR-0021，避开企业版 §10.4 已锁的 0011–0020）。这是所有部署切片的隐藏前置。
2. **D2**：版本漂移是**三处**不是一处——index.ts:79=0.2.0，health.ts:15 与 :24=0.1.0；ARCH §5.5 只点了 index.ts:79。
3. **D3（安全）**：auth.ts:26-31 的生产 JWT fail-closed 会被 `@prisma/client` 自动 dotenv 加载 `apps/api/.env` 静默绕过（实测 NODE_ENV=production 仍拿到 dev 密钥通过）。需让闸门先于 prisma 求值、拉黑开发默认值、发布包排除 .env（S3/S8）。
4. **D4**：Spec §12 的 `pnpm -w test`（基线 270 绿）**当前为红**——web 无测试文件致 vitest 退出 1。需 S0 加 `--passWithNoTests`（ARCH R6 提过，但 Spec 命令未修）。
5. **D5**：Spec §12 `pnpm --filter @gx/shared build` 是空操作——shared-types 无 build 脚本、发裸 TS。CI 应改为 shared typecheck；运行时由 S2 打包内化。
6. **D6**：Spec §12/ARCH 的 `pnpm --filter @gx/api lint` 与根 `pnpm -w lint` 都是**假绿**（无 lint 脚本、无 eslint 配置；仅 eslint 9.39.5 二进制在）。M0 要么写真门禁要么移除（S7 选写真门禁 + 基线告警数校准）。
7. **D7**：需求写 "helmet"，但 helmet 面向 Express 且未安装；Hono 4.13.5 自带 secure-headers/body-limit（实测可 import）。采用 Hono 原生件，零新增运行时依赖；限流用内存件、审计用零依赖 JSONL（ARCH §5.4 的 pino 降为可选，不进 M0 必做）。
8. **D8**：现有 `GET /api/health` 失败分支 `error: String(e)` 会泄漏内部异常；无 /healthz、/readyz。ARCH §5.4 提议路径是 `/api/health/ready`，本计划按主理人/Spec 口径统一为根级 `/healthz`、`/readyz`，并保留 `/api/health` 兼容别名（桌面壳在用）。
9. **D9**：ARCH §1.6 一处写"10 个手写迁移目录"，实际 **11 个**（含 20260911233000_kbdoc_content_version），readyz/CI 对账基线以 11 为准。
10. **D10**：`.db-backups/20260912-100746/` 是分别 cp 的 db/wal/shm + consolidated 多文件，非 WAL 一致性快照，不能作为既有备份能力，S6 从新建。
11. **D11（范围提醒）**：JWT 现状是单一 7 天 token（auth.ts:34）；Spec §4 的 access 1h/refresh ≥30d 与 ARCH §4.3 的 tokenVersion 属 M2/M6，**M0 不做**，避免膨胀。
12. **D12**：本机有 sqlite3 CLI 3.51，但客户机不保证有；备份/校验改用已锁定的 better-sqlite3（M0 由 devDep 提升为 dependency）。age/caddy 本机不存在，属部署机外部二进制。
13. **D13**：vite dev 代理未含 /mcp；Caddyfile 在 M0 即预埋同域 /mcp（应用路由 M6 才落），锁定"/mcp 与 /api 同域不新开端口"。
14. **D14**：db.ts PRAGMA 为悬空 promise 且 import 即跑（含测试）；M0 不改，readyz 用独立 better-sqlite3 探针以避免耦合，留待 M1 写纪律切片时一并收口。

---

## 8. 切片速查（供派工与 RoleVerdict）

| ID | 标题 | 关键新增/改动文件 | 独立验收（一句话） |
|---|---|---|---|
| S0 | 基线留证+修根测试 | apps/web/package.json；docs/baseline/2026-09-13-m0-baseline.md | `pnpm -w test` 退出 0，270 全绿 |
| S1 | 版本单源 | src/version.ts；index.ts:79；health.ts:15,24；version.test.ts | 三处响应版本=根 package.json，无硬编码 |
| S2 | 修生产构建(B0) | api/scripts/build.mjs；api/package.json(scripts/deps) | `build` 产出可运行 `dist/index.js`，无 test、无裸 @gx 引用 |
| S3 | 配置闸门 | src/config.ts；index.ts；auth.ts；.env.example；config.test.ts | 生产缺/黑名单密钥非 0 退出；test/dev 放行 |
| S4 | healthz/readyz | routes/healthz.ts、routes/readyz.ts、ops/readiness.ts；health.ts；dev-up.sh；vite.config | /healthz 恒 200；/readyz 五探针 200/故障 503 不泄漏 |
| S5a | 安全头/体积/错误信封 | middleware/secureHeaders.ts、bodyLimit.ts；index.ts；guards.ts | 头存在、超限 413、错误无 stack、270 不回归 |
| S5b | 认证限流 | middleware/rateLimit.ts；auth 挂载 | 第 11 次错误登录 429+Retry-After |
| S5c | 审计日志 | audit/audit.ts；deploy/logrotate/gouxiangdb.conf | JSONL 可解析、无密钥、可按日轮换 |
| S6 | 备份/加密/恢复 | ops/backup.ts；scripts/backup/*.mjs；backup.timer；runbooks | live 库 .backup 快照 integrity ok、计数一致、可恢复 |
| S7 | CI+真 lint+干跑 | scripts/ci-quality.sh；eslint.config.js；.workflow/ci.yml；各 pkg lint | `bash scripts/ci-quality.sh` 全绿；注入问题变红 |
| S8 | 裸机部署物 | deploy/{systemd,caddy,bin,env.conf.example}；runbooks/deploy.md | 干净机部署成功，readyz 绿，30 秒回滚 |
| S9 | ADR/runbook | docs/adr/0003,0007,0011；docs/runbooks/README.md | 文档与实现一致 |
