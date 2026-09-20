# ARCHIVE-LOG — 历史文档归档日志

## 这是什么 / 什么时候做的 / 机制是什么

- **是什么**：本文件是「构想工作台」仓库在实施 M0–M7 之后，对已完成的**里程碑实施计划**与**被后续报告取代的验收报告**做的一次集中归档索引。
- **时间**：2026-09-20（版本 `v0.1.7`，根 `package.json`）。
- **决策人**：项目总监；执行：文档整合 worker。
- **机制（重要）**：**删的是"散落位置"，不是"信息"**。
  1. 被归档的 **14 个文件全部保留一字未改的全文副本**，物理位置迁至 `docs/_archive/originals/`（文件名加目录前缀消歧，如 `planning-phase2-M0-implementation-plan.md`）。
  2. 原路径（`docs/planning/phase2/*`、`docs/acceptance/2026-09-19-*`）不再存在。
  3. 保留文档中指向它们的引用**已批量改链**到归档副本（ADR / baseline / decisions / runbooks / openapi，共 48 个文件）。
  4. **本文件（根目录 `ARCHIVE-LOG.md`）是这些副本的索引与摘要**，把每个文件里不可丢失的决策结论、实测数字、硬约束、踩坑记录以**原文摘录**方式固化下来。要查历史细节，先读本文件，再按"归档副本"路径打开全文。
- **不归档（仍在原位，未动）**：`M7-implementation-plan.md`（门⑦⑧在进行）、`PLAN-ADJUST-nas-min-hardware.md`（现行硬件姿态决策，被 ADR-0045 引用）、`S5b-hydration-projection-plan.md`（待启动项）、`docs/planning/phase1/*`、`docs/decisions/*`、`docs/adr/*`、`docs/baseline/*`、`docs/runbooks/*`、`docs/deployment/*`、`docs/design/2026-09-ui-restructure/_archive/*`。

---

## 一、总表（14 项）

| # | 原路径 | 归档副本（`docs/_archive/originals/`） | 字节 / 行数 | 最后 commit | 归档理由 | 继承者（现行权威） |
|---|---|---|---|---|---|---|
| 01 | `docs/planning/phase2/M0-implementation-plan.md` | `planning-phase2-M0-implementation-plan.md` | 59,673 / 753 | `fcaa221` 2026-09-13 | M0 已完成，出口基线已冻结 | `docs/baseline/2026-09-13-m0-baseline.md`；ADR-0003/0007/0010/0021；`docs/runbooks/{deploy,backup,restore,ci}.md` |
| 02 | `docs/planning/phase2/M1-implementation-plan.md` | `planning-phase2-M1-implementation-plan.md` | 69,991 / 649 | `be8838f` 2026-09-14 | M1 已完成，出口基线已冻结 | `docs/baseline/2026-09-13-m1-{baseline,gate,s10-gate}.md`；ADR-0008；`docs/runbooks/m1-sidecar.md` |
| 03 | `docs/planning/phase2/M2-implementation-plan.md` | `planning-phase2-M2-implementation-plan.md` | 71,523 / 621 | `32f7bea` 2026-09-14 | M2 已完成，出口基线已冻结 | `docs/baseline/2026-09-14-m2-gate.md`、`2026-09-15-m2-baseline.md`；ADR-0022/0023/0024；`docs/runbooks/org-contacts.md` |
| 04 | `docs/planning/phase2/M3-implementation-plan.md` | `planning-phase2-M3-implementation-plan.md` | 102,918 / 777 | `9b64cc6` 2026-09-15 | M3 已完成，出口基线已冻结 | `docs/baseline/2026-09-14-m3-baseline.md`；ADR-0025；`docs/api/openapi.yaml` |
| 05 | `docs/planning/phase2/M4-implementation-plan.md` | `planning-phase2-M4-implementation-plan.md` | 122,373 / 805 | `03195cb` 2026-09-15 | M4 已完成，出口基线已冻结 | `docs/baseline/2026-09-15-m4-baseline.md`、`2026-09-16-m4-{gate,exit}.md`；ADR-0032~0041；`docs/runbooks/authz-*.md` |
| 06 | `docs/planning/phase2/M5-implementation-plan.md` | `planning-phase2-M5-implementation-plan.md` | 88,860 / 789 | `0fc88ca` 2026-09-17 | M5 已完成，出口基线已冻结 | `docs/baseline/2026-09-16-m5-baseline.md`、`2026-09-17-m5-{gate,gate-tierL,exit}.md`；ADR-0042~0050；`docs/runbooks/m5-search.md` |
| 07 | `docs/planning/phase2/M6-implementation-plan.md` | `planning-phase2-M6-implementation-plan.md` | 75,801 / 490 | `411786c` 2026-09-14 | M6 已完成，出口基线已冻结 | `docs/baseline/2026-09-17-m6-exit.md`、`2026-09-18-m6-baseline.md`、`m6-connectivity.md`；ADR-0051~0055；`docs/runbooks/mcp.md` |
| 08 | `docs/planning/phase2/M4-FE-permission-ui-handoff.md` | `planning-phase2-M4-FE-permission-ui-handoff.md` | 9,657 / 118 | `071036b` 2026-09-15 | M4-FE 前端片已实施完毕 | 契约真源 `docs/api/openapi.yaml` + `packages/shared-types/src/policy.ts`；错误码 `docs/api/m4-error-codes.md` |
| 09 | `docs/planning/phase2/M4-readiness-check.md` | `planning-phase2-M4-readiness-check.md` | 28,357 / 272 | `e36699d` 2026-09-15 | 13 条必修 + 12 条建议已回填 M4 计划 r3 | `planning-phase2-M4-implementation-plan.md`（r3 正文）；`docs/baseline/2026-09-15-m4-baseline.md` |
| 10 | `docs/planning/phase2/spike-sqlite-vec.md` | `planning-phase2-spike-sqlite-vec.md` | 25,216 / 322 | `32f7bea` 2026-09-14 | 结论已被 M5 架构决策吸收 | ADR-0042 / 0044 / 0047 / 0050 |
| 11 | `docs/planning/phase2/spike-mcp-transport.md` | `planning-phase2-spike-mcp-transport.md` | 42,225 / 586 | `32f7bea` 2026-09-14 | 结论已被 M6 架构决策吸收 | ADR-0051 / 0053 / 0054 |
| 12 | `docs/acceptance/2026-09-19-ui-restructure-acceptance.md` | `acceptance-2026-09-19-ui-restructure-acceptance.md` | 19,835 / 254 | 未跟踪（工作区产物，未入库） | 被 09-20 报告取代 | `docs/acceptance/2026-09-20-editor-nav-remediation-report.md` |
| 13 | `docs/acceptance/2026-09-19-ui-restructure-defect-recheck.md` | `acceptance-2026-09-19-ui-restructure-defect-recheck.md` | 20,219 / 237 | 未跟踪（工作区产物，未入库） | 被 09-20 报告取代 | `docs/acceptance/2026-09-20-editor-nav-remediation-report.md` |
| 14 | `docs/acceptance/2026-09-19-p0-editor-canvas-recheck.md` | `acceptance-2026-09-19-p0-editor-canvas-recheck.md` | 4,758 / 51 | `9a6ef44` 2026-09-19 | 被 09-20 报告取代 | `docs/acceptance/2026-09-20-editor-nav-remediation-report.md` |
| 15 | `RELEASE.md`（2026-09-04 自测报告原内容） | `release-2026-09-04-self-test-report.md` | 6,311 / 104 | `de6f374` 2026-09-12 | 与「发版说明」文件名不匹配（版本早已是 0.1.7，读者会误当 Release Notes） | 根目录 **`RELEASE.md`**（已重写为 v0.1.7 发版说明） |
| 16 | `docs/AUDIT-2026-09-06.md` | `audit-2026-09-06-systematic-review.md` | 13,494 / 108 | `637eb9d` 2026-09-12 | 2026-09-06 四路系统性复盘，其「四、修复计划（本轮执行）」四批早已执行完毕；P0 结论已被 2026-09-11 全系统审计推翻性复验 | `docs/audits/2026-09-11-full-system-audit.md`；`docs/baseline/*`；根目录 `KNOWN-ISSUES.md`（146 条主表） |
| 17 | `docs/test-matrix.md` | `test-matrix-v1-v2-regression.md` | 8,389 / 163 | `637eb9d` 2026-09-12 | v1→v2 深度对比矩阵是 2026-09-04 的**空白模板**（全部条目仍为 ⏳，从未填写）；且 v1（SwiftUI）源码已不在仓库，无可比对象 | `docs/baseline/2026-09-12-regression-cases.md`；`docs/baseline/2026-09-18-m7-{checklist,gate-ledger}.md`；`KNOWN-ISSUES.md` |

> 字节/行数取自归档副本实读；commit 取自归档前 `git log -1 --format="%h %ad" --date=short -- <原路径>`。
> 第 16 / 17 项为 2026-09-20 第二轮归档（`docs/` 根目录散落文件清理）：原路径不在任何子目录，属零散堆积。
> 第 15 项副本为 **2026-09-04 原始正文的逐字节还原**（6,311 字节 / 104 行），未混入任何后期加注。

---

## 二、逐文件详情

### 01 · M0 生产基座实施计划

**① 讲什么**：M0（版本单源 / 配置闸门 / healthz-readyz / age 备份恢复 / CI / 安全收口 / systemd+Caddy 裸机部署物）的 S0–S9 十切片设计，含逐条现状证据行号核对。

**② 不可丢失的关键信息（原文摘录，数字未改）**
- 阻断项 B0 原文：`pnpm --filter @gx/api build` 产物是 `dist/apps/api/src/index.js`（嵌套路径），而 `start`/systemd 都调 `node dist/index.js`（文件不存在）；即便改调真实产物，也会因 `@gx/shared-types` 只发裸 TS 而 `ERR_MODULE_NOT_FOUND`。
- 版本三处硬编码互相矛盾：`apps/api/src/index.ts:79` = `"0.2.0"`；`apps/api/src/routes/health.ts:15` 与 `:24` = `"0.1.0"`；根 `package.json:3` = `0.1.0`。
- E5（隐蔽且高危）：实测 `import('@prisma/client')` 会自动 dotenv 加载 `apps/api/.env`，把里面的 `JWT_SECRET="dev-secret-change-in-prod-gouxiangdb-v2"` 注入 `process.env`，即使 `NODE_ENV=production` 且真实环境无该变量，校验也通过。
- 闸门顺序铁律：`import "./config.js";` **必须作为 `index.ts` 的第一行 side-effect import**（ESM 深度优先求值，保证在 `auth.js→db.js→@prisma/client` 加载 dotenv **之前**完成校验）。
- 拉黑清单（原文）：生产出现 `dev-secret-change-me-in-production` 或 `...gouxiangdb-v2` 一律拒绝（即使 .env 泄漏进包也 fail）。
- 测试基线：`api 214（8 文件）、shared 56（4 文件）`；根 `pnpm -w test` 必退出 0。
- 迁移基线：`prisma migrate deploy` 到空库实测 11/11、`integrity_check=ok`；readyz 迁移对账基线 = 11。
- 打包验收两条硬断言（原文）：`find apps/api/dist -name '*.test.js' | wc -l   # 必须为 0`；`grep -c "@gx/shared-types" apps/api/dist/index.js  # 必须为 0（已内化）`。
- 默认值表（原文摘录）：`GX_MIN_DISK_MB` 默认 `1024`；`GX_BODY_LIMIT_JSON` / `GX_BODY_LIMIT_UPLOAD` 默认 `1MB` / `6MB`；生产 `GX_DATA_DIR` 默认 `/var/lib/gouxiangdb`；`BACKUP_DIR` 默认 `/var/backups/gouxiangdb`。
- 环境实测版本：Node v22.22.2、pnpm 9.0.0、Hono 4.13.5、Prisma 5.22、better-sqlite3 13.0.3、sqlite3 CLI 3.51、esbuild 0.28.2。
- 选型结论（原文）：需求里写的 "helmet" 是 Express 中间件且未安装；实测 Hono 4.13.5 自带 `hono/secure-headers`、`hono/body-limit`。

**③ 与现行文档的关系 / 未继承内容**
- 已由 `docs/baseline/2026-09-13-m0-baseline.md` 与 ADR-0021（esbuild 扁平产物）、0003/0007/0010 继承。
- ⚠️ **未被继承**：E17 上传目录双份硬编码（`index.ts:30` 与 `auth.ts:15` 各用 `path.resolve(__dirname,"../uploads")`）与 E18（`db.ts:34-37` PRAGMA 悬空 promise）——两条在 M0 的结论是"M0 不动它"，后续无文档承接，属**待决遗留**。

---

### 02 · M1 数据底座实施计划

**① 讲什么**：M1 的 S0–S11 十二切片：写串行队列、只读 raw 网关 + keyset、sidecar DDL 与只写同事务维护、hydration 两阶段批量化、queryPlan 物理下推、keyset 接入、前端游标、压测脚手架、证伪门、出口收口。

**② 不可丢失的关键信息（原文摘录）**
- 最大放大点（原文）：**POST 创建（`records.ts:385`）与 PATCH 更新（`:590`）成功后都对整张表跑一次 `queryRecords(noPaging:true)` 再 `.find` 出本行**——这意味着"写一行 = 全表读 + 全表两轮 hydration"。
- trigram 实测（原文）：实测 trigram 对 **≥3 字符子串（含中文 3 字、拉丁 3 字符）命中**，但对 **2 字中文词（"订单""离职"）返回 0**。
- 假分页原文：默认 limit 200（`:150`），`hydrated.slice(offset, offset+limit)`（`:151`），翻页零节省。
- 两处 2000 行硬截断：`routes/records.ts:474-478`（`GET /api/records/search`）、`routes/search.ts:76-80`（统一搜索记录支路）。
- 写事务铁律（原文）：**回调体内只用传入 `tx`，不得再入队**（避免同事务自死锁）。
- 方言红线（原文）：所有 raw SQL **参数化**，禁止字符串拼用户输入；sidecar 用普通表（**不用 SQLite 专有的 `WITHOUT ROWID`**）。
- 列名陷阱（原文）：实际 DDL 列名是 Prisma 引号蛇形/驼形（`"tableId"`、`"createdAt"`、`"deletedAt"`），**手写 SQL 必须用引号列名**。
- 游标谓词（原文）：`("createdAt" > ? OR ("createdAt" = ? AND "id" > ?))`。
- 测试基线：api **261**（16 个测试文件）+ shared-types **56**（4 个文件）= **317**，"不许由绿转红"。
- 并发写对抗验收（原文）：并发 20 个 PATCH/创建，全部成功或按既有业务校验失败（4xx），不得出现 SQLITE_BUSY(5)。
- 语义口径不得近似（原文）：`evalFilter` 22 个操作符、空值恒排后、localeCompare `zh-CN,numeric:true`——SQL 下推必须与之**逐算符对拍**，对不齐的算符一律回退内存路径，不得"近似"。
- 三 flag（原文）：`GX_M1_WRITE_QUEUE`（默认 on 纯收口）/`GX_M1_KEYSET`(off→shadow→on)/`GX_M1_SIDECAR`(off→on，写维护常开、读由 S6/S7 切)。

**③ 与现行文档的关系 / 未继承内容**
- 已由 `docs/baseline/2026-09-13-m1-*`（含 `m1-s10-gate.md` 的证伪门判定）、ADR-0008、`docs/runbooks/m1-sidecar.md` 继承。
- ⚠️ **未被继承**：§11「与主理人所给锚点不符之处」的行号漂移对照表（旧 ARCH 行号 vs 实测行号）——纯考古价值，无现行文档承接；若将来要复核"为什么某条设计当初被改"，只有此处有据。

---

### 03 · M2 组织通讯录实施计划

**① 讲什么**：M2 的 S0–S9 十切片：工作区/部门/组织角色五表、tokenVersion 鉴权收口、部门树、成员多部门、角色授予求值、停用闭环、前端三栏、六层对抗、出口收口。

**② 不可丢失的关键信息（原文摘录）**
- AC-M2-1 选型的完整理由（原文）：`users` 表加 `tokenVersion` 整数列，JWT 携带 `tv`，鉴权热路径单行 PK 直查比对 + status 判定。不引 redis、不引会话表。单实例 SQLite 主键点查为微秒级，500 人规模无压力，**默认零缓存**以严格满足"下一次请求即 401"；另留 `GX_AUTH_STATE_TTL_MS`（默认 0）。
- 平滑升级条款（原文）：存量 7 天 token（无 `tv` claim）在升级后**不得被一律踢下线**——无 tv claim 视为 tv=0，与 users.tokenVersion 默认 0 相等即通过。
- 匿名外链边界（原文）：`GET /api/public/s/:token`（匿名公开外链）**不绑定任何用户**，停用某成员在语义上不应自动吊销一个匿名资源链接；"停用即吊销其创建的外链"不做。
- 写事务铁律（原文）：`withWriteTx` / `runWrite` / `withWriteBatch`，铁律"回调体内只用传入 tx，不得再入队"（`db.ts:111`）。
- 组织角色分层（原文）：`roles` 表播种 owner/creator/editor/commenter/viewer 五枚系统角色，但 M2 它们只承载**组织管理动作**（owner 持 manage_members/roles/departments）；资源内 c/r/u/d 动作位**不进** M2 的 roles.permissions。
- 查询收敛（原文）：禁止"逐部门/逐角色 N+1"，用 IN/join 收敛为定数查询（2~3 条）。
- 迁移纪律（原文）：**迁移只增**：users 只加可空列/带常量默认列；新表全新；不删列不改列类型；回填幂等可重跑。
- 部署铁律（原文）：部署前在线快照已由 M0 deploy 链路强制；回滚 30 分钟内（SPEC §4 铁律 :60）。
- 测试基线（原文）：**api 47 文件 598 passed / 3 skipped；web 2 文件 33 passed；迁移 12 个目录**。
- flag（原文）：`GX_ENTERPRISE_ORG`（默认 on，可 off 摘路由）。
- JWT 现状（原文）：`TOKEN_TTL_SEC` = **7 天**，HS256。

**③ 与现行文档的关系 / 未继承内容**
- 已由 `docs/baseline/2026-09-14-m2-gate.md`、`2026-09-15-m2-baseline.md`、ADR-0022/0023/0024、`docs/runbooks/org-contacts.md` 继承。
- ⚠️ **未被继承**：§5-D.5 关于匿名公开外链是否应随成员停用而吊销的**未决口径**——文中写明"归属 M4 分享治理或另行立项"，M4 未承接，现行文档无结论。**如需做分享治理，此条要重开。**

---

### 04 · M3 统一导航资源树实施计划

**① 讲什么**：M3 的 S0–S11 十二切片：nav_nodes 权威实体树 + menu_items 引用编排层两表、回填与对账、18 个实体写点同事务接线、tree/menu 读写 API、openapi 首版冻结、新工作区外壳、旧链兼容与 10 万节点性能、S11 部署链路 nav path 重算。

**② 不可丢失的关键信息（原文摘录）**
- 内容深链铁律（原文）：`/base/:id/table/:id/view/:id`、`/kb/:id/doc|canvas/:id` 永久有效，是被 Markdown 正文（`lib/internal-links.ts`）、画布引用卡（`DocRefCard`/`GxLinkBlockView`）、匿名公开分享（`/s/:token`）持久化存储的资源身份；**不引入 `/w/node/:id` 内容路径**，N5 用 SPA 别名实现旧外壳入口可达，**不做服务端 301**。
- nav 同步强一致（原文）：任何 nav 写失败整体回滚实体写，实体回滚也不留半截节点；**禁止 try/catch 吞错降级 best-effort**；reconcile 脚本仅作上线后兜底。
- 三层裁剪结论（原文）：①**建 view 节点、不建 field 节点**（建 field 节点只带来 ~10x 行数膨胀）；②**建 kb 节点**；③doc 层级在 nav_nodes 用 parentId 镜像 `kb_docs.parentId`，**默认菜单不嵌套复刻文档树**。
- 收纳口径（原文）：**S2 基线之后，运行期新建实体默认"未收纳"，不自动写任何 shortcut**（总监方案 A，ADR-0025）；菜单收纳的唯一运行期入口是 S6 菜单写 API（manage_menu 显式编排）。
- 对账分级（原文）：**阻断差异 = A/B/C1/C2/C3 计数全 0；C4/C5 为 warning 只报告**。
- 三态悬挂（原文）：活（alive）/ 软删悬挂 / 失效悬挂（资源物理消失：shortcut 标 `broken`，**仅管理编排态显灰**可清理，清理入审计）。
- 图标纪律（原文）：`components/icons.tsx:7-106` 为唯一 IconName 联合（100 枚）；**禁止第二套图标库、禁止 emoji**。
- 事务纪律（原文）：原语一律 `*Tx(tx, …)` 签名，回调内只用传入 tx（M1 铁律）；route 文件不得直接 prisma.navNode.*。
- 测试基线（原文）：**apps/api 51 文件 641 passed / 3 skipped、shared-types 4 文件 56 passed、apps/web 2 文件 33 passed；迁移目录 14 个**。
- flag（原文）：`GX_ENTERPRISE_NAV`（默认 on，test 默认 on），与 M2 的 `GX_ENTERPRISE_ORG` 正交。
- openapi 写实（原文）：按现网真实信封 `{error, code}`……**不切 `{code,data,message}`**。

**③ 与现行文档的关系 / 未继承内容**
- 已由 `docs/baseline/2026-09-14-m3-baseline.md`、ADR-0025、`docs/api/openapi.yaml` 继承。
- ⚠️ **未被继承**：裁决 6 的负面结论——**M3 不补 base/kb 软删恢复端点，全局回收站聚合列 P1 backlog**。现行无文档承接这条 backlog，属**易丢的待办**。
- ⚠️ **未被继承**：§4.4 的 18 条实体写点逐条清单（含"复制表不加快捷项"等条目级规则），现行只在代码里体现，无文档清单。

---

### 05 · M4 统一权限引擎实施计划

**① 讲什么**：M4 的 S0–S11 十二切片：旧三表 characterization、纯 allow 引擎纯函数与定数 SQL、旧三表投影回填、shadow 适配层、可见集 scope 接口、策略管理 v1 API、fieldMask 五出口、tree/menu 服务端剪枝 + 中断继承、openapi 增补、AC 对抗与规模门与翻转演练、出口收口。

**② 不可丢失的关键信息（原文摘录）**
- 三态 flag（原文）：新增 `GX_AUTHZ_ENGINE=off|shadow|on`，**代码默认 off（裁决 A-3）**；M4 出口**生产建议值 shadow**。
- drift 两类（原文）：**DRIFT_OVERDENY（旧 allow / 引擎 deny，误拦/可用性风险）** 与 **DRIFT_OVERALLOW（旧 deny / 引擎 allow，越权/安全风险，零容忍）**。
- 翻转纪律（原文）：on 后先跑**一个迭代反向 shadow**（引擎决策生效、旧结果只记录）；旧守卫决策分支**再保留两个迭代**才允许删除。
- 两形态契约（原文）：`resolveVisibleNodeIds(userId, action, kinds, opts)` 返回节点/资源 id 集合（带 budget，默认 **5000**，超限拒绝全量模式）与 `buildVisibleScopeSql(userId, action, resourceType)` 返回**参数化 SQL 片段 + 参数数组**。
- 最小泄漏定稿 A-4（原文）：① 主体对目标表有表级 r 但展示字段被 mask：title 回退 **record id**；② 主体对目标表**表级完全不可见**：LinkRef **不出现 id**；③ 对①类用户不得出现"无权限"字样——该措辞对无权者反证字段存在。
- A-6 定稿（原文）：**"父无权、子 direct 有权"**——权威树响应**不出现**该子节点位置；**子节点打开后的面包屑不得泄漏无权父节点名称**。
- 动作白名单真源（原文）：**唯一真源 = `packages/shared-types/src/org.ts:10-14` `OrgAction`（联合）+ `:16-21` `ORG_ACTIONS`（常量）**……禁止手改任何本地联合。
- 双 flag 挂载（原文）：`app.ts:146` **双 flag 条件挂载** `if (config.enterpriseOrg || config.enterpriseNav) mount.route("/api/v1", v1)`，两 flag 全 off 时整个 /api/v1 不挂载。
- 规模门（原文）：500 用户/**1 万节点**：单用户 scope 定数查询、P95 留证。
- 测试基线（原文）：M3 收口点 `f553641` = **api 84 文件 963 passed / 3 skipped**；M4-S0 后 = **api 86 文件 1008 passed / 3 skipped**；迁移目录 **17 个**（M4-S2 后 18，M4-S5 后 19）。
- 审计（原文）：`AuditEventName` 联合现 21 枚。

**③ 与现行文档的关系 / 未继承内容**
- 已由 `docs/baseline/2026-09-15-m4-baseline.md`、`2026-09-16-m4-{gate,exit}.md`、ADR-0032~0041、`docs/runbooks/authz-*.md` 继承。
- ⚠️ **未被继承**：`docs/runbooks/authz-engine-flip-on.md` 是否完整收录了 §4.8「翻 on 五条前置条件」的原文，需人工复核——本归档不替代该核对。

---

### 06 · M5 向量检索实施计划

**① 讲什么**：M5 的 S0–S14 十五切片：旧检索字节级 golden、outbox 同事务接线、SearchStore + vec0、chunk/RRF/查询规划纯函数、cloud/off embedding、indexer worker、路由门、先收敛后召回、fieldGrant、admin 六端点、AC 对抗、RRF boost、Tier-L 真机门、出口收口。

**② 不可丢失的关键信息（原文摘录）**
- 最高依据（原文）：`PLAN-ADJUST-nas-min-hardware.md §4`：**embedding 唯一默认来源＝远端 OpenAI 兼容 API；不内置/不默认安装本地模型**；cloud/off 两态半，local 降为未来可选 provider。
- 出厂默认（原文）：Embedding 两态半 `cloud | off`，**出厂默认 `off`**。
- 两层门（原文）：实施期 `GX_M5_SEARCH=off`……连续一迭代 drift=0 才 on；切 on 后 `GX_EMBEDDING_MODE` 出厂默认 `off`，cloud 必须管理员显式配置 + 二次确认才启用。**off 态零外网须抓包留证（S12）。**
- 性能门诚实口径（原文）：spike 在 Apple M5/16GB 实测 **100k×1536 维 KNN p95≈113ms、库 ≈592MB、RSS≈86MB**——**仅留档，绝不写进对外承诺**。**Tier-L 2C4G（x86 + arm 各一）真机实测后定档**……不给跨硬件硬 500ms 承诺。
- RRF 公式（原文，见 `apps/api/src/domain/search/__tests__/rrf-title-boost.test.ts:3` 引用）：「每路 score += 1/(60+rank)；标题精确等于 q / ……」。
- spike 硬事实 H4（原文）：KNN 必须带 `LIMIT`/`k=?`，否则报错；vec0 **无 ANN、暴力全扫**，EXPLAIN 恒 `SCAN ... USE TEMP B-TREE`，延迟随 chunk 数近线性。
- 立项目槛（原文）：chunk > **50 万**或目标机持续超标才立项 LanceDB。
- 唯一例外（原文）：M5 不得改 M2/M3/M4 文件，**唯一例外**：在 M3/M4 已登记的实体写点所在事务内**追加一行 outbox INSERT**。
- fpk 构建铁律（原文）：`deploy/fnos/build-fpk.mjs`：强制 Linux 同架构机/buildx 内安装、平台 prebuild 自检；vec0.so 照 better-sqlite3/prebuilds 同构显式拷入 + `file` 架构自检。
- 硬依赖（原文）：检索链路依赖 **M3-S1（nav_nodes）** 与 **M4-S4（`domain/authz/scope.ts` 契约冻结）+ M4-S1（engine.decide）+ M4-S6（fieldMask 五出口）**。

**③ 与现行文档的关系 / 未继承内容**
- 已由 `docs/baseline/2026-09-16-m5-baseline.md`、`2026-09-17-m5-{gate,gate-tierL,exit}.md`、ADR-0042~0050、`docs/runbooks/m5-search.md` 继承。
- ⚠️ **未被继承（重要）**：「开发机数字不冒充 NAS 承诺」这条**对外承诺纪律**——`docs/runbooks/m5-search.md` 仍把本计划标为「事实真源」（链接已改指归档副本）。**建议由专人把 runbook 真源改挂到 ADR-0042~0050**，否则运维文档长期指向归档区，语义别扭。

---

### 07 · M6 鉴权 MCP 服务实施计划

**① 讲什么**：M6 的 S0–S10 十二切片（含 C-2 追加的 S6b）：PAT 基座、传输骨架、双闸门适配、表/记录语言、文档块语言、画布只读 + stdio、画布六不变量 shared 校验器 + commit_elements、审计与幂等、三客户端连通、出口收口。

**② 不可丢失的关键信息（原文摘录）**
- 传输定稿（原文）：官方 `@modelcontextprotocol/sdk@1.30.0` 的 `WebStandardStreamableHTTPServerTransport` 与 Hono 直桥；**必须 `await server.connect(transport)`**（漏 connect 请求永久挂起，spike §1.2 实测踩坑）；无状态 transport 实例 SDK 硬校验不可跨请求复用。
- 三档限流（原文）：认证后 **patId 桶 120 次/60s**、认证前 **IP 预桶 300 次/60s**、PAT 管理 REST（/api/v1/pats）**30 次/60s/人**，三者均可经 `GX_MCP_RATE_*` 环境变量配置；超限 **HTTP 429 + Retry-After**。
- body 豁免（原文）：独立 `GX_MCP_BODY_LIMIT` 默认 **11MB**（对齐文档/画布 10MB + JSON 开销；实测 2MB 画布 call 在 1MB 下 413、11MB 放行）。
- 零限流现状（原文）：rateLimit.ts:71-78 `selectRule` 现状对 `/mcp` 不匹配任何规则（DEFAULT_RULE 只认 `/api/` 前缀），即**当前天然零限流**，M6 必须新增按 patId 的独立档，不留裸奔。
- PAT 与用户态联动（原文）：用户被停用 → 其全部 PAT **同事务批量 revokedAt** + 边缘 status 兜底双保险，下一请求即 401；用户物理删除 → FK `onDelete: Cascade` 带走 PAT。**改密码/tokenVersion 不杀 PAT**（PAT 是独立凭据，不比对 tv）。
- 工具全集（原文）：数据表 **8 个**、文档块 **4 个**、画布 = 只读 get_board + 最小写入 commit_elements。
- 未支持操作（原文）：**未支持的操作必须返回明确 `UNSUPPORTED_OPERATION` 错误，不得静默成功**。
- 幂等（原文）：键 = patId+tool+requestId，**24h 去重窗**，轻表只增，重启不丢。
- 规格铁律（原文，引 SPEC §10 :135）：op≤100/文本≤100KB/10MB/工具 **30s**/长任务 jobId。
- 门控（原文）：**C-5 定稿：/mcp 与 /api/v1/pats 同受此门控（off 即不挂载/404）**（`GX_ENTERPRISE_ORG`）。
- 挂载双路径（原文）：MCP 只要挂进 mount 即自动同时有 `/mcp` 与 `/app/gouxiangdb/mcp`（spike §2.1 实测路径不参与协议）。
- 真实成本（原文）：块模型纯函数 `mdToBlocks/blocksToMd` 当前在 **apps/web/src/features/kb/blocks.ts（993 行）** + markdown.ts（473 行），S5 须先下沉到 packages/shared——**这是文档语言切片的真实成本，不是零成本复用**。

**③ 与现行文档的关系 / 未继承内容**
- 已由 `docs/baseline/2026-09-17-m6-exit.md`、`2026-09-18-m6-baseline.md`、`m6-connectivity.md`、ADR-0051~0055、`docs/runbooks/mcp.md` 继承。
- ⚠️ **未被继承**：`docs/runbooks/mcp.md` 同样把本计划列为「实施计划」真源链接（已改指归档副本），**建议改挂 ADR-0051~0055**。

---

### 08 · M4-FE 权限 UI 派工输入清单

**① 讲什么**：M4 前端片的输入契约——后端已冻结的端点、DTO、错误码、门控纪律与五条硬约束。

**② 不可丢失的关键信息（原文摘录）**
- 五条硬约束（原文）：1. **只走 `api/client.ts`**，禁止新依赖、禁止第二套请求层；2. **全部 gx token**；3. **图标只追加 `apps/web/src/components/icons.tsx`**：禁第二套图标库、**禁 emoji 作功能图标**（团队 P0）；4. **禁紫到粉渐变**（团队 P0）；5. **禁 AI 模板味空文案**。
- 门控（原文）：后端总门 `AUTHZ_ENFORCE_READY` 在 S10 翻转演练前默认 false；**合入生产构建必须默认关闭**，等 S10 总监下令翻 on。
- 分页默认值（原文）：`count` 精确（不受分页影响）；`items` 按 userId 字典序分页（默认 **100**、上限 **200**）。

**③ 与现行文档的关系 / 未继承内容**
- 契约真源已在 `docs/api/openapi.yaml`、`docs/api/m4-error-codes.md`、`packages/shared-types/src/policy.ts` / `nav.ts` / `authz.ts`。
- ⚠️ **未被继承**：**"禁紫到粉渐变" / "禁 emoji 作功能图标" / "禁 AI 模板味空文案" 三条团队 P0 美学红线**——这三条规定在现行文档里没有独立成文的家，只有本 handoff 写了原文。**前端后续改 UI 时容易丢。**

---

### 09 · M4 开工前就绪核对

**① 讲什么**：对 M4 计划 r2（793 行）的只读核对，判定 verdict pass（附条件），列出 13 条必修（M1~M13）与 12 条建议（A1~A12）。

**② 不可丢失的关键信息（原文摘录）**
- 总裁决（原文）：**verdict：pass（附条件）**。M4 计划引用的核心机制在代码中全部成立，无"假设根本不存在"的阻断项。
- 统计（原文）：**阻断级 0 条；必须修正（命名/签名漂移）13 条（M1~M13）；建议修正（行号/计数漂移）12 条（A1~A12）**。
- 合流条件（原文）：M3-S5（tree/menu 读 API）当前以**未提交工作区改动**形态存在……**S2 及之后切片等 M3-S5/S6 提交收口、锚点复核后再派工**。
- 三处"按名查找不成立、但等价物存在"（原文）：`sharePolicyAllows`、`ISBLANK`、`purgeResourceNodeTx`，已在 M7/M11/M12 给出真实落点，不构成功能阻断。
- 挂载点结论（原文）：**M4 enforce 挂载点 = 适配层（guards.ts 五函数 + kb.ts 两函数体）内部，位于 `requireUserId/requireCanView` 已取得 userId 之后**，不新增全局中间件。
- schema 核对结论（原文）：**M4 对 auth_policies 的全部 schema 假设对得上**，只需加索引（S1 EXPLAIN 后定）不需改结构。
- 写点核对结论（原文）：**11 个写点全部存在、语义连续**；其中 4 处已在 M3 事务内，其余 7 处为裸写需 M4-S5 包裹。
- 新增 config（原文）：`apps/api/src/config.ts:182/:238` 新增 `enterpriseNav`（`GX_ENTERPRISE_NAV`），默认 on。

**③ 与现行文档的关系 / 未继承内容**
- 13 条必修已回填 M4 计划 r3 正文（`planning-phase2-M4-implementation-plan.md` 头部明确记载 "r3（2026-09-16）按 `M4-readiness-check.md`（e36699d，verdict pass）§4 的 13 条必修（M1~M13）+ 12 条建议（A1~A12）回填真实锚点"）。
- ⚠️ **未被继承**：A1~A12 是 12 条**建议**（行号/计数漂移），r3 只回填了 13 条必修；A1~A12 是否全部落实无现行文档证明。
- ⚠️ **现行依赖提醒**：`docs/baseline/2026-09-15-m4-baseline.md:8` 把本文当作「为准」的权威源引用（原文：`docs/planning/phase2/M4-readiness-check.md`（架构师 高见远，e36699d）为准，计划中的 kb 行号已过期），链接已改指归档副本。

---

### 10 · Spike：sqlite-vec + 统一检索只读可行性

**① 讲什么**：对 better-sqlite3@13 + sqlite-vec@0.1.9 的只读可行性验证（隔离目录 `/tmp/gx-vec-spike.70uqRs/`，未改仓库代码），判定【有条件可行】，给出 5 条决定 M5 设计的硬事实。

**② 不可丢失的关键信息（原文摘录）**
- 判定（原文）：**sqlite-vec 方案判定：【有条件可行】**……真正的约束在 **2C4G NAS 上的磁盘/内存带宽（1536 维全量暴力扫描）** 与 **跨架构 .so 打包/路径解析**。
- 硬事实 1（原文）：better-sqlite3@13 直接支持 `db.loadExtension()`，无需自编译、无需 `enableLoadExtension()`。实测 `typeof db.loadExtension === 'function'`、`db.enableLoadExtension === undefined`，`SELECT vec_version()` = `v0.1.9`。
- 硬事实 2（原文，高危）：better-sqlite3@13 把普通 JS `number`（含整数字面量）绑定为 SQL `REAL`，只有 `bigint` 绑定为 `INTEGER`……传 number 会报 `Only integers are allows for primary key` / `Expected integer ... received FLOAT`。**M5 写 vec0 的所有整数绑定必须用 `BigInt`**，否则整批事务回滚。
- 硬事实 3（原文）：vec0 KNN 强制要求 `LIMIT` 或 `k = ?`，否则报错 `A LIMIT or 'k = ?' constraint is required on vec0 knn queries`；检索为**暴力全表扫描（无 ANN）**，`EXPLAIN QUERY PLAN` = `SCAN v VIRTUAL TABLE ... USE TEMP B-TREE FOR ORDER BY`。100k×1536 在 M5 开发机 **p95≈113ms、RSS≈86MB、库文件≈592MB**；延迟随行数近线性。
- 硬事实 4（原文）：Prisma 主库与裸 better-sqlite3 打开的独立 `search.db` 同进程互不干扰、物理文件独立、扩展连接级隔离。search.db 可整文件删除重建。
- 硬事实 5（原文，供应链）：sqlite-vec npm 包按 `os`/`cpu` 拆 5 个平台子包，linux-x64 / linux-arm64 的 `.so` 齐全且仅依赖 glibc（x64 需 **GLIBC≤2.14**、arm64 **≤2.17**）；**动态链接 glibc，musl/Alpine 不兼容（无 musl 专版）**。入口符号按文件名推导（`sqlite3_vec0_init`），**分发时必须保留文件名 `vec0.so/.dylib/.dll`，改名即加载失败**。
- 环境（原文）：Node `v22.22.2`、宿主 `darwin arm64`（macOS 26.5.1，Apple M5 / 10 核 / 16GB，参考机非 NAS）；better-sqlite3 内建 **SQLite 3.53.4**。

**③ 与现行文档的关系 / 未继承内容**
- 五条硬事实已被 ADR-0042（拓扑）、0044（暴力 KNN 降级一等公民）、0047（trigram 门槛）、0050（供应链边界）逐条吸收。
- ⚠️ **未被继承**：硬事实 5 的**具体 glibc 版本上界（x64 ≤2.14 / arm64 ≤2.17）**与"改名即加载失败"这条打包铁律，ADR-0050 只引 §5 未抄数字；**打包/换镜像时请回本文件核对**。

---

### 11 · Spike：M6 MCP 协议与传输层可行性

**① 讲什么**：MCP Streamable HTTP 在 Node 22 + Hono 4 的落地验证、官方 SDK vs 手写对比、子路径/unix socket 反代、PAT、双闸门、越权三对抗、审计接入、OAuth 边界。

**② 不可丢失的关键信息（原文摘录）**
- 选型（原文）：**传输选型：推荐方案 (a)——官方 `@modelcontextprotocol/sdk`，但用它在 1.30.0 新增的 `WebStandardStreamableHTTPServerTransport`**……**不需要** `@hono/node-server` 的 `getRequestListener/nodeListener`。
- 实测踩坑 1（原文）：**全局 1MB body 上限会 413 杀掉合法 MCP 大 payload**：实测 2MB 的画布整板快照 `tools/call` 在 1MB 限制下返回 `413 PAYLOAD_TOO_LARGE`，放宽到 **11MB** 才 200。当前 `apps/api/src/middleware/bodyLimit.ts` 全局 `GX_BODY_LIMIT_JSON` 默认 1MB（`config.ts:22`）。
- 实测踩坑 2（原文）：SDK 的 SSE 响应自带 `X-Accel-Buffering: no`、`Cache-Control: no-cache, no-transform`；但无状态 JSON 模式是最简单、对反代最稳的起步形态，建议 M6 首版用**无状态 JSON**。
- connect 踩坑（原文）：`await server.connect(transport);  // ★必须 connect，否则 onmessage 无人消费、Promise 永不 resolve（实测踩坑）`。
- 三种客户端（原文）：① curl（裸 JSON-RPC）② 官方 SDK `StreamableHTTPClientTransport` 客户端 ③ MCP Inspector CLI；JSON 与 SSE 两种响应模式、根路径 `/mcp` 与飞牛子路径 `/app/gouxiangdb/mcp`、TCP 与 **unix socket 经模拟飞牛网关（注入 `X-Trim-Userid`）** 全部 200 连通。
- 越权三对抗（原文）：无/伪造 token → HTTP 401；过期 token → 401 `Token expired`；吊销 token → 401 且**已建立会话的下一请求立即 401**；IDOR 直传 `base_secret` → 工具可见、执行期 enforce 拦截，MCP `isError:true` + `FORBIDDEN_RESOURCE`；只读凭证绕过 tools/list 直调写工具 → `Tool xxx not found`（-32602，不泄漏存在性）。
- 手写方案代价（原文）：约 **300 行**且**协议升级（如 2025-11-25 无状态化、resumable streams）要自己跟**；SDK esbuild 生产 bundle 增量仅 **~1.4MB**（gzip 前，`--packages=external` 时产物只有 **8.4KB**）。

**③ 与现行文档的关系 / 未继承内容**
- 已被 ADR-0051（传输选型）、0053（双闸门与未知工具不泄漏）、0054（body 豁免与限流）吸收。
- ⚠️ **未被继承**：`X-Trim-Userid` 这个**飞牛网关注入头名**——只在本文出现，是子路径/unix socket 部署形态调试的关键线索，现行 runbook 未登记。

---

### 12 · UI 重构阶段 5 全页面验收报告（2026-09-19）

**① 讲什么**：对 UI 重构阶段 0–4（`3e6ef31`→`28289e5`→`faba404`→`6c25e87`→`f573112`）的自动化真机走查，结论「**有条件通过**」，报 9 条缺陷 D-1~D-9。

**② 不可丢失的关键信息（原文摘录）**
- 结论表（原文）：全部 24 类页面可访问、无白屏/无 ErrorBoundary 崩溃 ✅；主干交互链路 ✅；响应式断点 R-D-29~33 ⚠️ **R-D-30 / 31 / 32 三档不符合规范**；<768 档存在 P1 视觉破坏。
- 放行条件（原文）：修复缺陷清单中的 3 条 P1（窄屏工具栏竖排断行 ×2、分享链接路由缺失）与 3 条断点档位偏差后，对窄屏档位复验即可全量通过。
- D-1 P1（原文）：「新建记录」「行高」「筛选」「分组」「排序」「行颜色」等按钮文字**竖排两行断行**（每字一行），严重视觉破坏；<768 时顶栏全局搜索同样断行且未折叠为图标（违反 R-D-33）。
- D-2 P1（原文）：调 `POST /api/bases/:id/share` 得到 `url:"/share/<token>"`；**前端无 `/share/:token` 路由**，命中 `*` 兜底 → 重定向首页/登录页，新用户无法通过分享链接加入。
- D-5/D-6/D-7（原文）：R-D-30 视口 1366 L2 应压至 **208** 实测仍 240；R-D-31 视口 1152 L2 应可折叠为浮出面板，实测恒为静态 240；R-D-32 视口 900 应 L1 折叠 56 图标档、L2 浮出、表格转卡片列表，实测直接整体切换移动壳。
- 尺寸偏差（原文）：工具栏高 48；按钮高 32 → 主按钮实测高 **28**（D-8）；表头字号 12 → 实测 **13px**（D-9）。
- 色彩实测值（原文）：主按钮 `rgb(58,109,240)`（#3A6DF0，非 #378ADD）；L1 底 `rgb(233,239,249)`；L2 底 `rgb(244,248,253)`；表头/汇总条 `rgb(249,250,252)`；L1=224 / L2=240；L1/L2 导航项圆角 8。
- 环境（原文）：Chromium（Playwright 1234 revision / agent-browser 0.21.2 daemon），headless；视口主走查 1600×1000；断点档 1600 / 1366 / 1152 / 900 / 390；库含既有测试数据 **43 bases / 46 KB**。
- 环境干扰（原文）：验收期间存在**另一个并行自动化会话**，导致 `test@gx.dev` 的 tokenVersion 由 2 递增至 8（其 JWT 全部失效，表现为多次 401→登出）。

**③ 与现行文档的关系 / 未继承内容**
- 已被 `docs/acceptance/2026-09-20-editor-nav-remediation-report.md`（55,935B）取代；D-1/D-3/D-4 经复验证伪。
- ⚠️ **未被继承（重要）**：**§8「未覆盖项」11 条如实声明**——含 ⌘K 快捷键、`/join/:token` 匿名加入全流程、`/invite/:token` 激活提交、L4/L5 危险确认、骨架屏 R-D-25/26、局部刷新进度条 R-D-27、长任务进度浮层 R-D-28、**R-D-34 可读性（4.5:1 对比度、32×32 点击区）未系统性测量**、移动端抽屉展开态、**多视图类型页（看板/日历/画廊/表单）本库仅有网格视图未覆盖**。这些"没测过什么"的清单是后续验收排期的关键输入，09-20 报告未逐条继承。
- ⚠️ **未被继承**：D-8（按钮高实 28 / 规范 32）与 D-9（表头字号实 13px / 规范 12）两条**尺寸令牌偏差**——属设计令牌层面的实测偏差，未见到承接条目。

---

### 13 · UI 重构缺陷复验报告（2026-09-19，独立 QA）

**① 讲什么**：对上一份报告 D-1~D-5 的独立复验（不同人、独立 session、git 考古 + DB/API 直查三角验证）。

**② 不可丢失的关键信息（原文摘录）**
- 总裁决表（原文）：D-1 P1 路由 404 → **误报**（404 为 API 404 非路由 404）；D-2 P1 工具栏多三按钮 → **需重定级 + 重定性**（非本轮重构引入，属遗留规范收敛项，降为 P3 遗留待定）；D-3 P2 → **误报**（gate 只存在于 `/join/:token`）；D-4 P2 → **误报**（自动化脚本伪影，四步全通）；D-5 P2 → **属实但属"未覆盖"而非缺陷，本轮补做全通过**。
- 总结论（原文）：**5 条缺陷中 3 条为误报（D-1/D-3/D-4），1 条需重定性（D-2），1 条为未覆盖项且补验通过（D-5）。原报告的「有条件通过」在缺陷层面可以收敛为：无一条本轮重构引入的 P1 缺陷**；本轮复验另发现 1 个真实但低危的 P3（非 owner 空白分区）与 2 个 P3 级可访问性观察。
- 自相矛盾取证法（原文）：原报告称"页面空白、console 报 404"，但其交付截图 `q5-19-ws-settings-search.png` **明确显示该页完整渲染**……截图与报告文字直接矛盾。
- 新发现 P3（原文）：非 owner 直访该 URL 会得到「空白右区」；定级建议 **P3**；建议改为 fallback 发生时渲染 general 内容（把守卫统一为 `effectiveSection`）或显示"无权限"空态。
- P1 定义收窄（原文）：**P1 的定义应保留给"本轮重构引入的、阻断使用的缺陷"**——本条两条都不满足。
- 附带可访问性观察（原文）：Modal 缺 `role="dialog"`/`aria-modal`/焦点圈禁。
- 可选 UX 增强 P3（原文）：`alreadyMember=true` 时自动跳转 `/base/:id` 省一次点击。

**③ 与现行文档的关系 / 未继承内容**
- 结论（零新增缺陷）已被 09-20 报告吸收。
- ⚠️ **未被继承**：**"新发现 P3：非 owner 空白分区（effectiveSection 守卫口径）"**——这是复验**新发现**的真实缺陷，原报告没有，09-20 报告未见承接条目。**属最易丢失的一条。**
- ⚠️ **未被继承**：**"Modal 缺 role="dialog"/aria-modal/焦点圈禁"可访问性观察**，无现行承接。
- ⚠️ **未被继承**：**"P1 的定义应保留给本轮重构引入的、阻断使用的缺陷"** 这条定级方法论——后续分级时若无人记得，会把历史遗留 debt 反复误升 P1。

---

### 14 · P0 编辑器/画布五处缺陷复验记录（2026-09-19）

**① 讲什么**：对 `docs/design/2026-09-19-editor-nav-remediation/PLAN.md` §一 P0（⑤①②④a④b）的真机逐条复验，21/21 断言通过。

**② 不可丢失的关键信息（原文摘录）**
- 逐条结论（原文摘录）：⑤ 画布路由下 L2 停在「画布」tab（`aria-selected=true` 仅一处）；②a 拖拽中 plait 几何与卡片 FO 同步（**x 差 1px**），几何确实位移 **120px**（屏幕）；②a 一次 Cmd+Z 回到拖拽起点（**整段拖拽 = 一个撤销批次**）；④b 抽屉 `z=400`(`gx-z-drawer`)、`parentElement === document.body`；④a 二次确认弹窗 `z=860`（`gx-z-modal-nested`）；① 嵌入块热区 before top=**252**/h=**6**、after top=**402**/h=**6**，点击后块数 3→4→5。
- 数字基线（原文）：web 单测 639 passed / 50 files → **665 passed / 54 files**（+26 例 / +4 文件）；api 单测 **2243 passed / 209 files** 不变；`pnpm -w typecheck` 七包 Done；web lint 0 error / **114 warning**。
- 修法摘要（原文摘录）：⑤ `SecondaryNav.tsx:83-109,137-139,222` kbTab 从纯本地 state 改为**路由派生**；① 新增 `features/kb/wy-zones.ts`，热区判据从"邻块是否占用型"改为"邻块是否已给可输入空位"；② 新增 `canvas/link-drag.ts` + `canvas/board-guards.ts`，拖拽期逐帧写 plait（`withNewBatch` 首帧 + `withMerging` 后续帧）；④a `packages/design-tokens/src/layout.ts:80-84` 新增 z 档 `modalNested=860`；④b `VersionHistoryDrawer.tsx:128-133,305-312` 裸 `z-50` → `gx-z-drawer(400)` 令牌 + `createPortal` 到 `document.body`。
- 验收夹具（原文，为可复现保留）：画布 `P0-②验收画布`、文档 `P0-①验收文档`、文档 `P0-④验收文档`，建在「统一测试知识库」。
- 环境（原文）：本地 dev（vite 5173 + api 3001），账号 `test@gx.dev`（owner），Chromium **1440×900**；脚本已按纪律删除。

**③ 与现行文档的关系 / 未继承内容**
- 已被 09-20 报告取代。
- ⚠️ **未被继承**：**「统一测试知识库」里的三个可复现验收夹具（P0-①/②/④）**——文档没说这些夹具是否保留/清理。将来复验 P0 画布行为时，这是唯一记录了夹具名与构造方式（含 6 张关联卡 + 脑图 + 连线）的地方。

---

### 15 · RELEASE.md 旧内容：2026-09-04「第二轮 6 类问题修复自测报告」

**① 讲什么**：2026-09-04 单轮迭代的自测报告——6 类问题（选项字段颜色 / 详情页布局编辑 / 数据关联字段 / 聚合字段 / 公式函数全集 / 业务逻辑综合）的修复记录 + E2E 验证表 + 单测数字 + typecheck + 已清理脏数据 + 交付用户自测清单。

**② 不可丢失的关键信息（原文摘录）**
- 文件头自带的**历史档案声明**（原文）：本文件是 2026-09-04 单次迭代的自测记录，保留原貌用于追溯，**不是当前部署 / 配置依据**。文中「DATABASE_URL 用绝对路径」「PostgreSQL」等说法均已过时——数据库已确定为 SQLite 且使用相对路径 `file:./dev.db`。
- 6 类问题结论（原文）：① 选项字段颜色淡 → ✅ 修复（`components/ui.tsx` Badge `variant = "solid"` + 实色背景 + 白字）；② 详情页布局编辑 → ✅ 修复（移除 1/2/3 选项卡，新增 `DetailLayoutEditor` 支持拖拽换序 / 行内 1-4 列 / 长字段跨整行）；③ 数据关联字段 → ✅ 修复（`recordFilter` 子集筛选，反向关联级联对称软删）；④ 聚合字段 → ✅ 修复（count 改走 `resolveLinkedPeerIds + getRecordsByIds + evalFilter`）；⑤ 公式函数全集 → ✅ 验证；⑥ 业务逻辑综合修复（`FieldDTO` 补 `recordFilter` 序列化）。
- E2E 实测（原文）：T1/T2/T3 聚合 recordFilter 三条全 ✅；公式 `{VIP客户数}*2`=4、`{VIP客户总数量}+10`=160 全 ✅。
- 单测（原文）：`formula.test.ts` 43 + `formula-functions.test.ts` 82 + `record_filter.test.ts` 5 + `hydrate.test.ts` 20 = **Test Files 4 passed / Tests 150 passed**。
- typecheck（原文）：后端 0 错误（修复 5 处 `detailLayout` 重复属性 + 1 处测试误用 `.then`）；前端 0 错误。
- **关键修复（原文，易忘）**：v2 前序 **SEARCH 参数顺序错位**，回归测试已对齐 v1；`SEARCH(within, find)` 沿用 v1 约定。
- 测试账号（原文）：`verify@gx.local` 类账号、测试 E2E base `cmtmtf3wp001rd6fa9mz0mocz`（**25 字符 cuid，多写一个 t 会命中不到**）。
- 已清理脏数据（原文）：临时测试账号 `newverify*` / `verify3*` 已删除；误建记录（VIP-now 残留）已软删；`Customers_e2e` 测试表已软删。
- 遗留（原文）：分享 Share、多字段编辑（bulk update 已建但 UI 编辑器未做）、ERD 关系图。
- 约束（原文）：本轮未走 Release 打包流程，只做 Debug 构建重启供测试。

**③ 与现行文档的关系 / 为何归档**
- **归档原因**：文件名是 `RELEASE.md`（读者会当发版说明），但内容是 2026-09-04 单轮自测记录，而实际版本早已是 **0.1.7**，严重不匹配。2026-09-20 已把 `RELEASE.md` 重写为 v0.1.7 发版说明，旧正文整段迁来此处。
- 继承者：**根目录 `RELEASE.md`（v0.1.7 发版说明）**；已知问题改指向 `KNOWN-ISSUES.md`。
- ⚠️ **未被继承**：**「v2 前序 SEARCH 参数顺序错位，回归已对齐 v1（`SEARCH(within, find)`）」**——这条跨版本语义约定在新 RELEASE.md 里没有，现行仅存在于 `formula` 测试。改公式引擎前请回查。
- ⚠️ **未被继承**：**测试 E2E base 的 25 字符 cuid `cmtmtf3wp001rd6fa9mz0mocz` 及"多写一个 t 会命中不到"的坑**；以及三个已清理脏数据的记录（`newverify*` / `verify3*` / `Customers_e2e`）——若将来在库里发现同名残留，此处是唯一说明其来源的地方。

---

### 16 · 2026-09-06 四路系统性复盘报告（原 `docs/AUDIT-2026-09-06.md`）

**① 讲什么**：2026-09-06 的 4 路并行深度审计（前端 UI/交互、后端 API/数据、权限/隔离、模块架构），全部基于真实代码逐行阅读并附 `文件:行号`。按严重度三级出清单：**§一 严重问题（P0）= A1–A9 安全越权 + B1–B9 数据正确性 + C1–C8 前端崩溃/XSS/断链，共 26 条**；**§二 建议改进（P1）= D1–D24**；**§三 体验优化/规范（P2）= E1–E10**。末尾 §四 给出「修复计划（本轮执行）」四批。

**② 不可丢失的关键信息（原文摘录，数字未改）**
- 分级定义（原文）：「【严重问题】崩溃 / 数据丢失 / 越权 / 安全漏洞；【建议改进】功能缺陷 / 一致性 / 性能；【体验优化】规范 / 可维护性。」
- A1（原文）：「**JWT 无过期 + 密钥硬编码默认值** | `apps/api/src/auth.ts:10,37` | token 永久有效、无 exp；生产漏配 `JWT_SECRET` 时用公开默认密钥可伪造任意用户。整个认证体系可被绕过」
- A2/A3（原文）：「creator 在自己 Base 建 links 字段指向**别人 Base 的表**，服务端在受害者表内写反向字段，并经 hydrate/lookup 读回他人记录。跨租户数据泄露 + 结构污染」「editor PATCH 自己记录时 links 填**任意 Base 的 recordId**，即可链接并经 title/lookup/rollup 读出受害者记录内容。最直接 IDOR」
- A9（原文）：「**CORS 反射任意 Origin + credentials** | `apps/api/src/index.ts:21-28` | 任意网站跨域带凭证请求被放行。应白名单」
- B2（原文）：「**公式链式引用按字段顺序求值，拓扑排序是死代码** | `domain/hydrate.ts:164-170`（实际）vs `192-236`（computeFormulas 从未调用）| A 公式引用后序字段 B 时取到 null，结果随字段排列顺序变化。文件注释承诺的 Kahn 拓扑未接线」
- B3（原文）：「**脏 FilterNode 导致整表 500**……缺 children/child 时 `node.children.length` 抛 TypeError，冒泡到 app.onError，整表列表/详情全 500」
- B8（原文）：「**关键多表写操作无事务**：建表 `tables.ts:72-121`、建关联字段对 `fieldService.ts:167-206`、删字段级联 `370-401`、KB 文档+快照 `kb.ts:270-285,340-349` 等 | 中途失败留脏数据（有表无主字段、正反字段不互指、快照缺失）；快照并发撞 `@@unique([docId,version])` 500」
- D1（原文）：「**单条读/写触发全表 hydrate**：`records.ts:253,397,438` 改一个单元格就 `queryRecords({noPaging:true})` 全表水合再 find 一条……性能生命线。」
- D5（原文）：「**分享 token 用 Math.random()**：`bases.ts:343` 非加密安全，应 crypto.randomBytes。」
- D13（原文）：「**跨 feature 网状互引**：detail↔views↔designer↔drawer 互相 import 内部组件，field-controls 实为共享件却放在 views。」
- E3 超长文件 Top（原文，含行数）：「`FormDesigner 1684、WysiwygEditor 1197、formula.ts 943、DetailLayout 895、FieldEditorSheet 797、records.ts 750、GridView 685、ui.tsx 674、blocks.ts 621、hydrate.ts 614`。」
- E4 死代码（原文）：「`sidebar/BaseSwitcher.tsx`（零引用）、`kb-hooks.ts:135-144 useSaveDoc`、`useToast:18-25`、`void ROLES/tableId/useToast` 抑制语句、根目录 `_tmp_*`、`apps/web/_dist_bak/`、desktop 壳 `main.ts` 仅 void 0。」
- E5 markdown round-trip 有损六条（原文）：「表格单元格含 `|` 不转义错列；嵌套列表缩进丢失全变一级；有序列表原编号丢失；软换行 `<br>`→`\n` 语义消失；URL 含 `)` 截断；code/math 内含 ``` / $$ 提前闭合。」
- E10 类型断言（原文）：「前端 134 处、后端 63 处 `as X`，根因是 Prisma 字符串列无字面量类型；建议 db 边界 zod 解析。」
- §四 四批计划（原文）：「**第一批 · 后端安全/数据正确性（P0）**：A1 JWT、A2/A3 跨 Base 关联校验、A4 CSV 越权、A5 恢复越权、A6 KB owner 保护、A7 personal 视图、A8 bulk linkRow 收敛、A9 CORS、B1 唯一校验前置、B3 FilterNode 防御、B2 公式拓扑、B7 count 过滤、B6 subtable 归类、B9 搜索已删字段、D5 分享 token、D6 auth json 兜底。**第二批 · 前端崩溃/XSS/断链（P0）**：C1 键盘劫持、C2 IME、C3/C4 XSS 消毒、C5 ErrorBoundary、C6 record 跳转、C8 401 处理、D18 data-idx、D15 外链 target。**第三批 · 数据一致性（P1）**：B4 软删不硬删 linkRow、B5 bt 基数、B8 关键路径事务（择要）、D10 flush 走 client、D16 上传插入位置、C7 callout/toggle 守卫。**第四批 · 清理（P2）**：E4 死代码、E2 符号图标、E1 关键硬编码色。」「每批后跑 typecheck + 单测 + build 回归。」

**③ 与现行文档的关系 / 为何归档**
- **被取代的直接证据**：`docs/audits/2026-09-11-full-system-audit.md`（5 天后、范围更宽）在「二、问题清单（按严重度）」下原文写明：「**P0：本轮未发现可直接利用的越权/P0（鉴权 RBAC、bulk 写 first.tableId 收敛、link 目标校验、路径穿越拦截均在位）**」——即 A1/A2/A3/A8 这一组已被修复。
- 后续 M0–M7 全部完成，出口基线在 `docs/baseline/*`；现行缺陷主表为根目录 `KNOWN-ISSUES.md`（146 条，P0×24 / P1×48 / P2×44 / P3×30），本文的 P0 结论已不具现行效力。
- 全仓**零引用**（仅 `.workbuddy/memory/**` 有 2 处，按红线纪律未改）。

**④ ⚠️ 未被继承的信息**
- ⚠️ **E3 超长文件 Top 10 清单（含具体行数）**——现行无文档承接。这是唯一一份带行数的"技术债体量"快照，做重构排期时是现成的量化输入。
- ⚠️ **E5 markdown round-trip 六条有损清单**（`|` 不转义 / 嵌套列表缩进丢失 / 有序列表编号丢失 / `<br>`→`\n` / URL 含 `)` 截断 / code 与 math 提前闭合）——M6-S5 仅把 `blocks.ts`/`markdown.ts` 下沉到 shared，**无文档逐条登记这六条有损**。改块模型或做文档导入导出前必须回查。
- ⚠️ **E10 类型断言计数（前端 134 / 后端 63）与根因结论（Prisma 字符串列无字面量类型，建议 db 边界 zod 解析）**——现行无承接，也无"是否整治"的结论。
- ⚠️ **E4 死代码清单**（`sidebar/BaseSwitcher.tsx` 零引用、`kb-hooks.ts:135-144 useSaveDoc`、`useToast:18-25`、根目录 `_tmp_*`、`apps/web/_dist_bak/`、desktop 壳 `main.ts` 仅 void 0）——这些**是否已被清理，无文档证明**。若将来做项目瘦身，此处是原始清单。
- ⚠️ **D13 跨 feature 网状互引关系（detail↔views↔designer↔drawer；field-controls 实为共享件却放在 views）**——模块边界描述，现行架构文档无此图。
- ⚠️ **B2「公式拓扑排序是死代码（`computeFormulas` 从未调用）」的行号证据**——后来公式引擎已在 07 月重做并补了 36 函数走查，但**没有文档写明"原 Kahn 拓扑为何未接线、现引擎是否已按拓扑求值"**，回查只有此处有据。

---

### 17 · v1 → v2 深度对比测试矩阵（原 `docs/test-matrix.md`）

**① 讲什么**：2026-09-04 立的「v2 重构后功能 1:1 对等」判定标准模板。共 10 节：字段类型系统（28 种）、关系系统（10 条）、视图系统（7 条）、权限系统 RBAC（7 条）、数据导入导出（3 条）、UI 视觉风格 1:1 复刻（10 条）、Core 数据层 25 条算法断言、性能基线（4 条）、验证流程、验收门槛。**全部测试点状态列一律为 ⏳，从未填写过任何一条结论。**

**② 不可丢失的关键信息（原文摘录，数字未改）**
- 目的（原文）：「作为 v2 重构后"功能 1:1 对等"的判定标准。每个测试点必须有 v1 现状快照 + v2 重写后回归用例 + 通过/失败标记。」
- 对比维度（原文）：「✅ = 功能行为 + 视觉风格 + 性能均与 v1 一致；🟡 = 行为一致但视觉/性能略有不同（可接受）；❌ = 行为不一致（阻塞回归，必须修复）」
- 字段类型 28 项清单（原文，按文档编号）：SingleLineText / LongText / RichText / Number / Currency / Percent / Duration / Date / DateTime / Checkbox / SingleSelect / MultiSelect / Email / URL / Phone / Rating / AutoNumber / JSON / Attachment / Links / Lookup / Rollup / Count / Formula / CreatedTime / LastModifiedTime / CreatedBy / LastModifiedBy。
- 关系系统两条语义（原文）：「5 | 反向映射语义 | bt → hm (反向不是 bt) | `assert reverse type mapping`」；「9 | 浅层 hydration | 防双向递归栈溢出 | `assert no recursion stack overflow`」。
- §7 Core 25 条断言（原文）：「v1 在 `Tests/reverse_link_test.swift` 跑过的 25 条断言，v2 必须在 `apps/api/src/domain/__tests__/` 用 TS 重写并保持全绿：| 1-25 | 关联字段全链路 + 反向映射 + 显示字段 + Lookup + 公式点引用 | 全绿 | TS 重写 | ⏳ |」
- §8 性能基线四档（原文）：「1 | 1000 行 Grid 渲染 | <500ms | ≤500ms；2 | 100 字段类型切换 | <100ms | ≤100ms；3 | 关联字段跳转 | <50ms | ≤50ms；4 | 公式计算 100 行 | <200ms | ≤200ms」
- §9 验证流程第 4 条（原文）：「**视觉对比**：用 Playwright 在 v1 + v2 同一窗口尺寸下截图，逐像素 diff（≤2% 视为通过）」
- §10 验收门槛（原文，六条）：「- ✅ 所有功能点行为一致；- ✅ 视觉对比 ≤2% 像素差异；- ✅ 性能不超过 v1 1.2 倍；- ✅ Core 层 25 条断言全绿；- ✅ 零 P0 缺陷；- ✅ 零新增 bug（对比基线后新增的 bug 必须修复或列入已知问题）」「**未达标即不交付，重新迭代。**」

**③ 与现行文档的关系 / 为何归档**
- **归档主因一：是空模板**。全表状态列 100% 为 ⏳，从未产生任何一条实测结论，不具备"基线"价值。
- **归档主因二：比对对象已不存在**。全仓已无任何 `.swift` 文件（v1 macOS 原生 SwiftUI 源码不在本仓库），"v1 现状快照"无法再取，"1:1 对等"判定已无可执行性。
- 现行回归真源：`docs/baseline/2026-09-12-regression-cases.md`、`docs/baseline/2026-09-18-m7-{checklist,gate-ledger}.md`、40RC 回归台账、根目录 `KNOWN-ISSUES.md`。
- 全仓引用仅 2 处：`docs/adr/0001-architecture-selection.md:58`（目录树示意，已就地加注归档去向）、`.workbuddy/memory/2026-09-04.md:150`（红线未改）。

**④ ⚠️ 未被继承的信息**
- ⚠️ **「视觉对比 ≤2% 像素差异」与「性能不超过 v1 1.2 倍」两条量化验收门槛**——这两条是全仓唯一成文的"像素级/倍数级"验收口径，现行 M7 验收文档用的是「EXPLAIN 无 SCAN + RSS 有界 + P95」另一套口径，**没有任何文档声明旧的两条门槛已作废或已被取代**。若将来要做视觉回归，此处是唯一原始口径。
- ⚠️ **v1 `Tests/reverse_link_test.swift` 25 条断言的历史来源与其落点约定（`apps/api/src/domain/__tests__/`）**——现行文档只写"TS 重写"，**没有回溯说明这 25 条对应 v1 的哪个 Swift 测试文件**，属可追溯性缺口。
- ⚠️ **28 种字段类型的 v1 语义逐条描述**（如「Currency：¥/$/€ 等 + 千分位 + 小数位」「Rating：星级 1-5」「Duration：时长，秒/分/时/天」）——现行字段语义只在代码与 openapi 里，**无一份"逐类型的预期行为"清单**。做字段类型回归时可回查。
- ⚠️ **「bt → hm（反向不是 bt）」这条反向映射语义的成文表述**——关系系统最易搞错的一条，现行无文档单独写明。

---

## 三、悬空引用登记（代码注释，红线未改）

以下 **51 个文件 / 52 处**位于 `apps/**` 的**代码注释**（含 Prisma 迁移 SQL 注释）仍写着归档前的计划文件名。按红线纪律（`apps/**` 不得改动）**未做修改**，路径已失效但**不参与运行/构建/测试断言，无功能影响**。将来若授权清理，按此清单逐条改指 `docs/_archive/originals/` 对应副本。

| 区域 | 文件数 | 代表文件 |
|---|---|---|
| `apps/api/src/domain/search/**` | 22 | `queryPlan.ts`、`rrf.ts`、`searchStore.ts`、`schema.ts`、`vecLoader.ts`、`embedding/{cloud,off,types}.ts`、`indexer*.ts`、`chunks.ts`、`fieldGrant.ts`、`reindex.ts`、`outbox.ts`、`searchCoverage.ts`、`admin{Status,Embedding}.ts`、`__tests__/{rrf-title-boost,reindex-swap,query-s11-gate}.test.ts` |
| `apps/api/src/mcp/**` | 10 | `audit.ts`（2 处）、`transport/{streamableHttp,authenticate}.ts`、`permissions/{types,m4Adapter}.ts`、`pat/{tokens,patService}.ts`、`idempotency.ts` |
| `apps/api/prisma/migrations/**` + rollback | 7 | `20260915090000_enterprise_org_ddl`、`20260916090000_enterprise_nav_ddl`、`20260916093000_enterprise_nav_backfill`、`20260916110000_authz_policies_backfill`、`20260916140000_m5_search_outbox_ddl`、`20260918090000_mcp_pat_ddl`、`apps/api/prisma/docs/rollback/20260916110000_authz_backfill.down.sql` |
| `apps/api/src/routes/v1/**` | 3 | `pats.ts`、`adminSearch.ts`、`__tests__/m5-admin-audit.test.ts` |
| `apps/api/src/e2e/**` | 2 | `clientHarness.ts`、`serverHarness.ts` |
| `apps/api/scripts/search/` | 1 | `check-coverage.ts` |
| `apps/web/**` | 3 | `src/lib/__tests__/nav-urls.test.ts`、`src/api/client.ts:1275`、`src/features/settings/pat-labels.ts:4` |

**未改动的其他红线引用**：`.workbuddy/memory/**`（约 8 处）按纪律一字未动。

**第二轮归档新增的失效引用（同样按纪律未改，仅登记）**：

| 位置 | 处数 | 原引用 | 现应指向 |
|---|---|---|---|
| `.workbuddy/memory/2026-09-04.md:150` | 1 | `docs/test-matrix.md` | `docs/_archive/originals/test-matrix-v1-v2-regression.md` |
| `.workbuddy/memory/2026-09-07.md:5`、`archive-v2dir/2026-09-07.md:5` | 2 | `docs/AUDIT-2026-09-06.md` | `docs/_archive/originals/audit-2026-09-06-systematic-review.md` |
| `.workbuddy/memory/2026-09-12.md:226`、`archive-v2dir/2026-09-07.md:74` | 2 | `docs/benchmark-api.md` | `docs/baseline/2026-09-07-api-benchmark.md`（未归档，只是换位） |
| `docs/_archive/originals/planning-phase2-M1-implementation-plan.md:221,474` | 2 | `docs/benchmark-api.md` | 同上。**按「归档副本一字未改」纪律未改**，读该副本时按新路径对应 |

> 说明：`docs/benchmark-api.md` 本轮**不是归档**，是从 `docs/` 根目录移到 `docs/baseline/2026-09-07-api-benchmark.md`（仍为现行引用的历史性能旁证）。

---

## 四、⚠️ 未被继承条目汇总（速查）

| # | 来源 | 未继承内容 | 建议去向 |
|---|---|---|---|
| 1 | 06 M5 / 07 M6 | `docs/runbooks/m5-search.md`、`mcp.md` 仍把实施计划当「事实真源」，现指向归档区 | 派专人把 runbook 真源改挂 ADR-0042~0050 / ADR-0051~0055 |
| 2 | 13 复验报告 | **新发现 P3：非 owner 直访设置页得空白右区（effectiveSection 守卫口径）** | 未决缺陷，需另立条目 |
| 3 | 13 复验报告 | Modal 缺 `role="dialog"`/`aria-modal`/焦点圈禁（可访问性） | 未决，需另立条目 |
| 4 | 12 验收报告 | §8「未覆盖项」11 条（含 R-D-34 对比度/点击区未测、多视图类型未覆盖、⌘K 未触发） | 后续验收排期输入 |
| 5 | 12 验收报告 | D-8 按钮高实 28 / 规范 32；D-9 表头字号实 13px / 规范 12 | 设计令牌偏差，需确认是否接受 |
| 6 | 08 M4-FE | 「禁紫到粉渐变」「禁 emoji 作功能图标」「禁 AI 模板味空文案」三条团队 P0 美学红线 | 需独立成文，否则前端后续易丢 |
| 7 | 03 M2 | 匿名公开外链是否随成员停用而吊销——未决口径 | 分享治理立项时重开 |
| 8 | 04 M3 | 裁决 6：不补 base/kb 软删恢复端点，全局回收站聚合列 P1 backlog | backlog 无承接文档 |
| 9 | 04 M3 | 18 条实体写点逐条清单（含"复制表不加快捷项"） | 只在代码里，无文档清单 |
| 10 | 09 readiness | A1~A12 共 12 条建议项（r3 只回填了 M1~M13 必修） | 无落实证明 |
| 11 | 10 spike-sqlite-vec | glibc 版本上界（x64 ≤2.14 / arm64 ≤2.17）与「vec0.so 改名即加载失败」 | 打包/换镜像时回查 |
| 12 | 11 spike-mcp-transport | 飞牛网关注入头名 `X-Trim-Userid` | runbook 未登记 |
| 13 | 14 canvas recheck | 「统一测试知识库」三个可复现夹具（P0-①/②/④）名与构造方式 | 复验画布行为时回查 |
| 14 | 01 M0 | E17 上传目录双份硬编码、E18 db.ts PRAGMA 悬空 promise（M0 结论是"不动"） | 无承接，属待决遗留 |
| 15 | 02 M1 | §11 旧行号 vs 实测行号漂移对照表 | 纯考古价值 |
| 16 | 13 复验报告 | 「P1 定义应保留给本轮重构引入的、阻断使用的缺陷」定级方法论 | 缺陷分级规范 |
| 17 | 15 旧 RELEASE | **v2 前序 SEARCH 参数顺序错位，回归已对齐 v1（`SEARCH(within, find)`）** | 改公式引擎前回查 |
| 18 | 15 旧 RELEASE | 测试 E2E base 的 25 字符 cuid 与三个已清理脏数据来源（`newverify*` / `verify3*` / `Customers_e2e`） | 库里发现同名残留时回查 |
| 19 | 16 审计 09-06 | **E3 超长文件 Top 10 含行数**（FormDesigner 1684 起共 10 个） | 重构排期的量化输入，现无承接 |
| 20 | 16 审计 09-06 | **E5 markdown round-trip 六条有损**（`|` 不转义 / 嵌套缩进 / 有序编号 / `<br>` / URL 含 `)` / code·math 提前闭合） | 改块模型或导入导出前必查 |
| 21 | 16 审计 09-06 | E10 类型断言计数（前端 134 / 后端 63）与 zod 边界建议；E4 死代码原始清单；D13 跨 feature 网状互引 | 均无承接；项目瘦身时回查 |
| 22 | 16 审计 09-06 | B2「公式拓扑排序死代码（`computeFormulas` 从未调用）」行号证据 | 现引擎是否已按拓扑求值，无文档结论 |
| 23 | 17 test-matrix | **「视觉对比 ≤2% 像素差异」「性能不超过 v1 1.2 倍」两条量化验收门槛** | 无文档声明作废，做视觉回归时回查 |
| 24 | 17 test-matrix | v1 `Tests/reverse_link_test.swift` 25 条断言的**来源文件名**与落点约定 | 可追溯性缺口 |
| 25 | 17 test-matrix | 28 种字段类型的 v1 逐类型预期行为；「bt → hm（反向不是 bt）」成文表述 | 字段回归可回查 |

---

## 五、如何回溯

1. 想知道"某条历史决策的原文依据" → 在本文件「逐文件详情」按里程碑查，再打开对应 `docs/_archive/originals/*` 全文副本。
2. 现行规范（怎么写/怎么运维）→ `docs/adr/*`（决策）、`docs/baseline/*`（出口证据）、`docs/runbooks/*`（运维）、`docs/api/openapi.yaml`（契约）、`docs/deployment/*`（部署）。
3. 待裁决事项 → 根目录 `PENDING-DECISIONS.md`。
4. 帮助中心（用户向）→ `docs/help-center/`（正文真源 `_parts/`，截图 `assets/`）。
5. **2026-09-20 真机走查报告三份**（权限组合 / 画布白板 / 平台侧）→ `docs/acceptance/2026-09-20-walkthrough/`；**报告正文已归位，截图仍在 `docs/help-center/assets/walk/`**（报告内「截图目录」一行仍指向该处，未变）。
6. 前端实现公约 → `docs/web-conventions.md`（仍在 `docs/` 根目录，本轮未动）。⚠️ **§6 权限口径已与现行口径冲突**：该节原文要求「`canEditData` 为 false 时要**禁用**（不要隐藏，禁用 + tooltip 说明）」，而 `docs/acceptance/2026-09-20-walkthrough/WALK-权限组合-2026-09-20.md` §3 的项目既定口径是「**无权限不渲染入口，不做 disabled 假入口**」，两者正相反。**改前端权限呈现前必须先裁决**，本文未擅自修改。
