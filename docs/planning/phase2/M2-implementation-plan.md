# M2 组织通讯录 — 可执行实施切片（设计与现状核对，不改业务码）

- 日期：2026-09-15
- 作者：架构师 高见远
- 状态：Proposed（交项目总监大湾区靓仔复核后派后端/前端工程师实施）
- 上游依据：SPEC-enterprise-v1.0 §2（M2 行，:22 P0）/§4（:60 铁律、:64 v1 前缀）/§5（:70 `/api/v1/org/*`）/§6（:84 M2 表清单）/§7（:97 通讯录三栏）/§9（AC-M2-1，:118）/§10（:134 性能）/§12（:167-169 对抗用例）；PRD-enterprise §四支柱3（O1/O2/O3，:143-145）/§六 M2（:246-251）/C-12（删除悬挂，:319）；ARCH-enterprise §1.1（三套 RBAC 现状）/§4（组织模型，:317-429）/§5.1（三源并集，:437-440）/§5.6（缓存与 tokenVersion，:542-550）/flag 表（:124 `enterprise_org`）
- 适用代码基线：`main` @ git `a4bbf1f`（三环境部署方案收口后）；根 `package.json` v0.1.0
- 本机核对环境：Node v22.22.2、pnpm 9.0.0、Prisma 5.22、better-sqlite3 13.0.3（内置 SQLite 3.53.4）、Hono 4.13.5、jose 5.9.0（依赖在，源码实际经 `hono/jwt` 间接使用，见 §11-6）

> 本文所有"现状证据"行号均在本机实际读码/跑命令核对（实跑测试基线时间 2026-09-15 12:17）。与主理人所给锚点不符或需要口径澄清之处集中列在 §11。本阶段只产出规划，不提交任何业务代码、不改 package.json、不 commit。

---

## 0. 结论先行

1. **M2 是"加一层"，不是"改一层"**：新增工作区/部门/组织角色层（5 张新表 + users 只增列），现有 `members`（base 五角色，`schema.prisma:202-215`）、`kb_members`、`kb_doc_acls`、两张分享表**一行语义不动**，M2 不做任何资源 enforce。组织数据先空跑，为 M3 资源树、M4 三源并集预留挂点（`workspaceId` 列、`role_assignments` 表与只读求值函数）。
2. **AC-M2-1 即时失效选最小方案 A：users 表加 `tokenVersion` 整数列，JWT 携带 `tv`，鉴权热路径单行 PK 直查比对 + status 判定**。不引 redis、不引会话表。单实例 SQLite 主键点查为微秒级，500 人规模无压力，**默认零缓存**以严格满足"下一次请求即 401"；另留 `GX_AUTH_STATE_TTL_MS`（默认 0）短缓存口子给 ADR-0008 规模化场景。方案 B（会话撤销表）及取舍见 §5-D。
3. **"嵌入/分享凭据"需一处口径澄清（请总监复核）**：AC-M2-1 的嵌入若是登录态 iframe（localStorage JWT），tokenVersion 直接覆盖；`POST /api/bases/join/:token`（`bases.ts:445-461`）本质是登录态兑换，同样覆盖。但 `GET /api/public/s/:token`（`public.ts`，匿名公开外链）**不绑定任何用户**，停用某成员在语义上不应自动吊销一个匿名资源链接（否则破坏现有公开分享与 RC）。M2 不改匿名外链语义，"停用即吊销其创建的外链"不做（归属 M4 分享治理或另行立项），见 §5-D.5。
4. **组织角色命名与资源角色同名是有意的，但必须物理分层**：`roles` 表播种 owner/creator/editor/commenter/viewer 五枚系统角色（SPEC 锁定），但 M2 它们只承载**组织管理动作**（owner 持 manage_members/roles/departments）；资源内 c/r/u/d 动作位**不进** M2 的 roles.permissions，资源权限矩阵继续只认 `members.role` + shared-types `permissions.ts`。M4 用 `auth_policies(subjectType=role → roles.id)` 接上，详见决策 A（§5-A）。
5. M2 切成 **S0–S9 共 10 片**：S0 特征测试 → S1 迁移+回填 → S2 鉴权收口机制 → S3 部门树 → S4 成员多部门 → S5 角色与授予求值 → S6 停用/激活业务闭环 → S7 前端三栏 → S8 6 层对抗端到端 → S9 出口收口。除 S7 外全部纯后端可独立做；一个 env flag `GX_ENTERPRISE_ORG`（默认 on，可 off 摘路由）保护灰度，旧 `/api` 行为零变化。
6. 实测基线：**api 47 文件 598 passed / 3 skipped；web 2 文件 33 passed；迁移 12 个目录**。M2 回归门以这组数字为"不许由绿转红"基线。

---

## 1. 现状证据（行号已核对）

### 1.1 认证与 JWT（AC-M2-1 落点）

| 事实 | 证据（已核对） |
|---|---|
| JWT 签发只有 userId/iat/exp，HS256，TTL **7 天** | `auth.ts:27-35`（`TOKEN_TTL_SEC`、`issueToken`） |
| 登录校验仅 bcrypt，不查账号状态（users 无 status 列） | `auth.ts:70-89` |
| 注册直接 create user 并签发 token | `auth.ts:45-63` |
| 全站鉴权唯一入口 `getUserId`：只验签，**不查库不查状态** | `auth.ts:285-295` |
| `/me` 验签后按 id 查用户，用户不存在返 404 | `auth.ts:91-103` |
| 资源级 RBAC：base member 五角色判定 | `guards.ts:43-95`（roleOf/permissionsOf/requireCan*）；权限矩阵 `packages/shared-types/src/permissions.ts:33-69` |
| base 级角色助手（与 guards 重复的一份） | `auth.ts:298-322`（userRoleInBase/Permission） |
| 注销账号：唯一 base owner 拒绝（逐 base count） | `auth.ts:193-225`（:206-219 保护逻辑） |
| JWT 库实际调用 | 源码统一 `import { sign, verify } from "hono/jwt"`（`auth.ts:5`）；`jose@5.9.0` 在 dependencies 且 build external（`scripts/build.mjs:36`），M2 不换库不引库 |

调用面（grep 已核对）：业务路由不直接调 `getUserId`，统一经 `guards.ts` 的 `requireUserId/requireRole/requireCan*`（`guards.ts:15-19` 等）；`auth.ts` 自身 5 处（/me 系列）。这意味着 M2 若要让全站感知停用，**收口点只有两个：`getUserId`（验签后加查）与 `/me`**，不必改 60+ 路由调用点。

### 1.2 用户/成员数据模型

| 事实 | 证据 |
|---|---|
| User 无 status/workspaceId/tokenVersion；字段 id/email/displayName/passwordHash/username?/phone?/avatarUrl?/bio?/createdAt/updatedAt? | `schema.prisma:182-200` |
| Member = base 资源级成员，`@@unique([baseId,userId])`，role 字符串五值 | `schema.prisma:202-215` |
| KbMember = 知识库级四角色（无 creator） | `schema.prisma:264-277` |
| KbDocAcl = 单文档叠加角色 | `schema.prisma:334-346` |
| ShareLink（base）持票加入，匿名 token 不绑用户 | `schema.prisma:233-245`；兑换 `bases.ts:445-461`；CRUD `bases.ts:390-441` |
| KbDoc 公开外链（shareToken/shareRole/shareIncludeChildren），匿名通道 | `schema.prisma:299-302`；`routes/public.ts` 全文 |
| users 加列有现成 SQLite 模式可抄：ALTER ADD COLUMN 可空 + UPDATE 回填 + 唯一索引另建 | 迁移 `20260907100000_add_user_profile_fields/migration.sql` |

### 1.3 路由装配 / v1 挂载点 / 横切设施

- 单一挂载单元 `createMount`（`app.ts:48-145`）：`/api` Hono 子实例在 `:125-136` 装配 health/auth/bases/tables/fields/records/views/kb/public/search。**M2 在 `:136` 后新增 `mount.route("/api/v1", v1)`，与 `/api` 平级，互不影响**；basePath 双副本（`:162-164`）自动覆盖 v1。
- 限流选择器按路径前缀 `/api/` 匹配（`middleware/rateLimit.ts:34-48`）：`/api/v1/org/*` 自动落入 600/60s 默认档；org 写端点如需更严档（disable/角色变更）在 S6 加命名规则，不改既有档位。
- 统一错误信封：HttpError + code（`guards.ts:9-13, 97-127`）；v1 新路由全部经 `errorResponse`，错误码沿用 BAD_REQUEST/UNAUTHORIZED/FORBIDDEN/NOT_FOUND/CONFLICT。
- 审计 JSONL：`audit/emit.ts`（业务给 event/status/actorId/detail，自动脱敏）；事件名枚举在 `audit/audit.ts:9-15`，当前 6 个，M2 在此**只增**组织事件名。
- 写串行门面：`db.ts:117 withWriteTx` / `:129 runWrite` / `:138 withWriteBatch`，铁律"回调体内只用传入 tx，不得再入队"（`db.ts:111`）。M2 多步写（移动部门子树 path 重写、停用时 bump tokenVersion + 审计）全部走它。
- 配置闸门：`config.ts` 纯函数 `validateEnv` + `buildConfig`，flag 模式有 M1 先例（`GX_RATE_LIMIT` on/off、`GX_M1_*`），M2 仿照加 `GX_ENTERPRISE_ORG`。

### 1.4 迁移与 CI 纪律

- 迁移目录现有 **12 个**（最新 `20260913062000_record_field_index_sidecar`）；`scripts/ci-quality.sh:83-90` 在临时库 `prisma migrate deploy` 干跑，迁移数由目录数动态对账。
- 手写表先例：record_field_index 不入 schema.prisma、由手写迁移 + raw SQL 维护（`schema.prisma:348-361` 注释、M1 S3 迁移）。**但 M2 组织表是业务一等表，要用 Prisma model 管理**（需要关系查询/类型安全），不存在手写表问题；仅 users 回填的幂等性用迁移内 SQL 保证。
- 部署前在线快照已由 M0 deploy 链路强制；回滚 30 分钟内（SPEC §4 铁律 :60）。

### 1.5 前端现状（决定 S7 接入口径）

- 路由骨架 `App.tsx:103-120`：当前"设置"是 **base 级**路由 `/base/:baseId/settings`（`SettingsPage.tsx`，成员面板 `MembersPanel.tsx` 管的是该 base 的 Member）。**工作区通讯录是新的工作区级页面，不能塞进 base SettingsPage**。
- 侧栏底部已有"回收站 / 设置 / 头像+个人中心"区（`Sidebar.tsx:239-282`），"设置"按钮当前跳 base 设置（`:251`）。M3 才做统一外壳；M2 的落点：**在侧栏底部新增"工作区管理/通讯录"入口**（工作区级，无 baseId 依赖），路由 `/workspace/contacts`，页面内三 tab（成员/部门/角色）。不改动既有 base 设置入口语义（M3 统一导航时再收敛，避免 M2 越界做外壳重构）。
- API 唯一出口 `api/client.ts`：`apiFetch` 自动注 JWT（`:117-124`），401 全局清登录态跳登录页（`:101-114`）——**停用后前端下一次任意请求 401 自动登出，无需前端特殊处理**；路径前缀经 `BASE_URL` 自动兼容子路径部署。
- TanStack Query 5.62 已在；web 测试基线 33（`lib/base.test.ts` 9 + `api/records-paging.test.ts` 24），无组件测试设施，S7 新增纯函数/hook 测试（vitest 已通）。
- 图标：单一自建 SVG 体系 `components/icons.tsx`（`IconName` 联合 :7、`settings` :18/:119），M2 所需 building/sitemap/userPlus/userX/crown/slash 等在该文件**追加 path**，不引第二套库、不用 emoji（SPEC §8 :109）。
- 现有成员管理 UI 参照：`features/settings/MembersPanel.tsx`（base 成员增删/改角色），S7 的组织成员列表交互风格对齐但数据源换新 v1 API。

### 1.6 测试基线（2026-09-15 12:17 实跑）

- `pnpm -w test`：**apps/api 47 文件 598 passed / 3 skipped**；**apps/web 2 文件 33 passed**。
- 路由级真库测试模式已有先例：`routes/__tests__/records-keyset.test.ts`（临时目录 + `prisma migrate deploy` 建真库 + `globalThis.__gx_prisma` 注入 + `vi.mock("../../auth.js")`，:17/:40-51）。M2 的 org 路由测试照此模式（真迁移真表，不 mock Prisma）。
- 注意：该测试 mock 的是 `getUserId`；M2 若改变其签名/行为需同步该 mock（S2 必须把此处纳入回归）。

---

## 2. M2 范围边界

### 2.1 M2 必做（SPEC M2 行 + O1/O2/O3 + AC-M2-1）

1. 工作区单例：`workspaces` 表 + 现有数据幂等回填默认工作区；所有新表带 `workspaceId`（单工作区交付，列先行为多工作区留口，不做切换 UI）。
2. 无限部门树：`departments`（parentId 真相 + path 物化派生，前缀 LIKE 查子树），建/改/移动/（软）删，移动子树 path 事务内重写，防环，6 层对抗用例但不设 6 层上限（应用层 32 层深度护栏，与 ARCH §4.1 一致）。
3. 成员多部门：`dept_members` 多对多 + isMain；调岗（移动主部门/移除部门）、兼岗（加第二个部门）即时反映到角色求值。
4. 账号生命周期：users 增 `status(INVITED/ACTIVE/DISABLED)`、`disabledAt`、`inviteTokenHash?`、`workspaceId?`；邀请（建 INVITED + 一次性激活链接）、直接创建（ACTIVE）、停用、重新激活；停用即 JWT/登录态失效（401）。
5. 系统五角色 + 自定义角色：`roles`（五枚 isSystem 不可删）、`role_assignments(subject=user|dept, scope=workspace|node 预留)`；成员"有效组织角色集合"只读求值函数（直接授予 ∪ 部门祖先链授予并集），供 M4 与 M2 测试用，**不做资源 enforce**。
6. `/api/v1` 首挂：`/api/v1/org/departments|members|roles` 全套 CRUD，manage_members/owner 鉴权；旧 `/api` 原样保留。
7. 前端工作区通讯录：左下入口 → 成员/部门/角色三栏（DeptTree/MemberList/RoleManager），成员 500 虚拟滚动。
8. 对抗用例自动化（6 层部门 → 兼两部门 → 停用 → 旧 token 下次请求 401 → 调岗并集变化）。

### 2.2 M2 明确不做（划给后续里程碑，禁止越界）

| 不做 | 归属 | M2 临时姿态 |
|---|---|---|
| 资源权限 enforce（base/table/field/doc 任何 c/r/u/d 判定改走组织角色/部门） | **M4** | members/kb_members/kb_doc_acls 语义与守卫一行不动；组织角色是空跑管理层 |
| 统一资源树 nav_nodes/menu_items、外壳重构、设置收敛 | **M3** | 通讯录以独立工作区级页面 + 侧栏底部入口落地，不重构 Sidebar/TopBar |
| auth_policies 写入/回填、subjectType=role 的资源策略 | **M4**（M3 只建表冻结） | M2 只建 roles/role_assignments 并提供 subject 展开求值，不建 auth_policies |
| PAT、MCP 通道鉴权 | M6 | 无 |
| 停用即吊销匿名公开外链 / 外链按人治理 | M4 分享治理或另行立项 | 匿名 `/api/public/s/*` 语义不变（§5-D.5） |
| 邀请邮件投递（SMTP/通知服务） | 不做（无邮件基础设施） | 邀请返回一次性激活链接，由管理员线下转发；状态机闭环完整 |
| 多工作区切换/跨工作区授权、多租户 | 明确 Out-of-Scope（SPEC §3 :38） | 单例默认工作区，workspaceId 列只留口 |
| 部门负责人/职级/编制/汇报线等 HR 字段 | 不做 | 仅 name/parentId/ord/status |
| redis/集中会话/多实例失效广播 | 触 ADR-0008 才议 | 单实例零缓存直查（§5-D） |
| 角色的资源动作模板编辑器（勾 c/r/u/d 到库表） | M4 权限面板 | M2 自定义角色只能勾组织管理动作（manage_members/roles/departments） |

---

## 3. M2 内"绝对不能动"的契约（Characterization 先锁）

1. **现有资源鉴权结果逐值不变**：任意用户对任意 base/table/record/doc 的 `requireCan*` 结果在 M2 前后一致（组织层不接入判定）。这是 M2 最高回归红线。
2. **旧 `/api/*` 路径与响应契约零变化**：M2 只新增 `/api/v1` 挂载；`getUserId` 若内部重构，其输入输出（`Promise<string|null>`，验签失败/无 token 返 null）保持，`records-keyset.test.ts:17` 的 mock 继续成立。
3. **JWT 既有持有人可用性**：存量 7 天 token（无 `tv` claim）在升级后**不得被一律踢下线**——无 tv claim 视为 tv=0，与 users.tokenVersion 默认 0 相等即通过（平滑升级）；只有被显式停用（bump tv）才失效。
4. **注册/登录成功仍返回 token + publicUser**，publicUser 只增字段（status/workspaceId 投影可选），不删不减（`auth.ts:109-125`）。
5. **公开分享三条匿名通道**行为不变（`public.ts` 的 /s/:token、/doc/:docId、/ref/:docId、匿名 PUT content；ShareLink 兑换加入）。
6. **注销账号唯一 owner 保护**（`auth.ts:206-219`）不削弱，M2 在其之上**叠加**"唯一工作区 owner 拒绝停用/注销"，不替换 base 侧检查。
7. **迁移只增**：users 只加可空列/带常量默认列；新表全新；不删列不改列类型；回填幂等可重跑（测试库 + 已部署实例都能升）。
8. **前端 base 设置/成员面板语义不变**：`/base/:id/settings` 与 MembersPanel 继续管 base Member；新通讯录是并列页面，不抢路由不抢权限。

---

## 4. 横切工程纪律

### 4.1 Feature flag

| flag | 默认 | 含义 |
|---|---|---|
| `GX_ENTERPRISE_ORG` | `on` | on=挂载 `/api/v1/org/*`、启用工作区自举与组织管理面；off=不挂 v1 org 路由（请求 404，与未升级一致），组织表与列已在库中但闲置无害；**不影响旧 `/api` 与资源鉴权** |

- flag 解析进 `config.ts`（仿 `GX_RATE_LIMIT`：test 环境默认 on 以便新测试直跑，可显式 off 测摘除）。
- v1 挂载点条件化：`if (config.enterpriseOrg) mount.route("/api/v1", v1)`；`/api/v1` 前缀本身即使 flag off 也不影响旧路径（不注册即 404 到既有 notFound）。
- 单步回退：置 off 重启即完全收回 M2 管理面；数据保留，重新置 on 即恢复。组织表为纯新增，无"回滚要改业务数据"的问题。

### 4.2 方言边界（SPEC §4 铁律，为 ADR-0008 留口）

- 新表普通 rowid 表、`TEXT/INTEGER` 标准类型；布尔 `INTEGER 0/1`；时间列与现状一致用 Prisma DateTime（SQLite TEXT）。
- 部门 path 子树查询用参数化前缀 LIKE：`"path" LIKE ? ESCAPE '\\'`（参数 = 部门 path + '%'，转义 %/_/\）；前缀 LIKE 可走 B-tree（`@@index([path])`/SQL 索引），PG 同样支持 `LIKE 'prefix%'` 索引（text btree 前缀匹配），不写 SQLite 专有 `GLOB`。
- 不用 CTE 递归（部门祖先靠 path 物化，不递归）；不在 SQL 内做 JSON 抽取；所有 raw（若有）参数化。
- FK 与级联：dept_members/role_assignments 对 departments/users/roles 显式 FK + onDelete 行为见 §5-B/5-C；软删部门不物理删（保授权悬挂可解释，C-12）。

### 4.3 迁移/回填/回滚纪律

- 一个只增迁移目录（建议拆 2 个迁移，见 S1，避免单迁移又建表又回填长跑）：
  - 迁移 A（DDL）：建 workspaces/departments/dept_members/roles/role_assignments + users 加 5 列 + 索引 + 播种系统角色的幂等 INSERT。
  - 回填 B（数据，幂等 SQL，仍放迁移内但全部为幂等 UPDATE/INSERT，单实例用户量 ≤500，秒级完成，无需独立脚本；与 M1 sidecar 百万回填场景不同）：INSERT 默认 workspace（若不存在）→ users 回填 workspaceId/status/tokenVersion → 首位用户 owner 自举（幂等，见 §5-D.4）。
- 所有回填带 `WHERE ... IS NULL`/`INSERT ... WHERE NOT EXISTS`（SQLite 支持 `INSERT ... SELECT ... WHERE NOT EXISTS`），重跑零副作用。
- 回滚 SQL 另存 `prisma/docs/rollback/<ts>_enterprise_org.down.sql`（DROP 新表/索引，users 新列 SQLite 无法 DROP 旧版本——保留为空操作说明：列闲置无害；与 M1 同纪律）。**主回滚路径是应用层 flag off + 发布前快照恢复**，不是 down 迁移。

### 4.4 v1 路由组织（决策 E 落地）

```
apps/api/src/
  routes/v1/
    index.ts            // export const v1 = new Hono(); v1.use(auth 中间件链); v1.route("/org", org)
    org/
      index.ts          // export const org = new Hono(); 子路由装配
      departments.ts    // /departments CRUD + move
      members.ts        // /members、/members/invite、/members/:id/assignments、disable、reactivate
      roles.ts          // /roles CRUD + /roles/:id/assignments
  domain/org/
    workspace.ts        // 单例解析/自举（getDefaultWorkspace，内存单例缓存）
    deptTree.ts         // path 纯函数：buildPath/rewriteSubtree/assertAcyclic/depth
    members.ts          // 多部门归属、主部门约束
    roles.ts            // 系统角色常量、有效组织角色求值 effectiveOrgRoles
    lifecycle.ts        // status 状态机、tokenVersion bump、停用/激活事务
  middleware/
    authActive.ts       // requireActiveUser（验签+tv+status）、requireManageMembers
```

- v1 子路由第一方中间件：`requireActiveUser`（新鉴权链的 v1 版，§5-D）；旧 `/api` 继续用旧 `getUserId`（S2 内部让两者共享同一解析核心，但旧入口签名/行为不变）。
- 所有 v1 响应遵循 SPEC 统一信封 `{code,data,message}` 还是沿用现网 `{error,code}`？**结论：M2 的 v1 成功响应用资源本体/`{items,total,page,limit,hasMore}`（与现网风格一致，避免无谓包装破坏前端既有解析习惯），错误体沿用 `{error, code}` 信封**；`{code:0,data,message}` 规范在 M3 openapi 出口统一时再全量对齐（SPEC §5 明确 openapi 冻结点在 M3 :23）。M2 在 openapi sidecar 草案中按现网信封书写，减少前端改造。此口径列入 §11 请总监知悉。

---

## 5. 关键设计决策（A–F）

### 5-A. 组织角色 vs 资源 Member.role：同名两层，物理隔离，M4 可接

**现状两层事实**：
- 资源层：`members.role`（base，五值）+ `kb_members.role`（四值）+ `kb_doc_acls.role`，经 `permissions.ts` 矩阵映射到 PermissionSet，是今天唯一生效的权限。
- 组织层（M2 新增）：`roles` 工作区角色目录 + `role_assignments`（授予 user 或 dept）。

**M2 落地规则**：
1. `roles` 表播种五行，`systemKey` 分别为 owner/creator/editor/commenter/viewer，`isSystem=1`，name 用中文展示名（所有者/创建者/编辑者/评论者/阅读者，与 ROLE_LABEL 对齐）。五者**不可删、不可改 systemKey/name/排序**；自定义角色 `isSystem=0`，`@@unique([workspaceId, name])`。
2. **M2 的 roles.permissions（JSON）只放组织管理动作**，动作集合锁定三枚：`manage_departments`、`manage_members`、`manage_roles`（manage_menu 留 M3，资源动作 r/c/u/d/comment 一律不放）。系统角色中仅 **owner 三枚全有**；其余四枚系统角色 M2  permissions 为空数组（它们是 M4 资源角色的命名锚点，M2 不给管理面权力）。自定义角色可勾三枚管理动作的任意子集。
3. 资源判定完全不读 roles 表：`guards.ts`/`permissions.ts` 不出现 org 依赖（依赖方向：domain/org 不被 guards 引用；S8 用测试断言"改组织角色不影响任一 requireCan* 结果"）。
4. **M4 衔接点**：M4 的 `auth_policies.subjectType='role', subjectId=roles.id` 直接可用；届时五枚系统 key 与资源动作的关系由 auth_policies 动作位表达（角色本身不内置资源权限），subject 展开复用 M2 的 `effectiveOrgRoles`（§5-C）。组织角色与资源角色同名的问题在 M4 通过"角色是工作区主体、动作挂在策略行上"自然消解；M2 不提前做映射表（映射即越界设计）。
5. requireManageMembers（M2 管理面鉴权）：调用者 `effectiveOrgRoles` 并集内任一角色的 permissions 含所需管理动作即放行；等价地 M2 初期只有 owner（系统）与被授管理动作的自定义角色可管理。首个 owner 自举见 §5-D.4。

### 5-B. 部门树：parentId 真相 + path 派生，移动子树事务重写

- path 规则（同 ARCH §4.1）：`/` + 各级 departmentId 以 `/` 连接，首尾均 `/`；根 = `/{id}/`。path **永远可由 parentId 链重算**，是派生数据（可全量重建）。
- 建部门：指定 parentId（null=根级），insert 后按父 path 拼自身 path 再 update（同事务）；校验 name 非空、同父 name 不重复（409，参数化查询）。
- 移动部门 `PATCH /org/departments/:id {parentId}`：
  1. 防环：新祖先不能是自己或自己的子孙——判定 `新父.path 以 本部门.path 为前缀` 即拒绝（一条前缀查询，无需递归）；parentId 不变为 no-op。
  2. 子树重写：一次查出本部门子树全部行（`path LIKE oldSelfPath || '%'`），在 `withWriteTx` 内逐行计算 `newPath = newParentPath || substr(oldPath, length(oldSelfPath)+1)`（应用层算，参数化 UPDATE；SQLite/PG 均支持 substr/长度函数语义等价，也可在应用层用 JS 算后逐条 update，500 人组织子树行数极小）。
  3. 深度护栏：重写后最大深度 > 32 拒绝整事务（应用层常量，6 层用例远低于此；**32 是护栏不是功能上限**，PRD 要求"无限级"，对客文案不宣传 32）。
- 软删：`deletedAt`；有成员或子部门时拒绝硬删，要求先处理（C-12：列出成员数/子部门数，引导移动成员）；软删部门不进通讯录树、不参与新授予，但 `role_assignments(subjectType=dept)` 保留（悬挂在 M4 O8 视图显红；M2 对软删部门的授予在求值中一律不展开）。
- 列表：树查询一次取工作区全部活部门（≤ 数百行），前端组装树，不分页；`GET /org/departments` 返回平铺数组（id/parentId/path/name/ord/memberCount），树组装放前端。

### 5-C. role_assignments subject=user|dept 与"有效组织角色"并集求值

```
effectiveOrgRoles(userId, workspaceId):    // 纯读，M2 不接 enforce
  direct  = role_assignments where subjectType='user' and subjectId=userId
  deptIds = dept_members where userId → departments（活部门）
  inherited = role_assignments where subjectType='dept'
               and subjectId ∈ (deptIds 的祖先闭包：任一用户部门 path 的前缀段)
  return unique(roleId) from (direct ∪ inherited)，附带每条来源 {roleId, sourceType:'user'|'dept', sourceId}
```

- "部门授角色 → 部门成员经部门并集获得"：祖先闭包用 path 前缀展开（授予 D 部门 = D 子树全体成员获得；用户在 D 的子部门即命中，与 ARCH §5.1 一致）。单条 SQL 可表达（join dept_members→departments，`? LIKE d.path || '%'` 方向），M2 规模直接查；禁止"逐部门/逐角色 N+1"，用 IN/join 收敛为定数查询（2~3 条），S8 断言 SQL 计数不随部门层数/成员数增长。
- role_assignments 唯一键 `@@unique([roleId, subjectType, subjectId, scopeType, scopeNodeId])`（scopeNodeId M2 恒 null/工作区，列先留；比 ARCH 草案的四元键多 scopeType 进唯一键，防止 workspace/node 同主体两行冲突）。
- 写授予/移除：仅 manage_roles（角色成员维护归入角色管理；owner 默认有）。给部门授系统 owner 也要受"最后 owner"保护约束（见 §5-D.4：保护判定必须把部门继承展开计入，否则可绕过）。
- 调岗/兼岗即时性：求值不做跨请求缓存（M2），dept_members 写后下一次求值即为新并集；S8 断言"移除部门后下一次请求 effectiveOrgRoles 立即少角色"。M4 如需缓存走 workspace.policyVersion（workspaces 表 M2 即建 `policyVersion Int @default(0)` 列，M2 先在 org 写路径递增，消费在 M4）。

### 5-D. 账号生命周期状态机与停用即时失效（AC-M2-1 核心）

#### D.1 状态机

```
INVITED ──接受邀请(设密码)──▶ ACTIVE ──disable──▶ DISABLED
   │  (管理员也可直接建 ACTIVE 账号)    ▲            │
   └──────────────────────────────────└──reactivate┘
DISABLED ──reactivate──▶ ACTIVE（不回 INVITED）
注销（DELETE /me / 管理员删除）= 现状态机之外的物理/匿名化，M2 不在生命周期接口内新增删除（沿用 auth.ts:193）
```

- INVITED 不可登录（登录返回 403 + 明确文案"账号尚未激活"，与密码错误 401 区分，不泄露过多信息时可统一 401，M2 取 403 + 审计，因为这是管理员域内系统）；不可被授予前可先配部门/角色（允许预配，PRD  invited 行）。
- DISABLED：登录拒绝（401"账号已停用"）；**已签发 JWT 下一次请求 401**；不删任何数据（membership/部门/角色/createdBy 全保留）。
- 每次 login/invite-accept/disable/reactivate 入审计（事件名见 S6）。

#### D.2 即时失效机制：方案 A（选定）vs 方案 B（否决）

**方案 A：用户行 tokenVersion（选）**
- users 增 `tokenVersion INTEGER NOT NULL DEFAULT 0`；issueToken payload 增 `tv`（`{userId, tv, iat, exp}`）。
- 鉴权核心（v1 `requireActiveUser` 与改造后的旧 `getUserId` 共享解析函数）：验签 → 按 PK 查 users 一行（select id/status/tokenVersion/workspaceId）→ 用户不存在/null → 401；`status='DISABLED'` → 401；`payload.tv ?? 0 !== user.tokenVersion` → 401；INVITED 在登录端点拒绝、在业务端点同样 401（未激活不产生 token，防御性）。
- 停用/reactivate：同事务 `tokenVersion += 1`；旧 tv 立即不等。改密 M2 不强制 bump（现有 change-password 不下线其他会话，保持现状；可选增强列入 advisory，不进 P0）。
- **缓存策略（单实例纪律，不引 redis）**：默认 `GX_AUTH_STATE_TTL_MS=0` → 每请求一次 PK 点查（SQLite 本地文件、WAL 读，500 用户下微秒级，相对业务查询本身的几十次 IO 可忽略；S10 风格实测留证）。TTL>0 时进程内 LRU（上限 5000 条）缓存"用户状态行"，停用动作在**本进程**同步 invalidate key（单实例必然同进程，故即使开了短缓存也可在停用时主动失效，做到下一次请求 401；TTL 只是兜底）。M2 交付默认 TTL=0 + 主动 invalidate 双保险代码路径。
- 多实例/PG 是 ADR-0008 议题：届时 TTL 短缓存 + policyVersion 表轮询/通知升级，列与 claim 设计不变。

**方案 B：会话撤销表（sessions/revocation list）**
- 每签发 token 落一行 session（jti/lastSeen），停用删/标 revoked，鉴权查表。
- 否决理由：M2 只有"全员停用/激活"这一种粗粒度撤销需求，tokenVersion 一次整数比较即等价；会话表引入签发落库（改登录性能与事务面）、jti 管理、清理任务，是过度设计；M6 PAT 有独立的 personal_access_tokens 表（SPEC §6），那是凭据实体，届时单独建，不与会话混用。

**为什么不用"短有效期 access token + refresh"**：现状 7 天 token 无 refresh 体系，改造面大且影响所有现有客户端；tokenVersion 以一列成本达成同等"即时"，不破坏登录（SPEC 要求"最小且不破坏现有登录"）。

#### D.3 AC-M2-1 三条断言的实现路径

1. 停用 → 旧 JWT 下一次请求 401：停用事务提交后，旧 token tv 失配，任意挂鉴权的端点（含 `/api/auth/me` 与全部 v1）下次请求即 401；前端 apiFetch 401 自动清态跳登录（现有逻辑，零改动）。
2. 嵌入：登录态 iframe 持同一 JWT → 同源下次请求 401，嵌入视图随之失效（前端 S7 不需特殊通道）。
3. 分享凭据：登录态兑换的 `bases/join/:token` 被 getUserId 收口覆盖（停用者无法再用持票链接加入/访问）。**匿名外链见 §5-D.5 口径澄清**。
4. 调岗/兼岗 → 权限并集即时变化：M2 可验证的是 `GET /api/v1/org/members/me/effective-roles`（或成员详情内 effectiveRoles 字段）在 dept_members 变更后**下一次请求**返回值即变（无缓存）；资源权限的实际变化要等 M4 enforce，M2 只保证求值函数与数据通道正确。

#### D.4 自举与自锁保护

- 迁移回填：默认 workspace 创建后，取**最早注册的 ACTIVE 用户**（createdAt 最小）授予系统 owner（role_assignments user 级一行，幂等 NOT EXISTS）。空库不授。
- 运行时兜底：若一个工作区没有任何有效 owner（例如历史数据异常），系统注册的第一个用户（workspace 内 user 计数为 0 时的 signup）自动获 owner；`getDefaultWorkspace` 内保证单例。
- 保护规则（停用/移除 owner 授予/删角色成员时统一走一个 `assertNotLastOwner(tx, workspaceId)`）：
  - 展开计算"当前有效 owner 集合"（user 直接 + dept 继承，§5-C 反向），若该操作会使集合变空 → 409"至少保留一位工作区所有者"。
  - 保护同样作用于：停用 user、删 user 的 owner 授予、给授予链上的部门软删/移除最后一个成员等路径；逐个在 S6 列测试。
  - 自我保护：owner 不可停用自己（400 文案），与现有"唯一 base owner 不能注销"同款护栏。

#### D.5 匿名公开外链口径澄清（请总监复核，不偷偷改语义）

- `GET /api/public/s/:token` 是**匿名持票即准入**（`public.ts:27-37`），请求不带 JWT、不解析用户，与"某成员的登录态"不是同一种凭据。AC-M2-1 字面"嵌入/分享凭据即时失效"若解释为"停用 A 则 A 曾创建的所有匿名外链全部失效"，会导致：(a) 公开链接语义被绑回创建者，改变现网 RC 与 PublicSharePage 行为；(b) M2 无从区分"离职交接后链接应保留"的正常诉求。
- M2 口径：**AC 的"分享凭据"在 M2 落地为"经成员身份使用的分享/嵌入通道"**（join 兑换 + 登录态嵌入），全部被 tokenVersion 覆盖；匿名资源外链不绑定成员，保持可用，其治理（按创建者批量吊销/外链审计）随 M4 分享分区（C-10）或 M6 一起做。若总监要求 M2 即按字面连匿名链接一并吊销，追加方案为：kb_doc 公开链接与 share_links 已有 createdBy 关联能力（share_links 无 createdBy 列，需只增列 + 停用时按人批量失效），工作量单列，不在当前切片内。

### 5-E. API 版本与路由（决策 E）

- 新代码全部 `/api/v1/org/*`；`/api` 旧路由零改动，按 SPEC §5 :64 保留一个迭代后再议下线（M2 不做任何旧路径迁移/重定向）。
- v1 装配见 §4.4；限流/安全头/bodyLimit/CORS 经 mount 全局链自动继承。
- 分页：成员列表支持服务端分页（500 人前端虚拟滚动 + 服务端 keyset/limit 双备），统一 `{items,total,page?/nextCursor,limit,hasMore}`；M2 规模用 `?deptId=&q=&status=&page=&limit=` 普通页码即可（组织成员是低频管理查询，500 行 offset 成本可忽略，不把 M1 的 keyset 设施强搬到管理面；q 走 email/displayName 参数化 ILIKE/LIKE，见 S4）。

### 5-F. 切片切分原则

- 后端 6 片（S1-S6）严格按"表→机制→树→人→角色→生命周期"依赖序，每片独立可测可回滚；S2 在没有任何 UI 的情况下先用真库测试锁定 401 机制。
- 前端单片 S7（契约在 S5 冻结后开工），S8 端到端对抗独立成片（后端主导，前端只补必要的测试钩子），S9 收口。
- 建议并行度 2：一人后端 S1→S3→S5，一人后端 S2→S4→S6（S2 依赖 S1 的列；S4 依赖 S3 的部门；实际是两段并行后汇合，排期见 §6 依赖图）。

---

## 6. 切片总览与依赖

| 切片 | 标题 | 类型 | 主要触碰 | 对 598/33 影响 | 依赖 | 可并行 |
|---|---|---|---|---|---|---|
| S0 | M2 基线留证 + 鉴权/成员现状 Characterization | 纯后端 | docs/baseline；新增 __tests__/characterization | 只增测试 | — | 与 S1 并行 |
| S1 | 迁移 A/B：5 表 + users 5 列 + 默认工作区/系统角色/owner 自举幂等回填 | 纯后端 | 1~2 个手写迁移；schema.prisma 增 model；rollback SQL | 无（DDL+回填，真库干跑测试） | S0 | 先行，阻塞全部 |
| S2 | 鉴权收口：tokenVersion claim + 共享解析核心（查 status/tv）+ v1 挂载骨架 + flag | 纯后端 | auth.ts（内部重构，签名不变）；middleware/authActive.ts；routes/v1/index.ts；config.ts | **高敏**（动 getUserId），靠 S0 + 全站回归 | S1 | 与 S3 并行（不同文件） |
| S3 | 部门树 service + `/v1/org/departments`（含 move/防环/path 重写/软删） | 纯后端 | domain/org/deptTree.ts；routes/v1/org/departments.ts | 无（新模块+新路由） | S1、S2 | S2 后 |
| S4 | 成员与多部门 `/v1/org/members`（列表/邀请/直接创建/部门分配/主部门） | 纯后端 | domain/org/{workspace,members,lifecycle}.ts；routes/v1/org/members.ts | 无 | S2、S3 | S3 后 |
| S5 | 系统/自定义角色 + role_assignments + effectiveOrgRoles 只读求值 + `/v1/org/roles` | 纯后端 | domain/org/roles.ts；routes/v1/org/roles.ts；shared-types 常量 | 无 | S3、S4 | S4 后；**契约冻结点** |
| S6 | 停用/重新激活闭环 + tv bump + 最后 owner 保护 + 审计事件 + 限流命名档 | 纯后端 | domain/org/lifecycle.ts；members.ts 路由；audit.ts 事件名；rateLimit 规则 | 无（新端点）；全站行为变化由 S2 承担 | S4、S5 | 串行收尾后端 |
| S7 | **前端**工作区通讯录：左下入口 + 三栏 DeptTree/MemberList/RoleManager + 500 虚拟滚动 | 需前端 | web features/contacts/*；api/client.ts/hooks；icons.tsx 追加；App.tsx 路由 | web 只增；旧页面不动 | S5（冻结契约） | 与 S8 准备并行 |
| S8 | 6 层对抗端到端 + AC-M2-1 自动化 + 500 成员性能/查询计数 | 纯后端测试 | routes/v1/org/__tests__；scripts（造数） | 只增测试 | S6、S7 | S6 后 |
| S9 | 出口收口：openapi 草案、ADR、40RC 回归、flag 生命周期、baseline、runbook | 文档+验证 | docs/adr、docs/baseline、docs/planning | 无 | 全部 | 收尾 |

关键路径：S0/S1 → S2 → S3 → S4 → S5 → S7 → S8 → S9（S6 可在 S5 后与 S7 并行）。

---

## 7. 切片明细

> 每片统一给：现状证据、新增/改动文件（具体路径）、改动要点、独立验收命令、对基线影响/保护、回滚。

### S0 — 基线留证 + Characterization 锁行为

**新增文件**
- `docs/baseline/2026-09-15-m2-baseline.md`：git a4bbf1f、598/3 skipped、web 33、迁移 12、Node/SQLite 版本、Hono/jose 版本。
- `apps/api/src/domain/org/__tests__/characterization/auth-current.test.ts`（目录先建）：
  - 用真临时库 + 真 auth 路由（仿 records-keyset 模式）锁：无 token→null/401；坏 token→null；有效登录签发 token 7 天 exp；/me 200/404；停用概念不存在（基线行为：users 无 status，任何存在用户验签即过）。
  - 锁 signup/login 响应形状（token + publicUser 字段集合）。
- `.../characterization/resource-rbac-current.test.ts`：造 base+member 五角色，锁 `permissionsForRole` 全矩阵与 requireCanView/Edit/ManageSchema/ManageBase/Comment 的放行/403 现状（M2 后必须逐值不变，S9 复跑）。
- `.../characterization/public-share-current.test.ts`：扩展现成 `routes/__tests__/public.test.ts` 的快照认知（不修改其文件，新增一份说明性测试锁"匿名访问不查 users"的事实：停用某 user 不影响 /s/:token——把 §5-D.5 口径变成可执行断言，防后人误改）。
- `.../characterization/migration-count.test.ts`（或写进 baseline 手工口令）：记录迁移目录数=12，S1 后变 13/14。

**要点**：只测不改。停用/401 的"目标行为"测试在 S2/S6 写（before/after 对照清晰）。
**独立验收**：`pnpm -w test` 全绿，api 计数 598+N。
**回滚**：删新增测试与文档。

---

### S1 — 迁移：组织五表 + users 扩列 + 幂等回填

**新增/改动**
- `apps/api/prisma/migrations/20260915xxxxxx_enterprise_org_ddl/migration.sql`（迁移 A，DDL + 系统角色种子）：
  - `workspaces`：id PK、name（默认"默认工作区"）、`policyVersion INTEGER NOT NULL DEFAULT 0`、menuVersion/navVersion 列预留（M3 用，M2 先建整数列默认 0，避免 M3 再改表——注意只建 M2 明确要用的 policyVersion；navVersion/menuVersion 是否提前建列列为可选，倾向**不建**，YAGNI，M3 再只增）、createdAt/updatedAt。
  - `departments`：id、workspaceId NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE、parentId TEXT REFERENCES departments(id) ON DELETE RESTRICT、path TEXT NOT NULL、name TEXT NOT NULL、ord INTEGER NOT NULL DEFAULT 0、status TEXT NOT NULL DEFAULT 'active'、createdAt、updatedAt、deletedAt；`INDEX (workspaceId, parentId)`、`INDEX (path)`。
  - `dept_members`：id、departmentId NOT NULL REFERENCES departments(id) ON DELETE RESTRICT、userId NOT NULL REFERENCES users(id) ON DELETE CASCADE、isMain INTEGER NOT NULL DEFAULT 0、joinedAt；`UNIQUE(departmentId,userId)`、`INDEX(userId)`；**额外部分唯一索引保证一人一主部门**：`CREATE UNIQUE INDEX ... ON dept_members(userId) WHERE isMain=1`（SQLite 部分索引；PG 同样支持 partial index，方言可接受——列入 ADR 注记）。
  - `roles`：id、workspaceId NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE、systemKey TEXT（五枚系统角色填 owner/...，自定义 NULL）、name NOT NULL、description TEXT DEFAULT ''、isSystem INTEGER NOT NULL DEFAULT 0、permissions TEXT NOT NULL DEFAULT '[]'、createdAt、deletedAt；`UNIQUE(workspaceId,name)`、`UNIQUE(workspaceId,systemKey)`（SQLite 多 NULL 不冲突，自定义行 systemKey NULL 可多行）。
  - `role_assignments`：id、roleId NOT NULL REFERENCES roles(id) ON DELETE CASCADE、subjectType TEXT NOT NULL（user/dept）、subjectId TEXT NOT NULL、scopeType TEXT NOT NULL DEFAULT 'workspace'、scopeNodeId TEXT、createdAt、createdBy TEXT；`UNIQUE(roleId,subjectType,subjectId,scopeType,scopeNodeId)`、`INDEX(subjectType,subjectId)`。
  - users 加列（全部可空或带常量默认，SQLite ALTER 友好）：`status TEXT NOT NULL DEFAULT 'ACTIVE'`（注意 ADD COLUMN 带常量默认合法；存量行即 ACTIVE）、`workspaceId TEXT REFERENCES workspaces(id) ON DELETE SET NULL`（SQLite ALTER 加不了带 FK 的列——**FK 约束跳过，仅加列，引用完整性应用层保证**，与 M1 方言纪律一致，注记）、`tokenVersion INTEGER NOT NULL DEFAULT 0`、`disabledAt DATETIME`、`lastSeenAt DATETIME`、`inviteTokenHash TEXT`、`invitedAt DATETIME`；`INDEX(workspaceId)`、`INDEX(status)`。
    - 顺序问题：workspaces 必须先建再给 users 加 workspaceId（同一迁移内顺序写即可）。
  - 播种：INSERT 默认 workspace（固定 id 常量如 `'ws_default'`，便于幂等与回填引用）；INSERT 五系统角色（固定 cuid 风格常量 id 如 `role_owner`...，workspaceId=ws_default，permissions：owner `["manage_departments","manage_members","manage_roles"]`，余四枚 `[]`），全部 `WHERE NOT EXISTS`。
- 迁移 B `..._enterprise_org_backfill/migration.sql`（幂等数据回填）：
  - `UPDATE users SET status='ACTIVE', workspaceId='ws_default', tokenVersion=0 WHERE workspaceId IS NULL`（status/tokenVersion 已有默认，双保险）。
  - owner 自举：取最早用户 INSERT role_assignments（subject user → role_owner，workspace scope，createdBy='system-bootstrap'），`WHERE NOT EXISTS(任何 owner 授予) AND EXISTS(SELECT 1 FROM users LIMIT 1)`；SQLite 用 `INSERT ... SELECT ... WHERE NOT EXISTS`，选人子查询 `SELECT id FROM users ORDER BY createdAt ASC, id ASC LIMIT 1`。
  - 不建部门、不建 dept_members（组织为空，管理员在 UI 自建）。
- `schema.prisma`：新增 5 个 model（@@map snake_case 表名蛇形复数）+ User 增字段与反向关系；生成 client。
- `prisma/docs/rollback/<ts>_enterprise_org.down.sql`：DROP 五表与新索引说明；users 列不可 DROP（旧 SQLite），注明闲置无害。

**要点/陷阱**
- Prisma migrate deploy 对"迁移内引用刚建表"按语句顺序执行没问题；users FK 列限制要遵守（应用层保证 workspaceId 有效）。
- 部分唯一索引不能在 schema.prisma 表达，用 `// 由手写迁移维护` 注释 + 原始迁移承载（Prisma 会感知为 drift：该索引在 DB 里但 schema 不声明——可接受，与 record_field_index 同类处理，在 schema 注释写明，禁止 migrate dev 据其生成变更）。
- 固定 id（ws_default/role_owner 等）只在单工作区成立；多工作区是 Out-of-Scope，固定 id 让回填/求值极简单，ADR 记录。

**独立验收**
```bash
# 干净临时库干跑（CI 第 8 步自动）
T=$(mktemp -d); DATABASE_URL="file:$T/t.db" pnpm --filter @gx/api exec prisma migrate deploy
# 断言：14 个迁移目录；users 新列默认值；1 个 workspace、5 个系统角色；最早用户有 owner 授予
# 重跑 deploy 幂等（已应用跳过）；对现有 dev.db 升级后 users 全部 ACTIVE+ws_default，抽样 0 NULL
pnpm -w test   # 598 全绿（新表不影响现有用例）
```
**回滚**：flag 尚不存在（S2 才挂路由），纯表/列；发布前快照恢复 + down SQL。

---

### S2 — 鉴权收口：tokenVersion + status 校验 + v1 骨架 + flag

**改动文件**
- `src/config.ts`：增 `enterpriseOrg: boolean`（GX_ENTERPRISE_ORG，非 test 默认 on、test 默认 on，显式 off 摘除）与 `authStateTtlMs: number`（GX_AUTH_STATE_TTL_MS，默认 0，非负整数校验）。
- `src/auth.ts`：
  - 抽共享核心 `resolveActiveAuth(c): Promise<{userId, status, tv, workspaceId} | null>`：验签（无 tv claim 视 0）→ 查用户行 → status/tv 判定；DISABLED/tv 不符 → null（不区分原因给上层 401，审计在调用侧）。
  - `getUserId` 保持签名 `Promise<string|null>`：内部改为调用核心（**行为变化点：多一次 PK 查询 + DISABLED/tv 拦截**；ACTIVE 且 tv 匹配时与旧行为完全一致；存量无 tv token 平滑通过）。这是 M2 唯一对旧链路有行为影响的改动，S0 测试全门保护。
  - `issueToken(userId, tv=0)`：signup/login/invite-accept 签发带 tv；login 增 ACTIVE 校验（INVITED 403、DISABLED 401），signup 不变（仍 ACTIVE）。
  - `/me` 复用核心，用户 DISABLED 返回 401（替代旧的"存在即 200"）。
- `src/middleware/authActive.ts`：`requireActiveUser(c)`（v1 用，失败抛 HttpError 401 并附 code）、`requireOrgAction(action)`（403）。
- `src/routes/v1/index.ts`：`export const v1 = new Hono()`；本片刻挂一个 `GET /v1/meta`（或 health 风格探针）验证链路；S3 起挂 org。
- `src/app.ts`：条件 `mount.route("/api/v1", v1)`（flag on 时）。
- 用户状态缓存（仅 TTL>0）：`src/domain/org/authStateCache.ts`（Map+TTL，容量 5000，invalidate(userId)）；停用事务后调用 invalidate；TTL=0 旁路。

**要点/陷阱**
- `records-keyset.test.ts:17` mock `getUserId` 仍兼容（名字/签名不变）。
- 真库路由测试里建的用户默认 status ACTIVE/tv0，mock token 无 tv 也通过——确认既有真库测试不被新查询打穿（它们 mock 掉 getUserId，不查库；不受影响）。
- 性能：每请求 +1 PK 查，写一条 benchmark 笔记（500 用户库连续 1000 次 resolve 总耗时），证微秒级。
**独立验收**
```bash
pnpm -w test                        # 598 全绿 + 新增：无tv旧token可用；DISABLED→401；tv+1→401；INVITED 登录 403
GX_ENTERPRISE_ORG=off pnpm --filter @gx/api test   # /api/v1 不挂载 404，旧 /api 全绿
pnpm --filter @gx/api typecheck && pnpm --filter @gx/api lint
```
**回滚**：代码层 revert auth.ts（核心内聚在两个函数，diff 可控）；flag 只控 v1 挂载，不关 getUserId 的新校验——若新查询需紧急旁路，提供 `GX_AUTH_STATE_CHECK=off`（仅紧急，默认 on，计划中实现但不宣传为常态）。

---

### S3 — 部门树 service + `/api/v1/org/departments`

**新增**
- `src/domain/org/deptTree.ts`（纯函数 + tx 操作）：`selfPath(parentPath,id)`、`isDescendantPath(ancestorPath, maybeDescPath)`、`assertMoveNoCycle(node,newParentPath)`、`rewriteSubtreePathsTx(tx, deptId, oldSelfPath, newSelfPath)`（查出子树、应用层 map、参数化 update 逐条/批量）、`MAX_DEPTH=32` 校验、`validateDeptName`。
- `src/domain/org/workspace.ts`：`getDefaultWorkspaceId()`（查 ws_default，内存单例 Promise 缓存）。
- `src/routes/v1/org/departments.ts`（全部 requireActiveUser + requireOrgAction('manage_departments') 写、登录可读）：
  - `GET /` 平铺列表（含 memberCount：group by dept_members 一条聚合，活成员 status<>'DISABLED' 计数口径在 S4 定，先给 dept_members 行数）。
  - `POST /` {name,parentId?,ord?} 201；`PATCH /:id` {name,ord,parentId}（parentId 变更触发 move 事务）；`DELETE /:id`（无子部门/无成员→软删；否则 409 带 counts）。
  - 校验：parentId 须同 workspace 且未软删；name 同父唯一 409；move 防环 400；深度 32 400。
- `routes/v1/org/index.ts` 装配 departments。
- 单测：纯函数全套（path 拼接/前缀/防环/重写后全子树 path 正确、深度拒绝）；真库路由测试（建 6 层链、移动中间层、断言全部后代 path、环拒绝、软删）。

**独立验收**
```bash
pnpm --filter @gx/api test -- org
# 新增测试全绿；EXPLAIN：子树 LIKE 命中 path 索引（记录计划，无 SCAN departments）
pnpm --filter @gx/api typecheck
```
**回滚**：删新文件 + 去 org 装配一行；表保留。

---

### S4 — 成员与多部门 `/api/v1/org/members`

**新增/改动**
- `src/domain/org/members.ts`：
  - `listMembers(filters)`：分页（page/limit，limit≤100）、q（email/displayName 参数化 LIKE，短串）、deptId（含子树：path 前缀 join 一条 SQL）、status 过滤；返回 `{items,total,page,limit,hasMore}` + 每人 deptMemberships（deptId/isMain）与角色摘要。
  - `assignDepartmentsTx(tx, userId, assignments:[{deptId,isMain}])`：全量替换或增量端点二选一（M2 用增量 add/remove + setMain）；isMain 唯一性靠部分唯一索引 + 事务内"先清旧 main 再设新 main"。
  - 邀请/直接创建：`createInvitedUserTx`（email 唯一 409、status INVITED、crypto.randomBytes 生成激活码，sha256 存 inviteTokenHash，返回明文一次）、`createActiveUserTx`（管理员给初始密码，bcrypt，ACTIVE，workspaceId=默认）。
- `src/domain/org/lifecycle.ts` 本片刻状态转换原语（acceptInvite），停用在 S6。
- `routes/v1/org/members.ts`（manage_members 写；读：登录即可，或管理动作限 owner——M2 通讯录对全员只读可见是合理默认，**采取：登录用户可读目录，写限管理动作**，与"组织能当工作台"一致）：
  - `GET /members`、`GET /members/:id`、`GET /members/me/effective-roles`（S5 完整实现，本片先返直接角色/部门）。
  - `POST /members`（直接创建 ACTIVE，body email/displayName/password）、`POST /members/invite`（INVITED + 返回 activateUrl 一次）。
  - `POST /members/activate`（公开端点挂 /api/v1/auth/invite/accept：{token,password,displayName?}→ACTIVE 清 hash 发 JWT；放 auth 路由文件而非 org，不要求登录）。
  - `POST /members/:id/departments` {add?:[],remove?:[],mainDeptId?}（兼岗/调岗）。
- signup 自举：workspace 0 用户时注册者 owner（S1 已处理迁移，本片补运行时路径，单测）。
- 真库测试：兼两部门、主部门切换唯一、邀请链接一次性（重放 410/404）、q/分页 total 正确、停用者计数口径（S6 后补）。

**独立验收**：`pnpm --filter @gx/api test`；手测口令（curl 邀请→激活→登录）。
**回滚**：删新文件；users 新列闲置。

---

### S5 — 系统/自定义角色、授予、effectiveOrgRoles 求值（契约冻结）

**新增/改动**
- `shared-types` 增（只增）：`OrgAction='manage_departments'|'manage_members'|'manage_roles'`、`SystemRoleKey`、`OrgRoleDTO/DeptDTO/OrgMemberDTO/RoleAssignmentDTO`、`EffectiveRoleDTO{roleId,systemKey,name,sources:[{type:'user'|'dept',id,name}]}`（M3 openapi 的 TS 先型，前端只依赖这些）。
- `src/domain/org/roles.ts`：
  - 系统角色常量（id/key/动作集）与迁移种子单一真源注释（常量与 SQL 对拍测试）。
  - `createCustomRole/update/softDelete`（系统角色 405/400；删除角色要求先清空授予或显式 `reassignTo`，C-12，409 列悬挂数）。
  - `grantTx/revokeTx`（user|dept；scope M2 固定 workspace，body 带 nodeId 一律 400）。
  - **`effectiveOrgRoles(userId)` 定数查询求值**（§5-C），返回角色 + 来源；`usersWithRole(roleId)` 反向展开（最后 owner 保护用，S6）。
  - `hasOrgAction(userId, action)`。
- `routes/v1/org/roles.ts`：`GET /`（系统角色固定序在前 + 自定义）、`POST /`（name/description/actions 白名单校验，三动作之外 400）、`PATCH /:id`（系统角色仅 description 可改）、`DELETE /:id`、`GET /:id/assignments`、`PUT /:id/assignments`（批量主体集，事务 diff 授予/撤销）、`GET /members/:id/effective-roles`。
- 真库测试矩阵：直接授予、部门授予（含子部门成员继承）、多部门并集去重、来源清单完整、软删部门不展开、自定义角色删悬挂保护、系统角色不可删。
- **契约冻结**：本片合入时输出 `docs/planning/phase2/m2-openapi-draft.yaml`（S9 定稿），前端 S7 据此开工。

**独立验收**：api 全绿 + shared-types build + 求值 SQL 计数测试（造 6 层 ×多兼岗，断言查询数为常量，日志计数）。
**回滚**：新模块摘除；表数据保留。

---

### S6 — 停用/重新激活闭环 + 最后 owner 保护 + 审计

**改动/新增**
- `domain/org/lifecycle.ts`：`disableUserTx`（assertNotLastOwner→status DISABLED、disabledAt、tokenVersion+1、authStateCache invalidate；保留全部成员/部门/角色行）、`reactivateUserTx`（ACTIVE、disabledAt=null、tv+1 使旧停用期 token 仍失效——重新激活强制重新登录）、`assertNotLastOwnerTx`（展开 owner 集合，含部门继承）。
- 路由（members.ts）：`POST /members/:id/disable`、`POST /members/:id/reactivate`（manage_members）；自我停用 400；最后 owner 409。
- `audit/audit.ts` 事件名只增：`member_invited`、`member_activated`、`member_disabled`、`member_reactivated`、`department_created/moved/deleted`、`role_created/deleted`、`role_assignment_changed`；emit 接线（detail 不带邮箱外的敏感信息，复用现有脱敏）。
- 限流：新增命名档（可选）`/api/v1/org/members/*/(disable|reactivate)` 与 invite/activate 收严到 30/60s（在 rateLimit 规则表加，不改旧档）。
- 测试（AC-M2-1 后端事实，S8 端到端串）：停用后旧 token 下一次请求 401（打 /me 与 v1 两个面）、TTL 缓存开启时 invalidate 后仍下次 401、reactivate 后旧 token 仍 401 需重登、最后 owner 三路径保护（直接授予/部门授予/自停用）。

**独立验收**
```bash
pnpm -w test
# 手测：login→disable→旧 token curl /api/auth/me = 401；reactivate→旧 token 仍 401；新 login 200
```
**回滚**：停用是数据状态（无破坏性删数据）；reactivate 即人工回退；代码 revert 不影响已存 status 列（默认 ACTIVE）。

---

### S7 — 前端工作区通讯录（需前端，S5 契约冻结后开工）

**遵循 web 纪律**：只走 `api/client.ts`（新增 Org 段，路径 `/api/v1/org/*`），不裸 fetch；无新 npm 依赖；gx-* token；图标只在 `icons.tsx` 追加（building/sitemap/userPlus/userSlash(crown/slash 按需，命名与现有蛇形风格一致），不 emoji。

**新增/改动**
- 路由：`App.tsx` 在 AppShell 子路由内增 `/workspace/contacts`（无 baseId）；`Sidebar.tsx:239` 底部区在"设置"前加"通讯录"按钮（Icon building/users），仅登录可见。
- `features/contacts/ContactsPage.tsx`：左中右三栏布局（部门树 / 成员列表 / 角色管理），三 tab 或同屏三栏——SPEC §7 写"成员/部门/角色三栏"，采用**同屏三栏**（左 DeptTree、中 MemberList[+选中成员抽屉编辑部门/角色]、右 RoleManager），窄宽退化 tab（可只做 ≥1024 三栏，M2 不做移动端，SPEC §10 浏览器桌面三版）。
- `api/hooks` 增：`useDepartments`、`useOrgMembers`（分页 + q + deptId 过滤）、`useOrgRoles`、`useEffectiveRoles(memberId)`，mutation 全套（TanStack Query，失效后 invalidate 相关 query）。
- DeptTree：平铺数据前端组树、增/改名/移动（下拉选父，防环在前端也拦一次）/删（409 显示成员数引导）；6 层缩进无压力。
- MemberList：**虚拟滚动**（自实现窗口化，不引依赖：定高行 + IntersectionObserver/scroll 切片，参照 GridView.tsx:412-413 的 start/end 模式），500 行流畅；搜索框、状态筛选（在职/停用/待激活）、部门筛选；选中成员抽屉：显示/编辑多部门（主部门单选 + 兼岗多选）、有效角色（只读来源清单）、停用/重新激活按钮（二次确认 Modal，危险操作 gx-danger 样式，不依赖颜色单表意 + 文字确认）。
- RoleManager：系统角色五枚（锁定标识，不可删，展示说明）、自定义角色 CRUD（名称/描述/三枚管理动作勾选，无资源动作位）、角色成员维护（选人/选部门，支持选部门节点）。
- 邀请：弹窗两种方式（邀请：填邮箱生成激活链接，结果面板一次性展示链接+复制按钮；直接创建：邮箱/姓名/初始密码）。
- 空状态/加载/错误：无部门空引导；401 由全局处理（停用后任意操作触发跳登录，符合 AC）。
- 纯函数抽到 `features/contacts/lib/tree.ts`（组树/移动候选父列表过滤/虚拟窗口计算）并配 vitest 单测（web 33 基线只增）。

**独立验收**
```bash
pnpm --filter @gx/web typecheck && pnpm --filter @gx/web build
pnpm -w test
# 手测/冒烟：500 成员滚动不卡（Performance 帧率主观+长列表 DOM 节点数断言）；
# 停用某人 → 其浏览器下次操作被登出；调岗 → 有效角色来源即时变；三栏在 /workspace/contacts 可达，base 设置页不受影响
```
**回滚**：路由/入口/feature 目录移除即整页摘除；client/hooks 只增，留着无害。

---

### S8 — 6 层对抗端到端 + AC-M2-1 + 性能/查询计数

**新增**
- `routes/v1/org/__tests__/ac-m2-1.adversarial.test.ts`（真库真迁移真 Hono，仅初始化时 mock 必要设施，走真 jwt：用真实 issueToken 签发，不 mock auth）：
  1. 建 6 层部门 D1..D6（API 逐级 POST）。
  2. 用户 U 兼 D3 与 D6 两部门（assignments）。
  3. 给 D2 授自定义角色 R（含 manage_members），给 D6 直接授某角色 Q；断言 `effective-roles` 含 R（经 D3 祖先链）与 Q，来源清单 3 条路径正确。
  4. U 调岗：移出 D3 → 下次请求 R 消失、Q 仍在；加回 → 恢复（即时性，无 sleep）。
  5. owner 停用 U：U 旧 token 调 `GET /api/auth/me` = 401、调 `/api/v1/org/members` = 401；断言响应体 code=UNAUTHORIZED。
  6. 嵌入模拟：同一 token 第二次请求（模拟 iframe 刷新）仍 401。
  7. owner 自停用 400；移除最后 owner 授予（含经部门授予的展开）409。
  8. 匿名 `/api/public/s/:token` 在停用某无关成员后仍 200（口径 §5-D.5 锁死）。
- 查询计数：effectiveOrgRoles/listMembers 在 6 层×10 兼岗夹具上 Prisma 调用计数（bench proxy 已有 instrumentPrisma 设施，db.ts:38）断言与层数/人数无关的常量上界。
- 500 成员性能：脚本造 500 ACTIVE 用户 + 6 层部门 + 随机兼岗；`GET /members?limit=100` 服务端耗时记录（目标宽松：P95 < 150ms，管理面非 SPEC 硬指标，仅留证）；首屏三接口并行总时长对照"首屏 <1s"（SPEC §10 :134 的导航指标主要在 M3，M2 仅通讯录三接口留基线）。
- 升级演练：对一份"v0.1.0 风格"旧库（仅 users/members/kb，无组织表）跑 deploy → 断言全 ACTIVE/ws_default/owner 自举；再跑一遍幂等。

**独立验收**：上述测试全绿；结果入 `docs/baseline/2026-09-15-m2-gate.md`。
**回滚**：纯测试/脚本。

---

### S9 — 出口收口：openapi/ADR/RC 回归/flag/runbook

- `docs/planning/phase2/openapi-m2-draft.yaml`（OpenAPI 3.0，全部 /api/v1/org/* + invite/accept：method/path/请求 schema/响应 schema/错误码；M3 出口并入正式 openapi.yaml 冻结，本片先出 M2 分册）。
- 新建 ADR（docs/adr/）：
  - `0022-org-token-version-revocation.md`：tokenVersion 即时失效（vs 会话表/refresh）、默认零缓存、单实例纪律、ADR-0008 升级口。
  - `0023-materialized-path-dept-tree.md`：物化路径选型（vs 邻接/嵌套集/闭包）、移动重写、32 护栏、部分唯一索引方言注记。
  - `0024-org-role-vs-resource-role-layering.md`：两层同名角色隔离、M4 subjectType=role 衔接、组织动作三枚边界。
- 复跑 `docs/baseline/2026-09-12-regression-cases.md` 40 RC 全量（M2 相关：全部账号/成员/分享/知识库 owner 类 RC）+ S0 三组 characterization 必须逐值绿。
- flag 生命周期：GX_ENTERPRISE_ORG 默认 on 持续一个迭代稳定后，下一期删除 off 分支与 v1 条件挂载（清理任务另开，M2 保留）；GX_AUTH_STATE_TTL_MS 保持默认 0 直到有性能证据。
- runbook 增章："组织管理面紧急收回（flag off）""停用账号后用户仍能访问的排查（tv/缓存/多实例警告）""组织数据回填/默认工作区修复""激活链接重发"。
- 审计事件文档更新（事件名表 + 示例，不含敏感值）。
- baseline 收口报告：测试计数 598+N / web 33+M、迁移数、对抗用例结果、性能留证、升级演练结果。

---

## 8. 对 598/33 基线的影响面与保护

| 触碰源 | 切片 | 为什么不转红 / 保护 |
|---|---|---|
| getUserId 内部加查库+状态/tv | S2 | **唯一高敏点**：S0 auth-current 锁旧行为；无 tv claim 视 0 平滑兼容；ACTIVE+tv0 路径结果与旧版逐请求等价；records-keyset mock 签名不变；全站 598 复跑 |
| login 增加状态分支 | S2/S4/S6 | 现网用户全 ACTIVE（回填默认），登录行为不变；INVITED/DISABLED 是新状态新分支 |
| 新增 Prisma model + 迁移 | S1 | 只增表/列；CI 临时库干跑自动对账 12→14；现有查询不触新表 |
| /api/v1 新路由 | S2-S6 | 与 /api 平级独立 Hono；flag off 不挂载；旧路由表零 diff |
| 审计事件枚举只增 | S6 | TS 联合类型只增；现有 6 事件不受影响 |
| 限流规则加档 | S6 | 只增匹配规则，旧 STRICT/DEFAULT 优先级与计数不变，rateLimit 10 测试复跑 |
| 前端新页面 | S7 | 新路由/新目录；Sidebar 只加一个按钮；client/hooks 只增导出；web 33 + 新增纯函数测试 |
| shared-types 只增 | S5/S7 | 不改 Role/PermissionSet；现有 import 不受影响 |

**每切片统一回归口令（PR 必贴）**
```bash
pnpm -w install --frozen-lockfile
pnpm --filter @gx/shared-types build
pnpm --filter @gx/api typecheck && pnpm --filter @gx/web typecheck
pnpm -w test            # api 598+N passed/3 skipped、web 33+M；只许增，不许任一既有用例转红
pnpm --filter @gx/api lint
bash scripts/ci-quality.sh   # 含迁移临时库干跑（目录数动态对账）
```

预计新增测试（598 → 约 598+110～140，以实现为准）：S0 ~18、S1 迁移/回填 ~10、S2 鉴权 ~14、S3 部门树 ~20、S4 成员/邀请/多部门 ~20、S5 角色/求值矩阵 ~22、S6 停用/保护 ~14、S8 对抗/计数 ~16；web S7 纯函数/hook ~8。

---

## 9. M2 出口 Definition of Done

1. AC-M2-1 自动化全绿：停用成员后其旧 JWT 对 `/api/auth/me` 与任意 `/api/v1/*` 的**下一次请求均 401**（零缓存默认）；登录态嵌入同源失效；调岗/兼岗后 effectiveOrgRoles 下次请求即按多部门并集变化；reactivate 后旧 token 不可用、须重登。
2. 6 层部门对抗用例（S8 八条）全绿，含防环、移动子树 path 全量正确、最后 owner 保护（直接+部门授予两路径）、匿名外链不受停用影响。
3. 只增迁移在干净临时库与"旧库快照"两种库上 `migrate deploy` 成功且幂等；存量 users 回填 ACTIVE/ws_default 0 NULL；owner 自举恰好一行；回滚 SQL/快照恢复演练 ≤30 分钟。
4. 旧资源 RBAC 五角色矩阵与 40 条 RC 逐值不变（S0 characterization S9 复跑）；旧 `/api/*` 契约零 diff；598+N/33+M 全绿、typecheck/lint/ci-quality 全绿。
5. 三栏通讯录可用：左下入口可达；500 成员虚拟滚动无卡顿（DOM 节点有界）；部门增改移删、邀请/直接创建/激活、兼岗调岗、角色与授予（含授予部门）端到端可用；系统五角色不可删改 key；无新依赖、无裸 fetch、无 emoji、图标全走 icons.tsx、gx-* token 无硬编码色值。
6. effectiveOrgRoles 查询数为与部门层数/成员数无关的常量（计数测试留证）；500 人组织三接口基线耗时留档。
7. flag `GX_ENTERPRISE_ORG` on/off 行为符合 §4.1；紧急收回与排障 runbook 齐备；审计覆盖邀请/激活/停用/部门/角色/授予七类事件；ADR-0022/0023/0024 归档；M2 openapi 分册产出并与 TS 类型一致。
8. 边界：无部门空状态引导、同名部门 409、环移动 400、超深 400、角色删除悬挂 409、越权（非管理员写 org）403、未激活登录 403——全部有自动化用例。

---

## 10. 外部输入清单

S0–S9 全部可本地完成（无外部凭据/服务/新依赖）。需产品/总监确认项（不阻塞编码，阻塞对应切片合入）：
1. §5-D.5 匿名公开外链在"停用成员"时的口径（本计划按"不联动吊销"落地）。
2. §4.4 v1 成功响应是否立即切 `{code,data,message}` 信封（本计划按现网风格、M3 随 openapi 统一）。
3. 通讯录对全员只读可见 vs 仅管理员可见（本计划按全员可见目录、写限管理动作；若组织要求目录保密，改一个中间件即可，S4 标注切换点）。
4. 自定义角色 M2 是否开放三枚管理动作勾选（本计划开放；若要求 M2 自定义角色仅挂名、管理动作只 owner，把 actions 白名单清空即可，均不影响 M4）。
5. 工作区/系统角色使用固定 id（ws_default/role_owner...）——单工作区前提成立，知会。

---

## 11. 现状核对后与所给锚点/旧文档的不符与澄清

1. **测试基线**：实跑为 **api 47 文件 598 passed / 3 skipped、web 2 文件 33 passed**（2026-09-15 12:17），与主理人所述一致；迁移目录 **12 个**（M1 计划时 11，sidecar 后已 12）。M2 后变 14（拆两迁移）。
2. **JWT 库**：SPEC §4 与派工称"无状态 JWT（jose）"。事实：`jose@5.9.0` 确在 dependencies，但源码统一 import 的是 **`hono/jwt`**（`auth.ts:5`），jose 仅作为 build external 依赖存在、src 内无 import。M2 加 tv claim 用现有 `hono/jwt` 的 sign/verify 即可，**不引入也不更换依赖**；若总监要求统一到 jose API，属于独立重构，不夹在 M2。
3. **JWT 有效期**：现状 **7 天**（`auth.ts:28`），SPEC §4 表注 access 1h/refresh 30d 是 M6 PAT/OAuth 口径，与现有登录态不是一回事；M2 不动 TTL。
4. **鉴权收口点比预想少**：业务路由不直接调 getUserId，全部经 `guards.ts` 的 require*；因此让全站感知停用只需改 getUserId 核心 + /me，无需逐路由接线（派工所问"接在哪里"的答案）。
5. **"分享凭据"有两套，语义不同**：base `share_links` + `/bases/join/:token`（登录态持票兑换，停用即被 getUserId 拦）；kb_doc 匿名外链 `/api/public/s/*`（不绑用户）。AC-M2-1 的"嵌入/分享凭据即时失效"不能无条件覆盖匿名链接，口径设计与澄清见 §5-D.5，请总监复核。
6. **左下设置现状是 base 级，不是工作区级**：Sidebar 底部"设置"跳 `/base/:baseId/settings`（`Sidebar.tsx:251`），MembersPanel 管的是 base Member。M2 不能把通讯录塞进该页（会混淆两层成员，正是派工警告的点）；方案是新增并列工作区级入口/路由，统一外壳收敛留 M3（PRD N1 归 M3）。
7. **ARCH §4.2 的 users 字段名 `deactivatedAt/lastSeenAt` 与派工的 `disabledAt` 不一致**：本计划采用派工/SPEC 状态语义命名 **`disabledAt`**（状态是 DISABLED，列名对齐），另加 invitedAt；lastSeenAt M2 无消费方（登录已有审计），**不建**（YAGNI，需要时只增）。
8. **ARCH §4.2 预置系统角色为 workspace_admin/workspace_member 两枚**，与 **SPEC §6/派工明确的"五枚 owner/creator/editor/commenter/viewer"冲突**。本计划以 SPEC（团队唯一开发依据）为准播种五枚；owner 在 M2 承担工作区管理面（manage_* 三动作），workspace_admin/member 不建。M4 若需显式 admin 命名，可再加自定义/系统角色，不影响五枚锚点。请总监复核该覆盖。
9. **ARCH §5.6 提"停用靠 60s 短缓存 + tokenVersion"**：本计划收紧为**默认零缓存直查**（严格满足 AC"下一次请求即 401"），缓存 TTL 可配默认 0、停用时同进程主动 invalidate；理由是单实例 PK 点查成本可忽略，AC 是 P0 字面验收。
10. **role_assignments 唯一键**：ARCH 草案为 `[roleId,subjectType,subjectId,nodeId]` 四元；本计划加 scopeType 进键 `[roleId,subjectType,subjectId,scopeType,scopeNodeId]`，避免 workspace/node 两 scope 同主体冲突。
11. **users 加 workspaceId 外键**：SQLite `ALTER TABLE ADD COLUMN` 不能附带 REFERENCES 约束，该列只加列、引用完整性应用层保证（与 M1 方言纪律一致）；新表的 FK 正常建。
12. **v1 响应信封**：见 §4.4 与 §10-2，M2 沿用现网 `{error,code}`/资源本体，`{code:0,data,message}` 统一留 M3 openapi 冻结点，避免 M2 同时改前端解析习惯。
13. **企业 flag 命名对齐**：ARCH flag 表用 `enterprise_org`，本计划落为 env `GX_ENTERPRISE_ORG`（与 GX_M1_*/GX_RATE_LIMIT 命名纪律一致），同一物。
14. **迁移回填方式**：ARCH §4.2 提"加可空列→回填→建 NOT NULL 表拷贝"模式；本计划 users.status/tokenVersion 直接用 ADD COLUMN 带常量默认（SQLite 支持），无需表拷贝；workspaceId 保持可空列（应用层保证非空），避免拷贝大表。
15. **现有 base owner 唯一保护可复用模式**：`auth.ts:206-219` 逐 base count；M2 的"最后工作区 owner"保护必须把**部门继承授予**展开计入（否则绕过），已在 §5-D.4 与 S6 明确，旧逻辑本身不动。

---

## 12. 切片速查（供派工 / RoleVerdict）

| ID | 标题 | 关键文件 | 独立验收（一句话） | 跨端 |
|---|---|---|---|---|
| S0 | 基线+特征测试 | docs/baseline/2026-09-15-m2-baseline.md；domain/org/__tests__/characterization/* | 598/33 全绿，锁鉴权/资源 RBAC/匿名分享现状 | 否 |
| S1 | 组织五表+users 扩列+回填 | 2 个手写迁移；schema.prisma；rollback SQL | 干净库/旧库 deploy 成功且幂等，默认 ws+5 角色+owner 自举 | 否 |
| S2 | tokenVersion 鉴权收口+v1 骨架 | auth.ts；middleware/authActive.ts；routes/v1/index.ts；config.ts | 无 tv 旧 token 平滑可用；DISABLED/tv 不符下次请求 401；flag off 旧链路全绿 | 否 |
| S3 | 部门树 | domain/org/deptTree.ts；routes/v1/org/departments.ts | 6 层建/移/防环/path 重写/软删全部正确，LIKE 走索引 | 否 |
| S4 | 成员多部门+邀请激活 | domain/org/{members,lifecycle}.ts；routes/v1/org/members.ts | 兼岗/调岗/主部门唯一/邀请一次性激活/分页 q 正确 | 否 |
| S5 | 角色+授予+并集求值 | domain/org/roles.ts；routes/v1/org/roles.ts；shared-types | user/dept 授予并集+来源清单正确，求值查询数常量；契约冻结 | 否 |
| S6 | 停用即时失效闭环+保护+审计 | lifecycle.ts；members 路由；audit.ts；rateLimit.ts | 停用→旧 token 下次 401；最后 owner（含部门继承）保护；审计齐全 | 否 |
| S7 | 前端通讯录三栏 | features/contacts/*；client.ts/hooks；icons.tsx；App/Sidebar | 三栏+500 虚拟滚动+全操作闭环；旧 base 设置不受影响 | **是** |
| S8 | 6 层对抗端到端+性能 | routes/v1/org/__tests__/ac-m2-1.adversarial.test.ts | AC-M2-1 八条断言全绿、查询常量化、旧库升级演练 | 否 |
| S9 | 收口 | openapi-m2-draft；ADR-0022/23/24；40RC；runbook；baseline | RC/characterization 逐值绿、回滚演练≤30min、文档齐备 | 否 |
