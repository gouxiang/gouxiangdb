# ADR-0024：组织角色与资源角色物理分层（同名两套角色，M2 不打通判定）

**状态（Status）**：Accepted（M2 落地，S5 契约冻结 / S0 特征锁定，2026-09-14）
**作者**：后端（mvp-dev-expert-team-backend）
**上游依据**：`docs/_archive/originals/planning-phase2-M2-implementation-plan.md` §5-C（角色与求值）、§5-A（M4 衔接）；`docs/_archive/originals/planning-phase2-M4-implementation-plan.md` §1（auth_policies 主体三源）
**关联**：ADR-0023（部门树祖先展开）；旧资源 RBAC 真源 `packages/shared-types/src/permissions.ts`、`apps/api/src/guards.ts`

---

## 1. 背景（Context）

GouXiangDB 里长期存在一套「资源角色」：owner/creator/editor/commenter/viewer，作用于
**单个 Base / 知识库**，决定用户能否看数据、改数据、管表结构、管 Base、评论。M2 又引入一套
「组织角色」，作用于**整个工作区的通讯录管理面**（管部门、管成员、管角色）。两套角色都叫
「角色」、都有 owner/viewer 等同名项，但作用域、数据载体、判定时机完全不同。

关键红线（M2 计划 §3.1，由 S0 特征测试锁定）：组织层接入前后，用户对 Base 的资源权限
`requireCanView/EditData/ManageSchema/ManageBase/Comment` 结果必须逐值不变。组织角色
绝不能在 M2 意外影响资源鉴权。

## 2. 决策（Decision）：物理分层，M2 只建组织层，不接资源判定

两套角色从表到判定完全分离：

| 维度 | 资源角色（既有，M0/M1 已存在） | 组织角色（M2 新增） |
|---|---|---|
| 作用域 | 单个 Base / 知识库（实例级） | 工作区（M2 单工作区 ws_default） |
| 真源表 | `members.role`、`kb_members`、`kb_doc_acls`（旧三表） | `roles` + `role_assignments`（user/dept 主体） |
| 角色集 | owner/creator/editor/commenter/viewer | 五枚同名系统角色（owner/creator/editor/commenter/viewer，仅 owner 持三动作）+ 自定义角色 |
| 权限真源 | `permissionsForRole()` 返回布尔矩阵（shared-types 单一真源） | `roles.permissions` JSON，**仅**三枚组织动作 |
| 动作词汇 | r/c/u/d、comment、manage_schema/manage_share 等（M4 落 auth_policies） | manage_departments / manage_members / manage_roles |
| 判定入口 | `guards.ts` 的 `roleOf/requireCan*`，读 members.role | `requireOrgAction -> hasOrgAction -> effectiveRoleRows` |
| 求值 | 按 baseId 查一行成员关系 | 直接授予 ∪ 部门祖先闭包上的部门授予（ADR-0023） |

要点：
- **M2 的 `roles` 表只承载三枚组织管理动作**。`parseActionsStrict` 对动作白名单之外的串
  （如 `manage_menu`、`manage_share`、`drop_table`）一律 400；契约冻结期不提前加动作。
  `manage_menu` 属 M3、`manage_share` 属 M4，均不进 M2。
- **资源判定不读组织表**：`guards.ts` 不 import 任何 `domain/org` 模块；组织角色授予多少都
  不改变一个人对某 Base 的 `requireCan*` 结果。依赖方向单向：`domain/org` 不被 `guards` 引用。
- 组织系统角色的 owner 只代表「工作区所有者」（通讯录最高权限：三枚 manage_* 全持），
  与「某 Base 的 owner」是两回事；同一个字符串 `owner` 在两层各自解释，互不授予对方权限。
- 停用/邀请状态（AC-M2-1）在资源判定之前由共享鉴权核心统一拦截：非 ACTIVE 用户
  `getUserId` 返回 null，旧 `/api` 资源端点与新 `/api/v1` 管理端点都先 401，不进入各自的
  角色判定。

### 2.1 求值形态（定数查询，无 N+1）

`effectiveRoleRows(userId)` 为常量次往返（详见 ADR-0023 的物化路径）：
1. 一次取用户全部活部门归属（含 path）；应用层按 `/` 切出祖先闭包；
2. 一次 `IN` 取祖先部门名；
3. 一条 `OR`（user 直接授予 + dept 祖先集合授予）取全部授予并 include role，按 role 合并
   来源（user 直授 / dept 授带部门名），软删角色与软删部门不展开。
反向 `usersWithRole(roleId)` 用于最后 owner 保护：直接用户 + 授给部门后按 path 子树展开的
全部 ACTIVE 成员；INVITED/DISABLED 不计在岗。S8 在 6 层 ×10 兼岗夹具上实测求值 <=3 次、
成员列表恒定 4 次，与部门层数/兼岗数/成员总数无关。

### 2.2 与 M4 统一权限引擎的衔接点（M2 只留口，不实现）

M4 将建 `auth_policies`，其主体侧三源之一明确为
`auth_policies(subjectType='role')`，命中值即 **M2 的 `effectiveOrgRoles` 输出**
（user 直授 + 部门祖先展开）。即：M2 的组织角色求值结果是 M4 策略引擎的一个主体输入，
届时「组织角色」才能经由策略行作用到导航节点/资源；M2 阶段不存在这条线。M4 还负责把旧三表
回填为 auth_policies allow 行并双写投影，M2 不改旧三表语义。

## 3. 后果（Consequences）

正面：
- 两层互不污染：组织上线对资源 RBAC 零行为变化，由 S0 五角色矩阵特征测试在每个里程碑复跑兜底。
- 组织角色建模独立、动作集合小而封闭，契约冻结后前端可并行（S7）。
- 为 M4 预留的衔接是「求值结果作为主体源」，不需要 M2 提前耦合策略表。

代价/边界：
- 同名「owner/viewer」需要文档与 UI 明确区分作用域，避免运营误解（组织所有者不等于资源所有者）。
- M2 自定义角色只能勾选三枚管理动作，不能表达「某部门可编辑某 Base」这类资源授权——
  这是刻意的边界，属 M4，不在 M2 用组织角色硬凑。
- scope 在 M2 恒为 workspace；任何 nodeId/scopeType!=workspace 的授予请求一律 400，
  节点作用域留待 M3+。

## 4. 验证证据

- `domain/org/__tests__/characterization/resource-rbac-current.test.ts`（19 例）：锁定
  permissionsForRole 五角色布尔矩阵与真库 requireCan* 结果；M2 各切片及 S8 复跑逐值绿，
  证明组织层未改变资源判定。
- `roles-eval.test.ts`：系统角色常量与迁移种子对拍；并集/去重/来源、软删不展开、
  usersWithRole 子树展开与 ACTIVE 过滤、查询计数常量。
- `roles-admin.test.ts` / `ac-m2-1.adversarial.test.ts`：动作白名单三枚之外 400；
  部门授予经祖先命中、调岗即时变化；最后 owner（含部门继承展开）保护。
- 代码锚点：`packages/shared-types/src/permissions.ts`（资源矩阵单一真源）、
  `apps/api/src/guards.ts`（资源判定，不依赖 org）、`domain/org/{roles,roleAdmin,authorization}.ts`
  （组织角色与求值）、`middleware/authActive.ts`（requireOrgAction）。
