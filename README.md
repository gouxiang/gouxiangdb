# GouXiangDB v2 — 前后端分离 · 客户端壳化 · 多端复用

> v1 是 macOS 原生智能表格（Swift + SwiftUI + SQLite，clean-room 复刻 NocoDB）。
> v2 是前后端分离重构版：薄客户端壳 + 单一 Node.js API + 多端共用核心。
> **重构目的**：突破 v1 "macOS 单机 + 硬编码" 瓶颈，承接多用户/多端需求。

---

## 当前状态（2026-09-04 拍板日）

✅ **已完成**（本次会话）：
- 架构选型 ADR（决策固化，详见 `docs/adr/0001-architecture-selection.md`）
- 功能测试矩阵（深度对比测试基线，详见 `docs/test-matrix.md`）
- 共享类型包（28 字段、28 种类型、关联语义、LinkRef、RBAC）
- 设计 token 包（从 v1 GXTheme 1:1 移植为跨端 token JSON）
- 后端骨架（Hono + Prisma + JWT）：Base/Table/Field/Record/View/Auth/Health
- 后端 hydration 核心算法（v1 SQLiteRecordRepository.hydrate TS 同构）
- 前端骨架（Vite + React + Tailwind + Zustand + TanStack Query）
- 前端两栏骨架 + 登录 + 侧栏 + 详情路由 + Grid 视图
- Tauri 桌面壳配置
- 共享类型 21 条算法断言全绿
- 后端 + 前端 TS 编译 0 错误
- 前端 Vite build 成功（93 modules, 195KB JS）

⏳ **下一里程碑**（需要后续推进）：
- 跑通 PostgreSQL migrate + 启动 API server + 端到端最小链路 PoC
- 实现剩余 27 种字段类型的 cell renderer 与存储映射
- 实现 Lookup / Rollup / Count / Formula 完整 hydration
- 实现 Gallery / Form / Detail / Drawer 视图
- 写数据迁移 v1 → v2 脚本
- 写 Playwright E2E 对比测试

---

## 仓库结构

```
GouXiangDB-v2/
├── apps/
│   ├── api/              # Node.js + Hono + Prisma 后端
│   ├── web/              # React + Vite + Tailwind 前端
│   └── desktop/          # Tauri 桌面壳
├── packages/
│   ├── shared-types/     # 前后端共享 TS 类型（28 字段 + 关联语义 + RBAC）
│   └── design-tokens/    # 跨端设计 token（从 v1 GXTheme 移植）
├── docs/
│   ├── adr/              # 架构决策记录
│   │   └── 0001-architecture-selection.md
│   ├── test-matrix.md    # 深度对比测试基线
│   └── migration/        # v1 SQLite → v2 PG 迁移脚本（待开发）
├── scripts/
│   └── compare-test.sh   # v1 vs v2 深度对比测试（待开发）
├── package.json          # pnpm workspace root
└── pnpm-workspace.yaml
```

---

## 启动开发环境

### 前置依赖
- Node.js ≥ 20（推荐 22.22.2）
- pnpm ≥ 9
- PostgreSQL ≥ 14（推荐 16）
- Rust + Cargo（Tauri 桌面壳需要）

### 启动步骤

```bash
# 1. 安装依赖
pnpm install

# 2. 配置数据库
export DATABASE_URL="postgresql://user:pass@localhost:5432/gouxiangdb"
pnpm db:migrate   # 跑 Prisma migrations

# 3. 启动后端
pnpm dev:api      # http://localhost:3001

# 4. 启动前端（新终端）
pnpm dev:web      # http://localhost:5173

# 5. 启动桌面壳（新终端，需要先 pnpm build:web）
pnpm dev:desktop  # Tauri 窗口

# 同时启动所有服务
pnpm dev
```

### 跑测试

```bash
pnpm test          # 全部
pnpm test:unit     # 单元测试（Vitest）
pnpm test:e2e      # E2E 测试（Playwright）
pnpm compare-test  # v1 vs v2 深度对比（待开发）
```

---

## 与 v1 的关系

| v1 组件 | v2 对应 | 状态 |
|---|---|---|
| Core/Models.swift | packages/shared-types/src/entities.ts | ✅ 已移植 |
| Core/RecordRepository.swift | apps/api/src/domain/hydrate.ts | ✅ 算法对齐（完整 Lookup/Rollup/Formula 待开发）|
| Core/MetaRepository.swift | apps/api/src/routes/fields.ts | ✅ 关联字段双向自动建 |
| Core/PermissionChecker.swift | packages/shared-types/src/entities.ts (permissionsForRole) | ✅ |
| Shared/Theme.swift | packages/design-tokens/src/{colors,layout}.ts | ✅ 1:1 移植 |
| Features/Sidebar/SidebarView.swift | apps/web/src/features/sidebar/Sidebar.tsx | ✅ 视觉对齐（v1 选中态蓝条） |
| Features/DetailRouter.swift | apps/web/src/features/detail/DetailRouter.tsx | ✅ 视觉对齐（面包屑 + 视图标签） |
| Features/Grid/GridView.swift | apps/web/src/features/grid/GridView.tsx | ✅ 视觉对齐（斑马纹 + 字段类型彩色图标） |
| Features/Gallery/Form/Detail/Drawer | (待开发) | ⏳ |
| Core/MetaRepository.swift (CSV 导入) | apps/api/src/routes/csv.ts (待开发) | ⏳ |
| 25 条数据层断言 | packages/shared-types/src/__tests__/relations.test.ts | ✅ 21 条全绿（合并相关断言） |

---

## 验收门槛（用户拍板）

v2 重构在以下条件全部满足前**不交付**：

1. ✅ 所有功能点行为一致（详见 `docs/test-matrix.md`）
2. ⏳ 视觉对比 ≤2% 像素差异（Playwright 截图 diff）
3. ⏳ 性能不超过 v1 1.2 倍（详见 test-matrix §8）
4. ✅ Core 层 21+ 条算法断言全绿
5. ⏳ 零 P0 缺陷
6. ⏳ 零新增 bug（对比基线后新增的 bug 必须修复）

未达标即不交付，重新迭代。

---

## 决策记录

详见 `docs/adr/0001-architecture-selection.md`。

核心选型：Node.js + Hono + PostgreSQL + Prisma + Vite + React + Tailwind + Tauri。

变更请联系 ADR 流程。