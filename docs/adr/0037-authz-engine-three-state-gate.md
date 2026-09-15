# ADR-0037：GX_AUTHZ_ENGINE 三态翻转门（off/shadow/on）

**状态（Status）**：Accepted（裁决 A-3 2026-09-18 定稿，仿 M1 三态先例；2026-09-16 M4 出口归档）
**作者**：后端 贝洛奇
**上游依据**：M4-implementation-plan.md §0-6、§4.8（drift 分类与翻门五条件）、§0-8 裁决 A-6；M1 flags.ts 三态先例
**关联**：ADR-0033（双写保证 off 回滚物理可行）；ADR-0040（开关往返语义）；runbook authz-engine-flip-on.md；旧守卫清理裁决 AUTHZ-LEGACY-GUARD-CLEANUP.md

---

## 1. 背景（Context）

新引擎以替换旧七守（guards.ts 五个 require*、routes/kb/shared.ts 的
requireKb/requireDocAccess）为终态，但 M4 不能上线即强制：旧行为是现网唯一
授权路径，新引擎与旧守卫的任何语义偏差要么锁外用户（可用性事故）要么放行进
未授权资源（安全事故）。M1 sidecar/keyset 已有 off/shadow/on 三态灰度先例，
M4 沿用同一纪律并加严（M1 容忍一定 OVERDENY 灰度，M4 要求双零）。

## 2. 决策（Decision）

### 2.1 三态语义（configAuthz.ts）

- **off（代码默认，含未设置/未知/空值保守回落）**：七守完全走旧三表决策，
  shadow 适配层短路，不实例化引擎、零新增 SQL。
- **shadow**：旧决策为准并照常返回，同一请求内 await 引擎同上下文对拍，
  差异只分类计数/脱敏结构化日志（event=authz_drift，userId 仅 sha256 短
  哈希），不改响应、不抛错；引擎自身出错吞掉记 authz_shadow_error，旧响应
  不受影响（fail-open 仅限观测层）。
- **on**：以引擎决策为准。

### 2.2 三层就绪门（M4 出口现状如实记录）

三个独立常量，后两者读**原始** resolveAuthzEngineMode（不经 on 降级）：

| 常量 | M4 出口值 | 含义 |
|---|---|---|
| AUTHZ_ENFORCE_READY（七守总门） | false | 七守只有 shadow 对拍缝，无"以引擎 decide 为准放行/拒绝"的 enforce 生产分支；env=on 被 effectiveAuthzMode 降级为 shadow 并 warn 一次 |
| FIELD_MASK_ENFORCE_READY | true | S6 五出口在原始 env=on 时真实下推（maskGate.ts 等） |
| NAV_PRUNE_ENFORCE_READY | true | S7 tree/menu 剪枝 + 面包屑截断在原始 env=on 时真实生效 |

env=on 在总门 false 期间的真实效果 = shadow 对拍 + fieldMask + navPrune
三件套；资源可达性仍由旧七守裁决。两件只减不增的能力先于总门生效是安全的：
它们只在旧守卫已放行表级 r 之后做收窄/剔除，从不放行被旧守拒绝的请求。

### 2.3 drift 两分类（shadow.ts）

- DRIFT_OVERDENY = 旧 allow / 引擎 deny：引擎更严，锁外/可用性风险；
- DRIFT_OVERALLOW = 旧 deny / 引擎 allow：引擎更宽，越权风险，零容忍；
- 另有 errors（引擎对拍抛错）与 unresolvedNode（资源反查不到活节点，归
  M3 reconcile，不算权限漂移）。
进程内 DriftRegistry 滚动计数 + 最近 200 条环形缓冲，不落盘、不含响应体。

### 2.4 翻 on 五条前置（全满足且仅项目总监下令）

1. S0/S3 characterization 对拍覆盖五角色 x 三族 x 继承/ACL（>=ARCH 18 条），
   DRIFT 双零；
2. 升级副本 reconcile A/B/C=0，随机 20 主体 x 20 节点全等 + 全量小库逐判定
   0 漂移；
3. 类生产演练库（500 用户/6 层部门/万节点/约 3000 策略）确定性流量双零
   （12000 次 scope/decide 对拍）；
4. 生产影子**连续一个迭代** OVERALLOW=0 且 OVERDENY=0（比 M1 严：可用性
   漂移也不灰度容忍），authz_shadow_error=0 或全部有归因；
5. 回滚演练通过（off 后逐值恢复、A-5 类授权往返恢复）+ 切 on runbook
   经总监书面签收。

### 2.5 on 后时间线与旧分支寿命

on 后先跑**一个迭代反向 shadow**（引擎生效、旧结果仅记录），任一
OVERALLOW 立即 env off 回滚；反向 shadow 期满双零后，旧守卫决策分支**再保
两个迭代**，期满才许在**另开切片**删除。M4 不删任何旧守卫分支
（docs/decisions/AUTHZ-LEGACY-GUARD-CLEANUP.md 已列删除清单与触发条件）。

### 2.6 正交关系与 v1 通道

- 与 GX_ENTERPRISE_NAV（M3 导航 flag）正交：NAV 控 /api/v1/nodes/* 挂载，
  AUTHZ_ENGINE 控七守决策来源；v1 子路由按双 flag 条件挂载，两 flag 全 off
  时整个 /api/v1 不挂载。
- v1 新端点（policies/effective/visible-scope/inheritance）**不经三态
  flag**，任何模式下直接走引擎——新通道从第一天只认引擎，M6 MCP 同纪律。

## 3. 被否决的备选

1. **上线即 on（无影子期）**：偏差即事故，且无回滚证据。否决。
2. **只做 shadow 永不翻 on**：旧三表与双写永久付费，引擎成为永远的旁路，
   M5/M6 消费的 scope 与 HTTP 强制语义长期脱节。
3. **按比例灰度（部分请求引擎为准）**：同一用户相邻请求结果不一致，且
   权限灰度无安全余量；定稿硬切换，中间态只有 shadow。
4. **用改代码默认值翻 on**：生产取值只能由部署 env + 总监下令决定；
   代码默认恒 off。

## 4. 后果（Consequences）

- M4 出口可发布姿态：代码默认 off、**生产建议值 shadow**（部署侧设定），
  翻 on 还需一个含七守 enforce 接线 + 总门翻转的独立构建切片（runbook
  第 0 步），该切片不在 M4 内。
- env=on 静默降级 shadow 是防误开保险，也意味着"配置写了 on"不等于
  "已强制"——启动行必须核 configured/effective，runbook 已列为切换步骤。
- 回滚一步：env 回 off 重启，旧守逐值恢复，auth_policies 数据保留
  （ADR-0040）。

## 5. 验证证据

- 门与三态：src/configAuthz.ts（:17 总门 false、:64/:82 两独立门 true）。
- 对拍：src/domain/authz/shadow.ts、adapter.ts；guards.ts 与
  routes/kb/shared.ts 七处 shadow 缝。
- 三态翻转演练：`__tests__/s10-flip-drill.test.ts`（5 例，28+28 格等价，
  含 READY=false 锁定、反向 shadow 插桩分类、回 off 零查询）。
- 双零证据与五条件核对：docs/baseline/2026-09-16-m4-gate.md §3-§5。
- 操作手册：docs/runbooks/authz-engine-flip-on.md。
- 落地 commit：5440b40/50269a2（S3）、a4e1f50（S10 门证据与 runbook）。
