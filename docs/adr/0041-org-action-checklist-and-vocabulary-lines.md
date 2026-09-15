# ADR-0041：组织动作扩充的跨里程碑单一检查清单与词汇线隔离

**状态（Status）**：Accepted（项目总监补充裁决，M3 manage_menu 首用、M4 manage_share 复用；2026-09-16 M4 出口归档）
**作者**：后端 贝洛奇
**上游依据**：M4-implementation-plan.md §0-9、§4.10（八项清单两次复用）、§1.4（白名单真源写死结论）；M3-S6（15ac5fe）；M4-S5（2663cc0）
**关联**：ADR-0024（组织角色 vs 资源角色分层）；ADR-0039（资源 owner 不抬升 role_owner）；ADR-0032（资源动作串词汇）

---

## 1. 背景（Context）

企业版动作词汇分两条线增长：组织管理动作（M2 三枚、M3 加 manage_menu、
M4 加 manage_share，存 roles.permissions JSON）与资源动作（M4 七枚，
存 auth_policies.actions 逗号串）。两次组织动作只增上线（M3-S6、M4-S5）
若只改调用点，极易漏掉种子/owner 补位/错误文案/穷举测试中的硬编码枚举，
造成"端点认、角色编辑器不认""owner 实际没有"之类的半接线状态。总监裁决：
两次只增改动必须过**同一份八项清单**，派工与验收照抄。

## 2. 决策（Decision）

### 2.1 八项单一检查清单（M3 首用结果 / M4 复用结果）

| # | 检查点 | 准则 | M4 manage_share 落地证据 |
|---|---|---|---|
| 1 | 系统角色种子 SQL | M2 DDL 迁移 20260915090000 的固定 JSON 串是历史锚点，不改种子文件；owner 补位只由只增迁移承担 | 未改 M2 种子；M3 补位迁移 20260916100000 未动 |
| 2 | owner 幂等补位只增迁移 | 全串匹配 WHERE（旧全串逐字同序无空格才 UPDATE），连跑恒等，自定义角色不触碰；down SQL 存 prisma/docs/rollback | 迁移 20260916130000_owner_manage_share（四枚全串 -> 五枚全串） |
| 3 | 域白名单真源 | 唯一真源 = packages/shared-types/src/org.ts 的 OrgAction 联合 + ORG_ACTIONS 常量；api 侧 authorization.ts 仅 import/re-export，禁止本地枚举/本地联合 | org.ts:12-25 五枚；api 侧无本地动作数组 |
| 4 | shared-types 联合 | 只增一枚 + rebuild；api/web typecheck 双过；web 动作标签映射同步补位（typecheck 兜底） | 2663cc0 单点 +1+1 |
| 5 | 中间件 | authActive.ts 不动：requireOrgAction 的白名单走 ORG_ACTIONS.includes，新动作经真源自动收窄 | 零 diff（import 类型自动收窄） |
| 6 | 角色管理端点校验 | roleAdmin 全部硬编码动作文案收口为 ORG_ACTIONS 派生（M3 遗留的 :21 四枚字面量在 M4-S5 必收） | roleAdmin.ts:21 现为 `仅允许 ${ORG_ACTIONS.join("/")}`；toRoleDTO 过滤同源 |
| 7 | 穷举测试 | N 动作 x requireOrgAction 不抛未知动作；非法动作 400 文案含全部 N 枚且随常量自动更新；非 owner 系统角色持新动作端点 403 | org 白名单穷举测试随 S5 扩为五枚 |
| 8 | 回滚姿态 | 动作位多一枚无数据副作用；发布前快照为主回滚路径，down SQL 备援 | 迁移 down 文件 + env/快照回滚 |

### 2.2 词汇线隔离：manage_share 的双重身份

manage_share 是唯一横跨两线的名字，必须按下表物理隔离，禁止用同一个集合
做两种校验：

| 维度 | 组织空间 manage_share | 资源空间 manage_share |
|---|---|---|
| 含义 | 授权策略/分享**管理面**权限（工作区角色可授） | 资源节点策略行动作串成员（资源 owner/creator 行持有） |
| 真源 | shared-types/org.ts ORG_ACTIONS（5 枚组织动作） | shared-types/authz.ts RESOURCE_ACTIONS（7 枚资源动作） |
| 存储 | roles.permissions JSON | auth_policies.actions 逗号串 |
| 校验 | requireOrgAction + hasOrgAction（M2 设施） | 引擎 actions.includes + 白名单 POLICY_ACTION_INVALID |
| 迁移 | role_owner 幂等补位（20260916130000） | 旧角色映射串内含（base/kb owner 档，回填迁移） |
| 授予效果 | 可访问任意节点策略管理端点（组织能力） | 仅本资源（及继承后代）的分享管理 |

两条线互不自动授予：组织 manage_share 不产生任何资源行；资源 owner 不因此
成为 role_owner（ADR-0039）。manage_menu 只在组织线存在，资源动作集无此枚；
manage_schema 只在资源线（table/base 节点合法，actionLegalForNode 限 kind）。

### 2.3 复用义务（M6+）

未来新增任何组织动作（如审计/配额管理位）必须原样复用本八项清单；新增
资源动作须同步评估：RESOURCE_ACTIONS 单点、旧角色映射是否含该枚、
reconcile 规范串集合（knownActionStrings）、openapi 枚举、穷举测试。
禁止在 api 侧新立任何动作常量文件。

## 3. 被否决的备选

1. **每处需要的地方各写一份动作数组**：M9 漂移源——加动作必然漏点；
   r3 盘点已发现 roleAdmin 文案硬编码一处遗留，证明集中真源的必要性。
2. **组织/资源动作合并为一个大枚举**：两存储位置（permissions JSON vs
   actions 串）与两套守卫不可能合并，合并只会让同名两枚失去区分，
   manage_share 的双重身份正好说明必须隔离而非合并。
3. **owner 补位用不带 WHERE 旧串的 UPDATE**：重复执行/自定义角色可能被
   误改；定稿全串匹配幂等 UPDATE。

## 4. 后果（Consequences）

- 新增组织动作的改动面可预测：shared-types 单点 + 一条 owner 迁移 +
  穷举测试扩枚 + web 标签补位；authActive/authorization 零改动。
- 两条词汇线的同名动作需要所有文档（含本 ADR 与 openapi 描述）显式标注
  命名空间，排查 403 时先问"是组织面还是资源面"。
- 迁移总数因 owner 补位到 20（M3 第 17、M4 第 20）；后续每枚组织动作
  默认伴随一条只增迁移，直到 owner 角色模型重做。

## 5. 验证证据

- 真源：packages/shared-types/src/org.ts:11-25（OrgAction/ORG_ACTIONS
  五枚）、authz.ts:11-29（RESOURCE_ACTIONS 七枚）。
- 收口：domain/org/roleAdmin.ts:21（ORG_ACTIONS.join 派生文案）、
  middleware/authActive.ts（ORG_ACTIONS.includes）。
- 迁移：20260916130000_owner_manage_share（迁移数 19->20）；
  2663cc0（S5 第五动作位）。
- 穷举与端点：org 角色白名单测试、s10-ac-authz-matrix（非 owner 持组织
  manage_share 与资源 manage_share 的 403/200 矩阵）。
- M3 首用：15ac5fe（manage_menu，第四枚，迁移 20260916100000）。
