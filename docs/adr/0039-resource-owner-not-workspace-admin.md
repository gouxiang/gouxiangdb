# ADR-0039：资源 owner 不等于工作区管理员（两类 owner 兜底并集）

**状态（Status）**：Accepted（裁决 A-2 2026-09-18 定稿；2026-09-16 M4 出口归档）
**作者**：后端 贝洛奇
**上游依据**：M4-implementation-plan.md §0-9 裁决 A-2、§5.2-5、§8（ADR-0039）；ADR-0024 组织角色/资源角色分层
**关联**：ADR-0024（M2/M4 词汇线隔离的前置决策）；ADR-0032（两类 fallback 在判定序中的位置）；ADR-0041（manage_share 双重身份）

---

## 1. 背景（Context）

旧 base 的 owner 角色既是资源最高权限（分享、schema、数据），又隐含"这个
工作区管理员"的常识误读。ARCH 早期草案（:602 附近）提出：资源 owner 成员
额外写入 workspace_admin（即抬升为工作区 role_owner）。该草案若实施，
创建一个 base 就批量制造工作区管理员，通讯录/角色/菜单管理面失控，且与
M2 自举的单一工作区 role_owner 体系冲突——资源所有权是高频、可按资源
分散授予的，工作区管理是低频、应集中收敛的权力，二者必须物理隔离。

## 2. 决策（Decision）

### 2.1 兜底口径 = workspace role_owner 并集 实体 createdBy

引擎判定序（ADR-0032）前两级即两类 owner：

1. **实体 createdBy（资源 creator/owner）**：makeCreatedByResolver 按
   nav 节点 resourceType 点查对应实体表 createdBy 列（base/kb/doc/canvas/
   table 四类，group/view 无 createdBy 语义返回 null），命中则全动作
   allow，source 标 `owner_fallback/creator`。creator 兜底**不沿导航树
   继承**——用户创建的 base 其下 table 不因"父资源是他建的"而放行，
   table 有自己的 createdBy（scope-parity u_cr 用例锁定）。
2. **workspace role_owner**：resolveSubject 以是否持组织角色 role_owner
   标记 isWorkspaceOwner，命中则对**全工作区所有节点**全动作 allow，
   source 标 `owner_fallback/workspace_owner`。

两者是并集关系，任命中即兜底放行；都不命中才进入三源策略过滤。

### 2.2 资源 owner 的权力边界

- 资源 owner（映射串含 r,c,u,d,comment + manage_share + base owner 另有
  manage_schema；kb owner 含 manage_share 不含 manage_schema）只对**本
  资源**及其继承范围内的后代有效；manage_share 是挂在资源节点策略行上的
  **资源动作**，管的是本资源的策略/分享。
- **不批量抬升**：回填迁移与双写绝不向 role_assignments 写任何行
  （backfill-literals "绝不写 role_assignments" 用真实 DML 文本断言锁死，
  避开注释文字）；资源创建时不授 role_owner，资源 owner 被移除成员身份后
  仅保留 createdBy 兜底（实体未删前不被锁外——这是有意设计，防止
  "唯一 owner 被踢后无人能管资源"，与旧成员体系 owner 语义连续）。

### 2.3 工作区管理面归属

通讯录、部门、组织角色、菜单编排等管理面只归 M2 自举的 role_owner
（经 requireOrgAction + ORG_ACTIONS 校验）。资源 owner 在这些端点上是
普通用户：无 manage_members/manage_roles/manage_menu 即 403，哪怕他是
十个 base 的 owner。

### 2.4 与第五组织动作的衔接

M4-S5 新增的 manage_share 组织动作（ADR-0041）让工作区 role_owner 天然
持"管任意节点策略"的组织权限；资源 owner 持资源动作串里的 manage_share
管本资源。同名两枚，存储与校验路径完全不同（roles.permissions JSON vs
auth_policies.actions 逗号串），互不自动授予：给自定义角色勾上组织
manage_share 不给他任何具体资源行；资源 owner 不因此进 role_owner。

## 3. 被否决的备选

1. **资源 owner 自动授 role_owner（ARCH :602 草案）**：批量制造管理员、
   最小权限崩坏、移除资源所有权还要回收组织角色，生命周期纠缠。否决。
2. **取消 createdBy 兜底，一切走显式策略**：建库自动建 owner 成员行之外
   的实体（doc/table 等）在授权投影缺失瞬间会把创建人锁外；兜底保证
   "谁创建谁能管"的连续直觉，也是 cutoff restricted 后创建人不被自己
   关在门外的豁免来源（AC-M4-2 exempt=creator）。
3. **creator 兜底沿祖树继承**：会让 base 创建人自动拥有库内全部 table/
   doc，超出资源所有权语义；scope-parity u_cr 锁定"仅自己创建的 base，
   他人创建的 table 不可见"。

## 4. 后果（Consequences）

- 两条词汇线（组织/资源）从 M2 到 M4 保持物理分层，ADR-0024 的承诺在
  引擎判定序中有了强制位置。
- 工作区 role_owner 是全工作区可见性的唯一"超级主体"，scope 对其跳过
  creator UNION（3 条 SQL），其余主体 4 条。
- createdBy 列是安全相关数据：实体写点不得允许普通用户篡改 createdBy
  （沿用现网服务端赋值纪律，M4 未新增篡改面）。
- 资源 owner 与组织管理员的身份可能重合（自举 owner 创建资源）但必须
  分别授予、分别回收。

## 5. 验证证据

- 判定序：evaluate.ts:98-99（creator 先于 workspace_owner，两者均先于
  策略行）；adapter.ts makeCreatedByResolver（四实体点查 + 会话缓存，
  group/view 返回 null）；subjects.ts:46 isWorkspaceOwner。
- 不抬升：backfill-literals.test.ts "绝不写 role_assignments"；
  迁移 20260916110000 SQL 文本。
- 不继承：scope-parity u_cr/u_own 用例（creator 仅自建 base；owner
  visibleTotal=9 全可见）；decision-matrix #11（restricted 叶子三类
  主体对比）。
- impact 豁免：s7Harness/s7-inheritance（creator 与 workspace_owner
  入 exempt）；inheritance.ts:151-161。
- 落地 commit：aa8c28c（S2 回填）、d1d7ac6（S1 引擎）、6047991（S4）。
