# ADR-0033：旧三表回填为 allow 投影，不做运行时双读合并

**状态（Status）**：Accepted（M4 计划 §0-2/§4.6 定稿，2026-09-18 终审；2026-09-16 M4 出口归档）
**作者**：后端 贝洛奇
**上游依据**：docs/_archive/originals/planning-phase2-M4-implementation-plan.md §0-2、§4.6（七维对比与写路径切换点表）、§5（回填与对账）；M3 裁决 9（nav 同事务强一致）
**关联**：ADR-0032（纯 allow 模型是投影可等价的前提）；ADR-0034（kb_members 投影到 kb 单行）；ADR-0037（三态翻转门与 on+2 迭代退役路径）；ADR-0040（不可映射授权不阻断）

---

## 1. 背景（Context）

M4 开工时，旧三表 `members` / `kb_members` / `kb_doc_acls` 是七守卫的唯一
决策真源，新表 `auth_policies` 在 M3 已建好但零写入。引擎要上线，有两条根本
不同的路：

- **方案甲**：迁移时把旧三表一次性回填为 auth_policies 的 allow 行；运行期
  引擎只读新表；旧表在双写过渡期降级为一份物化投影，最终停写退役。
- **方案乙**：引擎判定时同时读旧表与策略表，在内存合并两边结果，两表长期并存。

fieldMask、中断继承、角色/部门授予三个 M4 新能力在旧表完全没有承载列，方案乙
必须永久回答"旧成员行与新策略行冲突谁赢"，等于把 deny/优先级问题从数据模型
里搬到每次请求的合并代码里。

## 2. 决策（Decision）：方案甲——回填 allow 投影，权威单一

### 2.1 七维对比（计划 §4.6，实施后逐项核实）

| 维度 | 方案甲（采纳） | 方案乙（否决） |
|---|---|---|
| 权威数 | 1 个 auth_policies；旧表是可由策略重建的物化投影 | 2 个，判定时合并 |
| 新能力承载 | fieldMask/继承 cutoff/角色与部门授予全在策略表，表达完整 | 旧表只有 per-user 资源角色，合并需定义冲突胜者，引回优先级问题 |
| 零漂移验证 | shadow 逐请求对拍，差异可数、可归零 | 合并结果无单一参照物，漂移只能人工推理 |
| 回滚 | flag 回 off：旧守卫读旧表（双写保证新鲜），行为整体回到 f553641 | 无法干净回滚：策略行已独立增长，关掉新逻辑后这些授权消失 |
| 长期形态 | on 稳定 2 个迭代后停旧表写、再评估删表（另开切片） | 永久双系统 |
| 成本 | 回填一次 + 11 写点同事务双写 | 每次判定永久多 2-3 条旧表查询 |
| 主要风险 | 双写漏点致投影陈旧；缓解=每写点真库测试 + 对账脚本可反复跑 + 回滚只依赖旧表 | 语义复杂度不可逆 |

### 2.2 回填与双写的实际形态

- 迁移 `20260916110000_authz_policies_backfill` 是纯幂等 DML
  （INSERT...SELECT + WHERE NOT EXISTS），按 shared-types 的
  `resourceActionsForLegacyRole` 映射动作串；确定性策略 id
  `pol_legacy_{member|kbmember|acl}_<旧行id>`，reason 前缀
  `legacy:member` / `legacy:kb_member` / `legacy:acl`，v1 手工策略用
  `policy:v1`。重跑零行增长，down SQL 只删 legacy 前缀行。
- S5 起 11 个旧写点（members 5 + kb_members 3 + kb_doc_acls 3）在同一
  `withWriteTx`/`withWriteBatch` 内维护投影；成员**降级**用精确 SET 收窄
  （setLegacyByRowTx），不用并集，避免 owner 降 viewer 残留高档动作。
- 反向：v1 `PUT /policies` 可映射档（user 主体 + 实体节点 + 无 mask +
  动作恰为某旧档串）同事务反写旧三表；不可映射档走 ADR-0040。
- 双写共生死：策略写、旧表反写、policyVersion bump 在同一事务，任一侧失败
  整体回滚（M3 裁决 9 的同纪律延伸，policyAdminTx.ts）。

### 2.3 对账：A/B/C 三类脚本，D 类在运行时

`scripts/authz/reconcile-policies.ts`（只读默认，`--apply` 修复，`--json`）：

- A 类（旧表到投影缺失/不一致）：A1_UNMAPPABLE_ROLE、A1_MISSING_POLICY、
  A2_ACTION_MISMATCH、A3_MANUAL_MATCHES_LEGACY（只报）；
- B 类（投影悬挂）：B1_ORPHAN_PROJECTION、B2_BROKEN_NODE、B3_MISSING_USER；
- C 类（结构合法性）：C1_BAD_ACTION、C2_DANGLING_FIELD、
  C3_DANGLING_DEPT/ROLE、C4_DUPLICATE_POLICY、C5_CONDITIONS_PRESENT（只报）；
- `--apply` 只修 A1/A2/B1/B2/B3，用 backfill.ts 同一原语；A3 与全部 C 类
  只报告，连跑第二次必须 no changes。

**D 类（逐请求决策漂移）不在脚本内实现**：脚本头注释明确"D 类决策漂移
S3 后补"，实际由 S3 落地的 shadow 运行时承担——七守旧决策与引擎 decide 同
上下文对拍，差异经 driftRegistry 分为 DRIFT_OVERDENY / DRIFT_OVERALLOW。
计划 §5.4 设想的"脚本内 D 类对拍"最终形态是运行时对拍加测试夹具对拍
（shadow-integration、s10 系列），本 ADR 以实现为准。

### 2.4 旧表退役路径（不在 M4 执行）

按计划切换点表：shadow 期旧表是决策真源、双写保鲜；on 期旧表仅投影、
旧结果只进反向 shadow；**on 稳定 2 个迭代后**在另开切片评审停旧表写与
删表。M4 不删任何旧表、旧守卫分支（清理裁决另见
docs/decisions/AUTHZ-LEGACY-GUARD-CLEANUP.md）。

## 3. 被否决的备选

1. **运行时双读合并（方案乙）**：见 §2.1，新能力无承载、漂移无单一参照物、
   无法回滚，三项均不可接受。
2. **只回填不双写（切 on 前旧表冻结）**：shadow 期旧入口仍在写旧表，冻结
   会让投影立刻陈旧；且回滚后旧表缺影子期全部变更。否决。
3. **双写但不反写（v1 策略只写新表）**：回滚到 off 后，面板在 shadow 期
   写入的可映射授权全部失效，违背"回滚逐值恢复"。故可映射档必须反写，
   不可映射档按 ADR-0040 显式标记。

## 4. 后果（Consequences）

- 升级路径可逆：迁移只增、down 只清 legacy 行；env 回 off 即回旧行为，
  无需数据回迁。
- 投影健康是可观测的：reconcile exit code 可直接进巡检；shadow drift 计数
  是上线前的硬门（ADR-0037）。
- 代价：11 写点全部要包事务双写，漏一个即投影陈旧——由 s5-dual-write 11 点
  故障注入测试与对账脚本兜底；旧三表在退役前仍需备份与保留。

## 5. 验证证据

- 回填迁移：`prisma/migrations/20260916110000_authz_policies_backfill/`，
  字面量交叉断言 `__tests__/backfill-literals.test.ts`（7 例）。
- 对账：domain/authz/reconcile.ts 全码值；CLI `scripts/authz/reconcile-policies.ts`；
  `__tests__/backfill-reconcile.test.ts`（8 例）。
- 双写：`__tests__/s5-dual-write.test.ts`（11 写点注入失败回滚）、
  s5-purge、s5-toggle-roundtrip。
- 升级 0 漂移：`__tests__/s10-ac-upgrade-20x20.test.ts`（400 格全等、
  reconcile 0 漂移）。
- 落地 commit：aa8c28c（S2 迁移加脚本）、a7eac11（S5 双写）、63f7020（S10）。
