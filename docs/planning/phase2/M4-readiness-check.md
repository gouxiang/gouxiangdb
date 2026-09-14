# M4 开工前就绪核对（只读核对，不改业务码）

- 日期：2026-09-14
- 作者：架构师 高见远
- 核对对象：`docs/planning/phase2/M4-implementation-plan.md`（r2，2026-09-18 终审版，793 行）
- 磁盘基线：HEAD `31df766`；工作区另含 M3-S5 **未提交在途改动**（见 §1 阻断/关注项）
- 纪律：本次核对全程只读，未改 `apps/` 任何代码；不对 M4 计划正文做改动，所有修正措辞集中在本文，由项目总监审定后回填。

---

## 0. 裁决摘要（RoleVerdict）

- **verdict：pass（附条件）**。M4 计划引用的核心机制在代码中全部成立，无"假设根本不存在"的阻断项；但存在 **1 项必须先处理的合流条件** 与若干命名/行号漂移。
- **合流条件（开工前置）**：M3-S5（tree/menu 读 API）当前以**未提交工作区改动**形态存在，M4-S7 的剪枝挂载点与 M4 基线重锚都依赖它定稿。建议 M4-S0 可立即开工（纯新增测试/文档，不碰在途文件）；**S2 及之后切片等 M3-S5/S6 提交收口、锚点复核后再派工**。
- 不符项统计：**阻断级 0 条；必须修正（命名/签名漂移，影响切片措辞）13 条（M1~M13）；建议修正（行号/计数漂移）12 条（A1~A12）**。
- 计划中三处"按名查找不成立、但等价物存在"的引用（`sharePolicyAllows`、`ISBLANK`、`purgeResourceNodeTx`），已在 M7/M11/M12 给出真实落点，不构成功能阻断。

---

## 1. 阻断/关注项

### B-关注-1：M3-S5 读 API 为未提交在途改动，M4 多个锚点处于浮动态

`git status` 显示以下文件已修改未提交（M3-S5 在途）：

| 文件 | 在途内容 |
|---|---|
| `apps/api/src/routes/v1/index.ts` | 改为按 `config.enterpriseOrg` / `config.enterpriseNav` 双 flag 条件挂载；`/workspaces` 子路由在此接入 |
| `apps/api/src/app.ts:146` | v1 挂载条件改为 `config.enterpriseOrg || config.enterpriseNav` |
| `apps/api/src/config.ts:182/:238` | 新增 `enterpriseNav`（`GX_ENTERPRISE_NAV`），默认 on |
| `apps/api/src/domain/nav/workspace-read.ts`（新增） | `readNavTree`（:105）、`navVersionOf`（:96）、`TreeQueryError`（:26）、`TreeParams`（:19） |
| `apps/api/src/domain/nav/menu-read.ts`（新增） | `readMenuTree`（:82）、`menuVersionOf`（:76） |
| `apps/api/src/routes/v1/workspace.ts`（新增） | `/current/tree` 等薄控制器，导出 `workspaceRoutes` |
| `apps/api/src/routes/v1/__tests__/enterprise-flag-off.test.ts` | 双 flag off 态用例 |
| `packages/shared-types/src/index.ts`、`domain/nav/reconcile-types.ts` | 配套导出/类型 |

影响：M4 计划 §1.4/§9 仍描述"M2-S2 时 v1 无条件挂 org + /meta"，而磁盘在途版本已是双 flag 条件挂载（该形态与 M4 §9 表中"flag off 不挂新子路由"的意图一致，方向正确）。M4-S7 的 tree/menu 剪枝挂载点（`readNavTree` 内部分支）此刻才刚出现、S5 期间还会变动。

处置建议（不属计划假设失败，属排序纪律）：

1. M4-S0 现可开工（只新增 `domain/authz/__tests__` 与 `docs/baseline`，与上述在途文件零冲突）；
2. M4-S2（回填迁移）与 S3/S5/S7 的派工，排在 M3-S5 提交、M3-S6（manage_menu + owner 补位迁移）落地之后；
3. 本文凡引用在途文件行号处，均标注"待 M3-S5/S6 落地后复核"。

---

## 2. 基线重锚（2026-09-14 于当前工作区实跑）

| 项 | M4 计划记录值 | 当前磁盘实跑值 |
|---|---|---|
| api 测试 | a65073d：54 文件 657/3；6f7dc29：56 文件 678/3 | **79 文件 866 passed / 3 skipped**（含 M3-S5 在途改动；`pnpm vitest run`，耗时 19.2s） |
| 迁移目录 | 14（计划预期 M3 后 17） | **16**：`20260916090000_enterprise_nav_ddl`、`20260916093000_enterprise_nav_backfill` 已在；**M3-S6 manage_menu owner 补位迁移尚不存在**（S6 未开工） |
| `workspaces` 版本列 | policyVersion（M2）+ navVersion/menuVersion（M3-S1） | 三列均在（schema.prisma:379/382/383；DDL 迁移 :20-21） |
| api 测试文件总数（find） | — | 74 个 `.test.ts`（含 scripts 下测试；vitest 计 79 文件含非 .test 入口差异） |

说明：M4 计划 §7-S0 的"开工重锚 678/3"已过期，S0 文档应以 **866/3、79 文件、16 迁移** 重锚；M3-S6 落地后迁移变 17，M4 回填后 18、manage_share 补位后 19（与计划 §12-12 的推演一致，仅起点从 16 而非 14）。

---

## 3. 逐锚点核实

### 3.1 M2 三源之 role 源：`effectiveRoleRows` / `usersWithRole` / `hasOrgAction`（M4 复用，不重写）

| M4 引用 | 磁盘真实位置 | 结论 |
|---|---|---|
| `domain/org/authorization.ts` effective roles"定数两查询" | `authorization.ts:40-110` `effectiveRoleRows(userId, client?)`，实际 **3 次查询**（q1 部门集 :45、q2 祖先部门名 :64、q3 user/dept 授予 OR :75）；文件头 :1-10 注释 | 机制成立；**查询数计划写"两查询"、代码是 3 查询**（M2-S5 收口时补了 q2），M4 沿用其 ≤3 上界即可 |
| 计划 §1.4 "EffectiveRoleRow（:24-32，含 sources）" | 类型真源在 **`packages/shared-types/src/org.ts:129` `EffectiveRoleDTO`** + `:119` `EffectiveRoleSource`；authorization.ts :40 返回该 DTO | **类型名为 `EffectiveRoleDTO` 不是 `EffectiveRoleRow`**；api 侧无本地行类型 |
| `effectiveOrgRoles(userId, workspaceId)` | `roles.ts:9-11`：`export const effectiveOrgRoles = effectiveRoleRows`（别名）；**无 workspaceId 形参**（单工作区，workspace 内部固定） | 别名已提供，M4 可按 `effectiveOrgRoles` 名 import；**调用签名只有 userId（+可选 client），计划伪码中的 workspaceId 形参不存在** |
| `usersWithRole(roleId, client?)` 计划写 `roles.ts:66` | `roles.ts:66-110`，签名一致；反向展开 = 授予行 :67 → 子树部门 :81-91 → 成员 :96-100 → 过滤 ACTIVE :105-108 | 成立；返回值仅 **ACTIVE**（:106），INVITED/DISABLED 不计，M4 impact 复用须知悉此口径 |
| `hasOrgAction(userId, action)` 计划写 `:115-117` | `authorization.ts:113-120`，真实签名 **`hasOrgAction(userId, action, client?)` 三参数** | 成立，多一个可选 client；M4 manage_share 直接 import |
| 部门祖先展开"不重写" | `authorization.ts:22-24` `ancestorDeptIdsFromPath`；path 前缀子树展开见 `roles.ts:86-91`（startsWith） | M4 subjects.ts 直接包 `effectiveOrgRoles`，部门 path 集另查 dept_members，计划 §4.2 边界成立 |

### 3.2 `auth_policies` 真实 DDL（nav 迁移 20260916090000）

DDL 位于迁移文件 **:78-94**，schema.prisma `AuthPolicy` :533-550。逐列核对：

| 计划假设（§1.5/§4.x） | 磁盘真实列 | 结论 |
|---|---|---|
| id/workspaceId/nodeId/subjectType/subjectId | `id TEXT PK`、`workspaceId TEXT`（**无 FK**）、`nodeId TEXT`（**无 FK**）、`subjectType/subjectId TEXT NOT NULL` | 一致；注意 workspaceId/nodeId **均未建外键约束**（计划未假设有 FK，无数处受影响） |
| actions/fieldMask/conditions/reason | `actions TEXT NOT NULL DEFAULT 'r'`、`fieldMask TEXT`、`conditions TEXT`、`reason TEXT` | 一致 |
| createdAt/createdBy | `createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP`、`createdBy TEXT NOT NULL` | 一致 |
| `@@unique([nodeId,subjectType,subjectId])` | 唯一索引 `auth_policies_node_subject_key`（:91-92） | 一致，纯 allow 单行假设成立 |
| 索引 `[workspaceId,subjectType,subjectId]`、`[nodeId]` | `auth_policies_workspace_subject_idx`（:93-94）、`auth_policies_node_idx`（:95） | 一致 |
| 回填迁移不触碰本表 | `202609160930000_enterprise_nav_backfill` 中 `auth_policies` 出现 **0 次**（已 grep 确认） | 一致，M3 零写入冻结纪律有迁移证据 |

结论：**M4 对 auth_policies 的全部 schema 假设对得上**，只需加索引（S1 EXPLAIN 后定）不需改结构。

### 3.3 鉴权热路径与 M4 enforce 挂载点候选

中间件真实顺序（`app.ts` createMount）：

```
mount:
  1. CORS（:80-92）
  2. secureHeaders   mount.use("*", ...)   app.ts:95
  3. bodyLimit       mount.use("*", ...)   app.ts:96
  4. rateLimit       mount.use("*", ...)   app.ts:98   （匹配 path.startsWith("/api/")，rateLimit.ts:64；
                                                         /api/v1 同样以 /api/ 开头 → 自动被兜底档覆盖）
  5. /healthz /readyz（:101-102，不鉴权）
  6. /api 旧实例（:128-141）
  7. /api/v1（:146-149，条件：enterpriseOrg || enterpriseNav）
       v1 内部：v1.use("*", requireActiveUser)（routes/v1/index.ts:21）
                 → 子路由按 flag 条件挂载（org :25、workspaces :42）
  8. SPA 静态（:153-155，最后）
```

- 热路径核心：`resolveActiveAuth`（`authState.ts:55-96`）= Bearer 解析 :56-58 → verify :62-70 → 可选缓存 :72-78 → users PK 点查 :80-86。默认 TTL=0（config.authStateTtlMs，:180/:230）。
- `requireActiveUser`（`authActive.ts:19-24`）与旧 `getUserId` 共享 `resolveActiveAuth`，M4 shadow/enforce 的"DISABLED 进不了守卫"对拍断言挂在适配层即可，鉴权层不需要 M4 改动。
- **M4 enforce 挂载点结论**：不新增全局中间件；挂载点 = 适配层（guards.ts 五函数 + kb.ts 两函数体）内部，位于 `requireUserId/requireCanView` 已取得 userId 之后。这与计划 §3-1"只换函数体、调用方零改"一致。

### 3.4 旧三表投影回填的真实读模型（以 schema.prisma 真实名为准）

| 表（Prisma 模型 / 物理表） | schema 行 | 唯一键 | 角色档 | 回填目标节点（计划 §5.2） |
|---|---|---|---|---|
| `Member` / `members` | :220-233 | `@@unique([baseId,userId])` :230 | owner/creator/editor/commenter/viewer（:224） | base 节点 `nodeId("base", baseId)` 一行 |
| `KbMember` / `kb_members` | :282-295 | `@@unique([kbId,userId])` :292 | owner/editor/commenter/viewer（:286） | kb 节点 `nodeId("kb", kbId)` 一行 |
| `KbDocAcl` / `kb_doc_acls` | :352-364 | `@@unique([docId,userId])` :361 | editor/commenter/viewer（:356） | doc 节点 `nodeId("doc", docId)` 逐行 |

- 节点 id 为**确定性生成**：`domain/nav/backfill.ts:20` `nodeId(kind, resourceId) => 'nav_<kind>_<resourceId>'`，`WS_ID='ws_default'`（:16）。回填 INSERT...SELECT 拼 nodeId 时必须照此函数，不可另造 id 规则。
- 三表均无软删、FK 均 `onDelete: Cascade`（:227-228/289-290/358-359），与计划 §1.2 一致。
- createdBy 兜底列真实行号：bases :24、tables :40、fields :128、knowledge_bases :271、kb_docs :306、records :341（另 role_assignments.createdBy :459 可空）。计划 §1.2 行号全部对得上。
- 活资源/活用户口径：软删过滤以各实体 `deletedAt`；用户行保留含 DISABLED（M2 停用在登录层拦），与计划 §1.2 注一致。

### 3.5 旧守卫决策点（适配层包壳位置）

| 计划引用 | 磁盘真实位置 | 结论 |
|---|---|---|
| `guards.ts:43-49` roleOf / `:51-57` permissionsOf | :43-49 / :51-57 | 行号一致 |
| 矩阵真源 `shared-types/permissions.ts:33-69` | `MATRIX` 定义 :33-67，`permissionsForRole` :69-71 | 基本一致（矩阵结束 :67 非 :69） |
| 五个 requireCan*（:66-95） | requireCanView :66-71、EditData :73-77、ManageSchema :79-83、ManageBase :85-89、Comment :91-95 | 行号一致；文案"只有所有者可管理 Base"在 :87 |
| 资源 id → baseId 三解析器（:22-41） | :22-25 / :27-33 / :35-41 | 行号一致 |
| 错误信封 `guards.ts:97-127` | errorCodeForStatus :98-109、errorResponse :112-127 | 行号一致；**errorResponse 的 c.json 状态类型只列了 400/401/403/404/409（:116），而 HttpError 实际可产生 410/413/429**（如 bases 分享过期抛 410）。M4 新增错误码时建议顺带核实状态类型，不改行为 |
| kb 侧 `kbRoleOf/docAclRoleOf/RANK/requireKb/requireDocAccess`（计划写 kb.ts:22-60） | **行号整体漂移**：kbRoleOf :29-35、docAclRoleOf :37-43、RANK :45、requireKb :54-60、requireDocAccess :63-78 | 见 M3/M4 |
| requireDocAccess "取较高 :54-55、needEdit :57-58" | 取较高在 **:68-69**；`canEdit` 档判 :72；needEdit 拒绝 :73；**返回 `{doc, role, canEdit}`（:78）** | 见 M4 |

### 3.6 五个 fieldMask 出口真实文件:行

| # | 出口 | 磁盘真实落点 | 与计划差异 |
|---|---|---|---|
| 1 | 列表响应体 | records.ts：handler :328；loadTableFields :343；queryRecords :353；body 组装 **:363-371**（records :364、fields=visibleFields :367、allFields :368、groups :369、aggregations :370）；c.json :377 | 计划 :359-373/363/364 整体下移约 4-8 行（M1 接线后漂移） |
| 2 | 详情响应 | handler :601；`:614` `c.json({record: found, fields})`；hydrateRecordById :611 | 计划 :610，实为 :614 |
| 3 | 写 payload 键白名单 | create：handler :390（计划 :386）、payloadFields :404（计划 :400）、applyFieldWrites :433（withWriteTx :427 内）；patch：handler :621、loadTableFields :632、withWriteTx :636、assertUnique :637、applyFieldWrites :638 | 计划 :395/:628/:632-636 均漂移；**现状写键无任何越权校验，M4 键白名单为纯新增插点，应落在 create :399 解析后/withWriteTx 之前、patch :632 之后/:636 之前** |
| 4 | CSV 导出 | `domain/csvExport.ts`：hydrate 直通 :85、累积声明 :96、累积 push :103；入口 `tables.ts:17` import、`:379` 调用 `exportTableCsv`（计划写 tables.ts:17） | 函数内行号一致；入口调用在 tables.ts:379（计划只写了 import :17） |
| 5 | hydrate 依赖 | hydrateRecords :94；primaryTitle **:506-528**（无标题兜底 **:528** `return "(无标题)"`）；link title 拼接 :390-392 | 计划 :499-524/兜底 :529，**实为 :506-528、兜底在 :528** |
| — | 列表内搜索/过滤/排序 | recordService applyViewQuery :68；filters :77-78；可见字段搜索 :84-87；sorts :93-98 | 与计划基本一致（搜索行号吻合） |

### 3.7 旧三表写点（投影双写 10/11 处）真实行号

| # | 写点 | 计划行号 | 磁盘真实行号 | 现有事务形态（M4 双写接入处） |
|---|---|---|---|---|
| 1 | 建库自动 owner 行 | bases.ts:153 | **:158** | 已在 `withWriteTx("base.create")` :150 内，且已有 syncNavFromEntitiesTx :160；直接追加 |
| 2 | 加成员 create | bases.ts:333-345 | **:363-366** | 当前**裸写**（无 withWriteTx）；需按 M3 纪律最小包裹 |
| 3 | 改角色 update | bases.ts:361-371 | **:389-392** | 裸写，需包裹 |
| 4 | 移除成员 delete | bases.ts:378-384 | **:402** | 裸写，需包裹 |
| 5 | 持票加入 create | bases.ts:445-459 | **:477** | 裸写，需包裹 |
| 6 | kb 成员 upsert | kb.ts:254 | **:260-264** | 在 try 内裸写；handler :246 |
| 7 | kb 成员 deleteMany | kb.ts:281 | **:287** | 裸写 |
| 8 | 全库批量升降级（循环/批 update） | kb.ts:575-592（:586） | handler **:593**；`withWriteBatch` :612-620；每成员 `kbMember.update` 在 **:617** | 已用 withWriteBatch；M4 双写进同批或同事务回调 |
| 9 | 清文档 ACL（物理删文档） | kb.ts:634 | **:680**（`tx.kbDocAcl.deleteMany`） | 已在 :678 `withWriteTx("doc.purge")` 内 |
| 10 | 删单人 ACL | kb.ts:766 | **:815** `prisma.kbDocAcl.deleteMany` | 裸写（put /docs/:docId/acl handler :798） |
| 11 | ACL upsert | kb.ts:769 | **:818-821** | 裸写 |

结论：**11 个写点全部存在、语义连续**；其中 4 处已在 M3 事务内（#1/#8/#9 及 nav 接线），其余 7 处为裸写需 M4-S5 按 M3 同纪律包裹。计划 §7-S5 的"11 个实际条目"数量正确，仅行号全部需更新。

### 3.8 给 M5 的契约落点（nav tree 读路径）

- `resolveVisibleNodeIds` / `buildVisibleScopeSql`：**M3 代码中不存在落点**（全仓 grep 仅命中 M4/M5/M6 计划文档）。二者属 **M4-S4 自身交付物**（落 `domain/authz/scope.ts`），M3 无对应物，符合排期，不作为漂移。
- M4-S7 tree/menu 剪枝的真实挂载点（待 M3-S5 落地后复核）：
  - `domain/nav/workspace-read.ts:105` `readNavTree` → 内部分支 `readAll` :56、`readRootChunk` :65、`readSubtree` :77；DTO 转换 `toDto` :32。剪枝作为 on 态后置过滤，最自然的插点在三个 read 分支产出节点数组之后、DTO 装配处。
  - `domain/nav/menu-read.ts:82` `readMenuTree`；菜单 shortcut 剔除插点同口径。
  - 以上两文件为 M3-S5 在途新增，**行号与形态待 S5 提交、S6 写 API 落地后复核**。
- move-impact：M3 计划落 `POST /api/v1/nodes/:id/move(-impact)`（routes/v1/nodes.ts，**S6 尚未建、文件不存在**）；现网旧 move 为 `kb.ts:476`（doc）与 `fields.ts:245`（field），均无 impact。M4-S7 的"升级三源口径"挂载点要等 M3-S6 nodes.ts 出现后定，标注待复核。

---

## 4. 计划与现状不符/锚点漂移清单

> 格式：编号 | 计划位置 | 磁盘真实位置 | 建议的 M4 切片措辞修正。仅建议，不改正文。

### 必须修正（命名/签名漂移，措辞会误导实施）

| # | 计划位置 | 磁盘真实 | 修正建议 |
|---|---|---|---|
| M1 | §1.4"EffectiveRoleRow（authorization.ts:24-32）" | 类型名 `EffectiveRoleDTO`，真源 `packages/shared-types/src/org.ts:129`（source 在 :119） | 改为："M4 role 源消费 `EffectiveRoleDTO`（shared-types/org.ts:129），由 `effectiveRoleRows`（authorization.ts:40）返回" |
| M2 | §4.2/§1.4 `effectiveOrgRoles(userId, workspaceId)` | `roles.ts:11` 别名，签名 `(userId, client?)`，**无 workspaceId** | 伪码与 S1 说明改为单 userId（+可选 tx）；workspace 恒 ws_default 不需入参 |
| M3 | §1.1 kb 侧引用"kb.ts:22-28/30-36/38/40-46/49-60" | kbRoleOf :29-35、docAclRoleOf :37-43、RANK :45、requireKb :54-60、requireDocAccess :63-78 | §1.1 表格 kb 全部行号更新为上述；计划§5-C 引用的行号同步 |
| M4 | §1.1 "requireKb（kb 存在且未删+成员，否则404/403）" | requireKb 真实签名 **`requireKb(userId, kbId): {role}`（:54）**，不是"路由内直接拿 c"；kb 实体查询 :55、成员 :57 | 适配层包壳措辞改为"入参 (userId, kbId)，返回 {role}"；S3 七函数清单中它的包壳位置在函数首行成员解析后 |
| M5 | §1.1 "requireDocAccess 取较高 :54-55，needEdit :57-58" | 取较高 :68-69；canEdit :72；needEdit 拒绝 :73；**返回 `{doc, role, canEdit}`（:78）** | 补齐返回形状三字段；S3 包壳须保持 `{doc, role, canEdit}` 不被 shadow 改形（当前 26 处调用消费 doc/canEdit） |
| M6 | §1.4"authorization.ts:14 OrgActionString（当前三枚）、:16-20 ORG_ACTIONS" 与 §4.10"shared-types/org.ts:10 真源"并存且互相矛盾 | 磁盘已按 §4.10 形态落地：真源 = `shared-types/org.ts:12` `OrgAction` + `:14-18` `ORG_ACTIONS`；authorization.ts:12-17 仅 import 并 re-export；authActive.ts:9 同源 import | 删旧锚点：§1.4 与 §12-8 统一改为"真源 shared-types/org.ts:12/14，api 侧 re-export"；**M4 manage_share 只改 shared-types 单点，authActive 不需改本地联合（其 `OrgAction` 是 import 类型）** |
| M7 | §3-3"sharePolicyAllows 作为引擎外纯函数保留" | **无 `sharePolicyAllows` 函数**；匿名三通道实际核心 = `routes/public.ts:66` `resolveShare(token, docId?, needEdit?)` + `:27` findShareRoot + `:40` subtreeIdSet；三通道注册 :183/:213/:223（第4通道匿名编辑 :260） | 改为"保留 resolveShare/subtreeIdSet 于引擎外"；"匿名请求零 auth_policies 查询"断言针对 public.ts 该三/四个 handler 写 |
| M8 | §7-S5"authActive.ts:11 联合与 :34 allowed 追加 manage_share" | authActive 中无本地联合/allowed 数组：`OrgAction` 来自 import（:9），白名单检查是 `ORG_ACTIONS.includes`（:32），hasOrgAction 调用 :38 | S5 措辞改为"shared-types OrgAction/ORG_ACTIONS 单点追加 manage_share；authActive 经 import 自动收窄，不手改联合" |
| M9 | §4.10-6/§1.4"角色管理端点校验同源常量" | `domain/org/roleAdmin.ts:33` 与 `:20` 仍有**硬编码三枚字面量数组**（未消费 ORG_ACTIONS）；routes/v1/org/roles.ts 端点经 roleAdmin 间接消费 | M2 遗留不同源点 2 处。M4-S5 加 manage_share 时必须把 roleAdmin.ts:20/33 收口为 ORG_ACTIONS，否则白名单 3 处不同源；列入 §4.10 清单第 6 点的 M4 实际触碰 |
| M10 | §1.6/§7-S5"挂在 M3 purgeResourceNodeTx 同事务" | **无 purgeResourceNodeTx**；真实为三个函数：`nav/sync.ts:134 purgeViewNodeTx`、`:147 purgeTableNodeTx`、`:160 purgeDocNodeTx` | S5 挂钩措辞改为三函数分别追加策略清理；doc 物理删路径（kb.ts:678 事务）已调 purgeDocNodeTx，挂钩后自动生效 |
| M11 | §0-4/§10-A4/S6"ISBLANK :598 类探测函数" | **无 ISBLANK 函数**；:598 附近是 `ISNULL`（:597-598，判空）与 `BLANK`（:599-600，返 FNULL） | mask-null 探测断言按 **ISNULL(:598)** 写（mask 注入 null ⇒ ISNULL=true，即不可区分推论）；ADR-0035 同步改名，避免实施时找不到 ISBLANK |
| M12 | §1.6"effectiveRoleRows 定数两查询"（多处引用"两查询"） | 实际 3 查询（q1/q2/q3），文件头 :6-9 明示 | 改为"定数 ≤3 查询"；S1 SQL 计数上界用 3（与计划 §7-S1 的 ≤3 一致，仅文字"两查询"需改） |
| M13 | §1.4/§9 v1 挂载"routes/v1/index.ts:14-34 无条件挂 org、requireActiveUser 全链 :17" | 在途已改：index.ts:21 全链；org 条件挂载 :23-38；workspaces :40-43；app.ts:146 双 flag 条件 | §1.4/§9 更新为双 flag 条件挂载形态（方向与 M4 §9 意图一致），待 M3-S5 提交后按最终行号回填 |

### 建议修正（行号/计数漂移，不影响语义）

| # | 计划位置 | 磁盘真实 | 建议 |
|---|---|---|---|
| A1 | §1.3-1 列表"records.ts:327-374、:339/:349/:359-367" | handler:328、loadTableFields:343、queryRecords:353、body:363-371、json:377 | 更新行号 |
| A2 | §1.3-2 详情":597-611、:610" | :601-615，json :614 | 更新 |
| A3 | §1.3-3 create/patch":386-456/:400、:617-636/:633-634" | create :390/:404/:427-433；patch :621/:632/:636-638 | 更新；标注现状无键白名单、M4 为新增 |
| A4 | §1.3-5 hydrate":499-529 primaryTitle、兜底 :529" | primaryTitle :506-528，兜底 :528 | 更新 |
| A5 | §1.2 bases 写点":153/:333-345/:361-371/:378-384/:445-459" | :158/:363/:389/:402/:477 | 更新（明细见 §3.7） |
| A6 | §1.2 kb 写点":254/:281/:575-592/:634/:737/:766/:769" | :260/:287/:593-620(:617)/:680/列表:786/删:815/upsert:818 | 更新 |
| A7 | §1.1 守卫调用计数"kb 35、bases 14" | 按计划口径（requireCan*/requireKb 等 + requireUserId）：kb **54**、bases **18**；仅 requireKb/requireDocAccess=26、requireCan*/requireRole=13 | 回归面量化数字更新；口径建议在 §1.1 脚注写清 grep 模式，避免再漂移 |
| A8 | §7-S0 baseline"开工重锚 678/3、56 文件、迁移 14" | **866/3、79 文件、迁移 16** | S0 文档按 §2 重锚 |
| A9 | §12-12"当前 14…M3 +2+1=17" | 当前 16（nav 2 个已在，manage_menu 补位未在） | 起点改 16；推演 17→18→19 不变 |
| A10 | §12-9"config 现状无 GX_AUTHZ_ENGINE，config.ts:175-230" | 区间实为 :171-240；enterpriseNav 已插入 :182/:238 | 行号区间更新；M4 三态解析位置避开 enterpriseNav 段 |
| A11 | §12-10"search.ts:58/:122" | members 读 :58、kbMembers 读 :122（行号仍准确）；search 仅一个 `search.get("/")` :47 | 行号保留；补"M3-S5 后旧预览仍只此一路由"边界 |
| A12 | §1.1"permissions.ts:33-69"矩阵 | MATRIX :33-67、permissionsForRole :69 | 区间微调 |

---

## 5. ADR 引用核对（重编号后自洽性）

- M4 候选 ADR **0032-0041 连续 10 条**，与 M3 已用最大编号 ADR-0031 无缝衔接，无重号。
- M4 文档内部引用计数（grep）：0032×6、0033×1、0034×4、0035×3、0036×1、0037×2、0038×1、0039×3、0040×2、0041×2，另引旧 ADR-0005×1、ADR-0031×3。
- 逐条核对正文 §8 定义与正文引用一一对应：
  - ADR-0034 的"证伪判定标准"段在 §0-3、§5.2-2、§8 三处被引用，引用一致；
  - ADR-0035 含 A-4/公式 null，被 §0-4、§10-A4、§8 引用，一致（但其中"ISBLANK"字样需按 M11 改为 ISNULL）；
  - ADR-0041 对应 §4.10 清单（八项），清单表头"M3 manage_menu / M4 manage_share"与 §10 补充裁决一致。
- **结论：M4 计划内部 ADR 引用自洽**，仅需随 M11 修订一处函数名；编号不阻塞开工。
- 现存 ADR 目录止于 0025（docs/adr/），0026-0031 为 M3 候选（M3 出口归档），M4 归档 0032-0041 排在其后，目录序列无冲突。

---

## 6. M4 S0 开工 checklist

### 6.1 前置条件

| # | 条件 | 状态 |
|---|---|---|
| 1 | 只读核对完成、无阻断项 | 已满足（本文） |
| 2 | S0 仅新增测试与基线文档，不碰 M3-S5 在途文件 | 纪律已明确，可立即开工 |
| 3 | S0 基线数字以当前工作区重锚：866/3、79 文件、16 迁移 | 待写进 S0 baseline（替换计划中的 678/56/14） |
| 4 | S0 characterization 走真库真迁移（与 M3-S5 同库形态兼容：nav 读表已在，auth_policies 空表已在） | 已具备，`prisma migrate deploy` 可跑到 16 |
| 5 | 后续 S2+ 派工前置：M3-S5 提交、M3-S6（manage_menu + owner 补位迁移 = 迁移 17）落地，按本文 §4 复核锚点 | 未满足，作为排序门 |

### 6.2 S0 第一切片应触碰文件（全部为新增，零修改）

1. `apps/api/src/domain/authz/__tests__/characterization/legacy-decision-matrix.test.ts`
   - 真库夹具：base 五角色 × 8 操作 200/403 矩阵（调真实 guards：`requireCanView/EditData/ManageSchema/ManageBase/Comment` + `permissionsForRole`）；
   - kb 四角色 × doc ACL 三角色"取较高"组合（复用 `requireDocAccess`，构造 :68-69 两路）；
   - 无成员/无 ACL/软删资源的 403/404 文案与 code；
   - 匿名 public 四 handler（:183/:213/:223/:260）断言零 auth_policies 查询（按 M7 修正后的函数名）。
2. `apps/api/src/domain/authz/__tests__/characterization/legacy-response-shapes.test.ts`
   - 锁列表键集合（records/total/filteredTotal/fields/allFields/groups/aggregations，keyset on 时 +nextCursor/hasMore/degraded）；详情 `{record,fields}`；CSV 表头列序。
3. `docs/baseline/2026-09-14-m4-baseline.md`（建议日期随开工日；文件名日期计划写 2026-09-17，可保留或改开工日）：基线 31df766 + 在途说明、866/3/79 文件/16 迁移、环境版本。

### 6.3 与 M3 读 API 的合流点

- S0 不直接合流（只读 import guards/实体），但 characterization 夹具应**在 GX_ENTERPRISE_NAV 默认 on 的当前形态下**跑一次，确认全量 tree/menu 读对旧决策无副作用。
- S4（scope）与 S7（剪枝）才是真正合流点：
  - S4 消费 M3 `nav_nodes` path 索引（`nav_nodes_path_idx`）与 `auth_policies_workspace_subject_idx`；契约 `resolveVisibleNodeIds/buildVisibleScopeSql` 落 `domain/authz/scope.ts`，M5/M6 凭 §4.7 + openapi 消费。
  - S7 在 `domain/nav/workspace-read.ts:105 readNavTree`、`menu-read.ts:82 readMenuTree` 的产出后挂 on 态剪枝（待 M3-S5/S6 定稿复核）；move-impact 挂载点待 `routes/v1/nodes.ts`（M3-S6）出现后定。
- 同文件冲突纪律（重申 §6 排期硬约束 2）：M4 对 M3 文件的触碰仅限 ① S5 在三个 purge*NodeTx 内挂钩；② S7 在 readNavTree/readMenuTree 挂剪枝。两处均在 M3 全片收口后以独立增量提交，PR 单列触碰清单。

---

## 7. 待复核登记（M3 在途，收口后回填）

| 标记 | 复核内容 | 触发时点 |
|---|---|---|
| R1 | `routes/v1/index.ts` / `app.ts` 双 flag 挂载最终行号与条件 | M3-S5 提交后 |
| R2 | `workspace-read.ts` readNavTree 三分支与 toDto 行号（S7 剪枝插点） | M3-S5 提交后 |
| R3 | `menu-read.ts` readMenuTree 行号（S7 shortcut 剔除插点） | M3-S5 提交后 |
| R4 | `routes/v1/nodes.ts` move/move-impact 形态（S7 impact 升级插点） | M3-S6 落地后 |
| R5 | manage_menu owner 幂等补位迁移时间戳与全串 WHERE（迁移 17；M4 manage_share 补位列 18/19 照此模式） | M3-S6 落地后 |
| R6 | M4 baseline 在 M3 全片收口后的最终重锚（文件数/测试数/迁移数） | M4-S0 文档定稿时 |
