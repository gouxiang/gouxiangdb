# 构想工作台 — 前后端分离 · 客户端壳化 · 多端复用智能表格

> 产品名统一为「**构想工作台**」（飞牛应用包名 / 目录 / monorepo 根包名仍为 `gouxiangdb` / `gouxiangdb-v2`，
> 仅为技术标识，界面与清单中的展示名一律为「构想工作台」）。

> v1 是 macOS 原生智能表格（Swift 6 + SwiftUI + SQLite，clean-room 复刻 NocoDB）。
> 当前版本（仓库内代号 v2）是前后端分离重构版：薄客户端壳 + 单一 Node.js API + 多端共用核心。
> **重构目的**：突破 v1「macOS 单机 + 硬编码」瓶颈，承接多用户 / 多端 / 知识库协作需求。
>
> 说明：仓库目录已由 `GouXiangDB-v2` 改名为 `GouXiangDB`；monorepo 根包名仍保留 `gouxiangdb-v2`，仅为历史标识，不影响运行。

---

## 当前状态（2026-09-12 稳定性基线 `v0.1.0`）

Git 基线：`main` + 只读分支 `baseline/0.1` + tag `v0.1.0`（提交 `637eb9d`），已推送 Gitee 私有仓，可随时回滚比对。基线报告见 `docs/baseline/2026-09-12-stability-baseline.md`，历史 bug 回归用例见 `docs/baseline/2026-09-12-regression-cases.md`。

**测试基线（机械证据）**

- 后端单测 `@gx/api`：214 项全绿（8 个套件，含公式引擎、跨表点引用、创建期必填校验等）
- 共享类型 `@gx/shared-types`：56 项全绿（筛选语义、关系、类型分组）
- 全仓 `pnpm typecheck`：5 个工程 0 错误（design-tokens / shared-types / api / web / desktop）
- api / web 构建通过；真机 Chromium + WebKit 双引擎冒烟通过（画布卡片在 WebKit 下无白卡）

**已交付能力**

- 架构选型 ADR；后端 Hono + Prisma + JWT + RBAC，Base/Table/Field/Record/View/Auth/Health 全套路由
- 数据库落地为 **SQLite**（详见下文「数据库说明」），手写 migration + `prisma migrate deploy`，WAL + busy_timeout
- 字段类型约 30 种并全部具备 cell renderer 与存储映射：单行 / 长文 / 富文本、数字 / 货币 / 百分比 / 评分 / 时长、复选框、单选 / 多选、日期 / 日期时间、链接 / 邮箱 / 电话、附件、关联（links）、公式 / lookup / rollup / count、自动编号、创建 / 修改时间、创建 / 修改人、JSON、子表（subtable）、分页（tabs）
- 公式引擎：跨表统一走 hydration 字段层点引用 `{关联.子字段}`，SUM/AVERAGE/MIN/MAX/CONCAT 等直接吃多记录 list；默认值公式与公式字段同一链路；跨表写操作即时反向重算
- 视图：Grid / Gallery / Form / Detail / Drawer / Kanban / Calendar，外加 ERD 关系图
- 关联：双向自动建 linkRow、软删 / 恢复、多目标写入严格校验、record/field 清理联动
- 知识库（KB）：块编辑器、文档树、公开分享（只读 / 可写）、乐观锁版本控制
- 画布：基于 Plait/Drawnix 的关联卡白板，关联文档 / 表格记录，图层 z 序、选区、WebKit 渲染补偿等契约已固化
- 前端 Vite + React + Tailwind + Zustand + TanStack Query；Tauri 桌面壳配置
- 系统审计 29 项问题分四批次修复并回填（见 `docs/audits/2026-09-11-full-system-audit.md`）

**已知遗留（进入功能升级时看护，详见基线报告风险清单）**

- 全表 findMany 无 take + 内存分页，单表 >5000 行或多关联时需做 filter SQL 化 / 视图分流
- 附件以 dataURL 内嵌 fields JSON（过渡方案），后续迁独立附件表 / 对象存储
- 唯一 / 必填改设置后不回溯校验存量数据
- 工程化：根 `test:e2e` 指向尚不存在的 vitest e2e 配置、根 lint 脚本暂无实现、无 CI
- 首屏部分 chunk >500KB（flowchart-elk / 主入口 / mindmap），待动态 import 分包

---

## 仓库结构

```
GouXiangDB/
├── apps/
│   ├── api/              # Node.js + Hono + Prisma + SQLite 后端
│   │   ├── prisma/
│   │   │   ├── schema.prisma
│   │   │   ├── migrations/   # 手写 SQL 迁移（migrate deploy）
│   │   │   └── dev.db         # 本地 SQLite 库（相对路径解析，不入库）
│   │   └── src/
│   ├── web/              # React + Vite + Tailwind 前端
│   └── desktop/          # Tauri 桌面壳
├── packages/
│   ├── shared-types/     # 前后端共享 TS 类型 + 筛选/关系/公式语义
│   └── design-tokens/    # 跨端设计 token（从 v1 GXTheme 移植）
├── docs/
│   ├── adr/              # 架构决策记录（0001 选型）
│   ├── decisions/        # KB / 画布等设计决策记录
│   ├── audits/           # 系统审计与修复回填
│   ├── baseline/         # 稳定性基线报告 + 40 条回归用例
│   ├── test-matrix.md    # v1 vs v2 深度对比测试基线
│   └── web-conventions.md
├── patches/              # @plait/draw 补丁（连线手势守卫，升级需重放）
├── scripts/
│   ├── dev-up.sh         # 一键启停 API + Web（start/stop/status/restart）
│   └── compare-test.sh
├── package.json          # pnpm workspace root
└── pnpm-workspace.yaml
```

---

## 数据库说明（重要）

ADR-0001 在拍板阶段初选 PostgreSQL，但落地实现时改用 **SQLite**（以代码为准，`apps/api/prisma/schema.prisma` 中 `provider = "sqlite"`）。选择 SQLite 的原因是优先保证零外部依赖、本地 / 桌面端可直接运行；多用户服务端数据库作为后续演进项保留。

- 连接串使用相对路径：`DATABASE_URL="file:./dev.db"`，Prisma 相对 schema 目录解析到 `apps/api/prisma/dev.db`。
- 复制 / 改名 / 换机部署时，保持该相对路径即可，不要写死本机绝对路径。
- 迁移用 `prisma migrate deploy`（非交互环境不要用 `migrate dev`）。

---

## 启动开发环境

### 前置依赖

- Node.js ≥ 20（推荐 22.x，通过 pnpm workspace 管理）
- pnpm ≥ 9
- Rust + Cargo（仅 Tauri 桌面壳需要；纯 Web + API 开发不需要）
- 无需安装 / 启动任何外部数据库（SQLite 文件库）

### 启动步骤

```bash
# 1. 安装依赖
pnpm install

# 2. 准备环境变量（相对路径，无需改绝对路径）
cp apps/api/.env.example apps/api/.env   # 已含 DATABASE_URL="file:./dev.db"

# 3. 应用数据库迁移并生成 Prisma Client
pnpm db:migrate        # 首次可用 pnpm --filter @gx/api exec prisma migrate deploy
pnpm --filter @gx/api exec prisma generate

# 4. 一键起 API(:3001) + Web(:5173)（推荐，进程脱离 shell）
bash scripts/dev-up.sh start
bash scripts/dev-up.sh status
bash scripts/dev-up.sh restart
bash scripts/dev-up.sh stop

# 或分别手动启动
pnpm dev:api           # http://localhost:3001
pnpm dev:web           # http://localhost:5173
pnpm dev               # 并行启动全部 dev 服务
```

健康检查：`curl http://localhost:3001/api/health` 应返回 `{"ok":true,"db":"ok"}`。

### 跑测试 / 构建

```bash
pnpm --filter @gx/api test          # 后端 214 项
pnpm --filter @gx/shared-types test # 共享类型 56 项
pnpm test                           # 逐包跑（web 暂无单测属已知项）
pnpm typecheck                      # 全仓类型检查
pnpm build                          # 全仓构建
# pnpm test:e2e                     # 暂未提供 e2e 配置（基线遗留，勿据此判红）
```

测试账号等本地机密从环境变量注入，禁止硬编码入库。

---

## 与 v1 的关系

| v1 组件 | 当前对应 | 状态 |
|---|---|---|
| Core/Models.swift | packages/shared-types/src/fields.ts 等 | 已移植，字段类型约 30 种 |
| Core/RecordRepository.swift（hydrate） | apps/api/src/domain/hydrate.ts | 已对齐并超越：两轮 hydration + 防双向递归 + 跨表点引用 |
| 公式 / Lookup / Rollup | apps/api/src/domain/formula* + defaults.ts | 已完整实现，跨表走点引用 + 即时反向重算 |
| Core/MetaRepository.swift | apps/api 字段 / 关联路由 | 已移植，关联字段双向自动建 + 软删恢复 |
| Core/PermissionChecker.swift | shared-types permissionsForRole + RBAC 中间件 | 已移植 |
| Shared/Theme.swift | packages/design-tokens | 1:1 移植为跨端 token |
| Grid / Gallery / Form / Detail / Drawer | apps/web/src/features/{grid,views,detail,drawer} | 已实现，另增 Kanban / Calendar / ERD |
| 画布 / 知识库（v1 无） | apps/web/src/features/kb | 新增能力 |
| 数据层断言 | api 214 + shared-types 56 | 全绿 |

v1（Swift）与当前版本零代码依赖；v1 目录已移入废纸篓。

---

## 发布基线与质量门禁

当前为 `v0.1.0` 稳定性基线，结论「可安全进入功能升级」（原「有条件通过」的两个前置——异地备份、目录改名 + 相对路径——均已满足）：

1. 功能行为以 `docs/test-matrix.md` 与 40 条历史 bug 回归用例为准
2. 核心单测 270 项全绿、typecheck 0 错、api/web 构建通过
3. 无未修复 P0；遗留项均为性能 / 工程化 / 边角一致性，已登记分级
4. 每个功能迭代后必须跑回归用例集，重点看护大数据量分页与画布（Plait 选区 / z 序 / WebKit）契约

---

## 决策记录

- `docs/adr/0001-architecture-selection.md`：拍板阶段总选型（B-S 三层 / Hono / Prisma / React / Tauri）
- `docs/adr/0002-database-sqlite.md`：数据库落地为 SQLite，正式修订 0001 的 PostgreSQL 初选，并给出未来演进到服务端数据库的路径
- `docs/decisions/`：KB 编辑器各轮、画布嵌入 / 缩放 / 层级 / 焦点 / 公开引用等设计决策
- `docs/baseline/`：升级前基线报告与回归用例
- 架构选型与重大变更走 ADR 流程；悬而未决项登记后再关闭
