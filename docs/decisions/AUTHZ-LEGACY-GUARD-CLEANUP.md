# 裁决：旧守卫分支与旧三表的退役清理清单（M4 不执行）

- 日期：2026-09-16
- 作者：后端 贝洛奇
- 状态：**Accepted（仅登记清理清单与触发条件；M4 不删任何旧分支/旧表/旧写点）**
- 上游依据：docs/_archive/originals/planning-phase2-M4-implementation-plan.md §4.8（on 后反向 shadow 一迭代、旧分支再保两迭代）、§4.6 写路径切换点表（on+2 迭代停旧表写评估）、§S11"旧守卫分支清理裁决文档"
- 关联：ADR-0037（三态翻转门与时间线）、ADR-0033（旧表投影地位与退役路径）、ADR-0032（引擎判定唯一内核）；runbook authz-engine-flip-on.md、authz-policy-dual-write.md

---

## 1. 裁决

1. M4 里程碑内**不删除**任何旧守卫决策分支、旧三表查询、旧表写点与旧表本身；
   不翻转 AUTHZ_ENFORCE_READY 默认值。M4 出口姿态为代码默认 off、生产建议 shadow。
2. 清理动作拆为**独立切片**（建议名 m5/m6-authz-retire，不挤进任何在途里程碑），
   最早启动条件见 §3，全部条件满足前清单中的任何一项都不得提前动手。
3. 该切片自身仍须走三态/双 flag 兼容纪律：删除分阶段、可回滚、每阶段回归
   40RC + S0 golden（golden 在旧分支真正删除的那个切片里同步退役）。

## 2. 删除/退役清单（按阶段，后阶段不得先于前阶段）

### 阶段 R1：七守 enforce 接线 + 翻总门（前置，不在本裁决清理范围但必须先发生）

- guards.ts 五函数（requireCanView/requireCanEditData/requireCanManageSchema/
  requireCanManageBase/requireCanComment）与 routes/kb/shared.ts 两函数
  （requireKb/requireDocAccess）增加"effective=on 时以 engineDecideResource
  为权威结果（allow 放行/拒绝 403），旧决策仅留反向 shadow"的生产分支；
  kb 四处 owner-only 提级（rename/delete/member add/remove）与建内容（c）
  二次角色闸同口径接线（现仅有 shadow 缝，见 shadow-kb-escalation）。
- AUTHZ_ENFORCE_READY 经独立评审翻 true；configAuthz.ts 注释与启动日志更新。
- 验收：flip runbook 第 0 步四项 + 五前置（authz-engine-flip-on.md）。

**R1 接线落地范围与两处语义缺口（实施记录，2026-10-03）**

- 落地：`apps/api/src/domain/authz/enforceGate.ts`（`enforceOrLegacy` 原语，三态收口）+
  `guards.ts` 七守改经该原语；`off/shadow` 两态响应逐值不变（有测试锁）。
- 缺口 1（需架构师/总监裁决）：**引擎动作词汇里没有「删库」这一枚**。
  `requireCanDeleteBase` 在旧模型是硬规则 A（仅超级管理员），引擎唯一接近的是 base 节点 `d`
  （删数据）。若按 authority 语义放行，任何在数据上拿到 `d` 的人（编辑者、库管理员）都能删库——
  实打实的越权。故该关卡取 `conjunction`（旧 ∧ 引擎）：`d` 只作必要条件，超管（workspace owner
  兜底）照删，其余仍被硬规则 A 拒。有测试锁（给非超管 `d` 策略仍 403）。
  **未解决**：引擎侧仍表达不了"删库"本身，翻 on 后这一条只能靠旧分支兜底，
  建议补一枚动作位（`delete_library`）后在 R3 前改回 authority。
- 缺口 2（R2 观察期必盯）：**`manage_schema` 在投影里挂的是 table 节点，不是 base 节点**
  （`scopeProjection.projectBase`：`canManage` 的策略行挂在 base 节点上只有
  `manage_table,manage_share`，`manage_schema` 随 `manageSchema` 进了各 table 节点）。
  而 `requireCanManageSchema` 的对拍点是 base 节点。故非超管的库管理员（canManage=1）在
  on 态可能被拒改表结构（OVERDENY）。存量库靠 legacy 三表回填（owner 角色映射含
  manage_schema）暂时不暴露，新配的库管理员会暴露。翻门前需先决定：
  （a）把该守卫的对拍点改到 table 节点，或（b）投影给 base 节点也补 `manage_schema`。

### 阶段 R2：on 稳定观察期内只观测，不删（时间门）

- on 后反向 shadow 连续 **1 个迭代**双零（DRIFT_OVERALLOW=0、
  DRIFT_OVERDENY=0、authz_shadow_error=0 或全部有归因）。
- 其后旧守卫决策分支**再保留 2 个迭代**。在此期间清单冻结，只允许修缺陷。

### 阶段 R3：旧决策代码删除（观察期满后的独立切片）

1. guards.ts：删除五函数内的旧决策体（roleOf/permissionsOf 驱动分支），
   收敛为"取 userId -> 引擎 decide -> HttpError 403"；shadowBase 对拍缝与
   runShadowCheck 调用一并移除（反向 shadow 已结束）。注意保留
   requireUserId/resolveBaseIdBy* 等非授权工具函数（路由解析仍在用）。
2. routes/kb/shared.ts：删除 kbRoleOf/docAclRoleOf/RANK 参与的旧决策与
   "取较高"逻辑，requireKb/requireDocAccess 收敛为引擎判定；保持
   requireDocAccess 现返回形状 `{doc, role, canEdit}` 的调用面——26 处
   消费方在同切片迁移或适配新形状（这是最大调用面，需单列 PR）。
3. kb 处理器内联 owner-only 判断（成员管理/改名/删除/建内容的提级闸）
   迁移到引擎 manage_share/c 判定，业务保护（不能踢 owner/自己）保留——
   那不是授权动作。
4. shadow 设施：shadow.ts（DriftRegistry/classifyDrift）、adapter.ts 的
   runShadowCheck 及七（含提级为十一以上）埋点、drift 日志事件、configAuthz
   的 shadow 分支随反向 shadow 结束后删除；effectiveAuthzMode 可收敛为
   off/on 两态或保留解析但移除降级 warn（切片自决，须 ADR 补记）。
5. 测试处置：characterization/legacy-decision-matrix、legacy-response-shapes、
   shadow*、flip-drill 等"锁旧行为/对拍"的测试在对应代码删除的同切片退役；
   decision-matrix/scope-parity/s10-ac-* 等引擎侧测试保留并继续作为权威。
6. S0 golden 文档（2026-09-15-m4-baseline.md）标记历史基线，不再要求逐值绿。

### 阶段 R4：旧三表停写与投影退役（R3 之后另评）

1. 11 个写点的双写投影代码（members 5 + kb_members 3 + kb_doc_acls 3，
   policyAdminTx.reverseWriteLegacyTx 反向写、backfill.ts/setLegacyByRowTx
   等）按 §4.6 切换点表"on+2 迭代"评估停写；停写顺序建议：先停 v1 策略写
   的反向回写（新入口先单写权威表），观察一迭代；再停旧入口的正向投影并
   把旧入口（成员管理/ACL 端点）改为直接写 auth_policies 或下线该入口。
2. legacyUnmappable 机制（ADR-0040）在旧入口不再承担权威后语义消失，
   响应字段经前端版本窗口后再移除（只增契约的移除需先发废弃通告）。
3. 物理删表（members/kb_members/kb_doc_acls）与列回收必须满足：
   - 全量代码 grep 无旧表读（含脚本/测试/备份恢复文档）；
   - 一次大版本升级演练：备份 -> 迁移删表 -> restore.md 流程适配 ->
     回滚预案（以发布前快照为主路径）；
   - 旧匿名分享链路（/s/* 令牌、resolveShare/subtreeIdSet）**不在**
     授权引擎域（M7 通道保留），确认其不依赖 kb_doc_acls 后才能动该表。
4. 迁移只增纪律下，删表走新迁移 DROP TABLE；down SQL 存
   prisma/docs/rollback，发布说明显式标注不可逆数据动作。
5. reconcile-policies 脚本在旧表消失后缩减为 auth_policies 单边结构巡检
   （C 类与 policy:v1 行健康），或随表一起退役，切片自决。

### 阶段 R5：配置与文档收口

- GX_AUTHZ_ENGINE 若收敛为常驻 on：env 文档、deploy.md §6.8、env 示例、
  启动日志、runbook 两册（flip-on/dual-write）一并更新或归档；
  org-contacts.md 等引用三态处同步。
- FIELD_MASK_ENFORCE_READY / NAV_PRUNE_ENFORCE_READY 两个独立门在总门
  稳定后评估是否折叠为单一门（它们存在的历史原因是 S6/S7 先于七守生效，
  折叠须确认没有"只要掩码/剪枝不要节点强制"的部署诉求）。

## 3. 启动条件（硬门，全部满足才许开 R3 切片）

1. 含 R1 enforce 接线的构建已发布，生产启动行 effective=on 真实生效
   （非降级 shadow）；
2. 翻 on 五前置全部留证（flip-on runbook §1），且切 on 由项目总监书面下令；
3. 反向 shadow 连续 1 个迭代双零；
4. 其后再经过 2 个完整迭代观察期无权限类回滚；
5. M6 MCP 接入确认只走引擎（ARCH :539 纪律），无新消费方依赖旧七守返回
   形状（requireDocAccess 的 {doc,role,canEdit} 尤其要清点）；
6. 旧匿名分享通道与旧表耦合关系已清点（§R4-3）。

## 4. M4 出口为什么必须按兵不动

- shadow 双零的生产观测（前置 4）在 M4 出口尚未发生；没有观测期就删旧分支
  等于把唯一经过现网验证的授权路径拆掉。
- 七守 enforce 生产分支在 M4 代码中不存在（configAuthz.ts
  AUTHZ_ENFORCE_READY=false 是硬事实，s10-flip-drill 用
  `expect(AUTHZ_ENFORCE_READY).toBe(false)` 锁死）；跳过 R1 直接清理
  无路径可走。
- 旧表是 off 回滚的物理依托（ADR-0033）；双写保鲜期内提前停写会使回滚后
  影子期授权变更丢失。
- 本文件只回答"将来删什么、什么条件下删"，不构成任何 M4 代码动作。

## 5. 证据锚点（清理切片开工时按图索骥）

- 七守旧决策体：apps/api/src/guards.ts（五函数 + roleOf/permissionsOf）；
  apps/api/src/routes/kb/shared.ts（requireKb/requireDocAccess/RANK）。
- 对拍/影子设施：domain/authz/adapter.ts、shadow.ts、configAuthz.ts。
- 双写与投影：11 写点（M4 计划 §1.2 表带行号，S5 已全部接线）、
  domain/authz/backfill.ts、policyAdminTx.ts reverseWriteLegacyTx、
  scripts/authz/reconcile-policies.ts、迁移 20260916110000。
- 三 purge 清策略：domain/nav/sync.ts purgeViewNodeTx/purgeTableNodeTx/
  purgeDocNodeTx（这部分是新机制，删旧表后仍保留）。
- 时间线依据：M4 计划 §4.8 裁决 A-3；ADR-0037 §2.5。
