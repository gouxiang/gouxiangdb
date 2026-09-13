# Spec — GouXiangDB 企业版（组织工作台六支柱）v1.0

> 生成日期：2026-09-12　生成人：项目总监（大湾区靓仔）
> 基于（已主理人确认）：PRD-enterprise v1.2 + ARCH-enterprise（R-MCP-1/R-MCP-2 收口）+ UIUX-enterprise v1.x + PRD/ARCH-production（M0–M1 子集）
> 状态：**已确认（Phase 1 主理人 GO），团队内部开发唯一依据**
> 编号约定：里程碑 M0–M7；需求 ID 沿用 D/N/O/V/MC；冲突 C-1~C15；裁决 R-MCP-1（MCP 双闸门）、R-MCP-2（放弃 WorkBuddy 原生、MCP 为核心、M7 总验收）。

---

## 1. 产品定义

- **一句话描述**：在单机智能表格 + 知识库 + 画布 v0.1.0 之上，建成可私有化、百万行容量、统一组织导航、角色/部门/资源三源并集授权、内建语义检索、并通过标准鉴权 MCP 被任意第三方 AI 安全调用的「组织工作台操作系统」。
- **目标用户**：内部用户、工作区/库管理员、私有化运维者、客户自有 AI 智能体（经 MCP）。
- **核心问题**：数据敢托付（M0/M1）、组织能当唯一工作台（M2/M3）、管理员敢放全员进来（M4）、内容找得到且可被 AI 理解（M5）、第三方 AI「接进来就能干活、且只能干身份内的活」（M6）。

## 2. MVP 范围（锁定——不在表内不做）

| 优先级 | 功能 | 里程碑 | 验收标准摘要 |
|---|---|---|---|
| P0 | 生产基座：版本单源、配置闸门、CI、备份恢复（age X25519）、安全收口 | M0 | 干净机部署、备份/恢复演练通过、CI 绿 |
| P0 | 数据底座：写串行队列、keyset 分页、hydration 批量化、索引/FTS | M1 | 50 万行 P95<800ms；百万行证伪门（不过走 ADR-0008） |
| P0 | 组织通讯录：部门无限树、成员多部门、账号生命周期、系统+自定义角色 | M2 | 6 层部门/调岗兼岗/停用即时失效；不触资源权限 |
| P0 | 统一导航资源树：nav_nodes 权威树 + menu_items 引用层、新外壳、存量回填 | M3 | 旧树新树双切视觉一致、回填对账 0 差异、旧链接重定向；**openapi.yaml 出口冻结** |
| P0 | 统一权限引擎：纯 allow 三源并集、字段 fieldMask、内容 inheritAncestors、shadow→enforce | M4 | 越权矩阵全绿、shadow 差异连续一迭代为 0、面板双向同步 |
| P0 | 向量库与统一检索：outbox、派生 search.db、FTS5 trigram、RRF、embedding 三模式 | M5 | spike 达标、10 万 chunk P95<500ms、越权零泄漏、kill 后降级 FTS |
| P0 | 鉴权 MCP：PAT、双传输、tools/list 双闸门、数据表/文档块/画布图元三语言、审计 | M6 | Inspector 全工具、越权三对抗用例、双客户端连通 PoC |
| P0 | 企业版总验收 | M7 | 五主线对抗全绿、v0.1.0→M7 直升抽样 0 差异、回滚演练、验收报告 |
| P1/P2 | 收藏/最近访问、权限申请轻闭环、OAuth 2.1、可访问性 AA 等 | 各里程碑 | 见 PRD 对应条目 |

## 3. 明确不做（Out-of-Scope——锁定）

| 不做 | 原因 | 何时考虑 |
|---|---|---|
| 内置/自带 AI 聊天框、服务端模型编排、自建 Web 对话面板 | R-MCP-2：本期 AI 接入＝第三方经标准 MCP；不押单一平台 | 未来立项自有 AI 产品，复用 service/tool-core |
| WorkBuddy 原生/专属适配、连接器市场上架商务 | 方案放弃；MCP 协议无关 | 有明确客户再评估 |
| 行级（任意行自由条件）权限、deny/effect 拒绝语义 | D-2 纯 allow；收窄仅 fieldMask + 中断继承 | 行级权限后续大版本 |
| 审批流/会签、ABAC（IP/时间/设备） | MVP ROI 不足 | v2 |
| 个人导航定制/多主题、跨工作区、多租户 SaaS | D-3 仅工作区级一棵树；单工作区交付 | SaaS 化时 |
| 实时协同 CRDT、向量集群/reranker/多模态 embedding、MCP Resources 全功能（仅承载只读说明书）/Prompts | 控制爆炸半径 | 按需 |
| PG 切换（除非触阈值）、高可用集群、移动端原生 App、正式国际化 | 单实例可重建前提 | 触 ADR-0008 阈值 |

## 4. 技术架构（锁定，含版本锚定）

| 层 | 技术 | 版本（实施前 `pnpm list` 复核） | 锁定原因 |
|---|---|---|---|
| 包管理/monorepo | pnpm workspaces | 现状 | 既有 |
| 后端 | Hono + TypeScript（Node ≥20） | 现状 | 既有，MCP 可同进程桥接 |
| ORM/DB | Prisma + **SQLite（WAL）** | 现状；迁移手写 migration.sql + `migrate deploy` | ADR-0001/0002；切库阈值 ADR-0008 |
| 前端 | React 18 + Vite + Tailwind + TanStack Query | 现状 | web-conventions：禁新依赖、禁直接 fetch、gx-* token |
| 画布 | Plait/Drawnix | @plait/draw 0.89.2 / drawnix 0.4.0-0 | patch 升级需重放 |
| 桌面壳 | Tauri | 现状 | 多端 |
| 向量 | sqlite-vec 0.1.x（派生独立 search.db，better-sqlite3 旁路）+ FTS5 trigram | 锁版本，可 truncate 重建 | 不污染主库 |
| Embedding | 本地 @huggingface/transformers + Xenova/bge-small-zh-v1.5（512 维，默认）；云端 OpenAI 兼容可配；off 降级 | optionalDependencies | 数据不出网默认 |
| MCP | @modelcontextprotocol/sdk `^1.30`（实施锁版本复测 Streamable HTTP 无状态 API） | 1.30.0 调研值 | 单 server 双传输 |
| 令牌/OAuth | jose 5.9（已在依赖） | 5.9 | PAT 先行，OAuth 可选不引重型 IdP |
| 备份加密 | age **X25519 收件人模式**（公钥在备份机、identity 离线） | 系统包 | 支持无人值守 cron |
| 部署 | Caddy(TLS) → systemd 单实例 Node → 同机 SQLite+uploads；Docker Compose 仅可选探针 | — | 裸机为主线 |
| 认证 | 现有 session/JWT；MCP 用 PAT（gxpat_，仅存 SHA-256 hash）；OAuth2.1+PKCE 可选 | access 1h / refresh ≥30d | — |

**铁律**：所有企业版新表不得写死 SQLite 专有语法（为 ADR-0008 留方言边界）；所有迁移只增（新表/新可空列/回填），发布前在线快照，30 分钟内可回滚。

## 5. API 端点清单（纲要——M3 出口以 openapi.yaml 为唯一联调依据）

> M0/M1 不新增对外契约；M2 起全部挂 `/api/v1/`，旧 `/api` 保留一个迭代后下线（R 裁决）。

| Method | Path | 功能 | 鉴权 | 里程碑 |
|---|---|---|---|---|
| GET | `/api/v1/workspaces/current/tree` | 权威资源树（含我的动作位） | r | M3 |
| GET/PATCH | `/api/v1/workspaces/current/menu` | 菜单引用层读写（不动 nav_nodes/策略） | r / manage_menu | M3 |
| * | `/api/v1/org/departments`、`/org/members`、`/org/roles`（含 members/assignments/disable/reactivate） | 通讯录 CRUD | admin/manage_members | M2 |
| GET/PUT | `/api/v1/nodes/:id/policies` | 读/批量 upsert-delete 纯 allow 策略（无 effect 字段） | r / manage_share | M4 |
| PATCH | `/api/v1/nodes/:id/inheritance` | 内容叶子 inheritAncestors 开关（二次确认，返回去重失访人数） | manage_share | M4 |
| GET | `/api/v1/nodes/:id/effective` | 有效权限来源链调试（role/dept/direct/owner） | r | M4 |
| GET/POST/DELETE | `/api/v1/pats`（`:id`） | PAT 管理（明文仅创建响应一次） | 本人 | M6 |
| GET | `/api/v1/search?q=&mode=auto` | 混合检索（权限先收敛再召回） | r | M5 |
| POST | `/api/v1/admin/reindex` | 派生数据重建（job） | admin | M5 |
| ANY | `/mcp` | MCP Streamable HTTP（Bearer PAT/OAuth） | 每工具执行期 enforce | M6 |
| * | `/oauth/*`、`/.well-known/oauth-*` | OAuth 2.1（可选档） | 公开 | M6 可选 |

**MCP 工具命名空间**：`workspace.* / table.* / record.* / doc.* / canvas.* / admin.*`（全集见 ARCH §8.3，运行时按账号过滤为子集）。文档机语 `doc.block.*` 锚 Block + contentVersion 乐观锁；画布 `canvas.element.*` 锚 Plait（z 序=数组序、3×2 网格常量抽 shared、显式 id、不碰 WebKit 补偿层）。

## 6. 数据库表清单（锁定）

- **M2 组织**：`workspaces`、`departments`（parentId 真相 + `path` 物化路径派生，前缀 LIKE）、`dept_members`（成员多对多多部门）、`roles`（系统五枚 owner/creator/editor/commenter/viewer 内置不可删 + 自定义）、`role_assignments`（subject=user/dept）；`users` 加 `status(INVITED/ACTIVE/DISABLED)`、`workspaceId` 等可空列。
- **M3 资源树**：`nav_nodes`（`workspaceId, parentId, resourceType, resourceId, inheritAncestors Boolean @default(true)`，`@@unique([workspaceId,resourceType,resourceId])`，唯一父级承载继承授权）；`menu_items`（`workspaceId,parentId,type(container|shortcut),nodeId→nav_nodes,label,iconName,ord`，nodeId **不唯一**可多处引用）；`auth_policies` 同期**建表冻结契约但不写策略**。
- **M4 权限**：`auth_policies`（`nodeId, subjectType(user|dept|role), subjectId, actions, fieldMask`——**无 effect/deny 列**）启用写入；存量 `members/kb_members/kb_doc_acls` 回填 allow（旧协作者→direct、旧角色成员→系统/自定义角色、旧分享→单内容外链例外）；旧表本期保留双跑不物理删除。
- **M5 派生库 search.db（独立文件，可 truncate 重建，不进业务备份）**：`change_events`(outbox)、向量 chunk 表（vec0）、FTS5 trigram 表、`index_meta`；主库仅 outbox/change_events。
- **M6**：`personal_access_tokens`（hash/name/scope/lastUsedAt/expiresAt/revoked）；可选 oauth 表。
- 索引：M1 为热字段补物理索引；`records` 现状仅 tableId/createdAt 需强化；分组授权为条件策略节点（tableId+fieldId+桶值），不复制行。

## 7. 页面清单（锁定）

| 页面/区域 | 路由/位置 | 核心组件 | 对应 API | Token 主题 |
|---|---|---|---|---|
| 工作区外壳 | 主框架 | Logo 区 / 一级导航 / 左下设置区 / 内容区 | tree/menu | gx-* 浅色主 |
| 一级三类列表 | 数据表/文档/画布 | 二级列表 + 搜索 + 收藏/最近 | menu | 同上 |
| 通讯录 | 左下设置 → 成员/部门/角色三栏 | DeptTree/MemberList/RoleManager（虚拟滚动） | org/* | 同上 |
| 统一权限面板 | 设置/节点「管理权限」 | PermPanel（资源树+主体三页签+CRUD 矩阵+字段三态） | nodes/policies | 同上 |
| 单内容分享 | 文档/画布内 | 轻量分享弹窗（仅开放向）+ 高级权限深链 | policies/inheritance | 同上 |
| 继承中断确认 | 面板/单内容 | BreakInheritanceConfirmModal / RestoreInheritanceConfirmModal | inheritance | gx-warning/gx-danger |
| 分组影响预览 | 拖移/下推 | BulkImpactConfirmModal（保留/恢复/逐项，默认保留） | N6 预览 | 同上 |
| PAT 管理 | 设置 → MCP 接入 | PatList（创建一次明文/吊销） | pats | 同上 |
| embedding/检索设置 | 设置 → 语义检索 | 模式状态标识 local/cloud/off + 重建 | admin/reindex | 同上 |

## 8. 设计 Token（锁定）

- 复用现有 `gx-*` 全套 token 与组件视觉，**禁硬编码色值（仅 #000/#fff 例外）、禁紫→粉渐变/发光/毛玻璃**。
- 字体：`Inter + "Noto Sans SC" + system-ui`，等宽 `JetBrains Mono`；正文 14px/1.5。架构师在 Spec 锁字体 token，前端不写死字体栈。
- **图标：单一自建 SVG 图标体系 `components/icons.tsx`**，尺寸 16/20/24，全项目一套不混用，**禁止 emoji**。新增语义：building/sitemap/key/userPlus/userX/grip/inherit/crown/slash。
- 主题：浅色为主，对比度 WCAG 2.1 AA；危险不单靠颜色表意。
- z 层级沿用现状 token（entry50…chrome75；portal drawer400/modal800…toast1000），禁裸 z-[n]。

## 9. 验收标准（锁定——EARS，QA 唯一依据，摘）

| 编号 | EARS | 优先级 |
|---|---|---|
| AC-M1-1 | While 命中物理字段索引，50 万行系统必须 P95<800ms、100 万行<1.5s；计算字段不承诺并禁用大表排序 | P0 |
| AC-M2-1 | When 停用某成员，其登录态与嵌入/分享凭据必须即时失效；调岗/兼岗后权限按部门并集即时变化 | P0 |
| AC-M3-1 | If 同一资源被多次加到不同菜单容器，拖动/删除快捷项必须不改变其真实归属与权限；仅「移动到其他分组」改 nav_node 父级且弹影响预览 | P0 |
| AC-M4-1 | Given 某成员仅经部门获权，When 在角色页移除其角色，系统必须仍按其余来源判定，并在 O8 来源链展示全部来源（角色/部门/直接） | P0 |
| AC-M4-2 | When 对单篇关闭继承，系统必须先弹二次确认、列去重失访人数（多部门只计 1，owner/创建者豁免），确认后转 restricted 且入审计；未确认状态不变 | P0 |
| AC-M4-3 | 字段 hidden 后，列表/详情/导出/API/检索/关联展开/公式引用必须一致不出现该列 | P0 |
| AC-M5-1 | When 向量/embedding 进程崩溃，系统必须自动降级 FTS-only 且主应用不受影响；reindex 必须幂等 | P0 |
| AC-M5-2 | 无权内容必须在召回前被权限范围剔除，对抗用例零泄漏；不索引字段物理缺席 | P0 |
| AC-M6-1 | Given 只读凭证，tools/list 必须无写/删/admin 工具，绕过列表直调返回「工具不存在」口径（UNKNOWN_TOOL/404，不泄漏存在性） | P0 |
| AC-M6-2 | 字段受限凭证的 schema 与返回必须无不可见字段；参数越权被服务端二次拦截 | P0 |
| AC-M6-3 | AI 按文档块/画布图元语言写入，Web 端打开结构完整；contentVersion 冲突返回 409；破坏性工具无 `confirm:true` 不可执行 | P0 |
| AC-M6-4 | 凭证吊销后下一次调用必须立即被拒；每次调用入审计（参数脱敏） | P0 |
| AC-UPG-1 | 从 v0.1.0 直升各里程碑，记录数/附件/正文/画布/旧分享链接必须逐项抽样等价、0 损坏 | P0 |

## 10. 边界与约束

- 浏览器：Chrome/Edge/Safari 最新两版；新外壳下画布 R10 契约回归必跑；旧桌面端连新服务端给升级提示。
- 性能：成员 500、资源 10 万节点下首屏导航 <1s；权限判定本地缓存快照、无 N+1、变更秒级生效；单实例部署前提（多实例/PG 时缓存失效升级）。
- 单批：文档 op≤100/文本≤100KB，文档与画布上限 10MB；MCP 工具 30s 返回，长任务返 jobId。
- 数据安全：默认本地 embedding 不出网，切云端二次确认；key 环境变量 600 不入库不入日志。

## 11. 内嵌已知坑（从项目记忆/现状拉入，防止重蹈）

| 坑 | 指纹 | 修法 |
|---|---|---|
| SQLite PRAGMA 静默失败 | `$executeRawUnsafe` 设 busy_timeout/WAL 无效 | 必须 `$queryRawUnsafe` |
| Prisma migrate dev 非交互不可用 | CI/部署 | 手写 migration.sql + `migrate deploy`；failed 用 resolve --rolled-back |
| migrate 后画布白屏（WebKit/vite 缓存） | @plait patch/重放 | rm `apps/web/node_modules/.vite`；patch 升级重放连线手势守卫 |
| 画布 WebKit 负 viewBox 白卡 | ForeignObject 复杂 HTML | FO 挂补偿 g（translate(vbOx,vbOy)），属性坐标写非负可见区 |
| 画布右键浮层丢选区 | portal 到 body | 浮层加 `menuClassName="plait-board-attached"` |
| 假分页 | recordService findMany 全表 + slice | keyset(limit/游标) + 过滤下推，禁内存全量 |
| hydration N+1 | hydrate.ts 逐行 for await | 批量签名（prismaDeps 已具备，改调用方） |
| vite7 构建删 dist 被拦 | safe-delete shim | rename tmpdir → build --outDir 临时 → rename 回 |
| @plait/mind 非直接依赖 | import 即 500 | 经 drawnix 传递，勿直接 import |

## 12. 端到端验证步骤（每里程碑出口执行）

```bash
# 1. 构建与质量门
pnpm -w install --frozen-lockfile
pnpm --filter @gx/shared build
pnpm --filter @gx/api typecheck && pnpm --filter @gx/web typecheck
pnpm -w test            # 基线 270 项（api 214 + shared 56）必须保持全绿 + 新增回归
pnpm --filter @gx/api lint

# 2. 迁移与启动（只增迁移，先快照）
cp apps/api/prisma/dev.db /tmp/pre-migration.db.bak
pnpm --filter @gx/api prisma migrate deploy
bash scripts/dev-up.sh restart    # 等 http://localhost:3001 healthz、web 5173

# 3. M2 组织：建 6 层部门 → 加成员兼两部门 → 停用
curl -X POST localhost:3001/api/v1/org/departments -H "Authorization: Bearer $ADMIN" -d '{...}'
# 断言：停用成员旧 token 下一次请求 401

# 4. M4 权限：只读账号四路径同口径 + 中断继承
# 断言：hidden 字段在 list/detail/export/search 均缺席；关闭继承弹确认且去重人数正确

# 5. M6 MCP：只读 PAT
curl -X POST localhost:3001/mcp -H "Authorization: Bearer gxpat_$READONLY" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'
# 断言：无 record.create/update/delete/admin；直调被裁工具返 UNKNOWN_TOOL/404
# 断言：画布三矩形两箭头写入后 Web 打开坐标/绑定完整；无 confirm 的删除被拒

# 6. 升级：v0.1.0 快照 → 最新 migrate deploy → 抽样核对
# 断言：记录数/附件/正文/画布/旧分享链接等价
```

## 13. 变更记录

| 日期 | 变更 | 原因 | 影响 |
|---|---|---|---|
| 2026-09-12 | Spec v1.0 初版，六支柱 M0–M7 锁定 | Phase 1 主理人 GO | 全部后续开发以此为准 |
| 2026-09-12 | 纳入 R-MCP-1（MCP tools/list 双闸门） | 消除架构与 PRD 口径冲突 | M6、API §5、AC-M6 |
| 2026-09-12 | 纳入 R-MCP-2（放弃 WorkBuddy 原生与内置聊天，MCP 为第三方 AI 接入唯一核心，M7 改总验收） | 主理人决策 | §2/§3/§5/§9，删 ai_chat flag 与 AI2-4 交付 |

> Spec 变更纪律：小改（不增 API 端点/不增表/影响≤2 页面/不改核心流程）→ 更新本表演进；大改 → 回 Phase 0 重走澄清并更新三份上游文档。
