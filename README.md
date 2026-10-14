# 构想工作台

> 一款私有化部署的 **智能表格 + 知识库 + 画布** 一体化工作台。数据全部保存在你自己的 NAS / 服务器上，不上云、不订阅、不按人数收费。
>
> 适合想用飞书多维表格 / Airtable / Notion，又希望数据完全自控的个人、家庭与小团队。

- **当前版本**：**`v0.2.3`**
- **产品名**：构想工作台。技术标识（飞牛应用包名 / 目录 / 仓库名）为 `gouxiangdb`，仅用于开发与安装包，界面一律显示「构想工作台」。
- **运行形态**：单进程同时提供 Web 界面与后端接口，内置 SQLite 数据库，**无需外部数据库 / Redis**；浏览器打开即用，电脑、平板、手机自适应。

---

## 功能一览

### 📊 智能表格

一块表就是一个轻量业务系统，每一列都有明确类型，共 **30 种字段**：文本、数字、货币、百分比、时长、日期、单选 / 多选、复选框、人员、评分、邮箱 / 链接 / 电话、附件、自动编号、JSON，以及跨表的**关联 / 查阅 / 聚合 / 计数 / 公式**，外加选项卡、子表格和创建人 / 创建时间等系统字段。

同一份数据可保存多种视图，共 **8 种视图**：**网格、看板、日历、甘特、层级（树形）、画廊、详情、表单**。看板拖动卡片即可推进状态，日历 / 甘特按日期排期，表单用于对外收集。支持筛选、排序、分组、行颜色、字段显隐、底部汇总，并可在记录详情抽屉里讨论评论。

> 应用场景不写死：项目管理、缺陷跟踪、客户与商机（CRM）、库存、书单、家庭记账……建表配字段即可，不需要代码。

### 📚 团队知识库

- 富文本 / Markdown 编辑器：标题、列表、待办、表格、引用块，带悬浮大纲目录；
- **自动保存 + 版本历史**：每次保存形成命名版本，可查看历史并一键回滚；
- **公开分享链接**：把文档只读 / 可编辑地发给外部成员，无需为其开账号；
- 文档内可**嵌入实时数据表与画布**，数据更新时文档里同步变化。

### 🗂️ 自由画布

基于 Plait 的白板：拖拽矩形、自由排版，用于画产品结构图、流程图、头脑风暴；支持缩放平移、节点注释、关联文档卡片与只读分享。

### 🏢 企业级协作

- **通讯录 + 部门架构**：建立部门、把成员挂到部门下；
- **角色与细粒度权限**：内置所有者 / 管理员 / 成员等角色，权限可精确到库 / 表 / 文档，并支持字段级、行级控制（例如成员只能看到自己负责的记录）；
- **操作审计**：关键操作留痕。

### 🔍 全局检索与 AI 接入

- 顶部搜索框（快捷键 `Ctrl / ⌘ + K`）**跨库、跨文档、跨画布**全局检索，结果分组并高亮关键词；
- 可选开启 **MCP 接口**接入 AI（知识库问答、自动化），支持语义向量检索，提供个人访问令牌（PAT）。不开启也完全不影响日常使用。

### 🔒 数据与更新

- 数据库与上传附件全部保存在你选定的存储空间，**不向任何第三方上传数据**；
- 支持应用内检查更新、在线升级；升级走数据库迁移并自动备份，**卸载重装数据保留**。

---

## 界面预览

> 截图位于 [`docs/forum-publish/images/`](docs/forum-publish/images/)，配文见 [`docs/forum-publish/论坛帖正文.md`](docs/forum-publish/论坛帖正文.md)。

| 登录 | 智能表格 · 网格 |
| :---: | :---: |
| ![登录](docs/forum-publish/images/01-login.png) | ![网格](docs/forum-publish/images/02-grid.png) |
| **看板视图** | **日历视图** |
| ![看板](docs/forum-publish/images/03-kanban.png) | ![日历](docs/forum-publish/images/04-calendar.png) |
| **记录详情与评论** | **知识库文档** |
| ![详情](docs/forum-publish/images/05-drawer.png) | ![文档](docs/forum-publish/images/08-doc.png) |
| **自由画布** | **通讯录与权限** |
| ![画布](docs/forum-publish/images/09-canvas.png) | ![通讯录](docs/forum-publish/images/10-contacts.png) |

---

## 快速开始（飞牛 fnOS）

1. 下载与 NAS 架构匹配的安装包（**x86 或 arm，勿下错**）；
2. 打开飞牛「应用中心」→「手动安装」→ 选择 `.fpk` → 选择安装存储空间；
3. 从桌面卡片打开应用，**第一个注册的账号自动成为所有者（超级管理员）**，后续成员由管理员创建；
4. 浏览器打开即用，建议 Chrome / Edge / Safari 最新版。

> 也支持预置初始管理员、自定义外部访问地址等，详见 [`docs/deployment/fnos-native.md`](docs/deployment/fnos-native.md) 与 [`docs/deployment/first-admin-init.md`](docs/deployment/first-admin-init.md)。

其余部署形态（裸机 systemd、Docker）见下方「[部署形态](#部署形态)」。

---
---

> **以下为开发者与运维内容**，普通用户无需关心。

## 技术栈

| 层 | 选型 |
|---|---|
| 后端 | Node.js（**部署统一 v22**）+ **Hono 4** + **Prisma 5** + **SQLite**（WAL 单写者）；esbuild 扁平生产打包 |
| 前端 | React 18 + Vite + Tailwind + TanStack Query；图标单一 `icons.tsx`，色板走 `@gx/design-tokens` |
| 桌面端 | 不在本期范围（Tauri 路线已砍；未来若重启会另起项目基于已有核心封壳） |
| 共享 | `@gx/shared-types`（类型 + 筛选/关系/权限语义）、`@gx/design-tokens`、`@gx/blocks`、`@gx/canvas` |
| 检索 | 独立 `search.db` + **sqlite-vec（vec0）** + FTS5 trigram；embedding 出厂默认 `off`，仅远端 OpenAI 兼容 API |
| AI 接入 | **MCP**（官方 Streamable HTTP 传输 + PAT 凭据 + 双闸门）——M6 后为唯一 AI 接入核心 |

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
├── deploy/               # 裸机 systemd / Caddy / Docker / 飞牛 fpk 部署物
├── scripts/              # dev-up.sh / ci-quality.sh / compare-test.sh / acceptance 等
├── package.json          # pnpm workspace root（version 为版本号唯一真源）
└── pnpm-workspace.yaml
```

## 本地开发

前置：Node ≥ 20（**部署侧统一 v22**）、pnpm ≥ 9（`packageManager` 锁定 `pnpm@9.0.0`）。无需外部数据库。

```bash
pnpm install                                   # 安装
cp apps/api/.env.example apps/api/.env         # 已含 DATABASE_URL="file:./dev.db"

pnpm db:migrate                                # 开发（prisma migrate dev）
pnpm --filter @gx/api run db:deploy            # 非交互环境（prisma migrate deploy）
pnpm --filter @gx/api exec prisma generate

bash scripts/dev-up.sh start                   # 推荐：API :3001 + Web :5173（脱离 shell）
bash scripts/dev-up.sh status | restart | stop
# 或分别起：pnpm dev:api / pnpm dev:web；并行：pnpm dev

pnpm test                 # 逐包跑；pnpm typecheck / pnpm lint / pnpm build
bash scripts/ci-quality.sh                     # CI 质量门
```

健康检查：`/healthz`（存活）、`/readyz`（就绪，含迁移对账 / 磁盘 / WAL 探针），见 `docs/runbooks/`。

<details>
<summary><b>测试基线（带日期的历史实测，以实际重跑为准）</b></summary>

| 包 | 实测值 | 记录日期 | 来源 |
|---|---|---|---|
| `apps/api` | **3180 passed / 0 failed / 14 skipped**（302 files） | 2026-10-14 | v0.2.3 收口全量复跑（HEAD `dab64f7`，VM15） |
| `apps/web` | **1717 passed / 0 failed** | 2026-10-13 | v0.2.3 质量门（VM15） |
| `@gx/shared-types` | **172 passed / 0 failed** | 2026-10-13 | v0.2.3 质量门 |
| `@gx/canvas` | **51 passed / 0 failed** | 2026-10-13 | v0.2.3 质量门 |

本表是历史记录、非当前断言。v0.2.3 收口：四包 `tsc --noEmit` 零错误、`eslint` 0 error、迁移干跑 40/40 应用且 `integrity_check=ok`（本版零新增迁移）。内存 / 压测类重活不在本机跑，放预览机 VM15；权威出口数字见 `docs/baseline/`。

</details>

## 部署形态

| 形态 | 说明 | 文档 |
|---|---|---|
| **飞牛 fnOS（fpk）** | 原生应用包，子路径 `/app/gouxiangdb` 部署；应用中心一键装、桌面卡片打开 | `docs/deployment/fnos-native.md` |
| **裸机 systemd** | systemd + Caddy + `deploy.sh`（在线快照 → `migrate deploy` → nav path 重算 → 切换，失败 die 在切换前） | `docs/deployment/README.md`、`docs/runbooks/deploy.md` |
| **Docker** | `node:22-bookworm` 基础镜像，自包含 Dockerfile / entrypoint / compose | `docs/deployment/docker.md` |

其他：`docs/deployment/first-admin-init.md`（首次超管引导）、`docs/deployment/macos-dev.md`（本机开发）。

## 运维硬约束

1. **Node 版本**：任何部署目标一律 **v22**。Node 20 下原生模块（better-sqlite3）会直接 **SIGSEGV**（非普通报错，易误判为数据库损坏），详见 `docs/deployment/README.md` §2.4。
2. **子路径 / 网关鉴权头**：飞牛网关会吞 `Authorization`，Web 用自定义头 **`X-GX-Token`**；服务端先取 `Authorization: Bearer`，再回退 `X-GX-Token`。
3. **SQLite 单写者**：写操作统一走 `withWriteTx` / `runWrite` / `withWriteBatch`（回调体内只用传入 `tx`，不得再入队）；raw SQL 一律参数化。
4. **搜索 / 嵌入**：`GX_M5_SEARCH`、`GX_EMBEDDING_MODE` 出厂默认 `off`（语义检索需管理员显式配置）；`search.db` 可整文件重建，不进业务备份。
5. **MCP**：`/mcp` 独立 body 上限 `GX_MCP_BODY_LIMIT` 默认 11MB（全局 JSON 限 1MB）；`/mcp` 与 `/api/v1/pats` 受 `GX_ENTERPRISE_ORG` 门控（off 即不挂载）。
6. **迁移纪律**：只增不删（不删列、不改列类型），回填幂等可重跑；生产用 `migrate deploy`，`migrate dev` 仅交互环境用。
7. **性能口径**：本 README 不承诺任何跨硬件性能数字；需要请查 `docs/baseline/`，无记录一律标【待补】。

<details>
<summary><b>权限引擎当前状态（M4，唯一执法者，无开关）</b></summary>

实际执法的是统一权限引擎 `apps/api/src/domain/authz/engine.ts` 的 `decide()`，读 **`auth_policies` + `nav_nodes`**（角色 / 部门 / 用户经 nav 节点投影），**永久、无条件生效**：

- 三态开关 `GX_AUTHZ_ENGINE`、READY 阶段门、shadow 对拍 / drift 账本已全部物理删除（2026-10-06，ADR-0057）；
- 引擎抛错 → 503 fail-closed（不回落旧决策）；资源无活 nav 节点 → 403 fail-closed；
- 删库 / 删知识库走 conjunction（只减不增）；字段掩码、行级条件、导航剪枝恒定执行。

`libraryPolicy.ts` 是引擎之上的「能力 / UI 形状层」，与引擎执法正交。第一代旧三表（`members` / `kb_members` / `kb_doc_acls`）不参与放行，仅作台账。详见 ADR-0057、ADR-0056。

</details>

## 数据库说明

ADR-0001 初选 PostgreSQL，落地改用 **SQLite**（以 `apps/api/prisma/schema.prisma` 的 `provider = "sqlite"` 为准）：零外部依赖、本地可直接运行；多用户服务端数据库作为后续演进项（触 ADR-0008 阈值再立项）。

- 开发连接串用相对路径 `DATABASE_URL="file:./dev.db"`（相对 schema 目录）；**生产建议绝对路径**。
- 生产用 `prisma migrate deploy`；`migrate dev` 交互式，非交互环境禁用。

## 与 v1 的关系

v1 为 Swift 实现，与当前版本零代码依赖。核心模型（字段、hydrate、公式 / Lookup / Rollup、Meta、权限、主题）均已移植并增强，另新增看板 / 日历 / 甘特、知识库与画布。

## 文档导航

| 想找什么 | 去哪 |
|---|---|
| **帮助中心（用户向）** | `docs/help-center/` |
| **现行规范 / 架构决策** | `docs/adr/`（ADR-0001~0057，唯一权威）；权限专项另见 `docs/decisions/` |
| **部署** | `docs/deployment/` |
| **运维手册** | `docs/runbooks/`（deploy / backup / restore / ci / m5-search / mcp / authz-*） |
| **接口契约** | `docs/api/openapi.yaml`（冻结）+ `docs/api/m4-error-codes.md` |
| **出口证据 / 实测基线** | `docs/baseline/` |
| **发版记录** | 根目录 **`RELEASE.md`**（现行＝v0.2.3 应用更新机制发版说明） |
| **已知问题 / Bug 回归清单** | 根目录 **`KNOWN-ISSUES.md`**（发版前按表回归；条数以该文件标题行实时统计为准） |
| **待裁决事项（含瘦身清理）** | 根目录 `PENDING-DECISIONS.md` |
| **历史归档（M0–M6 计划、被取代报告）** | 根目录 `ARCHIVE-LOG.md`（索引摘要）→ 全文副本 `docs/_archive/originals/` |

根目录四份常驻文件：`KNOWN-ISSUES.md`（回归清单 + 踩坑速查）、`ARCHIVE-LOG.md`（归档溯源）、`PENDING-DECISIONS.md`（待裁决）、`RELEASE.md`（发版记录）。架构选型与重大变更走 ADR；悬而未决项登记 `PENDING-DECISIONS.md`，关闭前不擅自实施。
