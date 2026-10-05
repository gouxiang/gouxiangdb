# 构想工作台

> 私有化部署的智能表格 + 知识库 + 画布一体化工作台，前后端分离 · 客户端壳化 · 多端复用。

- **产品名**：「**构想工作台**」。飞牛应用包名 / 目录 / monorepo 根包名仍为 `gouxiangdb` / `gouxiangdb-v2`，仅为技术标识，界面与清单展示名一律为「构想工作台」。
- **当前版本**：**`v0.2.1`**（单一真源 = 根 `package.json` 的 `version` 字段；运行时禁止再出现硬编码版本字面）。
- **当前阶段**：M0–M6 已全部收口（生产基座 / 数据底座 / 组织通讯录 / 统一导航 / 权限引擎 / 向量检索 / 鉴权 MCP），**M7 企业版总验收进行中**（门⑦⑧未完成）。

> **⚠️ 权限当前真实状态（谁说了算，别误读）**：
> 当前**实际执法的是第二代「库级策略」**——`apps/api/src/domain/authz/libraryPolicy.ts` 的 `resolveBaseAccess()`，
> 读 **`role_library_scope`**（角色×库台账，另有超管/管理员硬短路），**不读旧三表**。日常在
> 「工作区设置 → 角色权限」里配的库/表权限就是这一层，真生效。
> 第三代 M4 权限引擎（读 `auth_policies` + `nav_nodes`）**本体已建成，且七个守卫的 enforce 接线（阶段 R1）已完成**，
> 但被两个门卡着：`apps/api/src/configAuthz.ts` 的 `AUTHZ_ENFORCE_READY = false` + 环境变量 `GX_AUTHZ_ENGINE` 默认 `off`
> （未设置 / 未知值 / 空值一律回 `off`；即使写 `on`，阶段门未翻也会降级为 `shadow`）。
> 故引擎现在只在 `shadow` 下做对拍、不改判；翻 `on` 需满足前置条件且**仅由项目总监下令**。
> 第一代旧三表（`members` / `kb_members` / `kb_doc_acls`）生产已**零写点**，仅剩 3 处非执法只读用途，实际已退役。
> 详见 `docs/runbooks/authz-engine-flip-on.md`、ADR-0056 与 `docs/decisions/AUTHZ-LEGACY-GUARD-CLEANUP.md`。

---

## 技术栈

| 层 | 选型 |
|---|---|
| 后端 | Node.js + **Hono 4** + **Prisma 5** + **SQLite**（WAL 单写者）；esbuild 扁平生产打包 |
| 前端 | React 18 + Vite + Tailwind + TanStack Query；图标单一 `icons.tsx`，色板走 `@gx/design-tokens` |
| 桌面端 | 不在本期范围（Tauri 路线已砍；未来若重启会另起项目基于已有核心封壳） |
| 共享 | `@gx/shared-types`（类型 + 筛选/关系/权限语义）、`@gx/design-tokens`、`@gx/blocks`、`@gx/canvas` |
| 检索 | 独立 `search.db` + **sqlite-vec（vec0）** + FTS5 trigram；embedding 出厂默认 `off`，仅远端 OpenAI 兼容 API |
| AI 接入 | **MCP**（`@modelcontextprotocol/sdk` 官方 Streamable HTTP 传输 + PAT 凭据 + 双闸门）——M6 后为唯一 AI 接入核心 |

---

## 目录结构

```
GouXiangDB/
├── apps/
│   ├── api/              # Hono + Prisma + SQLite 后端
│   │   ├── prisma/{schema.prisma,migrations/}   # 手写 SQL 迁移，生产用 migrate deploy
│   │   ├── scripts/                              # build / backup / init-admin / nav-reconcile
│   │   └── src/
│   └── web/              # React + Vite 前端
├── packages/
│   ├── shared-types/     # 前后端共享 TS 类型与语义（权限/筛选/关系/策略 DTO）
│   ├── design-tokens/    # 跨端设计 token（自 v1 GXTheme 移植）
│   ├── blocks/           # 块模型 mdToBlocks / blocksToMd（服务端消费）
│   └── canvas/           # 画布校验器（Plait 六不变量，服务端 shared 单一规则源）
├── docs/                 # 见下方「文档导航」
├── deploy/               # 裸机 systemd / Caddy / Docker 部署物
├── scripts/              # dev-up.sh / ci-quality.sh / compare-test.sh / acceptance 等
├── package.json          # pnpm workspace root
└── pnpm-workspace.yaml
```

---

## 本地开发

前置：Node ≥ 20（**部署侧统一 v22**）、pnpm ≥ 9（`packageManager` 锁定 `pnpm@9.0.0`）。桌面端不在本期范围，无需 Rust/Cargo。无需外部数据库。

```bash
# 安装
pnpm install

# 环境变量（相对路径，勿写死本机绝对路径）
cp apps/api/.env.example apps/api/.env      # 已含 DATABASE_URL="file:./dev.db"

# 数据库
pnpm db:migrate                              # 开发（prisma migrate dev）
pnpm --filter @gx/api run db:deploy          # 非交互环境（prisma migrate deploy）
pnpm --filter @gx/api exec prisma generate

# 起服务（推荐，进程脱离 shell）
bash scripts/dev-up.sh start                 # API :3001 + Web :5173
bash scripts/dev-up.sh status | restart | stop

# 或分别起
pnpm dev:api        # http://localhost:3001
pnpm dev:web        # http://localhost:5173
pnpm dev            # 并行

# 测试 / 检查 / 构建（脚本均以仓库既有 scripts 为准）
pnpm test                                    # 逐包跑
pnpm --filter @gx/api test
pnpm typecheck                               # 全仓
pnpm lint
pnpm build                                   # 全仓
pnpm build:api                               # 产出可直接 node dist/index.js 的扁平单文件
bash scripts/ci-quality.sh                   # CI 用质量门
```

健康检查：`/healthz`（存活）与 `/readyz`（就绪，含迁移对账 / 磁盘 / WAL 等探针）—— 见 `docs/runbooks/`。

### 测试基线（带日期的历史实测，以实际重跑为准）

| 包 | 实测值 | **记录日期** | 来源 |
|---|---|---|---|
| `apps/api` | **2976 passed / 0 failed**（290 files，2 files 本地 skip）；大资源规模门 VM15 跑 10/10 | 2026-10-05 | 本轮全量复跑（HEAD 59f49f5） |
| `apps/web` | **1636 passed / 0 failed**（129 files） | 2026-10-05 | 本轮全量复跑 |
| `@gx/shared-types` | **103 passed** | 2026-10-05 | 本轮复跑 |
| `@gx/canvas` | **51 passed** | 2026-10-05 | 本轮复跑 |

> 本表是**带日期的历史实测记录**，不是当前断言——数字会随迭代变化，**以实际重跑为准**，请勿当作现状承诺。
> 三包 `typecheck` 零错误、`eslint` **0 error**（web 100 / api 4 均为历史既有 warning）。
> 内存/资源占用大的规模门与压测**不在本机跑**，放预览机 VM15；需要权威出口数字请查 `docs/baseline/` 最新报告。

---

## 部署形态

三种形态并存，详见 `docs/deployment/`：

| 形态 | 说明 | 文档 |
|---|---|---|
| **裸机 systemd** | systemd + Caddy + `deploy.sh`（在线快照 → `migrate deploy` → nav path 重算 → 切换，失败 die 在切换前） | `docs/deployment/README.md`、`docs/runbooks/deploy.md` |
| **Docker** | `node:22-bookworm` 基础镜像，自包含 Dockerfile / entrypoint / compose | `docs/deployment/docker.md` |
| **飞牛 fnOS（fpk）** | 原生应用包，子路径 `/app/gouxiangdb` 部署 | `docs/deployment/fnos-native.md` |

其他：`docs/deployment/first-admin-init.md`（首次超管引导）、`docs/deployment/macos-dev.md`（本机开发）。

---

## 文档导航

| 想找什么 | 去哪 |
|---|---|
| **现行规范 / 架构决策** | `docs/adr/`（ADR-0001~0056，决策唯一权威）；权限专项另见 `docs/decisions/` |
| **出口证据 / 实测基线** | `docs/baseline/`（含 M7 门①~⑥ 证据、gate6 三环境证据） |
| **运维手册** | `docs/runbooks/`（deploy / backup / restore / ci / m1-sidecar / m5-search / mcp / authz-*） |
| **接口契约** | `docs/api/openapi.yaml`（冻结）+ `docs/api/m4-error-codes.md` |
| **部署** | `docs/deployment/` |
| **设计决策（KB / 画布 / UI）** | `docs/decisions/` |
| **帮助中心（用户向）** | `docs/help-center/` |
| **已知问题 / Bug 回归清单** | 根目录 **`KNOWN-ISSUES.md`**（含发现时间 / 修复时间 / 版本号 / commit 四列）。**条数与级别分布以该文件主表标题行的实时统计为准**，本表不复制数字 |
| **待裁决事项（含瘦身清理项）** | 根目录 `PENDING-DECISIONS.md` |
| **发版记录** | 根目录 `RELEASE.md` |
| **历史归档（M0–M6 实施计划、被取代的验收报告）** | 根目录 **`ARCHIVE-LOG.md`**（索引与摘要）→ 全文副本在 `docs/_archive/originals/` |

> `docs/planning/phase2/` 下已归档完毕的文件**不再在原位**；仍在原位的只有 `M7-implementation-plan.md`、`PLAN-ADJUST-nas-min-hardware.md`、`S5b-hydration-projection-plan.md`。

---

## 当前已知约束

1. **Node 版本**：部署侧统一 **v22**（飞牛运行时 `nodejs_v22`；Docker 基础镜像 `node:22-bookworm`）；本机开发可 ≥20，但**任何部署目标一律 22**。更换 Node 大版本必须重装依赖并复验。
   > **故障现象**：Node 20 下不是报普通模块错误，而是进程直接 **SIGSEGV**（原生模块 ABI/NAPI 档位不匹配），极易误判为内存/磁盘/SQLite 损坏。**详见 `docs/deployment/README.md` §2.4「Node 版本硬约束」**（该条为 2026-09 部署实证，2026-09-20 首次落盘）。
2. **子路径 / 网关部署的鉴权头**：飞牛网关会吞 `Authorization`，应用 JWT 改用自定义头 **`X-GX-Token`** 携带；服务端 `resolveActiveAuth` 先取 `Authorization: Bearer`，再回退 `X-GX-Token`（可带或不带 Bearer 前缀）。见 `docs/baseline/gate6-evidence/2026-09-18-fnos-fpk-0.1.1-delivery.md`。
3. **数据库方言**：SQLite 单写者。所有写走 `withWriteTx` / `runWrite` / `withWriteBatch`，铁律「回调体内只用传入 `tx`，不得再入队」；raw SQL 一律参数化。
4. **搜索**：`GX_M5_SEARCH` 出厂默认 `off`，`GX_EMBEDDING_MODE` 出厂默认 `off`（cloud 需管理员显式配置 + 二次确认）；`search.db` 可整文件重建，不进业务备份。
5. **权限引擎**：`GX_AUTHZ_ENGINE` 代码默认 `off`，生产建议 `shadow`；**即使部署侧写 `on`，阶段门也会降级为 shadow 并 warn 一次**；真正翻 `on` 需满足五条前置且**仅由项目总监下令**（详见文首警示）。
6. **MCP**：`/mcp` 独立 body 上限 `GX_MCP_BODY_LIMIT` 默认 11MB（全局 JSON 限为 1MB）；`/mcp` 与 `/api/v1/pats` 同受 `GX_ENTERPRISE_ORG` 门控（off 即不挂载）。
7. **未实测项**：本 README 不给出任何跨硬件性能承诺（如 KNN 延迟、首屏时间）；需要数字请查 `docs/baseline/`（含旧口径压测 `docs/baseline/2026-09-07-api-benchmark.md`），无记录的一律标【待补】。
8. **项目瘦身**：截图、临时产物、疑似冗余组件等清理项**尚未裁决**，清单见根目录 `PENDING-DECISIONS.md`；未裁决前不得自行删除。

---

## 已知问题

历史问题与 Bug 的**唯一清单**在根目录 **`KNOWN-ISSUES.md`**，本 README 不复述条目。

- **条数与级别分布**以 `KNOWN-ISSUES.md` 主表标题行的**实时统计**为准（该文件每次追加条目都会更新标题行）——本 README **刻意不写死数字**，避免反复漂移。
- 它是**回归测试 checklist，不是缺陷跟踪系统**：每次发版前按主表「模块 + 复现要点」逐条走一遍。
- 新发现问题**追加到主表**（编号顺延当前最大编号，见该文件主表末行），填满发现时间 / 修复时间 / 修复版本号 / 修复 commit 四列；拿不准写「待确认」，**不许编**。
- §二「误报 / 撤销 / 重定性」不是缺陷，别重复修；§三「历史遗留注意事项 / 已知坑」改相关模块前先读。
- 「当前已知约束」（上一节）讲的是**运行限制**，与 `KNOWN-ISSUES.md` 的**缺陷条目**是两回事，别混。

---

## 数据库说明

ADR-0001 拍板阶段初选 PostgreSQL，落地实现改用 **SQLite**（以代码为准：`apps/api/prisma/schema.prisma` 中 `provider = "sqlite"`）。理由：零外部依赖、本地 / 桌面端可直接运行；多用户服务端数据库作为后续演进项保留（触 ADR-0008 阈值才立项）。

- 开发环境连接串用相对路径 `DATABASE_URL="file:./dev.db"`（Prisma 相对 schema 目录解析）；**生产建议绝对路径**。
- 生产用 `prisma migrate deploy`；`migrate dev` 为交互式，非交互环境禁用。
- 迁移纪律：**只增不删**（不删列、不改列类型），回填幂等可重跑。

---

## 与 v1 的关系

| v1 组件（Swift） | 当前对应 | 状态 |
|---|---|---|
| Core/Models.swift | `packages/shared-types/src/fields.ts` 等 | 已移植，字段类型约 30 种 |
| Core/RecordRepository.swift（hydrate） | `apps/api/src/domain/hydrate.ts` | 已对齐并超越：两轮 hydration + 防双向递归 + 跨表点引用 |
| 公式 / Lookup / Rollup | `apps/api/src/domain/formula*` + `defaults.ts` | 完整实现，跨表点引用 + 即时反向重算 |
| Core/MetaRepository.swift | `apps/api` 字段 / 关联路由 | 已移植，关联双向自动建 + 软删恢复 |
| Core/PermissionChecker.swift | `shared-types permissionsForRole` + `libraryPolicy`（库级策略） | 已移植；M4 统一引擎已建成、R1 enforce 接线已完成但**默认不生效**（见文首警示），现行执法走第二代 `role_library_scope` |
| Shared/Theme.swift | `packages/design-tokens` | 1:1 移植为跨端 token |
| Grid / Gallery / Form / Detail / Drawer | `apps/web/src/features/{grid,views,detail,drawer}` | 已实现，另增 Kanban / Calendar / ERD |
| 画布 / 知识库（v1 无） | `apps/web/src/features/kb` | 新增能力 |

v1（Swift）与当前版本零代码依赖。

---

## 决策与归档

根目录四份常驻文件，改动前建议先看一眼：

| 文件 | 作用 | 什么时候看 |
|---|---|---|
| **`KNOWN-ISSUES.md`** | 历史问题 / Bug 回归清单 + 误报与踩坑速查（条数见其主表标题行实时统计） | 每次发版回归前；发现新问题时追加 |
| **`ARCHIVE-LOG.md`** | 已归档文档的原路径 → 归档位置 → 理由 → 「⚠️ 未被继承的信息」 | 找不到某份历史文档时；改被归档模块前 |
| **`PENDING-DECISIONS.md`** | 待主理人裁决项（含瘦身清理：截图 / 临时产物 / 疑似冗余组件） | 清理仓库前；口径未定时 |
| **`RELEASE.md`** | 发版记录（注：现内容为 2026-09-04 迭代的历史档案，非当前发版依据） | 追溯历史发版 |

- 架构选型与重大变更走 ADR 流程：**`docs/adr/`**。
- 悬而未决项登记在 `PENDING-DECISIONS.md`，关闭前不擅自实施。
