# ADR-0057：权限引擎永久单一化——移除三态开关、对拍设施与 READY 阶段门

- 状态：Accepted
- 日期：2026-10-06
- 决策者：戴总（产品负责人）
- 关联：
  - ADR-0037（GX_AUTHZ_ENGINE 三态翻转门 off/shadow/on）—— 本 ADR 废止其机制
  - ADR-0056（库级聚合动作 enter/edit_data）
  - ADR-0035（字段掩码在表策略行上）
  - ADR-0036（继承中断）

## 1. 背景

M4 统一权限引擎在迭代过程中采用了「灰度三态 + 对拍 + 阶段门」的保守上线机制：

- 环境变量 `GX_AUTHZ_ENGINE = off | shadow | on` 控制引擎是否参与放行；
- 三个独立 READY 常量（`AUTHZ_ENFORCE_READY` / `FIELD_MASK_ENFORCE_READY` / `NAV_PRUNE_ENFORCE_READY`）作为阶段门；
- `shadow` 态同时跑旧决策与引擎，对拍结果记入 drift 账本（`DRIFT_OVERALLOW` / `DRIFT_OVERDENY`），但响应仍以旧决策为准；
- 引擎故障时回落旧决策（fail-safe warn）。

2026-10-05 已由戴总下令直接通电接管（commit `138933f`，总门翻 true）。引擎经全量投影、对账、规模门、对抗矩阵与真实进程冒烟验证，结论与现行口径一致。

戴总进一步明确（原文）：

> 打开权限引擎 而且确保没有旧的权限引擎残留，我不想在出现以后误判新旧引擎的问题，而且也不希望下次再有改动的时候会问我是否打开新引擎，确保功能都是最新的标准，不要残留迭代过程当中的冗余的东西。

## 2. 决策

权限引擎成为**唯一、永久、无条件生效**的布尔执法路径：

1. **删除三态开关**：不再读取 `GX_AUTHZ_ENGINE`，`off/shadow/on` 三态及其解析函数全部移除。
2. **删除 READY 阶段门**：三个独立就绪常量及其门控逻辑移除；引擎、字段掩码、导航剪枝均恒定执行。
3. **删除对拍/drift 设施**：`shadow.ts`（drift 账本、对拍分类）、适配层 `runShadowCheck` 及相关埋点全部移除。
4. **fail-closed 取代回落**：
   - 引擎抛错 → 抛 `HttpError(503, "权限服务暂不可用")`，记结构化事件 `authz_engine_error`，**绝不回落任何旧决策**；
   - 资源反查不到活 nav 节点 → fail-closed 拒绝（403），记 `authz_engine_unresolved`。
5. **保留 conjunction 语义**：删库 / 删知识库仍走 `legacyAllowed ∧ engineAllowed`，只减不增，防止引擎借动作词更宽而放行删库。
6. **保留 libraryPolicy 能力层**：`libraryPolicy.ts` 作为引擎之上的「能力 / UI 形状层」保留；`authzManage` 能力位与引擎执法正交，只决定权限面板是否可写，不参与资源放行。

## 3. 删除 / 变更清单

物理删除：

- `apps/api/src/configAuthz.ts`（三态开关 + 三个 READY 门）
- `apps/api/src/domain/authz/shadow.ts`（drift 账本 + 对拍）
- 纯对拍/翻转测试：`shadow.test.ts`、`shadow-integration.test.ts`、`shadow-kb-escalation.test.ts`、`s10-flip-drill.test.ts`

改造为永久态：

- `domain/authz/enforceGate.ts`：恒定走引擎，fail-closed；`EnforceParams` 去掉 `mode`，`EnforceOutcome` 精简为 `{ allowed, source:"engine", nodeId? }`
- `domain/authz/adapter.ts`：删除 `runShadowCheck`，保留 `engineDecideResource` / `ResourceRef` / `makeCreatedByResolver`
- `domain/authz/maskGate.ts`、`breadcrumb.ts`、`navVisibility.ts`、`maskSession.ts`：恒定执行
- `routes/v1/workspace.ts`：tree/menu 恒定剪枝
- `domain/authz/tableManageGuards.ts`：建表 / 表管理 / 结构设计均走引擎权威裁决
- `config.ts`、`index.ts`：移除 `authzEngine` 字段与 `[authz]` 启动日志块

## 4. 后果

正面：

- 系统中只有一套生效的授权实现，从根上消除「两套裁决谁为准」的误判；
- 后续任何改动不再需要询问是否开启新引擎；
- 字段掩码、行级条件、导航剪枝随引擎永久生效，无隐藏开关。

风险与处置：

- 引擎故障不再有旧路径兜底，直接 503。这是刻意选择：旧路径本身已退役，保留兜底即保留「第二裁决来源」，与戴总「不残留」的要求冲突。503 是显式、可观测、可告警的失败，优于静默的错误授权。
- 存量数据零改动：本决策不涉及数据结构变更；历史 `members` / `kb_members` / `kb_doc_acls` 行保留为台账，不参与放行（其进一步退役另议，且须遵守「不破坏存量数据」约束）。
