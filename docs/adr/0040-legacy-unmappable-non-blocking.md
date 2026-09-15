# ADR-0040：legacyUnmappable 不阻断写入，权威行保留、重开即恢复

**状态（Status）**：Accepted（裁决 A-5 2026-09-18 定稿；2026-09-16 M4 出口归档）
**作者**：后端 贝洛奇
**上游依据**：M4-implementation-plan.md §0 裁决 A-5、§4.6 写路径切换点表（200+标记+开关往返）、§8（ADR-0040）；SPEC :71-73 policies 写端点
**关联**：ADR-0033（双写方向与旧表投影地位）；ADR-0037（off/shadow 期授权不生效但行保留）；ADR-0035（fieldMask 是主要不可映射类之一）

---

## 1. 背景（Context）

面板上线后，用户会经 v1 `PUT /api/v1/nodes/:id/policies` 写入旧三表
**结构上无法承载**的授权：角色/部门授予（旧表只有 per-user 行）、fieldMask
收窄（旧表无字段维）、非标准动作组合（旧角色档是固定动作集）、table/view/
group 节点授权（这些 kind 无逐资源旧表行）。若按"必须双写成功才接受请求"
处理，这些在引擎侧完全合法的授权会拖垮新端点的可用性，甚至倒逼扩旧表
schema——而旧表已定为待退役投影（ADR-0033），给投影加列方向完全错误。

## 2. 决策（Decision）

### 2.1 200 + legacyUnmappable 标记，不阻断、不扩 schema

- 写入仍 200 成功（单事务：策略 upsert/delete + 版本 bump + before/after
  快照），权威 auth_policies 行正常落库，reason=policy:v1。
- 响应携带 `legacyUnmappable: [{subjectType, subjectId, reasons}]` 明细
  （批量 PUT 聚合；为每条 upsert 用 unmappableReason 判因，可映射档
  reverseWriteLegacyTx 同事务反写旧表）。

  可映射严格条件（四条全满足才反写）：subjectType=user + 节点是
  base/kb/doc|canvas 实体 + 无 fieldMask 定义 + 动作串恰等某旧角色档
  映射串。任一不满足即收集原因，旧表不动。
- 不阻断、不扩旧表任何列、不留"假成员行"；legacyUnmappable 是响应中的
  状态标记，**不是错误码**（错误码表无此项）。前端面板据此显示警示。

### 2.2 off/shadow 不生效但行保留——开关往返恢复语义

1. 角色授予经 PUT 落 auth_policies，旧三表零行。
2. GX_AUTHZ_ENGINE=off/shadow（M4 出口总门 false 时 even env=on 物理仍
   shadow）期间，旧七守不读 auth_policies，该授权对旧路径**不生效**——
   这是预期，不是缺陷：引擎尚未接管资源可达性强制。
3. 往返切 off -> shadow -> on(降级 shadow) -> off，auth_policies 里那条
   不可映射授权行**不被删除、不被回灌旧表、动作串不变**
   （s5-toggle-roundtrip 锁定）。
4. 引擎判定与 flag 无关：即使 off 下直接跑 decide 或 GET effective，该
   角色授予仍求值为 allow。因此 enforce 接线 + 翻 on 的独立切片落地后，
   **无需任何数据迁移或补写，存量不可映射授权立即生效**——"重开即恢复"
   的根据就是行始终保留在权威表。

### 2.3 为什么不能反写但必须保留

旧三表承载不了 dept/role 主体、fieldMask 与非标组合；若为了 off 期"生效"
而把这类授权强行翻译（例如把角色授予展开成每个成员的 member 行），则角色
成员变更时展开结果陈旧、且与 M2 组织体系双写，制造新的双权威。定稿：
off 期缺口明确（旧路径本就没有这些新能力），以面板警示 + runbook 告知，
不用数据展开掩盖。

## 3. 被否决的备选

1. **不可映射即 4xx 拒绝**：角色授予与字段掩码是 M4 的核心卖点，拒绝等于
   新端点只能写旧表已有能力，新能力不可用。否决。
2. **扩旧表加 subject_type/field_mask 列**：向待退役投影投资，且旧守卫
   不读这些列，加了也不生效，纯负债。否决。
3. **展开角色授予为 per-user 旧行**：组织变更即陈旧，双权威不可收敛。
   否决。
4. **off 期自动删除不可映射行**：违背"重开即恢复"，且删除用户显式写入
   的授权无任何正当性。否决。

## 4. 后果（Consequences）

- 面板必须区分"写入成功"与"旧路径当前是否生效"：200 且 legacyUnmappable
  非空时给警示文案（M4-FE 已实现同表视图提示）。
- 从 shadow 翻 on 前的资产盘点要包含 policy:v1 行中不可映射授权的规模与
  类型（GET policies 任何模式可读权威表），翻 on 后它们立即变成真实
  权限，安全侧需在影子期确认这些行的来源合规。
- reconcile 不把不可映射行当差异（它们不是 legacy 投影行，不进 A/B 巡检；
  A3 只针对"非 legacy 行动作串恰等于旧档"的疑似手工污染）。

## 5. 验证证据

- 判定与事务：policyAdmin.ts unmappableReason:91（四类原因文案）、
  policyAdminTx.ts:162-170（聚合明细，200 不阻断）、:63-110
  reverseWriteLegacyTx（仅可映射档反写）。
- 契约：openapi.yaml legacyUnmappable/PolicyWriteResult；s9-dto-openapi
  -cross 第 5 例；s8-openapi-shapes。
- 往返：`__tests__/s5-toggle-roundtrip.test.ts`（行保留、旧表零行、重开
  decide allow）；`__tests__/s5-dual-write.test.ts`。
- 三态行为：s10-flip-drill 5/5（角色授予 flip_role_grant 行保留，off 下
  旧守 403、引擎 decide allow）。
- runbook：authz-policy-dual-write.md §3-§4。
- 落地 commit：a7eac11（S5）、a4e1f50（S10 往返演练）。
