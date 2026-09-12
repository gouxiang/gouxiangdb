# GouXiangDB v2 功能升级前稳定性基线报告

- 日期：2026-09-12
- 基线提交：`637eb9d`（分支 `main`，标签 `v0.1.0`，基线分支 `baseline/0.1`）
- 范围：升级前"全面功能升级"前置处理中的【阶段二目录清理结果】+【阶段三稳定性基线测试与架构审查】
- 原则：测试只读 / 非破坏，不修改现有数据；任何整改先报方案再执行

---

## 一、目录清理结果（阶段二）

### 1. 唯一最新项目目录
- 保留唯一活跃工程：`GouXiangDB-v2`（pnpm monorepo），结构：
  - `apps/api`（Hono + Prisma + SQLite）、`apps/web`（React18 + Vite + Tailwind + Plait/Drawnix）、`apps/desktop`（Tauri 壳）
  - `packages/shared-types`、`packages/design-tokens`（前后端共用）
- 原版 macOS Swift 工程 `GouXiangDB/`：代码级与 v2 **零运行时依赖**（见下"依赖审计"），计划在远程基线推送完成后整目录移入废纸篓（可恢复），并把 `GouXiangDB-v2` 改名为 `GouXiangDB`（见第六节待办）。

### 2. 依赖审计结论（v2 不依赖 v1，删除安全）
| 检查项 | 结论 |
|---|---|
| 指向 v1/外部的符号链接 | 无（node_modules 内部链接属依赖自身） |
| `file:`/`link:` 外部本地依赖 | 无；仅 `workspace:*` 引用仓库内 `@gx/shared-types`、`@gx/design-tokens` |
| tsconfig paths / vite alias / tauri frontendDist | 全部在 v2 内解析；tauri `frontendDist=../web/dist` |
| 绝对路径 `/Users/daijing` 硬编码（源码/配置） | 无（仅 `apps/api/.env` 的 `DATABASE_URL` 为绝对路径，.env 不入库；已提供相对路径 `.env.example`） |
| `.swift` / `.xcodeproj` 运行时引用 | 无；源码中"v1 xxx.swift"字样仅为"移植出处"注释 |
| 附件/上传目录 | `apps/api/uploads`（v2 内部，自包含） |
| prisma | sqlite，`url=env(DATABASE_URL)`，11 个迁移 |

### 3. 已执行清理（均进 macOS 废纸篓，可恢复；已先全量备份）
- 安全备份：`~/.gx-precleanup-backup-20260912-185737/`（两份 `.workbuddy` 完整 tar）。
- 迁移并零丢失合并 `.workbuddy` 项目记忆到 v2：memory 03–12 全齐、MEMORY 已并入旧快照独有要点、artifacts 21 项、3 份顶层修复报告、skills 保留；v2 旧快照归整到 `.workbuddy/memory/archive-v2dir/`。
- 删除（废纸篓）：根目录 8 个零字节 `_tmp_*`、`scripts/tmp-extract-heading.ts`、`scripts/tmp-paste-regex.ts`、`.verify-shots/`（63+ 张调试截图）。
- 仅本地保留但不入库（.gitignore）：`node_modules/`、`dist/`、`.env`、`dev.db(+wal/shm)`、`.db-backups/`、`.workbuddy/verify` 与全部 `.png`、根 `artifacts/`、`.workbuddy-artifacts/`。

### 4. 保留/删除/待确认清单（汇总）
- **保留（主线，已入库）**：apps、packages、根配置、pnpm-lock、pnpm-workspace、tsconfig.base、patches、prisma（schema + 11 migrations）、docs、README、RELEASE、`scripts/{dev-up.sh,smoke_defaults.py,compare-test.sh}`、`.env.example`、`.gitignore`、`.workbuddy` 的 md 知识文本。
- **已删除（废纸篓）**：见 1.3。
- **待确认（暂不动）**：v1 整目录（待远程推送后删除）、桌面外 DerivedData/应用沙盒/废纸篓旧产物、`~/.workbuddy/projects` 会话元数据。

---

## 二、基线测试结果（阶段三）

### 1. 自动化测试（非破坏：单测不连真实库，仓储走 mock）
| 套件 | 命令 | 结果 |
|---|---|---|
| shared-types 单测 | `pnpm --filter @gx/shared-types test` | ✅ **56/56 通过**（4 文件） |
| api 单测 | `pnpm --filter @gx/api test` | ✅ **214/214 通过**（8 文件） |
| web 单测 | `pnpm --filter @gx/web test` | ⚠️ 无测试文件，`vitest run` 退出 1（配置问题，非功能失败，见风险 R6） |
| 全工作区 typecheck | `pnpm -r typecheck` | ✅ 5 个工作区 **0 错** |
| api 生产构建 | `pnpm --filter @gx/api build`（tsc） | ✅ 通过 |
| web 生产构建 | `pnpm --filter @gx/web build`（vite） | ✅ 通过，8.6s（有 chunk 体积告警，见 R7） |

api 测试覆盖分布：formula 43、formula-functions 86、cross-formula 20、formula-output-type 9、hydrate 21、record_filter 12、public 分享 13、required-create 10。

### 2. 运行时只读冒烟（dev：api 3001 / web 5173）
- `GET /api/health` → 200，`db:ok`，version 0.1.0。
- 账密登录 → 200，签发 token；错误密码 → 401；无 token 访问 `/bases` → 401。
- `GET /api/auth/me` → 200；`GET /api/bases`、`/api/tables?baseId=` → 200；`/api/kb` → 200。
- 越权/不存在资源：访问他人 base → 403（受控，非 500），路径/路由受控返回 404，无未捕获崩溃。
- 结论：鉴权、RBAC、路由、DB 连接、只读主链路健康。

### 3. 已有的历史真机/集成回归（沿用结论）
- 公式引擎端到端：`/tmp/gx-formula-e2e.cjs`（75 断言）、`gx-formula-e2e2.cjs`（11 断言）、UI 真机 `gx-formula-ui4.cjs`（公式 SUM 子表=300 等）此前全绿（临时脚本，未入库；用例已沉淀到回归集）。
- 默认值公式弹窗因子表候选缺失，本轮已修复并 Playwright 真机验证（见回归 RC-26）。

---

## 三、架构 / 模块划分 / 耦合审查

### 1. 分层（清晰）
- `packages/shared-types`：字段/过滤/关系/公式函数元数据/默认值来源等**前后端共用内核**，零 UI/零 IO 依赖，是单一事实源（filter、relations、type-groups 前后端同构）。
- `apps/api/src/domain`：纯领域逻辑（hydrate 两轮、formula 引擎、recordService、defaults 反向重算、kb、csv）；`routes` 仅做 HTTP/鉴权/事务编排；`db.ts` 统一 Prisma 与 SQLite PRAGMA。
- `apps/web`：`api/client.ts` + `hooks.ts`（react-query）为唯一数据出口（约定禁裸 fetch）；`features/*` 按域划分；`components/ui`、`icons.tsx` 自建组件，颜色/间距走 `gx-*` token。
- `apps/desktop`：薄 Tauri 壳，devUrl 指向 web、frontendDist 指 web/dist，无重复业务逻辑。

### 2. 关键耦合点（需在升级中重点看护）
1. **hydration 契约**：`records.fields` 存 JSON FieldValue map；公式/关联/lookup 依赖两轮 hydrate + mergedCache/merging 防循环。任何写路径改动都要保证事务化与反向重算（defaults）一致。
2. **shared-types 同构**：过滤/类型/公式元数据改动同时影响前后端，必须同步回归两侧。
3. **Plait/Drawnix 画布**：z 序=board.children 数组序；选区双轨（WeakMap 实时源 + selectedIds 快照）；WebKit 负 viewBox 白卡需补偿 g；右键浮层须带 `plait-board-attached`；补丁 `patches/@plait__draw@0.89.2.patch` 升级需重放并清 `.vite`。属高耦合、易回归区。
4. **KB 编辑/画布共享持久化**：useDocPersistence + contentVersion 乐观锁；三弹窗 requestClose 脏确认；嵌入统一渲染链路 useResolvedDoc/RefEmbedBody/RefEmbedCard。
5. **默认值/公式两条链路已统一**：`evaluateRecordFormula` 为唯一公式入口，默认值公式复用；`selfFields` 必须传 `formulaFields`（不能传 `selfMatchFields`），否则公式弹窗缺子表。

### 3. 不合理依赖 / 技术债
- 包管理器锁为 pnpm；`@plait/mind` 为传递依赖，禁止直接 import（会 500 白屏）。
- vite7 清空 dist 受本机 safe-delete shim 影响，偶发 ETIMEDOUT，重试即过（环境问题，非代码）。
- 无 ESLint 配置落地、无 CI、无 web 单测，质量门目前依赖人工跑 typecheck/单测/build。

---

## 四、问题与风险清单（升级前已知，按优先级）

| ID | 等级 | 模块 | 问题 | 影响 | 建议处置 |
|---|---|---|---|---|---|
| R1 | 中（遗留） | api/recordService | 全表 findMany 无 take + 全量 hydrate + 内存分页（U-2 主项） | 单表 >5000 行或多关联时卡顿/内存峰值 | 触发条件（>5000 行或 P95>800ms）后做 filter SQL 化/视图分流；升级中避免放大 |
| R2 | 中（遗留） | 附件 | 附件 dataURL 内嵌 fields JSON（2MB/个、20/格 上限为过渡） | 叠加全表读取放大内存；无对象存储 | 升级到独立附件表/对象存储（U-3 架构项） |
| R3 | 中（遗留） | 字段设置 | 唯一/必填改设置不校验存量；relationKind 变更不收敛存量 linkRow（U-6） | 历史脏数据可能不满足新约束 | 需产品决策（拒绝 or 迁移）后补存量迁移/校验 |
| R4 | 低（遗留） | 安全/回收 | restore field 不校验对端存活；分享链接删除后 member 不回收；JWT 改密不失效；头像扩展名信任 file.type（U-10 余项） | 边角一致性/安全卫生 | 排期逐项收口 |
| R5 | 低（遗留） | 表格编辑 | grid 无撤销重做；列宽本地不持久；分组无虚拟化；LinksEditor 仅前 200 条 | 大表体验 | 升级迭代 |
| R6 | 工程化 | 构建/测试 | 根 `pnpm test` 因 web 无测试退出 1；`test:e2e` 指向不存在的 `vitest.e2e.config.ts`；根 `lint` 脚本无实现；无 CI | 自动化质量门不稳定，易误判红灯 | 建议：web `test` 改 `vitest run --passWithNoTests`；移除/补齐 e2e 配置；加最小 eslint 或去掉 lint 脚本；加 Gitee/GitHub CI（先报方案） |
| R7 | 性能 | web 构建 | 3 个 chunk >500KB（flowchart-elk 1.45MB、主入口 1.18MB、mindmap 0.54MB） | 首屏加载 | 动态 import / manualChunks 分包（升级时优化） |
| R8 | 运维 | 配置 | `apps/api/.env` 用绝对 DB 路径；改名/换机会失效 | 目录改名后需同步 | 已给 `.env.example` 相对路径；**改名时需把本地 .env 的 DATABASE_URL 改为 `file:./dev.db` 并重启** |
| R9 | 并发（已缓解） | SQLite | 写整 JSON 覆盖无乐观锁重试；已加 busy_timeout=5000+WAL（U-7） | 极高异字段并发仍可能 BUSY | 观察，必要时加写串行/重试 |
| R10 | 可维护性 | 画布 | 大量 Plait 行为依赖补丁、WeakMap 选区、WebKit 补偿 g 等"非显然契约" | 升级依赖/改动选区易回归 | 契约已入 MEMORY/docs；升级前务必跑画布回归（RC-16~RC-24） |
| R11 | 环境 | 构建 | vite safe-delete shim 偶发 ETIMEDOUT | 首次构建可能失败 | 重试即可；CI 用标准环境可规避 |

> 说明：审计报告（`docs/audits/2026-09-11-full-system-audit.md`）中的 29 项（D-1/2/3、S-1、C-1~C-11、U-1~U-10、E-1/2）已分四批次修复并回填验证；上表仅列仍遗留或工程化/性能类风险，无未修复的 P0。

---

## 五、是否可安全进入功能升级——结论

**结论：有条件通过（满足前置后可进入升级）。**

- ✅ 无未修复 P0；核心单测 214+56 全绿、typecheck 0 错、api/web 构建通过、运行时主链路与鉴权健康；v2 对 v1 零代码依赖。
- ✅ 本地 Git 基线（main + v0.1.0 + baseline/0.1）已建立，可随时回滚比对。

**进入升级前需满足的前提条件（建议按序）：**
1. 提供 Gitee PAT，完成远程私有仓创建与 `main` / `baseline/0.1` / `v0.1.0` 推送（拿到异地基线，防丢）。
2. 推送成功后再执行：把 v1 整目录移入废纸篓、将 `GouXiangDB-v2` 改名为 `GouXiangDB`，并同步本地 `.env` 的 `DATABASE_URL` 为相对路径后重启验证（对应 R8）。
3. 建议先合入 R6 的最小工程化修正（让根 test 不变红、补 CI），避免升级期误判——此项可在升级首条 PR 做，会先给方案。
4. 升级过程中每个功能迭代后执行《历史 bug 回归用例集》（`docs/baseline/2026-09-12-regression-cases.md`），重点看护 R1/R10（数据分页与画布契约）。

在前提 1、2 完成前，**不建议**开始破坏性功能改造（目前仅有异地缺失 + 目录改名两件收尾动作）。
