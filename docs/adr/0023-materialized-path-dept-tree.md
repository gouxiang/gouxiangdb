# ADR-0023：组织部门树采用物化路径（Materialized Path），移动时事务内重写子树

**状态（Status）**：Accepted（M2 落地，S3 实现 / S8 对抗验证，2026-09-14）
**作者**：后端（mvp-dev-expert-team-backend）
**上游依据**：`docs/_archive/originals/planning-phase2-M2-implementation-plan.md` §5-B（部门树）、§7-S3/S8
**关联**：ADR-0002（SQLite 选型）；有效角色求值的祖先展开见 ADR-0024；PostgreSQL 平移通道见 ADR-0008

---

## 1. 背景（Context）

企业通讯录需要一棵可改名、可移动、可软删的组织部门树，并支撑两类高频查询：
1. **子树查询**：列出某部门及其全部下级（成员列表按部门过滤时含子部门）；
2. **祖先闭包**：求「一个用户所在部门的全部上级部门」，用于组织角色的祖先继承
   （角色授给某部门 = 其子树成员经祖先链获得，见 ADR-0024）。

M2 规模：单工作区、部门树深度与宽度都很小（500 用户量级），但要求移动子树后路径
即时一致、且求值查询不能随深度/兼岗数产生 N+1。底层是 SQLite，不带递归 CTE 的写法也要
可平移到 PostgreSQL（ADR-0008 的方言纪律）。

## 2. 候选方案

- **a) 邻接表（仅 parentId）+ 递归 CTE**：写简单，但递归 CTE 在每次子树/祖先查询时求值，
  SQLite 老版本与查询计划行为不一致，且移动后无法用一次前缀匹配完成子树判定。否决为主结构。
- **b) 闭包表（closure table）**：祖先-后代关系另存一张表，查祖先/子树都很快；但移动子树
  要批量删插闭包行、写放大与一致性维护复杂，对 500 人规模过重。否决。
- **c) 嵌套集（nested set，左右值）**：子树查询是区间，极快；但任何插入/移动都要重排大量
  左右值，写代价高、并发差。否决。
- **d) 邻接表保真相 + 物化路径 `path` 派生列（采用）**：`parentId` 记录直接上级（真相与
  外键约束），冗余 `path` 为 `/{id}/{id}/.../`，子树查询用前缀 `LIKE 'x%'` 命中 path 索引，
  祖先闭包在应用层按 `/` 切段得到，无需递归 SQL。

## 3. 决策（Decision）

`departments` 同时持有 `parentId`（直接父，自引用外键 `ON DELETE RESTRICT`）与
`path`（物化派生）：

- 根部门 `path = /{id}/`；子部门 `path = 父path + id + "/"`。两端都带 `/`，使
  「前缀即祖先」按段边界自然成立：`/a/` 是 `/a/b/` 的前缀，但不会误匹配 `/ab/`。
- 建普通 B-tree 索引 `departments_path_idx ON departments(path)` 与
  `departments_workspace_parent_idx(workspaceId, parentId)`；子树查询
  `path LIKE '<rootPath>%'`（Prisma `startsWith`）走索引，S3 EXPLAIN 留证为
  `SEARCH departments USING INDEX`，无全表 SCAN。
- **祖先闭包在应用层**：把用户所在部门的 path 按 `/` 切段即得全部祖先部门 id（含自身），
  再用一次 `id IN (...)` 批量取名，避免递归 CTE 与逐部门查询（求值细节与查询计数见 ADR-0024）。
- **移动子树**：单个写事务内——校验新父、防环、深度护栏；查出整棵子树，按 path 排序
  （父在子前），逐行参数化 UPDATE 用
  `newPath = newSelfPath + oldPath.slice(oldSelfPath.length)` 重写。回调整体回滚。
- **防环**：若新父部门的 path 以被移动部门自身 path 为前缀（把部门挂到自己的子孙下），
  拒绝（400）；`nextParentId === id`（挂自身下）同样拒绝。
- **深度护栏 `MAX_DEPTH=32`**：移动/新建后若子树深度超过 32 抛错。这是防失控的护栏，
  **不是功能承诺**——正常组织结构远不到 32 层，业务上限以产品为准。
- 软删：`deletedAt` 标记；列表与求值都过滤软删部门。删除非空部门（仍有子部门或成员）
  返回 409 并携带两者计数，不级联硬删。

### 3.1 一人一主部门的方言注记

`dept_members` 要求「一个用户至多一个主部门（isMain=1）」。用**部分唯一索引**
`UNIQUE(userId) WHERE isMain=1` 表达；应用层在设置主部门时先清旧 main 再置新，部分索引
作为库级兜底。SQLite 与 PostgreSQL 都支持 partial index，平移无歧义。角色授予的业务唯一
（含可空 scopeNodeId）则用 `COALESCE(scopeNodeId,'')` 表达式唯一索引承载，二者均为
Prisma schema 无法直接表达、由手写迁移维护的索引（禁止 migrate dev 据其生成变更）。

## 4. 后果（Consequences）

正面：
- 子树与祖先两类查询都退化为「前缀匹配 / 一次 IN」，常量次查询，无递归、无 N+1。
- path 是可读字符串，排查问题时肉眼可判层级；移动重写逻辑确定、可在单事务内回滚。
- 普通 B-tree 索引即可，SQLite/PostgreSQL 行为一致，符合 ADR-0008 平移纪律。

代价/边界：
- path 是冗余派生数据，一致性依赖「所有改 parentId 的写路径都必须在同事务重写子树 path」；
  M2 只有 `updateDepartment` 一个移动入口，已收口，未来新增移动入口必须复用同一事务原语
  （`rewriteSubtreePathsTx`）。
- 深度护栏 32 是技术护栏，不代表产品支持 32 层。
- 单工作区前提：path 在 workspace 内唯一解释；多工作区是后续里程碑的 Out-of-Scope。

## 5. 验证证据

- `domain/org/deptTree.ts` 纯函数（selfPath/isDescendantPath/防环/子树重写/MAX_DEPTH）有
  10 个单测（`deptTree.test.ts`）。
- `routes/v1/org/__tests__/departments.test.ts`：建 6 层链 path 正确；移动后全部后代 path
  重写、旁支不动；挂自身/子孙 400；同父同名 409；非空删除 409 带计数。
- S8 `ac-m2-1.adversarial.test.ts`：API 逐级建 6 层链，物化路径与部门授予祖先继承端到端验证。
- 查询常量化：S8 在 10 部门/10 兼岗夹具上证明有效角色求值 <=3 次往返、成员列表恒定 4 次，
  与层数/人数无关（见 ADR-0024 与 `2026-09-14-m2-gate.md`）。
