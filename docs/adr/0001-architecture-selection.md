# ADR-0001：GouXiangDB v2 架构选型（前后端分离 · 客户端壳化 · 多端复用）

> **修订说明（2026-09-12）**：本文「数据库 = PostgreSQL」一项在落地阶段调整为 **SQLite**，详见 [ADR-0002](0002-database-sqlite.md)。其余选型（Hono / Prisma / React / Vite / Tailwind / Tauri / B-S 三层）维持有效。下文涉及 PostgreSQL 的表述为拍板当时的历史记录，保留以追溯决策过程。

**状态**：Accepted（2026-09-04 拍板；数据库一项见 ADR-0002 修订）
**作者**：经用户授权按"最优方案"自主决策
**约束**：功能 1:1 对等当前 macOS 版 · 零新增 bug · 深度对比测试通过

---

## 上下文

GouXiangDB v1 是 macOS 原生智能表格（Swift 6 + SwiftUI + SQLite3，clean-room 复刻 NocoDB）。它走到了三个瓶颈：

1. **多用户场景不可达**：本地 SQLite 单进程，无服务端、无共享。
2. **多端封包成本巨大**：iOS / Android / 桌面端各做一套 Native 客户端，工作量翻倍。
3. **macOS 硬编码反噬**：SwiftUI 视图绑死 + Core 层用 Swift 写，使代码无法跨端复用。"在现有基础上重写"指的是借鉴业务模型和视觉风格，不是直接搬代码。

## 决策

采用 **B/S 三层架构**：薄客户端壳 + 单一后端 API + 跨端核心业务层。

### 选型一览

| 维度 | 选型 | 理由 |
|---|---|---|
| 后端语言 | **Node.js + TypeScript** | 生态最大，前后端同语言共享类型，人才好招 |
| 后端框架 | **Hono** | 轻量（~14kb）、TypeScript-first、跨运行时（Node/Bun/Cloudflare）、性能强 |
| 数据库 | **PostgreSQL** | 多用户/JSONB/行级权限，事实标准；旧 SQLite 数据走迁移脚本 |
| ORM | **Prisma** | 类型安全、迁移工具完善、与 TS 深度集成 |
| 前端框架 | **React 18** + Vite | 生态最大、组件库最丰富、招人最容易 |
| UI 组件 | **shadcn/ui** + **Radix UI** | 不是组件库是源码，可定制、视觉可控、可 1:1 复刻 v1 风格 |
| 样式 | **Tailwind CSS** | 设计 token 与 v1 的 GXTheme 1:1 映射为 design tokens |
| 状态管理 | **Zustand** | 轻量、TS 友好、避免 Redux 模板代码 |
| 数据请求 | **TanStack Query** | 缓存/失效/乐观更新内置 |
| 实时协作 | **Yjs + y-websocket**（P3 阶段） | CRDT 无冲突，最成熟方案 |
| 桌面壳 | **Tauri 2.x** | 包小（5-10MB）、Rust 后端、原生菜单/快捷键 |
| 移动壳 | **Capacitor**（P3 阶段） | 复用同一份前端代码生成 .apk/.ipa |
| 单测 | **Vitest** | 与 Vite 同源、快 |
| E2E | **Playwright** | 跨浏览器、自带对比截图能力 |
| 鉴权 | **自建 JWT**（P0）→ 可升级 OIDC | 最简单起步，未来按需接企业 SSO |
| 包管理 | **pnpm workspaces** | 单仓多包、磁盘高效、严格依赖隔离 |

### 仓库：单仓多包结构

```
GouXiangDB-v2/
├── apps/
│   ├── api/           # Node.js + Hono + Prisma 后端
│   ├── web/           # React + Vite 前端
│   └── desktop/       # Tauri 桌面壳（包 web 产物）
├── packages/
│   ├── shared-types/  # 前后端共享 TS 类型
│   ├── design-tokens/  # 跨端设计 token（颜色/间距/字号）
│   └── test-fixtures/ # 测试数据集（用于深度对比测试）
├── docs/
│   ├── adr/           # 架构决策记录
│   ├── test-matrix.md # 功能对比测试矩阵（回归基线）
│   └── migration/     # v1 → v2 数据迁移脚本
├── scripts/
│   └── compare-test.sh # 深度对比测试脚本（v1 vs v2）
└── package.json       # pnpm workspace root
```

### 与 v1 的对应关系

| v1 层 | v2 对应 | 复用策略 |
|---|---|---|
| Core (Models/Repository/Permission) | packages/shared-types + apps/api/src/domain | **业务规则借鉴**（字段类型系统、关系语义、公式算法、权限模型），代码用 TS 重写 |
| Shared (Theme.swift) | packages/design-tokens + Tailwind config | **设计语义 1:1 映射**为 design tokens JSON，颜色/间距/字号的"含义"复用 |
| Features (Sidebar/Grid/Gallery/...) | apps/web/src | **视觉/交互 1:1 复刻**，代码全部重写为 React |

### 客户端壳策略

- **P1 阶段**：网页版直接部署（最快出价值）
- **P2 阶段**：Tauri 桌面壳打包（macOS/Windows/Linux）
- **P3 阶段**：Capacitor 移动壳（iOS/Android）

所有壳消费同一个 `apps/api/` 服务，业务逻辑零分叉。

## 影响

### 正面

- 多端共用一份业务代码，新增端成本降到"前端适配"级别
- 多用户/权限/共享可自然支持（PG + JWT + RBAC）
- 实时协作可叠加（Yjs 与现有数据模型正交）
- 部署灵活（Vercel + Railway / 自托管 / Docker）

### 负面

- v1 Swift 代码不能直接复用（最大误判风险，决策中已明确）
- v1 数据需要迁移脚本（link_row / 字段元数据 / 记录数据）
- 公式/Lookup/Rollup 的 hydration 思路要换：v1 客户端现算 → v2 服务端预计算 + WebSocket 增量推送
- 学习成本：TS / Prisma / Hono / Tailwind 全套需要上手
- 工作量：完整版 2-3 个月，最简可用版（P0+P1+P2）约 6-8 周

### 缓解措施

- 借鉴 v1 字段类型系统、关系语义、权限模型的成熟算法（避免重新设计踩坑）
- 阶段产物用同一份功能测试矩阵做回归基线
- 数据迁移脚本双写验证（v1 导出 → v2 导入 → 字段/记录/关联全相等）

## 决策日期

2026-09-04 用户拍板：彻底重构完再统一测试。功能与当前一致、零新增 bug、深度对比测试通过才交付。