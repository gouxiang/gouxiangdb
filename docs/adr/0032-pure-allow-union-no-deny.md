# ADR-0032：纯 allow 三源并集、无 deny 的收权模型

**状态（Status）**：Accepted（项目总监裁决 A-7 体系随 M4 计划 r2 终审通过，2026-09-18；2026-09-16 M4 出口归档）
**作者**：后端 贝洛奇
**上游依据**：`docs/planning/phase2/M4-implementation-plan.md` §0-1（纯 allow 判定序）、§2.1-1、§8（ADR-0032 候选）；ARCH-enterprise §5.1-5.2；SPEC-enterprise-v1.0 §5
**关联**：ADR-0024（组织角色与资源角色物理分层）；ADR-0033（旧三表回填为 allow 投影）；ADR-0035（fieldMask 是 allow 之上的收窄，不是 deny）；ADR-0036（cutoff 收集边界）

---

## 1. 背景（Context）

M4 权限引擎要把三套互不一致的旧授权（base 的 members 五档、kb 的 kb_members
四档、doc 的 kb_doc_acls 三档）与两类新授予主体（部门 dept、组织角色 role）统一进
一张 `auth_policies` 表。设计阶段有两个根本分歧：

1. 是否需要 deny（显式拒绝）能力——例如"允许部门 D 但排除用户 U"；
2. 多来源冲突时按什么规则合并——优先级数值、后写覆盖，还是集合运算。

旧系统的工程事实给了强约束：五档/四档/三档角色的动作集是严格**包含关系**
（viewer 持 `r`，commenter 持 `r,comment`，editor 持 crud+comment，向上单调增宽），
`requireDocAccess` 对 kb 成员角色与 doc ACL 角色"取较高"（routes/kb/shared.ts
RANK 比较）本质是取动作超集，不存在"某来源明确禁止"的语义。引擎若引入 deny，
旧三表回填时无法决定哪些行该翻译成 deny，回填等价（升级 0 漂移）在数学上不成立。

## 2. 决策（Decision）

### 2.1 判定序（唯一内核，decide 与 scope 共用）

判定逻辑只允许存在于 `evaluateChainDecision`（domain/authz/evaluate.ts:96）一个
纯函数中，单节点 decide 与批量 scope 都调用它，禁止第二份判定。顺序固定：

1. **实体 createdBy 兜底**：主体是目标节点资源的创建人，全动作 allow
   （source 标记 `owner_fallback` / `creator`）；
2. **workspace owner 兜底**：主体持组织角色 `role_owner`，全动作 allow
   （`owner_fallback` / `workspace_owner`）；
3. **三源 allow 并集**：cutoff 链（ADR-0036）内收集到的策略行中，
   `actions` 含请求动作、且字段维通过（ADR-0035）的行全部成为 allow 来源，
   任一命中即放行，来源全部列入 sources（O8 来源链可解释）；
4. **无 allow 即拒**：没有任何命中行时 `{allowed:false, reason:"no_matching_allow"}`。

三源指策略行的 `subjectType`：`user`（direct 直授）、`dept`（部门授予，按用户
活部门物化路径祖先闭包匹配）、`role`（角色授予，复用 M2 effectiveRoleRows：
user 直授角色加部门祖先继承的角色）。主体展开定数查询，见 subjects.ts。

### 2.2 收权 = 移除来源，不存在"加一条 deny"

要收回某人的访问，唯一手段是删除/收窄其全部 allow 来源（移除成员、删 ACL、
撤角色授予、删直授策略、或由 cutoff 阻断祖先授予）。`auth_policies` 表没有
deny 列、没有 effect 列：唯一索引 `[nodeId,subjectType,subjectId]` 保证同节点
同主体只有一行，调权 = upsert 改 `actions`，天然不存在 allow/deny 两行打架。

### 2.3 与 requireDocAccess"取较高"的连续性

旧 `requireDocAccess` 在 kb 成员角色与 doc ACL 角色间取 RANK 较高者。其动作集
是包含关系，取较高 = 取动作超集；新模型下两源各自投影为策略行（kb_members 投到
kb 节点经祖树继承，kb_doc_acls 投到 doc 节点直挂），纯 allow 并集恰好等于动作
超集。20 主体 x 20 节点 400 格升级对拍（s10-ac-upgrade-20x20）逐格锁定该连续性。

### 2.4 已知限制登记（裁决 A-7）：conditions 行谓词顺延 P1

SPEC 设想过行级（记录级）分组条件策略。M4 定稿**不实现行权限**，处置：

- `auth_policies.conditions` 列在 M3 nav DDL 中已建，**保留列不删**；
- v1 写策略端点的请求 schema **不声明 conditions 键**（openapi.yaml 明示），
  解析器不读取该键：客户端即便传入也不落库（M4 实际行为是静默忽略该键，不是
  400 拒绝——这里如实记录，不夸大为已拦截）；
- 错误码 `POLICY_CONDITION_UNSUPPORTED` 仅在 openapi 登记为 **P1 启用行权限时
  的预留口径**（届时非 null conditions 写入返回 400 本码），M4 代码未抛出；
- 引擎判定内核不留行上下文参数，M4 不做任何行级求值；
- reconcile C5 类（C5_CONDITIONS_PRESENT）巡检物理上非空的 conditions 行，
  出现即报，防止旁路写入造成"M4 不支持但数据已存在"的灰色状态；
- inheritance impact / move-impact 的失访人数只按节点级三源计算，不含行谓词。

## 3. 被否决的备选

1. **deny 列 / effect(allow|deny) 列**：旧三表无任何 deny 语义，回填无法翻译，
   升级 0 漂移不成立；deny 还会引出"deny 是否跨继承优先""群组 deny 与个人
   allow 谁赢"等无穷规则面。否决。
2. **后写覆盖（last write wins）**：并发下调权结果依赖写入顺序，且无法同时
   表达"部门给 r、个人再给 u"的叠加；与旧档包含关系语义冲突。否决。
3. **优先级数值（每条策略带 priority）**：把组织管理决策转嫁给每条数据的填值
   质量，普通用户无法理解，shadow 对拍也没有可对齐的旧语义。否决。
4. **收权用"拒绝行"表达**：同 1，且导致唯一键失效（一节点一主体可能多行）。

## 4. 后果（Consequences）

正面：

- 判定内核是一个无 IO、无优先级排序的纯过滤函数，decide 与 scope 结构性同路径，
  12000 次布尔对拍 0 差异（见验证证据）。
- 收权语义可解释：effective 端点列出的 sources 就是全部权限来源，删尽即拒，
  不存在隐藏的 deny。
- 回填升级保持逐格等价：纯 allow 超集恰好复刻旧角色档包含关系。

代价/边界：

- "允许部门 D 但排除其中用户 U"需改用"不授 D、改授 D 内其余人或子部门"的
  正向表达，或收窄后用直授补回；P1 若确有强需求再单开 ADR 评审行级条件，
  不得在本表临时加 effect 列。
- conditions 列在 M4 期间恒为 null；任何需要行级隔离的需求必须等 P1，
  不得在应用层私塞 conditions JSON 后指望引擎生效。

## 5. 验证证据

- 判定内核：`domain/authz/evaluate.ts:96` evaluateChainDecision（creator/owner
  兜底见 :98-99，三源过滤 :101-104，无 allow 即拒 :106-108）。
- 纯函数决策矩阵：`__tests__/decision-matrix.test.ts`（#1 无关系默认拒、
  #7/#8 部门祖先与多部门并集、#9 role+direct 同列两来源、#10 restricted
  移除直授即恢复、#11 两类兜底）。
- 升级等价：`__tests__/s10-ac-upgrade-20x20.test.ts`（400 格全等）。
- decide/scope 零分叉：`__tests__/scope-parity.test.ts`、规模门
  `__tests__/s10-scale-gate.test.ts`（12000 对拍 0 差异）。
- A-7 现状锚点：openapi.yaml conditions 说明段、reconcile.ts C5_CONDITIONS_PRESENT、
  engine.ts:79 留口注释。
- 落地 commit：d1d7ac6（S1 纯函数层）、6047991（S4 scope 同内核）、
  63f7020（S10 AC 对拍）。
