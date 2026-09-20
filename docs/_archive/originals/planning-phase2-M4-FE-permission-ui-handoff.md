# M4 前端权限 UI 派工输入清单（M4-FE handoff）

> 面向 M4 前端实施切片的**输入契约**。后端 S5-S9 已落地并冻结，本文只登记前端要消费什么、
> 受什么约束、哪些入口必须门控。契约真源：
> - OpenAPI：`docs/api/openapi.yaml`（S8 冻结，27 paths / 命名 schema）
> - 错误码：`docs/api/m4-error-codes.md`
> - 共享 DTO：`packages/shared-types/src/policy.ts`（策略/effective/visible-scope）+
>   `packages/shared-types/src/nav.ts`（继承/面包屑/MoveImpact）+ `authz.ts`（ResourceAction/FieldMask）
>
> 后端端点全部挂 `/api/v1`，经 `apps/web/src/api/client.ts` 的 `apiFetch` 走，**禁止新依赖、禁止第二套请求层**。

## 0. 硬约束（违反即退回）

1. **只走 `api/client.ts`**：新增方法挂在既有 v1 client 段，类型只 import `@gx/shared-types`，不引第三方请求/状态/图标库。
2. **全部 gx token**：颜色/间距/圆角/字号只用 `@gx/design-tokens`（`tailwind.config.ts` 已接 `gxTailwindConfig`），不硬编码色值。
3. **图标只追加 `apps/web/src/components/icons.tsx`**：禁第二套图标库、**禁 emoji 作功能图标**（团队 P0）。
4. **禁紫到粉渐变**（团队 P0）。
5. **禁 AI 模板味空文案**：按钮/空态/错误用具体业务话术。

## 1. 门控纪律（最高优先，S10 翻总门前生产不暴露）

继承开关与节点策略编辑是 **M4 新增能力**，后端总门 `AUTHZ_ENFORCE_READY` 在 S10 翻转演练前默认 false
（off/shadow 态旧守卫决策、剪枝短路、与 M3 字节一致；但 S7 起策略/继承写端点在 off/shadow 也可改列，
仅作对拍不代表生产语义生效）。

- **前端必须对"继承切换 + 策略编辑入口"做 UI 门控**：门未开时生产环境不渲染这些操作入口
  （PermPanel 只读可见、Break/Restore 开关与保存按钮不出现或禁用）。
- 门控信号与读取方式在前端切片开工时向后端确认（读 `/api/v1/meta` 现有企业态或新增只读能力位，
  不允许前端自行写死"已上线"）。
- off/shadow 阶段前端可在开发/对拍环境联调完整交互，但**合入生产构建必须默认关闭**，等 S10 总监下令翻 on。
- 只读解释类能力（effective 来源链、visible-scope 诊断、面包屑截断标记）不改变决策，可随 M4-FE 正常上线，
  但其中"管理视角"数据（查他人 effective）仍受后端 manage_share 约束，前端按 403 隐入口即可，不做本地越权判断。

## 2. PermPanel 权限面板（SPEC :98）

一个节点的统一授权管理面板，四块：

1. **资源树（左）**：复用 M3 tree 数据，选中节点；on 态树已由后端剪枝，前端不二次判权，只渲染。
2. **主体三页签**：成员（user）/ 部门（dept）/ 角色（role），对应 `PolicySubjectType`。
   页签内列出该主体在本节点的授权，支持搜索选择主体（悬挂主体后端返回 `subjectName:null`，前端显"已删除主体"）。
3. **动作矩阵**：七枚资源动作勾选——`r / c / u / d / comment / manage_share / manage_schema`
   （`RESOURCE_ACTIONS`，字典序）。矩阵语义=整单 PUT 的 `upserts`；
   `manage_schema` 仅 table/base 节点可勾（其他节点后端 400 POLICY_ACTION_INVALID，前端按节点 kind 先置灰）。
4. **字段三态（仅 table 节点，挂在单条策略行）**：可见 / 只读 / 可编辑，映射 `FieldMask`
   （`allowFields` 收窄可见、`readOnlyFields` 只读）；缺省=不裁剪（可编辑=全量）。

**数据契约**：
- 读：`GET /nodes/{id}/policies`  ->  `NodePoliciesViewDTO`
  `{ node{id,kind,resourceType,name,inheritAncestors:0|1}, inheritAncestors:boolean, direct:PolicyRowDTO[], ancestors:PolicyAncestorSummaryDTO[] }`。
  - `direct[]` 是本表可编辑行；`ancestors[]` 是 cutoff 链祖先继承下来的**只读摘要**（展示"继承自 X"，不可在此改）。
  - `PolicyRowDTO`：`{id, subjectType, subjectId, subjectName, actions[], fieldMask, reason, createdAt}`；
    `reason` 为 `policy:v1` 是手工策略，`legacy:*` 是旧三表投影（同表编辑，不另开旧弹窗）。
- 写：`PUT /nodes/{id}/policies`，体 `PolicyWriteRequestDTO { upserts?:PolicyUpsertDTO[], deletes?:PolicyDeleteDTO[] }`，
  至少一项、upserts≤200/deletes≤500；**整单全合法才提交**，任一 4xx 全拒。
- 写响应 `PolicyWriteResultDTO { node{...resourceId...}, policyVersion, upserted, deleted, legacyUnmappable[] }`。
  - `legacyUnmappable`（`{subjectType,subjectId,reasons[]}`）是 **200 成功提示不是错误**：
    该授权在新引擎生效但无法反写旧三表（角色/部门授予、fieldMask、非标动作组合、table 节点）。
    前端用轻提示展示明细，**不要弹错误框、不要回滚 UI**。
- 授权：读需对节点 r；写需组织 manage_share 或节点 manage_share（后端取或）。无权限整面板只读/隐藏保存。

## 3. Break / Restore Inheritance 确认 Modal（SPEC :100）

仅 doc/canvas 节点显示继承开关（其他 kind 后端 400 NODE_NOT_INHERITABLE，前端不显示）。

- 开切到关（中断）或关切到开（恢复）前，先 `GET /nodes/{id}/inheritance/impact?value=0|1&limit=&offset=` 取 `InheritanceImpactDTO`：
  `{ nodeId, from, to, delta:"losing"|"gaining", count, items[{userId,name,via,sources[]}], limit, offset, exempt[{userId,name,reason}] }`。
  - `count` 精确（不受分页影响）；`items` 按 userId 字典序分页（默认 100、上限 200）。
  - `exempt`（reason=`creator`/`workspace_owner`）是"不会失访"的兜底主体，与 count 分开呈现，不要算进失访人数。
  - `via`（direct/dept/role）+ `sources[]` 用于在列表里标注来源类型。
  - **本载荷没有 willBreakInheritanceHint**——该 hint 只属于移动节点的 MoveImpact，勿张冠李戴。
- 用户确认后 `PATCH /nodes/{id}/inheritance` 体 `{ value:boolean, confirmed:true }`；
  未带 confirmed 后端回 **409 INHERITANCE_CONFIRM_REQUIRED** 并附 impact（前端拿到 409 也应弹同一 Modal，防竞态）。
- 成功响应 `{ nodeId, inheritAncestors, navVersion, policyVersion, impact }`；目标值与现状一致时后端幂等回 200（count=0、不 bump）。
- Modal 文案区分"中断将使 N 人失去访问（另有 M 位创建者/所有者不受影响）"与"恢复将使 N 人重新获得访问"。

## 4. 来源链抽屉（O8 可解释）

- 数据：`GET /nodes/{id}/effective?userId={可选}`  ->  `EffectiveViewDTO`
  `{ node{...}, userId, actions[], policyVersion, perAction:EffectivePermissionDTO[] }`，
  perAction 固定 7 项（七动作逐一），每项 `{action, allowed, sources:EffectiveSourceDTO[]}`。
- 抽屉按动作展示 sources，单条 `EffectiveSourceDTO` 九键：
  `kind(direct|dept|role|owner_fallback)、policyId、nodeId、nodeName、viaAncestor、subjectType、subjectId、subjectName、fallback(workspace_owner|creator|null)`。
  - `viaAncestor=true` 标"继承自祖先节点 nodeName"；`kind=owner_fallback`/`fallback` 非空标"创建者/工作区所有者兜底"（policyId 为 null）。
  - `subjectName:null` 显悬挂主体。
- 缺省查本人；查他人需 manage_share（后端 403 时前端不显示"查看他人"入口）。

## 5. DocAclModal 改造为同表视图

- 现有文档权限弹窗（旧 `/api/kb/docs/:id/acl` 三档 viewer/commenter/editor）**不另起一套**，
  改造为 PermPanel 在 doc 节点的同表视图：旧三档是可映射的 per-user 授权，经 GET/PUT policies 统一读写
  （后端整单写会同事务反写 kb_doc_acls，双写共生死）。
- 角色/部门/字段级/非标组合在旧表无对应档，以 `legacyUnmappable` 提示"仅企业权限引擎生效"，不在旧弹窗伪造档位。
- 旧公开分享 `/s/*` 匿名通道独立，不在本面板范围。

## 6. 面包屑（只渲染后端中性化后的链）

- `GET /nodes/{id}/breadcrumb`  ->  `NodeBreadcrumbDTO { nodeId, chain:BreadcrumbNodeDTO[], truncatedAbove }`。
- 后端已在 on 态把无权祖先段整体截断并重写段首相对坐标（段首 `parentId=null`、`path=/<id>/`、depth 从 0），
  **响应不含被截节点 id/name/path**。前端只做两件事：
  1. 正常渲染 `chain`（根到自身）；
  2. `truncatedAbove=true` 时在链首渲染一个中性"上级受限/…"截断标记（不请求、不猜测、不拼接被截祖先）。
- off/shadow 态后端回全物理链且 `truncatedAbove=false`，前端无需分支，按标记渲染即可。

## 7. 图标（只在 icons.tsx 追加）

候选名（语义见上）：`shield`（权限/安全）、`lock`（中断继承/受限）、`unlock`（恢复继承）、
`keyRound`（manage_share/授权）、`inherit`（继承）、`cutoff`（继承边界/截断）。

- 现状 `icons.tsx` **已有** `lock / shield / keyRound`；**需追加** `unlock / inherit / cutoff` 三个 path-data 即可，
  沿用既有 `IconName` 联合类型 + `Icon` 组件 + `VIEW_ICON` 风格，不引新库、不用 emoji。

## 8. 验收对齐（前端片自测）

- 三身份联调矩阵以后端 S9 快照为准（`apps/api/src/routes/v1/__tests__/s9-identity-snapshots.test.ts`）：
  viewer（仅 r，只读）/ 节点 manage_share 直授者（能改本节点、能查本节点他人 effective、不能跨用户查 visible-scope）/
  owner（全通）。
- 409 confirm 流（inheritance/move）必须"带 impact 弹 Modal  ->  confirmed:true 原样重放"。
- 门控默认关闭；typecheck/build 双过；无 emoji 功能图标；无硬编码色值。
