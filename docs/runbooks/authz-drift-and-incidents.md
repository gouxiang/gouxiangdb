# M4 权限引擎：漂移排查与应急处置四章

四章覆盖：权限漂移排查（shadow drift + reconcile A/B/C）、成员被锁外或
误授应急（移除来源与关引擎两条路）、inheritance 误关恢复、旧表投影不一致
修复。三态开关操作（off/shadow/on 切换、翻 on 五前置、回滚演练）不在本文件，
只引用 [authz-engine-flip-on.md](authz-engine-flip-on.md)；双写方向与
legacyUnmappable 基础语义见 [authz-policy-dual-write.md](authz-policy-dual-write.md)。

> 命令默认在 api 应用目录（发布物的 `apps/api` 或等价 current 目录）执行。
> 改库前先按 [backup.md](backup.md) 做一次在线备份。单实例部署（ADR-0003）。

---

## 1. 权限漂移排查（D 类：逐请求决策漂移）

### 1.1 先分清两类"漂移"，它们不是一回事

| 类别 | 发现手段 | 含义 | 自动修 |
|---|---|---|---|
| A/B/C 类（投影/结构差异） | `scripts/authz/reconcile-policies.ts` | auth_policies 投影与旧三表不一致，或策略行结构不合法 | A1/A2/B1/B2/B3 可 `--apply`；A3、C 类只报 |
| **D 类（逐请求决策漂移）** | shadow 运行时对拍：结构化日志 `authz_drift` + 进程内 driftRegistry 环形计数 | 同一请求上旧七守决策与引擎 decide 布尔不一致 | **不自动修**，按本章定位 |

重要事实（避免按旧文档找不存在的命令）：M4 实现中 D 类**不在 reconcile
脚本内**（脚本头注释"D 类决策漂移 S3 后补"，最终由 S3 运行时对拍承担）。
脚本只有 A/B/C。D 类的两个方向：

- `DRIFT_OVERDENY`：旧放行 / 引擎拒绝。引擎更严，用户可能被锁外，可用性风险。
- `DRIFT_OVERALLOW`：旧拒绝 / 引擎放行。引擎更宽，越权风险，**零容忍**。

另有两种"非漂移"计数，排查时先排除：`authz_shadow_error`（引擎侧抛错，
旧响应不受影响，但要查引擎故障）与 `unresolvedNode`（资源反查不到活 nav
节点，属 M3 nav reconcile 域，不是权限分歧）。

### 1.2 D 类定位流程

1. 确认生产处于 shadow：env `GX_AUTHZ_ENGINE=shadow`（或 env=on 但
   AUTHZ_ENFORCE_READY=false 被降级 shadow，启动行可见 warn）。off 态没有
   对拍，查不到 D 类。
2. 从日志聚合取 `authz_drift` 行（JSON 单事件），按字段分桶：
   `kind`（OVERDENY/OVERALLOW）、`guard`（requireCanView/
   requireCanEditData/requireCanManageSchema/requireCanManageBase/
   requireCanComment/requireKb/requireDocAccess，另有 kb 四处提级动作与
   建内容以对应处理器名埋点）、`action`、`nodeId`、`userHash`（sha256
   短哈希，不回推明文；需要定位人时用该用户 id 自行加同盐哈希比对）。
3. 对同一 (userHash, nodeId, action) 用权威端点复核（任何模式下都直接算
   引擎，不经三态 flag）：
   `GET /api/v1/nodes/<nodeId>/effective?userId=<uid>`，看 perAction 布尔
   与 sources 来源链（direct/dept/role/owner_fallback，含 viaAncestor）。
4. 查旧三表事实：members（baseId_userId）、kb_members、kb_doc_acls 是否
   有活行、角色档是什么；再查 auth_policies 同节点链上的策略行与 reason
   前缀（legacy:* 为投影行，policy:v1 为面板手工行）。
5. 归因到下表，按右列处置：

| 典型归因 | 判据 | 处置 |
|---|---|---|
| 投影陈旧/缺失（双写漏点或历史数据） | 旧表有行、legacy 投影缺失或动作串不符 | 第 4 章 reconcile `--apply` 修 A1/A2；修后 shadow 计数应停止增长 |
| cutoff 边界差异 | 节点或祖先 inheritAncestors=0 | 引擎行为正确（ADR-0036 新能力）；旧系统无此功能，确认该 restricted 设置是否预期，预期则属于升级带来的收窄，在翻 on 前完成用户告知/授权补回 |
| 主体展开差异（调岗/角色/部门 path） | effective 的 dept/role sources 与预期不符 | 查 role_assignments、dept_members、部门 path（M2 域）；停用用户在登录层 401，不进引擎 |
| policy:v1 手工行造成的引擎更宽 | 旧表无行、节点上有 policy:v1 allow | shadow/on 未强制期本就不对旧请求生效；若来源不合规，经 PUT policies 或直接数据处置删除该行（先备份），翻 on 前必须完成盘点 |
| 引擎缺陷（上述都不成立） | 来源链清楚但布尔与纯 allow 规则矛盾 | 保留日志与节点/用户 id，回退方案：env 回 off（见第 2 章路线 B），同时报缺陷；禁止在生产库手工改策略"试修" |

### 1.3 双零口径

翻 on 前置 4 要求连续一个迭代 OVERALLOW=0 且 OVERDENY=0（见
authz-engine-flip-on.md 五前置）。观测面只有结构化日志与进程内环形缓冲
（容量 200，重启清零，M4 未在 readyz 暴露 drift 摘要）；故双零证据必须由
日志侧聚合留存，不能只靠进程计数。环形缓冲仅供现场最近条目排查，不作持久
证据。

---

## 2. 成员被锁外 / 误授应急

故障形态：某用户报告进不去本应有权的 base/kb/doc（锁外），或发现某人能
访问不应访问的资源（误授）。先判引擎是否已在强制路径。

### 2.1 先判状态（30 秒）

- 启动行/环境：GX_AUTHZ_ENGINE 是 off、shadow 还是 effective=on。
- M4 出口构建（AUTHZ_ENFORCE_READY=false）下，即使 env=on，七守资源可达性
  仍由旧三表裁决（对拍只观测）。此时锁外/误授的直接原因在旧表或业务层，
  **不要去改 auth_policies 试图即时止血**（旧守不读它，改了对七守无效；
  仅 v1 端点与 fieldMask/剪枝读引擎）。

### 2.2 路线 A（首选，两种姿态通用）：移除/补回授权来源

纯 allow 模型没有 deny 可删，收权 = 删尽来源；放权 = 补来源。按来源表逐项
查（用 effective 端点的 sources 最快定位）：

1. 旧成员/ACL 行：members.role、kb_members.role、kb_doc_acls（经既有
   /api 管理端点操作，会同事务双写投影，勿直接改库）。
2. 直授策略：`GET /api/v1/nodes/<nodeId>/policies` 找 subjectType=user
   行，经 PUT policies 的 deletes 移除（需组织 manage_share 或本资源
   manage_share 权限）。
3. 角色授予：role_assignments（user 直授或部门授角色），在通讯录角色管理
   面回收；调岗（移出有权部门）下一次请求即生效（无决策正缓存）。
4. 部门授予：auth_policies 上 subjectType=dept 行，注意部门授予荫及子树
   全体成员（impact 反向展开口径）。
5. 祖先继承：访问可能来自祖先节点策略，沿 nav path 逐节点查 policies；
   需要时可对内容叶子关继承（第 3 章，谨慎，属有意的结构变更不是应急首选）。
6. 兜底两类（删不光的来源）：资源 createdBy（实体创建人，除非删除实体或
   转移所有权——M4 无所有权转移端点，需数据层处置，先备份）与工作区
   role_owner（组织面回收，M2 设施）。

锁外反向操作：确认应有的来源类型后补一行（加成员/补直授/恢复角色授予）。
off/shadow 期要让旧七守立即认，必须补**旧表**来源（加成员/ACL 端点）；
仅写 auth_policies 的角色/部门授予对旧守不生效（ADR-0040），要等引擎
强制后。

### 2.3 路线 B（兜底，仅止血）：关引擎降级

适用：确认问题来自引擎强制路径（effective=on 的构建）且短时间无法定位
具体来源，或 OVERALLOW 越权正在发生。

- 操作与回滚同 flip-on runbook §4：env.conf 置 `GX_AUTHZ_ENGINE=off`
  （紧急）或退回 `shadow`（保留观测），重启 API；启动行确认
  effective=off。
- 效果：旧七守立即以旧三表决策为准；auth_policies 数据全部保留，期间
  policy:v1 不可映射授权对旧守不生效但行不丢，重开即恢复（ADR-0040）。
- 授权：回滚属总监授权动作；故障现场可先执行后补签，但必须同步通报总监
  （flip-on §4 同纪律）。
- fieldMask/剪枝注意：FIELD_MASK_ENFORCE_READY 与 NAV_PRUNE_ENFORCE_READY
  在 M4 出口构建为 true 且读**原始** env；env 回 off 后两者一并关闭，
  响应恢复全字段/全树，确认这对当前故障可接受（越权应急时优先止血，字段
  维度同理回到旧姿态）。

### 2.4 禁止事项

- 禁止直接 SQL 删 members/acls 应急（绕过同事务双写，立刻制造 A1/B1
  投影差异）；一律走管理端点。确需数据层处置时先备份，事后立即跑
  reconcile 复核。
- 禁止"加一条 deny"——模型无 deny（ADR-0032）。

---

## 3. inheritance 误关恢复

症状：某 doc/canvas 的继承被误置为关闭（nav_nodes.inheritAncestors=0），
一批成员反馈文档从树里消失或直开 403；或管理员想确认某次关继承影响面。

### 3.1 先看影响面（只读）

`GET /api/v1/nodes/<nodeId>/inheritance/impact?target=1` 预览**重开将恢复
访问的人数**（gaining，去重 ACTIVE 用户，分页 items 含 sources 来源标记；
creator/workspace_owner 关继承期间有兜底访问，不算恢复，exempt 在 gaining
方向恒空）。

`target=0` 方向给"若现在关会失访"的 losing 集与 exempt 名单（creator/
workspace_owner）。两方向都是只读预览，不变更状态。

### 3.2 恢复（重开继承）

`PATCH /api/v1/nodes/<nodeId>/inheritance`，body `{ "target": 1 }`
（首次调用未带 confirmed 会 409 INHERITANCE_CONFIRM_REQUIRED 并回带 impact
载荷，这是正常二次确认门，不是错误；带 `"confirmed": true` 提交）。

成功后：inheritAncestors 回到 1，同事务 bump navVersion 与 policyVersion，
审计 inheritance_changed 带前后 diff；祖先授予下一次请求即恢复，无缓存
等待。同一节点重放（本就为 1 再置 1）幂等不 bump。

### 3.3 边界与注意

- 仅 doc/canvas 可切；table/view/group/base/kb 返回 400
  NODE_NOT_INHERITABLE，这些类型"打不开继承"不是故障。
- 关继承只阻断**祖先**授予：节点自身直挂策略、creator、workspace owner
  不受影响（ADR-0036）。若恢复后仍有人进不去，问题不在继承，回第 2 章
  按来源逐项查。
- 子节点的连锁语义：被关节点 K 自身的策略仍及于其子孙；K 的子孙各自
  inherit=1 时，恢复 K 的继承会让 kb/更高祖先授予重新流入整个 K 子树。
  恢复前用 impact 看清人数，必要时先调整祖先授予再重开。
- 若节点本身被误删（404 NODE_NOT_FOUND）而非误关继承，走 M3 nav 恢复
  路径（软删恢复 + reconcile-nav），不在本章。

---

## 4. 旧表投影不一致修复（reconcile A/B/C）

适用：升级后对账、怀疑双写漏点、巡检发现差异、第 1 章 D 类归因到投影
陈旧。工具：`apps/api/scripts/authz/reconcile-policies.ts`（只读默认，
`--apply` 修复，`--json`）。

### 4.1 标准流程

```bash
# 0) 备份（见 backup.md），确认没有其他维护进程在写库

# 1) 只读报告（有差异退出码 1；--json 便于存档）
DATABASE_URL=file:/abs/app.db pnpm tsx scripts/authz/reconcile-policies.ts
DATABASE_URL=file:/abs/app.db pnpm tsx scripts/authz/reconcile-policies.ts --json > /tmp/authz-recon-before.json

# 2) 修复 A1/A2（补/校正投影）与 B1/B2/B3（删悬挂 legacy 投影）
DATABASE_URL=file:/abs/app.db pnpm tsx scripts/authz/reconcile-policies.ts --apply

# 3) 二次复跑：必须 no changes、退出码 0（幂等门）
DATABASE_URL=file:/abs/app.db pnpm tsx scripts/authz/reconcile-policies.ts
```

（注：脚本只从 DATABASE_URL 解析库路径，不 import 启动配置，可在停机维护
窗口直接跑；`--apply` 内部分别在事务内计算与修复。）

S 段（第二代 `role_library_scope` -> `reason='scope:role'` 投影）同源修复也走本脚本，
但**通电前的存量缺口**请用专用入口 `scripts/authz/project-scope.ts --apply`，
通电前总判定用 `scripts/authz/preflight.ts`（见 deploy.md §6.7.1）。

### 4.2 各类处置对照

| 码 | 含义 | --apply | 人工动作 |
|---|---|---|---|
| A1_UNMAPPABLE_ROLE | 旧行角色不在该族档位白名单 | 否 | 查旧表该行角色值来源（历史脏数据/第三方写入），修正旧行角色或删除后重跑 |
| A1_MISSING_POLICY | 旧活行在节点缺 user 策略 | 修（upsert 投影） | 修后核对 |
| A2_ACTION_MISMATCH | legacy 投影动作串与映射不符 | 修（精确 SET） | 若刚发生成员降级，双写本应已改，排查是否有人绕过端点改库 |
| A3_MANUAL_MATCHES_LEGACY | 非 legacy 行动作串恰等于旧档（疑似手工污染） | 否 | 人工确认该行是否应为 policy:v1 手工授权；确认后保留或改 reason，勿让脚本动 |
| B1_ORPHAN_PROJECTION | legacy 投影对应的旧表活行已不存在 | 修（删投影） | 若旧行是被误删，先恢复旧行而非删投影 |
| B2_BROKEN_NODE | 投影指向软删/不存在节点 | 修（删投影） | 软删资源恢复后授权本应还在：如资源会恢复，先恢复资源与 nav 节点 |
| B3_MISSING_USER | 投影主体用户不存在 | 修（删投影） | 同上，先判用户是否会重新激活 |
| C1_BAD_ACTION | actions 含非法/非规范动作词 | 否 | 数据层修正动作串为七枚白名单内规范串（先备份） |
| C2_DANGLING_FIELD | fieldMask 引用已删字段（table 节点） | 否 | 更新 mask 去掉失效字段 id |
| C3_DANGLING_DEPT / C3_DANGLING_ROLE | dept/role 主体已删 | 否 | 确认后删该行或改挂有效主体 |
| C4_DUPLICATE_POLICY | 同节点同主体多行（唯一索引正常会挡住，说明旁路写入） | 否 | 人工合并为一行后删余 |
| C5_CONDITIONS_PRESENT | conditions 非空（M4 不支持行级条件，A-7） | 否 | M4 引擎不读 conditions；确认非预期后清空该列；P1 行权限启用前不得依赖这些行 |
| S1_MISSING | 第二代 scope 行缺 `reason='scope:role'` 投影 | 修（整角色精确替换） | 存量缺口用 `scripts/authz/project-scope.ts --apply` 一次补齐（双写只覆盖写路径） |
| S2_ACTION_MISMATCH | scope 投影动作串与期望不等 | 修（整角色精确替换） | 先查是否有人绕过端点改库 |
| S3_MASK_MISMATCH | scope 投影 fieldMask 与期望不等 | 修（整角色精确替换） | 字段结构变更后应已由 `resyncTableMaskTx` 重算；未重算说明漏接线 |
| S4_ORPHAN | 多余 scope 投影（期望集无此节点） | 修（整角色精确替换） | 确认不是手工授权；`role_owner` 的台账行不审计、不删 |

S 段只认 `reason='scope:role'` 的行，`legacy:*` / `policy:v1` / user 行一根不碰。

### 4.3 修复后验证

- 二次复跑 A/B/C 全 0、退出码 0。
- shadow 姿态下观察一个业务周期：`authz_drift` 不再出现该 nodeId 的
  OVERDENY（投影缺失修复后引擎与旧守应收敛）。
- 若修复了大批量行（升级后首次跑），抽样用 effective 端点对若干用户/节点
  做布尔复核；升级等价的完整对拍标准见 s10-ac-upgrade-20x20 口径。
- nav 节点差异不归本脚本：unresolvedNode 或资源反查失败先跑 M3 的
  `scripts/nav/reconcile-nav.ts`（见 deploy.md §6.6/§6.8 与 restore.md）。

---

## 交叉引用

- 三态切换/翻 on/回滚一步操作：[authz-engine-flip-on.md](authz-engine-flip-on.md)
- 双写方向、legacyUnmappable 开关往返、purge 清策略：[authz-policy-dual-write.md](authz-policy-dual-write.md)
- 备份与恢复：[backup.md](backup.md) / [restore.md](restore.md)
- 架构依据：ADR-0032/0033/0036/0037/0040（[../adr/](../adr/)）
