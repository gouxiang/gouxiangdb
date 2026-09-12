# ADR-0002：数据库落地为 SQLite（修订 ADR-0001 的 PostgreSQL 初选）

**状态**：Accepted（2026-09-12 回填，决策实际生效于 2026-09 落地阶段）
**作者**：经用户授权按「生产可落地 / 零外部依赖优先」决策
**取代关系**：本文仅修订 [ADR-0001](0001-architecture-selection.md) 中的**数据库**一项；其余选型（Hono / Prisma / React / Vite / Tailwind / Tauri / B-S 三层）维持不变。

---

## 上下文

ADR-0001 在 2026-09-04 拍板阶段把数据库初选为 **PostgreSQL**，理由是多用户 / JSONB / 行级权限。但在 09-04 之后的落地实现中，团队发现该阶段引入 PostgreSQL 与项目现实不匹配：

1. **首要目标是可运行、可复现的单包基线**：本地开发、Tauri 桌面端、CI、未来换机部署都要求「clone 即跑」，不应强依赖一个需要单独安装、建库、配账号的外部数据库服务。
2. **数据访问已用 Prisma 抽象**：schema 与查询全部走 Prisma Client，数据库提供商对业务代码透明，切换成本主要集中在原生 SQL 与 provider 特性上。
3. **当前规模未触及 SQLite 瓶颈**：单库文件 + WAL 已能支撑开发与单机多用户试用；真正的高并发多租户是后续演进而非当前阻塞项。
4. **SQLite 与 v1 数据形态同源**：v1 即 SQLite，便于后续数据迁移与对照测试。

与此同时，已落地的工程事实是：

- `apps/api/prisma/schema.prisma` 中 `datasource db { provider = "sqlite" }`；
- `apps/api/prisma/migrations/migration_lock.toml` 锁定 `provider = "sqlite"`；
- 现有 10 个迁移均为 SQLite 方言；
- 连接串统一为相对路径 `DATABASE_URL="file:./dev.db"`（相对 schema 目录解析到 `apps/api/prisma/dev.db`），并启用 WAL + `busy_timeout=5000`。

## 决策

**GouXiangDB 当前版本数据库确定为 SQLite**，ADR-0001 中「PostgreSQL」的表述以本文为准。

配套约束：

- 所有表名经 Prisma `@@map` 映射为 snake_case；
- schema 变更一律手写 `migration.sql` + `prisma migrate deploy`（非交互环境不用 `migrate dev`），失败迁移用 `migrate resolve --rolled-back` 处理；
- 写路径事务化（DbTx）；SQLite 运维 PRAGMA（busy_timeout / WAL）必须用 `$queryRawUnsafe` 执行——`$executeRawUnsafe` 在该 Prisma 版本会静默失败；
- `DATABASE_URL` 一律使用相对路径 `file:./dev.db`，禁止写死本机绝对路径，保证改名 / 换机 / 打包后路径自洽；
- 机密走环境变量（`JWT_SECRET` 等），生产环境缺失关键变量时拒绝启动；`.env` 与 `*.db` 已在 `.gitignore` 忽略，仅提交 `.env.example`。

## 后果

**正面**

- 零外部数据库依赖，clone → `pnpm install` → `migrate deploy` → 起服务即可运行，显著降低部署与新人上手成本；
- 与 Tauri 桌面壳、本地单机模式天然契合；
- 库文件可直接备份 / 拷贝 / 对照，便于 v1→v2 数据迁移与回归。

**负面 / 约束**

- 高并发写、多实例横向扩展、行级细粒度权限不是 SQLite 强项；当前以「单实例 + WAL + 短事务 + busy_timeout」规避写锁竞争。
- 全表 `findMany` 无 `take` + 内存分页在单表 >5000 行时会成为瓶颈（基线风险 R1），需要在触发阈值后做 filter SQL 化 / 视图分流。
- 附件以 dataURL 内嵌记录 JSON（过渡方案），后续需独立附件表 / 对象存储（基线风险 R2）。

**向服务端数据库的演进路径（未来若做多租户 SaaS）**

因数据访问已隔离在 Prisma 层，未来切换 PostgreSQL 属于「新增 provider + 迁移方言适配」而非重写：新增 PG datasource 与适配层、把 SQLite 方言的手写迁移与原生 SQL（PRAGMA、日期函数等）做方言抽象、补数据导出 / 导入通道即可。该演进触发条件＝确认要做真正的多实例多租户商用部署，届时另立 ADR-0003。

## 相关

- [ADR-0001](0001-architecture-selection.md)：架构总选型（数据库一项以本文为准）
- `docs/baseline/2026-09-12-stability-baseline.md`：R1（大表分页）、R2（附件存储）、R9（SQLite 并发）风险登记
- `README.md` §数据库说明：面向使用者的部署口径
